/**
 * Execution-attempt store (plan Part 4c; the Part 5 store implements this
 * same interface transactionally).
 *
 * The crash-safe external-effect protocol's durable half: BEFORE the engine
 * initiates any external side effect (a model-provider call or a sandbox
 * command), it persists an execution-attempt record carrying a DETERMINISTIC
 * external idempotency key derived from stable identifiers (task id, gate id,
 * effect kind, attempt lineage) — so a crashed worker's successor derives
 * the exact same key and can safely replay, reconcile, or re-offer. The
 * outcome is persisted when the call completes; only the FIRST terminal
 * state is ever authoritative. An `indeterminate` attempt is never silently
 * re-executed — the gate machinery re-offers it for explicit user
 * re-approval (`gateMachineryV1.ts`).
 *
 * Part 4d threads these keys into sandbox commands (as command
 * markers/metadata where the platform lacks native idempotency support) so
 * reconciliation can identify whether a given attempt already ran.
 */
import { sha256HexUtf8V1 } from "../../ensemble-core/src/sha256V1";
import { canonicalJsonTextV1 } from "../../ensemble-core/src/structuredQuestionV1";
import type { ExecutionAttemptStateV1 } from "../../ensemble-core/src/gateV1";

/** The two external-effect classes the engine ever initiates. */
export type EngineExternalEffectKindV1 = "modelProviderCall" | "sandboxCommand";

export interface ExecutionAttemptKeyInputV1 {
  readonly taskId: string;
  /** The gate (or step) whose approval this effect executes under. */
  readonly gateId: string;
  readonly effectKind: EngineExternalEffectKindV1;
  /** 0-based attempt lineage under this gate. */
  readonly lineage: number;
}

/**
 * Deterministic external idempotency key: SHA-256 over the domain-prefixed
 * canonical JSON of the stable identifiers. Same task + gate + effect kind +
 * lineage always derives the same key — no randomness, no timestamps — which
 * is what makes post-crash safe replay possible.
 */
export function deriveExecutionAttemptKeyV1(input: ExecutionAttemptKeyInputV1): string {
  return sha256HexUtf8V1(
    "ensemble-execution-attempt-v1\n" +
      canonicalJsonTextV1({
        taskId: input.taskId,
        gateId: input.gateId,
        effectKind: input.effectKind,
        lineage: input.lineage,
      })
  );
}

/** A persisted execution-attempt/effect record. */
export interface ExecutionAttemptRecordV1 {
  readonly attemptKey: string;
  readonly taskId: string;
  readonly gateId: string;
  readonly effectKind: EngineExternalEffectKindV1;
  readonly lineage: number;
  readonly state: ExecutionAttemptStateV1;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** Short outcome code (never payloads, never key material). */
  readonly outcomeCode?: string;
}

export interface BeginExecutionAttemptInputV1 {
  readonly attemptKey: string;
  readonly taskId: string;
  readonly gateId: string;
  readonly effectKind: EngineExternalEffectKindV1;
  readonly lineage: number;
}

export interface EngineExecutionAttemptStoreV1 {
  /**
   * Persist the attempt record in state `pending` BEFORE the external effect
   * is initiated. Idempotent by attempt key: an existing record is returned
   * with `created: false` (recovery reads it, never overwrites it).
   */
  begin(
    input: BeginExecutionAttemptInputV1
  ): Promise<{ readonly created: boolean; readonly record: ExecutionAttemptRecordV1 }>;
  /**
   * Persist the terminal outcome. Only the FIRST terminal state is
   * authoritative — a repeat completion returns the stored record unchanged.
   */
  complete(
    attemptKey: string,
    state: "succeeded" | "failed",
    outcomeCode?: string
  ): Promise<ExecutionAttemptRecordV1>;
  /** Mark a pending attempt indeterminate (recovery could not prove it ran). */
  markIndeterminate(attemptKey: string): Promise<ExecutionAttemptRecordV1>;
  read(attemptKey: string): Promise<ExecutionAttemptRecordV1 | undefined>;
  /** All attempts under a gate, ordered by lineage. */
  listForGate(gateId: string): Promise<readonly ExecutionAttemptRecordV1[]>;
  /** Every still-open (`pending`) attempt for a task — the recovery worklist. */
  listOpenForTask(taskId: string): Promise<readonly ExecutionAttemptRecordV1[]>;
}

/** In-memory reference implementation (tests / single-process dev). */
export function createInMemoryExecutionAttemptStoreV1(options?: {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}): EngineExecutionAttemptStoreV1 {
  const now = options?.now ?? ((): Date => new Date());
  const attempts = new Map<string, ExecutionAttemptRecordV1>();

  function terminal(
    attemptKey: string,
    state: "succeeded" | "failed" | "indeterminate",
    outcomeCode?: string
  ): Promise<ExecutionAttemptRecordV1> {
    const record = attempts.get(attemptKey);
    if (record === undefined) {
      return Promise.reject(new Error(`no execution attempt exists for key ${attemptKey}`));
    }
    if (record.state !== "pending") {
      // First terminal state wins; repeats are idempotent no-ops.
      return Promise.resolve(record);
    }
    const next: ExecutionAttemptRecordV1 = {
      ...record,
      state,
      completedAt: now().toISOString(),
      ...(outcomeCode !== undefined ? { outcomeCode } : {}),
    };
    attempts.set(attemptKey, next);
    return Promise.resolve(next);
  }

  return {
    begin(
      input: BeginExecutionAttemptInputV1
    ): Promise<{ readonly created: boolean; readonly record: ExecutionAttemptRecordV1 }> {
      const existing = attempts.get(input.attemptKey);
      if (existing !== undefined) {
        return Promise.resolve({ created: false, record: existing });
      }
      const record: ExecutionAttemptRecordV1 = {
        attemptKey: input.attemptKey,
        taskId: input.taskId,
        gateId: input.gateId,
        effectKind: input.effectKind,
        lineage: input.lineage,
        state: "pending",
        startedAt: now().toISOString(),
      };
      attempts.set(input.attemptKey, record);
      return Promise.resolve({ created: true, record });
    },

    complete(
      attemptKey: string,
      state: "succeeded" | "failed",
      outcomeCode?: string
    ): Promise<ExecutionAttemptRecordV1> {
      return terminal(attemptKey, state, outcomeCode);
    },

    markIndeterminate(attemptKey: string): Promise<ExecutionAttemptRecordV1> {
      return terminal(attemptKey, "indeterminate", "recoveryIndeterminate");
    },

    read(attemptKey: string): Promise<ExecutionAttemptRecordV1 | undefined> {
      return Promise.resolve(attempts.get(attemptKey));
    },

    listForGate(gateId: string): Promise<readonly ExecutionAttemptRecordV1[]> {
      const matches: ExecutionAttemptRecordV1[] = [];
      for (const record of attempts.values()) {
        if (record.gateId === gateId) {
          matches.push(record);
        }
      }
      matches.sort((a, b) => a.lineage - b.lineage);
      return Promise.resolve(matches);
    },

    listOpenForTask(taskId: string): Promise<readonly ExecutionAttemptRecordV1[]> {
      const matches: ExecutionAttemptRecordV1[] = [];
      for (const record of attempts.values()) {
        if (record.taskId === taskId && record.state === "pending") {
          matches.push(record);
        }
      }
      matches.sort((a, b) => a.lineage - b.lineage);
      return Promise.resolve(matches);
    },
  };
}
