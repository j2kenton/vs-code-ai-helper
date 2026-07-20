import { TaskStage, TaskStatus, isReviewStage, AI_MODEL_STAGES } from "../types/taskProgress";

export interface TaskContextInput {
  status: TaskStatus;
  currentStage: TaskStage;
  hasLintPayload?: boolean;
  lintPassed?: boolean;
  isScheduled?: boolean;
  isMetaManaged?: boolean;
  isPinned?: boolean;
}

export interface StageContextInput {
  stage: TaskStage;
  status: "done" | "current" | "outstanding";
  isPaused?: boolean;
  hasLintPayload?: boolean;
  lintPassed?: boolean;
  isScheduled?: boolean;
  isMetaManaged?: boolean;
  /** A previous artifact version exists — enables View/Revert/Delete backup actions. */
  hasBackup?: boolean;
  /**
   * The artifact currently sits on the reverted side of its durable redo
   * sidecar (see utils/redoSidecar.ts) — enables the Redo Changes action.
   * Survives reload/crash; never true without hasBackup also true.
   */
  redoAvailable?: boolean;
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
  if (input.status === "archived") {
    tokens.push("task-archived");
  } else if (input.status === "paused") {
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

  if (input.isMetaManaged) {
    tokens.push("meta-managed");
  }

  // Pinned marker last so menu `when` clauses can match /-pinned$/ without
  // colliding with the other suffix tokens.
  if (input.isPinned) {
    tokens.push("pinned");
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

  // Meta-managed state
  if (input.isMetaManaged) {
    tokens.push("meta-managed");
  }

  // Backup availability: gates the Delete Previous Version menu entry (menus
  // match /-has-backup/), independent of swap direction. Kept before the
  // trailing modelable token so /-modelable$/ clauses keep matching.
  if (input.hasBackup) {
    tokens.push("has-backup");
  }

  // Swap direction: exactly one of these two tokens is present whenever a
  // backup exists, gating Revert Changes vs. Redo Changes as mutually
  // exclusive menu entries (menus match /-revert-available/ /
  // /-redo-available/) instead of deriving "revert" from the negation of
  // "redo-available".
  if (input.hasBackup) {
    tokens.push(input.redoAvailable ? "redo-available" : "revert-available");
  }

  // Modelable state (always at the end for regex compatibility)
  if (AI_MODEL_STAGES.includes(input.stage)) {
    tokens.push("modelable");
  }

  return tokens.join("-");
}
