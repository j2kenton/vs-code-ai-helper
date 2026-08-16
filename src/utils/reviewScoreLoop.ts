import * as vscode from "vscode";
import { isPlanIncomplete } from "./reviewReadiness";

const KEY = "bestReviewScores";
export const MAX_REVIEW_ATTEMPTS = 5;

/**
 * Smallest score gain that counts as real progress for the stop/plateau
 * decision. For integer scores this is equivalent to the historical "+1"
 * rule — there is no integer strictly between baselineScore and
 * baselineScore + 1, so a whole-point jump still clears it and a flat score
 * still fails it. It matters only for the fractional scores staged
 * (multi-round) implementation reviews emit (see reviewReadiness.ts): a
 * genuine but sub-band climb like 3.1 -> 3.4 now registers as improvement,
 * so a large plan delivered incrementally is not misread as a plateau and
 * escalated when it is in fact progressing.
 */
export const MIN_SCORE_IMPROVEMENT = 0.1;

export function getBestReviewScore(context: vscode.ExtensionContext, stage: string): number | undefined {
  return context.workspaceState.get<Record<string, number>>(KEY)?.[stage];
}

export async function recordBestReviewScore(context: vscode.ExtensionContext, stage: string, score: number): Promise<number> {
  const scores = context.workspaceState.get<Record<string, number>>(KEY, {});
  const best = Math.max(scores[stage] ?? Number.NEGATIVE_INFINITY, score);
  await context.workspaceState.update(KEY, { ...scores, [stage]: best });
  return best;
}

/** How many consecutive zero-task-fixable review rounds (with positive
 * evidence — see ReviewRoundOutcome.zeroFixableEvidence) terminate the loop
 * as success when `zeroFixableTerminates` is enabled. Two, not one, so a
 * single over-lenient round can't end a run on its own. */
export const ZERO_FIXABLE_TERMINAL_ROUNDS = 2;

/**
 * How many consecutive clean-but-incomplete rounds may pass WITHOUT the
 * reported plan progress advancing before the loop gives up and reports
 * `stalled`.
 *
 * The safety valve on continuing through an incomplete plan: "zero blockers,
 * more steps remain" tells the loop to keep building, but if implementation
 * then lands nothing new round after round, continuing would burn the entire
 * attempt budget achieving nothing — the exact runaway this whole signal
 * exists to prevent, just wearing a different hat. Two rounds, matching
 * ZERO_FIXABLE_TERMINAL_ROUNDS, so one unproductive round is tolerated.
 */
export const PROGRESS_STALL_ROUNDS = 2;

/**
 * Where a pause came from, when the caller can tell:
 *  - "escalation": handleReviewRoutingOutcome (reviewActions.ts) escalated
 *    and paused the task from INSIDE this run's own review round.
 *  - "external": any other source — the user pausing manually, another
 *    window, an escalation for a different stage.
 * A plain boolean `true` is treated as "external" (the pre-existing
 * contract): only a caller that affirmatively classifies a pause as this
 * run's own escalation ever gets the continue-through behavior.
 */
export type PauseSource = "external" | "escalation";

/**
 * Structured per-round review outcome — the single seam consumed by both
 * degenerate-round handling (score: null) and zero-fixable termination.
 * review() may still return a bare number (legacy callers/tests): it is
 * normalized to `{ score, taskFixableCount: null, zeroFixableEvidence:
 * false }`, which preserves every historical behavior.
 */
export interface ReviewRoundOutcome {
  /** Parsed `Readiness: N/10`, or null when the artifact changed but carried
   * no parseable score (the round is treated as stalled, exactly as a bare
   * null score was before). */
  score: number | null;
  /** Task-fixable blockers reported this round, or null when no
   * machine-readable blocker block was parsed. */
  taskFixableCount: number | null;
  /**
   * POSITIVE evidence this round reported zero task-fixable blockers: a
   * parsed (present) blocker block with no task-fixable entry, or an
   * explicit "no blockers" statement — never the mere absence of the block
   * (see reviewReadiness.ts's hasZeroTaskFixableEvidence).
   */
  zeroFixableEvidence: boolean;
  /**
   * How far through an ordered plan this round reports the implementation to
   * be (reviewReadiness.ts's parseReviewProgress), or null/absent when the
   * review emitted no progress marker.
   *
   * This is what separates "clean AND finished" from "clean SO FAR": with
   * zero blockers and `complete < total`, the correct move is to keep
   * building the next steps, NOT to declare the run successful. Absent
   * (null/undefined) restores the exact pre-marker behavior, so a review from
   * an older prompt — or a provider that ignored the marker — is unaffected.
   */
  progress?: { complete: number; total: number } | null;
  /**
   * Identity of the provider/model that actually produced THIS round's
   * review (including any backup-cascade substitution) — mirrors
   * `ReviewScoreHistoryEntry.reviewer`. Absent when the caller has no
   * attribution to offer, which keeps every pre-existing caller's behavior
   * unchanged (see `baselineReviewer` below).
   */
  reviewer?: { providerLabel: string; storedModelId: string };
}

/** `${providerLabel}|${storedModelId}`, or undefined for an unidentified
 * reviewer — mirrors reviewRouting.ts's own reviewerKey. */
function reviewerKey(reviewer?: { providerLabel: string; storedModelId: string }): string | undefined {
  return reviewer ? `${reviewer.providerLabel}|${reviewer.storedModelId}` : undefined;
}

export interface ImproveReviewScoreResult {
  /** Last known score, or null if no attempt ever produced a parseable one. */
  score: number | null;
  attempts: number;
  /** True once an attempt's score reached baselineScore + MIN_SCORE_IMPROVEMENT
   * (a whole point for integer scores; a fractional gain for staged reviews). */
  improved: boolean;
  /**
   * True when an attempt's review() returned null (the review artifact
   * didn't change, or changed but had no parseable score) — the loop stops
   * immediately rather than burning the remaining attempts, since nothing
   * distinguishing happened to compare against.
   */
  stalled: boolean;
  /**
   * True when apply() left the task paused (isPaused() returned truthy and
   * the pause was not ridden through — see continueThroughEscalation).
   * Checked AFTER review() runs (so a score this attempt actually produced
   * is still recorded — see isPaused's own doc comment) but takes priority
   * over `stalled` in the returned outcome, so the two remain mutually
   * exclusive: a pause means there is a real, known reason to stop — an
   * escalation, most commonly — as opposed to stalled's "nothing changed and
   * we don't know why". Always false when the caller doesn't pass isPaused.
   */
  paused: boolean;
  /**
   * True when at least one attempt's own review escalated ("escalation"
   * pause source) and the loop, under continueThroughEscalation, kept
   * running instead of aborting — the caller must surface that escalation
   * to the user at the end of the run rather than letting it disappear.
   */
  escalationDeferred: boolean;
  /**
   * True when the loop stopped because ZERO_FIXABLE_TERMINAL_ROUNDS
   * consecutive rounds each carried positive evidence of zero task-fixable
   * blockers (zeroFixableTerminates) — terminal success regardless of score
   * movement. Mutually exclusive with `improved`.
   */
  zeroFixableSuccess: boolean;
}

/**
 * Runs exactly one apply followed by one re-review per attempt, up to
 * MAX_REVIEW_ATTEMPTS, stopping as soon as a later attempt's score beats
 * baselineScore by at least MIN_SCORE_IMPROVEMENT (one whole point for
 * integer scores; any real fractional gain for staged reviews).
 *
 * baselineScore must be the score of the review *before* this call starts
 * (read by the caller) — the loop does not consult any previously persisted
 * score to decide when to stop. A cross-session "best score" is still
 * recorded via recordBestReviewScore for potential future display, but it
 * never gates the stopping condition: gating on "no persisted best yet"
 * would make the very first fast-forward run on a task stop after a single
 * attempt regardless of how low that attempt's score was.
 */
export async function improveReviewScore(options: {
  context: vscode.ExtensionContext;
  stage: string;
  baselineScore: number;
  apply: () => Promise<void>;
  /** Returns the new round outcome (or a bare score, normalized — see
   * ReviewRoundOutcome), or null if this attempt produced nothing to compare
   * (stops the loop). */
  review: () => Promise<ReviewRoundOutcome | number | null>;
  /**
   * Checked immediately after review(), and takes priority over `stalled` in
   * the returned outcome. When it returns truthy, the loop stops and reports
   * `paused` — unless the value is "escalation" AND continueThroughEscalation
   * is set, in which case the loop records `escalationDeferred` and keeps
   * going. review() still runs first so a score this same attempt actually
   * produced (e.g. an internal re-review that itself triggered the pause via
   * escalation) is recorded rather than discarded. Optional: a caller with
   * no pausable task (e.g. a test, or a future non-task-scoped use of this
   * loop) simply never sees this outcome.
   */
  isPaused?: () => Promise<boolean | PauseSource>;
  /**
   * ensemble.resilience.fastForwardSurvivesEscalation: a plateau escalation
   * raised INSIDE this run must not silently reduce an explicitly-requested
   * multi-attempt run to a single round — the user already answered "keep
   * going" by starting it. Only rides through pauses the caller classifies
   * as "escalation" (this run's own); external pauses always abort, which is
   * isPaused's original purpose.
   */
  continueThroughEscalation?: boolean;
  /**
   * ensemble.resilience.zeroFixableTerminatesFastForward: two consecutive
   * rounds with positive zero-task-fixable evidence end the loop as terminal
   * success regardless of score movement. Without this, a review reporting
   * zero blockers of every category plus "ready to proceed" still burns the
   * remaining attempts whenever its number failed to move +0.1 (observed:
   * 37 zero-blocker rounds across one task, none of which stopped anything).
   * The score gate remains an ADDITIONAL way to succeed, never the only one.
   */
  zeroFixableTerminates?: boolean;
  token?: vscode.CancellationToken;
  /** Maximum apply/review cycles for this run. */
  maxAttempts?: number;
  /** 0 stops at the first improvement; a positive target is an additional
   * goal, but never replaces the mandatory baseline improvement (of at least
   * MIN_SCORE_IMPROVEMENT). */
  stopAtScore?: number;
  /**
   * Evidence from the review that already existed BEFORE this call started
   * (the same review `baselineScore` was read from) — lets a baseline that
   * is already at or above `stopAtScore` with nothing fixable succeed
   * without burning even one apply()/review() cycle. Without this, a
   * finished 10/10 task still runs a full round: `improved` demands
   * `baselineScore + 0.1`, which cannot exist at a baseline of 10 on a
   * 0-10 scale, so the loop always falls through to the zero-fixable path
   * — but that path itself needs ZERO_FIXABLE_TERMINAL_ROUNDS consecutive
   * evidence, and the counter starts at 0 every call. Passing the pre-loop
   * review's own evidence here both seeds that counter (so one in-loop
   * round after a zero-fixable baseline can still terminate) and — when the
   * evidence already clears the bar — skips apply() on attempt 1 entirely.
   */
  preLoopEvidence?: {
    /** Same positive-evidence contract as ReviewRoundOutcome.zeroFixableEvidence. */
    zeroFixableEvidence: boolean;
    /** Same contract as ReviewRoundOutcome.progress → isPlanIncomplete. */
    planIncomplete: boolean;
  };
  /**
   * Identity of the reviewer that produced `baselineScore` (read by the
   * caller before this call started), and its task-fixable count if known.
   * Lets the loop tell a genuine score improvement from an artifact of a
   * reviewer substitution (backup-cascade fallback, manual model switch): a
   * different reviewer is a different instrument, and the between-reviewer
   * offset can be the same order of magnitude as MIN_SCORE_IMPROVEMENT
   * (2026-08-14 finding: workflow-2 item 7). Absent — as for every
   * pre-existing caller — restores the exact prior behavior of comparing
   * every round's score straight against `baselineScore`.
   */
  baselineReviewer?: { providerLabel: string; storedModelId: string };
  baselineTaskFixableCount?: number;
}): Promise<ImproveReviewScoreResult> {
  let best: number | null = null;
  let escalationDeferred = false;
  // Seeded from the pre-loop review's own evidence (see preLoopEvidence) so
  // the counter reflects what is already known rather than only what this
  // run generates — without this, a zero-fixable baseline is invisible to
  // the ZERO_FIXABLE_TERMINAL_ROUNDS check and costs one extra round.
  let consecutiveZeroFixable = options.preLoopEvidence?.zeroFixableEvidence ? 1 : 0;
  /** Last round's reported `progress.complete`, for detecting forward movement. */
  let previousComplete: number | null = null;
  let roundsWithoutProgressAdvance = 0;
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_REVIEW_ATTEMPTS);
  const stopAtScore = Math.max(0, Math.min(10, options.stopAtScore ?? 0));
  // The reviewer identity + score/blocker-count a round's `improved` test is
  // actually compared against. Starts at the caller-supplied baseline and
  // re-anchors to a new reviewer's own first round when one is detected (see
  // the reviewer-change branch below), so a substitution never gets treated
  // as a same-instrument delta in either direction.
  let referenceReviewerKey = reviewerKey(options.baselineReviewer);
  let referenceScore = options.baselineScore;
  let referenceTaskFixableCount: number | null = options.baselineTaskFixableCount ?? null;

  // Pre-loop short-circuit: the evidence already in hand (from the review
  // that produced baselineScore) shows the task is already finished. Succeed
  // without running apply() even once — the round that would otherwise run
  // here is exactly the one that failed in report 7 (a model asked to
  // "improve" work a reviewer already called perfect).
  if (
    stopAtScore > 0 &&
    options.baselineScore >= stopAtScore &&
    options.preLoopEvidence?.zeroFixableEvidence === true &&
    options.preLoopEvidence.planIncomplete === false
  ) {
    return {
      score: options.baselineScore,
      attempts: 0,
      improved: false,
      stalled: false,
      paused: false,
      escalationDeferred: false,
      zeroFixableSuccess: true,
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    await options.apply();
    if (options.token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const raw = await options.review();
    const round: ReviewRoundOutcome | null =
      raw === null
        ? null
        : typeof raw === "number"
          ? { score: raw, taskFixableCount: null, zeroFixableEvidence: false }
          : raw;
    const score = round?.score ?? null;
    if (score !== null) {
      best = Math.max(best ?? Number.NEGATIVE_INFINITY, score);
      await recordBestReviewScore(options.context, options.stage, score);
    }
    const pause = (await options.isPaused?.()) ?? false;
    if (pause === "escalation" && options.continueThroughEscalation === true) {
      // This run's own review escalated. The user asked for a multi-attempt
      // run; keep going and report the escalation at the end instead of
      // degrading to a one-round button.
      escalationDeferred = true;
    } else if (pause === true || pause === "external" || pause === "escalation") {
      return { score: best, attempts: attempt, improved: false, stalled: false, paused: true, escalationDeferred, zeroFixableSuccess: false };
    }
    if (round === null || score === null) {
      return { score: best, attempts: attempt, improved: false, stalled: true, paused: false, escalationDeferred, zeroFixableSuccess: false };
    }
    // Plan-progress tracking (see ReviewRoundOutcome.progress). A round that
    // reports no marker leaves all of this null/untouched, so every decision
    // below is bit-for-bit the pre-marker behavior for those reviews.
    const progress = round.progress ?? null;
    const planIncomplete = isPlanIncomplete(progress);
    if (progress !== null) {
      if (previousComplete !== null) {
        roundsWithoutProgressAdvance =
          progress.complete > previousComplete ? 0 : roundsWithoutProgressAdvance + 1;
      }
      previousComplete = progress.complete;
    }

    // Reviewer-substitution scale break (workflow-2 item 7): once BOTH the
    // reference and this round carry a recorded identity and they differ,
    // this round's score is not comparable to the reference score at all —
    // treat it as a different instrument's reading, never as the same scale
    // moving. Prefer blocker-count movement (a count, not a judgement scale)
    // when both counts are known; otherwise there is no comparable evidence
    // yet, so this round can't itself prove improvement — it becomes the new
    // reference for whatever round comes next.
    const currentReviewerKey = reviewerKey(round.reviewer);
    const reviewerChanged =
      currentReviewerKey !== undefined &&
      referenceReviewerKey !== undefined &&
      currentReviewerKey !== referenceReviewerKey;
    // Compare in integer tenths: scores are normalized to one decimal
    // (reviewReadiness.ts), and `reference + 0.1` is not exactly representable
    // in IEEE-754, so a direct `>=` misfires exactly at the boundary.
    const improved = reviewerChanged
      ? round.taskFixableCount !== null &&
        referenceTaskFixableCount !== null &&
        round.taskFixableCount < referenceTaskFixableCount
      : Math.round(score * 10) >=
        Math.round(referenceScore * 10) + Math.round(MIN_SCORE_IMPROVEMENT * 10);
    // Re-anchor the reference to this round ONLY on a genuine detected
    // change from a KNOWN reference reviewer — never merely because this is
    // the first round to carry an identity at all (that would silently
    // narrow every later round's comparison from the original baseline down
    // to "beat the immediately preceding round", which is a different and
    // unintended loosening for the ordinary single-reviewer case). With no
    // `baselineReviewer` supplied, referenceReviewerKey stays undefined for
    // the whole run and this block never fires — the pre-existing behavior
    // of always comparing against options.baselineScore is preserved
    // exactly, matching every caller that has not opted into identity
    // tracking yet.
    if (reviewerChanged) {
      referenceReviewerKey = currentReviewerKey;
      referenceScore = score;
      referenceTaskFixableCount = round.taskFixableCount;
    }
    // Fast Forward is only successful after it has made measurable progress
    // from the score it started with.  A configured target may require more,
    // but must not let a task at (or above) that target stop without improving.
    //
    // `!planIncomplete` guards the same trap as the zero-fixable branch
    // below: now that scores measure the QUALITY of what was built rather
    // than the fraction of the plan present, a flawless first batch can
    // legitimately score high while most of the plan is still unbuilt.
    // Returning success there would advance the stage and strand every
    // remaining step. A review with no progress marker is unaffected.
    if (improved && (stopAtScore === 0 || score >= stopAtScore) && !planIncomplete) {
      return { score, attempts: attempt, improved: true, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: false };
    }

    // Terminal success on the FIRST round whose own evidence shows the task
    // is already at (or above) the configured stop level with nothing
    // task-fixable left, regardless of whether the score moved from the
    // baseline. This is what makes a 10/10 baseline reachable at all: the
    // `improved` branch above demands `baselineScore + 0.1`, which has no
    // representable value above a baseline of 10 on a 0-10 scale, so without
    // this branch a perfect baseline could only ever succeed through the
    // separate ZERO_FIXABLE_TERMINAL_ROUNDS path below — which still
    // requires two consecutive rounds even when the very first one already
    // proves there is nothing left to fix.
    if (
      stopAtScore > 0 &&
      score >= stopAtScore &&
      round.zeroFixableEvidence &&
      !planIncomplete
    ) {
      return { score, attempts: attempt, improved: false, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: true };
    }

    consecutiveZeroFixable = round.zeroFixableEvidence ? consecutiveZeroFixable + 1 : 0;
    if (options.zeroFixableTerminates === true && consecutiveZeroFixable >= ZERO_FIXABLE_TERMINAL_ROUNDS) {
      // Zero task-fixable blockers means "nothing is WRONG" — which is only
      // the same thing as "we are DONE" when the plan has no steps left. With
      // an ordered plan still mid-flight, terminating here is precisely the
      // bug this signal fixes: it declares success at (say) 8 of 25 steps and
      // strands the remaining 17. Keep going instead, so the next round
      // implements the next steps.
      if (!planIncomplete) {
        return { score, attempts: attempt, improved: false, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: true };
      }
      // ...unless implementation has stopped actually landing steps, in which
      // case "keep going" would just burn the attempt budget (PROGRESS_STALL_ROUNDS).
      if (roundsWithoutProgressAdvance >= PROGRESS_STALL_ROUNDS) {
        return { score: best, attempts: attempt, improved: false, stalled: true, paused: false, escalationDeferred, zeroFixableSuccess: false };
      }
    }
  }
  return { score: best, attempts: maxAttempts, improved: false, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: false };
}
