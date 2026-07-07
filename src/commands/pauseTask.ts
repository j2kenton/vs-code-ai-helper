import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import {
  readTaskProgress,
  updateTaskStatus,
  writeTaskProgress,
} from "../utils/taskProgressUtils";

/**
 * Mark a task as paused. Only active tasks may be paused.
 */
export async function pauseTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: { canonicalId?: string; taskFolderPath?: string }
): Promise<void> {
  const resolvedTask = await resolveTaskContext(
    inventory,
    explicitArg,
    { allowPaused: true }, // Allow paused to handle "already paused" message
    currentTaskStore
  );

  if (!resolvedTask) {
    void vscode.window.showInformationMessage("No active tasks to pause.");
    return;
  }

  // If already paused, show message
  if (resolvedTask.progress.status === "paused") {
    void vscode.window.showInformationMessage(
      `Task is already paused.`
    );
    return;
  }

  // If completed, don't allow pause
  if (resolvedTask.progress.currentStage === "completed") {
    void vscode.window.showInformationMessage(
      "Cannot pause a completed task."
    );
    return;
  }

  const taskUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const progress = await readTaskProgress(taskUri);
  if (!progress) {
    void vscode.window.showErrorMessage("Could not read task progress.");
    return;
  }

  await writeTaskProgress(taskUri, updateTaskStatus(progress, "paused"));
  await inventory.refresh();
  void vscode.window.showInformationMessage(`Task paused.`);
}

/**
 * Register the pauseTask command.
 */
export function registerPauseTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.pauseTask",
    (arg?: { canonicalId?: string; taskFolderPath?: string }) =>
      pauseTask(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(disposable);
}
