/**
 * RC12 item 3: Resume hands the AI the recorded questions and answers, and a
 * resumed run that asks again fails in plain words. First dispatches are pinned
 * to today's `buildPrompt` + result-contract formula.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import { MAX_NORMAL_RESPONSE_BYTES_V1 } from "../types/agentExecutionV1";

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
} from "../actions/rows/generatePlanRowV1";
import { CHAT_SEND_ACTION_KEY_V1, createChatSendRowV1 } from "../actions/rows/chatSendRowV1";
import { createReviewRowV1, REVIEW_ACTION_KEY_V1 } from "../actions/rows/reviewRowV1";
import { buildAiResultContractPromptV1 } from "../prompts/aiResultContractV1";
import { describeTaskActionFailureV1 } from "../utils/taskActionOutcomeTextV1";
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
import { safeRemoveDir } from "./testFsUtils";

type ExecuteRequest = Parameters<TaskActionCoordinatorV1["executeAction"]>[0];

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function fakeToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

function stubSelectionOpener(transports: readonly AgentTransportV1[]): RunnerSelectionOpenerV1 {
  let cursor = 0;
  return ({ session, mode }) => ({
    reserveNext(attemptId): V1ReserveNextResultV1 {
      const transport = transports[cursor];
      if (!transport) {
        return { kind: "noneRemaining", code: cursor === 0 ? "providerModeUnavailable" : "candidatesExhausted" };
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
          providerReadsWorkspaceNatively: true,
          createTransport: () => transport,
        },
      };
    },
  });
}

function transportReplying(reply: (request: { prompt: string; correlation: unknown }) => unknown): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(frame(reply(request as unknown as { prompt: string; correlation: unknown })));
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

function questionsTransport(kind: "singleChoice" | "text", seen?: unknown[]): AgentTransportV1 {
  return transportReplying((request) => {
    seen?.push(request.correlation);
    return {
      version: 1,
      correlation: request.correlation,
      kind: "questions",
      questions: [
        kind === "singleChoice"
          ? {
              questionId: "q1",
              kind: "singleChoice",
              prompt: "Which item should be dropped?",
              required: true,
              options: [
                { optionId: "keep-all", label: "Keep every item" },
                { optionId: "drop-item-2", label: "Drop item 2" },
              ],
            }
          : { questionId: "q1", kind: "text", prompt: "Which stage?", required: true },
      ],
    };
  });
}

function completedTransport(
  prompts: string[],
  contentType: string,
  content: Record<string, unknown>,
  seen?: unknown[]
): AgentTransportV1 {
  return transportReplying((request) => {
    prompts.push(request.prompt);
    seen?.push(request.correlation);
    return {
      version: 1,
      correlation: request.correlation,
      kind: "completed",
      content: { contentType, schemaVersion: 1, ...content },
    };
  });
}

function expectedFirstPrompt(rowPrompt: string, correlation: unknown, contentType: string): string {
  return (
    rowPrompt +
    "\n\n" +
    buildAiResultContractPromptV1({
      correlation: correlation as Parameters<typeof buildAiResultContractPromptV1>[0]["correlation"],
      permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
      completedContentType: contentType as "markdown-artifact.v1",
      maxResponseBytes: MAX_NORMAL_RESPONSE_BYTES_V1,
    })
  );
}

interface TestEnvV1 {
  readonly taskFolder: string;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly orchestrator: ActionConversationOrchestratorV1;
  makeCoordinator(
    transports: readonly AgentTransportV1[],
    options?: { readonly chatSendResumeSemantics?: "replacementOperation"; readonly postCounter?: { count: number } }
  ): TaskActionCoordinatorV1;
  tearDown(): void;
}

function setUpTestEnvV1(): TestEnvV1 {
  resetWorkflowRuntimeServicesForTestV1();
  const privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-resumed-answers-private-"));
  const privateRootId = configureWorkflowPrivateStorageRootV1(privateStorageDir);
  setChatInteractionTransactionStoreV1(
    createChatInteractionTransactionStoreV1({
      registry: getWorkflowPathRegistryV1(),
      fileStore: getWorkflowFileStoreV1(),
      privateRootId,
    })
  );
  const fixture = makeOwnedTaskFolder("ensemble-resumed-answers-task-");
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
    orchestrator,
    makeCoordinator(transports, options): TaskActionCoordinatorV1 {
      const chatRow = createChatSendRowV1();
      const counter = options?.postCounter;
      const coordinatorOrchestrator: ActionConversationOrchestratorV1 = counter
        ? {
            ...orchestrator,
            postQuestions: (input) => {
              counter.count += 1;
              return orchestrator.postQuestions(input);
            },
          }
        : orchestrator;
      return createTaskActionCoordinatorV1({
        registry: createTaskActionRegistryV1([
          createGeneratePlanRowV1(),
          options?.chatSendResumeSemantics ? { ...chatRow, resumeSemantics: options.chatSendResumeSemantics } : chatRow,
          createReviewRowV1(),
        ]),
        leaseStore: createWorkflowLeaseStoreV1(),
        openRunnerSelection: stubSelectionOpener(transports),
        orchestrator: coordinatorOrchestrator,
        followUpScheduler: { schedule: (): void => undefined },
        presenter: { beginProgress: () => ({ end: (): void => undefined }) },
        auditLogger: { log: (): void => undefined },
      });
    },
    tearDown(): void {
      resetWorkflowRuntimeServicesForTestV1();
      safeRemoveDir(fixture.folder);
      safeRemoveDir(privateStorageDir);
    },
  };
}

void describe("resumedAnswersPromptV1 (coordinator integration)", () => {
  let env: TestEnvV1;
  before(() => {
    env = setUpTestEnvV1();
  });
  after(() => {
    env.tearDown();
  });

  const binding = (): { taskBindingId: string; chatDocumentId: string } => ({
    taskBindingId: env.taskBindingId,
    chatDocumentId: env.chatDocumentId,
  });

  const planRequest = (prompt: string): ExecuteRequest => {
    const rootId = ensureWorkflowTaskFolderRootV1(env.taskFolder);
    return {
      actionKey: GENERATE_PLAN_ACTION_KEY_V1,
      taskBinding: binding(),
      taskStatus: "active",
      taskStage: "plan",
      rawInput: { prompt, targetLocator: { rootId, relativePath: GENERATE_PLAN_TARGET_RELATIVE_PATH_V1 } },
      cancellationToken: fakeToken(),
    } as ExecuteRequest;
  };

  const chatRequest = (prompt: string): ExecuteRequest =>
    ({
      actionKey: CHAT_SEND_ACTION_KEY_V1,
      taskBinding: binding(),
      taskStatus: "active",
      taskStage: "plan",
      rawInput: { prompt },
      cancellationToken: fakeToken(),
    }) as ExecuteRequest;

  const askAndAnswer = async (
    request: ExecuteRequest,
    kind: "singleChoice" | "text",
    answer: Record<string, unknown>
  ): Promise<{ ref: InteractionRefV1; firstPrompts: string[] }> => {
    const firstPrompts: string[] = [];
    const outcome = await env.makeCoordinator([questionsTransport(kind)]).executeAction({
      ...request,
      onPromptAssembled: (info) => {
        firstPrompts.push(info.prompt);
      },
    });
    assert.equal(outcome.kind, "questions");
    if (outcome.kind !== "questions") {
      assert.fail("expected questions");
    }
    const ref: InteractionRefV1 = {
      operationId: outcome.correlation.operationId,
      interactionId: outcome.interactionId,
      taskBindingId: outcome.correlation.taskBindingId,
      chatDocumentId: outcome.correlation.chatDocumentId,
      sourceAttemptId: outcome.correlation.attemptId,
    };
    const submitted = await env.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind, state: "answered", ...answer } as never],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);
    return { ref, firstPrompts };
  };

  const resumeArgs = (ref: InteractionRefV1): Parameters<TaskActionCoordinatorV1["resumeAction"]>[0] => ({
    interaction: ref,
    taskBinding: binding(),
    taskStatus: "active",
    taskStage: "plan",
    resumeIdempotencyId: allocateHex128IdV1(),
    cancellationToken: fakeToken(),
  });

  void it("a first Generate Plan dispatch is exactly the row prompt plus the result contract", async () => {
    const seen: unknown[] = [];
    const prompts: string[] = [];
    const coordinator = env.makeCoordinator([
      completedTransport([], "markdown-artifact.v1", { markdown: "# P\n" }, seen),
    ]);
    await coordinator.executeAction({
      ...planRequest("PLAN ROW PROMPT"),
      onPromptAssembled: (info) => {
        prompts.push(info.prompt);
      },
    });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0], expectedFirstPrompt("PLAN ROW PROMPT", seen[0], "markdown-artifact.v1"));
  });

  void it("a first chat-send dispatch is exactly the row prompt plus the result contract", async () => {
    const seen: unknown[] = [];
    const prompts: string[] = [];
    await env.makeCoordinator([questionsTransport("text", seen)]).executeAction({
      ...chatRequest("CHAT ROW PROMPT"),
      onPromptAssembled: (info) => {
        prompts.push(info.prompt);
      },
    });
    assert.equal(prompts[0], expectedFirstPrompt("CHAT ROW PROMPT", seen[0], "chat-message.v1"));
  });

  void it("a first review dispatch is exactly the row prompt plus the result contract", async () => {
    const seen: unknown[] = [];
    const prompts: string[] = [];
    const rootId = ensureWorkflowTaskFolderRootV1(env.taskFolder);
    await env.makeCoordinator([questionsTransport("text", seen)]).executeAction({
      actionKey: REVIEW_ACTION_KEY_V1,
      taskBinding: binding(),
      taskStatus: "active",
      taskStage: "plan",
      rawInput: { prompt: "REVIEW ROW PROMPT", targetLocator: { rootId, relativePath: "plan.md" } },
      cancellationToken: fakeToken(),
      onPromptAssembled: (info) => {
        prompts.push(info.prompt);
      },
    } as ExecuteRequest);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0], expectedFirstPrompt("REVIEW ROW PROMPT", seen[0], "markdown-artifact.v1"));
  });

  void it("a resumed replacementOperation run that asks again fails without posting a new interaction", async () => {
    const postCounter = { count: 0 };
    const options = { chatSendResumeSemantics: "replacementOperation" as const, postCounter };
    const askOutcome = await env
      .makeCoordinator([questionsTransport("text")], options)
      .executeAction(chatRequest("REPLACEMENT ASK AGAIN"));
    assert.equal(askOutcome.kind, "questions");
    if (askOutcome.kind !== "questions") {
      assert.fail("expected questions");
    }
    assert.equal(postCounter.count, 1);
    const ref: InteractionRefV1 = {
      operationId: askOutcome.correlation.operationId,
      interactionId: askOutcome.interactionId,
      taskBindingId: askOutcome.correlation.taskBindingId,
      chatDocumentId: askOutcome.correlation.chatDocumentId,
      sourceAttemptId: askOutcome.correlation.attemptId,
    };
    const submitted = await env.orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "x" } as never],
      allocateHex128IdV1()
    );
    assert.equal(submitted.ok, true);
    const outcome = await env.makeCoordinator([questionsTransport("text")], options).resumeAction(resumeArgs(ref));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") {
      assert.fail("expected failed");
    }
    assert.equal(outcome.code, "resumedRunAskedAgain");
    assert.equal(postCounter.count, 1, "no second interaction was posted by the resumed run");
  });

  void it("a first dispatch that returns questions still posts an interaction", async () => {
    const outcome = await env.makeCoordinator([questionsTransport("text")]).executeAction(chatRequest("posts"));
    assert.equal(outcome.kind, "questions");
  });

  void it("resuming an answered Generate Plan choice question sends the question and the chosen label", async () => {
    const { ref, firstPrompts } = await askAndAnswer(planRequest("PLAN RESUME PROMPT"), "singleChoice", {
      selectedOptionId: "drop-item-2",
    });
    assert.ok(!firstPrompts[0]!.includes("Which item should be dropped?"));
    const snapshotBefore = (await env.orchestrator.getRecord(ref))?.inputSnapshot;
    assert.ok(snapshotBefore);
    fs.rmSync(path.join(env.taskFolder, GENERATE_PLAN_TARGET_RELATIVE_PATH_V1), { force: true });
    const resumedPrompts: string[] = [];
    const outcome = await env
      .makeCoordinator([completedTransport(resumedPrompts, "markdown-artifact.v1", { markdown: "# Resumed\n" })])
      .resumeAction(resumeArgs(ref));
    assert.equal(outcome.kind, "completed");
    const snapshotAfter = (await env.orchestrator.getRecord(ref))?.inputSnapshot;
    assert.deepEqual(snapshotAfter, snapshotBefore, "the saved input snapshot is unchanged by Resume");
    assert.ok(!snapshotAfter.canonicalJson.includes("Drop item 2"));
    const sent = resumedPrompts[0]!;
    assert.ok(sent.startsWith("PLAN RESUME PROMPT"), "the saved snapshot prompt is still the base");
    assert.ok(sent.includes("Which item should be dropped?"));
    assert.ok(sent.includes("Drop item 2"));
    assert.ok(!sent.includes("drop-item-2"));
    assert.ok(sent.includes("do not ask any of these questions"));
  });

  void it("resuming an answered chat-send text question sends the answer text", async () => {
    const { ref } = await askAndAnswer(chatRequest("CHAT RESUME PROMPT"), "text", { value: "the publish stage" });
    const resumedPrompts: string[] = [];
    await env
      .makeCoordinator([completedTransport(resumedPrompts, "chat-message.v1", { markdown: "ok" })])
      .resumeAction(resumeArgs(ref));
    const sent = resumedPrompts[0]!;
    assert.ok(sent.startsWith("CHAT RESUME PROMPT"));
    assert.ok(sent.includes("Which stage?"));
    assert.ok(sent.includes("the publish stage"));
  });

  void it("a resumed run that asks again fails in plain words", async () => {
    const { ref } = await askAndAnswer(chatRequest("ASK AGAIN PROMPT"), "text", { value: "x" });
    const outcome = await env.makeCoordinator([questionsTransport("text")]).resumeAction(resumeArgs(ref));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") {
      assert.fail("expected failed");
    }
    assert.equal(outcome.code, "resumedRunAskedAgain");
    const text = describeTaskActionFailureV1(outcome);
    assert.ok(text.includes("the AI asked again after your answer"));
    assert.ok(!text.includes("chatTransactionNotRecorded"));
  });
});
