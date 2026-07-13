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
export type TaskStatus = "creating" | "active" | "paused" | "completed";

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
  /** Set when the task is explicitly completed; stage advancement never sets it. */
  completedAt?: string;
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
   * see `updateImplReviewFiles`. Sorted alphabetically. Used as the primary
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
  /** ISO timestamp when the task is scheduled to resume */
  scheduledResumeTime?: string;
  /** Pending notes by stage */
  pendingNotes?: Partial<Record<TaskStage, string>>;
  /** Active fallback state by stage */
  fallbackActive?: Partial<Record<TaskStage, boolean>>;
  /** Monotonic token identifying the review run allowed to finalize this stage. */
  reviewAttemptId?: string;
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
  if (status === "creating" || status === "active" || status === "paused" || status === "completed") {
    return status;
  }
  // Older task files used `finished` for the explicit completion state.
  if (status === "finished" || status === "done") return "completed";
  return "active";
}
