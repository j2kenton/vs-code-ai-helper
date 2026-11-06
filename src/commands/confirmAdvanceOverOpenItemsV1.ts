import * as vscode from "vscode";

import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import {
  advanceNeedsOpenItemsConfirmationV1,
  advanceOverOpenItemsLabelV1,
  describeAdvanceOverOpenItemsV1,
} from "../utils/advanceOverOpenItemsV1";
import { readPlanItemCountsV1 } from "../utils/effectiveReviewProgress";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";

/** The quoted task label a pop-up leads with: the display name when the progress file has one, else the folder's. */
export async function readTaskPopUpLabelV1(folderUri: vscode.Uri): Promise<string> {
  const progress = await readTaskProgressStrictV1(folderUri);
  return formatNotificationTaskLabelV1(progress.ok ? progress.decoded.progress.displayName : undefined, folderUri.fsPath);
}

/**
 * review1 Step 57: the one confirmation for moving out of High-Level Code Review while plan items are still open.
 * Complete Stage & Move On (`nextStage`) and the "Advance to …" card option (`resumeAndSetTaskStageV1`) both call
 * it, so a card cannot skip the pop-up the command shows. A pop-up, because the move answers a click; the only
 * button that goes ahead names what is being skipped. Dismissing it leaves the stage as it was.
 *
 * Returns `true` when the move may go ahead: no open items, a move this guard does not cover, or the owner chose
 * the labelled override.
 */
export async function confirmAdvanceOverOpenItemsV1(
  folderUri: vscode.Uri,
  source: TaskStage,
  destination: TaskStage,
  /** Test seam: replaces the pop-up. Resolves the chosen button label, or `undefined` when dismissed. */
  showPopUp?: (message: string, overrideLabel: string) => PromiseLike<string | undefined>
): Promise<boolean> {
  if (!advanceNeedsOpenItemsConfirmationV1(source, destination)) return true;
  const counts = await readPlanItemCountsV1(folderUri, { policy: "lenient", mode: "gate" });
  const openCount = counts?.open ?? 0;
  if (openCount <= 0) return true;
  const overrideLabel = advanceOverOpenItemsLabelV1(openCount);
  const message = describeAdvanceOverOpenItemsV1(openCount, STAGE_DISPLAY_NAMES[destination]);
  let choice: string | undefined;
  if (showPopUp) {
    choice = await showPopUp(message, overrideLabel);
  } else {
    const taskLabel = await readTaskPopUpLabelV1(folderUri);
    choice = await vscode.window.showWarningMessage(`${taskLabel}: ${message}`, { modal: true }, overrideLabel);
  }
  return choice === overrideLabel;
}
