/**
 * Pure classification helper for `TaskProgress.roundOutcomes` (wf10 item 4 /
 * Part 4). Isolated from `reviewActions.ts` so the decision of "which
 * classification does this zero-file round earn" is unit-testable on its
 * own, independent of the surrounding recovery/latch machinery.
 *
 * Only ever called for a round that has already reached completion
 * accounting (`result.status === "completed"`, no incomplete-round/rejected-
 * summary recovery in flight) — the caller in `reviewActions.ts` is
 * responsible for that gate; this function assumes it already holds.
 */
import { RoundOutcomeClassificationV1 } from "../types/taskProgress";

export interface ClassifyZeroFileImplRoundInputV1 {
  /** True when this round landed new plan-checklist ticks despite changing no files — durable progress. */
  readonly checklistAdvanced: boolean;
  /**
   * True when the round was flagged as a suspicious zero-file completion
   * rather than passed through as a justified no-op — i.e. the gate that
   * fires `uncheckedItemsWithoutClearingReview` OR the sibling
   * settings/first-round conditions in the same warning branch
   * (`reviewActions.ts`'s zero-file gate).
   */
  readonly warnedAsZeroFileFailure: boolean;
}

/**
 * Classify a completed implementation round that changed zero files.
 * `checklistAdvanced` wins regardless of the warning flag — landing real
 * checklist ticks is durable progress, not a provider failure, even if some
 * other condition in the same gate (e.g. a first-ever round with no
 * established tree) also happened to trip the warning.
 */
export function classifyZeroFileImplRoundV1(
  input: ClassifyZeroFileImplRoundInputV1
): RoundOutcomeClassificationV1 {
  if (input.checklistAdvanced) {
    return "edits-produced";
  }
  return input.warnedAsZeroFileFailure ? "provider-failure-empty" : "genuine-no-op";
}
