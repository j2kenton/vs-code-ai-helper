import * as assert from "node:assert/strict";
import { test } from "node:test";
import { appendBlockerSupersession, appendChecklistChangeProposal, appendReviewRejection, appendReviewScoreHistory, appendRoundOutcome, capImplReviewFilesV1, clearEscalation, clearImplementationTypeCheckFailure, clearReviewInvalidatedByRound, clearStageFallbackReservation, IMPL_REVIEW_FILES_MAX_ENTRIES_V1, latestReviewBlockerNamedPathsV1, markChecklistChangeProposalAdoptedV1, promotePendingImplReviewFiles, quarantinePendingImplReviewFiles, recordEscalation, recordImplementationTypeCheckFailure, recordReviewInvalidatedByRound, recordTaskMdSizeBandAnnouncedV1, setIncompleteRoundContinuations, setZeroChangeImplRounds, updateImplReviewFiles, clearImplReviewFiles, updateTaskProgressStage } from "../utils/taskProgressTransforms";
import { BlockerSupersessionRecordV1, ChecklistChangeProposalV1, MAX_BLOCKER_SUPERSESSIONS, MAX_CHECKLIST_CHANGE_PROPOSALS, MAX_REVIEW_REJECTIONS, MAX_REVIEW_SCORE_HISTORY, MAX_ROUND_OUTCOMES, ReviewRejectionEntry, ReviewScoreHistoryEntry, RoundLedgerEntryV1, RoundOutcomeEntryV1, type TaskProgress, type TaskStage } from "../types/taskProgress";

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
// capImplReviewFilesV1 / updateImplReviewFiles eviction (item 9, Part 16 step
// 42): the persisted set is soft-capped, but a path a standing review
// blocker names survives eviction even outside the most-recent window.
// ---------------------------------------------------------------------------

void test("capImplReviewFilesV1 is a no-op under the cap", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(capImplReviewFilesV1(files, new Set(), 40), files);
});

void test("capImplReviewFilesV1 keeps only the newest N files over the cap", () => {
  const files = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
  const capped = capImplReviewFilesV1(files, new Set(), 40);
  assert.equal(capped.length, 40);
  assert.deepEqual(capped, files.slice(0, 40));
});

void test("capImplReviewFilesV1 preserves a blocker-named path outside the recency window without exceeding the cap", () => {
  const files = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
  const capped = capImplReviewFilesV1(files, new Set(["f44.ts"]), 40);
  // f44.ts is the OLDEST file (last in the most-recent-first list) and would
  // normally be evicted — it survives because a blocker names it, DISPLACING
  // a recency-only entry rather than growing the result past the cap
  // (2026-08-29 review, completion blocker: "eviction can exceed 40
  // entries").
  assert.equal(capped.length, 40);
  assert.ok(capped.includes("f44.ts"));
  // f44 takes one of the 40 slots as a preserved path, so only 39 of the
  // remaining 44 recency-only entries (f0..f38) survive — f39 is the first
  // one displaced to make room.
  assert.ok(!capped.includes("f39.ts"));
});

void test("capImplReviewFilesV1 preserves original most-recent-first order for kept entries", () => {
  const files = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
  const capped = capImplReviewFilesV1(files, new Set(["f44.ts", "f10.ts"]), 40);
  assert.equal(capped.length, 40);
  // f10.ts (preserved, mid-list) still appears BEFORE f44.ts (preserved,
  // last) — preservation must not reorder the recency-first list.
  assert.ok(capped.indexOf("f10.ts") < capped.indexOf("f44.ts"));
});

void test("capImplReviewFilesV1 hard-caps even when preserved paths alone exceed maxEntries", () => {
  const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
  const allPreserved = new Set(files);
  const capped = capImplReviewFilesV1(files, allPreserved, 40);
  assert.equal(capped.length, 40);
});

void test("updateImplReviewFiles caps the accumulated set at IMPL_REVIEW_FILES_MAX_ENTRIES_V1", () => {
  const existing = Array.from({ length: IMPL_REVIEW_FILES_MAX_ENTRIES_V1 }, (_, i) => `f${i}.ts`);
  const progress = makeProgress(existing);
  const updated = updateImplReviewFiles(progress, ["new.ts"]);
  assert.equal(updated.implReviewFiles?.length, IMPL_REVIEW_FILES_MAX_ENTRIES_V1);
  assert.equal(updated.implReviewFiles?.[0], "new.ts");
  // The single oldest file is the one evicted to make room for the new one.
  assert.ok(!updated.implReviewFiles?.includes(`f${IMPL_REVIEW_FILES_MAX_ENTRIES_V1 - 1}.ts`));
});

void test("updateImplReviewFiles preserves a blocker-named path when eviction would otherwise drop it", () => {
  const existing = Array.from({ length: IMPL_REVIEW_FILES_MAX_ENTRIES_V1 }, (_, i) => `f${i}.ts`);
  const oldestPath = `f${IMPL_REVIEW_FILES_MAX_ENTRIES_V1 - 1}.ts`;
  const progress = makeProgress(existing);
  const updated = updateImplReviewFiles(progress, ["new.ts"], new Set([oldestPath]));
  assert.ok(updated.implReviewFiles?.includes(oldestPath));
});

// ---------------------------------------------------------------------------
// latestReviewBlockerNamedPathsV1 (item 9, Part 16 step 42)
// ---------------------------------------------------------------------------

void test("latestReviewBlockerNamedPathsV1 returns an empty set with no review history", () => {
  const progress = makeProgress(undefined);
  assert.deepEqual(latestReviewBlockerNamedPathsV1(progress), new Set());
});

void test("latestReviewBlockerNamedPathsV1 extracts backtick-quoted paths from the most recent entry's blockers", () => {
  const progress: TaskProgress = {
    ...makeProgress(undefined),
    reviewScoreHistory: [
      {
        stage: "impl-high-review",
        score: 6,
        attemptId: "a1",
        at: "2026-08-20T00:00:00.000Z",
        blockerCount: 1,
        taskFixableCount: 1,
        blockers: [
          {
            category: "completion",
            resolver: "task-fixable",
            subject: "old.ts",
            description: "the guard in `src/old.ts` is wrong",
          },
        ],
      },
      {
        stage: "impl-high-review",
        score: 6,
        attemptId: "a2",
        at: "2026-08-21T00:00:00.000Z",
        blockerCount: 2,
        taskFixableCount: 2,
        blockers: [
          {
            category: "completion",
            resolver: "task-fixable",
            subject: "new.ts",
            description: "see `src/new.ts:42` for the missing guard",
          },
          {
            category: "completion",
            resolver: "task-fixable",
            subject: "prose-only",
            description: "no path named here at all",
          },
        ],
      },
    ],
  };
  assert.deepEqual(latestReviewBlockerNamedPathsV1(progress), new Set(["src/new.ts"]));
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

// ---------------------------------------------------------------------------
// recordTaskMdSizeBandAnnouncedV1 (item 9, Part 16 step 44): durable,
// monotonic "once per band" marker — must survive bounded chat-history
// compaction, unlike the prior chat-scan approach.
// ---------------------------------------------------------------------------

void test("recordTaskMdSizeBandAnnouncedV1 records a fresh band from unset", () => {
  const progress = makeProgress(undefined);
  const updated = recordTaskMdSizeBandAnnouncedV1(progress, 2);
  assert.equal(updated.taskMdSizeBandAnnounced, 2);
});

void test("recordTaskMdSizeBandAnnouncedV1 is a no-op for a band no higher than the recorded one", () => {
  const progress: TaskProgress = { ...makeProgress(undefined), taskMdSizeBandAnnounced: 3 };
  const same = recordTaskMdSizeBandAnnouncedV1(progress, 3);
  assert.strictEqual(same, progress);
  const lower = recordTaskMdSizeBandAnnouncedV1(progress, 1);
  assert.strictEqual(lower, progress);
});

void test("recordTaskMdSizeBandAnnouncedV1 advances to a strictly higher band", () => {
  const progress: TaskProgress = { ...makeProgress(undefined), taskMdSizeBandAnnounced: 1 };
  const updated = recordTaskMdSizeBandAnnouncedV1(progress, 3);
  assert.equal(updated.taskMdSizeBandAnnounced, 3);
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

// ---------------------------------------------------------------------------
// appendBlockerSupersession: durable chat-resolved-blocker trail (wf10 item 19)
// ---------------------------------------------------------------------------

function supersessionEntry(overrides: Partial<BlockerSupersessionRecordV1> = {}): BlockerSupersessionRecordV1 {
  return {
    stage: "plan-high-review",
    blockerDescription: "the owner must approve a complete tie policy",
    supersededAt: "2026-07-07T00:00:00.000Z",
    planRelPath: "plan.md",
    ...overrides,
  };
}

void test("appendBlockerSupersession records the resolved blocker without touching reviewRejections or reviewScoreHistory", () => {
  const progress = { ...makeProgress(), reviewScoreHistory: [historyEntry()] };
  const updated = appendBlockerSupersession(progress, supersessionEntry());
  assert.deepEqual(updated.blockerSupersessions, [supersessionEntry()]);
  assert.deepEqual(updated.reviewScoreHistory, [historyEntry()]);
  assert.equal(updated.reviewRejections, undefined);
});

void test("appendBlockerSupersession preserves prior entries in order", () => {
  const progress = { ...makeProgress(), blockerSupersessions: [supersessionEntry({ planRelPath: "plan-old.md" })] };
  const updated = appendBlockerSupersession(progress, supersessionEntry({ planRelPath: "plan.md" }));
  assert.deepEqual(
    updated.blockerSupersessions?.map((e) => e.planRelPath),
    ["plan-old.md", "plan.md"]
  );
});

void test("appendBlockerSupersession caps at MAX_BLOCKER_SUPERSESSIONS, dropping the oldest first", () => {
  const existing = Array.from({ length: MAX_BLOCKER_SUPERSESSIONS }, (_, i) =>
    supersessionEntry({ blockerDescription: `blocker-${i}` })
  );
  const progress = { ...makeProgress(), blockerSupersessions: existing };
  const updated = appendBlockerSupersession(progress, supersessionEntry({ blockerDescription: "blocker-new" }));
  assert.equal(updated.blockerSupersessions?.length, MAX_BLOCKER_SUPERSESSIONS);
  assert.equal(updated.blockerSupersessions?.[0]?.blockerDescription, "blocker-1", "the single oldest entry must be dropped");
  assert.equal(updated.blockerSupersessions?.at(-1)?.blockerDescription, "blocker-new");
});

// ---------------------------------------------------------------------------
// appendRoundOutcome: durable round-outcome classification trail (wf10 item 4 / Part 4)
// ---------------------------------------------------------------------------

function roundOutcomeEntry(overrides: Partial<RoundOutcomeEntryV1> = {}): RoundOutcomeEntryV1 {
  return {
    stage: "impl",
    classification: "provider-failure-empty",
    at: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

void test("appendRoundOutcome records the classification without touching reviewRejections or reviewScoreHistory", () => {
  const progress = { ...makeProgress(), reviewScoreHistory: [historyEntry()] };
  const updated = appendRoundOutcome(progress, roundOutcomeEntry());
  assert.deepEqual(updated.roundOutcomes, [roundOutcomeEntry()]);
  assert.deepEqual(updated.reviewScoreHistory, [historyEntry()]);
  assert.equal(updated.reviewRejections, undefined);
});

void test("appendRoundOutcome preserves prior entries in order", () => {
  const progress = { ...makeProgress(), roundOutcomes: [roundOutcomeEntry({ classification: "genuine-no-op" })] };
  const updated = appendRoundOutcome(progress, roundOutcomeEntry({ classification: "edits-produced" }));
  assert.deepEqual(
    updated.roundOutcomes?.map((e) => e.classification),
    ["genuine-no-op", "edits-produced"]
  );
});

void test("appendRoundOutcome caps at MAX_ROUND_OUTCOMES, dropping the oldest first", () => {
  const existing = Array.from({ length: MAX_ROUND_OUTCOMES }, (_, i) =>
    roundOutcomeEntry({ attemptId: `attempt-${i}` })
  );
  const progress = { ...makeProgress(), roundOutcomes: existing };
  const updated = appendRoundOutcome(progress, roundOutcomeEntry({ attemptId: "attempt-new" }));
  assert.equal(updated.roundOutcomes?.length, MAX_ROUND_OUTCOMES);
  assert.equal(updated.roundOutcomes?.[0]?.attemptId, "attempt-1", "the single oldest entry must be dropped");
  assert.equal(updated.roundOutcomes?.at(-1)?.attemptId, "attempt-new");
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

void test("recordImplementationTypeCheckFailure sets the field (2g)", () => {
  const progress = makeProgress();
  const failure = { at: "2026-08-07T00:00:00.000Z", output: "TS2322: fake type error" };
  const updated = recordImplementationTypeCheckFailure(progress, failure);
  assert.deepEqual(updated.implementationTypeCheckFailure, failure);
});

void test("clearImplementationTypeCheckFailure removes a recorded failure (2g)", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    implementationTypeCheckFailure: { at: "2026-08-07T00:00:00.000Z", output: "TS2322: fake type error" },
  };
  const updated = clearImplementationTypeCheckFailure(progress);
  assert.equal(updated.implementationTypeCheckFailure, undefined);
});

void test("clearImplementationTypeCheckFailure is a no-op (same reference) when nothing is recorded", () => {
  const progress = makeProgress();
  assert.strictEqual(clearImplementationTypeCheckFailure(progress), progress);
});


// ---------------------------------------------------------------------------
// Multi-round accumulation (2026-08-07 live escalation). A plan now
// legitimately spans many implementation rounds, so review scope must be
// everything the task built — not the last round's slice.
//
// Observed: after a 25-step plan finished, impl-low-review saw only 9 files,
// could not source-verify ~20 of 25 plan items, and raised a
// review-confidence blocker no implementation round could clear (nothing was
// wrong to fix). Three zero-change rounds later the no-progress breaker
// escalated. reviewActions.ts's write site had been REPLACING this field
// while the helper it bypassed unions.
// ---------------------------------------------------------------------------

void test("accumulates across many rounds instead of keeping only the last", () => {
  let progress = makeProgress();
  progress = updateImplReviewFiles(progress, ["round1.ts"]);
  progress = updateImplReviewFiles(progress, ["round2.ts"]);
  progress = updateImplReviewFiles(progress, ["round3.ts"]);
  assert.deepStrictEqual(
    [...(progress.implReviewFiles ?? [])].sort(),
    ["round1.ts", "round2.ts", "round3.ts"]
  );
});

void test("puts the newest round first so a size budget trims already-reviewed files", () => {
  // Ordering is load-bearing: the context pack truncates from the end, so
  // the current round's work — the part the reviewer has not seen yet —
  // must never be the part dropped.
  let progress = makeProgress();
  progress = updateImplReviewFiles(progress, ["older.ts"]);
  progress = updateImplReviewFiles(progress, ["newest.ts"]);
  assert.strictEqual(progress.implReviewFiles?.[0], "newest.ts");
});

void test("does not duplicate a file touched in several rounds", () => {
  let progress = makeProgress();
  progress = updateImplReviewFiles(progress, ["shared.ts", "a.ts"]);
  progress = updateImplReviewFiles(progress, ["shared.ts", "b.ts"]);
  assert.strictEqual(
    (progress.implReviewFiles ?? []).filter((f) => f === "shared.ts").length,
    1
  );
});

void test("keeps earlier rounds when a later round changes only machine-maintained files", () => {
  // The regression this guards: an inventory-only round must not shrink
  // review scope to nothing, which is how a reviewer once ended up pointed
  // at a single generated JSON file.
  let progress = makeProgress();
  progress = updateImplReviewFiles(progress, ["real-work.ts"]);
  progress = updateImplReviewFiles(progress, [
    "workflow-inventories/workflow-production-source-live-v1.json",
  ]);
  assert.deepStrictEqual(progress.implReviewFiles, ["real-work.ts"]);
});

// ---------------------------------------------------------------------------
// Stage rollback retracts completedStages (2026-08-07). Moving an ACTIVE task
// backwards — Set Stage as Current, or correcting a stage that advanced too
// early — used to leave completedStages claiming the re-entered stage and
// every later one were still finished. taskProgressFieldPolicyV1's reopen path
// already retracts correctly, but it is gated on status === "completed", so it
// never covered an active rollback. That gap was hit twice in one day and both
// times needed task-progress.json edited by hand.
// ---------------------------------------------------------------------------

void test("rolling back an active task retracts the re-entered stage and everything after it", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    currentStage: "publish",
    completedStages: ["desc", "plan", "plan-high-review", "plan-low-review", "impl", "impl-high-review", "impl-low-review"],
  };
  const rolled = updateTaskProgressStage(progress, "impl-high-review");
  assert.strictEqual(rolled.currentStage, "impl-high-review");
  assert.deepStrictEqual(rolled.completedStages, [
    "desc",
    "plan",
    "plan-high-review",
    "plan-low-review",
    "impl",
  ]);
});

void test("a stage is never both current and completed after a rollback", () => {
  const progress: TaskProgress = {
    ...makeProgress(),
    currentStage: "impl-low-review",
    completedStages: ["desc", "plan", "impl", "impl-high-review"],
  };
  const rolled = updateTaskProgressStage(progress, "impl-high-review");
  assert.ok(
    !(rolled.completedStages ?? []).includes("impl-high-review"),
    "the stage being re-entered must not still be listed as completed"
  );
});

void test("moving FORWARD leaves completedStages untouched", () => {
  // Only the backwards direction retracts; normal advancement is handled by
  // the stage-transition path that adds to the list.
  const completed: TaskStage[] = ["desc", "plan", "impl"];
  const progress: TaskProgress = {
    ...makeProgress(),
    currentStage: "impl",
    completedStages: completed,
  };
  const advanced = updateTaskProgressStage(progress, "impl-high-review");
  assert.deepStrictEqual(advanced.completedStages, completed);
});

void test("re-setting the same stage changes nothing about completion", () => {
  const completed: TaskStage[] = ["desc", "plan"];
  const progress: TaskProgress = {
    ...makeProgress(),
    currentStage: "impl",
    completedStages: completed,
  };
  const same = updateTaskProgressStage(progress, "impl");
  assert.deepStrictEqual(same.completedStages, completed);
});

void test("a task with no completedStages survives a rollback", () => {
  const progress: TaskProgress = { ...makeProgress(), currentStage: "impl-high-review" };
  const rolled = updateTaskProgressStage(progress, "impl");
  assert.strictEqual(rolled.currentStage, "impl");
  assert.strictEqual(rolled.completedStages, undefined);
});

// A rollback deliberately PRESERVES implReviewFiles, diverging from the
// completed-task reopen path (whose policy is "otherwise []"). Reopen restarts
// a finished task, so the old changed-file list is history. An active rollback
// is a mid-flight correction — usually "go back to impl and build more" — and
// that list is the accumulated review scope for everything built so far.
// Clearing it would leave the next review seeing only the following round's
// files, which is the blindness that stalled the workflow task on 2026-08-07.

void test("rolling back to impl preserves accumulated implReviewFiles (unlike reopen)", () => {
  const accumulated = ["a.ts", "b.ts", "c.ts"];
  const progress: TaskProgress = {
    ...makeProgress(accumulated),
    currentStage: "impl-high-review",
    completedStages: ["desc", "plan", "impl"],
  };
  const rolled = updateTaskProgressStage(progress, "impl");
  assert.deepStrictEqual(
    rolled.implReviewFiles,
    accumulated,
    "review scope built over earlier rounds must survive a mid-flight rollback"
  );
});

void test("rolling back to a stage before impl also preserves review scope", () => {
  // Even here the task is still active and mid-flight; reopen's "clear it"
  // rule applies to restarting a COMPLETED task, not to this transition.
  const accumulated = ["a.ts", "b.ts"];
  const progress: TaskProgress = {
    ...makeProgress(accumulated),
    currentStage: "impl-high-review",
    completedStages: ["desc", "plan", "impl"],
  };
  const rolled = updateTaskProgressStage(progress, "plan");
  assert.deepStrictEqual(rolled.implReviewFiles, accumulated);
  assert.deepStrictEqual(rolled.completedStages, ["desc"]);
});

// ---------------------------------------------------------------------------
// setZeroChangeImplRounds: durable no-progress-breaker counter (step 8)
// ---------------------------------------------------------------------------

void test("setZeroChangeImplRounds sets the counter to the given value", () => {
  const progress = makeProgress();
  const updated = setZeroChangeImplRounds(progress, 3);
  assert.equal(updated.zeroChangeImplRounds, 3);
});

void test("setZeroChangeImplRounds(undefined) clears a previously set counter", () => {
  const progress = { ...makeProgress(), zeroChangeImplRounds: 5 };
  const updated = setZeroChangeImplRounds(progress, undefined);
  assert.equal(updated.zeroChangeImplRounds, undefined);
});

void test("setZeroChangeImplRounds bumps updatedAt", () => {
  const progress = makeProgress();
  const updated = setZeroChangeImplRounds(progress, 1);
  assert.notEqual(updated.updatedAt, progress.updatedAt);
});

void test("setZeroChangeImplRounds does not disturb unrelated fields", () => {
  const progress = { ...makeProgress(["a.ts"]), currentStage: "impl-high-review" as const };
  const updated = setZeroChangeImplRounds(progress, 2);
  assert.deepEqual(updated.implReviewFiles, ["a.ts"]);
  assert.equal(updated.currentStage, "impl-high-review");
});

// ---------------------------------------------------------------------------
// Incomplete-round quarantine / promotion (deferred-round detection, 2026-08-13
// report item 1): a detected round's delta lands in pendingImplReviewFiles —
// never implReviewFiles — and a later successful round promotes it.
// ---------------------------------------------------------------------------

void test("quarantinePendingImplReviewFiles records the delta without touching implReviewFiles", () => {
  const progress = makeProgress(["reviewed.ts"]);
  const updated = quarantinePendingImplReviewFiles(progress, ["a.ts", "b.ts"]);
  assert.deepEqual(updated.pendingImplReviewFiles, ["a.ts", "b.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["reviewed.ts"]);
});

void test("consecutive incomplete rounds accumulate into the quarantine (union, newest first)", () => {
  const progress = { ...makeProgress(), pendingImplReviewFiles: ["a.ts", "b.ts"] };
  const updated = quarantinePendingImplReviewFiles(progress, ["b.ts", "c.ts"]);
  assert.deepEqual(updated.pendingImplReviewFiles, ["b.ts", "c.ts", "a.ts"]);
});

void test("quarantine applies the machine-maintained-path filter like updateImplReviewFiles", () => {
  const progress = makeProgress();
  const updated = quarantinePendingImplReviewFiles(progress, [
    "src/a.ts",
    "workflow-inventories/workflow-route-baseline-v1.json",
  ]);
  assert.deepEqual(updated.pendingImplReviewFiles, ["src/a.ts"]);
});

void test("quarantining an empty (or all-filtered) delta leaves progress untouched", () => {
  const progress = makeProgress();
  assert.equal(quarantinePendingImplReviewFiles(progress, []), progress);
});

void test("promotePendingImplReviewFiles unions the pending set into implReviewFiles and clears it", () => {
  const progress = {
    ...makeProgress(["reviewed.ts"]),
    pendingImplReviewFiles: ["a.ts", "b.ts"],
    incompleteRoundContinuations: 2,
  };
  const promoted = promotePendingImplReviewFiles(progress);
  assert.deepEqual(promoted.implReviewFiles, ["a.ts", "b.ts", "reviewed.ts"]);
  assert.equal(promoted.pendingImplReviewFiles, undefined);
  assert.equal(promoted.incompleteRoundContinuations, undefined);
});

void test("promotePendingImplReviewFiles with nothing pending is a no-op returning the same object", () => {
  const progress = makeProgress(["reviewed.ts"]);
  assert.equal(promotePendingImplReviewFiles(progress), progress);
});

void test("promotePendingImplReviewFiles clears a continuation counter even with no pending files", () => {
  const progress = { ...makeProgress(), incompleteRoundContinuations: 1 };
  const promoted = promotePendingImplReviewFiles(progress);
  assert.equal(promoted.incompleteRoundContinuations, undefined);
  assert.equal(promoted.pendingImplReviewFiles, undefined);
});

// ---------------------------------------------------------------------------
// reviewInvalidatedByRound marker: durable "this review no longer describes
// the workspace" record, set by a detected round and cleared only after
// replacement review-tracking state persists.
// ---------------------------------------------------------------------------

void test("recordReviewInvalidatedByRound stamps the stage and a timestamp", () => {
  const progress = makeProgress();
  const updated = recordReviewInvalidatedByRound(progress, "impl-high-review");
  assert.equal(updated.reviewInvalidatedByRound?.stage, "impl-high-review");
  assert.ok(updated.reviewInvalidatedByRound?.at);
});

void test("clearReviewInvalidatedByRound removes the marker; no-op when absent", () => {
  const progress = makeProgress();
  const marked = recordReviewInvalidatedByRound(progress, "impl-low-review");
  const cleared = clearReviewInvalidatedByRound(marked);
  assert.equal(cleared.reviewInvalidatedByRound, undefined);
  assert.equal(clearReviewInvalidatedByRound(progress), progress);
});

// ---------------------------------------------------------------------------
// markChecklistChangeProposalAdoptedV1: the proposal-adoption write and the
// mutating round's roundLedger annotation now happen in this ONE pure
// transform (2026-08-28 review fix, completion blocker: "the separate
// best-effort write may fail or no-op after the originating row is pruned —
// adoption may be marked durable on the proposal while the required ledger
// record remains absent"). Moved here from roundLedgerV1.test.ts's now-
// removed `recordChecklistRevisionOnRoundLedgerV1` coverage: same three
// behaviors, now exercised as one atomic transform instead of two
// independently-racing writes.
// ---------------------------------------------------------------------------

function makeRevisingProposal(overrides?: Partial<ChecklistChangeProposalV1>): ChecklistChangeProposalV1 {
  return {
    at: "2026-08-27T23:05:00.000Z",
    roundId: "mutating-round-1",
    stage: "impl",
    kind: "added",
    proposedItems: ["Add the retry button"],
    removedItems: [],
    status: "revising",
    ...overrides,
  };
}

function makeMutatingRow(overrides?: Partial<RoundLedgerEntryV1>): RoundLedgerEntryV1 {
  return {
    roundId: "mutating-round-1",
    intentId: "mutating-round-1",
    attemptIds: [],
    stage: "impl",
    mode: "implementation",
    startedAt: "2026-08-27T23:00:00.000Z",
    endedAt: "2026-08-27T23:05:00.000Z",
    state: "rejected",
    outcome: { rejectionReason: "checklist mutation reverted" },
    ...overrides,
  };
}

void test(
  "marks the proposal adopted AND annotates the mutating round's roundLedger row, atomically",
  () => {
    const row = makeMutatingRow();
    const progress: TaskProgress = {
      ...makeProgress(),
      checklistChangeProposals: [makeRevisingProposal()],
      roundLedger: [row],
    };
    const updated = markChecklistChangeProposalAdoptedV1(progress, "2026-08-27T23:05:00.000Z", {
      resolvedAt: "2026-01-02T00:00:00.000Z",
      itemCountBefore: 80,
      itemCountAfter: 85,
    });

    const proposal = updated.checklistChangeProposals?.find((p) => p.at === "2026-08-27T23:05:00.000Z");
    assert.equal(proposal?.status, "adopted");
    assert.equal(proposal?.ledgerAnnotated, true);

    const updatedRow = updated.roundLedger?.find((r) => r.roundId === "mutating-round-1");
    assert.deepEqual(updatedRow?.checklistRevisionAdopted, {
      resolvedAt: "2026-01-02T00:00:00.000Z",
      itemCountBefore: 80,
      itemCountAfter: 85,
    });
    // The row's own frozen terminal facts must survive untouched.
    assert.equal(updatedRow?.state, "rejected");
    assert.equal(updatedRow?.outcome?.rejectionReason, "checklist mutation reverted");
  }
);

void test(
  "reconstructs and annotates the mutating round's ledger event when its original row was pruned",
  () => {
    const progress: TaskProgress = {
      ...makeProgress(),
      checklistChangeProposals: [makeRevisingProposal({ roundId: "long-gone-round" })],
      roundLedger: [],
    };
    const updated = markChecklistChangeProposalAdoptedV1(progress, "2026-08-27T23:05:00.000Z", {
      resolvedAt: "2026-01-02T00:00:00.000Z",
    });

    const proposal = updated.checklistChangeProposals?.find((p) => p.at === "2026-08-27T23:05:00.000Z");
    assert.equal(proposal?.status, "adopted");
    assert.equal(proposal?.ledgerAnnotated, true);
    const reconstructed = updated.roundLedger?.find((row) => row.roundId === "long-gone-round");
    assert.equal(reconstructed?.state, "rejected");
    assert.equal(reconstructed?.outcome?.rejectionReason, "checklist mutation reverted");
    assert.equal(reconstructed?.checklistRevisionAdopted?.resolvedAt, "2026-01-02T00:00:00.000Z");
  }
);

void test("never reassigns an already-set checklistRevisionAdopted", () => {
  const row = makeMutatingRow({
    checklistRevisionAdopted: { resolvedAt: "2026-01-02T00:00:00.000Z", itemCountBefore: 80, itemCountAfter: 85 },
  });
  const progress: TaskProgress = {
    ...makeProgress(),
    checklistChangeProposals: [makeRevisingProposal()],
    roundLedger: [row],
  };
  const updated = markChecklistChangeProposalAdoptedV1(progress, "2026-08-27T23:05:00.000Z", {
    resolvedAt: "2026-05-05T00:00:00.000Z",
    itemCountBefore: 1,
    itemCountAfter: 2,
  });

  const updatedRow = updated.roundLedger?.find((r) => r.roundId === "mutating-round-1");
  assert.equal(updatedRow?.checklistRevisionAdopted?.resolvedAt, "2026-01-02T00:00:00.000Z");
  // The proposal itself still records its OWN resolution facts, distinct
  // from the (already-set, untouched) row annotation.
  const proposal = updated.checklistChangeProposals?.find((p) => p.at === "2026-08-27T23:05:00.000Z");
  assert.equal(proposal?.resolvedAt, "2026-05-05T00:00:00.000Z");
  assert.equal(proposal?.ledgerAnnotated, true, "already-annotated counts as annotated");
});

// ---------------------------------------------------------------------------
// appendChecklistChangeProposal cap eviction (2026-08-28 review fix,
// completion blocker: "ordinary ledger-cap eviction is prevented, but
// plan-revision adoption can still lack its required ledger completion event
// when ... the active proposal record is unavailable" — the proposal cap
// itself could evict the one entry naming the round-ledger row that
// `upsertRoundLedgerEntryV1`'s own protection depends on). Mirrors that same
// round-ledger over-cap test's shape: fill to the cap, push one more, and
// prove the unresolved entry survives while a resolved one is dropped first.
// ---------------------------------------------------------------------------

void test(
  "protects a pending/revising proposal from cap eviction, dropping a resolved one first",
  () => {
    const resolved = makeRevisingProposal({
      at: "2026-01-01T00:00:00.000Z",
      roundId: "resolved-round-0",
      status: "adopted",
    });
    const others = Array.from({ length: MAX_CHECKLIST_CHANGE_PROPOSALS - 2 }, (_, i) =>
      makeRevisingProposal({
        at: `2026-01-01T00:${String(i + 1).padStart(2, "0")}:00.000Z`,
        roundId: `filler-round-${i}`,
        status: "discarded",
      })
    );
    const pending = makeRevisingProposal({
      at: "2026-08-27T23:05:00.000Z",
      roundId: "mutating-round-1",
      status: "revising",
    });
    let progress: TaskProgress = {
      ...makeProgress(),
      checklistChangeProposals: [resolved, ...others, pending],
    };
    assert.equal(progress.checklistChangeProposals?.length, MAX_CHECKLIST_CHANGE_PROPOSALS);

    const pushedOver = appendChecklistChangeProposal(
      progress,
      makeRevisingProposal({ at: "2026-08-28T00:00:00.000Z", roundId: "new-round" })
    );

    assert.equal(pushedOver.checklistChangeProposals?.length, MAX_CHECKLIST_CHANGE_PROPOSALS);
    assert.ok(
      pushedOver.checklistChangeProposals?.some((p) => p.at === "2026-08-27T23:05:00.000Z" && p.status === "revising"),
      "the unresolved proposal must survive cap eviction"
    );
    assert.ok(
      pushedOver.checklistChangeProposals?.some((p) => p.at === "2026-08-28T00:00:00.000Z"),
      "the newly appended proposal must be present"
    );
    assert.ok(
      !pushedOver.checklistChangeProposals?.some((p) => p.at === "2026-01-01T00:00:00.000Z"),
      "the oldest RESOLVED proposal must be dropped first, not the pending one"
    );
    progress = pushedOver;
  }
);

void test("leaves the array over cap rather than evicting an unresolved proposal when nothing resolved remains", () => {
  const allPending = Array.from({ length: MAX_CHECKLIST_CHANGE_PROPOSALS }, (_, i) =>
    makeRevisingProposal({
      at: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      roundId: `live-round-${i}`,
      status: "revising",
    })
  );
  const progress: TaskProgress = { ...makeProgress(), checklistChangeProposals: allPending };
  const pushedOver = appendChecklistChangeProposal(
    progress,
    makeRevisingProposal({ at: "2026-08-28T00:00:00.000Z", roundId: "new-round" })
  );
  assert.equal(pushedOver.checklistChangeProposals?.length, MAX_CHECKLIST_CHANGE_PROPOSALS + 1);
});

void test("setIncompleteRoundContinuations sets and clears the persisted counter", () => {
  const progress = makeProgress();
  const set = setIncompleteRoundContinuations(progress, 2);
  assert.equal(set.incompleteRoundContinuations, 2);
  const cleared = setIncompleteRoundContinuations(set, undefined);
  assert.equal(cleared.incompleteRoundContinuations, undefined);
});
