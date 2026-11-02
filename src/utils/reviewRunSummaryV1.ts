/**
 * bugs5 Step 22 (item 10): how far a review stage's run has got, shown on the plateau and churn cards so the owner
 * can see whether the rounds were moving anything: rounds run, score range, and settled plan items at the start of
 * the run and now.
 */
import type { ReviewScoreHistoryEntry, TaskStage } from "../types/taskProgress";

/** Number of distinct open plan items a grouped unbuilt-items blocker must name before Implementation is recommended. */
export const MANY_UNBUILT_ITEMS_THRESHOLD_V1 = 5;

export interface ReviewRunSummaryV1 {
  readonly rounds: number;
  readonly scoreMin: number;
  readonly scoreMax: number;
  readonly settledStart?: number;
  readonly settledNow?: number;
}

export function summarizeReviewRunV1(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage
): ReviewRunSummaryV1 | undefined {
  const rows = history.filter((entry) => entry.stage === stage && entry.score !== null);
  if (rows.length === 0) {
    return undefined;
  }
  const scores = rows.map((row) => row.score as number);
  const settled = rows.map((row) => row.settledItemCount).filter((n): n is number => n !== undefined);
  return {
    rounds: rows.length,
    scoreMin: Math.min(...scores),
    scoreMax: Math.max(...scores),
    ...(settled.length > 0 ? { settledStart: settled[0], settledNow: settled[settled.length - 1] } : {}),
  };
}

export function describeReviewRunSummaryV1(summary: ReviewRunSummaryV1): string {
  const scores =
    summary.scoreMin === summary.scoreMax ? `${summary.scoreMin}/10` : `${summary.scoreMin}/10 to ${summary.scoreMax}/10`;
  const settled =
    summary.settledStart !== undefined && summary.settledNow !== undefined
      ? `; settled plan items ${summary.settledStart} at the start of the run, ${summary.settledNow} now`
      : "";
  return `${summary.rounds} ${summary.rounds === 1 ? "round" : "rounds"} run; scores ${scores}${settled}.`;
}
