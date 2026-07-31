import * as vscode from "vscode";
import { getConfiguredTaskRoot } from "./taskRoot";
import { findIncompleteTasksStrictV1 } from "../services/taskProgressDiscoveryV1";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "./notificationRouter";

/**
 * Prompt the user to pick a task folder to operate on, restricted to
 * tasks whose current stage is in `eligibleStages`. This prevents AI
 * commands from being pointed at tasks that are further along in the
 * workflow, which would otherwise regress their stage and leave stale
 * later-stage artifacts behind.
 * Returns undefined if there is no valid meta folder, no eligible tasks,
 * or the user cancels the picker.
 */
export async function pickTaskFolder(
  quickPickTitle: string,
  eligibleStages: readonly TaskStage[]
): Promise<vscode.Uri | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showWarning(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getConfiguredTaskRoot()
  );

  // Strict discovery (plan §3.12): undecodable folders are excluded from the
  // picker — they surface as recovery nodes in the Tasks view instead.
  const allTasks = (await findIncompleteTasksStrictV1(metaFolderUri)).tasks;
  const tasks = allTasks.filter((task) =>
    eligibleStages.includes(task.progress.currentStage)
  );

  if (tasks.length === 0) {
    NotificationRouter.showWarning(
      allTasks.length === 0
        ? "No task folders found. Use 'Start New Task' to create one."
        : "No tasks are at a stage eligible for this action."
    );
    return undefined;
  }

  if (tasks.length === 1) {
    return tasks[0]?.folderUri;
  }

  const items = tasks.map((task) => ({
    label: task.folderName,
    description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
    folderUri: task.folderUri,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a task",
    title: quickPickTitle,
  });

  return selected?.folderUri;
}
