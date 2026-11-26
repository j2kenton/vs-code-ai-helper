/**
 * bugs6 item 41 (1.18 backport of 70e250a): what an editing round's prompt says about time. A round told "this round
 * has a wall-clock budget of roughly 60 minutes" with no start time and no way to read the clock stopped after 12 of
 * them (bugs6 item 41) and, in another case, after 6 (item 46). The prompt now carries the start and the end of the
 * budget in UTC, says how to read the real time where the round may, and says what to do where it cannot: never stop
 * for time on a guess.
 *
 * In 1.18 the 60 minutes is also the CLI runner's own wall-clock limit (`RUN_TIMEOUT_MS` in `cliAgentRunner.ts`), so
 * the end the prompt names is never later than the limit that is enforced. The prompt is rendered just before the
 * round starts, so the time it names is, if anything, slightly early.
 */
import { roundAdapterAllowsClockCommandV1, ROUND_CLOCK_COMMAND_V1 } from "./roundClockCommandV1";

/** The time budget the editing-round prompts state ("roughly 60 minutes"); equal to the CLI runner's limit. */
export const ROUND_PROMPT_BUDGET_MINUTES_V1 = 60;

/** The minutes left at which stopping for time is right. */
export const ROUND_STOP_FOR_TIME_MINUTES_LEFT_V1 = 10;

export interface RoundClockV1 {
  readonly startedAt: Date;
  readonly budgetEndsAt: Date;
  readonly budgetMinutes: number;
}

/** The round's clock: it starts at `startedAt` and its budget is {@link ROUND_PROMPT_BUDGET_MINUTES_V1} minutes. */
export function buildRoundClockV1(startedAt: Date = new Date()): RoundClockV1 {
  const budgetMinutes = ROUND_PROMPT_BUDGET_MINUTES_V1;
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
  options: { readonly modelId?: string; readonly now?: Date } = {}
): string {
  if (!ROUND_CLOCK_PROMPT_FILES_V1.has(templateFileName)) {
    return prompt;
  }
  return `${prompt}${formatRoundClockPromptBlockV1(buildRoundClockV1(options.now), options.modelId)}`;
}
