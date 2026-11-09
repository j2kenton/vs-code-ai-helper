/**
 * run1 Step 3: what stopped a round, and how it is said to the owner.
 *
 * Before this, a failure that was not a sign-in or capacity problem was worded "hit a usage
 * limit" whatever had really happened (bugs6 items 5 and 16): Antigravity's own 55-minute turn
 * cap, Ensemble's own 60-minute limit and a dropped process all read as the owner's plan running
 * out. This module is the one place that names the cause and says whose limit it was. Cards, the
 * "_Ended:" line and notifications build their sentences here; run logs may keep the raw detail.
 *
 * Plain words only: nothing in the returned text is an internal identifier.
 */
import { explicitProviderUsageLimitLineV1, parseQuotaResetV1 } from "./quota";

export type RoundStopKindV1 =
  | "providerUsageLimit"
  | "providerQuota"
  | "providerPayment"
  | "providerTimeCap"
  | "ensembleBackstop"
  | "ensembleIdleStop"
  | "ensembleRepeatStop"
  | "ensembleEndOfTurn"
  | "ownerCancel"
  | "providerError"
  | "signIn"
  | "capacity"
  | "processEnded"
  | "processNotConfirmedStopped"
  | "generic";

export interface RoundStopCauseV1 {
  readonly kind: RoundStopKindV1;
  /** The provider's own limit line or error text, used for the reset time and the detail. */
  readonly detail?: string;
  /** When the provider says the limit lifts, as it printed it (never guessed). */
  readonly resetAt?: string;
  /** Ensemble's own time limit in minutes, when the round's text states it. */
  readonly limitMinutes?: number;
}

export interface RoundStopFactsV1 {
  /** "Claude Code", "Antigravity CLI": whose limit or error it was. */
  readonly providerLabel: string;
  readonly workedMs?: number;
  /** Files the round's own stream shows it changed (the round's attributed changes). */
  readonly attributedFilesChanged?: number;
  /** Files that changed in the workspace while it ran without proof they were this round's. */
  readonly unattributedFilesChanged?: number;
  /** True when Ensemble is continuing the round from the working tree right away. */
  readonly continuing?: boolean;
  /** Ensemble's own time limit, in minutes, for `ensembleBackstop`. */
  readonly limitMinutes?: number;
  /** The provider's own time cap, in minutes, for `providerTimeCap`. */
  readonly providerCapMinutes?: number;
  /** The quiet time that ended the round, in minutes, for `ensembleIdleStop`. */
  readonly idleMinutes?: number;
  /** HH:MM at which a complete report was already written, when one was. */
  readonly reportWrittenAt?: string;
  /** What the next step does with the edits, e.g. "the next round continues from them". */
  readonly nextStep?: string;
  /**
   * Ask for a fragment of the stop wording instead of the whole stop sentence, for cards that build their own
   * sentence around it and need a noun or a step, in their own grammar:
   * - `limitName`: "usage limit" or "quota or rate limit" for a provider limit;
   * - `waitForReset`: "wait for the usage limit to reset", with `resetText` as "(earliest ...)" when known;
   * - `lead`: the one-line lead of a failure message, with `rawDetail` kept inside it.
   * Every fragment is decided here, so no card repeats the decision as a local pattern.
   */
  readonly fragment?: "limitName" | "waitForReset" | "lead";
  /** The reset time as the caller formats it, for the `waitForReset` fragment. */
  readonly resetText?: string;
  /** The provider's raw error text, kept inside the `lead` fragment. */
  readonly rawDetail?: string;
}

/** The signals a runner result carries; every field is optional so any result can be passed. */
export interface RoundStopSignalsV1 {
  readonly status?: "completed" | "failed" | "cancelled";
  readonly failureKind?: "quota" | "temporarily-unavailable" | "model-entitlement" | "payment-required" | "generic";
  readonly errorMessage?: string;
  readonly authFailure?: boolean;
  readonly providerCapacity?: boolean;
  readonly timeoutReason?: "wall-clock" | "inactivity";
  readonly timedOut?: boolean;
  /** The provider's own turn cap ended the turn (conversationResume marker matched). */
  readonly providerTimeCap?: boolean;
  /** The process ended on its own without a result. */
  readonly processEnded?: boolean;
  /** Ensemble's own stops, set by the runner's settlement. */
  readonly ensembleStop?: "repeat" | "endOfTurn";
  /** The cause the runner's settlement already recorded on the result (`stopCauseV1`). */
  readonly recordedCause?: RoundStopKindV1;
}

const USAGE_LIMIT_TEXT = /usage[\s-]*limit|session limit|limit\s+(?:reached|exceeded)/i;

/**
 * Name the cause from a runner result's signals. A usage-limit or quota kind is chosen only when
 * the failure was classified as one from the provider's own output (`failureKind`), and
 * "usage limit" only when that output says so; everything else keeps its own name.
 */
export function classifyRoundStopV1(signals: RoundStopSignalsV1, now: Date = new Date()): RoundStopCauseV1 {
  const detail = signals.errorMessage;
  if (signals.status === "cancelled") {
    return { kind: "ownerCancel" };
  }
  // run1 Step 8: the cause the runner's one settlement recorded is used as it was decided. Only the
  // provider-limit kinds are still read from the provider's own text below, because their wording
  // (the limit line, the reset time) comes from that text and "usage limit" may be said only when it does.
  const recorded = signals.recordedCause;
  if (
    recorded !== undefined &&
    recorded !== "generic" &&
    recorded !== "providerUsageLimit" &&
    recorded !== "providerQuota" &&
    recorded !== "providerPayment"
  ) {
    if (recorded === "ensembleBackstop") {
      const limitMinutes = Number(/(\d+)[- ]minute wall[- ]clock/i.exec(detail ?? "")?.[1]);
      return { kind: recorded, ...(limitMinutes > 0 ? { limitMinutes } : {}) };
    }
    const keepsDetail =
      recorded === "providerError" ||
      recorded === "providerTimeCap" ||
      recorded === "signIn" ||
      recorded === "processNotConfirmedStopped";
    return { kind: recorded, ...(keepsDetail && detail ? { detail } : {}) };
  }
  if (signals.ensembleStop === "repeat") {
    return { kind: "ensembleRepeatStop" };
  }
  if (signals.ensembleStop === "endOfTurn") {
    return { kind: "ensembleEndOfTurn" };
  }
  if (signals.timeoutReason === "inactivity") {
    return { kind: "ensembleIdleStop" };
  }
  if (signals.timeoutReason === "wall-clock" || signals.timedOut === true) {
    const limitMinutes = Number(/(\d+)[- ]minute wall[- ]clock/i.exec(detail ?? "")?.[1]);
    return { kind: "ensembleBackstop", ...(limitMinutes > 0 ? { limitMinutes } : {}) };
  }
  if (signals.providerTimeCap === true) {
    return { kind: "providerTimeCap", ...(detail ? { detail } : {}) };
  }
  if (signals.authFailure === true) {
    return { kind: "signIn", ...(detail ? { detail } : {}) };
  }
  if (signals.providerCapacity === true) {
    return { kind: "capacity" };
  }
  if (signals.failureKind === "payment-required") {
    return { kind: "providerPayment", ...(detail ? { detail } : {}) };
  }
  if (signals.failureKind === "quota") {
    const resetAt = parseQuotaResetV1(detail, now);
    const limitLine = explicitProviderUsageLimitLineV1(detail);
    const kind: RoundStopKindV1 =
      limitLine !== undefined || USAGE_LIMIT_TEXT.test(detail ?? "") ? "providerUsageLimit" : "providerQuota";
    return {
      kind,
      ...(limitLine ?? detail ? { detail: limitLine ?? detail } : {}),
      ...(resetAt ? { resetAt } : {}),
    };
  }
  if (signals.processEnded === true) {
    return { kind: "processEnded" };
  }
  if (signals.failureKind === "temporarily-unavailable") {
    return { kind: "providerError", detail: detail ?? "it was temporarily unavailable" };
  }
  if (signals.failureKind === "model-entitlement") {
    return { kind: "providerError", detail: detail ?? "this model is not available to this account" };
  }
  return { kind: "generic", ...(detail ? { detail } : {}) };
}

/** "60 minutes", "1 hour", "4 hours", "90 minutes". */
export function formatLimitDurationV1(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${Math.round(minutes)} minutes`;
}

function formatWorkedV1(workedMs: number): string {
  const minutes = Math.max(1, Math.round(workedMs / 60_000));
  return formatLimitDurationV1(minutes);
}

function filesPhraseV1(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function trimDetailV1(detail: string | undefined): string {
  return (detail ?? "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/** The sentence that says whose limit or error it was. */
function headlineV1(cause: RoundStopCauseV1, facts: RoundStopFactsV1): string {
  const provider = facts.providerLabel;
  switch (cause.kind) {
    case "providerUsageLimit":
      return `${provider} reports that its usage limit is used up${
        cause.resetAt ? ` (it resets ${cause.resetAt})` : "; check the provider for when it resets"
      }.`;
    case "providerQuota":
      return `${provider} hit a quota or rate limit at the provider${cause.resetAt ? ` (it resets ${cause.resetAt})` : ""}.`;
    case "providerPayment":
      return `${provider} was refused for payment: the provider needs credits or a free model.`;
    case "providerTimeCap":
      // Kept free of the words a later re-classification reads as a plan problem: this is a cap
      // on one turn, and says so.
      return `${provider} ended its turn at its own time cap${
        facts.providerCapMinutes ? ` of ${formatLimitDurationV1(facts.providerCapMinutes)}` : ""
      } for a single turn; nothing is wrong with your plan.`;
    case "ensembleBackstop":
      return `Ensemble stops a round after ${formatLimitDurationV1(facts.limitMinutes ?? cause.limitMinutes ?? 60)}, and this one reached that limit.`;
    case "ensembleIdleStop":
      return `Ensemble stopped the round: no reply from the model for ${formatLimitDurationV1(facts.idleMinutes ?? 20)}.`;
    case "ensembleRepeatStop":
      return "Ensemble stopped the round because the model kept repeating itself.";
    case "ensembleEndOfTurn":
      return "The model had finished its turn but did not exit, so Ensemble stopped it.";
    case "ownerCancel":
      return "The round was cancelled.";
    case "signIn":
      return `${provider} is not signed in.`;
    case "capacity":
      return `${provider}: the model was at capacity (a temporary overload at OpenAI).`;
    case "processEnded":
      return `${provider}'s process ended without giving a result.`;
    case "processNotConfirmedStopped": {
      // The detail already names the process and what to do, in plain words, so it is said as is.
      const detail = trimDetailV1(cause.detail);
      return detail
        ? `${detail}.`
        : `${provider}'s process could not be confirmed stopped; it may still be running and editing the workspace.`;
    }
    case "providerError": {
      const detail = trimDetailV1(cause.detail);
      return `${provider} reported an error${detail ? `: ${detail}` : ""}.`;
    }
    case "generic": {
      const detail = trimDetailV1(cause.detail);
      return `${provider} failed${detail ? `: ${detail}` : ""}.`;
    }
  }
}

/**
 * The plain sentences for a stop: whose limit it was, how long the round worked, what changed,
 * and that the edits are still in the working tree with what the next step does with them.
 * "changed N files" is used only for the round's attributed changes; unattributed ones read
 * "N files changed in the workspace while it ran".
 */
export function describeRoundStopV1(cause: RoundStopCauseV1, facts: RoundStopFactsV1): string {
  if (facts.fragment !== undefined) {
    return describeStopFragmentV1(cause, facts, facts.fragment);
  }
  const parts: string[] = [headlineV1(cause, facts)];
  if (facts.reportWrittenAt) {
    parts.push(`It wrote a report at ${facts.reportWrittenAt} but did not exit.`);
  }
  const attributed = facts.attributedFilesChanged ?? 0;
  const unattributed = facts.unattributedFilesChanged ?? 0;
  const worked = facts.workedMs !== undefined && facts.workedMs >= 60_000 ? `It worked ${formatWorkedV1(facts.workedMs)}` : "";
  if (worked && attributed > 0) {
    parts.push(`${worked} and changed ${filesPhraseV1(attributed)}.`);
  } else if (worked) {
    parts.push(`${worked}.`);
  } else if (attributed > 0) {
    parts.push(`It changed ${filesPhraseV1(attributed)}.`);
  }
  if (unattributed > 0) {
    parts.push(`${filesPhraseV1(unattributed)} changed in the workspace while it ran.`);
  }
  if (attributed + unattributed > 0 && cause.kind !== "ownerCancel") {
    parts.push(
      facts.continuing
        ? "Continuing from the working tree."
        : `Its edits are still in the working tree; ${facts.nextStep ?? "the next round continues from them"}.`
    );
  }
  return parts.join(" ");
}

/**
 * The one-line lead of a failure message ("Claude Code hit a usage limit: <the provider's text>"),
 * without a closing full stop so a caller can continue the sentence. "usage limit" and "quota"
 * appear only for the kinds the provider's own output established; every other cause keeps its
 * own wording, with the raw detail kept inside it.
 */
export function describeStopLeadV1(cause: RoundStopCauseV1, providerLabel: string, rawErrorMessage?: string): string {
  return describeRoundStopV1(cause, { providerLabel, fragment: "lead", rawDetail: rawErrorMessage });
}

/** The fragments `describeRoundStopV1` returns for `facts.fragment`. */
function describeStopFragmentV1(
  cause: RoundStopCauseV1,
  facts: RoundStopFactsV1,
  fragment: NonNullable<RoundStopFactsV1["fragment"]>
): string {
  const limitName = cause.kind === "providerUsageLimit" ? "usage limit" : "quota or rate limit";
  switch (fragment) {
    case "limitName":
      return limitName;
    case "waitForReset":
      return facts.resetText !== undefined
        ? `wait for the ${limitName} to reset (earliest ${facts.resetText})`
        : `wait for the ${limitName} to reset`;
    case "lead": {
      const withRaw = (lead: string): string => {
        const raw = trimDetailV1(facts.rawDetail);
        return raw ? `${lead}: ${raw}` : lead;
      };
      switch (cause.kind) {
        case "providerUsageLimit":
          return withRaw(`${facts.providerLabel} hit a usage limit`);
        case "providerQuota":
          return withRaw(`${facts.providerLabel} hit a quota or rate limit`);
        case "providerPayment":
          return withRaw(`${facts.providerLabel} was refused for payment`);
        default:
          return headlineV1(cause, facts).replace(/[.\s]+$/, "");
      }
    }
  }
}

/** Convenience: classify and describe in one call. */
export function describeRoundStopFromSignalsV1(
  signals: RoundStopSignalsV1,
  facts: RoundStopFactsV1,
  now: Date = new Date()
): string {
  return describeRoundStopV1(classifyRoundStopV1(signals, now), facts);
}

/** "Ensemble tried 3 times by itself to finish this round and has stopped trying." */
export function describeEnsembleRetriesGaveUpV1(attempts: number): string {
  return `Ensemble tried ${attempts === 1 ? "once" : `${attempts} times`} by itself to finish this round and has stopped trying.`;
}

/**
 * run1 plain words: how a provider's quota-type failure is named in a sentence. "usage limit" only when
 * the provider's own text says so (the same decision {@link classifyRoundStopV1} makes); otherwise the
 * neutral "quota or rate limit". Cards that build their own sentence around a limit use this, so the one
 * decision is never repeated as a local pattern.
 */
export function describeProviderLimitPhraseV1(providerText: string | undefined): "usage limit" | "quota or rate limit" {
  const cause = classifyRoundStopV1({ failureKind: "quota", errorMessage: providerText });
  return describeRoundStopV1(cause, { providerLabel: "", fragment: "limitName" }) as "usage limit" | "quota or rate limit";
}

/**
 * run1 plain words: the "wait for the limit to reset" step of a recovery sentence, for provider failures that
 * were limits. "usage limit" only when at least one provider's own text says so; otherwise the neutral
 * "quota or rate limit". `earliestReset` is the time as the caller formats it, when a provider gave one.
 */
export function describeWaitForLimitResetV1(
  providerTexts: readonly (string | undefined)[],
  earliestReset?: string
): string {
  const causes = providerTexts.map((text) => classifyRoundStopV1({ failureKind: "quota", errorMessage: text }));
  const cause: RoundStopCauseV1 =
    causes.find((candidate) => candidate.kind === "providerUsageLimit") ?? causes[0] ?? { kind: "providerQuota" };
  return describeRoundStopV1(cause, {
    providerLabel: "",
    fragment: "waitForReset",
    ...(earliestReset !== undefined ? { resetText: earliestReset } : {}),
  });
}

/** "The 74 changed files are kept for the next round." */
export function describeChangedFilesKeptV1(count: number): string {
  return count === 1
    ? "The 1 changed file is kept for the next round."
    : `The ${count} changed files are kept for the next round.`;
}
