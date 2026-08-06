/**
 * Coverage for the `generatePlan.v1` registry row (plan §6.2, "Implement
 * Generate Plan first" — the vertical-slice proof that the coordinator/
 * registry built in earlier steps actually works end to end for a real
 * action):
 *
 *  - `validateGeneratePlanInputV1` accepts only the exact declared shape.
 *  - A `completed` markdown-artifact.v1 result writes plan.md through the
 *    shared workflow file store, exclusively when it does not exist yet and
 *    via a revision-checked replace when it does; a STALE captured revision
 *    (a concurrent edit landed after the baseline was read) is refused
 *    rather than clobbered.
 *  - A `questions` result never touches plan.md — only the durable Chat
 *    interaction transaction is written.
 *  - Malformed, cross-operation (mismatched correlation), cancelled, and
 *    failed results never touch plan.md either.
 *  - Resume after answering reconstructs the action from the persisted
 *    validated-input snapshot (the exact same prompt) and completes it.
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
  InteractionRefV1,
} from "../actions/actionConversationOrchestratorV1";
import {
  createTaskActionCoordinatorV1,
  RunnerSelectionOpenerV1,
  TaskActionCoordinatorV1,
} from "../actions/taskActionCoordinatorV1";
import { createTaskActionRegistryV1 } from "../actions/taskActionRegistryV1";
import {
  createGeneratePlanRowV1,
  GENERATE_PLAN_ACTION_KEY_V1,
  GENERATE_PLAN_TARGET_RELATIVE_PATH_V1,
  validateGeneratePlanInputV1,
} from "../actions/rows/generatePlanRowV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import { createWorkflowLeaseStoreV1 } from "../services/workflowLeaseStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  ensureWorkflowTaskFolderRootV1,
  getChatInteractionTransactionStoreV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  resetWorkflowRuntimeServicesForTestV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { AgentTransportV1 } from "../types/agentExecutionV1";
import { V1ReserveNextResultV1 } from "../runners/runnerRegistry";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function fakeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

/** A `RunnerSelectionOpenerV1` test double: one reservation per listed transport, then exhausted. */
function stubSelectionOpener(transports: readonly AgentTransportV1[]): RunnerSelectionOpenerV1 {
  let cursor = 0;
  return ({ session, mode }) => ({
    reserveNext(attemptId): V1ReserveNextResultV1 {
      const transport = transports[cursor];
      if (!transport) {
        return cursor === 0
          ? { kind: "noneRemaining", code: "providerModeUnavailable" }
          : { kind: "noneRemaining", code: "candidatesExhausted" };
      }
      cursor += 1;
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
  });
}

/** A transport that frames whatever `script` returns for the request's own correlation. */
function scriptedTransport(script: (correlation: unknown) => string): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(script(request.correlation));
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

function completedTransport(markdown: string): AgentTransportV1 {
  return scriptedTransport((correlation) =>
    frame({
      version: 1,
      correlation,
      kind: "completed",
      content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
    })
  );
}

function questionsTransport(): AgentTransportV1 {
  return scriptedTransport((correlation) =>
    frame({
      version: 1,
      correlation,
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "text",
          prompt: "What should the plan focus on?",
          required: true,
          allowBlank: false,
          maxLength: 500,
        },
      ],
    })
  );
}

function cancelledTransport(): AgentTransportV1 {
  return scriptedTransport((correlation) => frame({ version: 1, correlation, kind: "cancelled", reason: "user" }));
}

function failedTransport(): AgentTransportV1 {
  return scriptedTransport((correlation) =>
    frame({ version: 1, correlation, kind: "failed", code: "providerError", message: "boom", retryable: false })
  );
}

function malformedTransport(): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (_request, output): Promise<{ kind: "completed" }> => {
      // Short enough (under taskActionCoordinatorV1.ts's
      // FRAMELESS_FALLBACK_MIN_CHARS_V1) to stay genuinely malformed rather
      // than being rescued by tryFramelessContentFallbackV1, which this
      // suite's own tests are not about.
      output.write("no frame");
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/** Echoes a foreign correlation (cross-operation/stale-attempt) instead of the request's own. */
function crossOperationTransport(markdown: string): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (_request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frame({
          version: 1,
          correlation: {
            actionKey: GENERATE_PLAN_ACTION_KEY_V1,
            operationId: allocateHex128IdV1(),
            attemptId: allocateHex128IdV1(),
            taskBindingId: "some-other-task",
            chatDocumentId: "some-other-doc",
          },
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

interface TestEnvV1 {
  readonly taskFolder: string;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly planFileUri: vscode.Uri;
  readonly orchestrator: ActionConversationOrchestratorV1;
  makeCoordinator(transports: readonly AgentTransportV1[]): TaskActionCoordinatorV1;
  readPlanFile(): string | undefined;
  tearDown(): void;
}

function setUpTestEnvV1(): TestEnvV1 {
  resetWorkflowRuntimeServicesForTestV1();
  const privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-generate-plan-private-"));
  const privateRootId = configureWorkflowPrivateStorageRootV1(privateStorageDir);
  setChatInteractionTransactionStoreV1(
    createChatInteractionTransactionStoreV1({
      registry: getWorkflowPathRegistryV1(),
      fileStore: getWorkflowFileStoreV1(),
      privateRootId,
    })
  );
  const fixture = makeOwnedTaskFolder("ensemble-generate-plan-task-");
  const rootId = ensureWorkflowTaskFolderRootV1(fixture.folder);
  const taskBindingId = getVerifiedTaskBindingIdV1(rootId);
  assert.ok(taskBindingId, "task folder root must verify for this fixture");
  const orchestrator = createActionConversationOrchestratorV1({
    transactionStore: getChatInteractionTransactionStoreV1()!,
  });

  return {
    taskFolder: fixture.folder,
    taskBindingId,
    chatDocumentId: allocateHex128IdV1(),
    planFileUri: vscode.Uri.file(path.join(fixture.folder, GENERATE_PLAN_TARGET_RELATIVE_PATH_V1)),
    orchestrator,
    makeCoordinator(transports: readonly AgentTransportV1[]): TaskActionCoordinatorV1 {
      return createTaskActionCoordinatorV1({
        registry: createTaskActionRegistryV1([createGeneratePlanRowV1()]),
        leaseStore: createWorkflowLeaseStoreV1(),
        openRunnerSelection: stubSelectionOpener(transports),
        orchestrator,
        followUpScheduler: { schedule: (): void => undefined },
        presenter: { beginProgress: () => ({ end: (): void => undefined }) },
        auditLogger: { log: (): void => undefined },
      });
    },
    readPlanFile(): string | undefined {
      try {
        return fs.readFileSync(path.join(fixture.folder, GENERATE_PLAN_TARGET_RELATIVE_PATH_V1), "utf8");
      } catch {
        return undefined;
      }
    },
    tearDown(): void {
      resetWorkflowRuntimeServicesForTestV1();
      fs.rmSync(fixture.folder, { recursive: true, force: true });
      fs.rmSync(privateStorageDir, { recursive: true, force: true });
    },
  };
}

async function buildValidatedInput(
  env: TestEnvV1,
  prompt: string
): Promise<{ prompt: string; targetLocator: { rootId: string; relativePath: string }; baselineRevision?: string }> {
  const rootId = ensureWorkflowTaskFolderRootV1(env.taskFolder);
  const locator = { rootId, relativePath: GENERATE_PLAN_TARGET_RELATIVE_PATH_V1 };
  const stat = await getWorkflowFileStoreV1().stat(locator);
  const baselineRevision =
    stat.kind === "ok" && stat.value.kind === "file" ? stat.value.revision : undefined;
  return { prompt, targetLocator: locator, ...(baselineRevision !== undefined ? { baselineRevision } : {}) };
}

function baseRequest(env: TestEnvV1, rawInput: unknown): {
  actionKey: string;
  taskBinding: { taskBindingId: string; chatDocumentId: string };
  taskStatus: string;
  taskStage: string;
  rawInput: unknown;
  cancellationToken: vscode.CancellationToken;
} {
  return {
    actionKey: GENERATE_PLAN_ACTION_KEY_V1,
    taskBinding: { taskBindingId: env.taskBindingId, chatDocumentId: env.chatDocumentId },
    taskStatus: "active",
    taskStage: "plan",
    rawInput,
    cancellationToken: fakeToken(),
  };
}

void describe("generatePlanRowV1", () => {
  void describe("validateGeneratePlanInputV1", () => {
    void it("accepts a well-formed input", () => {
      const result = validateGeneratePlanInputV1({
        prompt: "hello",
        targetLocator: { rootId: "root-1", relativePath: "plan.md" },
      });
      assert.equal(result.ok, true);
    });

    void it("accepts a well-formed input carrying a baselineRevision", () => {
      const result = validateGeneratePlanInputV1({
        prompt: "hello",
        targetLocator: { rootId: "root-1", relativePath: "plan.md" },
        baselineRevision: "v1:10:100:5",
      });
      assert.equal(result.ok, true);
    });

    void it("rejects a missing prompt", () => {
      const result = validateGeneratePlanInputV1({ targetLocator: { rootId: "r", relativePath: "plan.md" } });
      assert.equal(result.ok, false);
    });

    void it("rejects an empty prompt", () => {
      const result = validateGeneratePlanInputV1({
        prompt: "",
        targetLocator: { rootId: "r", relativePath: "plan.md" },
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a relativePath other than plan.md", () => {
      const result = validateGeneratePlanInputV1({
        prompt: "hello",
        targetLocator: { rootId: "r", relativePath: "task.md" },
      });
      assert.equal(result.ok, false);
    });

    void it("rejects an unknown field", () => {
      const result = validateGeneratePlanInputV1({
        prompt: "hello",
        targetLocator: { rootId: "r", relativePath: "plan.md" },
        extra: "nope",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a non-object input", () => {
      assert.equal(validateGeneratePlanInputV1("nope").ok, false);
      assert.equal(validateGeneratePlanInputV1(null).ok, false);
      assert.equal(validateGeneratePlanInputV1(undefined).ok, false);
    });
  });

  void describe("end to end through the coordinator", () => {
    let env: TestEnvV1;

    before(() => {
      env = setUpTestEnvV1();
    });
    after(() => {
      env.tearDown();
    });

    void it("a completed result creates plan.md when it does not exist yet", async () => {
      const input = await buildValidatedInput(env, "ACTION PROMPT 1");
      assert.equal(input.baselineRevision, undefined, "plan.md must not exist yet for this case");
      const coordinator = env.makeCoordinator([completedTransport("# Plan\n\n1. Do the thing.\n")]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "completed");
      assert.equal(env.readPlanFile(), "# Plan\n\n1. Do the thing.\n");
    });

    void it("a completed result replaces plan.md via a revision-checked write", async () => {
      const input = await buildValidatedInput(env, "ACTION PROMPT 2");
      assert.notEqual(input.baselineRevision, undefined, "plan.md exists from the previous test");
      const coordinator = env.makeCoordinator([completedTransport("# Plan\n\n1. Regenerated.\n")]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "completed");
      assert.equal(env.readPlanFile(), "# Plan\n\n1. Regenerated.\n");
    });

    void it("refuses to promote over a STALE baseline revision (concurrent edit) and leaves plan.md untouched", async () => {
      const input = await buildValidatedInput(env, "ACTION PROMPT 3");
      // Simulate a concurrent edit landing after the baseline revision was
      // captured but before this drive's promotion runs.
      fs.writeFileSync(path.join(env.taskFolder, GENERATE_PLAN_TARGET_RELATIVE_PATH_V1), "# Plan\n\nEdited concurrently.\n");
      const coordinator = env.makeCoordinator([completedTransport("# Plan\n\n1. Should not land.\n")]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        // promotionFailureCodeV1 now appends the row's own write-failure
        // detail (bounded/flattened) instead of the bare code — see that
        // function's own doc comment for the live diagnosability gap this
        // closes.
        assert.match(outcome.code, /^promotionFailed: could not write plan\.md: .*revisionMismatch/);
      }
      assert.equal(env.readPlanFile(), "# Plan\n\nEdited concurrently.\n");
    });

    void it("a questions result never touches plan.md — only Chat's durable transaction is written", async () => {
      const before = env.readPlanFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 4");
      const coordinator = env.makeCoordinator([questionsTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "questions");
      assert.equal(env.readPlanFile(), before, "plan.md must be byte-identical — questions never touch it");
      if (outcome.kind === "questions") {
        const record = await env.orchestrator.getRecord({
          operationId: outcome.correlation.operationId,
          interactionId: outcome.interactionId,
          taskBindingId: outcome.correlation.taskBindingId,
          chatDocumentId: outcome.correlation.chatDocumentId,
          sourceAttemptId: outcome.correlation.attemptId,
        });
        assert.ok(record, "the durable Chat interaction transaction must exist");
        assert.equal(record?.questions?.length, 1);
        assert.equal(record?.resumeSemantics, "sameOperation");
      }
    });

    void it("a malformed provider response never touches plan.md", async () => {
      const before = env.readPlanFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 5");
      const coordinator = env.makeCoordinator([malformedTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "malformedResult");
      assert.equal(env.readPlanFile(), before);
    });

    void it("a cross-operation/stale-attempt result (foreign correlation) never touches plan.md", async () => {
      const before = env.readPlanFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 6");
      const coordinator = env.makeCoordinator([crossOperationTransport("# Plan\n\nForeign.\n")]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "malformedResult");
      if (outcome.kind === "malformedResult") {
        assert.equal(outcome.code, "resultCorrelationMismatch");
      }
      assert.equal(env.readPlanFile(), before);
    });

    void it("a cancelled result never touches plan.md", async () => {
      const before = env.readPlanFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 7");
      const coordinator = env.makeCoordinator([cancelledTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "cancelled");
      assert.equal(env.readPlanFile(), before);
    });

    void it("a failed result never touches plan.md", async () => {
      const before = env.readPlanFile();
      const input = await buildValidatedInput(env, "ACTION PROMPT 8");
      const coordinator = env.makeCoordinator([failedTransport()]);
      const outcome = await coordinator.executeAction(baseRequest(env, input));
      assert.equal(outcome.kind, "failed");
      assert.equal(env.readPlanFile(), before);
    });

    void it("Resume after answering reconstructs the action from its saved transaction and completes it", async () => {
      const originalPrompt = "ACTION PROMPT — RESUME CASE";
      const input = await buildValidatedInput(env, originalPrompt);
      const firstCoordinator = env.makeCoordinator([questionsTransport()]);
      const questionsOutcome = await firstCoordinator.executeAction(baseRequest(env, input));
      assert.equal(questionsOutcome.kind, "questions");
      if (questionsOutcome.kind !== "questions") {
        return;
      }

      const ref: InteractionRefV1 = {
        operationId: questionsOutcome.correlation.operationId,
        interactionId: questionsOutcome.interactionId,
        taskBindingId: questionsOutcome.correlation.taskBindingId,
        chatDocumentId: questionsOutcome.correlation.chatDocumentId,
        sourceAttemptId: questionsOutcome.correlation.attemptId,
      };
      const submitted = await env.orchestrator.submitAnswers(
        ref,
        [{ questionId: "q1", kind: "text", state: "answered", value: "Focus on the migration." }],
        allocateHex128IdV1()
      );
      assert.equal(submitted.ok, true);

      let sawReconstructedPrompt = false;
      const resumeTransport: AgentTransportV1 = {
        runnerId: "scripted-transport",
        invoke: (request, output) => {
          sawReconstructedPrompt = request.prompt.startsWith(originalPrompt);
          output.write(
            frame({
              version: 1,
              correlation: request.correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# Plan\n\nResumed.\n" },
            })
          );
          return Promise.resolve({ kind: "completed" as const });
        },
      };
      const resumeCoordinator = env.makeCoordinator([resumeTransport]);
      const resumeOutcome = await resumeCoordinator.resumeAction({
        interaction: ref,
        taskBinding: { taskBindingId: env.taskBindingId, chatDocumentId: env.chatDocumentId },
        taskStatus: "active",
        taskStage: "plan",
        resumeIdempotencyId: allocateHex128IdV1(),
        cancellationToken: fakeToken(),
      });
      assert.equal(resumeOutcome.kind, "completed");
      assert.equal(sawReconstructedPrompt, true, "Resume must rebuild the exact original prompt from the snapshot");
      assert.equal(env.readPlanFile(), "# Plan\n\nResumed.\n");
    });
  });
});
