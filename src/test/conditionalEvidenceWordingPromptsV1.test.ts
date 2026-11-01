/**
 * bugs4 Step 27 (item 19): the plan-generation prompt asks for owner-evidence state written as a
 * condition, and every plan-review prompt flags a present-tense claim ("the current `task.md` has
 * no ...") as a blocker that asks for conditional wording.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

function promptText(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "resources", "prompts", name), "utf8");
}

void describe("plan-generation prompt (bugs4 item 19)", () => {
  void it("asks for evidence state as a condition, never a present-tense fact", () => {
    const text = promptText("create-plan.md");
    assert.match(text, /Write every statement about the state of owner evidence as a condition, never as a present-tense fact/);
    assert.match(text, /Step 10 starts once `task\.md` records/);
    assert.match(text, /the current `task\.md` has no selected export/);
  });
});

for (const name of ["review-plan-high.md", "review-plan-low.md", "review-plan-high-rereview.md", "review-plan-low-rereview.md"]) {
  void describe(`${name} (bugs4 item 19)`, () => {
    void it("flags present-tense evidence claims and asks for conditional wording", () => {
      const text = promptText(name);
      assert.match(text, /Present-tense evidence claims:/);
      assert.match(text, /"the current `task\.md` has no \.\.\."/);
      assert.match(text, /file a task-fixable blocker asking for conditional wording/i);
    });

    void it("ties the User Request section to task.md", () => {
      assert.match(promptText(name), /`## User Request` section of a round prompt is the current contents of `task\.md`/);
    });
  });
}
