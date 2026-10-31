/**
 * bugs3 Step 3: how a dispatched automation command tells the automation chain
 * what its round actually ended as.
 *
 * `automationChain` terminalizes the generic round-ledger row it opened for a
 * dispatch when the command's promise settles, and until now it could only tell
 * "returned `false`" (declined) from "returned anything else" (completed). A
 * Plan generation whose every candidate failed returns normally, so the row
 * ended `completed` with no attempt ids even though two providers had been
 * invoked and no `plan.md` was written. A command that knows its round failed
 * or was cancelled reports that here, keyed by task folder; the chain clears
 * the slot before dispatch and takes it after, so a stale report from an
 * earlier command can never decide a later round.
 */
export type AutomationCommandOutcomeV1 =
  | {
      readonly state: "failed";
      /** Why the round failed — the same text the user-facing failure carries. */
      readonly reason: string;
      /** Every attempt the round allocated or invoked, including those with no provider report. */
      readonly attemptIds: readonly string[];
    }
  | {
      readonly state: "cancelled";
      readonly reason: string;
      readonly attemptIds: readonly string[];
    };

const reportedOutcomesV1 = new Map<string, AutomationCommandOutcomeV1>();
/**
 * Tasks whose dispatched command is running under the chain right now. The
 * chain will close that dispatch's ledger row, and the ledger posts the
 * round's one "Ended" line, so the command need not post its own.
 */
const armedTasksV1 = new Set<string>();

/**
 * Report the round's settled outcome to the chain. Returns true when a chain
 * dispatch is waiting on it, i.e. the round ledger will post the terminal line
 * and the caller's operation observer must stay silent for this operation.
 */
export function reportAutomationCommandOutcomeV1(taskKey: string, outcome: AutomationCommandOutcomeV1): boolean {
  reportedOutcomesV1.set(taskKey, outcome);
  return armedTasksV1.has(taskKey);
}

/** Called by the chain right before it dispatches: drops any stale report and arms the slot. */
export function clearAutomationCommandOutcomeV1(taskKey: string | undefined): void {
  if (taskKey) {
    reportedOutcomesV1.delete(taskKey);
    armedTasksV1.add(taskKey);
  }
}

/** Called by the chain when the dispatched command rejected, so the slot does not stay armed. */
export function disarmAutomationCommandOutcomeV1(taskKey: string | undefined): void {
  if (taskKey) {
    reportedOutcomesV1.delete(taskKey);
    armedTasksV1.delete(taskKey);
  }
}

/** Read the reported outcome once; a second read returns `undefined`. */
export function takeAutomationCommandOutcomeV1(taskKey: string | undefined): AutomationCommandOutcomeV1 | undefined {
  if (!taskKey) {
    return undefined;
  }
  const outcome = reportedOutcomesV1.get(taskKey);
  reportedOutcomesV1.delete(taskKey);
  armedTasksV1.delete(taskKey);
  return outcome;
}
