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
  failedChecks?: Array<{ command: string; exitCode: number; output: string }>;
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
   * Set when automated review iteration determined it cannot make further
   * progress on its own and needs a human decision. Cleared on the next
   * stage transition and whenever the user explicitly resumes iteration.
   */
  escalation?: TaskEscalation;
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
}

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
}

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
