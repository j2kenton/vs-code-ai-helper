/**
 * Durable gate store (plan Part 4c; the Part 5 store implements this same
 * interface transactionally).
 *
 * A gate is a paused decision point: it moves `pending → approved|rejected`
 * exactly once via an atomic compare-and-set on the gate row, and the
 * decision command's idempotency is scoped to (owner, gate, idempotency key)
 * with a stored request fingerprint (the @ensemble/core gate contract):
 *
 * - same key + same payload fingerprint → the ORIGINAL outcome is returned
 *   (`replayed`), never a second transition;
 * - same key + different payload → typed `gateDecisionPayloadMismatch`;
 * - a conflicting decision for an already-decided gate → typed
 *   `gateAlreadyDecided`;
 * - an unknown gate — or one the authenticated owner does not own — reads as
 *   `gateNotFound` (ownership is enforced at the store, so identifier
 *   guessing reveals nothing).
 *
 * The engine's gate machinery consumes PERSISTED decision records from this
 * store — never in-memory signals — and `markResumed` is the exactly-once
 * consumption CAS: a decision for an already-resumed gate is a no-op.
 *
 * The in-memory reference implementation below is for tests and
 * single-process dev; its mutations are single synchronous check-and-sets,
 * atomic by construction in one JS runtime — the stand-in for Part 5's
 * database CAS + unique constraint.
 */
import { allocateHex128IdV1, isHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import {
  computeGateDecisionFingerprintV1,
  GateCommandErrorCodeV1,
  GateDecisionCommandV1,
  GateDecisionRecordV1,
  GateStateV1,
  gateStateForDecisionV1,
} from "../../ensemble-core/src/gateV1";

/** A persisted gate row. */
export interface EngineGateRecordV1 {
  readonly gateId: string;
  readonly taskId: string;
  /** Every gate carries an owner (plan Part 3 ownership rules). */
  readonly ownerId: string;
  /** Operator-facing description of what approval would execute. */
  readonly summary: string;
  readonly state: GateStateV1;
  readonly createdAt: string;
  /** Unified diff of the proposed changes under review (read-only artifact). */
  readonly diffUnified?: string;
  /** Present when this gate re-offers an indeterminate execution attempt. */
  readonly reofferOfAttemptKey?: string;
  /** The accepted decision (idempotency key + request fingerprint). */
  readonly decision?: GateDecisionRecordV1;
  /** Set exactly once when the engine consumed the decision. */
  readonly resumedAt?: string;
}

export interface CreateEngineGateInputV1 {
  /** Defaults to a fresh 128-bit identity. */
  readonly gateId?: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly summary: string;
  readonly diffUnified?: string;
  readonly reofferOfAttemptKey?: string;
}

export type EngineGateDecideResultV1 =
  | {
      /** The CAS transitioned the gate: this is the FIRST and only decision. */
      readonly kind: "decided";
      readonly record: EngineGateRecordV1;
    }
  | {
      /** Same key + same fingerprint: the original outcome, no state change. */
      readonly kind: "replayed";
      readonly record: EngineGateRecordV1;
    }
  | {
      readonly kind: "error";
      readonly code: GateCommandErrorCodeV1;
      readonly reason: string;
    }
  | {
      /** Malformed command (shape errors, not one of the contract's typed gate errors). */
      readonly kind: "rejected";
      readonly reason: string;
    };

export interface EngineGateStoreV1 {
  /** Exclusive-create a pending gate row. */
  create(input: CreateEngineGateInputV1): Promise<EngineGateRecordV1>;
  read(gateId: string): Promise<EngineGateRecordV1 | undefined>;
  /**
   * Apply a decision command under the (owner, gate, idempotency key)
   * idempotency contract; the transition itself is an atomic CAS
   * `pending → approved|rejected`.
   */
  decide(ownerId: string, command: GateDecisionCommandV1): Promise<EngineGateDecideResultV1>;
  /**
   * Exactly-once consumption CAS: set `resumedAt` if unset. Returns
   * `consumed: false` when the gate was already consumed (the caller must
   * treat the decision as a no-op).
   */
  markResumed(
    gateId: string
  ): Promise<{ readonly consumed: boolean; readonly record: EngineGateRecordV1 | undefined }>;
  listForTask(taskId: string): Promise<readonly EngineGateRecordV1[]>;
}

/** In-memory reference implementation (tests / single-process dev). */
export function createInMemoryGateStoreV1(options?: {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}): EngineGateStoreV1 {
  const now = options?.now ?? ((): Date => new Date());
  const gates = new Map<string, EngineGateRecordV1>();

  return {
    create(input: CreateEngineGateInputV1): Promise<EngineGateRecordV1> {
      const gateId = input.gateId ?? allocateHex128IdV1();
      if (gates.has(gateId)) {
        return Promise.reject(new Error(`a gate already exists with id ${gateId}`));
      }
      const record: EngineGateRecordV1 = {
        gateId,
        taskId: input.taskId,
        ownerId: input.ownerId,
        summary: input.summary,
        state: "pending",
        createdAt: now().toISOString(),
        ...(input.diffUnified !== undefined ? { diffUnified: input.diffUnified } : {}),
        ...(input.reofferOfAttemptKey !== undefined
          ? { reofferOfAttemptKey: input.reofferOfAttemptKey }
          : {}),
      };
      gates.set(gateId, record);
      return Promise.resolve(record);
    },

    read(gateId: string): Promise<EngineGateRecordV1 | undefined> {
      return Promise.resolve(gates.get(gateId));
    },

    decide(ownerId: string, command: GateDecisionCommandV1): Promise<EngineGateDecideResultV1> {
      if (!isHex128IdV1(command.idempotencyKey)) {
        return Promise.resolve({
          kind: "rejected",
          reason: "gate idempotency keys are 128-bit lowercase-hex identifiers",
        });
      }
      if (command.decision !== "approve" && command.decision !== "reject") {
        return Promise.resolve({
          kind: "rejected",
          reason: "a gate decision is either approve or reject",
        });
      }
      const record = gates.get(command.gateId);
      if (record === undefined || record.ownerId !== ownerId) {
        // Ownership mismatch deliberately reads identically to absence.
        return Promise.resolve({
          kind: "error",
          code: "gateNotFound",
          reason: "no such gate for the authenticated owner",
        });
      }
      const fingerprint = computeGateDecisionFingerprintV1(command);
      if (record.decision !== undefined) {
        if (record.decision.idempotencyKey === command.idempotencyKey) {
          if (record.decision.requestFingerprint === fingerprint) {
            // Includes an already-resumed gate: the stored outcome comes
            // back, and nothing transitions or re-executes.
            return Promise.resolve({ kind: "replayed", record });
          }
          return Promise.resolve({
            kind: "error",
            code: "gateDecisionPayloadMismatch",
            reason:
              "this idempotency key was already used with a different decision payload",
          });
        }
        return Promise.resolve({
          kind: "error",
          code: "gateAlreadyDecided",
          reason: `the gate is already ${record.state}`,
        });
      }
      if (record.state !== "pending") {
        return Promise.resolve({
          kind: "error",
          code: "gateAlreadyDecided",
          reason: `the gate is already ${record.state}`,
        });
      }
      // Atomic CAS in one JS runtime: pending → approved|rejected, decision
      // record written in the same step (Part 5: one database transaction).
      const decision: GateDecisionRecordV1 = {
        gateId: record.gateId,
        decision: command.decision,
        idempotencyKey: command.idempotencyKey,
        requestFingerprint: fingerprint,
        decidedAt: now().toISOString(),
      };
      const next: EngineGateRecordV1 = {
        ...record,
        state: gateStateForDecisionV1(command.decision),
        decision,
      };
      gates.set(record.gateId, next);
      return Promise.resolve({ kind: "decided", record: next });
    },

    markResumed(
      gateId: string
    ): Promise<{ readonly consumed: boolean; readonly record: EngineGateRecordV1 | undefined }> {
      const record = gates.get(gateId);
      if (record === undefined) {
        return Promise.resolve({ consumed: false, record: undefined });
      }
      if (record.resumedAt !== undefined) {
        return Promise.resolve({ consumed: false, record });
      }
      const next: EngineGateRecordV1 = { ...record, resumedAt: now().toISOString() };
      gates.set(gateId, next);
      return Promise.resolve({ consumed: true, record: next });
    },

    listForTask(taskId: string): Promise<readonly EngineGateRecordV1[]> {
      const matches: EngineGateRecordV1[] = [];
      for (const record of gates.values()) {
        if (record.taskId === taskId) {
          matches.push(record);
        }
      }
      return Promise.resolve(matches);
    },
  };
}
