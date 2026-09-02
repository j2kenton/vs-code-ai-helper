/**
 * Task/progress schema (Part 2 port of `src/types/taskProgress.ts`).
 *
 * Transport-agnostic types and constants only — the extension keeps its own
 * copy under `src/` and never imports this package; the dual-decode
 * conformance suite (tests/conformance.test.ts) is the drift detector
 * between the two. The permissive `migrateStage`/`migrateStatus` helpers are
 * deliberately NOT ported: this package carries only the strict stack
 * (taskProgressDecoderV1.ts), and the closed legacy alias tables live there.
 */

/** The workflow stages, in pipeline order. */
export type TaskStage =
  | "desc"
  | "plan"
  | "plan-high-review"
  | "plan-low-review"
  | "impl"
  | "impl-high-review"
  | "impl-low-review"
  | "publish";

/** Task lifecycle status values. */
export type TaskStatus = "creating" | "active" | "paused" | "completed" | "archived";

/** Authoritative list of every persisted task status, in display order. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "creating",
  "active",
  "paused",
  "completed",
  "archived",
];

/** Order of stages for determining workflow progression. */
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

/** Human-readable names for each stage. */
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

export const REVIEW_STAGES: readonly TaskStage[] = [
  "plan-high-review",
  "plan-low-review",
  "impl-high-review",
  "impl-low-review",
  "publish",
] as const;

/** Whether a stage is one of the review stages. */
export function isReviewStage(stage: TaskStage): boolean {
  return REVIEW_STAGES.includes(stage);
}

/** Whether a review stage reviews the plan (vs the implementation). */
export function isPlanReviewStage(stage: TaskStage): boolean {
  return stage === "plan-high-review" || stage === "plan-low-review";
}

/** The filename for the task progress tracking file. */
export const TASK_PROGRESS_FILENAME = "task-progress.json";

/**
 * Persisted lint-state payload for a completed task.
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
  failedChecks?: Array<{ command: string; exitCode: number; output: string; retryCount?: number }>;
  /**
   * Where this payload came from. `"publish"` (the default when absent, for
   * backward compatibility) means a real Publish attempt ran the checks.
   * `"review"` means a Publish-stage review computed this while building its
   * prompt variables — real, ground-truth check results, but possibly
   * against a stale Publish scope compared to what an actual publish attempt
   * would resolve. See the extension's `src/types/taskProgress.ts` for full
   * commentary.
   */
  source?: "publish" | "review";
}

/**
 * Tracks the progress of a task through the planning workflow. Field-level
 * semantics match the extension's `TaskProgress` declaration exactly; see
 * `src/types/taskProgress.ts` for the full per-field commentary.
 */
export interface TaskProgress {
  /** The task folder name (e.g., "2025-12-01_task_1") */
  taskFolder: string;
  /** User-facing task label. Folder names stay stable so ordering/IDs do not change. */
  displayName?: string;
  /** True until the generated default label is replaced by a user or AI summary. */
  nameIsDefault?: boolean;
  /** Current stage in the workflow */
  currentStage: TaskStage;
  /** Task status. Missing = active for backward compat. */
  status?: TaskStatus;
  /** Set when the task is explicitly completed; survives resume as inert metadata. */
  completedAt?: string;
  /** The lifecycle status the task had when it was archived. */
  archivedFrom?: TaskStatus;
  /** ISO timestamp of when the task was pinned. Present only while pinned. */
  pinnedAt?: string;
  /** Workspace-relative project root the Publish stage verifies against. */
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
   * Monotonic optimistic-concurrency token, owned entirely by the extension's
   * `patchTaskProgressStrictV1` (wf10 item 8). Mirrors `src/types/taskProgress.ts`
   * exactly; see that definition for the full rationale. Absent on any record
   * that predates this field or on brand-new tasks before their first patch.
   */
  progressVersion?: number;
  /** Workspace-relative paths changed across all AI implementation runs. */
  implReviewFiles?: string[];
  /**
   * The highest `sizeBandV1` quarter (0-4) of `task.md`'s byte size against
   * `MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1` already announced to the user.
   * Mirrors `src/types/taskProgress.ts` exactly — durable so the "once per
   * band" guarantee survives chat-history compaction. Set only when a fresh
   * band is crossed; never decreases even if task.md later shrinks.
   */
  taskMdSizeBandAnnounced?: number;
  /** Persisted lint state for this task. */
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
  /** Per-round review score trail. */
  reviewScoreHistory?: ReviewScoreHistoryEntry[];
  /** Durable record of review rounds rejected as degenerate. */
  reviewRejections?: ReviewRejectionEntry[];
  /** Durable record of blockers a human resolved via this task's own stage
   * chat (mirror of `src/types/taskProgress.ts`). Capped at
   * MAX_BLOCKER_SUPERSESSIONS (oldest dropped). */
  blockerSupersessions?: BlockerSupersessionRecordV1[];
  /** Durable, fixed-vocabulary record of what each round that reached
   * completion accounting actually produced (mirror of
   * `src/types/taskProgress.ts`). Persisted only at round-completion-
   * accounting time; runner-level failures (quota, unavailable, skipped
   * candidate) never reach that accounting and are not recorded here.
   * Capped at MAX_ROUND_OUTCOMES (oldest dropped). */
  roundOutcomes?: RoundOutcomeEntryV1[];
  /**
   * The sole lifecycle authority for a round, start to end (mirror of
   * `src/types/taskProgress.ts`): every round the task ever starts gets
   * exactly one row here, created either from a scheduling intent
   * (`roundId = intentId`, `state: "scheduled"`) or from the coordinator's
   * manual-dispatch `operationId` (`state: "open"`), and ended exactly once
   * by `terminalizeRoundV1`. Distinct from `roundOutcomes` above: that is a
   * CLASSIFICATION record written only for rounds that reach completion
   * accounting; this is a LIFECYCLE record covering every round regardless
   * of how it ends. Capped at MAX_ROUND_LEDGER_ENTRIES (oldest dropped
   * first).
   */
  roundLedger?: RoundLedgerEntryV1[];
  /** Durable record of a round that tried to add, remove, or renumber a
   * checklist item in `plan-final.md` (mirror of `src/types/taskProgress.ts`).
   * Capped at MAX_CHECKLIST_CHANGE_PROPOSALS (oldest dropped first). */
  checklistChangeProposals?: ChecklistChangeProposalV1[];
  /** Set while a checklist-mutation proposal is being turned into an actual
   * `plan-final.md` revision (mirror of `src/types/taskProgress.ts`). */
  planRevision?: PlanRevisionStateV1;
  /** Set when automated review iteration needs a human decision. */
  escalation?: TaskEscalation;
  /** Durable record of every escalation Fast Forward rode through rather than
   * aborting for, instead of acting on it. Append-only, capped at
   * MAX_OVERRIDDEN_ESCALATIONS (oldest dropped). */
  overriddenEscalations?: TaskEscalation[];
  /** Set when a post-implementation type-check failed on a round that changed files. */
  implementationTypeCheckFailure?: ImplementationTypeCheckFailure;
  /** True once a round completed work the plan checklist could not record. */
  checklistProgressUnreliable?: boolean;
  /** Plain-language reason `checklistProgressUnreliable` was set (task:
   * "Actionable Hand-offs" PART 5) — surfaced by the reconciliation decision
   * so the discriminating fact (why the ticks were distrusted) is available,
   * not only the weaker unticked-item count. Absent on records written
   * before this field existed. */
  checklistProgressUnreliableReason?: string;
  /** Consecutive completed implementation rounds (current stage) that changed
   * zero files — durable no-progress-breaker counter; persists across
   * reloads/rounds, reset on a file-changing round or stage transition. */
  zeroChangeImplRounds?: number;
  /** Workspace-relative paths changed by an implementation round detected as
   * INCOMPLETE (deferred/cut short), quarantined instead of banked into
   * `implReviewFiles`; promoted by the next successful round. */
  pendingImplReviewFiles?: string[];
  /** Set when an incomplete round changed the tree after a review stage's
   * artifact was written; the artifact's content is preserved but no longer
   * describes the workspace. */
  reviewInvalidatedByRound?: ReviewInvalidatedByRound;
  /** Count of incomplete (deferred/cut-short) implementation rounds since the
   * last successful round; bounds the automatic continuation loop. */
  incompleteRoundContinuations?: number;
  /** WHY the task is paused, for a workflow-imposed pause (e.g. an exhausted
   * provider chain). Meaningful only while `status === "paused"`; cleared by
   * any status change away from paused. */
  pausedReason?: string;
  /** Durable record that an implementation round finished without a usable
   * report and a recovery continuation is owed. See the extension's
   * `src/types/taskProgress.ts` for the full state-machine commentary. */
  implRecovery?: ImplRecoveryV1;
  /** Durable record that a stage was blocked by a quota/model-entitlement
   * failure (mirror of `src/types/taskProgress.ts`). See the extension's
   * copy for the full state-machine commentary. */
  quotaParkRecord?: QuotaParkRecordV1;
}

/** One artifact deliberately accepted as absent by a human completion override. */
export interface CompletedWithMissingArtifactV1 {
  readonly stage: TaskStage;
  readonly artifact: string;
  readonly at: string;
  readonly override: "user";
}

/** `TaskProgress.quotaParkRecord` — mirror of `src/types/taskProgress.ts`. */
export interface QuotaParkRecordV1 {
  /** The model id that hit the failure. */
  modelId: string;
  /** The resolved provider id that reported the failure. */
  providerId: string;
  /** Account/credential context the failure was observed under, when known. */
  accountKey?: string;
  /** Narrowed to the two failure kinds "resets at" language applies to. */
  failureKind: "quota" | "model-entitlement";
  /** ISO instant the provider reported the limit will lift. */
  resetAt?: string;
  /** ISO instant the failure was observed. */
  observedAt: string;
}

/** How the round that triggered an `implRecovery` failed to report. */
export type ImplRecoveryTriggerV1 =
  | "roundDeferred"
  | "roundIncomplete"
  | "summaryRejected";

/** The continuation constraint recovery was begun under (mirror of
 * `src/types/taskProgress.ts`). */
export type ImplRecoveryModeV1 =
  | "summary-only"
  | "inspect-and-complete"
  | "unconstrained";

/** Dispatch state of the owed recovery continuation. */
export type ImplRecoveryDispatchStateV1 = "pending" | "dispatched";

/**
 * What an implementation round was actually working from (mirror of
 * `src/types/taskProgress.ts`) — distinguishes a checklist-driven
 * Implementation round from a review-driven Apply Review round from a
 * recovery continuation of either.
 */
export type ImplementationDispatchModeV1 =
  | "implementation"
  | "apply-review"
  | "continuation";

/** `RoundLedgerEntryV1.mode`'s value space — a strict superset of
 * `ImplementationDispatchModeV1` (mirror of `src/types/taskProgress.ts`);
 * adds `"review"` for rows recorded at a review stage, which none of the
 * three implementation-only values fit. Kept as its own type so the OTHER
 * fields typed `ImplementationDispatchModeV1` (genuinely implementation-only)
 * cannot silently accept it. */
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
  /** "pending" until an implementation round claims the continuation. */
  dispatch: ImplRecoveryDispatchStateV1;
  /** ISO timestamp recovery was recorded. */
  at: string;
  /** True when the triggering round's change set could not be enumerated. */
  filesChangedUnknown?: boolean;
  /** Continuation attempt token, set when `dispatch` flips to "dispatched". */
  attemptId?: string;
  /** Same lease semantics as `scheduledRun`: one window arms the dispatch. */
  leaseOwner?: string;
  leaseUntil?: string;
  /** Dispatch mode of the round that triggered this recovery (mirror of
   * `src/types/taskProgress.ts`). Absent for recoveries recorded before this
   * field existed; treat absence as `"implementation"`. */
  sourceDispatchMode?: ImplementationDispatchModeV1;
  /** The review stage whose blockers the source `"apply-review"` round was
   * applying (mirror of `src/types/taskProgress.ts`). Only meaningful when
   * `sourceDispatchMode === "apply-review"`. */
  sourceReviewStage?: TaskStage;
  /** The `roundLedger` row id terminalized as the source round (mirror of
   * `src/types/taskProgress.ts`). Absent for a record persisted before this
   * field existed. */
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
 * implementation rounds before escalating to the human (mirror of
 * `src/types/taskProgress.ts`).
 */
export const MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 = 3;

/** `TaskProgress.implementationTypeCheckFailure` — one round's failing type-check. */
export interface ImplementationTypeCheckFailure {
  /** ISO timestamp the failing type-check was recorded. */
  at: string;
  /** Truncated compiler/build output, for display. */
  output: string;
}

/** Stable identity of one reported blocker, persisted per review round. */
export interface ReviewBlockerIdentity {
  category: string;
  resolver: string;
  /** File-ish token named by the blocker when one exists, else a normalized prose prefix. */
  subject: string;
  /** Opaque stable id, carried forward across rounds via reviewer-declared
   * lineage (absent on older entries). See the mirrored doc in
   * src/types/taskProgress.ts. */
  id?: string;
  /** This round's declared lineage against its own prior blocker list,
   * absent when unknown. See the mirrored doc in src/types/taskProgress.ts. */
  lineage?: BlockerLineageDeclaration;
  /** Truncated original description, for re-review prompt context only —
   * never used for identity comparisons. */
  description?: string;
  /** Carried forward from `ReviewBlocker.origin` (mirror of
   * `src/types/taskProgress.ts`): `"reviewer"` for a blocker the AI reviewer
   * itself raised in prose, `"mechanical"` for one synthesized directly from
   * a failed Verified Check. Absent on entries written before this field
   * existed. */
  origin?: "reviewer" | "mechanical";
}

/** One blocker a round re-raised that matches a `plan-final.md`
 * `## Accepted Non-Goals` entry (mirror of `src/types/taskProgress.ts`). */
export interface ReviewerChallengedNonGoalV1 {
  /** The stable blocker lineage id (`ReviewBlockerIdentity.id`) of the
   * re-raised blocker, when one could be resolved. */
  readonly blockerId?: string;
  /** The `## Accepted Non-Goals` sub-heading (or the section heading itself,
   * for a plan with no sub-headings) the blocker matched. */
  readonly nonGoalHeading: string;
}

/** See `ReviewBlockerIdentity.lineage`; mirrors src/types/taskProgress.ts. */
export type BlockerLineageDeclaration =
  | { kind: "new" }
  | { kind: "same"; refId: string }
  | { kind: "narrowed"; refId: string };

/** One row of `TaskProgress.reviewScoreHistory`. */
export interface ReviewScoreHistoryEntry {
  stage: TaskStage;
  /** Parsed `Readiness: N/10`, or null if the round produced no parseable score. */
  score: number | null;
  /** The reviewAttemptId that produced this round. */
  attemptId: string;
  /** ISO timestamp when this round's review was published. */
  at: string;
  /** Total classified blockers found by the reviewer this round. */
  blockerCount: number;
  /** Of those, how many were classified as fixable by another implementation round. */
  taskFixableCount: number;
  /** Stable identities of this round's blockers (absent on older entries). */
  blockers?: ReviewBlockerIdentity[];
  /** Identity of the provider/model that actually produced this round's
   * review (absent on older entries). See the mirrored doc in
   * src/types/taskProgress.ts. */
  reviewer?: ReviewerIdentityV1;
  /** Stable identities of blockers this round reported that were EXCLUDED
   * from `blockerCount`/`taskFixableCount`/`blockers` because they matched a
   * `plan-final.md` `## Accepted Non-Goals` entry (mirror of
   * `src/types/taskProgress.ts`). Absent when nothing was superseded this
   * round. */
  supersededBlockers?: ReviewBlockerIdentity[];
  /** Every blocker this round re-raised that matches an Accepted Non-Goals
   * entry (mirror of `src/types/taskProgress.ts`). Absent when nothing
   * matched. */
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
  /** The reviewAttemptId of the rejected round. */
  attemptId: string;
  /** ISO timestamp when the round was rejected. */
  at: string;
  /** Why the round was rejected. */
  reason: string;
}

/** Cap on `TaskProgress.reviewRejections` length (oldest entries dropped first). */
export const MAX_REVIEW_REJECTIONS = 50;

/** One row of `TaskProgress.blockerSupersessions` (mirror of
 * `src/types/taskProgress.ts`) — a blocker a human resolved via this task's
 * own stage chat, recorded the moment the confirmable `plan.md` edit lands. */
export interface BlockerSupersessionRecordV1 {
  /** The plan-review stage the superseded blocker was recorded against. */
  stage: TaskStage;
  /** The blocker's own description text, exactly as parsed from the review
   * artifact at the moment it was declared resolved. */
  blockerDescription: string;
  /** ISO timestamp the confirmable plan.md edit was actually applied. */
  supersededAt: string;
  /** Task-folder-relative path of the file the resolving decision was
   * written to (currently always `plan.md`). */
  planRelPath: string;
  /** ISO timestamp of the assistant chat message that proposed the confirmed
   * edit — the pointer to the confirming chat exchange. Optional only so a
   * record from before this field existed remains decodable. */
  confirmingMessageAt?: string;
  /** Where this supersession came from (mirror of
   * `src/types/taskProgress.ts`). Absent decodes as `"chat-confirmed"` —
   * every record written before this field existed came from the stage-chat
   * resolution path, the only one that existed then. */
  source?: "chat-confirmed" | "plan-non-goal";
}

/** Cap on `TaskProgress.blockerSupersessions` length (oldest entries dropped first). */
export const MAX_BLOCKER_SUPERSESSIONS = 50;

/** One row of `TaskProgress.checklistChangeProposals` (mirror of
 * `src/types/taskProgress.ts`). */
export interface ChecklistChangeProposalV1 {
  /** ISO timestamp the mutation was caught and reverted. */
  at: string;
  /** This round's own round-ledger row identity. */
  roundId: string;
  /** The stage the round was dispatched at when it mutated the checklist. */
  stage: TaskStage;
  /** How the item set changed, before it was reverted. */
  kind: "added" | "removed" | "renumbered";
  /** The item texts the round tried to add (for `"added"`/`"renumbered"`). */
  proposedItems: readonly string[];
  /** The item texts the round's edit dropped (for `"removed"`/`"renumbered"`). */
  removedItems: readonly string[];
  /** `"pending"` until a `checklistChangeProposed` decision is answered;
   * `"revising"` while a chosen plan revision is in flight; `"discarded"` if
   * the user declined the proposal; `"adopted"` once a revision
   * incorporating it lands. */
  status: "pending" | "revising" | "discarded" | "adopted";
  /** ISO timestamp the entry was marked `"adopted"` (mirror of
   * `src/types/taskProgress.ts`). */
  resolvedAt?: string;
  /** Checklist total immediately before this revision's re-finalization
   * merge (mirror of `src/types/taskProgress.ts`). */
  itemCountBefore?: number;
  /** Checklist total immediately after this revision's re-finalization
   * merge (mirror of `src/types/taskProgress.ts`). */
  itemCountAfter?: number;
  /** Whether the ledger annotation for this adoption landed atomically with
   * `resolvedAt` (mirror of `src/types/taskProgress.ts`). Set `true` only
   * when the row was found and annotated; `false` when adoption succeeded
   * but the row named by `roundId` no longer exists in `roundLedger`
   * (evicted by its own cap). Absent only when the proposal has not yet been
   * adopted. */
  ledgerAnnotated?: boolean;
}

/** Cap on `TaskProgress.checklistChangeProposals` length (oldest entries dropped first). */
export const MAX_CHECKLIST_CHANGE_PROPOSALS = 50;

/** `TaskProgress.planRevision` (mirror of `src/types/taskProgress.ts`) — set
 * by `applyPlanRevisionPolicyV1` when a caught checklist-mutation proposal is
 * turned into an actual plan revision. */
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
  /** The revision-owned journal snapshot's filename, relative to the task
   * folder (mirror of `src/types/taskProgress.ts`). */
  readonly journaledPlanRef?: string;
}

/**
 * Fixed-vocabulary outcome of a completed round (mirror of
 * `src/types/taskProgress.ts`):
 *  - `edits-produced`: the round changed files, or landed checklist ticks.
 *  - `genuine-no-op`: zero files changed, justified — no work was needed.
 *  - `provider-failure-empty`: zero files changed on a task with unticked
 *    checklist items and a review naming live blockers — the same shape
 *    previously recorded, indistinguishably, as a success.
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
   * occurred). Absent for older entries written before this field existed;
   * treat absence as "unknown candidate", never as a match.
   */
  modelId?: string;
  /**
   * The runner id (`runnerId`) the candidate that actually produced this
   * round ran under — e.g. `"claude-cli"`, `"codex-cli"`, or `"copilot-lm"`
   * for every Copilot dispatch (Copilot is routed exclusively through the
   * sealed two-phase pipeline, so `"copilot-lm"` already IS the
   * sealed-vs-direct distinction). Candidate identity for the breaker/
   * health-window checks is the full provider path (provider id + model
   * id), not `modelId` alone. Absent for entries written before this field
   * existed; treat absence as "unknown provider", never as a match.
   */
  providerId?: string;
  /** What the round was dispatched to work from (mirror of
   * `src/types/taskProgress.ts`). Absent for entries written before this
   * field existed; treat absence as unknown, never as `"implementation"` by
   * default. */
  dispatchMode?: ImplementationDispatchModeV1;
  /** The impl-review stage the task actually displayed when this round was
   * dispatched, set only on rows bookkept under the literal `stage: "impl"`
   * (mirror of `src/types/taskProgress.ts`). Absent for rows not bookkept
   * that way and for rows written before this field existed. */
  originatingReviewStage?: TaskStage;
}

/** Cap on `TaskProgress.roundOutcomes` length (oldest entries dropped first). */
export const MAX_ROUND_OUTCOMES = 50;

/** Cap on `TaskProgress.roundLedger` length (oldest TERMINAL rows dropped first). */
export const MAX_ROUND_LEDGER_ENTRIES = 200;

/** `TaskProgress.roundLedger`'s lifecycle states (mirror of
 * `src/types/taskProgress.ts`): `"scheduled"` and `"open"` are the two live
 * states; every other value is terminal and, once set, may never change. */
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

/** The durable outcome recorded on a terminalized `RoundLedgerEntryV1`
 * (mirror of `src/types/taskProgress.ts`). */
export interface RoundLedgerOutcomeV1 {
  /** Paths changed by this round, when known. */
  filesChanged?: readonly string[];
  /** True when a round DID change files but the exact set could not be enumerated. */
  filesChangedUnknown?: boolean;
  /** A review round's score out of 10, when this row is a review. */
  score?: number;
  /** A review round's blocker count actually raised by the reviewer. */
  reviewerBlockers?: number;
  /** A review round's blocker count synthesized from failing checks. */
  mechanicalBlockers?: number;
  /** Why a round's summary was rejected, for `state: "rejected"`. */
  rejectionReason?: string;
  /** True when ending this round left a recovery continuation owed. */
  continuationOwed?: boolean;
  /** Workspace-relative path of this round's run log, when one was written. */
  runLogPath?: string;
  /** Correlates this row with its `TaskProgress.roundOutcomes` classification
   * entry (matched by `attemptId`), when this round also went through
   * completion accounting. */
  roundOutcomeAttemptId?: string;
  /** Headings of `## Accepted Non-Goals` entries this review round re-raised
   * a blocker against (mirror of `src/types/taskProgress.ts`). */
  reviewerChallengedNonGoal?: readonly string[];
}

/** One row of `TaskProgress.roundLedger` — the sole lifecycle record of one
 * round, from its scheduled/open start to its terminal end (mirror of
 * `src/types/taskProgress.ts`). */
export interface RoundLedgerEntryV1 {
  /** This row's own stable identity. Never reassigned once set. */
  roundId: string;
  /** The scheduling intent that announced this round, when it was auto-started. */
  intentId?: string;
  /** The coordinator's `operationId` for this round. */
  operationId?: string;
  /** Every coordinator `attemptId` this round's operation allocated. */
  attemptIds: string[];
  /** This row's own `roundId` when this round is a recovery continuation OF another round. */
  continuationOf?: string;
  /** The stage this round ran against. */
  stage: TaskStage;
  /** What this round was dispatched to work from. */
  mode: RoundLedgerModeV1;
  /** ISO timestamp this row was created. */
  startedAt: string;
  /** Current lifecycle state. */
  state: RoundLedgerStateV1;
  /** ISO timestamp `terminalizeRoundV1` set the terminal `state`. */
  endedAt?: string;
  /** Set only once `state` is terminal. */
  outcome?: RoundLedgerOutcomeV1;
  /** Set once, well after this round already terminalized, when this row's
   * own checklist mutation is later formalized into an actual plan revision
   * (mirror of `src/types/taskProgress.ts`). Absent for every row that never
   * mutated the checklist, and for one whose proposal was discarded rather
   * than adopted. */
  checklistRevisionAdopted?: ChecklistRevisionAdoptedV1;
}

/** `RoundLedgerEntryV1.checklistRevisionAdopted` — see that field's own doc
 * comment (mirror of `src/types/taskProgress.ts`). */
export interface ChecklistRevisionAdoptedV1 {
  /** ISO timestamp the revision was adopted — copied from the proposal's own
   * `resolvedAt`. */
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
  /** True when this escalation followed a deliberate second-opinion attempt. */
  secondOpinionAttempted?: boolean;
}

/** Cap on `TaskProgress.overriddenEscalations` length (oldest entries dropped
 * first) — same rationale and size as `MAX_REVIEW_REJECTIONS`. */
export const MAX_OVERRIDDEN_ESCALATIONS = 50;
