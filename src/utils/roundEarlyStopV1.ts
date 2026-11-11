/**
 * bugs6 items 41 and 46: an editing round that stops with most of its time budget unused is flagged in its run
 * record and in the chat, and the steps it declines are recorded with the reason from its own Remaining Blockers, so a
 * step declined twice for a reason no round can change raises one card instead of coming back every cycle.
 *
 * Everything here is deliberately conservative: an early stop is flagged only when the round's own report says it
 * stopped for time, or names steps it calls unblocked, AND less than half of the budget was used. Phrases alone never
 * flag a round.
 */
import { remainingBlockersLinesV1 } from "./implementationChecklist";
import { ROUND_EARLY_STOP_FRACTION_V1, ROUND_PROMPT_BUDGET_MINUTES_V1 } from "./roundClockV1";

export interface RoundEarlyStopV1 {
  readonly kind: "time-claim" | "unblocked-steps";
  readonly minutesUsed: number;
  readonly budgetMinutes: number;
  readonly unblockedSteps?: number;
  /** The text for the run record and the chat line. */
  readonly text: string;
}

const TIME_CLAIM_RE =
  /\b(?:time\s+budget|wall[-\s]clock|running\s+out\s+of\s+time|ran\s+(?:short|out)\s+of\s+time|out\s+of\s+time|so\s+little\s+time|little\s+time\s+(?:left|remaining)|time\s+(?:limit|constraint)s?|budget\s+(?:was\s+)?(?:nearly|almost)\s+(?:used|exhausted|spent)|not\s+enough\s+time)\b/i;
const STOP_WORD_RE = /\b(?:stopp?(?:ed|ing)?|did\s+not\s+start|didn't\s+start|not\s+start(?:ed)?|ending|ended|halt(?:ed)?|leave|left|land(?:ed)?\s+a\s+(?:coherent\s+)?slice)\b/i;
const UNBLOCKED_RE =
  /\bnothing\s+(?:in\s+(?:the\s+)?(?:code|plan|repo|repository)\s+)?(?:blocks|is\s+blocking|stops|prevents)\s+(?:them|these|those|it)\b|\bnot\s+blocked\s+by\s+anything\b|\bno\s+blocker\s+(?:prevents|stops)\b|\bunblocked\b/i;
const STEP_REF_RE = /\b(?:steps?|parts?)\s+(\d+)(?:\s*[–-]\s*(\d+))?/gi;

function distinctStepRefs(text: string): number {
  const refs = new Set<string>();
  for (const match of text.matchAll(STEP_REF_RE)) {
    const from = Number(match[1]);
    const to = match[2] !== undefined ? Number(match[2]) : from;
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from < 50) {
      for (let n = from; n <= to; n += 1) refs.add(`${match[0].toLowerCase().startsWith("part") ? "p" : "s"}${n}`);
    }
  }
  return refs.size;
}

/**
 * Flags a round that ended with less than half its budget used when its report says it stopped for time, or its
 * Remaining Blockers say steps it leaves open are unblocked. `undefined` when the round used half or more of its
 * budget, or says neither.
 */
export function detectRoundEarlyStopV1(input: {
  readonly summary: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly budgetMinutes?: number;
}): RoundEarlyStopV1 | undefined {
  const budgetMinutes = input.budgetMinutes ?? ROUND_PROMPT_BUDGET_MINUTES_V1;
  if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.endedAtMs) || input.endedAtMs < input.startedAtMs) {
    return undefined;
  }
  const minutesUsed = Math.round((input.endedAtMs - input.startedAtMs) / 60_000);
  if (minutesUsed >= budgetMinutes * ROUND_EARLY_STOP_FRACTION_V1) {
    return undefined;
  }
  const blockerLines = remainingBlockersLinesV1(input.summary);
  const unblockedLines = blockerLines.filter((line) => UNBLOCKED_RE.test(line));
  if (unblockedLines.length > 0) {
    const unblockedSteps = Math.max(1, distinctStepRefs(unblockedLines.join(" ")));
    return {
      kind: "unblocked-steps",
      minutesUsed,
      budgetMinutes,
      unblockedSteps,
      text: `stopped after ${minutesUsed} of ${budgetMinutes} minutes with ${unblockedSteps} unblocked step${unblockedSteps === 1 ? "" : "s"} left`,
    };
  }
  const claimsTime = input.summary
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => TIME_CLAIM_RE.test(sentence) && STOP_WORD_RE.test(sentence));
  if (claimsTime) {
    return {
      kind: "time-claim",
      minutesUsed,
      budgetMinutes,
      text: `stopped early: ${minutesUsed} of ${budgetMinutes} minutes used`,
    };
  }
  return undefined;
}

/**
 * The chat line for a flagged early stop. The Ended line carries the flag as an outcome-kind line, which the chat
 * transcript hides, so this is posted as a normal assistant line (no `kind`).
 */
export function describeEarlyStopChatLineV1(flag: Pick<RoundEarlyStopV1, "text">): string {
  return (
    `This round ${flag.text}. The review that follows will show what it left open; ` +
    "click Apply Review again to continue from the next step nothing blocks."
  );
}

/** Why a round declined a step, when the reason is one no round can change on its own. */
export type DeclinedStepKindV1 = "full-suite" | "too-large" | "other";

export interface DeclinedStepV1 {
  readonly step: string;
  readonly kind: DeclinedStepKindV1;
  readonly reason: string;
}

const FULL_SUITE_RE = /\bfull[-\s](?:test\s+)?suite\b|\bwhole\s+(?:test\s+)?suite\b|\bentire\s+(?:test\s+)?suite\b|which\s+this\s+round\s+does\s+not\s+allow|verify:workflow-safety/i;
const TOO_LARGE_RE = /\babout\s+[\d,]+[-\s]lines?\b|~\s*[\d,]+[-\s]lines?\b|[\d,]+[-\s]lines?\b[^.]{0,40}\bfunction\b|\btoo\s+(?:large|big)\b|\blarge\s+refactor\b|\b(?:cannot|can't|does\s+not|doesn't)\s+fit\s+in\s+one\s+round\b|\bmore\s+than\s+one\s+round\b/i;
const DECLINE_RE = /\b(?:declin\w+|did\s+not\s+(?:start|build|attempt)|didn't\s+(?:start|build|attempt)|stopped\s+because|stopped\s+here|not\s+attempt\w*|left\s+(?:for|to)|could\s+not|couldn't|can't|cannot)\b/i;

/**
 * The steps a round declined, from its own `## Remaining Blockers`: each line that names a `Step N` (or `Part N`) and
 * says it did not do it, with the reason as written and a kind for the two reasons no round can change on its own (it
 * needs the full suite, which rounds don't run; it is too large for one round). Lines that only say other steps are
 * unblocked are not declines.
 */
export function parseDeclinedStepsV1(summary: string): DeclinedStepV1[] {
  const found: DeclinedStepV1[] = [];
  for (const raw of remainingBlockersLinesV1(summary)) {
    if (UNBLOCKED_RE.test(raw) && !DECLINE_RE.test(raw)) continue;
    const ref = /\b(Step|Part)\s+(\d+)\b/i.exec(raw);
    if (!ref || !DECLINE_RE.test(raw)) continue;
    const step = `${ref[1]![0]!.toUpperCase()}${ref[1]!.slice(1).toLowerCase()} ${ref[2]}`;
    const reason = raw.replace(/^[\s>\-*•]+/, "").replace(/\s+/g, " ").trim().slice(0, 300);
    const kind: DeclinedStepKindV1 = FULL_SUITE_RE.test(raw) ? "full-suite" : TOO_LARGE_RE.test(raw) ? "too-large" : "other";
    if (!found.some((entry) => entry.step === step)) found.push({ step, kind, reason });
  }
  return found.slice(0, 20);
}

export interface RepeatedlyDeclinedStepV1 {
  readonly step: string;
  readonly kind: Exclude<DeclinedStepKindV1, "other">;
  readonly reason: string;
  readonly rounds: number;
}

/**
 * A step declined in at least two different rounds for a reason no round can change on its own. `rows` are the task's
 * round-ledger outcomes, oldest first; only a rounds' own `declinedSteps` count, so one round never counts twice.
 */
export function findRepeatedlyDeclinedStepV1(
  rows: readonly { readonly declinedSteps?: readonly DeclinedStepV1[] }[],
  alreadyRaised: ReadonlySet<string> = new Set()
): RepeatedlyDeclinedStepV1 | undefined {
  const counts = new Map<string, { kind: Exclude<DeclinedStepKindV1, "other">; reason: string; rounds: number }>();
  for (const row of rows) {
    const seenThisRound = new Set<string>();
    for (const declined of row.declinedSteps ?? []) {
      if (declined.kind === "other" || seenThisRound.has(declined.step)) continue;
      seenThisRound.add(declined.step);
      const prior = counts.get(declined.step);
      counts.set(declined.step, { kind: declined.kind, reason: declined.reason, rounds: (prior?.rounds ?? 0) + 1 });
    }
  }
  for (const [step, entry] of counts) {
    if (entry.rounds >= 2 && !alreadyRaised.has(step)) {
      return { step, kind: entry.kind, reason: entry.reason, rounds: entry.rounds };
    }
  }
  return undefined;
}
