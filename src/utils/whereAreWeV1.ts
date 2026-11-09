/**
 * run1 Step 19: "where are we?" in one line: the stage or flow, the step within it, and what comes next.
 * Wording only; the flows themselves (Publish belongs to publish1) are unchanged.
 *
 *   Publish: running the checks, 2 of 4; then the Publish review
 *   Publish: the Publish review; then Commit and Push
 *   High-Level Code Review: Apply Review, round 3; then a review
 */
export interface WhereAreWeInputV1 {
  /** The flow or stage: "Publish", "High-Level Code Review". */
  readonly scope: string;
  /** The step now running: "running the checks", "Apply Review, round 3". */
  readonly step: string;
  /** Which of how many, when the step has a count. */
  readonly position?: { readonly index: number; readonly total: number };
  /** What follows: "the Publish review", "a review". Omitted when nothing follows. */
  readonly next?: string;
}

export function whereAreWeLineV1(input: WhereAreWeInputV1): string {
  const position =
    input.position !== undefined && input.position.total > 0
      ? `, ${Math.min(input.position.index, input.position.total)} of ${input.position.total}`
      : "";
  const next = input.next !== undefined && input.next.length > 0 ? `; then ${input.next}` : "";
  return `${input.scope}: ${input.step}${position}${next}`;
}

/** What follows the Publish checks, in words: the Publish review, or Commit and Push. */
export function publishNextAfterChecksV1(nextStep: "review" | "commit-and-push"): string {
  return nextStep === "review" ? "the Publish review" : "Commit and Push";
}

/**
 * The line for a review stage's rounds: "High-Level Code Review: Apply Review, round 3; then a review"
 * after an Apply Review, and "High-Level Code Review: review, round 3; then Apply Review if it finds
 * fixes, or the next stage" for a review. `round` is the Fast Forward round when one is running.
 */
export function reviewStageWhereLineV1(input: {
  readonly stageName: string;
  readonly step: "apply-review" | "review" | "re-review";
  readonly round?: number;
}): string {
  const round = input.round !== undefined && input.round > 0 ? `, round ${input.round}` : "";
  if (input.step === "apply-review") {
    return `${input.stageName}: Apply Review${round}; then a review`;
  }
  const what = input.step === "re-review" ? "running the review again" : "review";
  return `${input.stageName}: ${what}${round}; then Apply Review if it finds fixes, or the next stage`;
}

/** The line for the Publish review step: the review, then Commit and Push. */
export function publishReviewWhereLineV1(): string {
  return whereAreWeLineV1({ scope: "Publish", step: "the Publish review", next: "Commit and Push" });
}
