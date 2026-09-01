/**
 * Coverage for the durable Chat interaction transaction contract (plan §5.5
 * / AC-CHAT-TX-01..03, AC-ID-04's persisted idempotency linkage):
 *
 *  - the strict decoder is pinned against every checked-in fixture under
 *    test-fixtures/chat-transactions/ (valid states decode; unknown fields,
 *    digest mismatches, broken receipt chains, semantics mismatches,
 *    non-canonical snapshots, and Resume settlements whose chain skipped
 *    resumeScheduled reject) and against the checked-in JSON Schema's field
 *    rosters;
 *  - the store is wired the way the plan requires (§2.1/§1.8): a registered
 *    privateStorage root, registry-vended locators, and every filesystem
 *    operation through workflowFileStoreV1;
 *  - `begin` creates exactly one durable record per operation and a second
 *    begin rejects (AC-CHAT-TX-01);
 *  - the full state machine round-trips durably across store instances,
 *    with a journaled receipt chain ending at the current state;
 *  - answer submission and Resume scheduling are idempotent exactly for the
 *    recorded idempotency id (+ canonical answers); anything else rejects,
 *    and a second Resume of a settled interaction rejects (plan §3.1);
 *  - Resume settlement enforces the record's declared semantics
 *    (`sameOperation` → `resumed`, `replacementOperation` →
 *    `supersededByReplacementOperation`) and identity distinctness;
 *  - cancel/expire/reset settle exactly once from any unsettled state;
 *  - `recordResumeInvocationOutcome` requires a prior claim, is idempotent
 *    (only the first recorded outcome is ever authoritative), and durably
 *    persists the claimed invocation's exact terminal outcome (plan §3.1 /
 *    AC-RUNNER-03 "recover the claimed terminal result");
 *  - a corrupt persisted record loads as `recoveryRequired` — read-only and
 *    non-resumable (AC-CHAT-TX-03);
 *  - the retention sweep settles stale unresolved records as `expired` and
 *    removes stale settled ones, including their resume-invocation claim
 *    marker, so no directory is left permanently wedged; the marker is
 *    cleared BEFORE the transaction record itself, so an interruption
 *    between the two deletions still recovers on the next sweep instead of
 *    leaving an unreclaimable marker-only directory.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { allocateHex128IdV1, ActionCorrelationV1 } from "../types/actionCorrelationV1";
import {
  CHAT_TRANSACTION_FILENAME_V1,
  CHAT_TRANSACTION_RESUME_INVOCATION_CLAIM_FILENAME_V1,
  decodeChatInteractionTransactionV1,
  isInputSnapshotSizeRejectionReasonV1,
} from "../types/chatInteractionTransactionV1";
import {
  BeginChatTransactionInputV1,
  ChatInteractionTransactionStoreV1,
  ChatTransactionStoreResultV1,
  createChatInteractionTransactionStoreV1,
} from "../services/chatInteractionTransactionStoreV1";
import { createWorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import { createWorkflowPathRegistryV1 } from "../services/workflowPathRegistryV1";
import { StructuredAnswerV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "test-fixtures", "chat-transactions");
const SCHEMA_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "workflow-inventories",
  "schemas",
  "chat-interaction-transaction-v1.schema.json"
);

const QUESTIONS: readonly StructuredQuestionV1[] = [
  {
    questionId: "scope",
    kind: "singleChoice",
    prompt: "Which artifact should the plan target?",
    required: true,
    options: [
      { optionId: "plan", label: "plan.md" },
      { optionId: "task", label: "task.md" },
    ],
  },
  {
    questionId: "notes",
    kind: "text",
    prompt: "Anything else the plan must honor?",
    required: false,
    allowBlank: true,
    maxLength: 500,
  },
];

const VALID_ANSWERS: readonly StructuredAnswerV1[] = [
  { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" },
  { questionId: "notes", kind: "text", state: "skipped" },
];

function correlation(actionKey = "generatePlan.v1"): ActionCorrelationV1 {
  return {
    actionKey,
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

function beginInput(
  overrides: Partial<BeginChatTransactionInputV1> = {}
): BeginChatTransactionInputV1 {
  return {
    correlation: correlation(),
    interactionId: allocateHex128IdV1(),
    stage: "impl",
    resumeSemantics: "sameOperation",
    validatedInput: { stage: "plan", targetArtifact: "plan.md" },
    promptContract: {
      contractId: "ensemble-ai-result-contract",
      contractVersion: 1,
      promptInputSha256: "d".repeat(64),
    },
    questions: QUESTIONS,
    ...overrides,
  };
}

function expectOk(result: ChatTransactionStoreResultV1): asserts result is Extract<
  ChatTransactionStoreResultV1,
  { kind: "ok" }
> {
  assert.equal(result.kind, "ok", `expected ok, got ${JSON.stringify(result)}`);
}

/**
 * Wire the store exactly as the plan requires (§2.1/§1.8): a registered
 * privateStorage root, registry-vended locators, and every filesystem
 * operation through the workflow file store.
 */
function makeStore(rootFsPath: string, now?: () => Date): ChatInteractionTransactionStoreV1 {
  const registry = createWorkflowPathRegistryV1();
  registry.registerRoot({
    rootId: "private-storage",
    fsPath: rootFsPath,
    kind: "privateStorage",
    trustedForMutation: true,
  });
  return createChatInteractionTransactionStoreV1({
    registry,
    fileStore: createWorkflowFileStoreV1(registry.registeredRoots()),
    privateRootId: "private-storage",
    ...(now ? { now } : {}),
  });
}

/** The exact on-disk layout the registry allocates for one record. */
function recordPath(rootFsPath: string, operationId: string): string {
  return path.join(
    rootFsPath,
    "workflow-runtime-v1",
    "chat-transactions",
    operationId,
    CHAT_TRANSACTION_FILENAME_V1
  );
}

function operationDirPath(rootFsPath: string, operationId: string): string {
  return path.join(rootFsPath, "workflow-runtime-v1", "chat-transactions", operationId);
}

function claimMarkerPath(rootFsPath: string, operationId: string): string {
  return path.join(
    operationDirPath(rootFsPath, operationId),
    CHAT_TRANSACTION_RESUME_INVOCATION_CLAIM_FILENAME_V1
  );
}

let tmpRoot: string;
let store: ChatInteractionTransactionStoreV1;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-tx-"));
  store = makeStore(tmpRoot);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

void describe("chatInteractionTransactionV1 decoder fixtures", () => {
  const fixtureNames = fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  void it("covers both decode outcomes with checked-in fixtures", () => {
    assert.ok(fixtureNames.some((n) => n.startsWith("valid-")));
    assert.ok(fixtureNames.some((n) => n.startsWith("invalid-")));
  });

  for (const name of fixtureNames) {
    void it(`${name.startsWith("valid-") ? "accepts" : "rejects"} ${name}`, () => {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
      const result = decodeChatInteractionTransactionV1(raw);
      if (name.startsWith("valid-")) {
        assert.equal(result.ok, true, result.ok ? "" : result.reason);
      } else {
        assert.equal(result.ok, false, `expected ${name} to reject`);
      }
    });
  }

  void it("enforces the Resume transition chain on settlements (plan §5.5)", () => {
    // A forged "resumed" settlement that skipped resumeScheduled must be
    // rejected specifically by the settlement-chain rule — every receipt
    // edge in the fixture is individually legal and all Resume fields exist.
    const forged: unknown = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, "invalid-resumed-without-scheduled-receipt.json"), "utf8")
    );
    const forgedResult = decodeChatInteractionTransactionV1(forged);
    assert.equal(forgedResult.ok, false);
    assert.match(
      (forgedResult as { reason: string }).reason,
      /settlement must settle from a resumeScheduled receipt/
    );

    // A resumeIdempotencyId is proof a Resume was scheduled; without the
    // matching receipt the record is inconsistent.
    const orphanId: unknown = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, "invalid-resume-id-without-scheduled-receipt.json"), "utf8")
    );
    const orphanResult = decodeChatInteractionTransactionV1(orphanId);
    assert.equal(orphanResult.ok, false);
    assert.match(
      (orphanResult as { reason: string }).reason,
      /requires a resumeScheduled transition receipt/
    );
  });

  void it("stays in roster parity with the checked-in JSON Schema", () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "actionKey",
      "answerIdempotencyId",
      "answers",
      "answersSha256",
      "chatDocumentId",
      "inputSnapshot",
      "interactionId",
      "operationId",
      "promptContract",
      "questionSetSha256",
      "questions",
      "resumeIdempotencyId",
      "resumeInvocationClaimedAt",
      "resumeInvocationOutcome",
      "resumeResolution",
      "resumeSemantics",
      "schemaVersion",
      "settlement",
      "sourceAttemptId",
      "stage",
      "state",
      "taskBindingId",
      "transitions",
    ]);
    assert.deepEqual([...schema.required].sort(), [
      "actionKey",
      "chatDocumentId",
      "inputSnapshot",
      "interactionId",
      "operationId",
      "promptContract",
      "resumeSemantics",
      "schemaVersion",
      "sourceAttemptId",
      "stage",
      "state",
      "taskBindingId",
      "transitions",
    ]);
  });
});

void describe("chatInteractionTransactionStoreV1", () => {
  void it("creates exactly one durable record per operation (AC-CHAT-TX-01)", async () => {
    const input = beginInput();
    const first = await store.begin(input);
    expectOk(first);
    assert.equal(first.transaction.state, "questionsPosted");
    assert.equal(first.transaction.sourceAttemptId, input.correlation.attemptId);
    // A direct `begin` with no prior `beginInvocation` admission spans both
    // receipts (null -> invocationPending -> questionsPosted) in one write.
    assert.equal(first.transaction.transitions.length, 2);
    assert.equal(first.transaction.transitions[0]!.from, null);
    assert.equal(first.transaction.transitions[0]!.to, "invocationPending");
    assert.equal(first.transaction.transitions[1]!.from, "invocationPending");
    assert.equal(first.transaction.transitions[1]!.to, "questionsPosted");

    const second = await store.begin(input);
    assert.equal(second.kind, "rejected");

    // The record sits at exactly the registry-vended §2.1 locator.
    assert.ok(fs.existsSync(recordPath(tmpRoot, input.correlation.operationId)));
  });

  void it("round-trips the full state machine durably across store instances", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));

    const draft = await store.saveAnswersDraft(operationId, [VALID_ANSWERS[0]]);
    expectOk(draft);
    assert.equal(draft.transaction.state, "answersDraft");

    // A draft re-save rewrites in place without a new receipt.
    const redraft = await store.saveAnswersDraft(operationId, [VALID_ANSWERS[0]]);
    expectOk(redraft);
    assert.equal(redraft.transaction.transitions.length, draft.transaction.transitions.length);

    const answerIdempotencyId = allocateHex128IdV1();
    const submitted = await store.submitAnswers(operationId, VALID_ANSWERS, answerIdempotencyId);
    expectOk(submitted);
    assert.equal(submitted.transaction.state, "answersSubmitted");
    assert.equal(submitted.transaction.answerIdempotencyId, answerIdempotencyId);

    const resumeIdempotencyId = allocateHex128IdV1();
    const scheduled = await store.scheduleResume(operationId, resumeIdempotencyId);
    expectOk(scheduled);
    assert.equal(scheduled.transaction.state, "resumeScheduled");

    // Durability: an entirely fresh store instance (fresh registry and file
    // store over the same root) reads the same record.
    const reopened = makeStore(tmpRoot);
    const reloaded = await reopened.load(operationId);
    expectOk(reloaded);
    assert.equal(reloaded.transaction.state, "resumeScheduled");
    assert.equal(reloaded.transaction.resumeIdempotencyId, resumeIdempotencyId);

    const newAttemptId = allocateHex128IdV1();
    const settled = await reopened.settleResumed(operationId, {
      kind: "sameOperation",
      newAttemptId,
    });
    expectOk(settled);
    assert.equal(settled.transaction.settlement, "resumed");
    assert.deepEqual(settled.transaction.resumeResolution, { kind: "sameOperation", newAttemptId });

    const receipts = settled.transaction.transitions;
    assert.deepEqual(
      receipts.map((r) => r.to),
      ["invocationPending", "questionsPosted", "answersDraft", "answersSubmitted", "resumeScheduled", "settled"]
    );
    assert.equal(receipts[0]!.from, null);
    for (let i = 1; i < receipts.length; i++) {
      assert.equal(receipts[i]!.from, receipts[i - 1]!.to);
    }
  });

  void it("treats only the identical idempotency id + answers as a duplicate no-op", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));
    const answerIdempotencyId = allocateHex128IdV1();
    expectOk(await store.submitAnswers(operationId, VALID_ANSWERS, answerIdempotencyId));

    const duplicate = await store.submitAnswers(operationId, VALID_ANSWERS, answerIdempotencyId);
    expectOk(duplicate);
    assert.equal(duplicate.duplicate, true);

    const differentAnswers = await store.submitAnswers(
      operationId,
      [
        { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "task" },
        { questionId: "notes", kind: "text", state: "skipped" },
      ],
      answerIdempotencyId
    );
    assert.equal(differentAnswers.kind, "rejected");

    const differentId = await store.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1());
    assert.equal(differentId.kind, "rejected");
  });

  void it("validates answers against the stored question set before writing through", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));

    const skippedRequired = await store.submitAnswers(
      operationId,
      [
        { questionId: "scope", kind: "singleChoice", state: "skipped" },
        { questionId: "notes", kind: "text", state: "skipped" },
      ],
      allocateHex128IdV1()
    );
    assert.equal(skippedRequired.kind, "rejected");

    const unknownProperty = await store.submitAnswers(
      operationId,
      [
        {
          questionId: "scope",
          kind: "singleChoice",
          state: "answered",
          selectedOptionId: "plan",
          extra: true,
        },
        { questionId: "notes", kind: "text", state: "skipped" },
      ],
      allocateHex128IdV1()
    );
    assert.equal(unknownProperty.kind, "rejected");

    // A failed submission left the record unchanged.
    const loaded = await store.load(operationId);
    expectOk(loaded);
    assert.equal(loaded.transaction.state, "questionsPosted");
  });

  void it("rejects a second Resume of the same interaction (plan §3.1)", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));
    expectOk(await store.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1()));
    const resumeIdempotencyId = allocateHex128IdV1();
    expectOk(await store.scheduleResume(operationId, resumeIdempotencyId));

    const sameIdAgain = await store.scheduleResume(operationId, resumeIdempotencyId);
    expectOk(sameIdAgain);
    assert.equal(sameIdAgain.duplicate, true);

    const differentId = await store.scheduleResume(operationId, allocateHex128IdV1());
    assert.equal(differentId.kind, "rejected");

    expectOk(
      await store.settleResumed(operationId, {
        kind: "sameOperation",
        newAttemptId: allocateHex128IdV1(),
      })
    );

    const afterSettlement = await store.scheduleResume(operationId, allocateHex128IdV1());
    assert.equal(afterSettlement.kind, "rejected");
    const secondSettle = await store.settleResumed(operationId, {
      kind: "sameOperation",
      newAttemptId: allocateHex128IdV1(),
    });
    assert.equal(secondSettle.kind, "rejected");
  });

  void it("enforces the declared Resume semantics and identity distinctness", async () => {
    const sameOp = beginInput();
    expectOk(await store.begin(sameOp));
    expectOk(await store.submitAnswers(sameOp.correlation.operationId, VALID_ANSWERS, allocateHex128IdV1()));
    expectOk(await store.scheduleResume(sameOp.correlation.operationId, allocateHex128IdV1()));

    const wrongKind = await store.settleResumed(sameOp.correlation.operationId, {
      kind: "replacementOperation",
      replacementOperationId: allocateHex128IdV1(),
    });
    assert.equal(wrongKind.kind, "rejected");

    const reusedAttempt = await store.settleResumed(sameOp.correlation.operationId, {
      kind: "sameOperation",
      newAttemptId: sameOp.correlation.attemptId,
    });
    assert.equal(reusedAttempt.kind, "rejected");

    const replacement = beginInput({
      correlation: correlation("commitPushMetadata.v1"),
      resumeSemantics: "replacementOperation",
    });
    expectOk(await store.begin(replacement));
    expectOk(
      await store.submitAnswers(replacement.correlation.operationId, VALID_ANSWERS, allocateHex128IdV1())
    );
    expectOk(await store.scheduleResume(replacement.correlation.operationId, allocateHex128IdV1()));
    const superseded = await store.settleResumed(replacement.correlation.operationId, {
      kind: "replacementOperation",
      replacementOperationId: allocateHex128IdV1(),
    });
    expectOk(superseded);
    assert.equal(superseded.transaction.settlement, "supersededByReplacementOperation");
  });

  void it("claims the resume invocation exactly once (plan §3.1 / AC-RUNNER-03)", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));

    // Too early: no settled Resume resolution exists yet.
    const tooEarly = await store.claimResumeInvocation(operationId);
    assert.equal(tooEarly.kind, "rejected");

    expectOk(await store.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1()));
    expectOk(await store.scheduleResume(operationId, allocateHex128IdV1()));
    const newAttemptId = allocateHex128IdV1();
    expectOk(await store.settleResumed(operationId, { kind: "sameOperation", newAttemptId }));

    const first = await store.claimResumeInvocation(operationId);
    expectOk(first);
    assert.equal(first.duplicate, undefined);
    assert.ok(typeof first.transaction.resumeInvocationClaimedAt === "string");

    // A second claim over the SAME store instance is a deterministic
    // duplicate, never a second live claim.
    const second = await store.claimResumeInvocation(operationId);
    expectOk(second);
    assert.equal(second.duplicate, true);
    assert.equal(second.transaction.resumeInvocationClaimedAt, first.transaction.resumeInvocationClaimedAt);

    // Durable across a fresh store instance over the same root: a
    // crash-and-restart replay sees the claim without racing anything.
    const reopened = makeStore(tmpRoot);
    const afterRestart = await reopened.claimResumeInvocation(operationId);
    expectOk(afterRestart);
    assert.equal(afterRestart.duplicate, true);
  });

  void it("records a resume invocation outcome exactly once, only after the claim (plan §3.1 / AC-RUNNER-03)", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));
    expectOk(await store.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1()));
    expectOk(await store.scheduleResume(operationId, allocateHex128IdV1()));
    const newAttemptId = allocateHex128IdV1();
    expectOk(await store.settleResumed(operationId, { kind: "sameOperation", newAttemptId }));

    const outcome = {
      kind: "completed" as const,
      correlation: { ...input.correlation, attemptId: newAttemptId },
      code: "completed" as const,
    };

    // Too early: not yet claimed.
    const tooEarly = await store.recordResumeInvocationOutcome(operationId, outcome);
    assert.equal(tooEarly.kind, "rejected");

    expectOk(await store.claimResumeInvocation(operationId));

    const first = await store.recordResumeInvocationOutcome(operationId, outcome);
    expectOk(first);
    assert.equal(first.duplicate, undefined);
    assert.deepEqual(first.transaction.resumeInvocationOutcome, outcome);

    // A second report — even with different content — never overwrites the
    // first recorded outcome (only the first is ever authoritative).
    const different = {
      kind: "failed" as const,
      correlation: outcome.correlation,
      code: "someOtherFailure",
      retryable: true,
    };
    const second = await store.recordResumeInvocationOutcome(operationId, different);
    expectOk(second);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.transaction.resumeInvocationOutcome, outcome);

    // Durable across a fresh store instance.
    const reopened = makeStore(tmpRoot);
    const reloaded = await reopened.load(operationId);
    expectOk(reloaded);
    assert.deepEqual(reloaded.transaction.resumeInvocationOutcome, outcome);
  });

  void it("resolves a genuinely concurrent claim race across two store instances to exactly one winner", async () => {
    const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-tx-claim-race-"));
    try {
      const storeA = makeStore(raceRoot);
      const storeB = makeStore(raceRoot);
      const input = beginInput();
      const operationId = input.correlation.operationId;
      expectOk(await storeA.begin(input));
      expectOk(await storeA.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1()));
      expectOk(await storeA.scheduleResume(operationId, allocateHex128IdV1()));
      expectOk(
        await storeA.settleResumed(operationId, {
          kind: "sameOperation",
          newAttemptId: allocateHex128IdV1(),
        })
      );

      // Two SEPARATE store instances (distinct in-process mutation queues,
      // the same durable file) racing the same claim — the shape of two
      // extension-host windows replaying the same crashed Resume.
      const [resultA, resultB] = await Promise.all([
        storeA.claimResumeInvocation(operationId),
        storeB.claimResumeInvocation(operationId),
      ]);
      expectOk(resultA);
      expectOk(resultB);
      // The exclusive-create marker is the strict guarantee: exactly one
      // side wins. The settled record's `resumeInvocationClaimedAt` mirror
      // is only best-effort/eventually-consistent (module header,
      // "INVOCATION-ONCE CLAIM") — the loser can legitimately observe the
      // record from before the winner's mirror write lands, so the two
      // sides' returned `transaction` snapshots are NOT asserted to agree.
      const duplicates = [resultA.duplicate === true, resultB.duplicate === true];
      assert.deepEqual(duplicates.filter(Boolean).length, 1, "exactly one side must observe a duplicate");

      // A later, settled read confirms the mirror converges.
      const reloaded = await makeStore(raceRoot).load(operationId);
      expectOk(reloaded);
      assert.ok(typeof reloaded.transaction.resumeInvocationClaimedAt === "string");
    } finally {
      fs.rmSync(raceRoot, { recursive: true, force: true });
    }
  });

  void it("settles cancel/expire/reset exactly once, from any unsettled state", async () => {
    const cancelled = beginInput();
    expectOk(await store.begin(cancelled));
    const cancelResult = await store.cancel(cancelled.correlation.operationId);
    expectOk(cancelResult);
    assert.equal(cancelResult.transaction.settlement, "cancelled");
    assert.equal((await store.cancel(cancelled.correlation.operationId)).kind, "rejected");
    assert.equal((await store.expire(cancelled.correlation.operationId)).kind, "rejected");

    const reset = beginInput();
    expectOk(await store.begin(reset));
    expectOk(await store.saveAnswersDraft(reset.correlation.operationId, [VALID_ANSWERS[0]]));
    const resetResult = await store.settleByChatRecovery(reset.correlation.operationId);
    expectOk(resetResult);
    assert.equal(resetResult.transaction.settlement, "resetByChatRecovery");
  });

  void it("surfaces a corrupt record as recoveryRequired (AC-CHAT-TX-03)", async () => {
    const input = beginInput();
    const operationId = input.correlation.operationId;
    expectOk(await store.begin(input));
    fs.writeFileSync(recordPath(tmpRoot, operationId), "{not json", "utf8");
    assert.equal((await store.load(operationId)).kind, "recoveryRequired");
    assert.equal((await store.cancel(operationId)).kind, "recoveryRequired");

    // A decodable record whose identity does not match its directory is also
    // recovery, not silently accepted.
    const other = beginInput();
    expectOk(await store.begin(other));
    fs.copyFileSync(
      recordPath(tmpRoot, other.correlation.operationId),
      recordPath(tmpRoot, operationId)
    );
    assert.equal((await store.load(operationId)).kind, "recoveryRequired");
  });

  void it("reports missing records distinctly", async () => {
    assert.equal((await store.load(allocateHex128IdV1())).kind, "missing");
    assert.equal((await store.cancel(allocateHex128IdV1())).kind, "missing");
    assert.equal((await store.load("not-an-operation-id")).kind, "rejected");
  });

  void it("sweeps per the retention policy: unresolved expire, settled are removed", async () => {
    const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-tx-sweep-"));
    try {
      let clock = new Date("2026-07-01T00:00:00.000Z");
      const sweepStore = makeStore(sweepRoot, () => clock);

      const unresolved = beginInput();
      expectOk(await sweepStore.begin(unresolved));
      const settledInput = beginInput();
      expectOk(await sweepStore.begin(settledInput));
      expectOk(await sweepStore.cancel(settledInput.correlation.operationId));
      const fresh = beginInput();

      // Advance past expiry, then add one fresh record that must survive.
      clock = new Date("2026-07-03T00:00:00.000Z");
      expectOk(await sweepStore.begin(fresh));

      const swept = await sweepStore.sweepExpired();
      assert.deepEqual(swept, { expired: 1, removed: 1 });

      const expiredRecord = await sweepStore.load(unresolved.correlation.operationId);
      expectOk(expiredRecord);
      assert.equal(expiredRecord.transaction.settlement, "expired");
      assert.equal((await sweepStore.load(settledInput.correlation.operationId)).kind, "missing");
      const freshRecord = await sweepStore.load(fresh.correlation.operationId);
      expectOk(freshRecord);
      assert.equal(freshRecord.transaction.state, "questionsPosted");
    } finally {
      fs.rmSync(sweepRoot, { recursive: true, force: true });
    }
  });

  void it("removes a settled record's resume-invocation claim marker too, so its directory is fully reclaimed", async () => {
    const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-tx-sweep-claim-"));
    try {
      let clock = new Date("2026-07-01T00:00:00.000Z");
      const sweepStore = makeStore(sweepRoot, () => clock);

      const claimed = beginInput();
      const operationId = claimed.correlation.operationId;
      expectOk(await sweepStore.begin(claimed));
      expectOk(await sweepStore.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1()));
      expectOk(await sweepStore.scheduleResume(operationId, allocateHex128IdV1()));
      expectOk(
        await sweepStore.settleResumed(operationId, {
          kind: "sameOperation",
          newAttemptId: allocateHex128IdV1(),
        })
      );
      const claim = await sweepStore.claimResumeInvocation(operationId);
      expectOk(claim);
      assert.equal(claim.duplicate, undefined);
      assert.ok(fs.existsSync(claimMarkerPath(sweepRoot, operationId)));

      // Advance past expiry.
      clock = new Date("2026-07-03T00:00:00.000Z");
      const swept = await sweepStore.sweepExpired();
      assert.deepEqual(swept, { expired: 0, removed: 1 });

      // The record, the claim marker, AND the operation directory itself
      // must all be gone -- a leftover marker would otherwise wedge
      // `deleteEmptyDirectory` forever while still (wrongly) counting as
      // removed.
      assert.equal((await sweepStore.load(operationId)).kind, "missing");
      assert.equal(fs.existsSync(recordPath(sweepRoot, operationId)), false);
      assert.equal(fs.existsSync(claimMarkerPath(sweepRoot, operationId)), false);
      assert.equal(fs.existsSync(operationDirPath(sweepRoot, operationId)), false);

      // A second sweep finds nothing left to do for this operation.
      const secondSweep = await sweepStore.sweepExpired();
      assert.deepEqual(secondSweep, { expired: 0, removed: 0 });
    } finally {
      fs.rmSync(sweepRoot, { recursive: true, force: true });
    }
  });

  void it("recovers a settled removal interrupted between clearing the claim marker and deleting the record", async () => {
    // The marker is cleared BEFORE the transaction record (plan §3.1 /
    // AC-RUNNER-03's cleanup ordering): if the process dies in between, the
    // record is still present and the marker is already gone — reproduced
    // here by deleting the marker directly (bypassing the store) instead of
    // driving the interruption through sweepExpired itself. A crash in the
    // OTHER order (record gone, marker left behind) is exactly what the
    // fixed ordering makes impossible, and is covered by the preceding test.
    const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-tx-sweep-interrupt-"));
    try {
      let clock = new Date("2026-07-01T00:00:00.000Z");
      const sweepStore = makeStore(sweepRoot, () => clock);

      const claimed = beginInput();
      const operationId = claimed.correlation.operationId;
      expectOk(await sweepStore.begin(claimed));
      expectOk(await sweepStore.submitAnswers(operationId, VALID_ANSWERS, allocateHex128IdV1()));
      expectOk(await sweepStore.scheduleResume(operationId, allocateHex128IdV1()));
      expectOk(
        await sweepStore.settleResumed(operationId, {
          kind: "sameOperation",
          newAttemptId: allocateHex128IdV1(),
        })
      );
      expectOk(await sweepStore.claimResumeInvocation(operationId));
      assert.ok(fs.existsSync(claimMarkerPath(sweepRoot, operationId)));

      clock = new Date("2026-07-03T00:00:00.000Z");

      // Simulate the interruption: the marker is already gone, but the
      // transaction record is still present (as it would be if the process
      // died immediately after the marker deletion landed but before the
      // record's).
      fs.rmSync(claimMarkerPath(sweepRoot, operationId));
      assert.equal(fs.existsSync(recordPath(sweepRoot, operationId)), true);

      // The next sweep must finish the removal in this round: the transaction
      // record it can still read is what makes the (already-absent) marker
      // discoverable as "nothing left to clear", so it proceeds straight to
      // deleting the record and reclaiming the directory rather than getting
      // stuck (the old ordering would have deleted the record FIRST, so this
      // exact interruption would instead have left an unreadable, undeletable
      // marker-only directory with no transaction left to point back to it).
      const swept = await sweepStore.sweepExpired();
      assert.deepEqual(swept, { expired: 0, removed: 1 });
      assert.equal(fs.existsSync(recordPath(sweepRoot, operationId)), false);
      assert.equal(fs.existsSync(operationDirPath(sweepRoot, operationId)), false);
    } finally {
      fs.rmSync(sweepRoot, { recursive: true, force: true });
    }
  });

  void it("rejects content the strict decoder could never re-read", async () => {
    const oversizedInput = beginInput({ validatedInput: { blob: "x".repeat(300 * 1024) } });
    const oversized = await store.begin(oversizedInput);
    assert.equal(oversized.kind, "rejected");
    // Item 9 (Part 16 step 43): this specific rejection must be recognizable
    // by isInputSnapshotSizeRejectionReasonV1 so the coordinator can report
    // it non-retryable — an unchanged prompt cannot decode differently.
    if (oversized.kind === "rejected") {
      assert.equal(isInputSnapshotSizeRejectionReasonV1(oversized.reason), true);
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicResult = await store.begin(beginInput({ validatedInput: cyclic }));
    assert.equal(cyclicResult.kind, "rejected");
    // A non-size rejection must NOT be misclassified as the deterministic
    // size limit — that would wrongly mark a possibly-retryable failure
    // non-retryable.
    if (cyclicResult.kind === "rejected") {
      assert.equal(isInputSnapshotSizeRejectionReasonV1(cyclicResult.reason), false);
    }

    assert.equal((await store.begin(beginInput({ questions: [] }))).kind, "rejected");
  });
});

// ---------------------------------------------------------------------------
// isInputSnapshotSizeRejectionReasonV1 (item 9 — Part 16 step 43)
// ---------------------------------------------------------------------------

void describe("isInputSnapshotSizeRejectionReasonV1", () => {
  void it("recognizes the exact message decodeInputSnapshot produces", () => {
    assert.equal(
      isInputSnapshotSizeRejectionReasonV1(
        "inputSnapshot exceeds the 262144-byte canonical limit"
      ),
      true
    );
  });

  void it("recognizes the message even wrapped with an outer decode-failure prefix", () => {
    assert.equal(
      isInputSnapshotSizeRejectionReasonV1(
        "transaction record would not decode: inputSnapshot exceeds the 262144-byte canonical limit"
      ),
      true
    );
  });

  void it("does not recognize an unrelated rejection reason", () => {
    assert.equal(
      isInputSnapshotSizeRejectionReasonV1("inputSnapshot \"canonicalJson\" is not valid JSON"),
      false
    );
    assert.equal(
      isInputSnapshotSizeRejectionReasonV1("correlation tuple does not match"),
      false
    );
  });
});
