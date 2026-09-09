import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

/**
 * Apply low-level review changes. This command provides a concrete entry point
 * for the keyboard shortcut router and delegates to the text-root
 * (applyReviewWithAI) or edit-root (applyReviewEditWithAI) command, whichever
 * matches the resolved task's stage (plan §1.3 / AC-ROUTE-01).
 *
 * Returns whether the downstream apply command was actually dispatched
 * (`true`) or this call refused before dispatching anything (`false` — no
 * task resolved, wrong stage, still paused, or `applyReviewWithAI`/
 * `applyReviewEditWithAI` themselves refused on an internal guard — missing/
 * stale/invalid review artifact, no current plan content, no model
 * configured). `applyCurrentStageAction.ts`'s review-apply branches and
 * `goToReviewAndApplyV1` read this so a scheduled or redirected dispatch can
 * tell a genuine invocation apart from any refusal along the chain
 * (2026-09-09 review completion blocker, narrowed — both downstream commands
 * now report their own real result via `Promise<boolean>` instead of
 * `Promise<void>`).
 */
export async function applyLowLevelReviewChanges(
  inventory: TaskInventory,
  explicitArg?: {
    canonicalId?: string;
    taskFolderPath?: string;
    task?: { progress: { currentStage: string } };
    /**
     * Forwarded verbatim from `applyCurrentStageAction.ts`'s `execute()`
     * helper — see that file's `ApplyArg.admissionHandoffTokenV1` doc
     * comment for the full rationale. Must be relayed into whichever
     * downstream `applyReviewEditWithAI`/`applyReviewWithAI` dispatch this
     * function makes below, or a scheduled caller that already holds live
     * durable admission self-blocks as busy against its own marker (2026-09-09
     * review completion blocker, narrowed) instead of adopting it.
     */
    admissionHandoffTokenV1?: string;
  }
): Promise<boolean> {
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
      "No tasks at the Low-Level Review stage."
    );
    return false;
  }

  if (
    resolvedTask.progress.currentStage !== "plan-low-review" &&
    resolvedTask.progress.currentStage !== "impl-low-review"
  ) {
    NotificationRouter.showWarning(
      "Task is not at a Low-Level Review stage."
    );
    return false;
  }

  if (resolvedTask.progress.currentStage === "impl-low-review") {
    assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");

    if (resolvedTask.progress.status === "paused") {
      NotificationRouter.showWarning(
        "Task is paused. Resume it before applying review changes."
      );
      return false;
    }

    const editDispatched = await vscode.commands.executeCommand<boolean>(
      "vs-code-ai-helper.applyReviewEditWithAI",
      {
        task: {
          folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
          folderName: path.basename(resolvedTask.taskFolderPath),
          progress: resolvedTask.progress,
        },
        admissionHandoffTokenV1: explicitArg?.admissionHandoffTokenV1,
      }
    );
    return editDispatched === true;
  }

  if (resolvedTask.progress.status === "paused") {
    NotificationRouter.showWarning(
      "Task is paused. Resume it before applying review changes."
    );
    return false;
  }

  const textDispatched = await vscode.commands.executeCommand<boolean>(
    "vs-code-ai-helper.applyReviewWithAI",
    {
      task: {
        folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
        folderName: path.basename(resolvedTask.taskFolderPath),
        progress: resolvedTask.progress,
      },
      admissionHandoffTokenV1: explicitArg?.admissionHandoffTokenV1,
    }
  );
  return textDispatched === true;
}

/**
 * Register the applyLowLevelReviewChanges command.
 */
export function registerApplyLowLevelReviewChangesCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.applyLowLevelReviewChanges",
    (arg?: { canonicalId?: string; taskFolderPath?: string; admissionHandoffTokenV1?: string }) =>
      applyLowLevelReviewChanges(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
