/**
 * review2 Step 41: cards raised together from one round form one group. The follow-up run (the review an answer
 * promises) starts once the whole group is answered, or after an explicit "Run now", so the run reads a plan that holds
 * every answer. Run1, 2026-11-08 05:44 to 05:52: answering the review's card re-ran the review at once, while three
 * sibling answers sat held and landed after that review had read the plan.
 *
 * Pure: no `vscode`, no I/O. The in-memory ledger only remembers, per task, which answers are still waiting to be
 * written and which follow-up run is owed. The durable fallback for a reload is the "Run now" card the caller posts.
 */

export type FollowUpRunDecisionV1 =
  /** Start the run for this answer now. */
  | { readonly action: "start" }
  /** Start the run an earlier answer in the group owed; this answer started none. */
  | { readonly action: "start-owed" }
  /** The group is not fully answered: remember the run and say how many decisions are still open. */
  | { readonly action: "hold"; readonly open: number }
  | { readonly action: "none" };

export interface FollowUpRunInputV1 {
  /** True when the answer just recorded is one that starts a run (a plain approval or a rejection does not). */
  readonly startsRun: boolean;
  /** Other pending cards of the same round's group, not counting the one just answered. */
  readonly openSiblings: number;
  /** Other answers of the group that are recorded but not yet written to plan-final.md (a round was running). */
  readonly heldWritesRemaining: number;
  /** An earlier answer in the group owes a run that is still waiting. */
  readonly owedFromEarlier: boolean;
}

export function decideFollowUpRunV1(input: FollowUpRunInputV1): FollowUpRunDecisionV1 {
  const open = input.openSiblings + input.heldWritesRemaining;
  if (input.startsRun) {
    return open > 0 ? { action: "hold", open } : { action: "start" };
  }
  return open === 0 && input.owedFromEarlier ? { action: "start-owed" } : { action: "none" };
}

/** "2 decisions from this round" (one decision reads "1 decision from this round"). */
export function describeDecisionGroupV1(count: number): string {
  return `${count} decision${count === 1 ? "" : "s"} from this round`;
}

/** The chat line when a run is held for the rest of its group. */
export function describeHeldFollowUpRunV1(open: number): string {
  return (
    `Your answer is recorded. The review it starts waits until the other ${describeDecisionGroupV1(open)} ` +
    `${open === 1 ? "is" : "are"} answered, so it reads every answer. Choose "Run now" on the card below to start it without waiting.`
  );
}

const heldWrites = new Map<string, Set<string>>();
const owedRuns = new Map<string, unknown>();

/** Remember that `blockerId`'s answer is recorded but not yet written. */
export function noteHeldWriteV1(canonicalId: string, blockerId: string): void {
  const set = heldWrites.get(canonicalId) ?? new Set<string>();
  set.add(blockerId);
  heldWrites.set(canonicalId, set);
}

/** The answer's write has landed. */
export function releaseHeldWriteV1(canonicalId: string, blockerId: string): void {
  const set = heldWrites.get(canonicalId);
  if (set === undefined) return;
  set.delete(blockerId);
  if (set.size === 0) heldWrites.delete(canonicalId);
}

/** Held writes of the task other than `exceptBlockerId`'s own. */
export function heldWritesRemainingV1(canonicalId: string, exceptBlockerId: string): number {
  const set = heldWrites.get(canonicalId);
  if (set === undefined) return 0;
  return [...set].filter((id) => id !== exceptBlockerId).length;
}

export function rememberOwedRunV1(canonicalId: string, run: unknown): void {
  owedRuns.set(canonicalId, run);
}

export function peekOwedRunV1(canonicalId: string): unknown {
  return owedRuns.get(canonicalId);
}

/** Take (and clear) the run the group owes; undefined when none. Also used by "Run now". */
export function takeOwedRunV1(canonicalId: string): unknown {
  const run = owedRuns.get(canonicalId);
  owedRuns.delete(canonicalId);
  return run;
}

/** Test seam. */
export function resetOwnerAnswerGroupsV1TestOnly(): void {
  heldWrites.clear();
  owedRuns.clear();
}
