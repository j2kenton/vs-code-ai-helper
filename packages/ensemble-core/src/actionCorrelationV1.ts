/**
 * Correlation identity contract (Part 2 port of
 * `src/types/actionCorrelationV1.ts`).
 *
 * Every AI action invocation is expected to carry these identifiers so a
 * cross-task, cross-operation, or stale-attempt result can never be promoted
 * into Chat or an artifact by a consumer that only checks envelope "kind".
 * `actionKey` alone is never a unique execution identity — `operationId` and
 * `attemptId` are.
 */

/** Stable registry key, e.g. "generatePlan.v1". */
export type ActionKeyV1 = string;

/** 128-bit random identifier, rendered as 32 lowercase hex characters. */
export type OperationIdV1 = string;

/** 128-bit random identifier, rendered as 32 lowercase hex characters. */
export type AttemptIdV1 = string;

/** 128-bit random identifier, rendered as 32 lowercase hex characters. */
export type ReservationIdV1 = string;

/** 128-bit random identifier, rendered as 32 lowercase hex characters. */
export type InteractionIdV1 = string;

/**
 * Declares whether an explicit Resume after a `questions` result retains the
 * original operation (a new attempt on the same `operationId`) or starts a
 * fresh, linked operation (because the original's process-global token was
 * already released — e.g. Commit/Push metadata).
 */
export type ResumeSemanticsV1 = "sameOperation" | "replacementOperation";

export interface TaskBindingRefV1 {
  /** SHA-256 of canonical ownership + taskFolder binding. */
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
}

export interface ActionCorrelationV1 extends TaskBindingRefV1 {
  readonly actionKey: ActionKeyV1;
  readonly operationId: OperationIdV1;
  readonly attemptId: AttemptIdV1;
}

const HEX_128_ID_PATTERN = /^[0-9a-f]{32}$/;

/** True for a well-formed 128-bit random identifier: 32 lowercase hex chars. */
export function isHex128IdV1(value: unknown): value is string {
  return typeof value === "string" && HEX_128_ID_PATTERN.test(value);
}

/**
 * The one allocator for every 128-bit workflow identity (operation, attempt,
 * reservation, interaction, selection session): 16 CSPRNG bytes rendered as
 * 32 lowercase hex characters. Globally unique by construction — plan §3.1's
 * "simultaneous runs of the same action on different tasks cannot share a
 * complete correlation tuple" rests on this, so no caller may substitute a
 * counter, a timestamp, or a reused identifier.
 */
export function allocateHex128IdV1(): string {
  // globalThis.crypto is a CSPRNG in Node >= 19, browsers, and React Native
  // (with the standard polyfill) — same guarantee as node:crypto randomBytes
  // without binding this package to Node.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Structural validation of an `ActionCorrelationV1` tuple decoded from JSON. */
export function isActionCorrelationV1(value: unknown): value is ActionCorrelationV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.actionKey) &&
    isHex128IdV1(v.operationId) &&
    isHex128IdV1(v.attemptId) &&
    isNonEmptyString(v.taskBindingId) &&
    isNonEmptyString(v.chatDocumentId)
  );
}

/**
 * True when two correlation tuples identify the same task binding,
 * operation, and attempt — i.e. a result carrying `candidate` may be
 * promoted against state opened under `expected`. A mismatch on any field is
 * terminal (plan §3.1: "Correlation is checked before envelope-kind or
 * content processing").
 */
export function correlationMatchesV1(
  expected: ActionCorrelationV1,
  candidate: ActionCorrelationV1
): boolean {
  return (
    expected.actionKey === candidate.actionKey &&
    expected.operationId === candidate.operationId &&
    expected.attemptId === candidate.attemptId &&
    expected.taskBindingId === candidate.taskBindingId &&
    expected.chatDocumentId === candidate.chatDocumentId
  );
}
