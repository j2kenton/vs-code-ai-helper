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
 * bugs5 Step 18: Publish is two parts, the checks and then the AI review that gives the score. Every
 * line about a passing run says which part it is, so the owner can see where the step has got to.
 * Without a review next (Commit & Push follows the checks) there is no part 2 to name.
 */
export function publishChecksPassedHeadingV1(nextStep: "review" | "commit-and-push" = publishNextStepFromActionsV1()): string {
  return nextStep === "review" ? "Publish part 1 of 2 (checks) passed." : "Publish checks passed.";
}

/**
 * bugs5 Step 18: the first status line of a Publish Checks run: what part of Publish this is, what
 * runs, roughly how long it takes here (from the last timed run, when there is one), and that the
 * owner can leave. The per-check progress lines that follow update in place under the same operation.
 */
export function publishPartOneRunningLineV1(commands: readonly string[], estimatedMinutes?: number): string {
  const what = commands.length > 0 ? commands.join(", ") : "lint, types, tests";
  const duration = estimatedMinutes !== undefined ? ` (usually about ${estimatedMinutes} min here)` : "";
  return `Publish, part 1 of 2: checks running — ${what}${duration}. You can leave this; the result will appear here.`;
}

/** The review's own heading, so its lines read as the second half of the same step. */
export const PUBLISH_PART_TWO_LABEL_V1 = "Publish, part 2 of 2: AI review";

/** The name a review's operation carries: Publish's review is named as part 2 of 2, other stages keep `fallback`. */
export function reviewOperationLabelV1(stage: string | undefined, fallback: string): string {
  return stage === "publish" ? PUBLISH_PART_TWO_LABEL_V1 : fallback;
}

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
        sentence: "Part 2 is the AI review, which gives the score out of 10. Run it now?",
        action: { command: PUBLISH_STEP_COMMANDS_V1.review, title: "Run Publish Review" },
      };
}
