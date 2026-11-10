/**
 * review2 Step 44 (Part 10; bugs6 register item 3): when every open plan item only waits on test evidence, a
 * zero-change round had nothing to build, so a clean review next to it must not mark the checklist unreliable.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTestDependentChecklistItemV1, openItemsAllWaitOnTestEvidenceV1 } from "../utils/implementationChecklist";

const WRITE_TESTS = "Write the tests for Part 2: the scope guard, the acceptance record and the refusal text.";
const BUILD = "Build the batch planner that splits the scope by read budget.";

void describe("open items that only wait on test evidence (review2 Step 44)", () => {
  void it("the fixture's test item is test-dependent and the build item is not", () => {
    assert.equal(isTestDependentChecklistItemV1(WRITE_TESTS), true);
    assert.equal(isTestDependentChecklistItemV1(BUILD), false);
  });

  void it("is true when every open item is a test item (the 2026-11-06 bugs1 shape)", () => {
    const plan = [`- [x] ${BUILD}`, `- [ ] ${WRITE_TESTS}`, `- [ ] Write the tests for Part 3: coverage.`].join("\n");
    assert.equal(openItemsAllWaitOnTestEvidenceV1(plan), true);
  });

  void it("is false when any open item is buildable work", () => {
    const plan = [`- [ ] ${BUILD}`, `- [ ] ${WRITE_TESTS}`].join("\n");
    assert.equal(openItemsAllWaitOnTestEvidenceV1(plan), false);
  });

  void it("is false when nothing is open", () => {
    assert.equal(openItemsAllWaitOnTestEvidenceV1([`- [x] ${BUILD}`, `- [x] ${WRITE_TESTS}`].join("\n")), false);
  });

  void it("owner hand-offs (excluded, unticked) are not open work and do not make the answer true or false", () => {
    const handOffOnly = [`- [x] ${BUILD}`, "- [ ] Owner step: confirm Publish Checks ran <!-- ensemble:excluded -->"].join("\n");
    assert.equal(openItemsAllWaitOnTestEvidenceV1(handOffOnly), false);
    const withTests = [`- [ ] ${WRITE_TESTS}`, "- [ ] Owner step: confirm Publish Checks ran <!-- ensemble:excluded -->"].join("\n");
    assert.equal(openItemsAllWaitOnTestEvidenceV1(withTests), true);
  });

  void it("a nested open sub-item does not count as a top-level open item", () => {
    const plan = [`- [ ] ${WRITE_TESTS}`, `  - [ ] ${BUILD}`].join("\n");
    assert.equal(openItemsAllWaitOnTestEvidenceV1(plan), true);
  });
});
