import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

/**
 * Apply high-level review changes. This command provides a concrete entry point
 * for the keyboard shortcut router and delegates to the text-root
 * (applyReviewWithAI) or edit-root (applyReviewEditWithAI) command, whichever
 * matches the resolved task's stage (plan §1.3 / AC-ROUTE-01).
 */
export async function applyHighLevelReviewChanges(
  inventory: TaskInventory,
  explicitArg?: { canonicalId?: string; taskFolderPath?: string; task?: { progress: { currentStage: string } } }
): Promise<void> {
  // Static edit and text safety gates MUST be asserted BEFORE any task, stage,
  // workspace, artifact, or task-progress reads occur (plan §1.3 / AC-ROUTE-01).
  assertLegacyAiRouteAllowedV0("applyReview.v1");

  const explicitStage = explicitArg?.task?.progress?.currentStage;

  let stage = explicitStage;
  if (!stage && explicitArg?.taskFolderPath) {
    const strict = await readTaskProgressStrictV1(vscode.Uri.file(explicitArg.taskFolderPath), {
      expectedTaskFolder: path.basename(explicitArg.taskFolderPath),
    });
    if (strict.ok) {
      stage = strict.decoded.progress.currentStage;
    }
  }

  const resolvedTask = await resolveTaskContext(inventory, explicitArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    NotificationRouter.showWarning(
      "No tasks at the High-Level Review stage."
    );
    return;
  }

  if (
    resolvedTask.progress.currentStage !== "plan-high-review" &&
    resolvedTask.progress.currentStage !== "impl-high-review"
  ) {
    NotificationRouter.showWarning(
      "Task is not at a High-Level Review stage."
    );
    return;
  }

  if (resolvedTask.progress.currentStage === "impl-high-review") {
    assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");

    if (resolvedTask.progress.status === "paused") {
      NotificationRouter.showWarning(
        "Task is paused. Resume it before applying review changes."
      );
      return;
    }

    await vscode.commands.executeCommand("vs-code-ai-helper.applyReviewEditWithAI", {
      task: {
        folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
        folderName: path.basename(resolvedTask.taskFolderPath),
        progress: resolvedTask.progress,
      },
    });
    return;
  }

  if (resolvedTask.progress.status === "paused") {
    NotificationRouter.showWarning(
      "Task is paused. Resume it before applying review changes."
    );
    return;
  }

  await vscode.commands.executeCommand("vs-code-ai-helper.applyReviewWithAI", {
    task: {
      folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
      folderName: path.basename(resolvedTask.taskFolderPath),
      progress: resolvedTask.progress,
    },
  });
}

/**
 * Register the applyHighLevelReviewChanges command.
 */
export function registerApplyHighLevelReviewChangesCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.applyHighLevelReviewChanges",
    (arg?: { canonicalId?: string; taskFolderPath?: string }) =>
      applyHighLevelReviewChanges(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
