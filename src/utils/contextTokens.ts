import { TaskStage, TaskStatus, isReviewStage, AI_MODEL_STAGES } from "../types/taskProgress";

export interface TaskContextInput {
  status: TaskStatus;
  currentStage: TaskStage;
  hasLintPayload?: boolean;
  lintPassed?: boolean;
  isScheduled?: boolean;
  hasPendingNote?: boolean;
  isMetaManaged?: boolean;
}

export interface StageContextInput {
  stage: TaskStage;
  status: "done" | "current" | "outstanding";
  isPaused?: boolean;
  hasLintPayload?: boolean;
  lintPassed?: boolean;
  isScheduled?: boolean;
  hasPendingNote?: boolean;
  isMetaManaged?: boolean;
}

/**
 * Validates inputs that would otherwise produce ambiguous context tokens.
 *
 * Scheduled state is intentionally tolerated on completed tasks. Older
 * releases persisted the deprecated scheduledResumeTime field and tree
 * rendering must not fail while displaying those task-progress files.
 */
export function validateTaskContextInput(input: TaskContextInput): void {
  void input;
}

/**
 * Builds the contextValue string for a TaskNode.
 */
export function buildTaskContextValue(input: TaskContextInput): string {
  validateTaskContextInput(input);

  const tokens: string[] = [];

  // Lifecycle. Paused is checked before completed so a task parked on the
  // Publish stage (fixing lint / committing / pushing) can still be
  // paused/resumed at the task level instead of losing that control the
  // moment it reaches the final stage.
  if (input.status === "paused") {
    tokens.push("task-paused");
  } else if (input.status === "completed") {
    tokens.push("task-completed");
  } else if (isReviewStage(input.currentStage)) {
    tokens.push("task-active-review");
  } else {
    tokens.push("task-active");
  }

  // Suffixes based on conditions
  if (input.hasLintPayload && input.currentStage === "publish") {
    tokens.push("lint-known");
    if (input.lintPassed !== undefined) {
      tokens.push(input.lintPassed ? "lint-passed" : "lint-failed");
    }
  }

  if (input.isScheduled) {
    tokens.push("scheduled");
  }

  if (input.hasPendingNote) {
    tokens.push("pending-note");
  }

  if (input.isMetaManaged) {
    tokens.push("meta-managed");
  }

  return tokens.join("-");
}

/**
 * Builds the contextValue string for a StageNode.
 */
export function buildStageContextValue(input: StageContextInput): string {
  const tokens: string[] = [];

  // Primary stage token
  if (input.status === "current") {
    switch (input.stage) {
      case "desc":
        tokens.push("stage-desc-current");
        break;
      case "plan":
        tokens.push("stage-plan-current");
        break;
      case "impl":
        tokens.push("stage-impl-current");
        break;
      case "impl-low-review":
        tokens.push("stage-impl-low-review-current");
        break;
      case "publish":
        tokens.push("stage-publish-current");
        break;
      default:
        if (isReviewStage(input.stage)) {
          tokens.push("stage-review-current");
        } else {
          tokens.push("stage-current");
        }
    }
  } else {
    if (input.stage === "desc") {
      tokens.push("stage-desc");
    } else if (input.stage === "plan") {
      tokens.push("stage-plan");
    } else {
      tokens.push("stage");
    }
  }

  // Paused state
  if (input.isPaused) {
    tokens.push("paused");
  }

  // Lint state
  if (
    input.hasLintPayload &&
    (input.stage === "impl-low-review" || input.stage === "publish") &&
    input.status === "current"
  ) {
    tokens.push("lint-known");
    if (input.lintPassed !== undefined) {
      tokens.push(input.lintPassed ? "lint-passed" : "lint-failed");
    }
  }

  // Scheduled state
  if (input.isScheduled) {
    tokens.push("scheduled");
  }

  // Pending note state
  if (input.hasPendingNote) {
    tokens.push("pending-note");
  }

  // Meta-managed state
  if (input.isMetaManaged) {
    tokens.push("meta-managed");
  }

  // Modelable state (always at the end for regex compatibility)
  if (AI_MODEL_STAGES.includes(input.stage)) {
    tokens.push("modelable");
  }

  return tokens.join("-");
}
