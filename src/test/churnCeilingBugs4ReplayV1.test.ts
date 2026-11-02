/**
 * bugs5 Step 21 (item 10): replaying bugs4's 40 High-Level Code Review rounds through the churn ceiling.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { roundsWithoutTaskFixableDecrease, shouldEscalateChurnCeiling } from "../utils/reviewRouting";
import {
  BUGS4_LAST_BEST_SCORE_RISE_INDEX_V1,
  buildBugs4HighLevelReviewHistoryV1,
} from "./fixtures/bugs4HighLevelReviewHistoryV1";

void describe("bugs5 Step 21: the churn ceiling counts only real progress", () => {
  const history = buildBugs4HighLevelReviewHistoryV1();

  void it("the fixture is bugs4's 40 real rounds: scores 5-7 and task-fixable counts swinging 1-3", () => {
    assert.equal(history.length, 40);
    assert.equal(Math.min(...history.map((e) => e.score ?? 99)), 5);
    assert.equal(Math.max(...history.map((e) => e.score ?? 0)), 7);
    assert.deepEqual(
      history.slice(0, 11).map((e) => e.taskFixableCount),
      [2, 2, 1, 1, 1, 1, 2, 1, 2, 1, 3]
    );
  });

  void it("tagging the grouped blocker [narrowed:…] every round does not change the count", () => {
    const narrowed = buildBugs4HighLevelReviewHistoryV1({ narrowedGroupedBlocker: true });
    assert.ok(narrowed.every((e) => e.blockers?.length === 1));
    for (let n = 1; n <= history.length; n++) {
      assert.equal(
        roundsWithoutTaskFixableDecrease(narrowed.slice(0, n), "impl-high-review"),
        roundsWithoutTaskFixableDecrease(history.slice(0, n), "impl-high-review"),
        `prefix of ${n} rounds`
      );
    }
  });

  void it("with churnCeilingRounds 5, the ceiling fires by the 6th round after the last rise in best score", () => {
    const firesAt = (n: number): boolean =>
      shouldEscalateChurnCeiling({
        history: history.slice(0, n),
        stage: "impl-high-review",
        taskFixableCount: history[n - 1]!.taskFixableCount,
        churnCeilingRounds: 5,
      });
    const rise = BUGS4_LAST_BEST_SCORE_RISE_INDEX_V1;
    // The round that first reached 7/10 is history[rise]; each later round gained nothing.
    assert.equal(firesAt(rise + 1 + 4), false);
    assert.equal(firesAt(rise + 1 + 5), true);
    assert.ok(firesAt(rise + 6));
    // Every longer prefix keeps firing: the swinging 1-2 count never resets it.
    for (let n = rise + 6; n <= history.length; n++) {
      assert.equal(firesAt(n), true, `prefix of ${n} rounds`);
    }
  });

  void it("a settled-items rise after the plateau restarts the count", () => {
    const withRise = history.map((entry, index) => ({
      ...entry,
      settledItemCount: index >= 20 ? 70 : 63,
    }));
    // The step to 70 at index 20 gains; rounds before it already had a flat 63.
    assert.equal(roundsWithoutTaskFixableDecrease(withRise.slice(0, 21), "impl-high-review"), 0);
    assert.equal(roundsWithoutTaskFixableDecrease(withRise.slice(0, 26), "impl-high-review"), 5);
  });
});
