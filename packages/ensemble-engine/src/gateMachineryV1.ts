/**
 * Gate machinery and the crash-safe external-effect protocol (plan Part 4c).
 *
 * Pause/approve/deny as a durable state machine with exactly-once
 * transitions, on top of the storage-agnostic Part 5 store interfaces:
 *
 * - **Gates consume persisted decision records, never in-memory signals.**
 *   `openGate` persists a pending gate (with the unified diff of the
 *   proposed changes for review, wired into the 4a event streams as a
 *   `gateRequested` notification + `gateStateChanged`); `decide` applies the
 *   store's CAS under the (owner, gate, idempotency key) contract and emits
 *   `gateStateChanged` exactly once per real transition — a replayed command
 *   returns the stored outcome and emits nothing.
 * - **A decision for an already-resumed gate is a no-op.** Consumption is an
 *   exactly-once CAS on the gate row (`markResumed`); replayed decisions
 *   after resume read back the stored outcome and nothing re-executes.
 * - **The lease alone is not the duplicate-execution guarantee.** Resumption
 *   runs under the Part 5 single-worker lease, but safety across crashes
 *   comes from the durable execution-attempt protocol: an attempt record
 *   with a DETERMINISTIC external idempotency key is persisted BEFORE the
 *   external call, and the outcome is persisted after. On recovery the
 *   acquiring worker reads open attempt records BEFORE doing anything:
 *   - platform supports idempotency/at-most-once → re-issue with the SAME
 *     key (safe replay);
 *   - otherwise → reconcile against observable provider/sandbox state and
 *     adopt or re-issue accordingly;
 *   - genuinely indeterminate → the attempt is marked `indeterminate`,
 *     surfaced as a typed `indeterminateAttempt` event, and RE-ENTERS THE
 *     GATE FLOW as a fresh pending re-offer gate for explicit user
 *     re-approval — never silently re-executed.
 *
 * Crash injection for the three persistence-to-external-effect boundaries
 * (before attempt persist; after persist, before call; after call, before
 * outcome persist) needs no special production hooks: a crash at each
 * boundary is a throw from `attemptStore.begin`, from the effect body before
 * its side effect registers, or from `attemptStore.complete` — the record
 * (or its absence) is exactly what a killed process would leave behind, and
 * the tests drive recovery through this module's public surface.
 */
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type { GateDecisionCommandV1 } from "../../ensemble-core/src/gateV1";
import type { ExecutionAttemptStateV1 } from "../../ensemble-core/src/gateV1";
import { EngineEventSinkV1 } from "./engineEventsV1";
import {
  createInMemoryExecutionAttemptStoreV1,
  deriveExecutionAttemptKeyV1,
  EngineExecutionAttemptStoreV1,
  EngineExternalEffectKindV1,
  ExecutionAttemptRecordV1,
} from "./executionAttemptStoreV1";
import {
  createInMemoryGateStoreV1,
  EngineGateDecideResultV1,
  EngineGateRecordV1,
  EngineGateStoreV1,
} from "./gateStoreV1";
import { createInMemoryLeaseStoreV1, EngineLeaseStoreV1 } from "./leaseStoreV1";
import { buildUnifiedDiffV1, EngineFileChangeV1 } from "./unifiedDiffV1";

/** Outcome of one external effect call. */
export interface EngineEffectOutcomeV1 {
  readonly status: "succeeded" | "failed";
  /** Short outcome code (never payloads, never key material). */
  readonly code?: string;
}

export type EngineEffectReconcileVerdictV1 = "executed" | "notExecuted" | "unknown";

/**
 * One gated external effect. `execute` receives the deterministic attempt
 * key and MUST thread it into the external call where the platform accepts
 * idempotency keys (or as a command marker/metadata — Part 4d) so
 * reconciliation can identify the attempt.
 */
export interface EngineExternalEffectV1 {
  readonly effectKind: EngineExternalEffectKindV1;
  /**
   * True when the platform accepts the idempotency key with at-most-once
   * semantics, making re-issue with the SAME key a safe replay.
   */
  readonly supportsIdempotentReplay: boolean;
  execute(attemptKey: string): Promise<EngineEffectOutcomeV1>;
  /**
   * Consulted on recovery when replay is unsafe: query observable
   * provider/sandbox state (process/exit/audit records) for whether the
   * keyed attempt already ran. Absent ⇒ recovery treats the attempt as
   * `unknown` (indeterminate re-offer).
   */
  reconcile?(attemptKey: string): Promise<EngineEffectReconcileVerdictV1>;
}

/**
 * Result of running an ungated external effect (e.g. Part 4d source
 * acquisition) under the same attempt protocol and lease as gated
 * resumption. `stepId` plays the gate-id role in the deterministic key, so
 * a crashed step's successor derives the identical key and recovers instead
 * of re-running; a genuinely indeterminate attempt re-enters the gate flow
 * as a re-offer gate exactly like a gated one.
 */
export type EngineUngatedEffectResultV1 =
  | {
      readonly kind: "executed";
      readonly attemptKey: string;
      readonly outcome: EngineEffectOutcomeV1;
    }
  | {
      readonly kind: "recovered";
      readonly method: "replayedWithSameKey" | "reconciledAdoptedOutcome" | "reconciledReissued";
      readonly attemptKey: string;
      readonly outcome: EngineEffectOutcomeV1;
    }
  | {
      readonly kind: "indeterminate";
      readonly attemptKey: string;
      readonly reofferGateId: string;
    }
  | {
      /** A terminal attempt already exists for this step — nothing re-runs. */
      readonly kind: "alreadyExecuted";
      readonly attemptKey: string;
      readonly attemptState: ExecutionAttemptStateV1;
    }
  | {
      readonly kind: "leaseUnavailable";
      readonly holderWorkerId?: string;
    };

export type EngineGateResumeResultV1 =
  | {
      /** Fresh execution: exactly one external effect was initiated. */
      readonly kind: "executed";
      readonly attemptKey: string;
      readonly outcome: EngineEffectOutcomeV1;
    }
  | {
      /** Recovery resolved a crashed attempt without a duplicate effect. */
      readonly kind: "recovered";
      readonly method: "replayedWithSameKey" | "reconciledAdoptedOutcome" | "reconciledReissued";
      readonly attemptKey: string;
      readonly outcome: EngineEffectOutcomeV1;
    }
  | {
      /**
       * Recovery could not prove the attempt executed-or-not: it is marked
       * indeterminate and re-offered as a fresh pending gate. NOTHING was
       * re-executed.
       */
      readonly kind: "indeterminate";
      readonly attemptKey: string;
      readonly reofferGateId: string;
    }
  | {
      /** A terminal attempt already exists — the effect already happened. */
      readonly kind: "alreadyExecuted";
      readonly attemptKey: string;
      readonly attemptState: ExecutionAttemptStateV1;
    }
  | {
      /** The gate's decision was already consumed; nothing to do. */
      readonly kind: "alreadyResumed";
    }
  | { readonly kind: "rejectedGate" }
  | { readonly kind: "gateStillPending" }
  | { readonly kind: "gateNotFound" }
  | {
      /** Another worker holds the job lease; nothing was executed. */
      readonly kind: "leaseUnavailable";
      readonly holderWorkerId?: string;
    };

export interface OpenEngineGateInputV1 {
  readonly summary: string;
  /**
   * The proposed file changes under review; their unified diff is generated
   * here and persisted on the gate record for the read-only diff view.
   */
  readonly changes?: readonly EngineFileChangeV1[];
  readonly gateId?: string;
}

export interface CreateEngineGateMachineryOptionsV1 {
  readonly taskId: string;
  readonly ownerId: string;
  /** Stable identity of this engine worker (lease holder id). */
  readonly workerId: string;
  readonly sink: EngineEventSinkV1;
  /** Default: fresh in-memory stores (tests / single-process dev). */
  readonly gateStore?: EngineGateStoreV1;
  readonly attemptStore?: EngineExecutionAttemptStoreV1;
  readonly leaseStore?: EngineLeaseStoreV1;
  readonly now?: () => Date;
  /** Job-lease TTL for resumption; default 30s. */
  readonly leaseTtlMs?: number;
}

export interface EngineGateMachineryV1 {
  /** Persist a pending gate and announce it (diff + request notification). */
  openGate(input: OpenEngineGateInputV1): Promise<EngineGateRecordV1>;
  /**
   * Apply an approve/reject command for the machinery's owner; emits
   * `gateStateChanged` exactly once per real transition.
   */
  decide(command: GateDecisionCommandV1): Promise<EngineGateDecideResultV1>;
  /**
   * Consume an approved gate's persisted decision and run its external
   * effect under the crash-safe attempt protocol and the single-worker
   * lease. Safe to call again after any crash: recovery consults the
   * persisted attempt records before doing anything.
   */
  resumeApproved(gateId: string, effect: EngineExternalEffectV1): Promise<EngineGateResumeResultV1>;
  /**
   * Run an UNGATED external effect (Part 4d source acquisition, teardown
   * commands, …) under the identical crash-safe attempt protocol and
   * single-worker lease. `stepId` is the stable step identity the attempt
   * key derives from — the same step never executes twice, and an
   * indeterminate attempt re-enters the gate flow as a re-offer gate.
   */
  runUngatedEffect(
    stepId: string,
    effect: EngineExternalEffectV1
  ): Promise<EngineUngatedEffectResultV1>;
  readonly gateStore: EngineGateStoreV1;
  readonly attemptStore: EngineExecutionAttemptStoreV1;
  readonly leaseStore: EngineLeaseStoreV1;
}

const DEFAULT_LEASE_TTL_MS = 30_000;

export function createEngineGateMachineryV1(
  options: CreateEngineGateMachineryOptionsV1
): EngineGateMachineryV1 {
  const now = options.now ?? ((): Date => new Date());
  const gateStore = options.gateStore ?? createInMemoryGateStoreV1({ now });
  const attemptStore = options.attemptStore ?? createInMemoryExecutionAttemptStoreV1({ now });
  const leaseStore = options.leaseStore ?? createInMemoryLeaseStoreV1({ now });
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const { taskId, ownerId, workerId, sink } = options;

  function emitGateState(record: EngineGateRecordV1): void {
    sink.emit({
      type: "gateStateChanged",
      taskId: record.taskId,
      gateId: record.gateId,
      state: record.state,
    });
  }

  function emitGateRequested(record: EngineGateRecordV1): void {
    sink.emit({
      type: "notification",
      at: now().toISOString(),
      notification: {
        kind: "gateRequested",
        taskId: record.taskId,
        gateId: record.gateId,
        summary: record.summary,
      },
    });
  }

  async function announceGate(record: EngineGateRecordV1): Promise<EngineGateRecordV1> {
    emitGateState(record);
    emitGateRequested(record);
    return record;
  }

  async function completeAttempt(
    attemptKey: string,
    outcome: EngineEffectOutcomeV1
  ): Promise<void> {
    await attemptStore.complete(
      attemptKey,
      outcome.status,
      outcome.code ?? outcome.status
    );
  }

  /**
   * The recovery core shared by gated and ungated resumption: safe replay,
   * reconciliation, or marking the attempt indeterminate — never a silent
   * duplicate. Gate consumption / re-offer surfacing stay with the callers.
   */
  async function recoverViaAttemptProtocol(
    record: ExecutionAttemptRecordV1,
    effect: EngineExternalEffectV1
  ): Promise<
    | {
        readonly resolution: "recovered";
        readonly method: "replayedWithSameKey" | "reconciledAdoptedOutcome" | "reconciledReissued";
        readonly outcome: EngineEffectOutcomeV1;
      }
    | { readonly resolution: "indeterminate" }
  > {
    if (effect.supportsIdempotentReplay) {
      // The platform dedupes by the SAME deterministic key: re-issuing is a
      // safe replay whether or not the original call went out.
      const outcome = await effect.execute(record.attemptKey);
      await completeAttempt(record.attemptKey, outcome);
      return { resolution: "recovered", method: "replayedWithSameKey", outcome };
    }
    const verdict =
      effect.reconcile !== undefined ? await effect.reconcile(record.attemptKey) : "unknown";
    if (verdict === "executed") {
      const outcome: EngineEffectOutcomeV1 = { status: "succeeded", code: "reconciledExecuted" };
      await completeAttempt(record.attemptKey, outcome);
      return { resolution: "recovered", method: "reconciledAdoptedOutcome", outcome };
    }
    if (verdict === "notExecuted") {
      const outcome = await effect.execute(record.attemptKey);
      await completeAttempt(record.attemptKey, outcome);
      return { resolution: "recovered", method: "reconciledReissued", outcome };
    }
    await attemptStore.markIndeterminate(record.attemptKey);
    return { resolution: "indeterminate" };
  }

  /**
   * Surface an indeterminate attempt as a pending re-offer gate. Find-first
   * makes the sequence crash-repairable: a crash between marking the attempt
   * indeterminate and creating its re-offer gate is healed on the next
   * drive, which finds no re-offer for the attempt key and creates it then —
   * the explicit re-approval prompt is never lost.
   */
  async function findOrCreateReofferGate(
    attemptKey: string,
    diffUnified: string | undefined,
    contextLabel: string
  ): Promise<{ readonly record: EngineGateRecordV1; readonly created: boolean }> {
    const existing = (await gateStore.listForTask(taskId)).find(
      (candidate) => candidate.reofferOfAttemptKey === attemptKey
    );
    if (existing !== undefined) {
      return { record: existing, created: false };
    }
    const reoffer = await gateStore.create({
      taskId,
      ownerId,
      summary:
        `Re-approval required: a prior execution attempt for ${contextLabel} could not be ` +
        "proven executed-or-not after a crash. Approving runs the effect again as a new attempt.",
      ...(diffUnified !== undefined ? { diffUnified } : {}),
      reofferOfAttemptKey: attemptKey,
    });
    await announceGate(reoffer);
    sink.emit({
      type: "notification",
      at: now().toISOString(),
      notification: {
        kind: "indeterminateAttempt",
        taskId,
        gateId: reoffer.gateId,
        attemptKey,
      },
    });
    return { record: reoffer, created: true };
  }

  /**
   * Recovery for one open attempt record under a gate: safe replay,
   * reconciliation, or the indeterminate re-offer — never a silent duplicate.
   */
  async function recoverOpenAttempt(
    gate: EngineGateRecordV1,
    record: ExecutionAttemptRecordV1,
    effect: EngineExternalEffectV1
  ): Promise<EngineGateResumeResultV1> {
    const recovery = await recoverViaAttemptProtocol(record, effect);
    await gateStore.markResumed(gate.gateId);
    if (recovery.resolution === "recovered") {
      return {
        kind: "recovered",
        method: recovery.method,
        attemptKey: record.attemptKey,
        outcome: recovery.outcome,
      };
    }
    // Genuinely indeterminate: the original gate is consumed and the attempt
    // re-enters the gate flow as a fresh pending re-offer gate.
    const reoffer = await findOrCreateReofferGate(
      record.attemptKey,
      gate.diffUnified,
      `gate ${gate.gateId}`
    );
    return {
      kind: "indeterminate",
      attemptKey: record.attemptKey,
      reofferGateId: reoffer.record.gateId,
    };
  }

  async function resumeApprovedUnderLease(
    gateId: string,
    effect: EngineExternalEffectV1
  ): Promise<EngineGateResumeResultV1> {
    const gate = await gateStore.read(gateId);
    if (gate === undefined || gate.ownerId !== ownerId) {
      return { kind: "gateNotFound" };
    }
    if (gate.state === "pending") {
      return { kind: "gateStillPending" };
    }
    if (gate.state === "rejected") {
      // A rejected gate never executes anything; consume it exactly once.
      await gateStore.markResumed(gateId);
      return { kind: "rejectedGate" };
    }

    // RECOVERY FIRST: read persisted attempt records before doing anything.
    const attempts = await attemptStore.listForGate(gateId);
    const open = attempts.find((record) => record.state === "pending");
    if (open !== undefined) {
      return recoverOpenAttempt(gate, open, effect);
    }
    const terminalAttempt = attempts.find((record) => record.state !== "pending");
    if (terminalAttempt !== undefined) {
      // The effect already reached a terminal state (a crash may have landed
      // between outcome-persist and consumption): consume, never re-execute.
      await gateStore.markResumed(gateId);
      if (terminalAttempt.state === "indeterminate") {
        // Crash repair: an indeterminate attempt must always have a live
        // re-offer — a crash between marking it and creating the re-offer
        // gate would otherwise silently swallow the re-approval prompt.
        const reoffer = await findOrCreateReofferGate(
          terminalAttempt.attemptKey,
          gate.diffUnified,
          `gate ${gate.gateId}`
        );
        return {
          kind: "indeterminate",
          attemptKey: terminalAttempt.attemptKey,
          reofferGateId: reoffer.record.gateId,
        };
      }
      return {
        kind: "alreadyExecuted",
        attemptKey: terminalAttempt.attemptKey,
        attemptState: terminalAttempt.state,
      };
    }
    if (gate.resumedAt !== undefined) {
      return { kind: "alreadyResumed" };
    }

    // Fresh execution under the attempt protocol. The key is DETERMINISTIC:
    // a crash anywhere below re-derives the identical key on the next drive.
    const lineage = attempts.length;
    const attemptKey = deriveExecutionAttemptKeyV1({
      taskId: gate.taskId,
      gateId,
      effectKind: effect.effectKind,
      lineage,
    });
    // Boundary 1→2: the attempt record persists BEFORE the external call.
    await attemptStore.begin({
      attemptKey,
      taskId: gate.taskId,
      gateId,
      effectKind: effect.effectKind,
      lineage,
    });
    // Boundary 2→3: the external call. A crash here leaves the open record
    // for recovery; this module deliberately does not catch — an error
    // mid-call is indistinguishable from a crash until recovery inspects it.
    const outcome = await effect.execute(attemptKey);
    // Boundary 3: the outcome persists after the call.
    await completeAttempt(attemptKey, outcome);
    await gateStore.markResumed(gateId);
    return { kind: "executed", attemptKey, outcome };
  }

  async function runUngatedEffectUnderLease(
    stepId: string,
    effect: EngineExternalEffectV1
  ): Promise<EngineUngatedEffectResultV1> {
    // RECOVERY FIRST: the step's persisted attempt records decide everything.
    const attempts = await attemptStore.listForGate(stepId);
    const open = attempts.find((record) => record.state === "pending");
    if (open !== undefined) {
      const recovery = await recoverViaAttemptProtocol(open, effect);
      if (recovery.resolution === "recovered") {
        return {
          kind: "recovered",
          method: recovery.method,
          attemptKey: open.attemptKey,
          outcome: recovery.outcome,
        };
      }
      const reoffer = await findOrCreateReofferGate(open.attemptKey, undefined, `step ${stepId}`);
      return {
        kind: "indeterminate",
        attemptKey: open.attemptKey,
        reofferGateId: reoffer.record.gateId,
      };
    }
    const terminalAttempt = attempts.find((record) => record.state !== "pending");
    if (terminalAttempt !== undefined) {
      if (terminalAttempt.state === "indeterminate") {
        // Crash repair, exactly as in gated resumption: an indeterminate
        // attempt always gets its re-offer surfaced, never silently lost.
        const reoffer = await findOrCreateReofferGate(
          terminalAttempt.attemptKey,
          undefined,
          `step ${stepId}`
        );
        return {
          kind: "indeterminate",
          attemptKey: terminalAttempt.attemptKey,
          reofferGateId: reoffer.record.gateId,
        };
      }
      return {
        kind: "alreadyExecuted",
        attemptKey: terminalAttempt.attemptKey,
        attemptState: terminalAttempt.state,
      };
    }

    // Fresh execution under the attempt protocol — identical boundaries to
    // gated resumption: persist, call, persist outcome.
    const lineage = attempts.length;
    const attemptKey = deriveExecutionAttemptKeyV1({
      taskId,
      gateId: stepId,
      effectKind: effect.effectKind,
      lineage,
    });
    await attemptStore.begin({
      attemptKey,
      taskId,
      gateId: stepId,
      effectKind: effect.effectKind,
      lineage,
    });
    const outcome = await effect.execute(attemptKey);
    await completeAttempt(attemptKey, outcome);
    return { kind: "executed", attemptKey, outcome };
  }

  return {
    gateStore,
    attemptStore,
    leaseStore,

    async openGate(input: OpenEngineGateInputV1): Promise<EngineGateRecordV1> {
      const diffUnified =
        input.changes !== undefined ? buildUnifiedDiffV1(input.changes) : undefined;
      const record = await gateStore.create({
        gateId: input.gateId ?? allocateHex128IdV1(),
        taskId,
        ownerId,
        summary: input.summary,
        ...(diffUnified !== undefined && diffUnified.length > 0 ? { diffUnified } : {}),
      });
      return announceGate(record);
    },

    async decide(command: GateDecisionCommandV1): Promise<EngineGateDecideResultV1> {
      const result = await gateStore.decide(ownerId, command);
      if (result.kind === "decided") {
        // Exactly once per real transition; replays emit nothing.
        emitGateState(result.record);
      }
      return result;
    },

    async resumeApproved(
      gateId: string,
      effect: EngineExternalEffectV1
    ): Promise<EngineGateResumeResultV1> {
      const lease = await leaseStore.acquire(taskId, workerId, leaseTtlMs);
      if (!lease.acquired) {
        return {
          kind: "leaseUnavailable",
          ...(lease.holderWorkerId !== undefined
            ? { holderWorkerId: lease.holderWorkerId }
            : {}),
        };
      }
      try {
        return await resumeApprovedUnderLease(gateId, effect);
      } finally {
        await leaseStore.release(taskId, workerId);
      }
    },

    async runUngatedEffect(
      stepId: string,
      effect: EngineExternalEffectV1
    ): Promise<EngineUngatedEffectResultV1> {
      const lease = await leaseStore.acquire(taskId, workerId, leaseTtlMs);
      if (!lease.acquired) {
        return {
          kind: "leaseUnavailable",
          ...(lease.holderWorkerId !== undefined
            ? { holderWorkerId: lease.holderWorkerId }
            : {}),
        };
      }
      try {
        return await runUngatedEffectUnderLease(stepId, effect);
      } finally {
        await leaseStore.release(taskId, workerId);
      }
    },
  };
}
