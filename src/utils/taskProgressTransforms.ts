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
  BlockerSupersessionRecordV1,
  ChecklistChangeProposalV1,
  ImplementationTypeCheckFailure,
  MAX_BLOCKER_SUPERSESSIONS,
  MAX_CHECKLIST_CHANGE_PROPOSALS,
  MAX_OVERRIDDEN_ESCALATIONS,
  MAX_REVIEW_REJECTIONS,
  MAX_REVIEW_SCORE_HISTORY,
  MAX_ROUND_LEDGER_ENTRIES,
  MAX_ROUND_OUTCOMES,
  QuotaParkRecordV1,
  ReviewRejectionEntry,
  ReviewScoreHistoryEntry,
  RoundLedgerEntryV1,
  RoundOutcomeEntryV1,
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
 * Append one blocker-supersession record (wf10 item 19, see
 * `TaskProgress.blockerSupersessions`'s doc comment) — the durable trail a
 * stage gate consults so a blocker a human resolved via stage chat stops
 * reading as outstanding without requiring a fresh review round. Same
 * append-and-cap shape as `appendReviewRejection`.
 */
export function appendBlockerSupersession(
  progress: TaskProgress,
  entry: BlockerSupersessionRecordV1
): TaskProgress {
  const supersessions = [...(progress.blockerSupersessions ?? []), entry];
  const trimmed = supersessions.length > MAX_BLOCKER_SUPERSESSIONS
    ? supersessions.slice(supersessions.length - MAX_BLOCKER_SUPERSESSIONS)
    : supersessions;
  return {
    ...progress,
    blockerSupersessions: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Append one checklist-mutation record (wf "make the stage chat a record of
 * work" Part 6 / item 5, see `TaskProgress.checklistChangeProposals`'s doc
 * comment) — the durable trace of a round whose direct edit to
 * `plan-final.md`'s item list was caught and reverted. Same append-and-cap
 * shape as `appendReviewRejection`/`appendBlockerSupersession`.
 */
export function appendChecklistChangeProposal(
  progress: TaskProgress,
  entry: ChecklistChangeProposalV1
): TaskProgress {
  const proposals = [...(progress.checklistChangeProposals ?? []), entry];
  // A `"pending"`/`"revising"` proposal names a round-ledger row that
  // `upsertRoundLedgerEntryV1` is itself keeping alive on the strength of
  // THIS entry still existing (2026-08-28 review fix, completion blocker:
  // "`appendChecklistChangeProposal` still evicts oldest proposals without
  // protecting an active revision" — the round-ledger side of this same
  // protection was fixed first, but evicting the proposal record itself
  // just relocates the gap one level up). Mirror that same "protect the
  // live one, drop terminal ones oldest-first" rule here: a proposal only
  // ages out once it has resolved (`"discarded"`/`"adopted"`). If every
  // entry over cap is still open (pathological — normally at most one
  // revision is in flight on a task at a time) the array is left over cap
  // rather than discarding an unresolved proposal out from under its own
  // revision.
  let trimmed = proposals;
  while (trimmed.length > MAX_CHECKLIST_CHANGE_PROPOSALS) {
    const dropIndex = trimmed.findIndex((p) => p.status === "discarded" || p.status === "adopted");
    if (dropIndex === -1) {
      break;
    }
    trimmed = [...trimmed.slice(0, dropIndex), ...trimmed.slice(dropIndex + 1)];
  }
  return {
    ...progress,
    checklistChangeProposals: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Flip one `"pending"` `checklistChangeProposals` entry to `"discarded"` (wf
 * "make the stage chat a record of work" Part 6 / item 19's "Discard the
 * proposal" option). Matches `applyPlanRevisionPolicyV1`'s own
 * `markProposalRevising` in requiring an exact `at` + `"pending"` match and
 * never inventing/removing an entry — returns `progress` unchanged when no
 * such entry exists, so a caller can treat that as "already resolved" rather
 * than throwing on a race with a concurrent decision answer.
 */
export function markChecklistChangeProposalDiscardedV1(
  progress: TaskProgress,
  proposalAt: string
): TaskProgress {
  const proposals = progress.checklistChangeProposals;
  if (proposals === undefined) {
    return progress;
  }
  const matched = proposals.some((p) => p.at === proposalAt && p.status === "pending");
  if (!matched) {
    return progress;
  }
  return {
    ...progress,
    checklistChangeProposals: proposals.map((p) =>
      p.at === proposalAt && p.status === "pending" ? { ...p, status: "discarded" as const } : p
    ),
    updatedAt: new Date().toISOString(),
  };
}

/** Optional durable resolution facts recorded onto a `checklistChangeProposals`
 * entry the moment it is marked `"adopted"` — see
 * `ChecklistChangeProposalV1.resolvedAt`/`itemCountBefore`/`itemCountAfter`'s
 * doc comments (2026-08-28 review fix, Part 6 completion blocker: "records
 * the completion in chat rather than the round ledger"). */
export interface ChecklistChangeProposalResolutionV1 {
  readonly resolvedAt: string;
  readonly itemCountBefore?: number;
  readonly itemCountAfter?: number;
}

/**
 * Re-finalization transform (wf "make the stage chat a record of work" Part
 * 6 / item 7): flip a `"revising"` `checklistChangeProposals` entry to
 * `"adopted"` and clear `TaskProgress.planRevision`, in the same patch that
 * publishes the revised `plan-final.md` (`preparePlanPromotion`'s plan-
 * revision branch). Matches the other two proposal-status transforms' "no
 * match, no-op" contract rather than throwing — the promotion path already
 * treats "no in-flight revision" as nothing to adopt. `resolution`, when
 * supplied, is stamped onto the SAME entry in the SAME transaction, making
 * the item-count change a durable fact in `task-progress.json` rather than
 * something only ever narrated in chat prose.
 *
 * Also annotates the mutating round's `roundLedger` row (via the proposal's
 * own `roundId`) with `checklistRevisionAdopted`, in this SAME pure
 * transform rather than a separate best-effort `patchTaskProgressStrictV1`
 * call (2026-08-28 review fix, completion blocker: "the separate best-effort
 * write may fail or no-op after the originating row is pruned — adoption may
 * be marked durable on the proposal while the required ledger record remains
 * absent"). Being folded into the caller's own single transaction makes the
 * two facts atomic — there is no longer a window in which one can land
 * without the other because of an independent I/O failure. The one case
 * that remains structurally impossible — the row has already been evicted by
 * `roundLedger`'s own 200-row cap — is recorded as an observable
 * `ledgerAnnotated: false` on the durable proposal record instead of being a
 * silently swallowed no-op, matching `promptCaptureComplete`'s "declare the
 * gap rather than overclaim" precedent elsewhere in this codebase. Never
 * reassigns an already-set `checklistRevisionAdopted` (same "attached once"
 * contract every other post-hoc round-ledger enrichment in this codebase
 * follows) — a proposal already carrying `ledgerAnnotated: true` from an
 * earlier call is left alone.
 */
export function markChecklistChangeProposalAdoptedV1(
  progress: TaskProgress,
  proposalAt: string,
  resolution?: ChecklistChangeProposalResolutionV1
): TaskProgress {
  const proposals = progress.checklistChangeProposals;
  const target = proposals?.find((p) => p.at === proposalAt && p.status === "revising");
  if (!target) {
    return progress;
  }
  const existingRow = resolveRoundV1(progress, target.roundId);
  const annotation = resolution?.resolvedAt === undefined
    ? undefined
    : {
        resolvedAt: resolution.resolvedAt,
        ...(resolution.itemCountBefore !== undefined ? { itemCountBefore: resolution.itemCountBefore } : {}),
        ...(resolution.itemCountAfter !== undefined ? { itemCountAfter: resolution.itemCountAfter } : {}),
      };
  // The proposal itself is the durable evidence needed to reconstruct an
  // evicted source row. Do that before flipping its status to adopted, while
  // `upsertRoundLedgerEntryV1` still sees this proposal as revising and
  // therefore protects the reconstructed terminal row from its normal cap.
  // A plan revision is not complete unless this ledger event exists.
  const row = existingRow ?? {
    roundId: target.roundId,
    attemptIds: [],
    stage: target.stage,
    mode: "implementation" as const,
    startedAt: target.at,
    endedAt: resolution?.resolvedAt ?? new Date().toISOString(),
    state: "rejected" as const,
    outcome: { rejectionReason: "checklist mutation reverted" },
  };
  let next = annotation !== undefined && row.checklistRevisionAdopted === undefined
    ? upsertRoundLedgerEntryV1(progress, { ...row, checklistRevisionAdopted: annotation })
    : progress;
  next = {
    ...next,
    checklistChangeProposals: proposals!.map((p) =>
      p.at === proposalAt && p.status === "revising"
        ? {
            ...p,
            status: "adopted" as const,
            ...(resolution?.resolvedAt !== undefined ? { resolvedAt: resolution.resolvedAt } : {}),
            ...(resolution?.itemCountBefore !== undefined
              ? { itemCountBefore: resolution.itemCountBefore }
              : {}),
            ...(resolution?.itemCountAfter !== undefined
              ? { itemCountAfter: resolution.itemCountAfter }
              : {}),
            ledgerAnnotated: true,
          }
        : p
    ),
    planRevision: undefined,
    updatedAt: new Date().toISOString(),
  };
  return next;
}

/**
 * Append one round-outcome classification (wf10 item 4 / Part 4, see
 * `TaskProgress.roundOutcomes`) to the durable trail. Trims from the front
 * once the cap is exceeded — same shape as `appendReviewRejection` and
 * `appendReviewScoreHistory`, which this sits beside in every call site that
 * records round-completion accounting.
 */
export function appendRoundOutcome(
  progress: TaskProgress,
  entry: RoundOutcomeEntryV1
): TaskProgress {
  const outcomes = [...(progress.roundOutcomes ?? []), entry];
  const trimmed = outcomes.length > MAX_ROUND_OUTCOMES
    ? outcomes.slice(outcomes.length - MAX_ROUND_OUTCOMES)
    : outcomes;
  return {
    ...progress,
    roundOutcomes: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Look up one `TaskProgress.roundLedger` row by ANY identity it carries —
 * its own `roundId`, the scheduling `intentId` that announced it, the
 * coordinator `operationId` that ran it, or any one of its `attemptIds`
 * (the initial attempt, an item-14 retry, a fallback candidate, or a
 * transport retry). This is what lets `ImplRecoveryV1.sourceAttemptId` and
 * `RoundOutcomeEntryV1.attemptId` both resolve to the same row without
 * either caller needing to know which identity it originally had in hand.
 * Pure; callers needing the row's INDEX (to replace it) use
 * `upsertRoundLedgerEntryV1` instead.
 */
export function resolveRoundV1(
  progress: TaskProgress,
  id: string
): RoundLedgerEntryV1 | undefined {
  return (progress.roundLedger ?? []).find(
    (entry) =>
      entry.roundId === id ||
      entry.intentId === id ||
      entry.operationId === id ||
      entry.attemptIds.includes(id)
  );
}

/**
 * Drift check (wf "make the stage chat a record of work" Part 4 step 46):
 * every `TaskProgress.roundOutcomes` classification entry that carries an
 * `attemptId` must resolve to a `roundLedger` row via that same id — a
 * classification recorded against an identity with no corresponding
 * lifecycle row is exactly the "two stores disagreeing about the same
 * round" defect Part 4 exists to close (mirrors item 12's "one quarantine
 * decision, computed once and consumed everywhere" rule, applied to round
 * identity instead of blocker quarantine).
 *
 * An entry with no `attemptId` is skipped, not flagged: a handful of older
 * call sites (the fallback circuit breaker's own bookkeeping paths predating
 * this drift check) still omit it. Every implementation-round completion
 * accounting site (`reviewActions.ts`'s gate/zero-change/edits-produced/
 * no-edits/cancelled terminalizations) and every review-round site now stamp
 * `attemptId: implRoundId`/the coordinator attempt, so an omission there
 * would be a regression this check exists to catch, not an expected gap.
 */
export function findRoundOutcomesMissingLedgerRowV1(
  progress: TaskProgress
): readonly RoundOutcomeEntryV1[] {
  return (progress.roundOutcomes ?? []).filter(
    (entry) => entry.attemptId !== undefined && !resolveRoundV1(progress, entry.attemptId)
  );
}

/**
 * Insert or replace one `TaskProgress.roundLedger` row, matched by
 * `roundId` — the identity that never changes once a row is created (see
 * `RoundLedgerEntryV1.roundId`'s doc comment). Capped at
 * `MAX_ROUND_LEDGER_ENTRIES`: when over cap, the OLDEST rows already in a
 * terminal state are dropped first, front to back, before ever considering
 * dropping a `"scheduled"`/`"open"` row — a live round's own record must
 * never be silently evicted out from under it. If every row is still live
 * (pathological — the reconciliation sweep exists precisely so this does
 * not happen in practice), the array is left over cap rather than dropping
 * a live round's record.
 *
 * A terminal row is ALSO protected from this drop while it is the
 * `roundId` named by a `checklistChangeProposals` entry still `"pending"` or
 * `"revising"` (2026-08-28 review fix, completion blocker: a plan revision
 * can take many rounds — through plan, both plan reviews, implementation and
 * both impl reviews — before `markChecklistChangeProposalAdoptedV1` runs; if
 * the mutating round's own row were evicted by ordinary FIFO pressure during
 * that window, adoption could never annotate it). Once a proposal resolves
 * (`"discarded"`/`"adopted"`) its row loses this protection and ages out
 * normally, same as any other terminal row.
 */
export function upsertRoundLedgerEntryV1(
  progress: TaskProgress,
  entry: RoundLedgerEntryV1
): TaskProgress {
  const existing = progress.roundLedger ?? [];
  const index = existing.findIndex((row) => row.roundId === entry.roundId);
  const next = index === -1
    ? [...existing, entry]
    : existing.map((row, i) => (i === index ? entry : row));
  const protectedRoundIds = new Set(
    (progress.checklistChangeProposals ?? [])
      .filter((p) => p.status === "pending" || p.status === "revising")
      .map((p) => p.roundId)
  );
  let trimmed = next;
  while (trimmed.length > MAX_ROUND_LEDGER_ENTRIES) {
    const dropIndex = trimmed.findIndex(
      (row) =>
        row.state !== "scheduled" &&
        row.state !== "open" &&
        !protectedRoundIds.has(row.roundId)
    );
    if (dropIndex === -1) {
      // Every remaining row is still live, or protected by a pending plan
      // revision — cannot drop any without losing a live round's record or
      // orphaning an in-flight revision; leave the array over cap rather
      // than do so.
      break;
    }
    trimmed = [...trimmed.slice(0, dropIndex), ...trimmed.slice(dropIndex + 1)];
  }
  return {
    ...progress,
    roundLedger: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Append one escalation Fast Forward rode through (Item 13,
 * `TaskProgress.overriddenEscalations`) to the durable override trail. Called
 * from inside the SAME `patchTaskProgressStrictV1` transaction that un-pauses
 * the task for the ride-through, so a crash between the two can never leave
 * the task active with the override unrecorded. Trims from the front once
 * the cap is exceeded.
 */
export function appendOverriddenEscalation(
  progress: TaskProgress,
  entry: TaskEscalation
): TaskProgress {
  const overridden = [...(progress.overriddenEscalations ?? []), entry];
  const trimmed =
    overridden.length > MAX_OVERRIDDEN_ESCALATIONS
      ? overridden.slice(overridden.length - MAX_OVERRIDDEN_ESCALATIONS)
      : overridden;
  return {
    ...progress,
    overriddenEscalations: trimmed,
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
