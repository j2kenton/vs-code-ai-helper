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
  __resetFastForwardRunsForTestV1,
  clearFastForwardRunActiveV1,
  clearFastForwardRunPausedProvenanceV1,
  getFastForwardRunEpochV1,
  getFastForwardRunStateV1,
  getFastForwardSessionIdV1,
  isFastForwardRunActiveV1,
  isFastForwardRunPausedProvenanceCurrentV1,
  markFastForwardRunActiveV1,
  recordFastForwardRunPausedV1,
  stampFastForwardResumeProvenanceV1,
  updateFastForwardRunStateV1,
} from "../utils/activeFastForwardRunsV1";
import * as vscode from "vscode";

import { computeFastForwardResumeBudgetV1 } from "../commands/reviewActions";
import { improveReviewScore } from "../utils/reviewScoreLoop";
import { isFastForwardResumeStateTrustedV1 } from "../commands/fastForwardResumeSuffixV1";

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

void describe("activeFastForwardRunsV1 — session id and run epoch (RC3 item 4, Step 3 completion fix)", () => {
  void it("getFastForwardRunEpochV1 is 0 for a folder that has never been marked active", () => {
    assert.equal(getFastForwardRunEpochV1("/fake/task-ff-never-active"), 0);
  });

  void it("getFastForwardRunEpochV1 increments once per markFastForwardRunActiveV1 call and never decrements when the run ends", () => {
    const folder = "/fake/task-ff-epoch-increments";
    markFastForwardRunActiveV1(folder, { attemptNumber: 0, maxAttempts: 5 });
    const first = getFastForwardRunEpochV1(folder);
    clearFastForwardRunActiveV1(folder);
    assert.equal(getFastForwardRunEpochV1(folder), first, "clearing an ended run must not reset its epoch");
    markFastForwardRunActiveV1(folder, { attemptNumber: 0, maxAttempts: 5 });
    assert.equal(getFastForwardRunEpochV1(folder), first + 1, "a NEW run must bump the epoch");
    clearFastForwardRunActiveV1(folder);
  });

  void it("getFastForwardSessionIdV1 is stable across unrelated calls", () => {
    assert.equal(getFastForwardSessionIdV1(), getFastForwardSessionIdV1());
  });

  void it("__resetFastForwardRunsForTestV1 mints a fresh session id and clears active runs/epochs, simulating a restart", () => {
    const folder = "/fake/task-ff-restart-sim";
    const before = getFastForwardSessionIdV1();
    markFastForwardRunActiveV1(folder, { attemptNumber: 1, maxAttempts: 3 });
    try {
      __resetFastForwardRunsForTestV1();
      assert.notEqual(getFastForwardSessionIdV1(), before);
      assert.equal(getFastForwardRunEpochV1(folder), 0);
      assert.equal(isFastForwardRunActiveV1(folder), false);
    } finally {
      // Nothing to clear — the reset already cleared it.
    }
  });
});

void describe("activeFastForwardRunsV1 — pause provenance (review-flagged completion fix, round 2, 2026-09-30)", () => {
  void it("has no pause record for a folder that has never had a run marked active", () => {
    assert.equal(isFastForwardRunPausedProvenanceCurrentV1("/fake/task-pause-never", "any-session", 1), false);
  });

  void it("records and matches the exact session/epoch a run was active at when it paused", () => {
    const folder = "/fake/task-pause-record";
    markFastForwardRunActiveV1(folder, { attemptNumber: 1, maxAttempts: 4 });
    try {
      const { fastForwardSessionIdV1, fastForwardRunEpochV1 } = stampFastForwardResumeProvenanceV1(folder);
      recordFastForwardRunPausedV1(folder);
      assert.equal(
        isFastForwardRunPausedProvenanceCurrentV1(folder, fastForwardSessionIdV1, fastForwardRunEpochV1),
        true
      );
    } finally {
      clearFastForwardRunActiveV1(folder);
      clearFastForwardRunPausedProvenanceV1(folder);
    }
  });

  void it("clearFastForwardRunPausedProvenanceV1 invalidates a recorded pause (the run ended for an unrelated reason)", () => {
    const folder = "/fake/task-pause-clear";
    markFastForwardRunActiveV1(folder, { attemptNumber: 1, maxAttempts: 4 });
    const provenance = stampFastForwardResumeProvenanceV1(folder);
    recordFastForwardRunPausedV1(folder);
    clearFastForwardRunActiveV1(folder);
    clearFastForwardRunPausedProvenanceV1(folder);
    assert.equal(
      isFastForwardRunPausedProvenanceCurrentV1(folder, provenance.fastForwardSessionIdV1, provenance.fastForwardRunEpochV1),
      false
    );
  });

  void it("markFastForwardRunActiveV1 (a new run starting) invalidates any pause record left by a prior run for the same folder", () => {
    const folder = "/fake/task-pause-superseded";
    markFastForwardRunActiveV1(folder, { attemptNumber: 1, maxAttempts: 4 });
    const firstRun = stampFastForwardResumeProvenanceV1(folder);
    recordFastForwardRunPausedV1(folder);
    clearFastForwardRunActiveV1(folder);
    // A different run starts for the same folder.
    markFastForwardRunActiveV1(folder, { attemptNumber: 0, maxAttempts: 4 });
    try {
      assert.equal(
        isFastForwardRunPausedProvenanceCurrentV1(folder, firstRun.fastForwardSessionIdV1, firstRun.fastForwardRunEpochV1),
        false
      );
    } finally {
      clearFastForwardRunActiveV1(folder);
      clearFastForwardRunPausedProvenanceV1(folder);
    }
  });
});

void describe("isFastForwardResumeStateTrustedV1 (RC3 item 4, Step 3 completion fix)", () => {
  void it("is never trusted when state is undefined", () => {
    assert.equal(isFastForwardResumeStateTrustedV1(undefined, "/fake/task-trust-undefined"), false);
  });

  void it("distrusts a state carrying no provenance fields at all (an older, pre-fix card — indistinguishable from a legitimate one otherwise)", () => {
    assert.equal(
      isFastForwardResumeStateTrustedV1({ attemptNumber: 4, maxAttempts: 10 }, "/fake/task-trust-legacy"),
      false
    );
  });

  void it("trusts a state whose session id and run epoch still match the current values, and whose pause is still on record", () => {
    const folder = "/fake/task-trust-matching";
    markFastForwardRunActiveV1(folder, { attemptNumber: 2, maxAttempts: 6 });
    try {
      const state = {
        attemptNumber: 2,
        maxAttempts: 6,
        fastForwardSessionIdV1: getFastForwardSessionIdV1(),
        fastForwardRunEpochV1: getFastForwardRunEpochV1(folder),
      };
      recordFastForwardRunPausedV1(folder);
      assert.equal(isFastForwardResumeStateTrustedV1(state, folder), true);
    } finally {
      clearFastForwardRunActiveV1(folder);
      clearFastForwardRunPausedProvenanceV1(folder);
    }
  });

  void it("distrusts a state whose session id no longer matches (a window/extension-host restart since it was captured)", () => {
    const folder = "/fake/task-trust-stale-session";
    const state = {
      attemptNumber: 2,
      maxAttempts: 6,
      fastForwardSessionIdV1: "a-session-id-from-a-previous-process",
      fastForwardRunEpochV1: getFastForwardRunEpochV1(folder),
    };
    assert.equal(isFastForwardResumeStateTrustedV1(state, folder), false);
  });

  void it("distrusts a state whose run epoch no longer matches (a different run has since started for this folder)", () => {
    const folder = "/fake/task-trust-stale-epoch";
    const state = {
      attemptNumber: 2,
      maxAttempts: 6,
      fastForwardSessionIdV1: getFastForwardSessionIdV1(),
      fastForwardRunEpochV1: getFastForwardRunEpochV1(folder) + 1,
    };
    assert.equal(isFastForwardResumeStateTrustedV1(state, folder), false);
  });

  void it("distrusts a state whose session/epoch match but whose run ended for an unrelated (non-paused) reason", () => {
    const folder = "/fake/task-trust-ended-unrelated";
    markFastForwardRunActiveV1(folder, { attemptNumber: 2, maxAttempts: 6 });
    const state = {
      attemptNumber: 2,
      maxAttempts: 6,
      // Review-flagged completion fix, round 3: `stampFastForwardResumeProvenanceV1`
      // itself now records the pause synchronously (closing the window
      // between "the card is posted" and "the pause is on record" — see its
      // doc comment), so this card starts out trusted, exactly like a real
      // one built while Fast Forward is genuinely interrupted to raise it.
      ...stampFastForwardResumeProvenanceV1(folder),
    };
    // The run then goes on to end for a reason unrelated to this card —
    // success, stalled, exhausted attempts, or an error — which is what
    // `fastForwardReviewWithAI`'s own `finally` invalidates via
    // `clearFastForwardRunPausedProvenanceV1` for every non-paused outcome.
    clearFastForwardRunActiveV1(folder);
    clearFastForwardRunPausedProvenanceV1(folder);
    assert.equal(isFastForwardResumeStateTrustedV1(state, folder), false);
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
