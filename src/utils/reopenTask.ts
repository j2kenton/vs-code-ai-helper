import * as vscode from "vscode";
import {
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskProgress,
  TaskStage,
} from "../types/taskProgress";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import { activateTask, StaleReopenError } from "../state/taskActivationCoordinator";
import {
  invokeLifecycleRowV1,
} from "../actions/productionTaskActionRuntimeV1";
import { RESUME_TASK_ACTION_KEY_V1 } from "../actions/rows/resumeTaskRowV1";
import * as path from "path";

export { StaleReopenError };

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

/** The slice of a resolved task context the reopen transition needs. */
export interface ReopenCompletedTaskTargetV1 {
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly folderName: string;
  readonly progress: TaskProgress;
  readonly workspaceFolder?: vscode.Uri;
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
 *
 * The reopen mutation itself runs through the `resumeTask.v1` registry row
 * (plan §9): strict decode, persisted-binding validation, and
 * `applyReopenPolicyV1`'s exhaustive Reopen field column — never the legacy
 * permissive reader/writer (§9.1). The activation coordinator keeps owning
 * the surrounding §9.2 sequence (meta-root lock, pause-others, checkpoint,
 * sole-active focus, refresh) and invokes the row as its target write via
 * `writeTarget`; `skipTaskLock` rides along because the coordinator already
 * holds the covering meta-root lock.
 */
export async function reopenCompletedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  task: ReopenCompletedTaskTargetV1,
  chosenStage: TaskStage,
  capturedCompletedAt: string | undefined
): Promise<ReopenCompletedTaskResult> {
  // Captured across the writeTarget boundary so a non-throwing row rejection
  // (recovery/failure) can surface its specific message after activateTask
  // returns false.
  let rejection: ReopenCompletedTaskResult | undefined;

  const writeTarget = async (): Promise<boolean> => {
    const outcome = await invokeLifecycleRowV1({
      actionKey: RESUME_TASK_ACTION_KEY_V1,
      taskFolderPath: task.taskFolderPath,
      taskBindingId: task.canonicalId,
      chatDocumentIdentitySeed: task.canonicalId,
      workspaceCwd: task.workspaceFolder?.fsPath ?? path.dirname(task.taskFolderPath),
      taskStatus: task.progress.status ?? "active",
      taskStage: task.progress.currentStage,
      rawInput: {
        taskFolderPath: task.taskFolderPath,
        selectedStage: chosenStage,
        ...(capturedCompletedAt !== undefined ? { expectedCompletedAt: capturedCompletedAt } : {}),
      },
      skipTaskLock: true,
    });
    if (outcome.kind === "completed") {
      return true;
    }
    if (outcome.kind === "failed" && outcome.code === "resumeTask.staleCompletedAt") {
      // Pre-persistence by construction (the row's CAS threw before any
      // write) — activateTask rolls back the pause-others writes on this.
      throw new StaleReopenError(
        `Task "${task.folderName}" was updated elsewhere before the reopen could be applied.`
      );
    }
    if (outcome.kind === "recoveryRequired") {
      rejection = {
        outcome: "failed",
        message:
          "Could not reopen the task — its progress file needs recovery. " +
          "See the task's entry in the Tasks panel.",
      };
      return false;
    }
    const detail = outcome.kind === "failed" ? outcome.code : outcome.kind;
    rejection = {
      outcome: "failed",
      message: `Could not reopen the task (${detail}). Please refresh the Tasks panel and try again.`,
    };
    return false;
  };

  try {
    const activated = await activateTask(
      inventory,
      currentTaskStore,
      task.taskFolderPath,
      task.canonicalId,
      { writeTarget }
    );
    if (!activated) {
      return (
        rejection ?? {
          outcome: "failed",
          message:
            "Could not reopen the task — its progress file could not be read. Please refresh the Tasks panel and try again.",
        }
      );
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
