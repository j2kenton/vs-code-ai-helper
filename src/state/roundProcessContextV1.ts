import { AsyncLocalStorage } from "node:async_hooks";
import { heldAdmissionClaimIdForTaskV1 } from "./workAdmissionV1";

/**
 * Which task's admission lock a provider CLI started on the current async call
 * path runs under (1.0 RC1, Part B item 2).
 *
 * The V1 text transport (`createCliTextTransportV1`) is built by the provider
 * registry and never sees the caller's `WorkAdmissionHandleV1`, so it cannot be
 * handed a claim id the way the legacy `execCliAgent` path is. Every dispatch
 * that holds admission runs inside `runTrackedOperation`, keyed by the same
 * task folder path the admission marker is keyed by, so that one choke point
 * establishes this context and the transport resolves the CLAIM itself, at
 * spawn time, from this process's live admission handles. Scoped with
 * `AsyncLocalStorage`, not a module variable, because operations on different
 * tasks overlap freely.
 */
const taskFolder = new AsyncLocalStorage<string>();

/** Runs `fn` with `taskFolderPath` as the task whose lock its provider CLIs run under. */
export function runWithRoundProcessTaskFolderV1<T>(taskFolderPath: string, fn: () => Promise<T>): Promise<T> {
  return taskFolder.run(taskFolderPath, fn);
}

export interface RoundProcessRecordingTargetV1 {
  readonly taskFolderPath: string;
  readonly claimId: string;
}

/**
 * The lock a CLI spawned right now must be recorded against, or `undefined`
 * when the call path carries no task or this process holds no `admission` lock
 * for it (recording is then skipped, exactly as for a legacy caller with no
 * lock context).
 */
export function currentRoundProcessRecordingTargetV1(): RoundProcessRecordingTargetV1 | undefined {
  const taskFolderPath = taskFolder.getStore();
  if (taskFolderPath === undefined) {
    return undefined;
  }
  const claimId = heldAdmissionClaimIdForTaskV1(taskFolderPath);
  return claimId === undefined ? undefined : { taskFolderPath, claimId };
}
