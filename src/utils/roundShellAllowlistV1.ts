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
 * Git is not listed either. Claude Code already runs read-only git (`git status`, `git diff`, ...)
 * without approval and tells those apart from git invocations that write or run helpers; a blanket
 * `Bash(git diff *)` rule would approve `git diff --output=<any path>` and external diff helpers
 * too (review, 2026-11-01).
 *
 * The function stays so the runner's wiring (and a future, deliberately narrow addition) has one
 * place to go; `_cwd` is kept so callers don't change.
 */
export function resolveRoundShellCommandsV1(_cwd: string): string[] {
  return [];
}
