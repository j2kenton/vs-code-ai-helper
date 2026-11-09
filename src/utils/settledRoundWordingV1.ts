/**
 * run1 Step 8: the words for a round's ending, read from the ONE outcome the runner's settlement
 * recorded on its result (`stopCauseV1`, `activityV1`), so the command layer's terminalisation, the
 * ledger row's reason, the "_Ended:" line, the notification and the card all say the same thing.
 *
 * Before this the command layer used the result's `errorMessage` text as it came, and re-derived the
 * cause from it. A cause the settlement named is now worded here through `describeRoundStopV1`.
 * Causes the provider's own text defines (a usage limit, a quota, a sign-in failure) keep that text.
 */
import { classifyFailure } from "./quota";
import {
  classifyRoundStopV1,
  describeRoundStopV1,
  type RoundStopFactsV1,
  type RoundStopKindV1,
} from "./roundStopCauseV1";

export interface SettledRoundResultV1 {
  readonly status?: "completed" | "failed" | "cancelled";
  readonly errorMessage?: string;
  readonly stopCauseV1?: RoundStopKindV1;
  readonly providerLabel?: string;
  readonly runnerId?: string;
  readonly filesChanged?: readonly string[];
  readonly filesChangedUnknown?: boolean;
  readonly activityV1?: {
    readonly workedMs: number;
    readonly attributedFiles: readonly string[];
    readonly observedFiles: readonly string[];
    readonly processStartedAtMs?: number;
    readonly processEndedAtMs?: number;
  };
}

export interface SettledRoundWordingOptionsV1 {
  /** Ensemble's own backstop, in minutes (for `ensembleBackstop`). */
  readonly backstopMinutes?: number;
  /** The quiet time that ends a round, in minutes (for `ensembleIdleStop`). */
  readonly idleMinutes?: number;
  /** What the next step does with the edits; defaults to continuing from them. */
  readonly nextStep?: string;
}

/** Causes whose wording Ensemble owns, so the settled cause (not message text) decides it. */
const ENSEMBLE_WORDED_CAUSES_V1: ReadonlySet<RoundStopKindV1> = new Set<RoundStopKindV1>([
  "ensembleBackstop",
  "ensembleIdleStop",
  "ensembleRepeatStop",
  "ensembleEndOfTurn",
  "providerTimeCap",
  "processEnded",
  "processNotConfirmedStopped",
]);

/** The facts a round's recorded activity gives the wording. Files not proven to be the round's stay apart. */
export function roundStopFactsOfResultV1(
  result: SettledRoundResultV1,
  options: SettledRoundWordingOptionsV1 = {}
): RoundStopFactsV1 {
  const activity = result.activityV1;
  const providerLabel = result.providerLabel ?? result.runnerId ?? "The provider";
  // Without a feed (a result that did not come from a CLI edit round) the change set is all that is
  // known, and it is not proven to be this round's own.
  const unattributed = activity
    ? activity.observedFiles.length
    : result.filesChangedUnknown === true
      ? 0
      : (result.filesChanged?.length ?? 0);
  return {
    providerLabel,
    ...(activity && activity.workedMs > 0 ? { workedMs: activity.workedMs } : {}),
    ...(activity && activity.attributedFiles.length > 0 ? { attributedFilesChanged: activity.attributedFiles.length } : {}),
    ...(unattributed > 0 ? { unattributedFilesChanged: unattributed } : {}),
    ...(options.backstopMinutes !== undefined ? { limitMinutes: options.backstopMinutes } : {}),
    ...(options.idleMinutes !== undefined ? { idleMinutes: options.idleMinutes } : {}),
    nextStep: options.nextStep ?? "the next round continues from them",
  };
}

/**
 * The plain sentence for a failed round, from the cause its settlement recorded. Returns the result's
 * own `errorMessage` unchanged when no cause was recorded or the provider's own text defines the
 * cause, so a limit the provider named is still said in the provider's words.
 */
export function describeSettledFailureV1(
  result: SettledRoundResultV1,
  options: SettledRoundWordingOptionsV1 = {}
): string | undefined {
  const recorded = result.stopCauseV1;
  if (result.status === "completed" || recorded === undefined || !ENSEMBLE_WORDED_CAUSES_V1.has(recorded)) {
    return result.errorMessage;
  }
  const cause = classifyRoundStopV1({
    status: "failed",
    recordedCause: recorded,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  });
  return describeRoundStopV1(cause, roundStopFactsOfResultV1(result, options));
}

const TRANSPORT_CODE_CAUSES_V1: ReadonlyArray<readonly [RegExp, RoundStopKindV1]> = [
  [/\bcliRunTimeout\b/, "ensembleBackstop"],
  [/\bcliRunInactivityTimeout\b/, "ensembleIdleStop"],
  [/\bcliRunRepeatStop\b/, "ensembleRepeatStop"],
  [/\bcliProcessNotConfirmedStopped\b/, "processNotConfirmedStopped"],
  [/\bcliProcessEnded\b/, "processEnded"],
];

/**
 * The stop cause a text-transport failure code names (`cliRunTimeout`, `cliRunInactivityTimeout`,
 * `cliRunRepeatStop`, `cliProcessNotConfirmedStopped`), so a review round's terminalisation reads the
 * same recorded cause as an implementation round's. Undefined for every other failure.
 */
export function stopCauseOfTransportEvidenceV1(evidence: string | undefined): RoundStopKindV1 | undefined {
  if (evidence === undefined) {
    return undefined;
  }
  return TRANSPORT_CODE_CAUSES_V1.find(([pattern]) => pattern.test(evidence))?.[1];
}

/**
 * The stop cause of ANY failed attempt, from the evidence it left (transport code and detail, or an
 * exhausted chain's per-candidate reason). Ensemble's own stops are named by their transport code;
 * a provider limit, a quota, a payment or a sign-in failure only when the provider's own text says
 * so (the same `classifyFailure` markers the runner uses); a provider's error result is a provider
 * error; everything else is `generic`, and `generic` never reads as a limit.
 */
export function stopCauseOfFailureEvidenceV1(
  evidence: string | undefined,
  hint: { readonly deferredFailureKind?: "quota" | "model-entitlement" } = {}
): RoundStopKindV1 {
  const named = stopCauseOfTransportEvidenceV1(evidence);
  if (named !== undefined) {
    return named;
  }
  const failure = classifyFailure({ errorMessage: evidence ?? "" });
  const failureKind = hint.deferredFailureKind ?? failure.failureKind;
  const kind = classifyRoundStopV1({
    status: "failed",
    failureKind,
    ...(evidence ? { errorMessage: evidence } : {}),
  }).kind;
  if (kind === "generic" && evidence !== undefined && /\bcliErrorResult\b/.test(evidence)) {
    return "providerError";
  }
  return kind;
}

/**
 * run1 Step 8: one exhausted-chain candidate's reason in plain words, read through the shared stop
 * wording. A candidate that Ensemble's own stop ended (the time limit, the idle stop, the repeat stop,
 * the process ending, an unconfirmed process stop) says what Ensemble did, with no transport code and
 * no watchdog name. Every other reason (a provider's own limit text, a sign-in failure) keeps its own
 * words. The raw reason stays in the run log.
 */
export function plainCandidateReasonV1(reason: string, providerLabel: string): string {
  const kind = stopCauseOfTransportEvidenceV1(reason);
  if (kind === undefined) {
    return reason;
  }
  const minutesOf = (pattern: RegExp): number | undefined => {
    const found = pattern.exec(reason)?.[1];
    return found !== undefined ? Number(found) : undefined;
  };
  const limitMinutes = minutesOf(/no exit after (\d+)m/);
  const idleMinutes = minutesOf(/no output for (\d+)m/);
  const detail =
    kind === "processNotConfirmedStopped" ? /cliProcessNotConfirmedStopped:\s*([\s\S]*)$/.exec(reason)?.[1] : undefined;
  const sentence = describeRoundStopV1(
    { kind, ...(limitMinutes !== undefined ? { limitMinutes } : {}), ...(detail ? { detail } : {}) },
    {
      providerLabel,
      ...(limitMinutes !== undefined ? { limitMinutes } : {}),
      ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    }
  );
  return sentence.replace(/[.\s]+$/, "");
}
