/**
 * The shell commands an editing round may run without anyone approving them.
 *
 * run1 Step 14: none. Claude Code's `--permission-mode acceptEdits` lets a headless round edit
 * files but refuses every shell command nobody approved, and this list used to approve the whole
 * Publish command plan (`pnpm run verify`, lint, the tests, ...). Rounds then ran the full suite
 * themselves, which is what Publish Checks do once, in full; three 60-minute rounds in a row were
 * spent that way (bugs6 item 14) while the prompt said "run only the tests that cover the files you
 * changed". The allowed tools and the prompt now say the same thing: rounds run no checks.
 *
 * What replaces them: Ensemble itself runs `check-types` and `lint` after each implementation round
 * and gives the raw results to the reviewer as ground truth, and Publish Checks run the full test
 * suite. A refused check never stops a round.
 *
 * bugs6 item 41: exactly one entry, `date -u`, matched as that exact command and never with
 * arguments. A round that cannot read the clock misjudged elapsed time and stopped after 12 of its
 * 60 minutes; the prompt now gives the start and the end of the budget in UTC, and this lets the round
 * compare them with the real time. It is safe because `date -u` with no arguments only prints the
 * current time in UTC: it reads nothing from the workspace, writes nothing, starts nothing and cannot
 * run a check, and with no wildcard rule `date -u -s …` and the like stay refused. Nothing else is
 * added: a round still runs no checks.
 *
 * Git is not listed either. Claude Code already runs read-only git (`git status`, `git diff`, ...)
 * without approval and tells those apart from git invocations that write or run helpers; a blanket
 * `Bash(git diff *)` rule would approve `git diff --output=<any path>` and external diff helpers
 * too (review, 2026-11-01).
 *
 * `_cwd` is kept so callers don't change.
 */
export const ROUND_CLOCK_COMMAND_V1 = "date -u";

/** Entries matched exactly: an adapter must not add a "command plus any arguments" form for them. */
export const EXACT_MATCH_ONLY_ROUND_SHELL_COMMANDS_V1: ReadonlySet<string> = new Set([ROUND_CLOCK_COMMAND_V1]);

/**
 * The provider ids whose headless edit mode reads {@link resolveRoundShellCommandsV1}'s list (the adapter hands it
 * to the CLI as an allow-list). Every other provider gets no shell rule from here, so it has no clock to read.
 */
const ADAPTERS_READING_THE_SHELL_ALLOWLIST_V1: ReadonlySet<string> = new Set(["claude-cli"]);

export function resolveRoundShellCommandsV1(_cwd: string): string[] {
  return [ROUND_CLOCK_COMMAND_V1];
}

/**
 * True when a round run on the provider behind `modelId` (`<provider>:<model>@<effort>`) is allowed to run
 * `date -u`: its adapter reads the shell allow-list and that list holds the command. Decided by the same list the
 * runner passes, so the prompt never offers a command the round will be refused.
 */
export function roundAdapterAllowsClockCommandV1(modelId: string | undefined, cwd = ""): boolean {
  if (modelId === undefined) {
    return false;
  }
  const providerId = modelId.split(":")[0] ?? "";
  return (
    ADAPTERS_READING_THE_SHELL_ALLOWLIST_V1.has(providerId) && resolveRoundShellCommandsV1(cwd).includes(ROUND_CLOCK_COMMAND_V1)
  );
}
