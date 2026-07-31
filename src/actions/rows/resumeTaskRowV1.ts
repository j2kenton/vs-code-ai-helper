/**
 * `resumeTask.v1` registry row (plan §9) — completed-task Resume through the
 * strict progress stack: reactivate a completed task at a selected stage via
 * `applyReopenPolicyV1`'s Reopen column (`taskProgressFieldPolicyV1.ts`),
 * never the legacy permissive reader/writer (§9.1).
 *
 * The row owns §9.2's steps 3, 6, and 7: strict decode + persisted-binding
 * validation, the Reopen field policy, and metadata preservation — all inside
 * one locked compare-and-swap write. The SURROUNDING activation sequence
 * (§9.2 steps 4-5, 8-9: meta-root lock, pausing other active tasks, the
 * activation checkpoint, sole-active verification, tree refresh) stays with
 * `taskActivationCoordinator.activateTask`, which invokes this row as its
 * target write via `ActivateTaskOptions.writeTarget` — see
 * `utils/reopenTask.ts`. Because the coordinator already holds the covering
 * meta-root lock, callers thread `lifecycleSkipTaskLock` so the row's strict
 * patch does not queue on the same per-process lock key and self-deadlock.
 *
 * Staleness contract (§9.2 step 2's "on cancellation, change nothing"
 * companion): the caller captures `completedAt` BEFORE showing the reopen
 * picker and passes it as `expectedCompletedAt`; the row re-validates both
 * the completed status and the exact marker against the freshly re-read
 * progress inside the lock, so a task resumed, re-completed, or otherwise
 * touched by another window while the picker was open is rejected
 * (`resumeTask.staleCompletedAt`), never silently reopened.
 */
import * as vscode from "vscode";
import {
  LifecycleExecutionContextV1,
  LifecycleTaskActionRowV1,
  TaskActionInputValidationResultV1,
} from "../taskActionRegistryV1";
import { allocateHex128IdV1 } from "../../types/actionCorrelationV1";
import { TaskActionOutcomeV1 } from "../../types/taskActionOutcomeV1";
import { STAGE_ORDER, TaskStage } from "../../types/taskProgress";
import { deriveTaskBindingV1 } from "../../types/taskBindingV1";
import { applyReopenPolicyV1 } from "../../services/taskProgressFieldPolicyV1";
import { patchTaskProgressStrictV1 } from "../../services/taskProgressWriterV1";
import {
  LifecycleBindingInvalidError,
  LifecycleCompletionMarkerMismatchError,
  LifecyclePolicyFailureError,
  toSanitizedWriteFailureCodeV1,
} from "./lifecyclePolicyRejection";

export const RESUME_TASK_ACTION_KEY_V1 = "resumeTask.v1";

export interface ResumeTaskActionInputV1 {
  readonly taskFolderPath: string;
  /** The stage to reopen the completed task at (§9.2 step 1's picker choice). */
  readonly selectedStage: TaskStage;
  /**
   * The `completedAt` marker the caller observed immediately before showing
   * the reopen picker. Optional because a legacy completed task can lack the
   * marker entirely — the CAS compares exact equality including `undefined`,
   * so "had no marker" is itself a checkable snapshot.
   */
  readonly expectedCompletedAt?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTaskStage(value: unknown): value is TaskStage {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}

/** @internal exported for testing */
export function validateResumeTaskInputV1(rawInput: unknown): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input is missing a non-empty \"taskFolderPath\" string" };
  }
  if (!isTaskStage(raw.selectedStage)) {
    return { ok: false, reason: "input is missing a valid \"selectedStage\" stage" };
  }
  if (raw.expectedCompletedAt !== undefined && !isNonEmptyString(raw.expectedCompletedAt)) {
    return { ok: false, reason: "input has an invalid \"expectedCompletedAt\" value" };
  }
  const allowedKeys = new Set(["taskFolderPath", "selectedStage", "expectedCompletedAt"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: ResumeTaskActionInputV1 = {
    taskFolderPath: raw.taskFolderPath,
    selectedStage: raw.selectedStage,
    ...(raw.expectedCompletedAt !== undefined
      ? { expectedCompletedAt: raw.expectedCompletedAt }
      : {}),
  };
  return { ok: true, input: validated };
}

/**
 * Injectable seam for `patchTaskProgressStrictV1` (plan §3.10) — same shape
 * and rationale as `NextStageRowDepsV1` (`nextStageRowV1.ts`).
 */
export interface ResumeTaskRowDepsV1 {
  readonly patchTaskProgress: typeof patchTaskProgressStrictV1;
}

const defaultResumeTaskRowDepsV1: ResumeTaskRowDepsV1 = {
  patchTaskProgress: patchTaskProgressStrictV1,
};

/** @internal exported for testing */
export async function executeResumeTaskV1(
  context: LifecycleExecutionContextV1,
  deps: ResumeTaskRowDepsV1 = defaultResumeTaskRowDepsV1
): Promise<TaskActionOutcomeV1> {
  const input = context.validatedInput as ResumeTaskActionInputV1;
  const taskFolderUri = vscode.Uri.file(input.taskFolderPath);

  let patched;
  try {
    patched = await deps.patchTaskProgress(
      taskFolderUri,
      (current) => {
        // Staleness CAS first: BOTH conditions describe "no longer the
        // completed snapshot the picker was shown for" — a task that is no
        // longer completed was necessarily resumed elsewhere in the interim.
        if (current.status !== "completed" || current.completedAt !== input.expectedCompletedAt) {
          throw new LifecycleCompletionMarkerMismatchError(
            "Task was updated elsewhere before the reopen could be applied."
          );
        }
        // §9.1/§9.2 step 3: the persisted binding must derive before any
        // mutation — an ownership-free or underivable record is a recovery
        // condition, never silently reopened.
        if (
          current.ownership === undefined ||
          !deriveTaskBindingV1({ ownership: current.ownership, taskFolder: current.taskFolder }).ok
        ) {
          throw new LifecycleBindingInvalidError(
            "Task binding could not be derived from persisted ownership."
          );
        }
        const result = applyReopenPolicyV1(current, {
          now: new Date().toISOString(),
          selectedStage: input.selectedStage,
        });
        if (!result.ok) {
          throw new LifecyclePolicyFailureError(result.code);
        }
        return result.progress;
      },
      {
        ...(context.skipTaskLock !== undefined ? { skipLock: context.skipTaskLock } : {}),
        ...(context.beforeWrite !== undefined ? { beforeWrite: context.beforeWrite } : {}),
      }
    );
  } catch (error) {
    if (error instanceof LifecycleCompletionMarkerMismatchError) {
      return { kind: "failed", code: "resumeTask.staleCompletedAt", retryable: false };
    }
    if (error instanceof LifecycleBindingInvalidError) {
      return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
    }
    if (error instanceof LifecyclePolicyFailureError) {
      return { kind: "failed", code: `resumeTask.${error.code}`, retryable: false };
    }
    return {
      kind: "failed",
      code: toSanitizedWriteFailureCodeV1("resumeTask", error),
      retryable: true,
    };
  }

  if (!patched) {
    return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
  }

  return {
    kind: "completed",
    correlation: {
      actionKey: context.actionKey,
      operationId: context.operationId,
      attemptId: allocateHex128IdV1(),
      taskBindingId: context.taskBindingId,
      chatDocumentId: context.chatDocumentId,
    },
    code: "completed",
  };
}

export function createResumeTaskRowV1(
  deps: ResumeTaskRowDepsV1 = defaultResumeTaskRowDepsV1
): LifecycleTaskActionRowV1 {
  return {
    kind: "lifecycle",
    actionKey: RESUME_TASK_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.resumeTask"],
    // Only COMPLETED tasks route through this row (§9.2: paused-task Resume
    // retains its existing behavior and never reopens anything).
    eligibility: { statuses: ["completed"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: "Reopening task…",
    validateInput: validateResumeTaskInputV1,
    loggingPolicy: { channel: "action.resumeTask", includeResultMetrics: false },
    execute: (context) => executeResumeTaskV1(context, deps),
  };
}
