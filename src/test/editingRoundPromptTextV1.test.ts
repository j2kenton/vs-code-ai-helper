/**
 * bugs4 Steps 21 and 22 (items 16 and 23): the editing-round prompts tell the agent that a
 * refused test command never stops the build, how to report it, and to finish background tasks
 * and repeat its summary if it answers again after a notification.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const EDITING_ROUND_PROMPTS = ["run-implementation.md", "apply-impl-review-code.md"] as const;

function promptText(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "resources", "prompts", name), "utf8");
}

for (const name of EDITING_ROUND_PROMPTS) {
  void describe(`${name} (bugs4 items 16 and 23)`, () => {
    void it("says a refused test command never stops a round from building", () => {
      const text = promptText(name);
      assert.match(text, /A refused test command never stops a round from building/);
      assert.match(text, /tests could not run: the provider refused the command <command>/);
      assert.match(text, /leave the test-dependent items provisional/);
      assert.match(text, /Only claiming a test-dependent item done is gated on a passing test report; building it is not/);
    });

    void it("separates a refused command from tests that ran and failed", () => {
      assert.match(promptText(name), /different from tests that ran and failed/);
    });

    void it("tells the agent to await background tasks and repeat the summary after a notification", () => {
      const text = promptText(name);
      assert.match(text, /wait for any background command or monitor to complete before you write the summary/);
      assert.match(text, /repeat the full summary/);
    });

    void it("does not tell the agent to widen permissions", () => {
      assert.doesNotMatch(promptText(name), /settings\.local\.json|add an allow rule|allowedTools/i);
    });
  });
}
