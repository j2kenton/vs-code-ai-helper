import * as vscode from "vscode";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import {
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1,
} from "../utils/taskWatchdogV1";
import { TaskProgress } from "../types/taskProgress";

/**
 * v1 fixes item 1, Part 1a — the architectural half of the resume/setup-phase
 * race this task exists to close, on the ADMISSION-ACQUIRING side (the
 * sweep-side half already exists: `scheduleTaskResume.ts`'s
 * `detectAndRepairStalledActiveTasksV1` re-checks admission immediately after
 * its own pause write and reverses if admission arrived in that narrow
 * window — but that only covers a pause that lands DURING that one sweep
 * pass. A pause that lands after the sweep pass has already finished — while
 * this command was still waiting on something else it does not control, like
 * a first-use consent dialog with no time bound — is invisible to that
 * check).
 *
 * A command that has JUST published a durable admission marker must re-read
 * the task's own status before proceeding to its setup phase and reverse a
 * pause the WATCHDOG wrote (identified by its own two known reasons, never by
 * "any pause") rather than be defeated by it — the marker is proof this
 * command is doing exactly the work the pause complained was silently
 * missing. A user-initiated pause (any other reason, including a quota park,
 * which also sets `status: "paused"` for a real, non-racing cause) is NEVER
 * reversed: this module only ever recognizes the watchdog's own two
 * constants, both owned by `taskWatchdogV1.ts`.
 */
export type WorkAdmissionPauseReconciliationV1 =
  | { readonly outcome: "notPaused" }
  | { readonly outcome: "reversed"; readonly progress: TaskProgress }
  | { readonly outcome: "userPaused"; readonly progress: TaskProgress }
  /** The progress file could not be read/decoded at all — the caller should
   * treat this the same as any other "could not resolve the task" failure. */
  | { readonly outcome: "unreadable" };

function isWatchdogProvenancePauseV1(reason: string | undefined): boolean {
  return reason === STALLED_ACTIVE_TASK_PAUSE_REASON_V1 || reason === UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1;
}

/**
 * Re-read `taskFolderUri`'s CURRENT persisted status and, if it is paused
 * with watchdog provenance, reverse it back to active in the same CAS write —
 * never touching any other field, and never reversing a pause whose reason is
 * not one of the watchdog's own two constants (including a pause that
 * resolved to something else between this check and the write landing, e.g.
 * a concurrent user pause — the field-scoped compare-and-swap re-validates
 * the reason immediately before writing, not just at the initial read).
 */
export async function reconcileWatchdogPauseAgainstAdmissionV1(
  taskFolderUri: vscode.Uri
): Promise<WorkAdmissionPauseReconciliationV1> {
  // Two plain out-of-band flags rather than a captured discriminated-union
  // variable: the callback below may run multiple times across
  // `patchTaskProgressStrictV1`'s own out-of-band-write retry loop, and only
  // the LAST invocation's verdict (immediately before either a real write or
  // a final no-op) matters — these flags are simply overwritten each call,
  // same as the write decision itself.
  let userPauseSnapshot: TaskProgress | undefined;
  let attemptedReversal = false;
  const result = await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    userPauseSnapshot = undefined;
    attemptedReversal = false;
    if (current.status !== "paused") {
      return undefined;
    }
    if (!isWatchdogProvenancePauseV1(current.pausedReason)) {
      userPauseSnapshot = current;
      return undefined;
    }
    attemptedReversal = true;
    return {
      ...current,
      status: "active",
      pausedReason: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
  if (result === undefined) {
    // The progress file could not be read/decoded — `patchTaskProgressStrictV1`
    // returns undefined only in that case (the callback itself never returns
    // undefined for a readable file; see the branches above).
    return { outcome: "unreadable" };
  }
  if (userPauseSnapshot) {
    return { outcome: "userPaused", progress: userPauseSnapshot };
  }
  if (attemptedReversal) {
    // Reflect the ACTUAL written state (with its bumped updatedAt/progressVersion).
    return { outcome: "reversed", progress: result };
  }
  return { outcome: "notPaused" };
}
