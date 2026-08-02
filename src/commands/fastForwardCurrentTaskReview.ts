import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import {
  checkEditActionHostGateV1,
  checkEditActionProviderPathGateV1,
} from "./runEditActionV1";

/**
 * Keyboard shortcut router: runs Fast Forward Review against the current
 * task, without requiring the user to navigate the tree first.
 */
export async function fastForwardCurrentTaskReview(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<void> {
  // Concrete alias route of the fast-forward action family (plan §1.3): the
  // gate must run before this wrapper's own task-state read, not only inside
  // the downstream fastForwardReviewWithAI handler it delegates to.
  assertLegacyAiRouteAllowedV0("fastForward.v1");

  // §7.5 (AC-HOST-03): unlike fastForwardReviewWithAI's own early gate —
  // which can trust an already-resident caller-supplied `arg.task.progress`
  // and so skip the gate at zero extra cost when that data proves the
  // target is plan-review-only — this keyboard-shortcut router has no such
  // caller-supplied data. Answering "is the target plan-review-only" here
  // would require reading `currentTaskStore` and/or `TaskInventory` first,
  // and those are task-state reads. So this router enforces the coarse
  // host/provider gate unconditionally, before touching `currentTaskStore`
  // or `TaskInventory` at all — no peek, no conditional skip.
  const earlyHostGate = checkEditActionHostGateV1();
  if (!earlyHostGate.ok) {
    NotificationRouter.showWarning(earlyHostGate.reason);
    return;
  }
  const earlyProviderPathGate = checkEditActionProviderPathGateV1("impl");
  if (!earlyProviderPathGate.ok) {
    NotificationRouter.showWarning(earlyProviderPathGate.reason);
    return;
  }

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

  // Pass the already-resolved task/progress through (rather than a bare
  // `taskFolderPath`) so fastForwardReviewWithAI's zero-I/O routing check
  // (fastForwardTargetsImplReviewV1, reviewActions.ts) can decide whether its
  // early host/provider gate applies from this in-memory progress alone,
  // instead of needing its own extra read to answer the same question this
  // command's resolveTaskContext call above already answered.
  await vscode.commands.executeCommand("vs-code-ai-helper.fastForwardReviewWithAI", {
    task: {
      folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
      folderName: resolvedTask.folderName,
      progress: resolvedTask.progress,
    },
  });
}

/**
 * Register the fastForwardCurrentTaskReview command.
 */
export function registerFastForwardCurrentTaskReviewCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.fastForwardCurrentTaskReview",
    () => fastForwardCurrentTaskReview(inventory, currentTaskStore)
  );
  context.subscriptions.push(disposable);
}
