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
  MAX_REVIEW_SCORE_HISTORY,
  ReviewScoreHistoryEntry,
  TaskEscalation,
  TaskProgress,
  TaskStage,
  TaskStatus,
} from "../types/taskProgress";

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
  return {
    ...withoutEscalation,
    currentStage: newStage,
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
  const union = new Set([...files, ...existing]);
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
