import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";

/**
 * Keyboard shortcut router: runs Re-review with AI against the current task,
 * without requiring the user to navigate the tree first.
 */
export async function reReviewCurrentTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<void> {
  const resolvedTask = await resolveTaskContext(
    inventory,
    undefined,
    { allowPaused: true },
    currentTaskStore
  );

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No active task found. Create or resume a task first."
    );
    return;
  }

  if (resolvedTask.progress.status === "paused") {
    void vscode.window.showInformationMessage(
      "Task is paused. Resume it before using this shortcut."
    );
    return;
  }

  await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", {
    taskFolderPath: resolvedTask.taskFolderPath,
  });
}

/**
 * Register the reReviewCurrentTask command.
 */
export function registerReReviewCurrentTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.reReviewCurrentTask",
    () => reReviewCurrentTask(inventory, currentTaskStore)
  );
  context.subscriptions.push(disposable);
}
