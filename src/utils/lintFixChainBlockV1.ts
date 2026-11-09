/**
 * bugs4 Step 32 (item 31): why a Publish fix round ended because its model chain cannot
 * run, and what the owner should do about it. A fix round that failed on quota, payment or
 * sign-in leaves checks failing; running the same chain again hits the same wall, so the
 * recommended move is a different Publish model, never a re-run of known-failing checks.
 */
import { formatProviderErrorV1 } from "./providerErrorFormatterV1";
import { describeProviderLimitPhraseV1 } from "./roundStopCauseV1";
import { isAuthenticationFailure, isPaymentRequiredFailureV1, isQuotaError } from "./quota";
import type { ChainAttemptV1 } from "./stopBehaviourV1";

export type FixChainBlockKindV1 = "quota" | "payment-required" | "auth";

/** The kind of chain-level block a failed fix round's error describes, or undefined for anything else. */
export function classifyFixChainBlockV1(errorMessage: string | undefined): FixChainBlockKindV1 | undefined {
  if (errorMessage === undefined || errorMessage.trim() === "") return undefined;
  // Order matters: a 402 carries quota vocabulary, and an explicit quota reply can mention "token".
  if (isPaymentRequiredFailureV1(errorMessage)) return "payment-required";
  if (isQuotaError(errorMessage)) return "quota";
  if (isAuthenticationFailure(errorMessage)) return "auth";
  return undefined;
}

/** What a failed fix round's chain error says, cleaned for the card (bugs4 item 31). */
export interface FixChainFailureReadingV1 {
  /** Readable failure text: no raw envelope, repeated advice once, no contradictory reset line. */
  readonly text: string;
  /** Models the message says were tried, in order, each once. */
  readonly triedModels: readonly string[];
  /** The same models with their own outcome in plain words ("payment required", "usage limit", ...). */
  readonly triedOutcomes: readonly { readonly label: string; readonly outcome: string }[];
  /** Configured backups the message says are switched off in the stage's chain. */
  readonly disabledBackups: readonly string[];
}

const NO_RESET_SCHEDULE_SENTENCE_V1 = /\s*Payment-required failures do not have a quota reset schedule\.?/gi;

/**
 * Reads a Publish fix-round failure: shows the reset time once and never alongside "no reset
 * schedule", lists each model tried once and names disabled backups so the card can point at them.
 */
export function readFixChainFailureV1(
  errorMessage: string | undefined,
  /** The runner's structured attempt list (primary first); when present it decides the models listed. */
  attempts?: readonly ChainAttemptV1[]
): FixChainFailureReadingV1 {
  const parsed = readFixChainFailureFromTextV1(errorMessage);
  if (attempts === undefined || attempts.length === 0) {
    return parsed;
  }
  const tried = attempts.filter((attempt) => attempt.outcome === "tried-and-failed");
  return {
    text: parsed.text,
    triedModels: tried.map((attempt) => attempt.label),
    triedOutcomes: tried.map((attempt) => ({ label: attempt.label, outcome: describeTriedOutcomeV1(attempt.reason) })),
    disabledBackups: attempts
      .filter((attempt) => attempt.outcome === "disabled" && !attempt.isPrimary)
      .map((attempt) => attempt.label),
  };
}

function readFixChainFailureFromTextV1(errorMessage: string | undefined): FixChainFailureReadingV1 {
  const raw = (errorMessage ?? "").replace(/\s+/g, " ").trim();
  const triedModels: string[] = [];
  const triedOutcomes: { label: string; outcome: string }[] = [];
  // A label never contains another "Backup " / "The stage's primary " marker, so a lazy match cannot
  // swallow the sentences between two records.
  for (const match of raw.matchAll(
    /(?:The stage's primary|Backup) ((?:(?!Backup |The stage's primary ).)+?) was tried and failed: ((?:(?!Backup |The stage's primary ).)*)/g
  )) {
    const label = match[1]!.trim();
    if (triedModels.includes(label)) continue;
    triedModels.push(label);
    triedOutcomes.push({ label, outcome: describeTriedOutcomeV1(match[2] ?? "") });
  }
  // The headline names the primary's provider and its own failure ("X hit a usage limit: ..."). It is the
  // primary's outcome unless a record below already names that provider's model (the same attempt, said twice).
  const headline = /^(?:AI final fixes failed: )?(.+?) hit a (?:usage|quota or rate) limit(?:: ((?:(?!Backup |The stage's primary ).)*))?/.exec(raw);
  const headlineLabel = headline?.[1]?.trim();
  if (
    headlineLabel !== undefined &&
    headlineLabel !== "" &&
    !triedModels.some((tried) => tried === headlineLabel || tried.startsWith(headlineLabel + " "))
  ) {
    triedModels.unshift(headlineLabel);
    triedOutcomes.unshift({ label: headlineLabel, outcome: describeTriedOutcomeV1(headline?.[2] ?? "") });
  }
  const disabledBackups: string[] = [];
  for (const match of raw.matchAll(/Backup ((?:(?!Backup ).)+?) is disabled in the stage's chain; enable it to use it here\./g)) {
    const label = match[1]!.trim();
    if (!disabledBackups.includes(label)) disabledBackups.push(label);
  }
  const hasResetTime = /\bresets? in \d/i.test(raw);
  const withoutContradiction = hasResetTime ? raw.replace(NO_RESET_SCHEDULE_SENTENCE_V1, "") : raw;
  // "...model.." (a provider sentence plus our own full stop) reads as a typo; keep a real ellipsis.
  const tidied = withoutContradiction.replace(/(?<!\.)\.\.(?!\.)/g, ".");
  const text = formatProviderErrorV1(tidied, { maxChars: 600 }) ?? "no reason was reported";
  return { text, triedModels, triedOutcomes, disabledBackups };
}

/** One model's own failure in plain words, so a card can say what each model hit. */
function describeTriedOutcomeV1(reason: string): string {
  const kind = classifyFixChainBlockV1(reason);
  const reset = /\bresets? in ([^.,;]+?)(?=[.,;]|$)/i.exec(reason);
  const resetClause = reset ? `, resets in ${reset[1]!.trim()}` : "";
  switch (kind) {
    case "payment-required":
      return `payment required${resetClause}`;
    case "quota":
      // "usage limit" only when the provider's own text says so (the shared stop wording decides).
      return `${describeProviderLimitPhraseV1(reason)}${resetClause}`;
    case "auth":
      return "sign-in failed";
    default:
      return "failed";
  }
}
