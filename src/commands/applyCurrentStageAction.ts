import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
} from "../types/taskProgress";
import { patchTaskProgress } from "../utils/taskProgressUtils";

type ApplyArg = { canonicalId?: string; taskFolderPath?: string };

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
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
): Promise<void> {
  const resolvedTask = await resolveTaskContext(
    inventory,
    explicitArg,
    { allowPaused: true, promptForOwnershipResolution: true },
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
  const consumeNoteAfterSuccess = async (): Promise<void> => {
    if (!resolvedTask.progress.pendingNotes?.[stage]) return;
    await patchTaskProgress(vscode.Uri.file(resolvedTask.taskFolderPath), current => {
      // Never consume a note after a competing transition changed the stage.
      if (current.currentStage !== stage || !current.pendingNotes?.[stage]) return current;
      const pendingNotes = { ...current.pendingNotes };
      delete pendingNotes[stage];
      return { ...current, pendingNotes: Object.keys(pendingNotes).length ? pendingNotes : undefined, updatedAt: new Date().toISOString() };
    });
  };
  const execute = async (command: string): Promise<void> => {
    await vscode.commands.executeCommand(command, {
      canonicalId: resolvedTask.canonicalId,
      pendingNote: resolvedTask.progress.pendingNotes?.[stage],
    });
    await consumeNoteAfterSuccess();
  };

  if (stage === "desc") {
    await execute("vs-code-ai-helper.draftTaskWithAI");
    return;
  }

  if (stage === "plan") {
    await execute("vs-code-ai-helper.generatePlanWithAI");
    return;
  }

  if (stage === "publish") {
    await execute("vs-code-ai-helper.runLintingFixes");
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
        await execute("vs-code-ai-helper.applyHighLevelReviewChanges");
        return;
      } catch {
        void vscode.window.showInformationMessage(
          "No high-level review artifact found yet. Run Review first."
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
        await execute("vs-code-ai-helper.applyLowLevelReviewChanges");
        return;
      } catch {
        void vscode.window.showInformationMessage(
          "No low-level review artifact found yet. Run Review first."
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
    (arg?: ApplyArg) => applyCurrentStageAction(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(disposable);
}
