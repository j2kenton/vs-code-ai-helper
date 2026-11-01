/**
 * bugs4 item 21/27 (Step 17): a populated Verified Complete block (33 entries, each with an
 * `evidence:` line, as the 2026-10-31 Low-Level Code Review wrote it) must reach the plan's
 * ticked items. The pipeline is parse -> filter to ticked plan items -> gate; this pins the
 * first two stages, including a reviewer who copies the checklist box into the entry.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { filterAlreadyCheckedPlanItemsV1, isTestDependentChecklistItemV1 } from "../utils/implementationChecklist";

const ITEM_COUNT = 33;
const itemText = (index: number): string => `Wire the retention path for stage ${index} in \`apps/server/src/stage${index}.ts\``;

function planWithTickedItems(): string {
  const lines = ["<!-- ensemble:implementation-checklist -->", ""];
  for (let index = 1; index <= ITEM_COUNT; index += 1) {
    lines.push(`- [x] ${itemText(index)}`);
  }
  return lines.join("\n");
}

function reviewBlock(entry: (index: number) => string): string {
  const lines = ["Readiness: 9/10", "", "<!-- verified-complete:start -->"];
  for (let index = 1; index <= ITEM_COUNT; index += 1) {
    lines.push(entry(index), `  evidence: opened apps/server/src/stage${index}.ts lines 1-40; server command 7 files, 131 passed`);
  }
  lines.push("<!-- verified-complete:end -->");
  return lines.join("\n");
}

void describe("a populated Verified Complete block reaches the ticked plan items", () => {
  void it("33 entries with evidence lines all match the ticked items, and each keeps its evidence", () => {
    const verified = parseReviewVerifiedCompleteV1(reviewBlock((index) => `- ${itemText(index)}`));
    assert.equal(verified.items.length, ITEM_COUNT);
    assert.ok(verified.entries.every((entry) => entry.evidence?.includes("131 passed")));
    assert.equal(filterAlreadyCheckedPlanItemsV1(planWithTickedItems(), verified.items).length, ITEM_COUNT);
  });

  void it("an entry that copies the checklist box still matches its item", () => {
    const verified = parseReviewVerifiedCompleteV1(reviewBlock((index) => `- [x] ${itemText(index)}`));
    assert.equal(verified.items[0], itemText(1));
    assert.equal(filterAlreadyCheckedPlanItemsV1(planWithTickedItems(), verified.items).length, ITEM_COUNT);
  });

  void it("these items are not test-dependent merely because their evidence names a test command", () => {
    assert.equal(isTestDependentChecklistItemV1(itemText(1)), false);
  });

  void it("control: an item the plan does not tick is not matched", () => {
    const verified = parseReviewVerifiedCompleteV1(reviewBlock((index) => `- ${itemText(index)}`));
    const plan = planWithTickedItems().replace("- [x] " + itemText(1), "- [ ] " + itemText(1));
    assert.equal(filterAlreadyCheckedPlanItemsV1(plan, verified.items).length, ITEM_COUNT - 1);
  });
});
