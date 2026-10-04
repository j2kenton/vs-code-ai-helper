/**
 * 1.0 item 13: the Publish row's single "Check and review" command runs the
 * checks only when they are missing or stale, then the review, one after the
 * other through their own commands (no admission handed between them).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkAndReviewPublishV1 } from "../commands/checkAndReviewPublish";

function makeDeps(freshSequence: boolean[]) {
  const calls: { command: string; args: unknown[] }[] = [];
  let freshChecks = 0;
  return {
    calls,
    deps: {
      isPublishChecksFresh: (): Promise<boolean> =>
        Promise.resolve(freshSequence[Math.min(freshChecks++, freshSequence.length - 1)] === true),
      executeCommand: (command: string, ...args: unknown[]): Promise<unknown> => {
        calls.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
  };
}

void describe("checkAndReviewPublishV1", () => {
  void it("runs the review directly when the checks are already fresh", async () => {
    const { calls, deps } = makeDeps([true]);
    const result = await checkAndReviewPublishV1({ taskFolderPath: "/t/one" }, deps);
    assert.equal(result, "review-dispatched");
    assert.deepEqual(
      calls.map((c) => c.command),
      ["vs-code-ai-helper.runReviewWithAI"]
    );
  });

  void it("runs the checks first, then the review, when the checks are missing or stale", async () => {
    const { calls, deps } = makeDeps([false, true]);
    const result = await checkAndReviewPublishV1({ taskFolderPath: "/t/one" }, deps);
    assert.equal(result, "review-dispatched");
    assert.deepEqual(
      calls.map((c) => c.command),
      ["vs-code-ai-helper.runPublishChecks", "vs-code-ai-helper.runReviewWithAI"]
    );
    assert.deepEqual(calls[0]?.args, [{ taskFolderPath: "/t/one" }]);
  });

  void it("stops without a review when the checks did not produce fresh results", async () => {
    const { calls, deps } = makeDeps([false, false]);
    const result = await checkAndReviewPublishV1({ taskFolderPath: "/t/one" }, deps);
    assert.equal(result, "checks-not-fresh");
    assert.deepEqual(
      calls.map((c) => c.command),
      ["vs-code-ai-helper.runPublishChecks"]
    );
  });

  void it("hands a row-less invocation straight to the review command", async () => {
    const { calls, deps } = makeDeps([false]);
    await checkAndReviewPublishV1(undefined, deps);
    assert.deepEqual(
      calls.map((c) => c.command),
      ["vs-code-ai-helper.runReviewWithAI"]
    );
  });
});
