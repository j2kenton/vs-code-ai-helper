import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  getBestReviewScore,
  improveReviewScore,
  MAX_REVIEW_ATTEMPTS,
  recordBestReviewScore,
  ReviewRoundOutcome,
  ZERO_FIXABLE_TERMINAL_ROUNDS,
} from "../utils/reviewScoreLoop";

/** Minimal in-memory stand-in for vscode.ExtensionContext.workspaceState. */
function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, defaultValue?: unknown) =>
        store.has(key) ? store.get(key) : defaultValue,
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
}

void describe("recordBestReviewScore / getBestReviewScore", () => {
  void it("persists the best score seen per stage", async () => {
    const context = fakeContext();
    assert.strictEqual(getBestReviewScore(context, "impl-high-review"), undefined);

    await recordBestReviewScore(context, "impl-high-review", 4);
    assert.strictEqual(getBestReviewScore(context, "impl-high-review"), 4);

    // A lower subsequent score does not lower the recorded best.
    await recordBestReviewScore(context, "impl-high-review", 2);
    assert.strictEqual(getBestReviewScore(context, "impl-high-review"), 4);

    await recordBestReviewScore(context, "impl-high-review", 7);
    assert.strictEqual(getBestReviewScore(context, "impl-high-review"), 7);
  });

  void it("tracks separate stages independently", async () => {
    const context = fakeContext();
    await recordBestReviewScore(context, "plan-high-review", 6);
    await recordBestReviewScore(context, "impl-high-review", 3);
    assert.strictEqual(getBestReviewScore(context, "plan-high-review"), 6);
    assert.strictEqual(getBestReviewScore(context, "impl-high-review"), 3);
  });
});

void describe("improveReviewScore", () => {
  void it("stops as soon as an attempt's score beats baseline by at least 1", async () => {
    const context = fakeContext();
    const scores = [4, 4, 6];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 4,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(scores[call - 1] ?? null),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.score, 6);
    assert.strictEqual(call, 3);
  });

  void it("treats a fractional gain as improvement (staged-plan scores) so a real climb is not read as a plateau", async () => {
    // 3.1 -> 3.2 is only +0.1 — under the old integer "+1" gate this counted
    // as no progress and drove the plateau escalation; it must now register.
    const context = fakeContext();
    const scores = [3.1, 3.2];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 3.1,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(scores[call - 1] ?? null),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.score, 3.2);
  });

  void it("does NOT treat a flat fractional score as improvement", async () => {
    // Real scores are normalized to tenths (reviewReadiness.ts), so "no
    // progress" means the same tenth again — that must not count, so a
    // genuinely stuck staged plan can still stall/escalate.
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 3.1,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve(3.1),
    });

    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.attempts, MAX_REVIEW_ATTEMPTS);
  });

  void it("does NOT report improved on a fresh task with no persisted best just because there's no history", async () => {
    // Regression test: the original implementation used
    // `previous === undefined` (no persisted best yet) as a shortcut that
    // reported success after exactly one attempt, no matter the score. A
    // task's very first fast-forward run must still require a real
    // improvement over its own starting score, not skip the check.
    const context = fakeContext();
    assert.strictEqual(getBestReviewScore(context, "impl-high-review"), undefined);

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 3,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve(3), // never improves over the baseline
    });

    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.attempts, MAX_REVIEW_ATTEMPTS);
  });

  void it("exhausts MAX_REVIEW_ATTEMPTS and reports the best score seen when nothing beats baseline+1", async () => {
    const context = fakeContext();
    const scores = [3, 4, 3, 4, 3];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "plan-high-review",
      baselineScore: 4,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(scores[call - 1] ?? null),
    });

    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.stalled, false);
    assert.strictEqual(result.attempts, MAX_REVIEW_ATTEMPTS);
    assert.strictEqual(result.score, 4);
    assert.strictEqual(call, MAX_REVIEW_ATTEMPTS);
  });

  void it("stops immediately when review() returns null (nothing changed)", async () => {
    const context = fakeContext();
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-low-review",
      baselineScore: 5,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(null),
    });

    assert.strictEqual(result.stalled, true);
    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.paused, false);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(call, 1);
  });

  // Regression coverage: escalation (handleReviewRoutingOutcome,
  // reviewActions.ts) can now fire inside Fast Forward and pause the task
  // mid-loop. Before isPaused existed, apply() silently no-op'd on the
  // paused guard, review() then saw unchanged content and returned null, and
  // the loop reported `stalled` — blaming "the provider may have failed or
  // been blocked" for what was actually a deliberate escalation.
  void it("reports paused, not stalled, when isPaused() is true and review() also sees nothing new", async () => {
    // Covers a pause unrelated to THIS attempt's own review (e.g. the task
    // was already paused going in) — review() still runs (it must, so a real
    // score from an escalation-triggering round is never skipped — see the
    // next test), but here it correctly finds nothing changed.
    const context = fakeContext();
    let reviewCalls = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-low-review",
      baselineScore: 5,
      apply: () => Promise.resolve(),
      isPaused: () => Promise.resolve(true),
      review: () => {
        reviewCalls += 1;
        return Promise.resolve(null);
      },
    });

    assert.strictEqual(result.paused, true);
    assert.strictEqual(result.stalled, false);
    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(reviewCalls, 1, "review() must still run so a real score isn't skipped when one exists");
  });

  // The actual escalation path: apply() itself runs a nested re-review that
  // produces a real, different score and — because that score routed to
  // "second-opinion"/"escalate" — pauses the task in the same breath. review()
  // reading the SAME already-updated content back must still count.
  void it("records the score from this attempt's own review even though isPaused() is true afterward", async () => {
    const context = fakeContext();

    const result = await improveReviewScore({
      context,
      stage: "impl-low-review",
      baselineScore: 5,
      apply: () => Promise.resolve(),
      isPaused: () => Promise.resolve(true),
      review: () => Promise.resolve(6),
    });

    assert.strictEqual(result.paused, true);
    assert.strictEqual(result.stalled, false);
    assert.strictEqual(result.score, 6);
    assert.strictEqual(getBestReviewScore(context, "impl-low-review"), 6);
  });

  void it("keeps iterating normally when isPaused() is provided but returns false", async () => {
    const context = fakeContext();
    const scores = [4, 4, 6];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 4,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      isPaused: () => Promise.resolve(false),
      review: () => Promise.resolve(scores[call - 1] ?? null),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.paused, false);
    assert.strictEqual(result.attempts, 3);
  });

  // 2a (ensemble.resilience.fastForwardSurvivesEscalation): an escalation
  // raised by this run's OWN review must not silently reduce an explicitly
  // requested multi-attempt run to attempts: 1 — the exact failure observed
  // on jester 2026-07-30_task_1, where every Fast Forward click produced one
  // apply/review pair and a mandatory manual resume.
  void it("continues through an in-run escalation pause when continueThroughEscalation is set, reporting escalationDeferred", async () => {
    const context = fakeContext();
    let applies = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      continueThroughEscalation: true,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      // The first attempt's review escalates (pause source "escalation");
      // later attempts see no pause.
      isPaused: () => Promise.resolve(applies === 1 ? "escalation" : false),
      review: () => Promise.resolve(5), // never improves — exhausts the budget
    });

    assert.strictEqual(result.paused, false);
    assert.strictEqual(result.escalationDeferred, true);
    assert.strictEqual(result.attempts, 3, "the run must finish its attempt budget");
    assert.strictEqual(applies, 3);
  });

  void it("still aborts on an escalation pause when continueThroughEscalation is off (legacy behavior)", async () => {
    const context = fakeContext();
    let applies = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      isPaused: () => Promise.resolve("escalation"),
      review: () => Promise.resolve(5),
    });

    assert.strictEqual(result.paused, true);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(applies, 1);
  });

  void it("still aborts on an EXTERNAL pause even when continueThroughEscalation is set", async () => {
    // Riding through pauses is scoped to this run's own escalation; a user
    // pausing manually (or another window) must keep its original effect.
    const context = fakeContext();

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      continueThroughEscalation: true,
      apply: () => Promise.resolve(),
      isPaused: () => Promise.resolve("external"),
      review: () => Promise.resolve(5),
    });

    assert.strictEqual(result.paused, true);
    assert.strictEqual(result.attempts, 1);
  });

  // 2h (ensemble.resilience.zeroFixableTerminatesFastForward): a review
  // reporting zero task-fixable blockers with positive evidence is terminal
  // success, regardless of score movement — 37 zero-blocker rounds on
  // 2026-07-14_task_5 (scores 5.2–7.6) advanced nothing because only a +0.1
  // score change could ever end the loop.
  const cleanRound = (score: number): ReviewRoundOutcome => ({
    score,
    taskFixableCount: 0,
    zeroFixableEvidence: true,
  });

  void it("terminates as success after two consecutive zero-fixable rounds with positive evidence, with no score movement", async () => {
    const context = fakeContext();
    let applies = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5.2,
      maxAttempts: MAX_REVIEW_ATTEMPTS,
      zeroFixableTerminates: true,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(cleanRound(5.2)), // flat score, clean evidence
    });

    assert.strictEqual(result.zeroFixableSuccess, true);
    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.attempts, ZERO_FIXABLE_TERMINAL_ROUNDS);
    assert.strictEqual(applies, ZERO_FIXABLE_TERMINAL_ROUNDS);
  });

  void it("does NOT terminate on zero-fixable rounds without positive evidence (absent blocker block)", async () => {
    const context = fakeContext();

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      zeroFixableTerminates: true,
      apply: () => Promise.resolve(),
      // No blocker block parsed and no explicit statement — mere absence.
      review: () => Promise.resolve({ score: 5, taskFixableCount: null, zeroFixableEvidence: false }),
    });

    assert.strictEqual(result.zeroFixableSuccess, false);
    assert.strictEqual(result.attempts, 3);
  });

  void it("requires the zero-fixable rounds to be consecutive", async () => {
    const context = fakeContext();
    const rounds: ReviewRoundOutcome[] = [
      cleanRound(5),
      { score: 5, taskFixableCount: 1, zeroFixableEvidence: false }, // breaks the streak
      cleanRound(5),
      cleanRound(5),
    ];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 4,
      zeroFixableTerminates: true,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(rounds[call - 1] ?? null),
    });

    assert.strictEqual(result.zeroFixableSuccess, true);
    assert.strictEqual(result.attempts, 4, "the streak must restart after the interrupting round");
  });

  void it("ignores zero-fixable evidence entirely when the flag is off (legacy behavior)", async () => {
    const context = fakeContext();

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve(cleanRound(5)),
    });

    assert.strictEqual(result.zeroFixableSuccess, false);
    assert.strictEqual(result.attempts, 3);
  });

  void it("keeps the score-improvement gate as an additional success path alongside zero-fixable termination", async () => {
    const context = fakeContext();

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      zeroFixableTerminates: true,
      apply: () => Promise.resolve(),
      // Improves immediately — the improved path must win on attempt 1,
      // before any zero-fixable streak accumulates.
      review: () => Promise.resolve({ score: 7, taskFixableCount: 0, zeroFixableEvidence: true }),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.zeroFixableSuccess, false);
    assert.strictEqual(result.attempts, 1);
  });

  void it("throws CancellationError when the token is already cancelled", async () => {
    const context = fakeContext();
    const cts = new vscode.CancellationTokenSource();
    cts.cancel();

    await assert.rejects(
      improveReviewScore({
        context,
        stage: "plan-low-review",
        baselineScore: 5,
        apply: () =>
          Promise.reject(
            new Error("apply() should not run once already cancelled")
          ),
        review: () => Promise.resolve(9),
        token: cts.token,
      }),
      vscode.CancellationError
    );
  });
});

void describe("improveReviewScore — reviewer-identity scale break (workflow-2 item 7)", () => {
  const REVIEWER_A = { providerLabel: "OpenAI Codex", storedModelId: "gpt-5.6-sol@high" };
  const REVIEWER_B = { providerLabel: "Cline", storedModelId: "cline-pass/kimi-k3@xhigh" };

  void it("legacy behavior: no baselineReviewer supplied — every round compares straight against baselineScore", async () => {
    // Without baselineReviewer the scale-break check never activates, so
    // this is byte-for-byte the pre-existing multi-round semantic: round 2
    // must still beat the ORIGINAL baseline, not round 1's score.
    const context = fakeContext();
    const scores: ReviewRoundOutcome[] = [
      { score: 6, taskFixableCount: 1, zeroFixableEvidence: false, reviewer: REVIEWER_A },
      { score: 6.2, taskFixableCount: 1, zeroFixableEvidence: false, reviewer: REVIEWER_A },
    ];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 6,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(scores[call - 1] ?? null),
    });

    // 6.2 is only +0.2 over the true original baseline of 6 but the loop
    // runs out of scripted rounds (score 6.2 also fails "beat 6 by 1 whole
    // point"? no — MIN_SCORE_IMPROVEMENT is 0.1, so 6.2 DOES clear 6.1).
    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.score, 6.2);
  });

  void it("a reviewer substitution does not let a same-or-lower score across the break read as improvement", async () => {
    // Baseline was reviewed by A at 7.4. The in-loop round is reviewed by B
    // (backup-cascade substitution) at 7.1 — a genuine regression under one
    // instrument, but +... nothing meaningful to compare across a break. It
    // must not be misread as "improved" via a same-reviewer delta test, and
    // with no known blocker-count movement it must not terminate as improved
    // either.
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 7.4,
      baselineReviewer: REVIEWER_A,
      maxAttempts: 1,
      apply: () => Promise.resolve(),
      review: () =>
        Promise.resolve({
          score: 7.1,
          taskFixableCount: null,
          zeroFixableEvidence: false,
          reviewer: REVIEWER_B,
        }),
    });

    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.score, 7.1);
  });

  void it("a reviewer substitution with a lower task-fixable count IS treated as improvement (count, not score, movement)", async () => {
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 7.4,
      baselineReviewer: REVIEWER_A,
      baselineTaskFixableCount: 3,
      apply: () => Promise.resolve(),
      review: () =>
        Promise.resolve({
          // Score itself moved DOWN across the break (different instrument),
          // but the blocker count — a count, not a judgement scale — improved.
          score: 6.9,
          taskFixableCount: 1,
          zeroFixableEvidence: false,
          reviewer: REVIEWER_B,
        }),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.score, 6.9);
  });

  void it("a reviewer substitution with unknown blocker counts re-baselines to the new reviewer's own first score, without terminating that round", async () => {
    const context = fakeContext();
    const rounds: ReviewRoundOutcome[] = [
      // Round 1: reviewer changed, no taskFixableCount evidence either side —
      // no comparable signal yet, so this round can't itself prove
      // improvement; it becomes the new reference.
      { score: 6.5, taskFixableCount: null, zeroFixableEvidence: false, reviewer: REVIEWER_B },
      // Round 2: SAME reviewer as round 1 (B), and clears +0.1 over round 1's
      // own score (6.5 -> 6.6) — proves the re-baseline actually took, since
      // 6.6 does NOT clear the ORIGINAL baseline (7.4) by any margin.
      { score: 6.6, taskFixableCount: null, zeroFixableEvidence: false, reviewer: REVIEWER_B },
    ];
    let call = 0;

    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 7.4,
      baselineReviewer: REVIEWER_A,
      apply: () => {
        call += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(rounds[call - 1] ?? null),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.score, 6.6);
  });

  void it("entries without a recorded identity on either side keep today's behavior", async () => {
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 6,
      // No baselineReviewer, and this round's outcome carries no reviewer
      // either — the scale-break check has nothing to compare and must stay
      // fully inert, exactly like every pre-existing (legacy) caller.
      apply: () => Promise.resolve(),
      review: () =>
        Promise.resolve({ score: 6.1, taskFixableCount: null, zeroFixableEvidence: false }),
    });

    assert.strictEqual(result.improved, true);
    assert.strictEqual(result.score, 6.1);
  });
});

/**
 * Plan-progress signal (2026-08-07). The bug it fixes: a review's score was
 * asked to answer two different questions at once — "is what was built any
 * good" and "is the whole plan built yet". A clean-but-partial round therefore
 * looked identical to a failure, so the loop retried the SAME scope instead of
 * moving on to the next steps. Live evidence: task "workflow" sat at 6.3/10
 * with zero blockers across six reviews and four providers, structurally unable
 * to advance, while 17 of its 25 plan steps were never built.
 *
 * With the marker, "no blockers" means only "nothing is wrong"; completeness is
 * reported separately, and the loop keeps building until the plan is done.
 */
void describe("improveReviewScore — plan progress", () => {
  const cleanAt = (score: number, complete: number, total: number): ReviewRoundOutcome => ({
    score,
    taskFixableCount: 0,
    zeroFixableEvidence: true,
    progress: { complete, total },
  });

  void it("keeps building instead of declaring success while plan steps remain", async () => {
    const context = fakeContext();
    let applies = 0;
    // Every round is clean, and each one lands one more step: 8/25 ... 12/25.
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 6.3,
      maxAttempts: 5,
      zeroFixableTerminates: true,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(cleanAt(9, 7 + applies, 25)),
    });

    // Pre-fix this returned zeroFixableSuccess after 2 rounds, stranding 17 steps.
    assert.strictEqual(result.zeroFixableSuccess, false, "must not call a partial plan finished");
    assert.strictEqual(applies, 5, "keeps implementing across the full attempt budget");
  });

  void it("terminates as success once the plan reports fully complete", async () => {
    const context = fakeContext();
    // Flat score, so the score-improvement path can't fire and this pins the
    // zero-fixable path specifically: complete plan + clean rounds = done.
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 6.3,
      maxAttempts: 5,
      zeroFixableTerminates: true,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve(cleanAt(6.3, 25, 25)),
    });

    assert.strictEqual(result.zeroFixableSuccess, true);
    assert.strictEqual(result.attempts, ZERO_FIXABLE_TERMINAL_ROUNDS);
  });

  void it("lets a score improvement finish the run once the plan is complete", async () => {
    // The complement of the mid-plan guard below: with 25/25 reported, a
    // genuine score improvement is allowed to end the run as before.
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve(cleanAt(9, 25, 25)),
    });

    assert.strictEqual(result.improved, true);
  });

  void it("stops as stalled when a clean but incomplete plan stops advancing", async () => {
    // The safety valve: "keep going" must not mean "burn every attempt doing
    // nothing" if implementation stops landing steps.
    const context = fakeContext();
    let applies = 0;
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 6.3,
      maxAttempts: 20,
      zeroFixableTerminates: true,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(cleanAt(9, 8, 25)), // frozen at 8/25
    });

    assert.strictEqual(result.stalled, true);
    assert.strictEqual(result.zeroFixableSuccess, false);
    assert.ok(applies < 20, "stopped early rather than burning the whole attempt budget");
  });

  void it("does not let a high score advance the stage mid-plan", async () => {
    // Scores now measure quality, so a flawless first batch can score high
    // while most of the plan is unbuilt. That must not count as success.
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve(cleanAt(10, 8, 25)), // big improvement, still partial
    });

    assert.strictEqual(result.improved, false, "a partial plan is never 'improved to done'");
  });

  void it("is unaffected when a review emits no progress marker (pre-marker behavior)", async () => {
    const context = fakeContext();
    const result = await improveReviewScore({
      context,
      stage: "impl-high-review",
      baselineScore: 5,
      maxAttempts: 3,
      apply: () => Promise.resolve(),
      // No `progress` field at all — exactly the old ReviewRoundOutcome shape.
      review: () =>
        Promise.resolve({ score: 9, taskFixableCount: 0, zeroFixableEvidence: true }),
    });

    assert.strictEqual(result.improved, true, "score-based success still works without the marker");
  });

  // Step 10: Fast Forward must be able to succeed from a 10/10 baseline.
  // `improved` demands `baselineScore + 0.1`, which has no representable
  // value above a baseline of 10 on a 0-10 scale, so a perfect baseline must
  // succeed through a different path that does not require score movement.
  void describe("terminal success at/above the configured stop level without score movement", () => {
    void it("succeeds on the FIRST in-loop round at a 10/10 baseline, without requiring +0.1", async () => {
      const context = fakeContext();
      let applies = 0;
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 10,
        maxAttempts: MAX_REVIEW_ATTEMPTS,
        stopAtScore: 10,
        apply: () => {
          applies += 1;
          return Promise.resolve();
        },
        review: () => Promise.resolve({ score: 10, taskFixableCount: 0, zeroFixableEvidence: true }),
      });

      assert.strictEqual(result.zeroFixableSuccess, true);
      assert.strictEqual(result.improved, false);
      assert.strictEqual(result.attempts, 1, "must not wait for ZERO_FIXABLE_TERMINAL_ROUNDS");
      assert.strictEqual(applies, 1);
    });

    void it("does not fire below the configured stop level, even with zero-fixable evidence", async () => {
      const context = fakeContext();
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 8,
        maxAttempts: 2,
        stopAtScore: 10,
        apply: () => Promise.resolve(),
        review: () => Promise.resolve({ score: 8, taskFixableCount: 0, zeroFixableEvidence: true }),
      });

      assert.strictEqual(result.zeroFixableSuccess, false, "8 is below the configured stop level of 10");
    });

    void it("does not fire without zero-fixable evidence, even at/above the stop level", async () => {
      const context = fakeContext();
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 10,
        maxAttempts: 1,
        stopAtScore: 10,
        apply: () => Promise.resolve(),
        review: () => Promise.resolve({ score: 10, taskFixableCount: 1, zeroFixableEvidence: false }),
      });

      assert.strictEqual(result.zeroFixableSuccess, false);
    });

    void it("pre-loop short-circuit: succeeds without running apply() even once when the seeded evidence already clears the bar", async () => {
      const context = fakeContext();
      let applies = 0;
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 10,
        maxAttempts: MAX_REVIEW_ATTEMPTS,
        stopAtScore: 10,
        preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
        apply: () => {
          applies += 1;
          return Promise.resolve();
        },
        review: () => Promise.resolve({ score: 3, taskFixableCount: 5, zeroFixableEvidence: false }),
      });

      assert.strictEqual(result.zeroFixableSuccess, true);
      assert.strictEqual(result.attempts, 0, "must not burn the round that failed in report 7");
      assert.strictEqual(applies, 0, "apply() must never run when the pre-loop evidence already succeeds");
      assert.strictEqual(result.score, 10);
    });

    void it("pre-loop short-circuit does not fire when the plan is still incomplete", async () => {
      const context = fakeContext();
      let applies = 0;
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 10,
        maxAttempts: 1,
        stopAtScore: 10,
        preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
        apply: () => {
          applies += 1;
          return Promise.resolve();
        },
        review: () => Promise.resolve({ score: 10, taskFixableCount: 0, zeroFixableEvidence: true }),
      });

      assert.strictEqual(applies, 1, "an incomplete plan must still run at least one round");
      assert.strictEqual(result.zeroFixableSuccess, true);
    });

    void it("seeds consecutiveZeroFixable from the pre-loop review, so one in-loop clean round can still terminate via the 2-round path", async () => {
      // The pre-loop review was itself zero-fixable but did NOT meet
      // stopAtScore (so the short-circuit above does not fire) — a single
      // further clean round should be enough to reach
      // ZERO_FIXABLE_TERMINAL_ROUNDS (2), not require two more rounds.
      const context = fakeContext();
      let applies = 0;
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 8,
        maxAttempts: MAX_REVIEW_ATTEMPTS,
        zeroFixableTerminates: true,
        preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
        apply: () => {
          applies += 1;
          return Promise.resolve();
        },
        review: () => Promise.resolve({ score: 8, taskFixableCount: 0, zeroFixableEvidence: true }),
      });

      assert.strictEqual(result.zeroFixableSuccess, true);
      assert.strictEqual(result.attempts, 1, "the pre-loop round already counted toward the 2-round streak");
      assert.strictEqual(applies, 1);
    });
  });
});
