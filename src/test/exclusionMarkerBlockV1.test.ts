/**
 * bugs4 Step 12 (item 30): the completeness gate recognises the
 * `<!-- ensemble:excluded -->` marker anywhere in the item's own block: on the
 * item line, or on an indented line under it before the next top-level item.
 * Ensemble's own plan writer produced the own-line layout, so the gate and the
 * writer used to disagree and owner hand-offs read as unbuilt work.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkExclusionMarkerPlacementV1,
  countChecklistProgressV1,
  countOpenOwnerHandOffsV1,
  describeOpenAndHandOffsV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  formatExclusionMarkerPlacementForReviewerV1,
  isExcludedContinuationLineV1,
  listOpenPlanItemRecordsV1,
} from "../utils/implementationChecklist";

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;
const HEAD = ["<!-- ensemble:implementation-checklist -->", ""];

/** Eight owner hand-offs with the marker on a line of its own, as the writer emitted them. */
function ownLinePlan(): string {
  const lines = [...HEAD, "## Build", "", "- [x] Build the parser", "- [ ] Build the gate", "", "## Owner hand-offs (excluded from implementation rounds)", ""];
  for (let i = 1; i <= 8; i++) {
    lines.push(
      `- [ ] **Hand-off ${i}: deploy step ${i} (HIGH).**`,
      "  - **What:** do the deploy.",
      "  - **How:** run the command.",
      `  ${M}`,
      ""
    );
  }
  return lines.join("\n");
}

function itemLinePlan(): string {
  const lines = [...HEAD, "## Build", "", "- [x] Build the parser", "- [ ] Build the gate", "", "## Owner hand-offs (excluded from implementation rounds)", ""];
  for (let i = 1; i <= 8; i++) {
    lines.push(
      `- [ ] **Hand-off ${i}: deploy step ${i} (HIGH).** ${M}`,
      "  - **What:** do the deploy.",
      "  - **How:** run the command.",
      ""
    );
  }
  return lines.join("\n");
}

void describe("exclusion marker anywhere in the item's block (bugs4 Step 12, item 30)", () => {
  void it("the own-line layout gives 8 excluded and drops the open count by 8", () => {
    const counted = countChecklistProgressV1(ownLinePlan());
    assert.ok(counted);
    assert.equal(counted.total, 10);
    assert.equal(counted.closedWithoutDoing, 8);
    assert.equal(counted.checked, 1);
    assert.equal(counted.remaining, 1, "only 'Build the gate' is genuinely open");
  });

  void it("the item-line layout gives the same result", () => {
    const own = countChecklistProgressV1(ownLinePlan());
    const onLine = countChecklistProgressV1(itemLinePlan());
    assert.deepEqual(onLine, own);
  });

  void it("the open-items list no longer offers the excluded hand-offs", () => {
    const open = listOpenPlanItemRecordsV1(ownLinePlan()).filter((record) => !record.settled);
    assert.deepEqual(open.map((record) => record.itemText), ["Build the gate"]);
  });

  void it("a marker after a sub-bullet block excludes only its own item, not the neighbours", () => {
    const plan = [
      ...HEAD,
      "- [ ] First item",
      "  - detail",
      `  ${M}`,
      "- [ ] Second item",
      "  - detail",
      "",
    ].join("\n");
    const counted = countChecklistProgressV1(plan);
    assert.ok(counted);
    assert.equal(counted.closedWithoutDoing, 1);
    assert.equal(counted.remaining, 1);
  });

  void it("a marker after a blank line still belongs to the item above while indented", () => {
    const plan = [...HEAD, "- [ ] Only item", "  - detail", "", `  ${M}`, ""].join("\n");
    assert.equal(countChecklistProgressV1(plan)?.closedWithoutDoing, 1);
  });

  void it("an unindented marker line is not a continuation and excludes nothing", () => {
    const plan = [...HEAD, "- [ ] Only item", M, ""].join("\n");
    assert.equal(countChecklistProgressV1(plan)?.closedWithoutDoing, 0);
  });

  void it("a heading ends the block, so a later marker does not reach back", () => {
    const plan = [...HEAD, "- [ ] Only item", "## Next", `  ${M}`, ""].join("\n");
    assert.equal(countChecklistProgressV1(plan)?.closedWithoutDoing, 0);
  });

  void it("a mention of the marker is not an exclusion", () => {
    const wrapped = [...HEAD, "- [ ] Document the marker", `  - Add \`${M}\``, ""].join("\n");
    assert.equal(countChecklistProgressV1(wrapped)?.closedWithoutDoing, 0);
    const prose = [...HEAD, "- [ ] Document the marker", `  - the literal${M}`, ""].join("\n");
    assert.equal(countChecklistProgressV1(prose)?.closedWithoutDoing, 0);
    const fenced = [...HEAD, "- [ ] Document the marker", "  ```", `  ${M}`, "  ```", ""].join("\n");
    assert.equal(countChecklistProgressV1(fenced)?.closedWithoutDoing, 0);
  });

  void it("continuation-line rule: lone marker, bullet marker, text then marker", () => {
    assert.equal(isExcludedContinuationLineV1(`  ${M}`), true);
    assert.equal(isExcludedContinuationLineV1(`  - ${M}`), true);
    assert.equal(isExcludedContinuationLineV1(`  \`${M}\``), true);
    assert.equal(isExcludedContinuationLineV1(`  - Priority: LOW ${M}`), true);
    assert.equal(isExcludedContinuationLineV1(`  - Priority: LOW \`${M}\``), false);
    assert.equal(isExcludedContinuationLineV1("  - nothing here"), false);
  });

  void it("plan-format check: flags own-line markers (counted) and orphan markers (excluding nothing)", () => {
    assert.deepEqual(checkExclusionMarkerPlacementV1(itemLinePlan()), [], "the canonical layout has nothing to flag");
    const own = checkExclusionMarkerPlacementV1(ownLinePlan());
    assert.equal(own.length, 8);
    assert.ok(own.every((finding) => finding.kind === "own-line"));
    const orphan = [...HEAD, "- [ ] An item", "", "## Section", M, ""].join("\n");
    const found = checkExclusionMarkerPlacementV1(orphan);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.kind, "orphan");
    assert.equal(found[0]?.line, 6);
    const text = formatExclusionMarkerPlacementForReviewerV1(orphan);
    assert.match(text, /1 stray exclusion marker\(s\) belong to no checklist item and exclude nothing \(plan-final\.md line 6\)/);
    assert.equal(formatExclusionMarkerPlacementForReviewerV1(itemLinePlan()), "");
    // A mention of the marker in a fenced example is not a finding.
    const fenced = [...HEAD, "- [ ] An item", "", "```", M, "```", ""].join("\n");
    assert.deepEqual(checkExclusionMarkerPlacementV1(fenced), []);
  });

  void it("reports 'N open, of which M are owner hand-offs' from the plan", () => {
    assert.equal(describeOpenAndHandOffsV1(ownLinePlan()), "9 open, of which 8 are owner hand-offs");
    assert.equal(describeOpenAndHandOffsV1(itemLinePlan()), "9 open, of which 8 are owner hand-offs");
    const done = ownLinePlan().replace("- [ ] Build the gate", "- [x] Build the gate");
    assert.equal(describeOpenAndHandOffsV1(done), "8 open, of which 8 are owner hand-offs");
    assert.equal(describeOpenAndHandOffsV1("no checklist here"), undefined);
  });

  void it("counts owner hand-offs apart from unbuilt work, so the Tasks pane and cards show them separately (item 49)", () => {
    assert.equal(countOpenOwnerHandOffsV1(ownLinePlan()), 8);
    assert.equal(countOpenOwnerHandOffsV1(itemLinePlan()), 8);
    const ticked = ownLinePlan().replace("- [ ] **Hand-off 1:", "- [x] **Hand-off 1:");
    assert.equal(countOpenOwnerHandOffsV1(ticked), 7, "a ticked hand-off is done, not waiting");
    assert.equal(countOpenOwnerHandOffsV1("no checklist here"), 0);
  });

  void it("a nested child's own block marker excludes the child, not the parent", () => {
    const plan = [
      ...HEAD,
      "- [ ] Parent",
      "  - [ ] Child",
      `    ${M}`,
      "",
    ].join("\n");
    const counted = countChecklistProgressV1(plan);
    assert.ok(counted);
    assert.equal(counted.closedWithoutDoing, 0, "the parent is not excluded by its child's marker");
    assert.equal(counted.remaining, 1);
  });
});
