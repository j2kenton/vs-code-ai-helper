/**
 * run1 Step 8: the one decision that settles a round.
 *
 * Every way a round can end (the process exiting, a `result` event, the owner's Cancel, Ensemble's own
 * stops, the provider's own limits) is a signal. Signals only accumulate; once the process is confirmed
 * gone the runner asks this function, once, what the round's outcome is. First-to-arrive no longer wins:
 * the precedence is fixed, so a Cancel pressed during a successful result's exit grace, or a time limit
 * that arrives while a report is being recovered, cannot throw a finished report away.
 *
 * Precedence, highest first:
 *  1. a successful result received BEFORE the owner's Cancel (finished work is kept); a success that
 *     arrives after the Cancel never overrides it;
 *  2. the owner's Cancel;
 *  3. a complete report recovered from a stream Ensemble had to stop;
 *  4. provider limits (a time cap, or an error result);
 *  5. Ensemble's own stops (backstop, idle, repeat);
 *  6. the process having ended on its own: an exit 0 with output and no provider cut-off completes
 *     the round (providers that print no terminal event); anything else is a failure.
 */
import type { RoundStopKindV1 } from "./roundStopCauseV1";

export type RoundSignalV1 =
  | { readonly kind: "resultSuccess"; readonly text?: string }
  | { readonly kind: "resultError" }
  | { readonly kind: "recoveredReport"; readonly text: string }
  | { readonly kind: "ownerCancel" }
  | { readonly kind: "providerTimeCap" }
  | { readonly kind: "ensembleStop"; readonly cause: "ensembleBackstop" | "ensembleIdleStop" | "ensembleRepeatStop" | "ensembleEndOfTurn" }
  | {
      readonly kind: "processEnded";
      /**
       * How an ordinary exit looked, when the process ended on its own. Without it the exit is just
       * "the process ended" (a failure). With it, an exit 0 that produced output and no provider
       * cut-off is how a provider that prints no terminal event completes its round.
       */
      readonly exit?: { readonly code: number | null; readonly hasOutput: boolean; readonly providerCutOff?: boolean };
    };

export type RoundSettlementV1 =
  | {
      readonly outcome: "completed";
      /** Where the accepted answer came from. */
      readonly via: "result" | "recoveredReport" | "exit";
      readonly text?: string;
      /** True when Ensemble had to stop a process that was still running. */
      readonly stoppedByEnsemble: boolean;
      readonly cause: RoundStopKindV1 | undefined;
    }
  | { readonly outcome: "cancelled"; readonly cause: "ownerCancel" }
  | { readonly outcome: "failed"; readonly cause: RoundStopKindV1 };

export function decideRoundSettlementV1(signals: readonly RoundSignalV1[]): RoundSettlementV1 {
  const ensembleStop = signals.find((signal) => signal.kind === "ensembleStop");
  const success = signals.find((signal) => signal.kind === "resultSuccess");
  const recovered = signals.find((signal) => signal.kind === "recoveredReport");
  // Signals are kept in arrival order, so "already received" is an index comparison.
  const cancelIndex = signals.findIndex((signal) => signal.kind === "ownerCancel");
  const successIndex = signals.findIndex((signal) => signal.kind === "resultSuccess");
  if (success !== undefined && (cancelIndex < 0 || successIndex < cancelIndex)) {
    return {
      outcome: "completed",
      via: "result",
      ...(success.text !== undefined ? { text: success.text } : {}),
      stoppedByEnsemble: ensembleStop !== undefined,
      cause: ensembleStop !== undefined ? "ensembleEndOfTurn" : undefined,
    };
  }
  if (signals.some((signal) => signal.kind === "ownerCancel")) {
    return { outcome: "cancelled", cause: "ownerCancel" };
  }
  if (recovered !== undefined) {
    return {
      outcome: "completed",
      via: "recoveredReport",
      text: recovered.text,
      stoppedByEnsemble: true,
      cause: ensembleStop?.cause,
    };
  }
  const ended = signals.find((signal) => signal.kind === "processEnded");
  const exit = ended?.kind === "processEnded" ? ended.exit : undefined;
  if (signals.some((signal) => signal.kind === "providerTimeCap") || exit?.providerCutOff === true) {
    return { outcome: "failed", cause: "providerTimeCap" };
  }
  if (signals.some((signal) => signal.kind === "resultError")) {
    return { outcome: "failed", cause: "providerError" };
  }
  if (ensembleStop !== undefined) {
    return { outcome: "failed", cause: ensembleStop.cause };
  }
  if (exit !== undefined && exit.code === 0 && exit.hasOutput) {
    return { outcome: "completed", via: "exit", stoppedByEnsemble: false, cause: undefined };
  }
  return { outcome: "failed", cause: "processEnded" };
}
