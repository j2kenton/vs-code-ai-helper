/**
 * Publish's stage-action table (v1 fixes 2, item 33): the ordered steps the
 * Publish stage runs as stage actions. It is the single source of truth for
 * three decisions, so none of them can drift from the others:
 *
 * - which command `applyCurrentStageAction` dispatches at Publish (the first
 *   entry — always the checks),
 * - whether a review step follows the checks (`publishNextStepAfterChecksV1`),
 * - which artifact-gated actions the Publish pre-flight surfaces warn about
 *   (`stageActionsForPreflightV1("publish")`).
 *
 * The `update ll rev` task removes the Publish AI review by deleting the
 * `"review"` entry below; every consumer then reads state A (checks, then
 * Commit & Push) with no other edit. Commit & Push is a separate command, not a
 * stage action, so it never appears here.
 *
 * Pure module — no `vscode` import — so the utilities that read the table stay
 * unit-testable.
 */
export type PublishStepV1 = "checks" | "review";

export const PUBLISH_STAGE_ACTIONS_V1: readonly PublishStepV1[] = ["checks", "review"];

/** The command each Publish step dispatches when it is the step to run. */
export const PUBLISH_STEP_COMMANDS_V1: Readonly<Record<PublishStepV1, string>> = {
  checks: "vs-code-ai-helper.runPublishChecks",
  review: "vs-code-ai-helper.runReviewWithAI",
};

/** The command Publish's stage button dispatches: the table's first step, which is always the checks. */
export function publishDispatchCommandV1(actions: readonly PublishStepV1[] = PUBLISH_STAGE_ACTIONS_V1): string {
  return PUBLISH_STEP_COMMANDS_V1[actions[0] ?? "checks"];
}

/** What Publish presents once its checks have passed, read from `actions`. */
export function publishNextStepFromActionsV1(
  actions: readonly PublishStepV1[] = PUBLISH_STAGE_ACTIONS_V1
): "review" | "commit-and-push" {
  return actions.includes("review") ? "review" : "commit-and-push";
}

/** The command Commit & Push runs. Not a stage action, so it is not in the table. */
export const COMMIT_AND_PUSH_COMMAND_V1 = "vs-code-ai-helper.commitAndPushTask";

/**
 * What to offer on the "checks passed" notice: the step `nextStep` names, as a
 * sentence and a one-click action, so the user never has to hunt the stage row
 * for the step that follows the checks.
 */
export function publishNextStepOfferV1(
  nextStep: "review" | "commit-and-push" = publishNextStepFromActionsV1()
): { readonly sentence: string; readonly action: { readonly command: string; readonly title: string } } {
  return nextStep === "commit-and-push"
    ? {
        sentence: "Commit & Push to finish.",
        action: { command: COMMIT_AND_PUSH_COMMAND_V1, title: "Commit & Push" },
      }
    : {
        sentence: "Request a Publish review to finish.",
        action: { command: PUBLISH_STEP_COMMANDS_V1.review, title: "Run Publish Review" },
      };
}
