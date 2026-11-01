/**
 * One plain name per workflow step (v1 fixes 2, items 14 + 25, step 10).
 *
 * The stage row (`progressLabel`), the tracked-operation label that every
 * notification is built from (`operationNotificationBridge`) and the chat
 * outcome line used to name the same step three different ways — "Running
 * review…" on the row, "Review" on the notification, `mode review` in the
 * transcript. A reader could not tell they described one round. Every surface
 * now takes its wording from this table, so the same step identity produces
 * the same words everywhere.
 *
 * Pure: no vscode, no fs.
 */

import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";

export type StepKindV1 = "review" | "re-review" | "apply-review" | "implementation" | "continuation";

interface StepWordingV1 {
  /** Noun form — the tracked-operation label, notification prefix and chat outcome line. */
  readonly name: string;
  /** Progress form — the stage row's in-flight status. */
  readonly progress: string;
}

const STEP_WORDING_V1: Readonly<Record<StepKindV1, StepWordingV1>> = {
  review: { name: "Review", progress: "Running review…" },
  "re-review": { name: "Re-running review", progress: "Re-running review…" },
  "apply-review": { name: "Apply Review", progress: "Applying review fixes…" },
  implementation: { name: "Run Implementation", progress: "Running implementation…" },
  continuation: { name: "Implementation continuation", progress: "Producing the missing implementation report (no edits)…" },
};

/** The step's plain name, e.g. "Apply Review". */
export function stepNameV1(step: StepKindV1): string {
  return STEP_WORDING_V1[step].name;
}

/** The step's in-flight wording for the stage row, e.g. "Applying review fixes…". */
export function stepProgressLabelV1(step: StepKindV1): string {
  return STEP_WORDING_V1[step].progress;
}

/**
 * The step's name as the chat outcome line states it. A step whose name is not
 * already the stage's own name is qualified by the stage it ran at —
 * "Apply Review (High-Level Code Review)" — while a stage's default action
 * keeps the bare stage name ("Implementation"), so the line never reads
 * "Implementation (Implementation)".
 */
export function stepOutcomeNameV1(step: StepKindV1, stageDisplayName: string): string {
  const name = stepNameV1(step);
  return name === stageDisplayName ? name : step === "implementation" ? stageDisplayName : `${name} (${stageDisplayName})`;
}

/**
 * bugs4 item 32: an Apply Review runs with the Implementation stage's role and
 * model chain, but it belongs to the review stage it applies. Progress and
 * "Started" lines name that stage, so a Low-Level Code Review Apply Review is
 * never read as the task having been sent back to Implementation.
 */
export function applyReviewTargetLabelV1(reviewStageDisplayName: string): string {
  return `Applying ${reviewStageDisplayName} findings (Implementation model)`;
}

/** The activity noun for a model-invocation line: "Running <activity> with <provider> — <model>.". */
export function applyReviewActivityV1(reviewStageDisplayName: string): string {
  return `Apply Review of ${reviewStageDisplayName} findings`;
}

/**
 * The chat's "Started / Progress / Resumed" label for a tracked operation:
 * "<label> — <stage>[: <detail>]". An Apply Review child names the review stage
 * it applies instead of the Implementation stage whose model chain it borrows,
 * and no line says "Implementation" alone unless that is the task's stage.
 */
export function operationChatLabelV1(
  operation: {
    readonly label: string;
    readonly stage?: TaskStage;
    readonly appliesStage?: TaskStage;
    readonly detail?: string;
    readonly activity?: string;
  },
  fallbackStage: TaskStage
): string {
  const detail = operation.detail ?? operation.activity;
  const suffix = detail ? `: ${detail}` : "";
  if (operation.appliesStage) {
    return `${applyReviewTargetLabelV1(STAGE_DISPLAY_NAMES[operation.appliesStage])}${suffix}`;
  }
  const stage = operation.stage ? STAGE_DISPLAY_NAMES[operation.stage] : STAGE_DISPLAY_NAMES[fallbackStage];
  return `${operation.label} — ${stage}${suffix}`;
}
