/**
 * bugs4 item 36: when the no-progress breaker stops further automatic rounds, the
 * chat said the next round was "refused" with no reason and that Fast Forward
 * "succeeded". This module owns the one sentence for the stop and the short-lived
 * record that lets Fast Forward end as "stopped" rather than "succeeded".
 *
 * Pure apart from a small in-memory map keyed by task folder (the same shape as
 * the stage-action refusal record); no vscode, no I/O.
 */
import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";

const REVIEW_STAGES_V1: ReadonlySet<TaskStage> = new Set<TaskStage>([
  "plan-high-review",
  "plan-low-review",
  "impl-high-review",
  "impl-low-review",
]);

/** "Apply Review" at a review stage, "Implementation" otherwise. */
export function breakerStoppedRoundLabelV1(stage: TaskStage): string {
  return REVIEW_STAGES_V1.has(stage) ? "Apply Review" : "Implementation";
}

/**
 * "<round> (<stage>) not started: no-progress breaker (N rounds with no changes).
 * Waiting for your decision."
 */
export function describeBreakerStopV1(stage: TaskStage, zeroChangeRounds: number): string {
  const rounds = `${zeroChangeRounds} round${zeroChangeRounds === 1 ? "" : "s"} with no changes`;
  return (
    `${breakerStoppedRoundLabelV1(stage)} (${STAGE_DISPLAY_NAMES[stage] ?? stage}) not started: ` +
    `no-progress breaker (${rounds}). Waiting for your decision.`
  );
}

/** How Fast Forward's own ending reads when the breaker stopped it. */
export function describeBreakerFastForwardEndV1(stage: TaskStage, zeroChangeRounds: number): string {
  return (
    `stopped by the no-progress breaker at ${STAGE_DISPLAY_NAMES[stage] ?? stage} ` +
    `(${zeroChangeRounds} round${zeroChangeRounds === 1 ? "" : "s"} with no changes); waiting for your decision`
  );
}

interface BreakerStopRecordV1 {
  readonly stage: TaskStage;
  readonly zeroChangeRounds: number;
  readonly at: number;
}

const breakerStopsV1 = new Map<string, BreakerStopRecordV1>();

export function recordBreakerStopV1(
  taskFolderPath: string,
  stage: TaskStage,
  zeroChangeRounds: number,
  at: number = Date.now()
): void {
  breakerStopsV1.set(taskFolderPath, { stage, zeroChangeRounds, at });
}

export function clearBreakerStopV1(taskFolderPath: string): void {
  breakerStopsV1.delete(taskFolderPath);
}

/**
 * The breaker stop recorded at or after `since` for this task, consumed once. A
 * stop from before the Fast Forward run began belongs to an earlier event.
 */
export function takeBreakerStopSinceV1(taskFolderPath: string, since: number): BreakerStopRecordV1 | undefined {
  const record = breakerStopsV1.get(taskFolderPath);
  if (!record || record.at < since) {
    return undefined;
  }
  breakerStopsV1.delete(taskFolderPath);
  return record;
}
