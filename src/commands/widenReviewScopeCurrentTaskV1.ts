import * as vscode from "vscode";

import { forwardInViewerV1 } from "../services/viewerForwardingV1";
import { TaskInventory } from "../state/taskInventory";
import { IMPL_REVIEW_STAGES } from "../types/taskProgress";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { runWithNotificationTaskContextV1 } from "../utils/notificationTaskContextV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { resolveWorkspaceRootForTaskV1 } from "./applyReviewerVerifiedTicks";
import { resolvePartialReviewScopeV1 } from "./partialScopeDecisionV1";
import { readAllChangedFilesForScopeWideningV1 } from "./reviewActions";

/** review2 Step 14: the palette command's id. */
export const WIDEN_REVIEW_SCOPE_COMMAND_V1 = "vs-code-ai-helper.widenReviewScopeToAllChanged";

/**
 * "Ensemble: Widen Review Scope to All Changed Files": adds every file the task changed (git's diff against the task's
 * baseline commit, plus untracked files) to the current task's review scope and runs the stage's review again, through
 * the same `resolvePartialReviewScopeV1` the partial-scope card's "Add the missing files" uses. Works without waiting
 * for a card: a review that was shown only part of the change can be widened from the palette at any time. The review
 * runs because the changed file list is a changed review input (review2 Step 9).
 */
export async function widenReviewScopeCurrentTaskV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<void> {
  const resolved = await resolveTaskContext(inventory, undefined, { allowPaused: true }, currentTaskStore);
  if (!resolved) {
    NotificationRouter.showWarning("No active task found. Create or resume a task first.");
    return;
  }
  // Everything from here is about one resolved task, so every notice it raises names that task.
  await runWithNotificationTaskContextV1(resolved.progress.displayName, resolved.taskFolderPath, async () => {
    const stage = resolved.progress.currentStage;
    if (!IMPL_REVIEW_STAGES.includes(stage)) {
      NotificationRouter.showWarning(
        `The review scope can be widened at a code review stage; this task is at ${STAGE_DISPLAY_NAMES[stage] ?? stage}.`
      );
      return;
    }
    const folderUri = vscode.Uri.file(resolved.taskFolderPath);
    const workspaceRoot = resolveWorkspaceRootForTaskV1(folderUri);
    if (!workspaceRoot) {
      NotificationRouter.showWarning("The task's workspace folder could not be found, so the review scope was not widened.");
      return;
    }
    const changed = await readAllChangedFilesForScopeWideningV1(folderUri, vscode.Uri.file(workspaceRoot), resolved.progress);
    if (changed.kind !== "established") {
      NotificationRouter.showWarning(`The review scope was not widened: ${changed.reason}.`);
      return;
    }
    if (changed.files.length === 0) {
      NotificationRouter.showInformation("Git lists no changed files for this task, so there is nothing to add to the review scope.");
      return;
    }
    await resolvePartialReviewScopeV1({
      taskFolderPath: resolved.taskFolderPath,
      stage,
      action: "addAndRereview",
      missingFiles: changed.files,
      hash: "",
    });
  });
}

export function registerWidenReviewScopeCommandV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      WIDEN_REVIEW_SCOPE_COMMAND_V1,
      forwardInViewerV1(WIDEN_REVIEW_SCOPE_COMMAND_V1, () => widenReviewScopeCurrentTaskV1(inventory, currentTaskStore))
    )
  );
}
