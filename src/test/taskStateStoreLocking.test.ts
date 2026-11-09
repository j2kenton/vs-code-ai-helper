import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { withTaskLock, withMetaRootLock, setStateLeaseWaitForTestsV1 } from "../state/taskStateStore";
import { PrimarySessionLock, PrimarySessionLockHeldError } from "../state/primarySessionLock";
import { safeRemoveDir } from "./testFsUtils";

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
  safeRemoveDir(TEST_ROOT);
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

// run1 Steps 21-22: a lease held by ANOTHER host (a lease file with another session id) is waited for,
// not failed on. This is bugs6 item 24: the owner's window held the workspace leases for a moment while
// it created a task, and the runner's round hit the lease and ended with no record.
void test(
  "a task write waits for a workspace lease another host holds, then runs, and a task created meanwhile exists",
  async () => {
    const tasksDir = path.join(TEST_ROOT, ".ensemble", "tasks-foreign-host");
    const taskA = path.join(tasksDir, "taskA");
    const taskB = path.join(tasksDir, "taskB");
    fs.mkdirSync(taskA, { recursive: true });
    // "Host B" holds the meta lease while it creates and renames task B.
    const hostB = new PrimarySessionLock(path.join(tasksDir, ".ensemble-meta.lock"));
    const releaseHostB = await hostB.acquire();
    setStateLeaseWaitForTestsV1([20, 20, 20, 20, 20, 20, 20, 20, 20, 20]);
    try {
      let ran = false;
      const hostA = withTaskLock(taskA, () => {
        ran = true;
        return Promise.resolve();
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(ran, false, "host A waits while host B holds the lease");
      fs.mkdirSync(taskB, { recursive: true });
      fs.renameSync(taskB, `${taskB}-renamed`);
      await releaseHostB();
      await hostA;
      assert.equal(ran, true);
      assert.ok(fs.existsSync(`${taskB}-renamed`));
    } finally {
      setStateLeaseWaitForTestsV1();
    }
  }
);

void test(
  "a task write whose wait for a held lease runs out throws the typed held error and holds nothing",
  async () => {
    const tasksDir = path.join(TEST_ROOT, ".ensemble", "tasks-foreign-host-exhausted");
    const taskA = path.join(tasksDir, "taskA");
    fs.mkdirSync(taskA, { recursive: true });
    const hostB = new PrimarySessionLock(path.join(tasksDir, ".ensemble-meta.lock"));
    const releaseHostB = await hostB.acquire();
    setStateLeaseWaitForTestsV1([5, 5]);
    try {
      await assert.rejects(
        withTaskLock(taskA, () => Promise.resolve()),
        (error: unknown) => error instanceof PrimarySessionLockHeldError
      );
      // Nothing the failed attempt took is left behind.
      assert.equal(fs.existsSync(path.join(tasksDir, "..", ".ensemble-session.lock")), false);
      assert.equal(fs.existsSync(path.join(taskA, ".ensemble-task.lock")), false);
    } finally {
      setStateLeaseWaitForTestsV1();
      await releaseHostB();
    }
  }
);
