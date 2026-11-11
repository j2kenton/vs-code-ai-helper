/**
 * bugs6 item 41: what an editing round's prompt says about time. A round told "this round has a wall-clock budget of
 * roughly 60 minutes" with no start time and no way to read the clock stopped after 12 of them (bugs6 item 41) and, in
 * another case, after 6 (item 46). The prompt now carries the start and the stop in UTC, says how to read the real time
 * where the round may, and says what to do where it cannot: never stop for time on a guess. The time named is the end
 * of the round's own 60-minute budget, not a kill by the runner (the runner's limit is the far-off backstop), so the
 * prompt calls it the end of the budget and never says Ensemble will end the round then (owner decision
 * step-12-hard-stop, 2026-11-11).
 */
import { getResilienceSettings } from "../config/settings";
import { roundAdapterAllowsClockCommandV1, ROUND_CLOCK_COMMAND_V1 } from "./roundShellAllowlistV1";

/** The time budget the editing-round prompts state ("roughly 60 minutes"). */
export const ROUND_PROMPT_BUDGET_MINUTES_V1 = 60;

/** A round that ends with less than this fraction of its budget used, and says it stopped for time, is flagged. */
export const ROUND_EARLY_STOP_FRACTION_V1 = 0.5;

/** The minutes left at which stopping for time is right. */
export const ROUND_STOP_FOR_TIME_MINUTES_LEFT_V1 = 10;

export interface RoundClockV1 {
  readonly startedAt: Date;
  readonly budgetEndsAt: Date;
  readonly budgetMinutes: number;
}

/**
 * The round's clock: it starts at `startedAt` and its budget is {@link ROUND_PROMPT_BUDGET_MINUTES_V1} minutes, capped
 * by the runner's own far-off backstop (`ensemble.resilience.roundBackstopHours`, the limit that actually kills a
 * process) when a lower one is configured, so the end the prompt names is never later than the limit that is enforced.
 */
export function buildRoundClockV1(startedAt: Date = new Date(), backstopHours?: number): RoundClockV1 {
  let backstop = backstopHours;
  if (backstop === undefined) {
    try {
      backstop = getResilienceSettings().roundBackstopHours;
    } catch {
      backstop = undefined;
    }
  }
  const budgetMinutes =
    backstop !== undefined && Number.isFinite(backstop) && backstop > 0
      ? Math.min(ROUND_PROMPT_BUDGET_MINUTES_V1, Math.floor(backstop * 60))
      : ROUND_PROMPT_BUDGET_MINUTES_V1;
  return { startedAt, budgetEndsAt: new Date(startedAt.getTime() + budgetMinutes * 60_000), budgetMinutes };
}

/** "19:36 UTC". */
export function formatUtcClockV1(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/**
 * The block appended to an editing round's prompt. `modelId` is the model the round runs on; the `date -u` instruction
 * is given only when that model's adapter is allowed to run it (`roundAdapterAllowsClockCommandV1`, the same list the
 * runner hands the CLI). Without one, the block says there is no clock and forbids stopping for time on a guess.
 */
export function formatRoundClockPromptBlockV1(clock: RoundClockV1, modelId: string | undefined): string {
  const started = formatUtcClockV1(clock.startedAt);
  const stop = formatUtcClockV1(clock.budgetEndsAt);
  const header = `## Round clock\n\nThis round started at ${started}; its time budget is ${clock.budgetMinutes} minutes and ends at ${stop}.`;
  if (roundAdapterAllowsClockCommandV1(modelId)) {
    return (
      `\n\n${header} Run \`${ROUND_CLOCK_COMMAND_V1}\` to check the real time. Stop for time only when \`${ROUND_CLOCK_COMMAND_V1}\` shows ` +
      `less than about ${ROUND_STOP_FOR_TIME_MINUTES_LEFT_V1} minutes left before ${stop}; never stop for time on a guess about how long you have worked, ` +
      `and finish a step you have started before you check again.\n`
    );
  }
  return (
    `\n\n${header} This round's tools give you no way to read the clock, so you cannot know how much of the budget is used: do not stop for time on a guess. ` +
    `Stop early only when every remaining step is blocked; otherwise go on to the next step until the budget ends at ${stop}.\n`
  );
}

/** The prompt files that are editing rounds and carry the clock block. */
export const ROUND_CLOCK_PROMPT_FILES_V1: ReadonlySet<string> = new Set(["run-implementation.md", "apply-impl-review-code.md"]);

export function appendRoundClockPolicyV1(
  templateFileName: string,
  prompt: string,
  options: { readonly modelId?: string; readonly now?: Date; readonly backstopHours?: number } = {}
): string {
  if (!ROUND_CLOCK_PROMPT_FILES_V1.has(templateFileName)) {
    return prompt;
  }
  return `${prompt}${formatRoundClockPromptBlockV1(buildRoundClockV1(options.now, options.backstopHours), options.modelId)}`;
}
