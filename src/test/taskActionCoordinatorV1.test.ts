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
import { createHash } from "node:crypto";
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
  chatTransactionFailureCodeV1,
  promotionFailureCodeV1,
  CandidateSkippedV1,
  createTaskActionCoordinatorV1,
  RunnerSelectionOpenerV1,
  TaskActionCoordinatorV1,
  TaskActionFollowUpRequestV1,
  TaskActionSettlementRecordV1,
  TaskActionToolSessionsV1,
  tryFramelessContentFallbackV1,
} from "../actions/taskActionCoordinatorV1";
import { BoundedResultStoreV1, createBoundedResultStoreV1 } from "../services/boundedResultStoreV1";
import { AgentExecutionBrokerOptionsV1 } from "../services/agentExecutionBrokerV1";
import { findMostRecentSpool } from "../commands/recoverLastAiResponse";
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
import { AgentTransportExitV1, AgentTransportV1 } from "../types/agentExecutionV1";
import { CompletedContentV1, MalformedAiResultV1 } from "../types/aiResultEnvelope";
import { MIGRATED_ACTION_KEYS_V0 } from "../services/legacyAiActionSafetyGateV0";
import { EDIT_EXECUTION_ACTION_KEY_V1 } from "../actions/rows/editExecutionRowV1";
import { createObservationLedgerV1 } from "../types/preflightPlanV1";
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
function stubSelectionOpener(
  transports: readonly AgentTransportV1[],
  exhaustion?: import("../types/taskActionOutcomeV1").ProviderChainExhaustionV1,
  /** false models a Copilot-shaped provider with no file access of its own. */
  providerReadsWorkspaceNatively = true
): StubSelectionSource {
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
            ? {
                kind: "noneRemaining",
                code: "providerModeUnavailable",
                ...(exhaustion !== undefined ? { chainExhaustion: exhaustion } : {}),
              }
            : {
                kind: "noneRemaining",
                code: "candidatesExhausted",
                ...(exhaustion !== undefined ? { chainExhaustion: exhaustion } : {}),
              };
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
            providerReadsWorkspaceNatively,
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
  extraRows: readonly TaskActionRegistryRowV1[] = [],
  brokerOptions?: AgentExecutionBrokerOptionsV1,
  selectionExhaustion?: import("../types/taskActionOutcomeV1").ProviderChainExhaustionV1,
  /** Read-tools wiring: a tool-session source plus whether the stub provider reads files itself. */
  readTools?: {
    readonly toolSessions: TaskActionToolSessionsV1;
    readonly providerReadsWorkspaceNatively: boolean;
  }
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
  const selection = stubSelectionOpener(
    transports,
    selectionExhaustion,
    readTools?.providerReadsWorkspaceNatively ?? true
  );
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
    ...(brokerOptions !== undefined ? { brokerOptions } : {}),
    ...(readTools !== undefined ? { toolSessions: readTools.toolSessions } : {}),
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

  /**
   * Whether a reviewer CAN read the workspace is a property of the PROVIDER,
   * not the row. A CLI provider opens files itself; Copilot's text transport
   * has no tools, so without a read session it judges from a possibly
   * truncated context pack — and reports work it could not see as missing
   * (jester 2026-08-18: ten rounds against committed, present tests).
   */
  function readSessionProbe(): {
    readonly toolSessions: TaskActionToolSessionsV1;
    readonly created: { value: number };
  } {
    const created = { value: 0 };
    return {
      created,
      toolSessions: {
        createPreflightSession: () => {
          throw new Error("a text row must never open a preflight session");
        },
        createEditSession: () => {
          throw new Error("a text row must never open an edit session");
        },
        createWorkspaceReadSession: () => {
          created.value += 1;
          return {
            handler: {
              descriptors: [],
              handleToolCall: (): Promise<string> => Promise.resolve("{}"),
              violationCount: (): number => 0,
            },
            ledger: createObservationLedgerV1(),
            rootId: "workspace:test-root",
          };
        },
      },
    };
  }

  function promptCapturingTransport(seen: { prompt: string }): AgentTransportV1 {
    return {
      runnerId: "scripted-transport",
      invoke: (request, output) => {
        seen.prompt = request.prompt;
        output.write(
          frame({
            version: 1,
            correlation: request.correlation,
            kind: "completed",
            content: {
              contentType: "markdown-artifact.v1",
              schemaVersion: 1,
              markdown: "ok",
            },
          })
        );
        return Promise.resolve({ kind: "completed" });
      },
    };
  }

  void it("gives a readsWorkspaceFiles row read tools when the provider cannot read files", async () => {
    const seen = { prompt: "" };
    const probe = readSessionProbe();
    const harness = makeHarness(
      [promptCapturingTransport(seen)],
      { readsWorkspaceFiles: true },
      [],
      undefined,
      undefined,
      { toolSessions: probe.toolSessions, providerReadsWorkspaceNatively: false }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(probe.created.value, 1, "a tool-less provider must be given the read session");
    // Attaching tools silently is the same failure as not attaching them: the
    // model has to be told, and told which root id to pass.
    assert.match(seen.prompt, /Workspace access/);
    assert.match(seen.prompt, /workspace:test-root/);
  });

  void it("gives no read session to a provider that reads the workspace natively", async () => {
    const seen = { prompt: "" };
    const probe = readSessionProbe();
    const harness = makeHarness(
      [promptCapturingTransport(seen)],
      { readsWorkspaceFiles: true },
      [],
      undefined,
      undefined,
      { toolSessions: probe.toolSessions, providerReadsWorkspaceNatively: true }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(probe.created.value, 0, "a CLI provider already reads files and needs no session");
    assert.doesNotMatch(seen.prompt, /Workspace access/);
  });

  void it("tells the model plainly when a readsWorkspaceFiles row's read session could not be attached", async () => {
    const seen = { prompt: "" };
    const probe = readSessionProbe();
    const throwingToolSessions: TaskActionToolSessionsV1 = {
      ...probe.toolSessions,
      createWorkspaceReadSession: () => {
        throw new Error("no open workspace folder for this task");
      },
    };
    const harness = makeHarness(
      [promptCapturingTransport(seen)],
      { readsWorkspaceFiles: true },
      [],
      undefined,
      undefined,
      { toolSessions: throwingToolSessions, providerReadsWorkspaceNatively: false }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed", "a failed read-session attach must still run the row, tool-less");
    assert.doesNotMatch(seen.prompt, /## Workspace access\s*$/m, "must not claim tools it does not have");
    assert.match(seen.prompt, /Workspace access — unavailable this attempt/);
    assert.match(seen.prompt, /could not be attached/);
  });

  void it("leaves a row that does not read workspace files unchanged", async () => {
    const seen = { prompt: "" };
    const probe = readSessionProbe();
    const harness = makeHarness(
      [promptCapturingTransport(seen)],
      {},
      [],
      undefined,
      undefined,
      { toolSessions: probe.toolSessions, providerReadsWorkspaceNatively: false }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(probe.created.value, 0);
    assert.doesNotMatch(seen.prompt, /Workspace access/);
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

  /**
   * Item 9 (2026-08-17..19 workflow-defects batch): the questions-admission
   * hash used to be computed from a prompt built WITHOUT the preflight tool
   * session's `ledger`/`rootId` in context — a preflight row's `buildPrompt`
   * weaves the root id into the text, so the admitted `promptInputSha256`
   * silently described bytes different from what the transport actually
   * received. Both are now assembled from the exact same `prompt` value.
   */
  void it("hashes the exact prompt bytes sent, including preflight session context, for a question-capable row", async () => {
    const seen = { prompt: "" };
    const preflightToolSessions: TaskActionToolSessionsV1 = {
      createPreflightSession: () => ({
        handler: {
          descriptors: [],
          handleToolCall: (): Promise<string> => Promise.resolve("{}"),
          violationCount: (): number => 0,
        },
        ledger: createObservationLedgerV1(),
        rootId: "preflight-root-item9",
      }),
      createEditSession: () => {
        throw new Error("not used by this test");
      },
      createWorkspaceReadSession: () => {
        throw new Error("not used by this test");
      },
    };
    const harness = makeHarness(
      [
        {
          runnerId: "scripted-transport",
          invoke: (request, output): Promise<{ kind: "completed" }> => {
            seen.prompt = request.prompt;
            output.write(
              frame({
                version: 1,
                correlation: request.correlation,
                kind: "questions",
                questions: [
                  { questionId: "q1", kind: "text", prompt: "Which stage?", required: true },
                ],
              })
            );
            return Promise.resolve({ kind: "completed" as const });
          },
        },
      ],
      {
        providerMode: "preflight",
        completedContentType: "preflight-plan.v1",
        buildPrompt: (context) =>
          context.preflight
            ? `PREFLIGHT ROOT ${context.preflight.rootId}`
            : "NO PREFLIGHT CONTEXT REACHED THIS ROW",
      },
      [],
      undefined,
      undefined,
      { toolSessions: preflightToolSessions, providerReadsWorkspaceNatively: true }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "questions");
    if (outcome.kind !== "questions") {
      assert.fail("expected a questions outcome");
    }
    // The prompt actually sent must have been built WITH the preflight
    // session's rootId in context — proof the admission-time assembly and
    // the invocation-time assembly are now the same code path.
    assert.match(seen.prompt, /PREFLIGHT ROOT preflight-root-item9/);

    // `promptContract` is persisted on the durable transaction record but is
    // not part of the orchestrator's `getRecord` read model, so it is read
    // back the same way the existing questions test above proves the file
    // was written through: directly off disk.
    const transactionPath = path.join(
      orchestratorTmpRoot,
      "workflow-runtime-v1",
      "chat-transactions",
      outcome.correlation.operationId,
      "transaction-v1.json"
    );
    const persisted = JSON.parse(fs.readFileSync(transactionPath, "utf8")) as {
      promptContract: { promptInputSha256: string };
    };
    const expectedSha256 = createHash("sha256").update(seen.prompt, "utf8").digest("hex");
    assert.equal(
      persisted.promptContract.promptInputSha256,
      expectedSha256,
      "the recorded prompt digest must describe the exact bytes the transport received"
    );
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

  void it("maps wrong content types and unpermitted kinds to malformedResult", async () => {
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
    assert.match(wrongTypeOutcome.detail ?? "", /received content type "chat-message\.v1"/);
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
    assert.match(unpermittedOutcome.detail ?? "", /received result kind "questions"/);
  });

  /**
   * 2026-08-06/07 live incident: four separate `impl-high-review` runs on
   * the "workflow" task settled `malformedResult (invalidFrame)` in one day,
   * each time with a substantively complete, correct markdown review
   * recovered from the discarded response — the model simply never attempted
   * the `<<<ENSEMBLE_AI_RESULT_V1>>>` frame at all, not merely misplaced it.
   * tryFramelessContentFallbackV1 rescues exactly that shape instead of
   * discarding real work.
   */
  void it("rescues a frameless-but-substantive text-mode response instead of discarding it as malformed", async () => {
    const harness = makeHarness([
      {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write(
            "Let me verify the implementation first.\n\nReadiness: 6.3/10\n\n## Summary\n\nEverything checks out."
          );
          return Promise.resolve({ kind: "completed" as const });
        },
      },
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "completed");
    assert.equal(harness.promoted.length, 1);
    assert.deepEqual(harness.promoted[0], {
      contentType: "markdown-artifact.v1",
      schemaVersion: 1,
      markdown:
        "Let me verify the implementation first.\n\nReadiness: 6.3/10\n\n## Summary\n\nEverything checks out.",
    });
  });

  void it("does not rescue a frameless response with a leading byte-order mark", async () => {
    const harness = makeHarness([
      {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write("﻿Readiness: 6.3/10\n\nA complete, substantive review with no frame at all.");
          return Promise.resolve({ kind: "completed" as const });
        },
      },
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "invalidFrame");
    assert.equal(harness.promoted.length, 0);
  });

  // Unit-tested directly against tryFramelessContentFallbackV1 rather than
  // through the full coordinator/broker pipeline: createBoundedResultWriterV1
  // captures text via `Buffer.from(chunk, "utf8")`, which already replaces a
  // lone surrogate with U+FFFD at write time (verified directly — a real
  // lone surrogate cannot survive that round-trip), so a transport-level
  // `output.write(...)` can never actually deliver one to this function in
  // practice. The guard stays as defense-in-depth for any other caller of
  // parseAiResultEnvelopeV1 whose raw text did not go through that writer —
  // exactly why aiResultEnvelope.test.ts's own equivalent test also calls
  // the parser directly rather than through a transport.
  void it("does not rescue a frameless response containing a lone (unpaired) UTF-16 surrogate", () => {
    const correlation: ActionCorrelationV1 = {
      actionKey: TEST_ACTION_KEY,
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      ...TASK_BINDING,
    };
    const malformed: MalformedAiResultV1 = {
      kind: "malformed",
      code: "invalidFrame",
      raw: "Readiness: 6.3/10\n\nA review with a stray surrogate: \uD800 right here.",
      reason: "input contains a lone (unpaired) UTF-16 surrogate",
    };
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
      promoteCompletedContent: () => Promise.resolve("completed"),
      loggingPolicy: { channel: "action.test", includeResultMetrics: true },
    };
    assert.equal(tryFramelessContentFallbackV1(row, correlation, malformed), undefined);
  });

  void it("does not rescue a frameless response that is too short to trust as real content", async () => {
    const harness = makeHarness([
      {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write("too short");
          return Promise.resolve({ kind: "completed" as const });
        },
      },
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "invalidFrame");
    assert.equal(harness.promoted.length, 0);
  });

  // 2026-08-07: parseAiResultEnvelopeV1 now scans for the LAST frame-start
  // marker and keeps only that frame, discarding anything before it — so two
  // complete, well-formed frames back to back are no longer "structurally
  // broken" at all; the second one wins outright (see
  // aiResultEnvelope.test.ts's own "keeps the LAST of two frames" test). A
  // frame that starts but never closes is still genuinely broken under the
  // new parser too, and is the case this test now covers instead.
  void it("does not rescue a response whose frame was attempted but is structurally broken", async () => {
    const harness = makeHarness([
      {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          // Frame start present, but the response ends before the closing
          // marker ever appears — the model attempted the contract and got a
          // structural detail wrong, a materially different — and more
          // suspicious — failure than never attempting it at all.
          output.write("<<<ENSEMBLE_AI_RESULT_V1>>>\nsomething went wrong mid-stream, never closed");
          return Promise.resolve({ kind: "completed" as const });
        },
      },
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "invalidFrame");
    assert.match(outcome.detail ?? "", /expected the frame to end with/);
    assert.equal(harness.promoted.length, 0);
  });

  void it("does not rescue a frameless response for a content type raw text cannot losslessly become", async () => {
    // commit-metadata.v1 needs a real subject/body split raw prose cannot
    // safely provide — deliberately excluded from the fallback's allowed set.
    const harness = makeHarness(
      [
        {
          runnerId: "scripted-transport",
          invoke: (_request, output): Promise<{ kind: "completed" }> => {
            output.write("A perfectly reasonable-looking commit message body, just never framed.");
            return Promise.resolve({ kind: "completed" as const });
          },
        },
      ],
      { completedContentType: "commit-metadata.v1" }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "invalidFrame");
    assert.equal(harness.promoted.length, 0);
  });

  /**
   * Live incident, 2026-08-06: a review settled `malformedResult
   * (invalidFrame)` after the model did the work correctly and only omitted
   * the required output frame. Nothing in the coordinator kept a copy of
   * what it actually said — the only reason it was recoverable at all was
   * that the CLI provider happened to keep its own private session
   * transcript, which is provider-specific luck, not something Ensemble
   * controls. This proves the coordinator now keeps its own recovery copy
   * whenever a spool store is configured, independent of any provider's own
   * transcript behavior.
   */
  void it("preserves a malformed result's raw text for recovery when a spool store is configured", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-recovery-spool-"));
    const spoolStore = createBoundedResultStoreV1({ rootDir });
    // Well-framed but invalid JSON inside: "invalidJson", never rescued by
    // tryFramelessContentFallbackV1 (which only ever touches "invalidFrame"),
    // so this keeps testing genuine malformed-result recovery regardless of
    // that fallback's own tuning.
    const rawText = "<<<ENSEMBLE_AI_RESULT_V1>>>\nnot valid json\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n";
    const harness = makeHarness(
      [
        {
          runnerId: "scripted-transport",
          invoke: (_request, output): Promise<{ kind: "completed" }> => {
            output.write(rawText);
            return Promise.resolve({ kind: "completed" as const });
          },
        },
      ],
      {},
      [],
      { spoolStore }
    );
    try {
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind !== "malformedResult") {
        assert.fail("expected malformedResult");
      }
      assert.equal(outcome.code, "invalidJson");
      assert.match(outcome.detail ?? "", /response preserved for recovery/);
      assert.match(
        outcome.detail ?? "",
        new RegExp(`operationId=${outcome.correlation.operationId}`)
      );

      // Read the recovery copy back directly from disk — the same layout
      // boundedResultStoreV1.ts documents (<root>/<op>/<attempt>/<reservation>/
      // result-v1.bin) — proving the ACTUAL text was preserved, not just that
      // the outcome claims it was.
      const spoolFiles: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name === "result-v1.bin") {
            spoolFiles.push(full);
          }
        }
      };
      walk(rootDir);
      assert.equal(spoolFiles.length, 1, "exactly one recovery spool must be written");
      assert.equal(fs.readFileSync(spoolFiles[0]!, "utf8"), rawText);

      // The persisted meta must carry purpose: "recovery" — this is what lets
      // a reader walking the SAME store's tree (Recover Last AI Response)
      // tell this apart from an ordinary broker spool for a large in-flight
      // or already-settled response, which never sets this field.
      const metaPath = path.join(path.dirname(spoolFiles[0]!), "spool-meta-v1.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { purpose?: string };
      assert.equal(meta.purpose, "recovery");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("never blocks settlement when no spool store is configured — recovery is best-effort", async () => {
    // The default harness (used by every other test in this suite) passes no
    // brokerOptions at all; this pins that the malformedResult path still
    // settles cleanly with no detail crash and no thrown error. Short enough
    // (under FRAMELESS_FALLBACK_MIN_CHARS_V1) to stay genuinely malformed
    // rather than being rescued by tryFramelessContentFallbackV1.
    const harness = makeHarness([
      {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write("no frame at all");
          return Promise.resolve({ kind: "completed" as const });
        },
      },
    ]);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.doesNotMatch(outcome.detail ?? "", /response preserved for recovery/);
  });

  /**
   * Live incident, 2026-08-15 (Copilot desc): the envelope PARSED — version,
   * correlation, kind all valid — and settlement then rejected the content,
   * which used to preserve nothing. These four tests are the evidence that
   * both settlement-time `contentSchemaMismatch` origins now keep a
   * recovery copy the Recover Last AI Response command can actually find,
   * and that when no copy could be kept the outcome says so explicitly
   * instead of leaving success and failure indistinguishable.
   */
  void it("preserves the rejected response when settlement rejects a result kind the row does not permit", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-settle-kind-spool-"));
    const spoolStore = createBoundedResultStoreV1({ rootDir });
    const questionsEnvelope = (correlation: ActionCorrelationV1): unknown => ({
      version: 1,
      correlation,
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "text",
          prompt: "Which stage?",
          required: true,
        },
      ],
    });
    const harness = makeHarness(
      [envelopeTransport((correlation) => frame(questionsEnvelope(correlation)))],
      // Exclude "questions" so the well-formed questions envelope lands on
      // settleEnvelope's kind-not-permitted origin, not the questions flow.
      { permittedResultKinds: ["completed", "cancelled", "failed"] },
      [],
      { spoolStore }
    );
    try {
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind !== "malformedResult") {
        assert.fail("expected malformedResult");
      }
      assert.equal(outcome.code, "contentSchemaMismatch");
      assert.match(outcome.detail ?? "", /received result kind "questions"/);
      assert.match(outcome.detail ?? "", /response preserved for recovery in extension private storage/);
      assert.match(outcome.detail ?? "", /Recover Last AI Response/);
      assert.match(outcome.detail ?? "", /vs-code-ai-helper\.recoverLastAiResponse/);

      // The spool must be discoverable the way the user reaches it — through
      // the Recover Last AI Response command's own scan, not just on disk.
      const found = findMostRecentSpool(rootDir);
      assert.ok(found, "findMostRecentSpool must surface the recovery spool");
      assert.equal(found.meta.purpose, "recovery");
      assert.equal(found.meta.operationId, outcome.correlation.operationId);
      assert.equal(found.meta.providerLabel, "Test Provider");
      assert.equal(
        fs.readFileSync(found.binPath, "utf8"),
        frame(questionsEnvelope(outcome.correlation)),
        "the preserved bytes must be the exact unsealed response text"
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("preserves the rejected response when settlement rejects a completed result's content type", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-settle-ctype-spool-"));
    const spoolStore = createBoundedResultStoreV1({ rootDir });
    const mismatchedEnvelope = (correlation: ActionCorrelationV1): unknown => ({
      version: 1,
      correlation,
      kind: "completed",
      // Valid, decodable content — of the WRONG type for the row (which
      // expects markdown-artifact.v1), the exact 2026-08-15 desc shape.
      content: { contentType: "chat-message.v1", schemaVersion: 1, text: "a perfectly valid chat reply" },
    });
    const harness = makeHarness(
      [envelopeTransport((correlation) => frame(mismatchedEnvelope(correlation)))],
      {},
      [],
      { spoolStore }
    );
    try {
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind !== "malformedResult") {
        assert.fail("expected malformedResult");
      }
      assert.equal(outcome.code, "contentSchemaMismatch");
      assert.match(
        outcome.detail ?? "",
        /received content type "chat-message\.v1", expected "markdown-artifact\.v1"/
      );
      assert.match(outcome.detail ?? "", /response preserved for recovery in extension private storage/);
      assert.match(outcome.detail ?? "", /Recover Last AI Response/);

      const found = findMostRecentSpool(rootDir);
      assert.ok(found, "findMostRecentSpool must surface the recovery spool");
      assert.equal(found.meta.purpose, "recovery");
      assert.equal(found.meta.operationId, outcome.correlation.operationId);
      assert.equal(
        fs.readFileSync(found.binPath, "utf8"),
        frame(mismatchedEnvelope(outcome.correlation)),
        "the preserved bytes must be the exact unsealed response text"
      );
      assert.equal(harness.promoted.length, 0);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("states explicitly that nothing was preserved when settlement rejects with no spool store configured", async () => {
    // Default harness: no brokerOptions at all. The settled outcome must say
    // the response was NOT kept and why — silence here is what made the
    // 2026-08-15 failure look identical whether a copy existed or not.
    const harness = makeHarness(
      [
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation,
            kind: "completed",
            content: { contentType: "chat-message.v1", schemaVersion: 1, text: "valid but wrong type" },
          })
        ),
      ]
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "contentSchemaMismatch");
    assert.match(
      outcome.detail ?? "",
      /response NOT preserved \(no recovery spool store is configured for this workspace\)/
    );
    assert.doesNotMatch(outcome.detail ?? "", /response preserved for recovery/);
  });

  void it("states explicitly that nothing was preserved when the recovery write fails, without altering the settled outcome", async () => {
    const failingStore = {
      writeSpool: (): Promise<never> => Promise.reject(new Error("disk full")),
    } as unknown as BoundedResultStoreV1;
    const harness = makeHarness(
      [
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation,
            kind: "completed",
            content: { contentType: "chat-message.v1", schemaVersion: 1, text: "valid but wrong type" },
          })
        ),
      ],
      {},
      [],
      { spoolStore: failingStore }
    );
    const outcome = await harness.coordinator.executeAction(baseRequest());
    // Best-effort contract: the write failure changes only the detail clause,
    // never the settled kind/code.
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "contentSchemaMismatch");
    assert.match(outcome.detail ?? "", /response NOT preserved \(writing the recovery copy failed\)/);
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

  /**
   * 2026-08-12 field report, item 2: a malformed result used to be retried
   * only against the SAME resolved primary candidate
   * (`withMalformedResultRetryV1`) — a stage with four configured backups
   * under `switch-to-backup` never reached any of them. The coordinator loop
   * now advances to the next ranked candidate on a malformed result, exactly
   * like the existing pre-response `transportFailure` fallback above.
   */
  void describe("malformed-result candidate advancement", () => {
    function malformedTransport(): AgentTransportV1 {
      return {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write("<<<ENSEMBLE_AI_RESULT_V1>>>\nnot valid json\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n");
          return Promise.resolve({ kind: "completed" as const });
        },
      };
    }

    void it("advances to the next candidate on a malformed result and recovers on the second", async () => {
      const harness = makeHarness([
        malformedTransport(),
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation,
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
          })
        ),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "completed");
      assert.equal(harness.promoted.length, 1);
      assert.equal(harness.selection.reserved, 2, "the second candidate must have been reserved");
    });

    /**
     * The budget is pinned at MAX_MALFORMED_RESULT_INVOCATIONS_V1 = 3 (the
     * initial attempt plus at most two advances) so a five-candidate stage
     * cannot burn five CLI invocations on one press.
     */
    void it("stops advancing after 3 total invocations, even with more candidates configured", async () => {
      const harness = makeHarness([
        malformedTransport(),
        malformedTransport(),
        malformedTransport(),
        malformedTransport(),
        malformedTransport(),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      assert.equal(
        harness.selection.reserved,
        3,
        "only the initial attempt plus two advances may be reserved"
      );
    });

    void it("returns the last malformed outcome, not providerModeUnavailable, when candidates run out", async () => {
      // Exactly two candidates configured, both malformed: the loop advances
      // once, the second candidate also comes back malformed, and reserving
      // a third finds nothing left. The exhaustion must not mask the real
      // failure behind a misleading "no provider available".
      const harness = makeHarness([malformedTransport(), malformedTransport()]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind !== "malformedResult") {
        assert.fail("expected malformedResult, not providerModeUnavailable");
      }
      assert.equal(outcome.code, "invalidJson");
      assert.equal(harness.selection.reserved, 2);
    });

    void it("does not advance candidates for a resultCorrelationMismatch", async () => {
      // A foreign-operation echo is a correlation bug, not a bad provider
      // response — a different candidate cannot fix it, so this must settle
      // on the first candidate exactly as before this step.
      const harness = makeHarness([
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation: { ...correlation, operationId: allocateHex128IdV1() },
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# x" },
          })
        ),
        envelopeTransport(() => {
          throw new Error("must not advance past a resultCorrelationMismatch");
        }),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind !== "malformedResult") {
        assert.fail("expected malformedResult");
      }
      assert.equal(outcome.code, "resultCorrelationMismatch");
      assert.equal(harness.selection.reserved, 1);
    });

    // Excluded action key, matching `retryOnMalformedResultV1`'s existing
    // exclusion and its reasoning (productionTaskActionRuntimeV1.ts): a
    // partially-executed edit-broker session cannot safely restart from a
    // fresh conversation, so `editExecution.v1` never advances candidates on
    // a malformed result even when (as synthesized here) it happens to be
    // wired as a text-mode row. Production `editExecution.v1` rows are
    // always non-text anyway, so the providerMode check above already
    // covers that shape in practice; this test isolates the action-key
    // check specifically.
    void it("does not advance candidates for the editExecution.v1 action key", async () => {
      const editRow: ProviderTaskActionRowV1 = {
        kind: "provider",
        actionKey: EDIT_EXECUTION_ACTION_KEY_V1,
        routes: ["vs-code-ai-helper.testEditExecutionRoute"],
        eligibility: { statuses: ["active"], stages: ["plan"] },
        requiresTaskOperationLease: true,
        progressLabel: "Testing…",
        providerMode: "text",
        maxResponseBytes: 64 * 1024,
        permittedResultKinds: ["completed", "cancelled", "failed"],
        completedContentType: "markdown-artifact.v1",
        resumeSemantics: "sameOperation",
        validateInput: (input) => ({ ok: true, input }),
        buildPrompt: () => "ACTION PROMPT",
        promoteCompletedContent: () => Promise.resolve("completed"),
        loggingPolicy: { channel: "action.test", includeResultMetrics: false },
      };
      const selection = stubSelectionOpener([malformedTransport(), malformedTransport()]);
      const coordinator = createTaskActionCoordinatorV1({
        registry: createTaskActionRegistryV1([editRow]),
        leaseStore: createWorkflowLeaseStoreV1(),
        openRunnerSelection: selection.opener,
        orchestrator: makeOrchestrator(),
        followUpScheduler: { schedule: (): void => undefined },
        presenter: { beginProgress: () => ({ end: (): void => undefined }) },
        auditLogger: { log: (): void => undefined },
      });
      const outcome = await coordinator.executeAction({
        ...baseRequest(),
        actionKey: EDIT_EXECUTION_ACTION_KEY_V1,
      });
      assert.equal(outcome.kind, "malformedResult");
      assert.equal(
        selection.reserved,
        1,
        "editExecution.v1 must not advance past a malformed result"
      );
    });

    /**
     * `TaskActionRequestV1.malformedInvocationsAlreadyUsedV1` seeds this
     * operation's own counter (2026-08-13 review fix): without it, a
     * genuinely fresh operation started by `withMalformedResultRetryV1`
     * after a first operation already spent part of the shared 3-invocation
     * budget would start counting from zero again, letting one user press
     * reach up to 5-6 total provider invocations instead of the approved 3.
     */
    void it("seeds the invocation counter from malformedInvocationsAlreadyUsedV1, capping the combined total at 3", async () => {
      const harness = makeHarness([malformedTransport(), malformedTransport(), malformedTransport()]);
      const outcome = await harness.coordinator.executeAction({
        ...baseRequest(),
        malformedInvocationsAlreadyUsedV1: 2,
      });
      assert.equal(outcome.kind, "malformedResult");
      // Seeded at 2 already-used: only ONE more invocation is permitted
      // before hitting the shared cap of 3, so only a single candidate may
      // be reserved by this operation.
      assert.equal(
        harness.selection.reserved,
        1,
        "only one more invocation may run once 2 of the shared 3-budget is already spent"
      );
      if (outcome.kind === "malformedResult") {
        assert.equal(
          outcome.malformedInvocationsUsedV1,
          3,
          "the reported count must be the cumulative total (2 already used + 1 more), not this operation's own delta"
        );
      }
    });

    function preResponseFailingTransport(): AgentTransportV1 {
      return {
        runnerId: "scripted-transport",
        invoke: () => Promise.resolve({ kind: "transportFailure" as const, code: "connectFailed" }),
      };
    }

    /**
     * 2026-08-13 review fix: `malformedInvocationCountV1` counts EVERY
     * invocation once a malformed result has armed the shared budget — not
     * just ones caused by another malformed result. Before this fix, a
     * pre-response `transportFailure` always advanced unconditionally
     * (mirroring the ordinary transport-failure fallback), so a malformed
     * result followed by transport failures could push this operation's
     * total invocations past the 3-invocation cap. With a malformed result
     * on attempt 1 and transport failures on attempts 2 and 3, attempt 3's
     * increment reaches the cap (count=3) and must stop the loop rather
     * than reserving a 4th candidate.
     */
    void it("caps total invocations at 3 when a malformed result is followed by transport failures", async () => {
      const harness = makeHarness([
        malformedTransport(),
        preResponseFailingTransport(),
        preResponseFailingTransport(),
        envelopeTransport(() => {
          throw new Error("must not reserve a 4th candidate once the shared budget is exhausted");
        }),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind === "malformedResult") {
        assert.equal(
          outcome.code,
          "invalidJson",
          "the honest diagnosis (the malformed result from attempt 1) must be reported, not masked by the later transport failures"
        );
        assert.equal(
          outcome.malformedInvocationsUsedV1,
          3,
          // 2026-08-13 review fix: the stamped count must track the
          // operation's TOTAL invocations (1 malformed + 2 transport
          // failures = 3), not the count at the moment the malformed result
          // occurred (1). A stale count here would let the outer wrapper in
          // productionTaskActionRuntimeV1.ts believe only 1 of 3 invocations
          // had been spent and open further operations past the shared cap.
        );
      }
      assert.equal(
        harness.selection.reserved,
        3,
        "only 3 total invocations may be reserved once the malformed budget is armed"
      );
    });

    /**
     * Same guard, but the budget arrives already-armed via
     * `malformedInvocationsAlreadyUsedV1` from a prior fresh operation
     * (rather than a malformed result within this operation itself). A
     * pre-response transport failure on the one invocation this operation
     * is permitted must not advance to a 2nd candidate.
     */
    void it("caps a transport failure at the seeded budget when armed via malformedInvocationsAlreadyUsedV1", async () => {
      const harness = makeHarness([
        preResponseFailingTransport(),
        envelopeTransport(() => {
          throw new Error("must not reserve a 2nd candidate once the seeded budget is exhausted");
        }),
      ]);
      const outcome = await harness.coordinator.executeAction({
        ...baseRequest(),
        malformedInvocationsAlreadyUsedV1: 2,
      });
      assert.equal(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        assert.equal(outcome.code, "connectFailed");
        assert.equal(outcome.retryable, true);
      }
      assert.equal(
        harness.selection.reserved,
        1,
        "only the one remaining invocation of the seeded 3-budget may be reserved"
      );
    });
  });

  /**
   * Item 14: a transport-flagged network fault (dropped connection, DNS
   * failure, TLS handshake failure, HTTP/2 protocol error) earns one
   * immediate retry of the SAME candidate before the loop falls through to
   * the next ranked one — falling straight to a backup would silently
   * change which model authors the artifact for a reason that had nothing
   * to do with the model.
   */
  void describe("network-fault same-candidate retry", () => {
    /** Fails with a flagged network fault on its first call, then succeeds. */
    function networkFaultOnceThenCompletes(): AgentTransportV1 {
      let calls = 0;
      return {
        runnerId: "scripted-transport",
        invoke: (request, output): Promise<AgentTransportExitV1> => {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              kind: "transportFailure" as const,
              code: "copilotRequestFailed",
              networkFault: true,
            });
          }
          output.write(frame({
            version: 1,
            correlation: request.correlation,
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
          }));
          return Promise.resolve({ kind: "completed" as const });
        },
      };
    }

    function networkFaultAlways(): AgentTransportV1 {
      return {
        runnerId: "scripted-transport",
        invoke: () =>
          Promise.resolve({
            kind: "transportFailure" as const,
            code: "copilotRequestFailed",
            networkFault: true,
          }),
      };
    }

    function malformedTransport(): AgentTransportV1 {
      return {
        runnerId: "scripted-transport",
        invoke: (_request, output): Promise<{ kind: "completed" }> => {
          output.write("<<<ENSEMBLE_AI_RESULT_V1>>>\nnot valid json\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n");
          return Promise.resolve({ kind: "completed" as const });
        },
      };
    }

    void it("retries the same candidate once on a flagged network fault, without reserving a new one", async () => {
      const harness = makeHarness([
        networkFaultOnceThenCompletes(),
        envelopeTransport(() => {
          throw new Error("must not reserve a 2nd candidate — the retry must reuse the first");
        }),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "completed");
      assert.equal(
        harness.selection.reserved,
        1,
        "the retry re-reserves the SAME candidate directly through the session, never through the registry's ranked cursor"
      );
    });

    void it("falls through to the next candidate once the one retry is also a network fault", async () => {
      const harness = makeHarness([
        networkFaultAlways(),
        envelopeTransport((correlation) =>
          frame({
            version: 1,
            correlation,
            kind: "completed",
            content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# ok" },
          })
        ),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "completed");
      assert.equal(
        harness.selection.reserved,
        2,
        "one retry (not counted as a reservation) then one genuine fallback to the 2nd ranked candidate"
      );
    });

    void it("does not retry once the malformed-result budget is armed and exhausted", async () => {
      const harness = makeHarness([
        malformedTransport(),
        networkFaultAlways(),
        envelopeTransport(() => {
          throw new Error("must not reserve a 3rd candidate once the shared budget is exhausted");
        }),
      ]);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      // 1 (malformed) + 1 (network-fault fallback, budget already armed at
      // that point) = 2 total invocations; the retry that would make a 3rd
      // must be refused by the same shared-cap check the ordinary fallback
      // uses, leaving the malformed result as the honest diagnosis.
      assert.equal(outcome.kind, "malformedResult");
      assert.equal(
        harness.selection.reserved,
        2,
        "the network-fault retry must not push total invocations past the shared 3-budget once armed"
      );
    });
  });

  /**
   * Coordinator-policy seam tests for the candidate-scoped content-contract
   * fallback (2026-08-16 field report, fourth item;
   * `classifyProviderCandidateDispositionV1` in providerSelectionPolicyV1.ts).
   * A row-owned `validateCompletedContent` failure (e.g. review.v1's missing
   * "Readiness: N/10" line) must behave exactly like a malformed envelope for
   * fallback purposes: advance to the next ranked candidate without acquiring
   * a lease or writing an artifact for the rejected candidate, terminate as a
   * non-retryable `contentContractFailed` failure (never `malformedResult`)
   * when no candidate remains, and never cascade past a promotion failure
   * that happens AFTER a candidate's content already passed validation.
   */
  void describe("content-contract candidate advancement", () => {
    const REQUIRED_MARKER = "MAGIC";
    function requireMagicMarker(
      content: CompletedContentV1
    ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
      if (content.contentType !== "markdown-artifact.v1") {
        return { ok: false, reason: "expected markdown-artifact.v1" };
      }
      return content.markdown.includes(REQUIRED_MARKER)
        ? { ok: true }
        : { ok: false, reason: `missing required "${REQUIRED_MARKER}" marker` };
    }

    function markdownEnvelopeTransport(markdown: string): AgentTransportV1 {
      return envelopeTransport((correlation) =>
        frame({
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
        })
      );
    }

    void it(
      "advances to the next candidate on a content-contract failure and completes on the second, " +
        "with no lease acquisition or artifact write for the rejected first candidate",
      async () => {
        const harness = makeHarness(
          [markdownEnvelopeTransport("no marker here"), markdownEnvelopeTransport("has the MAGIC marker")],
          { validateCompletedContent: requireMagicMarker }
        );
        const outcome = await harness.coordinator.executeAction(baseRequest());
        assert.equal(outcome.kind, "completed");
        assert.equal(harness.selection.reserved, 2, "the second candidate must have been reserved");
        assert.equal(
          harness.promoted.length,
          1,
          "promoteCompletedContent (and thus lease acquisition/artifact write) must run once, for the second candidate only"
        );
        assert.equal(harness.promoted[0]?.contentType, "markdown-artifact.v1");
      }
    );

    void it(
      "terminates with a non-retryable contentContractFailed outcome (not malformedResult) when no backup candidate remains",
      async () => {
        const harness = makeHarness([markdownEnvelopeTransport("no marker here")], {
          validateCompletedContent: requireMagicMarker,
        });
        const outcome = await harness.coordinator.executeAction(baseRequest());
        assert.equal(outcome.kind, "failed");
        if (outcome.kind === "failed") {
          assert.equal(outcome.code, "contentContractFailed");
          assert.equal(outcome.retryable, false);
        }
        assert.equal(harness.selection.reserved, 1);
        assert.equal(harness.promoted.length, 0, "no candidate's content ever passed validation");
      }
    );

    void it(
      "does not cascade to a further candidate when promotion fails after content-contract validation passed",
      async () => {
        const harness = makeHarness(
          [
            markdownEnvelopeTransport("has the MAGIC marker"),
            envelopeTransport(() => {
              throw new Error("must not reserve a 2nd candidate once promotion has already failed terminally");
            }),
          ],
          {
            validateCompletedContent: requireMagicMarker,
            promoteCompletedContent: () => {
              throw new Error("simulated CAS/storage conflict");
            },
          }
        );
        const outcome = await harness.coordinator.executeAction(baseRequest());
        assert.equal(outcome.kind, "failed");
        if (outcome.kind === "failed") {
          assert.equal(outcome.retryable, false);
        }
        assert.equal(
          harness.selection.reserved,
          1,
          "a promotion/storage failure after content validation passed must not cascade to another candidate"
        );
      }
    );
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

  void it(
    "fires onAttemptAllocated even when no candidate remains, before onPromptAssembled " +
      "(2026-08-28 review, blocker: pre-prompt failure branches never attach an identity)",
    async () => {
      // `admitAction`'s own pre-admission allocation loop reaches its
      // `noneRemaining` branch immediately with zero candidates — assembly
      // never runs, so `onPromptAssembled` never fires for this attempt at
      // all. `onAttemptAllocated` must still report it, since it fires the
      // instant `session.allocateAttempt()` returns, strictly before the
      // `noneRemaining` check that produces the "unavailable" outcome.
      const harness = makeHarness([]);
      const allocated: { attemptId: string; operationId: string }[] = [];
      const assembled: unknown[] = [];
      const outcome = await harness.coordinator.executeAction({
        ...baseRequest(),
        onAttemptAllocated: (info) => {
          allocated.push(info);
        },
        onPromptAssembled: (info) => {
          assembled.push(info);
        },
      });
      assert.deepEqual(outcome, { kind: "unavailable", code: "providerModeUnavailable" });
      assert.equal(allocated.length, 1);
      assert.ok(/^[0-9a-f]+$/i.test(allocated[0]!.attemptId));
      assert.ok(/^[0-9a-f]+$/i.test(allocated[0]!.operationId));
      assert.equal(assembled.length, 0);
    }
  );

  void it("settles rather than leaking progress when allocation-ledger attachment rejects during admission", async () => {
    const harness = makeHarness([]);
    const outcome = await harness.coordinator.executeAction({
      ...baseRequest(),
      onAttemptAllocated: () => Promise.reject(new Error("ledger write unavailable")),
    });
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "attemptIdentityAttachmentFailed");
      assert.equal(outcome.retryable, true);
      assert.ok(outcome.correlation, "the failed allocation keeps its attempt identity");
      assert.match(outcome.correlation.attemptId, /^[0-9a-f]{32}$/);
    }
    assert.equal(harness.presentationEnded.value, true, "admission failure must close progress");
    assert.equal(harness.settlementRecords.length, 1, "admission failure must be audited once");
    assert.equal(harness.settlementRecords[0]!.outcomeCode, "attemptIdentityAttachmentFailed");
    assert.equal(harness.selection.reserved, 0, "a failed attachment must prevent provider reservation");
  });

  void it("settles a retry allocation attachment rejection without invoking the retry", async () => {
    const networkFault: AgentTransportV1 = {
      runnerId: "network-fault",
      invoke: () => Promise.resolve({ kind: "transportFailure" as const, code: "connectionLost", networkFault: true }),
    };
    const harness = makeHarness([networkFault]);
    let allocations = 0;
    const outcome = await harness.coordinator.executeAction({
      ...baseRequest(),
      onAttemptAllocated: () => {
        allocations++;
        if (allocations === 2) {
          return Promise.reject(new Error("ledger write unavailable"));
        }
        return Promise.resolve();
      },
    });
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "attemptIdentityAttachmentFailed");
      assert.equal(outcome.retryable, true);
      assert.ok(outcome.correlation, "the failed retry keeps its attempt identity");
      assert.match(outcome.correlation.attemptId, /^[0-9a-f]{32}$/);
    }
    assert.equal(allocations, 2);
    assert.equal(harness.presentationEnded.value, true);
    assert.equal(harness.settlementRecords.length, 1);
    assert.equal(harness.selection.reserved, 1, "the retry must not reserve or invoke a provider");
  });

  void it("passes the registry's chain-exhaustion evidence through verbatim, mutating no task state", async () => {
    // Finding 4: the coordinator is a pure pass-through for the structured
    // exhaustion evidence — the stage owner (not the coordinator) pauses the
    // task and writes the enriched run record. Asserted here: the evidence
    // arrives on the outcome byte-identical, the lease is released, and no
    // task-progress mutation surface was ever touched (this harness wires
    // none, so any attempted mutation would throw).
    const exhaustion = {
      stage: "impl-high-review",
      candidates: [
        {
          storedModelId: "cline-cli:kimi-k3",
          providerLabel: "Cline CLI",
          runnerId: "cline-cli",
          reason: "the CLI is not installed",
        },
        {
          storedModelId: "kimi-cli:k3",
          providerLabel: "Kimi CLI",
          runnerId: "kimi-cli",
          reason: "authentication failure: not logged in",
        },
      ],
    };
    const harness = makeHarness([], {}, [], undefined, exhaustion);
    const outcome = await harness.coordinator.executeAction(baseRequest());
    assert.deepEqual(outcome, {
      kind: "unavailable",
      code: "providerModeUnavailable",
      chainExhaustion: exhaustion,
    });
    assert.equal(
      harness.leaseStore.heldLease(TASK_BINDING.taskBindingId),
      undefined,
      "the lease must be released like any other unavailable settlement"
    );
  });

  void it(
    "reports candidatesExhausted with real per-attempt outcomes when every candidate was invoked and failed",
    async () => {
      // The opposite condition from the previous test: here every candidate
      // WAS reserved and invoked (both via a pre-response transport failure,
      // fallback-eligible) before the chain ran out. Collapsing this onto
      // `providerModeUnavailable` — as the coordinator used to do — is what
      // cost a multi-hour Copilot misdiagnosis on 2026-08-15 (workflow 3
      // continuation, third item): the code must say "tried and failed", not
      // "nothing was available", and each candidate's placeholder reason must
      // be replaced with what the session actually recorded for it.
      const failingOnce: AgentTransportV1 = {
        runnerId: "scripted-transport",
        invoke: () => Promise.resolve({ kind: "transportFailure" as const, code: "connectFailed" }),
      };
      const exhaustion = {
        stage: "impl-high-review",
        candidates: [
          {
            storedModelId: "copilot:test",
            providerLabel: "Test Provider",
            runnerId: "scripted-transport",
            reason: "not attempted",
          },
          {
            storedModelId: "copilot:test",
            providerLabel: "Test Provider",
            runnerId: "scripted-transport",
            reason: "not attempted",
          },
        ],
      };
      const harness = makeHarness([failingOnce, failingOnce], {}, [], undefined, exhaustion);
      const outcome = await harness.coordinator.executeAction(baseRequest());
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") {
        assert.fail("expected unavailable");
      }
      assert.equal(
        outcome.code,
        "candidatesExhausted",
        "every candidate was reserved and invoked, so this is the opposite of providerModeUnavailable"
      );
      assert.equal(harness.selection.reserved, 2);
      assert.deepEqual(
        outcome.chainExhaustion?.candidates.map((candidate) => candidate.reason),
        [
          "invoked, but the transport failed before any response arrived - connectFailed",
          "invoked, but the transport failed before any response arrived - connectFailed",
        ],
        "each candidate's placeholder reason must be replaced with its actual recorded per-attempt outcome"
      );
      // The stable phrase is retained verbatim and the fault CLASS appended.
      // Without the code every pre-response failure rendered identically, so a
      // three-candidate chain produced three indistinguishable lines and named
      // no remedy (workflow 5 run 039). cliRunTimeout, cliNotInstalled and
      // cliExit.1 must not read the same.
      for (const candidate of outcome.chainExhaustion?.candidates ?? []) {
        assert.match(candidate.reason, /^invoked, but the transport failed before any response arrived/);
        assert.match(candidate.reason, /connectFailed/);
      }
    }
  );

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

  // A skipped candidate used to be recorded ONLY inside the selection session:
  // the loop settled the attempt, moved to the next candidate, and nothing the
  // user could ever see said their configured model had been passed over. That
  // is how codex-cli stayed invisible — resolving, reporting available, listed
  // in the picker, refused on every V1 action while a backup answered for it.
  // A hand-rolled selection is used deliberately here rather than the real
  // registry: this asserts the coordinator's own reporting, and it must not
  // reach a transport that could spawn a provider CLI.
  function skippingSelectionOpener(skips: readonly {
    storedModelId: string;
    providerLabel: string;
    runnerId: string;
  }[]): RunnerSelectionOpenerV1 {
    return (request) => {
      let index = 0;
      return {
        reserveNext: (attemptId): V1ReserveNextResultV1 => {
          const skip = skips[index++];
          if (!skip) {
            return { kind: "noneRemaining", code: "providerModeUnavailable" };
          }
          // Mirror the real registry: it settles the attempt itself before
          // returning candidateUnavailable, so the session's
          // one-outcome-per-attempt accounting stays complete.
          request.session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
          return {
            kind: "candidateUnavailable",
            code: "providerModeUnavailable",
            storedModelId: skip.storedModelId,
            providerLabel: skip.providerLabel,
            runnerId: skip.runnerId,
          };
        },
      };
    };
  }

  function skipTestRow(): ProviderTaskActionRowV1 {
    return {
      kind: "provider",
      actionKey: TEST_ACTION_KEY,
      routes: [TEST_ROUTE],
      eligibility: { statuses: ["active"], stages: ["plan"] },
      requiresTaskOperationLease: true,
      progressLabel: "Testing…",
      providerMode: "text",
      maxResponseBytes: 64 * 1024,
      permittedResultKinds: ["completed", "cancelled", "failed"],
      completedContentType: "markdown-artifact.v1",
      resumeSemantics: "sameOperation",
      validateInput: (input) => ({ ok: true, input }),
      buildPrompt: () => "ACTION PROMPT",
      promoteCompletedContent: () => Promise.resolve("completed"),
      loggingPolicy: { channel: "action.test", includeResultMetrics: false },
    };
  }

  void it("reports every skipped candidate to onCandidateSkipped instead of dropping it silently", async () => {
    const skipped: CandidateSkippedV1[] = [];
    const coordinator = createTaskActionCoordinatorV1({
      registry: createTaskActionRegistryV1([skipTestRow()]),
      leaseStore: createWorkflowLeaseStoreV1(),
      openRunnerSelection: skippingSelectionOpener([
        { storedModelId: "codex-cli:gpt-5.6-sol@high", providerLabel: "OpenAI Codex", runnerId: "codex-cli" },
        { storedModelId: "kimi-cli:kimi-code/k3", providerLabel: "Kimi Code CLI", runnerId: "kimi-cli" },
      ]),
      orchestrator: makeOrchestrator(),
      followUpScheduler: { schedule: (): void => undefined },
      presenter: { beginProgress: () => ({ end: (): void => undefined }) },
      auditLogger: { log: (): void => undefined },
      onCandidateSkipped: (skip): void => {
        skipped.push(skip);
      },
    });

    const outcome = await coordinator.executeAction(baseRequest());

    assert.deepEqual(outcome, { kind: "unavailable", code: "providerModeUnavailable" });
    assert.equal(skipped.length, 2, "every passed-over candidate must be reported, not just the first");
    assert.deepEqual(skipped.map((s) => s.storedModelId), [
      "codex-cli:gpt-5.6-sol@high",
      "kimi-cli:kimi-code/k3",
    ]);
    // The stored id is what the user actually configured, so it is the only
    // string that lets them find the setting that caused the skip.
    assert.equal(skipped[0]?.providerLabel, "OpenAI Codex");
    assert.equal(skipped[0]?.runnerId, "codex-cli");
    assert.equal(skipped[0]?.code, "providerModeUnavailable");
    assert.equal(skipped[0]?.taskStage, "plan");
  });

  void it("never lets a throwing onCandidateSkipped observer change the outcome", async () => {
    // Reporting is advisory. A notification surface that throws (or is torn
    // down mid-operation) must not turn a working cascade into a failure.
    const coordinator = createTaskActionCoordinatorV1({
      registry: createTaskActionRegistryV1([skipTestRow()]),
      leaseStore: createWorkflowLeaseStoreV1(),
      openRunnerSelection: skippingSelectionOpener([
        { storedModelId: "codex-cli:gpt-5", providerLabel: "OpenAI Codex", runnerId: "codex-cli" },
      ]),
      orchestrator: makeOrchestrator(),
      followUpScheduler: { schedule: (): void => undefined },
      presenter: { beginProgress: () => ({ end: (): void => undefined }) },
      auditLogger: { log: (): void => undefined },
      onCandidateSkipped: (): void => {
        throw new Error("notification surface exploded");
      },
    });

    const outcome = await coordinator.executeAction(baseRequest());
    assert.deepEqual(outcome, { kind: "unavailable", code: "providerModeUnavailable" });
  });

  void it("integrates with runnerRegistry's real openV1RunnerSelection: ranked fallback and exhaustion", async () => {
    // Ranking policy under test is the registry's own: the stored primary is
    // reserved, invoked through the broker, and on a pre-response failure the
    // strategy-gated backup is reserved on a FRESH attempt. Under the test
    // stub there is no usable vscode.lm host, so each Copilot transport
    // reports a deterministic pre-response transport failure, the ranking
    // exhausts, and the coordinator maps the whole operation onto
    // candidatesExhausted (workflow 3 continuation, third item) — BOTH
    // candidates were actually reserved and invoked before the chain ran
    // out, the opposite condition from providerModeUnavailable.
    //
    // BOTH candidates are Copilot on purpose. This test uses the REAL opener,
    // which builds REAL transports — a CLI candidate here does not stub
    // anything, it spawns the actual provider binary against the developer's
    // own account. This test previously ranked `codex-cli:gpt-5` first,
    // relying on codex being refused pre-spawn for writing its answer to a
    // last-message file; when codex moved to stdout capture (2026-08-11) that
    // refusal disappeared and every run of this file silently started two
    // real `codex exec` processes, burning live quota to reach the same
    // assertion. Keep CLI provider ids out of this test.
    //
    // The "unsupported primary is skipped rather than silently bypassed"
    // behaviour it used to cover lives in runnerRegistryV1Selection.test.ts,
    // which exercises the mode arm and a synthetic last-message-file
    // definition without constructing a transport at all; the coordinator's
    // own handling of a skip is covered by the onCandidateSkipped tests above.
    const settings = installModelSettings({
      "impl-high-review": {
        primary: "copilot:gpt-5-mini",
        backups: ["copilot:gpt-5"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const opener = createV1RunnerSelectionOpener({
        workspaceCwd: "/workspace",
        resolveStagePrimaryModel: (taskStage) => {
          assert.equal(taskStage, "plan");
          return { modelId: "copilot:gpt-5-mini", stage: "impl-high-review" };
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
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind === "unavailable") {
        assert.equal(
          outcome.code,
          "candidatesExhausted",
          "both candidates were reserved and invoked, so this is the opposite of providerModeUnavailable"
        );
        // The real registry now carries structured exhaustion evidence for
        // the stage owner (finding 4) — both ranked candidates named, both
        // recorded as reserved-and-failed.
        assert.equal(outcome.chainExhaustion?.stage, "impl-high-review");
        assert.deepEqual(
          outcome.chainExhaustion?.candidates.map((candidate) => candidate.storedModelId),
          ["copilot:gpt-5-mini", "copilot:gpt-5"]
        );
      }
      assert.equal(promoted.length, 0);
      assert.equal(leaseStore.heldLease(TASK_BINDING.taskBindingId), undefined);

      // A genuinely NO-mode-capable-candidate-at-all chain (anySupported
      // false) is deliberately NOT re-proven here: every CLI provider now
      // supports stdout capture for "text" mode (2026-08-11), so there is no
      // longer a non-CLI-spawning way to construct that condition through
      // this row's fixed "text" mode — attempting it by changing settings
      // alone is a no-op because `resolveStagePrimaryModel` above is a fixed
      // stub, not a live settings read, so it silently exercised the SAME
      // chain twice rather than the unsupported-mode path its comment
      // claimed (masked before this round because the coordinator collapsed
      // both `providerModeUnavailable` and `candidatesExhausted` onto one
      // code; workflow 3 continuation, third item, made the mismatch
      // observable). That condition is already covered at both layers this
      // test would otherwise duplicate: the real registry in
      // runnerRegistryV1Selection.test.ts ("returns providerModeUnavailable
      // for preflight/edit when only CLI providers are configured"), and the
      // coordinator's own pass-through in this file ("returns
      // providerModeUnavailable when the ranked selection has no
      // candidate").
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

  void it("forwards onPromptAssembled during a Resume drive (review blocker 2026-08-27: Resume omitted the attempt observer)", async () => {
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

    const resumeTransport: AgentTransportV1 = {
      runnerId: "scripted-transport",
      invoke: (request, output): Promise<{ kind: "completed" }> => {
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
    const observed: { attemptId: string; prompt: string; promptSha256: string }[] = [];
    const outcome = await resumeHarness.coordinator.resumeAction({
      interaction: ref,
      taskBinding: TASK_BINDING,
      taskStatus: "active",
      taskStage: "plan",
      resumeIdempotencyId: allocateHex128IdV1(),
      cancellationToken: fakeToken(),
      onPromptAssembled: (info) => {
        observed.push(info);
      },
    });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") {
      assert.fail("expected a completed outcome");
    }
    // The Resume drive's own attempt was captured — same identity as the
    // outcome's correlation, and a non-empty assembled prompt/hash, exactly
    // as a fresh `executeAction` drive's `onPromptAssembled` would report.
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.attemptId, outcome.correlation.attemptId);
    assert.ok(observed[0]!.prompt.length > 0);
    assert.ok(/^[0-9a-f]{64}$/.test(observed[0]!.promptSha256));
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

/**
 * A rejected chat transaction is deterministic and content-driven (plan §5.5:
 * oversized input snapshot, malformed correlation, undecodable record), yet
 * the outcome reports `retryable: true` — so if the reason is dropped, an
 * unchanged prompt fails identically forever with nothing to diagnose. That
 * is not hypothetical: a real review stalled for days with only
 * "chatTransaction.chatTransactionRejected" in its run log, while the store
 * had computed the exact cause (its canonical input snapshot sat ~1.5% over
 * MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1) and the coordinator discarded it.
 */
void describe("taskActionCoordinatorV1 — chat transaction failure codes", () => {
  void it("preserves the store's reason so a deterministic rejection is diagnosable", () => {
    assert.equal(
      chatTransactionFailureCodeV1(
        "chatTransactionRejected",
        "transaction record would not decode: inputSnapshot exceeds the 262144-byte canonical limit"
      ),
      "chatTransaction.chatTransactionRejected: transaction record would not decode: " +
        "inputSnapshot exceeds the 262144-byte canonical limit"
    );
  });

  void it("falls back to the bare namespaced code when the store gave no reason", () => {
    assert.equal(
      chatTransactionFailureCodeV1("chatTransactionRejected", "   "),
      "chatTransaction.chatTransactionRejected"
    );
  });

  void it("flattens newlines so the code stays a single readable run-log line", () => {
    assert.equal(
      chatTransactionFailureCodeV1("chatTransactionRejected", "line one\n\tline two   line three"),
      "chatTransaction.chatTransactionRejected: line one line two line three"
    );
  });

  void it("bounds an overlong reason instead of pasting unbounded text into the code", () => {
    const code = chatTransactionFailureCodeV1("chatTransactionRejected", "x".repeat(5000));
    const prefix = "chatTransaction.chatTransactionRejected: ";
    assert.ok(code.startsWith(prefix));
    // The reason is capped at 200 chars regardless of what the store produced.
    assert.equal(code.length - prefix.length, 200);
    assert.ok(code.endsWith("…"), "a truncated reason must be visibly elided");
  });
});

/**
 * A promotion failure's catch block used to discard the thrown error
 * entirely — not even into a variable — so every promotion failure surfaced
 * only the bare code "promotionFailed", indistinguishable whether the cause
 * was a compare-and-set conflict, a validation failure, or a storage error.
 * Live evidence 2026-08-06: a complete, correct review lost a CAS race
 * against a concurrent artifact write and the outcome said nothing about it.
 */
void describe("taskActionCoordinatorV1 — promotion failure codes", () => {
  void it("preserves the row's own write-failure message", () => {
    assert.equal(
      promotionFailureCodeV1("could not write plan.md: failed.revisionMismatch"),
      "promotionFailed: could not write plan.md: failed.revisionMismatch"
    );
  });

  void it("falls back to the bare code when the error has no message", () => {
    assert.equal(promotionFailureCodeV1("   "), "promotionFailed");
  });

  void it("flattens newlines so the code stays a single readable line", () => {
    assert.equal(
      promotionFailureCodeV1("line one\n\tline two   line three"),
      "promotionFailed: line one line two line three"
    );
  });

  void it("bounds an overlong message instead of pasting unbounded text into the code", () => {
    const code = promotionFailureCodeV1("x".repeat(5000));
    const prefix = "promotionFailed: ";
    assert.ok(code.startsWith(prefix));
    assert.equal(code.length - prefix.length, 200);
    assert.ok(code.endsWith("…"), "a truncated message must be visibly elided");
  });
});
