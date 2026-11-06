/**
 * bugs5 Step 27 (item 15): a review says how much of the change it was shown. Replays the shape of bugs4's
 * run 141: a tracked scope that holds tests and part of the production files, against a larger change set.
 */
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  computeReviewScopeGapV1,
  describeReviewedCountV1,
  describeTrackedScopeFallbackLineV1,
  formatMissingFilesSectionV1,
  isProductionSourceFileV1,
} from "../utils/reviewScopeGapV1";

const prod = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/utils/file${i}.ts`);
const tests = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/test/file${i}.test.ts`);

void describe("isProductionSourceFileV1", () => {
  void it("counts src/ and packages/ source, not tests, fixtures or other folders", () => {
    assert.equal(isProductionSourceFileV1("src/utils/a.ts"), true);
    assert.equal(isProductionSourceFileV1("packages/ensemble-core/src/a.ts"), true);
    assert.equal(isProductionSourceFileV1("src/test/a.test.ts"), false);
    assert.equal(isProductionSourceFileV1("src/test/fixtures/b.json"), false);
    assert.equal(isProductionSourceFileV1("packages/x/src/a.test.ts"), false);
    assert.equal(isProductionSourceFileV1("docs/a.md"), false);
  });
});

void describe("review1 Step 59/60: a file the size budget cut is not reviewed", () => {
  void it("a tracked file the pack left out joins the not-reviewed list and the count says so", () => {
    const tracked = prod(10);
    const omittedByBudget = new Set(tracked.slice(7)); // the pack ran out of room for the last 3
    const gap = computeReviewScopeGapV1({
      ledgerFiles: tracked,
      workingTreeFiles: [],
      // Exactly what reviewActions does: the scope is the tracked files minus the pack's omitted ones.
      scopeFiles: tracked.filter((file) => !omittedByBudget.has(file)),
    });
    assert.deepEqual([...gap.missing].sort(), [...omittedByBudget].sort());
    assert.equal(gap.productionChangedCount, 10);
    assert.equal(gap.productionReviewedCount, 7);
    assert.match(describeReviewedCountV1(gap), /7 of 10/);
    assert.match(formatMissingFilesSectionV1(gap), /src\/utils\/file9\.ts/);
  });

  void it("the review dispatch takes the pack's omitted files out of the scope it reports on", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const filter = source.indexOf("written.omittedRelPaths.map(");
    assert.ok(filter > 0, "the omitted files are read from the written pack");
    const block = source.slice(filter, filter + 900);
    assert.match(block, /scopeFiles: scopeGapInput\.scopeFiles\.filter\(/);
    assert.match(block, /partialScopeVariablesV1\(gap\.missing/);
  });
});

void describe("computeReviewScopeGapV1", () => {
  void it("replay: 40 tracked paths (25 production + 15 tests) against 88 changed production files", () => {
    const allProduction = prod(88);
    const scope = [...allProduction.slice(0, 25), ...tests(15)];
    const gap = computeReviewScopeGapV1({
      ledgerFiles: [...allProduction, ...tests(15)],
      workingTreeFiles: [],
      scopeFiles: scope,
    });
    assert.equal(gap.missingProduction.length, 63);
    assert.equal(gap.productionChangedCount, 88);
    assert.equal(gap.productionReviewedCount, 25);
    assert.equal(describeReviewedCountV1(gap), "Reviewed 40 of 103 changed files (25 of 88 production files)");
    const section = formatMissingFilesSectionV1(gap);
    assert.match(section, /^## Changed files not in this review's scope/);
    assert.match(section, /src\/utils\/file87\.ts/);
    assert.equal(
      describeTrackedScopeFallbackLineV1(40, gap),
      "Review scope: using the 40 files already tracked; the round history couldn't confirm a complete list. 63 changed files are not included."
    );
  });

  void it("shows nothing when the scope matches the change set", () => {
    const files = [...prod(5), ...tests(2)];
    const gap = computeReviewScopeGapV1({ ledgerFiles: files, workingTreeFiles: files.slice(0, 3), scopeFiles: files });
    assert.equal(gap.missing.length, 0);
    assert.equal(formatMissingFilesSectionV1(gap), "");
    assert.equal(describeTrackedScopeFallbackLineV1(7, gap), undefined);
  });

  void it("leaves out .ensemble/ and quarantined files, and counts working-tree changes", () => {
    const gap = computeReviewScopeGapV1({
      ledgerFiles: [".ensemble/t/plan-final.md", "src/a.ts"],
      workingTreeFiles: ["src\\b.ts", "src/held.ts"],
      scopeFiles: ["src/a.ts"],
      quarantinedFiles: ["src/held.ts"],
    });
    assert.deepEqual(gap.missing, ["src/b.ts"]);
    assert.equal(gap.changedCount, 2);
  });

  void it("leaves out lockfiles and other machine-maintained artifacts, which never enter a scope", () => {
    const gap = computeReviewScopeGapV1({
      ledgerFiles: ["pnpm-lock.yaml", "src/a.ts"],
      workingTreeFiles: ["dist/app.min.js"],
      scopeFiles: ["src/a.ts"],
    });
    assert.deepEqual(gap.changeSet, ["src/a.ts"]);
    assert.equal(gap.missing.length, 0);
  });

  void it("leaves out the whole task root, whatever it is called", () => {
    const gap = computeReviewScopeGapV1({
      ledgerFiles: ["src/a.ts"],
      workingTreeFiles: ["plans/task-1/plan.md", "plans/task-2/task.md", "src/a.ts", "src/b.ts"],
      scopeFiles: ["src/a.ts"],
      taskRecordFolders: ["plans"],
    });
    assert.deepEqual(gap.changeSet, ["src/a.ts", "src/b.ts"]);
    // A task root outside the workspace (a "../" relative path) excludes nothing.
    const outside = computeReviewScopeGapV1({
      ledgerFiles: [],
      workingTreeFiles: ["src/a.ts"],
      scopeFiles: [],
      taskRecordFolders: ["../elsewhere"],
    });
    assert.deepEqual(outside.changeSet, ["src/a.ts"]);
  });

  void it("does not count working-tree changes another open task claims, unless this task's own records name them", () => {
    const gap = computeReviewScopeGapV1({
      ledgerFiles: ["src/mine.ts", "src/shared.ts"],
      workingTreeFiles: ["src/theirs.ts", "src/shared.ts", "src/unclaimed.ts", "src/tracked-here.ts"],
      scopeFiles: ["src/mine.ts", "src/tracked-here.ts"],
      otherTaskFiles: ["src/theirs.ts", "src/shared.ts", "src/tracked-here.ts"],
    });
    assert.deepEqual(gap.changeSet, ["src/mine.ts", "src/shared.ts", "src/tracked-here.ts", "src/unclaimed.ts"]);
    assert.deepEqual(gap.missing, ["src/shared.ts", "src/unclaimed.ts"]);
  });

  void it("caps the listed files and says how many more", () => {
    const gap = computeReviewScopeGapV1({ ledgerFiles: prod(200), workingTreeFiles: [], scopeFiles: [] });
    assert.match(formatMissingFilesSectionV1(gap), /… and 80 more/);
  });
});
