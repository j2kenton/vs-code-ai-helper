/**
 * Regenerate the checked-in Chat interaction transaction fixtures
 * (test-fixtures/chat-transactions/, plan §5.5) from the COMPILED runtime
 * type module, so every digest and canonical form in a fixture is the real
 * production computation — never a hand-copied value that could drift.
 *
 * Usage:
 *   pnpm run generate:chat-transaction-fixtures   (compiles tests first)
 *
 * Valid fixtures cover every §5.5 state; invalid fixtures are targeted
 * mutations of valid records (unknown field, missing settlement, semantics
 * mismatch, broken receipt chain, digest mismatch, missing idempotency,
 * non-canonical snapshot, post-settlement transition, a Resume settlement
 * whose chain skipped resumeScheduled, and a resumeIdempotencyId without a
 * resumeScheduled receipt). The script self-checks
 * that every `valid-*` fixture decodes and every `invalid-*` fixture rejects
 * before writing is considered successful;
 * src/test/chatInteractionTransactionStoreV1.test.ts pins the same
 * expectations at test time.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const COMPILED_TX_RELATIVE = "out/types/chatInteractionTransactionV1.js";
const COMPILED_SQ_RELATIVE = "out/types/structuredQuestionV1.js";

for (const relative of [COMPILED_TX_RELATIVE, COMPILED_SQ_RELATIVE]) {
  if (!fs.existsSync(path.join(repoRoot, relative))) {
    console.error(
      `${relative} is missing — run "pnpm run generate:chat-transaction-fixtures", which compiles tsconfig.test.json first.`
    );
    process.exit(1);
  }
}

const tx = requireCjs(path.join(repoRoot, COMPILED_TX_RELATIVE));
const sq = requireCjs(path.join(repoRoot, COMPILED_SQ_RELATIVE));

const outDir = path.join(repoRoot, "test-fixtures", "chat-transactions");
fs.mkdirSync(outDir, { recursive: true });

const QUESTIONS = [
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

const SUBMITTED_ANSWERS = [
  { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" },
  { questionId: "notes", kind: "text", state: "skipped" },
];

const DRAFT_ANSWERS = [
  { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" },
];

const INPUT = { stage: "plan", targetArtifact: "plan.md", advisoryRevision: "v1:120:99:7" };
const inputCanonical = sq.canonicalJsonTextV1(INPUT);

const ids = {
  operationId: "0f2b6c1d8a934e7fb5c2d90e814a3f66",
  sourceAttemptId: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
  interactionId: "9e8d7c6b5a493827161504f3e2d1c0b9",
  answerIdempotencyId: "aaaabbbbccccddddeeeeffff00001111",
  resumeIdempotencyId: "22223333444455556666777788889999",
  newAttemptId: "abcdefabcdefabcdefabcdefabcdef01",
  replacementOperationId: "fedcbafedcbafedcbafedcbafedcba02",
};

const RECEIPTS = {
  created: "01010101010101010101010101010101",
  draft: "02020202020202020202020202020202",
  submitted: "03030303030303030303030303030303",
  scheduled: "04040404040404040404040404040404",
  settled: "05050505050505050505050505050505",
};

const receipt = (receiptId, from, to, at) => ({ receiptId, from, to, at });

function base(overrides) {
  return {
    schemaVersion: 1,
    actionKey: "generatePlan.v1",
    operationId: ids.operationId,
    sourceAttemptId: ids.sourceAttemptId,
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
    interactionId: ids.interactionId,
    stage: "impl",
    resumeSemantics: "sameOperation",
    inputSnapshot: {
      canonicalJson: inputCanonical,
      sha256: tx.computeChatTransactionInputSha256V1(inputCanonical),
    },
    promptContract: {
      contractId: "ensemble-ai-result-contract",
      contractVersion: 1,
      promptInputSha256: "d".repeat(64),
    },
    questions: QUESTIONS,
    questionSetSha256: tx.computeChatTransactionQuestionSetSha256V1(QUESTIONS),
    ...overrides,
  };
}

const T0 = "2026-07-26T10:00:00.000Z";
const T1 = "2026-07-26T10:05:00.000Z";
const T2 = "2026-07-26T10:10:00.000Z";
const T3 = "2026-07-26T10:15:00.000Z";
const T4 = "2026-07-26T10:20:00.000Z";

const answersDigest = tx.computeChatTransactionAnswersSha256V1(SUBMITTED_ANSWERS);

const fixtures = {
  "valid-questions-posted.json": base({
    state: "questionsPosted",
    transitions: [receipt(RECEIPTS.created, null, "questionsPosted", T0)],
  }),
  "valid-answers-draft.json": base({
    answers: DRAFT_ANSWERS,
    state: "answersDraft",
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.draft, "questionsPosted", "answersDraft", T1),
    ],
  }),
  "valid-answers-submitted.json": base({
    answers: SUBMITTED_ANSWERS,
    answerIdempotencyId: ids.answerIdempotencyId,
    answersSha256: answersDigest,
    state: "answersSubmitted",
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.draft, "questionsPosted", "answersDraft", T1),
      receipt(RECEIPTS.submitted, "answersDraft", "answersSubmitted", T2),
    ],
  }),
  "valid-resume-scheduled.json": base({
    answers: SUBMITTED_ANSWERS,
    answerIdempotencyId: ids.answerIdempotencyId,
    answersSha256: answersDigest,
    resumeIdempotencyId: ids.resumeIdempotencyId,
    state: "resumeScheduled",
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.draft, "questionsPosted", "answersDraft", T1),
      receipt(RECEIPTS.submitted, "answersDraft", "answersSubmitted", T2),
      receipt(RECEIPTS.scheduled, "answersSubmitted", "resumeScheduled", T3),
    ],
  }),
  "valid-settled-resumed.json": base({
    answers: SUBMITTED_ANSWERS,
    answerIdempotencyId: ids.answerIdempotencyId,
    answersSha256: answersDigest,
    resumeIdempotencyId: ids.resumeIdempotencyId,
    state: "settled",
    settlement: "resumed",
    resumeResolution: { kind: "sameOperation", newAttemptId: ids.newAttemptId },
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.draft, "questionsPosted", "answersDraft", T1),
      receipt(RECEIPTS.submitted, "answersDraft", "answersSubmitted", T2),
      receipt(RECEIPTS.scheduled, "answersSubmitted", "resumeScheduled", T3),
      receipt(RECEIPTS.settled, "resumeScheduled", "settled", T4),
    ],
  }),
  "valid-settled-superseded.json": base({
    resumeSemantics: "replacementOperation",
    actionKey: "commitPushMetadata.v1",
    answers: SUBMITTED_ANSWERS,
    answerIdempotencyId: ids.answerIdempotencyId,
    answersSha256: answersDigest,
    resumeIdempotencyId: ids.resumeIdempotencyId,
    state: "settled",
    settlement: "supersededByReplacementOperation",
    resumeResolution: {
      kind: "replacementOperation",
      replacementOperationId: ids.replacementOperationId,
    },
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.submitted, "questionsPosted", "answersSubmitted", T2),
      receipt(RECEIPTS.scheduled, "answersSubmitted", "resumeScheduled", T3),
      receipt(RECEIPTS.settled, "resumeScheduled", "settled", T4),
    ],
  }),
  "valid-settled-cancelled.json": base({
    state: "settled",
    settlement: "cancelled",
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.settled, "questionsPosted", "settled", T1),
    ],
  }),
  "valid-settled-resumed-invocation-claimed.json": base({
    answers: SUBMITTED_ANSWERS,
    answerIdempotencyId: ids.answerIdempotencyId,
    answersSha256: answersDigest,
    resumeIdempotencyId: ids.resumeIdempotencyId,
    state: "settled",
    settlement: "resumed",
    resumeResolution: { kind: "sameOperation", newAttemptId: ids.newAttemptId },
    // AC-RUNNER-03: the durable invocation-once claim, set strictly after
    // the resumeResolution settles, immediately before the coordinator
    // invokes the provider (src/services/chatInteractionTransactionStoreV1.ts
    // "claimResumeInvocation").
    resumeInvocationClaimedAt: T4,
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.draft, "questionsPosted", "answersDraft", T1),
      receipt(RECEIPTS.submitted, "answersDraft", "answersSubmitted", T2),
      receipt(RECEIPTS.scheduled, "answersSubmitted", "resumeScheduled", T3),
      receipt(RECEIPTS.settled, "resumeScheduled", "settled", T4),
    ],
  }),
  "valid-settled-resumed-invocation-outcome-recorded.json": base({
    answers: SUBMITTED_ANSWERS,
    answerIdempotencyId: ids.answerIdempotencyId,
    answersSha256: answersDigest,
    resumeIdempotencyId: ids.resumeIdempotencyId,
    state: "settled",
    settlement: "resumed",
    resumeResolution: { kind: "sameOperation", newAttemptId: ids.newAttemptId },
    resumeInvocationClaimedAt: T4,
    // AC-RUNNER-03 "recover the claimed terminal result": once the claimed
    // invocation actually ran to completion, its exact TaskActionOutcomeV1
    // is durably mirrored here (recordResumeInvocationOutcome) so a later
    // replay recovers it instead of failing closed forever.
    resumeInvocationOutcome: {
      kind: "completed",
      correlation: {
        actionKey: "generatePlan.v1",
        operationId: ids.operationId,
        attemptId: ids.newAttemptId,
        taskBindingId: "task-binding-digest",
        chatDocumentId: "chat-document-id",
      },
      code: "completed",
    },
    transitions: [
      receipt(RECEIPTS.created, null, "questionsPosted", T0),
      receipt(RECEIPTS.draft, "questionsPosted", "answersDraft", T1),
      receipt(RECEIPTS.submitted, "answersDraft", "answersSubmitted", T2),
      receipt(RECEIPTS.scheduled, "answersSubmitted", "resumeScheduled", T3),
      receipt(RECEIPTS.settled, "resumeScheduled", "settled", T4),
    ],
  }),
};

const clone = (value) => JSON.parse(JSON.stringify(value));

let f = clone(fixtures["valid-questions-posted.json"]);
f.unexpectedField = true;
fixtures["invalid-unknown-field.json"] = f;

f = clone(fixtures["valid-settled-cancelled.json"]);
delete f.settlement;
fixtures["invalid-settled-without-settlement.json"] = f;

f = clone(fixtures["valid-settled-resumed.json"]);
f.resumeSemantics = "replacementOperation";
fixtures["invalid-resume-semantics-mismatch.json"] = f;

f = clone(fixtures["valid-answers-submitted.json"]);
f.transitions.splice(1, 1); // drop the draft receipt: the chain breaks
fixtures["invalid-broken-transition-chain.json"] = f;

f = clone(fixtures["valid-questions-posted.json"]);
f.questionSetSha256 = "0".repeat(64);
fixtures["invalid-question-digest-mismatch.json"] = f;

f = clone(fixtures["valid-answers-submitted.json"]);
delete f.answerIdempotencyId;
delete f.answersSha256;
fixtures["invalid-answers-without-idempotency.json"] = f;

f = clone(fixtures["valid-questions-posted.json"]);
// Non-canonical snapshot: same data, keys deliberately unsorted; the digest
// is correct for the bytes so ONLY canonical-form verification can reject it.
const noncanonical = JSON.stringify({
  targetArtifact: "plan.md",
  stage: "plan",
  advisoryRevision: "v1:120:99:7",
});
f.inputSnapshot = {
  canonicalJson: noncanonical,
  sha256: tx.computeChatTransactionInputSha256V1(noncanonical),
};
fixtures["invalid-noncanonical-input-snapshot.json"] = f;

f = clone(fixtures["valid-settled-cancelled.json"]);
f.transitions.push(receipt("06060606060606060606060606060606", "settled", "questionsPosted", T2));
f.state = "questionsPosted";
delete f.settlement;
fixtures["invalid-transition-after-settlement.json"] = f;

// Review blocker (omitted-scheduling): a forged "resumed" settlement whose
// receipt chain never entered resumeScheduled. Every edge is individually
// legal (questionsPosted → answersSubmitted → settled) and both idempotency
// ids plus the resolution are present, so ONLY the settlement-chain rule
// ("a Resume settlement must settle from a resumeScheduled receipt") can
// reject it.
f = clone(fixtures["valid-settled-resumed.json"]);
f.transitions = [
  receipt(RECEIPTS.created, null, "questionsPosted", T0),
  receipt(RECEIPTS.submitted, "questionsPosted", "answersSubmitted", T2),
  receipt(RECEIPTS.settled, "answersSubmitted", "settled", T4),
];
fixtures["invalid-resumed-without-scheduled-receipt.json"] = f;

// A resumeIdempotencyId on a record whose chain never entered
// resumeScheduled (here: cancelled straight from answersSubmitted) — the id
// exists exactly when a Resume was actually scheduled.
f = clone(fixtures["valid-settled-resumed.json"]);
f.settlement = "cancelled";
delete f.resumeResolution;
f.transitions = [
  receipt(RECEIPTS.created, null, "questionsPosted", T0),
  receipt(RECEIPTS.submitted, "questionsPosted", "answersSubmitted", T2),
  receipt(RECEIPTS.settled, "answersSubmitted", "settled", T4),
];
fixtures["invalid-resume-id-without-scheduled-receipt.json"] = f;

// AC-RUNNER-03: a resumeInvocationClaimedAt claim is legal only alongside a
// settled resumeResolution — here it is forged onto a "cancelled" settlement
// (cancel/expire/reset never invoke a provider, so no claim can exist).
f = clone(fixtures["valid-settled-cancelled.json"]);
f.resumeInvocationClaimedAt = T2;
fixtures["invalid-invocation-claim-without-resolution.json"] = f;

// AC-RUNNER-03 "recover the claimed terminal result": a resumeInvocationOutcome
// can only exist for an invocation that was actually claimed — here it is
// forged onto a resumed settlement with no resumeInvocationClaimedAt at all.
f = clone(fixtures["valid-settled-resumed.json"]);
f.resumeInvocationOutcome = {
  kind: "completed",
  correlation: {
    actionKey: "generatePlan.v1",
    operationId: ids.operationId,
    attemptId: ids.newAttemptId,
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  },
  code: "completed",
};
fixtures["invalid-invocation-outcome-without-claim.json"] = f;

// AC-RUNNER-03 correlation binding: a resumeInvocationOutcome must be bound
// to THIS interaction's action/operation/task/document — here it is forged
// with a foreign operationId (the resolution's own recorded newAttemptId is
// otherwise correct), so only the correlation-binding check can reject it.
f = clone(fixtures["valid-settled-resumed-invocation-outcome-recorded.json"]);
f.resumeInvocationOutcome = {
  kind: "completed",
  correlation: {
    actionKey: "generatePlan.v1",
    operationId: "f".repeat(32),
    attemptId: ids.newAttemptId,
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  },
  code: "completed",
};
fixtures["invalid-invocation-outcome-correlation-mismatch.json"] = f;

// AC-RUNNER-03 correlation binding: a persisted resumeInvocationOutcome must
// ALWAYS carry a correlation tuple (the coordinator normalizes one onto every
// recorded outcome) — a correlation-free record can never be semantically
// bound to this interaction, so it must reject rather than be recoverable as
// authoritative recovery data.
f = clone(fixtures["valid-settled-resumed-invocation-outcome-recorded.json"]);
f.resumeInvocationOutcome = {
  kind: "unavailable",
  code: "providerModeUnavailable",
};
fixtures["invalid-invocation-outcome-correlation-missing.json"] = f;

let wrote = 0;
for (const [name, value] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
  wrote++;
}

let failures = 0;
for (const name of Object.keys(fixtures)) {
  const raw = JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8"));
  const result = tx.decodeChatInteractionTransactionV1(raw);
  const expectOk = name.startsWith("valid-");
  if (result.ok !== expectOk) {
    console.error(`self-check mismatch ${name}: ok=${result.ok} reason=${result.reason ?? ""}`);
    failures++;
  }
}
console.log(`wrote ${wrote} chat-transaction fixtures; self-check failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
