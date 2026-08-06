import * as assert from "node:assert/strict";
import { test } from "node:test";
import { appendReviewRejection, appendReviewScoreHistory, clearEscalation, clearStageFallbackReservation, recordEscalation, updateImplReviewFiles, clearImplReviewFiles, updateTaskProgressStage } from "../utils/taskProgressTransforms";
import { MAX_REVIEW_REJECTIONS, MAX_REVIEW_SCORE_HISTORY, ReviewRejectionEntry, ReviewScoreHistoryEntry, type TaskProgress } from "../types/taskProgress";

function makeProgress(implReviewFiles?: string[]): TaskProgress {
  return {
    taskFolder: "2026-07-07_task_1",
    currentStage: "impl",
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

void test("a later run's new files are unioned ahead of the previously tracked set", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["c.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["c.ts", "a.ts", "b.ts"]);
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

void test("duplicate paths across runs are not repeated, and re-touched files move to the front", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["b.ts", "c.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["b.ts", "c.ts", "a.ts"]);
});

void test("updateImplReviewFiles bumps updatedAt", () => {
  const progress = makeProgress(["a.ts"]);
  const updated = updateImplReviewFiles(progress, ["b.ts"]);
  assert.notEqual(updated.updatedAt, progress.updatedAt);
});

void test(
  "the union is ordered most-recently-changed first regardless of alphabetical order",
  () => {
    const progress = makeProgress(["z.ts", "m.ts"]);
    const updated = updateImplReviewFiles(progress, ["a.ts", "q.ts"]);
    assert.deepEqual(updated.implReviewFiles, ["a.ts", "q.ts", "z.ts", "m.ts"]);
  }
);

// ---------------------------------------------------------------------------
// updateImplReviewFiles: machine-maintained artifacts are never tracked
// (2026-08-06 live dogfooding fix — see isMachineMaintainedArtifactPathV1's
// own header for the recurring failure this closes: an implementation round
// that regenerates this repo's own generated workflow-safety inventories had
// those paths recorded as review scope, inflating or replacing the next
// review's actual reviewable content with machine-written JSON fragments).
// ---------------------------------------------------------------------------

void test("generated workflow inventories are excluded from a fresh set", () => {
  const progress = makeProgress(undefined);
  const updated = updateImplReviewFiles(progress, [
    "src/a.ts",
    "workflow-inventories/workflow-route-baseline-v1.json",
  ]);
  assert.deepEqual(updated.implReviewFiles, ["src/a.ts"]);
});

void test("lockfiles and minified bundles are excluded alongside real source changes", () => {
  const progress = makeProgress(undefined);
  const updated = updateImplReviewFiles(progress, [
    "src/a.ts",
    "pnpm-lock.yaml",
    "dist/extension.js.map",
  ]);
  assert.deepEqual(updated.implReviewFiles, ["src/a.ts"]);
});

void test("a round touching ONLY machine-maintained artifacts still preserves the prior tracked set", () => {
  // Same "don't erase on an empty-after-filtering diff" contract as an
  // empty raw diff — a round whose only changes are generated inventories
  // did not touch reviewable work, so the previous round's scope must survive.
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["workflow-inventories/workflow-route-live-v1.json"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts"]);
});

void test("machine-maintained paths already in the prior tracked set are not retroactively purged", () => {
  // The filter only screens NEW files this round is trying to add — it is
  // not a general-purpose sanitizer of the whole persisted list. (A prior
  // round predating this fix could still have one on disk; that is a
  // one-time cleanup concern, not something every future update should
  // re-litigate.)
  const progress = makeProgress(["workflow-inventories/workflow-route-live-v1.json"]);
  const updated = updateImplReviewFiles(progress, ["a.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "workflow-inventories/workflow-route-live-v1.json"]);
});

// ---------------------------------------------------------------------------
// clearImplReviewFiles: the only intended way to discard the tracked set
// ---------------------------------------------------------------------------

void test("clearImplReviewFiles removes the tracked set entirely", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const cleared = clearImplReviewFiles(progress);
  assert.equal(cleared.implReviewFiles, undefined);
  assert.ok(!("implReviewFiles" in cleared));
});

void test("clearStageFallbackReservation removes only the requested stage", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    fallbackActive: {
      impl: true,
      plan: true,
    },
    fallbackModelId: {
      impl: "impl-backup",
      plan: "plan-backup",
    },
  };

  const cleared = clearStageFallbackReservation(progress, "impl");
  assert.deepEqual(cleared.fallbackActive, { plan: true });
  assert.deepEqual(cleared.fallbackModelId, { plan: "plan-backup" });
  assert.equal(cleared.updatedAt, progress.updatedAt);
});

void test("clearStageFallbackReservation is a no-op when the stage is not reserved", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    fallbackActive: {
      plan: true,
    },
  };

  const cleared = clearStageFallbackReservation(progress, "impl");
  assert.strictEqual(cleared, progress);
});

void test("updateTaskProgressStage advances the stage and clears the new stage fallback reservation", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    currentStage: "desc",
    fallbackActive: {
      desc: true,
      plan: true,
    },
    fallbackModelId: {
      desc: "desc-backup",
      plan: "plan-backup",
    },
  };

  const updated = updateTaskProgressStage(progress, "plan");

  assert.equal(updated.currentStage, "plan");
  assert.deepEqual(updated.fallbackActive, {
    desc: true,
  });
  assert.deepEqual(updated.fallbackModelId, {
    desc: "desc-backup",
  });
});

void test("updateTaskProgressStage clears an escalation recorded on the stage being left", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    currentStage: "impl-high-review",
    escalation: {
      stage: "impl-high-review",
      kind: "plateau",
      reason: "stuck",
      at: "2026-07-07T00:00:00.000Z",
    },
  };
  const updated = updateTaskProgressStage(progress, "impl-low-review");
  assert.equal(updated.escalation, undefined);
});

// ---------------------------------------------------------------------------
// appendReviewScoreHistory / recordEscalation / clearEscalation
// ---------------------------------------------------------------------------

function historyEntry(overrides: Partial<ReviewScoreHistoryEntry> = {}): ReviewScoreHistoryEntry {
  return {
    stage: "impl-high-review",
    score: 5,
    attemptId: "attempt-1",
    at: "2026-07-07T00:00:00.000Z",
    blockerCount: 1,
    taskFixableCount: 1,
    ...overrides,
  };
}

void test("appendReviewScoreHistory appends to an empty history", () => {
  const progress = makeProgress();
  const updated = appendReviewScoreHistory(progress, historyEntry());
  assert.deepEqual(updated.reviewScoreHistory, [historyEntry()]);
});

void test("appendReviewScoreHistory preserves prior entries in order", () => {
  const progress = { ...makeProgress(), reviewScoreHistory: [historyEntry({ score: 2 })] };
  const updated = appendReviewScoreHistory(progress, historyEntry({ score: 5 }));
  assert.deepEqual(
    updated.reviewScoreHistory?.map((e) => e.score),
    [2, 5]
  );
});

void test("appendReviewScoreHistory caps at MAX_REVIEW_SCORE_HISTORY, dropping the oldest first", () => {
  const existing = Array.from({ length: MAX_REVIEW_SCORE_HISTORY }, (_, i) => historyEntry({ attemptId: `attempt-${i}`, score: i }));
  const progress = { ...makeProgress(), reviewScoreHistory: existing };
  const updated = appendReviewScoreHistory(progress, historyEntry({ attemptId: "attempt-new", score: 999 }));
  assert.equal(updated.reviewScoreHistory?.length, MAX_REVIEW_SCORE_HISTORY);
  assert.equal(updated.reviewScoreHistory?.[0]?.attemptId, "attempt-1", "the single oldest entry must be dropped");
  assert.equal(updated.reviewScoreHistory?.at(-1)?.attemptId, "attempt-new");
});

// ---------------------------------------------------------------------------
// appendReviewRejection: durable degenerate-round rejection trail (2d)
// ---------------------------------------------------------------------------

function rejectionEntry(overrides: Partial<ReviewRejectionEntry> = {}): ReviewRejectionEntry {
  return {
    stage: "impl-high-review",
    attemptId: "attempt-1",
    at: "2026-07-07T00:00:00.000Z",
    reason: "no parseable Readiness line",
    ...overrides,
  };
}

void test("appendReviewRejection records the rejected round with its reason, without touching reviewScoreHistory", () => {
  const progress = { ...makeProgress(), reviewScoreHistory: [historyEntry()] };
  const updated = appendReviewRejection(progress, rejectionEntry());
  assert.deepEqual(updated.reviewRejections, [rejectionEntry()]);
  assert.deepEqual(updated.reviewScoreHistory, [historyEntry()]);
});

void test("appendReviewRejection preserves prior rejections in order", () => {
  const progress = { ...makeProgress(), reviewRejections: [rejectionEntry({ attemptId: "attempt-0" })] };
  const updated = appendReviewRejection(progress, rejectionEntry({ attemptId: "attempt-1" }));
  assert.deepEqual(
    updated.reviewRejections?.map((e) => e.attemptId),
    ["attempt-0", "attempt-1"]
  );
});

void test("appendReviewRejection caps at MAX_REVIEW_REJECTIONS, dropping the oldest first", () => {
  const existing = Array.from({ length: MAX_REVIEW_REJECTIONS }, (_, i) => rejectionEntry({ attemptId: `attempt-${i}` }));
  const progress = { ...makeProgress(), reviewRejections: existing };
  const updated = appendReviewRejection(progress, rejectionEntry({ attemptId: "attempt-new" }));
  assert.equal(updated.reviewRejections?.length, MAX_REVIEW_REJECTIONS);
  assert.equal(updated.reviewRejections?.[0]?.attemptId, "attempt-1", "the single oldest entry must be dropped");
  assert.equal(updated.reviewRejections?.at(-1)?.attemptId, "attempt-new");
});

void test("recordEscalation sets the escalation field", () => {
  const progress = makeProgress();
  const escalation = { stage: "impl-high-review" as const, kind: "plateau" as const, reason: "stuck", at: "2026-07-07T00:00:00.000Z" };
  const updated = recordEscalation(progress, escalation);
  assert.deepEqual(updated.escalation, escalation);
});

void test("clearEscalation removes a recorded escalation", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    escalation: { stage: "impl-high-review", kind: "plateau", reason: "stuck", at: "2026-07-07T00:00:00.000Z" },
  };
  const updated = clearEscalation(progress);
  assert.equal(updated.escalation, undefined);
});

void test("clearEscalation is a no-op (same reference) when nothing is recorded", () => {
  const progress = makeProgress();
  assert.strictEqual(clearEscalation(progress), progress);
});

