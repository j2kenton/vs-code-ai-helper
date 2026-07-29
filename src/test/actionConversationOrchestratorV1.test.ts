/**
 * Coverage for the action conversation orchestrator (plan §3.8 / §5.5's
 * state machine / AC-ID-04's Resume semantics), now backed by the DURABLE
 * Chat interaction transaction store (step 8's Chat-cohort wiring):
 *  - questions post as an unresolved interaction persisted at the
 *    registry-vended §2.1 locator, with a canonical digest;
 *  - answer submission validates against the question set and is idempotent
 *    only for the identical idempotency id + canonical answers;
 *  - `sameOperation` Resume retains the operation with a fresh attempt;
 *    `replacementOperation` Resume allocates a linked fresh operation and
 *    settles the source as `supersededByReplacementOperation`;
 *  - the interaction survives an orchestrator restart (a fresh instance over
 *    the same storage resumes it — AC-QUESTION-03's reconstructibility);
 *  - Resume idempotency ids are caller-owned and required (§3.1): a second
 *    Resume of the same interaction is rejected, while the identical Resume
 *    idempotency id replays the recorded resolution — the linkage's exact
 *    recorded attempt/operation;
 *  - cancel/expire settle exactly once and answering never resumes anything
 *    implicitly;
 *  - `claimResumeInvocation` durably claims a settled resolution's provider
 *    invocation exactly once (AC-RUNNER-03): it rejects before settlement,
 *    the first call after settlement wins, and every later call — including
 *    across orchestrator instances — reports `alreadyClaimed` rather than a
 *    fresh win;
 *  - `recordResumeInvocationOutcome` requires the invocation to already be
 *    claimed and is idempotent; once recorded, a later `claimResumeInvocation`
 *    surfaces the EXACT recorded outcome via `recoveredOutcome` instead of
 *    bare `alreadyClaimed` ("recover the claimed terminal result").
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  ActionConversationErrorV1,
  ActionConversationOrchestratorV1,
  createActionConversationOrchestratorV1,
  InteractionRefV1,
  PostQuestionsInputV1,
  PostQuestionsResultV1,
  SubmitAnswersResultV1,
} from "../actions/actionConversationOrchestratorV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import { createWorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import { createWorkflowPathRegistryV1 } from "../services/workflowPathRegistryV1";
import {
  ActionCorrelationV1,
  allocateHex128IdV1,
  isHex128IdV1,
  ResumeSemanticsV1,
} from "../types/actionCorrelationV1";
import {
  canonicalJsonByteLengthV1,
  MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1,
  StructuredAnswerV1,
  StructuredQuestionV1,
} from "../types/structuredQuestionV1";

const QUESTIONS: readonly StructuredQuestionV1[] = [
  {
    questionId: "q1",
    kind: "text",
    prompt: "Which module should own the migration?",
    required: true,
    allowBlank: false,
    maxLength: 200,
  },
];

const VALID_ANSWERS: readonly StructuredAnswerV1[] = [
  { questionId: "q1", kind: "text", state: "answered", value: "taskInventory" },
];

const PROMPT_CONTRACT = {
  contractId: "ensemble.aiResultContract.v1",
  contractVersion: 1,
  promptInputSha256: "a".repeat(64),
};

function fakeCorrelation(actionKey = "generatePlan.v1"): ActionCorrelationV1 {
  return {
    actionKey,
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

function postInput(
  correlation: ActionCorrelationV1,
  resumeSemantics: ResumeSemanticsV1 = "sameOperation",
  questions: readonly StructuredQuestionV1[] = QUESTIONS
): PostQuestionsInputV1 {
  return {
    correlation,
    stage: "impl",
    resumeSemantics,
    questions,
    validatedInput: { stage: "plan" },
    promptContract: PROMPT_CONTRACT,
  };
}

function expectPosted(result: PostQuestionsResultV1): asserts result is Extract<
  PostQuestionsResultV1,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
}

function failureReason(result: SubmitAnswersResultV1): string {
  return result.ok ? "" : result.reason;
}

/** Wire the durable orchestrator exactly as production will (§2.1/§1.8 storage). */
function makeOrchestrator(rootFsPath: string): ActionConversationOrchestratorV1 {
  const registry = createWorkflowPathRegistryV1();
  registry.registerRoot({
    rootId: "private-storage",
    fsPath: rootFsPath,
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

let tmpRoot: string;
let orchestrator: ActionConversationOrchestratorV1;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-conversation-"));
  orchestrator = makeOrchestrator(tmpRoot);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function postedInteraction(
  resumeSemantics: ResumeSemanticsV1 = "sameOperation"
): Promise<{ correlation: ActionCorrelationV1; ref: InteractionRefV1 }> {
  const correlation = fakeCorrelation();
  const posted = await orchestrator.postQuestions(postInput(correlation, resumeSemantics));
  expectPosted(posted);
  return {
    correlation,
    ref: {
      operationId: correlation.operationId,
      interactionId: posted.record.interactionId,
      taskBindingId: correlation.taskBindingId,
      chatDocumentId: correlation.chatDocumentId,
      sourceAttemptId: correlation.attemptId,
    },
  };
}

void describe("actionConversationOrchestratorV1", () => {
  void it("posts questions as a durably persisted unresolved interaction with a digest", async () => {
    const correlation = fakeCorrelation();
    const posted = await orchestrator.postQuestions(postInput(correlation));
    expectPosted(posted);
    const record = posted.record;
    assert.equal(isHex128IdV1(record.interactionId), true);
    assert.equal(record.state, "questionsPosted");
    assert.equal(record.resumeSemantics, "sameOperation");
    assert.deepEqual(record.correlation, correlation);
    assert.match(record.questionSetDigest!, /^[0-9a-f]{64}$/);

    // The record sits at the registry-vended §2.1 locator.
    assert.ok(
      fs.existsSync(
        path.join(
          tmpRoot,
          "workflow-runtime-v1",
          "chat-transactions",
          correlation.operationId,
          "transaction-v1.json"
        )
      )
    );

    const empty = await orchestrator.postQuestions(postInput(fakeCorrelation(), "sameOperation", []));
    assert.equal(empty.ok, false);
    if (empty.ok) {
      assert.fail("expected an empty question set to be rejected");
    }
    assert.equal(empty.code, "chatTransactionRejected");
  });

  void it("validates answers against the question set", async () => {
    const { ref } = await postedInteraction();
    const idempotencyId = allocateHex128IdV1();

    const skipped = await orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "skipped" }],
      idempotencyId
    );
    assert.equal(skipped.ok, false);

    const badId = await orchestrator.submitAnswers(ref, VALID_ANSWERS, "not-hex");
    assert.equal(badId.ok, false);

    const submitted = await orchestrator.submitAnswers(ref, VALID_ANSWERS, idempotencyId);
    assert.deepEqual(submitted, { ok: true, duplicate: false });
    assert.equal((await orchestrator.getRecord(ref))?.state, "answersSubmitted");
  });

  void it("treats only the identical idempotency id + answers as a duplicate no-op", async () => {
    const { ref } = await postedInteraction();
    const idempotencyId = allocateHex128IdV1();
    assert.equal((await orchestrator.submitAnswers(ref, VALID_ANSWERS, idempotencyId)).ok, true);

    const duplicate = await orchestrator.submitAnswers(ref, VALID_ANSWERS, idempotencyId);
    assert.deepEqual(duplicate, { ok: true, duplicate: true });

    const differentAnswers = await orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "different" }],
      idempotencyId
    );
    assert.equal(differentAnswers.ok, false);

    const differentId = await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    assert.equal(differentId.ok, false);
  });

  void it("resolves a sameOperation Resume with the original operation and a fresh attempt", async () => {
    const { correlation, ref } = await postedInteraction("sameOperation");
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());

    const resolution = await orchestrator.resolveResume(ref, allocateHex128IdV1());
    assert.equal(resolution.kind, "sameOperation");
    if (resolution.kind !== "sameOperation") {
      assert.fail("expected a sameOperation resolution");
    }
    assert.equal(resolution.operationId, correlation.operationId);
    assert.equal(isHex128IdV1(resolution.newAttemptId), true);
    assert.notEqual(resolution.newAttemptId, correlation.attemptId);

    const record = await orchestrator.getRecord(ref);
    assert.equal(record?.state, "settled");
    assert.equal(record?.settlement, "resumed");
    assert.deepEqual(record?.resumeResolution, resolution);
  });

  void it("resolves a replacementOperation Resume as a linked fresh operation", async () => {
    const { correlation, ref } = await postedInteraction("replacementOperation");
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());

    const resolution = await orchestrator.resolveResume(ref, allocateHex128IdV1());
    assert.equal(resolution.kind, "replacementOperation");
    if (resolution.kind !== "replacementOperation") {
      assert.fail("expected a replacementOperation resolution");
    }
    assert.equal(isHex128IdV1(resolution.replacementOperationId), true);
    assert.notEqual(resolution.replacementOperationId, correlation.operationId);
    assert.equal(resolution.resumedFromOperationId, correlation.operationId);
    assert.equal(resolution.sourceInteractionId, ref.interactionId);
    assert.equal(
      (await orchestrator.getRecord(ref))?.settlement,
      "supersededByReplacementOperation"
    );
  });

  void it("reconstructs and resumes an interaction across orchestrator instances (AC-QUESTION-03)", async () => {
    const { correlation, ref } = await postedInteraction("sameOperation");
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());

    // A fresh orchestrator over the same storage — the restart case — reads
    // the persisted record and performs the Resume.
    const reopened = makeOrchestrator(tmpRoot);
    const record = await reopened.getRecord(ref);
    assert.equal(record?.state, "answersSubmitted");
    assert.deepEqual(record?.questions, QUESTIONS);

    const resolution = await reopened.resolveResume(ref, allocateHex128IdV1());
    assert.equal(resolution.kind, "sameOperation");
    if (resolution.kind !== "sameOperation") {
      assert.fail("expected a sameOperation resolution");
    }
    assert.equal(resolution.operationId, correlation.operationId);
  });

  void it("exposes the validated-input snapshot and typed load results for the coordinator's Resume path", async () => {
    const { ref } = await postedInteraction();

    // The record carries the §5.5 validated-input snapshot in canonical
    // JSON with its digest — what the coordinator reconstructs the action
    // from (AC-QUESTION-03).
    const loaded = await orchestrator.loadInteraction(ref);
    assert.equal(loaded.kind, "ok");
    if (loaded.kind !== "ok") {
      assert.fail("expected a loaded record");
    }
    assert.equal(loaded.record.inputSnapshot.canonicalJson, '{"stage":"plan"}');
    assert.match(loaded.record.inputSnapshot.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(loaded.record.inputSnapshot.canonicalJson), { stage: "plan" });

    // Unknown references load as data, never as a throw.
    const unknownInteraction = await orchestrator.loadInteraction({
      ...ref,
      interactionId: allocateHex128IdV1(),
    });
    assert.equal(unknownInteraction.kind, "unknown");
    const unknownOperation = await orchestrator.loadInteraction({
      ...ref,
      operationId: allocateHex128IdV1(),
    });
    assert.equal(unknownOperation.kind, "unknown");

    // The Resume idempotency binding surfaces on the record once recorded.
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    const resumeIdempotencyId = allocateHex128IdV1();
    await orchestrator.resolveResume(ref, resumeIdempotencyId);
    const settled = await orchestrator.getRecord(ref);
    assert.equal(settled?.resumeIdempotencyId, resumeIdempotencyId);
  });

  void it("rejects a second Resume, a malformed id, and a Resume without submitted answers", async () => {
    const { ref } = await postedInteraction();
    await assert.rejects(
      () => orchestrator.resolveResume(ref, "not-hex"),
      ActionConversationErrorV1
    );
    await assert.rejects(
      () => orchestrator.resolveResume(ref, allocateHex128IdV1()),
      ActionConversationErrorV1
    );

    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    await orchestrator.resolveResume(ref, allocateHex128IdV1());
    await assert.rejects(
      () => orchestrator.resolveResume(ref, allocateHex128IdV1()),
      ActionConversationErrorV1
    );
  });

  void it("replays the recorded resolution for the identical Resume idempotency id", async () => {
    const { ref } = await postedInteraction();
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    const resumeIdempotencyId = allocateHex128IdV1();

    const first = await orchestrator.resolveResume(ref, resumeIdempotencyId);
    const replay = await orchestrator.resolveResume(ref, resumeIdempotencyId);
    assert.deepEqual(replay, first);

    // Any OTHER id is the rejected second Resume (plan §3.1).
    await assert.rejects(
      () => orchestrator.resolveResume(ref, allocateHex128IdV1()),
      ActionConversationErrorV1
    );
  });

  void it("claims the resume invocation exactly once and rejects a claim before settlement (AC-RUNNER-03)", async () => {
    const { ref } = await postedInteraction();

    // Too early: Resume has not even been scheduled yet.
    const tooEarly = await orchestrator.claimResumeInvocation(ref);
    assert.equal(tooEarly.ok, false);

    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    await orchestrator.resolveResume(ref, allocateHex128IdV1());

    const first = await orchestrator.claimResumeInvocation(ref);
    assert.deepEqual(first, { ok: true, alreadyClaimed: false });

    // A second claim of the same interaction must never report a fresh win.
    const second = await orchestrator.claimResumeInvocation(ref);
    assert.deepEqual(second, { ok: true, alreadyClaimed: true });

    const record = await orchestrator.getRecord(ref);
    assert.ok(typeof record?.resumeInvocationClaimedAt === "string");
  });

  void it("recovers the recorded terminal outcome on a later claim once the invocation completes (AC-RUNNER-03)", async () => {
    const { ref, correlation } = await postedInteraction();
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    await orchestrator.resolveResume(ref, allocateHex128IdV1());

    const first = await orchestrator.claimResumeInvocation(ref);
    assert.deepEqual(first, { ok: true, alreadyClaimed: false });

    // Before the invocation's outcome is recorded, a re-claim is the
    // genuinely ambiguous in-flight/unknown case: claimed, no outcome yet.
    const beforeOutcome = await orchestrator.claimResumeInvocation(ref);
    assert.deepEqual(beforeOutcome, { ok: true, alreadyClaimed: true });

    const outcome = { kind: "completed", correlation, code: "completed" } as const;
    const recorded = await orchestrator.recordResumeInvocationOutcome(ref, outcome);
    assert.deepEqual(recorded, { ok: true });

    // A recording failure must never block returning the real outcome (it
    // is best-effort from the caller's side) — a duplicate report is a
    // harmless no-op.
    const recordedAgain = await orchestrator.recordResumeInvocationOutcome(ref, outcome);
    assert.deepEqual(recordedAgain, { ok: true });

    // Now a later claim recovers the EXACT recorded outcome instead of
    // reporting bare `alreadyClaimed` with nothing to act on.
    const afterOutcome = await orchestrator.claimResumeInvocation(ref);
    assert.deepEqual(afterOutcome, { ok: true, alreadyClaimed: true, recoveredOutcome: outcome });

    const record = await orchestrator.getRecord(ref);
    assert.deepEqual(record?.resumeInvocationOutcome, outcome);
  });

  void it("rejects recording an outcome before the invocation is claimed (AC-RUNNER-03)", async () => {
    const { ref, correlation } = await postedInteraction();
    await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1());
    await orchestrator.resolveResume(ref, allocateHex128IdV1());

    const tooEarly = await orchestrator.recordResumeInvocationOutcome(ref, {
      kind: "completed",
      correlation,
      code: "completed",
    });
    assert.equal(tooEarly.ok, false);

    const record = await orchestrator.getRecord(ref);
    assert.equal(record?.resumeInvocationOutcome, undefined);
  });

  void it("settles cancel and expire exactly once and refuses answers afterwards", async () => {
    const { ref } = await postedInteraction();
    await orchestrator.cancel(ref);
    assert.equal((await orchestrator.getRecord(ref))?.settlement, "cancelled");
    await assert.rejects(() => orchestrator.cancel(ref), ActionConversationErrorV1);
    assert.equal(
      (await orchestrator.submitAnswers(ref, VALID_ANSWERS, allocateHex128IdV1())).ok,
      false
    );

    const second = await postedInteraction();
    await orchestrator.expire(second.ref);
    assert.equal((await orchestrator.getRecord(second.ref))?.settlement, "expired");
    await assert.rejects(
      () => orchestrator.resolveResume(second.ref, allocateHex128IdV1()),
      ActionConversationErrorV1
    );
  });

  void it("fail-closes on unknown or mismatched interaction references", async () => {
    const unknownRef: InteractionRefV1 = {
      operationId: allocateHex128IdV1(),
      interactionId: allocateHex128IdV1(),
      taskBindingId: "task-binding-digest",
      chatDocumentId: "chat-document-id",
      sourceAttemptId: allocateHex128IdV1(),
    };
    await assert.rejects(
      () => orchestrator.resolveResume(unknownRef, allocateHex128IdV1()),
      ActionConversationErrorV1
    );
    assert.equal(await orchestrator.getRecord(unknownRef), undefined);

    // A real operation addressed with a foreign interaction id never reaches
    // the record.
    const { ref } = await postedInteraction();
    const mismatched: InteractionRefV1 = { ...ref, interactionId: allocateHex128IdV1() };
    assert.equal(await orchestrator.getRecord(mismatched), undefined);
    assert.equal(
      (await orchestrator.submitAnswers(mismatched, VALID_ANSWERS, allocateHex128IdV1())).ok,
      false
    );
    await assert.rejects(() => orchestrator.cancel(mismatched), ActionConversationErrorV1);
  });

  void it("enforces the 256 KiB canonical-byte limit on posted question sets", async () => {
    const bigPrompt = "x".repeat(256 * 1024);
    const oversized = [
      { questionId: "q1", kind: "text", prompt: bigPrompt, required: true, allowBlank: false, maxLength: 10 },
    ] as readonly StructuredQuestionV1[];
    const posted = await orchestrator.postQuestions(
      postInput(fakeCorrelation(), "sameOperation", oversized)
    );
    assert.equal(posted.ok, false);
    if (posted.ok) {
      assert.fail("expected an oversized question set to be rejected");
    }
    assert.equal(posted.code, "chatTransactionRejected");
  });

  void it("enforces the 128 KiB canonical-byte limit on answer submissions", async () => {
    const { ref } = await postedInteraction();
    const oversized = [
      { questionId: "q1", kind: "text", state: "answered", value: "x".repeat(128 * 1024) },
    ] as readonly StructuredAnswerV1[];
    const result = await orchestrator.submitAnswers(ref, oversized, allocateHex128IdV1());
    assert.equal(result.ok, false);
    assert.match(failureReason(result), /exceeds.*byte limit/);
  });

  void it("rejects unknown properties on answers at runtime through the strict decoder", async () => {
    const { ref } = await postedInteraction();
    const result = await orchestrator.submitAnswers(
      ref,
      [{ questionId: "q1", kind: "text", state: "answered", value: "hello", extraField: "bad" }],
      allocateHex128IdV1()
    );
    assert.equal(result.ok, false);
    assert.match(failureReason(result), /unknown field/i);
  });

  void it("accepts an exact-limit answer submission", async () => {
    const correlation = fakeCorrelation();
    const largeTextQuestion: readonly StructuredQuestionV1[] = [
      {
        questionId: "q1",
        kind: "text",
        prompt: "Write a very long answer?",
        required: true,
        allowBlank: false,
        maxLength: MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1,
      },
    ];
    const posted = await orchestrator.postQuestions(
      postInput(correlation, "sameOperation", largeTextQuestion)
    );
    expectPosted(posted);
    const ref: InteractionRefV1 = {
      operationId: correlation.operationId,
      interactionId: posted.record.interactionId,
      taskBindingId: correlation.taskBindingId,
      chatDocumentId: correlation.chatDocumentId,
      sourceAttemptId: correlation.attemptId,
    };
    const emptyTemplate: readonly StructuredAnswerV1[] = [
      { questionId: "q1", kind: "text", state: "answered", value: "" },
    ];
    const emptyLen = canonicalJsonByteLengthV1(emptyTemplate);
    const neededChars = MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1 - emptyLen;
    const exactLimit = [
      { questionId: "q1", kind: "text", state: "answered", value: "x".repeat(neededChars) },
    ];
    assert.equal(canonicalJsonByteLengthV1(exactLimit), MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1);
    const result = await orchestrator.submitAnswers(ref, exactLimit, allocateHex128IdV1());
    assert.equal(result.ok, true, failureReason(result));
  });

  void it("rejects a limit-plus-one answer submission", async () => {
    const correlation = fakeCorrelation();
    const largeTextQuestion: readonly StructuredQuestionV1[] = [
      {
        questionId: "q1",
        kind: "text",
        prompt: "Write a very long answer?",
        required: true,
        allowBlank: false,
        maxLength: MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1,
      },
    ];
    const posted = await orchestrator.postQuestions(
      postInput(correlation, "sameOperation", largeTextQuestion)
    );
    expectPosted(posted);
    const ref: InteractionRefV1 = {
      operationId: correlation.operationId,
      interactionId: posted.record.interactionId,
      taskBindingId: correlation.taskBindingId,
      chatDocumentId: correlation.chatDocumentId,
      sourceAttemptId: correlation.attemptId,
    };
    const emptyTemplate: readonly StructuredAnswerV1[] = [
      { questionId: "q1", kind: "text", state: "answered", value: "" },
    ];
    const emptyLen = canonicalJsonByteLengthV1(emptyTemplate);
    const neededChars = MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1 - emptyLen + 1;
    const overLimit = [
      { questionId: "q1", kind: "text", state: "answered", value: "x".repeat(neededChars) },
    ];
    assert.equal(canonicalJsonByteLengthV1(overLimit), MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1 + 1);
    const result = await orchestrator.submitAnswers(ref, overLimit, allocateHex128IdV1());
    assert.equal(result.ok, false);
    assert.match(failureReason(result), /exceeds.*byte limit/);
  });

  void it("cleanly rejects a cyclic raw answer submission instead of throwing", async () => {
    const { ref } = await postedInteraction();
    const cyclic: Record<string, unknown> = { questionId: "q1", kind: "text", state: "answered" };
    cyclic.value = cyclic;
    const result = await orchestrator.submitAnswers(ref, [cyclic], allocateHex128IdV1());
    assert.equal(result.ok, false);
    assert.match(failureReason(result), /not JSON data/);
    assert.equal((await orchestrator.getRecord(ref))?.state, "questionsPosted");
  });
});
