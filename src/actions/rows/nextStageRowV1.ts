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
import { readTaskProgressStrictV1 } from "../../services/taskProgressReaderV1";
import { syncOwedContinuationLedgerBestEffortV1 } from "../../state/schedulingIntentV1";
import { ensurePublishReviewArtifactExistsV1 } from "../../utils/publishChecksFreshness";
import { missingCompletionArtifactsV1 } from "../../utils/stageArtifactRequirementsV1";
import { computeNextStage, enterStageV1, runStageEntryPostCommitV1 } from "../../utils/stageTransition";
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
  /** Only the explicit human "Complete Anyway" command may set this. */
  readonly artifactOverride?: "user";
  /**
   * v1 fixes 2, item 8/32/Wave I review fix (2026-09-17): the fresh
   * `nextActor` value for the arriving stage, computed by the caller BEFORE
   * this action runs (mirroring legacy `advanceStage`'s own
   * `shouldAutoReview` eligibility test in `stageTransition.ts`) so it lands
   * in the same atomic CAS write `applyNextStagePolicyV1` performs, instead
   * of a second, race-prone patch after the fact. Omitted callers (e.g. the
   * plain "Complete Stage & Move On" button, which arranges no automated
   * follow-up itself) get the same unconditional clear-to-unknown as before.
   */
  readonly nextActorOnAdvance?: "human" | "automation";
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
  if (raw.artifactOverride !== undefined && raw.artifactOverride !== "user") {
    return { ok: false, reason: 'input has an invalid "artifactOverride" value' };
  }
  if (
    raw.nextActorOnAdvance !== undefined &&
    raw.nextActorOnAdvance !== "human" &&
    raw.nextActorOnAdvance !== "automation"
  ) {
    return { ok: false, reason: 'input has an invalid "nextActorOnAdvance" value' };
  }
  const allowedKeys = new Set([
    "taskFolderPath",
    "expectedSourceStage",
    "targetStage",
    "expectedReviewAttemptId",
    "artifactOverride",
    "nextActorOnAdvance",
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
    ...(raw.artifactOverride === "user" ? { artifactOverride: "user" as const } : {}),
    ...(raw.nextActorOnAdvance !== undefined
      ? { nextActorOnAdvance: raw.nextActorOnAdvance as "human" | "automation" }
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
  // Preserve the lifecycle row's established recovery result for a missing or
  // malformed progress document before asking the filesystem about artifacts.
  const preflight = await readTaskProgressStrictV1(taskFolderUri);
  if (!preflight.ok) {
    return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
  }
  const missingArtifacts = await missingCompletionArtifactsV1(taskFolderUri, input.expectedSourceStage);

  // Review fix (2026-09-22, architectural blocker, fourth narrowing): the
  // CAS/write step now goes through `enterStageV1` — the same one-door
  // primitive `setTaskStage` uses — instead of a bare `patchTaskProgress`
  // call with its own duplicated promotion/publish handling. `enterStageV1`
  // resolves "what does the destination need" via `prepareStageEntryV1` and,
  // for "impl", handles the plan.md -> plan-final.md promotion (and its own
  // failure rollback) atomically with this CAS write itself — this row no
  // longer needs its OWN `publishArtifact`/`context.beforeWrite` plumbing for
  // that (every production caller of this row that used to build one now
  // relies on this instead — see `advanceStageViaNextStageRowV1` and
  // `nextStage()` in `reviewActions.ts`).
  //
  // `destinationStage` must be known BEFORE the lock (to resolve entry
  // requirements up front): every production caller of this row always
  // supplies `targetStage` explicitly (verified 2026-09-22 across
  // `reviewActions.ts` and `commitAndPushTask.ts`), so the `computeNextStage`
  // fallback below only matters for a hypothetical caller that omits it — a
  // mismatch there cannot corrupt anything: `advanceStageLocked`'s own
  // backstop refuses a transition landing on "impl" with neither a promoted
  // artifact nor entry work supplied.
  const destinationStage = input.targetStage ?? computeNextStage(input.expectedSourceStage) ?? input.expectedSourceStage;

  const result = await enterStageV1(
    taskFolderUri,
    input.expectedSourceStage,
    destinationStage,
    /* isPaused */ false, // Inert here: the transform below always overrides advanceStage's default write, and this row's callers separately compute their own shouldAutoReview from nextActorOnAdvance.
    "complete-and-move-on",
    {
      expectedReviewAttemptId: input.expectedReviewAttemptId,
      deps: { patchTaskProgress: deps.patchTaskProgress },
      additionalBeforeWrite: context.beforeWrite,
      transform: (current) => {
        // Computed fresh on every invocation (matching the pre-reroute
        // behavior) rather than once outside the lock — `patchTaskProgress`
        // may re-run this callback on an internal retry, and a stale
        // captured timestamp would then land as `updatedAt`.
        const now = new Date().toISOString();
        // Validate lifecycle semantics first, so terminal/stale/invalid target
        // errors are not masked by an unrelated absent artifact.
        const baseResult = applyNextStagePolicyV1(current, {
          now,
          targetStage: input.targetStage,
          completionArtifactsPresent: true,
        });
        if (!baseResult.ok) {
          throw new LifecyclePolicyFailureError(baseResult.code);
        }
        const finalResult = applyNextStagePolicyV1(current, {
          now,
          targetStage: input.targetStage,
          completionArtifactsPresent: missingArtifacts.length === 0,
          artifactOverride: input.artifactOverride,
          missingArtifacts,
          nextActorOnAdvance: input.nextActorOnAdvance,
        });
        if (!finalResult.ok) {
          throw new LifecyclePolicyFailureError(finalResult.code);
        }
        return finalResult.progress;
      },
    }
  );

  if (!result.ready) {
    // `enterStageV1` flattens every failure to a string `reason`, but
    // preserves the original thrown error on `cause` (review fix, 2026-09-22,
    // architectural blocker) so this row's typed outcome codes survive the
    // reroute unchanged.
    if (result.cause instanceof LifecyclePolicyFailureError) {
      return { kind: "failed", code: `nextStage.${result.cause.code}`, retryable: false };
    }
    if (result.cause instanceof LifecycleStageMismatchError) {
      return { kind: "failed", code: "nextStage.staleSourceStage", retryable: false };
    }
    if (result.cause instanceof LifecycleReviewAttemptMismatchError) {
      return { kind: "failed", code: "nextStage.staleReviewAttempt", retryable: false };
    }
    if (result.cause === undefined) {
      // `enterStageV1`'s own refusals carry no `cause`: either the
      // destination had unmet entry requirements ("no plan to promote") or
      // the write reported no progress at all — both are recovery-shaped,
      // matching this row's pre-existing `!patched` handling below.
      return { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" };
    }
    return {
      kind: "failed",
      code: toSanitizedWriteFailureCodeV1("nextStage", result.cause),
      retryable: true,
    };
  }

  // Safe now: `enterStageV1`'s own `patchTaskProgressStrictV1` call has
  // already returned, so its `withTaskLock` hold on this task folder has
  // been released — applies the deferred plan-revision adoption write (and
  // the `applyReviewerVerifiedTicks` card withdrawal it now also performs —
  // see that function's doc comment) exactly where it used to run at every
  // caller that built its own `publishArtifact` for this row.
  await runStageEntryPostCommitV1(taskFolderUri, result);

  // Every route that can land currentStage on "publish" must guarantee the
  // stage's document exists (plan item 17, step 20a) — this is the primary
  // manual/review-driven transition writer (legacy `advanceStageLocked` in
  // `stageTransition.ts` covers the other transition kinds), so it must not
  // be the one gap that leaves "not created yet" reachable. `enterStageV1`'s
  // own `advanceStage` call already does this for every destination that
  // reaches "publish" through it, so this is now a defensive no-op restated
  // here for clarity rather than a required duplicate — kept because
  // `ensurePublishReviewArtifactExistsV1` is itself idempotent and cheap.
  if (result.transition.newStage === "publish") {
    await ensurePublishReviewArtifactExistsV1(taskFolderUri);
  }

  // PART 6.5 (review-flagged 2026-08-23), updated for A1 (1.0.0 gate):
  // `applyNextStagePolicyV1` now REFUSES the transition (`implRecoveryOwed`)
  // while a continuation is owed, rather than clearing it — so a successful
  // transition here is proof `implRecovery` was already absent going in.
  // Still push the fact into the scheduling-intent ledger right after the
  // CAS resolves (never from inside the callback, which may re-run on a
  // retry), so a task that advances is not left showing a stale "owed"
  // ledger entry from an unrelated earlier record.
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
