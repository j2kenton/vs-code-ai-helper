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
});
