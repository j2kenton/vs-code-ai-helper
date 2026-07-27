/**
 * Chat interaction transaction record (plan §5.5, Chat cohort /
 * executable-order step 8).
 *
 * Every question-returning operation persists exactly one of these records at
 * `chat-transactions/<operation-id>/transaction-v1.json` under registered
 * private storage (plan §2.1 — the family is Chat-private per §2.2). The
 * record is what makes explicit Resume reconstructible: it carries the full
 * question-time correlation, the registry row's declared Resume semantics,
 * the validated original action input snapshot in canonical JSON with its
 * digest, the prompt-contract identity, the canonical question set and its
 * digest, per-question answer records with the answer-submission idempotency
 * id, and the current state plus journaled transition receipts.
 *
 * State machine (plan §5.5, verbatim):
 *
 *   questionsPosted → answersDraft → answersSubmitted → resumeScheduled → settled
 *
 * with exactly one terminal settlement per record: `resumed`, `cancelled`,
 * `supersededByReplacementOperation`, `expired`, or `resetByChatRecovery`.
 * `answersDraft` and the direct questionsPosted → answersSubmitted edge are
 * both legal (a draft save is optional); a draft re-save updates the record
 * in place without a new receipt, so the journal records state CHANGES and
 * stays bounded. Settling early (cancel/expire/reset) is legal from any
 * unsettled state, but a Resume settlement (`resumed` /
 * `supersededByReplacementOperation`) must settle from a `resumeScheduled`
 * receipt — the journaled chain, not the settlement label, proves the record
 * actually traversed answersSubmitted → resumeScheduled → settled.
 *
 * This module owns the persisted shape: the closed record type, the strict
 * fail-closed decoder (unknown fields, digest mismatches, non-canonical
 * snapshots, illegal transition chains, and state/field inconsistencies all
 * reject), and the canonical encoder the store writes with. The durable
 * store itself is `src/services/chatInteractionTransactionStoreV1.ts`; the
 * checked-in JSON Schema evidence is
 * workflow-inventories/schemas/chat-interaction-transaction-v1.schema.json
 * with fixtures under test-fixtures/chat-transactions/.
 *
 * INVOCATION-ONCE CLAIM — a settled Resume resolution (`resumed` /
 * `supersededByReplacementOperation`) is idempotently replayable by the
 * identical Resume idempotency id (crash recovery), but the provider
 * invocation it drives must never run twice (plan §3.1 / AC-RUNNER-03). The
 * TRUE atomic gate for that is an exclusive-create marker file
 * (`resume-invocation-claim-v1.json`, see
 * `CHAT_TRANSACTION_RESUME_INVOCATION_CLAIM_FILENAME_V1`) sibling to this
 * record — the same primitive `begin()` uses for AC-CHAT-TX-01. This
 * record's own `resumeInvocationClaimedAt` is a best-effort MIRROR of that
 * marker's timestamp, written once by whichever caller wins it, for
 * observability only — code deciding whether it is safe to invoke the
 * provider must consult the marker (via
 * `chatInteractionTransactionStoreV1.ts`'s `claimResumeInvocation`), not
 * this field. Legal only on a record settled with a `resumeResolution`; a
 * cancelled, expired, or reset-by-recovery settlement never carries it,
 * because those settlements never invoke a provider.
 *
 * RECOVERABLE TERMINAL OUTCOME — a claim alone only tells a later replay
 * "do not invoke again"; it cannot tell "not started" (safe to become the
 * invoker) apart from "in flight or crashed with no result" (must fail
 * closed). `resumeInvocationOutcome` closes that gap: once the claimed
 * invocation actually runs to completion, the coordinator durably mirrors
 * its exact `TaskActionOutcomeV1` here (`recordResumeInvocationOutcome`).
 * A later replay that finds the claim already made now checks this field
 * first — present means "recover and return this exact result instead of
 * invoking the provider again"; absent (alongside a present
 * `resumeInvocationClaimedAt`) means the outcome is still unknown, and only
 * then does the replay fail closed. Legal only alongside
 * `resumeInvocationClaimedAt`, for the same reason: an outcome can only
 * exist for an invocation that was claimed. The decoder also REQUIRES the
 * persisted outcome to carry a correlation tuple — the coordinator
 * normalizes every recorded outcome to one (`taskActionCoordinatorV1.ts`),
 * so a correlation-free record is either legacy drift or corruption and can
 * never be semantically bound — and binds that correlation to this record's
 * actionKey/taskBindingId/chatDocumentId and to the operation id its
 * `resumeResolution` actually drives (the source operation for
 * `sameOperation`, the replacement operation for `replacementOperation`) —
 * a mismatched or unbindable outcome is rejected outright rather than ever
 * being recoverable as this interaction's authoritative result.
 */
import { createHash } from "crypto";
import { isHex128IdV1, ResumeSemanticsV1 } from "./actionCorrelationV1";
import { decodeTaskActionOutcomeV1, outcomeCorrelationV1, TaskActionOutcomeV1 } from "./taskActionOutcomeV1";
import { STAGE_ORDER, TaskStage } from "./taskProgress";
import {
  canonicalJsonByteLengthV1,
  canonicalJsonTextV1,
  CanonicalJsonErrorV1,
  decodeStructuredAnswersArrayV1,
  decodeStructuredQuestionsV1,
  MAX_QUESTION_SET_CANONICAL_BYTES_V1,
  STABLE_ID_PATTERN_V1,
  StructuredAnswerV1,
  StructuredQuestionV1,
  validateStructuredAnswersV1,
} from "./structuredQuestionV1";

/** The one file a transaction directory contains (plan §5.5). */
export const CHAT_TRANSACTION_FILENAME_V1 = "transaction-v1.json";

/**
 * The invocation-once claim's TRUE atomic gate (plan §3.1 / AC-RUNNER-03):
 * an exclusive-create marker sibling to `transaction-v1.json`, in the same
 * per-operation directory. Existence — not content — is authoritative;
 * `resumeInvocationClaimedAt` on the transaction record itself is a
 * best-effort mirror for observability, written once by whichever caller's
 * exclusive create of this file actually wins. See
 * `chatInteractionTransactionStoreV1.ts`'s `claimResumeInvocation`.
 */
export const CHAT_TRANSACTION_RESUME_INVOCATION_CLAIM_FILENAME_V1 = "resume-invocation-claim-v1.json";

/** Bounded read ceiling for a persisted transaction record. */
export const MAX_CHAT_TRANSACTION_FILE_BYTES_V1 = 1024 * 1024;

/** Bounded canonical size of the validated original action input snapshot. */
export const MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 = 256 * 1024;

/**
 * Journaled transition receipts are bounded because draft re-saves do not
 * append (see module header): the longest legal chain is
 * null → questionsPosted → answersDraft → answersSubmitted → resumeScheduled
 * → settled (5 receipts). 8 leaves headroom without permitting unbounded
 * growth.
 */
export const MAX_TRANSITION_RECEIPTS_V1 = 8;

export type ChatInteractionTransactionStateV1 =
  | "questionsPosted"
  | "answersDraft"
  | "answersSubmitted"
  | "resumeScheduled"
  | "settled";

/** §5.5's terminal settlements, verbatim. */
export type ChatInteractionSettlementV1 =
  | "resumed"
  | "cancelled"
  | "supersededByReplacementOperation"
  | "expired"
  | "resetByChatRecovery";

/**
 * One journaled state transition. The first receipt of every record has
 * `from: null` (record creation into `questionsPosted`); each later receipt
 * chains from its predecessor's `to`, and the final receipt's `to` is the
 * record's current state.
 */
export interface ChatTransactionTransitionReceiptV1 {
  /** 128-bit lowercase-hex receipt identity (plan §3.1's allocator). */
  readonly receiptId: string;
  readonly from: ChatInteractionTransactionStateV1 | null;
  readonly to: ChatInteractionTransactionStateV1;
  /** Store-clock ISO timestamp. */
  readonly at: string;
}

/**
 * The validated original action input snapshot (plan §5.5): the exact
 * post-validation input the coordinator needs to rebuild the action on
 * Resume, stored as canonical JSON text with its SHA-256. Chat-private.
 */
export interface ChatTransactionInputSnapshotV1 {
  readonly canonicalJson: string;
  readonly sha256: string;
}

/** The prompt-contract identity/version and prompt-input digest (plan §5.5). */
export interface ChatTransactionPromptContractV1 {
  readonly contractId: string;
  readonly contractVersion: number;
  readonly promptInputSha256: string;
}

/**
 * The §3.1 Resume idempotency linkage: the source interaction binds to
 * exactly one new attempt (`sameOperation`) or exactly one replacement
 * operation (`replacementOperation`). Present only on a record settled as
 * `resumed` or `supersededByReplacementOperation`.
 */
export type ChatTransactionResumeResolutionV1 =
  | { readonly kind: "sameOperation"; readonly newAttemptId: string }
  | { readonly kind: "replacementOperation"; readonly replacementOperationId: string };

export interface ChatInteractionTransactionV1 {
  readonly schemaVersion: 1;
  /** Question-time source correlation (plan §3.1). */
  readonly actionKey: string;
  readonly operationId: string;
  readonly sourceAttemptId: string;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly interactionId: string;
  /**
   * The stage this interaction's questions belong to (Chat is fully
   * stage-isolated — plan §5.1/§6.1). Required so a transaction can be
   * reconciled into a per-stage Chat view even when its task-local mirror
   * record is missing (AC-CHAT-TX-03's "transaction without a Chat record"
   * direction) — without it, an orphaned transaction has no stage to render
   * under and stays undiscoverable in every stage-scoped view.
   */
  readonly stage: TaskStage;
  /** The registry row's declared Resume semantics (plan §3.1 / AC-ID-04). */
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly inputSnapshot: ChatTransactionInputSnapshotV1;
  readonly promptContract: ChatTransactionPromptContractV1;
  readonly questions: readonly StructuredQuestionV1[];
  /** SHA-256 over the domain-prefixed canonical question-set JSON. */
  readonly questionSetSha256: string;
  /**
   * Present from `answersDraft` onward. In `answersDraft` (or a record
   * settled directly from a draft) the set may be partial; from
   * `answersSubmitted` onward it must fully validate against the question
   * set (§3.6).
   */
  readonly answers?: readonly StructuredAnswerV1[];
  /** Answer-submission idempotency id — present from `answersSubmitted`. */
  readonly answerIdempotencyId?: string;
  /** SHA-256 over the domain-prefixed canonical answers — present with `answerIdempotencyId`. */
  readonly answersSha256?: string;
  /** Resume idempotency id — present from `resumeScheduled`. */
  readonly resumeIdempotencyId?: string;
  readonly state: ChatInteractionTransactionStateV1;
  /** Present exactly when `state` is `settled` (one terminal settlement). */
  readonly settlement?: ChatInteractionSettlementV1;
  /** Present exactly for `resumed` / `supersededByReplacementOperation` settlements. */
  readonly resumeResolution?: ChatTransactionResumeResolutionV1;
  /**
   * Best-effort MIRROR of the invocation-once claim (plan §3.1 /
   * AC-RUNNER-03): the true atomic gate is a sibling exclusive-create marker
   * file, not this field — see the module header ("INVOCATION-ONCE CLAIM").
   * Legal only alongside a `resumeResolution`; may lag or (rarely) be absent
   * even when the marker exists, so do not use its absence to decide it is
   * safe to invoke the provider.
   */
  readonly resumeInvocationClaimedAt?: string;
  /**
   * Durable mirror of the terminal outcome the claimed invocation produced
   * (plan §3.1 / AC-RUNNER-03 "recover the claimed terminal result") — see
   * the module header ("RECOVERABLE TERMINAL OUTCOME"). Legal only alongside
   * `resumeInvocationClaimedAt`.
   */
  readonly resumeInvocationOutcome?: TaskActionOutcomeV1;
  readonly transitions: readonly ChatTransactionTransitionReceiptV1[];
}

const STATES_V1: readonly ChatInteractionTransactionStateV1[] = [
  "questionsPosted",
  "answersDraft",
  "answersSubmitted",
  "resumeScheduled",
  "settled",
];

const SETTLEMENTS_V1: readonly ChatInteractionSettlementV1[] = [
  "resumed",
  "cancelled",
  "supersededByReplacementOperation",
  "expired",
  "resetByChatRecovery",
];

/**
 * Legal receipt edges. Self-transitions are illegal by construction (draft
 * re-saves do not journal), which is what bounds the chain.
 */
const LEGAL_TRANSITIONS_V1: ReadonlyMap<
  ChatInteractionTransactionStateV1 | null,
  readonly ChatInteractionTransactionStateV1[]
> = new Map<ChatInteractionTransactionStateV1 | null, readonly ChatInteractionTransactionStateV1[]>([
  [null, ["questionsPosted"]],
  ["questionsPosted", ["answersDraft", "answersSubmitted", "settled"]],
  ["answersDraft", ["answersSubmitted", "settled"]],
  ["answersSubmitted", ["resumeScheduled", "settled"]],
  ["resumeScheduled", ["settled"]],
  ["settled", []],
]);

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unknownField(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return `${label} has an unknown field: ${key}`;
    }
  }
  return undefined;
}

/** Domain-prefixed digest of the canonical question-set JSON. */
export function computeChatTransactionQuestionSetSha256V1(
  questions: readonly StructuredQuestionV1[]
): string {
  return sha256HexUtf8("ensemble-chat-transaction-questions-v1\n" + canonicalJsonTextV1(questions));
}

/** Domain-prefixed digest of the canonical answers JSON. */
export function computeChatTransactionAnswersSha256V1(
  answers: readonly StructuredAnswerV1[]
): string {
  return sha256HexUtf8("ensemble-chat-transaction-answers-v1\n" + canonicalJsonTextV1(answers));
}

/** Digest of an input snapshot's canonical JSON bytes. */
export function computeChatTransactionInputSha256V1(canonicalJson: string): string {
  return sha256HexUtf8(canonicalJson);
}

/** Canonical UTF-8 bytes the store persists for a record. */
export function encodeChatInteractionTransactionV1(
  transaction: ChatInteractionTransactionV1
): Buffer {
  return Buffer.from(canonicalJsonTextV1(transaction), "utf8");
}

export type DecodeChatInteractionTransactionResultV1 =
  | { readonly ok: true; readonly transaction: ChatInteractionTransactionV1 }
  | { readonly ok: false; readonly reason: string };

function fail(reason: string): DecodeChatInteractionTransactionResultV1 {
  return { ok: false, reason };
}

const VALID_STAGES = new Set<string>(STAGE_ORDER);

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "actionKey",
  "operationId",
  "sourceAttemptId",
  "taskBindingId",
  "chatDocumentId",
  "interactionId",
  "stage",
  "resumeSemantics",
  "inputSnapshot",
  "promptContract",
  "questions",
  "questionSetSha256",
  "answers",
  "answerIdempotencyId",
  "answersSha256",
  "resumeIdempotencyId",
  "state",
  "settlement",
  "resumeResolution",
  "resumeInvocationClaimedAt",
  "resumeInvocationOutcome",
  "transitions",
]);

function decodeInputSnapshot(raw: unknown): ChatTransactionInputSnapshotV1 | string {
  if (!isPlainRecord(raw)) {
    return "\"inputSnapshot\" is not an object";
  }
  const unknown = unknownField(raw, new Set(["canonicalJson", "sha256"]), "inputSnapshot");
  if (unknown) {
    return unknown;
  }
  if (!isNonEmptyString(raw.canonicalJson)) {
    return "inputSnapshot is missing a non-empty \"canonicalJson\"";
  }
  if (Buffer.byteLength(raw.canonicalJson, "utf8") > MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1) {
    return `inputSnapshot exceeds the ${MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1}-byte canonical limit`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.canonicalJson);
  } catch {
    return "inputSnapshot \"canonicalJson\" is not valid JSON";
  }
  let recanonicalized: string;
  try {
    recanonicalized = canonicalJsonTextV1(parsed);
  } catch (error) {
    if (error instanceof CanonicalJsonErrorV1) {
      return `inputSnapshot has no canonical JSON form: ${error.message}`;
    }
    throw error;
  }
  if (recanonicalized !== raw.canonicalJson) {
    return "inputSnapshot \"canonicalJson\" is not in canonical form";
  }
  if (!isSha256Hex(raw.sha256) || raw.sha256 !== computeChatTransactionInputSha256V1(raw.canonicalJson)) {
    return "inputSnapshot \"sha256\" does not match its canonical JSON bytes";
  }
  return { canonicalJson: raw.canonicalJson, sha256: raw.sha256 };
}

function decodePromptContract(raw: unknown): ChatTransactionPromptContractV1 | string {
  if (!isPlainRecord(raw)) {
    return "\"promptContract\" is not an object";
  }
  const unknown = unknownField(
    raw,
    new Set(["contractId", "contractVersion", "promptInputSha256"]),
    "promptContract"
  );
  if (unknown) {
    return unknown;
  }
  if (typeof raw.contractId !== "string" || !STABLE_ID_PATTERN_V1.test(raw.contractId)) {
    return "promptContract is missing a valid \"contractId\" (bounded ASCII identifier required)";
  }
  if (
    typeof raw.contractVersion !== "number" ||
    !Number.isInteger(raw.contractVersion) ||
    raw.contractVersion < 1
  ) {
    return "promptContract is missing a positive integer \"contractVersion\"";
  }
  if (!isSha256Hex(raw.promptInputSha256)) {
    return "promptContract is missing a valid \"promptInputSha256\"";
  }
  return {
    contractId: raw.contractId,
    contractVersion: raw.contractVersion,
    promptInputSha256: raw.promptInputSha256,
  };
}

function decodeResumeResolution(raw: unknown): ChatTransactionResumeResolutionV1 | string {
  if (!isPlainRecord(raw)) {
    return "\"resumeResolution\" is not an object";
  }
  if (raw.kind === "sameOperation") {
    const unknown = unknownField(raw, new Set(["kind", "newAttemptId"]), "resumeResolution");
    if (unknown) {
      return unknown;
    }
    if (!isHex128IdV1(raw.newAttemptId)) {
      return "sameOperation resumeResolution is missing a valid \"newAttemptId\"";
    }
    return { kind: "sameOperation", newAttemptId: raw.newAttemptId };
  }
  if (raw.kind === "replacementOperation") {
    const unknown = unknownField(raw, new Set(["kind", "replacementOperationId"]), "resumeResolution");
    if (unknown) {
      return unknown;
    }
    if (!isHex128IdV1(raw.replacementOperationId)) {
      return "replacementOperation resumeResolution is missing a valid \"replacementOperationId\"";
    }
    return { kind: "replacementOperation", replacementOperationId: raw.replacementOperationId };
  }
  return `resumeResolution has an unrecognized "kind": ${JSON.stringify(raw.kind)}`;
}

function decodeTransitions(
  raw: unknown,
  state: ChatInteractionTransactionStateV1
): readonly ChatTransactionTransitionReceiptV1[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "\"transitions\" must be a non-empty array of receipts";
  }
  if (raw.length > MAX_TRANSITION_RECEIPTS_V1) {
    return `"transitions" exceeds the ${MAX_TRANSITION_RECEIPTS_V1}-receipt bound`;
  }
  const receipts: ChatTransactionTransitionReceiptV1[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isPlainRecord(entry)) {
      return `transition receipt at index ${i} is not an object`;
    }
    const unknown = unknownField(
      entry,
      new Set(["receiptId", "from", "to", "at"]),
      `transition receipt at index ${i}`
    );
    if (unknown) {
      return unknown;
    }
    if (!isHex128IdV1(entry.receiptId)) {
      return `transition receipt at index ${i} is missing a valid "receiptId"`;
    }
    if (seenIds.has(entry.receiptId)) {
      return `duplicate transition "receiptId": ${entry.receiptId}`;
    }
    seenIds.add(entry.receiptId);
    const from = entry.from;
    if (from !== null && !STATES_V1.includes(from as ChatInteractionTransactionStateV1)) {
      return `transition receipt at index ${i} has an invalid "from" state`;
    }
    const to = entry.to;
    if (!STATES_V1.includes(to as ChatInteractionTransactionStateV1)) {
      return `transition receipt at index ${i} has an invalid "to" state`;
    }
    if (typeof entry.at !== "string" || Number.isNaN(Date.parse(entry.at))) {
      return `transition receipt at index ${i} has an invalid "at" timestamp`;
    }
    const fromState = from as ChatInteractionTransactionStateV1 | null;
    const toState = to as ChatInteractionTransactionStateV1;
    const legal = LEGAL_TRANSITIONS_V1.get(fromState) ?? [];
    if (!legal.includes(toState)) {
      return `transition receipt at index ${i} records an illegal edge ${String(fromState)} -> ${toState}`;
    }
    const expectedFrom = i === 0 ? null : receipts[i - 1]!.to;
    if (fromState !== expectedFrom) {
      return `transition receipt at index ${i} breaks the chain: "from" must be ${String(expectedFrom)}`;
    }
    receipts.push({ receiptId: entry.receiptId, from: fromState, to: toState, at: entry.at });
  }
  if (receipts[receipts.length - 1]!.to !== state) {
    return `the final transition receipt must end at the record's state (${state})`;
  }
  return receipts;
}

/**
 * Validate draft (possibly partial) answers: each answer must reference a
 * distinct known question with a matching kind. Value-level rules (§3.6
 * completeness, blank/length/selection constraints) apply only from
 * `answersSubmitted` onward, via validateStructuredAnswersV1.
 */
function validateDraftAnswers(
  questions: readonly StructuredQuestionV1[],
  answers: readonly StructuredAnswerV1[]
): string | undefined {
  const byId = new Map(questions.map((q) => [q.questionId, q] as const));
  const seen = new Set<string>();
  for (const answer of answers) {
    if (seen.has(answer.questionId)) {
      return `duplicate draft answer for questionId ${answer.questionId}`;
    }
    seen.add(answer.questionId);
    const question = byId.get(answer.questionId);
    if (!question) {
      return `draft answer references unknown questionId ${answer.questionId}`;
    }
    if (question.kind !== answer.kind) {
      return `draft answer kind mismatch for questionId ${answer.questionId}`;
    }
  }
  return undefined;
}

/**
 * Strictly decode a raw parsed JSON value as a persisted Chat interaction
 * transaction record. Fail-closed: unknown fields at any level, malformed
 * identities, digest mismatches, non-canonical input snapshots, illegal or
 * broken transition chains, and any state/field inconsistency reject the
 * whole record. Callers treat a rejection as `chatRecoveryRequired` — the
 * interaction renders read-only and non-resumable (plan §5.5 /
 * AC-CHAT-TX-03).
 */
export function decodeChatInteractionTransactionV1(
  raw: unknown
): DecodeChatInteractionTransactionResultV1 {
  if (!isPlainRecord(raw)) {
    return fail("transaction record is not an object");
  }
  const unknown = unknownField(raw, TOP_LEVEL_FIELDS, "transaction record");
  if (unknown) {
    return fail(unknown);
  }
  if (raw.schemaVersion !== 1) {
    return fail(`unsupported "schemaVersion": ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (!isNonEmptyString(raw.actionKey)) {
    return fail("transaction record is missing a non-empty \"actionKey\"");
  }
  for (const field of ["operationId", "sourceAttemptId", "interactionId"] as const) {
    if (!isHex128IdV1(raw[field])) {
      return fail(`transaction record is missing a valid "${field}"`);
    }
  }
  if (!isNonEmptyString(raw.taskBindingId) || !isNonEmptyString(raw.chatDocumentId)) {
    return fail("transaction record is missing its task/document binding");
  }
  if (typeof raw.stage !== "string" || !VALID_STAGES.has(raw.stage)) {
    return fail(`transaction record is missing a valid "stage"`);
  }
  const stage = raw.stage as TaskStage;
  if (raw.resumeSemantics !== "sameOperation" && raw.resumeSemantics !== "replacementOperation") {
    return fail(`unrecognized "resumeSemantics": ${JSON.stringify(raw.resumeSemantics)}`);
  }
  const resumeSemantics: ResumeSemanticsV1 = raw.resumeSemantics;

  const inputSnapshot = decodeInputSnapshot(raw.inputSnapshot);
  if (typeof inputSnapshot === "string") {
    return fail(inputSnapshot);
  }
  const promptContract = decodePromptContract(raw.promptContract);
  if (typeof promptContract === "string") {
    return fail(promptContract);
  }

  const questionsResult = decodeStructuredQuestionsV1(raw.questions);
  if (!questionsResult.ok || !questionsResult.questions) {
    return fail(`invalid question set: ${questionsResult.reason ?? "unknown"}`);
  }
  const questions = questionsResult.questions;
  if (canonicalJsonByteLengthV1(questions) > MAX_QUESTION_SET_CANONICAL_BYTES_V1) {
    return fail(`question set exceeds the ${MAX_QUESTION_SET_CANONICAL_BYTES_V1}-byte canonical limit`);
  }
  if (
    !isSha256Hex(raw.questionSetSha256) ||
    raw.questionSetSha256 !== computeChatTransactionQuestionSetSha256V1(questions)
  ) {
    return fail("\"questionSetSha256\" does not match the canonical question set");
  }

  const state = raw.state;
  if (!STATES_V1.includes(state as ChatInteractionTransactionStateV1)) {
    return fail(`unrecognized "state": ${JSON.stringify(state)}`);
  }
  const typedState = state as ChatInteractionTransactionStateV1;

  // --- answers block -------------------------------------------------------
  let answers: readonly StructuredAnswerV1[] | undefined;
  if (raw.answers !== undefined) {
    const decoded = decodeStructuredAnswersArrayV1(raw.answers);
    if (!decoded.ok) {
      return fail(`invalid answers: ${decoded.reason}`);
    }
    answers = decoded.answers;
  }
  const answerIdempotencyId = raw.answerIdempotencyId;
  if ((answerIdempotencyId === undefined) !== (raw.answersSha256 === undefined)) {
    return fail("\"answerIdempotencyId\" and \"answersSha256\" must be present together");
  }
  let answersSha256: string | undefined;
  if (answerIdempotencyId !== undefined) {
    if (!isHex128IdV1(answerIdempotencyId)) {
      return fail("invalid \"answerIdempotencyId\"");
    }
    if (answers === undefined) {
      return fail("a record with an \"answerIdempotencyId\" must carry its \"answers\"");
    }
    const validation = validateStructuredAnswersV1(questions, answers);
    if (!validation.ok) {
      return fail(`submitted answers do not validate: ${validation.reason ?? "unknown"}`);
    }
    if (
      !isSha256Hex(raw.answersSha256) ||
      raw.answersSha256 !== computeChatTransactionAnswersSha256V1(answers)
    ) {
      return fail("\"answersSha256\" does not match the canonical answers");
    }
    answersSha256 = raw.answersSha256;
  } else if (answers !== undefined) {
    const draftProblem = validateDraftAnswers(questions, answers);
    if (draftProblem) {
      return fail(draftProblem);
    }
  }

  // --- resume idempotency block -------------------------------------------
  const resumeIdempotencyId = raw.resumeIdempotencyId;
  if (resumeIdempotencyId !== undefined) {
    if (!isHex128IdV1(resumeIdempotencyId)) {
      return fail("invalid \"resumeIdempotencyId\"");
    }
    if (answerIdempotencyId === undefined) {
      return fail("a \"resumeIdempotencyId\" requires submitted answers");
    }
    if (typedState !== "resumeScheduled" && typedState !== "settled") {
      return fail(`a "resumeIdempotencyId" is not valid in state ${typedState}`);
    }
  }

  // --- per-state field consistency ----------------------------------------
  switch (typedState) {
    case "questionsPosted":
      if (answers !== undefined || answerIdempotencyId !== undefined) {
        return fail("a questionsPosted record cannot carry answers");
      }
      break;
    case "answersDraft":
      if (answers === undefined) {
        return fail("an answersDraft record must carry its draft \"answers\"");
      }
      if (answerIdempotencyId !== undefined) {
        return fail("an answersDraft record cannot carry an \"answerIdempotencyId\"");
      }
      break;
    case "answersSubmitted":
      if (answerIdempotencyId === undefined) {
        return fail("an answersSubmitted record must carry its \"answerIdempotencyId\"");
      }
      if (resumeIdempotencyId !== undefined) {
        return fail("an answersSubmitted record cannot carry a \"resumeIdempotencyId\"");
      }
      break;
    case "resumeScheduled":
      if (answerIdempotencyId === undefined || resumeIdempotencyId === undefined) {
        return fail("a resumeScheduled record must carry both idempotency ids");
      }
      break;
    case "settled":
      break;
  }

  // --- settlement block ----------------------------------------------------
  const settlement = raw.settlement;
  const resumeResolutionRaw = raw.resumeResolution;
  if (typedState === "settled") {
    if (!SETTLEMENTS_V1.includes(settlement as ChatInteractionSettlementV1)) {
      return fail("a settled record must carry exactly one terminal \"settlement\"");
    }
  } else if (settlement !== undefined || resumeResolutionRaw !== undefined) {
    return fail("only a settled record may carry \"settlement\" or \"resumeResolution\"");
  }

  let resumeResolution: ChatTransactionResumeResolutionV1 | undefined;
  if (typedState === "settled") {
    const typedSettlement = settlement as ChatInteractionSettlementV1;
    const requiresResolution =
      typedSettlement === "resumed" || typedSettlement === "supersededByReplacementOperation";
    if (requiresResolution) {
      if (resumeResolutionRaw === undefined) {
        return fail(`a "${typedSettlement}" settlement requires a "resumeResolution"`);
      }
      const decoded = decodeResumeResolution(resumeResolutionRaw);
      if (typeof decoded === "string") {
        return fail(decoded);
      }
      resumeResolution = decoded;
      if (typedSettlement === "resumed") {
        if (decoded.kind !== "sameOperation" || resumeSemantics !== "sameOperation") {
          return fail(
            "a \"resumed\" settlement requires sameOperation semantics and a sameOperation resolution"
          );
        }
        if (decoded.newAttemptId === raw.sourceAttemptId) {
          return fail("a Resume attempt must be globally distinct from the source attempt");
        }
      } else {
        if (decoded.kind !== "replacementOperation" || resumeSemantics !== "replacementOperation") {
          return fail(
            "a \"supersededByReplacementOperation\" settlement requires replacementOperation " +
              "semantics and a replacementOperation resolution"
          );
        }
        if (decoded.replacementOperationId === raw.operationId) {
          return fail("a replacement operation must be distinct from the source operation");
        }
      }
      if (resumeIdempotencyId === undefined) {
        return fail(`a "${typedSettlement}" settlement requires a "resumeIdempotencyId"`);
      }
    } else if (resumeResolutionRaw !== undefined) {
      return fail(`a "${String(settlement)}" settlement cannot carry a "resumeResolution"`);
    }
  }

  // --- invocation-once claim block ------------------------------------------
  // Legal only alongside a settled `resumeResolution` (plan §3.1 /
  // AC-RUNNER-03): a claim can exist only once a Resume actually settled to
  // `resumed` / `supersededByReplacementOperation`, since that is the only
  // path that ever invokes a provider (see the module header).
  const resumeInvocationClaimedAtRaw = raw.resumeInvocationClaimedAt;
  if (resumeInvocationClaimedAtRaw !== undefined) {
    if (
      typeof resumeInvocationClaimedAtRaw !== "string" ||
      Number.isNaN(Date.parse(resumeInvocationClaimedAtRaw))
    ) {
      return fail("invalid \"resumeInvocationClaimedAt\" timestamp");
    }
    if (resumeResolution === undefined) {
      return fail(
        "a \"resumeInvocationClaimedAt\" claim requires a settled Resume resolution " +
          "(resumed or supersededByReplacementOperation)"
      );
    }
  }

  // --- recoverable terminal outcome block ------------------------------------
  // Legal only alongside `resumeInvocationClaimedAt` (module header,
  // "RECOVERABLE TERMINAL OUTCOME"): an outcome can only exist for an
  // invocation that was claimed.
  const resumeInvocationOutcomeRaw = raw.resumeInvocationOutcome;
  let resumeInvocationOutcome: TaskActionOutcomeV1 | undefined;
  if (resumeInvocationOutcomeRaw !== undefined) {
    if (resumeInvocationClaimedAtRaw === undefined) {
      return fail("a \"resumeInvocationOutcome\" requires \"resumeInvocationClaimedAt\"");
    }
    const decoded = decodeTaskActionOutcomeV1(resumeInvocationOutcomeRaw);
    if (!decoded.ok) {
      return fail(`invalid "resumeInvocationOutcome": ${decoded.reason}`);
    }
    // CORRELATION BINDING — a claim alone only proves who WON the invocation;
    // it says nothing about whether the outcome later recorded against it
    // actually belongs to this interaction. `resumeResolution` is guaranteed
    // decoded by this point (the block above requires it whenever a claim is
    // present). Reject an outcome whose correlation names a different action,
    // task, document, or operation than the one this transaction's Resume
    // resolution actually drives — otherwise a mismatched/forged outcome
    // could later be "recovered" as this interaction's authoritative result
    // (plan §3.1 / AC-RUNNER-03). A persisted outcome WITHOUT a correlation
    // is rejected the same way: the only producer
    // (`taskActionCoordinatorV1.ts`) normalizes every recorded outcome to
    // carry one, so a correlation-free record can never be semantically
    // bound to this interaction before being returned as authoritative
    // recovery data.
    const outcomeCorrelation = outcomeCorrelationV1(decoded.outcome);
    if (outcomeCorrelation === undefined) {
      return fail(
        "\"resumeInvocationOutcome\" must carry a correlation tuple so it can be bound " +
          "to this interaction's action/operation/task/document bindings"
      );
    }
    const expectedOperationId =
      resumeResolution!.kind === "replacementOperation"
        ? resumeResolution!.replacementOperationId
        : (raw.operationId as string);
    if (
      outcomeCorrelation.actionKey !== raw.actionKey ||
      outcomeCorrelation.taskBindingId !== raw.taskBindingId ||
      outcomeCorrelation.chatDocumentId !== raw.chatDocumentId ||
      outcomeCorrelation.operationId !== expectedOperationId
    ) {
      return fail(
        "\"resumeInvocationOutcome\" correlation does not match this interaction's " +
          "action/operation/task/document bindings"
      );
    }
    resumeInvocationOutcome = decoded.outcome;
  }

  const transitions = decodeTransitions(raw.transitions, typedState);
  if (typeof transitions === "string") {
    return fail(transitions);
  }

  // --- Resume transition-chain consistency (plan §5.5 / §3.1) --------------
  // A Resume settlement is only reachable through
  // answersSubmitted → resumeScheduled → settled, and the receipt chain is
  // the proof: a forged record cannot claim `resumed` /
  // `supersededByReplacementOperation` while its chain settled straight from
  // an earlier state, and a `resumeIdempotencyId` exists exactly when a
  // Resume was actually scheduled.
  if (typedState === "settled") {
    const typedSettlement = settlement as ChatInteractionSettlementV1;
    if (
      (typedSettlement === "resumed" || typedSettlement === "supersededByReplacementOperation") &&
      transitions[transitions.length - 1]!.from !== "resumeScheduled"
    ) {
      return fail(`a "${typedSettlement}" settlement must settle from a resumeScheduled receipt`);
    }
  }
  const enteredResumeScheduled = transitions.some((receipt) => receipt.to === "resumeScheduled");
  if (resumeIdempotencyId !== undefined && !enteredResumeScheduled) {
    return fail("a \"resumeIdempotencyId\" requires a resumeScheduled transition receipt");
  }
  if (enteredResumeScheduled && resumeIdempotencyId === undefined) {
    return fail("a record that entered resumeScheduled must carry its \"resumeIdempotencyId\"");
  }

  return {
    ok: true,
    transaction: {
      schemaVersion: 1,
      actionKey: raw.actionKey,
      operationId: raw.operationId as string,
      sourceAttemptId: raw.sourceAttemptId as string,
      taskBindingId: raw.taskBindingId,
      chatDocumentId: raw.chatDocumentId,
      interactionId: raw.interactionId as string,
      stage,
      resumeSemantics,
      inputSnapshot,
      promptContract,
      questions,
      questionSetSha256: raw.questionSetSha256,
      ...(answers !== undefined ? { answers } : {}),
      ...(answerIdempotencyId !== undefined ? { answerIdempotencyId } : {}),
      ...(answersSha256 !== undefined ? { answersSha256 } : {}),
      ...(resumeIdempotencyId !== undefined ? { resumeIdempotencyId } : {}),
      state: typedState,
      ...(typedState === "settled" ? { settlement: settlement as ChatInteractionSettlementV1 } : {}),
      ...(resumeResolution !== undefined ? { resumeResolution } : {}),
      ...(resumeInvocationClaimedAtRaw !== undefined
        ? { resumeInvocationClaimedAt: resumeInvocationClaimedAtRaw }
        : {}),
      ...(resumeInvocationOutcome !== undefined ? { resumeInvocationOutcome } : {}),
      transitions,
    },
  };
}
