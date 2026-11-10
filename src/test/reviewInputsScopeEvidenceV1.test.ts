/**
 * review2 Steps 9-11 (bugs6 items 30 and 31): the review's file scope, the owner's partial-scope acceptance and the
 * task's `evidence/` folder are review inputs, so a change to any of them on an unchanged tree makes the review run
 * instead of raising "Nothing has changed". A 200-file scope is never trimmed, and the git-baseline fallback line
 * names its source.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { describeTrackedScopeFallbackLineV1 } from "../utils/reviewScopeGapV1";
import { recordReviewInputsV1, reviewInputsChangedSinceV1 } from "../utils/reviewInputsChangedV1";
import { updateImplReviewFiles } from "../utils/taskProgressTransforms";
import type { TaskProgress } from "../types/taskProgress";
import { computeReviewScopeGapV1 } from "../utils/reviewScopeGapV1";

function writeScope(dir: string, files: readonly string[]): void {
  fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify({ implReviewFiles: files }));
}

/** A task folder whose review was dispatched (inputs recorded) and then finished. */
async function reviewedFolder(files: readonly string[]): Promise<{ dir: string; review: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-inputs-"));
  fs.writeFileSync(path.join(dir, "task.md"), "task");
  fs.writeFileSync(path.join(dir, "plan.md"), "plan");
  writeScope(dir, files);
  const review = path.join(dir, "impl-low-review.md");
  fs.writeFileSync(review, "review");
  await recordReviewInputsV1(dir, review);
  const later = Date.now() / 1000 + 60;
  fs.utimesSync(review, later, later);
  return { dir, review };
}

void describe("the review's scope, acceptance and evidence are review inputs (review2 Step 9)", () => {
  void it("an unchanged scope, acceptance and evidence folder leave the review current", async () => {
    const { dir, review } = await reviewedFolder(["src/a.ts", "src/b.ts"]);
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, false);
    assert.equal(result.scopeChange, undefined);
  });

  void it("a changed file scope on an unchanged tree counts as a changed input and reports 40 → 199 style counts", async () => {
    const small = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
    const { dir, review } = await reviewedFolder(small);
    writeScope(dir, Array.from({ length: 199 }, (_, i) => `src/f${i}.ts`));
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, true);
    assert.deepEqual(result.changedFiles, ["implReviewFiles"]);
    assert.deepEqual(result.scopeChange, { from: 40, to: 199 });
  });

  void it("the same files in a different order are the same scope", async () => {
    const { dir, review } = await reviewedFolder(["src/a.ts", "src/b.ts"]);
    writeScope(dir, ["src/b.ts", "src/a.ts"]);
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false);
  });

  void it("a new partial-scope acceptance record counts as a changed input", async () => {
    const { dir, review } = await reviewedFolder(["src/a.ts"]);
    fs.writeFileSync(
      path.join(dir, "review-scope-accepted-v1.json"),
      JSON.stringify({ stage: "impl-low-review", hash: "abc", missingCount: 1, acceptedAt: "2026-11-09T00:00:00.000Z" })
    );
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, true);
    assert.deepEqual(result.changedFiles, ["review-scope-accepted-v1.json"]);
  });

  void it("a new file under evidence/ counts as a changed input, and an edit to its content does too", async () => {
    const { dir, review } = await reviewedFolder(["src/a.ts"]);
    fs.mkdirSync(path.join(dir, "evidence"));
    fs.writeFileSync(path.join(dir, "evidence", "owner-run.txt"), "pnpm test: 12 passed");
    const added = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(added.changed, true);
    assert.deepEqual(added.changedFiles, ["evidence/"]);

    // Recording the inputs again (the next dispatch) makes the folder the baseline; a content edit is then seen.
    await recordReviewInputsV1(dir, review);
    const later = Date.now() / 1000 + 120;
    fs.utimesSync(review, later, later);
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false);
    fs.writeFileSync(path.join(dir, "evidence", "owner-run.txt"), "pnpm test: 11 passed, 1 failed");
    assert.deepEqual((await reviewInputsChangedSinceV1(dir, review)).changedFiles, ["evidence/"]);
  });

  void it("a record written before these inputs existed does not read them as changed", async () => {
    const { dir, review } = await reviewedFolder(["src/a.ts"]);
    const recordPath = path.join(dir, "review-inputs-v1.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Record<string, { digests: Record<string, string> }>;
    for (const entry of Object.values(record)) {
      delete entry.digests.implReviewFiles;
      delete entry.digests["review-scope-accepted-v1.json"];
      delete entry.digests["evidence/"];
    }
    fs.writeFileSync(recordPath, JSON.stringify(record));
    fs.mkdirSync(path.join(dir, "evidence"));
    fs.writeFileSync(path.join(dir, "evidence", "x.txt"), "x");
    writeScope(dir, ["src/a.ts", "src/b.ts"]);
    const later = Date.now() / 1000 + 120;
    fs.utimesSync(review, later, later);
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false);
  });
});

void describe("a wide scope is kept whole and the fallback names its source (review2 Steps 10-11)", () => {
  void it("200 changed files stay in implReviewFiles, whatever is already there (no cap, no trim)", () => {
    const files = Array.from({ length: 200 }, (_, i) => `src/area${i % 7}/file${i}.ts`);
    let progress = { implReviewFiles: files.slice(0, 40) } as TaskProgress;
    progress = updateImplReviewFiles(progress, files);
    assert.equal(progress.implReviewFiles?.length, 200);
    // An Apply Review round that names three files adds to the list; it never trims it back.
    progress = updateImplReviewFiles(progress, ["src/area0/file0.ts", "src/new.ts"]);
    assert.equal(progress.implReviewFiles?.length, 201);
  });

  void it("a file a round changed without naming it is part of the diff, so it is not a gap once merged in", () => {
    const changed = ["src/popup.ts", "src/popup.store.ts"];
    const before = computeReviewScopeGapV1({ ledgerFiles: changed, workingTreeFiles: changed, scopeFiles: ["src/popup.ts"] });
    assert.deepEqual(before.missing, ["src/popup.store.ts"]);
    const after = computeReviewScopeGapV1({ ledgerFiles: changed, workingTreeFiles: changed, scopeFiles: changed });
    assert.deepEqual(after.missing, []);
  });

  void it("the fallback line says the scope is the baseline diff, even when nothing is missing", () => {
    const gap = computeReviewScopeGapV1({ ledgerFiles: [], workingTreeFiles: ["src/a.ts"], scopeFiles: ["src/a.ts"] });
    const line = describeTrackedScopeFallbackLineV1(1, gap, { source: "git-baseline" });
    assert.match(line ?? "", /every file changed since the task's baseline commit/);
    assert.equal(describeTrackedScopeFallbackLineV1(1, gap), undefined, "the tracked-set wording stays silent when nothing is missing");
    const missingGap = computeReviewScopeGapV1({ ledgerFiles: [], workingTreeFiles: ["src/a.ts", "src/b.ts"], scopeFiles: ["src/a.ts"] });
    assert.match(describeTrackedScopeFallbackLineV1(1, missingGap) ?? "", /using the 1 files already tracked/);
  });
});
