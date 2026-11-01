/**
 * bugs4 Step 13 (item 29): wording for the "this review predates a change to your plan or
 * task description" confirmation raised by Complete Stage & Move On.
 *
 * Pure so the sentences are testable without the extension host. The detection itself is
 * `staleReviewInputsV1` (reviewInputsChangedV1.ts).
 */
import type { StaleReviewInputV1 } from "./reviewInputsChangedV1";

export interface StaleReviewVerdictTextInputV1 {
  /** Display name of the review stage whose verdict is being relied on. */
  readonly reviewStageName: string;
  readonly stale: readonly StaleReviewInputV1[];
  /** Unticked nested sub-items now in the plan of record (0 when none or unreadable). */
  readonly openNestedItems: number;
  /** Sub-items added to the plan since the review started (0 when unknown or none). */
  readonly nestedItemsAdded?: number;
  readonly nextStageName: string;
}

function describeStaleInputV1(input: StaleReviewInputV1): string {
  return input.modifiedAt !== undefined ? `${input.name} (changed ${input.modifiedAt})` : input.name;
}

export interface StaleReviewVerdictTextV1 {
  readonly whatHappened: string;
  readonly whyUserNeeded: string;
  readonly rerunConsequence: string;
  readonly advanceConsequence: string;
  readonly notNowConsequence: string;
}

export function buildStaleReviewVerdictTextV1(input: StaleReviewVerdictTextInputV1): StaleReviewVerdictTextV1 {
  const files = input.stale.map(describeStaleInputV1).join(" and ");
  const planChanged = input.stale.some((entry) => entry.name === "plan-final.md");
  const added = input.nestedItemsAdded ?? 0;
  const addedNote = added > 0 ? ` ${added} sub-item(s) added since the last review.` : "";
  const nested =
    input.openNestedItems > 0
      ? ` plan-final.md now has ${input.openNestedItems} unticked sub-item(s); each keeps its parent step open.${addedNote}`
      : addedNote;
  return {
    whatHappened:
      `${input.reviewStageName}'s verdict is out of date: ${files} changed after that review started, ` +
      `so the review did not see the current text.${nested}`,
    whyUserNeeded:
      `Moving on to ${input.nextStageName} would rely on a verdict about an older ${planChanged ? "plan" : "task description"}. ` +
      (input.openNestedItems > 0
        ? "Re-run the review so it checks them; it will send the task back to build them if they are not done."
        : "Re-running the review is the safe choice; advancing anyway is your call."),
    rerunConsequence: `Starts ${input.reviewStageName} again on the current text. Nothing moves until it finishes.`,
    advanceConsequence: `Moves the task to ${input.nextStageName} on the older verdict.`,
    notNowConsequence: `Nothing changes: the task stays at ${input.reviewStageName}.`,
  };
}
