/**
 * Represents the different stages in the task workflow:
 * task description, plan drafting, plan reviews, implementation (merged
 * from old final-plan + implementation stages), and implementation reviews.
 */
export type TaskStage =
  | "task-description"
  | "plan"
  | "plan-high-review"
  | "plan-low-review"
  | "implementation"
  | "impl-high-review"
  | "impl-low-review"
  | "completed";

/**
 * Task status values.
 */
export type TaskStatus = "active" | "paused";

/**
 * The filename for the task request/scope artifact
 */
export const TASK_FILENAME = "task.md";

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
}

/**
 * Tracks the progress of a task through the planning workflow
 */
export interface TaskProgress {
  /** The task folder name (e.g., "2025-12-01_task_1") */
  taskFolder: string;
  /** Current stage in the workflow */
  currentStage: TaskStage;
  /** Task status: active or paused. Missing = active for backward compat. */
  status?: TaskStatus;
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
}

/**
 * The filename for the task progress tracking file
 */
export const TASK_PROGRESS_FILENAME = "task-progress.json";

/**
 * Order of stages for determining workflow progression
 */
export const STAGE_ORDER: readonly TaskStage[] = [
  "task-description",
  "plan",
  "plan-high-review",
  "plan-low-review",
  "implementation",
  "impl-high-review",
  "impl-low-review",
  "completed",
] as const;

/**
 * Human-readable names for each stage
 */
export const STAGE_DISPLAY_NAMES: Record<TaskStage, string> = {
  "task-description": "Task Description",
  plan: "Plan",
  "plan-high-review": "Plan: High-Level Review",
  "plan-low-review": "Plan: Low-Level Review",
  implementation: "Implementation",
  "impl-high-review": "Implementation: High-Level Review",
  "impl-low-review": "Implementation: Low-Level Review",
  completed: "Completed",
};

/**
 * The markdown artifact each stage produces. "completed" has none.
 */
export const STAGE_ARTIFACT_FILENAMES: Record<TaskStage, string | undefined> =
  {
    "task-description": TASK_FILENAME,
    plan: PLAN_FILENAME,
    "plan-high-review": "plan-high-review.md",
    "plan-low-review": "plan-low-review.md",
    implementation: IMPLEMENTATION_FILENAME,
    "impl-high-review": "impl-high-review.md",
    "impl-low-review": "impl-low-review.md",
    completed: undefined,
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
] as const;

/**
 * Stages that execute an AI run and therefore can have per-stage model
 * selection configured.
 */
export const AI_MODEL_STAGES: readonly TaskStage[] = [
  "task-description",
  "plan",
  "plan-high-review",
  "plan-low-review",
  "implementation",
  "impl-high-review",
  "impl-low-review",
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
  created: "task-description",
  // Pre-merge of final-plan + implementation
  "plan-final": "implementation",
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
  return "task-description";
}

/**
 * Normalize a status value read from disk. Missing or invalid -> "active".
 */
export function migrateStatus(status: unknown): TaskStatus {
  if (status === "active" || status === "paused") {
    return status;
  }
  return "active";
}
