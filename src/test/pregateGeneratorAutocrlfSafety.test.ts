/**
 * Regression lock for a gap an implementation review found: the two
 * immutable pre-gate snapshot generators (`generatePregateProductionSourceBaseline.mjs`,
 * `generatePregateWorkflowInventoryBaselines.mjs`) both materialize a
 * historical commit into a scratch `git worktree` and hash its files. If
 * either script's `worktree add` runs without `-c core.autocrlf=false`, the
 * checked-out bytes — and therefore the recorded digests — become dependent
 * on the generating machine's `core.autocrlf` setting, silently diverging
 * from the other script and from any machine with a different Git config.
 *
 * Both scripts already pass the flag today, but nothing previously proved
 * it structurally, so a future edit could drop it from one script without
 * any test failing. This test pins the invariant by source position: the
 * `-c core.autocrlf=false` git argument must appear in the exact same
 * `git([...])` call as the `worktree add` it protects, in both generators.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

const PREGATE_GENERATOR_SCRIPTS = [
  "scripts/generatePregateProductionSourceBaseline.mjs",
  "scripts/generatePregateWorkflowInventoryBaselines.mjs",
] as const;

void describe("pregate worktree checkouts pin core.autocrlf=false", () => {
  for (const scriptPath of PREGATE_GENERATOR_SCRIPTS) {
    void it(`${scriptPath} passes -c core.autocrlf=false to the same git() call as its worktree add`, () => {
      const content = readRepoFile(scriptPath);

      const worktreeAddIndex = content.indexOf('"worktree", "add"');
      assert.ok(worktreeAddIndex >= 0, `could not find a worktree add call in ${scriptPath}`);

      // The git() call is a single statement; find its start ("git([") and
      // end (the matching closing call parenthesis) so the flag check is
      // scoped to exactly this invocation, not merely "somewhere earlier in
      // the file" (which the sibling `worktree remove` call would also
      // satisfy without protecting anything).
      const callStart = content.lastIndexOf("git([", worktreeAddIndex);
      assert.ok(callStart >= 0, `could not find the git([...]) call wrapping worktree add in ${scriptPath}`);

      const callEnd = content.indexOf(");", worktreeAddIndex);
      assert.ok(callEnd > worktreeAddIndex, `could not find the end of the worktree add git() call in ${scriptPath}`);

      const callText = content.slice(callStart, callEnd);
      assert.ok(
        callText.includes('"-c", "core.autocrlf=false"'),
        `${scriptPath}'s worktree add call must pass -c core.autocrlf=false so checked-out bytes are ` +
          `independent of the generating machine's Git config (found: ${JSON.stringify(callText)})`
      );
    });
  }
});
