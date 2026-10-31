/**
 * bugs3 Step 3: one "Ended …" chat line per logical operation, derived from the
 * operation's own settled outcome.
 *
 * The code that knows how a round ended records that outcome here, keyed by the
 * operation id, derived from the round's `TaskActionOutcomeV1` where there is
 * one (`terminalOutcomeFromTaskActionOutcomeV1`). The observer's line is then
 * rendered from the recorded outcome rather than from whether the command
 * merely returned, and it stays silent only when the outcome says the round
 * ledger already posted the round's terminal line.
 *
 * A composite action runs nested tracked operations that carry the same label
 * (Apply Review's root and the child that does the work). Each used to post its
 * own "Ended … — succeeded" line, and a root whose command merely returned read
 * as a success even when the child it ran had failed. This tracker keys the
 * line by operation id, lets only the outermost operation of a same-label chain
 * speak, and has that operation report the worst outcome its same-label
 * children settled.
 */
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { describeTaskActionFailureV1 } from "./taskActionOutcomeTextV1";
import { claimTerminalLineV1, ledgerOwnsTerminalLineV1, reserveLedgerTerminalLineV1 } from "./terminalLineEmitterV1";

export type EndedOperationStateV1 = "succeeded" | "failed" | "cancelled" | "interrupted" | "refused";

export interface TrackedOperationV1 {
  readonly id: string;
  readonly label: string;
  readonly parentId?: string;
}

export interface EndedOperationV1 extends TrackedOperationV1 {
  readonly state: string;
  /** Why the operation settled the way it did, when its owner said. */
  readonly endReasonV1?: string;
  readonly cancelReasonV1?: string;
}

interface SettledOutcomeV1 {
  readonly state: string;
  readonly reason?: string;
}

const STATE_WORDS_V1: Readonly<Record<string, string>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  refused: "refused — it did not start",
};

function describeSettledOutcomeV1(label: string, outcome: SettledOutcomeV1): string {
  const word = STATE_WORDS_V1[outcome.state] ?? outcome.state;
  const reason = outcome.reason?.trim().replace(/[.\s]+$/, "");
  return `Ended ${label} — ${word}${reason ? `: ${reason}` : ""}.`;
}

/** What an operation's round actually ended as, as recorded by whoever settled it. */
export interface OperationTerminalOutcomeV1 {
  readonly state: "succeeded" | "failed" | "cancelled" | "refused";
  readonly reason?: string;
  /**
   * True when the round ledger posts this round's terminal "Ended: …" line
   * (`terminalizeRoundV1`), so the operation observer must not add another.
   */
  readonly ledgerSpeaks?: boolean;
}

const terminalOutcomesV1 = new Map<string, OperationTerminalOutcomeV1>();

/** Record the settled outcome of the round an operation ran; a later record replaces an earlier one. */
export function recordOperationTerminalOutcomeV1(operationId: string, outcome: OperationTerminalOutcomeV1): void {
  terminalOutcomesV1.set(operationId, outcome);
  if (outcome.ledgerSpeaks) {
    reserveLedgerTerminalLineV1(operationId);
  }
}

/** Drop a recorded outcome (tests, and an operation that never ends). */
export function forgetOperationTerminalOutcomeV1(operationId: string): void {
  terminalOutcomesV1.delete(operationId);
}

/**
 * The single mapping from a round's `TaskActionOutcomeV1` to how its operation
 * ends. `undefined` means the outcome does not decide it (questions asked, or a
 * completed provider call whose round the stage owner still judges incomplete),
 * so the operation's own settlement stands.
 */
export function terminalOutcomeFromTaskActionOutcomeV1(
  outcome: TaskActionOutcomeV1
): Pick<OperationTerminalOutcomeV1, "state" | "reason"> | undefined {
  switch (outcome.kind) {
    case "completed":
      return outcome.code === "completed" || outcome.code === "noChanges" ? { state: "succeeded" } : undefined;
    case "questions":
      return undefined;
    case "cancelled":
      return { state: "cancelled" };
    case "duplicateRejected":
      return { state: "refused", reason: describeTaskActionFailureV1(outcome) };
    default:
      // failed, malformedResult, unavailable (candidatesExhausted / candidatesDeferred),
      // recoveryRequired, stalePreflight, partialEditBlocked: the round did not succeed.
      return { state: "failed", reason: describeTaskActionFailureV1(outcome) };
  }
}

export class OperationEndedLineTrackerV1 {
  private readonly registered = new Map<string, TrackedOperationV1>();
  private readonly emitted = new Set<string>();
  private readonly inherited = new Map<string, SettledOutcomeV1>();

  /** Remember an operation seen starting, so a child can find its parent. */
  register(operation: TrackedOperationV1): void {
    this.registered.set(operation.id, operation);
  }

  /**
   * The line to post when `operation` ends, or `undefined` when it must stay
   * silent: it already spoke, or a same-label ancestor will report for it.
   */
  ended(operation: EndedOperationV1): string | undefined {
    if (this.emitted.has(operation.id)) {
      return undefined;
    }
    this.emitted.add(operation.id);
    const recorded = terminalOutcomesV1.get(operation.id);
    terminalOutcomesV1.delete(operation.id);
    // The shared emitter registry also knows when the round ledger has already
    // posted (or reserved) this operation's line without the command recording it.
    if (recorded?.ledgerSpeaks || ledgerOwnsTerminalLineV1(operation.id)) {
      this.inherited.delete(operation.id);
      const ledgerRecord: OperationTerminalOutcomeV1 = recorded ?? { state: "succeeded", ledgerSpeaks: true };
      // The ledger line speaks for the whole same-label chain: a root whose
      // command merely returned must not add its own "succeeded" afterwards.
      const coveredParent = operation.parentId !== undefined ? this.registered.get(operation.parentId) : undefined;
      if (coveredParent !== undefined && coveredParent.label === operation.label && !this.emitted.has(coveredParent.id)) {
        recordOperationTerminalOutcomeV1(coveredParent.id, { ...ledgerRecord, ledgerSpeaks: true });
      }
      return undefined;
    }
    // The recorded round outcome is authoritative over the snapshot's state: a
    // command that merely returned settles "succeeded" even when its round failed.
    const own: SettledOutcomeV1 = recorded
      ? { state: recorded.state, reason: recorded.reason ?? operation.endReasonV1 ?? operation.cancelReasonV1 }
      : { state: operation.state, reason: operation.endReasonV1 ?? operation.cancelReasonV1 };
    // A command that merely returned settles "succeeded"; a same-label child
    // that failed under it is what actually happened.
    const carried = this.inherited.get(operation.id);
    this.inherited.delete(operation.id);
    const effective = own.state === "succeeded" && carried ? carried : own;
    const parent = operation.parentId !== undefined ? this.registered.get(operation.parentId) : undefined;
    if (parent !== undefined && parent.label === operation.label && !this.emitted.has(parent.id)) {
      if (effective.state !== "succeeded" && !this.inherited.has(parent.id)) {
        // The first non-success wins: it is the root cause the later ones follow.
        this.inherited.set(parent.id, effective);
      }
      return undefined;
    }
    // Every writer of an operation's terminal line goes through the shared
    // registry, so a second delivery or a late ledger line cannot double it.
    if (!claimTerminalLineV1(operation.id, "operation")) {
      return undefined;
    }
    return describeSettledOutcomeV1(operation.label, effective);
  }
}
