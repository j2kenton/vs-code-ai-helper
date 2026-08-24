/**
 * `markTaskDone.v1` registry row (plan §6.6) — terminally complete an active
 * task already at the Publish stage, through the strict progress stack and
 * the exhaustive field policy (`taskProgressFieldPolicyV1.ts`) exclusively —
 * never the legacy permissive reader/writer.
 *
 * Eligibility (`statuses: ["active"], stages: ["publish"]`) mirrors
 * `isMarkTaskDoneEligible` (`src/commands/markTaskDone.ts`): a paused,
 * already-completed, or archived task is rejected before this row's
 * `execute` ever runs, and `applyMarkTaskDonePolicyV1` independently
 * requires `status === "active"` as its own defense in depth.
 */
import * as vscode from "vscode";
import {
  LifecycleExecutionContextV1,
  LifecycleTaskActionRowV1,
  TaskActionInputValidationResultV1,
} from "../taskActionRegistryV1";
import { allocateHex128IdV1 } from "../../types/actionCorrelationV1";
import { TaskActionOutcomeV1 } from "../../types/taskActionOutcomeV1";
import { PUBLISH_STAGE } from "../../types/taskProgress";
import { applyMarkTaskDonePolicyV1 } from "../../services/taskProgressFieldPolicyV1";
import { patchTaskProgressStrictV1 } from "../../services/taskProgressWriterV1";
import { syncOwedContinuationLedgerBestEffortV1 } from "../../state/schedulingIntentV1";
import {
  LifecyclePolicyFailureError,
  LifecycleStageMismatchError,
  toSanitizedWriteFailureCodeV1,
} from "./lifecyclePolicyRejection";

export const MARK_TASK_DONE_ACTION_KEY_V1 = "markTaskDone.v1";

export interface MarkTaskDoneActionInputV1 {
  readonly taskFolderPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateMarkTaskDoneInputV1(rawInput: unknown): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input is missing a non-empty \"taskFolderPath\" string" };
  }
  const allowedKeys = new Set(["taskFolderPath"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: MarkTaskDoneActionInputV1 = { taskFolderPath: raw.taskFolderPath };
  return { ok: true, input: validated };
}

/**
 * Injectable seam for `patchTaskProgressStrictV1` (plan §3.10). Production
 * always uses the real writer; tests supply a throwing stub to exercise the
 * `writeFailed` catch branch deterministically, without monkey-patching
 * `fs`/`vscode.workspace.fs` and colliding with other fixtures' shared
 * `withTaskLock` lock path (see `lifecyclePolicyRejection.test.ts`).
 */
export interface MarkTaskDoneRowDepsV1 {
  readonly patchTaskProgress: typeof patchTaskProgressStrictV1;
}

const defaultMarkTaskDoneRowDepsV1: MarkTaskDoneRowDepsV1 = {
  patchTaskProgress: patchTaskProgressStrictV1,
};

/** @internal exported for testing */
export async function executeMarkTaskDoneV1(
  context: LifecycleExecutionContextV1,
  deps: MarkTaskDoneRowDepsV1 = defaultMarkTaskDoneRowDepsV1
): Promise<TaskActionOutcomeV1> {
  const input = context.validatedInput as MarkTaskDoneActionInputV1;
  const taskFolderUri = vscode.Uri.file(input.taskFolderPath);

  let patched;
  try {
    patched = await deps.patchTaskProgress(taskFolderUri, (current) => {
      if (current.currentStage !== PUBLISH_STAGE) {
        throw new LifecycleStageMismatchError(
          `Task changed before completion (expected ${PUBLISH_STAGE}, found ${current.currentStage}).`
        );
      }
      const result = applyMarkTaskDonePolicyV1(current, { now: new Date().toISOString() });
      if (!result.ok) {
        throw new LifecyclePolicyFailureError(result.code);
      }
      return result.progress;
    });
  } catch (error) {
    if (error instanceof LifecyclePolicyFailureError) {
      return { kind: "failed", code: `markTaskDone.${error.code}`, retryable: false };
    }
    if (error instanceof LifecycleStageMismatchError) {
      return { kind: "failed", code: "markTaskDone.staleSourceStage", retryable: false };
    }
    return {
      kind: "failed",
      code: toSanitizedWriteFailureCodeV1("markTaskDone", error),
      retryable: true,
    };
  }

  if (!patched) {
    return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
  }

  // PART 6.5 (review-flagged 2026-08-23): `applyMarkTaskDonePolicyV1` clears
  // `implRecovery` unconditionally on every successful completion — push that
  // fact into the scheduling-intent ledger right after the CAS resolves.
  await syncOwedContinuationLedgerBestEffortV1(input.taskFolderPath, undefined);

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

export function createMarkTaskDoneRowV1(
  deps: MarkTaskDoneRowDepsV1 = defaultMarkTaskDoneRowDepsV1
): LifecycleTaskActionRowV1 {
  return {
    kind: "lifecycle",
    actionKey: MARK_TASK_DONE_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.markTaskDone"],
    eligibility: { statuses: ["active"], stages: ["publish"] },
    requiresTaskOperationLease: true,
    progressLabel: "Completing task…",
    validateInput: validateMarkTaskDoneInputV1,
    loggingPolicy: { channel: "action.markTaskDone", includeResultMetrics: false },
    execute: (context) => executeMarkTaskDoneV1(context, deps),
  };
}
