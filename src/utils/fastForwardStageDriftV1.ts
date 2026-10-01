import type { TaskStage } from "../types/taskProgress";

/**
 * Where a task sits relative to the review a Fast Forward run is working on.
 *
 * - `atTarget`: the task is at the review's own stage; the run may dispatch.
 * - `notEntered`: the task never reached the review's stage (it is still at
 *   the stage the run started from, e.g. Implementation) — nothing can be
 *   applied, so the run is refused, not "completed".
 * - `movedOn`: the task left the review's stage during the run (e.g. a
 *   review auto-advanced it into Publish) — a follow-up run owns the new
 *   stage, so this one hands over instead of dispatching or reporting a stall.
 */
export type FastForwardStageDriftV1 = "atTarget" | "notEntered" | "movedOn";

export function classifyFastForwardStageV1(
  startStage: TaskStage,
  targetStage: TaskStage,
  currentStage: TaskStage
): FastForwardStageDriftV1 {
  if (currentStage === targetStage) {
    return "atTarget";
  }
  if (currentStage === startStage && startStage !== targetStage) {
    return "notEntered";
  }
  return "movedOn";
}
