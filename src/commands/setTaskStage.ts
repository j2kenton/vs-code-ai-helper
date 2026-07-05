import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import {
  findAllTasks,
  IncompleteTask,
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";

/**
 * Let the user jump a task's tracked stage backward or forward, overriding
 * the stage the workflow last auto-advanced it to. Useful when the automatic
 * stage tracking gets ahead of where the user actually is (e.g. they started
 * a review but aren't happy with the plan yet), or when they want to
 * redo a step. Does not touch any files in the task folder — it only changes
 * which stage `Resume Task` and the "with AI" commands treat as current.
 *
 * When invoked from the tasks tree view, the tree node is passed in and the
 * task picker is skipped.
 */
export async function setTaskStage(node?: {
  task?: IncompleteTask;
}): Promise<void> {
  if (!hasValidMetaResourcesPath()) {
    void vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first."
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getMetaResourcesPath()
  );

  const tasks = await findAllTasks(metaFolderUri);
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
      "No task folders found. Use 'Start New Task' to create one."
    );
    return;
  }

  const taskItems = tasks.map((task) => ({
    label: task.folderName,
    description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
    detail: `Last updated: ${new Date(
      task.progress.updatedAt
    ).toLocaleString()}`,
    task,
  }));

  const preselectedFolder = node?.task?.folderName;
  const preselectedItem = preselectedFolder
    ? taskItems.find((item) => item.task.folderName === preselectedFolder)
    : undefined;

  const selectedTaskItem =
    preselectedItem ??
    (taskItems.length === 1
      ? taskItems[0]
      : await vscode.window.showQuickPick(taskItems, {
          placeHolder: "Select a task",
          title: "Set Task Stage",
        }));

  if (!selectedTaskItem) {
    return;
  }

  const { task } = selectedTaskItem;

  const stageItems = STAGE_ORDER.map((stage) => ({
    label: STAGE_DISPLAY_NAMES[stage],
    description:
      stage === task.progress.currentStage ? "Current stage" : undefined,
    stage,
  }));

  const selectedStageItem = await vscode.window.showQuickPick(stageItems, {
    placeHolder: "Select the stage this task should be on",
    title: `Set Stage: ${task.folderName}`,
  });

  if (!selectedStageItem) {
    return;
  }

  const newStage: TaskStage = selectedStageItem.stage;
  if (newStage === task.progress.currentStage) {
    return;
  }

  const updated = updateTaskProgressStage(task.progress, newStage);
  await writeTaskProgress(task.folderUri, updated);

  void vscode.window.showInformationMessage(
    `${task.folderName} set to stage: ${STAGE_DISPLAY_NAMES[newStage]}`
  );
}

/**
 * Register the setTaskStage command
 */
export function registerSetTaskStageCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setTaskStage",
    setTaskStage
  );

  context.subscriptions.push(disposable);
}
