/**
 * bugs5 Step 18: the chat lines a decision-dispatched action says while it is starting, in the
 * owner's words. They name the action the owner chose and never use internal terms ("holds this
 * task", "admission", "the action"), and they never claim "no command has started" (a live
 * Publish Checks run counts as started).
 */
import { processAliveV1, type PublishChecksOutcomeV1 } from "./publishChecksOutcomeV1";

/** The first line, said once as soon as the task is held and nothing is visibly running yet. */
export function startingLineV1(actionName: string): string {
  return `${actionName} is starting — wait here; progress appears below.`;
}

/** Said once if the start takes longer than expected. */
export function stillStartingLineV1(actionName: string, minutes: number): string {
  return `${actionName} is still starting (${Math.round(minutes * 10) / 10} min).`;
}

/** Said when the task was released before anything ran, so the chat never ends on a start line. */
export function endedBeforeStartLineV1(actionName: string): string {
  return (
    `${actionName} stopped before it started, so nothing ran. ` +
    "The notification above says why; choose it again when that is resolved."
  );
}

/**
 * Whether the record on disk is a Publish Checks run that is going right now in a process that
 * is still alive. Such a run has started its commands even though no task operation is registered
 * for the announcer to see.
 */
export function isLivePublishChecksRunV1(
  record: PublishChecksOutcomeV1 | undefined,
  isProcessAlive: (pid: number) => boolean = processAliveV1
): boolean {
  return record !== undefined && record.outcome === "running" && isProcessAlive(record.pid);
}
