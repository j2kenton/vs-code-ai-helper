import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  getBestReviewScore,
  improveReviewScore,
  MAX_REVIEW_ATTEMPTS,
  recordBestReviewScore,
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
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(call, 1);
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
