import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import { LegacyCreatingStartupGateV0 } from "../state/legacyCreatingStartupGateV0";

type ApplyArg = { canonicalId?: string; taskFolderPath?: string };

/**
 * Routes the keyboard shortcut and other generic "current stage action"
 * entry points to the primary action for the current task stage.
 *
 * - Task Description  -> draftTaskWithAI
 * - Plan               -> generatePlanWithAI
 * - Implementation     -> runImplementationWithAI
 * - Publish            -> runPublishChecks (first Publish action: run the
 *   checks and produce the report; fixing is the separate second action)
 * - High-Level Review -> applyHighLevelReviewChanges (if artifact exists)
 * - Low-Level Review  -> applyLowLevelReviewChanges (if artifact exists)
 */
export async function applyCurrentStageAction(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
): Promise<void> {
  assertLegacyAiRouteAllowedV0("applyCurrentStage.v1");
  // Block on the startup gate's classification pass before this command's
  // first task-state read (plan §1.4). Runs after the synchronous route gate
  // above, which reads no state.
  await LegacyCreatingStartupGateV0.waitUntilReady();
  const resolvedTask = await resolveTaskContext(
    inventory,
    explicitArg,
    { allowPaused: true, promptForOwnershipResolution: true },
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

  const stage = resolvedTask.progress.currentStage;

  // Run-time model guard: a stage without a configured model (or whose
  // model's provider is disabled) shows an alert and opens AI Models
  // instead of failing silently mid-run.
  if (
    !(await ensureStageModelConfigured(
      vscode.Uri.file(resolvedTask.taskFolderPath),
      stage
    ))
  ) {
    return;
  }

  const execute = async (command: string): Promise<void> => {
    await vscode.commands.executeCommand(command, {
      canonicalId: resolvedTask.canonicalId,
      taskFolderPath: resolvedTask.taskFolderPath,
      task: {
        progress: resolvedTask.progress,
      },
    });
  };

  if (stage === "desc") {
    await execute("vs-code-ai-helper.draftTaskWithAI");
    return;
  }

  if (stage === "plan") {
    await execute("vs-code-ai-helper.generatePlanWithAI");
    return;
  }

  if (stage === "impl") {
    await execute("vs-code-ai-helper.runImplementationWithAI");
    return;
  }

  if (stage === "publish") {
    await execute("vs-code-ai-helper.runPublishChecks");
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
        NotificationRouter.showWarning(
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
        NotificationRouter.showWarning(
          "No low-level review artifact found yet. Run Review first."
        );
        return;
      }
    }
    return;
  }

  if (stage === "impl-high-review") {
    const artifactName = STAGE_ARTIFACT_FILENAMES["impl-high-review"];
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
        NotificationRouter.showWarning(
          "No high-level review artifact found yet. Run Review first."
        );
        return;
      }
    }
    return;
  }

  if (stage === "impl-low-review") {
    const artifactName = STAGE_ARTIFACT_FILENAMES["impl-low-review"];
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
        NotificationRouter.showWarning(
          "No low-level review artifact found yet. Run Review first."
        );
        return;
      }
    }
    return;
  }
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
