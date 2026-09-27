import { normalizePath } from "./taskRoot";

/**
 * Pre-1.0.0 fixes register, Part 3 Step 3: an escalation card's "Advance"
 * option must know, at the moment the card is BUILT, whether the process it
 * is interrupting was a Fast Forward run or a single stage action — "store
 * this on the decision's context" (the plan's own wording), added with no
 * new persisted progress field.
 *
 * `escalateReviewToHuman` pauses the task and posts the card from deep
 * inside `fastForwardReviewWithAI`'s own call stack when Fast Forward is
 * running it — by the time a HUMAN answers the card (seconds or days later),
 * that in-memory call stack is long gone, so the fact has to be captured at
 * escalation time and baked into the option's own dispatch args, not
 * re-derived when the option is later chosen. A plain in-process `Set`
 * keyed by normalized folder path is enough: `fastForwardReviewWithAI` marks
 * its own task folder active for the whole of its own try/finally (which
 * wraps its entire multi-round `improveReviewScore` loop), and clears it
 * unconditionally in that same `finally` — so at any moment while Fast
 * Forward is genuinely mid-run for a task, and only then, a query against
 * this set answers correctly. Nothing here is durable across a window
 * reload; that is fine, because a reload also ends the in-memory Fast
 * Forward loop this is tracking.
 */
const activeFastForwardTaskFolders = new Set<string>();

export function markFastForwardRunActiveV1(taskFolderPath: string): void {
  activeFastForwardTaskFolders.add(normalizePath(taskFolderPath));
}

export function clearFastForwardRunActiveV1(taskFolderPath: string): void {
  activeFastForwardTaskFolders.delete(normalizePath(taskFolderPath));
}

export function isFastForwardRunActiveV1(taskFolderPath: string): boolean {
  return activeFastForwardTaskFolders.has(normalizePath(taskFolderPath));
}
