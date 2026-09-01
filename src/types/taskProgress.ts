/**
 * Represents the different stages in the task workflow:
 * task description, plan drafting, plan reviews, implementation (merged
 * from old final-plan + implementation stages), and implementation reviews.
 */
export type TaskStage =
  | "desc"
  | "plan"
  | "plan-high-review"
  | "plan-low-review"
  | "impl"
  | "impl-high-review"
  | "impl-low-review"
  | "publish";

/** Lifecycle completion is separate from the terminal Publish stage. */
export type CanonicalTaskStage = TaskStage;

/**
 * Task status values.
 */
export type TaskStatus = "creating" | "active" | "paused" | "completed" | "archived";

/** Authoritative list of every persisted task status, in display order. */
export const TASK_STATUSES: readonly TaskStatus[] = ["creating", "active", "paused", "completed", "archived"];

/**
 * Statuses hidden from the task list unless the user explicitly filters them
 * in. Archived tasks are parked, not deleted — they stay reachable through
 * the status filter but never clutter the default view.
 */
export const DEFAULT_HIDDEN_STATUSES: readonly TaskStatus[] = ["archived"];

/** Maximum number of tasks that can be pinned at once. */
export const MAX_PINNED_TASKS = 10;

/**
 * The filename for the task request/scope artifact
 */
export const TASK_FILENAME = "task.md";
/** Optional free-text user input used to draft the structured task file. */
export const TASK_DESCRIPTION_FILENAME = "task-description.md";

/**
 * The filename for the current plan. There is exactly one plan file; applying
 * a review rewrites it in place rather than forking into "updated" copies.
 */
export const PLAN_FILENAME = "plan.md";

/**
 * The filename for the low-level plan artifact.
 */
export const LOW_LEVEL_PLAN_FILENAME = "plan-low.md";

/**
 * The filename for the implementation / final-plan artifact (merged stage).
 */
export const IMPLEMENTATION_FILENAME = "plan-final.md";

/**
 * The filename for the legacy implementation artifact (read/fallback only).
 */
export const LEGACY_IMPLEMENTATION_FILENAME = "implementation.md";

/**
 * The filename for an implementation RUN's summary.
 *
 * Deliberately separate from {@link IMPLEMENTATION_FILENAME}. plan-final.md is
 * the implementation plan of record — promoted from plan.md on entering the
 * stage, then refined into an `<!-- ensemble:implementation-checklist -->`
 * checklist — and it is read as durable state by completionLint's plan-item
 * verification and publishScopeCheck's path extraction. Writing a run's
 * free-text summary over it destroyed all of that (observed live 2026-08-10:
 * a 47-item checklist replaced by a three-line "tests still running" status
 * message, which silently emptied the Plan Item Verification section and left
 * both implementation reviewers reading that message as the implementation).
 * The two roles now own separate files: the plan of record is never
 * overwritten by a run, and the run summary has a home of its own.
 */
export const IMPLEMENTATION_SUMMARY_FILENAME = "impl-summary.md";

/**
 * The machine-written Publish report: Completion Checks (lint/type/test plus
 * plan-item verification) and the Scope Check.
 *
 * Split out of `publish-review.md` for the same reason `impl-summary.md` was
 * split out of `plan-final.md`, and after the same failure. Both sections were
 * upserted into the AI reviewer's artifact, so a file could hold one cycle's
 * verdict above another cycle's checks with nothing marking the seam. Observed
 * live 2026-08-11: publish-review.md opened with a stale `Readiness: 2/10` and
 * three blockers from the previous commit, while the Completion Checks section
 * a hundred lines below reported everything passing from the current one.
 * Re-running the checks could not fix it — they only ever rewrote the lower
 * half — and the command announced "Report saved" while opening the file whose
 * visible verdict was the old one.
 *
 * Nothing reads these sections back: the Publish reviewer receives
 * `{{verifiedChecks}}` and `{{planItemVerification}}` computed fresh as prompt
 * inputs, never by parsing this file. They are a report for the user, so they
 * belong in a document whose every line comes from the same run.
 */
export const PUBLISH_CHECKS_FILENAME = "publish-checks.md";

/**
 * The filename for the generated context pack artifact
 */
export const CONTEXT_PACK_FILENAME = "context-pack.md";

/**
 * The directory name for per-run agent logs
 */
export const RUNS_DIRNAME = "runs";

/**
 * Persisted lint-state payload for a completed task.
 * Used to gate completion-only actions (commit/push) on known lint state.
 */
export interface LintPayload {
  /** ISO timestamp when lint was last run */
  runAt: string;
  /** true = all lint checks passed, false = failures recorded */
  passed: boolean;
  /** Optional human-readable summary (e.g. "3 errors, 2 warnings") */
  summary?: string;
  /** Number of editor diagnostics plus failed checks. */
  issueCount?: number;
  /** Commands that failed, including their exit codes and output. */
  failedChecks?: Array<{
    command: string;
    exitCode: number;
    output: string;
    retryCount?: number;
    /** The known-flake quarantine decision for this failure, computed once
     * in `collectCompletionLint` (see completionLint.ts's `QuarantineStampV1`
     * and `isQuarantinedCheckV1`) and persisted verbatim so a re-read never
     * has to re-derive it. */
    quarantine?: { reason: string; ruleMatch: string };
  }>;
  /**
   * Where this payload came from. `"publish"` (the default when absent, for
   * backward compatibility) means a real Publish attempt ran the checks via
   * `runCompletionLint`. `"review"` means a Publish-stage review computed
   * this via `collectCompletionLintPreview` (allowScopePrompt: false) while
   * building its `{{verifiedChecks}}`/`{{planItemVerification}}` prompt
   * variables — real, ground-truth check results, but possibly against a
   * stale Publish scope compared to what an actual publish attempt would
   * resolve.
   */
  source?: "publish" | "review";
}

/**
 * Tracks the progress of a task through the planning workflow
 */
export interface TaskProgress {
  /** The task folder name (e.g., "2025-12-01_task_1") */
  taskFolder: string;
  /** User-facing task label. Folder names stay stable so task ordering/IDs do not change. */
  displayName?: string;
  /** True until the generated default label is replaced by a user or AI summary. */
  nameIsDefault?: boolean;
  /** Current stage in the workflow */
  currentStage: TaskStage;
  /** Task status: active or paused. Missing = active for backward compat. */
  status?: TaskStatus;
  /**
   * Set when the task is explicitly completed; stage advancement never sets
   * it. After a resume/reopen this survives as historical metadata only —
   * completion is inferred solely from `status`, never from this field.
   */
  completedAt?: string;
  /**
   * The lifecycle status the task had when it was archived (active, paused,
   * or completed). Recorded for history; resuming an archived task always
   * returns it to "active" regardless of this value.
   */
  archivedFrom?: TaskStatus;
  /**
   * ISO timestamp of when the task was pinned. Present only while pinned.
   * Pinned tasks sort before unpinned ones, most recently pinned first,
   * capped at MAX_PINNED_TASKS (the oldest pin is dropped automatically).
   */
  pinnedAt?: string;
  /**
   * Workspace-relative project root the Publish stage verifies against
   * (lint/tests/plan verification). Persisted per task so two tasks in the
   * same workspace folder of a monorepo can target different packages.
   */
  publishScopePath?: string;
  /** Stages explicitly completed by a terminal lifecycle action. */
  completedStages?: TaskStage[];
  /**
   * Explicit human acceptances of a stage whose required artifact was absent
   * at completion time. A completed task with this record is intentionally
   * distinguishable from one whose complete stage artifacts all existed.
   */
  completedWithMissingArtifacts?: CompletedWithMissingArtifactV1[];
  /** Original description captured before an AI draft is applied. */
  preImageDescription?: string;
  /** Stable project binding used for workspace-scoped operations. */
  ownership?: {
    metaRoot: string;
    projectRoot: string;
    workspaceRoot?: string;
    boundAt: string;
    state?: "resolved" | "ownership-unresolved";
  };
  /** ISO timestamp when the task was created */
  createdAt: string;
  /** ISO timestamp when the progress was last updated */
  updatedAt: string;
  /**
   * Monotonic optimistic-concurrency token, owned entirely by
   * `patchTaskProgressStrictV1` (wf10 item 8): incremented by exactly 1 on
   * every write that actually changes the document, and left untouched by
   * every caller — no `nextStage`/`markTaskDone`/`reopen` transition, and no
   * individual patch callback, sets this itself. This exists because
   * `updatedAt` was previously asked to serve two incompatible roles at
   * once: a CAS token that must stay stable across a write for a closed-over
   * comparison to make sense, and a human-facing "when did this last change"
   * timestamp that every display site (Tasks-tree sort/tooltip, discovery
   * sort, status bar) expects to move on every change. Resolving that in
   * `updatedAt`'s favor as a token meant a display bump (e.g. Mark Plan
   * Checklist Reconciled) had nowhere safe to land, so it was silently
   * skipped — the one action the UI insists only a human can perform was the
   * one it did not record. With its own field, `updatedAt` is free to become
   * purely display-value again.
   *
   * Absent on any record that predates this field (every task that existed
   * before this version) and on brand-new tasks before their first patch;
   * `patchTaskProgressStrictV1` treats absence as generation 0 and stamps 1
   * on that first versioned write. A CAS guard comparing this field must
   * therefore fall back to comparing `updatedAt` when either side lacks it,
   * and may treat it as authoritative once both sides carry it.
   */
  progressVersion?: number;
  /**
   * Workspace-relative paths changed across all AI implementation runs for
   * this task, accumulated (unioned, not replaced) as each run completes —
   * see `updateImplReviewFiles`. Ordered most-recently-changed first so the
   * implementation-review pack's size budget serves the latest run's files.
   * Used as the primary
   * review scope for implementation reviews so the review is not limited to
   * whatever files happen to be open, and so a later run that happens to
   * touch no new files doesn't erase an earlier run's tracked files.
   * Absent for tasks implemented manually or created before this field
   * was introduced — those fall back to open-editor review.
   */
  implReviewFiles?: string[];
  /**
   * Workspace-relative paths changed by an implementation round that was
   * detected as INCOMPLETE (deferred or cut short — see
   * `describeIncompleteImplementationRoundV1`), quarantined here instead of
   * banked into `implReviewFiles`. A deferred round is not a completed round:
   * its edits are real and must not be discarded, but they have no usable
   * report to review against, so they wait here until a subsequent
   * implementation round completes successfully and promotes them (unioned
   * into `implReviewFiles` alongside that round's own delta) — see
   * `promotePendingImplReviewFiles`.
   */
  pendingImplReviewFiles?: string[];
  /**
   * Set when an incomplete implementation round changed the tree AFTER the
   * stage's review artifact was written, WITHOUT staling that artifact's
   * content: the previous review is preserved on disk (a detected round must
   * not destroy artifacts the way a rejected round's placeholder writes do),
   * and this marker is the durable record that it no longer describes the
   * workspace. Consumers that treat an existing review as current must check
   * it. Cleared only AFTER replacement review-tracking state has persisted —
   * a stale stamp on the artifact, or a fresh review round publishing with no
   * pending quarantined files — so every persisted state either carries the
   * marker or already shows a fresh review is required.
   */
  reviewInvalidatedByRound?: ReviewInvalidatedByRound;
  /**
   * Count of implementation rounds detected as incomplete (deferred/cut
   * short) since the last successful round. Bounds the automatic
   * continuation loop: each detected round schedules a continuation
   * implementation round, and once this reaches
   * `MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1` the task escalates to the human
   * instead of dispatching another provider. Cleared when a round completes
   * with a usable summary (the pending set is promoted at the same time).
   */
  incompleteRoundContinuations?: number;
  /**
   * Persisted lint state for this task. Present only after a lint run has
   * been executed for a completed task. When absent, the lint state is
   * "unknown" and completion-only actions (commit/push) are gated pending
   * a lint run or an explicit user bypass.
   */
  lintPayload?: LintPayload;
  /** Persisted one-shot current-stage action schedule. */
  scheduledRun?: {
    runAt: string;
    stage: TaskStage;
    leaseOwner?: string;
    leaseUntil?: string;
  };
  /** @deprecated Kept readable for schedules created by older releases. */
  scheduledResumeTime?: string;
  /** Active fallback state by stage */
  fallbackActive?: Partial<Record<TaskStage, boolean>>;
  /** Stored model ID for the backup that is currently carrying a stage. */
  fallbackModelId?: Partial<Record<TaskStage, string>>;
  /** Monotonic token identifying the review run allowed to finalize this stage. */
  reviewAttemptId?: string;
  /**
   * Per-round review score trail, appended once per completed review round
   * (initial reviews, re-reviews, and Fast Forward's internal re-reviews all
   * go through the same publish point). This is the durable, cross-invocation
   * record a single Fast Forward run's in-memory loop cannot provide on its
   * own — it is what lets the extension notice a task has been stuck across
   * many separate review invocations (e.g. hours apart), not just within one
   * session. Capped at MAX_REVIEW_SCORE_HISTORY entries (oldest dropped).
   */
  reviewScoreHistory?: ReviewScoreHistoryEntry[];
  /**
   * Durable record of review rounds REJECTED as degenerate (2d,
   * ensemble.resilience.rejectDegenerateReviews): a round with no parseable
   * `Readiness: N/10` line is a failed attempt, not a review, so it is
   * recorded here — with its reason — instead of ever entering
   * `reviewScoreHistory`, where a phantom scoreless round would distort
   * plateau detection. Capped at MAX_REVIEW_REJECTIONS (oldest dropped).
   */
  reviewRejections?: ReviewRejectionEntry[];
  /**
   * Durable record of review blockers a human has stated, in this task's own
   * stage chat, are resolved by something they just said — wf10 item 19.
   *
   * The chat's confirmable-edit flow (`chatSendRowV1.ts`'s
   * `detectBlockerSupersessionCandidateV1`, `chatWithStage.ts`'s
   * `dispatchProposedBlockerSupersessionEditV1`) writes one entry here the
   * moment the user confirms the drafted `plan.md` update that resolves a
   * stage's sole recorded blocker. Without this record, the write to
   * `plan.md` and the review file's own unchanged blocker text disagree
   * forever until a fresh review round runs — which item 19 explicitly does
   * NOT require (a full re-review remains an offered stronger option, never
   * a precondition). Two production consumers read a plan-review stage's
   * blocker list and treat a matching entry here as no longer outstanding,
   * both via `filterSupersededBlockersV1` (`reviewEvidenceNormalizerV1.ts`),
   * bound to the on-disk review artifact's own mtime so a fresher, still-live
   * re-finding of the same blocker text is never masked:
   * `readStageArtifactsForChat` (`chatWithStage.ts`), which feeds the chat
   * model's own prompt context, and (added 2026-08-25, review blocker
   * `a96160ec-…-2`) `computePlanReviewBlockerSupersessionEvidenceV1`
   * (`reconcilePlanChecklist.ts`), which surfaces the same filtered result as
   * a durable evidence entry in the reconcile decision panel — a real,
   * on-screen surface a human reads directly, not only a hint injected into a
   * model's prompt.
   *
   * `postReviewPlateauDecisionV1` (`reviewEscalation.ts`) deliberately never
   * filters at all, since the evidence it reads is always THIS round's own
   * just-published, still-fresh finding — see `filterSupersededBlockersV1`'s
   * own doc comment on why fresh review content must never be suppressed by
   * an older supersession. `buildSoleBlockerReconcileGuidanceV1`
   * (`reconcilePlanChecklist.ts`) also does not apply this record: it only
   * ever iterates `IMPL_REVIEW_STAGES` for an unrelated purpose (Step 26,
   * checklist-tick corroboration), and this field is only ever recorded
   * against a plan-review stage, so its filter call there could never match
   * regardless.
   *
   * Neither `reviewScoreHistory` nor `advanceStage` (`stageTransition.ts`)
   * consult this field: auto-advance for a plan-review stage is
   * score-threshold-only, and manual "Next Stage" is unconditional for every
   * stage — there is no live "blockers must be zero" transition gate for a
   * plan-review stage to wire supersession-awareness into. What this field
   * changes is what evidence is available to a human deciding, not whether a
   * transition is technically permitted.
   *
   * Matched on exact (trimmed) blocker description text for the same stage —
   * deliberately simple: a later review round that re-states the SAME
   * blocker text after the plan edit was supposed to resolve it is a real
   * disagreement worth surfacing again, not something this record should
   * keep suppressing, but because reviewers virtually always alter wording
   * between rounds even when re-finding the same underlying issue, an exact
   * match naturally stops applying to the next round's blocker list — which
   * is the intended lifecycle, not a bug to work around. Unbounded growth is
   * prevented the same way `reviewRejections` is
   * (`MAX_BLOCKER_SUPERSESSIONS`, oldest dropped first).
   */
  blockerSupersessions?: BlockerSupersessionRecordV1[];
  /**
   * Durable, fixed-vocabulary record of what each round that reached
   * completion accounting actually produced (wf10 item 4 / Part 4). Exists
   * because "Status: completed" with zero files recorded was previously
   * indistinguishable from a genuine no-op: an empty preflight plan on a
   * task with unticked checklist items and a review naming live blockers is
   * a PROVIDER FAILURE ("provider-failure-empty"), not a finding that no
   * work was needed ("genuine-no-op") — see `RoundOutcomeClassificationV1`.
   * Persisted only at round-completion-accounting time, in the same patch as
   * the other round-accounting fields it sits beside (`zeroChangeImplRounds`,
   * `reviewRejections`) — runner-level failures (quota, unavailable, skipped
   * candidate) never reach that accounting and are NOT recorded here; they
   * keep their existing representation (`fallbackActive`,
   * `TaskActionOutcomeV1` kinds) untouched, so this taxonomy neither
   * duplicates nor replaces it. Capped at MAX_ROUND_OUTCOMES (oldest
   * dropped).
   */
  roundOutcomes?: RoundOutcomeEntryV1[];
  /**
   * The sole lifecycle authority for a round, start to end (wf "make the
   * stage chat a record of work" Part 4 / item 1): every round the task ever
   * starts gets exactly one row here, created either from a scheduling
   * intent (`roundId = intentId`, `state: "scheduled"`) or from the
   * coordinator's manual-dispatch `operationId` (`state: "open"`), and ended
   * exactly once by `terminalizeRoundV1` (`roundLedgerV1.ts`) — the only
   * function that may write a terminal `state` here. Distinct from
   * `roundOutcomes` above: that is a CLASSIFICATION record the fallback
   * breaker and degenerate-review advance read, written only for rounds that
   * reach completion accounting; this is a LIFECYCLE record covering every
   * round regardless of how it ends, including ones `roundOutcomes` never
   * sees (a scheduled round that is dropped before dispatch, a review round,
   * a round terminalized on cancellation or quota-park). A terminalized
   * round that also has a classification carries it under
   * `outcome.roundOutcomeAttemptId`, pointing at the corresponding
   * `roundOutcomes` entry rather than duplicating its fields. Capped at
   * MAX_ROUND_LEDGER_ENTRIES (oldest dropped first, but never a row still
   * `"scheduled"`/`"open"` while a newer row is being dropped — the
   * reconciliation sweep is expected to close orphans before the cap ever
   * has to choose between an open row and eviction in practice).
   */
  roundLedger?: RoundLedgerEntryV1[];
  /**
   * Durable record of a round that tried to add, remove, or renumber a
   * checklist item in `plan-final.md` (wf "make the stage chat a record of
   * work" Part 6 / item 5): "a round never mutates the checklist" is a
   * standing rule, so a caught mutation is always reverted the same round it
   * happens (`detectChecklistItemSetMutationV1`, `implementationChecklist.ts`)
   * — this array is the visible trace of that reversal, and the anchor a
   * `checklistChangeProposed` `WorkflowDecisionV1` resolves against. A round
   * never writes a SECOND entry for the same reverted delta; `status`
   * transitions from `"pending"` in place once the user answers the decision.
   * Capped at MAX_CHECKLIST_CHANGE_PROPOSALS (oldest dropped first).
   */
  checklistChangeProposals?: ChecklistChangeProposalV1[];
  /**
   * Set while a checklist-mutation proposal (`checklistChangeProposals`,
   * `"pending"`→`"revising"` status) is being turned into an actual
   * `plan-final.md` revision (wf "make the stage chat a record of work"
   * Part 6 / item 5) — `applyPlanRevisionPolicyV1` writes this in the same
   * transition that moves the task back to the `plan` stage, so the task
   * sits at `plan` with this record naming what the revision is meant to
   * incorporate. Cleared once re-finalization adopts or discards it (Part 6
   * item 7, not yet built).
   */
  planRevision?: PlanRevisionStateV1;
  /**
   * Set when automated review iteration determined it cannot make further
   * progress on its own and needs a human decision. Cleared on the next
   * stage transition and whenever the user explicitly resumes iteration.
   */
  escalation?: TaskEscalation;
  /**
   * Durable record of every escalation Fast Forward rode through rather than
   * aborting for (`ensemble.resilience.fastForwardSurvivesEscalation`, Item
   * 13, 2026-08-18..20 workflow-defects batch): each entry is a DISTINCT
   * escalation (identified by its own `at`) that was overridden — not acted
   * on — so the run could finish its attempt budget. Without this, "an
   * escalation fired and was overridden" existed only as an in-memory array
   * surfaced through a single end-of-run notification; a ceiling that
   * re-fires more than once in one run, or a run whose notification the
   * operator missed, left no durable trace that anything had been ridden
   * through at all. Never cleared automatically — append-only, capped at
   * MAX_OVERRIDDEN_ESCALATIONS (oldest dropped).
   */
  overriddenEscalations?: TaskEscalation[];
  /**
   * Set when a post-implementation type-check (2g) fails on a round that DID
   * change files — a truncated tsc/build error left the tree non-compiling.
   * Surfaced immediately so the round is never handed to a reviewer as if it
   * were reviewable (a reviewer that instead diagnoses a build failure has
   * wasted its round). Cleared the next time an implementation round
   * completes with a passing (or skipped) type-check.
   */
  implementationTypeCheckFailure?: ImplementationTypeCheckFailure;

  /**
   * True once a round completed work that could not be recorded in the plan's
   * `- [ ]` checklist, making its counts permanently understate what is done.
   *
   * Set when a runner-authored round lands (the sealed edit pipeline returns
   * verified receipts and no written summary, so it cannot echo the checklist
   * back). Durable rather than derived from the latest summary, because the
   * damage outlives the round: a later model-authored round ticks only the
   * items IT completed, so the earlier round's work stays unticked forever
   * while the fresh summary makes the checklist look trustworthy again. The
   * count would then hold a finished plan short of its total indefinitely.
   *
   * Consulted by the completeness gate, which stands down rather than treat an
   * under-counting checklist as the authority on remaining work. Cleared only
   * by an explicit reconciliation of the checklist against the tree — never by
   * a later round, which has no way to know what the unrecorded round did.
   */
  checklistProgressUnreliable?: boolean;

  /**
   * Plain-language reason `checklistProgressUnreliable` was set (task:
   * "Actionable Hand-offs", PART 5) — e.g. "this round changed no files and
   * landed no checklist ticks, but the most recent review already scored the
   * work at or above the auto-advance threshold with zero blockers". The
   * reconciliation decision (`reconcilePlanChecklist.ts`) cites this instead
   * of only the weaker "N items are unticked" count, since the stronger
   * discriminating fact (WHY the counts are being distrusted, e.g. a
   * disputed auto-ticking mechanism) is what actually lets a human judge
   * whether "Mark reconciled" is safe.
   *
   * Optional, and NOT YET populated by any write path as of this field's
   * introduction — every current latch site lives in `reviewActions.ts`,
   * which this task's plan defers editing until a concurrent task closes
   * (PART 9). Until then this is uniformly absent, and the reconciliation
   * decision renders that absence as an explicit "not recorded (older
   * record)" statement rather than silently omitting the citation.
   */
  checklistProgressUnreliableReason?: string;

  /**
   * Consecutive completed implementation rounds (for the task's current
   * stage) that changed zero files — the durable form of the no-progress
   * breaker's counter (2c, `ensemble.resilience.noProgressBreakerRounds`).
   *
   * Deliberately persisted, reversing the counter's original in-memory-only
   * design: a per-session `Map` reset on every window reload, which let a
   * task that could have tripped the breaker keep silently accumulating
   * fresh zero-change rounds after a reload instead (report 11). The counter
   * now survives reloads and survives across rounds within a stage.
   *
   * Reset to zero (or cleared) on any round that changes files, and on a
   * stage transition — NOT consume-before-transition: a stage's own loop
   * must be able to read a count written several rounds earlier, so this is
   * not wiped merely because the field was read once.
   *
   * Widened (Part 3, 2026-08-14) to track STERILE rounds rather than
   * file-change alone: a round that changed no files but landed new plan
   * checklist ticks made real, durable progress and clears the streak like
   * any file-changing round; one that changed no files and merged no ticks —
   * including a retroactive-tick claim that matched nothing in the plan of
   * record — is exactly as sterile as one that reported nothing at all, and
   * still counts (round 013, task "1.9": a verification-only, zero-file round
   * whose retroactive claims used paraphrased item text and merged nothing).
   */
  zeroChangeImplRounds?: number;

  /**
   * WHY the task is paused, for a pause the workflow imposed rather than the
   * user requesting one — e.g. "no configured provider for impl-high-review
   * is available" when a stage's entire provider chain is exhausted
   * (2026-08-13 finding 4: the task previously just went quiet, its only
   * record a 60-byte run file nobody was watching). Surfaced in the task
   * tree so a paused-with-reason task is distinguishable from a round still
   * thinking. Meaningful only while `status === "paused"`; cleared by any
   * status change away from paused (`updateTaskStatus`).
   */
  pausedReason?: string;

  /**
   * Durable record that an implementation round finished without a usable
   * report and a recovery continuation is owed — the ONE transition every
   * unreported round lands on (deferred, cut short, or a stamped-unusable
   * summary). Written in the same strict patch that quarantines the round's
   * delta and increments `incompleteRoundContinuations`, BEFORE any run-log
   * or artifact write, so a crash at any later point can only lose
   * reporting, never the fact that recovery is owed. Its `dispatch` state
   * machine (`pending` → `dispatched`) is what lets a host restart tell "a
   * continuation was never started" (re-arm it) from "one started and died"
   * (surface it, never double-fire). Cleared in the same transaction that
   * finalizes a subsequent usable summary (`promotePendingImplReviewFiles`),
   * and by stage transitions (see taskProgressFieldPolicyV1). Without this
   * record, a stamped-unusable round persisted nothing and the task sat
   * "active" indefinitely with no forward motion (2026-08-13_task_1, round
   * 010: a "stale waiter" narration was finalized as completed and nothing
   * ever produced a real summary).
   */
  implRecovery?: ImplRecoveryV1;

  /**
   * Durable record that a stage was blocked by a quota or model-entitlement
   * failure — written in the same transaction that withholds/parks the
   * stage (see runnerRegistry.ts's dirty-tree withheld-backup branch and
   * reviewActions.ts's pauseTaskForExhaustedChainV1), so a host restart or a
   * later notification can still tell the operator WHEN (if known) the
   * provider is expected to recover, without re-deriving it from a
   * module-level, restart-losing in-memory map (see quota.ts's
   * QuotaObservation doc comment). Belongs to the specific stage attempt
   * that hit the failure, not to future stages. Unlike `pausedReason`,
   * resuming the task (`"paused"` -> `"active"`) does NOT clear it by
   * itself — it is a durable prediction, not a description of the current
   * paused state, so it survives until fresh evidence retires it: a
   * matching-identity successful or contradicting run via `clearQuotaParkV1`
   * (see runnerRegistry.ts), a later unrelated pause overwriting it
   * (`pauseTaskWithReason`), or explicit clearing by all three
   * `taskProgressFieldPolicyV1` transition builders (nextStage/
   * markTaskDone/reopen), matching `implRecovery`'s policy.
   */
  quotaParkRecord?: QuotaParkRecordV1;
}

/**
 * `TaskProgress.quotaParkRecord` — durable record of a quota/entitlement
 * failure that blocked a stage. `failureKind` is deliberately narrowed to
 * the two kinds "resets at" language actually applies to: `"quota"` and
 * `"model-entitlement"` (a provider explicitly refusing this model id to
 * this account until the account's entitlement changes). `"temporarily-
 * unavailable"` is excluded on purpose — it is a transient outage with no
 * provider-reported reset time, so persisting a park record for it would
 * imply a predictable resume time that does not exist.
 */
export interface QuotaParkRecordV1 {
  /** The model id that hit the failure. */
  modelId: string;
  /** The resolved provider id that reported the failure. */
  providerId: string;
  /** Account/credential context the failure was observed under, when known. */
  accountKey?: string;
  /** Narrowed to the two failure kinds "resets at" language applies to. */
  failureKind: "quota" | "model-entitlement";
  /** ISO instant the provider reported the limit will lift, from parseQuotaResetV1. */
  resetAt?: string;
  /** ISO instant the failure was observed. */
  observedAt: string;
}

/** How the round that triggered an `implRecovery` failed to report. */
export type ImplRecoveryTriggerV1 =
  | "roundDeferred"
  | "roundIncomplete"
  | "summaryRejected"
  // Part 7: a wall-clock or inactivity-watchdog kill — the process was
  // stopped from outside rather than returning any final response at all,
  // unlike the other three triggers which all have SOME provider reply
  // (however unusable) to classify.
  | "externallyTerminated"
  // Plan Part 15 (item 7b): a cascade-eligible provider failure (quota,
  // model-entitlement, or outage) that left the working tree dirty. The
  // primary DID return a final response (unlike `externallyTerminated`) but
  // its own edits are unverified, so the recorded recovery is always forced
  // to `"inspect-and-complete"` mode (see `beginImplementationRecoveryV1`'s
  // `forceMode`) rather than derived from the SAME-model review-history
  // evidence the other triggers use — that evidence is meaningless for a
  // hand-off to a DIFFERENT model that has never run this stage before.
  | "providerFailedMidRound";

/**
 * The continuation constraint recovery was begun under. Part 1 records
 * `"unconstrained"` (a full implementation continuation); evidence-based
 * selection of the narrower modes is Part 2's job:
 *  - `"summary-only"` — re-emit a proper report for an already-reviewed diff;
 *  - `"inspect-and-complete"` — verify/finish a known change set from an
 *    externally-terminated round;
 *  - `"unconstrained"` — the edits themselves are suspect.
 */
export type ImplRecoveryModeV1 =
  | "summary-only"
  | "inspect-and-complete"
  | "unconstrained";

/** Dispatch state of the owed recovery continuation. */
export type ImplRecoveryDispatchStateV1 = "pending" | "dispatched";

/**
 * What an implementation round was actually working from, distinguishing a
 * checklist-driven Implementation round from a review-driven Apply Review
 * round from a recovery continuation of either — the three currently share
 * one `# Implementation Run` run-log header with no way to tell them apart
 * after the fact (wf task "make the stage chat a record of work", item 17a).
 */
export type ImplementationDispatchModeV1 =
  | "implementation"
  | "apply-review"
  | "continuation";

/**
 * `RoundLedgerEntryV1.mode`'s value space — a strict superset of
 * `ImplementationDispatchModeV1`. The round ledger (unlike `roundOutcomes`,
 * `implRecovery`'s `sourceDispatchMode`, or the run-log `Mode:` line, all of
 * which describe only `impl`-stage rounds) also carries rows for rounds run
 * AT a review stage (`impl-high-review`, `impl-low-review`, and the plan
 * review stages) — an AI reviewer round is not "dispatched from" a checklist
 * or a review the way an implementation round is, so none of
 * `ImplementationDispatchModeV1`'s three values fit it. `"review"` is that
 * fourth case. Kept as its own type, rather than adding `"review"` to
 * `ImplementationDispatchModeV1` itself, so the OTHER fields typed
 * `ImplementationDispatchModeV1` (which are genuinely implementation-only)
 * cannot silently accept a value that would be meaningless there.
 */
export type RoundLedgerModeV1 = ImplementationDispatchModeV1 | "review";

/** `TaskProgress.implRecovery` — one owed recovery continuation. */
export interface ImplRecoveryV1 {
  /** Stable token identifying the triggering round, quoted in its run log. */
  sourceAttemptId: string;
  /** Displayable reason the triggering round's report was unusable. */
  reason: string;
  /** Failure class of the triggering round. */
  trigger: ImplRecoveryTriggerV1;
  /** Continuation constraint selected at transition time. */
  mode: ImplRecoveryModeV1;
  /**
   * `"pending"` until an implementation round actually starts and claims the
   * continuation (flipping to `"dispatched"` with a fresh `attemptId` in one
   * patch). Only a `pending` record with no live lease may be re-armed.
   */
  dispatch: ImplRecoveryDispatchStateV1;
  /** ISO timestamp recovery was recorded. */
  at: string;
  /**
   * True when the triggering round's change set could not be enumerated —
   * recorded explicitly rather than passed off as an empty quarantine list.
   */
  filesChangedUnknown?: boolean;
  /** Continuation attempt token, set when `dispatch` flips to "dispatched". */
  attemptId?: string;
  /** Same lease semantics as `scheduledRun`: one window arms the dispatch. */
  leaseOwner?: string;
  leaseUntil?: string;
  /**
   * Dispatch mode of the round that triggered this recovery. When it was
   * `"apply-review"`, the claimed continuation must render from
   * `apply-impl-review-code.md` with the original review content rather than
   * silently reverting to a checklist-driven `run-implementation.md`
   * continuation (the defect item 17b's risk note warns against). Absent for
   * recoveries recorded before this field existed; treat absence as
   * `"implementation"`.
   */
  sourceDispatchMode?: ImplementationDispatchModeV1;
  /**
   * The review stage whose blockers the source `"apply-review"` round was
   * applying, so its continuation can re-read the same review artifact.
   * Only meaningful when `sourceDispatchMode === "apply-review"`.
   */
  sourceReviewStage?: TaskStage;
  /**
   * The `roundLedger` row id `beginImplementationRecoveryV1` terminalized as
   * the source round (Part 4 / item 1 "source/continuation linkage") — the
   * live `roundLedger` row for this task at transition time when one existed,
   * or a row freshly synthesized under `sourceAttemptId` when none did (a
   * manually-dispatched round never opened one). `claimImplRecoveryDispatchV1`
   * reads this to set the continuation's own row `continuationOf`, so
   * `resolveRoundV1` can walk from a continuation back to the round it
   * continues. Absent for a record persisted before this field existed.
   */
  sourceRoundId?: string;
}

/** `TaskProgress.reviewInvalidatedByRound` — which stage's review an incomplete round invalidated, and when. */
export interface ReviewInvalidatedByRound {
  /** The review stage whose artifact no longer describes the workspace. */
  stage: TaskStage;
  /** ISO timestamp the invalidating round was detected. */
  at: string;
}

/**
 * Cap on automatic continuations of incomplete (deferred/cut-short)
 * implementation rounds before escalating to the human. Deliberately the
 * same VALUE as the coordinator's `MAX_MALFORMED_RESULT_INVOCATIONS_V1`
 * (taskActionCoordinatorV1.ts) but applied at the task-loop layer against
 * the persisted `incompleteRoundContinuations` counter — the coordinator's
 * malformed-result budget never sees these rounds, because a detected round
 * settles as a completed provider invocation.
 */
export const MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 = 3;

/** `TaskProgress.implementationTypeCheckFailure` — one round's failing type-check. */
export interface ImplementationTypeCheckFailure {
  /** ISO timestamp the failing type-check was recorded. */
  at: string;
  /** Truncated compiler/build output, for display. */
  output: string;
}

/**
 * Stable identity of one reported blocker, persisted per review round so
 * later rounds can compare blocker SETS substantively (category + resolver +
 * the file/subject named) instead of byte-for-byte prose — reviewer wording
 * drifts round to round ("still fails" → "fails during collection") while
 * the underlying cause stays the same. See reviewRouting.ts's
 * detectBlockerSetStall.
 */
export interface ReviewBlockerIdentity {
  category: string;
  resolver: string;
  /** File-ish token named by the blocker when one exists, else a normalized
   * prose prefix — the "what is this blocker about" key. */
  subject: string;
  /**
   * Opaque stable ID for this blocker, assigned when it is first persisted
   * to history (a `[new]`/lineage-unknown round) and carried forward
   * unchanged on every later round whose reviewer declares `[same:<id>]` or
   * `[narrowed:<id>]` against it — see resolveBlockerLineageV1
   * (reviewRouting.ts). Absent on entries written before this field existed.
   */
  id?: string;
  /**
   * This round's declared lineage against the round's own PRIOR blocker
   * list (the one injected into its re-review prompt), as parsed from the
   * reviewer's own third bracket. Absent means lineage-unknown — no bracket
   * was emitted, it cited an id absent from the prior list, or there was no
   * prior list to cite (a first round). Never inferred from prose: the
   * reviewer declares it or it is unknown, per blockerLineageV1's contract.
   */
  lineage?: BlockerLineageDeclaration;
  /**
   * Truncated original description (distinct from the compact `subject`
   * comparison key), kept only so a later round's re-review prompt can show
   * enough context for the reviewer to recognize its own prior finding when
   * deciding whether to cite it. Never used for identity comparisons.
   */
  description?: string;
  /**
   * Carried forward from `ReviewBlocker.origin` (reviewReadiness.ts):
   * `"reviewer"` for a blocker the AI reviewer itself raised in prose,
   * `"mechanical"` for one synthesized directly from a failed Verified
   * Check. Absent on entries written before this field existed, and for any
   * blocker whose origin was not recorded at parse time — never assume
   * `"reviewer"` for an absent value. Lets a reader distinguish "the
   * reviewer found 3 problems" from "0 reviewer-found, 3 generated
   * mechanically from failing checks" instead of reading both as one
   * undifferentiated count (wf10 continuation item 12).
   */
  origin?: "reviewer" | "mechanical";
}

/**
 * One blocker this round re-raised that matches a `plan-final.md`
 * `## Accepted Non-Goals` entry (wf10 continuation item 18) — recorded so
 * the disagreement is visible ("either the reviewer has a reason the
 * decision missed, or it is not reading the decision") rather than silent.
 * The review's own timestamp (`ReviewScoreHistoryEntry.at`) IS the "review
 * mtime" this was observed at — no separate timestamp is carried here.
 */
export interface ReviewerChallengedNonGoalV1 {
  /** The stable blocker lineage id (`ReviewBlockerIdentity.id`) of the
   * re-raised blocker, when one could be resolved. */
  readonly blockerId?: string;
  /** The `## Accepted Non-Goals` sub-heading (or the section heading itself,
   * for a plan with no sub-headings) the blocker matched. */
  readonly nonGoalHeading: string;
}

/**
 * A reviewer's declared relationship between one of this round's blockers
 * and a specific blocker from the prior round's ID'd list — see
 * `ReviewBlockerIdentity.lineage` and `resolveBlockerLineageV1`
 * (reviewRouting.ts). `refId` is the id exactly as cited by the reviewer,
 * which may not actually exist in the prior list (an unknown-id citation is
 * resolved to lineage-unknown by the caller, not by this type).
 */
export type BlockerLineageDeclaration =
  | { kind: "new" }
  | { kind: "same"; refId: string }
  | { kind: "narrowed"; refId: string };

/** One row of `TaskProgress.reviewScoreHistory`. */
export interface ReviewScoreHistoryEntry {
  stage: TaskStage;
  /** Parsed `Readiness: N/10`, or null if the round produced no parseable score. */
  score: number | null;
  /** The reviewAttemptId that produced this round, for correlation with run logs. */
  attemptId: string;
  /** ISO timestamp when this round's review was published. */
  at: string;
  /** Total classified blockers found by the reviewer this round. */
  blockerCount: number;
  /** Of those, how many were classified as fixable by another implementation round. */
  taskFixableCount: number;
  /** Stable identities of this round's blockers (absent on entries written
   * before this field existed). */
  blockers?: ReviewBlockerIdentity[];
  /**
   * Identity of the provider/model that actually produced this round's
   * review, including any backup-cascade substitution — never the stage's
   * configured/requested model. Absent on entries written before this field
   * existed. Score-delta and plateau comparisons must never compare across a
   * change in this identity: a different reviewer is a different instrument,
   * and the +0.1 advance threshold is the same order of magnitude as a
   * plausible between-reviewer offset (2026-08-14 finding: workflow-2 item 7).
   */
  reviewer?: ReviewerIdentityV1;
  /**
   * Stable identities of blockers this round reported that were EXCLUDED
   * from `blockerCount`/`taskFixableCount`/`blockers` because they matched a
   * `plan-final.md` `## Accepted Non-Goals` entry (wf10 continuation item
   * 18, `derivePlanNonGoalSupersessionsV1`). Absent when nothing was
   * superseded this round. Kept separate from `blockers` (which lists only
   * what still counts as outstanding) so a reader can see both what this
   * round measured AND what was set aside, rather than the plan's decision
   * silently shrinking the reported numbers with no trace.
   */
  supersededBlockers?: ReviewBlockerIdentity[];
  /**
   * Every blocker this round re-raised that matches an Accepted Non-Goals
   * entry — see `ReviewerChallengedNonGoalV1`'s doc comment. Absent when
   * nothing matched. A NON-EMPTY value here does not mean the reviewer was
   * wrong to raise it (see that type's doc comment on match confidence) —
   * only that the disagreement between this round and the plan of record is
   * now visible instead of silent.
   */
  reviewerChallengedNonGoal?: ReviewerChallengedNonGoalV1[];
}

/** See `ReviewScoreHistoryEntry.reviewer`. */
export interface ReviewerIdentityV1 {
  readonly providerLabel: string;
  readonly storedModelId: string;
}

/** One row of `TaskProgress.reviewRejections`. */
export interface ReviewRejectionEntry {
  stage: TaskStage;
  /** The reviewAttemptId of the rejected round, for correlation with run logs. */
  attemptId: string;
  /** ISO timestamp when the round was rejected. */
  at: string;
  /** Why the round was rejected (e.g. no parseable `Readiness: N/10` line). */
  reason: string;
}

/** Cap on `TaskProgress.reviewRejections` length (oldest entries dropped first). */
export const MAX_REVIEW_REJECTIONS = 50;

/** One row of `TaskProgress.blockerSupersessions` (wf10 item 19). */
export interface BlockerSupersessionRecordV1 {
  /** The plan-review stage the superseded blocker was recorded against. */
  stage: TaskStage;
  /** The blocker's own description text, exactly as parsed from the review
   * artifact at the moment it was declared resolved — matched verbatim
   * (after trimming) against a stage's current blocker list. */
  blockerDescription: string;
  /** ISO timestamp the confirmable plan.md edit was actually applied. */
  supersededAt: string;
  /** Task-folder-relative path of the file the resolving decision was
   * written to (currently always `plan.md`). */
  planRelPath: string;
  /**
   * ISO timestamp of the assistant chat message (`ChatMessage.at`,
   * `chatHistoryStore.ts`) that proposed the confirmed edit — the durable
   * pointer to the confirming chat exchange a review flagged as missing
   * (2026-08-25): without it, a supersession record asserted a resolution
   * happened in chat with no way to find that exchange again. Optional only
   * so a record from before this field existed remains decodable; every NEW
   * record (`dispatchProposedBlockerSupersessionEditV1`,
   * `commands/chatWithStage.ts`) carries it.
   */
  confirmingMessageAt?: string;
  /**
   * Where this supersession came from. Absent decodes as `"chat-confirmed"`
   * — every record written before this field existed came from the stage-chat
   * resolution path (`dispatchProposedBlockerSupersessionEditV1`), the only
   * one that existed then.
   *
   *  - `"chat-confirmed"`: a human resolved this specific blocker via this
   *    task's own stage chat and a confirmable `plan.md` edit landed. Only
   *    suppresses STALE content (`filterSupersededBlockersV1`'s doc comment)
   *    — a fresh review's own live output is never masked by it.
   *  - `"plan-non-goal"` (wf10 continuation item 18): derived automatically
   *    by matching a blocker's description against `plan-final.md`'s
   *    `## Accepted Non-Goals` section (`derivePlanNonGoalSupersessionsV1`,
   *    `reviewEvidenceNormalizerV1.ts`) — a standing decision about the
   *    blocker's SUBJECT, not a statement about one stale artifact, so it
   *    applies even to content produced the same round it was derived from.
   */
  source?: "chat-confirmed" | "plan-non-goal";
}

/** One row of `TaskProgress.checklistChangeProposals` (wf "make the stage
 * chat a record of work" Part 6 / item 5). */
export interface ChecklistChangeProposalV1 {
  /** ISO timestamp the mutation was caught and reverted. */
  at: string;
  /** This round's own round-ledger row identity, for correlation with the
   * run log that recorded the discarded delta. */
  roundId: string;
  /** The stage the round was dispatched at when it mutated the checklist. */
  stage: TaskStage;
  /** How the item set changed, before it was reverted. */
  kind: "added" | "removed" | "renumbered";
  /** The item texts the round tried to add (for `"added"`/`"renumbered"`) —
   * exactly as they appeared in the round's own edit, before being discarded. */
  proposedItems: readonly string[];
  /** The item texts the round's edit dropped (for `"removed"`/`"renumbered"`),
   * verbatim from the pre-round plan of record. */
  removedItems: readonly string[];
  /** `"pending"` until a `checklistChangeProposed` decision is answered;
   * `"revising"` while a chosen plan revision (Part 6 / item 19) is in
   * flight; `"discarded"` if the user declined the proposal; `"adopted"`
   * once a revision incorporating it lands. */
  status: "pending" | "revising" | "discarded" | "adopted";
  /** ISO timestamp `markChecklistChangeProposalAdoptedV1` set this entry
   * `"adopted"` (2026-08-28 review fix, Part 6 completion blocker: "records
   * the completion in chat rather than the round ledger"). The durable
   * record of a revision's completion — set in the SAME
   * `patchTaskProgressStrictV1` transaction that flips `status`, so it can
   * never exist without the status flip having actually landed, unlike the
   * best-effort chat line that narrates the same event. */
  resolvedAt?: string;
  /** Checklist `total` (settled/total denominator, Part 5) immediately
   * before this revision's re-finalization merge — set alongside
   * `resolvedAt`, for an auditable record of the item-count change that does
   * not depend on parsing the chat transcript's prose. */
  itemCountBefore?: number;
  /** Checklist `total` immediately after this revision's re-finalization
   * merge — set alongside `resolvedAt`. */
  itemCountAfter?: number;
  /**
   * Whether `markChecklistChangeProposalAdoptedV1` also annotated the
   * mutating round's `roundLedger` row with `checklistRevisionAdopted`, in
   * the SAME transaction that set `resolvedAt` above (2026-08-28 review fix,
   * completion blocker: "the separate best-effort write may fail or no-op
   * after the originating row is pruned — adoption may be marked durable on
   * the proposal while the required ledger record remains absent"). Set
   * `true` when the row was found and successfully annotated in this
   * transaction (or a prior one).
   *
   * A second review pass (same date) found the FIRST fix insufficient —
   * making the omission observable does not fulfill "the ledger records
   * revision completion" if the omission can still happen in the ordinary
   * case. The actual gap was `upsertRoundLedgerEntryV1`'s cap eviction: a
   * revision can take many rounds (through plan, both plan reviews,
   * implementation, both impl reviews) before this transform runs, and the
   * mutating round's own terminal row could be evicted by ordinary FIFO
   * pressure during that window. `upsertRoundLedgerEntryV1` now protects a
   * terminal row from eviction for as long as it is named by a
   * `checklistChangeProposals` entry still `"pending"`/`"revising"` — so in
   * the ordinary case the row is guaranteed to still exist when adoption
   * runs, and `false` should not occur in practice.
   *
   * A third review pass (same date) found that protection alone insufficient
   * too: `appendChecklistChangeProposal`'s own cap eviction could drop the
   * proposal entry itself — the thing naming the protected row — before
   * adoption ever ran, at which point the round-ledger protection lapses with
   * it regardless of how sound it is. `appendChecklistChangeProposal` now
   * applies the identical rule one level up: a `"pending"`/`"revising"`
   * proposal is never evicted by the ordinary cap, only `"discarded"`/
   * `"adopted"` (already-resolved) entries are, oldest first. The field is
   * kept (rather than made required) only for the one residual case both
   * protections still cannot reach: `MAX_CHECKLIST_CHANGE_PROPOSALS` (50)
   * OTHER proposals simultaneously unresolved on the same task at once — at
   * that point the array is deliberately left over cap (see
   * `appendChecklistChangeProposal`'s own doc comment) rather than evicting
   * an unresolved one, so this field would in fact still end up `true`; only
   * a decoder/writer failure on that specific write remains as a truly
   * unreachable-in-practice cause for `false`. `false` remains the observable
   * trace of that outcome rather than a silently swallowed no-op. Absent only
   * when the proposal itself has not yet been adopted.
   */
  ledgerAnnotated?: boolean;
}

/** Cap on `TaskProgress.checklistChangeProposals` length (oldest entries dropped first). */
export const MAX_CHECKLIST_CHANGE_PROPOSALS = 50;

/** `TaskProgress.planRevision` (wf "make the stage chat a record of work"
 * Part 6 / items 4-5) — set by `applyPlanRevisionPolicyV1` when a caught
 * checklist-mutation proposal is turned into an actual plan revision.
 * Carries forward the discarded/removed item texts and the originating
 * proposal's identity so a later `{{planRevisionProposal}}` template
 * variable (Part 6 item 6, not yet built) and re-finalization merge (Part 6
 * item 7, not yet built) can reconstruct what changed and re-apply prior
 * ticks without re-deriving them from a stale `plan-final.md` diff. */
export interface PlanRevisionStateV1 {
  /** The `checklistChangeProposals` entry (`at`) this revision resolves. */
  readonly proposalAt: string;
  /** ISO timestamp the revision transition itself ran (coordinator clock). */
  readonly startedAt: string;
  /** The stage the round was dispatched at when it produced the proposal. */
  readonly stage: TaskStage;
  /** Item texts the round tried to add, carried through unchanged from the proposal. */
  readonly discardedItems: readonly string[];
  /** Item texts the round's edit tried to drop, carried through unchanged. */
  readonly removedItems: readonly string[];
  /** Plain-language reason a revision is needed, surfaced to the plan-stage prompt. */
  readonly reason: string;
  /**
   * The revision-owned journal snapshot's filename, relative to the task
   * folder (2026-08-28 review fix, Part 6 completion blocker: "Step 19 still
   * persists ... instead of ... snapshot plan-final.md to the revert journal
   * and record a journaledPlanRef when revision begins"). Written by
   * `snapshotPlanForRevisionV1` (`implementationArtifactResolver.ts`) the
   * moment "Revise the plan" runs, BEFORE this record is even written —
   * a frozen copy of the pre-revision `plan-final.md`, independent of the
   * shared `_prev` backup slot any other artifact write could otherwise
   * clobber during the plan/plan-review stages this revision passes
   * through. `preparePlanPromotion`'s re-finalization merge reads prior
   * ticks from this file when present, falling back to the (in practice
   * identical) live canonical file only when it is unexpectedly absent.
   * Absent when the round that raised the proposal had, unusually, not yet
   * produced a `plan-final.md` for this task at all — nothing to snapshot.
   */
  readonly journaledPlanRef?: string;
}

/** Cap on `TaskProgress.blockerSupersessions` length (oldest entries dropped first). */
export const MAX_BLOCKER_SUPERSESSIONS = 50;

/**
 * Fixed classification of what a round that reached completion accounting
 * actually produced (wf10 item 4 / Part 4):
 *  - `edits-produced`: real workspace edits landed, or the plan checklist
 *    itself advanced (durable progress either way).
 *  - `genuine-no-op`: zero files changed, but this is a JUSTIFIED no-work
 *    finding — a correct implementer declining to fabricate work when prior
 *    rounds already changed the tree and no unticked/unclearing evidence
 *    says otherwise.
 *  - `provider-failure-empty`: zero files changed on a task that still has
 *    unticked checklist items and no review has cleared the stage — the
 *    same shape previously recorded, indistinguishably, as a success.
 *  - `cancelled`: the round was cancelled before producing a result.
 *  - `rejected-degenerate`: a review round with no parseable `Readiness:
 *    N/10` line — a failed attempt wearing a review's clothes, not a
 *    review (see `TaskProgress.reviewRejections`).
 */
export type RoundOutcomeClassificationV1 =
  | "edits-produced"
  | "genuine-no-op"
  | "provider-failure-empty"
  | "cancelled"
  | "rejected-degenerate";

/** One row of `TaskProgress.roundOutcomes`. */
export interface RoundOutcomeEntryV1 {
  stage: TaskStage;
  classification: RoundOutcomeClassificationV1;
  /** ISO timestamp when the round was classified. */
  at: string;
  /** Correlates with the review attempt this classification describes, when known (review rounds only). */
  attemptId?: string;
  /**
   * The stored model id this round actually ran with (Part 5's fallback
   * circuit breaker and degenerate-review backup advance both need to know
   * WHICH candidate produced a zero-file/rejected round, not just that one
   * occurred — a breaker keyed on the task+stage alone would trip on a
   * healthy primary's occasional no-op mixed with a genuinely broken
   * fallback's rounds). Absent for older entries written before this field
   * existed; treat absence as "unknown candidate", never as a match.
   */
  modelId?: string;
  /**
   * The runner id (`runnerId`) the candidate that actually produced this
   * round ran under — e.g. `"claude-cli"`, `"codex-cli"`, or `"copilot-lm"`
   * for every Copilot dispatch (Copilot is routed exclusively through the
   * sealed two-phase pipeline in `runImplementationOrSealedV1`, so
   * `"copilot-lm"` already IS the sealed-vs-direct distinction — there is no
   * separate invocation-mode value it could take). wf10 review fix (Part 5
   * steps 13-14, narrowed blocker 1): candidate identity for the breaker/
   * health-window checks is the full provider path (provider id + model id),
   * not `modelId` alone — two different provider paths could in principle
   * share a model id string. Absent for entries written before this field
   * existed; treat absence as "unknown provider", never as a match, exactly
   * like an absent `modelId`.
   */
  providerId?: string;
  /**
   * What the round was dispatched to work from — checklist-driven
   * Implementation, review-driven Apply Review, or a recovery continuation
   * of either. Absent for entries written before this field existed; treat
   * absence as unknown, never as `"implementation"` by default, since older
   * rows predate the distinction entirely.
   */
  dispatchMode?: ImplementationDispatchModeV1;
  /**
   * Review fix, 2026-08-27 (narrowed blocker 2 on Step 11): the impl-review
   * stage the task actually displayed when this round was dispatched, set
   * ONLY on rows bookkept under the literal `stage: "impl"` while the task
   * was really sitting on `impl-high-review`/`impl-low-review` (see the
   * `gateStage`/`zeroChangeStage` comments in `reviewActions.ts` — that
   * literal-"impl" bookkeeping exists so the fallback breaker resolves its
   * model/quota chain correctly, but it otherwise loses which review stage
   * was active). `recentDispatchModesForStageV1` uses this to keep an
   * `impl-high-review` plateau card's evidence from absorbing rounds that
   * actually ran while the task was at `impl-low-review`, and vice versa.
   * Absent for every row NOT bookkept under literal "impl" (its own `stage`
   * is already correct there) and for rows written before this field
   * existed — both cases fall back to matching the row's own `stage`, never
   * treated as a match for a review stage this field doesn't name.
   */
  originatingReviewStage?: TaskStage;
}

/** Cap on `TaskProgress.roundOutcomes` length (oldest entries dropped first). */
export const MAX_ROUND_OUTCOMES = 50;

/** Cap on `TaskProgress.roundLedger` length (oldest TERMINAL rows dropped first). */
export const MAX_ROUND_LEDGER_ENTRIES = 200;

/** `TaskProgress.roundLedger`'s lifecycle states — a strict superset of the
 * five-value scheduling-posture vocabulary the task tree already renders
 * (running / scheduled / owed-but-will-not-retry / waiting-for-you /
 * unknown): `"scheduled"` and `"open"` are the two live states; every other
 * value is terminal and, once set, may never change (see
 * `terminalizeRoundV1`'s idempotency contract). */
export type RoundLedgerStateV1 =
  | "scheduled"
  | "open"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed"
  | "quota-blocked"
  | "dropped"
  | "interrupted";

/** The durable outcome recorded on a terminalized `RoundLedgerEntryV1` — the
 * facts a chat outcome message renders (files changed, a review's score and
 * blocker split, a rejection's reason), never a duplicate of the full review
 * or run-log content itself. */
export interface RoundLedgerOutcomeV1 {
  /** Paths changed by this round, when known. Omitted (not empty) when the
   * round never reached a point where a change set could be enumerated. */
  filesChanged?: readonly string[];
  /** True when a round DID change files but the exact set could not be
   * enumerated — distinct from `filesChanged` being empty (no changes). */
  filesChangedUnknown?: boolean;
  /** A review round's score out of 10, when this row is a review. */
  score?: number;
  /** A review round's blocker count actually raised by the reviewer
   * (excludes mechanical/superseded blockers — see item 12's `origin` split
   * and item 18's `supersededBlockers`). */
  reviewerBlockers?: number;
  /** A review round's blocker count synthesized from failing checks
   * (`origin: "mechanical"`). */
  mechanicalBlockers?: number;
  /** Why a round's summary was rejected, for `state: "rejected"`. */
  rejectionReason?: string;
  /** True when ending this round left a recovery continuation owed —
   * the source round is terminal even though the work is not finished; the
   * lease wait itself is represented by the task's scheduling posture, never
   * by a second open ledger row (see `TaskProgress.roundLedger`'s doc
   * comment). */
  continuationOwed?: boolean;
  /** Workspace-relative path of this round's run log, when one was written. */
  runLogPath?: string;
  /** Correlates this row with its `TaskProgress.roundOutcomes` classification
   * entry (matched by `attemptId`), when this round also went through
   * completion accounting — avoids duplicating those fields here. */
  roundOutcomeAttemptId?: string;
  /**
   * Headings of `## Accepted Non-Goals` entries this review round re-raised a
   * blocker against (item 18, plan step 11: "write a ledger outcome line
   * when a review re-raises a blocker matching a non-goal"). Mirrors
   * `ReviewScoreHistoryEntry.reviewerChallengedNonGoal[].nonGoalHeading` —
   * headings only, since the ledger outcome is a short renderable summary,
   * not a duplicate of the full history entry (which carries the blocker
   * lineage id too).
   */
  reviewerChallengedNonGoal?: readonly string[];
}

/**
 * One row of `TaskProgress.roundLedger` — the sole lifecycle record of one
 * round, from its scheduled/open start to its terminal end. See the field's
 * own doc comment on `TaskProgress` for what distinguishes this from
 * `roundOutcomes`.
 */
export interface RoundLedgerEntryV1 {
  /** This row's own stable identity — the scheduling intent id for a row
   * created from an auto-start announcement, or the coordinator's
   * `operationId` for a row created from a manual/tracked dispatch. Never
   * reassigned once set. */
  roundId: string;
  /** The scheduling intent that announced this round, when it was
   * auto-started. Absent for a manually dispatched round. */
  intentId?: string;
  /** The coordinator's `operationId` for this round, attached once the
   * coordinator actually starts the operation (flips `state` from
   * `"scheduled"` to `"open"` in the same patch). Absent while still merely
   * `"scheduled"`. */
  operationId?: string;
  /** Every coordinator `attemptId` this round's operation allocated —
   * the initial attempt, any item-14 same-candidate retry, any fallback
   * candidate, and any transport-retry attempt. `resolveRoundV1` matches
   * against every entry, so a round may be looked up by any attempt it ever
   * made. */
  attemptIds: string[];
  /** This row's own `roundId` when this round is a recovery continuation OF
   * another round — the source round is itself terminal (`rejected`/
   * `failed`/`interrupted` with `outcome.continuationOwed: true`) by the time
   * this row exists; see `TaskProgress.roundLedger`'s doc comment. */
  continuationOf?: string;
  /** The stage this round ran against. */
  stage: TaskStage;
  /** What this round was dispatched to work from. */
  mode: RoundLedgerModeV1;
  /** ISO timestamp this row was created. */
  startedAt: string;
  /** Current lifecycle state — `"scheduled"`/`"open"` while live, one of the
   * seven terminal values once `terminalizeRoundV1` has run. */
  state: RoundLedgerStateV1;
  /** ISO timestamp `terminalizeRoundV1` set the terminal `state`. Absent
   * while `state` is `"scheduled"`/`"open"`. */
  endedAt?: string;
  /** Set only once `state` is terminal. */
  outcome?: RoundLedgerOutcomeV1;
  /**
   * Set once, well after this round already terminalized, when this row's
   * OWN checklist mutation (recorded as a `TaskProgress.checklistChangeProposals`
   * entry naming this row's `roundId` — see that type's own doc comment) is
   * later formalized into an actual plan revision (Part 6 items 5/19)
   * (2026-08-28 review fix, completion blocker: "the implementation does not
   * append or update a round-ledger event for 'Plan revised: N → M'" — the
   * durable record of that completion previously lived only on the proposal
   * itself and a best-effort chat line, never on the round ledger the plan
   * names as the sole lifecycle authority). Deliberately NOT one of this
   * row's own terminal facts: those are frozen the moment `terminalizeRoundV1`
   * sets them (this round's own `state`/`endedAt`/`outcome` describe what the
   * round itself did, during its own execution) — a plan revision is a human
   * decision and a later stage transition, which can happen minutes or days
   * afterward and is never part of what "the round did". Attaching it here
   * afterward, without amending any frozen field, mirrors the precedent
   * `operationId`'s own "attached once, never reassigned" contract already
   * establishes for post-hoc enrichment of a row. Absent for every row that
   * never mutated the checklist, and for one whose proposal was discarded
   * rather than adopted.
   */
  checklistRevisionAdopted?: ChecklistRevisionAdoptedV1;
}

/** `RoundLedgerEntryV1.checklistRevisionAdopted` — see that field's own doc
 * comment. Mirrors `ChecklistChangeProposalV1.resolvedAt`/`itemCountBefore`/
 * `itemCountAfter` (the proposal's own copy of the same fact) rather than
 * inventing a second shape for it. */
export interface ChecklistRevisionAdoptedV1 {
  /** ISO timestamp the revision was adopted — copied from the proposal's own
   * `resolvedAt` once the durable adoption write actually lands, never a
   * fresh timestamp of this annotation's own write (which may happen on a
   * later retry than the write that actually adopted the proposal). */
  readonly resolvedAt: string;
  /** Checklist `total` immediately before the revision's re-finalization merge. */
  readonly itemCountBefore?: number;
  /** Checklist `total` immediately after the revision's re-finalization merge. */
  readonly itemCountAfter?: number;
}

/** Cap on per-entry `blockers` length (a review with more is truncated). */
export const MAX_REVIEW_BLOCKER_IDENTITIES = 32;

/** Cap on `TaskProgress.reviewScoreHistory` length (oldest entries dropped first). */
export const MAX_REVIEW_SCORE_HISTORY = 200;

/** Reasons automated review iteration stopped and asked for a human decision. */
export type EscalationKind =
  | "plateau"
  | "spec-defect"
  | "environmental"
  | "unverifiable"
  | "reviewer-disagreement";

export interface TaskEscalation {
  stage: TaskStage;
  kind: EscalationKind;
  /** Human-readable explanation shown in chat/notifications. */
  reason: string;
  at: string;
  /**
   * True when this escalation followed a deliberate second-opinion attempt
   * (obtained-and-agreed, obtained-and-disagreed, or no alternate model was
   * available to try) — as opposed to a direct escalation with no attempt
   * at all. Explicit rather than inferred from `kind`, because a
   * second-opinion attempt can produce any of "environmental"/"spec-defect"
   * (agreement), "reviewer-disagreement", or "plateau" (no candidate
   * available) — `kind` alone can't distinguish "already tried" from "never
   * tried" the way a single boolean can. Used to cap second-opinion rounds
   * at one per plateau (see secondOpinionTriedThisPlateau in reviewActions.ts).
   */
  secondOpinionAttempted?: boolean;
}

/**
 * Cap on `TaskProgress.overriddenEscalations` length (oldest entries dropped
 * first) — same rationale and size as `MAX_REVIEW_REJECTIONS`.
 */
export const MAX_OVERRIDDEN_ESCALATIONS = 50;

/**
 * The filename for the task progress tracking file
 */
export const TASK_PROGRESS_FILENAME = "task-progress.json";

/**
 * Order of stages for determining workflow progression
 */
export const STAGE_ORDER: readonly TaskStage[] = [
  "desc",
  "plan",
  "plan-high-review",
  "plan-low-review",
  "impl",
  "impl-high-review",
  "impl-low-review",
  "publish",
] as const;

export const PUBLISH_STAGE: TaskStage = "publish";

/**
 * Human-readable names for each stage
 */
export const STAGE_DISPLAY_NAMES: Record<TaskStage, string> = {
  desc: "Task Description",
  plan: "Plan",
  "plan-high-review": "High-Level Review (Plan)",
  "plan-low-review": "Low-Level Review (Plan)",
  impl: "Implementation",
  "impl-high-review": "High-Level Code Review",
  "impl-low-review": "Low-Level Code Review",
  publish: "Publish",
};

/**
 * The markdown artifact each stage produces. "completed" has none.
 */
export const STAGE_ARTIFACT_FILENAMES: Record<TaskStage, string | undefined> =
  {
    desc: TASK_FILENAME,
    plan: PLAN_FILENAME,
    "plan-high-review": "plan-high-review.md",
    "plan-low-review": "plan-low-review.md",
    impl: IMPLEMENTATION_FILENAME,
    "impl-high-review": "impl-high-review.md",
    "impl-low-review": "impl-low-review.md",
    publish: "publish-review.md",
  };

/** One artifact deliberately accepted as absent by a human completion override. */
export interface CompletedWithMissingArtifactV1 {
  readonly stage: TaskStage;
  readonly artifact: string;
  readonly at: string;
  readonly override: "user";
}

export const PLAN_REVIEW_STAGES: readonly TaskStage[] = [
  "plan-high-review",
  "plan-low-review",
] as const;

export const IMPL_REVIEW_STAGES: readonly TaskStage[] = [
  "impl-high-review",
  "impl-low-review",
] as const;

/**
 * The stages that are review stages, in which the review actions
 * (view / apply / next stage) are available.
 */
export const REVIEW_STAGES: readonly TaskStage[] = [
  "plan-high-review",
  "plan-low-review",
  "impl-high-review",
  "impl-low-review",
  "publish",
] as const;

/**
 * Stages that execute an AI run and therefore can have per-stage model
 * selection configured.
 */
export const AI_MODEL_STAGES: readonly TaskStage[] = [
  "desc",
  "plan",
  "plan-high-review",
  "plan-low-review",
  "impl",
  "impl-high-review",
  "impl-low-review",
  "publish",
] as const;

/**
 * Whether a stage is one of the four review stages
 */
export function isReviewStage(stage: TaskStage): boolean {
  return REVIEW_STAGES.includes(stage);
}

/**
 * Whether a review stage reviews the plan (vs the implementation)
 */
export function isPlanReviewStage(stage: TaskStage): boolean {
  return stage === "plan-high-review" || stage === "plan-low-review";
}

/**
 * Stage names used by older versions, mapped onto the current pipeline.
 * - "created" / "Task Created" -> "task-description"
 * - "plan-final" -> "implementation"  (merged stage)
 * - "plan-review" etc. -> legacy review names
 */
const LEGACY_STAGE_MAP: Record<string, TaskStage> = {
  // Pre-"task-description" rename
  created: "desc",
  "task-description": "desc",
  // Pre-merge of final-plan + implementation
  "plan-final": "impl",
  implementation: "impl",
  // Very old stage names from pre-0.6.0
  "plan-review": "plan-high-review",
  "plan-updated": "plan-high-review",
  "plan-updated-review": "plan-low-review",
};

/**
 * Normalize a stage value read from disk: current stage names pass through,
 * legacy names are migrated, and anything unrecognized falls back to
 * "task-description" so a corrupt file never breaks the workflow.
 */
export function migrateStage(stage: string): TaskStage {
  if ((STAGE_ORDER as readonly string[]).includes(stage)) {
    return stage as TaskStage;
  }
  const legacy = LEGACY_STAGE_MAP[stage];
  if (legacy) {
    return legacy;
  }
  return "desc";
}

/**
 * Normalize a status value read from disk. Missing or invalid -> "active".
 */
export function migrateStatus(status: unknown): TaskStatus {
  if (status === "creating" || status === "active" || status === "paused" || status === "completed" || status === "archived") {
    return status;
  }
  // Older task files used `finished` for the explicit completion state.
  if (status === "finished" || status === "done") return "completed";
  return "active";
}
