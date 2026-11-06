/**
 * review1 Step 54: "and keep going". An auto-continuable card offers, beside its recommended option, the same option
 * with "and keep going". Choosing it runs the option as usual and records a run-scoped answer: later safe cards of
 * the same kind (same task, same decision key, same option) are then applied at once, each with a chat line, until the
 * answer expires, the owner presses Wait for me on a card of that kind, or the owner chooses its plain option.
 *
 * Pure: no `vscode`, no I/O. The store keeps the records; the chat view and the posting path call these helpers.
 */
import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { getFastForwardRunChainV1, getFastForwardSessionIdV1 } from "./activeFastForwardRunsV1";
import { isAutoContinueOptionV1, pickAutoContinueOptionV1 } from "./autoContinueV1";

export const KEEP_GOING_SUFFIX_V1 = ":keepGoing";
/** A backstop: the answer also ends after this long, whatever the run does. */
export const KEEP_GOING_TTL_MS_V1 = 8 * 60 * 60 * 1000;

/**
 * What "this run" means: this extension-host session and this task's current run chain (a Fast Forward run plus the
 * runs that explicitly continue it). `runEpoch` holds the chain id. The id goes up when a new chain starts and when
 * a chain ends (a run that ends for any reason but a pause for a card, an owner cancel, an automation-stopped card),
 * so an answer given in one run is dead once that run is over, and a window restart (a new session id) ends it too.
 */
export interface RunBindingV1 {
  readonly sessionId: string;
  readonly runEpoch: number;
}

export interface KeepGoingRecordV1 {
  readonly key: string;
  readonly recordedAt: string;
  /** Absent on records written before the binding existed; those never match. */
  readonly binding?: RunBindingV1;
}

/** The run that is current for this task right now. */
export function currentRunBindingV1(taskFolderPath: string): RunBindingV1 {
  return { sessionId: getFastForwardSessionIdV1(), runEpoch: getFastForwardRunChainV1(taskFolderPath) };
}

export function isKeepGoingOptionIdV1(optionId: string): boolean {
  return optionId.endsWith(KEEP_GOING_SUFFIX_V1);
}

export function baseOptionIdOfKeepGoingV1(optionId: string): string {
  return isKeepGoingOptionIdV1(optionId) ? optionId.slice(0, -KEEP_GOING_SUFFIX_V1.length) : optionId;
}

/** What "the same kind of card" means: the same task, decision key and option. */
export function keepGoingKeyV1(taskCanonicalId: string, decisionKey: string, optionId: string): string {
  return `${taskCanonicalId}\u0000${decisionKey}\u0000${optionId}`;
}

/**
 * The card's options plus "<option> and keep going" beside the option that would auto-continue. The sibling runs the
 * same effect; the card says, before it is chosen, what it additionally does.
 */
export function withKeepGoingOptionV1(
  options: readonly WorkflowDecisionOptionV1[],
  armedOptionId: string
): readonly WorkflowDecisionOptionV1[] {
  const base = options.find((option) => option.optionId === armedOptionId);
  if (!isAutoContinueOptionV1(base) || options.some((option) => option.optionId === `${armedOptionId}${KEEP_GOING_SUFFIX_V1}`)) {
    return options;
  }
  const keepGoing: WorkflowDecisionOptionV1 = {
    ...base,
    optionId: `${armedOptionId}${KEEP_GOING_SUFFIX_V1}`,
    label: `${base.label} and keep going`,
    consequence:
      `${base.consequence} It also keeps going: later cards of this kind in this run are applied at once, each with a ` +
      `line in the chat, until you press Wait for me on one or eight hours pass.`,
  };
  const index = options.findIndex((option) => option.optionId === armedOptionId);
  return [...options.slice(0, index + 1), keepGoing, ...options.slice(index + 1)];
}

/** True when a fresh pending card should be applied at once because the owner already said "keep going" for its kind. */
export function matchesKeepGoingV1(
  decision: Pick<WorkflowDecisionV1, "taskCanonicalId" | "decisionKey" | "options" | "recommendation" | "state">,
  records: readonly KeepGoingRecordV1[],
  nowMs: number,
  currentRun: RunBindingV1
): boolean {
  const option = pickAutoContinueOptionV1(decision);
  if (option === undefined) {
    return false;
  }
  const key = keepGoingKeyV1(decision.taskCanonicalId, decision.decisionKey, option.optionId);
  return records.some(
    (record) =>
      record.key === key &&
      record.binding !== undefined &&
      record.binding.sessionId === currentRun.sessionId &&
      record.binding.runEpoch === currentRun.runEpoch &&
      nowMs - Date.parse(record.recordedAt) < KEEP_GOING_TTL_MS_V1
  );
}

/** The chat line when a card was applied because of an earlier "keep going". */
export function describeKeepGoingAppliedLineV1(optionLabel: string): string {
  return `Continued automatically with ‘${optionLabel}’ (you chose to keep going earlier in this run).`;
}
