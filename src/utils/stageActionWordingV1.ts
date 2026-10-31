/**
 * bugs3 Step 4: one stage-aware description of what a round does, shared by the
 * resume labels, the watchdog's "its last round" text and the chat "Ended" line.
 *
 * The same internal mode (`implementation`, `apply-review`) means different
 * work at different stages: at Plan and plan-review stages the round writes or
 * revises `plan.md` and touches no code; at implementation stages it edits
 * code. Internal mode names are diagnostic identifiers — user-facing text names
 * what the round does at the task's actual stage instead.
 *
 * Pure: no vscode, no fs.
 */
import { isPlanReviewStage, TaskStage } from "../types/taskProgress";
import { StepKindV1 } from "./stepLabelsV1";

/** Whether a round at `stage` works on the plan (`plan.md`) rather than on code. */
export function isPlanWorkStageV1(stage: TaskStage | undefined): boolean {
  return stage === "plan" || (stage !== undefined && isPlanReviewStage(stage));
}

/** What a fix round (Apply Review) does at `stage`; the stage is unknown → the neutral form. */
export function fixRoundSummaryV1(stage: TaskStage | undefined): {
  /** Fragment for a button label, after an em dash. */
  readonly labelClause: string;
  /** Sentence for a consequence, describing the dispatched round. */
  readonly consequence: string;
} {
  if (isPlanWorkStageV1(stage)) {
    return {
      labelClause: "revises the plan (plan.md); it does not edit code",
      consequence: "This runs a round that revises the plan (plan.md) to address the review's findings; it does not edit code.",
    };
  }
  if (stage === undefined) {
    return {
      labelClause: "applies the review's findings",
      consequence:
        "This runs a round that applies the review's findings: at a plan stage it revises plan.md, and at an " +
        "implementation stage it edits code.",
    };
  }
  return {
    labelClause: "edits code to address the review's findings",
    consequence: "This runs a round that edits the workspace's code to address the review's findings.",
  };
}

/**
 * What a round of kind `mode` did at `stage`, for the "Ended" line and the
 * watchdog text — the replacement for printing the raw mode identifier.
 */
export function describeRoundActionV1(mode: StepKindV1, stage: TaskStage | undefined): string {
  const planWork = isPlanWorkStageV1(stage);
  switch (mode) {
    case "review":
    case "re-review":
      return "reads the work and records findings; it does not edit anything";
    case "apply-review":
      return planWork ? "revises plan.md; it does not edit code" : "edits code to address the review's findings";
    case "implementation":
      return planWork ? "writes or revises plan.md; it does not edit code" : "builds the plan's open items in code";
    case "continuation":
      return planWork
        ? "produces the missing plan report; it does not edit code"
        : "produces the missing implementation report; it makes no edits";
  }
}

/** `implementation at plan` → `a round that writes or revises plan.md; it does not edit code (Plan)`. */
export function describeLastRoundV1(mode: string, stageDisplayName: string, stage: TaskStage | undefined): string {
  const known: readonly StepKindV1[] = ["review", "re-review", "apply-review", "implementation", "continuation"];
  return known.includes(mode as StepKindV1)
    ? `a round that ${describeRoundActionV1(mode as StepKindV1, stage)} at ${stageDisplayName}`
    : `${mode} at ${stageDisplayName}`;
}
