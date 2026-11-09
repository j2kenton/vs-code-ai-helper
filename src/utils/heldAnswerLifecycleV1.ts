/**
 * run1 Steps 26 to 30: the rules for an owner's answer that was held while a round ran.
 *
 * Pure of VS Code and of storage. The record lives on the decision (`WorkflowDecisionDeferredAnswerV1`, kind
 * `heldOption`); the swap that makes "held to dispatching" happen once is the store's
 * `swapHeldAnswerState`. This module decides what may happen next and says it in plain words:
 * - whether a held answer may be dispatched now, or must wait for the owner (Pause and Cancel win);
 * - what activation does with each state (a crash can leave an answer half-dispatched, and it is never
 *   re-run by itself when nothing shows whether it ran);
 * - whether Fast Forward yields to a held answer at a round boundary;
 * - the sentences for the chat and the running row.
 */
import type { HandoffGatingV1 } from "../types/handoffGuidanceV1";
import type { TaskStage } from "../types/taskProgress";
import type {
  HeldAnswerStateV1,
  WorkflowDecisionDeferredAnswerV1,
  WorkflowDecisionOptionV1,
  WorkflowDecisionRecommendationV1,
} from "../types/workflowDecisionV1";

/** How the task's last run ended, as far as the owner's own actions go. */
export type LastRunEndedByV1 = "owner" | "runHeldAnswer" | "other";

export interface HeldDispatchFactsV1 {
  /** Read from the task's progress inside the same task lock that takes the claim. */
  readonly taskStatus: "active" | "paused" | undefined;
  readonly lastRunEndedBy: LastRunEndedByV1;
  /** The owner pressed "Run it now" (Step 30) or "Run it" on the waiting card: a go-ahead for this answer. */
  readonly runNowRequestedAt?: string;
}

export type HeldDispatchVerdictV1 =
  | { readonly kind: "dispatch" }
  | { readonly kind: "waitForOwner"; readonly reason: "paused" | "cancelledByOwner" };

/**
 * Pause and Cancel win over a held answer. A pause, or a last run the owner cancelled, means the answer does
 * not run by itself: the owner is asked. The owner's own "Run it now" (a cancel with reason `runHeldAnswer`)
 * is the go-ahead, and so is "Run it" on the waiting card; only an ordinary Cancel blocks.
 */
export function decideHeldDispatchV1(facts: HeldDispatchFactsV1): HeldDispatchVerdictV1 {
  if (facts.runNowRequestedAt !== undefined || facts.lastRunEndedBy === "runHeldAnswer") {
    return { kind: "dispatch" };
  }
  if (facts.taskStatus === "paused") {
    return { kind: "waitForOwner", reason: "paused" };
  }
  if (facts.lastRunEndedBy === "owner") {
    return { kind: "waitForOwner", reason: "cancelledByOwner" };
  }
  return { kind: "dispatch" };
}

/** What the claim and the ledger show about a dispatch that was started under a `dispatchId`. */
export interface HeldDispatchTraceV1 {
  readonly ledgerRow: "none" | "open" | "closed";
  readonly claim: "none" | "live" | "stale";
  readonly claimCarriesDispatchId: boolean;
  /**
   * The command was about to be executed when the answer was last written (`commandStartedAt`). A command
   * that takes no work admission leaves no other trace, so this alone means "it may have had an effect".
   */
  readonly commandStarted?: boolean;
  /**
   * A live operation for the task is registered in this window or mirrored from the runner. A dispatch whose
   * command had started, whose claim still carries its id, and that has no live operation and no ledger row
   * is one whose process is gone: it may or may not have had its effect.
   */
  readonly operationLive?: boolean;
}

/**
 * Reads the trace of a dispatch from the task's round ledger (rows stamped with `heldDispatchId`) and from the
 * admission markers. A row still scheduled or open means the dispatched operation is running; any terminal row
 * means it has run.
 */
export function buildHeldDispatchTraceV1(
  dispatchId: string,
  ledger: readonly { readonly state: string; readonly heldDispatchId?: string }[],
  claim: { readonly claim: "none" | "live" | "stale"; readonly claimCarriesDispatchId: boolean },
  commandStarted = false,
  operationLive?: boolean
): HeldDispatchTraceV1 {
  const rows = ledger.filter((row) => row.heldDispatchId === dispatchId);
  const ledgerRow: HeldDispatchTraceV1["ledgerRow"] =
    rows.length === 0
      ? "none"
      : rows.some((row) => row.state === "scheduled" || row.state === "open")
        ? "open"
        : "closed";
  return {
    ledgerRow,
    claim: claim.claim,
    claimCarriesDispatchId: claim.claimCarriesDispatchId,
    commandStarted,
    ...(operationLive !== undefined ? { operationLive } : {}),
  };
}

export type HeldReconcileActionV1 =
  /** Held: wait for the round boundary again. */
  | "rearm"
  /** Dispatched and still running: mark it ran when that operation ends. */
  | "markRanWhenEnds"
  /** Dispatched and finished: mark it ran now. */
  | "markRan"
  /** The dispatch never started: back to held, then through the usual checks. */
  | "backToHeld"
  /** Cannot tell whether it ran: ask the owner. Never re-run by itself. */
  | "uncertain"
  /** Nothing to do (waiting for the owner, or already final). */
  | "leave";

/** What activation does with one held answer. Replaces a plain re-arm. */
export function reconcileHeldAnswerV1(
  state: HeldAnswerStateV1,
  trace: HeldDispatchTraceV1 | undefined
): HeldReconcileActionV1 {
  switch (state) {
    case "held":
      return "rearm";
    case "waitingForOwner":
    case "ran":
    case "dropped":
    case "uncertain":
      return "leave";
    case "dispatching": {
      // With no way to read the trace, the only safe answer is to ask.
      if (trace === undefined) {
        return "uncertain";
      }
      if (trace.ledgerRow === "open") {
        return "markRanWhenEnds";
      }
      if (trace.ledgerRow === "closed") {
        return "markRan";
      }
      if (trace.claim === "stale") {
        return "uncertain";
      }
      if (trace.claim === "live" && trace.claimCarriesDispatchId) {
        // The claim is the dispatch's own, but nothing is running under it and the command had started: its
        // process is gone, so whether the command took effect is unknown. Ask; never mark it ran or re-run it.
        if (trace.commandStarted === true && trace.operationLive === false) {
          return "uncertain";
        }
        return "markRanWhenEnds";
      }
      // The command was about to run and left no claim or ledger row: it may have been one that takes no work
      // admission and already had its effect. Ask, never re-run.
      if (trace.commandStarted === true) {
        return "uncertain";
      }
      // No ledger row, no sign the command started, and either no claim or another operation's claim: this
      // dispatch never started.
      return "backToHeld";
    }
  }
}

/**
 * At a Fast Forward round boundary: yield to a held answer. A held answer runs ahead of the next same-stage
 * round, so Fast Forward ends there and the answer is dispatched through the task's work admission.
 */
export function shouldFastForwardYieldToHeldAnswerV1(
  answer: WorkflowDecisionDeferredAnswerV1 | undefined
): boolean {
  return answer?.kind === "heldOption" && answer.heldState === "held";
}

function clock(iso: string | undefined): string {
  if (!iso) {
    return "earlier";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "earlier";
  }
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

/** Step 29, at the start. */
export function describeHeldAnswerStartingV1(label: string, chosenAt: string | undefined, heldWhile: string): string {
  return `Running your '${label}' (chosen ${clock(chosenAt)}, held while ${heldWhile}).`;
}

/** Step 27: the chat line when Fast Forward ends at a round boundary to run a held answer. */
export function describeFastForwardYieldedToHeldAnswerV1(label: string): string {
  return `Fast Forward stopped to run your held '${label}'.`;
}

/** Step 29, when one is dropped: the reason, and that the card is back. */
export function describeHeldAnswerDroppedV1(label: string, reason: string): string {
  return `Your held '${label}' was not run: ${reason} The card is back; choose it again if you still want it.`;
}

/** Step 28: the chat line when Pause or Cancel kept the answer from running. */
export function describeHeldAnswerWaitingForOwnerV1(
  label: string,
  reason: "paused" | "cancelledByOwner"
): string {
  const why = reason === "paused" ? "the task is paused" : "you cancelled the last round";
  return `Your held '${label}' has not run, because ${why}. Run your held '${label}' now? Choose Run it or Drop it on the card below.`;
}

/** Step 26: the card text when a restart left no way to tell whether the answer ran. */
export function describeHeldAnswerUncertainV1(label: string, chosenAt: string | undefined, stageName: string): string {
  return (
    `Your '${label}' (chosen ${clock(chosenAt)}) may or may not have run before Ensemble restarted. ` +
    `The task is now at ${stageName}. Ensemble will not run it again by itself: choose it again if it did not run, or leave it.`
  );
}

/** The states in which the owner may still run the answer or drop it (from the row, or from the owner's card). */
export function isOwnerActionableHeldStateV1(
  state: HeldAnswerStateV1 | undefined
): state is "held" | "waitingForOwner" | "uncertain" {
  return state === "held" || state === "waitingForOwner" || state === "uncertain";
}

/** The key of the card that asks the owner what to do with a held answer that did not run. */
export const HELD_ANSWER_OWNER_CARD_KEY_V1 = "heldAnswerNeedsOwner";

export interface HeldAnswerOwnerCardFactsV1 {
  /** The decision that holds the answer (its record keeps the choice). */
  readonly heldDecisionId: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  readonly label: string;
  readonly chosenAt: string | undefined;
  /** Why it did not run: the owner paused, the owner cancelled, or a restart left it unclear. */
  readonly why: "paused" | "cancelledByOwner" | "uncertain";
  /** For `uncertain`: where the task is now. */
  readonly stageNow?: string;
}

/**
 * Steps 26 and 28: the card that asks "Run your held 'Move on' now?" with Run it and Drop it, for an answer a
 * Pause or Cancel kept back, or "Run it again" and Drop it when a restart left no way to tell whether it ran.
 * The two options are the row's own commands (they act on the held answer's decision), so the card, the row
 * and a viewer window all do the same thing.
 */
export function buildHeldAnswerOwnerCardInputV1(facts: HeldAnswerOwnerCardFactsV1): {
  readonly decisionKey: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  readonly whatHappened: string;
  readonly whyUserNeeded: string;
  readonly options: readonly WorkflowDecisionOptionV1[];
  readonly recommendation: WorkflowDecisionRecommendationV1;
  readonly gating: HandoffGatingV1;
} {
  const uncertain = facts.why === "uncertain";
  const arg = { heldAnswerV1: { decisionId: facts.heldDecisionId } };
  const whatHappened = uncertain
    ? describeHeldAnswerUncertainV1(facts.label, facts.chosenAt, facts.stageNow ?? "its current stage")
    : `Your held '${facts.label}' (chosen ${clock(facts.chosenAt)}) has not run, because ${
        facts.why === "paused" ? "the task is paused" : "you cancelled the last round"
      }.`;
  return {
    decisionKey: HELD_ANSWER_OWNER_CARD_KEY_V1,
    taskCanonicalId: facts.taskCanonicalId,
    stage: facts.stage,
    whatHappened,
    whyUserNeeded: uncertain
      ? `Run '${facts.label}' again, or drop it?`
      : `Run your held '${facts.label}' now?`,
    options: [
      {
        optionId: "runHeldAnswer",
        label: uncertain ? "Run it again" : "Run it",
        consequence: uncertain
          ? `Runs '${facts.label}' again. Only choose this if it did not run.`
          : `Runs '${facts.label}' now, as your go-ahead. It starts the task again if it is paused.`,
        resumeKind: "continue",
        effect: { kind: "command", command: "vs-code-ai-helper.runHeldAnswerNow", args: [arg] },
        recordedNext: `'${facts.label}' runs`,
      },
      {
        optionId: "dropHeldAnswer",
        label: "Drop it",
        consequence: `Does not run '${facts.label}'. The original card comes back if you want to choose again.`,
        resumeKind: "unpause",
        effect: { kind: "command", command: "vs-code-ai-helper.dropHeldAnswer", args: [arg] },
        recordedNext: `'${facts.label}' is dropped`,
      },
    ],
    recommendation: {
      kind: "none",
      reasoning: uncertain
        ? "Ensemble cannot tell whether it ran, so it will not run it by itself."
        : "You paused or cancelled, so Ensemble will not run it without asking.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: `Your held '${facts.label}' waits for you`,
    },
  };
}

/** Step 30: the running row's line for an answer that is waiting. */
export function describeHeldAnswerRowV1(label: string, chosenAt: string | undefined): string {
  return `waiting to run: ${label}, held since ${clock(chosenAt)}`;
}

/**
 * Step 30: a held answer as the Notifications row shows it. Held in the window that holds the answer, and
 * mirrored to viewer windows with the runner's operations; the row's "Run it now" and "Drop it" act on it.
 */
export interface HeldAnswerRowInfoV1 {
  readonly decisionId: string;
  readonly optionId: string;
  readonly label: string;
  /** ISO time the owner chose it. */
  readonly chosenAt?: string;
  /** `held` waits for the round to end; `waitingForOwner` was kept back by a Pause or a Cancel. */
  readonly state: "held" | "waitingForOwner";
}

/** Step 30: the row's whole held-answer segment, for either state. */
export function describeHeldAnswerRowInfoV1(info: HeldAnswerRowInfoV1): string {
  return info.state === "waitingForOwner"
    ? `your '${info.label}' (chosen ${clock(info.chosenAt)}) is waiting for you`
    : describeHeldAnswerRowV1(info.label, info.chosenAt);
}
