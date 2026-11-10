import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import type { TaskStage } from "../types/taskProgress";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { readReviewCoverageSummaryV1 } from "../utils/reviewCoverageIoV1";
import {
  describeReviewedLineV1,
  describeUnreviewedConfirmationV1,
  describeUnreviewedWarningV1,
  unreviewedConfirmLabelV1,
  type ReviewCoverageSummaryV1,
} from "../utils/reviewCoverageV1";
import { resolveWorkspaceRootForTaskV1 } from "./applyReviewerVerifiedTicks";

/**
 * review2 Step 19: moving to Publish, or committing and pushing, while changed files were never read by a review is a
 * labelled confirmation that names the number of unreviewed files. The owner's choice is recorded in the chat.
 *
 * Nothing is asked when every changed file was reviewed, or when no review has recorded coverage yet (a task that
 * predates the record claims nothing either way).
 */

/** The moves this guard covers: into Publish. */
export function moveNeedsUnreviewedFilesConfirmationV1(destination: TaskStage): boolean {
  return destination === "publish";
}

/** The pop-up's message. */
export function describeUnreviewedFilesPopUpV1(summary: ReviewCoverageSummaryV1, action: string): string {
  const warning = describeUnreviewedWarningV1(summary) ?? "";
  const production =
    summary.unreviewedProduction.length > 0
      ? ` ${summary.unreviewedProduction.length} of them ${summary.unreviewedProduction.length === 1 ? "is a production file" : "are production files"}.`
      : "";
  return (
    `${warning}${production} ${action} publishes code no review has read at its current content. ` +
    "Nothing is lost: you can go back, review the remaining files, and move on once they are covered."
  );
}

/** Asks for the confirmation; resolves true when the owner confirmed (or nothing needs confirming). */
export async function confirmUnreviewedFilesV1(
  folderUri: vscode.Uri,
  action: string,
  options?: {
    readonly destination?: TaskStage;
    readonly source?: TaskStage;
    /** Test seam: replaces the pop-up. Resolves the chosen button label, or `undefined` when dismissed. */
    readonly showPopUp?: (message: string, confirmLabel: string) => PromiseLike<string | undefined>;
  }
): Promise<boolean> {
  if (options?.destination !== undefined && !moveNeedsUnreviewedFilesConfirmationV1(options.destination)) return true;
  const strict = await readTaskProgressStrictV1(folderUri);
  if (!strict.ok) return true;
  const progress = strict.decoded.progress;
  const workspaceRoot = resolveWorkspaceRootForTaskV1(folderUri);
  if (workspaceRoot === undefined) return true;
  const summary = await readReviewCoverageSummaryV1(workspaceRoot, progress).catch(() => undefined);
  if (summary === undefined || summary.reviewedCount >= summary.changedCount) return true;
  const confirmLabel = unreviewedConfirmLabelV1(summary, action);
  const message = describeUnreviewedFilesPopUpV1(summary, action);
  let choice: string | undefined;
  if (options?.showPopUp) {
    choice = await options.showPopUp(message, confirmLabel);
  } else {
    const taskLabel = formatNotificationTaskLabelV1(progress.displayName, folderUri.fsPath);
    choice = await vscode.window.showWarningMessage(`${taskLabel}: ${message}`, { modal: true }, confirmLabel);
  }
  if (choice !== confirmLabel) return false;
  await appendChatMessageV1(folderUri.fsPath, {
    role: "assistant",
    text: describeUnreviewedConfirmationV1(summary, action),
    stage: options?.source ?? progress.currentStage,
    at: new Date().toISOString(),
  }).catch(() => undefined);
  return true;
}

/** "Reviewed: N of M changed files" for a task, or `undefined` when no coverage is recorded. */
export async function readReviewedLineForTaskV1(folderUri: vscode.Uri): Promise<string | undefined> {
  const strict = await readTaskProgressStrictV1(folderUri);
  if (!strict.ok) return undefined;
  const workspaceRoot = resolveWorkspaceRootForTaskV1(folderUri);
  if (workspaceRoot === undefined) return undefined;
  const summary = await readReviewCoverageSummaryV1(workspaceRoot, strict.decoded.progress).catch(() => undefined);
  return summary === undefined ? undefined : describeReviewedLineV1(summary);
}
