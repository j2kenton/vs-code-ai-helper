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
import {
  ImplRecoveryV1,
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  TaskProgress,
} from "../types/taskProgress";
import { hasLiveSchedulingIntentBestEffortV1, SchedulingPostureV1 } from "../state/schedulingIntentV1";
import { hasLiveWorkAdmissionBestEffortV1, hasLiveWorkAdmissionExcludingOwnerV1 } from "../state/workAdmissionV1";

/** True when this task's own persisted round ledger still has an open row. */
export function hasOpenRoundLedgerRowV1(progress: TaskProgress): boolean {
  return (progress.roundLedger ?? []).some(
    (row) => row.state === "scheduled" || row.state === "open"
  );
}

/**
 * The conservative read of `TaskProgress.nextActor` every consumer must use
 * instead of comparing the raw field directly (v1 fixes 2, item 8, Wave I).
 *
 * Returns the field's TRUE state — `"human"`, `"automation"`, or `"unknown"`
 * when absent — rather than collapsing absence into either named value.
 * Collapsing was tried both directions in earlier rounds and both were wrong:
 * folding unknown into `"human"` would silently exempt every task written
 * before this field existed from the existing stall protection the moment a
 * consumer started calling this helper (the "unverified count reads as
 * verified" failure mode this project's other gates, e.g. the checklist
 * latch, exist to avoid); folding unknown into `"automation"` erases the
 * distinction a consumer needs to satisfy the plan's own requirement —
 * "the watchdog: never pause on unknown alone" — since once a value is
 * merged into `"automation"` at the READ boundary, no downstream consumer can
 * ever tell "genuinely confirmed automation" apart from "never written" to
 * treat them differently, no matter how carefully it is written.
 *
 * Seven chokepoints write it in production so far: task creation
 * (`startNewTask.ts`, `"human"`), the generic resume's own `scheduledRun`
 * arming (`resumeTask.ts`'s `resumePausedTask`, `"automation"`), arming a
 * schedule (`scheduleTaskResume.ts`'s `scheduleTaskResume` and
 * `scheduleQuotaResumeAtV1`, `"automation"`), owing a recovery
 * (`implementationRecoveryV1.ts`'s `beginImplementationRecoveryV1`,
 * `"automation"` when leased, `"human"` when the continuation budget is
 * already exhausted and nothing will fire it automatically), four of the five
 * per-target `resumeAndXxxV1` dispatches (`resumeTask.ts`'s shared
 * `resumeThenDispatchV1`, `"automation"` — `resumeAndSetTaskStageV1` is
 * deliberately excluded, since its dispatch is a bare stage move with no
 * round attached), and discarding a recovery
 * (`implementationRecoveryV1.ts`'s `discardOwedImplRecoveryV1`, `"human"` —
 * only ever reached from an explicit, user-confirmed click). Still unwired:
 * the other recovery-clear path (`retireSatisfiedSummaryRejectedRecoveryV1`)
 * and stage transitions — see
 * `docs/verification/v1-fixes-2-wave1-inventory.md`. Every task created
 * before this field existed, and every task whose next mutation has not yet
 * been wired, still reads as `"unknown"`. Consumers must treat `"unknown"` at least as
 * permissively as `"automation"` for any gate that PREVENTS an action (never
 * use unknown to newly justify skipping existing protection), while never
 * treating `"unknown"` as sufficient on its own to ADD a new restrictive
 * consequence (e.g. a new pause) that a fully wired `"automation"` value
 * would justify — see `isImpossibleActiveStateV1`, which only ever uses this
 * helper to ADD an exemption (explicit `"human"`), never to add a new reason
 * to pause.
 */
export function effectiveNextActorV1(progress: TaskProgress): "human" | "automation" | "unknown" {
  if (progress.nextActor === "human" || progress.nextActor === "automation") {
    return progress.nextActor;
  }
  return "unknown";
}

/**
 * v1 fixes 2, item 8: true when the task is active, its next step is
 * EXPLICITLY the human's, and nothing is owed, scheduled or in flight that
 * says otherwise — the one condition under which a row or card may say
 * "waiting for you". The same facts `isImpossibleActiveStateV1` uses to exempt
 * such a task from the stall pause, so the surface and the watchdog cannot
 * disagree. `"unknown"` is never enough: an unwritten `nextActor` is not a
 * claim that anyone is waiting.
 */
export function isWaitingForHumanV1(progress: TaskProgress): boolean {
  return (
    progress.status === "active" &&
    effectiveNextActorV1(progress) === "human" &&
    progress.implRecovery === undefined &&
    progress.scheduledRun === undefined &&
    progress.scheduledResumeTime === undefined &&
    !hasOpenRoundLedgerRowV1(progress)
  );
}

/**
 * Pre-1.0.0 fixes register item 16 ("a task whose nextActor is human shows
 * that where the user looks"): the status bar and chat panel derive their
 * "waiting for you" text from `SchedulingPostureV1`
 * (`schedulingIntentV1.ts`), which reports `unknown` whenever the
 * scheduling-intent ledger has never recorded coverage for this task —
 * correctly, since ledger absence alone is never positive evidence (that
 * module's own documented contract). But `isWaitingForHumanV1` above is
 * independently sourced, direct evidence from `TaskProgress` itself, already
 * requiring nothing owed/scheduled/running before it asserts anything. This
 * only fills the `unknown` bucket — every stronger posture (`running`,
 * `scheduled`, `owedWillNotRetry`) still comes from the ledger, and a
 * `progress` the caller does not actually hold (an unreadable read) must
 * pass `undefined` rather than force this fallback. Callers: the tree row's
 * own tooltip posture, the status bar, and the chat panel's footer line —
 * the same three surfaces the task tree's row `description` already covers
 * directly via `isWaitingForHumanV1` (see `taskTreeProvider.ts`'s StageNode).
 */
export function withWaitingForHumanFallbackV1(
  posture: SchedulingPostureV1,
  progress: TaskProgress | undefined
): SchedulingPostureV1 {
  if (posture.kind === "unknown" && progress !== undefined && isWaitingForHumanV1(progress)) {
    return { kind: "waitingForYou" };
  }
  return posture;
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
  /**
   * The `ownerToken` of a `pauseCommit`-purpose work-admission claim the
   * CALLER itself currently holds for this same task (`scheduleTaskResume.ts`,
   * v1 fixes item 1, Part 1a step 4), so the live-admission check below can
   * exclude it. Without this, a sweep re-checking `isImpossibleActiveStateV1`
   * WHILE holding its own `pauseCommit` claim would see that claim's own
   * marker via `hasLiveWorkAdmissionBestEffortV1` and conclude the state is
   * no longer impossible — the sweep's own transitional lock disqualifying
   * the exact state it exists to detect, so the pause it is mid-committing
   * never actually lands (caught 2026-09-09: `transitioned` stayed `false` on
   * every watchdog pause attempt once the claim protocol shipped). Omitted by
   * every caller that does not hold a claim of its own — the ordinary
   * pre-claim check, and every non-watchdog caller.
   */
  readonly excludeWorkAdmissionOwnerToken?: string;
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
 *
 * v1 fixes 2, items 15/21: a `pending` record whose continuation budget is
 * already exhausted is ALSO a dead end — `beginImplementationRecoveryV1`
 * (`implementationRecoveryV1.ts`) deliberately omits `leaseOwner`/`leaseUntil`
 * for exactly this case ("a cap-reached record gets no lease and nothing will
 * ever fire it automatically"), so nothing will ever flip it to `dispatched`.
 * Read from the durable `incompleteRoundContinuations` counter rather than
 * "pending with no lease" — the reclaim path in `scheduleTaskResume.ts`'s
 * `armPendingImplRecoveries` also transiently writes a stale-but-
 * reconstructable `dispatched` record back to `pending` with no lease, one
 * transaction before it re-claims a fresh one; a lease-shaped test would read
 * that legitimately-recoverable mid-reclaim window as unrecoverable too. The
 * counter is set atomically in the SAME transaction as the lease omission and
 * never touched by the reclaim path, so it carries no such race.
 */
export function isUnrecoverableImplRecoveryV1(
  recovery: ImplRecoveryV1,
  progress: TaskProgress,
  now: number
): boolean {
  if (
    recovery.dispatch === "pending" &&
    (progress.incompleteRoundContinuations ?? 0) >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1
  ) {
    return true;
  }
  return isStaleDispatchedImplRecoveryV1(recovery, now) && !isReconstructableImplRecoveryV1(recovery, progress);
}

/**
 * The watchdog predicate itself. Intended to run AFTER a sweep's own round-
 * ledger reconciliation and `implRecovery` re-arm/reclaim passes have had a
 * chance to resolve anything resolvable — evaluated against whatever is left
 * once those passes are done, so a task this returns `true` for genuinely has
 * nothing left that could still bring it back to life on its own.
 */
/**
 * How long a task must have been QUIET before this predicate will call it
 * stalled (v1 fixes item 1, 2026-09-07).
 *
 * Without this the watchdog fires on a state that is not yet a fault. Resuming
 * a task sets `status: "active"` and arranges no work — `resumeTask` is a
 * status change, not a dispatch — so for the moment between resuming and the
 * next dispatch a healthy task is indistinguishable from a silently stopped
 * one. Worse, writing `task-progress.json` is itself what fires the sweep
 * (`extension.ts` wires the progress watcher's `onDidChange` to `armAll()`),
 * so the pause is a direct consequence of the resume rather than a timing
 * accident. Measured on `version 1` 2026-09-07: active at 07:32:48, re-paused
 * at 07:32:52 — four seconds, with no dispatch route available in between,
 * because every dispatch command is gated on the task not being paused.
 *
 * A watchdog is meant to notice that nothing has happened for a while.
 *
 * **Ninety seconds was tried first and was not enough** (2026-09-07 08:45:55).
 * A review was started by hand on a resumed task, spent its setup phase
 * assembling a 47 KB context pack, and the sweep paused the task underneath
 * it. The review then aborted on its own paused check:
 *
 *     Error: The task was paused while the review was starting.
 *         at ... vs-code-ai-helper.runReviewWithAI
 *
 * The cause is not slowness but ordering: **a command that is starting work
 * has not yet opened the round-ledger row that would exempt the task**, so
 * during setup it is indistinguishable from a task doing nothing. Any period
 * short enough to be useful can be outrun by a slower context pack, so the
 * value is a mitigation, not a boundary.
 *
 * Ten minutes was the second value tried, on the reasoning that it "cannot be
 * outrun by a setup phase". **It was, three times in eighteen hours**, every
 * instance `v1 fixes` running Fast Forward, every one with the same signature
 * — the pause lands in the gap, and the killed round's own context pack
 * appears AFTER it:
 *
 *     20:50:59 round ends → 21:04:03 paused → 21:08:59 context-pack.md (43 KB)
 *     12:05:29 round ends → 12:18:00 paused → 12:27:30 context-pack.md (40 KB)
 *     12:59:06 round ends → 13:13:00 paused → 13:21:01 context-pack.md (40 KB)
 *
 * Consistently ~14 minutes from the previous round ending to the pause, and
 * ~8 more before the pack lands: a setup phase of roughly 22 minutes on a plan
 * of this size, writing nothing to `task-progress.json` the whole time. Ten
 * minutes could not cover it, so the third of a thirty-iteration Fast Forward
 * run died at iteration 14, and the following two attempts died the same way.
 *
 * **This constant was raised to thirty minutes on 2026-09-09 as a same-round
 * self-amendment, and reverted back to ten on the same day** (implementation
 * review, `4abacb52-56de-4de9-bc74-cd1b0d728ea9-1`): the plan of record for
 * this task (`.ensemble/2026-09-07_task_1/plan.md`, Part 1a step 9) requires
 * "Keep `isImpossibleActiveStateV1` and the 10-minute quiet period unchanged,"
 * and the task's own chat history contains no recorded human approval of the
 * amendment — only a self-authored implementation-notes paragraph claiming
 * approval. Per this project's standing rule, a reasonable alternative
 * reached mid-round is not the same thing as approval: without a genuine,
 * out-of-band recorded owner decision, the approved contract governs. The
 * three-outrun measurements above are real and unresolved; they argue for
 * finishing `v1 fixes` item 1 (a command registers its intent BEFORE its
 * setup phase, so the sweep has a positive signal instead of inferring death
 * from silence) and `v1 fixes 2` item 8 (the sweep consults direct evidence of
 * life — recent writes in the task folder, a live provider process — before
 * concluding a task is dead), not for silently re-tuning this timeout a
 * fourth time. If thirty minutes (or another value) is genuinely wanted, it
 * needs an explicit, recorded decision through the plan process — not a
 * value chosen and self-approved inside an implementation round.
 */
export const STALLED_TASK_QUIET_PERIOD_MS = 10 * 60 * 1000;

export function isImpossibleActiveStateV1(input: StalledActiveTaskCheckInputV1): boolean {
  const { progress, taskCanonicalId } = input;
  const now = input.now ?? Date.now();
  if (progress.status !== "active") {
    return false;
  }
  // v1 fixes 2, item 8: a task whose next step is explicitly the human's is
  // never paused as stalled — it is waiting for a person, not stuck. Only an
  // EXPLICIT "human" write exempts; "unknown" (the value for every task until
  // Wave II's chokepoint writers land) falls through to the existing,
  // unchanged evidence-based checks below, so this can only ever ADD an
  // exemption and never remove the existing stall protection.
  if (effectiveNextActorV1(progress) === "human") {
    return false;
  }
  // Recently touched: not yet evidence of a stall. See the constant above.
  const updatedAt = progress.updatedAt ? Date.parse(progress.updatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt) && now - updatedAt < STALLED_TASK_QUIET_PERIOD_MS) {
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
  // v1 fixes item 1 (Part 1a): a command that is starting work registers
  // durable admission (state/workAdmissionV1.ts) BEFORE its setup phase, so
  // the sweep can see it even before a round-ledger row exists. `taskCanonicalId`
  // is the task folder path — the same value `acquireWorkAdmissionV1` keys
  // its admission directory by. Fails OPEN (any present claim/marker, live or
  // stale, counts) per that module's interim policy: v1a has no safe way to
  // tell a dead owner from a slow one, so it never lets the sweep guess.
  const hasUnrelatedLiveAdmission =
    input.excludeWorkAdmissionOwnerToken !== undefined
      ? hasLiveWorkAdmissionExcludingOwnerV1(taskCanonicalId, input.excludeWorkAdmissionOwnerToken)
      : hasLiveWorkAdmissionBestEffortV1(taskCanonicalId);
  if (hasUnrelatedLiveAdmission) {
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
