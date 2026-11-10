/**
 * review2 Steps 12-13 (bugs6 item 25, `runs/161`): a round that changed no source and ran each test step's own test
 * files settles those items on the commands and pass counts its `## Verification` section lists. An Apply Review that
 * changes no source and settles test items is told not to use the no-checklist-change marker.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  diagnoseApplicablePassingTestReportForItemV1,
  getApplicablePassingTestReportForItemV1,
  listPlanItemIdsV1,
  mergeChecklistProgressV1,
} from "../utils/implementationChecklist";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] Write the tests for Part 2",
  "- [ ] Write the tests for Part 3",
  "",
].join("\n");

function noSourceChangeReport(opts: { marker: boolean }): string {
  return [
    "Ran each Write-the-tests step's own test files; no source changed.",
    "",
    "## Files Changed",
    "",
    "None.",
    "",
    ...(opts.marker ? ["<!-- ensemble:no-checklist-change -->", ""] : []),
    "## Plan Item Checklist",
    "",
    "- Write the tests for Part 2 — done — src/test/a.test.ts",
    "- Write the tests for Part 3 — done — src/test/b.test.ts",
    "",
    "## Verification",
    "",
    "- `pnpm run test:unit -- src/test/a.test.ts` — 314 tests, 314 passed, 0 failed (Step 17)",
    "- `pnpm run test:unit -- src/test/b.test.ts` — 20 tests, 20 passed, 0 failed",
    "",
  ].join("\n");
}

void describe("a round that changed no source settles items on its Verification commands (review2 Step 12)", () => {
  void it("counts each named command with its pass and fail counts as that item's evidence", () => {
    const report = noSourceChangeReport({ marker: false });
    const a = getApplicablePassingTestReportForItemV1(PLAN, "Write the tests for Part 2", report);
    const b = getApplicablePassingTestReportForItemV1(PLAN, "Write the tests for Part 3", report);
    assert.equal(a?.testIdentity, "src/test/a.test.ts");
    assert.equal(a?.passed, 314);
    assert.equal(a?.failed, 0);
    assert.equal(b?.testIdentity, "src/test/b.test.ts");
    assert.equal(b?.passed, 20);
  });

  void it("never takes one item's command as another's evidence", () => {
    const report = noSourceChangeReport({ marker: false }).replace("src/test/b.test.ts` —", "src/test/other.test.ts` —");
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(PLAN, "Write the tests for Part 3", report);
    assert.equal(diagnosis.kind, "not-applicable");
  });

  void it("the merge ticks both items although the report lists no changed file, whether or not it carries the marker", () => {
    for (const marker of [false, true]) {
      const merged = mergeChecklistProgressV1(PLAN, noSourceChangeReport({ marker }));
      assert.equal(merged.kind, "merged", `marker=${marker}`);
      if (merged.kind === "merged") {
        assert.match(merged.content, /- \[x\] Write the tests for Part 2/);
        assert.match(merged.content, /- \[x\] Write the tests for Part 3/);
      }
    }
  });
});

void describe("a checklist line that names its item by [item:<id>] counts as that item's report (review2 Step 6)", () => {
  const ids = listPlanItemIdsV1(PLAN);
  const idPart2 = ids.find((entry) => entry.itemText === "Write the tests for Part 2")!.itemId;
  const idPart3 = ids.find((entry) => entry.itemText === "Write the tests for Part 3")!.itemId;

  void it("accepts the id form, with or without the item's text after the id", () => {
    const withText = noSourceChangeReport({ marker: false })
      .replace("- Write the tests for Part 2 —", `- [item:${idPart2}] Write the tests for Part 2 —`)
      .replace("- Write the tests for Part 3 —", `- item:${idPart3} —`);
    const a = getApplicablePassingTestReportForItemV1(PLAN, "Write the tests for Part 2", withText);
    const b = getApplicablePassingTestReportForItemV1(PLAN, "Write the tests for Part 3", withText);
    assert.equal(a?.testIdentity, "src/test/a.test.ts");
    assert.equal(b?.testIdentity, "src/test/b.test.ts");
  });

  void it("never takes an id that issues another item as this item's claim", () => {
    const swapped = noSourceChangeReport({ marker: false }).replace(
      "- Write the tests for Part 3 —",
      `- [item:${idPart2}] Write the tests for Part 3 —`
    );
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(PLAN, "Write the tests for Part 3", swapped);
    assert.equal(diagnosis.kind, "not-applicable");
  });
});

void describe("the Apply Review prompt on the no-checklist-change marker (review2 Step 13)", () => {
  const prompt = fs.readFileSync(path.resolve(__dirname, "../../resources/prompts/apply-impl-review-code.md"), "utf8");

  void it("tells a source-unchanged round that settles test items not to use the marker", () => {
    assert.match(prompt, /Do NOT write the `<!-- ensemble:no-checklist-change -->` marker in a round that changed no source files but settles test items/);
    assert.match(prompt, /the command and its passed and failed counts/);
    assert.match(prompt, /contradicts itself, and the claims it made are not used/);
  });

  void it("no longer says the marker never conflicts with a completion claim", () => {
    assert.doesNotMatch(prompt, /does not conflict with also reporting a completion/);
    assert.doesNotMatch(prompt, /never contradicts a completion claim/);
  });
});
