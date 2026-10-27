import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendRoundGitStatePolicyV1 } from "../utils/promptTemplates";

void describe("round Git state protection policy", () => {
  void it("adds the shared policy to editing, review and fix-round prompts", () => {
    for (const template of [
      "run-implementation.md",
      "apply-review.md",
      "apply-impl-review-code.md",
      "review-impl-high.md",
      "review-publish-rereview.md",
      "final-fixes-code.md",
    ]) {
      const prompt = appendRoundGitStatePolicyV1(template, "round instructions");
      assert.ok(prompt.includes("Git State Protection"), template);
      assert.ok(prompt.includes("git stash"), template);
      assert.ok(prompt.includes("git checkout"), template);
      assert.ok(prompt.includes("git restore"), template);
      assert.ok(prompt.includes("git reset"), template);
      assert.ok(prompt.includes("git apply"), template);
      assert.ok(prompt.includes("git merge"), template);
      assert.ok(prompt.includes("git rebase"), template);
      assert.ok(prompt.includes("prompt-level protection"), template);
    }
  });

  void it("does not add round-only policy to task creation prompts", () => {
    assert.equal(appendRoundGitStatePolicyV1("create-plan.md", "create a plan"), "create a plan");
  });
});
