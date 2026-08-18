/**
 * Closed coordinator outcome union (plan §3.7).
 *
 * Provider envelopes (aiResultEnvelope.ts) are INPUTS to the action
 * coordinator; product and UI code consumes only this union. The codes here
 * are stable UI/test contracts: they name what the product should do next
 * (show questions, offer recovery, offer a fresh preflight, ...), not what a
 * provider happened to emit. Nothing outside the coordinator may synthesize
 * a "completed" outcome, which is what makes "only the coordinator may
 * decode provider envelopes or promote completed content" enforceable.
 *
 * The coordinator itself lands with the registry (plan §3.8); until then
 * this module is the shared contract its collaborators (lease store, file
 * store, Commit/Push early gate) are written against.
 */
import { ActionCorrelationV1, InteractionIdV1, isActionCorrelationV1 } from "./actionCorrelationV1";
import { MalformedAiResultV1 } from "./aiResultEnvelope";
import { WorkflowUnavailableCodeV1 } from "./workflowAvailabilityV1";

/** Malformed-result codes are shared verbatim with the envelope parser. */
export type MalformedResultCodeV1 = MalformedAiResultV1["code"];

export type RecoveryRequiredCodeV1 =
  | "taskProgressRecoveryRequired"
  | "chatRecoveryRequired"
  | "taskCreationRecoveryRequired";

export interface DuplicateRejectedOutcomeV1 {
  readonly kind: "duplicateRejected";
  readonly code: "operationAlreadyRunning";
}

/**
 * Identity of the reservation actually claimed and invoked for a settled
 * outcome — carried onto `completed`/`malformedResult` so the run log can
 * record what really ran (including a backup-cascade substitution) rather
 * than the row's requested model. Never the model itself: just enough (the
 * same display label + provider-qualified stored id used for artifact
 * attribution) to render one log line.
 */
export interface TaskActionOutcomeProviderV1 {
  readonly providerLabel: string;
  readonly storedModelId: string;
}

/**
 * One candidate of an exhausted provider chain: which ranked entry it was and
 * why it could not serve the round. `reason` is our own bounded diagnostic
 * (mode-capability rejection, availability-check failure, invocation failure
 * class) — never provider free text — so it stays within §2.2's sanitized
 * -outcome rule.
 */
export interface ProviderChainCandidateStatusV1 {
  readonly storedModelId: string;
  readonly providerLabel: string;
  readonly runnerId: string;
  readonly reason: string;
}

/**
 * Structured evidence that a stage's ENTIRE resolved provider chain was
 * exhausted without acquiring a provider (2026-08-13 finding 4: round 018
 * recorded only a bare `Status: unavailable (providerModeUnavailable)` — no
 * stage, no chain, no per-candidate reason — which made the stall invisible).
 * Built from live settings resolution at selection time
 * (`resolveEffectiveStageChainV1`/`backupModelsForStage` via
 * `openV1RunnerSelection`'s own ranked list), never from a stale
 * task-models.resolved.json snapshot. The coordinator passes it through
 * verbatim; the STAGE OWNER surfaces it (enriched run record, paused task).
 */
export interface ProviderChainExhaustionV1 {
  /** The stage whose chain was exhausted (absent when the request carried no stage). */
  readonly stage?: string;
  /** The resolved candidate chain, in ranked order, each with its skip/failure reason. */
  readonly candidates: readonly ProviderChainCandidateStatusV1[];
}

export type TaskActionOutcomeV1 =
  | {
      readonly kind: "completed";
      readonly correlation: ActionCorrelationV1;
      /**
       * `roundDeferredIncomplete`/`roundIncomplete` record a provider
       * invocation that settled successfully but whose round the STAGE OWNER
       * detected as not actually finished (deferred to an undeliverable
       * follow-up turn, or cut short — see
       * `describeIncompleteImplementationRoundV1`). Informational only: the
       * coordinator never emits or retries them (they are not malformed
       * results), and recovery is the task-loop's continuation scheduling.
       */
      readonly code: "completed" | "noChanges" | "roundDeferredIncomplete" | "roundIncomplete";
      readonly provider?: TaskActionOutcomeProviderV1;
    }
  | {
      readonly kind: "questions";
      readonly correlation: ActionCorrelationV1;
      readonly interactionId: InteractionIdV1;
      /**
       * Identity of the reservation that asked the questions. Absent only for
       * outcomes produced before a reservation existed (there are none today,
       * since questions always come from a provider response), kept optional
       * so persisted records without it (recorded before this field existed)
       * remain valid.
       */
      readonly provider?: TaskActionOutcomeProviderV1;
    }
  | {
      readonly kind: "cancelled";
      readonly correlation?: ActionCorrelationV1;
      readonly code: "userCancelled" | "providerCancelled";
      /**
       * Identity of the reservation that was cancelled, when the cancellation
       * happened after a reservation existed. `userCancelled` before any
       * reservation (e.g. a caller cancellation token observed pre-invocation)
       * legitimately carries none.
       */
      readonly provider?: TaskActionOutcomeProviderV1;
    }
  | {
      readonly kind: "failed";
      readonly correlation?: ActionCorrelationV1;
      readonly code: string;
      readonly retryable: boolean;
      /**
       * Sanitized cause, when the failure knows more than its code.
       *
       * Mirrors `malformedResult.detail`. Added because a transport failure
       * arrived as a bare `copilotRequestFailed` — the thrown error had been
       * dropped by a `catch {}` with no binding — leaving prompt-too-large,
       * quota exhaustion and a transient API fault indistinguishable, each
       * with a different remedy. Kept as a separate field rather than
       * appended to `code` so the code stays a stable identifier.
       */
      readonly detail?: string;
      /**
       * Identity of the reservation actually claimed and invoked, when the
       * failure was provider-originated (e.g. `contentContractExhausted`, a
       * content-contract candidate-advance chain that ran out of ranked
       * candidates). Absent for failures with no reservation to name (a
       * pre-invocation admission or storage failure). 2026-08-16 field
       * report, sixth item: a failed run naming no model forced attribution
       * to be reconstructed from `ensemble.modelSettings`, and it was
       * reconstructed wrong once — the disabled configured primary was
       * blamed for a backup candidate's failure.
       */
      readonly provider?: TaskActionOutcomeProviderV1;
    }
  | {
      readonly kind: "malformedResult";
      readonly correlation: ActionCorrelationV1;
      readonly code: MalformedResultCodeV1;
      /**
       * Optional diagnostic naming WHY the result was malformed (e.g. "expected
       * the frame to start with <<<...>>>", "received content type X, expected
       * Y"). Generated by our own parser/coordinator from its own parsing and
       * schema contracts, never the model's free-text reply itself (the raw
       * response text never reaches this field) — but a short, bounded
       * (<=200 char), escaped fragment of a specific field VALUE the provider
       * supplied (an enum-like contentType/version string, a plan stepId, a
       * relative path) may appear when it explains what was wrong. §2.2/§3.7's
       * sanitized-outcome rule bars the model's own prose and free text, not a
       * short quoted value naming which field failed, so this does not weaken
       * it. Optional and additive: every existing malformedResult outcome (and
       * every persisted record without it) remains valid.
       */
      readonly detail?: string;
      readonly provider?: TaskActionOutcomeProviderV1;
      /**
       * Present only for outcomes produced by the malformed-result
       * candidate-advancement loop (`taskActionCoordinatorV1.ts`'s
       * `MAX_MALFORMED_RESULT_INVOCATIONS_V1` budget, 2026-08-12 field report
       * item 2): the number of provider invocations this OPERATION already
       * spent (same-candidate attempt plus any candidate advances) before
       * returning this terminal outcome. `withMalformedResultRetryV1`
       * (`productionTaskActionRuntimeV1.ts`) reads this to cap the combined
       * same-candidate-retry + advance + outer-fresh-retry total at the same
       * shared budget, instead of adding its own fixed retry count on top —
       * which is what used to let one user press reach 3x2=6 invocations.
       * Absent on outcomes the advancement loop never touches (e.g.
       * `resultLimitExceeded`, `contentSchemaMismatch`), which keep the
       * outer wrapper's pre-existing fixed-attempt behavior unchanged.
       */
      readonly malformedInvocationsUsedV1?: number;
    }
  | {
      readonly kind: "unavailable";
      readonly code: WorkflowUnavailableCodeV1;
      /**
       * Present only on `providerModeUnavailable` / `candidatesExhausted`
       * outcomes produced by a selection whose whole ranked chain was
       * exhausted — see `ProviderChainExhaustionV1`. On
       * `candidatesExhausted` each invoked candidate's reason carries its
       * actual recorded per-attempt outcome (enriched by the coordinator
       * from the selection session it owns). Optional and additive: every
       * existing unavailable outcome (and every persisted record without
       * it) remains valid.
       */
      readonly chainExhaustion?: ProviderChainExhaustionV1;
    }
  | {
      readonly kind: "recoveryRequired";
      readonly code: RecoveryRequiredCodeV1;
    }
  | {
      readonly kind: "stalePreflight";
      readonly correlation: ActionCorrelationV1;
      readonly planId: string;
    }
  | {
      readonly kind: "partialEditBlocked";
      readonly correlation: ActionCorrelationV1;
      readonly executionId: string;
      readonly appliedReceiptIds: readonly string[];
    }
  | DuplicateRejectedOutcomeV1;

/** The one duplicate-invocation outcome (plan §10.1's early guard emits it too). */
export function duplicateRejectedV1(): DuplicateRejectedOutcomeV1 {
  return { kind: "duplicateRejected", code: "operationAlreadyRunning" };
}

/**
 * Extract an outcome's correlation, uniformly across the closed union: some
 * variants carry it required (`completed`, `questions`, `malformedResult`,
 * `stalePreflight`, `partialEditBlocked`), some optional (`cancelled`,
 * `failed`), and some never (`unavailable`, `recoveryRequired`,
 * `duplicateRejected` — none of these ever reach a provider invocation, so
 * there is nothing to correlate). Used to bind a persisted
 * `resumeInvocationOutcome` back to the transaction it was recorded against
 * (plan §3.1 / AC-RUNNER-03) instead of trusting an unrelated correlation as
 * this interaction's authoritative recovery data.
 */
export function outcomeCorrelationV1(outcome: TaskActionOutcomeV1): ActionCorrelationV1 | undefined {
  switch (outcome.kind) {
    case "completed":
    case "questions":
    case "malformedResult":
    case "stalePreflight":
    case "partialEditBlocked":
      return outcome.correlation;
    case "cancelled":
    case "failed":
      return outcome.correlation;
    case "unavailable":
    case "recoveryRequired":
    case "duplicateRejected":
      return undefined;
  }
}

/**
 * Strict decoder for one persisted `TaskActionOutcomeV1` (plan §3.1 /
 * AC-RUNNER-03's "recover the claimed terminal result"): the durable mirror
 * `chatInteractionTransactionV1.ts` stores as `resumeInvocationOutcome` round
 * -trips through this decoder, fail-closed on unknown fields or an
 * unrecognized "kind" exactly like every other §5.5 sub-decoder. The stored
 * content is already §2.2-permitted (correlation ids, codes, digests, byte
 * counts) — never provider text — so persisting the exact closed outcome is
 * safe.
 */
export type DecodeTaskActionOutcomeResultV1 =
  | { readonly ok: true; readonly outcome: TaskActionOutcomeV1 }
  | { readonly ok: false; readonly reason: string };

function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownOutcomeField(
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

function fail(reason: string): DecodeTaskActionOutcomeResultV1 {
  return { ok: false, reason };
}

/** The same bounded failure-code shape the envelope parser enforces (plan §3.5). */
const FAILURE_CODE_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MALFORMED_RESULT_CODES_V1: ReadonlySet<string> = new Set<MalformedResultCodeV1>([
  "invalidFrame",
  "invalidJson",
  "invalidEnvelope",
  "contentSchemaMismatch",
  "resultCorrelationMismatch",
  "resultLimitExceeded",
]);

const WORKFLOW_UNAVAILABLE_CODES_V1: ReadonlySet<string> = new Set<WorkflowUnavailableCodeV1>([
  "hostToolApiUnavailable",
  "providerModeUnavailable",
  "candidatesExhausted",
  "workspaceRootUnsupported",
  "workspacePathUnsafe",
  "workflowStorageUnavailable",
]);

const RECOVERY_REQUIRED_CODES_V1: ReadonlySet<string> = new Set<RecoveryRequiredCodeV1>([
  "taskProgressRecoveryRequired",
  "chatRecoveryRequired",
  "taskCreationRecoveryRequired",
]);

/** Decode a required or optional correlation field, rejecting unknown sub-fields. */
function decodeCorrelation(raw: unknown): ActionCorrelationV1 | string {
  if (!isPlainRecordV1(raw) || !isActionCorrelationV1(raw)) {
    return "\"correlation\" is not a valid correlation tuple";
  }
  const unknown = unknownOutcomeField(
    raw,
    new Set(["actionKey", "operationId", "attemptId", "taskBindingId", "chatDocumentId"]),
    "correlation"
  );
  if (unknown) {
    return unknown;
  }
  return {
    actionKey: raw.actionKey,
    operationId: raw.operationId,
    attemptId: raw.attemptId,
    taskBindingId: raw.taskBindingId,
    chatDocumentId: raw.chatDocumentId,
  };
}

function decodeOptionalCorrelation(raw: unknown): ActionCorrelationV1 | undefined | string {
  if (raw === undefined) {
    return undefined;
  }
  return decodeCorrelation(raw);
}

/** Decode an optional `provider` field, rejecting unknown sub-fields; absent (pre-existing persisted outcomes) decodes to `undefined`. */
function decodeOptionalProviderV1(raw: unknown): TaskActionOutcomeProviderV1 | undefined | string {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainRecordV1(raw)) {
    return "\"provider\" is not an object";
  }
  const unknown = unknownOutcomeField(raw, new Set(["providerLabel", "storedModelId"]), "provider");
  if (unknown) {
    return unknown;
  }
  if (typeof raw.providerLabel !== "string" || raw.providerLabel.length === 0) {
    return "\"provider.providerLabel\" must be a non-empty string";
  }
  if (typeof raw.storedModelId !== "string" || raw.storedModelId.length === 0) {
    return "\"provider.storedModelId\" must be a non-empty string";
  }
  return { providerLabel: raw.providerLabel, storedModelId: raw.storedModelId };
}

/** Bound on one candidate's `reason` — a diagnostic sentence, never a transcript. */
const MAX_CHAIN_CANDIDATE_REASON_CHARS_V1 = 500;
/** Bound on the candidate list — a ranked chain is a handful of models. */
const MAX_CHAIN_CANDIDATES_V1 = 32;

/** Decode an optional `chainExhaustion` field, rejecting unknown sub-fields. */
function decodeOptionalChainExhaustionV1(
  raw: unknown
): ProviderChainExhaustionV1 | undefined | string {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainRecordV1(raw)) {
    return "\"chainExhaustion\" is not an object";
  }
  const unknown = unknownOutcomeField(raw, new Set(["stage", "candidates"]), "chainExhaustion");
  if (unknown) {
    return unknown;
  }
  if (raw.stage !== undefined && (typeof raw.stage !== "string" || raw.stage.length === 0)) {
    return "\"chainExhaustion.stage\" must be a non-empty string when present";
  }
  if (!Array.isArray(raw.candidates) || raw.candidates.length > MAX_CHAIN_CANDIDATES_V1) {
    return "\"chainExhaustion.candidates\" must be a bounded array";
  }
  const candidates: ProviderChainCandidateStatusV1[] = [];
  for (const entry of raw.candidates as unknown[]) {
    if (!isPlainRecordV1(entry)) {
      return "\"chainExhaustion.candidates\" entries must be objects";
    }
    const unknownEntry = unknownOutcomeField(
      entry,
      new Set(["storedModelId", "providerLabel", "runnerId", "reason"]),
      "chainExhaustion candidate"
    );
    if (unknownEntry) {
      return unknownEntry;
    }
    if (
      typeof entry.storedModelId !== "string" ||
      entry.storedModelId.length === 0 ||
      typeof entry.providerLabel !== "string" ||
      entry.providerLabel.length === 0 ||
      typeof entry.runnerId !== "string" ||
      entry.runnerId.length === 0 ||
      typeof entry.reason !== "string" ||
      entry.reason.length === 0 ||
      entry.reason.length > MAX_CHAIN_CANDIDATE_REASON_CHARS_V1
    ) {
      return "\"chainExhaustion.candidates\" entries must carry bounded non-empty identity and reason strings";
    }
    candidates.push({
      storedModelId: entry.storedModelId,
      providerLabel: entry.providerLabel,
      runnerId: entry.runnerId,
      reason: entry.reason,
    });
  }
  return {
    ...(raw.stage !== undefined ? { stage: raw.stage } : {}),
    candidates,
  };
}

/**
 * Strictly decode a raw parsed JSON value as a persisted `TaskActionOutcomeV1`.
 * Fail-closed: unknown fields, malformed correlations, and unrecognized codes
 * all reject rather than silently coercing.
 */
export function decodeTaskActionOutcomeV1(raw: unknown): DecodeTaskActionOutcomeResultV1 {
  if (!isPlainRecordV1(raw)) {
    return fail("outcome is not an object");
  }
  switch (raw.kind) {
    case "completed": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "code", "provider"]),
        "completed outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (
        raw.code !== "completed" &&
        raw.code !== "noChanges" &&
        raw.code !== "roundDeferredIncomplete" &&
        raw.code !== "roundIncomplete"
      ) {
        return fail(`invalid completed outcome "code": ${JSON.stringify(raw.code)}`);
      }
      const provider = decodeOptionalProviderV1(raw.provider);
      if (typeof provider === "string") {
        return fail(provider);
      }
      return {
        ok: true,
        outcome: {
          kind: "completed",
          correlation,
          code: raw.code,
          ...(provider !== undefined ? { provider } : {}),
        },
      };
    }
    case "questions": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "interactionId", "provider"]),
        "questions outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (typeof raw.interactionId !== "string" || raw.interactionId.length === 0) {
        return fail("questions outcome is missing a valid \"interactionId\"");
      }
      const provider = decodeOptionalProviderV1(raw.provider);
      if (typeof provider === "string") {
        return fail(provider);
      }
      return {
        ok: true,
        outcome: {
          kind: "questions",
          correlation,
          interactionId: raw.interactionId,
          ...(provider !== undefined ? { provider } : {}),
        },
      };
    }
    case "cancelled": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "code", "provider"]),
        "cancelled outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeOptionalCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (raw.code !== "userCancelled" && raw.code !== "providerCancelled") {
        return fail(`invalid cancelled outcome "code": ${JSON.stringify(raw.code)}`);
      }
      const provider = decodeOptionalProviderV1(raw.provider);
      if (typeof provider === "string") {
        return fail(provider);
      }
      return {
        ok: true,
        outcome: {
          kind: "cancelled",
          ...(correlation !== undefined ? { correlation } : {}),
          code: raw.code,
          ...(provider !== undefined ? { provider } : {}),
        },
      };
    }
    case "failed": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "code", "retryable", "detail", "provider"]),
        "failed outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeOptionalCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (typeof raw.code !== "string" || !FAILURE_CODE_PATTERN_V1.test(raw.code)) {
        return fail("failed outcome is missing a valid \"code\"");
      }
      if (typeof raw.retryable !== "boolean") {
        return fail("failed outcome is missing a boolean \"retryable\"");
      }
      if (raw.detail !== undefined && typeof raw.detail !== "string") {
        return fail(`invalid failed outcome "detail": ${JSON.stringify(raw.detail)}`);
      }
      const provider = decodeOptionalProviderV1(raw.provider);
      if (typeof provider === "string") {
        return fail(provider);
      }
      return {
        ok: true,
        outcome: {
          kind: "failed",
          ...(correlation !== undefined ? { correlation } : {}),
          code: raw.code,
          retryable: raw.retryable,
          ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
          ...(provider !== undefined ? { provider } : {}),
        },
      };
    }
    case "malformedResult": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "code", "detail", "provider", "malformedInvocationsUsedV1"]),
        "malformedResult outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (typeof raw.code !== "string" || !MALFORMED_RESULT_CODES_V1.has(raw.code)) {
        return fail(`invalid malformedResult outcome "code": ${JSON.stringify(raw.code)}`);
      }
      if (raw.detail !== undefined && typeof raw.detail !== "string") {
        return fail(`invalid malformedResult outcome "detail": ${JSON.stringify(raw.detail)}`);
      }
      const provider = decodeOptionalProviderV1(raw.provider);
      if (typeof provider === "string") {
        return fail(provider);
      }
      if (
        raw.malformedInvocationsUsedV1 !== undefined &&
        (typeof raw.malformedInvocationsUsedV1 !== "number" ||
          !Number.isInteger(raw.malformedInvocationsUsedV1) ||
          raw.malformedInvocationsUsedV1 < 0)
      ) {
        return fail(
          `invalid malformedResult outcome "malformedInvocationsUsedV1": ${JSON.stringify(raw.malformedInvocationsUsedV1)}`
        );
      }
      return {
        ok: true,
        outcome: {
          kind: "malformedResult",
          correlation,
          code: raw.code as MalformedResultCodeV1,
          ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(raw.malformedInvocationsUsedV1 !== undefined
            ? { malformedInvocationsUsedV1: raw.malformedInvocationsUsedV1 }
            : {}),
        },
      };
    }
    case "unavailable": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "code", "chainExhaustion"]),
        "unavailable outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      if (typeof raw.code !== "string" || !WORKFLOW_UNAVAILABLE_CODES_V1.has(raw.code)) {
        return fail(`invalid unavailable outcome "code": ${JSON.stringify(raw.code)}`);
      }
      const chainExhaustion = decodeOptionalChainExhaustionV1(raw.chainExhaustion);
      if (typeof chainExhaustion === "string") {
        return fail(chainExhaustion);
      }
      return {
        ok: true,
        outcome: {
          kind: "unavailable",
          code: raw.code as WorkflowUnavailableCodeV1,
          ...(chainExhaustion !== undefined ? { chainExhaustion } : {}),
        },
      };
    }
    case "recoveryRequired": {
      const unknown = unknownOutcomeField(raw, new Set(["kind", "code"]), "recoveryRequired outcome");
      if (unknown) {
        return fail(unknown);
      }
      if (typeof raw.code !== "string" || !RECOVERY_REQUIRED_CODES_V1.has(raw.code)) {
        return fail(`invalid recoveryRequired outcome "code": ${JSON.stringify(raw.code)}`);
      }
      return { ok: true, outcome: { kind: "recoveryRequired", code: raw.code as RecoveryRequiredCodeV1 } };
    }
    case "stalePreflight": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "planId"]),
        "stalePreflight outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (typeof raw.planId !== "string" || raw.planId.length === 0) {
        return fail("stalePreflight outcome is missing a valid \"planId\"");
      }
      return { ok: true, outcome: { kind: "stalePreflight", correlation, planId: raw.planId } };
    }
    case "partialEditBlocked": {
      const unknown = unknownOutcomeField(
        raw,
        new Set(["kind", "correlation", "executionId", "appliedReceiptIds"]),
        "partialEditBlocked outcome"
      );
      if (unknown) {
        return fail(unknown);
      }
      const correlation = decodeCorrelation(raw.correlation);
      if (typeof correlation === "string") {
        return fail(correlation);
      }
      if (typeof raw.executionId !== "string" || raw.executionId.length === 0) {
        return fail("partialEditBlocked outcome is missing a valid \"executionId\"");
      }
      if (
        !Array.isArray(raw.appliedReceiptIds) ||
        raw.appliedReceiptIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        return fail("partialEditBlocked outcome is missing valid \"appliedReceiptIds\"");
      }
      return {
        ok: true,
        outcome: {
          kind: "partialEditBlocked",
          correlation,
          executionId: raw.executionId,
          appliedReceiptIds: raw.appliedReceiptIds as readonly string[],
        },
      };
    }
    case "duplicateRejected": {
      const unknown = unknownOutcomeField(raw, new Set(["kind", "code"]), "duplicateRejected outcome");
      if (unknown) {
        return fail(unknown);
      }
      if (raw.code !== "operationAlreadyRunning") {
        return fail(`invalid duplicateRejected outcome "code": ${JSON.stringify(raw.code)}`);
      }
      return { ok: true, outcome: { kind: "duplicateRejected", code: "operationAlreadyRunning" } };
    }
    default:
      return fail(`unrecognized outcome "kind": ${JSON.stringify(raw.kind)}`);
  }
}
