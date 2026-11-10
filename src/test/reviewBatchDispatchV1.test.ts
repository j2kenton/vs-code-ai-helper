/**
 * review2 Steps 29-32 (Part 6 dispatch): which batch the next pass reads, the other batches' files never counting as
 * "missing" from it, the per-batch records and the combined verdict, selective reruns after a change, and the split of a
 * batch the reviewer did not fully inspect. The fixture has review1's shape: 202 changed files, about 23,000 lines.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import {
  batchFilesFromVariablesV1,
  batchPassVariablesV1,
  chooseBatchPassV1,
  describeBatchPassV1,
  REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1,
  REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1,
} from "../utils/reviewBatchPassV1";
import { type ReviewBatchFileV1 } from "../utils/reviewBatchPlanV1";
import {
  blockerKeyV1,
  combineBatchRecordsV1,
  extractBlockerLinesV1,
  rewriteReviewAsCombinedV1,
  upsertBatchRecordV1,
  validBatchRecordsV1,
  type BatchPassRecordV1,
} from "../utils/reviewBatchStoreV1";
import { measureReviewReadCostsV1 } from "../utils/reviewReadCostIoV1";
import { computeReviewScopeGapV1 } from "../utils/reviewScopeGapV1";

function pad(index: number): string {
  return String(index).padStart(3, "0");
}

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

function first<T>(items: readonly T[] | undefined): T {
  const item = items?.[0];
  assert.ok(item !== undefined, "expected an item");
  return item;
}

function record(
  position: number,
  count: number,
  files: readonly string[],
  extra: Partial<BatchPassRecordV1> = {}
): BatchPassRecordV1 {
  return {
    position,
    count,
    files,
    filesRead: files,
    hashes: Object.fromEntries(files.map((file) => [file, `h:${file}`])),
    score: 8,
    blockerLines: [],
    runId: `run-${position}`,
    at: "2026-11-10T06:00:00.000Z",
    ...extra,
  };
}

void describe("review2 Step 29: the next pass reads one batch", () => {
  void it("a scope that fits one pass runs as it always did, over the whole list", () => {
    const small = review1Fixture().slice(0, 20);
    assert.equal(chooseBatchPassV1({ files: small }), undefined);
  });

  void it("review1's 202 files split into about four passes, each inside the read budget", () => {
    const pass = chooseBatchPassV1({ files: review1Fixture() });
    assert.ok(pass !== undefined);
    assert.ok(pass.count >= 4 && pass.count <= 6, `about four passes, got ${pass.count}`);
    assert.equal(pass.position, 1);
    assert.ok(pass.batch.files.length <= 60);
    assert.ok(pass.batch.readLines <= 6000);
    assert.equal(describeBatchPassV1(pass), `Reviewing in ${pass.count} parts (about ${Math.round(202 / pass.count)} files each): part 1 of ${pass.count}`);
  });

  void it("source files and their tests land in the same pass", () => {
    const pass = chooseBatchPassV1({ files: review1Fixture() });
    assert.ok(pass);
    for (const file of pass.batch.files) {
      const match = /^src\/utils\/(mod\d+V1)\.ts$/.exec(file);
      if (match) assert.ok(pass.batch.files.includes(`src/test/${match[1]}.test.ts`), `${file} is read with its test`);
    }
  });

  void it("once the first batch is covered, the next pass is the next batch and the position moves on", () => {
    const files = review1Fixture();
    const one = chooseBatchPassV1({ files });
    assert.ok(one);
    const covered = new Set(one.batch.files);
    const two = chooseBatchPassV1({ files, coveredFiles: covered });
    assert.ok(two);
    assert.equal(two.position, 2);
    assert.ok(two.batch.files.every((file) => !covered.has(file)), "the second pass reads only files nobody has read");
    assert.equal(two.remaining, one.remaining - 1);
  });

  void it("the pass travels in prompt variables the coverage record reads back", () => {
    const pass = chooseBatchPassV1({ files: review1Fixture() });
    assert.ok(pass);
    const variables = batchPassVariablesV1(pass);
    assert.equal(variables[REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1], `1/${pass.count}`);
    assert.deepEqual(batchFilesFromVariablesV1(variables), [...pass.batch.files]);
    assert.equal(batchFilesFromVariablesV1({}), undefined);
    assert.ok(REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1.length > 0);
  });

  void it("files of the other batches are in the review list, so a batch pass never raises 'Add the missing files' for them", () => {
    const files = review1Fixture();
    const pass = chooseBatchPassV1({ files });
    assert.ok(pass);
    const all = files.map((file) => file.path);
    const gap = computeReviewScopeGapV1({ ledgerFiles: all, workingTreeFiles: [], scopeFiles: all });
    assert.deepEqual(gap.missing, [], "the list holds every changed file, whichever batch reads it");
    assert.ok(pass.batch.files.length < all.length, "yet this pass was shown only its own batch");
  });
});

void describe("review2 Step 30: per-batch records and the combined verdict", () => {
  const scope = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];

  void it("takes the lowest score, the union of blockers (a finding raised twice counts once), and covered N of M", () => {
    const records = [
      record(1, 2, ["src/a.ts", "src/b.ts"], { score: 9, blockerLines: ["- [completion] [task-fixable] [new] Fix the parser"] }),
      record(2, 2, ["src/c.ts", "src/d.ts"], {
        score: 6,
        blockerLines: ["- [completion] [task-fixable] [same:x-1] Fix the parser", "- [architectural] [task-fixable] [new] Split the card"],
      }),
    ];
    const combined = combineBatchRecordsV1(scope, records);
    assert.equal(combined.score, 6);
    assert.equal(combined.blockerLines.length, 2);
    assert.equal(combined.filesRead, 4);
    assert.equal(combined.filesTotal, 4);
    assert.equal(combined.complete, true);
  });

  void it("is incomplete while a batch has not been read", () => {
    const combined = combineBatchRecordsV1(scope, [record(1, 2, ["src/a.ts", "src/b.ts"])]);
    assert.equal(combined.complete, false);
    assert.deepEqual(combined.unreadFiles, ["src/c.ts", "src/d.ts"]);
    assert.equal(combined.filesRead, 2);
  });

  void it("after a one-file change only the affected batch falls out, and planning puts exactly its files first", () => {
    const records = [record(1, 2, ["src/a.ts", "src/b.ts"]), record(2, 2, ["src/c.ts", "src/d.ts"])];
    const current = new Map([
      ["src/a.ts", "h:src/a.ts"],
      ["src/b.ts", "h:src/b.ts"],
      ["src/c.ts", "CHANGED"],
      ["src/d.ts", "h:src/d.ts"],
    ]);
    const valid = validBatchRecordsV1(records, current);
    assert.deepEqual(valid.map((entry) => entry.position), [1]);
    const combined = combineBatchRecordsV1(scope, valid);
    assert.equal(combined.complete, false);
    assert.deepEqual(combined.unreadFiles, ["src/c.ts", "src/d.ts"], "only the second batch is read again");
  });

  void it("a new pass replaces the records it makes redundant", () => {
    const old = record(1, 2, ["src/a.ts"]);
    const kept = record(2, 2, ["src/b.ts"]);
    const next = upsertBatchRecordV1([old, kept], record(1, 2, ["src/a.ts", "src/c.ts"]));
    assert.equal(next.length, 2);
    assert.ok(next.some((entry) => entry.files.includes("src/b.ts")));
  });

  void it("blocker keys ignore the lineage tag", () => {
    assert.equal(
      blockerKeyV1("- [completion] [task-fixable] [same:abc-1] Fix it"),
      blockerKeyV1("- [completion] [task-fixable] [new] Fix it")
    );
  });

  void it("reads the blocker lines of a review file and writes the combined verdict back into it", () => {
    const review = [
      "# Implementation Review",
      "",
      "Readiness: 9/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] [new] Fix the parser",
      "<!-- blockers:end -->",
      "",
      "<!-- progress: 3/4 -->",
      "",
    ].join("\n");
    assert.deepEqual(extractBlockerLinesV1(review), ["- [completion] [task-fixable] [new] Fix the parser"]);
    const records = [
      record(1, 2, ["src/a.ts", "src/b.ts"], { score: 9, blockerLines: ["- [completion] [task-fixable] [new] Fix the parser"] }),
      record(2, 2, ["src/c.ts", "src/d.ts"], { score: 6, blockerLines: ["- [architectural] [task-fixable] [new] Split the card"] }),
    ];
    const combined = combineBatchRecordsV1(scope, records);
    const rewritten = rewriteReviewAsCombinedV1(review, combined, records);
    assert.match(rewritten, /^Readiness: 6\/10$/m);
    assert.deepEqual(extractBlockerLinesV1(rewritten).length, 2);
    assert.match(rewritten, /## Review parts/);
    assert.match(rewritten, /Covered 4 of 4 files across 2 part\(s\)/);
    assert.match(rewritten, /<!-- progress: 3\/4 -->/, "the review's own markers stay after the section");
    assert.equal(rewriteReviewAsCombinedV1(rewritten, combined, records), rewritten, "rewriting is idempotent");
  });
});

void describe("review2 Step 31: a batch the reviewer did not fully inspect is split, not blocked", () => {
  void it("the declined files' batch is planned again smaller, and the set grows by the split", () => {
    const files = review1Fixture();
    const plain = chooseBatchPassV1({ files });
    assert.ok(plain);
    const declined = new Set(plain.batch.files.slice(0, 40));
    const split = chooseBatchPassV1({ files, splitFiles: declined });
    assert.ok(split);
    assert.ok(split.batch.files.length < plain.batch.files.length, "the pass is smaller");
    assert.ok(split.batch.files.every((file) => declined.has(file)), "it reads only what was declined");
    assert.ok(split.count > plain.count, "the batch set grew by the split");
  });

  void it("a single declined file cannot be split further", () => {
    const files = review1Fixture();
    const plain = chooseBatchPassV1({ files });
    assert.ok(plain);
    const one = first(plain.batch.files);
    const same = chooseBatchPassV1({ files, splitFiles: new Set([one]) });
    assert.ok(same);
    assert.equal(same.count, plain.count);
    assert.deepEqual(same.batch.files, plain.batch.files);
  });
});

void describe("review2 Steps 29-31: the dispatch wiring (source checks; the full run is a hand-off check)", () => {
  const reviewActions = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");

  void it("the scope is split by the read budget before the pack is built, and the pack gets only the pass's files", () => {
    const planAt = reviewActions.indexOf("planBatchPassForFilesV1({");
    const packAt = reviewActions.indexOf("writeImplReviewContextPack(\n        folderUri,");
    assert.ok(planAt > 0 && packAt > planAt, "the batch is chosen before the pack is written");
    assert.match(reviewActions, /const packFiles = batchPass !== undefined \? \[\.\.\.batchPass\.batch\.files\] : taskProgress\?\.implReviewFiles;/);
    assert.match(reviewActions, /workspaceRoot\.uri,\n\s+packFiles,/);
  });

  void it("the stage clears only when every batch is read, and the next part runs under the same review", () => {
    assert.match(reviewActions, /const meetsThreshold = clearsWithoutScopeHold && !partialScopeHolds && !batchesIncomplete;/);
    assert.match(reviewActions, /skipUnchangedTreeGuard: true,\n\s+\.\.\.\(variables\.automationDispatch === "true"/);
  });

  void it("a pass's files are the only ones its coverage record counts as read", () => {
    const record = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "reviewCoverageRecordV1.ts"), "utf8");
    assert.match(record, /inBatch === undefined \|\| inBatch\.has\(file\)/);
  });
});

void describe("review2 Step 29: measuring what a pass must read", () => {
  void it("with no baseline a file costs its length in lines, and an unreadable one costs one line", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "batch-cost-"));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "a.ts"), "1\n2\n3\n4\n5");
      const costs = await measureReviewReadCostsV1(dir, undefined, ["a.ts", "gone.ts", "../escape.ts"]);
      assert.equal(costs.get("a.ts"), 5);
      assert.equal(costs.get("gone.ts"), 1);
      assert.ok(!costs.has("../escape.ts"), "a path outside the workspace is never read");
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
