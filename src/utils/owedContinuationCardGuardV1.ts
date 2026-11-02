/**
 * bugs5 Step 14: while an owed implementation continuation exists (waiting, claimed or running),
 * the continuation owns the next step. A "Run Implementation" or "Run Review next" card raised in
 * that window is wrong twice over: the sweep or the owner's Run now starts the continuation
 * anyway, and the card is then superseded seconds later. Cards of that kind are held back, and
 * the normal next step is raised once the owed state clears.
 */
import type { TaskProgress } from "../types/taskProgress";

/** True when the task still owes an implementation continuation. */
export function hasOwedImplContinuationV1(progress: Pick<TaskProgress, "implRecovery"> | undefined): boolean {
  return progress?.implRecovery !== undefined;
}
