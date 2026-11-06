/**
 * review1 Step 56 (and Step 60's stage action label and counts): the action on a review stage with a current review is
 * "Continue the work (N of M plan items left)", from the one shared counter.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import {
  describeContinueTheWorkLabelV1,
  describeContinueTheWorkMenuEntryV1,
  describePlanItemsLeftV1,
  planItemsLeftFromCountsV1,
} from "../utils/continueTheWorkLabelV1";

void describe("review1 Step 56: continue the work, named for the plan items left", () => {
  void it("takes N and M from the shared counts: unsettled items over the fixed total", () => {
    assert.deepEqual(planItemsLeftFromCountsV1({ total: 48, settled: 45 }), { left: 3, total: 48 });
    assert.deepEqual(planItemsLeftFromCountsV1({ total: 48, settled: 48 }), { left: 0, total: 48 });
    assert.deepEqual(planItemsLeftFromCountsV1({ total: 4, settled: 9 }), { left: 0, total: 4 });
  });

  void it("the action reads Continue the work with the count, and says nothing about going back a stage", () => {
    const label = describeContinueTheWorkLabelV1({ left: 3, total: 48 });
    assert.equal(label, "Continue the work (3 of 48 plan items left)");
    assert.doesNotMatch(label, /back|previous|return/i);
    assert.equal(describePlanItemsLeftV1({ left: 0, total: 48 }), "0 of 48 plan items left");
  });

  void it("a task with no plan items keeps the plain name", () => {
    assert.equal(describeContinueTheWorkLabelV1(undefined), "Continue the work");
    assert.equal(describeContinueTheWorkLabelV1({ left: 0, total: 0 }), "Continue the work");
  });
});

void describe("review1 Step 56/60: the selectable stage action carries the live figure", () => {
  void it("the Ensemble Actions menu entry is the Continue the work label with the count, and never a stage change", () => {
    const entry = describeContinueTheWorkMenuEntryV1({ left: 3, total: 48 });
    assert.equal(entry.label, "$(play) Continue the work (3 of 48 plan items left)");
    assert.doesNotMatch(entry.label + entry.detail, /go(ing)? back|previous stage|return to/i);
    assert.equal(describeContinueTheWorkMenuEntryV1(undefined).label, "$(play) Continue the work");
  });

  void it("the status bar menu offers it on a review stage with a review on record, via the stage action and the shared counter", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "views", "taskStatusBar.ts"),
      "utf8"
    );
    const menu = source.slice(source.indexOf("async showMenu()"));
    assert.match(menu, /isReviewStage\(stage\)/);
    assert.match(menu, /describeReviewStageScoreV1\(/, "only when a review is on record");
    assert.match(menu, /readPlanItemCountsV1\(taskToShow\.folderUri/, "N and M from the shared counter");
    assert.match(menu, /command: "vs-code-ai-helper\.applyCurrentStageAction"/);
    assert.match(menu, /taskFolderPath: taskToShow\.folderUri\.fsPath/);
  });
});
