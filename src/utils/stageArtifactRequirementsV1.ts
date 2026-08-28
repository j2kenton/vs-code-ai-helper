/**
 * Single source of truth for "what artifact must already exist before this
 * stage action can run" — and the exact user-facing text that says so.
 *
 * Before this module, the requirement and the refusal text it justified were
 * two independently-maintained strings living at the call site that hits the
 * missing file. They agreed by accident, and the refusal always arrived
 * after the attempt (see the task-level context: "No plan-final.md or
 * implementation.md found..." and "No plan found (or it is empty)..." were
 * both accurate and both arrived only once the user had already clicked the
 * action). This module lets a pre-flight surface (a tooltip, an enablement
 * check) and the actual refusal both read the same requirement record, so
 * the two can never drift apart, and lets the pre-flight surface exist at
 * all.
 */
import {
  IMPLEMENTATION_FILENAME,
  IMPLEMENTATION_SUMMARY_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
  PLAN_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  TaskStage,
} from "../types/taskProgress";
import * as vscode from "vscode";
import { statIfExists } from "./fileUtils";

/** Which artifact family a requirement is about — used only to group/label; the message and label strings below are the actual source of truth. */
export type StageArtifactIdV1 = "plan" | "implementationArtifact" | "implementationNotes";

/** One "this must exist before that action can run" fact. */
export interface StageArtifactRequirementV1 {
  /** Which artifact family this is (informational). */
  readonly artifactId: StageArtifactIdV1;
  /** Short, stage-neutral description for pre-flight surfacing, e.g. "plan.md". */
  readonly requirementLabel: string;
  /** The stage whose completion normally produces this artifact. */
  readonly producedByStage: TaskStage;
  /** The exact refusal text shown when this requirement is unmet. */
  readonly missingMessage: string;
}

/**
 * The named actions a task-tree/review-command surface can take, each gated
 * by its own artifact requirements.
 *
 * `applyReview` is deliberately split into `applyReviewPlan` (plan-review
 * stages, needs plan.md) and `applyReviewImplementation` (implementation-
 * review stages, needs plan-final.md) rather than one action id read by
 * index — the two check different artifacts on different stages, and a
 * single `firstUnmetStageActionRequirementV1` walk over one action's
 * requirement list must never mix them.
 */
export type StageActionIdV1 =
  | "reviewPlan"
  | "reviewImplementation"
  | "applyReviewPlan"
  | "applyReviewImplementation"
  | "runImplementation"
  | "generateImplementationChecklist";

const PLAN_REQUIREMENT_FOR_PLAN_REVIEW: StageArtifactRequirementV1 = {
  artifactId: "plan",
  requirementLabel: PLAN_FILENAME,
  producedByStage: "plan",
  missingMessage:
    "No plan found (or it is empty). Generate or write a plan first — " +
    `${PLAN_FILENAME} is produced by the plan stage.`,
};

const PLAN_REQUIREMENT_FOR_IMPLEMENTATION_REVIEW: StageArtifactRequirementV1 = {
  artifactId: "plan",
  requirementLabel: PLAN_FILENAME,
  producedByStage: "plan",
  missingMessage:
    "No plan found (or it is empty). Generate or write a plan before reviewing implementation — " +
    `${PLAN_FILENAME} is produced by the plan stage.`,
};

const PLAN_REQUIREMENT_FOR_APPLY_REVIEW: StageArtifactRequirementV1 = {
  artifactId: "plan",
  requirementLabel: PLAN_FILENAME,
  producedByStage: "plan",
  missingMessage:
    "No plan found (or it is empty). Nothing to apply the review to — " +
    `${PLAN_FILENAME} is produced by the plan stage.`,
};

const IMPLEMENTATION_NOTES_REQUIREMENT: StageArtifactRequirementV1 = {
  artifactId: "implementationNotes",
  requirementLabel: `${IMPLEMENTATION_SUMMARY_FILENAME} or ${IMPLEMENTATION_FILENAME}`,
  producedByStage: "impl",
  missingMessage:
    `No implementation notes found (${IMPLEMENTATION_SUMMARY_FILENAME} and ${IMPLEMENTATION_FILENAME} are ` +
    "missing or empty). Run the implementation step first — these are produced by the implementation stage.",
};

const IMPLEMENTATION_ARTIFACT_REQUIREMENT_FOR_APPLY: StageArtifactRequirementV1 = {
  artifactId: "implementationArtifact",
  requirementLabel: IMPLEMENTATION_FILENAME,
  producedByStage: "impl",
  missingMessage:
    `No ${IMPLEMENTATION_FILENAME} found. Nothing to apply the review to — ` +
    `${IMPLEMENTATION_FILENAME} is produced by the implementation stage.`,
};

const IMPLEMENTATION_ARTIFACT_REQUIREMENT_FOR_RUN: StageArtifactRequirementV1 = {
  artifactId: "implementationArtifact",
  requirementLabel: `${IMPLEMENTATION_FILENAME} (or legacy ${LEGACY_IMPLEMENTATION_FILENAME})`,
  producedByStage: "plan",
  missingMessage:
    `No ${IMPLEMENTATION_FILENAME} or ${LEGACY_IMPLEMENTATION_FILENAME} found. ` +
    "Generate an implementation plan before running implementation — " +
    `${IMPLEMENTATION_FILENAME} is produced by promoting the plan stage's plan into the implementation stage.`,
};

const PLAN_REQUIREMENT_FOR_GENERATE_CHECKLIST: StageArtifactRequirementV1 = {
  artifactId: "plan",
  requirementLabel: `${PLAN_FILENAME} or ${IMPLEMENTATION_FILENAME}`,
  producedByStage: "plan",
  missingMessage:
    "No plan found. Write or generate a plan first — " +
    `${PLAN_FILENAME} is produced by the plan stage.`,
};

/** The complete, ordered requirement list for each stage action. Every call site that refuses for a missing artifact, and every pre-flight surface that wants to warn about the same thing in advance, reads from here. */
export const STAGE_ACTION_ARTIFACT_REQUIREMENTS_V1: Readonly<Record<StageActionIdV1, readonly StageArtifactRequirementV1[]>> = {
  reviewPlan: [PLAN_REQUIREMENT_FOR_PLAN_REVIEW],
  reviewImplementation: [PLAN_REQUIREMENT_FOR_IMPLEMENTATION_REVIEW, IMPLEMENTATION_NOTES_REQUIREMENT],
  applyReviewPlan: [PLAN_REQUIREMENT_FOR_APPLY_REVIEW],
  applyReviewImplementation: [IMPLEMENTATION_ARTIFACT_REQUIREMENT_FOR_APPLY],
  runImplementation: [IMPLEMENTATION_ARTIFACT_REQUIREMENT_FOR_RUN],
  generateImplementationChecklist: [PLAN_REQUIREMENT_FOR_GENERATE_CHECKLIST],
};

/**
 * Artifacts which make a stage completion meaningful. This intentionally
 * reuses the canonical stage-to-artifact map: completion must not invent a
 * second idea of what a stage produces. `desc` is task.md, created with every
 * loadable task, so its completion check is a documented no-op in practice.
 */
export const STAGE_COMPLETION_ARTIFACTS_V1: Readonly<Record<TaskStage, readonly string[]>> =
  {
    desc: STAGE_ARTIFACT_FILENAMES.desc === undefined ? [] : [STAGE_ARTIFACT_FILENAMES.desc],
    plan: STAGE_ARTIFACT_FILENAMES.plan === undefined ? [] : [STAGE_ARTIFACT_FILENAMES.plan],
    "plan-high-review": STAGE_ARTIFACT_FILENAMES["plan-high-review"] === undefined ? [] : [STAGE_ARTIFACT_FILENAMES["plan-high-review"]],
    "plan-low-review": STAGE_ARTIFACT_FILENAMES["plan-low-review"] === undefined ? [] : [STAGE_ARTIFACT_FILENAMES["plan-low-review"]],
    impl: STAGE_ARTIFACT_FILENAMES.impl === undefined ? [] : [STAGE_ARTIFACT_FILENAMES.impl],
    "impl-high-review": STAGE_ARTIFACT_FILENAMES["impl-high-review"] === undefined ? [] : [STAGE_ARTIFACT_FILENAMES["impl-high-review"]],
    "impl-low-review": STAGE_ARTIFACT_FILENAMES["impl-low-review"] === undefined ? [] : [STAGE_ARTIFACT_FILENAMES["impl-low-review"]],
    publish: STAGE_ARTIFACT_FILENAMES.publish === undefined ? [] : [STAGE_ARTIFACT_FILENAMES.publish],
  };

/** Return the canonical completion artifacts absent from a task folder. */
export async function missingCompletionArtifactsV1(
  folderUri: vscode.Uri,
  stage: TaskStage
): Promise<readonly string[]> {
  const required = STAGE_COMPLETION_ARTIFACTS_V1[stage];
  const missing: string[] = [];
  for (const artifact of required) {
    if ((await statIfExists(vscode.Uri.joinPath(folderUri, artifact))) === undefined) {
      missing.push(artifact);
    }
  }
  return missing;
}

/**
 * Which stage action a review/apply attempt against a given `TaskStage`
 * exercises — `undefined` for stages with no artifact-requirement entry
 * (e.g. "desc", "impl", which gate differently or not at all here).
 */
export function stageActionForReviewV1(stage: TaskStage): StageActionIdV1 | undefined {
  if (stage === "plan-high-review" || stage === "plan-low-review") {
    return "reviewPlan";
  }
  if (stage === "impl-high-review" || stage === "impl-low-review" || stage === "publish") {
    return "reviewImplementation";
  }
  return undefined;
}

/**
 * The ordered list of stage actions a pre-flight surface (a task-tree
 * tooltip, an enablement check) should warn about for a given `TaskStage`,
 * before the user has clicked anything. Ordered so the more fundamental
 * action's requirement (e.g. Review, before Apply can make sense) is
 * reported first when several are unmet at once. `[]` for stages with no
 * artifact-gated action (e.g. "desc", "plan" itself).
 */
export function stageActionsForPreflightV1(stage: TaskStage): readonly StageActionIdV1[] {
  if (stage === "plan-high-review" || stage === "plan-low-review") {
    return ["reviewPlan", "applyReviewPlan"];
  }
  if (stage === "impl") {
    return ["runImplementation"];
  }
  if (stage === "impl-high-review" || stage === "impl-low-review" || stage === "publish") {
    return ["reviewImplementation", "applyReviewImplementation"];
  }
  return [];
}

/** The requirement list for one stage action, or `[]` if the action has none recorded. */
export function requirementsForStageActionV1(actionId: StageActionIdV1): readonly StageArtifactRequirementV1[] {
  return STAGE_ACTION_ARTIFACT_REQUIREMENTS_V1[actionId] ?? [];
}

/**
 * The exact refusal text for one requirement of one stage action, by index
 * into {@link requirementsForStageActionV1}'s list — the single accessor
 * every refusal call site uses, so a requirement can never be renumbered out
 * from under a caller without a compile-time-visible throw.
 */
export function stageActionRequirementMessageV1(actionId: StageActionIdV1, index: number): string {
  const requirement = requirementsForStageActionV1(actionId)[index];
  if (!requirement) {
    throw new Error(`stageArtifactRequirementsV1: no requirement at index ${index} for action "${actionId}"`);
  }
  return requirement.missingMessage;
}

/**
 * A short, human-readable "needs X" line for pre-flight surfacing (e.g. a
 * tree tooltip), naming every requirement of the action and which stage
 * produces it. Does not check the filesystem — callers combine this with
 * their own presence check to say which requirement is currently missing.
 */
export function describeStageActionRequirementsV1(actionId: StageActionIdV1): string {
  const requirements = requirementsForStageActionV1(actionId);
  if (requirements.length === 0) {
    return "";
  }
  return requirements
    .map(req => `needs ${req.requirementLabel} (produced by the ${req.producedByStage} stage)`)
    .join("; ");
}
