/**
 * Represents the different stages in the task planning workflow
 */
export type TaskStage =
  | "created"
  | "plan"
  | "plan-review"
  | "plan-updated"
  | "plan-updated-review"
  | "plan-final"
  | "completed";

/**
 * The filename for the task request/scope artifact
 */
export const TASK_FILENAME = "task.md";

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
  "plan-review",
  "plan-updated",
  "plan-updated-review",
  "plan-final",
  "completed",
] as const;

/**
 * Human-readable names for each stage
 */
export const STAGE_DISPLAY_NAMES: Record<TaskStage, string> = {
  created: "Task Created",
  plan: "Initial Plan",
  "plan-review": "Plan Review",
  "plan-updated": "Updated Plan",
  "plan-updated-review": "Updated Plan Review",
  "plan-final": "Final Plan",
  completed: "Completed",
};
