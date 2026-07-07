import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import {
  readTaskProgress,
  updateTaskStatus,
  writeTaskProgress,
} from "../utils/taskProgressUtils";

/**
 * Resume a paused task (set status back to "active").
 */
export async function resumePausedTask(
  inventory: TaskInventory,
  explicitArg?: { canonicalId?: string; taskFolderPath?: string }
): Promise<void> {
  const resolvedTask = await resolveTaskContext(inventory, explicitArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage("No paused tasks to resume.");
    return;
  }

  if (resolvedTask.progress.status !== "paused") {
    void vscode.window.showInformationMessage(`Task is not paused.`);
    return;
  }

  const taskUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const progress = await readTaskProgress(taskUri);
  if (!progress) {
    void vscode.window.showErrorMessage("Could not read task progress.");
    return;
  }
  await writeTaskProgress(taskUri, updateTaskStatus(progress, "active"));
  await inventory.refresh();
  void vscode.window.showInformationMessage(`Task resumed.`);
}

/**
 * Register the resumeTask command
 */
export function registerResumeTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeTask",
    (arg?: { canonicalId?: string; taskFolderPath?: string }) =>
      resumePausedTask(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
