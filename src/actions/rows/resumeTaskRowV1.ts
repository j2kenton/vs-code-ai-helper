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
import { readTaskProgressStrictV1 } from "../../services/taskProgressReaderV1";
import { syncOwedContinuationLedgerBestEffortV1 } from "../../state/schedulingIntentV1";
import { enterStageV1, runStageEntryPostCommitV1, type StageEntryResultV1 } from "../../utils/stageTransition";
import {
  LifecycleBindingInvalidError,
  LifecycleCompletionMarkerMismatchError,
  LifecyclePolicyFailureError,
  LifecycleStageMismatchError,
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

  // Part 1 review fix: routed through `enterStageV1` (kind `reopen`) instead
  // of a bare `patchTaskProgressStrictV1` call, so a Reopen selecting "impl"
  // on a task whose `plan-final.md` is missing is refused with the item-15
  // reason instead of landing on an unusable stage — `applyReopenPolicyV1`
  // itself has no artifact awareness of its own. The source stage is read
  // fresh here (outside the lock) only to seed `enterStageV1`'s built-in
  // compare-and-set; the REAL staleness check this row cares about
  // (`status`/`completedAt`) still runs inside `transform`, unchanged.
  //
  // `context.skipTaskLock` (see that field's own doc comment) rides through
  // as a `deps.patchTaskProgress` override rather than a new parameter on
  // `enterStageV1`/`advanceStage` — the seam those already expose for
  // exactly this purpose — because the caller (`taskActivationCoordinator`)
  // already holds the covering meta-root lock and re-acquiring the per-task
  // lock here would self-deadlock.
  const patchTaskProgress: typeof patchTaskProgressStrictV1 = context.skipTaskLock
    ? (uri, updater, options): ReturnType<typeof patchTaskProgressStrictV1> =>
        deps.patchTaskProgress(uri, updater, { ...options, skipLock: true })
    : deps.patchTaskProgress;

  const preflight = await readTaskProgressStrictV1(taskFolderUri);
  if (!preflight.ok) {
    return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
  }
  const sourceStage = preflight.decoded.progress.currentStage;

  const entryResult = await enterStageV1(
    taskFolderUri,
    sourceStage,
    input.selectedStage,
    /* isPaused */ false, // Inert: "reopen" is never AUTO_REVIEW_ELIGIBLE.
    "reopen",
    {
      deps: { patchTaskProgress },
      additionalBeforeWrite: context.beforeWrite,
      // Part 2 (item 15 hardening) — `context.skipTaskLock` means this call
      // is already running from inside `activateTaskLocked`'s meta-root lock
      // hold (see this function's own `patchTaskProgress` comment above);
      // `enterStageV1`'s proactive/reactive journal recovery both acquire
      // `withTaskLock` themselves, which would self-deadlock through the
      // shared per-tasksRoot queue in that case — see
      // `callerHoldsCoveringLock`'s own doc comment on `enterStageV1`. This is
      // now purely a self-deadlock backstop, not this path's only defense
      // against a stale journal: `reopenCompletedTask` (`reopenTask.ts`), the
      // one production caller that sets `context.skipTaskLock`, already runs
      // the equivalent recovery itself, lock-free, before it ever calls
      // `activateTask` (review fix, 2026-09-23, architectural blocker).
      callerHoldsCoveringLock: context.skipTaskLock === true,
      transform: (current) => {
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
    }
  );

  if (!entryResult.ready) {
    if (entryResult.cause instanceof LifecycleCompletionMarkerMismatchError) {
      return { kind: "failed", code: "resumeTask.staleCompletedAt", retryable: false };
    }
    if (entryResult.cause instanceof LifecycleStageMismatchError) {
      // The fresh pre-lock read above raced a write that landed between it
      // and the lock — the same "updated elsewhere" situation the
      // completedAt CAS exists to catch, just observed one field earlier.
      return { kind: "failed", code: "resumeTask.staleCompletedAt", retryable: false };
    }
    if (entryResult.cause instanceof LifecycleBindingInvalidError) {
      return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
    }
    if (entryResult.cause instanceof LifecyclePolicyFailureError) {
      return { kind: "failed", code: `resumeTask.${entryResult.cause.code}`, retryable: false };
    }
    if (entryResult.cause === undefined) {
      // `enterStageV1`'s own refusal: the selected stage is "impl" and
      // `plan-final.md` is not already canonical (`requireExistingArtifact`,
      // reopen's own item-15 behavior — never a generic "generate plan.md
      // first" promotion refusal, since a completed task must have finished
      // its own plan promotion before completing).
      //
      // Review fix (2026-09-22, completion blocker): this used to report
      // `taskProgressRecoveryRequired`, which `reopenTask.ts` describes to the
      // user as "its progress file needs recovery" — a misleading claim of
      // corruption for what is actually a missing implementation artifact.
      // `entryResult.reason` (surfaced via `detail`) names the real cause.
      return {
        kind: "failed",
        code: "resumeTask.noImplementationArtifact",
        retryable: false,
        detail: entryResult.reason,
      };
    }
    return {
      kind: "failed",
      code: toSanitizedWriteFailureCodeV1("resumeTask", entryResult.cause),
      retryable: true,
    };
  }

  // Post-commit work (a deferred plan-revision adoption write, or a future
  // caller's `postCommit`) acquires the task lock itself
  // (`applyDeferredPlanRevisionAdoptionV1`) — safe to run inline only when
  // this row did NOT skip the lock, i.e. no external caller is still holding
  // a covering lock around this call. `taskActivationCoordinator` (this
  // row's only production caller) always sets `skipTaskLock: true` and holds
  // the meta-root lock for the whole reopen sequence, so running it here
  // would deadlock; a reopen reaching "impl" is expected to find the
  // artifact already canonical (a completed task necessarily finished its
  // own plan revision, if any, before completing — see `enterStageV1`'s
  // `prepareStageEntryV1` doc comment), so `deferredPlanRevisionAdoption`
  // should never actually be set here in production. Handed BACK to the
  // caller via `context.postCommitSink` (Part 1 review fix) rather than
  // dropped, so the one case this assumption is ever wrong is still run —
  // just after the caller's own lock releases, instead of silently lost.
  if (!context.skipTaskLock) {
    await runStageEntryPostCommitV1(taskFolderUri, entryResult);
  } else if (entryResult.deferredPlanRevisionAdoption || entryResult.postCommit) {
    if (context.postCommitSink) {
      context.postCommitSink(entryResult satisfies StageEntryResultV1);
    } else {
      console.error(
        "resumeTaskRowV1: a reopen produced post-commit work while skipTaskLock was set, but the caller wired " +
          "no postCommitSink to receive it — this work was NOT run (running it here would deadlock on the " +
          "caller's held meta-root lock); this should not be reachable in production (see this branch's comment)."
      );
    }
  }

  // PART 6.5 (review-flagged 2026-08-23): `applyReopenPolicyV1` clears
  // `implRecovery` unconditionally on every successful reopen — push that
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
