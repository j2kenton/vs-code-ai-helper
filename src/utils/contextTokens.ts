import { TaskStage, TaskStatus, isReviewStage, AI_MODEL_STAGES } from "../types/taskProgress";
import { TaskCreationFootprintClassV1 } from "../types/taskCreationRecoveryV1";

/**
 * A `status: "creating"` row's plan §4.3 classification, as last published by
 * `TaskCreationStartupReconcilerV1.getLastKnownFootprint` — `undefined` means
 * no classification pass has published anything for this folder yet.
 */
export interface TaskCreationContextInput {
  footprintClass: TaskCreationFootprintClassV1;
  retryWithoutAdoptionEligible: boolean;
  deletionPending: boolean;
}

export interface TaskContextInput {
  status: TaskStatus;
  currentStage: TaskStage;
  hasLintPayload?: boolean;
  lintPassed?: boolean;
  isScheduled?: boolean;
  isMetaManaged?: boolean;
  /**
   * The task's `checklistProgressUnreliable` latch (see taskProgress.ts): a
   * round landed changes the plan checklist could not record, so the
   * completeness gate has stood down. Carried as a context token so the
   * reconcile command's menu entry — the only way to clear the latch — shows
   * only on tasks that actually carry it. Ignored for `creating` rows, which
   * return their single recovery context before any suffix is applied.
   */
  checklistProgressUnreliable?: boolean;
  isPinned?: boolean;
  /** Present only when `status === "creating"` and a classification has published. */
  creationFootprint?: TaskCreationContextInput;
}

/**
 * The six plan §4.7 recovery contexts, in the precedence order
 * `buildTaskContextValue` applies. Exported so `taskTreeProvider.ts` and its
 * tests can reference the exact literals instead of re-deriving them.
 */
export const CREATION_RECOVERY_CONTEXT_V1 = {
  deletionPending: "ensemble.task.creationRecovery.deletionPending",
  v1Recoverable: "ensemble.task.creationRecovery.v1Recoverable",
  reconstructible: "ensemble.task.creationRecovery.reconstructible",
  pristine: "ensemble.task.creationRecovery.pristine",
  preservable: "ensemble.task.creationRecovery.preservable",
  inspectionOnly: "ensemble.task.creationRecovery.inspectionOnly",
} as const;

/**
 * Chooses exactly one of the six plan §4.7 contexts for a `creating` row.
 * `deletionPending` wins outright (a deletion in flight must never also
 * offer Open/Retry/Adopt-and-Retry/Safe Delete); otherwise
 * `retryWithoutAdoptionEligible` (the verified-§4.2-journal branch — plan
 * §4.5) overrides the four conservative `footprintClass` values, since it is
 * strictly stronger evidence than any of them. `undefined` (no classification
 * published yet) conservatively falls back to `inspectionOnly` — Open only,
 * never Retry/Adopt-and-Retry/Safe Delete, until a real classification
 * publishes.
 */
function creationRecoveryContextValue(footprint: TaskCreationContextInput | undefined): string {
  if (!footprint) {
    return CREATION_RECOVERY_CONTEXT_V1.inspectionOnly;
  }
  if (footprint.deletionPending) {
    return CREATION_RECOVERY_CONTEXT_V1.deletionPending;
  }
  if (footprint.retryWithoutAdoptionEligible) {
    return CREATION_RECOVERY_CONTEXT_V1.v1Recoverable;
  }
  return CREATION_RECOVERY_CONTEXT_V1[footprint.footprintClass];
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

  // Creating is checked first and returns immediately: an interrupted
  // creation (plan §4.7 recovery row) has no stage/AI menu surface at all,
  // and must expose only the ONE recovery context its own classification
  // warrants (AC-CREATE-UI-01) — never a hyphen-joined blend with the
  // lint/scheduled/meta-managed/pinned suffixes below, none of which apply to
  // a row with no stages and no lint/schedule state of its own.
  if (input.status === "creating") {
    return creationRecoveryContextValue(input.creationFootprint);
  }

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

  // Checklist-unreliable latch: gates the reconcilePlanChecklist menu entry
  // (menus match /-checklistUnreliable/). Kept before the trailing pinned
  // token so /-pinned$/ clauses keep matching; every existing /^task/ clause
  // is a prefix match and is unaffected by the added suffix.
  if (input.checklistProgressUnreliable) {
    tokens.push("checklistUnreliable");
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
      case "impl-high-review":
        // Distinct token from the generic "stage-review-current" (previously
        // this case fell through to the isReviewStage default below, which
        // emitted the SAME literal token as the text-only plan review
        // stages). That conflation is what let the tree's Apply Review menu
        // binding route an edit-capable review stage through the identical
        // command entry point used for text-only plan reviews — the review's
        // "one dynamic public command used for both branches" finding. Giving
        // this stage its own token (mirroring impl-low-review) is the
        // prerequisite for the menu/command surface to eventually bind
        // edit-capable review stages to a distinct, statically edit-gated
        // route. Package.json's when-clauses that used to rely on
        // "stage-review-current" matching this stage now explicitly OR in
        // this new token so behavior is unchanged until that split lands.
        tokens.push("stage-impl-high-review-current");
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
