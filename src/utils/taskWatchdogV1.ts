/**
 * A1's watchdog (1.0.0 gate, "the product never lies about whether it is
 * working"): detects the impossible state a task must never be able to
 * reach — `status: active` with no live operation, no owed continuation, and
 * no scheduled intent — and generalises across every route that can produce
 * it, not just the two named in the finding (an auto-advance discarding an
 * owed `implRecovery`, and a `dispatched` continuation whose round never
 * settled). By definition nothing else announces this state: every other
 * failure mode leaves SOME trace (an escalation, a paused status, a visible
 * error); this one is defined by producing nothing, so only a periodic check
 * can find it.
 *
 * Evidence is deliberately restricted to durable, cross-window state — the
 * persisted `roundLedger` (after this sweep's own orphan reconciliation has
 * already closed any row whose own identity is no longer live, see
 * `roundLedgerReconciliationV1.ts`), the persisted `implRecovery` record, the
 * persisted `scheduledRun`, and the scheduling-intent store
 * (`hasLiveSchedulingIntentBestEffortV1`). The in-process `taskOperations`
 * registry is deliberately NOT consulted here: it reflects only this
 * window's own in-memory state, and the watchdog's job is to find a task
 * that is durably stuck, not to race a single window's bookkeeping.
 */
import { ImplRecoveryV1, TaskProgress } from "../types/taskProgress";
import { hasLiveSchedulingIntentBestEffortV1 } from "../state/schedulingIntentV1";

/** True when this task's own persisted round ledger still has an open row. */
export function hasOpenRoundLedgerRowV1(progress: TaskProgress): boolean {
  return (progress.roundLedger ?? []).some(
    (row) => row.state === "scheduled" || row.state === "open"
  );
}

/**
 * A `dispatched` recovery record's lease dates from the transition, and the
 * round it covers can legitimately run for the full CLI timeout (60
 * minutes) — only well past that is silence evidence of a dead round. The
 * SINGLE definition of "stale," shared by the sweep's reclaim
 * (`scheduleTaskResume.ts`'s `armPendingImplRecoveries`) and the watchdog
 * predicate below (2026-09-04 review follow-up: previously duplicated
 * locally in the sweep, risking the two drifting apart).
 */
export const STALE_DISPATCH_GRACE_MS = 90 * 60 * 1000;

export function isStaleDispatchedImplRecoveryV1(recovery: ImplRecoveryV1, now: number): boolean {
  if (recovery.dispatch !== "dispatched") {
    return false;
  }
  const anchor = recovery.leaseUntil ?? recovery.at;
  return now > new Date(anchor).getTime() + STALE_DISPATCH_GRACE_MS;
}

/**
 * True when a stale `dispatched` record still carries enough evidence to
 * safely re-arm: which round it continues (`sourceRoundId`) and what change
 * set to quarantine (`pendingImplReviewFiles`, or an explicit
 * `filesChangedUnknown` admission that the set could not be enumerated —
 * still a recorded fact, not silent absence). Without both, re-dispatching a
 * continuation under this record's name would have no source round to link
 * back to and no known file set to hand the round — indistinguishable from
 * silently starting an unrelated fresh round.
 */
export function isReconstructableImplRecoveryV1(
  recovery: ImplRecoveryV1,
  progress: TaskProgress
): boolean {
  return (
    recovery.sourceRoundId !== undefined &&
    (progress.pendingImplReviewFiles !== undefined || recovery.filesChangedUnknown === true)
  );
}

export interface StalledActiveTaskCheckInputV1 {
  readonly progress: TaskProgress;
  /** The scheduling-intent store's task key — the same canonical id every
   * other scheduling-intent call in this codebase uses (task folder path). */
  readonly taskCanonicalId: string;
  /** Injectable clock, defaulting to `Date.now()` — lets tests set up a
   * `dispatched` record that is stale/not-stale without waiting on the wall
   * clock, mirroring the sweep's own injectable `SchedulerClock`. */
  readonly now?: number;
}

/**
 * True when this task's `implRecovery` is a dead end no automated pass can
 * bring back: a `dispatched` record that is stale by the grace rule above AND
 * has no reconstructable evidence to re-arm from. A `pending` record is owed
 * work about to be armed by the next sweep; a `dispatched` record still
 * within grace may legitimately be running the full CLI timeout elsewhere; a
 * stale-but-reconstructable `dispatched` record will be reclaimed to
 * `pending` by the very next sweep. Only the fourth combination has no path
 * back on its own.
 */
export function isUnrecoverableImplRecoveryV1(
  recovery: ImplRecoveryV1,
  progress: TaskProgress,
  now: number
): boolean {
  return isStaleDispatchedImplRecoveryV1(recovery, now) && !isReconstructableImplRecoveryV1(recovery, progress);
}

/**
 * The watchdog predicate itself. Intended to run AFTER a sweep's own round-
 * ledger reconciliation and `implRecovery` re-arm/reclaim passes have had a
 * chance to resolve anything resolvable — evaluated against whatever is left
 * once those passes are done, so a task this returns `true` for genuinely has
 * nothing left that could still bring it back to life on its own.
 */
export function isImpossibleActiveStateV1(input: StalledActiveTaskCheckInputV1): boolean {
  const { progress, taskCanonicalId } = input;
  const now = input.now ?? Date.now();
  if (progress.status !== "active") {
    return false;
  }
  if (hasOpenRoundLedgerRowV1(progress)) {
    return false;
  }
  if (progress.implRecovery !== undefined) {
    // A1's second route (2026-09-04 review follow-up, blocker
    // "isImpossibleActiveStateV1 exempts every recovery record"): a
    // `dispatched` record that is stale AND non-reconstructable has no path
    // back — it will never be reclaimed by the sweep (which requires the
    // same reconstructability evidence) and would otherwise shield the task
    // from detection forever. Every OTHER shape of `implRecovery` (pending,
    // or dispatched-and-still-live, or stale-but-reconstructable) is
    // genuinely owed/in-flight work and must keep exempting the task.
    if (!isUnrecoverableImplRecoveryV1(progress.implRecovery, progress, now)) {
      return false;
    }
  }
  if (progress.scheduledRun !== undefined || progress.scheduledResumeTime !== undefined) {
    return false;
  }
  // Fails OPEN to "live" when indeterminate (see the function's own doc
  // comment) — exactly the conservative direction the watchdog needs: it
  // must never pause a task that might actually be about to do something.
  if (hasLiveSchedulingIntentBestEffortV1(taskCanonicalId)) {
    return false;
  }
  return true;
}

/** The pause reason recorded when the watchdog moves a stalled task to `paused`. */
export const STALLED_ACTIVE_TASK_PAUSE_REASON_V1 =
  "Watchdog: this task was active with no live operation, no owed continuation, and " +
  "nothing scheduled — an impossible state that means work silently stopped. Resume it " +
  "once you've reviewed what happened; the task's stage actions are unaffected.";

/** The pause reason recorded when the watchdog closes out an unrecoverable
 * `implRecovery` record (A1's second route) rather than the generic
 * "nothing at all" case above — distinct wording because this case also
 * clears `implRecovery`, so resuming does not instantly re-trap the task. */
export const UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1 =
  "Watchdog: a recovery continuation for this task was dispatched but never finalized, and its " +
  "record has no source round or quarantined file set left to safely re-arm. Cleared so resuming " +
  "does not immediately re-trap the task; review the run log for what the round actually changed " +
  "before resuming.";

export function describeStalledActiveTaskEscalationV1(displayName: string): string {
  return (
    `⚠️ "${displayName}" was stalled — active with nothing running, owed, or scheduled. ` +
    "Paused with an escalation so this is visible instead of silent; resume it from the task's stage actions once you've reviewed what happened."
  );
}

export function describeUnrecoverableRecoveryEscalationV1(displayName: string): string {
  return (
    `⚠️ "${displayName}" had a stalled recovery continuation with no source round or file set to ` +
    "safely re-arm, so it could not be reclaimed. Paused with an escalation; review the run log " +
    "before resuming."
  );
}
