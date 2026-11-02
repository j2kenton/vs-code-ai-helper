/**
 * bugs5 Step 12: what the recovery card offers after a run was interrupted (an extension host
 * restart, a reload). It restarts what was interrupted, by name, and at Publish it lists the
 * stage's real actions by their button names and recommends one from the state of the checks.
 *
 * Reported 2026-11-01 (jester, Publish): a Commit & Push interrupted after the checks had passed
 * offered only "Run Current Stage Action", which at Publish re-runs the 20-minute Publish Checks.
 *
 * Pure module (no `vscode` import) so the choice is unit-testable.
 */
import type { OperationKind } from "./operationTaxonomy";

export interface RecoveryActionV1 {
  /** The button name, as it appears on the stage row. */
  readonly label: string;
  readonly command: string;
  /** What choosing it runs, in words that are not just the label. */
  readonly consequence: string;
}

export const RECOVERY_COMMANDS_V1 = {
  publishChecks: "vs-code-ai-helper.runPublishChecks",
  fixLinting: "vs-code-ai-helper.runLintingFixes",
  commitPush: "vs-code-ai-helper.commitAndPushTask",
  completeTask: "vs-code-ai-helper.markTaskDone",
  implementation: "vs-code-ai-helper.runImplementationWithAI",
  applyReview: "vs-code-ai-helper.applyReviewWithAI",
  stageAction: "vs-code-ai-helper.applyCurrentStageAction",
  generatePlan: "vs-code-ai-helper.generatePlanWithAI",
  draftTask: "vs-code-ai-helper.draftTaskWithAI",
  release: "vs-code-ai-helper.release",
} as const;

/** What the Publish checks have proved about the tree as it is now. */
export type PublishChecksStateV1 = "passedOnCurrentTree" | "failed" | "neverRanOrStale";

export interface InterruptedRecoveryInputV1 {
  readonly label: string;
  readonly kind?: OperationKind;
  /** True when the task is at the Publish stage. */
  readonly atPublish: boolean;
  readonly checksState?: PublishChecksStateV1;
  /** The commands the last checks run ran, for the consequence text; omitted when unknown. */
  readonly lastRunCommands?: readonly string[];
  /** Minutes the last completed checks run took, when known. */
  readonly lastRunMinutes?: number;
}

export interface InterruptedRecoveryPlanV1 {
  /** The recommended action, offered first; absent when the interrupted operation cannot be named. */
  readonly primary: RecoveryActionV1 | undefined;
  /** Further actions, in the order the card lists them. */
  readonly alternatives: readonly RecoveryActionV1[];
  /** One line saying why `primary` is recommended. */
  readonly reasoning: string;
}

function checksConsequence(input: InterruptedRecoveryInputV1): string {
  const commands =
    input.lastRunCommands !== undefined && input.lastRunCommands.length > 0
      ? `: ${input.lastRunCommands.join(", ")}`
      : ": the project's lint, type, test and build checks";
  const minutes = input.lastRunMinutes !== undefined ? `; about ${input.lastRunMinutes} min here` : "";
  return `Runs Publish Checks${commands}${minutes}.`;
}

/** The four real Publish actions, each with a consequence that names what it runs. */
function publishActions(input: InterruptedRecoveryInputV1): Record<"checks" | "fix" | "commit" | "complete", RecoveryActionV1> {
  return {
    checks: { label: "Run Publish Checks", command: RECOVERY_COMMANDS_V1.publishChecks, consequence: checksConsequence(input) },
    fix: {
      label: "Fix Linting & Code Errors",
      command: RECOVERY_COMMANDS_V1.fixLinting,
      consequence: "Runs automatic and AI fixes from the last failing check output, then re-runs the checks.",
    },
    commit: {
      label: "Commit & Push",
      command: RECOVERY_COMMANDS_V1.commitPush,
      consequence: "Starts Commit & Push: it reuses the passing checks when the files are unchanged, then asks you to confirm before anything is committed.",
    },
    complete: {
      label: "Complete Task",
      command: RECOVERY_COMMANDS_V1.completeTask,
      consequence: "Marks the task complete without committing or pushing anything.",
    },
  };
}

/** The action that restarts the interrupted operation itself, when it can be named. */
function interruptedActionAgain(input: InterruptedRecoveryInputV1): RecoveryActionV1 | undefined {
  const publish = publishActions(input);
  if (input.label === "Run Publish Checks") {
    return { ...publish.checks, label: "Run Publish Checks again" };
  }
  switch (input.kind) {
    case "commit-push":
    case "complete-commit-push":
      return { ...publish.commit, label: "Commit & Push again" };
    case "run-implementation":
      return {
        label: "Run Implementation again",
        command: RECOVERY_COMMANDS_V1.implementation,
        consequence: "Starts Implementation again from the plan's open items; work already on disk is kept.",
      };
    case "apply-review":
      return {
        label: "Apply Review again",
        command: RECOVERY_COMMANDS_V1.applyReview,
        consequence: "Starts Apply Review again on the latest review's blockers.",
      };
    case "lint-fixes":
      return { ...publish.fix, label: "Fix Linting & Code Errors again" };
    case "review":
    case "fast-forward":
      return {
        label: `${input.label} again`,
        command: RECOVERY_COMMANDS_V1.stageAction,
        consequence: `Runs ${input.label} again by running this stage's own action.`,
      };
    case "generate-plan":
      return {
        label: "Generate Plan again",
        command: RECOVERY_COMMANDS_V1.generatePlan,
        consequence: "Starts Generate Plan again; a plan already written to disk is read first.",
      };
    case "draft-task":
      return {
        label: "Draft Task with AI again",
        command: RECOVERY_COMMANDS_V1.draftTask,
        consequence: "Starts Draft Task with AI again on this task's description.",
      };
    case "release":
      return {
        label: "Release again",
        command: RECOVERY_COMMANDS_V1.release,
        consequence: "Starts the release again from its first confirmation; nothing is published before you confirm.",
      };
    case "completion-checks":
      return { ...publish.checks, label: "Run Publish Checks again" };
    default:
      return undefined;
  }
}

/** Which Publish action the state recommends, and the one line saying why. */
export function recommendPublishActionV1(
  state: PublishChecksStateV1 | undefined
): { readonly action: "checks" | "fix" | "commit"; readonly reasoning: string } {
  switch (state) {
    case "passedOnCurrentTree":
      return { action: "commit", reasoning: "The Publish Checks already passed on these files, so there is nothing to re-run." };
    case "failed":
      return { action: "fix", reasoning: "The last Publish Checks run failed, so the fix round comes before any re-run." };
    default:
      return { action: "checks", reasoning: "There is no passing Publish Checks result for these files, so the checks come first." };
  }
}

export function planInterruptedRecoveryV1(input: InterruptedRecoveryInputV1): InterruptedRecoveryPlanV1 {
  const again = interruptedActionAgain(input);
  if (input.atPublish) {
    const publish = publishActions(input);
    const recommended = recommendPublishActionV1(input.checksState);
    const ordered = [publish[recommended.action], publish.checks, publish.fix, publish.commit, publish.complete].filter(
      (action, index, all) => all.findIndex((other) => other.command === action.command) === index
    );
    const interruptedRecommended =
      again !== undefined && again.command === publish[recommended.action].command ? again : undefined;
    const primary: RecoveryActionV1 = interruptedRecommended ?? publish[recommended.action];
    // What was interrupted is offered by name, right after the recommendation when it is not the recommendation.
    const rest = ordered.filter((action) => action.command !== primary.command).map((action) =>
      again !== undefined && action.command === again.command ? again : action
    );
    const interruptedFirst =
      again !== undefined ? [...rest.filter((action) => action === again), ...rest.filter((action) => action !== again)] : rest;
    return {
      primary,
      alternatives: interruptedFirst,
      reasoning:
        interruptedRecommended !== undefined
          ? `${interruptedRecommended.label.replace(/ again$/, "")} is what was interrupted, and it is also the next step: ${recommended.reasoning}`
          : recommended.reasoning,
    };
  }
  if (again !== undefined) {
    return {
      primary: again,
      alternatives: [],
      reasoning: `${input.label} was interrupted, so its outcome is unknown; starting it again is the safe way back.`,
    };
  }
  // bugs5 Step 12: no generic "Run Current Stage Action" guess. An operation that cannot be named
  // gets no action option; the owner is told to start it again from its own button.
  return {
    primary: undefined,
    alternatives: [],
    reasoning: `${input.label} was interrupted, so its outcome is unknown. Start it again from its own button when you are ready.`,
  };
}
