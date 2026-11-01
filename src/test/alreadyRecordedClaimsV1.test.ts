/**
 * bugs4 Step 14 (item 14): a claim restating an item the plan already records as
 * ticked or excluded is "already recorded". It is never an unmatched claim and so
 * can never set the unreliable-checklist latch. A claim matching nothing still does.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  areAllUnmatchedChecklistClaimsAlreadySettledV1,
  isChecklistClaimTextAlreadyRecordedV1,
  mergeChecklistProgressV1,
} from "../utils/implementationChecklist";
import { buildChecklistMergeDiagnosticsNoteV1 } from "../commands/reviewActions";

// Fixture text is the two claims quoted in bugs4 item 14 (round aed5015b…), restated
// in prose while both items were already `- [x]` in bugs3's plan.
const TICKED_A =
  "Key a single terminal chat emitter by operation ID and derive its Ended record from `TaskActionOutcomeV1`.";
const TICKED_B = "Bridge duplicate command and notification endings into the single terminal emitter.";
const OPEN = "Add a regression test for the terminal emitter.";
const EXCLUDED = "Owner replays the incident on the cloud box. <!-- ensemble:excluded -->";

const PLAN = [
  "# Implementation checklist",
  "",
  `- [x] ${TICKED_A}`,
  `- [x] ${TICKED_B}`,
  `- [ ] ${OPEN}`,
  `- [ ] ${EXCLUDED}`,
  "",
].join("\n");

function summaryWithClaims(...claims: string[]): string {
  return [
    "Restated finished work.",
    "",
    "<!-- ensemble:no-checklist-change -->",
    "",
    "## Files Changed",
    "",
    "- none",
    "",
    "## Plan Item Checklist",
    "",
    ...claims.map((claim) => `- ${claim} — done`),
    "",
  ].join("\n");
}

void describe("exact-text claims are already recorded (bugs4 item 14)", () => {
  void it("the two restated claims from round aed5015b are already recorded, not unmatched", () => {
    const result = mergeChecklistProgressV1(PLAN, summaryWithClaims(TICKED_A, TICKED_B));
    assert.notEqual(result.kind, "no-match");
    assert.deepEqual("alreadyRecorded" in result ? result.alreadyRecorded : undefined, [TICKED_A, TICKED_B]);
  });

  void it("an excluded item restated is already recorded too", () => {
    const result = mergeChecklistProgressV1(PLAN, summaryWithClaims(EXCLUDED.replace(" <!-- ensemble:excluded -->", "")));
    assert.notEqual(result.kind, "no-match");
  });

  void it("a claim matching nothing in the plan still reports no-match", () => {
    const result = mergeChecklistProgressV1(PLAN, summaryWithClaims(TICKED_A, "Rewrite the whole provider layer."));
    assert.equal(result.kind, "no-match");
    if (result.kind === "no-match") {
      assert.deepEqual(result.unmatchedAll, ["Rewrite the whole provider layer."]);
      assert.deepEqual(result.alreadyRecorded, [TICKED_A]);
    }
  });

  void it("a claim for a still-open item without evidence is not already recorded", () => {
    assert.equal(isChecklistClaimTextAlreadyRecordedV1(PLAN, OPEN), false);
    const result = mergeChecklistProgressV1(PLAN, summaryWithClaims(OPEN));
    assert.equal(result.kind, "no-match");
  });

  void it("settled-claims helper accepts exact-text claims for ticked or excluded items only", () => {
    assert.equal(areAllUnmatchedChecklistClaimsAlreadySettledV1(PLAN, [TICKED_A, TICKED_B]), true);
    assert.equal(areAllUnmatchedChecklistClaimsAlreadySettledV1(PLAN, [TICKED_A, OPEN]), false);
    assert.equal(areAllUnmatchedChecklistClaimsAlreadySettledV1(PLAN, [TICKED_A, "Not in the plan at all."]), false);
  });

  void it("two items with the same text, one open, are not already recorded", () => {
    const plan = `- [x] Same text.\n- [ ] Same text.\n`;
    assert.equal(isChecklistClaimTextAlreadyRecordedV1(plan, "Same text."), false);
  });

  void it("merge diagnostics report already-recorded claims as their own category", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      alreadyRecorded: [TICKED_A, TICKED_B],
      latchSet: false,
    });
    assert.match(note, /Already recorded/);
    assert.match(note, /Bridge duplicate command/);
    assert.doesNotMatch(note, /Unmatched claim text/);
    assert.match(note, /not set/);
  });
});
