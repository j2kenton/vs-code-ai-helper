/**
 * Shared "will this option's effect refuse right now?" check (task "stage
 * chat as a record of work" item 14 / Part 12 step 34): before a
 * `WorkflowDecisionV1` is posted, `postWorkflowDecisionV1` runs every
 * option's effect through this function and, when it reports `blocked`,
 * marks the option `disabled` with the returned reason rather than letting a
 * refusal-on-click surprise reach the user — the same "never render an
 * option the system already knows is wrong" rule item 10 established for
 * options that can never help, extended here to options that CAN help but
 * cannot run in the task's current state.
 *
 * Scoped to the one precondition this task actually verified refuses:
 * `resolveTaskContext(..., { allowPaused: false })` — used (directly or via
 * a command that delegates to one that does) by `applyCurrentStageAction`,
 * `fastForwardCurrentTaskReview`, `reviewCurrentTask`, the plain
 * `goToReviewAndApply`, and `setTaskStage` — genuinely refuses on a paused
 * task with "Task is paused. Resume it before using this shortcut." (the
 * literal message item 14 traced). The plan also names "continuation owed"
 * and "out-of-stage" as preconditions worth checking; this function does not
 * yet encode either, because no current call site was confirmed to refuse on
 * them — `applyCurrentStageAction`'s `impl` branch reads `continuationOwed`
 * only to choose which stage's work to dispatch (`decidePostReviewActionV1`),
 * never to refuse, and the "out of stage" refusals traced in
 * `goToReviewAndApplyV1`'s header comment are already resolved by that
 * command's own stage-jump before dispatch, not a precondition an option's
 * caller could evaluate in advance. Encoding a speculative rule here would
 * risk disabling an option that would in fact succeed — worse than the
 * defect this function exists to fix. Extend the curated sets below once a
 * concrete refusal on either axis is traced the same way.
 *
 * Preference order, per the plan: where a command already resumes the task
 * itself as part of proceeding (`resumeIfPausedThenGoToReviewAndApplyV1`,
 * `resumeAndSetTaskStageV1`, `resumeAndRerunReviewV1`,
 * `resumeAndDispatchImplementationV1`, the plain `resumeTask`), it is never
 * blocked on the paused-status precondition — "do the whole thing" already
 * covers that case at the command level, and disabling it here would
 * contradict the fix rather than complement it.
 */

import { WorkflowDecisionOptionEffectV1 } from "../types/workflowDecisionV1";

export interface RecommendationPreconditionResultV1 {
  readonly blocked: boolean;
  /** Non-empty when `blocked` is true — the option's `disabledReason`. */
  readonly reason?: string;
}

export interface RecommendationPreconditionProgressV1 {
  readonly status?: string;
}

/**
 * Commands whose `resumeXxxV1` wrapper already resumes a paused task as part
 * of proceeding — never blocked by the paused-status precondition.
 */
const RESUME_SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "vs-code-ai-helper.resumeTask",
  "vs-code-ai-helper.resumeAndRerunReview",
  "vs-code-ai-helper.resumeAndDispatchImplementation",
  "vs-code-ai-helper.resumeAndSetTaskStage",
  "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
]);

/**
 * Commands traced to refuse outright on a paused task (each resolves
 * `resolveTaskContext(..., { allowPaused: false })`, directly or via a
 * command that delegates to one that does) rather than resuming through it.
 */
const PAUSE_SENSITIVE_COMMANDS: ReadonlySet<string> = new Set([
  "vs-code-ai-helper.applyCurrentStageAction",
  "vs-code-ai-helper.fastForwardCurrentTaskReview",
  "vs-code-ai-helper.reviewCurrentTask",
  "vs-code-ai-helper.goToReviewAndApply",
  "vs-code-ai-helper.setTaskStage",
]);

/**
 * Evaluate whether `effect` would refuse if invoked against `progress` right
 * now. Pure and synchronous — callers that need this against a task by id
 * read its `TaskProgress` first (see `postWorkflowDecisionV1`, which does so
 * best-effort so a read failure never blocks posting the decision itself).
 */
export function recommendationPreconditionsV1(
  effect: WorkflowDecisionOptionEffectV1,
  progress: RecommendationPreconditionProgressV1
): RecommendationPreconditionResultV1 {
  if (effect.kind !== "command") {
    return { blocked: false };
  }
  const { command } = effect;

  if (
    progress.status === "paused" &&
    !RESUME_SAFE_COMMANDS.has(command) &&
    PAUSE_SENSITIVE_COMMANDS.has(command)
  ) {
    return { blocked: true, reason: "resume the task first" };
  }

  return { blocked: false };
}
