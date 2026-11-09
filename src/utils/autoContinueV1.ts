/**
 * review1 Step 53: a card whose recommended option is safe to run unattended can carry a countdown. When it ends
 * with nobody having answered, dismissed or pressed "Wait for me", and nothing else happened to the task, the
 * recommended option runs by itself. This module is the policy only; the store keeps the deadline and the periodic
 * sweep asks {@link evaluateAutoContinueV1} what to do.
 *
 * Pure: no `vscode`, no I/O.
 */
import type {
  WorkflowDecisionAutoContinueV1,
  WorkflowDecisionOptionV1,
  WorkflowDecisionV1,
} from "../types/workflowDecisionV1";

export const WAIT_FOR_ME_OPTION_ID_V1 = "waitForMe";
/** The longest wait the setting allows (one day). */
export const AUTO_CONTINUE_MAX_MINUTES_V1 = 1440;

/** The task facts the sweep compares against the ones recorded when the countdown was armed. */
export interface AutoContinueTaskStateV1 {
  readonly progressVersion?: number;
  readonly roundCount?: number;
  /** run1 Step 28: the owner paused the task. A countdown is never armed on, and never runs on, such a task. */
  readonly paused?: boolean;
}

/** An option may run unattended only when it says so and cannot lose work or needs no judgement. */
export function isAutoContinueOptionV1(option: WorkflowDecisionOptionV1 | undefined): option is WorkflowDecisionOptionV1 {
  return (
    option !== undefined &&
    option.unattendedSafe === true &&
    option.destructive !== true &&
    option.disabled !== true &&
    option.effect.kind === "command"
  );
}

/** The option that would run: the card's recommended option, when it is unattended-safe. Otherwise undefined. */
export function pickAutoContinueOptionV1(
  decision: Pick<WorkflowDecisionV1, "options" | "recommendation" | "state">
): WorkflowDecisionOptionV1 | undefined {
  if (decision.state !== "pending" || decision.recommendation.kind !== "option") {
    return undefined;
  }
  const recommendedId = decision.recommendation.optionId;
  const option = decision.options.find((candidate) => candidate.optionId === recommendedId);
  return isAutoContinueOptionV1(option) ? option : undefined;
}

/** The setting's value as a whole number of minutes in range; anything unusable means off. */
export function normaliseAutoContinueMinutesV1(raw: unknown): number {
  const numeric = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(0, Math.min(AUTO_CONTINUE_MAX_MINUTES_V1, numeric));
}

/** The countdown to store when a card is posted, or undefined when the card does not qualify or the setting is off. */
export function planAutoContinueV1(
  decision: Pick<WorkflowDecisionV1, "options" | "recommendation" | "state">,
  minutes: number,
  nowMs: number,
  task: AutoContinueTaskStateV1
): WorkflowDecisionAutoContinueV1 | undefined {
  const wait = normaliseAutoContinueMinutesV1(minutes);
  const option = pickAutoContinueOptionV1(decision);
  if (wait === 0 || option === undefined || task.paused === true) {
    return undefined;
  }
  return {
    optionId: option.optionId,
    minutes: wait,
    deadline: new Date(nowMs + wait * 60_000).toISOString(),
    ...(task.progressVersion !== undefined ? { armedProgressVersion: task.progressVersion } : {}),
    ...(task.roundCount !== undefined ? { armedRoundCount: task.roundCount } : {}),
  };
}

/** The "Wait for me" choice a countdown card carries beside its options. It records nothing and runs nothing. */
export function buildWaitForMeOptionV1(): WorkflowDecisionOptionV1 {
  return {
    optionId: WAIT_FOR_ME_OPTION_ID_V1,
    label: "Wait for me",
    resumeKind: "unpause",
    consequence: "Stops the countdown. The card stays open and nothing runs until you choose.",
    recordedNext: "the countdown is stopped; the card waits for you",
    effect: { kind: "doNothing" },
  };
}

/** Adds "Wait for me" to a card that has a countdown, once. */
export function withWaitForMeOptionV1(options: readonly WorkflowDecisionOptionV1[]): readonly WorkflowDecisionOptionV1[] {
  return options.some((option) => option.optionId === WAIT_FOR_ME_OPTION_ID_V1)
    ? options
    : [...options, buildWaitForMeOptionV1()];
}

/** "Continues with ‘<label>’ in N min unless you choose otherwise", counting down from the deadline. */
export function describeAutoContinueCountdownV1(
  autoContinue: WorkflowDecisionAutoContinueV1,
  optionLabel: string,
  nowMs: number
): string {
  const remainingMs = Date.parse(autoContinue.deadline) - nowMs;
  const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `Continues with ‘${optionLabel}’ in ${minutesLeft} min unless you choose otherwise.`;
}

/** The sentence on a card when its countdown is armed: the option and the clock time it will run at. */
export function describeAutoContinueScheduleV1(autoContinue: WorkflowDecisionAutoContinueV1, optionLabel: string): string {
  const at = new Date(autoContinue.deadline);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `Continues with ‘${optionLabel}’ in ${autoContinue.minutes} min (at ${clock}) unless you choose otherwise; press Wait for me to stop it.`;
}

/**
 * The sentence a card shows about its countdown, worked out from the stored record each time the card is drawn so it
 * counts down and, once the countdown is stopped, says so instead of promising a run that will not happen.
 * Undefined for a card with no countdown or one that is no longer pending.
 */
export function describeAutoContinueNoteV1(
  decision: Pick<WorkflowDecisionV1, "options" | "state" | "autoContinue">,
  nowMs: number
): string | undefined {
  const armed = decision.autoContinue;
  if (armed === undefined || decision.state !== "pending") {
    return undefined;
  }
  if (armed.cancelledAt !== undefined) {
    return `The countdown was stopped${armed.cancelledReason ? ` (${armed.cancelledReason})` : ""}. Nothing runs until you choose.`;
  }
  const label = decision.options.find((candidate) => candidate.optionId === armed.optionId)?.label;
  if (label === undefined) {
    return undefined;
  }
  return `${describeAutoContinueCountdownV1(armed, label, nowMs)} Press Wait for me to stop it.`;
}

/** True when the card has a countdown that is still running, so the chat should redraw it as the time passes. */
export function hasRunningAutoContinueCountdownV1(
  decision: Pick<WorkflowDecisionV1, "state" | "autoContinue">
): boolean {
  return decision.state === "pending" && decision.autoContinue !== undefined && decision.autoContinue.cancelledAt === undefined;
}

/** The chat line recorded when the countdown ran the option. */
export function describeAutoContinuedLineV1(optionLabel: string, minutes: number): string {
  return `Continued automatically with ‘${optionLabel}’ after ${minutes} min (no answer).`;
}

export type AutoContinueVerdictV1 =
  | { readonly kind: "wait" }
  | { readonly kind: "run"; readonly optionId: string }
  | { readonly kind: "cancel"; readonly reason: string; readonly stateChanged?: true };

/**
 * What the sweep does with one pending card. A countdown that was cancelled, or whose card is no longer pending, is
 * left alone. A task that moved on (its `progressVersion` or round-ledger length differs from arming time) cancels
 * the countdown: the card is re-offered by whatever raised it, not run against a stale review.
 */
export function evaluateAutoContinueV1(
  decision: Pick<WorkflowDecisionV1, "options" | "recommendation" | "state" | "autoContinue">,
  nowMs: number,
  task: AutoContinueTaskStateV1
): AutoContinueVerdictV1 {
  const armed = decision.autoContinue;
  if (armed === undefined || armed.cancelledAt !== undefined || decision.state !== "pending") {
    return { kind: "wait" };
  }
  const option = decision.options.find((candidate) => candidate.optionId === armed.optionId);
  if (!isAutoContinueOptionV1(option)) {
    return { kind: "cancel", reason: "the option is no longer one that can run unattended" };
  }
  if (task.paused === true) {
    // run1 Step 28: the owner's Pause wins over a countdown; the card waits for them.
    return { kind: "cancel", reason: "you paused the task" };
  }
  if (armed.armedProgressVersion !== undefined && task.progressVersion !== undefined && task.progressVersion !== armed.armedProgressVersion) {
    return { kind: "cancel", reason: "the task changed while the card waited", stateChanged: true };
  }
  if (armed.armedRoundCount !== undefined && task.roundCount !== undefined && task.roundCount !== armed.armedRoundCount) {
    return { kind: "cancel", reason: "a round ran while the card waited", stateChanged: true };
  }
  return Date.parse(armed.deadline) <= nowMs ? { kind: "run", optionId: armed.optionId } : { kind: "wait" };
}
