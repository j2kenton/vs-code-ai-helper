/**
 * Engine trace suite (plan Part 4a / acceptance criterion 7b).
 *
 * Scripted engine runs capture every emitted structured-question,
 * chat-transaction, and task-progress frame; each captured frame is decoded
 * with the applicable EXTENSION decoder/validator imported directly from
 * `src/` — `taskProgressDecoderV1`, the structured-question validator, and
 * the chat-transaction codec. A frame the `src` decoders reject fails the
 * suite: this checks engine output against the extension's own vocabulary,
 * not only @ensemble/core's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// --- the engine under test --------------------------------------------------
import {
  createEngineTaskV1,
  EngineProviderInvocationV1,
  EngineRoundResultV1,
} from "../src/taskLoopV1";
import { createRecordingEventSinkV1, EngineEventV1 } from "../src/engineEventsV1";
import { createInMemoryEngineTransactionStoreV1 } from "../src/transactionStoreV1";
import { createEngineConversationOrchestratorV1 } from "../src/conversationOrchestratorV1";
import { encodeTaskProgressTextV1 } from "../src/progressV1";
import { createEngineProviderRunnerV1 } from "../src/providerDispatchV1";
import { createEngineGateMachineryV1, EngineExternalEffectV1 } from "../src/gateMachineryV1";
import {
  EngineModelProviderAdapterV1,
  EngineTextInvocationV1,
} from "../src/providerAdaptersV1";
import { EngineProviderIdV1 } from "../src/providerCatalogV1";
import type { ModelSettings } from "../../ensemble-core/src/settingsV1";
import { encodeChatInteractionTransactionV1 } from "../../ensemble-core/src/chatInteractionTransactionV1";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { sha256HexUtf8V1 } from "../../ensemble-core/src/sha256V1";
import type { StructuredQuestionV1 } from "../../ensemble-core/src/structuredQuestionV1";

// --- the extension's own decoders (parity oracles) --------------------------
import * as srcQuestions from "../../../src/types/structuredQuestionV1";
import * as srcChat from "../../../src/types/chatInteractionTransactionV1";
import * as srcProgress from "../../../src/services/taskProgressDecoderV1";

/** Deterministic, strictly increasing clock. */
function testClock(startMs = Date.UTC(2026, 7, 12, 4, 0, 0)): () => Date {
  let tick = 0;
  return () => new Date(startMs + 1000 * tick++);
}

const PLAN_OF_RECORD = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist: Demo",
  "",
  "- [ ] build the alpha module",
  "- [ ] build the beta module",
  "- [ ] build the gamma module",
  "- [ ] build the delta module",
  "",
].join("\n");

function summaryTicking(items: string[], marker?: string): string {
  const boxes = [
    "build the alpha module",
    "build the beta module",
    "build the gamma module",
    "build the delta module",
  ].map((text) => `- [${items.includes(text) ? "x" : " "}] ${text}`);
  return [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist: Demo",
    "",
    ...boxes,
    "",
    "## Files Changed",
    "- src/alpha.ts — added",
    "",
    ...(marker !== undefined ? [marker, ""] : []),
  ].join("\n");
}

const QUESTIONS: readonly StructuredQuestionV1[] = [
  {
    questionId: "q-scope",
    kind: "text",
    prompt: "Which module should the next round prioritize?",
    required: true,
    allowBlank: false,
    maxLength: 200,
  },
  {
    questionId: "q-approach",
    kind: "singleChoice",
    prompt: "Pick the integration approach.",
    required: true,
    options: [
      { optionId: "opt-a", label: "Adapter" },
      { optionId: "opt-b", label: "Rewrite" },
    ],
  },
];

/** Decode every emitted frame with the EXTENSION's own decoders. */
function assertFramesDecodeUnderSrc(
  events: readonly EngineEventV1[],
  expectations: { readonly questionFrames: boolean } = { questionFrames: true }
): void {
  let progressFrames = 0;
  let questionFrames = 0;
  for (const event of events) {
    if (event.type === "taskProgress") {
      progressFrames++;
      const text = encodeTaskProgressTextV1(event.progress);
      const decoded = srcProgress.decodeTaskProgressTextV1(text, {
        expectedTaskFolder: event.progress.taskFolder,
      });
      assert.ok(
        decoded.ok,
        `emitted task-progress frame rejected by src decoder: ${decoded.ok ? "" : decoded.reason}`
      );
      assert.equal(decoded.decoded.family, "ensemble-v1");
      assert.deepEqual(
        decoded.decoded.progress,
        JSON.parse(JSON.stringify(event.progress)),
        "src-decoded progress differs from the emitted frame"
      );
    }
    if (event.type === "structuredQuestions") {
      questionFrames++;
      const roundTripped: unknown = JSON.parse(JSON.stringify(event.questions));
      const decoded = srcQuestions.decodeStructuredQuestionsV1(roundTripped);
      assert.ok(
        decoded.ok,
        `emitted structured-question frame rejected by src validator: ${decoded.reason ?? ""}`
      );
      assert.deepEqual(decoded.questions, roundTripped);
    }
  }
  assert.ok(progressFrames > 0, "scenario emitted no task-progress frames");
  if (expectations.questionFrames) {
    assert.ok(questionFrames > 0, "scenario emitted no structured-question frames");
  }
}

test("full round/question/resume scenario: every emitted frame decodes under the src decoders", async () => {
  const now = testClock();
  const store = createInMemoryEngineTransactionStoreV1({ now });
  const sink = createRecordingEventSinkV1();
  const script: EngineRoundResultV1[] = [
    { kind: "completed", summaryMarkdown: summaryTicking(["build the alpha module", "build the beta module"], "<!-- progress: 2/4 -->") },
    { kind: "questions", questions: QUESTIONS },
    {
      kind: "completed",
      summaryMarkdown: summaryTicking(
        [
          "build the alpha module",
          "build the beta module",
          "build the gamma module",
          "build the delta module",
        ],
        "<!-- progress: 4/4 -->"
      ),
    },
  ];
  const invocations: EngineProviderInvocationV1[] = [];
  const task = createEngineTaskV1({
    taskId: "task-demo-1",
    taskFolder: "2026-08-12_task_1",
    displayName: "Trace demo task",
    planOfRecord: PLAN_OF_RECORD,
    initialStage: "impl",
    now,
    store,
    sink,
    provider: {
      async invoke(input) {
        invocations.push(input);
        const next = script.shift();
        assert.ok(next, "provider invoked more times than the script provides");
        return next;
      },
    },
  });

  task.start();
  assert.equal(task.progress.status, "active");

  // Round 1: completed, N/M advances 2/4 (checklist authority).
  const round1 = await task.runRound();
  assert.equal(round1.kind, "completed");
  assert.ok(round1.kind === "completed");
  assert.deepEqual(round1.progress, { complete: 2, total: 4 });
  assert.equal(round1.planComplete, false);
  assert.deepEqual(task.checklist, { total: 4, checked: 2, remaining: 2 });

  // Round 2: the provider posts questions; the task pauses.
  const round2 = await task.runRound();
  assert.equal(round2.kind, "questionsPosted");
  assert.ok(round2.kind === "questionsPosted");
  assert.equal(task.progress.status, "paused");

  // Answers submit idempotently (same id + same payload is a no-op).
  const answers = [
    { questionId: "q-scope", kind: "text", state: "answered", value: "gamma first" },
    { questionId: "q-approach", kind: "singleChoice", state: "answered", selectedOptionId: "opt-a" },
  ];
  const answerId = allocateHex128IdV1();
  const submitted = await task.submitAnswers(round2.ref, answers, answerId);
  assert.deepEqual(submitted, { ok: true, duplicate: false });
  const resubmitted = await task.submitAnswers(round2.ref, answers, answerId);
  assert.deepEqual(resubmitted, { ok: true, duplicate: true });

  // Resume: the invocation runs exactly once and the outcome is recorded.
  const resumeId = allocateHex128IdV1();
  const resumed = await task.resume(round2.ref, resumeId);
  assert.equal(resumed.kind, "resumed");
  assert.ok(resumed.kind === "resumed");
  assert.equal(resumed.result.kind, "completed");
  assert.ok(resumed.result.kind === "completed");
  assert.equal(resumed.result.planComplete, true);
  assert.deepEqual(resumed.result.progress, { complete: 4, total: 4 });
  assert.equal(task.progress.status, "active");

  // The resumed invocation carried the validated answers.
  const resumedInvocation = invocations[2]!;
  assert.deepEqual(
    JSON.parse(JSON.stringify(resumedInvocation.answers)),
    answers,
    "resumed invocation did not carry the submitted answers"
  );

  // Replaying the identical Resume recovers the recorded outcome without
  // invoking the provider again (script is exhausted — a re-invoke throws).
  const replayed = await task.resume(round2.ref, resumeId);
  assert.equal(replayed.kind, "recovered");
  assert.ok(replayed.kind === "recovered");
  assert.equal(replayed.outcome.kind, "completed");

  // A DIFFERENT Resume id against the settled interaction is rejected.
  const secondResume = await task.resume(round2.ref, allocateHex128IdV1());
  assert.equal(secondResume.kind, "failed");

  // Stage advancement: impl -> impl-high-review. The strict decoder
  // canonicalizes completedStages to the contiguous STAGE_ORDER prefix
  // through the highest recorded stage — the extension's own persisted
  // semantics, which the journal's self-decode applies too.
  const advanced = task.advanceStage();
  assert.equal(advanced.currentStage, "impl-high-review");
  assert.deepEqual(advanced.completedStages, [
    "desc",
    "plan",
    "plan-high-review",
    "plan-low-review",
    "impl",
  ]);

  // --- Frame-level parity: every emitted frame under the src decoders ------
  assertFramesDecodeUnderSrc(sink.events);

  // --- The persisted chat transaction decodes under the src codec ----------
  const transaction = await store.load(round2.ref.operationId);
  assert.equal(transaction.kind, "ok");
  assert.ok(transaction.kind === "ok");
  const encoded = encodeChatInteractionTransactionV1(transaction.transaction);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(encoded));
  const srcDecoded = srcChat.decodeChatInteractionTransactionV1(parsed);
  assert.ok(
    srcDecoded.ok,
    `persisted chat transaction rejected by src codec: ${srcDecoded.ok ? "" : srcDecoded.reason}`
  );
  assert.deepEqual(srcDecoded.transaction, JSON.parse(JSON.stringify(transaction.transaction)));
  assert.equal(srcDecoded.transaction.state, "settled");
  assert.equal(srcDecoded.transaction.settlement, "resumed");
  assert.ok(srcDecoded.transaction.resumeInvocationClaimedAt !== undefined);
  assert.equal(srcDecoded.transaction.resumeInvocationOutcome?.kind, "completed");

  // --- Event shape expectations (Part 3 schemas) ----------------------------
  const kinds = sink.events.map((event) => event.type);
  assert.ok(kinds.includes("taskProgress"));
  assert.ok(kinds.includes("structuredQuestions"));
  assert.ok(kinds.includes("chatTransactionState"));
  const chatStates = sink.events
    .filter((event) => event.type === "chatTransactionState")
    .map((event) => (event.type === "chatTransactionState" ? event.state : ""));
  assert.deepEqual(chatStates, ["questionsPosted", "answersSubmitted", "settled"]);
  const lifecyclePhases = sink.events.flatMap((event) =>
    event.type === "notification" && event.notification.kind === "agentLifecycle"
      ? [event.notification.phase]
      : []
  );
  assert.equal(lifecyclePhases[0], "started");
  assert.ok(lifecyclePhases.includes("progress"));
});

test("checklist authority: a narrowed self-reported marker cannot declare the plan finished", async () => {
  const now = testClock();
  const sink = createRecordingEventSinkV1();
  const task = createEngineTaskV1({
    taskId: "task-demo-2",
    taskFolder: "2026-08-12_task_2",
    planOfRecord: PLAN_OF_RECORD,
    initialStage: "impl",
    now,
    sink,
    provider: {
      async invoke() {
        // The round ticks two items but claims a narrowed 2/2 denominator.
        return {
          kind: "completed",
          summaryMarkdown: summaryTicking(
            ["build the alpha module", "build the beta module"],
            "<!-- progress: 2/2 -->"
          ),
        } satisfies EngineRoundResultV1;
      },
    },
  });
  task.start();
  const round = await task.runRound();
  assert.ok(round.kind === "completed");
  // The checklist (2 of 4) wins over the marker's 2/2.
  assert.deepEqual(round.progress, { complete: 2, total: 4 });
  assert.equal(round.planComplete, false);
  assertFramesDecodeUnderSrc(sink.events, { questionFrames: false });
});

test("failed rounds discard the pending admission and emit a typed error", async () => {
  const now = testClock();
  const store = createInMemoryEngineTransactionStoreV1({ now });
  const sink = createRecordingEventSinkV1();
  const task = createEngineTaskV1({
    taskId: "task-demo-3",
    taskFolder: "2026-08-12_task_3",
    planOfRecord: PLAN_OF_RECORD,
    initialStage: "impl",
    now,
    store,
    sink,
    provider: {
      async invoke() {
        return { kind: "failed", code: "providerUnreachable", retryable: true } satisfies EngineRoundResultV1;
      },
    },
  });
  task.start();
  const round = await task.runRound();
  assert.deepEqual(round, { kind: "failed", code: "providerUnreachable", retryable: true });
  // No unresolved interaction survives a non-questions outcome.
  const unresolved = await store.listUnresolvedForChatDocument(
    sha256HexUtf8V1("ensemble-engine-chat-document-v1\ntask-demo-3")
  );
  assert.equal(unresolved.length, 0);
  const errors = sink.events.filter(
    (event) => event.type === "notification" && event.notification.kind === "error"
  );
  assert.equal(errors.length, 1);
});

test("replacementOperation resume settles as supersededByReplacementOperation and decodes under src", async () => {
  const now = testClock();
  const store = createInMemoryEngineTransactionStoreV1({ now });
  const orchestrator = createEngineConversationOrchestratorV1({ transactionStore: store });

  const operationId = allocateHex128IdV1();
  const attemptId = allocateHex128IdV1();
  const correlation = {
    actionKey: "engine.commitPush.v1",
    operationId,
    attemptId,
    taskBindingId: sha256HexUtf8V1("binding"),
    chatDocumentId: sha256HexUtf8V1("chat-doc"),
  };
  const promptContract = {
    contractId: "ensemble.engine.round.v1",
    contractVersion: 1,
    promptInputSha256: sha256HexUtf8V1("input"),
  };

  const admitted = await orchestrator.admitInvocation({
    correlation,
    stage: "publish",
    resumeSemantics: "replacementOperation",
    validatedInput: { taskId: "task-demo-4" },
    promptContract,
  });
  assert.ok(admitted.ok);

  const posted = await orchestrator.postQuestions({
    correlation,
    stage: "publish",
    resumeSemantics: "replacementOperation",
    questions: QUESTIONS,
    validatedInput: { taskId: "task-demo-4" },
    promptContract,
  });
  assert.ok(posted.ok);
  assert.ok(posted.ok === true);
  const ref = {
    operationId,
    interactionId: posted.record.interactionId,
    taskBindingId: correlation.taskBindingId,
    chatDocumentId: correlation.chatDocumentId,
    sourceAttemptId: attemptId,
  };

  const submitted = await orchestrator.submitAnswers(
    ref,
    [
      { questionId: "q-scope", kind: "text", state: "answered", value: "publish now" },
      { questionId: "q-approach", kind: "singleChoice", state: "answered", selectedOptionId: "opt-b" },
    ],
    allocateHex128IdV1()
  );
  assert.deepEqual(submitted, { ok: true, duplicate: false });

  const resumeId = allocateHex128IdV1();
  const resolution = await orchestrator.resolveResume(ref, resumeId);
  assert.equal(resolution.kind, "replacementOperation");
  assert.ok(resolution.kind === "replacementOperation");
  assert.equal(resolution.resumedFromOperationId, operationId);

  // Identical id replays the exact recorded resolution.
  const replayed = await orchestrator.resolveResume(ref, resumeId);
  assert.deepEqual(replayed, resolution);

  // Claim once; record the outcome bound to the REPLACEMENT operation.
  const claim = await orchestrator.claimResumeInvocation(ref);
  assert.ok(claim.ok && !claim.alreadyClaimed);
  const recorded = await orchestrator.recordResumeInvocationOutcome(ref, {
    kind: "completed",
    correlation: {
      ...correlation,
      operationId: resolution.replacementOperationId,
      attemptId: allocateHex128IdV1(),
    },
    code: "completed",
  });
  assert.deepEqual(recorded, { ok: true });

  const secondClaim = await orchestrator.claimResumeInvocation(ref);
  assert.ok(secondClaim.ok && secondClaim.alreadyClaimed);
  assert.equal(secondClaim.ok && secondClaim.recoveredOutcome?.kind, "completed");

  const loaded = await store.load(operationId);
  assert.ok(loaded.kind === "ok");
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(encodeChatInteractionTransactionV1(loaded.transaction))
  );
  const srcDecoded = srcChat.decodeChatInteractionTransactionV1(parsed);
  assert.ok(
    srcDecoded.ok,
    `replacement-settled transaction rejected by src codec: ${srcDecoded.ok ? "" : srcDecoded.reason}`
  );
  assert.equal(srcDecoded.transaction.settlement, "supersededByReplacementOperation");
});

test("invocationPending admissions are invisible and cancel settles exactly once", async () => {
  const now = testClock();
  const store = createInMemoryEngineTransactionStoreV1({ now });
  const orchestrator = createEngineConversationOrchestratorV1({ transactionStore: store });
  const correlation = {
    actionKey: "engine.runRound.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: sha256HexUtf8V1("binding-2"),
    chatDocumentId: sha256HexUtf8V1("chat-doc-2"),
  };
  const promptContract = {
    contractId: "ensemble.engine.round.v1",
    contractVersion: 1,
    promptInputSha256: sha256HexUtf8V1("input-2"),
  };
  const admitted = await orchestrator.admitInvocation({
    correlation,
    stage: "impl",
    resumeSemantics: "sameOperation",
    validatedInput: {},
    promptContract,
  });
  assert.ok(admitted.ok);
  // Pending admissions never render as unresolved interactions.
  assert.equal((await store.listUnresolvedForChatDocument(correlation.chatDocumentId)).length, 0);

  const posted = await orchestrator.postQuestions({
    correlation,
    stage: "impl",
    resumeSemantics: "sameOperation",
    questions: [QUESTIONS[0]!],
    validatedInput: {},
    promptContract,
  });
  assert.ok(posted.ok && posted.ok === true);
  assert.equal((await store.listUnresolvedForChatDocument(correlation.chatDocumentId)).length, 1);

  const ref = {
    operationId: correlation.operationId,
    interactionId: posted.ok === true ? posted.record.interactionId : "",
    taskBindingId: correlation.taskBindingId,
    chatDocumentId: correlation.chatDocumentId,
    sourceAttemptId: correlation.attemptId,
  };
  await orchestrator.cancel(ref);
  await assert.rejects(() => orchestrator.cancel(ref), /settles exactly once/);

  const loaded = await store.load(correlation.operationId);
  assert.ok(loaded.kind === "ok");
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(encodeChatInteractionTransactionV1(loaded.transaction))
  );
  const srcDecoded = srcChat.decodeChatInteractionTransactionV1(parsed);
  assert.ok(srcDecoded.ok);
  assert.equal(srcDecoded.transaction.settlement, "cancelled");
});

test("Part 4b dispatch integration: the real provider runner drives a round/question/resume cycle and every emitted frame decodes under src", async () => {
  const now = testClock();
  const sink = createRecordingEventSinkV1();

  // A scripted direct-API adapter that behaves as a contract-following model
  // must: it reads the correlation echo out of the round prompt and answers
  // with a strict `ensemble.aiResultContract.v1` frame — first structured
  // questions, then (after Resume carries the answers) a completed
  // markdown-artifact whose checklist ticks the whole plan.
  const frameFor = (prompt: string, payload: Record<string, unknown>): string => {
    const match = /\(echo it verbatim\): (\{[^\n]*\})/.exec(prompt);
    assert.ok(match, "round prompt does not embed the correlation echo");
    const correlation: unknown = JSON.parse(match![1]!);
    return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify({
      version: 1,
      correlation,
      ...payload,
    })}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
  };
  const adapterInvocations: EngineTextInvocationV1[] = [];
  const adapter: EngineModelProviderAdapterV1 = {
    providerId: "anthropic",
    async invokeText(input) {
      adapterInvocations.push(input);
      if (adapterInvocations.length === 1) {
        return {
          status: "completed",
          text: frameFor(input.prompt, { kind: "questions", questions: QUESTIONS }),
        };
      }
      return {
        status: "completed",
        text: frameFor(input.prompt, {
          kind: "completed",
          content: {
            contentType: "markdown-artifact.v1",
            schemaVersion: 1,
            markdown: summaryTicking(
              [
                "build the alpha module",
                "build the beta module",
                "build the gamma module",
                "build the delta module",
              ],
              "<!-- progress: 4/4 -->"
            ),
          },
        }),
      };
    },
  };

  const settings: ModelSettings = {
    impl: { primary: "anthropic:claude-sonnet-5", strategy: "alert-and-wait" },
  };
  const provider = createEngineProviderRunnerV1({
    getModelSettings: () => settings,
    getEnabledProviders: () => undefined,
    getProviderApiKey: (id: EngineProviderIdV1) => (id === "anthropic" ? "sk-ant-test" : undefined),
    adapters: new Map<EngineProviderIdV1, EngineModelProviderAdapterV1>([["anthropic", adapter]]),
    now,
  });

  const task = createEngineTaskV1({
    taskId: "task-demo-4b",
    taskFolder: "2026-08-12_task_4b",
    displayName: "Dispatch integration task",
    planOfRecord: PLAN_OF_RECORD,
    initialStage: "impl",
    now,
    sink,
    provider,
  });
  task.start();

  const round1 = await task.runRound();
  assert.equal(round1.kind, "questionsPosted");
  assert.ok(round1.kind === "questionsPosted");
  assert.equal(task.progress.status, "paused");

  const submitted = await task.submitAnswers(
    round1.ref,
    [
      { questionId: "q-scope", kind: "text", state: "answered", value: "gamma first" },
      { questionId: "q-approach", kind: "singleChoice", state: "answered", selectedOptionId: "opt-a" },
    ],
    allocateHex128IdV1()
  );
  assert.deepEqual(submitted, { ok: true, duplicate: false });

  const resumed = await task.resume(round1.ref, allocateHex128IdV1());
  assert.equal(resumed.kind, "resumed");
  assert.ok(resumed.kind === "resumed");
  assert.equal(resumed.result.kind, "completed");
  assert.ok(resumed.result.kind === "completed");
  assert.equal(resumed.result.planComplete, true);
  assert.deepEqual(resumed.result.progress, { complete: 4, total: 4 });

  // The resumed round prompt carried the validated answers.
  assert.equal(adapterInvocations.length, 2);
  assert.ok(adapterInvocations[1]!.prompt.includes("gamma first"));

  // Every frame the dispatch-driven run emitted decodes under the extension's
  // own decoders — the same oracle discipline as the scripted scenarios.
  assertFramesDecodeUnderSrc(sink.events);
});

test("Part 4c gate flow: gate lifecycle and indeterminate re-offer emissions ride the 4a event stream in contract shape", async () => {
  // Gates have no extension counterpart (the src decoders carry no gate
  // vocabulary), so the oracle here is the Part 3 contract union itself:
  // the recording sink is typed to EngineEventV1, and these assertions pin
  // the runtime sequence and payload shape of every gate emission.
  const now = testClock();
  const sink = createRecordingEventSinkV1();
  const machinery = createEngineGateMachineryV1({
    taskId: "task-demo-4c",
    ownerId: "user-1",
    workerId: "worker-1",
    sink,
    now,
  });

  const gate = await machinery.openGate({
    summary: "apply the reviewed change",
    changes: [{ path: "src/alpha.ts", oldText: "before\n", newText: "after\n" }],
  });
  assert.ok(gate.diffUnified?.includes("+++ b/src/alpha.ts"));
  const key = allocateHex128IdV1();
  const decided = await machinery.decide({ gateId: gate.gateId, decision: "approve", idempotencyKey: key });
  assert.equal(decided.kind, "decided");
  // A replayed decision emits nothing (exactly once per real transition).
  const replay = await machinery.decide({ gateId: gate.gateId, decision: "approve", idempotencyKey: key });
  assert.equal(replay.kind, "replayed");

  // A non-idempotent, non-reconcilable effect whose outcome-persist crashes:
  // recovery must produce the indeterminate re-offer through the SAME sink.
  let armCrash = true;
  const inner = machinery.attemptStore;
  const originalComplete = inner.complete.bind(inner);
  (inner as { complete: typeof inner.complete }).complete = (attemptKey, state, outcomeCode) => {
    if (armCrash) {
      armCrash = false;
      throw new Error("injected crash: before the outcome persisted");
    }
    return originalComplete(attemptKey, state, outcomeCode);
  };
  const effect: EngineExternalEffectV1 = {
    effectKind: "modelProviderCall",
    supportsIdempotentReplay: false,
    async execute() {
      return { status: "succeeded", code: "ok" };
    },
  };
  await assert.rejects(() => machinery.resumeApproved(gate.gateId, effect), /before the outcome/);
  const recovered = await machinery.resumeApproved(gate.gateId, effect);
  assert.equal(recovered.kind, "indeterminate");
  assert.ok(recovered.kind === "indeterminate");

  // The emitted stream, in order: the original gate's pending + request, its
  // approval, then the re-offer gate's pending + request + the typed
  // indeterminateAttempt notification.
  const shapes = sink.events.map((event) =>
    event.type === "notification" ? `notification:${event.notification.kind}` : event.type
  );
  assert.deepEqual(shapes, [
    "gateStateChanged",
    "notification:gateRequested",
    "gateStateChanged",
    "gateStateChanged",
    "notification:gateRequested",
    "notification:indeterminateAttempt",
  ]);
  const gateStates = sink.events.flatMap((event) =>
    event.type === "gateStateChanged" ? [event.state] : []
  );
  assert.deepEqual(gateStates, ["pending", "approved", "pending"]);
  const indeterminate = sink.events.find(
    (event) => event.type === "notification" && event.notification.kind === "indeterminateAttempt"
  );
  assert.ok(indeterminate !== undefined && indeterminate.type === "notification");
  assert.ok(indeterminate.notification.kind === "indeterminateAttempt");
  assert.equal(indeterminate.notification.gateId, recovered.reofferGateId);
  assert.equal(indeterminate.notification.attemptKey, recovered.attemptKey);
});
