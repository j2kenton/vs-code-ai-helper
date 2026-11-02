/**
 * bugs5 Step 22 (item 10): a plateau card whose grouped blocker names five or more unbuilt plan items recommends
 * Implementation, and the card shows how far the run has got.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import {
  describeReviewRunSummaryV1,
  summarizeReviewRunV1,
} from "../utils/reviewRunSummaryV1";
import { buildBugs4HighLevelReviewHistoryV1 } from "./fixtures/bugs4HighLevelReviewHistoryV1";

const BLOCKER = "[completion] Plan items not built: Steps 27, 47-51, 54, 55, 58-60, 63 and 67";
const target = { canonicalId: "c", taskFolderPath: "/t" };

const base = {
  blockersCount: 1,
  primaryBlockerDescription: BLOCKER,
  allBlockerDescriptions: [BLOCKER],
  narrowedNote: "",
  progressNote: "",
  taskFixableCount: 1,
  hasSpecDefect: false,
  hasDeclinedBlocker: false,
  hasNonFixableBlocker: false,
  nextStageHasRun: false,
  clearingNote: "",
  dispatchModeEvidence: [],
  planItemsOpen: 13,
  taskFixableIncludesUnbuiltWork: true,
};

void describe("bugs5 Step 22: many unbuilt items", () => {
  void it("recommends Build the N open plan items when the blocker names 5 or more", () => {
    const decision = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, {
      ...base,
      unbuiltItemsNamedCount: 13,
    });
    assert.equal(decision.recommendation?.kind, "option");
    assert.equal(decision.recommendation?.kind === "option" ? decision.recommendation.optionId : "", "buildRemaining");
    assert.match(decision.options.find((o) => o.optionId === "buildRemaining")?.label ?? "", /Build the 13 open plan items/);
  });

  void it("keeps recommending Keep iterating when the blocker names fewer than 5 items", () => {
    const decision = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, {
      ...base,
      unbuiltItemsNamedCount: 2,
    });
    assert.equal(decision.recommendation?.kind === "option" ? decision.recommendation.optionId : "", "keepIterating");
  });

  void it("shows how far the run has got on the card", () => {
    const decision = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, {
      ...base,
      runProgressNote: "40 rounds run; scores 5/10 to 7/10.",
    });
    const line = decision.evidence?.find((e) => e.label === "How far this run has got");
    assert.equal(line?.detail, "40 rounds run; scores 5/10 to 7/10.");
  });

  void it("summarizes rounds, score range and settled items from the history", () => {
    const history = buildBugs4HighLevelReviewHistoryV1().map((entry, index) => ({
      ...entry,
      settledItemCount: 60 + Math.floor(index / 10),
    }));
    const summary = summarizeReviewRunV1(history, "impl-high-review");
    assert.deepEqual(summary, { rounds: 40, scoreMin: 5, scoreMax: 7, settledStart: 60, settledNow: 63 });
    assert.equal(
      describeReviewRunSummaryV1(summary),
      "40 rounds run; scores 5/10 to 7/10; settled plan items 60 at the start of the run, 63 now."
    );
    assert.equal(summarizeReviewRunV1(history, "publish"), undefined);
  });
});
