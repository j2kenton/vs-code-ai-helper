/**
 * bugs6 item 41 (1.18 backport): the one clock command an editing round may run, `date -u`, and the rule that it is
 * matched as that exact command only. Kept in a module with no imports so the provider adapters
 * (`runners/providers.ts`) can read it without importing `roundShellAllowlistV1.ts`, whose Publish-plan reader pulls
 * in a large part of the extension (and, through it, the adapters themselves).
 */
export const ROUND_CLOCK_COMMAND_V1 = "date -u";

/** Entries matched exactly: an adapter must not add a "command plus any arguments" form for them. */
export const EXACT_MATCH_ONLY_ROUND_SHELL_COMMANDS_V1: ReadonlySet<string> = new Set([ROUND_CLOCK_COMMAND_V1]);

/**
 * The provider ids whose headless edit mode reads `resolveRoundShellCommandsV1`'s list (the adapter hands it to the
 * CLI as an allow-list). Every other provider gets no shell rule from there, so the prompt offers it no clock.
 */
const ADAPTERS_READING_THE_SHELL_ALLOWLIST_V1: ReadonlySet<string> = new Set(["claude-cli"]);

/**
 * True when a round run on the provider behind `modelId` (`<provider>:<model>@<effort>`) is allowed to run
 * `date -u`: its adapter reads the shell allow-list, and `resolveRoundShellCommandsV1` always lists the clock. So the
 * prompt never offers a command the round will be refused.
 */
export function roundAdapterAllowsClockCommandV1(modelId: string | undefined): boolean {
  if (modelId === undefined) {
    return false;
  }
  const providerId = modelId.split(":")[0] ?? "";
  return ADAPTERS_READING_THE_SHELL_ALLOWLIST_V1.has(providerId);
}
