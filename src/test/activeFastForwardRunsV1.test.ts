/**
 * RC2 item 12, Step 26: unit coverage for the two pure pieces behind "Keep
 * iterating" resuming Fast Forward from its own interrupted iteration
 * instead of restarting a single cycle —
 *  - `activeFastForwardRunsV1.ts`'s map now carries live `attemptNumber`/
 *    `maxAttempts` counters, not just presence (Step 23);
 *  - `reviewActions.ts`'s `computeFastForwardResumeBudgetV1` is the
 *    arithmetic that hands `improveReviewScore` only the REMAINING budget
 *    while keeping the displayed total unchanged (Step 25).
 *
 * The full command-level plumbing (the plateau card carrying the resume args
 * and label; `resumeAndApplyCurrentStageActionV1` dispatching
 * `fastForwardReviewWithAI` with them) is covered end-to-end in
 * `reviewEscalation.test.ts` and `commandArgNormalization.test.ts`
 * respectively — this file covers the arithmetic those two boundaries rely
 * on without driving a full multi-round provider loop.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearFastForwardRunActiveV1,
  getFastForwardRunStateV1,
  isFastForwardRunActiveV1,
  markFastForwardRunActiveV1,
  updateFastForwardRunStateV1,
} from "../utils/activeFastForwardRunsV1";
import * as vscode from "vscode";

import { computeFastForwardResumeBudgetV1 } from "../commands/reviewActions";
import { improveReviewScore } from "../utils/reviewScoreLoop";

/** Minimal in-memory stand-in for vscode.ExtensionContext.workspaceState, matching
 * reviewScoreLoop.test.ts's own fakeContext — improveReviewScore only reads/writes
 * workspaceState (recordBestReviewScore), so nothing else needs stubbing here. */
function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
}

void describe("activeFastForwardRunsV1 — live iteration counters (RC2 item 12, Step 23)", () => {
  void it("marks a folder active with default 0/0 counters when none are supplied", () => {
    const folder = "/fake/task-ff-default";
    markFastForwardRunActiveV1(folder);
    try {
      assert.equal(isFastForwardRunActiveV1(folder), true);
      assert.deepEqual(getFastForwardRunStateV1(folder), { attemptNumber: 0, maxAttempts: 0 });
    } finally {
      clearFastForwardRunActiveV1(folder);
    }
  });

  void it("marks a folder active with the supplied counters (a resumed run's own offset/budget)", () => {
    const folder = "/fake/task-ff-resumed";
    markFastForwardRunActiveV1(folder, { attemptNumber: 4, maxAttempts: 10 });
    try {
      assert.deepEqual(getFastForwardRunStateV1(folder), { attemptNumber: 4, maxAttempts: 10 });
    } finally {
      clearFastForwardRunActiveV1(folder);
    }
  });

  void it("updateFastForwardRunStateV1 advances the counters for an already-marked-active folder", () => {
    const folder = "/fake/task-ff-update";
    markFastForwardRunActiveV1(folder, { attemptNumber: 0, maxAttempts: 5 });
    try {
      updateFastForwardRunStateV1(folder, { attemptNumber: 1, maxAttempts: 5 });
      assert.deepEqual(getFastForwardRunStateV1(folder), { attemptNumber: 1, maxAttempts: 5 });
      updateFastForwardRunStateV1(folder, { attemptNumber: 2, maxAttempts: 5 });
      assert.deepEqual(getFastForwardRunStateV1(folder), { attemptNumber: 2, maxAttempts: 5 });
    } finally {
      clearFastForwardRunActiveV1(folder);
    }
  });

  void it("updateFastForwardRunStateV1 is a no-op once the folder has been cleared", () => {
    const folder = "/fake/task-ff-cleared";
    markFastForwardRunActiveV1(folder, { attemptNumber: 0, maxAttempts: 5 });
    clearFastForwardRunActiveV1(folder);
    updateFastForwardRunStateV1(folder, { attemptNumber: 1, maxAttempts: 5 });
    assert.equal(getFastForwardRunStateV1(folder), undefined);
    assert.equal(isFastForwardRunActiveV1(folder), false);
  });

  void it("normalizes the folder path consistently, so a double-slash variant still finds the same entry", () => {
    const markedAs = "/fake//task-ff-normalize";
    const queriedAs = "/fake/task-ff-normalize";
    markFastForwardRunActiveV1(markedAs, { attemptNumber: 1, maxAttempts: 3 });
    try {
      assert.deepEqual(getFastForwardRunStateV1(queriedAs), { attemptNumber: 1, maxAttempts: 3 });
      updateFastForwardRunStateV1(queriedAs, { attemptNumber: 2, maxAttempts: 3 });
      assert.deepEqual(getFastForwardRunStateV1(markedAs), { attemptNumber: 2, maxAttempts: 3 });
    } finally {
      clearFastForwardRunActiveV1(queriedAs);
    }
  });
});

void describe("computeFastForwardResumeBudgetV1 (RC2 item 12, Step 25)", () => {
  void it("with no resume offset, uses the configured setting for both the displayed total and the loop's own budget, and reports the budget as not exhausted", () => {
    const result = computeFastForwardResumeBudgetV1(undefined, () => 8);
    assert.deepEqual(result, { maxAttempts: 8, improveReviewScoreMaxAttempts: 8, remainingBudgetExhausted: false });
  });

  void it("with a resume offset, keeps the ORIGINAL total for display but hands the loop only the REMAINING budget", () => {
    const result = computeFastForwardResumeBudgetV1(
      { attemptNumber: 4, maxAttempts: 10 },
      () => {
        throw new Error("must not consult the live setting when a resume offset is supplied");
      }
    );
    assert.deepEqual(result, { maxAttempts: 10, improveReviewScoreMaxAttempts: 6, remainingBudgetExhausted: false });
  });

  // Completion blocker fix (2026-09-28 review): when the resumed offset
  // already meets or exceeds the original total, `improveReviewScoreMaxAttempts`
  // still floors at 1 (it must remain a valid `improveReviewScore` input), but
  // `remainingBudgetExhausted` is now `true` — the caller (`fastForwardReviewWithAI`)
  // reads THAT flag, not the floored arithmetic value, to decide whether any
  // further apply/re-review cycle may run at all. Running one more attempt off
  // the floored value here would silently exceed the interrupted run's own
  // committed budget, which is exactly the defect this flag exists to prevent.
  void it("floors the arithmetic remaining budget at 1, but reports the budget as EXHAUSTED once the offset meets or exceeds the total — the caller must not run another attempt", () => {
    assert.deepEqual(
      computeFastForwardResumeBudgetV1({ attemptNumber: 10, maxAttempts: 10 }, () => 10),
      { maxAttempts: 10, improveReviewScoreMaxAttempts: 1, remainingBudgetExhausted: true }
    );
    assert.deepEqual(
      computeFastForwardResumeBudgetV1({ attemptNumber: 15, maxAttempts: 10 }, () => 10),
      { maxAttempts: 10, improveReviewScoreMaxAttempts: 1, remainingBudgetExhausted: true }
    );
  });

  void it("resuming from attempt 0 (the seed state before any apply() has run) hands the loop the full budget and is not exhausted", () => {
    assert.deepEqual(
      computeFastForwardResumeBudgetV1({ attemptNumber: 0, maxAttempts: 6 }, () => 6),
      { maxAttempts: 6, improveReviewScoreMaxAttempts: 6, remainingBudgetExhausted: false }
    );
  });

  void it("a resume offset one short of the total (exactly one attempt remains) is not exhausted", () => {
    assert.deepEqual(
      computeFastForwardResumeBudgetV1({ attemptNumber: 9, maxAttempts: 10 }, () => 10),
      { maxAttempts: 10, improveReviewScoreMaxAttempts: 1, remainingBudgetExhausted: false }
    );
  });

  // 2026-09-28 review (narrowed completion blocker): the arithmetic tests above
  // prove what `improveReviewScoreMaxAttempts` computes to, but not that the
  // REAL loop `fastForwardReviewWithAI` hands it to (`improveReviewScore`, the
  // exact function imported here) actually stops there instead of running the
  // full original total. This drives that real loop — not a fake stand-in — with
  // a non-exhausted resumed offset (4 of 10 already spent, 6 remaining) and a
  // score that never improves, so the loop is forced to run every attempt its
  // budget allows and nothing improve()-triggered can stop it early: the ONLY
  // thing that can cap `call` is `improveReviewScoreMaxAttempts` itself.
  void it("resuming below the ceiling: the real improveReviewScore loop runs exactly the remaining budget's apply/re-review cycles, not the original total", async () => {
    const resumeFromAttempt = { attemptNumber: 4, maxAttempts: 10 };
    const { improveReviewScoreMaxAttempts, remainingBudgetExhausted } = computeFastForwardResumeBudgetV1(
      resumeFromAttempt,
      () => {
        throw new Error("must not consult the live setting when a resume offset is supplied");
      }
    );
    assert.equal(remainingBudgetExhausted, false);
    assert.equal(improveReviewScoreMaxAttempts, 6, "10 - 4 already-spent attempts = 6 remaining");

    let applyCalls = 0;
    let reviewCalls = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 4,
      maxAttempts: improveReviewScoreMaxAttempts,
      apply: () => {
        applyCalls += 1;
        return Promise.resolve();
      },
      // Flat score every round: never beats baseline+1, so nothing but the
      // budget itself can end the loop — proving the cap is the remaining
      // budget (6), not the original committed total (10).
      review: () => {
        reviewCalls += 1;
        return Promise.resolve(4);
      },
    });

    assert.equal(applyCalls, 6, "must run only the REMAINING budget, not the original total of 10");
    assert.equal(reviewCalls, 6);
    assert.equal(result.attempts, 6);
    assert.equal(result.improved, false);
  });
});
