import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import {
  clearEscalation,
  IncompleteTask,
  patchTaskProgress,
} from "../utils/taskProgressUtils";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";

import { NotificationRouter } from "../utils/notificationRouter";
import { activateTask } from "../state/taskActivationCoordinator";
import { pickReopenStage, reopenCompletedTask } from "../utils/reopenTask";
import { runTrackedOperation } from "../utils/taskOperations";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";

/**
 * Accepted argument shapes for resumeTask.
 *
 * Commands may be invoked from:
 *   - Tree task-row buttons: the tree TaskNode itself, which has
 *     `.task: IncompleteTask` (TaskNode shape)
 *   - Keyboard shortcut router / command-palette: `{ canonicalId?, taskFolderPath? }`
 *   - Command palette (no arg): undefined
 */
type ResumeTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a ResumeTaskArg into the shape resolveTaskContext expects.
 *
 * Handles the tree-row TaskNode shape (`{ task: IncompleteTask }`) by
 * extracting the folder path, so task-row invocations from the Tasks view
 * resolve correctly instead of falling through to the persisted current task.
 *
 * @internal exported for testing
 */
export function normalizeResumeTaskArg(
  arg: ResumeTaskArg | undefined
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
export function resumeTaskArgHasExplicitTask(
  arg: ResumeTaskArg | undefined
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
 * Resume a paused task (set status back to "active") and persist it as the
 * current task in CurrentTaskStore so the keyboard shortcut and status bar
 * immediately reflect the resumed task.
 *
 * Uses patchTaskProgress to preserve unrelated fields (e.g. implReviewFiles,
 * scheduled metadata, lint results) when writing the updated status.
 */
export async function resumePausedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ResumeTaskArg
): Promise<void> {
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read, so it cannot race the read-only
  // creating-folder reconciliation extension.ts kicks off during activate()
  // — see TaskCreationStartupReconcilerV1's doc comment and startNewTask.ts's
  // identical use of waitUntilReady().
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const hasExplicitTask = resumeTaskArgHasExplicitTask(explicitArg);
  const resolverArg = normalizeResumeTaskArg(explicitArg);
  const resolvedTask = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
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
    NotificationRouter.showInformation("No paused tasks to resume.");
    return;
  }

  if (resolvedTask.progress.status === "completed") {
    return resumeCompletedTask(inventory, currentTaskStore, resolvedTask);
  }

  if (resolvedTask.progress.status !== "paused") {
    NotificationRouter.showInformation(`Task is not paused.`);
    return;
  }

  // Tracked instant mutation (taxonomy: resume-task / terminal-always). The
  // terminal entry is recorded centrally by the operation-notification bridge.
  // activateTask also persists the resumed task as the current task so the
  // keyboard shortcut router and status bar reflect it immediately —
  // CurrentTaskStore is the single source of truth for all surfaces.
  try {
    await runTrackedOperation(
      resolvedTask.taskFolderPath,
      { label: "Resume Task", taskName: resolvedTask.folderName, kind: "resume-task" },
      async () => {
        const activated = await activateTask(
          inventory, currentTaskStore, resolvedTask.taskFolderPath, resolvedTask.canonicalId
        );
        if (!activated) {
          throw new Error("Could not read task progress.");
        }
        // Resuming a task IS the human's "how would you like to proceed"
        // answer to a stuck-review escalation — clear it as a small,
        // additive follow-up write rather than threading it into
        // activateTask's own checkpoint/rollback machinery. A stale
        // escalation left behind here would otherwise linger in the task
        // tree and (once the task plateaus again) skew
        // secondOpinionTriedThisPlateau against a fresh attempt.
        await patchTaskProgress(
          vscode.Uri.file(resolvedTask.taskFolderPath),
          (current) => clearEscalation(current)
        );
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(message);
  }
}

/**
 * Resume a completed task by reopening it at a chosen stage (Publish
 * preselected). Shows the picker BEFORE any state changes — cancelling
 * leaves the task fully completed and pauses nothing. The lifecycle marker
 * (`completedAt`) is captured here, before the picker is shown, so the
 * in-write validation inside `reopenCompletedTask` can detect the task being
 * resumed or re-completed by another window while the picker was open.
 */
async function resumeCompletedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  resolvedTask: ResolvedTaskContext
): Promise<void> {
  const capturedCompletedAt = resolvedTask.progress.completedAt;
  const chosenStage = await pickReopenStage(resolvedTask.folderName);
  if (!chosenStage) {
    return;
  }

  // Tracked instant mutation (taxonomy: resume-task). The picker stays outside
  // the operation — no lock or spinner while the user is still deciding. A
  // stale or failed reopen throws so the operation ends in the `failed`
  // terminal state instead of recording a bogus "completed" entry.
  let result: Awaited<ReturnType<typeof reopenCompletedTask>> | undefined;
  try {
    await runTrackedOperation(
      resolvedTask.taskFolderPath,
      { label: "Resume Task", taskName: resolvedTask.folderName, kind: "resume-task" },
      async (op) => {
        result = await reopenCompletedTask(
          inventory,
          currentTaskStore,
          resolvedTask.taskFolderPath,
          resolvedTask.canonicalId,
          chosenStage,
          capturedCompletedAt
        );
        if (result.outcome !== "reopened") {
          throw new Error(result.message ?? "Could not reopen the task.");
        }
        op.report(`reopened at ${STAGE_DISPLAY_NAMES[chosenStage]}`);
      }
    );
  } catch {
    if (result?.outcome === "stale") {
      NotificationRouter.showWarning(result.message!);
    } else {
      NotificationRouter.showError(result?.message ?? "Could not reopen the task.");
    }
    return;
  }

  // A busy refusal resolves without throwing but never runs the reopen.
  if (result?.outcome !== "reopened") {
    return;
  }

  // The tracked resume operation has already produced the sole terminal
  // success entry through operationNotificationBridge.
}

/**
 * Register the resumeTask command
 */
export function registerResumeTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeTask",
    (arg?: ResumeTaskArg) =>
      resumePausedTask(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(disposable);
}
