/**
 * bugs5 Step 24 (item 12): an Apply Review that is dispatched to do ONE thing — gather the evidence a blocker
 * asks for — must work on that blocker and not on every task-fixable blocker in the review.
 *
 * The focus is held in memory for the dispatching call only: `resumeAndApplyCurrentStageActionV1` sets it before
 * it dispatches and clears it in a `finally`, and the Apply Review prompt builder reads it while it is set. A
 * window restart loses it on purpose; the next dispatch is then an ordinary Apply Review.
 *
 * Pure: no `vscode`, no I/O.
 */

const focusByTaskV1 = new Map<string, string>();

function keyV1(taskFolderPath: string): string {
  return taskFolderPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function setApplyReviewFocusV1(taskFolderPath: string, blocker: string): void {
  const trimmed = blocker.trim();
  if (trimmed.length === 0) {
    focusByTaskV1.delete(keyV1(taskFolderPath));
    return;
  }
  focusByTaskV1.set(keyV1(taskFolderPath), trimmed);
}

export function clearApplyReviewFocusV1(taskFolderPath: string): void {
  focusByTaskV1.delete(keyV1(taskFolderPath));
}

export function peekApplyReviewFocusV1(taskFolderPath: string): string | undefined {
  return focusByTaskV1.get(keyV1(taskFolderPath));
}

/**
 * The block appended to the review text a focused Apply Review is given. Empty when no focus is set, so an
 * ordinary Apply Review is unchanged.
 */
export function formatApplyReviewFocusBlockV1(focus: string | undefined): string {
  if (!focus) {
    return "";
  }
  return (
    "\n\n## Round focus (set by the owner's choice)\n\n" +
    "The owner chose \"Let the AI gather it\" for exactly one blocker. This round's work is ONLY that blocker; " +
    "do not work on the review's other blockers.\n\n" +
    `Blocker: ${focus}\n\n` +
    "Gather the evidence it asks for yourself: run what you can safely run (a CLI in a throwaway folder outside " +
    "the workspace, a read-only command), save the evidence under the task's `evidence/` folder, and record in " +
    "your summary what you tried and what it showed. If it truly needs the owner's machine, an account, a " +
    "payment or their judgement, say which and why an agent cannot get it.\n"
  );
}
