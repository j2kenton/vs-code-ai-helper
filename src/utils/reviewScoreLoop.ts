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
   * True when apply() left the task paused (isPaused() returned true).
   * Checked AFTER review() runs (so a score this attempt actually produced
   * is still recorded — see isPaused's own doc comment) but takes priority
   * over `stalled` in the returned outcome, so the two remain mutually
   * exclusive: a pause means there is a real, known reason to stop — an
   * escalation, most commonly — as opposed to stalled's "nothing changed and
   * we don't know why". Always false when the caller doesn't pass isPaused.
   */
  paused: boolean;
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
  /** Returns the new score, or null if this attempt produced nothing to compare (stops the loop). */
  review: () => Promise<number | null>;
  /**
   * Checked immediately after review(), and takes priority over `stalled` in
   * the returned outcome. When it returns true, the loop stops and reports
   * `paused` instead of continuing — but review() still runs first so a
   * score this same attempt actually produced (e.g. an internal re-review
   * that itself triggered the pause via escalation) is recorded rather than
   * discarded. Optional: a caller with no pausable task (e.g. a test, or a
   * future non-task-scoped use of this loop) simply never sees this outcome.
   */
  isPaused?: () => Promise<boolean>;
  token?: vscode.CancellationToken;
  /** Maximum apply/review cycles for this run. */
  maxAttempts?: number;
  /** 0 stops at the first improvement; a positive target is an additional
   * goal, but never replaces the mandatory baseline improvement (of at least
   * MIN_SCORE_IMPROVEMENT). */
  stopAtScore?: number;
}): Promise<ImproveReviewScoreResult> {
  let best: number | null = null;
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
    const score = await options.review();
    if (score !== null) {
      best = Math.max(best ?? Number.NEGATIVE_INFINITY, score);
      await recordBestReviewScore(options.context, options.stage, score);
    }
    if ((await options.isPaused?.()) === true) {
      return { score: best, attempts: attempt, improved: false, stalled: false, paused: true };
    }
    if (score === null) {
      return { score: best, attempts: attempt, improved: false, stalled: true, paused: false };
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
      return { score, attempts: attempt, improved: true, stalled: false, paused: false };
    }
  }
  return { score: best, attempts: maxAttempts, improved: false, stalled: false, paused: false };
}
