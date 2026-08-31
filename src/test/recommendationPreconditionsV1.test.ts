/**
 * Coverage for `recommendationPreconditionsV1` (task "stage chat as a record
 * of work" item 14 / Part 12 step 34): the shared "will this option's effect
 * refuse right now?" check `postWorkflowDecisionV1` runs before posting a
 * decision, so an option offering an action known to refuse on a paused task
 * is disabled rather than clicked-then-refused.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recommendationPreconditionsV1 } from "../utils/recommendationPreconditionsV1";

void describe("recommendationPreconditionsV1", () => {
  void it("blocks a pause-sensitive command on a paused task", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.goToReviewAndApply" },
      { status: "paused" }
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /resume the task first/);
  });

  void it("does not block a pause-sensitive command on an active task", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.goToReviewAndApply" },
      { status: "active" }
    );
    assert.equal(result.blocked, false);
  });

  void it("never blocks a resume-safe wrapper command, even when the task is paused", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply" },
      { status: "paused" }
    );
    assert.equal(result.blocked, false);
  });

  void it("never blocks a doNothing effect", () => {
    const result = recommendationPreconditionsV1({ kind: "doNothing" }, { status: "paused" });
    assert.equal(result.blocked, false);
  });

  void it("does not block an unrecognized command — no opinion is the safe default", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.someUnrelatedCommand" },
      { status: "paused" }
    );
    assert.equal(result.blocked, false);
  });
});
