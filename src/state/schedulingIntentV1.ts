import * as vscode from "vscode";
import { normalizePath } from "../utils/taskRoot";
import { getExtensionContextV1 } from "../utils/extensionContextV1";
import { HandoffGuidanceFieldsV1 } from "../types/handoffGuidanceV1";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

/**
 * The scheduling-intent ledger (task: "Actionable Hand-offs", PART 6).
 *
 * The workflow starts rounds on its own — 12 `scheduleAutomationChain` call
 * sites across six files, all funnelled through the single chokepoint in
 * `src/utils/automationChain.ts` — and until this module existed, nothing
 * recorded that intent anywhere durable. Identical, fully-determined
 * behaviour therefore read as arbitrary: the operator could not tell whether
 * a round about to start was scheduled, already running, or whether nothing
 * was scheduled at all and the system was waiting on them.
 *
 * This module is the source of truth those questions are answered from. Each
 * entry is a lifecycle: `scheduled` (dispatch recorded, timer/lock pending)
 * -> `running` (the chain fired) -> a terminal state (`completed` /
 * `cancelled` / `expired`). `deriveSchedulingPostureV1` reduces a task's
 * entries plus the live in-flight-operation registry into exactly one of
 * five mutually-exclusive postures, in the plan's own precedence order.
 *
 * Best-effort throughout, mirroring `workflowDecisionDispatchV1.ts`'s
 * pattern: every write goes through `getExtensionContextV1()` and swallows
 * its own failure rather than ever masking the caller's real outcome (a
 * chain that fails to dispatch because ledger instrumentation threw would be
 * a strictly worse defect than the one this module fixes).
 */

export type SchedulingIntentLifecycleStateV1 =
  | "scheduled"
  | "running"
  | "completed"
  | "cancelled"
  | "expired";

export interface SchedulingIntentTransitionV1 {
  readonly state: SchedulingIntentLifecycleStateV1;
  readonly at: string;
}

/** Metadata a caller supplies about ONE scheduled dispatch — the fields the
 * plan requires beyond the bare lifecycle: what caused it, what setting (if
 * any) controls it, roughly when it is expected, and whether the system will
 * retry on its own if it does not complete. */
export interface SchedulingIntentMetadataV1 {
  /** Human-readable cause, e.g. "auto-review after plan completes". */
  readonly trigger: string;
  /** The `ensemble.*` setting name that caused this dispatch. Omitted (never
   * fabricated) for a user-initiated or structural dispatch — the renderer
   * must say "not setting-driven", not invent a key. */
  readonly settingKey?: string;
  /** Human-readable expected timing, e.g. "once the current review round ends". */
  readonly expectedTiming?: string;
  /** Whether this class of work will automatically retry if it does not
   * complete on its own. */
  readonly willRetry: boolean;
  readonly retryNote?: string;
}

export interface SchedulingIntentV1 extends SchedulingIntentMetadataV1 {
  readonly intentId: string;
  readonly taskCanonicalId: string;
  readonly command: string;
  readonly chainId: string;
  readonly transitions: readonly SchedulingIntentTransitionV1[];
  readonly createdAt: string;
}

/**
 * The owed-continuation fact for the "owed but will not retry" posture.
 *
 * Review-flagged (2026-08-23) across three rounds. Status as of this round:
 * ALL NINE mutation sites now push through
 * `syncOwedContinuationLedgerBestEffortV1` right after their own CAS
 * resolves (never from inside the CAS callback, which may re-run on a
 * retry):
 *
 *  - `implementationRecoveryV1.ts`: `beginImplementationRecoveryV1`
 *    establishes it; `claimImplRecoveryDispatchV1` flips `dispatch` from
 *    `"pending"` to `"dispatched"`; `escalateClaimedSummaryOnlyIfUnavailableV1`
 *    escalates `mode`.
 *  - `scheduleTaskResume.ts`: `armPendingImplRecoveries` pushes the
 *    freshly-claimed record when it re-arms a lease on sweep; `dispose()`
 *    pushes the released record on the same fire-and-forget chain as the
 *    lease-release write itself (this one CANNOT `await` — `dispose()` is
 *    synchronous — so it rides `.then()` on the same patch promise instead).
 *  - `taskProgressFieldPolicyV1.ts`'s `applyNextStagePolicyV1` /
 *    `applyMarkTaskDonePolicyV1` / `applyReopenPolicyV1` each unconditionally
 *    clear `implRecovery` on success; their row-action call sites
 *    (`nextStageRowV1.ts`, `markTaskDoneRowV1.ts`, `resumeTaskRowV1.ts`) push
 *    `undefined` right after their own CAS (`patched`) resolves.
 *  - `taskProgressTransforms.ts`'s `promotePendingImplReviewFiles` (clears it
 *    when a round produces a usable summary) — `reviewActions.ts` pushes
 *    `persistedAfterRun.implRecovery` right after that CAS resolves.
 *
 * `owedContinuationSourceV1` (exported from `implementationRecoveryV1.ts`) is
 * the one shared mapper every site above uses, so they all describe the
 * record identically.
 *
 * Render-path preference: both `chatView.ts`'s chat-header posture and
 * `taskTreeProvider.ts`'s tooltip computation (review-flagged 2026-08-23,
 * twice — `getChildren` was already `async`, so there was no synchronous
 * constraint forcing the earlier live-derivation shortcut) now derive from
 * `getOwedContinuation` (a genuine ledger READ, not the raw live-read value):
 * each performs its own fresh `TaskProgress` read first and pushes it through
 * `recordOwedContinuation` (the one thing no mutation site can substitute
 * for: a DIFFERENT window's direct file mutation, or a process that died
 * between its CAS and its own ledger push), then AWAITS that push and reads
 * the ledger back for the actual posture derivation. This satisfies AC5's
 * "rendered only from the ledger" contract while staying exactly as fresh as
 * a live read, since the ledger's value at that point IS that same read.
 */
export interface OwedContinuationRecordV1 {
  readonly taskCanonicalId: string;
  /** Plain-language statement of what is blocking, e.g. "a continuation round is owed". */
  readonly blocker: string;
  /** When the continuation was first recorded — available immediately, not
   * withheld for any grace period. */
  readonly surfacedAt: string;
  readonly leaseUntil?: string;
  readonly quarantinedFiles: readonly string[];
  /**
   * Whether the SYSTEM will automatically retry this continuation, derived
   * from the source record's `dispatch` state: a `"pending"` record is
   * re-armed and retried by the periodic recovery sweep
   * (`scheduleTaskResume.ts`'s `armPendingImplRecoveries`) once its lease
   * (if any) expires; a `"dispatched"` record already claimed a round and is
   * NEVER re-fired automatically — see that function's own doc comment.
   * Review-flagged (2026-08-23): this module previously claimed "will not
   * re-fire automatically" unconditionally, which was false for `"pending"`
   * records and could show a retryable continuation as needing manual
   * intervention.
   */
  readonly willRetry: boolean;
}

/** The minimal shape `deriveOwedContinuationRecordV1` needs from an
 * `ImplRecoveryV1` record plus its task's `pendingImplReviewFiles` — kept
 * generic (no `TaskProgress`/`ImplRecoveryV1` import) so this module has no
 * dependency on the task-progress type graph. */
export interface OwedContinuationSourceV1 {
  readonly reason: string;
  readonly at: string;
  readonly leaseUntil?: string;
  readonly quarantinedFiles: readonly string[];
  /** `ImplRecoveryV1.dispatch` — `"pending"` records are retried
   * automatically by the periodic sweep; `"dispatched"` records are not. */
  readonly dispatch: "pending" | "dispatched";
}

/** Derive the "continuation is owed" fact for one task from its live
 * `implRecovery` record, or `undefined` when no continuation is owed. Pure —
 * safe to call on every render, so the fact can never go stale the way the
 * 90-minute-withheld stale-dispatch surfacing did. Branches on `dispatch` so
 * a retryable `"pending"` record is never described as needing manual
 * intervention the way a dead `"dispatched"` record does. */
export function deriveOwedContinuationRecordV1(
  taskCanonicalId: string,
  source: OwedContinuationSourceV1 | undefined
): OwedContinuationRecordV1 | undefined {
  if (!source) {
    return undefined;
  }
  const willRetry = source.dispatch === "pending";
  return {
    taskCanonicalId: normalizePath(taskCanonicalId),
    blocker: willRetry
      ? `A continuation round is owed for this task (${source.reason}). It is queued and will be retried automatically once any existing lease clears.`
      : `A continuation round is owed for this task (${source.reason}). It will not re-fire automatically.`,
    surfacedAt: source.at,
    leaseUntil: source.leaseUntil,
    quarantinedFiles: source.quarantinedFiles,
    willRetry,
  };
}

/** Fragment-style (no trailing period, matching every other call site's
 * `trigger` convention) description of a retryable owed continuation, for the
 * "scheduled" posture it renders as — see `deriveSchedulingPostureV1`. */
function buildRetryingOwedTriggerV1(owed: OwedContinuationRecordV1): string {
  const filesClause =
    owed.quarantinedFiles.length > 0
      ? ` (${owed.quarantinedFiles.length} file(s) quarantined behind it: ${owed.quarantinedFiles.join(", ")})`
      : "";
  return `owed implementation continuation is queued and will be retried automatically${filesClause}`;
}

function latestTransitionV1(entry: SchedulingIntentV1): SchedulingIntentTransitionV1 | undefined {
  return entry.transitions[entry.transitions.length - 1];
}

function latestStateV1(entry: SchedulingIntentV1): SchedulingIntentLifecycleStateV1 {
  return latestTransitionV1(entry)?.state ?? "scheduled";
}

function latestTransitionAtMsV1(entry: SchedulingIntentV1): number {
  const at = latestTransitionV1(entry)?.at ?? entry.createdAt;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * How long an entry may sit in `scheduled` or `running` before it is treated
 * as abandoned and self-heals into `expired`. Reuses
 * `automationChain.ts`'s `DEFAULT_CHAIN_GUARD_TTL_MS` reasoning directly
 * (not re-derived): a chain deferred until a root operation ends can span a
 * full CLI run plus overhead, and that guard already settled on 2 hours as
 * clearly outside any legitimate span. Duplicated as a literal (not
 * imported) so this state module has no dependency on that utils module —
 * the two are independent instrumentation of the same chokepoint, not
 * layered on each other.
 */
export const SCHEDULING_INTENT_STALE_MS_V1 = 2 * 60 * 60 * 1000;

/** Retention: keep at least this many of a task's most recent entries
 * regardless of age... */
export const SCHEDULING_INTENT_RETENTION_COUNT_V1 = 20;
/** ...plus any entry still within this TTL of its last transition, so "why
 * did that round start" stays answerable for a reasonable window after the
 * intent settles, per the plan's retention requirement. */
export const SCHEDULING_INTENT_RETENTION_TTL_MS_V1 = 7 * 24 * 60 * 60 * 1000;

/**
 * Convert any entry stuck in `scheduled`/`running` past the staleness window
 * into `expired`. Self-healing, mirroring `automationChain.ts`'s
 * `pruneIfExpiredV1`: if the process that would have transitioned an entry
 * to `running` or to a terminal state dies first, the entry does not sit
 * forever claiming a live posture — it ages out into an explicit terminal
 * state, and posture derivation degrades to `unknown`/`owed` rather than a
 * stale `running`. Pure; callers persist the result themselves.
 */
export function pruneStaleSchedulingIntentsV1(
  entries: readonly SchedulingIntentV1[],
  now: number = Date.now(),
  staleMs: number = SCHEDULING_INTENT_STALE_MS_V1
): SchedulingIntentV1[] {
  return entries.map((entry) => {
    const state = latestStateV1(entry);
    if ((state === "scheduled" || state === "running") && now - latestTransitionAtMsV1(entry) > staleMs) {
      return {
        ...entry,
        transitions: [...entry.transitions, { state: "expired" as const, at: new Date(now).toISOString() }],
      };
    }
    return entry;
  });
}

/**
 * Bound per-task storage: keep the most recent `keepCount` entries
 * unconditionally, plus any older entry still within `ttlMs` of its last
 * transition. Terminal entries are RETAINED here, not deleted at terminal
 * state — the plan's explicit requirement, so an auto-started round's
 * explanation stays available after the intent that caused it has settled.
 */
export function applySchedulingIntentRetentionV1(
  entries: readonly SchedulingIntentV1[],
  now: number = Date.now(),
  keepCount: number = SCHEDULING_INTENT_RETENTION_COUNT_V1,
  ttlMs: number = SCHEDULING_INTENT_RETENTION_TTL_MS_V1
): SchedulingIntentV1[] {
  const byRecency = [...entries].sort((a, b) => latestTransitionAtMsV1(b) - latestTransitionAtMsV1(a));
  const kept = byRecency.filter((entry, index) => index < keepCount || now - latestTransitionAtMsV1(entry) <= ttlMs);
  return kept.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The five mutually-exclusive postures a task always shows exactly one of
 * (plan AC 5), in precedence order: running beats scheduled beats owed beats
 * waiting-for-you beats unknown. */
export type SchedulingPostureV1 =
  | {
      readonly kind: "running";
      readonly trigger?: string;
      readonly command?: string;
      readonly settingKey?: string;
      readonly expectedTiming?: string;
    }
  | {
      readonly kind: "scheduled";
      readonly trigger: string;
      readonly expectedTiming?: string;
      readonly settingKey?: string;
    }
  | {
      readonly kind: "owedWillNotRetry";
      readonly blocker: string;
      readonly surfacedAt: string;
      readonly leaseUntil?: string;
      readonly quarantinedFiles: readonly string[];
      /**
       * Review-flagged (2026-08-23): always `false` for this posture now. A
       * retryable (`"pending"`) source record no longer reaches this branch
       * at all — `deriveSchedulingPostureV1` routes it to `"scheduled"`
       * instead, since "owed-but-will-not-retry" cannot truthfully describe
       * a continuation the system already intends to retry. The field is
       * kept (rather than dropped) for API stability with existing readers
       * that narrow on it.
       */
      readonly willRetry: boolean;
    }
  | { readonly kind: "waitingForYou" }
  | { readonly kind: "unknown" };

export interface DeriveSchedulingPostureInputV1 {
  readonly entries: readonly SchedulingIntentV1[];
  readonly owedContinuation?: OwedContinuationRecordV1;
  /** True when a task's live exclusive operation is currently running
   * (`taskOperations.rootOperationIdFor`) — authoritative for "executing
   * now" even when no ledger entry exists for it (a missed write must never
   * hide a live round). */
  readonly inFlight: boolean;
  /** Whether this task has ever passed through the scheduling chokepoint (or
   * was otherwise marked covered). Without this, an empty ledger is
   * indistinguishable from "never observed" and must never be read as
   * positive evidence that the user owns the next action. */
  readonly hasCoverage: boolean;
  /**
   * True when the caller could NOT determine whether a continuation is owed
   * — e.g. `TaskProgress` failed to read (review-flagged 2026-08-23: an
   * unreadable/invalid progress read was previously treated as "no
   * continuation is owed", which is absence of evidence, not evidence of
   * absence, and could render the false-positive `waitingForYou` posture on
   * a task that may in fact be blocked on an owed continuation). When set,
   * `owedContinuation` MUST be `undefined` — this forces the posture to the
   * explicit `unknown` fallback rather than falling through to
   * `waitingForYou`, per the plan's "absence of a record is never treated as
   * positive evidence" rule.
   */
  readonly owedContinuationUnknown?: boolean;
  readonly now?: number;
}

/**
 * Reduce one task's ledger entries plus live state into exactly one posture,
 * per the plan's precedence: running > scheduled > owed-but-will-not-retry >
 * waiting-for-you > unknown. `waitingForYou` additionally requires positive
 * evidence on every clause (coverage marker present, no scheduled/running
 * entry, no in-flight operation, no owed continuation) — absence alone is
 * never sufficient, so an uncovered/never-observed task reports `unknown`
 * instead of falsely reassuring the operator that nothing is happening.
 */
export function deriveSchedulingPostureV1(input: DeriveSchedulingPostureInputV1): SchedulingPostureV1 {
  const now = input.now ?? Date.now();
  const pruned = pruneStaleSchedulingIntentsV1(input.entries, now);
  const runningEntry = pruned.find((entry) => latestStateV1(entry) === "running");
  if (runningEntry || input.inFlight) {
    return {
      kind: "running",
      trigger: runningEntry?.trigger,
      command: runningEntry?.command,
      settingKey: runningEntry?.settingKey,
      expectedTiming: runningEntry?.expectedTiming,
    };
  }
  const scheduledEntry = pruned.find((entry) => latestStateV1(entry) === "scheduled");
  if (scheduledEntry) {
    return {
      kind: "scheduled",
      trigger: scheduledEntry.trigger,
      expectedTiming: scheduledEntry.expectedTiming,
      settingKey: scheduledEntry.settingKey,
    };
  }
  if (input.owedContinuation) {
    if (!input.owedContinuation.willRetry) {
      return {
        kind: "owedWillNotRetry",
        blocker: input.owedContinuation.blocker,
        surfacedAt: input.owedContinuation.surfacedAt,
        leaseUntil: input.owedContinuation.leaseUntil,
        quarantinedFiles: input.owedContinuation.quarantinedFiles,
        willRetry: false,
      };
    }
    // Review-flagged (2026-08-23): a retryable ("pending") owed continuation
    // is not "owed-but-will-not-retry" — by AC5's own definition that posture
    // means exactly what its name says. It belongs under "scheduled": the
    // system already intends to act on its own (the periodic recovery sweep,
    // or the in-process chain `beginImplementationRecoveryV1` itself just
    // dispatched), which is only reached here at all in the narrow gap where
    // no live ledger entry for that dispatch exists yet (e.g. it was dropped
    // as a duplicate, or the process restarted before the sweep re-armed it).
    // Quarantine/lease detail is folded into the trigger text since the
    // "scheduled" posture has no dedicated fields for them.
    return {
      kind: "scheduled",
      trigger: buildRetryingOwedTriggerV1(input.owedContinuation),
      expectedTiming: input.owedContinuation.leaseUntil
        ? `once the current lease clears (${new Date(input.owedContinuation.leaseUntil).toLocaleString()})`
        : "once the periodic recovery sweep re-arms it",
    };
  }
  if (input.owedContinuationUnknown) {
    // Whether a continuation is owed is exactly the fact this render could
    // not establish — never fall through to `waitingForYou`, which asserts
    // the opposite (nothing is owed) on no positive evidence at all.
    return { kind: "unknown" };
  }
  if (input.hasCoverage) {
    return { kind: "waitingForYou" };
  }
  return { kind: "unknown" };
}

/**
 * Render one posture into the `scheduledWork` surface's required fields
 * (reason / failureSignal / gating — `HANDOFF_REQUIRED_FIELDS_V1.scheduledWork`
 * in `src/types/handoffGuidanceV1.ts`), so the "what happens next" line every
 * task always shows (plan AC 5) goes through the same shared contract as
 * every other hand-off surface rather than inventing its own wording.
 * Callers render this through `renderRequiredHandoffFieldsV1("scheduledWork", ...)`.
 */
export function describeSchedulingPostureV1(posture: SchedulingPostureV1): HandoffGuidanceFieldsV1 {
  switch (posture.kind) {
    case "running": {
      const settingClause = posture.settingKey
        ? ` (controlled by \`${posture.settingKey}\`)`
        : posture.trigger
          ? " (not setting-driven)"
          : "";
      return {
        reason: posture.trigger
          ? `A round is running now for this task: ${posture.trigger}${settingClause}.`
          : "A round is running now for this task.",
        failureSignal: {
          kind: "clearingSignal",
          detail: posture.expectedTiming
            ? `Expected ${posture.expectedTiming}. Will finish and update the task on its own.`
            : "Will finish and update the task on its own.",
        },
        gating: {
          holdsTaskPaused: false,
          unblocksProgress: false,
          detail: "The system is working — there is nothing to do until it finishes.",
        },
      };
    }
    case "scheduled": {
      const settingClause = posture.settingKey
        ? ` (controlled by \`${posture.settingKey}\`)`
        : " (not setting-driven)";
      return {
        reason: `${posture.trigger}${settingClause}.`,
        failureSignal: {
          kind: "clearingSignal",
          detail: posture.expectedTiming ? `Expected ${posture.expectedTiming}.` : "No specific timing recorded.",
        },
        gating: {
          holdsTaskPaused: false,
          unblocksProgress: false,
          detail: "The system will act on its own — there is nothing to do.",
        },
      };
    }
    case "owedWillNotRetry": {
      const retryDetail = posture.willRetry
        ? "It is queued and will be retried automatically."
        : "It will not re-fire automatically.";
      const filesDetail =
        posture.quarantinedFiles.length > 0
          ? `${posture.quarantinedFiles.length} file(s) are quarantined behind it: ${posture.quarantinedFiles.join(", ")}. `
          : "";
      return {
        reason: posture.blocker,
        failureSignal: {
          kind: "clearingSignal",
          detail: `${filesDetail}${retryDetail}`,
          clearsAt: posture.leaseUntil ? new Date(posture.leaseUntil).toLocaleString() : undefined,
        },
        gating: {
          holdsTaskPaused: false,
          unblocksProgress: !posture.willRetry,
          detail: posture.willRetry
            ? "The system will retry this on its own — no action needed unless it keeps failing."
            : "This needs you — rerun implementation manually, or wait for the lease to clear and resume.",
        },
      };
    }
    case "waitingForYou":
      return {
        reason: "Nothing is scheduled for this task right now.",
        failureSignal: { kind: "clearingSignal", detail: "Nothing will happen until you take an action." },
        gating: {
          holdsTaskPaused: false,
          unblocksProgress: false,
          detail: "This is waiting for you, not the system.",
        },
      };
    case "unknown":
      return {
        reason: "No scheduling record exists for this task yet.",
        failureSignal: { kind: "clearingSignal", detail: "Unknown — nothing has been recorded." },
        gating: {
          holdsTaskPaused: false,
          unblocksProgress: false,
          detail: "Unknown whether this is waiting on you or on the system.",
        },
      };
  }
}

const ENTRIES_KEY = "schedulingIntentEntriesV1";
const COVERAGE_KEY = "schedulingIntentCoverageV1";
const OWED_CONTINUATION_KEY = "schedulingIntentOwedContinuationV1";

/** Shared per-`Memento` change signal, same rationale as
 * `workflowDecisionStoreV1.ts`: two store instances over the same
 * `workspaceState` (tree provider, chat view) must observe each other's
 * writes. */
const changeEmitters = new WeakMap<vscode.Memento, vscode.EventEmitter<void>>();

function changeEmitterFor(state: vscode.Memento): vscode.EventEmitter<void> {
  let emitter = changeEmitters.get(state);
  if (!emitter) {
    emitter = new vscode.EventEmitter<void>();
    changeEmitters.set(state, emitter);
  }
  return emitter;
}

/** Persistent store for the scheduling-intent ledger, backed by a
 * `vscode.Memento` (mirrors `WorkflowDecisionStoreV1`'s Memento-backed
 * pattern: advisory UI state mirroring work tracked durably elsewhere, not
 * itself the source of truth for task progress). */
export class SchedulingIntentStoreV1 {
  readonly onDidChange: vscode.Event<void>;

  constructor(private readonly state: vscode.Memento) {
    this.onDidChange = changeEmitterFor(state).event;
  }

  private allEntries(): Record<string, SchedulingIntentV1[]> {
    return this.state.get<Record<string, SchedulingIntentV1[]>>(ENTRIES_KEY, {});
  }

  private async saveEntries(map: Record<string, SchedulingIntentV1[]>): Promise<void> {
    await this.state.update(ENTRIES_KEY, map);
    changeEmitterFor(this.state).fire();
  }

  private key(taskCanonicalId: string): string {
    return normalizePath(taskCanonicalId);
  }

  /**
   * This task's entries, with staleness pruning already applied (never
   * returns a stale `scheduled`/`running` entry as still live). When pruning
   * actually converts an entry to `expired`, that transition is also
   * persisted (fire-and-forget) so it becomes a stable, saved fact rather
   * than being silently re-derived — and never recorded anywhere — on every
   * read. Review-flagged (2026-08-23): the previous version returned only a
   * pruned COPY, so a task whose entries were never re-saved through
   * `recordScheduled`/`recordRunning`/`recordTerminal` could sit forever with
   * no persisted `expired` transition or timestamp. Stays synchronous: the
   * tree-tooltip and chat-header render paths call this inline.
   */
  listForTask(taskCanonicalId: string, now: number = Date.now()): readonly SchedulingIntentV1[] {
    const key = this.key(taskCanonicalId);
    const map = this.allEntries();
    const raw = map[key] ?? [];
    const pruned = pruneStaleSchedulingIntentsV1(raw, now);
    const changed =
      pruned.length !== raw.length ||
      pruned.some((entry, index) => entry.transitions.length !== raw[index]?.transitions.length);
    if (changed) {
      map[key] = pruned;
      void this.saveEntries(map);
    }
    return pruned;
  }

  /** Record a new `scheduled` entry, applying retention to the task's
   * existing entries first so storage stays bounded, and marking the task's
   * coverage marker (see `hasCoverage`). */
  async recordScheduled(
    input: {
      readonly taskCanonicalId: string;
      readonly command: string;
      readonly chainId: string;
    } & SchedulingIntentMetadataV1
  ): Promise<SchedulingIntentV1> {
    const key = this.key(input.taskCanonicalId);
    const now = Date.now();
    const entry: SchedulingIntentV1 = {
      intentId: crypto.randomUUID(),
      taskCanonicalId: key,
      command: input.command,
      chainId: input.chainId,
      trigger: input.trigger,
      settingKey: input.settingKey,
      expectedTiming: input.expectedTiming,
      willRetry: input.willRetry,
      retryNote: input.retryNote,
      transitions: [{ state: "scheduled", at: new Date(now).toISOString() }],
      createdAt: new Date(now).toISOString(),
    };
    const map = this.allEntries();
    const existing = applySchedulingIntentRetentionV1(pruneStaleSchedulingIntentsV1(map[key] ?? [], now), now);
    map[key] = [...existing, entry];
    await this.saveEntries(map);
    await this.markCoverage(input.taskCanonicalId);
    return entry;
  }

  private async transition(intentId: string, state: SchedulingIntentLifecycleStateV1): Promise<void> {
    const map = this.allEntries();
    for (const key of Object.keys(map)) {
      const list = map[key]!;
      const index = list.findIndex((entry) => entry.intentId === intentId);
      if (index !== -1) {
        const entry = list[index]!;
        list[index] = {
          ...entry,
          transitions: [...entry.transitions, { state, at: new Date().toISOString() }],
        };
        await this.saveEntries(map);
        return;
      }
    }
  }

  /** Transition an entry to `running` — written at chain fire time. */
  recordRunning(intentId: string): Promise<void> {
    return this.transition(intentId, "running");
  }

  /** Transition an entry to a terminal state. */
  recordTerminal(intentId: string, state: "completed" | "cancelled" | "expired"): Promise<void> {
    return this.transition(intentId, state);
  }

  /** Mark that this task has passed through the scheduling chokepoint at
   * least once — idempotent. Only a task carrying this marker may derive
   * `waitingForYou` from an otherwise-empty ledger (see
   * `deriveSchedulingPostureV1`); without it the posture is explicit
   * `unknown`, because an empty ledger on a task that has never been
   * observed is not evidence the ledger is complete. */
  async markCoverage(taskCanonicalId: string): Promise<void> {
    const key = this.key(taskCanonicalId);
    const set = this.state.get<string[]>(COVERAGE_KEY, []);
    if (!set.includes(key)) {
      await this.state.update(COVERAGE_KEY, [...set, key]);
      changeEmitterFor(this.state).fire();
    }
  }

  hasCoverage(taskCanonicalId: string): boolean {
    return this.state.get<string[]>(COVERAGE_KEY, []).includes(this.key(taskCanonicalId));
  }

  private allOwedContinuations(): Record<string, OwedContinuationSourceV1> {
    return this.state.get<Record<string, OwedContinuationSourceV1>>(OWED_CONTINUATION_KEY, {});
  }

  /**
   * Write (or clear, with `source: undefined`) the persisted owed-continuation
   * fact for one task (plan PART 6.5: "`implementationRecoveryV1` writes the
   * owed-continuation fact ... into the ledger at dispatch time").
   *
   * All nine `implRecovery` mutation sites (`implementationRecoveryV1.ts` ×3,
   * `scheduleTaskResume.ts` ×2, `taskProgressFieldPolicyV1.ts` ×3 via three
   * row-action call sites, `taskProgressTransforms.ts`'s
   * `promotePendingImplReviewFiles` ×1 via `reviewActions.ts` — see
   * `OwedContinuationRecordV1`'s doc comment for the full list) now push here
   * directly right after their own CAS resolves. `chatView.ts`'s chat-header
   * render additionally self-heals this ledger from its own fresh
   * `TaskProgress` read on every render (the one case no mutation site can
   * substitute for: a different window's direct file mutation, or a process
   * that died between committing its CAS and running its own push) and then
   * reads THIS store back for the actual posture derivation — see that call
   * site's comment. `taskTreeProvider.ts`'s tooltip computation (review-flagged
   * 2026-08-23, twice; `getChildren` is `async`, so this was always awaitable)
   * now does the same: it pushes its own fresh `TaskProgress` read through
   * here, then reads this store back for the actual posture derivation,
   * rather than deriving from the live read directly.
   */
  async recordOwedContinuation(
    taskCanonicalId: string,
    source: OwedContinuationSourceV1 | undefined
  ): Promise<void> {
    const key = this.key(taskCanonicalId);
    const map = this.allOwedContinuations();
    const existing = map[key];
    const unchanged =
      (existing === undefined && source === undefined) ||
      (existing !== undefined && source !== undefined && JSON.stringify(existing) === JSON.stringify(source));
    if (unchanged) {
      return;
    }
    if (source === undefined) {
      delete map[key];
    } else {
      map[key] = source;
    }
    await this.state.update(OWED_CONTINUATION_KEY, map);
    changeEmitterFor(this.state).fire();
  }

  /** The last-persisted owed-continuation fact for one task, or `undefined`
   * if none is recorded (never observed, or last observation was "not
   * owed"). Now the AUTHORITATIVE source for rendering (see
   * `recordOwedContinuation`'s doc comment): every mutation site pushes
   * through it directly, and both async render paths (`chatView.ts`'s
   * chat-header, `taskTreeProvider.ts`'s tooltip) push their own fresh read
   * through and await it before reading this back, so each sees a value
   * exactly as fresh as a live read. A caller that has NOT just pushed should
   * still prefer its own fresh `TaskProgress` read when one is cheaply
   * available, since this only reflects whichever push last landed. */
  getOwedContinuation(taskCanonicalId: string): OwedContinuationSourceV1 | undefined {
    return this.allOwedContinuations()[this.key(taskCanonicalId)];
  }

  /** Drop every persisted entry/coverage marker belonging to one task
   * (mirrors `WorkflowDecisionStoreV1.removeForTask`), for archival cleanup. */
  async removeForTask(taskCanonicalId: string): Promise<void> {
    const key = this.key(taskCanonicalId);
    const map = this.allEntries();
    let changed = false;
    if (key in map) {
      delete map[key];
      changed = true;
    }
    const coverage = this.state.get<string[]>(COVERAGE_KEY, []);
    const nextCoverage = coverage.filter((entry) => entry !== key);
    const owed = this.allOwedContinuations();
    const hadOwed = key in owed;
    if (hadOwed) {
      delete owed[key];
    }
    if (changed) {
      await this.saveEntries(map);
    }
    if (nextCoverage.length !== coverage.length) {
      await this.state.update(COVERAGE_KEY, nextCoverage);
      changeEmitterFor(this.state).fire();
    }
    if (hadOwed) {
      await this.state.update(OWED_CONTINUATION_KEY, owed);
      changeEmitterFor(this.state).fire();
    }
  }
}

// --- Best-effort chokepoint helpers -----------------------------------
//
// `src/utils/automationChain.ts` is the single dispatch chokepoint all 12
// scheduling call sites already use, but it has no natural access to a
// `vscode.ExtensionContext` (it is called from deep in command handlers with
// only an `AutomationDispatch` and an optional root-operation handle). These
// mirror `workflowDecisionDispatchV1.ts`'s escape hatch: read the
// process-wide activating context via `getExtensionContextV1()`, and treat
// its absence (or any store failure) as "nothing to record" rather than
// throwing — this instrumentation must never be able to break a real
// dispatch. Unscoped dispatches (no `taskKey`) are skipped entirely, mirroring
// `automationChain.ts`'s own duplicate-guard, which is likewise a no-op for
// them.

function storeFromActivatingContext(): SchedulingIntentStoreV1 | undefined {
  const context = getExtensionContextV1();
  return context ? new SchedulingIntentStoreV1(context.workspaceState) : undefined;
}

/** The same fallback metadata `recordScheduledIntentBestEffortV1` and
 * `announceAutoStartBestEffortV1` must agree on for an un-enriched call
 * site, factored out once so the ledger entry and the chat announcement can
 * never drift into describing the same dispatch differently. */
function resolveIntentMetadataV1(command: string, intent?: SchedulingIntentMetadataV1): SchedulingIntentMetadataV1 {
  return (
    intent ?? {
      trigger: `automation chain: ${command}`,
      willRetry: false,
      retryNote: "Generic chokepoint entry — this call site has not been enriched with retry policy yet.",
    }
  );
}

/** Record a `scheduled` entry for one chokepoint dispatch, returning its
 * `intentId` for the follow-up `running`/terminal calls, or `undefined` when
 * nothing could be (or needed to be) recorded. */
export async function recordScheduledIntentBestEffortV1(input: {
  readonly taskKey: string | undefined;
  readonly command: string;
  readonly chainId: string;
  readonly intent?: SchedulingIntentMetadataV1;
}): Promise<string | undefined> {
  if (!input.taskKey) {
    return undefined;
  }
  const store = storeFromActivatingContext();
  if (!store) {
    return undefined;
  }
  const metadata = resolveIntentMetadataV1(input.command, input.intent);
  try {
    const entry = await store.recordScheduled({
      taskCanonicalId: input.taskKey,
      command: input.command,
      chainId: input.chainId,
      ...metadata,
    });
    return entry.intentId;
  } catch {
    return undefined;
  }
}

/** Pure text formatter for the auto-start announcement, factored out of
 * `announceAutoStartBestEffortV1` so the wording is unit-testable without
 * mocking the extension-context/file-store plumbing the effectful wrapper
 * needs. Naming both the trigger and the controlling setting (or explicitly
 * "not setting-driven") is the plan's own requirement — see
 * `describeSchedulingPostureV1`'s `settingClause`, which this mirrors. */
export function buildAutoStartAnnouncementTextV1(metadata: SchedulingIntentMetadataV1): string {
  // Always states provenance explicitly — either the controlling setting or
  // "not setting-driven" — never silence (review-flagged 2026-08-23: the
  // prior version rendered no clause at all for a not-setting-driven
  // dispatch, which reads as an omission rather than the deliberate "this is
  // structural, not a fabricated setting" statement the plan requires; see
  // `describeSchedulingPostureV1`'s identical "scheduled" branch, which this
  // mirrors).
  const settingClause = metadata.settingKey ? ` (controlled by \`${metadata.settingKey}\`)` : " (not setting-driven)";
  return `_Auto-starting: ${metadata.trigger}${settingClause}._`;
}

/**
 * Best-effort persisted announcement for an auto-started round (task
 * "Actionable Hand-offs", PART 6: "announce before acting, not after" — a
 * round that starts on its own should say so as it starts, naming the
 * trigger and the setting that controls it, not leave the operator to infer
 * it from a spinner). Appends one assistant-role message to the task's chat
 * transcript the moment a chain actually starts running, so the explanation
 * survives in task history after the ledger entry itself moves on to
 * `running`/terminal — the tooltip's "what happens next" line is transient
 * (it describes the CURRENT posture), this is the durable record of why a
 * specific round began.
 *
 * Callers MUST await this before the command it announces actually executes
 * (review-flagged 2026-08-23: the previous fire-and-forget version let
 * `deps.execute` run — and the round's own chat writes land — before this
 * announcement's write had even started, so "announce before acting" was not
 * actually guaranteed, and the announcement itself used a read-then-write
 * pair with no protection against a concurrent chat writer). Uses
 * `appendChatMessageV1`, which re-reads and retries on a concurrent-write
 * conflict rather than ever overwriting a newer transcript with a stale one.
 * Still best-effort in outcome — a failure here must never block or fail the
 * actual dispatch, so every failure is swallowed rather than thrown.
 */
export async function announceAutoStartBestEffortV1(input: {
  readonly taskKey: string | undefined;
  readonly command: string;
  readonly intent?: SchedulingIntentMetadataV1;
}): Promise<void> {
  if (!input.taskKey) {
    return;
  }
  try {
    // `ChatMessage.stage` may be `null` ONLY on a `legacyRecovery` record
    // (see chatHistoryStore.ts's `validateMessages`); every other message —
    // including this announcement — MUST carry a real `TaskStage` or the
    // decoder rejects the whole document on the next read, quarantining the
    // transcript (review-flagged 2026-08-23: the previous version wrote
    // `stage: null` unconditionally here, which is exactly that invalid
    // shape). Read the task's current stage fresh rather than threading it
    // through every one of the 12 `scheduleAutomationChain` call sites.
    const progressResult = await readTaskProgressStrictV1(vscode.Uri.file(input.taskKey));
    if (!progressResult.ok) {
      // Cannot establish a valid stage to stamp the message with — skip the
      // announcement rather than write a document the next read would
      // reject. Still best-effort: never blocks dispatch.
      return;
    }
    const metadata = resolveIntentMetadataV1(input.command, input.intent);
    const text = buildAutoStartAnnouncementTextV1(metadata);
    await appendChatMessageV1(
      input.taskKey,
      { role: "assistant", text, stage: progressResult.decoded.progress.currentStage, at: new Date().toISOString() },
      input.taskKey
    );
  } catch {
    // Best-effort — never surfaces to the caller, never blocks dispatch.
  }
}

/** Best-effort `running` transition; a no-op when `intentId` is `undefined`
 * (nothing was recorded at schedule time) or the context is unavailable. */
export async function recordRunningIntentBestEffortV1(intentId: string | undefined): Promise<void> {
  if (!intentId) {
    return;
  }
  const store = storeFromActivatingContext();
  if (!store) {
    return;
  }
  try {
    await store.recordRunning(intentId);
  } catch {
    // Best-effort instrumentation — never surfaces to the caller.
  }
}

/** Best-effort terminal transition; same no-op rules as
 * `recordRunningIntentBestEffortV1`. */
export async function recordTerminalIntentBestEffortV1(
  intentId: string | undefined,
  state: "completed" | "cancelled"
): Promise<void> {
  if (!intentId) {
    return;
  }
  const store = storeFromActivatingContext();
  if (!store) {
    return;
  }
  try {
    await store.recordTerminal(intentId, state);
  } catch {
    // Best-effort instrumentation — never surfaces to the caller.
  }
}

/**
 * Best-effort write-through of the owed-continuation fact into the ledger
 * (`SchedulingIntentStoreV1.recordOwedContinuation`'s doc comment has the
 * full picture). `taskKey` is the same `TaskProgress.ownership`-derived
 * canonical id every other scheduling-intent call uses; a `undefined`/empty
 * key is a no-op, matching every other best-effort helper in this section.
 * Never throws — a failure to instrument the ledger must never surface as a
 * failure of the caller's real operation (establishing/claiming/escalating
 * an implementation recovery, or rendering a task's posture).
 */
export async function syncOwedContinuationLedgerBestEffortV1(
  taskKey: string | undefined,
  source: OwedContinuationSourceV1 | undefined
): Promise<void> {
  if (!taskKey) {
    return;
  }
  const store = storeFromActivatingContext();
  if (!store) {
    return;
  }
  try {
    await store.recordOwedContinuation(taskKey, source);
  } catch {
    // Best-effort instrumentation — never surfaces to the caller.
  }
}
