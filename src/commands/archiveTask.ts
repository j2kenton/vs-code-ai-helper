import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { activateTask } from "../state/taskActivationCoordinator";
import {
  IncompleteTask,
  patchTaskProgress,
} from "../utils/taskProgressUtils";
import { MAX_PINNED_TASKS, TaskProgress, TaskStatus } from "../types/taskProgress";
import { NotificationRouter } from "../utils/notificationRouter";
import { cancelRunningOperationsForTask, runTrackedOperation } from "../utils/taskOperations";
import { PendingOperationsStore } from "../state/pendingOperationsStore";
import { LegacyCreatingStartupGateV0 } from "../state/legacyCreatingStartupGateV0";

/**
 * Accepted argument shapes: the tree TaskNode (`{ task: IncompleteTask }`)
 * or an explicit `{ canonicalId?, taskFolderPath? }` reference.
 */
type ArchiveTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

function normalizeArg(
  arg: ArchiveTaskArg | undefined
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  if ("task" in arg && arg.task) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  return a.canonicalId || a.taskFolderPath
    ? { canonicalId: a.canonicalId, taskFolderPath: a.taskFolderPath }
    : undefined;
}

/** Statuses a task may be archived from. */
const ARCHIVABLE_STATUSES: readonly TaskStatus[] = ["active", "paused", "completed"];

/**
 * Archiving must never leave a live process writing into an archived task —
 * merely deleting the record is not enough, so the archive aborts if
 * cancellation fails or the wait times out. Thin archive-flavored alias over
 * the shared `cancelRunningOperationsForTask` (taskOperations.ts), kept so
 * existing call sites/imports don't need to change.
 */
export const cancelRunningOperationsForArchive = cancelRunningOperationsForTask;

/**
 * Archive a task. Allowed from the active, paused, and completed states.
 * The prior status is preserved in `archivedFrom`, and `completedAt`,
 * `pinnedAt`, plus all stage/progress data stay untouched (progress data is
 * preserved through archive/resume; archived tasks are hidden, so a kept
 * pin occupies no visible slot). A running AI operation is cancelled (the
 * actual process) first; if cancellation fails, the archive aborts.
 * Scheduled runs and persisted pending-operation records are cleared so
 * nothing fires against a parked task. Archiving the currently selected
 * task clears the selection.
 */
export async function archiveTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ArchiveTaskArg,
  pendingOperations?: PendingOperationsStore
): Promise<void> {
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read — same barrier contract as
  // startNewTask/resumeTask (plan §1.4).
  await LegacyCreatingStartupGateV0.waitUntilReady();

  const resolved = await resolveTaskContext(
    inventory,
    normalizeArg(explicitArg),
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }

  const status = resolved.progress.status ?? "active";
  if (status === "archived") {
    NotificationRouter.showInformation("Task is already archived.");
    return;
  }
  if (!ARCHIVABLE_STATUSES.includes(status)) {
    NotificationRouter.showInformation(
      "Only active, paused, or completed tasks can be archived."
    );
    return;
  }

  // A live AI process must never keep writing into an archived task:
  // cancel the real run and wait for termination before touching state.
  const cancelResult = await cancelRunningOperationsForArchive(resolved.taskFolderPath);
  if (!cancelResult.ok) {
    NotificationRouter.showError(
      `Could not archive "${resolved.folderName}": ${cancelResult.reason}`
    );
    return;
  }

  const taskUri = vscode.Uri.file(resolved.taskFolderPath);
  try {
    await runTrackedOperation(
      resolved.taskFolderPath,
      { label: "Archive Task", taskName: resolved.folderName, kind: "pause-task" },
      async () => {
        const patched = await patchTaskProgress(taskUri, (current) => ({
          ...current,
          status: "archived" as TaskStatus,
          archivedFrom: current.status ?? "active",
          // pinnedAt is progress data and survives archive/resume; only
          // scheduled work must never fire against a parked task.
          scheduledRun: undefined,
          scheduledResumeTime: undefined,
          updatedAt: new Date().toISOString(),
        }));
        if (!patched) {
          throw new Error("Could not read task progress.");
        }
        // Parked tasks must not keep persisted pending-operation records
        // either — those would otherwise be recovered/reconciled against an
        // archived task on the next activation.
        await pendingOperations?.removeForTask(resolved.canonicalId);
        if (currentTaskStore.get() === resolved.canonicalId) {
          await currentTaskStore.clear();
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
 * Resume an archived task: it returns to the active lifecycle status
 * regardless of what it was archived from. `completedAt` is preserved as
 * historical metadata only — completion is inferred solely from `status`,
 * so a previously completed task can reach Publish and be re-completed.
 *
 * A preserved pin is re-admitted only while the pin cap has room: archived
 * pins don't count against MAX_PINNED_TASKS (they're hidden), so resuming
 * one into a list that has since filled up to the cap would exceed it —
 * the resumed task's pin is dropped (with a notice) instead of unpinning a
 * task the user pinned more recently.
 */
export async function resumeArchivedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ArchiveTaskArg
): Promise<void> {
  // Same activation-barrier contract as archiveTask above (plan §1.4).
  await LegacyCreatingStartupGateV0.waitUntilReady();

  const resolved = await resolveTaskContext(
    inventory,
    normalizeArg(explicitArg),
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (resolved.progress.status !== "archived") {
    NotificationRouter.showInformation("Task is not archived.");
    return;
  }

  const visiblePinnedCount = inventory
    .getTasks()
    .filter(
      (t) =>
        t.canonicalId !== resolved.canonicalId &&
        t.progress.pinnedAt !== undefined &&
        t.progress.status !== "archived"
    ).length;
  const dropPin =
    resolved.progress.pinnedAt !== undefined &&
    visiblePinnedCount >= MAX_PINNED_TASKS;

  try {
    await runTrackedOperation(
      resolved.taskFolderPath,
      { label: "Resume Task", taskName: resolved.folderName, kind: "resume-task" },
      async () => {
        const activated = await activateTask(
          inventory,
          currentTaskStore,
          resolved.taskFolderPath,
          resolved.canonicalId,
          {
            mutateTarget: (current: TaskProgress): TaskProgress => ({
              ...current,
              archivedFrom: undefined,
              ...(dropPin ? { pinnedAt: undefined } : {}),
              updatedAt: new Date().toISOString(),
            }),
          }
        );
        if (!activated) {
          throw new Error("Could not read task progress.");
        }
        if (dropPin) {
          NotificationRouter.showInformation(
            `Pin limit of ${MAX_PINNED_TASKS} reached — "${resolved.progress.displayName ?? resolved.folderName}" was resumed unpinned.`
          );
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(message);
  }
}

export function registerArchiveTaskCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const pendingOperations = new PendingOperationsStore(context.workspaceState);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.archiveTask",
      (arg?: ArchiveTaskArg) => archiveTask(inventory, currentTaskStore, arg, pendingOperations)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.unarchiveTask",
      (arg?: ArchiveTaskArg) => resumeArchivedTask(inventory, currentTaskStore, arg)
    )
  );
}
