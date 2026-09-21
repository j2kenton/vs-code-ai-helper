/**
 * v1 fixes 2, items 14 + 25 (Part 4, step 10): the same step identity produces
 * the same words on the stage row, the tracked-operation label (which every
 * notification is built from) and the chat outcome line.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApplyReviewRowV1 } from "../actions/rows/applyReviewRowV1";
import { createReviewRowV1 } from "../actions/rows/reviewRowV1";
import { formatRoundOutcomeMessageV1 } from "../utils/roundLedgerV1";
import { stepNameV1, stepOutcomeNameV1, stepProgressLabelV1 } from "../utils/stepLabelsV1";
import type { RoundLedgerEntryV1 } from "../types/taskProgress";

function entry(mode: RoundLedgerEntryV1["mode"], stage: RoundLedgerEntryV1["stage"]): RoundLedgerEntryV1 {
  return {
    roundId: "r1",
    stage,
    mode,
    state: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
  } as RoundLedgerEntryV1;
}

void describe("stepLabelsV1", () => {
  void it("the review and apply-review rows take their in-flight wording from the shared table", () => {
    assert.equal(createReviewRowV1().progressLabel, stepProgressLabelV1("review"));
    assert.equal(createApplyReviewRowV1().progressLabel, stepProgressLabelV1("apply-review"));
  });

  void it("the chat outcome line names the same step the notification's operation label names", () => {
    const applyLine = formatRoundOutcomeMessageV1(entry("apply-review", "impl-high-review"));
    assert.ok(applyLine.startsWith(`_Ended: ${stepNameV1("apply-review")} (`), applyLine);
    const reviewLine = formatRoundOutcomeMessageV1(entry("review", "impl-low-review"));
    assert.ok(reviewLine.startsWith(`_Ended: ${stepNameV1("review")} (`), reviewLine);
  });

  void it("a stage's default action keeps the bare stage name — never 'Implementation (Implementation)'", () => {
    assert.equal(stepOutcomeNameV1("implementation", "Implementation"), "Implementation");
    assert.ok(formatRoundOutcomeMessageV1(entry("implementation", "impl")).startsWith("_Ended: Implementation — completed"));
  });

  void it("distinguishes Apply Review from Review — the two never share a name or a progress label", () => {
    assert.notEqual(stepNameV1("review"), stepNameV1("apply-review"));
    assert.notEqual(stepProgressLabelV1("review"), stepProgressLabelV1("apply-review"));
  });
});
