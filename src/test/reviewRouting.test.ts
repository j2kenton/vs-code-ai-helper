import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideReviewRoute,
  detectPlateau,
  REVIEW_RUBRIC_BLOCKER_SCORE_CAP,
  rubricCapLikelyBlockedAdvance,
} from "../utils/reviewRouting";
import { ReviewBlocker } from "../utils/reviewReadiness";
import { ReviewScoreHistoryEntry } from "../types/taskProgress";

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
