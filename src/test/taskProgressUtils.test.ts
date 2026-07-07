import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  updateImplReviewFiles,
  clearImplReviewFiles,
} from "../utils/taskProgressUtils";
import type { TaskProgress } from "../types/taskProgress";

function makeProgress(implReviewFiles?: string[]): TaskProgress {
  return {
    taskFolder: "2026-07-07_task_1",
    currentStage: "implementation",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...(implReviewFiles !== undefined ? { implReviewFiles } : {}),
  };
}

// ---------------------------------------------------------------------------
// updateImplReviewFiles: union across runs, not overwrite
// ---------------------------------------------------------------------------

void test("first run with no prior tracked files records exactly its own files", () => {
  const progress = makeProgress(undefined);
  const updated = updateImplReviewFiles(progress, ["a.ts", "b.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts"]);
});

void test("a later run's new files are unioned with the previously tracked set", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["c.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts", "c.ts"]);
});

void test(
  "a later run whose own snapshot diff is empty does not erase the task's " +
    "previously tracked files (regression for the multi-run bug)",
  () => {
    const progress = makeProgress(["a.ts", "b.ts", "c.ts"]);
    const updated = updateImplReviewFiles(progress, []);
    assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts", "c.ts"]);
  }
);

void test("duplicate paths across runs are not repeated in the union", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["b.ts", "c.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts", "c.ts"]);
});

void test("updateImplReviewFiles bumps updatedAt", () => {
  const progress = makeProgress(["a.ts"]);
  const updated = updateImplReviewFiles(progress, ["b.ts"]);
  assert.notEqual(updated.updatedAt, progress.updatedAt);
});

void test(
  "the union is sorted alphabetically regardless of insertion order across runs",
  () => {
    const progress = makeProgress(["z.ts", "m.ts"]);
    const updated = updateImplReviewFiles(progress, ["a.ts", "q.ts"]);
    assert.deepEqual(updated.implReviewFiles, ["a.ts", "m.ts", "q.ts", "z.ts"]);
  }
);

// ---------------------------------------------------------------------------
// clearImplReviewFiles: the only intended way to discard the tracked set
// ---------------------------------------------------------------------------

void test("clearImplReviewFiles removes the tracked set entirely", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const cleared = clearImplReviewFiles(progress);
  assert.equal(cleared.implReviewFiles, undefined);
  assert.ok(!("implReviewFiles" in cleared));
});
