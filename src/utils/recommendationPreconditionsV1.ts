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
 * Two axes are encoded, each traced to a genuine refusal message rather than
 * a speculative rule — encoding a guess here would risk disabling an option
 * that would in fact succeed, which is worse than the defect this function
 * exists to fix.
 *
 * **Paused status.** `resolveTaskContext(..., { allowPaused: false })` —
 * used (directly or via a command that delegates to one that does) by
 * `applyCurrentStageAction`, `fastForwardCurrentTaskReview`,
 * `reviewCurrentTask`, the plain `goToReviewAndApply`, and `setTaskStage` —
 * genuinely refuses on a paused task with "Task is paused. Resume it before
 * using this shortcut." (the literal message item 14 traced).
 *
 * **Review invalidated by an owed round.** `applyReviewEditWithAI`
 * (`reviewActions.ts`, reached by `applyHighLevelReviewChanges` /
 * `applyLowLevelReviewChanges` for their edit-root stage, and by
 * `goToReviewAndApplyV1` after its stage-jump) refuses whenever
 * `progress.reviewInvalidatedByRound?.stage` equals the stage the apply is
 * about to run against — an incomplete implementation round changed the
 * workspace after this review was written, so the stale review would drive
 * an edit round from findings about a tree that no longer exists. Traced
 * 2026-08-31 against `reviewActions.ts:10726-10746`; the same review-blocker
 * window that reported this axis missing also confirmed the resume-safe
 * wrapper this task added (`resumeIfPausedThenGoToReviewAndApply`) reaches
 * exactly this refusal.
 *
 * **Continuation owed** (review blocker, round 2 — Plan Part 12 step 34
 * names this as its own axis, separately from review-invalidation): the
 * refusal above is gated purely on `reviewInvalidatedByRound?.stage`, and
 * `implRecovery`'s only observed effect at that call site is which SENTENCE
 * is shown, not whether it refuses — `implRecovery` is task-level (no
 * `stage` field of its own outside the `apply-review`-sourced case), while
 * `reviewInvalidatedByRound` is the stage-scoped marker the refusal actually
 * keys on. Verified against every current creation site of `implRecovery`
 * (`implementationRecoveryV1.ts`): the one path that creates a fresh record
 * (`beginImplementationRecoveryV1`, `:474-530`) always calls
 * `recordReviewInvalidatedByRound` in the SAME patch whenever
 * `postRunReviewStage` is a review stage (`:500-502`) — which it always is
 * for this trigger — so a fresh `implRecovery` never exists without a
 * matching `reviewInvalidatedByRound`; the other two mutation sites
 * (`claimImplRecoveryDispatchV1`, `escalateClaimedSummaryOnlyIfUnavailableV1`)
 * only transition an EXISTING record and never originate one on their own.
 * Encoded explicitly anyway, as its own `continuationOwed` input, rather than
 * left as an implication of the review-invalidation axis: the plan names it
 * as a distinct precondition, and encoding it directly means a future
 * `implRecovery` creation site that forgets to also invalidate the review
 * (a regression the reviewInvalidatedByRound-only check would silently miss)
 * is still caught here.
 *
 * **Out-of-stage.** `applyHighLevelReviewChanges` accepts only
 * `plan-high-review`/`impl-high-review` (`applyHighLevelReviewChanges.ts:47-55`),
 * `applyLowLevelReviewChanges` only `plan-low-review`/`impl-low-review`
 * (`applyLowLevelReviewChanges.ts:47-55`), and `applyReviewEditWithAI`
 * resolves against `IMPL_REVIEW_STAGES` (`reviewActions.ts:10645`) —
 * `["impl-high-review", "impl-low-review"]`. These three commands act on
 * `progress.currentStage` directly (no stage argument of their own), so this
 * precondition can evaluate them exactly like the review-invalidation axis
 * does. Verified 2026-08-31 that every production decision-option effect
 * reaching an apply-review command today does so via
 * `resumeIfPausedThenGoToReviewAndApply`/`goToReviewAndApplyV1`'s own
 * stage-jump, so this axis does not currently trip in practice — encoded
 * anyway as a defensive check per the plan's naming, so a future option that
 * dispatches one of these three commands directly (skipping the jump) is
 * caught here rather than reproducing the exact "offered a button that could
 * only warn" defect `goToReviewAndApplyV1`'s header comment documents.
 *
 * Preference order, per the plan: where a command already resumes the task
 * itself as part of proceeding (`resumeIfPausedThenGoToReviewAndApplyV1`,
 * `resumeAndSetTaskStageV1`, `resumeAndRerunReviewV1`,
 * `resumeAndDispatchImplementationV1`, the plain `resumeTask`), it is never
 * blocked on the paused-status precondition — "do the whole thing" already
 * covers that case at the command level, and disabling it here would
 * contradict the fix rather than complement it. The review-invalidation
 * axis is not resolved by any such wrapper (nothing "does the whole thing"
 * for a stale review — the review genuinely must be regenerated first), so
 * it applies to every command in `REVIEW_APPLY_*_COMMANDS` below, resume-safe
 * or not.
 */

import { WorkflowDecisionOptionEffectV1 } from "../types/workflowDecisionV1";

export interface RecommendationPreconditionResultV1 {
  readonly blocked: boolean;
  /** Non-empty when `blocked` is true — the option's `disabledReason`. */
  readonly reason?: string;
}

export interface RecommendationPreconditionProgressV1 {
  readonly status?: string;
  /** `TaskProgress.currentStage` — the target stage for a command (like
   * `applyHighLevelReviewChanges`) that acts on whichever stage the task is
   * currently at rather than taking an explicit stage argument. */
  readonly currentStage?: string;
  /** `TaskProgress.reviewInvalidatedByRound?.stage`, when set. */
  readonly reviewInvalidatedByRoundStage?: string;
  /**
   * `TaskProgress.implRecovery !== undefined` — a continuation from an
   * earlier round is owed (pending or already dispatched). Task-level, not
   * stage-scoped: see this module's header comment for why `implRecovery`
   * carries no independent `stage` of its own outside the `apply-review`-
   * sourced case, and why this is still encoded as its own precondition
   * rather than left as an implication of `reviewInvalidatedByRoundStage`.
   */
  readonly continuationOwed?: boolean;
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
 * Commands that reach `applyReviewEditWithAI`'s review-invalidation refusal
 * and carry an explicit `reviewStage` in their first argument — the target
 * stage for the precondition check is that argument, not `progress.currentStage`
 * (the stage-jump these commands perform hasn't happened yet at the time
 * this function runs).
 */
const REVIEW_APPLY_STAGE_ARG_COMMANDS: ReadonlySet<string> = new Set([
  "vs-code-ai-helper.goToReviewAndApply",
  "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
]);

/**
 * Commands that reach the same refusal but act on whichever stage the task
 * is CURRENTLY at (they take no stage argument) — the target stage for the
 * check is `progress.currentStage`.
 */
const REVIEW_APPLY_CURRENT_STAGE_COMMANDS: ReadonlySet<string> = new Set([
  "vs-code-ai-helper.applyHighLevelReviewChanges",
  "vs-code-ai-helper.applyLowLevelReviewChanges",
  "vs-code-ai-helper.applyReviewEditWithAI",
]);

/**
 * Every command in `REVIEW_APPLY_STAGE_ARG_COMMANDS` /
 * `REVIEW_APPLY_CURRENT_STAGE_COMMANDS` reaches `applyReviewEditWithAI`'s
 * review-invalidation refusal, so `continuationOwed` blocks all of them
 * regardless of which target stage the effect names — `implRecovery` is
 * task-level, not stage-scoped (see header comment).
 */
const REVIEW_APPLY_COMMANDS: ReadonlySet<string> = new Set([
  ...REVIEW_APPLY_STAGE_ARG_COMMANDS,
  ...REVIEW_APPLY_CURRENT_STAGE_COMMANDS,
]);

/**
 * The stage set each `REVIEW_APPLY_CURRENT_STAGE_COMMANDS` entry accepts
 * before it refuses with its own "Task is not at a …" message — see this
 * module's header comment for the traced source of each set.
 */
const CURRENT_STAGE_COMMAND_ALLOWED_STAGES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["vs-code-ai-helper.applyHighLevelReviewChanges", new Set(["plan-high-review", "impl-high-review"])],
  ["vs-code-ai-helper.applyLowLevelReviewChanges", new Set(["plan-low-review", "impl-low-review"])],
  ["vs-code-ai-helper.applyReviewEditWithAI", new Set(["impl-high-review", "impl-low-review"])],
]);

/** Best-effort extraction of `args[0].reviewStage` from a command effect. */
function extractReviewStageArg(effect: WorkflowDecisionOptionEffectV1): string | undefined {
  if (effect.kind !== "command") {
    return undefined;
  }
  const first = effect.args?.[0];
  if (first && typeof first === "object" && "reviewStage" in first) {
    const value = (first as { reviewStage?: unknown }).reviewStage;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

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

  if (progress.continuationOwed === true && REVIEW_APPLY_COMMANDS.has(command)) {
    return {
      blocked: true,
      reason: "a continuation from an earlier round is still owed — it must run (or be dismissed) before applying this review",
    };
  }

  if (progress.reviewInvalidatedByRoundStage !== undefined) {
    const targetStage = REVIEW_APPLY_STAGE_ARG_COMMANDS.has(command)
      ? extractReviewStageArg(effect)
      : REVIEW_APPLY_CURRENT_STAGE_COMMANDS.has(command)
        ? progress.currentStage
        : undefined;
    if (targetStage !== undefined && targetStage === progress.reviewInvalidatedByRoundStage) {
      return {
        blocked: true,
        reason: "an implementation round changed the workspace after this review was written — run the review again first",
      };
    }
  }

  const allowedStages = CURRENT_STAGE_COMMAND_ALLOWED_STAGES.get(command);
  if (allowedStages !== undefined && progress.currentStage !== undefined && !allowedStages.has(progress.currentStage)) {
    return {
      blocked: true,
      reason: "the task is not at the review stage this action requires",
    };
  }

  return { blocked: false };
}
