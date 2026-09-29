/**
 * Regression for the review's completion blocker: existing tests only
 * asserted `improveReviewScore`'s internal `buildRoundsWithoutProgress`
 * counter, not the actual rendered Fast Forward stop notification built from
 * it in `reviewActions.ts`. This asserts the rendering site itself: the
 * message must name the count of stalled build rounds and must never say
 * "the last rounds changed nothing" (item 19's false-stop-message defect),
 * and must always say running Fast Forward again continues.
 *
 * A source-scan test (matching the existing convention in
 * reviewActionsStageActivity.test.ts) rather than a full dispatch drive,
 * because the property under test IS the rendered wording at the actual
 * notification call site.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const source = fs.readFileSync(
  path.join(process.cwd(), "src", "commands", "reviewActions.ts"),
  "utf8"
);

void describe("reviewActions.ts Fast Forward stalled-stop notification wording", () => {
  void it("renders the count of stalled build rounds from outcome.buildRoundsWithoutProgress instead of a blanket claim", () => {
    // RC2 item 13, Step 50: the branch condition grew a second clause
    // (`&& !consumeOpenItemsCardPostedSinceV1(...)`) so the literal
    // single-line `else if (outcome.stalled) {` no longer appears — anchor
    // on the still-stable `outcome.stalled &&` clause opener instead.
    const stalledBranch = source.indexOf("outcome.stalled &&");
    assert.ok(stalledBranch >= 0, "reviewActions.ts must still handle outcome.stalled");
    const branchSlice = source.slice(stalledBranch, stalledBranch + 2000);

    assert.match(
      branchSlice,
      /consecutive build round\(s\) ran without landing a new plan-checklist tick/,
      "the stalled branch must report how many build rounds ran without a new tick"
    );
    assert.match(
      branchSlice,
      /Running Fast Forward again continues from here/,
      "the stalled message must tell the user that running Fast Forward again continues"
    );
    assert.ok(!/the last rounds changed nothing/.test(branchSlice),
      "the stalled message must never claim \\\"the last rounds changed nothing\\\" when build rounds did run");
  });

  void it("derives the rendered stalled-round count from outcome.buildRoundsWithoutProgress, not a hardcoded or unrelated value", () => {
    const stalledBranch = source.indexOf("outcome.stalled &&");
    assert.ok(stalledBranch >= 0, "reviewActions.ts must still handle outcome.stalled");
    const branchSlice = source.slice(stalledBranch, stalledBranch + 2000);

    assert.match(
      branchSlice,
      /const buildRoundsStalled = outcome\.buildRoundsWithoutProgress \?\? 0;/,
      "the stalled branch must derive its local count directly from outcome.buildRoundsWithoutProgress"
    );
    assert.match(
      branchSlice,
      /\$\{buildRoundsStalled\} consecutive build round\(s\) ran without landing a new plan-checklist tick/,
      "the rendered count must interpolate the same buildRoundsStalled variable derived from outcome.buildRoundsWithoutProgress, not a separate or hardcoded figure"
    );
  });
});
