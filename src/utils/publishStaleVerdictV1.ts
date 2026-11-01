/**
 * bugs4 Step 13 (item 29): the Publish side of the stale-verdict check.
 *
 * Complete Stage & Move On and the hand-off card's Advance ask the owner before relying on a
 * review that predates a change to `task.md` or `plan-final.md` (see `staleReviewVerdictV1.ts`).
 * Publish Checks can also be started directly, with no advance in between, on a task whose last
 * code review never saw the current plan. This module finds the code review Publish relies on,
 * asks the shared detector whether it is stale, and words the card.
 *
 * Detection answers only from the dispatch-time record (`staleReviewInputsV1`), so a legacy
 * review with no record, or one that never ran, is never reported stale.
 */
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { countOpenNestedChecklistItemsV1 } from "./implementationChecklist";
import { PLAN_OF_RECORD_FILENAME_V1, staleReviewInputsV1, type StaleReviewInputV1 } from "./reviewInputsChangedV1";
import { STAGE_ARTIFACT_FILENAMES, type TaskStage } from "../types/taskProgress";

/** Newest first: the code review closest to Publish is the verdict Publish relies on. */
const PUBLISH_RELIED_ON_REVIEW_STAGES_V1: readonly TaskStage[] = ["impl-low-review", "impl-high-review"];

export interface StalePublishVerdictV1 {
  readonly reviewStage: TaskStage;
  readonly stale: readonly StaleReviewInputV1[];
  readonly nestedItemsAdded: number;
  /** Unticked sub-items in the plan of record now. */
  readonly openNestedItems: number;
}

/**
 * The code review Publish relies on, when it started before `task.md` or the plan of record
 * changed. `undefined` when no such review has a usable dispatch-time record, or nothing changed.
 */
export async function findStalePublishVerdictV1(taskFolderPath: string): Promise<StalePublishVerdictV1 | undefined> {
  for (const reviewStage of PUBLISH_RELIED_ON_REVIEW_STAGES_V1) {
    const filename = STAGE_ARTIFACT_FILENAMES[reviewStage];
    if (!filename) {
      continue;
    }
    const check = await staleReviewInputsV1(taskFolderPath, path.join(taskFolderPath, filename));
    if (!check.recorded) {
      continue;
    }
    // The newest recorded review is the verdict in force; an older one is superseded by it.
    if (check.stale.length === 0) {
      return undefined;
    }
    let openNestedItems = 0;
    try {
      openNestedItems = countOpenNestedChecklistItemsV1(
        await readFile(path.join(taskFolderPath, PLAN_OF_RECORD_FILENAME_V1), "utf8")
      );
    } catch {
      openNestedItems = 0;
    }
    return { reviewStage, stale: check.stale, nestedItemsAdded: check.nestedItemsAdded, openNestedItems };
  }
  return undefined;
}

export interface StalePublishTextV1 {
  readonly notice: string;
  /** True when the new plan text added sub-items, so "Build the new items" is the useful recovery. */
  readonly offerBuildNewItems: boolean;
  readonly recommendation: "buildNewItems" | "rerunReview";
  readonly recommendationReasoning: string;
}

function describeStaleFileV1(entry: StaleReviewInputV1): string {
  return entry.modifiedAt !== undefined ? `${entry.name} (changed ${entry.modifiedAt})` : entry.name;
}

/** Wording for the card shown instead of starting Publish Checks over an out-of-date review. */
export function buildStalePublishTextV1(input: {
  readonly reviewStageName: string;
  readonly stale: readonly StaleReviewInputV1[];
  readonly nestedItemsAdded: number;
  readonly openNestedItems: number;
}): StalePublishTextV1 {
  const files = input.stale.map(describeStaleFileV1).join(" and ");
  const offerBuildNewItems = input.nestedItemsAdded > 0 || input.openNestedItems > 0;
  const added = input.nestedItemsAdded > 0 ? ` ${input.nestedItemsAdded} sub-item(s) added since that review.` : "";
  const open =
    input.openNestedItems > 0
      ? ` plan-final.md now has ${input.openNestedItems} unticked sub-item(s); each keeps its parent step open.`
      : "";
  return {
    notice:
      `Publish Checks were not started: ${files} changed after ${input.reviewStageName} started, so that review ` +
      `did not see the current text.${added}${open}`,
    offerBuildNewItems,
    recommendation: offerBuildNewItems ? "buildNewItems" : "rerunReview",
    recommendationReasoning: offerBuildNewItems
      ? "The plan gained work the last review never checked; build it before checking it."
      : "The last review did not see the current plan or task description.",
  };
}
