import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgress } from "../utils/taskProgressUtils";
import { updateTaskStatus } from "../utils/taskProgressTransforms";
import { IncompleteTask } from "../types/incompleteTask";

import { NotificationRouter } from "../utils/notificationRouter";
import { runTrackedOperation } from "../utils/taskOperations";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";

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
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read, so it cannot race the read-only
  // creating-folder reconciliation extension.ts kicks off during activate()
  // — same barrier contract as startNewTask/resumeTask (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

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
      NotificationRouter.showError(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
      return;
    }
    NotificationRouter.showInformation("No active tasks to pause.");
    return;
  }

  // §9.2: Pause is only for active tasks. Menus already hide Pause on
  // completed rows (contextTokens/package.json), but a programmatic
  // invocation (command palette arg, automation) could still reach here —
  // pausing a completed task would strand it outside both the completed and
  // active lifecycles, with Resume's reopen flow no longer applicable.
  if (resolvedTask.progress.status === "completed") {
    NotificationRouter.showInformation(
      "This task is completed — use Resume to reopen it at a stage."
    );
    return;
  }

  // If already paused, show message
  if (resolvedTask.progress.status === "paused") {
    NotificationRouter.showInformation(`Task is already paused.`);
    return;
  }

  // Tracked instant mutation (taxonomy: pause-task / terminal-always). The
  // registration is synchronous, so the Notifications row appears optimistically
  // the moment the button is pressed; the terminal entry is recorded centrally
  // by the operation-notification bridge, not by an ad-hoc message here.
  const taskUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  try {
    await runTrackedOperation(
      resolvedTask.taskFolderPath,
      { label: "Pause Task", taskName: resolvedTask.folderName, kind: "pause-task" },
      async () => {
        const patched = await patchTaskProgress(taskUri, (current) =>
          updateTaskStatus(current, "paused")
        );
        if (!patched) {
          throw new Error("Could not read task progress.");
        }
        await inventory.refresh();
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(message);
  }
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
