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
import { TaskProgress } from "../types/taskProgress";
import { hasLiveSchedulingIntentBestEffortV1 } from "../state/schedulingIntentV1";

/** True when this task's own persisted round ledger still has an open row. */
export function hasOpenRoundLedgerRowV1(progress: TaskProgress): boolean {
  return (progress.roundLedger ?? []).some(
    (row) => row.state === "scheduled" || row.state === "open"
  );
}

export interface StalledActiveTaskCheckInputV1 {
  readonly progress: TaskProgress;
  /** The scheduling-intent store's task key — the same canonical id every
   * other scheduling-intent call in this codebase uses (task folder path). */
  readonly taskCanonicalId: string;
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
  if (progress.status !== "active") {
    return false;
  }
  if (hasOpenRoundLedgerRowV1(progress)) {
    return false;
  }
  if (progress.implRecovery !== undefined) {
    return false;
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

export function describeStalledActiveTaskEscalationV1(displayName: string): string {
  return (
    `⚠️ "${displayName}" was stalled — active with nothing running, owed, or scheduled. ` +
    "Paused with an escalation so this is visible instead of silent; resume it from the task's stage actions once you've reviewed what happened."
  );
}
