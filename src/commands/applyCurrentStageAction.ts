import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
} from "../types/taskProgress";

/**
 * Keyboard shortcut router: applies the primary action for the current
 * task's active stage.
 *
 * - Task Description  -> draftTaskWithAI
 * - High-Level Review -> applyHighLevelReviewChanges (if artifact exists)
 * - Low-Level Review  -> applyLowLevelReviewChanges (if artifact exists)
 * - All other stages  -> info message
 */
export async function applyCurrentStageAction(
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

  const stage = resolvedTask.progress.currentStage;

  if (stage === "task-description") {
    await vscode.commands.executeCommand("vs-code-ai-helper.draftTaskWithAI", {
      canonicalId: resolvedTask.canonicalId,
    });
    return;
  }

  if (stage === "plan") {
    await vscode.commands.executeCommand("vs-code-ai-helper.generatePlanWithAI", {
      canonicalId: resolvedTask.canonicalId,
    });
    return;
  }

  if (stage === "plan-high-review") {
    const artifactName = STAGE_ARTIFACT_FILENAMES["plan-high-review"];
    if (artifactName) {
      const artifactUri = vscode.Uri.joinPath(
        vscode.Uri.file(resolvedTask.taskFolderPath),
        artifactName
      );
      try {
        await vscode.workspace.fs.stat(artifactUri);
        await vscode.commands.executeCommand(
          "vs-code-ai-helper.applyHighLevelReviewChanges",
          { canonicalId: resolvedTask.canonicalId }
        );
        return;
      } catch {
        void vscode.window.showInformationMessage(
          "No high-level review artifact found yet. Run Re-review first."
        );
        return;
      }
    }
    return;
  }

  if (stage === "plan-low-review") {
    const artifactName = STAGE_ARTIFACT_FILENAMES["plan-low-review"];
    if (artifactName) {
      const artifactUri = vscode.Uri.joinPath(
        vscode.Uri.file(resolvedTask.taskFolderPath),
        artifactName
      );
      try {
        await vscode.workspace.fs.stat(artifactUri);
        await vscode.commands.executeCommand(
          "vs-code-ai-helper.applyLowLevelReviewChanges",
          { canonicalId: resolvedTask.canonicalId }
        );
        return;
      } catch {
        void vscode.window.showInformationMessage(
          "No low-level review artifact found yet. Run Re-review first."
        );
        return;
      }
    }
    return;
  }

  void vscode.window.showInformationMessage(
    `No shortcut action for stage: ${STAGE_DISPLAY_NAMES[stage]}.`
  );
}

/**
 * Register the applyCurrentStageAction command.
 */
export function registerApplyCurrentStageActionCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.applyCurrentStageAction",
    () => applyCurrentStageAction(inventory, currentTaskStore)
  );
  context.subscriptions.push(disposable);
}
