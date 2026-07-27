import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";

/**
 * Keyboard shortcut router: runs Review with AI against the current task,
 * without requiring the user to navigate the tree first.
 */
export async function reviewCurrentTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<void> {
  // Concrete alias route of the review action family (plan §1.3): the gate
  // must run before this wrapper's own task-state read, not only inside the
  // downstream runReviewWithAI handler it delegates to.
  assertLegacyAiRouteAllowedV0("review.v1");
  const resolvedTask = await resolveTaskContext(
    inventory,
    undefined,
    { allowPaused: true },
    currentTaskStore
  );

  if (!resolvedTask) {
    NotificationRouter.showWarning(
      "No active task found. Create or resume a task first."
    );
    return;
  }

  if (resolvedTask.progress.status === "paused") {
    NotificationRouter.showWarning(
      "Task is paused. Resume it before using this shortcut."
    );
    return;
  }

  await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", {
    taskFolderPath: resolvedTask.taskFolderPath,
  });
}

/**
 * Register the reviewCurrentTask command.
 */
export function registerReviewCurrentTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.reviewCurrentTask",
    () => reviewCurrentTask(inventory, currentTaskStore)
  );
  context.subscriptions.push(disposable);
}
