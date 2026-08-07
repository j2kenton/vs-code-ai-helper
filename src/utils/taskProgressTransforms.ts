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
  // The tree renders those stages as done (taskTreeProvider's getStageStatus
  // reads this list), and anything asking "has this stage been through?"
  // gets the wrong answer for work that is about to be redone.
  //
  // taskProgressFieldPolicyV1's reopen path already retracts exactly this
  // way, but it is gated on `status === "completed"` — it only covers
  // reopening a FINISHED task, never rolling an active one back. That gap
  // was hit twice on 2026-08-07 and both times required hand-editing
  // task-progress.json.
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
 * Update task status (active/paused)
 */
export function updateTaskStatus(
  progress: TaskProgress,
  status: TaskStatus
): TaskProgress {
  return {
    ...progress,
    status,
    updatedAt: new Date().toISOString(),
  };
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
 */
export function clearEscalation(progress: TaskProgress): TaskProgress {
  if (!progress.escalation) {
    return progress;
  }
  const { escalation: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
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
