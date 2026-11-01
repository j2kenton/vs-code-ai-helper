/**
 * bugs4 Step 13 (item 42): Publish lists unticked top-level and nested plan items as
 * blockers, and leaves excluded owner hand-offs out.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXCLUDED_CHECKLIST_ITEM_MARKER_V1, listUnsettledPlanItemsV1 } from "../utils/implementationChecklist";
import {
  buildPublishOpenPlanItemsSectionV1,
  describePublishOpenPlanItemsSentenceV1,
  PUBLISH_OPEN_PLAN_ITEMS_END_V1,
  PUBLISH_OPEN_PLAN_ITEMS_START_V1,
  upsertPublishOpenPlanItemsSectionV1,
} from "../utils/publishOpenPlanItemsV1";

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Build",
  "",
  "- [x] Build the parser",
  "  - [ ] Add the pgvector pin",
  "  - [x] Add its tests",
  "- [ ] Build the gate",
  "- [ ] **Hand-off 1: deploy (HIGH).**",
  "  - **What:** deploy it.",
  `  ${M}`,
  "",
].join("\n");

void describe("listUnsettledPlanItemsV1 (bugs4 item 42)", () => {
  void it("lists unticked top-level and nested items, and leaves out ticked and excluded ones", () => {
    const items = listUnsettledPlanItemsV1(PLAN);
    assert.deepEqual(
      items.map((item) => [item.text, item.nested]),
      [
        ["Add the pgvector pin", true],
        ["Build the gate", false],
      ]
    );
  });

  void it("an unticked child under a ticked parent is listed", () => {
    assert.equal(listUnsettledPlanItemsV1(PLAN).some((item) => item.nested), true);
  });

  void it("a fully settled plan lists nothing", () => {
    assert.deepEqual(listUnsettledPlanItemsV1("- [x] one\n- [x] two\n"), []);
  });
});

void describe("Publish open plan items section (bugs4 item 42)", () => {
  const items = listUnsettledPlanItemsV1(PLAN);

  void it("names every open item and marks sub-items, as a blocker", () => {
    const section = buildPublishOpenPlanItemsSectionV1(items);
    assert.ok(section);
    assert.ok(section.includes("Plan items still open (blocking)"));
    assert.ok(section.includes("- (sub-item) Add the pgvector pin"));
    assert.ok(section.includes("- Build the gate"));
    assert.ok(!section.includes("Hand-off 1"));
  });

  void it("is absent when nothing is open", () => {
    assert.equal(buildPublishOpenPlanItemsSectionV1([]), undefined);
    assert.equal(describePublishOpenPlanItemsSentenceV1([]), "");
  });

  void it("the sentence counts the items and the sub-items", () => {
    const sentence = describePublishOpenPlanItemsSentenceV1(items);
    assert.ok(sentence.startsWith("2 plan item(s) are still unticked (1 of them sub-items)"));
  });

  void it("caps a long list and counts the rest, never cutting an item mid-word", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ text: `Item number ${i}`, nested: false }));
    const section = buildPublishOpenPlanItemsSectionV1(many) ?? "";
    assert.ok(section.includes("…and 5 more."));
    const long = buildPublishOpenPlanItemsSectionV1([{ text: "word ".repeat(100), nested: false }]) ?? "";
    assert.ok(long.includes("word…"));
  });

  void it("upsert appends once, replaces on a rerun, and removes the section when nothing is open", () => {
    const report = "# Publish review\n\nChecks passed.\n";
    const first = upsertPublishOpenPlanItemsSectionV1(report, buildPublishOpenPlanItemsSectionV1(items));
    assert.equal(first.split(PUBLISH_OPEN_PLAN_ITEMS_START_V1).length - 1, 1);
    const second = upsertPublishOpenPlanItemsSectionV1(first, buildPublishOpenPlanItemsSectionV1(items.slice(1)));
    assert.equal(second.split(PUBLISH_OPEN_PLAN_ITEMS_START_V1).length - 1, 1);
    assert.ok(!second.includes("pgvector"));
    const cleared = upsertPublishOpenPlanItemsSectionV1(second, undefined);
    assert.ok(!cleared.includes(PUBLISH_OPEN_PLAN_ITEMS_START_V1));
    assert.ok(!cleared.includes(PUBLISH_OPEN_PLAN_ITEMS_END_V1));
    assert.ok(cleared.startsWith("# Publish review"));
    assert.ok(cleared.includes("Checks passed."));
    assert.equal(upsertPublishOpenPlanItemsSectionV1(report, undefined), report);
  });
});
