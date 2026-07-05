/**
 * Represents the different stages in the task workflow:
 * plan drafting, plan reviews, final plan, implementation, and
 * implementation reviews.
 */
export type TaskStage =
  | "created"
  | "plan"
  | "plan-high-review"
  | "plan-low-review"
  | "plan-final"
  | "implementation"
  | "impl-high-review"
  | "impl-low-review"
  | "completed";

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
 * The filename for the generated context pack artifact
 */
export const CONTEXT_PACK_FILENAME = "context-pack.md";

/**
 * The directory name for per-run agent logs
 */
export const RUNS_DIRNAME = "runs";

/**
 * Tracks the progress of a task through the planning workflow
 */
export interface TaskProgress {
  /** The task folder name (e.g., "2025-12-01_task_1") */
  taskFolder: string;
  /** Current stage in the workflow */
  currentStage: TaskStage;
  /** ISO timestamp when the task was created */
  createdAt: string;
  /** ISO timestamp when the progress was last updated */
  updatedAt: string;
}

/**
 * The filename for the task progress tracking file
 */
export const TASK_PROGRESS_FILENAME = "task-progress.json";

/**
 * Order of stages for determining workflow progression
 */
export const STAGE_ORDER: readonly TaskStage[] = [
  "created",
  "plan",
  "plan-high-review",
  "plan-low-review",
  "plan-final",
  "implementation",
  "impl-high-review",
  "impl-low-review",
  "completed",
] as const;

/**
 * Human-readable names for each stage
 */
export const STAGE_DISPLAY_NAMES: Record<TaskStage, string> = {
  created: "Task Created",
  plan: "Plan",
  "plan-high-review": "Plan: High-Level Review",
  "plan-low-review": "Plan: Low-Level Review",
  "plan-final": "Final Plan",
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
    created: TASK_FILENAME,
    plan: PLAN_FILENAME,
    "plan-high-review": "plan-high-review.md",
    "plan-low-review": "plan-low-review.md",
    "plan-final": "plan-final.md",
    implementation: "implementation.md",
    "impl-high-review": "impl-high-review.md",
    "impl-low-review": "impl-low-review.md",
    completed: undefined,
  };

/**
 * The stages that are review stages, in which the review actions
 * (view / reply / apply / next stage) are available.
 */
export const REVIEW_STAGES: readonly TaskStage[] = [
  "plan-high-review",
  "plan-low-review",
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
 * The reply artifact filename for a review stage (the user's response to a
 * review, fed to the AI alongside the review when applying it), or
 * undefined for non-review stages.
 */
export function getReviewReplyFilename(stage: TaskStage): string | undefined {
  const artifact = STAGE_ARTIFACT_FILENAMES[stage];
  if (!artifact || !isReviewStage(stage)) {
    return undefined;
  }
  return artifact.replace(/\.md$/, "-reply.md");
}

/**
 * Stage names used by versions before 0.6.0, mapped onto the current
 * pipeline. "plan-updated" collapses into the high-level review loop (the
 * plan had been revised after the first review) and "plan-updated-review"
 * maps to the low-level (second-round) review.
 */
const LEGACY_STAGE_MAP: Record<string, TaskStage> = {
  "plan-review": "plan-high-review",
  "plan-updated": "plan-high-review",
  "plan-updated-review": "plan-low-review",
};

/**
 * Normalize a stage value read from disk: current stage names pass through,
 * pre-0.6.0 names are migrated, and anything unrecognized falls back to
 * "created" so a corrupt file never breaks the workflow.
 */
export function migrateStage(stage: string): TaskStage {
  if ((STAGE_ORDER as readonly string[]).includes(stage)) {
    return stage as TaskStage;
  }
  const legacy = LEGACY_STAGE_MAP[stage];
  if (legacy) {
    return legacy;
  }
  return "created";
}
