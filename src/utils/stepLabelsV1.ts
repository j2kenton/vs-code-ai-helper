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
