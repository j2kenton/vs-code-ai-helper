/**
 * Coverage for the task action coordinator (plan §3.8 / §3.3 / AC-ID-01..03,
 * AC-RESULT-03, AC-OUTCOME-01):
 *  - the complete provider flow: operation + lease + selection session +
 *    unique attempt + registry-issued claim-once reservation + broker
 *    invocation + strict envelope decode + stable outcome mapping;
 *  - the provider boundary is `runnerRegistry.ts`'s own contract: the
 *    coordinator consumes `V1RunnerSelectionV1` (opened per operation via
 *    `RunnerSelectionOpenerV1`) and never picks a candidate or issues a
 *    reservation itself — including an integration test against the real
 *    `openV1RunnerSelection` with an unsupported primary and fallback;
 *  - correlation gating: a result echoing a foreign operation/attempt is
 *    `resultCorrelationMismatch` and promotes nothing;
 *  - questions route to the conversation orchestrator with the row's
 *    declared Resume semantics and promote nothing;
 *  - fallback happens only after a pre-response transport failure, with a
 *    fresh attempt; response-started failures are terminal;
 *  - leases are held for the invocation and released in the outermost
 *    finally, with duplicates rejected before any provider work;
 *  - a completed outcome consumes the row's declared follow-up exactly once,
 *    after lease release; non-completed outcomes schedule nothing
 *    (plan §3.8 / AC-LIFECYCLE-02);
 *  - `resumeAction` executes an explicit Resume end to end (plan §5.5 /
 *    §6.1 / AC-QUESTION-03): across a coordinator restart it reconstructs
 *    the action from the persisted validated-input snapshot and recorded
 *    answers, runs `sameOperation` under the settled linkage's recorded
 *    attempt id and `replacementOperation` as a fresh linked operation, and
 *    rejects unknown, unanswerable, mismatched, ineligible, already-settled,
 *    and duplicate-locked Resumes without settling the transaction or
 *    invoking a provider;
 *  - the Resume idempotency id is caller-owned (§3.1): re-driving with the
 *    identical id after a crash between settlement and provider invocation
 *    recovers the transaction's exactly-one recorded attempt linkage — the
 *    replay executes under the recorded `newAttemptId`, never an unbound
 *    fresh attempt;
 *  - AC-RUNNER-03: a settled resolution replaying idempotently does not make
 *    its provider invocation safe to run twice. A durable per-interaction
 *    claim (`resumeInvocationClaimedAt`), taken immediately before
 *    `runProviderRow` (the actual reservation/invocation boundary, not
 *    earlier), blocks a second drive's INVOCATION once claimed, and exactly
 *    one of two genuinely concurrent identical-id replays (distinct
 *    coordinator/store instances) ever invokes the provider. A claim alone
 *    is not permanent data loss, though: once a claimed invocation runs to
 *    completion its exact outcome is durably recorded
 *    (`resumeInvocationOutcome`), and a later replay that finds the claim
 *    already made recovers and returns that EXACT outcome instead of
 *    invoking again — only a claim with no recorded outcome (genuinely
 *    in-flight or crashed mid-invocation) fails closed. And critically, a
 *    crash strictly BEFORE the invocation boundary (during session/selection
 *    setup, or earlier) leaves no claim at all, so Resume stays fully
 *    retryable — a pre-invocation crash never permanently consumes it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  ActionConversationOrchestratorV1,
  createActionConversationOrchestratorV1,
} from "../actions/actionConversationOrchestratorV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import { createWorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import { createWorkflowPathRegistryV1 } from "../services/workflowPathRegistryV1";
import {
  createTaskActionCoordinatorV1,
  RunnerSelectionOpenerV1,
  TaskActionCoordinatorV1,
  TaskActionFollowUpRequestV1,
  TaskActionSettlementRecordV1,
} from "../actions/taskActionCoordinatorV1";
import {
  createTaskActionRegistryV1,
  LifecycleTaskActionRowV1,
  ProviderTaskActionRowV1,
  TaskActionRegistryErrorV1,
  TaskActionRegistryRowV1,
} from "../actions/taskActionRegistryV1";
import {
  createV1RunnerSelectionOpener,
  V1ReserveNextResultV1,
} from "../runners/runnerRegistry";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { AgentTransportV1 } from "../types/agentExecutionV1";
import { CompletedContentV1 } from "../types/aiResultEnvelope";
import { MIGRATED_ACTION_KEYS_V0 } from "../services/legacyAiActionSafetyGateV0";
import {
  createWorkflowLeaseStoreV1,
  WorkflowLeaseStoreV1,
} from "../services/workflowLeaseStoreV1";

const TEST_ACTION_KEY = "coordinatorTestAction.v1";
const TEST_ROUTE = "vs-code-ai-helper.coordinatorTestRoute";
const TASK_BINDING = { taskBindingId: "task-binding-digest", chatDocumentId: "chat-doc-id" };

/** Shared durable-storage root for every harness's transaction store (unique operation ids keep them disjoint). */
let orchestratorTmpRoot: string;

/** The durable orchestrator, wired the way production will be (§2.1/§1.8 storage). */
function makeOrchestrator(): ActionConversationOrchestratorV1 {
  const registry = createWorkflowPathRegistryV1();
  registry.registerRoot({
    rootId: "private-storage",
    fsPath: orchestratorTmpRoot,
    kind: "privateStorage",
    trustedForMutation: true,
  });
  return createActionConversationOrchestratorV1({
    transactionStore: createChatInteractionTransactionStoreV1({
      registry,
      fileStore: createWorkflowFileStoreV1(registry.registeredRoots()),
      privateRootId: "private-storage",
    }),
  });
}

function fakeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

type EnvelopeScript = (correlation: ActionCorrelationV1) => string;

/** A transport that frames whatever the script returns for the request's correlation. */
function envelopeTransport(
  script: EnvelopeScript,
  seenCorrelations?: ActionCorrelationV1[]
): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      seenCorrelations?.push(request.correlation);
      output.write(script(request.correlation));
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

interface StubSelectionSource {
  readonly opener: RunnerSelectionOpenerV1;
  /** Selections opened (one per provider operation). */
  readonly opened: number;
  /** Reservations the stub registry issued through the session. */
  readonly reserved: number;
}

/**
 * A `RunnerSelectionOpenerV1` test double implementing the exact
 * `V1RunnerSelectionV1` contract `openV1RunnerSelection` returns: every
 * reservation is issued through the caller's session (so claim-once and
 * one-reservation-per-attempt are session-enforced), and exhaustion reports
 * `noneRemaining` with the registry's codes.
 */
function stubSelectionOpener(transports: readonly AgentTransportV1[]): StubSelectionSource {
  let opened = 0;
  let reservedCount = 0;
  let cursor = 0;
  const opener: RunnerSelectionOpenerV1 = ({ session, mode }) => {
    opened += 1;
    return {
      reserveNext(attemptId): V1ReserveNextResultV1 {
        const transport = transports[cursor];
        if (!transport) {
          return cursor === 0
            ? { kind: "noneRemaining", code: "providerModeUnavailable" }
            : { kind: "noneRemaining", code: "candidatesExhausted" };
        }
        cursor += 1;
        reservedCount += 1;
        const handle = session.reserve({
          attemptId,
          mode,
          runnerId: transport.runnerId,
          providerId: "copilot",
          modelId: "copilot:test",
        });
        return {
          kind: "reserved",
          reserved: {
            handle,
            providerLabel: "Test Provider",
            storedModelId: "copilot:test",
            createTransport: () => transport,
          },
        };
      },
    };
  };
  return {
    opener,
    get opened(): number {
      return opened;
    },
    get reserved(): number {
      return reservedCount;
    },
  };
}

interface Harness {
  coordinator: TaskActionCoordinatorV1;
  leaseStore: WorkflowLeaseStoreV1;
  promoted: CompletedContentV1[];
  orchestrator: ActionConversationOrchestratorV1;
  selection: StubSelectionSource;
  followUps: TaskActionFollowUpRequestV1[];
  /** heldLease() observed at the moment each follow-up was scheduled. */
  leaseHeldAtFollowUp: (string | undefined)[];
  /** Presentations begun — each entry records the actionKey, operationId, and progressLabel handed to beginProgress. */
  presentations: { actionKey: string; operationId: string; progressLabel: string }[];
  /** True when the last-begun presentation was ended (wrapped so the test observes the live closure value). */
  presentationEnded: { value: boolean };
  /** Settlement records the audit logger received. */
  settlementRecords: TaskActionSettlementRecordV1[];
  /** The lease id held at the moment each settlement was logged. */
  leaseHeldAtSettlement: (string | undefined)[];
}

function makeHarness(
  transports: readonly AgentTransportV1[],
  rowOverrides: Partial<ProviderTaskActionRowV1> = {},
  extraRows: readonly TaskActionRegistryRowV1[] = []
): Harness {
  const promoted: CompletedContentV1[] = [];
  const row: ProviderTaskActionRowV1 = {
    kind: "provider",
    actionKey: TEST_ACTION_KEY,
    routes: [TEST_ROUTE],
    eligibility: { statuses: ["active"], stages: ["plan"] },
    requiresTaskOperationLease: true,
    progressLabel: "Testing…",
    providerMode: "text",
    maxResponseBytes: 64 * 1024,
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    resumeSemantics: "sameOperation",
    validateInput: (input) =>
      input === "invalid" ? { ok: false, reason: "invalid" } : { ok: true, input },
    buildPrompt: () => "ACTION PROMPT",
    promoteCompletedContent: (content) => {
      promoted.push(content);
      return Promise.resolve("completed");
    },
    loggingPolicy: { channel: "action.test", includeResultMetrics: true },
    ...rowOverrides,
  };
  const leaseStore = createWorkflowLeaseStoreV1();
  const orchestrator = makeOrchestrator();
  const selection = stubSelectionOpener(transports);
  const followUps: TaskActionFollowUpRequestV1[] = [];
  const leaseHeldAtFollowUp: (string | undefined)[] = [];
  const presentations: { actionKey: string; operationId: string; progressLabel: string }[] = [];
  const presentationEnded: { value: boolean } = { value: false };
  const settlementRecords: TaskActionSettlementRecordV1[] = [];
  const leaseHeldAtSettlement: (string | undefined)[] = [];
  const coordinator = createTaskActionCoordinatorV1({
    registry: createTaskActionRegistryV1([row, ...extraRows]),
    leaseStore,
    openRunnerSelection: selection.opener,
    orchestrator,
    followUpScheduler: {
      schedule: (request): void => {
        leaseHeldAtFollowUp.push(leaseStore.heldLease(request.taskBinding.taskBindingId)?.leaseId);
        followUps.push(request);
      },
    },
    presenter: {
      beginProgress(p) {
        presentations.push({ actionKey: p.actionKey, operationId: p.operationId, progressLabel: p.progressLabel });
        return { end: (): void => { presentationEnded.value = true; } };
      },
    },
    auditLogger: {
      log(record) {
        leaseHeldAtSettlement.push(leaseStore.heldLease(record.taskBindingId)?.leaseId);
        settlementRecords.push(record);
      },
    },
  });
  return { coordinator, leaseStore, promoted, orchestrator, selection, followUps, leaseHeldAtFollowUp, presentations, presentationEnded, settlementRecords, leaseHeldAtSettlement };
}

function baseRequest(rawInput: unknown = "input"): {
  actionKey: string;
  taskBinding: typeof TASK_BINDING;
  taskStatus: string;
  taskStage: string;
  rawInput: unknown;
  cancellationToken: vscode.CancellationToken;
} {
  return {
    actionKey: TEST_ACTION_KEY,
    taskBinding: TASK_BINDING,
    taskStatus: "active",
    taskStage: "plan",
    rawInput,
    cancellationToken: fakeToken(),
  };
}

/** Same settings shim the openV1RunnerSelection suite uses. */
function installModelSettings(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : defaultValue,
    inspect: () => undefined,
  });

  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

void describe("taskActionCoordinatorV1", () => {
  before(() => {
    (MIGRATED_ACTION_KEYS_V0 as unknown as Set<string>).add(TEST_ACTION_KEY);
    orchestratorTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-coordinator-"));
  });
  after(() => {
    (MIGRATED_ACTION_KEYS_V0 as unknown as Set<string>).delete(TEST_ACTION_KEY);
    fs.rmSync(orchestratorTmpRoot, { recursive: true, force: true });
  });

  void it("runs the completed happy path and releases the lease", async () => {
    let sawContract = false;
    const transport: AgentTransportV1 = {
      runnerId: "scripted-transport",
      invoke: (request, output) => {
        sawContract =
          request.prompt.startsWith("ACTION PROMPT") &&
          request.prompt.includes("<<<ENSEMBLE_AI_RESULT_V1>>>");
        output.write(
          frame({
            version: 1,
            correlation: request.correlation,
            kind: "completed",
            content: {
              contentType: "markdown-artifact.v1",
              schemaVersion: 1,
              markdown: "# Plan",
            },
          })
        );
        return Promise.resolve({ kind: "completed" as const });
      },
    };
    const harness = makeHarness([transport]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") {
      assert.fail("expected a completed outcome");
    }
    assert.equal(outcome.code, "completed");
    assert.equal(outcome.correlation.actionKey, TEST_ACTION_KEY);
    assert.equal(sawContract, true);
    assert.equal(harness.promoted.length, 1);
    assert.equal(harness.selection.opened, 1);
    assert.equal(harness.leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);
  });

  void it("routes questions to the orchestrator with the row's Resume semantics and promotes nothing", async () => {
    const harness = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "questions",
          questions: [
            {
              questionId: "q1",
              kind: "text",
              prompt: "Which stage?",
              required: true,
              allowBlank: false,
              maxLength: 100,
            },
          ],
        })
      ),
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "questions");
    if (outcome.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const record = await harness.orchestrator.getRecord({
      operationId: outcome.correlation.operationId,
      interactionId: outcome.interactionId,
      taskBindingId: outcome.correlation.taskBindingId,
      chatDocumentId: outcome.correlation.chatDocumentId,
      sourceAttemptId: outcome.correlation.attemptId,
    });
    assert.equal(record?.state, "questionsPosted");
    assert.equal(record?.resumeSemantics, "sameOperation");
    assert.deepEqual(record?.correlation, outcome.correlation);
    assert.equal(harness.promoted.length, 0);
    // Plan §5.5 write-through: the durable transaction record was persisted
    // at the registry-vended §2.1 locator before the outcome surfaced.
    assert.ok(
      fs.existsSync(
        path.join(
          orchestratorTmpRoot,
          "workflow-runtime-v1",
          "chat-transactions",
          outcome.correlation.operationId,
          "transaction-v1.json"
        )
      )
    );
    // The lease was released before the user answers (plan §6.1 rule 6).
    assert.equal(harness.leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);
  });

  void it("rejects a result echoing a foreign operation as resultCorrelationMismatch", async () => {
    const harness = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation: { ...correlation, operationId: allocateHex128IdV1() },
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# x" },
        })
      ),
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected a malformedResult outcome");
    }
    assert.equal(outcome.code, "resultCorrelationMismatch");
    assert.equal(harness.promoted.length, 0);
  });

  void it("maps unframed output, wrong content types, and unpermitted kinds to malformedResult", async () => {
    const bare = makeHarness([
      {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write("just some prose, no frame");
          return Promise.resolve({ kind: "completed" as const });
        },
      },
    ]);
    const bareOutcome = await bare.coordinator.executeAction(baseRequest());
    assert.equal(bareOutcome.kind, "malformedResult");
    if (bareOutcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(bareOutcome.code, "invalidFrame");

    const wrongType = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "chat-message.v1", schemaVersion: 1, text: "hi" },
        })
      ),
    ]);
    const wrongTypeOutcome = await wrongType.coordinator.executeAction(baseRequest());
    assert.equal(wrongTypeOutcome.kind, "malformedResult");
    if (wrongTypeOutcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(wrongTypeOutcome.code, "contentSchemaMismatch");
    assert.equal(wrongType.promoted.length, 0);

    const unpermitted = makeHarness(
      [
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation,
            kind: "questions",
            questions: [
              {
                questionId: "q1",
                kind: "text",
                prompt: "?",
                required: true,
                allowBlank: false,
                maxLength: 10,
              },
            ],
          })
        ),
      ],
      { permittedResultKinds: ["completed", "cancelled", "failed"] }
    );
    const unpermittedOutcome = await unpermitted.coordinator.executeAction(baseRequest());
    assert.equal(unpermittedOutcome.kind, "malformedResult");
    if (unpermittedOutcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(unpermittedOutcome.code, "contentSchemaMismatch");
  });

  void it("falls back after a pre-response transport failure with a fresh attempt", async () => {
    const seen: ActionCorrelationV1[] = [];
    const failing: AgentTransportV1 = {
      runnerId: "scripted-transport",
      invoke: (request) => {
        seen.push(request.correlation);
        return Promise.resolve({ kind: "transportFailure" as const, code: "connectFailed" });
      },
    };
    const succeeding = envelopeTransport(
      (correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
        }),
      seen
    );
    const harness = makeHarness([failing, succeeding]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(seen.length, 2);
    // Same operation, globally unique attempts (AC-ID-02), one ranked
    // selection opened for the whole operation.
    assert.equal(seen[0]!.operationId, seen[1]!.operationId);
    assert.notEqual(seen[0]!.attemptId, seen[1]!.attemptId);
    assert.equal(harness.selection.opened, 1);
    assert.equal(harness.selection.reserved, 2);
  });

  void it("treats a response-started transport failure as terminal (no fallback)", async () => {
    const failing: AgentTransportV1 = {
      runnerId: "scripted-transport",
      invoke: (_request, output) => {
        output.write("partial bytes");
        return Promise.resolve({ kind: "transportFailure" as const, code: "streamBroke" });
      },
    };
    const neverReached = envelopeTransport(() => {
      throw new Error("fallback must not run after a response-started failure");
    });
    const harness = makeHarness([failing, neverReached]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") {
      assert.fail("expected a failed outcome");
    }
    assert.equal(outcome.code, "streamBroke");
    assert.equal(outcome.retryable, false);
    assert.equal(harness.selection.reserved, 1);
  });

  void it("returns providerModeUnavailable when the ranked selection has no candidate", async () => {
    const harness = makeHarness([]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.deepEqual(outcome, { kind: "unavailable", code: "providerModeUnavailable" });
    assert.equal(harness.selection.opened, 1);
    assert.equal(harness.selection.reserved, 0);
  });

  void it("maps provider-declared failure and cancellation envelopes onto stable outcomes", async () => {
    const failed = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "failed",
          code: "modelOverloaded",
          message: "try later",
          retryable: true,
        })
      ),
    ]);
    const failedOutcome = await failed.coordinator.executeAction(baseRequest());
    assert.equal(failedOutcome.kind, "failed");
    if (failedOutcome.kind !== "failed") {
      assert.fail("expected failed");
    }
    assert.equal(failedOutcome.code, "modelOverloaded");
    assert.equal(failedOutcome.retryable, true);

    const cancelled = makeHarness([
      envelopeTransport((correlation) =>
        frame({ version: 1, correlation, kind: "cancelled", reason: "user" })
      ),
    ]);
    const cancelledOutcome = await cancelled.coordinator.executeAction(baseRequest());
    assert.deepEqual(cancelledOutcome.kind, "cancelled");
    if (cancelledOutcome.kind !== "cancelled") {
      assert.fail("expected cancelled");
    }
    assert.equal(cancelledOutcome.code, "userCancelled");
  });

  void it("rejects a duplicate invocation before any provider work", async () => {
    const harness = makeHarness([
      envelopeTransport(() => {
        throw new Error("provider must not be invoked for a duplicate");
      }),
    ]);
    const held = harness.leaseStore.acquire(
      TASK_BINDING.taskBindingId,
      "otherAction.v1",
      allocateHex128IdV1()
    );
    assert.equal(held.ok, true);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.deepEqual(outcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
    assert.equal(harness.selection.opened, 0);
    assert.equal(harness.selection.reserved, 0);
  });

  void describe("parentOperationId — nested child lease (commitPush.v1's self-deadlock fix)", () => {
    /**
     * Mirrors commitPush.v1's real shape: a lifecycle row holds its lease for
     * the whole coordinated transition (plan §3.8) and, from inside that same
     * `execute`, drives a nested provider-row call against the SAME task
     * binding (commitPushMetadata.v1 in production). Proves both halves of
     * the safety property in one flow: (1) the nested call succeeds via
     * `parentOperationId` instead of self-deadlocking as a false-positive
     * duplicate, and (2) while the parent's lease is held, an UNRELATED
     * caller on the same binding — including one that supplies a
     * `parentOperationId` it does not actually hold — is still rejected, so
     * this can never be used to let two independent operations act on the
     * same task concurrently.
     */
    void it("admits a nested provider-row call via parentOperationId, and still rejects an unrelated caller on the same binding", async () => {
      const coordinatorRef: { current?: TaskActionCoordinatorV1 } = {};
      let unrelatedOutcome: unknown;
      let impostorOutcome: unknown;
      const parentRow: LifecycleTaskActionRowV1 = {
        kind: "lifecycle",
        actionKey: "parentLifecycle.v1",
        routes: ["vs-code-ai-helper.parentLifecycleTestRoute"],
        eligibility: { statuses: ["active"], stages: ["plan"] },
        requiresTaskOperationLease: true,
        progressLabel: "Parent…",
        validateInput: (input) => ({ ok: true, input }),
        loggingPolicy: { channel: "action.parentTest", includeResultMetrics: false },
        execute: async (context) => {
          // An unrelated caller with NO parentOperationId must still be
          // rejected while this row's lease is held — base exclusivity for
          // this binding is unchanged.
          unrelatedOutcome = await coordinatorRef.current!.executeAction({
            actionKey: TEST_ACTION_KEY,
            taskBinding: { taskBindingId: context.taskBindingId, chatDocumentId: context.chatDocumentId },
            taskStatus: "active",
            taskStage: "plan",
            rawInput: "input",
            cancellationToken: fakeToken(),
          });
          // An impostor asserting a FABRICATED parentOperationId (not this
          // row's real operationId) must also be rejected — a child can only
          // ever be granted to the operation that actually holds the lease.
          impostorOutcome = await coordinatorRef.current!.executeAction({
            actionKey: TEST_ACTION_KEY,
            taskBinding: { taskBindingId: context.taskBindingId, chatDocumentId: context.chatDocumentId },
            taskStatus: "active",
            taskStage: "plan",
            rawInput: "input",
            cancellationToken: fakeToken(),
            parentOperationId: allocateHex128IdV1(),
          });
          // The legitimate nested call, naming THIS execution's own
          // operationId, must succeed.
          const nested = await coordinatorRef.current!.executeAction({
            actionKey: TEST_ACTION_KEY,
            taskBinding: { taskBindingId: context.taskBindingId, chatDocumentId: context.chatDocumentId },
            taskStatus: "active",
            taskStage: "plan",
            rawInput: "input",
            cancellationToken: fakeToken(),
            parentOperationId: context.operationId,
          });
          if (nested.kind !== "completed") {
            return { kind: "failed", code: `nestedNotCompleted:${nested.kind}`, retryable: false };
          }
          return {
            kind: "completed",
            correlation: {
              actionKey: context.actionKey,
              operationId: context.operationId,
              attemptId: allocateHex128IdV1(),
              taskBindingId: context.taskBindingId,
              chatDocumentId: context.chatDocumentId,
            },
            code: "completed",
          };
        },
      };
      const harness = makeHarness(
        [
          envelopeTransport((correlation) =>
            frame({
              version: 1,
              correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# nested" },
            })
          ),
        ],
        {},
        [parentRow]
      );
      coordinatorRef.current = harness.coordinator;

      const outcome = await harness.coordinator.executeAction({
        actionKey: "parentLifecycle.v1",
        taskBinding: TASK_BINDING,
        taskStatus: "active",
        taskStage: "plan",
        rawInput: "input",
        cancellationToken: fakeToken(),
      });

      assert.deepEqual(unrelatedOutcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
      assert.deepEqual(impostorOutcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
      assert.equal(outcome.kind, "completed");
      // Exactly one provider invocation actually ran: the legitimate child.
      assert.equal(harness.promoted.length, 1);
      assert.equal(harness.selection.opened, 1);
      // The parent's own lease is released once its execute returns.
      assert.equal(harness.leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);
    });
  });

  void it("checks eligibility, input, and cancellation before allocating anything", async () => {
    const harness = makeHarness([
      envelopeTransport(() => {
        throw new Error("provider must not be invoked");
      }),
    ]);
    const wrongStatus = await harness.coordinator.executeAction({
      ...baseRequest(),
      taskStatus: "completed",
    });
    assert.equal(wrongStatus.kind, "failed");
    if (wrongStatus.kind !== "failed") {
      assert.fail("expected failed");
    }
    assert.equal(wrongStatus.code, "actionNotEligibleForStatus");

    const wrongStage = await harness.coordinator.executeAction({
      ...baseRequest(),
      taskStage: "publish",
    });
    assert.equal(wrongStage.kind === "failed" && wrongStage.code, "actionNotEligibleForStage");

    const badInput = await harness.coordinator.executeAction(baseRequest("invalid"));
    assert.equal(badInput.kind === "failed" && badInput.code, "invalidActionInput");

    const preCancelled = await harness.coordinator.executeAction({
      ...baseRequest(),
      cancellationToken: fakeToken(true),
    });
    assert.equal(preCancelled.kind === "cancelled" && preCancelled.code, "userCancelled");
    assert.equal(harness.selection.opened, 0);
    assert.equal(harness.selection.reserved, 0);
    assert.equal(harness.leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);
  });

  void it("admitAction settles duplicate/ineligible/invalid/cancelled rejections without ever admitting a ticket (plan §5.4/AC-CHAT-TX-02)", async () => {
    const harness = makeHarness([
      envelopeTransport(() => {
        throw new Error("provider must not be invoked for a rejected admission");
      }),
    ]);
    const held = harness.leaseStore.acquire(TASK_BINDING.taskBindingId, "otherAction.v1", allocateHex128IdV1());
    assert.equal(held.ok, true);
    const duplicate = await harness.coordinator.admitAction(baseRequest());
    assert.equal(duplicate.kind, "settled");
    if (duplicate.kind === "settled") {
      assert.deepEqual(duplicate.outcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
    }
    harness.leaseStore.release(held.ok ? held.lease.leaseId : "");

    const wrongStatus = await harness.coordinator.admitAction({ ...baseRequest(), taskStatus: "completed" });
    assert.equal(wrongStatus.kind, "settled");
    assert.equal(wrongStatus.kind === "settled" && wrongStatus.outcome.kind, "failed");

    const badInput = await harness.coordinator.admitAction(baseRequest("invalid"));
    assert.equal(badInput.kind, "settled");
    assert.equal(
      badInput.kind === "settled" && badInput.outcome.kind === "failed" && badInput.outcome.code,
      "invalidActionInput"
    );

    const preCancelled = await harness.coordinator.admitAction({ ...baseRequest(), cancellationToken: fakeToken(true) });
    assert.equal(preCancelled.kind, "settled");
    assert.equal(
      preCancelled.kind === "settled" && preCancelled.outcome.kind === "cancelled" && preCancelled.outcome.code,
      "userCancelled"
    );

    // Every rejection is already audited by admitAction itself — a caller
    // that only calls admitAction (never continueAdmittedAction) for a
    // "settled" result still gets exactly one settlement record per call.
    assert.equal(harness.settlementRecords.length, 4);
    assert.equal(harness.selection.opened, 0);
    assert.equal(harness.selection.reserved, 0);
  });

  void it("admitAction admits a ticket without invoking the provider, and continueAdmittedAction runs it to the same outcome executeAction would produce (plan §5.4/AC-CHAT-TX-02)", async () => {
    let invoked = false;
    const transport: AgentTransportV1 = {
      runnerId: "admit-continue-transport",
      invoke: (request, output): Promise<{ kind: "completed" }> => {
        invoked = true;
        output.write(
          frame({
            version: 1,
            correlation: request.correlation,
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
          })
        );
        return Promise.resolve({ kind: "completed" as const });
      },
    };
    const harness = makeHarness([transport]);

    const admission = await harness.coordinator.admitAction(baseRequest());
    assert.equal(admission.kind, "admitted");
    // Selection is opened during admission (provider-selection precedes any
    // caller-visible "safe to proceed" point), but the provider transport
    // itself has not run yet.
    assert.equal(harness.selection.opened, 1);
    assert.equal(invoked, false);
    assert.equal(harness.settlementRecords.length, 0);
    assert.equal(harness.followUps.length, 0);

    if (admission.kind !== "admitted") {
      assert.fail("expected an admitted ticket");
    }
    const outcome = await harness.coordinator.continueAdmittedAction(admission.ticket);
    assert.equal(invoked, true);
    assert.equal(outcome.kind, "completed");
    assert.equal(harness.promoted.length, 1);
    // Exactly one settlement record — not one from admission and a second
    // from continuation.
    assert.equal(harness.settlementRecords.length, 1);
    assert.equal(harness.presentationEnded.value, true);
  });

  void it("abortAdmittedAction retires an admitted ticket without invoking the provider, settling exactly once (plan §5.4/AC-CHAT-TX-02)", async () => {
    let invoked = false;
    const harness = makeHarness([
      envelopeTransport((correlation) => {
        invoked = true;
        return frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
        });
      }),
    ]);

    const admission = await harness.coordinator.admitAction(baseRequest());
    assert.equal(admission.kind, "admitted");
    if (admission.kind !== "admitted") {
      assert.fail("expected an admitted ticket");
    }
    assert.equal(harness.presentationEnded.value, false);

    const outcome = await harness.coordinator.abortAdmittedAction(admission.ticket, "callerWorkFailed");
    assert.equal(invoked, false, "aborting an admitted ticket must never reach the provider");
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") {
      assert.fail("expected a failed outcome");
    }
    assert.equal(outcome.code, "admissionAborted.callerWorkFailed");
    assert.equal(outcome.retryable, true);
    // Ends progress and audits exactly once — the same exactly-once tail
    // continueAdmittedAction uses, so an admitted ticket that is aborted
    // instead of continued still settles instead of leaking.
    assert.equal(harness.presentationEnded.value, true);
    assert.equal(harness.settlementRecords.length, 1);
    assert.equal(harness.followUps.length, 0);
  });

  void it("rejects a second retirement of the same admitted ticket, in either order (plan §5.4/AC-CHAT-TX-02)", async () => {
    const completedTransport = envelopeTransport((correlation) =>
      frame({
        version: 1,
        correlation,
        kind: "completed",
        content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
      })
    );

    // continueAdmittedAction called twice for the same ticket.
    {
      const harness = makeHarness([completedTransport]);
      const admission = await harness.coordinator.admitAction(baseRequest());
      if (admission.kind !== "admitted") {
        assert.fail("expected an admitted ticket");
      }
      await harness.coordinator.continueAdmittedAction(admission.ticket);
      await assert.rejects(() => harness.coordinator.continueAdmittedAction(admission.ticket));
      // The rejected second call must not re-audit or re-follow-up.
      assert.equal(harness.settlementRecords.length, 1);
    }

    // abortAdmittedAction called twice for the same ticket.
    {
      const harness = makeHarness([completedTransport]);
      const admission = await harness.coordinator.admitAction(baseRequest());
      if (admission.kind !== "admitted") {
        assert.fail("expected an admitted ticket");
      }
      await harness.coordinator.abortAdmittedAction(admission.ticket, "callerWorkFailed");
      await assert.rejects(() => harness.coordinator.abortAdmittedAction(admission.ticket, "callerWorkFailed"));
      assert.equal(harness.settlementRecords.length, 1);
    }

    // abortAdmittedAction after continueAdmittedAction for the same ticket.
    {
      const harness = makeHarness([completedTransport]);
      const admission = await harness.coordinator.admitAction(baseRequest());
      if (admission.kind !== "admitted") {
        assert.fail("expected an admitted ticket");
      }
      await harness.coordinator.continueAdmittedAction(admission.ticket);
      await assert.rejects(() => harness.coordinator.abortAdmittedAction(admission.ticket, "tooLate"));
      assert.equal(harness.settlementRecords.length, 1);
    }

    // continueAdmittedAction after abortAdmittedAction for the same ticket.
    {
      const harness = makeHarness([completedTransport]);
      const admission = await harness.coordinator.admitAction(baseRequest());
      if (admission.kind !== "admitted") {
        assert.fail("expected an admitted ticket");
      }
      await harness.coordinator.abortAdmittedAction(admission.ticket, "callerWorkFailed");
      await assert.rejects(() => harness.coordinator.continueAdmittedAction(admission.ticket));
      assert.equal(harness.settlementRecords.length, 1);
    }
  });

  void it("consumes the row's declared follow-up exactly once, after lease release, and only when completed", async () => {
    const followUpTarget: LifecycleTaskActionRowV1 = {
      kind: "lifecycle",
      actionKey: "coordinatorFollowUpTarget.v1",
      routes: ["vs-code-ai-helper.coordinatorFollowUpTarget"],
      eligibility: { statuses: ["active"], stages: "anyStage" },
      requiresTaskOperationLease: false,
      progressLabel: "Following up…",
      validateInput: (input) => ({ ok: true, input }),
      execute: () => Promise.reject(new Error("the follow-up target is never auto-executed here")),
      loggingPolicy: { channel: "action.followUp", includeResultMetrics: false },
    };
    const completedTransport = envelopeTransport((correlation) =>
      frame({
        version: 1,
        correlation,
        kind: "completed",
        content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# done" },
      })
    );
    const harness = makeHarness(
      [completedTransport],
      { followUpActionKey: "coordinatorFollowUpTarget.v1" },
      [followUpTarget]
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(harness.followUps.length, 1);
    assert.deepEqual(harness.followUps[0], {
      followUpActionKey: "coordinatorFollowUpTarget.v1",
      sourceActionKey: TEST_ACTION_KEY,
      sourceOperationId: outcome.kind === "completed" ? outcome.correlation.operationId : "",
      taskBinding: TASK_BINDING,
    });
    // Scheduled after the outermost lease release, so a synchronous
    // scheduler can immediately coordinate against the same task.
    assert.deepEqual(harness.leaseHeldAtFollowUp, [undefined]);

    // A non-completed outcome consumes no follow-up.
    const questions = makeHarness(
      [
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation,
            kind: "questions",
            questions: [
              {
                questionId: "q1",
                kind: "text",
                prompt: "?",
                required: true,
                allowBlank: false,
                maxLength: 10,
              },
            ],
          })
        ),
      ],
      { followUpActionKey: "coordinatorFollowUpTarget.v1" },
      [followUpTarget]
    );
    const questionsOutcome = await questions.coordinator.executeAction(baseRequest());
    assert.equal(questionsOutcome.kind, "questions");
    assert.equal(questions.followUps.length, 0);
  });

  void it("integrates with runnerRegistry's real openV1RunnerSelection: unsupported primary, ranked fallback, exhaustion", async () => {
    // Ranking policy under test is the registry's own: the stored primary
    // (codex-cli, a last-message-file CLI that cannot satisfy AC-RUNNER-02's
    // stdout-only capture) is settled as an explicit unavailable attempt —
    // never silently bypassed — then the strategy-gated Copilot backup is
    // reserved on a FRESH attempt and invoked through the broker. Under the
    // test stub there is no usable vscode.lm host, so the Copilot transport
    // reports a deterministic pre-response transport failure, the ranking
    // exhausts, and the coordinator maps the whole operation onto the stable
    // providerModeUnavailable outcome.
    const settings = installModelSettings({
      "impl-high-review": {
        primary: "codex-cli:gpt-5",
        backups: ["copilot:gpt-5"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const opener = createV1RunnerSelectionOpener({
        workspaceCwd: "/workspace",
        resolveStagePrimaryModel: (taskStage) => {
          assert.equal(taskStage, "plan");
          return { modelId: "codex-cli:gpt-5", stage: "impl-high-review" };
        },
      });
      const leaseStore = createWorkflowLeaseStoreV1();
      const promoted: CompletedContentV1[] = [];
      const row: ProviderTaskActionRowV1 = {
        kind: "provider",
        actionKey: TEST_ACTION_KEY,
        routes: [TEST_ROUTE],
        eligibility: { statuses: ["active"], stages: ["plan"] },
        requiresTaskOperationLease: true,
        progressLabel: "Testing…",
        providerMode: "text",
        maxResponseBytes: 64 * 1024,
        permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
        completedContentType: "markdown-artifact.v1",
        resumeSemantics: "sameOperation",
        validateInput: (input) => ({ ok: true, input }),
        buildPrompt: () => "ACTION PROMPT",
        promoteCompletedContent: (content) => {
          promoted.push(content);
          return Promise.resolve("completed");
        },
        loggingPolicy: { channel: "action.test", includeResultMetrics: true },
      };
      const coordinator = createTaskActionCoordinatorV1({
        registry: createTaskActionRegistryV1([row]),
        leaseStore,
        openRunnerSelection: opener,
        orchestrator: makeOrchestrator(),
        followUpScheduler: { schedule: (): void => undefined },
        presenter: { beginProgress: () => ({ end: (): void => undefined }) },
        auditLogger: { log: (): void => undefined },
      });

      const outcome = await coordinator.executeAction(baseRequest());
      assert.deepEqual(outcome, { kind: "unavailable", code: "providerModeUnavailable" });
      assert.equal(promoted.length, 0);
      assert.equal(leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);

      // With NO mode-capable candidate at all (sole last-message-file CLI
      // primary, no backups), the registry reports mode unavailability on
      // the first reserveNext and no transport is ever constructed.
      const soleUnsupported = installModelSettings({
        "impl-high-review": { primary: "codex-cli:gpt-5", strategy: "switch-to-backup" },
      });
      try {
        const sole = await coordinator.executeAction(baseRequest());
        assert.deepEqual(sole, { kind: "unavailable", code: "providerModeUnavailable" });
      } finally {
        soleUnsupported.restore();
      }
    } finally {
      settings.restore();
    }
  });

  void it("executes lifecycle rows without touching providers and resolves routes fail-closed", async () => {
    const lifecycle: LifecycleTaskActionRowV1 = {
      kind: "lifecycle",
      actionKey: "nextStage.v1",
      routes: ["vs-code-ai-helper.nextStage"],
      eligibility: { statuses: ["active"], stages: "anyStage" },
      requiresTaskOperationLease: true,
      progressLabel: "Advancing…",
      validateInput: (input) => ({ ok: true, input }),
      execute: (context) =>
        Promise.resolve({
          kind: "completed" as const,
          correlation: {
            actionKey: context.actionKey,
            operationId: context.operationId,
            attemptId: allocateHex128IdV1(),
            taskBindingId: context.taskBindingId,
            chatDocumentId: context.chatDocumentId,
          },
          code: "completed" as const,
        }),
      loggingPolicy: { channel: "action.nextStage", includeResultMetrics: false },
    };
    const leaseStore = createWorkflowLeaseStoreV1();
    const selection = stubSelectionOpener([
      envelopeTransport(() => {
        throw new Error("lifecycle rows never consult providers");
      }),
    ]);
    const coordinator = createTaskActionCoordinatorV1({
      registry: createTaskActionRegistryV1([lifecycle]),
      leaseStore,
      openRunnerSelection: selection.opener,
      orchestrator: makeOrchestrator(),
      followUpScheduler: { schedule: (): void => undefined },
      presenter: { beginProgress: () => ({ end: (): void => undefined }) },
      auditLogger: { log: (): void => undefined },
    });
    const outcome = await coordinator.executeRoute("vs-code-ai-helper.nextStage", {
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      rawInput: undefined,
      cancellationToken: fakeToken(),
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(selection.opened, 0);
    assert.equal(selection.reserved, 0);
    assert.equal(leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);
    // rowForRoute throws synchronously (fail-closed) — wrap so the throw
    // surfaces as a rejection for the assertion.
    await assert.rejects(
      async () =>
        coordinator.executeRoute("vs-code-ai-helper.unknownRoute", {
        taskBinding: TASK_BINDING,
        taskStatus: "active",
        taskStage: "plan",
        rawInput: undefined,
          cancellationToken: fakeToken(),
        }),
      TaskActionRegistryErrorV1
    );
  });

  void it("releases the task-operation lease before the provider transport executes", async () => {
    let leaseHeldDuringInvocation: string | undefined;
    const transport: AgentTransportV1 = {
      runnerId: "scripted-transport",
      invoke: (request, output) => {
        // The lease must NOT be held when the transport is invoked (plan §6.1
        // rule 6: leases are released before provider waits).
        leaseHeldDuringInvocation = harness.leaseStore.heldLease(TASK_BINDING.taskBindingId)?.leaseId;
        output.write(
          frame({
            version: 1,
            correlation: request.correlation,
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
          })
        );
        return Promise.resolve({ kind: "completed" as const });
      },
    };
    const harness = makeHarness([transport]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(leaseHeldDuringInvocation, undefined, "lease must not be held during provider execution");
  });

  void it("presents progress with the row's declared label and ends the presentation in the outermost finally", async () => {
    const harness = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# done" },
        })
      ),
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    // Exactly one presentation begun with the row's declared label and
    // operation-specific operationId.
    assert.equal(harness.presentations.length, 1);
    assert.equal(harness.presentations[0]!.actionKey, TEST_ACTION_KEY);
    assert.equal(harness.presentations[0]!.progressLabel, "Testing…");
    // The presentation was ended in the outermost finally.
    assert.equal(harness.presentationEnded.value, true);
  });

  void it("logs exactly one sanitized settlement record per invocation through the audit logger", async () => {
    const completed = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# y" },
        })
      ),
    ]);
    const outcome = await completed.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(completed.settlementRecords.length, 1);
    const r0 = completed.settlementRecords[0]!;
    assert.equal(r0.event, "taskActionSettled");
    assert.equal(r0.channel, "action.test");
    assert.equal(r0.actionKey, TEST_ACTION_KEY);
    assert.equal(r0.outcomeKind, "completed");
    assert.equal(r0.outcomeCode, "completed");
    assert.ok(r0.operationId !== undefined);
    // Lease is released before settlement (plan §6.1 rule 6).
    assert.equal(completed.leaseHeldAtSettlement[0], undefined);

    // A non-completed outcome also logs exactly one record.
    const failed = makeHarness([
      envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "failed",
          code: "modelError",
          message: "try again",
          retryable: true,
        })
      ),
    ]);
    const failedOutcome = await failed.coordinator.executeAction(baseRequest());
    assert.equal(failedOutcome.kind, "failed");
    assert.equal(failed.settlementRecords.length, 1);
    const r1 = failed.settlementRecords[0]!;
    assert.equal(r1.event, "taskActionSettled");
    assert.equal(r1.outcomeKind, "failed");
    assert.equal(r1.outcomeCode, "modelError");
    assert.ok(r1.operationId !== undefined);

    // includeResultMetrics=true: byte length and sha256 present for a
    // completed outcome.
    assert.ok(typeof r0.resultByteLength === "number");
    assert.ok(typeof r0.resultSha256 === "string");
    // includeResultMetrics=true still present for a failed outcome (the
    // metrics capture runs before the envelope is decoded).
    assert.ok(typeof r1.resultByteLength === "number");
    assert.ok(typeof r1.resultSha256 === "string");

    // A pre-cancellation outcome (no provider invoked) logs with the
    // outcome-kind fields but no operation or attempt ids.
    const preCancelled = makeHarness([
      envelopeTransport(() => {
        throw new Error("must not be invoked for pre-cancelled");
      }),
    ]);
    const cancelledOutcome = await preCancelled.coordinator.executeAction({
      ...baseRequest(),
      cancellationToken: fakeToken(true),
    });
    assert.equal(cancelledOutcome.kind, "cancelled");
    assert.equal(preCancelled.settlementRecords.length, 1);
    const r2 = preCancelled.settlementRecords[0]!;
    assert.equal(r2.event, "taskActionSettled");
    assert.equal(r2.outcomeKind, "cancelled");
    assert.equal(r2.outcomeCode, "userCancelled");
    // No operation was allocated yet, so operationId must be absent.
    assert.equal(r2.operationId, undefined);
    assert.equal(r2.attemptId, undefined);
  });

  const RESUME_QUESTIONS_TRANSPORT = (): AgentTransportV1 =>
    envelopeTransport((correlation) =>
      frame({
        version: 1,
        correlation,
        kind: "questions",
        questions: [
          {
            questionId: "q1",
            kind: "text",
            prompt: "Which stage?",
            required: true,
            allowBlank: false,
            maxLength: 100,
          },
        ],
      })
    );

  /** Prompt builder proving the resumed run was rebuilt from the snapshot + answers. */
  const snapshotProvingPromptBuilder = {
    buildPrompt: (context: { validatedInput: unknown; answers?: readonly unknown[] }): string =>
      "ACTION PROMPT " +
      JSON.stringify(context.validatedInput) +
      (context.answers ? ` ANSWERS:${context.answers.length}` : " ANSWERS:none"),
  };

  void it("resumes a sameOperation interaction end to end across a coordinator restart (AC-QUESTION-03)", async () => {
    const questionsHarness = makeHarness([RESUME_QUESTIONS_TRANSPORT()], snapshotProvingPromptBuilder);
    const original = await questionsHarness.coordinator.executeAction(
      baseRequest({ target: "plan.md", advisoryRevision: "r7" })
    );
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await questionsHarness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    // A brand-new harness over the same durable storage — an extension-host
    // restart: nothing in memory survives, only the persisted transaction.
    const resumePrompts: string[] = [];
    const resumeTransport: AgentTransportV1 = {
      runnerId: "scripted-transport",
      invoke: (request, output): Promise<{ kind: "completed" }> => {
        resumePrompts.push(request.prompt);
        output.write(
          frame({
            version: 1,
            correlation: request.correlation,
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# resumed" },
          })
        );
        return Promise.resolve({ kind: "completed" as const });
      },
    };
    const resumeHarness = makeHarness([resumeTransport], snapshotProvingPromptBuilder);
    const outcome = await resumeHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId: allocateHex128IdV1(),
      cancellationToken: fakeToken(),
    });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") {
      assert.fail("expected a completed outcome");
    }
    // sameOperation: the original operation is retained with a NEW attempt.
    assert.equal(outcome.correlation.operationId, original.correlation.operationId);
    assert.notEqual(outcome.correlation.attemptId, original.correlation.attemptId);
    // The prompt was rebuilt from the persisted validated-input snapshot
    // (canonical key order) and carried the recorded answers.
    assert.equal(resumePrompts.length, 1);
    assert.ok(
      resumePrompts[0]!.startsWith(
        'ACTION PROMPT {"advisoryRevision":"r7","target":"plan.md"} ANSWERS:1'
      ),
      `resumed prompt was not rebuilt from the snapshot: ${resumePrompts[0]!.slice(0, 120)}`
    );
    assert.equal(resumeHarness.promoted.length, 1);
    // The transaction settled exactly once as "resumed", and the linkage's
    // recorded attempt id IS the executed attempt (AC-ID-04).
    const settledRecord = await resumeHarness.orchestrator.getRecord(ref);
    assert.equal(settledRecord?.state, "settled");
    assert.equal(settledRecord?.settlement, "resumed");
    assert.equal(settledRecord?.resumeResolution?.kind, "sameOperation");
    if (settledRecord?.resumeResolution?.kind === "sameOperation") {
      assert.equal(settledRecord.resumeResolution.newAttemptId, outcome.correlation.attemptId);
    }
    // One sanitized settlement record under the row's channel; lease released.
    assert.equal(resumeHarness.settlementRecords.length, 1);
    assert.equal(resumeHarness.settlementRecords[0]!.channel, "action.test");
    assert.equal(resumeHarness.settlementRecords[0]!.outcomeKind, "completed");
    assert.equal(resumeHarness.settlementRecords[0]!.operationId, original.correlation.operationId);
    assert.equal(resumeHarness.leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);

    // A second Resume under a different idempotency id is rejected by the
    // persisted record without invoking a provider (plan §3.1 / AC-ID-04).
    const second = await resumeHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId: allocateHex128IdV1(),
      cancellationToken: fakeToken(),
    });
    assert.equal(second.kind === "failed" && second.code, "interactionAlreadySettled");
    assert.equal(resumePrompts.length, 1);
  });

  void it("recovers the recorded attempt when an identical-id replay re-drives a Resume that crashed before provider invocation (AC-ID-04)", async () => {
    const questionsHarness = makeHarness([RESUME_QUESTIONS_TRANSPORT()], snapshotProvingPromptBuilder);
    const original = await questionsHarness.coordinator.executeAction(
      baseRequest({ target: "plan.md" })
    );
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await questionsHarness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    // Crash boundary: the transaction settles (resumeScheduled → settled,
    // binding the linkage's exactly-one `newAttemptId`) but the extension
    // host dies BEFORE the provider is invoked. Settling directly through
    // the orchestrator reproduces exactly that persisted state.
    const resumeIdempotencyId = allocateHex128IdV1();
    const settledResolution = await questionsHarness.orchestrator.resolveResume(
      ref,
      resumeIdempotencyId
    );
    assert.equal(settledResolution.kind, "sameOperation");
    if (settledResolution.kind !== "sameOperation") {
      assert.fail("expected a sameOperation resolution");
    }

    // Re-drive on a fresh coordinator (restart) with the caller-persisted
    // IDENTICAL id: the replay recovers the RECORDED attempt — the executed
    // attempt IS the transaction's exactly-one linkage, never an unbound
    // fresh id.
    const executedCorrelations: ActionCorrelationV1[] = [];
    const replayTransport = envelopeTransport(
      (correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# replayed" },
        }),
      executedCorrelations
    );
    const replayHarness = makeHarness([replayTransport], snapshotProvingPromptBuilder);
    const outcome = await replayHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") {
      assert.fail("expected a completed outcome");
    }
    assert.equal(outcome.correlation.operationId, original.correlation.operationId);
    assert.equal(outcome.correlation.attemptId, settledResolution.newAttemptId);
    assert.equal(executedCorrelations.length, 1);
    assert.equal(executedCorrelations[0]!.attemptId, settledResolution.newAttemptId);
    assert.equal(replayHarness.promoted.length, 1);

    // The replay did not re-settle or rebind: the record still carries
    // exactly the one recorded attempt linkage.
    const settledRecord = await replayHarness.orchestrator.getRecord(ref);
    assert.equal(settledRecord?.state, "settled");
    assert.equal(settledRecord?.settlement, "resumed");
    assert.equal(settledRecord?.resumeIdempotencyId, resumeIdempotencyId);
    assert.equal(settledRecord?.resumeResolution?.kind, "sameOperation");
    if (settledRecord?.resumeResolution?.kind === "sameOperation") {
      assert.equal(settledRecord.resumeResolution.newAttemptId, settledResolution.newAttemptId);
    }

    // Any OTHER id against the settled record remains the rejected second
    // Resume and invokes nothing further.
    const other = await replayHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId: allocateHex128IdV1(),
      cancellationToken: fakeToken(),
    });
    assert.equal(other.kind === "failed" && other.code, "interactionAlreadySettled");
    assert.equal(executedCorrelations.length, 1);
  });

  void it("recovers the first drive's exact terminal outcome on a second Resume drive once claimed (AC-RUNNER-03)", async () => {
    const questionsHarness = makeHarness([RESUME_QUESTIONS_TRANSPORT()], snapshotProvingPromptBuilder);
    const original = await questionsHarness.coordinator.executeAction(
      baseRequest({ target: "plan.md" })
    );
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await questionsHarness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    const resumeIdempotencyId = allocateHex128IdV1();

    // First drive (a fresh coordinator/extension-host restart): resumes,
    // claims the recorded attempt's invocation, and actually invokes the
    // provider exactly once.
    const firstInvocations: ActionCorrelationV1[] = [];
    const firstTransport = envelopeTransport(
      (correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# first" },
        }),
      firstInvocations
    );
    const firstHarness = makeHarness([firstTransport], snapshotProvingPromptBuilder);
    const firstOutcome = await firstHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    });
    assert.equal(firstOutcome.kind, "completed");
    assert.equal(firstInvocations.length, 1);
    assert.equal(firstHarness.promoted.length, 1);

    // Second drive: a SEPARATE coordinator/durable-store instance re-drives
    // with the IDENTICAL idempotency id — another extension-host restart, or
    // automatic recovery re-running because the first drive's outcome was
    // never observed. The durable claim must block a second INVOCATION
    // regardless of whether the first drive actually completed — but since
    // the first drive's exact terminal outcome was durably recorded, this
    // replay recovers and returns it instead of failing (plan §3.1 /
    // AC-RUNNER-03 "recover the claimed terminal result"): a crash observing
    // no result from the first drive must not permanently lose it.
    const secondInvocations: ActionCorrelationV1[] = [];
    const secondTransport = envelopeTransport(
      (correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# second" },
        }),
      secondInvocations
    );
    const secondHarness = makeHarness([secondTransport], snapshotProvingPromptBuilder);
    const secondOutcome = await secondHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    });
    assert.equal(secondOutcome.kind, "completed");
    assert.deepEqual(secondOutcome, firstOutcome);
    assert.equal(secondInvocations.length, 0, "the second drive must not invoke the provider");
    assert.equal(secondHarness.promoted.length, 0, "the second drive must not re-promote content");

    // A THIRD drive, still with no recorded outcome ever having failed to
    // persist, keeps recovering the identical result — recovery is stable,
    // not a one-shot fallback.
    const thirdInvocations: ActionCorrelationV1[] = [];
    const thirdHarness = makeHarness(
      [
        envelopeTransport(
          (correlation) =>
            frame({
              version: 1,
              correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# third" },
            }),
          thirdInvocations
        ),
      ],
      snapshotProvingPromptBuilder
    );
    const thirdOutcome = await thirdHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    });
    assert.deepEqual(thirdOutcome, firstOutcome);
    assert.equal(thirdInvocations.length, 0);
  });

  void it("fails closed (does not invoke the provider) when a Resume drive is claimed but its outcome is genuinely unknown (AC-RUNNER-03)", async () => {
    const questionsHarness = makeHarness([RESUME_QUESTIONS_TRANSPORT()], snapshotProvingPromptBuilder);
    const original = await questionsHarness.coordinator.executeAction(
      baseRequest({ target: "plan.md" })
    );
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await questionsHarness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    const resumeIdempotencyId = allocateHex128IdV1();
    const settledResolution = await questionsHarness.orchestrator.resolveResume(
      ref,
      resumeIdempotencyId
    );
    assert.equal(settledResolution.kind, "sameOperation");

    // Simulate the narrow crash window this design cannot close: the
    // invocation is claimed (over the durable store, directly, as the
    // coordinator would immediately before calling the provider) but the
    // process dies before the provider ever responds, so no terminal
    // outcome is ever recorded.
    const claimed = await questionsHarness.orchestrator.claimResumeInvocation(ref);
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.alreadyClaimed, false);
    }

    const replayInvocations: ActionCorrelationV1[] = [];
    const replayHarness = makeHarness(
      [
        envelopeTransport(
          (correlation) =>
            frame({
              version: 1,
              correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# replay" },
            }),
          replayInvocations
        ),
      ],
      snapshotProvingPromptBuilder
    );
    const outcome = await replayHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    });
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" && outcome.code, "resumeInvocationAlreadyClaimed");
    assert.equal(outcome.kind === "failed" && outcome.retryable, false);
    assert.equal(replayInvocations.length, 0, "the replay must not invoke the provider");
  });

  void it("stays fully retryable when a Resume drive crashes before the invocation boundary is ever reached (AC-RUNNER-03)", async () => {
    const questionsHarness = makeHarness([RESUME_QUESTIONS_TRANSPORT()], snapshotProvingPromptBuilder);
    const original = await questionsHarness.coordinator.executeAction(
      baseRequest({ target: "plan.md" })
    );
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await questionsHarness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    const resumeIdempotencyId = allocateHex128IdV1();

    // Settling the resolution directly (as the earlier "recovers the
    // recorded attempt" test does) reproduces a crash strictly BEFORE the
    // invocation boundary: no session/selection setup ever ran and, crucially,
    // no claim was ever taken (claimResumeInvocation is called immediately
    // before runProviderRow, never earlier). This is the specific gap the
    // review identified: a pre-invocation crash must not permanently
    // consume Resume.
    const settledResolution = await questionsHarness.orchestrator.resolveResume(
      ref,
      resumeIdempotencyId
    );
    assert.equal(settledResolution.kind, "sameOperation");
    const recordBeforeReplay = await questionsHarness.orchestrator.getRecord(ref);
    assert.equal(recordBeforeReplay?.resumeInvocationClaimedAt, undefined);

    const replayInvocations: ActionCorrelationV1[] = [];
    const replayHarness = makeHarness(
      [
        envelopeTransport(
          (correlation) =>
            frame({
              version: 1,
              correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# replay" },
            }),
          replayInvocations
        ),
      ],
      snapshotProvingPromptBuilder
    );
    const outcome = await replayHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(replayInvocations.length, 1, "the replay must invoke the provider exactly once");
    assert.equal(replayHarness.promoted.length, 1);
  });

  void it("invokes the provider exactly once across two concurrent identical-id Resume replays (AC-RUNNER-03)", async () => {
    const questionsHarness = makeHarness([RESUME_QUESTIONS_TRANSPORT()], snapshotProvingPromptBuilder);
    const original = await questionsHarness.coordinator.executeAction(
      baseRequest({ target: "plan.md" })
    );
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await questionsHarness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    // Settle out of band (crash boundary before either replay drives), like
    // the identical-id replay test above.
    const resumeIdempotencyId = allocateHex128IdV1();
    const settledResolution = await questionsHarness.orchestrator.resolveResume(
      ref,
      resumeIdempotencyId
    );
    assert.equal(settledResolution.kind, "sameOperation");

    const invocationsA: ActionCorrelationV1[] = [];
    const invocationsB: ActionCorrelationV1[] = [];
    const harnessA = makeHarness(
      [
        envelopeTransport(
          (correlation) =>
            frame({
              version: 1,
              correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# a" },
            }),
          invocationsA
        ),
      ],
      snapshotProvingPromptBuilder
    );
    const harnessB = makeHarness(
      [
        envelopeTransport(
          (correlation) =>
            frame({
              version: 1,
              correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# b" },
            }),
          invocationsB
        ),
      ],
      snapshotProvingPromptBuilder
    );

    const request = {
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId,
      cancellationToken: fakeToken(),
    };
    const [outcomeA, outcomeB] = await Promise.all([
      harnessA.coordinator.resumeAction(request),
      harnessB.coordinator.resumeAction(request),
    ]);

    const outcomes = [outcomeA, outcomeB];
    const completedCount = outcomes.filter((o) => o.kind === "completed").length;
    const blockedCount = outcomes.filter(
      (o) => o.kind === "failed" && o.code === "resumeInvocationAlreadyClaimed"
    ).length;
    assert.equal(completedCount, 1, "exactly one concurrent replay must complete");
    assert.equal(blockedCount, 1, "the other concurrent replay must be blocked, not invoke the provider");
    assert.equal(
      invocationsA.length + invocationsB.length,
      1,
      "the provider must be invoked exactly once across both concurrent replays"
    );
  });

  void it("resumes a replacementOperation interaction as a fresh linked operation", async () => {
    const completedTransport = envelopeTransport((correlation) =>
      frame({
        version: 1,
        correlation,
        kind: "completed",
        content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# resumed" },
      })
    );
    const harness = makeHarness([RESUME_QUESTIONS_TRANSPORT(), completedTransport], {
      resumeSemantics: "replacementOperation",
    });
    const original = await harness.coordinator.executeAction(baseRequest());
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const submitted = await harness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    const outcome = await harness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId: allocateHex128IdV1(),
      cancellationToken: fakeToken(),
    });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") {
      assert.fail("expected a completed outcome");
    }
    // replacementOperation: a fresh linked operation, never the source id.
    assert.notEqual(outcome.correlation.operationId, original.correlation.operationId);
    const settledRecord = await harness.orchestrator.getRecord(ref);
    assert.equal(settledRecord?.state, "settled");
    assert.equal(settledRecord?.settlement, "supersededByReplacementOperation");
    assert.equal(settledRecord?.resumeResolution?.kind, "replacementOperation");
    if (settledRecord?.resumeResolution?.kind === "replacementOperation") {
      assert.equal(
        settledRecord.resumeResolution.replacementOperationId,
        outcome.correlation.operationId
      );
    }
    assert.equal(harness.promoted.length, 1);
  });

  void it("rejects unknown, unanswerable, mismatched, ineligible, and duplicate-locked Resumes without settling", async () => {
    const harness = makeHarness([RESUME_QUESTIONS_TRANSPORT()]);
    const original = await harness.coordinator.executeAction(baseRequest());
    assert.equal(original.kind, "questions");
    if (original.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    const ref = {
      operationId: original.correlation.operationId,
      interactionId: original.interactionId,
      taskBindingId: original.correlation.taskBindingId,
      chatDocumentId: original.correlation.chatDocumentId,
      sourceAttemptId: original.correlation.attemptId,
    };
    const resume = (
      overrides: Partial<{
        interaction: typeof ref;
        taskBinding: typeof TASK_BINDING;
        taskStatus: string;
        resumeIdempotencyId: string;
        cancellationToken: vscode.CancellationToken;
      }> = {}
    ): ReturnType<typeof harness.coordinator.resumeAction> =>
      harness.coordinator.resumeAction({
        interaction: ref,
        taskBinding: TASK_BINDING,
        taskStatus: "active",
        taskStage: "plan",
        resumeIdempotencyId: allocateHex128IdV1(),
        cancellationToken: fakeToken(),
        ...overrides,
      });

    // Malformed idempotency id: rejected before anything is read.
    const malformed = await resume({ resumeIdempotencyId: "not-hex" });
    assert.equal(malformed.kind === "failed" && malformed.code, "invalidResumeIdempotencyId");

    // No submitted answers yet.
    const unanswered = await resume();
    assert.equal(unanswered.kind === "failed" && unanswered.code, "answersNotSubmitted");

    // Unknown interaction/operation references are AC-CHAT-TX-03 recovery
    // states, logged under the fallback channel (no row was resolved).
    const wrongInteraction = await resume({
      interaction: { ...ref, interactionId: allocateHex128IdV1() },
    });
    assert.deepEqual(wrongInteraction, { kind: "recoveryRequired", code: "chatRecoveryRequired" });
    const wrongOperation = await resume({
      interaction: { ...ref, operationId: allocateHex128IdV1() },
    });
    assert.deepEqual(wrongOperation, { kind: "recoveryRequired", code: "chatRecoveryRequired" });
    const lastRecord = harness.settlementRecords[harness.settlementRecords.length - 1]!;
    assert.equal(lastRecord.channel, "action.resume");
    assert.equal(lastRecord.actionKey, "resume.unresolved");

    const submitted = await harness.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "publish" }],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);

    // Foreign task/document binding.
    const mismatched = await resume({
      taskBinding: { taskBindingId: "some-other-task", chatDocumentId: "other-doc" },
    });
    assert.equal(mismatched.kind === "failed" && mismatched.code, "resumeBindingMismatch");

    // Current registry eligibility is revalidated at Resume time.
    const ineligible = await resume({ taskStatus: "completed" });
    assert.equal(ineligible.kind === "failed" && ineligible.code, "actionNotEligibleForStatus");

    // Pre-settlement cancellation leaves the interaction resumable.
    const cancelled = await resume({ cancellationToken: fakeToken(true) });
    assert.equal(cancelled.kind === "cancelled" && cancelled.code, "userCancelled");

    // Duplicate rejection precedes settlement: a Resume rejected by the
    // task-operation lease consumes nothing.
    const held = harness.leaseStore.acquire(
      TASK_BINDING.taskBindingId,
      "otherAction.v1",
      allocateHex128IdV1()
    );
    assert.equal(held.ok, true);
    const duplicate = await resume();
    assert.deepEqual(duplicate, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
    if (held.ok) {
      harness.leaseStore.release(held.lease.leaseId);
    }

    // Every rejection above left the transaction unsettled and resumable,
    // and no provider was invoked beyond the original questions run.
    const record = await harness.orchestrator.getRecord(ref);
    assert.equal(record?.state, "answersSubmitted");
    assert.equal(harness.selection.reserved, 1);
  });
});
