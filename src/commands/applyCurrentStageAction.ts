import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  decidePostReviewActionV1,
  IMPL_REVIEW_STAGES_V1,
} from "../utils/reviewRouting";
import { readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import { goToReviewAndApplyV1 } from "./goToReviewAndApplyV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";

type ApplyArg = {
  canonicalId?: string;
  taskFolderPath?: string;
  /**
   * Single-use same-process admission handoff token (2026-09-09 review
   * completion blocker: "a scheduled stage action must dispatch, or must not
   * consume its schedule"). Set only by a caller that already holds live
   * durable admission for this exact task and wants THIS dispatch to run
   * under it — currently `scheduleTaskResume.ts`'s `fire()`. Never set by a
   * UI surface (tree buttons, command palette, keyboard shortcut), so an
   * interactive invocation always takes the plain paused-refusal path below.
   * Forwarded into whichever downstream stage command this function
   * dispatches, so that command's own admission acquisition can adopt the
   * caller's marker (`acquireOrAdoptWorkAdmissionV1`) instead of racing a
   * fresh genesis against it and refusing `busy` — the exact self-block that
   * used to make `fire()` silently consume a schedule without dispatching
   * anything.
   */
  admissionHandoffTokenV1?: string;
};

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
 *
 * Returns whether a downstream stage command was actually dispatched (`true`)
 * or this call refused before dispatching anything (`false` — no task
 * resolved, still paused, model not configured, unknown stage, no review
 * artifact yet). `scheduleTaskResume.ts`'s `fire()` reads this to decide
 * whether a fired schedule may be safely cleared or must be restored
 * (2026-09-09 review completion blocker).
 */
export async function applyCurrentStageAction(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
): Promise<boolean> {
  assertLegacyAiRouteAllowedV0("applyCurrentStage.v1");
  // Block on the startup gate's classification pass before this command's
  // first task-state read (plan §1.4). Runs after the synchronous route gate
  // above, which reads no state.
  await TaskCreationStartupReconcilerV1.waitUntilReady();
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
    return false;
  }

  if (resolvedTask.progress.status === "paused") {
    // A caller-presented handoff token means the caller (currently only
    // `scheduleTaskResume.ts`'s `fire()`) already holds live durable
    // admission for this exact task — proof this dispatch is exactly the
    // work a watchdog pause complained was silently missing. Reconcile
    // (never a user/quota pause — see that function's own doc comment)
    // before falling back to the plain refusal below, so a resumed-then-
    // immediately-re-paused race can't defeat a caller that already proved
    // it is doing the work.
    const stillPaused = explicitArg?.admissionHandoffTokenV1
      ? (await reconcileWatchdogPauseAgainstAdmissionV1(
          vscode.Uri.file(resolvedTask.taskFolderPath)
        )).outcome !== "reversed"
      : true;
    if (stillPaused) {
      NotificationRouter.showWarning(
        "Task is paused. Resume it before using this shortcut."
      );
      return false;
    }
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
    return false;
  }

  const execute = async (command: string): Promise<void> => {
    await vscode.commands.executeCommand(command, {
      canonicalId: resolvedTask.canonicalId,
      taskFolderPath: resolvedTask.taskFolderPath,
      task: {
        progress: resolvedTask.progress,
      },
      admissionHandoffTokenV1: explicitArg?.admissionHandoffTokenV1,
    });
  };

  if (stage === "desc") {
    await execute("vs-code-ai-helper.draftTaskWithAI");
    return true;
  }

  if (stage === "plan") {
    await execute("vs-code-ai-helper.generatePlanWithAI");
    return true;
  }

  if (stage === "impl") {
    // Implementation is rendered with the plan checklist and NOT with the
    // review, so it is structurally blind to a standing blocker. Running it
    // while the newest impl review still reports task-fixable work is the
    // stall this routing exists to prevent: the reviewer keeps reporting the
    // same defects, every round is answered by the one action that cannot see
    // them, and the checklist it CAN see has nothing actionable left. See
    // decidePostReviewActionV1 for the observed case.
    const decision = decidePostReviewActionV1({
      history: resolvedTask.progress.reviewScoreHistory,
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems:
        ((
          await readPlanOfRecordV1(vscode.Uri.file(resolvedTask.taskFolderPath))
        ).counts?.remaining ?? 0) > 0,
      continuationOwed: resolvedTask.progress.implRecovery !== undefined,
      pendingImplReviewFilesCount: resolvedTask.progress.pendingImplReviewFiles?.length ?? 0,
    });
    if (decision.action === "apply-review") {
      // Say WHY the button did something other than the stage's usual action.
      // A silent substitution is the same opaque "big red button" problem in
      // the other direction.
      NotificationRouter.showInformation(
        `Running Apply Review instead of Implementation. ${decision.reason}`
      );
      // Moves to the review stage first: the task is at `impl` here, which is
      // precisely why this branch was reached, and every apply command
      // refuses out of stage. See goToReviewAndApplyV1.
      await goToReviewAndApplyV1({
        taskFolderPath: resolvedTask.taskFolderPath,
        reviewStage:
          decision.reviewStage === "impl-high-review"
            ? "impl-high-review"
            : "impl-low-review",
      });
      return true;
    }
    await execute("vs-code-ai-helper.runImplementationWithAI");
    return true;
  }

  if (stage === "publish") {
    await execute("vs-code-ai-helper.runPublishChecks");
    return true;
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
        return true;
      } catch {
        NotificationRouter.showWarning(
          "No high-level review artifact found yet. Run Review first."
        );
        return false;
      }
    }
    return false;
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
        return true;
      } catch {
        NotificationRouter.showWarning(
          "No low-level review artifact found yet. Run Review first."
        );
        return false;
      }
    }
    return false;
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
        return true;
      } catch {
        NotificationRouter.showWarning(
          "No high-level review artifact found yet. Run Review first."
        );
        return false;
      }
    }
    return false;
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
        return true;
      } catch {
        NotificationRouter.showWarning(
          "No low-level review artifact found yet. Run Review first."
        );
        return false;
      }
    }
    return false;
  }

  return false;
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
