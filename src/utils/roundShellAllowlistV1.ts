import { resolveCurrentPublishCommandPlanV1 } from "./completionLint";

/**
 * The shell commands an editing round may run without anyone approving them:
 * the project's own checks (the commands Publish Checks would run, configured
 * or detected from package.json).
 *
 * Why this exists: Claude Code's `--permission-mode acceptEdits` lets a
 * headless round edit files but refuses every shell command nobody approved
 * ("This command requires approval"). The owner's machines only worked
 * because their git-ignored `.claude/settings.local.json` files had grown
 * allow-lists, and the cloud box needed one copied in by hand (commit
 * aa8d768). A new user's rounds could edit but never run a test, so reviews
 * looped on blockers nobody could verify. Ensemble now passes this list
 * itself, so nobody has to edit Claude Code's settings.
 *
 * Git is deliberately NOT listed. Claude Code already runs read-only git
 * (`git status`, `git diff`, ...) without approval and tells those apart from
 * git invocations that write or run helpers; a blanket `Bash(git diff *)`
 * rule would approve `git diff --output=<any path>` and external diff
 * helpers too (review, 2026-11-01).
 */

/**
 * A command piece we can safely name in a permission rule: no quotes, no
 * expansions, no redirection or chaining (compound commands are split before
 * this check, and Claude Code matches each part of a compound command on its
 * own).
 */
function isPlainCommandV1(command: string): boolean {
  return command.length > 0 && command.length <= 200 && !/["'`$%^!<>|;&\\\r\n]/.test(command);
}

/** Split `a && b`, `a; b` and `a || b` into their parts. */
function splitCompoundV1(command: string): string[] {
  return command
    .split(/&&|\|\||;/)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter((part) => part.length > 0);
}

/**
 * The commands a round in `cwd` may run unprompted. Monorepo member checks
 * ("[packages/app] pnpm run test") are listed without their folder prefix,
 * because the round runs them from inside that folder. A command whose first
 * word is `git` is never listed (see the module comment).
 */
export function resolveRoundShellCommandsV1(cwd: string): string[] {
  const plan = resolveCurrentPublishCommandPlanV1(cwd) ?? [];
  const commands = new Set<string>();
  for (const entry of plan) {
    const withoutPrefix = entry.replace(/^\[[^\]]*\]\s*/, "");
    for (const part of splitCompoundV1(withoutPrefix)) {
      if (isPlainCommandV1(part) && !/^git(\s|$)/.test(part)) {
        commands.add(part);
      }
    }
  }
  return [...commands];
}
