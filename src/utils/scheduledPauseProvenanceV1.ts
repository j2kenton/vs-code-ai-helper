/**
 * Which pause a scheduled rerun may lift (bugs2 finding 13).
 *
 * A quota stop pauses the task and schedules a rerun for the provider's reset
 * (`pauseTaskForExhaustedChainV1` + `scheduleQuotaResumeAtV1`). Before this,
 * the pause had no relationship to the schedule, so the rerun found the task
 * "paused, and nothing has resumed it" every minute and never ran on its own.
 * The stop now has an identity (`quotaParkRecord.stopId`) that the schedule
 * carries (`scheduledRun.quotaStopId`); when the schedule fires it may lift
 * exactly the pause that stop created and nothing else:
 *
 * - a pause the USER made (no workflow reason is recorded for it);
 * - a pause with another cause (the watchdog, a different quota stop, a
 *   refused resume — each overwrites or clears the quota record);
 * - a legacy record written before stop ids existed (no proof either way);
 *
 * all stay in force, and the card names which one it is.
 */
import type { TaskProgress } from "../types/taskProgress";
import { isStalledActivePauseReasonV1 } from "./taskWatchdogV1";

/**
 * True when `progress` is paused BY the quota stop `stopId` named: it carries a
 * workflow pause reason (a user pause records none, and resuming clears it) and
 * its quota record is that stop's.
 */
export function isPauseCreatedByQuotaStopV1(progress: TaskProgress, stopId: string | undefined): boolean {
  return (
    stopId !== undefined &&
    progress.status === "paused" &&
    progress.pausedReason !== undefined &&
    !isStalledActivePauseReasonV1(progress.pausedReason) &&
    progress.quotaParkRecord?.stopId === stopId
  );
}

/** What a scheduled rerun should do about the task's pause state when it fires. */
export type ScheduledPauseVerdictV1 =
  | { readonly kind: "notPaused" }
  | { readonly kind: "liftOwnQuotaPause" }
  | { readonly kind: "blocked"; readonly cause: string };

/** One sentence naming why the task is paused, for the "could not start" card. */
export function describePauseCauseV1(progress: TaskProgress, scheduledQuotaStopId: string | undefined): string {
  const reason = progress.pausedReason;
  if (reason === undefined) {
    return "you paused it";
  }
  if (isStalledActivePauseReasonV1(reason)) {
    return "the stalled-task watchdog paused it";
  }
  if (progress.quotaParkRecord?.stopId !== undefined && progress.quotaParkRecord.stopId !== scheduledQuotaStopId) {
    return scheduledQuotaStopId === undefined
      ? "a provider quota stop paused it, and this rerun was not scheduled for that stop"
      : "a different provider quota stop paused it than the one this rerun was scheduled for";
  }
  if (scheduledQuotaStopId === undefined) {
    return "it is paused for a reason this rerun was not scheduled for";
  }
  return "it is paused for another reason";
}

export function judgeScheduledRunPauseV1(
  progress: TaskProgress,
  run: { readonly quotaStopId?: string }
): ScheduledPauseVerdictV1 {
  if (progress.status !== "paused") {
    return { kind: "notPaused" };
  }
  if (isPauseCreatedByQuotaStopV1(progress, run.quotaStopId)) {
    return { kind: "liftOwnQuotaPause" };
  }
  return { kind: "blocked", cause: describePauseCauseV1(progress, run.quotaStopId) };
}
