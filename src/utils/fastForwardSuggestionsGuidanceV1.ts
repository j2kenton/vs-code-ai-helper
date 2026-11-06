/**
 * review1 Step 16: once a Fast Forward run's latest review meets the stop level, a round that acts on that review's
 * non-blocking suggestions only makes polish edits. Each edit can send already-verified test evidence back to
 * provisional (review1 item 1: three rounds in a row), and the review is clean anyway. The apply prompt therefore
 * tells the round to leave suggestions alone, unless the owner opted in with `ensemble.fastForwardActOnSuggestions`.
 */
export const LEAVE_SUGGESTIONS_ALONE_GUIDANCE_V1 =
  "This review already meets the score Fast Forward stops at. Leave its non-blocking suggestions alone: do not make " +
  "polish, naming, formatting or refactoring edits. Work only on blockers and unbuilt plan items, and make no edit at " +
  "all if there are none, because every edit can send already-verified test evidence back to provisional.";

export function buildSuggestionsGuidanceV1(input: {
  /** True while a Fast Forward run is active for the task. */
  readonly fastForwardActive: boolean;
  readonly score: number | null | undefined;
  readonly stopLevel: number;
  /** `ensemble.fastForwardActOnSuggestions`. */
  readonly actOnSuggestions: boolean;
}): string {
  if (!input.fastForwardActive || input.actOnSuggestions) return "";
  if (typeof input.score !== "number" || input.score < input.stopLevel) return "";
  return LEAVE_SUGGESTIONS_ALONE_GUIDANCE_V1;
}
