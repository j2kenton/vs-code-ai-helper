import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";

/**
 * Apply low-level review changes. This command provides a concrete entry point
 * for the keyboard shortcut router and delegates to the unified applyReviewWithAI
 * command.
 */
export async function applyLowLevelReviewChanges(
  inventory: TaskInventory,
  explicitArg?: { canonicalId?: string; taskFolderPath?: string }
): Promise<void> {
  // First try with allowPaused: true to detect paused tasks
  const pausedCheck = await resolveTaskContext(inventory, explicitArg, {
    allowPaused: true,
  });

  if (pausedCheck && pausedCheck.progress.status === "paused") {
    void vscode.window.showInformationMessage(
      "Task is paused. Resume it before applying review changes."
    );
    return;
  }

  const resolvedTask = await resolveTaskContext(inventory, explicitArg, {
    allowPaused: false,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No tasks at the Low-Level Review stage."
    );
    return;
  }

  if (
    resolvedTask.progress.currentStage !== "plan-low-review" &&
    resolvedTask.progress.currentStage !== "impl-low-review"
  ) {
    void vscode.window.showInformationMessage(
      "Task is not at a Low-Level Review stage."
    );
    return;
  }

  // Delegate to the unified review apply command using taskFolderPath so the
  // normalizeReviewArg helper in reviewActions can resolve the task correctly.
  await vscode.commands.executeCommand("vs-code-ai-helper.applyReviewWithAI", {
    taskFolderPath: resolvedTask.taskFolderPath,
  });
}

/**
 * Register the applyLowLevelReviewChanges command.
 */
export function registerApplyLowLevelReviewChangesCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.applyLowLevelReviewChanges",
    (arg?: { canonicalId?: string; taskFolderPath?: string }) =>
      applyLowLevelReviewChanges(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
