import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import {
  IncompleteTask,
  patchTaskProgress,
  updateTaskStatus,
} from "../utils/taskProgressUtils";

/**
 * Accepted argument shapes for pauseTask.
 *
 * Commands may be invoked from:
 *   - Tree task-row buttons: the tree TaskNode itself, which has
 *     `.task: IncompleteTask` (TaskNode shape)
 *   - Keyboard shortcut router / command-palette: `{ canonicalId?, taskFolderPath? }`
 *   - Command palette (no arg): undefined
 */
type PauseTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a PauseTaskArg into the shape resolveTaskContext expects, plus
 * a flag indicating whether the caller supplied an explicit task identifier.
 *
 * Handles the tree-row TaskNode shape (`{ task: IncompleteTask }`) by
 * extracting the folder path, so task-row invocations from the Tasks view
 * resolve correctly instead of falling through to the persisted current task.
 *
 * @internal exported for testing
 */
export function normalizePauseTaskArg(
  arg: PauseTaskArg | undefined
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  // Tree task-row shape: TaskNode passes { task: IncompleteTask }
  if ("task" in arg && arg.task) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  // Explicit canonical-id / folder-path shape
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(a.canonicalId || a.taskFolderPath);
  return hasExplicit
    ? { canonicalId: a.canonicalId, taskFolderPath: a.taskFolderPath }
    : undefined;
}

/**
 * Return whether the raw arg represents an explicit task identifier.
 *
 * Used to distinguish "caller named a specific task that could not be found"
 * (should error) from "caller did not supply a task" (should show fallback
 * message or use persisted current task).
 *
 * @internal exported for testing
 */
export function pauseTaskArgHasExplicitTask(
  arg: PauseTaskArg | undefined
): boolean {
  if (!arg) {
    return false;
  }
  if ("task" in arg) {
    return !!arg.task;
  }
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  return !!(a.canonicalId || a.taskFolderPath);
}

/**
 * Mark a task as paused. Only active tasks may be paused.
 *
 * Uses patchTaskProgress to preserve unrelated fields (e.g. implReviewFiles,
 * scheduled metadata, lint results) when writing the updated status.
 */
export async function pauseTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: PauseTaskArg
): Promise<void> {
  const hasExplicitTask = pauseTaskArgHasExplicitTask(explicitArg);
  const resolverArg = normalizePauseTaskArg(explicitArg);
  const resolvedTask = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true }, // Allow paused to handle "already paused" message
    currentTaskStore
  );

  if (!resolvedTask) {
    // If the caller named a specific task (tree-row click, canonical ID, or
    // folder path) but resolution failed, the task no longer exists or is not
    // discoverable. Silently redirecting to a different task would be wrong.
    if (hasExplicitTask) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
      return;
    }
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
  const patched = await patchTaskProgress(taskUri, (current) =>
    updateTaskStatus(current, "paused")
  );
  if (!patched) {
    void vscode.window.showErrorMessage("Could not read task progress.");
    return;
  }

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
    (arg?: PauseTaskArg) =>
      pauseTask(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(disposable);
}
