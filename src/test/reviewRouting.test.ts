import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockerIdentity,
  decideReviewRoute,
  degenerateReviewRejectionReason,
  detectBlockerSetStall,
  detectPlateau,
  REVIEW_RUBRIC_BLOCKER_SCORE_CAP,
  roundsWithoutTaskFixableDecrease,
  rubricCapLikelyBlockedAdvance,
  sameBlockerPersistsAcrossLastRounds,
  shouldEscalateChurnCeiling,
  shouldTripNoProgressBreaker,
} from "../utils/reviewRouting";
import { ReviewBlocker } from "../utils/reviewReadiness";
import { ReviewBlockerIdentity, ReviewScoreHistoryEntry } from "../types/taskProgress";

function entry(score: number | null, overrides: Partial<ReviewScoreHistoryEntry> = {}): ReviewScoreHistoryEntry {
  return {
    stage: "impl-high-review",
    score,
    attemptId: `attempt-${Math.random()}`,
    at: new Date().toISOString(),
    // Default to a round that DID carry fixable work: detectPlateau ignores
    // rounds with nothing task-fixable to act on, so a zero default would
    // filter every entry out and make the plateau cases below vacuous.
    // Tests about clean rounds override this explicitly.
    blockerCount: 1,
    taskFixableCount: 1,
    ...overrides,
  };
}

function blocker(overrides: Partial<ReviewBlocker> = {}): ReviewBlocker {
  return { category: "completion", resolver: "task-fixable", description: "x", ...overrides };
}

void describe("detectPlateau", () => {
  void it("returns false with fewer than window + 1 rounds", () => {
    const history = [entry(2), entry(5), entry(5)];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), false);
  });

  void it("returns false while the score keeps setting a new high-water mark", () => {
    // window=3: baseline round(2), then 3 rounds each improving on the prior best.
    const history = [entry(2), entry(5), entry(6), entry(7)];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), false);
  });

  void it("detects a flat plateau (the actual task 1.4 failure mode: 5,5,5,5)", () => {
    const history = [entry(2), entry(5), entry(5), entry(5), entry(5)];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), true);
  });

  void it("detects an oscillating plateau (5,6,5,6 — never sets a new high beyond 6)", () => {
    const history = [entry(2), entry(5), entry(6), entry(5), entry(6), entry(5)];
    // Baseline best before the last-3 window is max(2,5,6)=6; the last-3
    // window [6,5,6] never exceeds 6 -> plateaued.
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), true);
  });

  void it("falls back to the default window instead of permanently returning false when window is NaN", () => {
    // A malformed ensemble.reviewPlateauRounds value can reach here as NaN.
    // Array.prototype.slice coerces a NaN offset to 0, which would make the
    // "prior" comparison slice permanently empty (max = -Infinity) and this
    // function permanently return false — silently disabling the escalation
    // safety valve with no visible symptom. A clear flat plateau at the
    // default window (3) must still be detected.
    const history = [entry(2), entry(5), entry(5), entry(5), entry(5)];
    assert.strictEqual(detectPlateau(history, "impl-high-review", NaN), true);
  });

  void it("a legitimate regression alone does not falsely read as a plateau", () => {
    // 6 -> 5 (the task 1.4 run-054 regression) with nothing before it to
    // compare against is just "not enough history yet".
    const history = [entry(6), entry(5)];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), false);
  });

  void it("ignores rounds that had nothing task-fixable to act on", () => {
    // Three clean zero-blocker rounds are not evidence that iteration is
    // stuck — there was nothing for it to fix. Counting them made a
    // genuinely progressing task escalate.
    const history = [
      entry(2, { taskFixableCount: 1, blockerCount: 1 }),
      entry(5, { taskFixableCount: 0, blockerCount: 0 }),
      entry(5, { taskFixableCount: 0, blockerCount: 0 }),
      entry(5, { taskFixableCount: 0, blockerCount: 0 }),
    ];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), false);
  });

  void it("does not let clean rounds become the 'prior best' a brand-new blocker is judged against", () => {
    // Replay of task_5 on 2026-07-26: 5.8/5.9/5.9/5.9 all reported zero
    // blockers, then a single round surfaced a NEW architectural blocker at
    // 5.7 — and escalated on that blocker's first appearance, claiming
    // automated iteration had failed "across multiple rounds".
    const history = [
      entry(5.5, { taskFixableCount: 1, blockerCount: 1 }),
      entry(5.8, { taskFixableCount: 0, blockerCount: 0 }),
      entry(5.9, { taskFixableCount: 0, blockerCount: 0 }),
      entry(5.9, { taskFixableCount: 0, blockerCount: 0 }),
      entry(5.9, { taskFixableCount: 0, blockerCount: 0 }),
      entry(5.7, { taskFixableCount: 1, blockerCount: 1 }),
    ];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), false);
  });

  void it("still detects a real stall across rounds that DID carry fixable work", () => {
    // The safety valve must survive: when iteration repeatedly had something
    // to fix and the score never improved, that is a genuine plateau.
    const history = [
      entry(2, { taskFixableCount: 2, blockerCount: 2 }),
      entry(5, { taskFixableCount: 1, blockerCount: 1 }),
      entry(5, { taskFixableCount: 1, blockerCount: 1 }),
      entry(5, { taskFixableCount: 1, blockerCount: 1 }),
      entry(5, { taskFixableCount: 1, blockerCount: 1 }),
    ];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), true);
  });

  void it("ignores rounds with a null score and ignores other stages", () => {
    const history = [
      entry(2, { stage: "impl-low-review" }), // different stage — ignored
      entry(2), // baseline for impl-high-review
      entry(null), // no parseable score — ignored, not counted toward the window
      entry(5), // improves over baseline (2) — not yet a plateau
      entry(5),
      entry(5),
      entry(5), // last 3 of [5,5,5,5] never exceed the pre-window best of 5
    ];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), true);
  });
});

function identity(overrides: Partial<ReviewBlockerIdentity> = {}): ReviewBlockerIdentity {
  return { category: "completion", resolver: "task-fixable", subject: "src/app.ts", ...overrides };
}

void describe("blockerIdentity", () => {
  void it("matches drifted wording that names the same file (the jester 2026-07-30_task_1 stall)", () => {
    // The reviewer refined its prose across rounds while the underlying
    // input never changed — identity comparison must read that as the SAME
    // blocker, where a byte-for-byte comparison would read it as progress.
    const roundA = blocker({ description: "still fails in amplify/functions/shabbatCron/handler.integration.test.ts" });
    const roundB = blocker({ description: "fails during collection in amplify/functions/shabbatCron/handler.integration.test.ts" });
    assert.deepStrictEqual(blockerIdentity(roundA), blockerIdentity(roundB));
  });

  void it("distinguishes blockers about different files", () => {
    const a = blocker({ description: "type error in src/a.ts" });
    const b = blocker({ description: "type error in src/b.ts" });
    assert.notDeepStrictEqual(blockerIdentity(a), blockerIdentity(b));
  });

  void it("distinguishes the same subject under different resolvers", () => {
    const a = blocker({ description: "src/a.ts fails", resolver: "task-fixable" });
    const b = blocker({ description: "src/a.ts fails", resolver: "environmental" });
    assert.notDeepStrictEqual(blockerIdentity(a), blockerIdentity(b));
  });
});

void describe("detectBlockerSetStall", () => {
  void it("escalates on a substantively unchanged blocker set across the window", () => {
    const blockers = [identity()];
    const history = [
      entry(5, { blockers }),
      entry(5.1, { blockers }),
      entry(5, { blockers }),
      entry(5.2, { blockers }),
    ];
    // Score is climbing (5 -> 5.2 would defeat the legacy high-water test),
    // but the SET never changed — stuck.
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), true);
  });

  void it("does not escalate when the set contents change round to round (same count, real progress)", () => {
    const history = [
      entry(5, { blockers: [identity({ subject: "src/a.ts" })] }),
      entry(5, { blockers: [identity({ subject: "src/b.ts" })] }),
      entry(5, { blockers: [identity({ subject: "src/c.ts" })] }),
      entry(5, { blockers: [identity({ subject: "src/d.ts" })] }),
    ];
    // Flat score for four rounds — the legacy test would call this a
    // plateau; blocker churn shows each round resolved one and found one.
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), false);
  });

  void it("does not escalate while the set is shrinking, regardless of the score", () => {
    const history = [
      entry(7, { blockers: [identity({ subject: "a" }), identity({ subject: "b" }), identity({ subject: "c" })] }),
      entry(7, { blockers: [identity({ subject: "a" }), identity({ subject: "b" })] }),
      entry(7, { blockers: [identity({ subject: "a" })] }),
      entry(7, { blockers: [] }),
    ];
    // The jester 2026-07-11_task_2 shape: 7/10 for every round while
    // blockers fell 3 -> 0 — resolving itself, not stuck.
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), false);
  });

  void it("escalates when the set only ever grows (regressing)", () => {
    const history = [
      entry(6, { blockers: [identity({ subject: "a" })] }),
      entry(6, { blockers: [identity({ subject: "a" }), identity({ subject: "b" })] }),
      entry(6, { blockers: [identity({ subject: "a" }), identity({ subject: "b" }), identity({ subject: "c" })] }),
      entry(6, { blockers: [identity({ subject: "a" }), identity({ subject: "b" }), identity({ subject: "c" }), identity({ subject: "d" })] }),
    ];
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), true);
  });

  void it("returns false for all-empty blocker sets (healthy clean rounds are not a stall)", () => {
    const history = [
      entry(5, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
    ];
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), false);
  });

  void it("does not escalate on a blocker's FIRST appearance after clean rounds (the 2026-07-26 regression)", () => {
    // Mirror of detectPlateau's "clean rounds must not become the prior
    // best" guard: three clean rounds followed by one round surfacing a
    // brand-new blocker is NEW work, not evidence that iteration failed
    // "across multiple rounds" — nothing in the window ever had that
    // blocker to fix. The set never shrank and never changed, so without
    // the window-start guard this window reads as stuck and escalates on
    // the blocker's very first appearance.
    const history = [
      entry(5.8, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5.9, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5.9, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5.7, { blockers: [identity()] }),
    ];
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), false);
  });

  void it("still escalates once the blocker has persisted for the full window", () => {
    // The window must START with the blocker present: once the same
    // identity has survived window+1 consecutive rounds, the stall is real
    // even though the run began with clean rounds further back.
    const blockers = [identity()];
    const history = [
      entry(5.9, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5.7, { blockers }),
      entry(5.7, { blockers }),
      entry(5.8, { blockers }),
      entry(5.7, { blockers }),
    ];
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), true);
  });

  void it("falls back to the legacy score test when the window MIXES identity-carrying and older entries", () => {
    // A long-lived task fills its window with identity-carrying rounds one
    // by one; until every entry in the window carries identity data the
    // legacy detector stays in charge. Pinned so the detector switch point
    // stays deliberate rather than drifting silently.
    const mixedFlat = [
      entry(2),
      entry(5),
      entry(5), // no blockers field — legacy entry inside the window
      entry(5, { blockers: [identity()] }),
      entry(5, { blockers: [identity()] }),
    ];
    assert.strictEqual(detectBlockerSetStall(mixedFlat, "impl-high-review", 3), true);
    const mixedClimbing = [
      entry(2),
      entry(5), // legacy entry inside the window
      entry(6, { blockers: [identity()] }),
      entry(7, { blockers: [identity()] }),
    ];
    assert.strictEqual(detectBlockerSetStall(mixedClimbing, "impl-high-review", 3), false);
  });

  void it("falls back to the legacy score test when entries predate blocker identity data", () => {
    const flat = [entry(2), entry(5), entry(5), entry(5), entry(5)];
    assert.strictEqual(detectBlockerSetStall(flat, "impl-high-review", 3), true);
    const climbing = [entry(2), entry(5), entry(6), entry(7)];
    assert.strictEqual(detectBlockerSetStall(climbing, "impl-high-review", 3), false);
  });

  void it("returns false with fewer than window + 1 rounds", () => {
    const blockers = [identity()];
    const history = [entry(5, { blockers }), entry(5, { blockers }), entry(5, { blockers })];
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), false);
  });
});

void describe("roundsWithoutTaskFixableDecrease", () => {
  void it("counts trailing rounds since the last strict decrease", () => {
    const history = [
      entry(4, { taskFixableCount: 3 }),
      entry(5, { taskFixableCount: 2 }), // decrease — counting starts after this
      entry(5, { taskFixableCount: 2 }),
      entry(5, { taskFixableCount: 3 }),
      entry(5, { taskFixableCount: 3 }),
    ];
    assert.strictEqual(roundsWithoutTaskFixableDecrease(history, "impl-high-review"), 3);
  });

  void it("returns 0 when the most recent transition was a decrease", () => {
    const history = [entry(5, { taskFixableCount: 3 }), entry(5, { taskFixableCount: 1 })];
    assert.strictEqual(roundsWithoutTaskFixableDecrease(history, "impl-high-review"), 0);
  });

  void it("returns 0 without two comparable rounds", () => {
    assert.strictEqual(roundsWithoutTaskFixableDecrease([entry(5)], "impl-high-review"), 0);
    assert.strictEqual(roundsWithoutTaskFixableDecrease([], "impl-high-review"), 0);
  });

  void it("ignores rounds from other stages and unscored rounds", () => {
    const history = [
      entry(5, { taskFixableCount: 5, stage: "impl-low-review" }),
      entry(5, { taskFixableCount: 2 }),
      entry(null, { taskFixableCount: 9 }),
      entry(5, { taskFixableCount: 2 }),
    ];
    assert.strictEqual(roundsWithoutTaskFixableDecrease(history, "impl-high-review"), 1);
  });
});

void describe("shouldEscalateChurnCeiling", () => {
  // Four rounds at taskFixableCount 2 -> the trailing three transitions all
  // fail to decrease it (roundsWithoutTaskFixableDecrease = 3).
  const stagnant = [
    entry(5, { taskFixableCount: 2 }),
    entry(5, { taskFixableCount: 2 }),
    entry(5, { taskFixableCount: 2 }),
    entry(5, { taskFixableCount: 2 }),
  ];

  void it("never escalates with the flag off (churnCeilingRounds = 0) — the legacy behavior", () => {
    assert.strictEqual(
      shouldEscalateChurnCeiling({
        history: stagnant,
        stage: "impl-high-review",
        taskFixableCount: 2,
        churnCeilingRounds: 0,
      }),
      false
    );
  });

  void it("escalates once the stagnant-round run reaches the configured ceiling", () => {
    assert.strictEqual(
      shouldEscalateChurnCeiling({
        history: stagnant,
        stage: "impl-high-review",
        taskFixableCount: 2,
        churnCeilingRounds: 3,
      }),
      true
    );
  });

  void it("does not escalate before the ceiling is reached, even with the flag on", () => {
    assert.strictEqual(
      shouldEscalateChurnCeiling({
        history: stagnant,
        stage: "impl-high-review",
        taskFixableCount: 2,
        churnCeilingRounds: 4,
      }),
      false
    );
  });

  void it("catches resolve-one/raise-one churn: identities change every round, but the count never falls", () => {
    // The exact case the ceiling exists for — blocker CONTENTS change each
    // round (so the blocker-set stall detector reads it as progress), while
    // the amount of fixable work never decreases.
    const churning = [
      entry(5, { taskFixableCount: 1, blockers: [identity({ subject: "src/a.ts" })] }),
      entry(5, { taskFixableCount: 1, blockers: [identity({ subject: "src/b.ts" })] }),
      entry(5, { taskFixableCount: 1, blockers: [identity({ subject: "src/c.ts" })] }),
      entry(5, { taskFixableCount: 1, blockers: [identity({ subject: "src/d.ts" })] }),
    ];
    assert.strictEqual(detectBlockerSetStall(churning, "impl-high-review", 3), false);
    assert.strictEqual(
      shouldEscalateChurnCeiling({
        history: churning,
        stage: "impl-high-review",
        taskFixableCount: 1,
        churnCeilingRounds: 3,
      }),
      true
    );
  });

  void it("does not escalate when the just-recorded round carries no task-fixable work", () => {
    assert.strictEqual(
      shouldEscalateChurnCeiling({
        history: stagnant,
        stage: "impl-high-review",
        taskFixableCount: 0,
        churnCeilingRounds: 3,
      }),
      false
    );
  });

  void it("does not count zero-fixable rounds as churn — the round after a long stall does not immediately trip", () => {
    // 18 zero-blocker rounds (report 12's stall), then one round that finally
    // finds a real blocker. The transition INTO that blocker is not churn —
    // there is nothing to compare it against — so the ceiling must not fire
    // on this round alone.
    const zeroFixableStretch = Array.from({ length: 18 }, () =>
      entry(9, { taskFixableCount: 0, blockerCount: 0, blockers: [] })
    );
    const history = [...zeroFixableStretch, entry(6, { taskFixableCount: 1 })];
    assert.strictEqual(roundsWithoutTaskFixableDecrease(history, "impl-high-review"), 0);
    assert.strictEqual(
      shouldEscalateChurnCeiling({
        history,
        stage: "impl-high-review",
        taskFixableCount: 1,
        churnCeilingRounds: 3,
      }),
      false
    );
  });
});

void describe("sameBlockerPersistsAcrossLastRounds", () => {
  void it("is true when the last two same-stage rounds carry the same non-empty identity set", () => {
    const blockers = [identity()];
    const history = [entry(5, { blockers }), entry(5, { blockers })];
    assert.strictEqual(sameBlockerPersistsAcrossLastRounds(history), true);
  });

  void it("is false when the identity sets differ (real progress, not persistence)", () => {
    const history = [
      entry(5, { blockers: [identity({ subject: "src/a.ts" })] }),
      entry(5, { blockers: [identity({ subject: "src/b.ts" })] }),
    ];
    assert.strictEqual(sameBlockerPersistsAcrossLastRounds(history), false);
  });

  void it("is false for empty identity sets — nothing persists when nothing is blocked", () => {
    const history = [
      entry(5, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
      entry(5, { blockerCount: 0, taskFixableCount: 0, blockers: [] }),
    ];
    assert.strictEqual(sameBlockerPersistsAcrossLastRounds(history), false);
  });

  void it("falls back to equal non-zero counts when identity data is absent", () => {
    assert.strictEqual(
      sameBlockerPersistsAcrossLastRounds([
        entry(5, { blockerCount: 2, taskFixableCount: 1 }),
        entry(5, { blockerCount: 2, taskFixableCount: 1 }),
      ]),
      true
    );
    assert.strictEqual(
      sameBlockerPersistsAcrossLastRounds([
        entry(5, { blockerCount: 2, taskFixableCount: 2 }),
        entry(5, { blockerCount: 2, taskFixableCount: 1 }),
      ]),
      false
    );
  });

  void it("is false without two comparable same-stage rounds (never escalates on missing evidence)", () => {
    assert.strictEqual(sameBlockerPersistsAcrossLastRounds(undefined), false);
    assert.strictEqual(sameBlockerPersistsAcrossLastRounds([]), false);
    assert.strictEqual(sameBlockerPersistsAcrossLastRounds([entry(5)]), false);
    assert.strictEqual(
      sameBlockerPersistsAcrossLastRounds([
        entry(5, { stage: "impl-low-review" }),
        entry(5, { stage: "impl-high-review" }),
      ]),
      false
    );
  });
});

void describe("shouldTripNoProgressBreaker", () => {
  const persisting = [entry(5, { blockers: [identity()] }), entry(5, { blockers: [identity()] })];

  void it("never trips with the flag off (breakerRounds = 0) — the legacy behavior", () => {
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 99, breakerRounds: 0, history: persisting }),
      false
    );
  });

  void it("trips at the configured round count while the same blocker persists", () => {
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 3, breakerRounds: 3, history: persisting }),
      true
    );
  });

  void it("does not trip below the configured round count", () => {
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 2, breakerRounds: 3, history: persisting }),
      false
    );
  });

  void it("trips on the zero-change count alone, even when blockers report zero every round (report 11)", () => {
    // The original gate required a persisting non-empty blocker set, which
    // can never be true while the reviewer reports zero blockers — exactly
    // the shape that stalled for 18 rounds/9 hours before this fix.
    const zeroBlockers = [
      entry(9, { blockers: [], blockerCount: 0, taskFixableCount: 0 }),
      entry(9, { blockers: [], blockerCount: 0, taskFixableCount: 0 }),
    ];
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 3, breakerRounds: 3, history: zeroBlockers }),
      true
    );
  });

  void it("trips on the zero-change count alone even when the blocker situation changed across rounds", () => {
    const changing = [
      entry(5, { blockers: [identity({ subject: "src/a.ts" })] }),
      entry(5, { blockers: [identity({ subject: "src/b.ts" })] }),
    ];
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 3, breakerRounds: 3, history: changing }),
      true
    );
  });

  void it("does not trip without a durable history (still requires no crash on undefined/empty)", () => {
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 3, breakerRounds: 3, history: undefined }),
      true
    );
    assert.strictEqual(
      shouldTripNoProgressBreaker({ zeroChangeRounds: 3, breakerRounds: 3, history: [] }),
      true
    );
  });
});

void describe("degenerateReviewRejectionReason", () => {
  void it("returns null with the flag off, even for an unparseable score — the legacy behavior", () => {
    assert.strictEqual(
      degenerateReviewRejectionReason({
        rejectDegenerateReviews: false,
        score: null,
        stage: "impl-high-review",
        attemptId: "attempt-1",
      }),
      null
    );
  });

  void it("returns null for a parseable score with the flag on (the round proceeds normally)", () => {
    assert.strictEqual(
      degenerateReviewRejectionReason({
        rejectDegenerateReviews: true,
        score: 7.5,
        stage: "impl-high-review",
        attemptId: "attempt-1",
      }),
      null
    );
  });

  void it("returns a reason naming the stage and attempt for an unparseable score with the flag on", () => {
    const reason = degenerateReviewRejectionReason({
      rejectDegenerateReviews: true,
      score: null,
      stage: "impl-high-review",
      attemptId: "attempt-42",
    });
    assert.notStrictEqual(reason, null);
    assert.ok(reason!.includes("High-Level Code Review"));
    assert.ok(reason!.includes("attempt-42"));
    assert.ok(reason!.includes("excluded from the review score history"));
  });
});

void describe("decideReviewRoute", () => {
  void it("advances when score meets threshold and no task-fixable/spec-defect blockers remain", () => {
    const decision = decideReviewRoute({
      score: 9,
      threshold: 8,
      blockers: [],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "advance");
  });

  void it("advances-with-note when threshold is met but only environmental blockers remain", () => {
    const decision = decideReviewRoute({
      score: 8,
      threshold: 8,
      blockers: [blocker({ resolver: "environmental" })],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "advance-with-note");
  });

  void it("iterates when below threshold, task-fixable work remains, and no plateau yet", () => {
    const decision = decideReviewRoute({
      score: 5,
      threshold: 8,
      blockers: [blocker({ resolver: "task-fixable" })],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "iterate");
  });

  void it("iterates on the very first round even with no blockers parsed (older review, no structured signal)", () => {
    const decision = decideReviewRoute({
      score: 5,
      threshold: 8,
      blockers: [],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "iterate");
  });

  void it("requests a second opinion when plateaued with task-fixable blockers still claimed", () => {
    const decision = decideReviewRoute({
      score: 5,
      threshold: 8,
      blockers: [blocker({ resolver: "task-fixable" })],
      plateaued: true,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "second-opinion");
  });

  void it("escalates directly when plateaued and every remaining blocker is non-task-fixable (the EPERM case)", () => {
    const decision = decideReviewRoute({
      score: 6,
      threshold: 10,
      blockers: [blocker({ resolver: "environmental" }), blocker({ resolver: "unverifiable" })],
      plateaued: true,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "escalate");
  });

  void it("escalates immediately when every remaining blocker is non-task-fixable, even with no plateau yet", () => {
    // A round can reach "nothing task-fixable remains" on its very first
    // appearance (e.g. the last task-fixable item just got resolved, leaving
    // only an environmental blocker). Waiting out a full plateau window
    // first — as a stale "iterate" would — burns rounds that provably
    // cannot change the outcome, since there is nothing left for another
    // automated implementation pass to act on.
    const decision = decideReviewRoute({
      score: 4.2,
      threshold: 9,
      blockers: [blocker({ resolver: "environmental" })],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "escalate");
  });

  void it("escalates immediately when the only remaining blocker needs toolchain execution (3a)", () => {
    // needs-toolchain marks a blocker whose fix requires running the
    // project's own build/codegen — something the implementation stage
    // structurally cannot do (edit-only, Bash denied). It must route the
    // same as environmental/spec-defect, not loop forever as task-fixable.
    const decision = decideReviewRoute({
      score: 5,
      threshold: 9,
      blockers: [blocker({ resolver: "needs-toolchain" })],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "escalate");
  });

  void it("still iterates below threshold when task-fixable work remains, regardless of any environmental blocker also present", () => {
    // onlyNonFixableRemain requires ALL blockers to be non-task-fixable — a
    // mix must still iterate normally so real, fixable work keeps getting
    // attempted.
    const decision = decideReviewRoute({
      score: 5,
      threshold: 8,
      blockers: [blocker({ resolver: "task-fixable" }), blocker({ resolver: "environmental" })],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "iterate");
  });

  void it("never escalates or requests a second opinion on a zero-blocker plateau — stock-settings regression", () => {
    // Default threshold is 10 (see getAutoAdvanceScoreThreshold's fallback)
    // and the default plateau window is 3. A reviewer that consistently
    // says "9/10, no blockers" across several rounds is not stuck — 9 means
    // "ready, only trivial suggestions" per the rubric — it is only a
    // strict numeric threshold that isn't met. Escalating here previously
    // paused the task and blamed "no alternate model was available" on
    // completely healthy default settings.
    const decision = decideReviewRoute({
      score: 9,
      threshold: 10,
      blockers: [],
      plateaued: true,
      secondOpinionTriedThisPlateau: false,
    });
    assert.strictEqual(decision.route, "iterate");
  });

  void it("escalates when plateaued and a second opinion has already been tried this plateau", () => {
    const decision = decideReviewRoute({
      score: 5,
      threshold: 8,
      blockers: [blocker({ resolver: "task-fixable" })],
      plateaued: true,
      secondOpinionTriedThisPlateau: true,
    });
    assert.strictEqual(decision.route, "escalate");
  });

  void it("never advances on threshold alone when a task-fixable blocker was explicitly reported", () => {
    // A reviewer that scored >= threshold but still listed a task-fixable
    // blocker must not silently advance — that would launder a real,
    // fixable defect through a lenient score.
    const decision = decideReviewRoute({
      score: 9,
      threshold: 8,
      blockers: [blocker({ resolver: "task-fixable" })],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.notStrictEqual(decision.route, "advance");
  });
});


void describe("rubricCapLikelyBlockedAdvance", () => {
  void it("flags the mismatch: best score at the rubric cap, stop level above it", () => {
    // The exact stock-settings trap: default autoAdvanceScoreThreshold (10)
    // and this user's fastForwardStopLevel (9) both sit above the rubric's
    // structural cap (7) for as long as any blocker is reported.
    assert.strictEqual(rubricCapLikelyBlockedAdvance(7, 9), true);
    assert.strictEqual(rubricCapLikelyBlockedAdvance(REVIEW_RUBRIC_BLOCKER_SCORE_CAP, 10), true);
  });

  void it("does not flag a score below the cap for a reason unrelated to blockers", () => {
    // A low score with a stop level also below the cap is a normal
    // in-progress iteration, not the rubric/threshold deadlock.
    assert.strictEqual(rubricCapLikelyBlockedAdvance(3, 7), false);
  });

  void it("does not flag when the stop level is achievable under the cap", () => {
    assert.strictEqual(rubricCapLikelyBlockedAdvance(6, 7), false);
    assert.strictEqual(rubricCapLikelyBlockedAdvance(5, 5), false);
  });

  void it("does not flag when the best score already exceeded the cap", () => {
    // If 8+ was reached at some point, blockers were not the obstacle — some
    // other reason (e.g. a later regression) is the real story.
    assert.strictEqual(rubricCapLikelyBlockedAdvance(9, 10), false);
  });

  void it("does not flag an unparseable score", () => {
    assert.strictEqual(rubricCapLikelyBlockedAdvance(null, 9), false);
  });
});
