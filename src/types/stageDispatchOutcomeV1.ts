/**
 * bugs8 Step 4: what an owner answer (or any resume-and-dispatch) actually did, so the chat only says "applying now"
 * when something started.
 *
 * `started` is claimed only after a CONFIRMED start: an operation registered for the task, or the downstream command
 * resolving `true` under its own "true only when real work started" contract. Calling a command, entering a wrapper or
 * a pre-dispatch callback never counts.
 */
export type StageDispatchOutcomeV1 =
  | { readonly kind: "started" }
  /** Nothing started yet; it starts by itself later. `startsWhen` says when. */
  | { readonly kind: "held"; readonly reason: string; readonly startsWhen: string }
  /** The dispatch was tried or declined and nothing is running. `click` names what carries on. */
  | { readonly kind: "refused"; readonly reason: string; readonly click: string }
  /** The answer is recorded and nothing was owed to start. `click` names what carries on. */
  | { readonly kind: "recordedOnly"; readonly reason: string; readonly click: string };

/** The click that carries a stopped stage on when the dispatch itself did not say a more specific one. */
export const RESUME_TASK_CLICK_V1 = "Resume Task";

/** The one chat line for an outcome that is not `started`; `started` says nothing here (its line comes from the start). */
export function describeStageDispatchNotStartedV1(outcome: StageDispatchOutcomeV1): string | undefined {
  switch (outcome.kind) {
    case "started":
      return undefined;
    case "held":
      return `${capitalizeV1(outcome.reason)}. ${capitalizeV1(outcome.startsWhen)}.`;
    case "refused":
    case "recordedOnly":
      return `Nothing started: ${stripTrailingStopV1(outcome.reason)}. Click ${outcome.click} to carry on.`;
  }
}

function stripTrailingStopV1(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

function capitalizeV1(text: string): string {
  const trimmed = stripTrailingStopV1(text);
  return trimmed.length === 0 ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}
