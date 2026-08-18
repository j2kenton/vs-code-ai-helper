/**
 * Coverage for `queuePublishChecksRunV1` (plan PART 2, step 6): a second
 * `runPublishChecks` trigger for the same task must QUEUE behind an active
 * run and resolve its own starting state once it actually gets its turn,
 * rather than interleaving with the active run or being refused outright.
 * `runPublishChecks` itself is a vscode command with heavy environment
 * dependencies (task resolution, progress UI, git); this queue primitive is
 * exercised directly, mirroring how `withPublishChecksReportLockV1` is
 * tested in publishChecksFreshness.test.ts.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queuePublishChecksRunV1 } from "../commands/runPublishChecks";

void describe("queuePublishChecksRunV1", () => {
  void it("serializes two runs queued for the same task path — never interleaves", async () => {
    const taskPath = "C:\\tasks\\task-a";
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const run = (label: string, delayMs: number): Promise<void> =>
      queuePublishChecksRunV1(taskPath, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`${label}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(`${label}-end`);
        active--;
      });

    const first = run("first", 20);
    const second = run("second", 1);
    await Promise.all([first, second]);

    assert.equal(maxActive, 1, "no two queued runs ever executed concurrently");
    assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  });

  void it("a queued second run reads state resolved AFTER the first run finishes, not at trigger time", async () => {
    const taskPath = "C:\\tasks\\task-b";
    // Simulates the mutable "current HEAD" the real command re-resolves
    // inside the queued closure — proving the second run picks up whatever
    // changed while it was waiting, rather than a value captured at trigger
    // time (which would be the interleaving bug this queue prevents).
    let currentHead = "sha-before";
    const observedByRun2: string[] = [];

    const runFirst = queuePublishChecksRunV1(taskPath, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      currentHead = "sha-after-first";
    });

    // Triggered while the first run is still in flight — its "read HEAD"
    // step must not execute until the first run's closure has completed.
    const runSecond = queuePublishChecksRunV1(taskPath, () => {
      observedByRun2.push(currentHead);
      return Promise.resolve();
    });

    await Promise.all([runFirst, runSecond]);
    assert.deepEqual(observedByRun2, ["sha-after-first"]);
  });

  void it("does not block a different task path's queue", async () => {
    const order: string[] = [];
    const slowA = queuePublishChecksRunV1("C:\\tasks\\task-c", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a-done");
    });
    const fastB = queuePublishChecksRunV1("C:\\tasks\\task-d", () => {
      order.push("b-done");
      return Promise.resolve();
    });

    await fastB;
    assert.deepEqual(order, ["b-done"]);
    await slowA;
    assert.deepEqual(order, ["b-done", "a-done"]);
  });

  void it("propagates a rejection without deadlocking the next queued caller", async () => {
    const taskPath = "C:\\tasks\\task-e";
    await assert.rejects(
      queuePublishChecksRunV1(taskPath, () => {
        throw new Error("boom");
      }),
      /boom/
    );
    const after = await queuePublishChecksRunV1(taskPath, () => Promise.resolve("recovered"));
    assert.equal(after, "recovered");
  });

  void it("treats paths that normalize to the same task identically (case/slash-insensitive), matching runPublishChecks's own lockKey", async () => {
    const order: string[] = [];
    const first = queuePublishChecksRunV1("C:\\Tasks\\Task-F", async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push("first-end");
    });
    const second = queuePublishChecksRunV1("c:/tasks/task-f", () => {
      order.push("second-end");
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-end", "second-end"]);
  });
});
