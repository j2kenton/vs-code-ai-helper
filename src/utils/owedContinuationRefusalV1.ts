import { ImplRecoveryV1, MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 } from "../types/taskProgress";

/**
 * The refusal explainer (task "Actionable Hand-offs", "Also in scope: when an
 * action refuses, say what is blocking it and when it clears"). Every field
 * this builds is already known to the code at refusal time — this only puts
 * it into one plain-language message instead of leaving a generic "an
 * operation is already in progress" or "review no longer describes the tree"
 * refusal to speak for itself.
 *
 * The live incident this answers (2026-08-21, `workflow 8`): Review, Apply
 * Review, and Fast Forward all refused within a `dispatch: "dispatched"`
 * continuation's lease window, and none of the three refusals named the
 * lease, its expiry, or the quarantined files behind it — the operator
 * clicked all three, got nothing, and concluded the extension was broken.
 *
 * Retry/clearing guidance is derived from the SAME predicate the recovery
 * scheduler (`scheduleTaskResume.ts`'s `armPendingImplRecoveries`) uses to
 * decide whether to re-arm a continuation, not restated independently:
 * - `"dispatched"` — a round already claimed the continuation and has not
 *   finished. The scheduler NEVER re-fires a dispatched record (edit runs
 *   give no idempotency guarantee), so waiting for its lease to expire does
 *   not make anything happen automatically; only reloading the window (to
 *   release a dead owner) and rerunning the implementation manually can.
 * - `"pending"` with the continuation budget exhausted
 *   (`continuations >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1`) — the
 *   scheduler explicitly skips re-arming a cap-reached record ("the
 *   transition already escalated ... re-dispatching would burn a round the
 *   budget says a human must authorize"), so this also will not retry on its
 *   own; it needs a human decision, same as the dispatched case.
 * - `"pending"` under budget — the scheduler DOES re-arm this once any live
 *   lease clears, so "wait, no action needed" is accurate here and only
 *   here.
 * Getting this branch wrong tells a user to wait on a mechanism that will
 * never fire, which is worse than the generic message it replaces.
 *
 * Kept in its own module (no `vscode` import, no dependency beyond the plain
 * `ImplRecoveryV1` type and the `MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1`
 * constant, both from `taskProgress.ts`) rather than folded into
 * `implementationRecoveryV1.ts` or `reviewActions.ts` — both of those pull in
 * `automationChain.ts`, which imports the `taskOperations` value this
 * function's busiest caller (`taskOperations.ts`'s `showTaskBusyWarning`)
 * lives in, and a value import back from either would form a module cycle.
 */
export function describeOwedContinuationRefusalV1(
  record: ImplRecoveryV1,
  pendingFiles: readonly string[],
  continuations: number
): string {
  const budgetExhausted = continuations >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1;
  const dispatched = record.dispatch === "dispatched";
  const blocker = `A continuation round is owed for this task (${record.reason}).`;
  const leaseClause =
    record.leaseUntil !== undefined
      ? ` Its lease is held until ${formatWallClockV1(record.leaseUntil)}.`
      : "";
  const retryClause = dispatched
    ? " A round already claimed this continuation and has not finished — retrying this action will not " +
      "help; it refuses before any provider is invoked. A dispatched continuation is never re-fired " +
      "automatically, even once its lease expires."
    : budgetExhausted
      ? " The continuation budget is exhausted, so automated recovery has stopped — retrying this action " +
        "will not help either; the task needs a human decision."
      : " This continuation is queued and will be retried automatically once any existing lease clears.";
  const filesClause =
    pendingFiles.length > 0
      ? ` ${pendingFiles.length} file(s) are quarantined behind it, waiting for the continuation to report on ` +
        `them:\n${pendingFiles.map((file) => `- ${file}`).join("\n")}`
      : record.filesChangedUnknown === true
        ? " The changed files behind it could not be enumerated (recorded as unknown), so whether anything " +
          "is quarantined cannot be confirmed from this message alone."
        : "";
  const remedyClause = dispatched
    ? record.leaseUntil !== undefined
      ? " Its lease expiring does not restart it — that only marks the round as stale. If it is stale " +
        "(the window that started it likely died), reload the window to release the dead owner and rerun " +
        "the implementation manually; otherwise wait for the round already running to finish on its own."
      : " Reload the window to release a dead owner and rerun the implementation manually if this " +
        "persists — it will not restart by itself."
    : budgetExhausted
      ? " Review the task and rerun the implementation manually to continue; it will not retry on its own."
      : " Wait — no action is needed from you.";
  return `${blocker}${leaseClause}${retryClause}${filesClause}${remedyClause}`;
}

/**
 * ISO timestamp -> local wall-clock time ("09:45"), for a refusal message
 * naming exactly when a lease clears. Falls back to the raw ISO string for an
 * unparseable value rather than throwing — a malformed lease timestamp must
 * degrade the message, never crash the refusal path that reports it.
 */
function formatWallClockV1(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
