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

/**
 * bugs6 items 41 and 46 (1.18 backport): Apply Review rounds stopped after 6 and 12 of their 60 minutes, one on a
 * guess that time was nearly up, one after declining a single hard step while saying nothing blocked the rest.
 */
void describe("apply-impl-review-code.md (bugs6 items 41 and 46)", () => {
  const text = (): string => promptText("apply-impl-review-code.md");

  void it("says to stop for time only with about 10 minutes left, never on a guess", () => {
    assert.match(text(), /Stop for time only when you can see that about 10 minutes or less of the budget are left, never on a guess/);
    assert.match(text(), /where you cannot read the clock, stop early only when every remaining step is blocked/);
    assert.doesNotMatch(text(), /If the remaining work will not fit in the budget/);
  });

  void it("says to go on to the next unblocked step after declining one", () => {
    assert.match(
      text(),
      /When you decline or can't finish a step, record why under Remaining Blockers, then go on to the next step that nothing blocks\. Stop early only when every remaining step is blocked, or when about 10 minutes are left\./
    );
  });

  void it("says a full suite it cannot run is no reason to decline a step", () => {
    assert.match(text(), /Rounds don't run the full suite because Publish Checks do, so being unable to run it is not a reason to decline a step/);
  });
});
