/**
 * `nextStage.v1` registry row (plan §6.6) — the first non-provider
 * (lifecycle) row: advance an active task to its immediate next canonical
 * stage (`STAGE_ORDER[+1]`), through the strict progress stack and the
 * exhaustive field policy (`taskProgressFieldPolicyV1.ts`) exclusively —
 * never the legacy permissive reader/writer.
 *
 * This row honors a workspace's configured-review-stage skip
 * (`resolveConfiguredReviewStages` / `computeNextStage`'s optional-review-
 * stage skip in `stageTransition.ts`) via the optional `targetStage` input,
 * which the field policy's `applyNextStagePolicyV1` validates as strictly
 * forward of the current stage and lands on directly — no synthetic
 * intermediate hop through a skipped stage. `nextStage`
 * (`src/commands/reviewActions.ts`) always delegates "Complete Stage & Move
 * On" through this row, passing its configured-stage-aware target.
 *
 * The review-triggered routes (a review's own stage-advance, and score-based
 * auto-advance after a review or an implementation run) also delegate here
 * via `advanceStageViaNextStageRowV1` in `reviewActions.ts`, using the
 * optional `expectedReviewAttemptId` CAS (mirroring legacy `advanceStage`'s
 * `expectedReviewAttemptId`) and the `beforeWrite` side channel threaded from
 * `LifecycleExecutionContextV1` (mirroring legacy `advanceStage`'s
 * `publishArtifact`, e.g. promoting `plan.md` to `plan-final.md` atomically
 * with the winning CAS). A same-stage re-review confirmation (no actual
 * transition — advancing FROM and TO the same stage) is not a stage
 * "advance" this row's §3.11-defined semantics cover; that no-op case is
 * handled directly by the caller instead of being forced through here. The
 * legacy `advanceStage` helper remains in use only for other transition
 * kinds (manual "Set Task Stage" jumps, resets, reopen, recovery, etc.).
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
import { syncOwedContinuationLedgerBestEffortV1 } from "../../state/schedulingIntentV1";
import { ensurePublishReviewArtifactExistsV1 } from "../../utils/publishChecksFreshness";
import {
  LifecyclePolicyFailureError,
  LifecycleReviewAttemptMismatchError,
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
  /**
   * Explicit destination stage. Optional: omit to advance to the immediate
   * `STAGE_ORDER` successor. When present, must be strictly forward of
   * `expectedSourceStage` — validated again by `applyNextStagePolicyV1`
   * inside the task lock against the freshly re-read current stage.
   */
  readonly targetStage?: TaskStage;
  /**
   * Optional compare-and-set against the freshly re-read progress's
   * `reviewAttemptId`, checked inside the same task lock as
   * `expectedSourceStage`. Lets a review-driven auto-advance (which claims a
   * stage via a review attempt id before the provider call, mirroring the
   * legacy `advanceStage`'s `expectedReviewAttemptId`) reject a stale attempt
   * that lost the race to a newer review attempt on the same stage, instead
   * of silently advancing on its behalf.
   */
  readonly expectedReviewAttemptId?: string;
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
  if (raw.targetStage !== undefined && !isTaskStage(raw.targetStage)) {
    return { ok: false, reason: "input has an invalid \"targetStage\" stage" };
  }
  if (raw.expectedReviewAttemptId !== undefined && !isNonEmptyString(raw.expectedReviewAttemptId)) {
    return { ok: false, reason: "input has an invalid \"expectedReviewAttemptId\" value" };
  }
  const allowedKeys = new Set([
    "taskFolderPath",
    "expectedSourceStage",
    "targetStage",
    "expectedReviewAttemptId",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: NextStageActionInputV1 = {
    taskFolderPath: raw.taskFolderPath,
    expectedSourceStage: raw.expectedSourceStage,
    ...(raw.targetStage !== undefined ? { targetStage: raw.targetStage as TaskStage } : {}),
    ...(raw.expectedReviewAttemptId !== undefined
      ? { expectedReviewAttemptId: raw.expectedReviewAttemptId }
      : {}),
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
    patched = await deps.patchTaskProgress(
      taskFolderUri,
      (current) => {
        if (current.currentStage !== input.expectedSourceStage) {
          throw new LifecycleStageMismatchError(
            `Task changed before transition (expected ${input.expectedSourceStage}, found ${current.currentStage}).`
          );
        }
        if (
          input.expectedReviewAttemptId !== undefined &&
          current.reviewAttemptId !== input.expectedReviewAttemptId
        ) {
          throw new LifecycleReviewAttemptMismatchError(
            "Review result is stale; a newer review attempt owns this transition."
          );
        }
        const result = applyNextStagePolicyV1(current, {
          now: new Date().toISOString(),
          targetStage: input.targetStage,
        });
        if (!result.ok) {
          throw new LifecyclePolicyFailureError(result.code);
        }
        return result.progress;
      },
      { beforeWrite: context.beforeWrite }
    );
  } catch (error) {
    if (error instanceof LifecyclePolicyFailureError) {
      return { kind: "failed", code: `nextStage.${error.code}`, retryable: false };
    }
    if (error instanceof LifecycleStageMismatchError) {
      return { kind: "failed", code: "nextStage.staleSourceStage", retryable: false };
    }
    if (error instanceof LifecycleReviewAttemptMismatchError) {
      return { kind: "failed", code: "nextStage.staleReviewAttempt", retryable: false };
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

  // Every route that can land currentStage on "publish" must guarantee the
  // stage's document exists (plan item 17, step 20a) — this is the primary
  // manual/review-driven transition writer (legacy `advanceStageLocked` in
  // `stageTransition.ts` covers the other transition kinds), so it must not
  // be the one gap that leaves "not created yet" reachable.
  if (patched.currentStage === "publish") {
    await ensurePublishReviewArtifactExistsV1(taskFolderUri);
  }

  // PART 6.5 (review-flagged 2026-08-23): `applyNextStagePolicyV1` clears
  // `implRecovery` unconditionally on every successful transition — push that
  // fact into the scheduling-intent ledger right after the CAS resolves
  // (never from inside the callback, which may re-run on a retry), so a task
  // that advances past its owed continuation this way is not left showing a
  // stale "owed" ledger entry.
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
