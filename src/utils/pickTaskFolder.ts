import * as vscode from "vscode";
import { getConfiguredTaskRoot } from "./taskRoot";
import { findIncompleteTasksStrictV1 } from "../services/taskProgressDiscoveryV1";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "./notificationRouter";
import { askChatChoiceV1 } from "./chatChoiceV1";
import { resolveGlobalChatTargetOrDefaultV1 } from "./globalChatTargetV1";

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

  const target = await resolveGlobalChatTargetOrDefaultV1(workspaceRoot.uri.fsPath);
  const pickedOptionId = await askChatChoiceV1({
    target,
    decisionKey: "pickTaskFolder",
    whatHappened: `${quickPickTitle} — Select a task.`,
    whyUserNeeded: "Multiple tasks are eligible for this action.",
    options: tasks.map((task, index) => ({
      optionId: `task_${index}`,
      label: task.progress.displayName ?? task.folderName,
      // wf10 item 21: folder id as description alongside stage, rather than
      // rendering only the unrecognizable folder id as the whole label.
      description: `${task.folderName} · Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
    })),
  });
  if (!pickedOptionId) {
    return undefined;
  }
  const pickedIndex = Number.parseInt(pickedOptionId.replace(/^task_/, ""), 10);
  return Number.isFinite(pickedIndex) ? tasks[pickedIndex]?.folderUri : undefined;
}
