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
 * re-derived when the option is later chosen. A plain in-process map
 * keyed by normalized folder path is enough: `fastForwardReviewWithAI` marks
 * its own task folder active for the whole of its own try/finally (which
 * wraps its entire multi-round `improveReviewScore` loop), and clears it
 * unconditionally in that same `finally` — so at any moment while Fast
 * Forward is genuinely mid-run for a task, and only then, a query against
 * this map answers correctly. Nothing here is durable across a window
 * reload; that is fine, because a reload also ends the in-memory Fast
 * Forward loop this is tracking.
 *
 * RC2 item 12: the map now also carries `attemptNumber`/`maxAttempts` — the
 * SAME live iteration counters `fastForwardReviewWithAI`'s own `apply()`
 * callback already tracks in its local closure — so a plateau card raised
 * mid-run (`reviewEscalation.ts`'s "Keep iterating" option) can bake the
 * exact iteration to resume from into its own dispatch args, for the same
 * "capture now, don't re-derive later" reason `resumeFastForward` above
 * already exists for. A plain boolean presence check
 * ({@link isFastForwardRunActiveV1}) is unaffected — it now reads as "this
 * key is present in the map" rather than "this key is in the set".
 */
export interface FastForwardRunStateV1 {
  readonly attemptNumber: number;
  readonly maxAttempts: number;
}

const activeFastForwardRuns = new Map<string, FastForwardRunStateV1>();

export function markFastForwardRunActiveV1(
  taskFolderPath: string,
  state: FastForwardRunStateV1 = { attemptNumber: 0, maxAttempts: 0 }
): void {
  activeFastForwardRuns.set(normalizePath(taskFolderPath), state);
}

/**
 * Updates the live iteration counters for an already-marked-active run.
 * A no-op when the folder was never marked active (or was already cleared) —
 * `fastForwardReviewWithAI`'s own `apply()` callback is the only caller, and
 * it only ever runs between that function's own mark/clear pair.
 */
export function updateFastForwardRunStateV1(taskFolderPath: string, state: FastForwardRunStateV1): void {
  const key = normalizePath(taskFolderPath);
  if (activeFastForwardRuns.has(key)) {
    activeFastForwardRuns.set(key, state);
  }
}

export function clearFastForwardRunActiveV1(taskFolderPath: string): void {
  activeFastForwardRuns.delete(normalizePath(taskFolderPath));
}

export function isFastForwardRunActiveV1(taskFolderPath: string): boolean {
  return activeFastForwardRuns.has(normalizePath(taskFolderPath));
}

/** The live iteration counters for an active run, or `undefined` when the
 * folder is not currently marked active. */
export function getFastForwardRunStateV1(taskFolderPath: string): FastForwardRunStateV1 | undefined {
  return activeFastForwardRuns.get(normalizePath(taskFolderPath));
}
