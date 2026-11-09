/**
 * run1 Step 19: the row answers "where are we" in one line: the step, which of how many, what comes next.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCompletionCheckActivityAccumulatorV1 } from "../commands/reviewActions";
import type { TaskOperationHandle } from "../utils/taskOperations";
import {
  publishNextAfterChecksV1,
  publishReviewWhereLineV1,
  reviewStageWhereLineV1,
  whereAreWeLineV1,
} from "../utils/whereAreWeV1";

void describe("run1 Step 19: where are we", () => {
  void it("names the step, the count and what comes next", () => {
    assert.equal(
      whereAreWeLineV1({
        scope: "Publish",
        step: "running the checks",
        position: { index: 2, total: 4 },
        next: publishNextAfterChecksV1("review"),
      }),
      "Publish: running the checks, 2 of 4; then the Publish review"
    );
    assert.equal(publishReviewWhereLineV1(), "Publish: the Publish review; then Commit and Push");
    assert.equal(
      whereAreWeLineV1({ scope: "High-Level Code Review", step: "Apply Review, round 3", next: "a review" }),
      "High-Level Code Review: Apply Review, round 3; then a review"
    );
    assert.equal(publishNextAfterChecksV1("commit-and-push"), "Commit and Push");
  });

  void it("leaves out what it does not know", () => {
    assert.equal(whereAreWeLineV1({ scope: "Publish", step: "the Publish review" }), "Publish: the Publish review");
    assert.equal(
      whereAreWeLineV1({ scope: "Publish", step: "running the checks", position: { index: 9, total: 4 } }),
      "Publish: running the checks, 4 of 4"
    );
  });

  void it("Publish Checks' row follows the actual sequence of checks and says what comes next", () => {
    const calls: string[] = [];
    const handle = {
      reportActivity: (activity: string) => {
        calls.push(activity);
        return 1;
      },
    } as unknown as TaskOperationHandle;
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined, 1, "the Publish review");
    const lint = { command: "pnpm run lint" };
    const types = { command: "pnpm run check-types" };
    acc.onCheckEvent.planned(4);
    acc.onCheckEvent.started(lint);
    acc.onCheckEvent.settled(lint);
    acc.onCheckEvent.started(types);
    assert.equal(calls[0], "Publish: running the checks, 1 of 4; then the Publish review · pnpm run lint");
    assert.equal(calls[1], "Publish: 1 of 4 checks done; then the Publish review");
    assert.equal(calls[2], "Publish: running the checks, 2 of 4; then the Publish review · pnpm run check-types");
  });

  void it("a review stage's Apply Review and review rows say the stage, the round and what comes next", () => {
    assert.equal(
      reviewStageWhereLineV1({ stageName: "High-Level Code Review", step: "apply-review", round: 3 }),
      "High-Level Code Review: Apply Review, round 3; then a review"
    );
    assert.equal(
      reviewStageWhereLineV1({ stageName: "High-Level Code Review", step: "review", round: 3 }),
      "High-Level Code Review: review, round 3; then Apply Review if it finds fixes, or the next stage"
    );
    assert.equal(
      reviewStageWhereLineV1({ stageName: "Low-Level Code Review", step: "re-review" }),
      "Low-Level Code Review: running the review again; then Apply Review if it finds fixes, or the next stage"
    );
  });
});
