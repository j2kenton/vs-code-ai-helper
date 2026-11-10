/**
 * review2 Steps 29-32 (Part 6): the read budget, the batch plan, source/test grouping, coverage ordering, the combined
 * verdict, selective reruns and the split of a batch the reviewer did not fully inspect. The fixture has review1's
 * shape: 202 changed files, about 23,000 lines to read.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_REVIEW_READ_LIMITS_V1,
  IMPL_REVIEW_READ_MAX_FILES_V1,
  IMPL_REVIEW_READ_MAX_LINES_V1,
  readCostLinesV1,
} from "../utils/implReviewBudgetV1";
import {
  batchesToRerunV1,
  combineBatchVerdictsV1,
  describeBatchProgressV1,
  matchSourceForTestV1,
  planReviewBatchesV1,
  splitBatchFurtherV1,
  type ReviewBatchFileV1,
} from "../utils/reviewBatchPlanV1";
import { parseDiffReadCostsV1 } from "../utils/reviewReadCostIoV1";

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `no item at ${index}`);
  return item;
}

function pad(index: number): string {
  return String(index).padStart(3, "0");
}

/** 100 production files (about 120 lines each), their 100 tests (about 110 lines each) and 2 unrelated files. */
function review1Fixture(): ReviewBatchFileV1[] {
  const files: ReviewBatchFileV1[] = [];
  for (let index = 0; index < 100; index += 1) {
    files.push({ path: `src/utils/mod${pad(index)}V1.ts`, readLines: 110 + (index % 21) });
    files.push({ path: `src/test/mod${pad(index)}V1.test.ts`, readLines: 100 + (index % 21) });
  }
  files.push({ path: "package.json", readLines: 40 });
  files.push({ path: "resources/prompts/review-impl-high.md", readLines: 60 });
  return files;
}

void describe("review2 Step 29: the read budget", () => {
  void it("pins the defaults at about 6,000 lines and 60 files per pass", () => {
    assert.equal(IMPL_REVIEW_READ_MAX_LINES_V1, 6000);
    assert.equal(IMPL_REVIEW_READ_MAX_FILES_V1, 60);
    assert.deepEqual(DEFAULT_REVIEW_READ_LIMITS_V1, { maxLines: 6000, maxFiles: 60 });
  });

  void it("charges a new file its whole length, a modified file its regions with context, a deleted file one line", () => {
    assert.equal(readCostLinesV1({ kind: "new", totalLines: 300 }), 300);
    assert.equal(readCostLinesV1({ kind: "modified", totalLines: 1000, changedLines: 20, hunks: 2 }), 20 + 2 * 6);
    assert.equal(readCostLinesV1({ kind: "modified", totalLines: 10, changedLines: 9, hunks: 3 }), 10, "never more than the file");
    assert.equal(readCostLinesV1({ kind: "deleted", totalLines: 500 }), 1);
  });

  void it("reads a per-file cost out of a git diff: context included, new and deleted files told apart", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " keep",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,3 @@",
      "+one",
      "+two",
      "+three",
      "diff --git a/src/c.ts b/src/c.ts",
      "deleted file mode 100644",
      "--- a/src/c.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
    ].join("\n");
    const costs = parseDiffReadCostsV1(diff);
    assert.equal(costs.get("src/a.ts"), 4);
    assert.equal(costs.get("src/b.ts"), 3);
    assert.equal(costs.get("src/c.ts"), 1);
  });
});

void describe("review2 Step 29: splitting a scope by the read budget", () => {
  void it("keeps a scope that fits as one batch holding every file", () => {
    const plan = planReviewBatchesV1({ files: [{ path: "src/a.ts", readLines: 10 }, { path: "src/test/a.test.ts", readLines: 10 }] });
    assert.equal(plan.batches.length, 1);
    assert.deepEqual([...at(plan.batches, 0).files].sort(), ["src/a.ts", "src/test/a.test.ts"]);
    assert.equal(describeBatchProgressV1(plan, 1), "");
  });

  void it("splits review1's 202-file change into about four passes that each fit the budget and the file ceiling", () => {
    const fixture = review1Fixture();
    const plan = planReviewBatchesV1({ files: fixture });
    assert.equal(plan.totalFiles, 202);
    assert.ok(plan.batches.length >= 4 && plan.batches.length <= 6, `got ${plan.batches.length} batches`);
    for (const batch of plan.batches) {
      assert.ok(batch.files.length <= IMPL_REVIEW_READ_MAX_FILES_V1, `batch ${batch.index} has ${batch.files.length} files`);
      assert.ok(batch.readLines <= IMPL_REVIEW_READ_MAX_LINES_V1, `batch ${batch.index} reads ${batch.readLines} lines`);
      assert.equal(batch.oversized, false);
    }
    const everyFile = plan.batches.flatMap((batch) => batch.files).sort();
    assert.deepEqual(everyFile, fixture.map((file) => file.path).sort(), "each file lands in exactly one batch");
    assert.match(describeBatchProgressV1(plan, 2), /^Reviewing in \d parts \(about \d+ files each\): part 2 of \d$/);
  });

  void it("splits by read lines even when the files would all fit one context pack as native-read stanzas", () => {
    // 200 files, 100 lines each: under the 60-file ceiling per pass only because of the split, and 20,000 lines in all.
    const files = Array.from({ length: 200 }, (_, index) => ({ path: `src/m/f${pad(index)}.ts`, readLines: 100 }));
    const plan = planReviewBatchesV1({ files });
    assert.ok(plan.batches.length >= 4);
    assert.ok(plan.batches.every((batch) => batch.readLines <= IMPL_REVIEW_READ_MAX_LINES_V1));
    // Few lines but many files: the file ceiling splits it.
    const many = Array.from({ length: 200 }, (_, index) => ({ path: `src/m/g${pad(index)}.ts`, readLines: 5 }));
    const manyPlan = planReviewBatchesV1({ files: many });
    assert.ok(manyPlan.batches.length >= 4);
    assert.ok(manyPlan.batches.every((batch) => batch.files.length <= IMPL_REVIEW_READ_MAX_FILES_V1));
  });

  void it("gives a file that is over the limits alone a batch of its own", () => {
    const plan = planReviewBatchesV1({
      files: [
        { path: "src/big.ts", readLines: 9000 },
        { path: "src/small.ts", readLines: 10 },
      ],
    });
    const big = plan.batches.find((batch) => batch.files.includes("src/big.ts"));
    assert.deepEqual(big?.files, ["src/big.ts"]);
    assert.equal(big?.oversized, true);
  });
});

void describe("review2 Step 29: source and test grouping", () => {
  void it("matches a test to the source of the same name, preferring the closest folder", () => {
    assert.equal(matchSourceForTestV1("src/test/fooV1.test.ts", ["src/utils/fooV1.ts", "src/other/barV1.ts"]), "src/utils/fooV1.ts");
    assert.equal(matchSourceForTestV1("src/a/x.spec.ts", ["src/b/x.ts", "src/a/x.ts"]), "src/a/x.ts");
    assert.equal(matchSourceForTestV1("src/test/none.test.ts", ["src/utils/fooV1.ts"]), undefined);
  });

  void it("keeps every test in the batch of its source", () => {
    const plan = planReviewBatchesV1({ files: review1Fixture() });
    const batchOf = new Map<string, number>();
    for (const batch of plan.batches) for (const file of batch.files) batchOf.set(file, batch.index);
    for (let index = 0; index < 100; index += 1) {
      assert.equal(
        batchOf.get(`src/test/mod${pad(index)}V1.test.ts`),
        batchOf.get(`src/utils/mod${pad(index)}V1.ts`),
        `mod${pad(index)} and its test are read together`
      );
    }
  });

  void it("puts a test with no matching source into the batch holding most files from its own folder", () => {
    const plan = planReviewBatchesV1({
      limits: { maxLines: 100, maxFiles: 3 },
      files: [
        { path: "src/a/one.ts", readLines: 40 },
        { path: "src/a/two.ts", readLines: 40 },
        { path: "src/b/three.ts", readLines: 40 },
        { path: "src/b/four.ts", readLines: 40 },
        { path: "src/b/misc.test.ts", readLines: 10 },
      ],
    });
    const withThree = plan.batches.find((batch) => batch.files.includes("src/b/three.ts"));
    assert.ok(withThree?.files.includes("src/b/misc.test.ts"), "the orphan test joins its own folder's batch");
    const withOne = plan.batches.find((batch) => batch.files.includes("src/a/one.ts"));
    assert.ok(!withOne?.files.includes("src/b/misc.test.ts"));
  });
});

void describe("review2 Step 29: files without current coverage go first", () => {
  void it("puts uncovered files into the earliest batches", () => {
    const files = Array.from({ length: 6 }, (_, index) => ({ path: `src/utils/s${index + 1}.ts`, readLines: 10 }));
    const covered = new Set(["src/utils/s1.ts", "src/utils/s2.ts", "src/utils/s3.ts", "src/utils/s4.ts"]);
    const plan = planReviewBatchesV1({ files, coveredFiles: covered, limits: { maxLines: 1000, maxFiles: 2 } });
    assert.deepEqual([...at(plan.batches, 0).files].sort(), ["src/utils/s5.ts", "src/utils/s6.ts"]);
    assert.equal(at(plan.batches, 0).uncoveredCount, 2);
    assert.equal(at(plan.batches, plan.batches.length - 1).uncoveredCount, 0);
  });
});

void describe("review2 Steps 30-31: verdicts, reruns and incomplete batches", () => {
  const files = ["a", "b", "c", "d"].map((name) => ({ path: `src/u/${name}.ts`, readLines: 10 }));
  const plan = planReviewBatchesV1({ files, limits: { maxLines: 1000, maxFiles: 2 } });

  void it("combines batches into the lowest score, the union of blockers and covered N of M", () => {
    const partial = combineBatchVerdictsV1(plan, [
      { index: 1, score: 8, blockers: ["fix a"], filesRead: 2, filesInBatch: 2 },
      { index: 2, score: 6, blockers: ["fix a", "fix b"], filesRead: 1, filesInBatch: 2 },
    ]);
    assert.equal(partial.score, 6);
    assert.deepEqual(partial.blockers, ["fix a", "fix b"]);
    assert.equal(partial.filesRead, 3);
    assert.equal(partial.filesTotal, 4);
    assert.equal(partial.complete, false, "a batch that did not read all its files does not clear the stage");
    const done = combineBatchVerdictsV1(plan, [
      { index: 1, score: 8, blockers: [], filesRead: 2, filesInBatch: 2 },
      { index: 2, score: 9, blockers: [], filesRead: 2, filesInBatch: 2 },
    ]);
    assert.equal(done.complete, true);
    assert.equal(done.score, 8);
    assert.equal(combineBatchVerdictsV1(plan, [{ index: 1, score: 8, blockers: [], filesRead: 2, filesInBatch: 2 }]).complete, false);
  });

  void it("re-runs only the batch holding the changed file", () => {
    const target = plan.batches.find((batch) => batch.files.includes("src/u/c.ts"));
    assert.deepEqual(batchesToRerunV1(plan, new Set(["src/u/c.ts"])), [target?.index]);
    assert.deepEqual(batchesToRerunV1(plan, new Set()), []);
  });

  void it("splits a batch further when files were declined or the reviewer said so in prose, and stops at one file", () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ path: `src/z/f${index}.ts`, readLines: 100 }));
    const big = at(planReviewBatchesV1({ files: eight, limits: { maxLines: 10000, maxFiles: 8 } }).batches, 0);
    const costs = new Map(eight.map((file) => [file.path, file.readLines]));
    const declined = splitBatchFurtherV1(big, costs, ["src/z/f3.ts", "src/z/f4.ts"], { maxLines: 10000, maxFiles: 8 });
    assert.ok(declined !== undefined && declined.batches.length === 2);
    assert.deepEqual(declined.batches.flatMap((batch) => batch.files).sort(), ["src/z/f3.ts", "src/z/f4.ts"]);
    const prose = splitBatchFurtherV1(big, costs, [], { maxLines: 10000, maxFiles: 8 });
    assert.ok(prose !== undefined && prose.batches.length >= 2);
    assert.equal(prose.totalFiles, 8);
    const single = at(planReviewBatchesV1({ files: [{ path: "src/one.ts", readLines: 5 }] }).batches, 0);
    assert.equal(splitBatchFurtherV1(single, new Map(), []), undefined);
  });
});
