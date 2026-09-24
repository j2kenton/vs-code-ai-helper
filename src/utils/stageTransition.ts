/**
 * Shared stage-advance helper.
 *
 * All stage transition writers (setTaskStage, nextStage, markTaskDone) must
 * route through this helper to guarantee:
 *   1. Stage persistence happens before any downstream action.
 *   2. Auto-review is dispatched at most once per successful transition.
 *   3. No auto-review fires on failed or skipped transitions.
 *
 * The helper is intentionally free of VS Code window/progress UI so it can be
 * unit-tested under node:test without a running extension host.
 */

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import {
  isReviewStage,
  STAGE_ORDER,
  TaskStage,
  type TaskProgress,
} from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { type PersistedTaskProgressV1 } from "../services/taskProgressDecoderV1";
import { updateTaskProgressStage } from "./taskProgressTransforms";
import { ensurePublishReviewArtifactExistsV1 } from "./publishChecksFreshness";
import {
  applyDeferredPlanRevisionAdoptionV1,
  getCanonicalImplementationUri,
  getLegacyImplementationUri,
  preparePlanPromotion,
  resolveImplementationArtifact,
  type PlanPromotion,
  type PlanRevisionAdoptionV1,
} from "./implementationArtifactResolver";
import { readNonEmptyText } from "./fileUtils";
import {
  LifecycleReviewAttemptMismatchError,
  LifecycleStageMismatchError,
} from "../actions/rows/lifecyclePolicyRejection";
import { withTaskLock } from "../state/taskStateStore";
import {
  beginStageEntryJournalV1,
  deleteStageEntryJournalV1,
  recoverStageEntryJournalIfPresentV1,
  recoverStageEntryJournalV1,
  sha256HexV1,
  StageEntryJournalUnreadableErrorV1,
  StageEntryRecoveryPendingErrorV1,
  writeStageEntryJournalV1,
  type StageEntryJournalV1,
} from "./stageEntryJournalV1";

// The disk-level CAS below protects multiple windows. This in-memory queue
// additionally serializes transition dispatch within this extension host, so
// a manual completion and an auto-advance cannot both reach downstream
// dispatch work at the same time for one task.
const transitionDispatches = new Map<string, Promise<void>>();

function queueTransition<T>(taskFolderUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  const key = taskFolderUri.fsPath.toLowerCase();
  const previous = transitionDispatches.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  transitionDispatches.set(key, current);

  return previous
    .catch(() => undefined)
    .then(action)
    .finally(() => {
      release();
      if (transitionDispatches.get(key) === current) {
        transitionDispatches.delete(key);
      }
    });
}

/**
 * Result returned from advanceStage so callers can decide whether to
 * dispatch auto-review or show success messages.
 */
export interface StageTransitionResult {
  /** True when the persistence write succeeded. */
  persisted: boolean;
  /** The stage the task was moved to. */
  newStage: TaskStage;
  /** Whether auto-review should be triggered (caller is responsible for executing it). */
  shouldAutoReview: boolean;
}

/**
 * Explicit map of source → destination transitions that trigger auto-review
 * when the caller opts in via a `kind` in `AUTO_REVIEW_ELIGIBLE_KINDS`.
 *
 * Only transitions that end in a review stage AND come from the immediately
 * preceding non-review stage qualify.
 *
 * Exported so tests can assert against the production map directly.
 */
export const AUTO_REVIEW_TRANSITIONS: Partial<Record<TaskStage, TaskStage>> = {
  plan: "plan-high-review",
  "plan-high-review": "plan-low-review",
  impl: "impl-high-review",
  "impl-high-review": "impl-low-review",
};

/**
 * Every distinct reason `advanceStage` can be called for.
 *
 * A plain boolean can't distinguish "this transition is allowed to opt into
 * auto-review" from "this transition must never auto-review, no matter what
 * a caller passes in" — a future call site could pass `true` for the wrong
 * reason and silently start a duplicate/incorrect review. `kind` makes that
 * a compile-time-visible decision instead of a scattered boolean.
 *
 * Only `complete-and-move-on` and `auto-advance` may ever result in
 * `shouldAutoReview: true` (see `AUTO_REVIEW_ELIGIBLE_KINDS`); every other
 * kind is hard-blocked inside `advanceStage` regardless of `optIn`.
 */
export type TransitionKind =
  /** "Complete Stage & Move On" / "Complete, Commit and Push" style manual completion. */
  | "complete-and-move-on"
  /** Score-based auto-advance past a perfect/threshold review result. */
  | "auto-advance"
  /** Manual "Set Task Stage" / "Set Stage as Current" jump to an arbitrary stage. */
  | "jump"
  /** Non-review-stage reset paths (e.g. reverting progress) — never review-eligible. */
  | "reset"
  /** Reopening a previously-completed task at a chosen stage. */
  | "reopen"
  /** Startup/checkpoint recovery replaying a transition that already happened. */
  | "recovery"
  /** Internal transition used only inside fast-forward's own retry loop. */
  | "fast-forward-internal"
  /** Running a review itself moves the task onto the review stage; must never re-dispatch a review. */
  | "review-run"
  /**
   * The "Complete, Commit and Push" composite's own internal advance to
   * Publish. Distinct from "complete-and-move-on" so this transition is
   * never eligible for auto-publish scheduling — the composite already
   * calls commitAndPushTask itself immediately afterward, and scheduling a
   * second auto-publish chain here would race a duplicate commit/push
   * against that explicit call.
   */
  | "complete-commit-push"
  /**
   * Entering the Plan stage from a fresh "Generate Plan with AI" run.
   * Intended single production caller (not yet wired — see `enterStageV1`'s
   * doc comment): `handleGeneratePlanOutcomeV1` (`generatePlanWithAI.ts`).
   */
  | "generate-plan"
  /**
   * Entering the Plan stage to revise an already-accepted plan from a
   * checklist-change proposal. Intended single production caller (not yet
   * wired): `reviseChecklistChangeProposalConfirmed` (`planRevisionV1.ts`).
   */
  | "plan-revision"
  /**
   * Entering the Implementation stage from "Generate Implementation"
   * (promoting `plan.md` to `plan-final.md` without also starting a round).
   * Intended single production caller (not yet wired):
   * `handleGenerateImplementationOutcomeV1` (`reviewActions.ts`).
   */
  | "generate-implementation"
  /**
   * Entering the Implementation stage as part of actually running an
   * implementation round (e.g. "Implement Actual Work" dispatched directly
   * from a pre-Implementation stage). Intended single production caller (not
   * yet wired): the implementation-run completion patch in `reviewActions.ts`.
   */
  | "implementation-run";

/**
 * The only two kinds that may ever produce `shouldAutoReview: true`. Every
 * other `TransitionKind` is hard-blocked in `advanceStage` regardless of the
 * `optIn` flag a caller passes.
 */
export const AUTO_REVIEW_ELIGIBLE_KINDS: ReadonlySet<TransitionKind> = new Set([
  "complete-and-move-on",
  "auto-advance",
]);

/**
 * Persist a stage transition and compute whether auto-review should fire.
 *
 * Callers receive a `StageTransitionResult` with `shouldAutoReview` set when
 * all of the following are true:
 *   - `triggerAutoReview` is true (caller opted in)
 *   - The task is not paused
 *   - The destination is a review stage
 *   - The source → destination pair is in `AUTO_REVIEW_TRANSITIONS`
 *
 * Callers are responsible for executing the auto-review command; this helper
 * only computes eligibility to keep UI concerns out of the utility layer.
 *
 * @param taskFolderUri  The task folder to update.
 * @param sourceStage    The stage the task is currently at before this transition.
 * @param newStage       The stage to advance to.
 * @param isPaused       Whether the task is currently paused.
 * @param kind           Why this transition is happening. Hard-gates auto-review
 *   eligibility: only `AUTO_REVIEW_ELIGIBLE_KINDS` can ever produce
 *   `shouldAutoReview: true`, regardless of `optIn`.
 * @param optIn          Caller-side opt-in (e.g. a workspace setting) for kinds
 *   that are eligible. Ignored for ineligible kinds. Defaults to `true`.
 * @param expectedReviewAttemptId  When set, the transition is rejected unless
 *   the task's persisted `reviewAttemptId` still matches — guards against a
 *   superseded review attempt advancing (or re-publishing over) a newer one.
 * @param publishArtifact  Optional side effect (e.g. renaming a staged review
 *   file into place) run atomically with the CAS check/write, inside the same
 *   lock. Passing the artifact publish here — instead of doing it after
 *   `advanceStage` returns — closes the window where a newer review attempt
 *   could claim and publish before this attempt's own (already-validated)
 *   publish step runs, which would otherwise let a stale result clobber the
 *   accepted artifact.
 * @param transform  Overrides the default `updateTaskProgressStage` write with
 *   the caller's own progress mutation (e.g. `enterStageV1`'s callers apply
 *   their own stage-entry policy). Receives the freshly-read progress and the
 *   `nextActor` value this function already computed for the write. Omit to
 *   get the default `updateTaskProgressStage` behavior unchanged.
 * @param precondition  An additional caller-supplied compare-and-set check,
 *   run inside the same lock immediately after the built-in source-stage/
 *   review-attempt checks and before `transform`. Returning a string refuses
 *   the transition with that reason (thrown as an `Error`, same as the
 *   built-in checks); returning `true` proceeds.
 * @param onCommitFailure  Review fix (2026-09-22, completion blocker, second
 *   narrowing): a caller-supplied hook invoked, and fully awaited, INSIDE the
 *   same `queueTransition` critical section as the failed write — i.e. before
 *   the in-process transition queue for this task is released to any queued
 *   successor. Receives the thrown error and returns the `Error` to actually
 *   throw (a caller that needs to roll back a `publishArtifact` side effect
 *   folds recovery-failure detail into the returned error here). Without this,
 *   a caller performing its own rollback AFTER `advanceStage` has already
 *   rejected races a queued successor transition that the release already let
 *   proceed — see `enterStageV1`'s use of this parameter.
 * @param patchTaskProgress  Injectable seam for `patchTaskProgressStrictV1`
 *   (defaults to the real implementation). Exists so a rerouted lifecycle-row
 *   caller (`nextStageRowV1.ts`'s existing `NextStageRowDepsV1` test seam) can
 *   still exercise its own write-failure path deterministically through
 *   `enterStageV1` without monkey-patching the module-level writer.
 * @returns `StageTransitionResult`, or `undefined` when persistence failed.
 */
export async function advanceStage(
  taskFolderUri: vscode.Uri,
  sourceStage: TaskStage,
  newStage: TaskStage,
  isPaused: boolean,
  kind: TransitionKind,
  optIn: boolean = true,
  expectedReviewAttemptId?: string,
  publishArtifact?: (patched: TaskProgress) => Promise<void>,
  transform?: (current: PersistedTaskProgressV1, nextActorForWrite: "human" | "automation") => TaskProgress,
  precondition?: (current: PersistedTaskProgressV1) => true | string,
  onCommitFailure?: (error: unknown) => Promise<Error>,
  patchTaskProgress: typeof patchTaskProgressStrictV1 = patchTaskProgressStrictV1
): Promise<StageTransitionResult | undefined> {
  return queueTransition(taskFolderUri, () => advanceStageLocked(
    taskFolderUri,
    sourceStage,
    newStage,
    isPaused,
    kind,
    optIn,
    expectedReviewAttemptId,
    publishArtifact,
    transform,
    precondition,
    onCommitFailure,
    patchTaskProgress
  ));
}

async function advanceStageLocked(
  taskFolderUri: vscode.Uri,
  sourceStage: TaskStage,
  newStage: TaskStage,
  isPaused: boolean,
  kind: TransitionKind,
  optIn: boolean,
  expectedReviewAttemptId?: string,
  publishArtifact?: (patched: TaskProgress) => Promise<void>,
  transform?: (current: PersistedTaskProgressV1, nextActorForWrite: "human" | "automation") => TaskProgress,
  precondition?: (current: PersistedTaskProgressV1) => true | string,
  onCommitFailure?: (error: unknown) => Promise<Error>,
  patchTaskProgress: typeof patchTaskProgressStrictV1 = patchTaskProgressStrictV1
): Promise<StageTransitionResult | undefined> {
  // v1 fixes 2, item 8/32/Wave I review fix (2026-09-17): computed BEFORE the
  // patch, from inputs already known to the caller (kind/optIn/isPaused/
  // sourceStage/newStage), so the correct fresh `nextActor` can be folded
  // into the SAME atomic CAS write below instead of a second, race-prone
  // patch after the fact. Identical eligibility test to the one below that
  // computes the returned `shouldAutoReview` — kept as one source of truth by
  // computing it once, here, and reusing it for both. A same-stage
  // transition (sourceStage === newStage) can never be auto-review eligible:
  // AUTO_REVIEW_TRANSITIONS never maps a stage to itself.
  const shouldAutoReviewForWrite =
    sourceStage !== newStage &&
    AUTO_REVIEW_ELIGIBLE_KINDS.has(kind) &&
    optIn &&
    !isPaused &&
    isReviewStage(newStage) &&
    AUTO_REVIEW_TRANSITIONS[sourceStage] === newStage;

  // Runtime backstop (Part 1, item 24): a transition LANDING on "impl" —
  // whether forward through the normal stage order or backward via a jump or
  // Reopen — must never land with no implementation artifact and no entry
  // work supplied to create one — that is exactly the "task lands on impl
  // with no implementation artifact" failure `preparePlanPromotion`'s own doc
  // comment warns every stage-mutating writer to avoid. Review fix
  // (2026-09-22, completion blocker): this used to gate on
  // `STAGE_ORDER.indexOf(sourceStage) < STAGE_ORDER.indexOf("impl")`, so a
  // backward jump (e.g. from "publish") or a Reopen selecting "impl" with a
  // missing/deleted artifact silently produced an unusable stage instead of
  // being refused — exactly the item-15 failure this backstop exists to
  // close. A same-stage re-entry ("impl" -> "impl") is excluded: it is
  // covered by the general CAS/lock path below and never needs fresh entry
  // work of its own. A caller that goes through `enterStageV1` always
  // supplies a `publishArtifact` when one is needed (or the artifact is
  // already canonical); a caller that bypasses that primitive and reaches
  // this point with neither is refused here rather than silently producing
  // an unusable stage.
  const isEnteringImpl = newStage === "impl" && sourceStage !== "impl";
  if (isEnteringImpl && !publishArtifact) {
    const canonicalContent = await readNonEmptyText(getCanonicalImplementationUri(taskFolderUri));
    const legacyContent = canonicalContent === undefined
      ? await readNonEmptyText(getLegacyImplementationUri(taskFolderUri))
      : undefined;
    if (canonicalContent === undefined && legacyContent === undefined) {
      throw new Error(
        "Refusing to enter Implementation with no implementation artifact and no entry work supplied " +
          "to create one — route this transition through enterStageV1/prepareStageEntryV1."
      );
    }
  }

  // Persist the stage transition before any other action.
  // patchTaskProgress preserves all unrelated fields (implReviewFiles,
  // scheduledAt, lintPayload, status, etc.).
  let patched: TaskProgress | undefined;
  try {
    patched = await patchTaskProgress(taskFolderUri, (current) => {
      // Compare-and-set the source stage inside the task lock. This prevents a
      // delayed review/shortcut from advancing a newer run a second time.
      //
      // Review fix (2026-09-22, architectural blocker, fourth narrowing):
      // these two built-in checks now throw the SAME typed error classes
      // `nextStageRowV1.ts` used to throw itself, so a caller rerouted onto
      // `enterStageV1` (see `StageEntryResultV1.cause`) can still recover its
      // exact original error codes (`nextStage.staleSourceStage`,
      // `nextStage.staleReviewAttempt`) instead of falling through to a
      // generic sanitized-write-failure code — the reason this file, a
      // general utility, imports from `actions/rows/lifecyclePolicyRejection`
      // (a leaf module with no imports of its own, so this creates no cycle).
      if (current.currentStage !== sourceStage) {
        throw new LifecycleStageMismatchError(
          `Task changed before transition (expected ${sourceStage}, found ${current.currentStage}).`
        );
      }
      if (expectedReviewAttemptId !== undefined && current.reviewAttemptId !== expectedReviewAttemptId) {
        throw new LifecycleReviewAttemptMismatchError("Review result is stale; a newer review attempt owns this transition.");
      }
      if (precondition) {
        const result = precondition(current);
        if (result !== true) {
          throw new Error(result);
        }
      }
      const nextActorForWrite: "human" | "automation" = shouldAutoReviewForWrite ? "automation" : "human";
      if (transform) {
        return transform(current, nextActorForWrite);
      }
      if (sourceStage === newStage) {
        // Review fix (2026-09-22, completion blocker): a same-stage entry with
        // no caller-supplied transform (e.g. a review-attempt CAS/publish
        // check that never intends to move the stage — see
        // stageTransitionPublish.test.ts) must leave every field untouched
        // rather than running it through `updateTaskProgressStage`, which is
        // written for an actual stage move and would needlessly reassign
        // `nextActor`. This case used to be a separate early-return branch
        // that skipped `precondition`, skipped a caller's `transform`
        // entirely, and — when `expectedReviewAttemptId` was omitted — could
        // even run `publishArtifact` outside this lock altogether. Falling
        // through to the same CAS/lock path as every other transition closes
        // all three gaps: the checks above still run, and `beforeWrite` below
        // still publishes atomically with them.
        return current;
      }
      return updateTaskProgressStage(
        current,
        newStage,
        // v1 fixes 2 review fix (2026-09-17, narrowed completion blocker):
        // "not auto-review eligible" must persist the plain fact that this
        // transition hands control back to the human — see
        // TaskProgress.nextActor's own doc comment ("completed stage actions
        // that hand control back persist nextActor: human"). Clearing to
        // unknown here was itself the defect: a task landing at a new stage
        // with nothing further arranged then had no durable record that a
        // human, not automation, is expected to act next.
        nextActorForWrite
      );
    }, { beforeWrite: publishArtifact });
  } catch (error) {
    // Review fix (2026-09-22, completion blocker, second narrowing): run the
    // caller's rollback INSIDE this same queued critical section — i.e.
    // before `queueTransition`'s `finally` releases this task's in-process
    // transition queue to a waiting successor. A caller that instead performed
    // its own rollback AFTER `advanceStage` had already rejected (the
    // previous shape) raced a queued successor transition that the release
    // had already let proceed. See `onCommitFailure`'s own doc comment.
    if (onCommitFailure) {
      throw await onCommitFailure(error);
    }
    throw error;
  }

  if (!patched) {
    return undefined;
  }

  // The stage always has a document to open (plan item 17, step 20(a)):
  // create publish-review.md the moment ANY transition lands on Publish, not
  // only when a review is later requested — "not created yet" must be
  // unreachable once a task has actually reached the stage. Idempotent and
  // cheap; every route that can set currentStage to "publish" goes through
  // this one helper.
  if (newStage === "publish") {
    await ensurePublishReviewArtifactExistsV1(taskFolderUri);
  }

  // Exactly-once auto-review eligibility, computed once above (before the
  // write, so its `"automation"`/unknown result could be folded into the same
  // atomic patch) and reused here unchanged — the write already happened only
  // on a successful `patched` result, so this is still effectively evaluated
  // only after persistence succeeds. `kind` is a hard gate: only
  // AUTO_REVIEW_ELIGIBLE_KINDS can ever reach `shouldAutoReview: true`, no
  // matter what `optIn` is — see TransitionKind's doc comment.
  const shouldAutoReview = shouldAutoReviewForWrite;

  // Commit and push (the Publish command) must never be scheduled
  // automatically for any transition, no matter the destination stage or
  // workspace settings — it may only run from the user's explicit "Commit
  // and Push" button click. There is deliberately no `shouldAutoPublish`
  // here for a caller to thread toward auto-scheduling it.
  return {
    persisted: true,
    newStage,
    shouldAutoReview,
  };
}

/**
 * Compute the next stage in the linear STAGE_ORDER, or undefined when
 * `currentStage` is the last stage.
 *
 * Exported so callers (nextStage, markTaskDone) can determine the next stage
 * without duplicating STAGE_ORDER indexing logic.
 */
export function computeNextStage(
  currentStage: TaskStage,
  configuredStages?: ReadonlySet<TaskStage>
): TaskStage | undefined {
  let idx = STAGE_ORDER.indexOf(currentStage);
  if (idx === -1) return undefined;
  while (idx < STAGE_ORDER.length - 1) {
    idx += 1;
    const candidate = STAGE_ORDER[idx];
    if (!candidate) continue;
    // A caller that has loaded model settings may omit optional review stages.
    // Keep the default behavior unchanged when no settings are supplied.
    if (configuredStages === undefined || !isReviewStage(candidate) || configuredStages.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Return true when `stage` is an eligible source for auto-review dispatch.
 * Convenience wrapper over AUTO_REVIEW_TRANSITIONS.
 */
export function isAutoReviewSource(stage: TaskStage): boolean {
  return stage in AUTO_REVIEW_TRANSITIONS;
}

/**
 * Prepare (read-only) whatever a destination stage needs before a task may
 * land on it. Today only "impl" carries an entry requirement (promoting
 * `plan.md` to `plan-final.md` — see `preparePlanPromotion`); every other
 * destination has nothing to prepare, so this simply reports "nothing to do"
 * rather than special-casing "impl" at every call site.
 *
 * Kept as a thin, explicit wrapper — rather than inlining
 * `preparePlanPromotion` into `enterStageV1` — so a future destination with
 * its own entry requirement has exactly one place to add it, and so
 * `enterStageV1` itself stays destination-agnostic.
 *
 * @param options.requireExistingArtifact  Review fix (2026-09-22, completion
 *   blocker): set by `enterStageV1` for the "reopen" kind only. A completed
 *   task necessarily finished its own plan revision (if any) before
 *   completing, so reopening it at "impl" must find `plan-final.md` ALREADY
 *   canonical — never fall back to (re)promoting a leftover `plan.md`, which
 *   would silently regenerate a missing canonical artifact instead of
 *   refusing. When set and the artifact is not already canonical, this
 *   returns `{ ready: false }` without reading `plan.md` at all (generic
 *   promotion — used by every other destination-"impl" caller — is skipped
 *   entirely).
 */
export async function prepareStageEntryV1(
  taskFolderUri: vscode.Uri,
  destinationStage: TaskStage,
  options?: {
    requireExistingArtifact?: boolean;
    /**
     * Set only by `enterStageOnceV1` when ITS OWN caller passed
     * `callerHoldsCoveringLock` (see `enterStageV1`'s matching option's doc
     * comment for why: the Reopen row's `skipTaskLock` path runs from inside
     * `activateTaskLocked`'s meta-root lock hold, under which
     * `recoverStageEntryJournalV1` — which always acquires `withTaskLock`
     * itself — would self-deadlock via the shared per-tasksRoot local
     * mutation queue both locks funnel through, `withLocalMutationQueue`
     * (`taskStateStore.ts`). Skips this function's own proactive recovery
     * call below; the "friendly pre-check" callers in `reviewActions.ts` and
     * `enterStageOnceV1`'s normal (non-skip-lock) callers never set this, so
     * they keep getting proactive recovery as normal. `reopenCompletedTask`
     * (`reopenTask.ts`) runs the equivalent recovery itself, BEFORE
     * `activateTask` ever acquires that meta-root lock, so this caller never
     * actually needs the skip for correctness — it is kept only so this
     * function itself never becomes the thing that self-deadlocks if some
     * future caller reaches it from inside that same lock hold.
     */
    skipProactiveRecovery?: boolean;
  }
): Promise<PlanPromotion> {
  // Part 2 (item 15 hardening) — proactive recovery, review fix (2026-09-23,
  // completion blocker): this used to run only when `destinationStage ===
  // "impl"`, below the early return for every other destination. That left a
  // real correctness gap: a stage-entry journal for a PRIOR "impl" entry that
  // crashed between its progress-write commit and Phase C's journal delete
  // survives on disk with `to: "impl"`. If the very next transition for this
  // task moves PAST "impl" (e.g. impl -> impl-high-review, `auto-advance`)
  // without this call running first, that journal is left stale while
  // `currentStage` no longer equals `journal.to`. `recoverStageEntryJournalV1`'s
  // Phase A treats `currentStage !== journal.to` (with `phase` not yet
  // `"committed"`) as PROOF the transition never committed and rolls the
  // artifact back — which would then delete or overwrite the `plan-final.md`
  // every later stage still depends on, even though the entry into "impl"
  // actually succeeded. Running this unconditionally, before the
  // destination-specific check below, closes that window: whichever
  // transition next passes through `prepareStageEntryV1` (any destination,
  // not only "impl") reconciles a stale journal from a PRIOR transition while
  // `currentStage` can still prove what actually happened, well before some
  // later, unrelated transition could make Phase A misclassify it. A journal
  // is only ever written for an "impl" promotion (see
  // `StageEntryJournalV1.artifact`), so this is a cheap no-op existence probe
  // for every other destination that has none pending. This also covers "the
  // head of `enterStageV1`" (the other call site the plan names):
  // `enterStageOnceV1`'s very first action is calling this function, and
  // `enterStageV1`'s own retry recurses through the same path — so a second,
  // separate call at `enterStageV1`'s own top would only repeat this same
  // cheap existence probe, never observe anything this one has not already
  // reconciled. Skipped when `skipProactiveRecovery` is set — see that
  // option's own doc comment for the one caller that needs this.
  if (!options?.skipProactiveRecovery) {
    await recoverStageEntryJournalIfPresentV1(taskFolderUri);
  }
  if (destinationStage !== "impl") {
    return { ready: true };
  }
  if (options?.requireExistingArtifact) {
    const resolved = await resolveImplementationArtifact(taskFolderUri);
    return resolved.isCanonical ? { ready: true } : { ready: false };
  }
  return preparePlanPromotion(taskFolderUri);
}

/**
 * The lock-released post-commit payload {@link runStageEntryPostCommitV1}
 * runs — deliberately just these three optional fields, decoupled from the
 * rest of {@link StageEntryResultV1} (in particular `transition`, which a
 * crash-recovered journal has no way to reconstruct). Both production
 * post-commit paths build one of these:
 *   - `enterStageV1`'s own `ready: true` result, for the normal
 *     no-crash case (structurally assignable here — see that type);
 *   - `recoverAndReplayCommittedJournalV1` (`stageEntryJournalV1.ts`), for a
 *     journal Phase A found already `"committed"` — built from ONLY what the
 *     journal persisted to disk, so `postCommit` is always `undefined` there
 *     (a closure cannot survive a crash or cross a process boundary; see
 *     that module's doc comment for what is still open here).
 */
export interface StageEntryPostCommitPayloadV1 {
  /**
   * Set when the destination stage's entry work published a plan
   * revision that deferred its own durable adoption write — pass this to
   * {@link runStageEntryPostCommitV1} once the caller's own lock hold (if
   * any) around `enterStageV1` has released.
   */
  readonly deferredPlanRevisionAdoption?: PlanRevisionAdoptionV1;
  /**
   * The caller's own lock-released follow-up work (e.g. withdrawing a
   * now-stale decision card), threaded through from `enterStageV1`'s
   * `options.postCommit` and run by {@link runStageEntryPostCommitV1}
   * AFTER the deferred plan-revision adoption above — so a caller never
   * needs its own separate "run this after the transition, once the lock
   * is released" call site alongside `runStageEntryPostCommitV1`.
   */
  readonly postCommit?: () => Promise<void>;
  /**
   * Part 2 (item 15 hardening) — set when this transition's publish began
   * a stage-entry journal (`stageEntryJournalV1.ts`). Passed to
   * {@link runStageEntryPostCommitV1}, which deletes the journal (Phase C)
   * only once this transition has actually committed. `undefined` when
   * this transition had no publish (destination artifact already
   * canonical, or no entry work at all) — there is then nothing for
   * Phase C to clean up. A begin failure can no longer reach this `ready:
   * true` branch at all: it fails closed (see `enterStageV1`'s doc
   * comment) and either recovers-and-retries or is refused.
   */
  readonly journalTransitionId?: string;
}

/** Result of {@link enterStageV1}. */
export type StageEntryResultV1 =
  | ({
      ready: true;
      transition: StageTransitionResult;
    } & StageEntryPostCommitPayloadV1)
  | {
      ready: false;
      /** Human-readable reason the transition was refused — nothing was written. */
      reason: string;
      /**
       * Review fix (2026-09-22, architectural blocker, fourth narrowing): the
       * original thrown error (when this refusal came from a caught
       * `advanceStage` rejection rather than a `{ ready: false }` promotion
       * refusal), so a caller that needs its exact typed error class back
       * (e.g. `nextStageRowV1.ts` mapping `LifecyclePolicyFailureError`,
       * `LifecycleStageMismatchError` and `LifecycleReviewAttemptMismatchError`
       * onto its own outcome codes) does not have to pattern-match `reason`'s
       * free text. `undefined` when there was no caught error (e.g. the
       * "no plan to promote" and "could not read or update task progress"
       * refusals below).
       */
      cause?: unknown;
    };

/**
 * The single destination-entry transition: prepares whatever the destination
 * stage requires ({@link prepareStageEntryV1}), then commits the stage move
 * (and the caller's own progress transform, if any) atomically with
 * publishing that preparation's artifact — all through the existing
 * `advanceStage` CAS/auto-review machinery, so entry work can never land
 * without the stage move, or the stage move without the entry work.
 *
 * Pre-1.0.0 fixes register, Part 1 (item 15) audit — every production stage
 * mutator, and how each one now enters through this one door:
 *   - manual Next Stage (`nextStageRowV1.ts`'s `executeNextStageV1`, reached
 *     from `advanceStageViaNextStageRowV1` — also covers every
 *     review-triggered forward transition: score-based auto-advance and a
 *     review's own stage-advance) — kind `complete-and-move-on`/`auto-advance`,
 *     transform `applyNextStagePolicyV1`;
 *   - `setTaskStage` (`setTaskStage.ts`, including the escalation card's
 *     "Advance to <stage>" and Chat Resume) — kind `jump`, default transform;
 *   - the Reopen row (`resumeTaskRowV1.ts`) — kind `reopen`, transform
 *     `applyReopenPolicyV1`, `requireExistingArtifact` so a reopen can never
 *     recreate `plan-final.md` from a leftover `plan.md`;
 *   - plan generation's outcome handler (`generatePlanWithAI.ts`'s
 *     `handleGeneratePlanOutcomeV1`) — kind `generate-plan`, default
 *     transform, precondition `ELIGIBLE_STAGES.includes(currentStage)`;
 *   - plan revision (`planRevisionV1.ts`'s
 *     `reviseChecklistChangeProposalConfirmed`) — kind `plan-revision`,
 *     transform `applyPlanRevisionPolicyV1`;
 *   - the Generate Implementation outcome handler (`reviewActions.ts`'s
 *     `handleGenerateImplementationOutcomeV1`) — kind `generate-implementation`,
 *     always a same-stage ("impl" -> "impl") re-entry;
 *   - the implementation-run completion patch (`reviewActions.ts`'s
 *     `executeImplementationRun`) — kind `implementation-run`, run BEFORE
 *     (and as a separate transaction from) that patch's own result write,
 *     which never sets `currentStage` itself;
 *   - `chatWithStage.ts` and `implementationRecoveryV1.ts`'s stage writers;
 *   - `goToReviewAndApplyV1.ts` (review-stage-only destinations).
 * `AUTO_REVIEW_ELIGIBLE_KINDS` is unchanged by this audit — only
 * `complete-and-move-on`/`auto-advance` may ever produce
 * `shouldAutoReview: true`; none of the newly-added `TransitionKind` members
 * (`generate-plan`, `plan-revision`, `generate-implementation`,
 * `implementation-run`) joins that set. Every other `TransitionKind`
 * member's own doc comment names the caller its reroute is intended for.
 * Kept fully self-contained and tested so wiring a further caller onto it is
 * a routing change, not a behavior change.
 *
 * Part 2 (item 15 hardening) invariant: a `plan-final.md` written by a
 * transition through this function is trustworthy if and only if no
 * stage-entry journal exists for this task, or the journal's transition has
 * committed (`phase: "committed"`, or its `to` stage matches the task's
 * current stage) — see `stageEntryJournalV1.ts`'s `recoverStageEntryJournalV1`
 * (Phase A).
 *
 * FAIL-CLOSED, not best-effort (review fix, 2026-09-23, architectural
 * blocker): `enterStageOnceV1`'s `publishArtifact` closure does not catch a
 * journal begin/phase-write failure — it propagates, aborts the whole
 * `patchTaskProgressStrictV1` write, and reaches `onCommitFailure`, which
 * (a) runs the existing byte-guarded artifact rollback whenever this
 * attempt's own write may have landed, and (b) cleans up any journal THIS
 * attempt began. A begin failure specifically caused by an un-recovered
 * journal from a PRIOR, different transition
 * (`StageEntryRecoveryPendingErrorV1`/`StageEntryJournalUnreadableErrorV1`)
 * is caught one level up, by the exported `enterStageV1` wrapper: it runs
 * `recoverStageEntryJournalV1` (now all three phases — Phase A's decide/
 * rollback, and, for a `"committed"` outcome, Phase B's post-commit replay and
 * Phase C's journal cleanup, both lock-released then re-acquired — see that
 * function's own doc comment in `stageEntryJournalV1.ts`) and retries the
 * whole transition once, exactly as this module's own doc comment's
 * commit-protocol section specifies. Only a SECOND collision (recovery ran
 * and it still collides) is reported as a plain refusal. A genuine crash
 * between "published" and the progress commit — no live process left to hit
 * either failure path above — is what this same `recoverStageEntryJournalV1`
 * call reconciles the NEXT time any transition is attempted against this
 * task (via the collision it raises then), but a task can also sit
 * un-recovered indefinitely with no next attempt ever made against it —
 * proactive recovery independent of a next attempt is wired at
 * `prepareStageEntryV1` (this function's own head, and the two "friendly
 * pre-check" reads in `reviewActions.ts`), `materializeCanonicalIfNeeded`,
 * and once per task in the activation sweep, all via the cheap
 * `recoverStageEntryJournalIfPresentV1` — see `stageEntryJournalV1.ts`'s own
 * doc comment for the full list and the one caller
 * (`callerHoldsCoveringLock`) that must skip it.
 *
 * @param transform  The caller's own progress mutation for this transition
 *   (e.g. a future caller's `applyReopenPolicyV1`/`applyNextStagePolicyV1`
 *   equivalent). Omit to get `advanceStage`'s default
 *   `updateTaskProgressStage` behavior.
 * @param precondition  The caller's own additional compare-and-set check, run
 *   inside the same lock as the stage write — see `advanceStage`'s matching
 *   parameter.
 * @param deps  Injectable seam for `patchTaskProgressStrictV1` — see
 *   `advanceStage`'s matching parameter's doc comment.
 * @param additionalBeforeWrite  A caller-supplied side effect (e.g. a
 *   lifecycle row's own externally-supplied `context.beforeWrite`, unrelated
 *   to this destination's own entry work) run atomically inside the SAME
 *   locked write as this destination's own promotion, if any — ahead of it.
 *   Kept separate from `transform`/`precondition` because it is a side
 *   effect, not a progress mutation or a CAS check.
 */
/**
 * Public entry point: runs {@link enterStageOnceV1} and, on the specific
 * failure the commit protocol names — an un-recovered stage-entry journal
 * from a PRIOR, un-committed transition already on disk
 * (`StageEntryRecoveryPendingErrorV1`) or one that exists but cannot be
 * parsed (`StageEntryJournalUnreadableErrorV1`) — recovers it via
 * {@link recoverStageEntryJournalV1} (safe to call here since the failed
 * attempt's own `patchTaskProgressStrictV1` hold has already released by the
 * time its rejection reaches this catch) and retries the WHOLE
 * transition exactly once (review fix, 2026-09-23, architectural blocker —
 * this was the missing fail-closed half of the commit protocol: a collision
 * used to be silently skipped rather than refused-then-recovered-then-retried).
 * A second collision (recovery ran and the transition still collides) is
 * reported as a plain refusal rather than looping — see this function's own
 * `retrying` guard.
 *
 * `options.callerHoldsCoveringLock` (Part 2, item 15 hardening): set by a
 * caller that invokes this from inside a lock that already covers this task
 * — today, only the Reopen row's `skipTaskLock` path (`resumeTaskRowV1.ts`),
 * called from inside `activateTaskLocked`'s meta-root lock hold
 * (`taskActivationCoordinator.ts`). `recoverStageEntryJournalV1` always
 * acquires `withTaskLock` itself, and that lock's per-tasksRoot local
 * mutation queue (`withLocalMutationQueue`, `taskStateStore.ts`) is the SAME
 * queue `withMetaRootLock` funnels through — so calling it from inside an
 * already-running `withMetaRootLock` operation for this task's tasksRoot
 * would wait on a queue slot that can only free once this very call returns:
 * a self-deadlock, not merely a slow path. When set, this function neither
 * recovers a journal-collision refusal here NOR retries (a genuine but rare
 * refusal — reachable only when a crash left an un-recovered journal for
 * THIS exact task, and a Reopen for THIS exact task is attempted before any
 * other recovery call site has run — is far preferable to hanging), and
 * `prepareStageEntryV1`'s own proactive recovery is skipped the same way
 * (see `enterStageOnceV1`'s call site below).
 */
export async function enterStageV1(
  taskFolderUri: vscode.Uri,
  sourceStage: TaskStage,
  destinationStage: TaskStage,
  isPaused: boolean,
  kind: TransitionKind,
  options: {
    optIn?: boolean;
    expectedReviewAttemptId?: string;
    transform?: (current: PersistedTaskProgressV1, nextActorForWrite: "human" | "automation") => TaskProgress;
    precondition?: (current: PersistedTaskProgressV1) => true | string;
    deps?: { patchTaskProgress: typeof patchTaskProgressStrictV1 };
    additionalBeforeWrite?: (patched: TaskProgress) => Promise<void>;
    postCommit?: () => Promise<void>;
    callerHoldsCoveringLock?: boolean;
  } = {},
  /** Internal — set only by this function's own single retry. Not part of the
   * public contract. */
  retrying = false
): Promise<StageEntryResultV1> {
  const result = await enterStageOnceV1(
    taskFolderUri,
    sourceStage,
    destinationStage,
    isPaused,
    kind,
    options
  );
  if (
    result.ready ||
    retrying ||
    options.callerHoldsCoveringLock ||
    !(result.cause instanceof StageEntryRecoveryPendingErrorV1 || result.cause instanceof StageEntryJournalUnreadableErrorV1)
  ) {
    return result;
  }
  await recoverStageEntryJournalV1(taskFolderUri);
  return enterStageV1(taskFolderUri, sourceStage, destinationStage, isPaused, kind, options, true);
}

async function enterStageOnceV1(
  taskFolderUri: vscode.Uri,
  sourceStage: TaskStage,
  destinationStage: TaskStage,
  isPaused: boolean,
  kind: TransitionKind,
  options: {
    optIn?: boolean;
    expectedReviewAttemptId?: string;
    transform?: (current: PersistedTaskProgressV1, nextActorForWrite: "human" | "automation") => TaskProgress;
    precondition?: (current: PersistedTaskProgressV1) => true | string;
    deps?: { patchTaskProgress: typeof patchTaskProgressStrictV1 };
    additionalBeforeWrite?: (patched: TaskProgress) => Promise<void>;
    /**
     * The caller's own lock-released follow-up work for a successful
     * transition (e.g. withdrawing a decision card the destination stage
     * makes stale) — see {@link StageEntryResultV1}'s `postCommit` field and
     * `runStageEntryPostCommitV1`'s doc comment. Never invoked on a refused
     * transition.
     */
    postCommit?: () => Promise<void>;
    /** See {@link enterStageV1}'s matching option's doc comment. */
    callerHoldsCoveringLock?: boolean;
  } = {}
): Promise<StageEntryResultV1> {
  // Refuse before writing anything: a destination with unmet entry
  // requirements (e.g. "impl" with no plan.md to promote) must never reach
  // the CAS/write step at all.
  //
  // Review fix (2026-09-22, completion blocker): "reopen" requires the
  // artifact to be ALREADY canonical — see `prepareStageEntryV1`'s
  // `requireExistingArtifact` doc comment for why generic promotion (which
  // would recreate plan-final.md from a leftover plan.md) must never run for
  // this kind.
  const promotion = await prepareStageEntryV1(taskFolderUri, destinationStage, {
    requireExistingArtifact: kind === "reopen",
    skipProactiveRecovery: options.callerHoldsCoveringLock,
  });
  if (!promotion.ready) {
    return {
      ready: false,
      reason:
        kind === "reopen"
          ? "this task has no plan-final.md to reopen at Implementation — its plan may need to be regenerated first"
          : "there is no plan to promote — generate the plan first",
    };
  }

  // No publish closure when the artifact is already canonical (or the
  // destination has no entry requirement at all) — `promotion.publish` is
  // undefined in both cases, so `advanceStage` commits with no `beforeWrite`
  // side effect.
  let deferredPlanRevisionAdoption: PlanRevisionAdoptionV1 | undefined;
  const publish = promotion.publish;
  // Set when `publish()` actually landed bytes at the canonical artifact — see
  // `onCommitFailure` below, which recovers a failure through the SAME
  // journal-driven rollback a crash uses (Part 2, item 15 hardening: "In-
  // process failure now uses the same code"), rather than a second,
  // separate in-process-only recovery path keyed on bytes captured here.
  let published = false;
  // Part 2 (item 15 hardening) — set only when this transition's publish
  // actually began a stage-entry journal (see below). Threaded onto
  // `StageEntryResultV1` so `runStageEntryPostCommitV1` can delete it (Phase
  // C) once the transition has actually committed, and onto `onCommitFailure`
  // so a failed commit cleans it up too rather than leaving it for some
  // future recovery call site (none of which are wired yet — see this
  // module's Part 2 doc notes) to find.
  let journalTransitionId: string | undefined;
  const additionalBeforeWrite = options.additionalBeforeWrite;
  const publishArtifact = publish || additionalBeforeWrite
    ? async (patched: TaskProgress): Promise<void> => {
        // A caller's own unrelated side effect (e.g. a lifecycle row's
        // externally-supplied `context.beforeWrite`) runs first, still
        // atomically inside this same locked write — see this parameter's
        // own doc comment.
        if (additionalBeforeWrite) {
          await additionalBeforeWrite(patched);
        }
        if (!publish) {
          return;
        }
        // Deferred: this closure runs as `advanceStage`'s `beforeWrite`,
        // i.e. while its own patch call already holds the task lock — a
        // plan-revision publish that needs its own durable adoption write
        // must defer it (see `preparePlanPromotion`'s `publish` doc comment
        // for why writing task-progress.json from inside that hold would
        // deadlock or clobber the outer write).
        //
        // Review fix (2026-09-22, completion blocker, second narrowing): the
        // prior-bytes snapshot used to be read HERE, before calling
        // `publish()` — outside the per-uri write lock `publish()` itself
        // acquires. A concurrent writer already holding that lock could land
        // newer bytes between this read and `publish()` actually acquiring
        // it, so the snapshot captured the wrong "prior" state to restore.
        // `onBeforeWrite` reports the exact prior content from INSIDE
        // `publish()`'s own lock hold, atomically with the write it precedes
        // — see that option's own doc comment on `PlanPromotion`. It is
        // never called at all when `publish()` finds nothing to do (artifact
        // already canonical, not a revision), which is exactly when no
        // rollback is ever needed — so `published` tracks that call, not
        // `publish()`'s return.
        //
        // Review fix (2026-09-23, architectural blocker, second narrowing):
        // `published` is now set to `true` DIRECTLY inside `onBeforeWrite`
        // below — the moment we know a write inside the lock is about to be
        // attempted — rather than from a local `capturedInsideLock` flag
        // copied across to `published` only AFTER `await publish(...)`
        // resolves. That old shape had a real fail-open gap: `writeAtomic`
        // (`implementationArtifactResolver.ts` -> `writeAtomic.ts`) can THROW
        // after its rename has already replaced the durable file on disk
        // (`durableTargetUnchanged: false`, from the post-rename readback
        // validation at the end of `writeAtomic`) — a failure that surfaces
        // here as `publish()` REJECTING, never returning normally. The
        // `published = capturedInsideLock` assignment sat textually AFTER the
        // `await publish(...)` call, so that exact rejection skipped it
        // entirely and `published` stayed at its initial `false`.
        // `onCommitFailure`'s `if (published)` guard then skipped the
        // byte-guarded rollback while the journal was still deleted (the
        // journal cleanup below `onCommitFailure` runs unconditionally),
        // leaving the newly-written `plan-final.md` bytes on disk with no
        // recovery journal at all — exactly the "fails open" shape the
        // commit protocol forbids. Setting `published` eagerly, inside the
        // callback, means it is already `true` by the time any later step —
        // `onBeforeArtifactWrite`'s journal write, or `writeAtomic` itself,
        // at any point during or after its rename — can fail.
        //
        // Part 2 (item 15 hardening) — FAIL-CLOSED stage-entry journal
        // ownership (review fix, 2026-09-23, architectural blocker: a caught
        // begin/phase-write failure used to be logged and swallowed here,
        // letting the real artifact publish proceed with no journal at all —
        // exactly the "fails open" shape the plan's commit protocol forbids).
        // None of the three journal calls below are wrapped in a try/catch
        // that swallows: a failure at ANY of them — an un-recovered journal
        // from a prior crash already on disk (`StageEntryRecoveryPendingErrorV1`
        // / `StageEntryJournalUnreadableErrorV1` from `beginStageEntryJournalV1`),
        // or a plain I/O failure writing any phase — propagates out of this
        // closure, aborts `patchTaskProgressStrictV1`'s write, and reaches
        // `onCommitFailure` below in the SAME queued critical section as
        // today's already-verified rollback. `onCommitFailure` runs the
        // existing byte-guarded artifact rollback whenever `published` is
        // true (a "publishing"/"published" write failure, OR a post-rename
        // validation failure inside `writeAtomic` itself, all land here, since
        // `onBeforeWrite` always runs BEFORE any of them and sets `published`
        // synchronously), and always attempts the journal cleanup that
        // closure already performs by `journalTransitionId`. A begin failure
        // (thrown before `publish()` is ever called) leaves `published` false
        // and `journalTransitionId` unset, so nothing this transition did
        // needs undoing — only the STALE journal it collided with does, which
        // `enterStageV1`'s outer wrapper below recovers and retries once,
        // exactly as this file's commit-protocol doc comment specifies.
        // Review fix (2026-09-23, completion blocker, third narrowing):
        // `priorArtifact` used to be hashed HERE, by reading `canonicalUri`
        // directly — before `publish()` is even called, and therefore before
        // `preparePlanPromotion`'s own per-uri `withPlanFileWriteLockV1` hold
        // is acquired (`implementationArtifactResolver.ts`, `publish`'s
        // `onBeforeWrite` doc comment warns against exactly this: "reading
        // beforehand can race a concurrent writer that lands new bytes
        // between that read and this lock actually being acquired"). A
        // legitimate writer landing between that read and the lock would
        // mean the journal recorded the WRONG "prior" hash — proof against
        // bytes that were never actually on disk when this transition
        // overwrote them, so a later rollback could neither restore the true
        // prior content (its hash would not match) nor recognize its own
        // write as landed, and would fall through to "leave it as-is",
        // silently discarding the wrongly-overwritten writer's content with
        // no recovery path.
        //
        // `"absent"` here is a placeholder, not a guess: `rollbackJournaledArtifactV1`
        // never reads `priorArtifact` while `phase === "intent"` (it returns
        // `"left-untouched-no-write-attempted"` before touching the field at
        // all — see that function's own first branch), and this placeholder
        // is unconditionally overwritten below, from INSIDE the lock, before
        // the journal ever advances past `"intent"`.
        const journalBase: Omit<StageEntryJournalV1, "phase"> = {
          transitionId: crypto.randomUUID(),
          from: sourceStage,
          to: destinationStage,
          startedAt: new Date().toISOString(),
          artifact: "plan-final.md",
          priorArtifact: "absent",
        };
        await beginStageEntryJournalV1(taskFolderUri, journalBase);
        journalTransitionId = journalBase.transitionId;
        let journal: StageEntryJournalV1 = { ...journalBase, phase: "intent" };
        // Captured synchronously inside `onBeforeWrite`, called from INSIDE
        // `publish()`'s own per-uri lock hold, immediately before the write
        // it precedes — the one point at which "what's on disk right now"
        // and "what this write is about to replace" are guaranteed to be the
        // same thing (see that callback's own doc comment). Always set by
        // the time `onBeforeArtifactWrite` (the very next thing `publish()`
        // calls, still inside the same lock) reads it, since `onBeforeWrite`
        // is always supplied here.
        let capturedPriorArtifact: StageEntryJournalV1["priorArtifact"] | undefined;

        deferredPlanRevisionAdoption = await publish({
          deferAdoptionWrite: true,
          onBeforeWrite: (priorBytes) => {
            // Set eagerly — see the comment above this block for why this
            // must not wait for `publish()` to resolve. `onCommitFailure`'s
            // rollback still re-reads and re-verifies from disk via the
            // journal's own `expectedSha256`/`priorArtifact` rather than
            // trusting this in-memory snapshot directly — `priorBytes` is
            // used only to compute the HASH recorded below, which rollback
            // then re-proves against whatever is actually on disk.
            published = true;
            capturedPriorArtifact = priorBytes !== undefined ? { sha256: sha256HexV1(priorBytes) } : "absent";
          },
          onBeforeArtifactWrite: async (sha256) => {
            journal = {
              ...journal,
              phase: "publishing",
              expectedSha256: sha256,
              // Correct the "intent"-phase placeholder with the race-free
              // value captured above — still inside the same lock hold, so
              // this is the first journal write that can ever be trusted for
              // rollback (see `rollbackJournaledArtifactV1`, which only reads
              // `priorArtifact` at `"publishing"`/`"published"`).
              priorArtifact: capturedPriorArtifact ?? journal.priorArtifact,
            };
            await writeStageEntryJournalV1(taskFolderUri, journal);
          },
        });

        // Only advance to `"published"` when the write actually happened —
        // `publish()` finding the canonical artifact already present (a race
        // with some other legitimate writer between `prepareStageEntryV1` and
        // this closure running) never calls `onBeforeWrite`/`onBeforeArtifactWrite`
        // at all and returns normally, leaving `published` at its initial
        // `false`, and the journal is deliberately left at `"intent"` in that
        // case (see this module's doc comment: "the stage may still commit
        // legitimately"). Phase C cleanup (`runStageEntryPostCommitV1`)
        // deletes it either way once the transition commits.
        if (published) {
          journal = { ...journal, phase: "published", deferredAdoption: deferredPlanRevisionAdoption };
          await writeStageEntryJournalV1(taskFolderUri, journal);
        }
      }
    : undefined;

  // Review fix (2026-09-22, completion blocker, second narrowing): rollback
  // must run BEFORE `queueTransition` (inside `advanceStage`) releases this
  // task's in-process transition queue to a waiting successor — a rollback
  // performed here, after `advanceStage` has already rejected, races a
  // queued successor that the release already let proceed, which could then
  // have its own freshly-published artifact overwritten or deleted by this
  // rollback. `advanceStage`'s `onCommitFailure` runs this INSIDE that same
  // queued critical section instead. A recovery failure is folded into the
  // surfaced reason rather than only logged, so it is never silently
  // swallowed.
  const onCommitFailure = async (error: unknown): Promise<Error> => {
    const originalMessage = error instanceof Error ? error.message : String(error);
    // Part 2 (item 15 hardening) — "In-process failure now uses the same
    // code" (plan text, verbatim): a live write failure and a host death now
    // resolve through the exact same function, `recoverStageEntryJournalV1`'s
    // Phase A. It re-reads THIS transition's own just-written journal (its
    // `to` cannot equal the re-read `currentStage`, since the write that
    // would have made that true is the one that just failed, so Phase A
    // always classifies it as "not committed"), proves or disproves that
    // whatever is on `canonicalUri` right now is provably this transition's
    // bytes via `expectedSha256`/`priorArtifact` — the SAME proof-before-
    // touching-file check a crash recovery performs — rolls back only when
    // proven, and deletes the journal either way. There is no longer a
    // separate in-process-only rollback keyed on bytes captured in this
    // closure's own scope.
    //
    // Guarded on `journalTransitionId` (this transition's own journal
    // actually began), not `published`: an "intent"-phase journal — `publish()`
    // never reached a write at all — still needs its own cleanup, which
    // `recoverStageEntryJournalV1` also performs (leaving the artifact
    // untouched, since nothing was written).
    //
    // By this point `patchTaskProgressStrictV1`'s own `withTaskLock` hold has
    // already released (it releases before its rejection propagates here), so
    // `recoverStageEntryJournalV1` acquiring it again is not reentrant — the
    // same pattern this closure already relied on for its own journal
    // cleanup. A recovery failure is folded into the surfaced reason rather
    // than only logged, so it is never silently swallowed.
    if (journalTransitionId !== undefined) {
      try {
        await recoverStageEntryJournalV1(taskFolderUri);
      } catch (recoveryError) {
        const recoveryMessage =
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        return new Error(
          `${originalMessage} (additionally, restoring plan-final.md after this failure also ` +
            `failed: ${recoveryMessage} — the file may be left in an inconsistent state and should ` +
            "be checked by hand)"
        );
      }
    }
    return error instanceof Error ? error : new Error(originalMessage);
  };

  let transition: StageTransitionResult | undefined;
  try {
    transition = await advanceStage(
      taskFolderUri,
      sourceStage,
      destinationStage,
      isPaused,
      kind,
      options.optIn ?? true,
      options.expectedReviewAttemptId,
      publishArtifact,
      options.transform,
      options.precondition,
      onCommitFailure,
      options.deps?.patchTaskProgress
    );
  } catch (error) {
    // Recovery (if any) already ran inside `onCommitFailure`, before the
    // in-process transition queue was released — see that closure and
    // `advanceStage`'s `onCommitFailure` parameter. `cause` preserves the
    // original error's type (e.g. `LifecyclePolicyFailureError`,
    // `LifecycleStageMismatchError`) for a caller that needs it back — see
    // `StageEntryResultV1`'s doc comment.
    return { ready: false, reason: error instanceof Error ? error.message : String(error), cause: error };
  }

  if (!transition?.persisted) {
    // Part 2 (item 15 hardening): `publishArtifact` (and any journal it began)
    // already ran as `beforeWrite`, ahead of `patchTaskProgressStrictV1`'s own
    // no-op check — see that function's `operation()` body. A journal begun
    // for a transition that then turns out not to have persisted has nothing
    // left to describe; clean it up the same way `onCommitFailure` does for a
    // thrown rejection, best-effort.
    if (journalTransitionId !== undefined) {
      try {
        await withTaskLock(taskFolderUri.fsPath, () =>
          deleteStageEntryJournalV1(taskFolderUri, journalTransitionId as string)
        );
      } catch (journalError) {
        console.error(
          "enterStageV1: could not clean up the stage-entry journal after a non-persisted transition",
          journalError
        );
      }
    }
    return { ready: false, reason: "could not read or update task progress" };
  }

  return {
    ready: true,
    transition,
    deferredPlanRevisionAdoption,
    postCommit: options.postCommit,
    journalTransitionId,
  };
}

/**
 * Post-commit work for a successful {@link enterStageV1} transition — run
 * only after the caller's own lock hold (if any) around `enterStageV1` has
 * released, since applying a deferred plan-revision adoption write acquires
 * the task lock itself (see `applyDeferredPlanRevisionAdoptionV1`'s doc
 * comment).
 *
 * Calls `applyDeferredPlanRevisionAdoptionV1`, which itself performs BOTH the
 * `applyReviewerVerifiedTicks` card withdrawal and the durable adoption write
 * for a plan revision's re-finalization — see that function's own doc
 * comment for why the withdrawal was moved out of `publish()`'s synchronous
 * path (review fix, 2026-09-22, completion blocker). Every production caller
 * of `preparePlanPromotion`'s `deferAdoptionWrite: true` path passes through
 * either this function or its own equivalent post-commit call, so the
 * withdrawal only ever runs after a commit has actually landed.
 *
 * After the deferred plan-revision adoption (if any), runs the caller's own
 * `postCommit` follow-up (if any) — see `enterStageV1`'s `options.postCommit`
 * and `StageEntryResultV1.postCommit`'s doc comments. Both run unconditionally
 * on every successful transition this is called for; a no-op result (neither
 * field set) is safe to call this with.
 *
 * Finally (Part 2, item 15 hardening, Phase C): re-reads the stage-entry
 * journal under a fresh `withTaskLock` hold and deletes it ONLY if its
 * on-disk `transitionId` still equals `result.journalTransitionId` — the
 * "deleted only by a caller that just read the same transition" ownership
 * rule (`deleteStageEntryJournalV1`'s own doc comment). Run last, after the
 * deferred adoption and the caller's `postCommit` have both had a chance to
 * run, so a failure in either of those does not leave the journal deleted
 * for work that never actually happened. Best-effort: a cleanup failure here
 * is logged, not thrown — the transition itself already committed
 * successfully by the time this runs.
 *
 * Takes {@link StageEntryPostCommitPayloadV1} rather than the full
 * `StageEntryResultV1` union — deliberately, so `stageEntryJournalV1.ts`'s
 * crash-recovery path (`recoverAndReplayCommittedJournalV1`, Phase B/C for a
 * journal Phase A found `"committed"`) can build one of these straight from
 * what the journal persisted to disk and call this SAME function, rather
 * than re-implementing "apply the deferred adoption, then clean up the
 * journal" a second time. A caller that already has a `{ ready: true, ... }`
 * `StageEntryResultV1` (every production caller in this file's own module)
 * passes it straight through — structurally assignable, since it carries
 * every field this type needs plus `transition`/`ready`, which this function
 * never reads.
 */
export async function runStageEntryPostCommitV1(
  taskFolderUri: vscode.Uri,
  result: StageEntryPostCommitPayloadV1
): Promise<void> {
  if (result.deferredPlanRevisionAdoption) {
    await applyDeferredPlanRevisionAdoptionV1(taskFolderUri, result.deferredPlanRevisionAdoption);
  }
  await result.postCommit?.();
  if (result.journalTransitionId !== undefined) {
    try {
      await withTaskLock(taskFolderUri.fsPath, () =>
        deleteStageEntryJournalV1(taskFolderUri, result.journalTransitionId as string)
      );
    } catch (journalError) {
      console.error(
        "runStageEntryPostCommitV1: could not clean up the stage-entry journal (Phase C) after a committed transition",
        journalError
      );
    }
  }
}
