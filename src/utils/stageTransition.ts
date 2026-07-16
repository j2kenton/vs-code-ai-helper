/**
 * Shared stage-advance helper.
 *
 * All stage transition writers (setTaskStage, nextStage, markTaskDone) must
 * route through this helper to guarantee:
 *   1. Stage persistence happens before any downstream action.
 *   2. Auto-review is dispatched at most once per successful transition.
 *   3. No auto-review fires on failed or skipped transitions.
 *
 * The helper is intentionally free of VS Code window/progress UI so it can be
 * unit-tested under node:test without a running extension host.
 */

import type * as vscode from "vscode";
import {
  isReviewStage,
  TaskStage,
} from "../types/taskProgress";
import {
  patchTaskProgress,
  updateTaskProgressStage,
} from "./taskProgressUtils";

/**
 * Result returned from advanceStage so callers can decide whether to
 * dispatch auto-review or show success messages.
 */
export interface StageTransitionResult {
  /** True when the persistence write succeeded. */
  persisted: boolean;
  /** The stage the task was moved to. */
  newStage: TaskStage;
  /** Whether auto-review should be triggered (caller is responsible for executing it). */
  shouldAutoReview: boolean;
}

/**
 * Explicit map of source → destination transitions that trigger auto-review
 * when the caller opts in via a `kind` in `AUTO_REVIEW_ELIGIBLE_KINDS`.
 *
 * Only transitions that end in a review stage AND come from the immediately
 * preceding non-review stage qualify.
 *
 * Exported so tests can assert against the production map directly.
 */
export const AUTO_REVIEW_TRANSITIONS: Partial<Record<TaskStage, TaskStage>> = {
  plan: "plan-high-review",
  "plan-high-review": "plan-low-review",
  impl: "impl-high-review",
  "impl-high-review": "impl-low-review",
};

/**
 * Every distinct reason `advanceStage` can be called for.
 *
 * A plain boolean can't distinguish "this transition is allowed to opt into
 * auto-review" from "this transition must never auto-review, no matter what
 * a caller passes in" — a future call site could pass `true` for the wrong
 * reason and silently start a duplicate/incorrect review. `kind` makes that
 * a compile-time-visible decision instead of a scattered boolean.
 *
 * Only `complete-and-move-on` and `auto-advance` may ever result in
 * `shouldAutoReview: true` (see `AUTO_REVIEW_ELIGIBLE_KINDS`); every other
 * kind is hard-blocked inside `advanceStage` regardless of `optIn`.
 */
export type TransitionKind =
  /** "Complete Stage & Move On" / "Complete, Commit and Push" style manual completion. */
  | "complete-and-move-on"
  /** Score-based auto-advance past a perfect/threshold review result. */
  | "auto-advance"
  /** Manual "Set Task Stage" / "Set Stage as Current" jump to an arbitrary stage. */
  | "jump"
  /** Non-review-stage reset paths (e.g. reverting progress) — never review-eligible. */
  | "reset"
  /** Reopening a previously-completed task at a chosen stage. */
  | "reopen"
  /** Startup/checkpoint recovery replaying a transition that already happened. */
  | "recovery"
  /** Internal transition used only inside fast-forward's own retry loop. */
  | "fast-forward-internal"
  /** Running a review itself moves the task onto the review stage; must never re-dispatch a review. */
  | "review-run";

/**
 * The only two kinds that may ever produce `shouldAutoReview: true`. Every
 * other `TransitionKind` is hard-blocked in `advanceStage` regardless of the
 * `optIn` flag a caller passes.
 */
export const AUTO_REVIEW_ELIGIBLE_KINDS: ReadonlySet<TransitionKind> = new Set([
  "complete-and-move-on",
  "auto-advance",
]);

/**
 * Persist a stage transition and compute whether auto-review should fire.
 *
 * Callers receive a `StageTransitionResult` with `shouldAutoReview` set when
 * all of the following are true:
 *   - `triggerAutoReview` is true (caller opted in)
 *   - The task is not paused
 *   - The destination is a review stage
 *   - The source → destination pair is in `AUTO_REVIEW_TRANSITIONS`
 *
 * Callers are responsible for executing the auto-review command; this helper
 * only computes eligibility to keep UI concerns out of the utility layer.
 *
 * @param taskFolderUri  The task folder to update.
 * @param sourceStage    The stage the task is currently at before this transition.
 * @param newStage       The stage to advance to.
 * @param isPaused       Whether the task is currently paused.
 * @param kind           Why this transition is happening. Hard-gates auto-review
 *   eligibility: only `AUTO_REVIEW_ELIGIBLE_KINDS` can ever produce
 *   `shouldAutoReview: true`, regardless of `optIn`.
 * @param optIn          Caller-side opt-in (e.g. a workspace setting) for kinds
 *   that are eligible. Ignored for ineligible kinds. Defaults to `true`.
 * @param expectedReviewAttemptId  When set, the transition is rejected unless
 *   the task's persisted `reviewAttemptId` still matches — guards against a
 *   superseded review attempt advancing (or re-publishing over) a newer one.
 * @param publishArtifact  Optional side effect (e.g. renaming a staged review
 *   file into place) run atomically with the CAS check/write, inside the same
 *   lock. Passing the artifact publish here — instead of doing it after
 *   `advanceStage` returns — closes the window where a newer review attempt
 *   could claim and publish before this attempt's own (already-validated)
 *   publish step runs, which would otherwise let a stale result clobber the
 *   accepted artifact.
 * @returns `StageTransitionResult`, or `undefined` when persistence failed.
 */
export async function advanceStage(
  taskFolderUri: vscode.Uri,
  sourceStage: TaskStage,
  newStage: TaskStage,
  isPaused: boolean,
  kind: TransitionKind,
  optIn: boolean = true,
  expectedReviewAttemptId?: string,
  publishArtifact?: () => Promise<void>
): Promise<StageTransitionResult | undefined> {
  // Short-circuit: no-op when source and destination are the same
  if (sourceStage === newStage) {
    if (expectedReviewAttemptId !== undefined) {
      const current = await patchTaskProgress(taskFolderUri, (progress) => {
        if (progress.currentStage !== sourceStage || progress.reviewAttemptId !== expectedReviewAttemptId) {
          throw new Error("Review result is stale; a newer review attempt owns this transition.");
        }
        return progress;
      }, false, publishArtifact);
      if (!current) return undefined;
    } else if (publishArtifact) {
      await publishArtifact();
    }
    return {
      persisted: true,
      newStage,
      shouldAutoReview: false,
    };
  }

  // Persist the stage transition before any other action.
  // patchTaskProgress preserves all unrelated fields (implReviewFiles,
  // scheduledAt, lintPayload, status, etc.).
  const patched = await patchTaskProgress(taskFolderUri, (current) => {
    // Compare-and-set the source stage inside the task lock. This prevents a
    // delayed review/shortcut from advancing a newer run a second time.
    if (current.currentStage !== sourceStage) {
      throw new Error(
        `Task changed before transition (expected ${sourceStage}, found ${current.currentStage}).`
      );
    }
    if (expectedReviewAttemptId !== undefined && current.reviewAttemptId !== expectedReviewAttemptId) {
      throw new Error("Review result is stale; a newer review attempt owns this transition.");
    }
    return updateTaskProgressStage(current, newStage);
  }, false, publishArtifact);

  if (!patched) {
    return undefined;
  }

  // Compute exactly-once auto-review eligibility.
  // Conditions are evaluated AFTER persistence so a failed write never
  // triggers a review on stale data. `kind` is a hard gate: only
  // AUTO_REVIEW_ELIGIBLE_KINDS can ever reach `shouldAutoReview: true`, no
  // matter what `optIn` is — see TransitionKind's doc comment.
  const shouldAutoReview =
    AUTO_REVIEW_ELIGIBLE_KINDS.has(kind) &&
    optIn &&
    !isPaused &&
    isReviewStage(newStage) &&
    AUTO_REVIEW_TRANSITIONS[sourceStage] === newStage;

  return {
    persisted: true,
    newStage,
    shouldAutoReview,
  };
}

/**
 * Compute the next stage in the linear STAGE_ORDER, or undefined when
 * `currentStage` is the last stage.
 *
 * Exported so callers (nextStage, markTaskDone) can determine the next stage
 * without duplicating STAGE_ORDER indexing logic.
 */
import { STAGE_ORDER } from "../types/taskProgress";

export function computeNextStage(
  currentStage: TaskStage,
  configuredStages?: ReadonlySet<TaskStage>
): TaskStage | undefined {
  let idx = STAGE_ORDER.indexOf(currentStage);
  if (idx === -1) return undefined;
  while (idx < STAGE_ORDER.length - 1) {
    idx += 1;
    const candidate = STAGE_ORDER[idx];
    if (!candidate) continue;
    // A caller that has loaded model settings may omit optional review stages.
    // Keep the default behavior unchanged when no settings are supplied.
    if (configuredStages === undefined || !isReviewStage(candidate) || configuredStages.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Return true when `stage` is an eligible source for auto-review dispatch.
 * Convenience wrapper over AUTO_REVIEW_TRANSITIONS.
 */
export function isAutoReviewSource(stage: TaskStage): boolean {
  return stage in AUTO_REVIEW_TRANSITIONS;
}
