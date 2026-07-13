import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  isNoteAwareStage,
} from "../types/taskProgress";
import { patchTaskProgress } from "../utils/taskProgressUtils";

type ApplyArg = { canonicalId?: string; taskFolderPath?: string };

/** Return progress with a note removed only if its stage is still current. */
export function clearPendingNoteForStage(
  progress: import("../types/taskProgress").TaskProgress,
  stage: import("../types/taskProgress").TaskStage
): import("../types/taskProgress").TaskProgress {
  if (progress.currentStage !== stage || !progress.pendingNotes?.[stage]) return progress;
  const pendingNotes = { ...progress.pendingNotes };
  delete pendingNotes[stage];
  return {
    ...progress,
    pendingNotes: Object.keys(pendingNotes).length ? pendingNotes : undefined,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Routes the keyboard shortcut and other generic "current stage action"
 * entry points to the primary action for the current task stage. Keeping
 * those paths here ensures queued stage notes are supplied and consumed
 * consistently.
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
    if (!isNoteAwareStage(stage)) return;
    if (!resolvedTask.progress.pendingNotes?.[stage]) return;
    await patchTaskProgress(vscode.Uri.file(resolvedTask.taskFolderPath), current =>
      // Never consume a note after a competing transition changed the stage.
      clearPendingNoteForStage(current, stage)
    );
  };
  const execute = async (command: string, consumePendingNote = false): Promise<void> => {
    // Stage commands return `true` only after their requested work completed.
    // Do not discard a user's note merely because a command handled a failure
    // or cancellation internally.
    const succeeded = await vscode.commands.executeCommand<boolean>(command, {
      canonicalId: resolvedTask.canonicalId,
      taskFolderPath: resolvedTask.taskFolderPath,
      ...(consumePendingNote ? { pendingNote: resolvedTask.progress.pendingNotes?.[stage] } : {}),
    });
    if (succeeded === true && consumePendingNote) {
      await consumeNoteAfterSuccess();
    }
  };

  if (stage === "desc") {
    await execute("vs-code-ai-helper.draftTaskWithAI", true);
    return;
  }

  if (stage === "plan") {
    await execute("vs-code-ai-helper.generatePlanWithAI", true);
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
