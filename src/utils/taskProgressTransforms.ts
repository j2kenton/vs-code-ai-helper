/**
 * Pure in-memory TaskProgress transformers.
 *
 * Extracted verbatim from `utils/taskProgressUtils.ts` (plan §3.12): these
 * neither read nor write disk — they compose inside BOTH the legacy
 * permissive patch and the strict `patchTaskProgressStrictV1` callbacks —
 * so helper-only consumers must not have to import the permissive legacy
 * reader/writer module (and stay on its fence roster) just to build a
 * progress mutation. The legacy module's own doc already declared them
 * outside the reader/writer boundary ("the pure in-memory transformers ...
 * are not part of this boundary").
 */
import {
  ImplementationTypeCheckFailure,
  MAX_REVIEW_REJECTIONS,
  MAX_REVIEW_SCORE_HISTORY,
  QuotaParkRecordV1,
  ReviewRejectionEntry,
  ReviewScoreHistoryEntry,
  TaskEscalation,
  STAGE_ORDER,
  TaskProgress,
  TaskStage,
  TaskStatus,
} from "../types/taskProgress";
import { isMachineMaintainedArtifactPathV1 } from "./implReviewFileSelection";

/**
 * Update the task progress stage
 * @param progress - The existing progress object
 * @param newStage - The new stage to set
 * @returns Updated TaskProgress object
 */
export function updateTaskProgressStage(
  progress: TaskProgress,
  newStage: TaskStage
): TaskProgress {
  const fallbackActive = { ...progress.fallbackActive };
  const fallbackModelId = { ...progress.fallbackModelId };
  delete fallbackActive[newStage];
  delete fallbackModelId[newStage];
  // A stage transition always resolves whatever iteration was stuck on the
  // stage being left — an escalation recorded there would otherwise linger
  // and be shown against the new stage it has nothing to do with.
  const { escalation: _unused, ...withoutEscalation } = progress;

  // Moving BACKWARDS (Set Stage as Current, or any correction after a stage
  // advanced too early) must retract the stages being re-entered. Without
  // this the task claims currentStage: "impl-high-review" while
  // completedStages still lists "impl-high-review" AND "impl-low-review" —
  // a state that says a stage is simultaneously in progress and finished.
  // taskTreeProvider's getStageStatus now renders from the current stage's
  // position alone (so a stale list can no longer hide the current marker),
  // but anything else asking "has this stage been through?" would still get
  // the wrong answer for work that is about to be redone.
  //
  // taskProgressFieldPolicyV1's reopen path already retracts exactly this
  // way, but it is gated on `status === "completed"` — it only covers
  // reopening a FINISHED task, never rolling an active one back. That gap
  // was hit twice on 2026-08-07 and both times required hand-editing
  // task-progress.json.
  //
  // `implReviewFiles` is deliberately NOT retracted here, which is a real
  // divergence from that reopen path (its policy: "Preserve only when its
  // owner stage (impl) is strictly before selected stage; otherwise []").
  // The two transitions want different things. Reopen restarts a FINISHED
  // task, so the previous cycle's changed-file list is history and clearing
  // it is right. An active rollback is a mid-flight correction — typically
  // "go back to impl and build more" — and that list is the accumulated
  // review scope for everything the task has built so far. Clearing it would
  // leave the next review seeing only whatever the following round happens to
  // touch, which is exactly the blindness that stalled the workflow task on
  // 2026-08-07 (a reviewer given 9 of 85 files could not source-verify ~18 of
  // 25 plan items, and raised a blocker no implementation round could clear).
  // Accumulating across rounds is the fix that unblocked it; a rollback must
  // not throw that away.
  const newIndex = STAGE_ORDER.indexOf(newStage);
  const currentIndex = STAGE_ORDER.indexOf(progress.currentStage);
  const movingBackwards = newIndex >= 0 && currentIndex >= 0 && newIndex < currentIndex;
  // `progress.completedStages !== undefined` keeps an absent field absent:
  // filtering `?? []` would materialize an empty array on a task that never
  // recorded one, adding a field the decoder then has to carry around.
  const completedStages =
    movingBackwards && progress.completedStages !== undefined
      ? progress.completedStages.filter((stage) => {
          const index = STAGE_ORDER.indexOf(stage);
          // An unrecognized stage has no position to compare, so it is left
          // alone rather than silently dropped.
          return index < 0 || index < newIndex;
        })
      : progress.completedStages;

  return {
    ...withoutEscalation,
    currentStage: newStage,
    ...(completedStages !== undefined ? { completedStages } : {}),
    fallbackActive: Object.keys(fallbackActive).length > 0
      ? fallbackActive
      : undefined,
    fallbackModelId: Object.keys(fallbackModelId).length > 0
      ? fallbackModelId
      : undefined,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update task status (active/paused).
 *
 * `preserveFreshness` keeps `updatedAt` untouched for status flips that are
 * pure focus/selection bookkeeping rather than task progress — activating a
 * task (and pausing the others as a side effect of that activation) must not
 * bump its recency, because the task list orders unpinned tasks by
 * `updatedAt` and a bump would hoist whichever task was merely selected to
 * the top as if it were pinned. Real lifecycle writes (explicit pause,
 * escalation pause, reopen) keep the default bump.
 */
export function updateTaskStatus(
  progress: TaskProgress,
  status: TaskStatus,
  options?: { preserveFreshness?: boolean }
): TaskProgress {
  return {
    ...progress,
    status,
    // A workflow-imposed pause reason describes the CURRENT paused state
    // only — any transition away from paused (resume, completion, archive)
    // retires it, or a long-resolved "no provider available" banner would
    // reappear on the next unrelated pause.
    ...(status !== "paused" && progress.pausedReason !== undefined
      ? { pausedReason: undefined }
      : {}),
    // Unlike pausedReason, quotaParkRecord is a durable PREDICTION about
    // when a model/provider becomes usable again, not a description of the
    // current paused state — resuming the task (paused -> active) is not by
    // itself fresh evidence the block resolved, so it must survive the
    // transition. It is only retired by explicit fresh evidence: a
    // contradicting/successful run (clearQuotaParkV1, called from
    // runnerRegistry.ts after a same-stage retry) or a later, unrelated
    // pause overwriting/clearing it (pauseTaskWithReason).
    updatedAt: options?.preserveFreshness
      ? progress.updatedAt
      : new Date().toISOString(),
  };
}

/**
 * Pause a task because the WORKFLOW cannot proceed (not a user request),
 * recording why — e.g. an exhausted provider chain (2026-08-13 finding 4).
 * `updatedAt` is bumped by `updateTaskStatus`'s default lifecycle behavior,
 * so the task stops looking "active as of the last successful round" while
 * it is actually stalled.
 */
export function pauseTaskWithReason(
  progress: TaskProgress,
  reason: string,
  quotaParkRecord?: QuotaParkRecordV1
): TaskProgress {
  return {
    ...updateTaskStatus(progress, "paused"),
    pausedReason: reason,
    // This pause's own record replaces any prior one; a pause with no
    // record of its own (this exhaustion wasn't quota/entitlement-shaped)
    // must not leave a stale record from an earlier, unrelated pause behind.
    ...(quotaParkRecord !== undefined ? { quotaParkRecord } : { quotaParkRecord: undefined }),
  };
}

/**
 * Record that a stage was blocked by a quota/model-entitlement failure,
 * without changing task status — the withheld-backup branch
 * (runnerRegistry.ts) blocks a single stage attempt but does not pause the
 * whole task, unlike `pauseTaskForExhaustedChainV1`'s fully-exhausted-chain
 * case (which threads the record through `pauseTaskWithReason` instead).
 */
export function recordQuotaParkV1(
  progress: TaskProgress,
  quotaParkRecord: QuotaParkRecordV1
): TaskProgress {
  return {
    ...progress,
    quotaParkRecord,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Identity of the run whose result is being offered as fresh evidence that a
 * `quotaParkRecord` block has resolved. Matched against the persisted
 * record's own `providerId`/`modelId`/`accountKey` before clearing.
 */
export interface QuotaParkClearingIdentityV1 {
  providerId: string;
  modelId: string;
  accountKey?: string;
}

/**
 * Clear a `quotaParkRecord` once a same-stage run has since completed
 * successfully — a resolved-park record left in place after the task moved
 * forward is a stale "blocked" reading (surfaced in the task tree tooltip)
 * for a block that no longer applies. `updatedAt` is deliberately NOT bumped:
 * this is bookkeeping cleanup riding on a successful run's own progress
 * write, not user-visible task progress in its own right.
 *
 * Review completion blocker: earlier this cleared on ANY fresh evidence
 * associated with the task folder, regardless of which model/provider
 * produced it — a contradicting result from a DIFFERENT model than the one
 * the record actually blocked proved nothing about whether that block
 * resolved. `identity`, when supplied, is matched against the persisted
 * record's own `providerId` and `modelId` (and `accountKey`, when both sides
 * have one) before clearing; a mismatch leaves the record untouched. Callers
 * that clear as a side effect of a stage/task transition (field-policy
 * builders) intentionally do not go through this function at all — the
 * record belongs to a specific stage attempt, and leaving that stage retires
 * it unconditionally regardless of model identity.
 */
export function clearQuotaParkV1(
  progress: TaskProgress,
  identity?: QuotaParkClearingIdentityV1
): TaskProgress {
  const record = progress.quotaParkRecord;
  if (record === undefined) {
    return progress;
  }
  if (identity !== undefined) {
    const matches =
      record.providerId === identity.providerId &&
      record.modelId === identity.modelId &&
      (record.accountKey === undefined ||
        identity.accountKey === undefined ||
        record.accountKey === identity.accountKey);
    if (!matches) {
      return progress;
    }
  }
  const { quotaParkRecord: _unused, ...rest } = progress;
  return rest;
}

/**
 * Clear the active fallback reservation for one stage without treating it as
 * user-visible task progress. This is internal routing state only, so callers
 * can persist the cleanup without bumping the task's freshness timestamp.
 */
export function clearStageFallbackReservation(
  progress: TaskProgress,
  stage: TaskStage
): TaskProgress {
  if (!progress.fallbackActive?.[stage] && !progress.fallbackModelId?.[stage]) {
    return progress;
  }

  const fallbackActive = { ...progress.fallbackActive };
  const fallbackModelId = { ...progress.fallbackModelId };
  delete fallbackActive[stage];
  delete fallbackModelId[stage];

  return {
    ...progress,
    fallbackActive: Object.keys(fallbackActive).length > 0
      ? fallbackActive
      : undefined,
    fallbackModelId: Object.keys(fallbackModelId).length > 0
      ? fallbackModelId
      : undefined,
  };
}

/**
 * Record the workspace-relative paths changed by an AI implementation run,
 * so implementation reviews can use them as the review scope instead of
 * relying on open editors.
 *
 * Unions `files` with any previously tracked set rather than replacing it.
 * A task can have several implementation runs in sequence (e.g. an initial
 * run followed by review-driven follow-up runs); a later run's before/after
 * git snapshot legitimately diffs to empty when it only re-confirms files an
 * earlier run already finalized. Overwriting the tracked set with that empty
 * diff would silently discard the earlier runs' files from the review scope.
 * Use `clearImplReviewFiles` for the one case where discarding the set is
 * actually intended: an explicit "start over" action, not a routine re-run.
 *
 * The union is ordered most-recently-changed first: the latest run's files
 * move to the front (re-touched files included), ahead of files only earlier
 * runs touched. The implementation-review context pack applies its total
 * size budget in this order (see applyContentCaps), so on long tasks whose
 * accumulated set exceeds the budget the omissions fall on the oldest —
 * already reviewed in earlier rounds — files, never on the current round's
 * work the reviewer has not seen yet.
 */
export function updateImplReviewFiles(
  progress: TaskProgress,
  files: string[]
): TaskProgress {
  const existing = progress.implReviewFiles ?? [];
  // Excludes generated workflow-safety inventories, lockfiles, and minified
  // bundles from ever entering review scope — the same classifier
  // contextPack.ts uses to keep their CONTENTS out of the review prompt (see
  // its own header). `files` here is typically a raw before/after git diff
  // (e.g. ImplementationRunResult.filesChanged), which has no way to know
  // these paths are machine-written side effects of a source edit rather
  // than reviewable work — filtering at the single place every caller
  // updates this field is what stops a future call site from reintroducing
  // the 2026-08-06 failure this exists to prevent.
  const reviewable = files.filter((file) => !isMachineMaintainedArtifactPathV1(file));
  const union = new Set([...reviewable, ...existing]);
  return {
    ...progress,
    implReviewFiles: [...union],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Quarantine the changed paths of an implementation round detected as
 * INCOMPLETE (deferred or cut short — see
 * `describeIncompleteImplementationRoundV1`): the delta goes durably into
 * `pendingImplReviewFiles`, never into `implReviewFiles` and never discarded.
 * A deferred round is not a completed round, so its edits must not be banked
 * as review scope — a reviewer would be handed files with no report to judge
 * them against — but they are real work that a later successful round must
 * carry into review (see `promotePendingImplReviewFiles`).
 *
 * Unions with any already-quarantined set (consecutive incomplete rounds
 * accumulate) and applies the same machine-maintained-path filter as
 * `updateImplReviewFiles`, for the same reason.
 */
export function quarantinePendingImplReviewFiles(
  progress: TaskProgress,
  files: string[]
): TaskProgress {
  const reviewable = files.filter((file) => !isMachineMaintainedArtifactPathV1(file));
  const union = new Set([...reviewable, ...(progress.pendingImplReviewFiles ?? [])]);
  if (union.size === 0) {
    return progress;
  }
  return {
    ...progress,
    pendingImplReviewFiles: [...union],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Promote the quarantined incomplete-round delta into review scope once a
 * subsequent implementation round completes successfully: the pending paths
 * are unioned into `implReviewFiles` (callers union the successful round's
 * own attributed delta separately, on top), and the pending set, the
 * continuation counter, and the owed `implRecovery` record are cleared —
 * all in the same transform, so the record can only ever clear in the same
 * transaction that finalizes the usable summary. Returns `progress`
 * unchanged when there is nothing to promote or clear.
 */
export function promotePendingImplReviewFiles(progress: TaskProgress): TaskProgress {
  const pending = progress.pendingImplReviewFiles ?? [];
  if (
    progress.pendingImplReviewFiles === undefined &&
    progress.incompleteRoundContinuations === undefined &&
    progress.implRecovery === undefined
  ) {
    return progress;
  }
  const {
    pendingImplReviewFiles: _pending,
    incompleteRoundContinuations: _continuations,
    implRecovery: _recovery,
    ...rest
  } = progress;
  if (pending.length === 0) {
    return { ...rest, updatedAt: new Date().toISOString() };
  }
  return updateImplReviewFiles(rest, pending);
}

/**
 * Record that an incomplete implementation round changed the tree after
 * `stage`'s review artifact was written, WITHOUT staling that artifact's
 * content — the marker is the durable "this review no longer describes the
 * workspace" record consumers must check (see
 * `TaskProgress.reviewInvalidatedByRound`).
 */
export function recordReviewInvalidatedByRound(
  progress: TaskProgress,
  stage: TaskStage
): TaskProgress {
  return {
    ...progress,
    reviewInvalidatedByRound: { stage, at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear the review-invalidation marker. Callers must persist replacement
 * review-tracking state FIRST (a stale stamp on the artifact, or a fresh
 * review round's publish record) — every persisted state must either carry
 * the marker or already show a fresh review is required.
 */
export function clearReviewInvalidatedByRound(progress: TaskProgress): TaskProgress {
  if (!progress.reviewInvalidatedByRound) {
    return progress;
  }
  const { reviewInvalidatedByRound: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Set (or clear, with `undefined`) the persisted incomplete-round
 * continuation counter (see `TaskProgress.incompleteRoundContinuations`).
 */
export function setIncompleteRoundContinuations(
  progress: TaskProgress,
  rounds: number | undefined
): TaskProgress {
  return {
    ...progress,
    incompleteRoundContinuations: rounds,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear any previously tracked changed-file set.
 */
export function clearImplReviewFiles(progress: TaskProgress): TaskProgress {
  const { implReviewFiles: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Persist a lint-state payload for a completed task.
 * Replaces any previously stored lint result.
 */
export function updateLintPayload(
  progress: TaskProgress,
  payload: import("../types/taskProgress").LintPayload
): TaskProgress {
  return {
    ...progress,
    lintPayload: payload,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Remove the persisted lint payload (e.g. when re-running lint after
 * code changes so the stale result is no longer shown as current).
 */
export function clearLintPayload(progress: TaskProgress): TaskProgress {
  const { lintPayload: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Append one round to the durable review-score trail (see
 * `TaskProgress.reviewScoreHistory`'s doc comment for why this must be
 * cross-invocation state rather than in-memory-only). Trims from the front
 * once the cap is exceeded so the file doesn't grow unbounded over a task's
 * lifetime.
 */
export function appendReviewScoreHistory(
  progress: TaskProgress,
  entry: ReviewScoreHistoryEntry
): TaskProgress {
  const history = [...(progress.reviewScoreHistory ?? []), entry];
  const trimmed = history.length > MAX_REVIEW_SCORE_HISTORY
    ? history.slice(history.length - MAX_REVIEW_SCORE_HISTORY)
    : history;
  return {
    ...progress,
    reviewScoreHistory: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Append one rejected (degenerate) review round to the durable rejection
 * trail (see `TaskProgress.reviewRejections`: these rounds are failed
 * attempts recorded WITH a reason, kept out of `reviewScoreHistory` so a
 * phantom scoreless round can never distort plateau detection). Trims from
 * the front once the cap is exceeded.
 */
export function appendReviewRejection(
  progress: TaskProgress,
  entry: ReviewRejectionEntry
): TaskProgress {
  const rejections = [...(progress.reviewRejections ?? []), entry];
  const trimmed = rejections.length > MAX_REVIEW_REJECTIONS
    ? rejections.slice(rejections.length - MAX_REVIEW_REJECTIONS)
    : rejections;
  return {
    ...progress,
    reviewRejections: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Set (or clear, with `undefined`) the durable consecutive zero-file-change
 * implementation-round counter (see `TaskProgress.zeroChangeImplRounds`'s
 * doc comment) — the persisted form of the no-progress breaker's input (2c).
 */
export function setZeroChangeImplRounds(
  progress: TaskProgress,
  rounds: number | undefined
): TaskProgress {
  return {
    ...progress,
    zeroChangeImplRounds: rounds,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Record that automated review iteration has given up and needs a human
 * decision. Does not itself change `status` — callers that want the
 * automation chain to actually stop must also set `status: "paused"` (see
 * `escalateReviewToHuman` in reviewEscalation.ts).
 */
export function recordEscalation(
  progress: TaskProgress,
  escalation: TaskEscalation
): TaskProgress {
  return {
    ...progress,
    escalation,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear a recorded escalation — e.g. once the user resumes the task or the
 * stage moves on. Stage transitions call this so a stale escalation reason
 * from a previous stage never lingers into the next one.
 *
 * `preserveFreshness` skips the `updatedAt` bump for callers where the clear
 * is a side effect of selecting/resuming a task rather than task progress
 * (see `updateTaskStatus` — same recency-ordering rationale).
 */
export function clearEscalation(
  progress: TaskProgress,
  options?: { preserveFreshness?: boolean }
): TaskProgress {
  if (!progress.escalation) {
    return progress;
  }
  const { escalation: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: options?.preserveFreshness
      ? progress.updatedAt
      : new Date().toISOString(),
  };
}

/**
 * Record that a post-implementation type-check (2g) failed on a round that
 * DID change files, so the caller can surface it immediately instead of
 * handing a non-compiling tree to a reviewer as if it were reviewable.
 */
export function recordImplementationTypeCheckFailure(
  progress: TaskProgress,
  failure: ImplementationTypeCheckFailure
): TaskProgress {
  return {
    ...progress,
    implementationTypeCheckFailure: failure,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear a recorded type-check failure once a later implementation round
 * completes with a passing (or skipped) type-check, so a stale failure from
 * an earlier round never lingers past the round that fixed it.
 */
export function clearImplementationTypeCheckFailure(progress: TaskProgress): TaskProgress {
  if (!progress.implementationTypeCheckFailure) {
    return progress;
  }
  const { implementationTypeCheckFailure: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}
