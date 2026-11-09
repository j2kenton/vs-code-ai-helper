/**
 * run1 Steps 28 and 31: who paused a task. Pause pressed by the owner is recorded here, so that
 * Fast Forward's paused ending can say "stopped because you paused the task" (an escalation that
 * paused the task raises its own card and is not recorded), and so a held answer or a countdown can
 * see that the owner's pause is in force. In memory, on the host that took the click; cleared when
 * the task is resumed.
 */
import * as path from "node:path";

const ownerPausedAtByTask = new Map<string, number>();

function key(taskFolderPath: string): string {
  return path.resolve(taskFolderPath);
}

export function recordOwnerPauseV1(taskFolderPath: string, at: number = Date.now()): void {
  ownerPausedAtByTask.set(key(taskFolderPath), at);
}

export function clearOwnerPauseV1(taskFolderPath: string): void {
  ownerPausedAtByTask.delete(key(taskFolderPath));
}

/** When the owner paused this task, while that pause is still in force. */
export function ownerPausedAtV1(taskFolderPath: string): number | undefined {
  return ownerPausedAtByTask.get(key(taskFolderPath));
}

/** True when the owner paused the task at or after `sinceMs` (for example, since a Fast Forward run began). */
export function wasPausedByOwnerSinceV1(taskFolderPath: string, sinceMs: number): boolean {
  const at = ownerPausedAtByTask.get(key(taskFolderPath));
  return at !== undefined && at >= sinceMs;
}
