import * as vscode from "vscode";

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
}): Promise<ImproveReviewScoreResult> {
  let best: number | null = null;
  let escalationDeferred = false;
  let consecutiveZeroFixable = 0;
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_REVIEW_ATTEMPTS);
  const stopAtScore = Math.max(0, Math.min(10, options.stopAtScore ?? 0));
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
    // Compare in integer tenths: scores are normalized to one decimal
    // (reviewReadiness.ts), and `baseline + 0.1` is not exactly representable
    // in IEEE-754, so a direct `>=` misfires exactly at the boundary.
    const improved =
      Math.round(score * 10) >=
      Math.round(options.baselineScore * 10) + Math.round(MIN_SCORE_IMPROVEMENT * 10);
    // Fast Forward is only successful after it has made measurable progress
    // from the score it started with.  A configured target may require more,
    // but must not let a task at (or above) that target stop without improving.
    if (improved && (stopAtScore === 0 || score >= stopAtScore)) {
      return { score, attempts: attempt, improved: true, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: false };
    }
    consecutiveZeroFixable = round.zeroFixableEvidence ? consecutiveZeroFixable + 1 : 0;
    if (options.zeroFixableTerminates === true && consecutiveZeroFixable >= ZERO_FIXABLE_TERMINAL_ROUNDS) {
      return { score, attempts: attempt, improved: false, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: true };
    }
  }
  return { score: best, attempts: maxAttempts, improved: false, stalled: false, paused: false, escalationDeferred, zeroFixableSuccess: false };
}
