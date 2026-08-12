/**
 * Gate / approval state contract (Part 2, new — no extension counterpart).
 *
 * A gate is a paused decision point in an engine run: execution stops until
 * the owning user approves or rejects it. These types are the shared
 * vocabulary for the Part 3 API contract (idempotent gate commands), the
 * Part 4c engine gate machinery (durable exactly-once transitions), and the
 * Part 5 store (atomic compare-and-set on the gate row plus the
 * (owner, gate, idempotency key) unique constraint with a stored request
 * fingerprint).
 *
 * Idempotency rules (plan Part 3):
 * - the client-generated idempotency key's uniqueness is scoped to the
 *   authenticated owner and the target gate;
 * - replaying the same key with the same payload returns the original
 *   outcome;
 * - replaying the same key with a different payload returns
 *   `gateDecisionPayloadMismatch`;
 * - a conflicting decision for an already-decided gate returns
 *   `gateAlreadyDecided` — never a second execution.
 */
import { sha256HexUtf8V1 } from "./sha256V1";
import { canonicalJsonTextV1 } from "./structuredQuestionV1";

/** A gate moves `pending → approved | rejected` exactly once (Part 4c). */
export type GateStateV1 = "pending" | "approved" | "rejected";

/** The decision a gate command carries. */
export type GateDecisionV1 = "approve" | "reject";

/** Terminal gate state produced by a decision. */
export function gateStateForDecisionV1(decision: GateDecisionV1): GateStateV1 {
  return decision === "approve" ? "approved" : "rejected";
}

/**
 * Typed error codes for gate commands (Part 3 contract; Part 5 returns them).
 */
export type GateCommandErrorCodeV1 =
  /** Same idempotency key replayed with a different payload fingerprint. */
  | "gateDecisionPayloadMismatch"
  /** A conflicting decision arrived for a gate that is no longer pending. */
  | "gateAlreadyDecided"
  /** The named gate does not exist for the authenticated owner. */
  | "gateNotFound";

/**
 * One gate approve/reject command as submitted by a client. Retries MUST
 * reuse the same `idempotencyKey` with an identical payload so a flaky
 * connection cannot double-approve (plan Part 9).
 */
export interface GateDecisionCommandV1 {
  readonly gateId: string;
  readonly decision: GateDecisionV1;
  /**
   * Client-generated key, unique per (authenticated owner, target gate) —
   * a 128-bit lowercase-hex identifier (see actionCorrelationV1's
   * allocateHex128IdV1).
   */
  readonly idempotencyKey: string;
  /** Optional operator-facing note recorded with the decision. */
  readonly comment?: string;
}

/**
 * The stored request fingerprint: SHA-256 over the domain-prefixed canonical
 * JSON of the decision payload (everything except the idempotency key
 * itself). The Part 5 store persists this alongside the key so a same-key /
 * different-payload replay is deterministically rejected.
 */
export function computeGateDecisionFingerprintV1(
  command: Pick<GateDecisionCommandV1, "gateId" | "decision" | "comment">
): string {
  return sha256HexUtf8V1(
    "ensemble-gate-decision-v1\n" +
      canonicalJsonTextV1({
        gateId: command.gateId,
        decision: command.decision,
        ...(command.comment !== undefined ? { comment: command.comment } : {}),
      })
  );
}

/**
 * A persisted gate decision record — what the atomic compare-and-set writes
 * and what a same-key replay reads back (plan Part 5).
 */
export interface GateDecisionRecordV1 {
  readonly gateId: string;
  readonly decision: GateDecisionV1;
  readonly idempotencyKey: string;
  /** computeGateDecisionFingerprintV1 of the accepted payload. */
  readonly requestFingerprint: string;
  /** ISO timestamp the decision was accepted. */
  readonly decidedAt: string;
}

/**
 * Execution-attempt states for the crash-safe external-effect protocol
 * (Part 4c). An attempt record is persisted BEFORE any external side effect;
 * `indeterminate` attempts are never silently re-executed — they re-enter
 * the gate flow for explicit user re-approval.
 */
export type ExecutionAttemptStateV1 =
  | "pending"
  | "succeeded"
  | "failed"
  | "indeterminate";
