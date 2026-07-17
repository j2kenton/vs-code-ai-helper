import * as vscode from "vscode";
import { getConfiguredTaskRoot } from "./taskRoot";
import { findIncompleteTasks } from "./taskProgressUtils";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";

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
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getConfiguredTaskRoot()
  );

  const allTasks = await findIncompleteTasks(metaFolderUri);
  const tasks = allTasks.filter((task) =>
    eligibleStages.includes(task.progress.currentStage)
  );

  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
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
