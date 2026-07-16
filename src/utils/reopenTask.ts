import * as vscode from "vscode";
import {
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskProgress,
  TaskStage,
} from "../types/taskProgress";
import {
  clearImplReviewFiles,
  clearLintPayload,
  clearStageFallbackReservation,
} from "./taskProgressUtils";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import { activateTask, StaleReopenError } from "../state/taskActivationCoordinator";

export { StaleReopenError };

/**
 * Build the mutation applied to a completed task's progress when it is
 * reopened at `chosenStage`. Composed by the activation coordinator as
 * `updateTaskStatus(mutateTarget(current), "active")`, so this function is
 * NOT responsible for the `status` flip itself — only for validating that
 * the reopen is still valid and for invalidating/preserving the rest of the
 * task's fields.
 *
 * Field-by-field audit against TaskProgress (types/taskProgress.ts):
 *   - taskFolder, displayName, nameIsDefault, preImageDescription, ownership,
 *     createdAt: non-stage data, untouched.
 *   - status: left alone here; the coordinator's `updateTaskStatus` call sets it.
 *   - completedAt: cleared — the task is no longer in the completed lifecycle.
 *   - completedStages: filtered to stages strictly before `chosenStage` — a
 *     stage can't be simultaneously completed and current/outstanding.
 *   - currentStage: set to `chosenStage`.
 *   - updatedAt: bumped.
 *   - implReviewFiles: cleared only when reopening at "impl" or earlier — the
 *     impl-review stages and Publish consume this as their review scope over
 *     the existing implementation, so a reopen at those stages must keep it.
 *   - lintPayload: always cleared — it's Publish-stage output, stale for any
 *     re-run regardless of which stage is reopened.
 *   - scheduledRun, scheduledResumeTime: always cleared — a one-shot schedule
 *     recorded before completion must not fire against the reopened task.
 *   - reviewAttemptId: always cleared — a stale in-flight review run from
 *     before completion must never finalize a reopened stage.
 *   - fallbackActive, fallbackModelId: cleared for `chosenStage` and every
 *     later stage — no backup-model reservation may survive for a stage
 *     that's about to be (re-)run.
 */
export function createReopenMutation(
  chosenStage: TaskStage,
  capturedCompletedAt: string | undefined
): (current: TaskProgress) => TaskProgress {
  return (current: TaskProgress): TaskProgress => {
    if (current.status !== "completed" || current.completedAt !== capturedCompletedAt) {
      throw new StaleReopenError(
        `Task "${current.taskFolder}" was updated elsewhere before the reopen could be applied.`
      );
    }

    const chosenIndex = STAGE_ORDER.indexOf(chosenStage);
    const implIndex = STAGE_ORDER.indexOf("impl");

    let next: TaskProgress = {
      ...current,
      completedAt: undefined,
      currentStage: chosenStage,
      completedStages: (current.completedStages ?? []).filter(
        (stage) => STAGE_ORDER.indexOf(stage) < chosenIndex
      ),
      scheduledRun: undefined,
      scheduledResumeTime: undefined,
      reviewAttemptId: undefined,
      updatedAt: new Date().toISOString(),
    };

    next = clearLintPayload(next);

    if (chosenIndex <= implIndex) {
      next = clearImplReviewFiles(next);
    }

    for (let i = chosenIndex; i < STAGE_ORDER.length; i++) {
      const stage = STAGE_ORDER[i];
      if (stage) next = clearStageFallbackReservation(next, stage);
    }

    return next;
  };
}

/** One item per workflow stage, with Publish listed first (see `pickReopenStage`). */
function reopenStageItems(): Array<{ label: string; stage: TaskStage }> {
  const ordered = ["publish" as TaskStage, ...STAGE_ORDER.filter((s) => s !== "publish")];
  return ordered.map((stage) => ({ label: STAGE_DISPLAY_NAMES[stage], stage }));
}

/**
 * Show the reopen stage picker for a completed task. Publish is listed
 * first — VS Code's QuickPick focuses the first item by default — so
 * "stay at Publish" (the common case: fixing lint/commit/push) is the
 * preselected choice without an extra keypress. Returns undefined if the
 * user cancels, which callers must treat as a no-op (no state changes).
 */
export async function pickReopenStage(folderName: string): Promise<TaskStage | undefined> {
  const picked = await vscode.window.showQuickPick(reopenStageItems(), {
    title: `Reopen "${folderName}" at stage`,
    placeHolder: "Select the stage to reopen this completed task at",
  });
  return picked?.stage;
}

export interface ReopenCompletedTaskResult {
  outcome: "reopened" | "stale" | "failed";
  message?: string;
}

/**
 * Shared reopen transition for a completed task, used by both the Resume
 * command and setTaskStage/setStageAsCurrent so marker capture, stale
 * validation, and field invalidation can never drift between entry points.
 *
 * `capturedCompletedAt` must be read from the task's progress before showing
 * any picker/confirmation, so the in-write validation can detect the task
 * being reopened, resumed, or re-completed by another window in the
 * meantime.
 */
export async function reopenCompletedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  taskFolderPath: string,
  canonicalId: string,
  chosenStage: TaskStage,
  capturedCompletedAt: string | undefined
): Promise<ReopenCompletedTaskResult> {
  const mutateTarget = createReopenMutation(chosenStage, capturedCompletedAt);
  try {
    const activated = await activateTask(
      inventory, currentTaskStore, taskFolderPath, canonicalId, { mutateTarget }
    );
    if (!activated) {
      return {
        outcome: "failed",
        message: "Could not reopen the task — its progress file could not be read. Please refresh the Tasks panel and try again.",
      };
    }
    return { outcome: "reopened" };
  } catch (error) {
    if (error instanceof StaleReopenError) {
      return {
        outcome: "stale",
        message: "This task was updated elsewhere while the picker was open. Refresh and try again.",
      };
    }
    throw error;
  }
}
