import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { withTaskLock, withMetaRootLock } from "../state/taskStateStore";

// Regression coverage for a review finding: task activation
// (taskActivationCoordinator.ts) used to acquire a lock file at a different
// path than ordinary per-task mutations (withTaskLock), so the two could run
// concurrently and activation could overwrite/miss a concurrent
// status/progress write. Both now derive their lock paths from the same
// `metaLocksForTasksRoot` helper in taskStateStore.ts; this test proves that
// by actually contending for the locks rather than just comparing strings.
//
// Mutations issued by the same extension host are queued before acquiring the
// cross-process lease. This prevents a repeated task action from failing with
// "Another Ensemble session..." while preserving the on-disk lock for other
// extension hosts.

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-lock-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

void test(
  "withMetaRootLock waits for a withTaskLock mutation under the same tasks root",
  async () => {
    const tasksDir = path.join(TEST_ROOT, ".ensemble", "tasks-exclude");
    const taskA = path.join(tasksDir, "taskA");
    fs.mkdirSync(taskA, { recursive: true });

    let releaseHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });

    const opA = withTaskLock(taskA, async () => {
      await held;
    });

    // Give op A a moment to actually acquire its lock before contending.
    await new Promise((resolve) => setTimeout(resolve, 50));

    let ranWhileHeld = false;
    const opB = withMetaRootLock(tasksDir, () => {
      ranWhileHeld = true;
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ranWhileHeld, false);

    releaseHeld();
    await opA;
    await opB;
    assert.equal(ranWhileHeld, true);

    // Once A has released, the same lock is free for withMetaRootLock.
    let ranAfterRelease = false;
    await withMetaRootLock(tasksDir, () => {
      ranAfterRelease = true;
      return Promise.resolve();
    });
    assert.equal(ranAfterRelease, true);
  }
);

void test(
  "withTaskLock waits for a withMetaRootLock mutation under the same tasks root",
  async () => {
    const tasksDir = path.join(TEST_ROOT, ".ensemble", "tasks-reverse");
    const taskA = path.join(tasksDir, "taskA");
    fs.mkdirSync(taskA, { recursive: true });

    let releaseHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });

    const opMeta = withMetaRootLock(tasksDir, async () => {
      await held;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    let ranWhileHeld = false;
    const opTask = withTaskLock(taskA, () => {
      ranWhileHeld = true;
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ranWhileHeld, false);

    releaseHeld();
    await opMeta;
    await opTask;
    assert.equal(ranWhileHeld, true);
  }
);
