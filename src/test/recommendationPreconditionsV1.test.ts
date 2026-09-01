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

  // Review-invalidation axis (review blocker 2026-08-31, extending Part 12
  // step 34): applyReviewEditWithAI refuses whenever the review artifact for
  // the target stage has been invalidated by an incomplete round, regardless
  // of whether the command in question is resume-safe on the paused axis.
  void it("blocks a stage-arg apply-review command when the target stage's review is invalidated", () => {
    const result = recommendationPreconditionsV1(
      {
        kind: "command",
        command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
        args: [{ taskFolderPath: "/x", reviewStage: "impl-high-review" }],
      },
      { status: "active", reviewInvalidatedByRoundStage: "impl-high-review" }
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /run the review again/);
  });

  void it("does not block a stage-arg apply-review command when a DIFFERENT stage's review is invalidated", () => {
    const result = recommendationPreconditionsV1(
      {
        kind: "command",
        command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
        args: [{ taskFolderPath: "/x", reviewStage: "impl-high-review" }],
      },
      { status: "active", reviewInvalidatedByRoundStage: "impl-low-review" }
    );
    assert.equal(result.blocked, false);
  });

  void it("blocks a current-stage apply-review command when the CURRENT stage's review is invalidated", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyHighLevelReviewChanges" },
      { status: "active", currentStage: "impl-high-review", reviewInvalidatedByRoundStage: "impl-high-review" }
    );
    assert.equal(result.blocked, true);
  });

  void it("does not block a current-stage apply-review command when the task is not yet at the invalidated stage", () => {
    // currentStage is deliberately a DIFFERENT stage this same command still
    // accepts (plan-high-review, not impl-high-review) — isolating the
    // review-invalidation axis from the out-of-stage axis added below, which
    // has its own dedicated tests.
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyHighLevelReviewChanges" },
      { status: "active", currentStage: "plan-high-review", reviewInvalidatedByRoundStage: "impl-high-review" }
    );
    assert.equal(result.blocked, false);
  });

  void it("never blocks the paused-status-resume-safe wrapper on the review-invalidation axis when there is no invalidation", () => {
    const result = recommendationPreconditionsV1(
      {
        kind: "command",
        command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
        args: [{ taskFolderPath: "/x", reviewStage: "impl-high-review" }],
      },
      { status: "paused" }
    );
    assert.equal(result.blocked, false);
  });

  void it("does not block an unrelated command even when a review is invalidated", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.someUnrelatedCommand" },
      { status: "active", currentStage: "impl-high-review", reviewInvalidatedByRoundStage: "impl-high-review" }
    );
    assert.equal(result.blocked, false);
  });

  // Continuation-owed axis (review blocker 2026-08-31, round 2 — Part 12
  // step 34 names this as its own precondition, distinct from
  // review-invalidation): `implRecovery` is task-level, so this blocks
  // regardless of which target stage the effect names.
  void it("blocks a current-stage apply-review command when a continuation is owed", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyHighLevelReviewChanges" },
      { status: "active", currentStage: "impl-high-review", continuationOwed: true }
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /continuation from an earlier round/);
  });

  void it("blocks a stage-arg apply-review command when a continuation is owed, even for an unrelated target stage", () => {
    const result = recommendationPreconditionsV1(
      {
        kind: "command",
        command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
        args: [{ taskFolderPath: "/x", reviewStage: "impl-low-review" }],
      },
      { status: "active", continuationOwed: true }
    );
    assert.equal(result.blocked, true);
  });

  void it("does not block an apply-review command when no continuation is owed", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyHighLevelReviewChanges" },
      { status: "active", currentStage: "impl-high-review", continuationOwed: false }
    );
    assert.equal(result.blocked, false);
  });

  void it("does not block an unrelated command even when a continuation is owed", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.someUnrelatedCommand" },
      { status: "active", continuationOwed: true }
    );
    assert.equal(result.blocked, false);
  });

  // Out-of-stage axis (review blocker 2026-08-31, round 2): a
  // current-stage apply-review command dispatched while the task is not at
  // one of the stages that command's own handler accepts.
  void it("blocks applyHighLevelReviewChanges when the task is at a stage it does not accept", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyHighLevelReviewChanges" },
      { status: "active", currentStage: "impl" }
    );
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /not at the review stage/);
  });

  void it("does not block applyHighLevelReviewChanges at plan-high-review", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyHighLevelReviewChanges" },
      { status: "active", currentStage: "plan-high-review" }
    );
    assert.equal(result.blocked, false);
  });

  void it("blocks applyLowLevelReviewChanges when the task is at a High-Level review stage", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyLowLevelReviewChanges" },
      { status: "active", currentStage: "impl-high-review" }
    );
    assert.equal(result.blocked, true);
  });

  void it("blocks applyReviewEditWithAI outside the implementation-review stages", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyReviewEditWithAI" },
      { status: "active", currentStage: "plan-high-review" }
    );
    assert.equal(result.blocked, true);
  });

  void it("does not block applyReviewEditWithAI at impl-low-review", () => {
    const result = recommendationPreconditionsV1(
      { kind: "command", command: "vs-code-ai-helper.applyReviewEditWithAI" },
      { status: "active", currentStage: "impl-low-review" }
    );
    assert.equal(result.blocked, false);
  });

  void it("does not apply the out-of-stage check to a stage-arg command (it jumps stage itself)", () => {
    const result = recommendationPreconditionsV1(
      {
        kind: "command",
        command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
        args: [{ taskFolderPath: "/x", reviewStage: "impl-high-review" }],
      },
      { status: "active", currentStage: "impl" }
    );
    assert.equal(result.blocked, false);
  });
});
