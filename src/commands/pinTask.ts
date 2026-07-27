import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask, patchTaskProgress } from "../utils/taskProgressUtils";
import { MAX_PINNED_TASKS } from "../types/taskProgress";
import { NotificationRouter } from "../utils/notificationRouter";
import { LegacyCreatingStartupGateV0 } from "../state/legacyCreatingStartupGateV0";

type PinTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

function normalizeArg(
  arg: PinTaskArg | undefined
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

/**
 * Pin a task so it sorts to the top of the task list (most recently pinned
 * first). At most MAX_PINNED_TASKS tasks can be pinned; pinning one more
 * automatically unpins the oldest pin and says so in a toast.
 */
export async function pinTask(
  inventory: TaskInventory,
  explicitArg?: PinTaskArg
): Promise<void> {
  // Activation-order barrier (plan §1.4): never read or patch task state
  // while the startup creating-folder classification pass is still running.
  await LegacyCreatingStartupGateV0.waitUntilReady();
  const resolved = await resolveTaskContext(inventory, normalizeArg(explicitArg), {
    allowPaused: true,
  });
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (resolved.progress.pinnedAt) {
    NotificationRouter.showInformation("Task is already pinned.");
    return;
  }

  // Enforce the pin cap: auto-unpin the oldest pinned task first. Archived
  // tasks keep their pin (progress data survives archive/resume) but are
  // hidden, so they neither count against the cap nor get auto-unpinned;
  // resumeArchivedTask re-checks the cap on the way back so a preserved pin
  // can never push the visible pinned count past MAX_PINNED_TASKS.
  const pinned = inventory
    .getTasks()
    .filter(
      (t) => t.progress.pinnedAt !== undefined && t.progress.status !== "archived"
    )
    .sort((a, b) => String(a.progress.pinnedAt).localeCompare(String(b.progress.pinnedAt)));
  if (pinned.length >= MAX_PINNED_TASKS) {
    const oldest = pinned[0];
    if (oldest) {
      await patchTaskProgress(vscode.Uri.file(oldest.taskFolderPath), (current) => ({
        ...current,
        pinnedAt: undefined,
      }));
      NotificationRouter.showInformation(
        `Pin limit of ${MAX_PINNED_TASKS} reached — unpinned "${oldest.progress.displayName ?? oldest.folderName}".`
      );
    }
  }

  await patchTaskProgress(vscode.Uri.file(resolved.taskFolderPath), (current) => ({
    ...current,
    pinnedAt: new Date().toISOString(),
  }));
  await inventory.refresh();
}

/** Remove a task's pin. */
export async function unpinTask(
  inventory: TaskInventory,
  explicitArg?: PinTaskArg
): Promise<void> {
  // Activation-order barrier (plan §1.4) — same rationale as pinTask above.
  await LegacyCreatingStartupGateV0.waitUntilReady();
  const resolved = await resolveTaskContext(inventory, normalizeArg(explicitArg), {
    allowPaused: true,
  });
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (!resolved.progress.pinnedAt) {
    NotificationRouter.showInformation("Task is not pinned.");
    return;
  }
  await patchTaskProgress(vscode.Uri.file(resolved.taskFolderPath), (current) => ({
    ...current,
    pinnedAt: undefined,
  }));
  await inventory.refresh();
}

export function registerPinTaskCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.pinTask",
      (arg?: PinTaskArg) => pinTask(inventory, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.unpinTask",
      (arg?: PinTaskArg) => unpinTask(inventory, arg)
    )
  );
}
