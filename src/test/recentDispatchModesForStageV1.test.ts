import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  recentDispatchModesForStageV1,
  recentDispatchModesIncludeAmbiguousOriginV1,
} from "../utils/reviewEscalation";
import { RoundOutcomeEntryV1 } from "../types/taskProgress";

// ---------------------------------------------------------------------------
// recentDispatchModesForStageV1 (Part 3 step 11 — review blocker, 2026-08-26)
//
// Zero-change/gate implementation rounds are deliberately bookkept under the
// literal stage "impl" (see reviewActions.ts's `gateStage`/
// `implBookkeepingStage`) regardless of which impl-review stage the task is
// displaying. A plain `entry.stage === stage` filter made those rounds
// invisible to an impl-high-review/impl-low-review plateau card's "recent
// dispatch modes" evidence — exactly the rounds most likely to reveal a
// dispatch plateau (the loop repeatedly choosing Implementation against a
// blocker only Apply Review can fix).
// ---------------------------------------------------------------------------

function entry(
  stage: RoundOutcomeEntryV1["stage"],
  dispatchMode: RoundOutcomeEntryV1["dispatchMode"],
  at: string,
  originatingReviewStage?: RoundOutcomeEntryV1["originatingReviewStage"]
): RoundOutcomeEntryV1 {
  return { stage, classification: "genuine-no-op", at, dispatchMode, originatingReviewStage };
}

void test("merges 'impl'-bookkept rounds into impl-high-review's evidence, in chronological order", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl-high-review", "apply-review", "2026-08-20T01:00:00.000Z"),
    entry("impl", "implementation", "2026-08-20T02:00:00.000Z"),
    entry("impl-high-review", "apply-review", "2026-08-20T03:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-high-review");
  assert.deepEqual(modes, ["implementation", "apply-review", "implementation", "apply-review"]);
});

void test("merges 'impl'-bookkept rounds into impl-low-review's evidence too", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl-low-review", "implementation", "2026-08-20T01:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-low-review");
  assert.deepEqual(modes, ["implementation", "implementation"]);
});

void test("does not merge 'impl' rows for a non-impl-review stage", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("plan-high-review", "implementation", "2026-08-20T01:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "plan-high-review");
  assert.deepEqual(modes, ["implementation"]);
});

void test("still honours the limit across the merged set", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl-high-review", "implementation", "2026-08-20T01:00:00.000Z"),
    entry("impl", "apply-review", "2026-08-20T02:00:00.000Z"),
    entry("impl-high-review", "apply-review", "2026-08-20T03:00:00.000Z"),
    entry("impl", "apply-review", "2026-08-20T04:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-high-review", 2);
  assert.deepEqual(modes, ["apply-review", "apply-review"]);
});

void test("this is the dispatch-plateau shape: a frozen taskFixableCount whose recent modes are all 'implementation' is now visible even though every round was bookkept under 'impl'", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl", "implementation", "2026-08-20T01:00:00.000Z"),
    entry("impl", "implementation", "2026-08-20T02:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-high-review");
  assert.deepEqual(modes, ["implementation", "implementation", "implementation"]);
});

// ---------------------------------------------------------------------------
// Review fix, 2026-08-27 (narrowed blocker 2): an 'impl'-bookkept round now
// carries `originatingReviewStage` naming which impl-review stage was
// actually active, so a plateau card for one stage cannot absorb a round
// that ran while the task displayed the OTHER impl-review stage.
// ---------------------------------------------------------------------------

void test("excludes an 'impl'-bookkept round from impl-low-review's evidence when it actually ran during impl-high-review", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z", "impl-high-review"),
    entry("impl-low-review", "implementation", "2026-08-20T01:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-low-review");
  assert.deepEqual(modes, ["implementation"]);
});

void test("excludes an 'impl'-bookkept round from impl-high-review's evidence when it actually ran during impl-low-review", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z", "impl-low-review"),
    entry("impl-high-review", "apply-review", "2026-08-20T01:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-high-review");
  assert.deepEqual(modes, ["apply-review"]);
});

void test("still includes an 'impl'-bookkept round whose originatingReviewStage matches the requested stage", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z", "impl-high-review"),
    entry("impl-high-review", "apply-review", "2026-08-20T01:00:00.000Z"),
  ];
  const modes = recentDispatchModesForStageV1(outcomes, "impl-high-review");
  assert.deepEqual(modes, ["implementation", "apply-review"]);
});

void test("a stage-crossing task's history correctly splits evidence between the two impl-review stages", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl-high-review", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl", "implementation", "2026-08-20T01:00:00.000Z", "impl-high-review"),
    entry("impl-low-review", "apply-review", "2026-08-20T02:00:00.000Z"),
    entry("impl", "apply-review", "2026-08-20T03:00:00.000Z", "impl-low-review"),
  ];
  assert.deepEqual(
    recentDispatchModesForStageV1(outcomes, "impl-high-review"),
    ["implementation", "implementation"]
  );
  assert.deepEqual(
    recentDispatchModesForStageV1(outcomes, "impl-low-review"),
    ["apply-review", "apply-review"]
  );
});

// ---------------------------------------------------------------------------
// recentDispatchModesIncludeAmbiguousOriginV1 (review fix, 2026-08-27,
// narrowed blocker 2, second half): a legacy 'impl' row with no
// `originatingReviewStage` is still merged into BOTH impl-review stages'
// evidence (the first two tests above prove that policy is kept), but a
// reader of the evidence must be told when that is happening rather than
// seeing an unqualified, possibly mixed-origin count.
// ---------------------------------------------------------------------------

void test("reports no ambiguity when every merged round names its originating stage", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z", "impl-high-review"),
    entry("impl-high-review", "apply-review", "2026-08-20T01:00:00.000Z"),
  ];
  assert.equal(recentDispatchModesIncludeAmbiguousOriginV1(outcomes, "impl-high-review"), false);
});

void test("reports ambiguity when a merged 'impl' round predates originatingReviewStage", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl-high-review", "apply-review", "2026-08-20T01:00:00.000Z"),
  ];
  assert.equal(recentDispatchModesIncludeAmbiguousOriginV1(outcomes, "impl-high-review"), true);
  assert.equal(recentDispatchModesIncludeAmbiguousOriginV1(outcomes, "impl-low-review"), true);
});

void test("reports no ambiguity for a non-impl-review stage even with an unrelated ambiguous 'impl' row present", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("plan-high-review", "implementation", "2026-08-20T01:00:00.000Z"),
  ];
  assert.equal(recentDispatchModesIncludeAmbiguousOriginV1(outcomes, "plan-high-review"), false);
});

void test("respects the limit: an ambiguous round outside the window does not report ambiguity", () => {
  const outcomes: RoundOutcomeEntryV1[] = [
    entry("impl", "implementation", "2026-08-20T00:00:00.000Z"),
    entry("impl-high-review", "apply-review", "2026-08-20T01:00:00.000Z"),
    entry("impl-high-review", "apply-review", "2026-08-20T02:00:00.000Z"),
  ];
  assert.equal(recentDispatchModesIncludeAmbiguousOriginV1(outcomes, "impl-high-review", 2), false);
});
