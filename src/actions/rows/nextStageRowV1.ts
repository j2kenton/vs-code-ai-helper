/**
 * `nextStage.v1` registry row (plan §6.6) — the first non-provider
 * (lifecycle) row: advance an active task to its immediate next canonical
 * stage (`STAGE_ORDER[+1]`), through the strict progress stack and the
 * exhaustive field policy (`taskProgressFieldPolicyV1.ts`) exclusively —
 * never the legacy permissive reader/writer.
 *
 * SCOPE: this row implements the "ordered next stage" (literal
 * `STAGE_ORDER` successor) transition only. It does not honor a workspace's
 * configured-review-stage skip (`resolveConfiguredReviewStages` /
 * `computeNextStage`'s optional-review-stage skip in `stageTransition.ts`):
 * the field policy's `applyNextStagePolicyV1` always lands on the immediate
 * successor and has no input for an arbitrary target stage. `nextStage`
 * (`src/commands/reviewActions.ts`) therefore only delegates to this row
 * when the caller's configured-stage-aware target equals that immediate
 * successor; a configured skip continues to route through the legacy
 * `advanceStage` helper so an unconfigured optional review stage is never
 * mis-recorded as completed by a synthetic intermediate hop through it.
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
import { applyNextStagePolicyV1 } from "../../services/taskProgressFieldPolicyV1";
import { patchTaskProgressStrictV1 } from "../../services/taskProgressWriterV1";
import {
  LifecyclePolicyFailureError,
  LifecycleStageMismatchError,
  toSanitizedWriteFailureCodeV1,
} from "./lifecyclePolicyRejection";

export const NEXT_STAGE_ACTION_KEY_V1 = "nextStage.v1";

export interface NextStageActionInputV1 {
  readonly taskFolderPath: string;
  /**
   * The stage the caller observed as current immediately before invoking
   * this action. Checked against the freshly re-read progress inside the
   * task lock so a delayed auto-advance (or a second concurrent click)
   * cannot silently double-advance a task that has already moved on —
   * mirroring the legacy `advanceStage` compare-and-set
   * (`src/utils/stageTransition.ts`).
   */
  readonly expectedSourceStage: TaskStage;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTaskStage(value: unknown): value is TaskStage {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}

/** @internal exported for testing */
export function validateNextStageInputV1(rawInput: unknown): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input is missing a non-empty \"taskFolderPath\" string" };
  }
  if (!isTaskStage(raw.expectedSourceStage)) {
    return { ok: false, reason: "input is missing a valid \"expectedSourceStage\" stage" };
  }
  const allowedKeys = new Set(["taskFolderPath", "expectedSourceStage"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: NextStageActionInputV1 = {
    taskFolderPath: raw.taskFolderPath,
    expectedSourceStage: raw.expectedSourceStage,
  };
  return { ok: true, input: validated };
}

/**
 * Injectable seam for `patchTaskProgressStrictV1` (plan §3.10). Production
 * always uses the real writer; tests supply a throwing stub to exercise the
 * `writeFailed` catch branch deterministically, without monkey-patching
 * `fs`/`vscode.workspace.fs` and colliding with other fixtures' shared
 * `withTaskLock` lock path (see `lifecyclePolicyRejection.test.ts`).
 */
export interface NextStageRowDepsV1 {
  readonly patchTaskProgress: typeof patchTaskProgressStrictV1;
}

const defaultNextStageRowDepsV1: NextStageRowDepsV1 = {
  patchTaskProgress: patchTaskProgressStrictV1,
};

/** @internal exported for testing */
export async function executeNextStageV1(
  context: LifecycleExecutionContextV1,
  deps: NextStageRowDepsV1 = defaultNextStageRowDepsV1
): Promise<TaskActionOutcomeV1> {
  const input = context.validatedInput as NextStageActionInputV1;
  const taskFolderUri = vscode.Uri.file(input.taskFolderPath);

  let patched;
  try {
    patched = await deps.patchTaskProgress(taskFolderUri, (current) => {
      if (current.currentStage !== input.expectedSourceStage) {
        throw new LifecycleStageMismatchError(
          `Task changed before transition (expected ${input.expectedSourceStage}, found ${current.currentStage}).`
        );
      }
      const result = applyNextStagePolicyV1(current, { now: new Date().toISOString() });
      if (!result.ok) {
        throw new LifecyclePolicyFailureError(result.code);
      }
      return result.progress;
    });
  } catch (error) {
    if (error instanceof LifecyclePolicyFailureError) {
      return { kind: "failed", code: `nextStage.${error.code}`, retryable: false };
    }
    if (error instanceof LifecycleStageMismatchError) {
      return { kind: "failed", code: "nextStage.staleSourceStage", retryable: false };
    }
    return {
      kind: "failed",
      code: toSanitizedWriteFailureCodeV1("nextStage", error),
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

export function createNextStageRowV1(deps: NextStageRowDepsV1 = defaultNextStageRowDepsV1): LifecycleTaskActionRowV1 {
  return {
    kind: "lifecycle",
    actionKey: NEXT_STAGE_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.nextStage"],
    eligibility: { statuses: ["active"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: "Advancing stage…",
    validateInput: validateNextStageInputV1,
    loggingPolicy: { channel: "action.nextStage", includeResultMetrics: false },
    execute: (context) => executeNextStageV1(context, deps),
  };
}
