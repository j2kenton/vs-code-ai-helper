/**
 * bugs5 Step 26 (item 6): what the Notifications row says about the model.
 *
 * A round's row names only a model that is actually running it. A review spends its first minutes running the
 * project's checks before any model is invoked, and the row used to keep the previous round's model (an Apply
 * Review's Claude Sonnet) until the review's own model was reported. Round starts now clear the model; until one
 * is invoked, a row that is running checks says so.
 */
import { describeModelWithProviderV1 } from "../runners/providers";

/** The activity text a review reports while it runs its checks (see `reviewActions.ts`'s check accumulator). */
const CHECKS_ACTIVITY_PATTERN_V1 = /\bchecks? running\b|\bchecks?\b.*\bcomplete\b/i;

export function describeOperationModelSegmentV1(input: {
  readonly modelId: string | undefined;
  readonly activity: string | undefined;
  readonly detail?: string | undefined;
}): string | undefined {
  if (input.modelId) {
    return describeModelWithProviderV1(input.modelId);
  }
  const text = `${input.detail ?? ""} ${input.activity ?? ""}`;
  return CHECKS_ACTIVITY_PATTERN_V1.test(text) ? "checks running; model not started yet" : undefined;
}
