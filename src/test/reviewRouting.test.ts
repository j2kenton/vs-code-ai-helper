import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  blockerIdentity,
  decidePostReviewActionV1,
  decideReviewRoute,
  IMPL_REVIEW_STAGES_V1,
  degenerateReviewRejectionReason,
  detectBlockerSetStall,
  detectPlateau,
  isProviderExhaustionReplyShapeV1,
  promptCeilingAdvisoryV1,
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

  void it("does not compare across a reviewer identity change (workflow-2 item 7)", () => {
    const reviewerA = { providerLabel: "Cline", storedModelId: "cline-pass/kimi-k3@xhigh" };
    const reviewerB = { providerLabel: "Codex", storedModelId: "gpt-5.6-sol@high" };
    // A flat run under reviewer A would plateau on its own, but reviewer B
    // only produced ONE round so far — not enough same-reviewer history to
    // judge, so this must NOT read as a plateau across the substitution.
    const history = [
      entry(7, { reviewer: reviewerA }),
      entry(7, { reviewer: reviewerA }),
      entry(7, { reviewer: reviewerA }),
      entry(7, { reviewer: reviewerA }),
      entry(6, { reviewer: reviewerB }),
    ];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), false);
  });

  void it("resumes comparing once enough rounds accumulate under the new reviewer", () => {
    const reviewerA = { providerLabel: "Cline", storedModelId: "cline-pass/kimi-k3@xhigh" };
    const reviewerB = { providerLabel: "Codex", storedModelId: "gpt-5.6-sol@high" };
    const history = [
      entry(9, { reviewer: reviewerA }),
      entry(6, { reviewer: reviewerB }),
      entry(6, { reviewer: reviewerB }),
      entry(6, { reviewer: reviewerB }),
      entry(6, { reviewer: reviewerB }),
    ];
    assert.strictEqual(detectPlateau(history, "impl-high-review", 3), true);
  });

  void it("legacy entries without any recorded reviewer identity behave exactly as before", () => {
    const history = [entry(2), entry(5), entry(5), entry(5), entry(5)];
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

  void it("does not compare blocker sets across a reviewer identity change", () => {
    const reviewerA = { providerLabel: "Cline", storedModelId: "cline-pass/kimi-k3@xhigh" };
    const reviewerB = { providerLabel: "Codex", storedModelId: "gpt-5.6-sol@high" };
    const blockers = [identity()];
    // Same unchanged blocker set would stall under one reviewer, but the
    // window's baseline round is under reviewer A and the rest under B —
    // only one same-reviewer (B) round exists, too few to judge.
    const history = [
      entry(5, { blockers, reviewer: reviewerA }),
      entry(5, { blockers, reviewer: reviewerB }),
      entry(5, { blockers, reviewer: reviewerB }),
      entry(5, { blockers, reviewer: reviewerB }),
    ];
    assert.strictEqual(detectBlockerSetStall(history, "impl-high-review", 3), false);
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

  // 2026-08-14 review finding: the breaker exists for a PASSING review
  // sending a finished-looking round back to impl forever, not for sterile
  // rounds against real unresolved work — trip must also require a
  // qualifying same-stage review at or above the auto-advance threshold.
  void describe("qualifying-review gate (qualifyingStage/qualifyingThreshold)", () => {
    void it("still trips on the zero-change count alone when the gate is omitted (legacy/back-compat)", () => {
      assert.strictEqual(
        shouldTripNoProgressBreaker({ zeroChangeRounds: 3, breakerRounds: 3, history: [] }),
        true
      );
    });

    void it("eligible: trips when the latest same-stage review meets the threshold", () => {
      const qualifying = [entry(10, { stage: "impl-high-review", blockerCount: 0, taskFixableCount: 0 })];
      assert.strictEqual(
        shouldTripNoProgressBreaker({
          zeroChangeRounds: 3,
          breakerRounds: 3,
          history: qualifying,
          qualifyingStage: "impl-high-review",
          qualifyingThreshold: 10,
        }),
        true
      );
    });

    void it("ineligible: does not trip when the latest same-stage review scores below the threshold", () => {
      const belowThreshold = [entry(6, { stage: "impl-high-review", blockerCount: 1, taskFixableCount: 1 })];
      assert.strictEqual(
        shouldTripNoProgressBreaker({
          zeroChangeRounds: 3,
          breakerRounds: 3,
          history: belowThreshold,
          qualifyingStage: "impl-high-review",
          qualifyingThreshold: 10,
        }),
        false
      );
    });

    void it("ineligible: does not trip with no history at all — no qualifying passing-review loop on record", () => {
      assert.strictEqual(
        shouldTripNoProgressBreaker({
          zeroChangeRounds: 3,
          breakerRounds: 3,
          history: undefined,
          qualifyingStage: "impl-high-review",
          qualifyingThreshold: 10,
        }),
        false
      );
    });

    void it("ineligible: does not trip when history only has entries for a different stage", () => {
      const otherStage = [entry(10, { stage: "impl-low-review", blockerCount: 0, taskFixableCount: 0 })];
      assert.strictEqual(
        shouldTripNoProgressBreaker({
          zeroChangeRounds: 3,
          breakerRounds: 3,
          history: otherStage,
          qualifyingStage: "impl-high-review",
          qualifyingThreshold: 10,
        }),
        false
      );
    });

    void it("qualifies on the MOST RECENT same-stage entry, not an earlier passing one", () => {
      const regressed = [
        entry(10, { stage: "impl-high-review", blockerCount: 0, taskFixableCount: 0, at: "2026-01-01T00:00:00.000Z" }),
        entry(4, { stage: "impl-high-review", blockerCount: 3, taskFixableCount: 3, at: "2026-01-02T00:00:00.000Z" }),
      ];
      assert.strictEqual(
        shouldTripNoProgressBreaker({
          zeroChangeRounds: 3,
          breakerRounds: 3,
          history: regressed,
          qualifyingStage: "impl-high-review",
          qualifyingThreshold: 10,
        }),
        false
      );
    });
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

/**
 * The routing that keeps an Implementation round from answering a blocker it
 * is structurally unable to see. Implementation is rendered with the plan
 * checklist only; Apply Review is rendered with the review. Choosing the
 * former while blockers stand is the stall these cases pin.
 */
void describe("decidePostReviewActionV1", () => {
  void it("routes to apply-review while task-fixable blockers stand, even with a complete checklist", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(5, { stage: "impl-low-review", taskFixableCount: 3, blockerCount: 3 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
    });
    assert.strictEqual(decision.action, "apply-review");
    assert.strictEqual(decision.reviewStage, "impl-low-review");
  });

  /**
   * wf10 item 6 (2026-08-24): this used to assert "apply-review" here too,
   * reasoning that blockers take precedence. That was true for the
   * RECOMMENDATION but false for the ALTERNATIVE: observed 2026-08-21, a task
   * with 1 task-fixable blocker and 77 unticked checklist items was told
   * Implementation "will most likely change nothing" — the newest review's
   * own progress marker showed 76 of those steps still queued and
   * actionable. Both actions are genuinely valid whenever both conditions
   * hold; the function now says so instead of naming one and asserting the
   * other is futile.
   */
  void it("returns 'both' (not 'apply-review') when a task-fixable blocker AND unticked checklist items coexist", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(5, { stage: "impl-low-review", taskFixableCount: 1, blockerCount: 1 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: true,
    });
    assert.strictEqual(decision.action, "both");
    assert.strictEqual(decision.reviewStage, "impl-low-review");
    assert.match(decision.reason, /Both are valid/);
  });

  void it("routes to implementation when nothing is task-fixable but the checklist is unfinished", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(9, { stage: "impl-low-review", taskFixableCount: 0, blockerCount: 0 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: true,
    });
    assert.strictEqual(decision.action, "implementation");
  });

  void it("routes to none when nothing is task-fixable and the checklist is complete", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(10, { stage: "impl-low-review", taskFixableCount: 0, blockerCount: 0 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
    });
    assert.strictEqual(decision.action, "none");
  });

  void it("decides from the NEWEST impl review, not whichever stage is listed first", () => {
    // The observed stale-stage bug: a clean impl-high-review round sat in
    // history while the fresher impl-low-review carried three blockers, and
    // reading the wrong one announced the task as finished.
    const decision = decidePostReviewActionV1({
      history: [
        entry(9, {
          stage: "impl-high-review",
          taskFixableCount: 0,
          blockerCount: 0,
          at: "2026-08-19T02:21:00.000Z",
        }),
        entry(5, {
          stage: "impl-low-review",
          taskFixableCount: 3,
          blockerCount: 3,
          at: "2026-08-19T09:47:00.000Z",
        }),
      ],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
    });
    assert.strictEqual(decision.action, "apply-review");
    assert.strictEqual(decision.reviewStage, "impl-low-review");
  });

  void it("prefers the newest round regardless of which stage carries the blockers", () => {
    const decision = decidePostReviewActionV1({
      history: [
        entry(5, {
          stage: "impl-low-review",
          taskFixableCount: 3,
          blockerCount: 3,
          at: "2026-08-19T02:21:00.000Z",
        }),
        entry(9, {
          stage: "impl-high-review",
          taskFixableCount: 0,
          blockerCount: 0,
          at: "2026-08-19T09:47:00.000Z",
        }),
      ],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: true,
    });
    assert.strictEqual(decision.action, "implementation");
    assert.strictEqual(decision.reviewStage, "impl-high-review");
  });

  void it("falls back to the checklist when no review has run yet", () => {
    assert.strictEqual(
      decidePostReviewActionV1({
        history: [],
        stages: IMPL_REVIEW_STAGES_V1,
        hasUntickedChecklistItems: true,
      }).action,
      "implementation"
    );
    assert.strictEqual(
      decidePostReviewActionV1({
        history: undefined,
        stages: IMPL_REVIEW_STAGES_V1,
        hasUntickedChecklistItems: false,
      }).action,
      "none"
    );
  });

  void it("ignores review rounds from stages it was not asked about", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(4, { stage: "plan-low-review", taskFixableCount: 5, blockerCount: 5 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: true,
    });
    assert.strictEqual(decision.action, "implementation");
    assert.strictEqual(decision.reviewStage, undefined);
  });

  /**
   * Task "Actionable Hand-offs", "The worse case" / PART 9: an owed
   * continuation outranks blocker/checklist routing, because it gates
   * whether Apply Review (and Review, and Fast Forward) can even run.
   * Recommending "apply-review" while a continuation is owed is always
   * wrong — that is exactly the state those actions refuse in.
   */
  void it("routes to implementation, unconditionally, when a continuation is owed — even with blockers standing", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(5, { stage: "impl-low-review", taskFixableCount: 3, blockerCount: 3 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
      continuationOwed: true,
    });
    assert.strictEqual(decision.action, "implementation");
    assert.match(decision.reason, /continuation/i);
  });

  void it("routes to implementation when files are quarantined behind a continuation, even with no implRecovery flag passed", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(5, { stage: "impl-low-review", taskFixableCount: 3, blockerCount: 3 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
      pendingImplReviewFilesCount: 2,
    });
    assert.strictEqual(decision.action, "implementation");
    assert.match(decision.reason, /continuation/i);
  });

  void it("routes to implementation when a continuation is owed even with a clean review and complete checklist", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(10, { stage: "impl-low-review", taskFixableCount: 0, blockerCount: 0 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
      continuationOwed: true,
    });
    assert.strictEqual(decision.action, "implementation");
  });

  void it("does not report a continuation when both continuation inputs are absent or false/zero", () => {
    const decision = decidePostReviewActionV1({
      history: [entry(5, { stage: "impl-low-review", taskFixableCount: 3, blockerCount: 3 })],
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems: false,
      continuationOwed: false,
      pendingImplReviewFilesCount: 0,
    });
    assert.strictEqual(decision.action, "apply-review");
  });
});

/**
 * Task "Actionable Hand-offs", PART 9 (remaining item): the two
 * `decidePostReviewActionV1` consumers that used to be raw
 * `vscode.window.showWarningMessage` dialogs (`sterileRoundRouting` and
 * `preImplementationRouting`, both in `reviewActions.ts`) were migrated onto
 * `postWorkflowDecisionV1` — see reviewActions.ts's comments at those two
 * call sites and `workflowDecisionGatingInventoryV1.test.ts`, which covers
 * their `gating` metadata. This suite covers the two properties that test
 * doesn't: that `postWorkflowDecisionV1` (not the raw notification) is the
 * PRIMARY path, with the raw notification appearing only as the documented
 * fallback for a missing extension context — and that every
 * `scheduleAutomationChain` dispatch in `reviewActions.ts` still carries the
 * enriched `intent` metadata Part 6's ledger depends on, rather than
 * silently regressing to the generic-from-command-name fallback Part 6
 * reserves for not-yet-enriched sites.
 *
 * These read the real source text rather than executing `reviewActions.ts`
 * (a `vscode`-importing command module) because the property under test is
 * "which call is reached first, and under what guard" — a source-level
 * fact — not runtime behavior already covered by `chatViewWorkflowDecision
 * .test.ts` (decision rendering) and `workflowDecisionGatingInventoryV1
 * .test.ts` (gating presence). Same technique as the latter file.
 */
void describe("reviewActions.ts's migrated dialogs and enriched ledger entries (PART 9)", () => {
  async function readReviewActionsSrc(): Promise<string> {
    return readFile(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
  }

  void it("the sterileRoundRouting dialog posts via postWorkflowDecisionV1, falling back to a raw notification only when posting fails", async () => {
    const source = await readReviewActionsSrc();
    const marker = 'decisionKey: "sterileRoundRouting"';
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `expected to find ${marker} in reviewActions.ts`);
    const before = source.slice(Math.max(0, index - 400), index);
    assert.match(
      before,
      /postWorkflowDecisionV1/,
      "sterileRoundRouting must be posted through postWorkflowDecisionV1, not built as a raw notification"
    );
    const after = source.slice(index, index + 3200);
    const fallbackOffset = after.indexOf("NotificationRouter.showWarning");
    assert.ok(fallbackOffset >= 0, "expected a fallback notification for a missing extension context");
    const guard = after.slice(0, fallbackOffset);
    assert.match(
      guard,
      /if\s*\(!sterileDecisionPosted\)/,
      "the fallback notification must be gated on the decision failing to post, not run unconditionally alongside it"
    );
  });

  void it("the preImplementationRouting dialog posts via postWorkflowDecisionV1, falling back to a raw notification only when posting fails", async () => {
    const source = await readReviewActionsSrc();
    const marker = 'decisionKey: "preImplementationRouting"';
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `expected to find ${marker} in reviewActions.ts`);
    const before = source.slice(Math.max(0, index - 400), index);
    assert.match(
      before,
      /postWorkflowDecisionV1/,
      "preImplementationRouting must be posted through postWorkflowDecisionV1, not built as a raw notification"
    );
    const after = source.slice(index, index + 4000);
    const fallbackOffset = after.indexOf("NotificationRouter.showWarning");
    assert.ok(fallbackOffset >= 0, "expected a fallback notification for a missing extension context");
    const guard = after.slice(0, fallbackOffset);
    assert.match(
      guard,
      /if\s*\(!decision\)/,
      "the fallback notification must be gated on the decision failing to post, not run unconditionally alongside it"
    );
  });

  void it("the sterileRoundRouting recommendation and fallback do not call Implementation futile when sterileBothValid (a task-fixable blocker AND unticked checklist items coexist)", async () => {
    // wf10 item 6 / this round's review finding: `decidePostReviewActionV1`
    // returning "both" means the two actions are BOTH valid — the caller
    // must not assert Implementation "will give the same (unchanged)
    // result" in that case, since a two-valid-actions result is exactly the
    // situation where that claim is false (see reviewRouting.test.ts's
    // "both" coverage for the underlying routing contract).
    const source = await readReviewActionsSrc();
    const marker = 'decisionKey: "sterileRoundRouting"';
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `expected to find ${marker} in reviewActions.ts`);

    // The recommendation.reasoning block, scoped to just before the
    // `gating:` field that follows it.
    const after = source.slice(index, index + 3200);
    const gatingOffset = after.indexOf("gating: {");
    assert.ok(gatingOffset >= 0, "expected a gating field after the recommendation block");
    const recommendationBlock = after.slice(0, gatingOffset);
    assert.match(
      recommendationBlock,
      /sterileBothValid\s*\?/,
      "the recommendation reasoning must branch on sterileBothValid rather than unconditionally asserting futility"
    );
    // Whatever the false-branch (sterileBothValid === false) text is, it
    // must not appear unguarded in the true-branch text — i.e. the futility
    // claim must not survive into the both-valid case.
    const trueBranchEnd = recommendationBlock.search(/:\s*"Apply Review is the only action/);
    assert.ok(trueBranchEnd >= 0, "expected to locate the sterileBothValid===false branch text");
    const trueBranchText = recommendationBlock.slice(0, trueBranchEnd);
    assert.doesNotMatch(
      trueBranchText,
      /will give the same \(unchanged\) result/,
      "the sterileBothValid===true branch must not claim Implementation will give the same result"
    );

    // The raw-notification fallback (missing extension context) must carry
    // the same conditional guard.
    const fallbackOffset = after.indexOf("NotificationRouter.showWarning");
    assert.ok(fallbackOffset >= 0, "expected a fallback notification for a missing extension context");
    const fallbackBlock = after.slice(fallbackOffset, fallbackOffset + 900);
    assert.match(
      fallbackBlock,
      /sterileBothValid\s*\?/,
      "the fallback notification text must also branch on sterileBothValid"
    );
  });

  void it("both migrated dialogs recommend 'Go to Review & Apply' rather than defaulting the recommendation to blindly running Implementation again", async () => {
    const source = await readReviewActionsSrc();
    for (const decisionKey of ["sterileRoundRouting", "preImplementationRouting"]) {
      const marker = `decisionKey: "${decisionKey}"`;
      const index = source.indexOf(marker);
      assert.ok(index >= 0, `expected to find ${marker} in reviewActions.ts`);
      const slice = source.slice(index, index + 2200);
      assert.match(
        slice,
        /optionId:\s*"goToReviewAndApply"/,
        `${decisionKey} must offer a goToReviewAndApply option`
      );
      assert.match(
        slice,
        /recommendation:\s*\{\s*kind:\s*"option",\s*optionId:\s*"goToReviewAndApply"/,
        `${decisionKey} must recommend goToReviewAndApply, matching the corrected routing input (an owed ` +
          "continuation is checked before this dialog is ever reached — see decidePostReviewActionV1)"
      );
    }
  });

  void it("every known scheduleAutomationChain trigger in reviewActions.ts carries enriched scheduling-intent metadata", async () => {
    const source = await readReviewActionsSrc();
    // One entry per distinct `intent` object literal reviewActions.ts passes
    // to `scheduleAutomationChain` (directly, or via
    // `dispatchReviewChainAfterLockRelease`) — enumerated rather than
    // pattern-matched across every `scheduleAutomationChain(` call, because
    // two of the real call sites pass `intent` as a variable reference
    // (`intent,`) rather than an inline object literal, so a single generic
    // "the call site's next N characters contain `intent: {`" regex would
    // false-fail on those two.
    const knownTriggers = [
      "auto-implement after review completes",
      "auto-review after advancing to the next stage",
      "Complete & Move On triggers AI: generate the plan for the next stage",
      "Complete & Move On triggers AI: run implementation for the next stage",
      "Complete & Move On triggers AI: run the Publish review",
      "Complete & Move On triggers AI: review after advancing to the next stage",
      "auto-advance review after implementation completes",
      "auto-review after implementation completes",
    ];
    for (const trigger of knownTriggers) {
      const marker = `trigger: "${trigger}"`;
      const index = source.indexOf(marker);
      assert.ok(index >= 0, `expected to find the enriched trigger "${trigger}" in reviewActions.ts`);
      const slice = source.slice(Math.max(0, index - 40), index + 400);
      assert.match(slice, /settingKey:/, `intent for trigger "${trigger}" must name a settingKey (or explicitly not-setting-driven)`);
      assert.match(slice, /expectedTiming:/, `intent for trigger "${trigger}" must name an expectedTiming`);
      assert.match(slice, /willRetry:/, `intent for trigger "${trigger}" must state whether it will retry`);
    }
  });
});

void describe("promptCeilingAdvisoryV1 (wf10 item 7c / Part 6 step 16)", () => {
  void it("returns undefined when the provider has no known ceiling", () => {
    assert.equal(promptCeilingAdvisoryV1(200000, "some-unknown-provider"), undefined);
  });

  void it("returns undefined when the prompt is within the known ceiling", () => {
    assert.equal(promptCeilingAdvisoryV1(1000, "kimi-cli"), undefined);
  });

  void it("returns undefined when either input is missing", () => {
    assert.equal(promptCeilingAdvisoryV1(undefined, "kimi-cli"), undefined);
    assert.equal(promptCeilingAdvisoryV1(70000, undefined), undefined);
  });

  void it("names the provider, the size, and a remedy when the ceiling is exceeded", () => {
    const advisory = promptCeilingAdvisoryV1(70000, "kimi-cli");
    assert.ok(advisory);
    assert.match(advisory, /70000 bytes/);
    assert.match(advisory, /kimi-cli/);
    assert.match(advisory, /Shrink the prompt|route this stage/);
  });
});

void describe("isProviderExhaustionReplyShapeV1 (wf10 item 7c / Part 6 step 16)", () => {
  void it("recognizes the observed budget-handler exhaustion reply shape", () => {
    const reply =
      "The Read tool keeps truncating the full-file read. I'll page through with explicit line ranges. " +
      "This is my current blocker and what I need from the user to unblock progress.";
    assert.equal(isProviderExhaustionReplyShapeV1(reply), true);
  });

  void it("does not classify ordinary short malformed output as an exhaustion reply", () => {
    assert.equal(isProviderExhaustionReplyShapeV1("garbled nonsense output with no readiness line"), false);
  });

  void it("does not classify empty output as an exhaustion reply", () => {
    assert.equal(isProviderExhaustionReplyShapeV1("   "), false);
  });

  void it("does not classify a long reply as an exhaustion reply even if it shares a phrase", () => {
    const longReply = "current blocker ".repeat(400);
    assert.equal(isProviderExhaustionReplyShapeV1(longReply), false);
  });

  // wf10 review fix: a lone topic phrase must not be enough — only an
  // unambiguous procedural marker, or BOTH halves of the injected question's
  // blocker-plus-needed-from-user shape together, may classify as exhaustion.
  void it("does not classify a reply naming only 'current blocker' with no needed-from-user half", () => {
    assert.equal(
      isProviderExhaustionReplyShapeV1("The current blocker is a missing config file."),
      false
    );
  });

  void it("does not classify a reply naming only the needed-from-user half with no blocker topic", () => {
    assert.equal(
      isProviderExhaustionReplyShapeV1("Here is what you need from the user to unblock progress."),
      false
    );
  });

  void it("classifies a reply that names both the blocker and needed-from-user halves together", () => {
    assert.equal(
      isProviderExhaustionReplyShapeV1(
        "I could not finish. The current blocker is prompt size. What I need from the user: a smaller prompt."
      ),
      true
    );
  });
});
