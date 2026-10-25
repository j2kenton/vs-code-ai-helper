import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findUnbuiltStepsWithoutCompletionBlockerV1 } from "../utils/reviewUnbuiltStepsV1";

const EMPTY_BLOCKS = "<!-- blockers:start -->\n<!-- blockers:end -->";

void describe("review that names unbuilt plan steps without a completion blocker (item 10)", () => {
  void it("flags the observed contradiction: 9/10, 'Next, finish Step 6', no blockers", () => {
    const review = [
      "## Readiness: 9/10",
      "",
      "**Verdict:** On track — 41 of 94 checklist items are settled. The landed steps are correct. Next, finish Step 6's caller handling, state-before-read audit and tests.",
      "",
      EMPTY_BLOCKS,
    ].join("\n");
    const found = findUnbuiltStepsWithoutCompletionBlockerV1(review);
    assert.ok(found, "the contradiction must be found");
    assert.match(found.sentence, /Next, finish Step 6/);
  });

  void it("flags 'steps remain to be built' under a Next steps heading", () => {
    const review = ["## Next steps", "", "Plan steps 12–18 remain to be built.", "", EMPTY_BLOCKS].join("\n");
    assert.ok(findUnbuiltStepsWithoutCompletionBlockerV1(review));
  });

  void it("is consistent when a [completion] blocker backs the verdict up", () => {
    const review = [
      "**Verdict:** Next, finish Step 6's caller handling.",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] Plan steps 6 and 7 are not built",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.equal(findUnbuiltStepsWithoutCompletionBlockerV1(review), undefined);
  });

  void it("does not flag built-but-unticked items", () => {
    const review = [
      "**Verdict:** Steps 3 and 4 are built but not ticked; they are listed under Verified Complete. Step 5 is already implemented.",
      "",
      EMPTY_BLOCKS,
    ].join("\n");
    assert.equal(findUnbuiltStepsWithoutCompletionBlockerV1(review), undefined);
  });

  void it("does not flag a clean verdict that names no open steps", () => {
    const review = ["**Verdict:** Ready. All 94 checklist items are settled.", "", EMPTY_BLOCKS].join("\n");
    assert.equal(findUnbuiltStepsWithoutCompletionBlockerV1(review), undefined);
  });

  void it("ignores text inside the machine-readable blocks", () => {
    const review = [
      "**Verdict:** Ready.",
      "",
      "<!-- verified-complete:start -->",
      "- Step 6: finish the remaining items",
      "<!-- verified-complete:end -->",
      EMPTY_BLOCKS,
    ].join("\n");
    assert.equal(findUnbuiltStepsWithoutCompletionBlockerV1(review), undefined);
  });
});
