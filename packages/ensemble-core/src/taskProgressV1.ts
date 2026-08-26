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
}

/** Cap on `TaskProgress.blockerSupersessions` length (oldest entries dropped first). */
export const MAX_BLOCKER_SUPERSESSIONS = 50;

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
}

/** Cap on `TaskProgress.roundOutcomes` length (oldest entries dropped first). */
export const MAX_ROUND_OUTCOMES = 50;

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
