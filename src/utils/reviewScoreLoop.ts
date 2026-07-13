import * as vscode from "vscode";

const KEY = "bestReviewScores";
export const MAX_REVIEW_ATTEMPTS = 5;

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
  /** True once an attempt's score reached baselineScore + 1. */
  improved: boolean;
  /**
   * True when an attempt's review() returned null (the review artifact
   * didn't change, or changed but had no parseable score) — the loop stops
   * immediately rather than burning the remaining attempts, since nothing
   * distinguishing happened to compare against.
   */
  stalled: boolean;
}

/**
 * Runs exactly one apply followed by one re-review per attempt, up to
 * MAX_REVIEW_ATTEMPTS, stopping as soon as a later attempt's score beats
 * baselineScore by at least 1.
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
  token?: vscode.CancellationToken;
  /** Maximum apply/review cycles for this run. */
  maxAttempts?: number;
  /** 0 stops at the first improvement; 1-10 stops once that score is reached. */
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
    if (score === null) {
      return { score: best, attempts: attempt, improved: false, stalled: true };
    }
    best = Math.max(best ?? Number.NEGATIVE_INFINITY, score);
    await recordBestReviewScore(options.context, options.stage, score);
    const improved = score >= options.baselineScore + 1;
    if ((stopAtScore === 0 && improved) || (stopAtScore > 0 && score >= stopAtScore)) {
      return { score, attempts: attempt, improved: true, stalled: false };
    }
  }
  return { score: best, attempts: maxAttempts, improved: false, stalled: false };
}
