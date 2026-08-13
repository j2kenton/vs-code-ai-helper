/**
 * Provider selection policy (plan §3.3, "Split provider selection from
 * invocation").
 *
 * A selection session is opened once per coordinator action invocation,
 * bound to `actionKey`, `operationId`, and the task/document binding. The
 * session enforces the coordinator flow's identity rules mechanically:
 *
 *  1. every provider invocation — including fallback and both Resume forms —
 *     gets a globally unique `attemptId` (AC-ID-02);
 *  2. each attempt gets exactly one reservation, which is claim-once and
 *     invocation-once (AC-RUNNER-03);
 *  3. each attempt's outcome is reported exactly once;
 *  4. a further reservation (fallback) is only issuable after the previous
 *     attempt settled with a pre-response outcome — completed output,
 *     questions, provider-declared failure, malformed output, correlation
 *     mismatch, overflow, cancellation, and response-started transport
 *     failure are terminal (AC-RUNNER-05). The one caller-driven exception is
 *     `malformedResultPreFallback`, reported only when the coordinator has
 *     already committed to advancing to the next ranked candidate for a
 *     malformed result (2026-08-12 field report, item 2) — see its own doc
 *     comment on `AttemptOutcomeKindV1`;
 *  5. no attempt or reservation is ever revisited.
 *
 * The session only accounts identities — it never invokes a provider
 * (AC-RUNNER-04: selection is split from invocation; the execution broker in
 * `agentExecutionBrokerV1.ts` owns invocation). WHICH runner/provider/model
 * a reservation names is not this module's decision either: reservation
 * inputs come from `openV1RunnerSelection` in `runnerRegistry.ts`, which
 * remains the sole source of provider/model ranking and fallback policy
 * (plan product decisions) and feeds `reserve` with registry-ranked
 * candidates only. Nothing in production opens sessions yet: the action
 * coordinator (plan §3.8, executable-order step 6) is the intended sole
 * caller while AI routes remain gated (plan §1.3).
 */
import {
  ActionCorrelationV1,
  ActionKeyV1,
  allocateHex128IdV1,
  AttemptIdV1,
  isHex128IdV1,
  OperationIdV1,
  ReservationIdV1,
} from "../types/actionCorrelationV1";
import { AgentExecutionModeV1 } from "../types/agentExecutionV1";
import { ProviderReservationHandleV1 } from "../types/providerReservationV1";

export class ProviderSelectionPolicyErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSelectionPolicyErrorV1";
  }
}

/**
 * How an attempt settled, as reported by the coordinator after decoding the
 * broker result (and, for completed frames, the envelope). Exactly three
 * outcomes leave the session open for an explicit fallback reservation; the
 * rest are terminal (plan §3.3).
 *
 * `malformedResultPreFallback` (2026-08-12 field report, item 2) is a
 * DISTINCT bookkeeping outcome from `malformedResult`, not a reclassification
 * of it: `malformedResult` itself stays terminal (AC-RUNNER-05 is unchanged —
 * a malformed response the coordinator has decided NOT to retry still closes
 * the session exactly as before). This new kind is reported only when the
 * coordinator has already decided, before calling `reportAttemptOutcome`,
 * that it will immediately reserve and invoke the next ranked candidate for
 * the SAME operation — the malformed-result analogue of the pre-response
 * `transportFailurePreResponse` path, which established the same shape for a
 * different terminal-outcome family. The `TaskActionOutcomeV1` returned to
 * the caller if candidates run out is still `{ kind: "malformedResult", ... }`;
 * this session-level kind never leaks past `taskActionCoordinatorV1.ts`.
 */
export type AttemptOutcomeKindV1 =
  | "completed"
  | "questions"
  | "providerDeclaredFailure"
  | "malformedResult"
  | "malformedResultPreFallback"
  | "resultCorrelationMismatch"
  | "overflow"
  | "providerCancelled"
  | "callerCancelled"
  | "transportFailureResponseStarted"
  | "transportFailurePreResponse"
  | "providerUnavailablePreInvocation";

/** The only outcomes after which the current fallback policy may request another provider. */
export const FALLBACK_ELIGIBLE_ATTEMPT_OUTCOMES_V1: ReadonlySet<AttemptOutcomeKindV1> =
  new Set<AttemptOutcomeKindV1>([
    "transportFailurePreResponse",
    "providerUnavailablePreInvocation",
    "malformedResultPreFallback",
  ]);

export interface SelectionSessionBindingV1 {
  readonly actionKey: ActionKeyV1;
  readonly operationId: OperationIdV1;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
}

export interface ProviderSelectionSessionOptionsV1 {
  /**
   * Adopt a pre-allocated id for the session's FIRST attempt instead of
   * allocating a fresh one. The coordinator's Resume path passes the §3.1
   * idempotency linkage's recorded `newAttemptId` here, so a `sameOperation`
   * Resume — fresh or an identical-id crash replay — executes under exactly
   * the attempt the settled Chat transaction binds to (AC-ID-04). The id
   * must be a well-formed 128-bit identity; it is consumed by exactly the
   * first `allocateAttempt`, and every later (fallback) attempt still
   * allocates a globally fresh id (AC-ID-02).
   */
  readonly firstAttemptId?: AttemptIdV1;
}

/**
 * Reservation input for one attempt. The runner/provider/model triple is
 * registry policy, not caller choice: production reservations are issued
 * through `openV1RunnerSelection` (`runnerRegistry.ts`), which derives these
 * fields from the registry's own ranking/fallback policy.
 */
export interface ReserveProviderInputV1 {
  readonly attemptId: AttemptIdV1;
  readonly mode: AgentExecutionModeV1;
  readonly runnerId: string;
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * A claimed reservation, ready for exactly one broker invocation.
 * `beginInvocation` throws on a second call — the mechanical form of
 * "claim and invoke the reservation exactly once".
 */
export interface ClaimedReservationV1 {
  readonly handle: ProviderReservationHandleV1;
  beginInvocation(): void;
}

export interface ProviderSelectionSessionV1 {
  readonly selectionSessionId: string;
  readonly binding: SelectionSessionBindingV1;
  /**
   * Allocate the next globally unique attempt. Throws when the session is
   * terminated, or while an earlier attempt has no reported outcome.
   */
  allocateAttempt(): AttemptIdV1;
  /** The full correlation tuple a request/envelope for this attempt must carry. */
  correlationForAttempt(attemptId: AttemptIdV1): ActionCorrelationV1;
  /** Issue the single reservation for an allocated attempt. */
  reserve(input: ReserveProviderInputV1): ProviderReservationHandleV1;
  /** Claim a reservation exactly once for invocation. */
  claim(reservationId: ReservationIdV1): ClaimedReservationV1;
  /** Record an attempt's settlement exactly once; a terminal outcome closes the session. */
  reportAttemptOutcome(attemptId: AttemptIdV1, outcome: AttemptOutcomeKindV1): void;
  /** True once a terminal outcome has been reported — no further attempts or reservations. */
  isTerminated(): boolean;
}

interface AttemptStateV1 {
  readonly attemptId: AttemptIdV1;
  reservation: ReservationStateV1 | undefined;
  outcome: AttemptOutcomeKindV1 | undefined;
}

interface ReservationStateV1 {
  readonly handle: ProviderReservationHandleV1;
  /** The attempt this reservation was issued for: once it settles, the reservation is dead. */
  readonly attempt: AttemptStateV1;
  claimed: boolean;
  invoked: boolean;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderSelectionPolicyErrorV1(
      `A provider selection session requires a non-empty "${field}".`
    );
  }
  return value;
}

export function openProviderSelectionSessionV1(
  binding: SelectionSessionBindingV1,
  options?: ProviderSelectionSessionOptionsV1
): ProviderSelectionSessionV1 {
  requireNonEmptyString(binding.actionKey, "actionKey");
  requireNonEmptyString(binding.taskBindingId, "taskBindingId");
  requireNonEmptyString(binding.chatDocumentId, "chatDocumentId");
  if (!isHex128IdV1(binding.operationId)) {
    throw new ProviderSelectionPolicyErrorV1(
      "A provider selection session requires a well-formed 128-bit operationId."
    );
  }
  if (options?.firstAttemptId !== undefined && !isHex128IdV1(options.firstAttemptId)) {
    throw new ProviderSelectionPolicyErrorV1(
      "A provider selection session's adopted first attempt id must be a well-formed 128-bit identity."
    );
  }

  const selectionSessionId = allocateHex128IdV1();
  const frozenBinding: SelectionSessionBindingV1 = {
    actionKey: binding.actionKey,
    operationId: binding.operationId,
    taskBindingId: binding.taskBindingId,
    chatDocumentId: binding.chatDocumentId,
  };

  const attempts: AttemptStateV1[] = [];
  const attemptsById = new Map<AttemptIdV1, AttemptStateV1>();
  const reservationsById = new Map<ReservationIdV1, ReservationStateV1>();
  let terminated = false;
  /** Consumed by exactly the first allocateAttempt (see ProviderSelectionSessionOptionsV1). */
  let pendingFirstAttemptId = options?.firstAttemptId;

  function requireOpen(action: string): void {
    if (terminated) {
      throw new ProviderSelectionPolicyErrorV1(
        `Cannot ${action}: this selection session settled with a terminal attempt outcome ` +
          "and is closed. Fallback requires a new coordinator operation, not a reopened session."
      );
    }
  }

  function requireAttempt(attemptId: AttemptIdV1): AttemptStateV1 {
    const attempt = attemptsById.get(attemptId);
    if (!attempt) {
      throw new ProviderSelectionPolicyErrorV1(
        `Unknown attemptId ${JSON.stringify(attemptId)}: attempts must be allocated by this session.`
      );
    }
    return attempt;
  }

  function correlationForAttempt(attemptId: AttemptIdV1): ActionCorrelationV1 {
    requireAttempt(attemptId);
    return {
      actionKey: frozenBinding.actionKey,
      operationId: frozenBinding.operationId,
      attemptId,
      taskBindingId: frozenBinding.taskBindingId,
      chatDocumentId: frozenBinding.chatDocumentId,
    };
  }

  return {
    selectionSessionId,
    binding: frozenBinding,

    allocateAttempt(): AttemptIdV1 {
      requireOpen("allocate an attempt");
      const latest = attempts[attempts.length - 1];
      if (latest && latest.outcome === undefined) {
        throw new ProviderSelectionPolicyErrorV1(
          `Cannot allocate a new attempt while attempt ${latest.attemptId} has no reported outcome: ` +
            "every attempt is reported exactly once before fallback may proceed."
        );
      }
      const attemptId = pendingFirstAttemptId ?? allocateHex128IdV1();
      pendingFirstAttemptId = undefined;
      const state: AttemptStateV1 = { attemptId, reservation: undefined, outcome: undefined };
      attempts.push(state);
      attemptsById.set(attemptId, state);
      return attemptId;
    },

    correlationForAttempt,

    reserve(input: ReserveProviderInputV1): ProviderReservationHandleV1 {
      requireOpen("issue a reservation");
      requireNonEmptyString(input.runnerId, "runnerId");
      requireNonEmptyString(input.providerId, "providerId");
      requireNonEmptyString(input.modelId, "modelId");
      const attempt = requireAttempt(input.attemptId);
      if (attempt.outcome !== undefined) {
        throw new ProviderSelectionPolicyErrorV1(
          `Attempt ${attempt.attemptId} already settled (${attempt.outcome}); attempts are never revisited.`
        );
      }
      if (attempt.reservation) {
        throw new ProviderSelectionPolicyErrorV1(
          `Attempt ${attempt.attemptId} already has reservation ` +
            `${attempt.reservation.handle.reservationId}; each attempt gets exactly one reservation.`
        );
      }
      const handle: ProviderReservationHandleV1 = {
        selectionSessionId,
        reservationId: allocateHex128IdV1(),
        correlation: correlationForAttempt(input.attemptId),
        mode: input.mode,
        runnerId: input.runnerId,
        providerId: input.providerId,
        modelId: input.modelId,
      };
      const reservation: ReservationStateV1 = { handle, attempt, claimed: false, invoked: false };
      attempt.reservation = reservation;
      reservationsById.set(handle.reservationId, reservation);
      return handle;
    },

    claim(reservationId: ReservationIdV1): ClaimedReservationV1 {
      requireOpen("claim a reservation");
      const reservation = reservationsById.get(reservationId);
      if (!reservation) {
        throw new ProviderSelectionPolicyErrorV1(
          `Unknown reservationId ${JSON.stringify(reservationId)}: reservations must be issued by this session.`
        );
      }
      if (reservation.attempt.outcome !== undefined) {
        // A settled attempt closes its reservation permanently — otherwise a
        // reservation reported as (say) providerUnavailablePreInvocation could
        // still be claimed and invoked after a fallback attempt was allocated,
        // producing two live invocations for one operation.
        throw new ProviderSelectionPolicyErrorV1(
          `Reservation ${reservationId} belongs to attempt ${reservation.attempt.attemptId}, which already ` +
            `settled (${reservation.attempt.outcome}); a settled attempt's reservation can never be claimed.`
        );
      }
      if (reservation.claimed) {
        throw new ProviderSelectionPolicyErrorV1(
          `Reservation ${reservationId} was already claimed; reservations are claim-once.`
        );
      }
      reservation.claimed = true;
      return {
        handle: reservation.handle,
        beginInvocation(): void {
          if (reservation.attempt.outcome !== undefined) {
            // Claimed before the attempt settled, invoked after: still dead.
            throw new ProviderSelectionPolicyErrorV1(
              `Reservation ${reservationId} belongs to attempt ${reservation.attempt.attemptId}, which already ` +
                `settled (${reservation.attempt.outcome}); a settled attempt's reservation can never be invoked.`
            );
          }
          if (reservation.invoked) {
            throw new ProviderSelectionPolicyErrorV1(
              `Reservation ${reservationId} was already invoked; reservations are invocation-once. ` +
                "Fallback requires a new attempt and an explicit next reservation."
            );
          }
          reservation.invoked = true;
        },
      };
    },

    reportAttemptOutcome(attemptId: AttemptIdV1, outcome: AttemptOutcomeKindV1): void {
      const attempt = requireAttempt(attemptId);
      if (attempt.outcome !== undefined) {
        throw new ProviderSelectionPolicyErrorV1(
          `Attempt ${attemptId} already reported outcome "${attempt.outcome}"; ` +
            "attempt outcomes are reported exactly once."
        );
      }
      attempt.outcome = outcome;
      if (!FALLBACK_ELIGIBLE_ATTEMPT_OUTCOMES_V1.has(outcome)) {
        terminated = true;
      }
    },

    isTerminated(): boolean {
      return terminated;
    },
  };
}
