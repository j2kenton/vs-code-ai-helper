/**
 * A round that stops without unwinding must stop being shown as running
 * (abandonedOperationReaperV1.ts + TaskOperationRegistry.endAbandonedOperation).
 *
 * The incident: a provider CLI exited on a usage limit two seconds into a
 * review, nothing unwound the round, and the operation was still advertised as
 * running seven hours later — spinner, progress bar and Notifications row all
 * reporting work that had stopped (2026-09-17).
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  ABANDONED_OPERATION_RENEWAL_AGE_MS_V1,
  describeAbandonedOperationV1,
  findAbandonedOperationsV1,
} from "../state/abandonedOperationReaperV1";
import { TaskOperationRegistry, TaskOperationSnapshot } from "../utils/taskOperations";

const TASK = process.platform === "win32" ? "C:\\w\\.ensemble\\t1" : "/w/.ensemble/t1";
const OTHER = process.platform === "win32" ? "C:\\w\\.ensemble\\t2" : "/w/.ensemble/t2";
const STALE = ABANDONED_OPERATION_RENEWAL_AGE_MS_V1 + 1;

function op(overrides: Partial<TaskOperationSnapshot> & { id: string }): TaskOperationSnapshot {
  return {
    key: TASK,
    label: "Fast Forward Review",
    taskName: "Clear Stale Provider Error Messages",
    startedAt: 1000,
    exclusive: true,
    cancellable: true,
    state: "running",
    waitingForUser: false,
    ...overrides,
  };
}

void describe("abandonedOperationReaperV1", () => {
  void it("reaps a root whose admission stopped being renewed", () => {
    const found = findAbandonedOperationsV1([op({ id: "op-11" })], () => STALE);
    assert.deepEqual(
      found.map((f) => ({ id: f.id, task: f.taskPath })),
      [{ id: "op-11", task: TASK }]
    );
    assert.match(describeAbandonedOperationV1(found[0]!), /Fast Forward Review — "Clear Stale Provider Error Messages" stopped without reporting/);
    assert.match(describeAbandonedOperationV1(found[0]!), /run log/, "and says where to look");
  });

  void it("leaves alone everything that is not evidence of a stopped round", () => {
    const renewals = (taskPath: string): number | undefined => (taskPath === TASK ? STALE : undefined);
    assert.deepEqual(
      findAbandonedOperationsV1(
        [
          // Renewing normally: the owner is alive.
          op({ id: "fresh" }),
          // Waiting on a person is not stalling, however long it lasts.
          op({ id: "waiting", waitingForUser: true }),
          // A child never owns admission; ending its root cascades to it.
          op({ id: "child", parentId: "root" }),
          // Already finished.
          op({ id: "done", state: "succeeded" }),
          // Holds no admission at all (e.g. a rename): nothing to judge it by.
          op({ id: "no-admission", key: OTHER }),
        ],
        (taskPath) => (taskPath === TASK ? 60_000 : renewals(taskPath))
      ),
      []
    );
    // Only the genuinely stale one, and only once its age passes the bound.
    assert.deepEqual(findAbandonedOperationsV1([op({ id: "x" })], () => ABANDONED_OPERATION_RENEWAL_AGE_MS_V1), []);
    assert.equal(findAbandonedOperationsV1([op({ id: "x" })], () => STALE).length, 1);
  });

  void describe("ending one", () => {
    let registry: TaskOperationRegistry;
    beforeEach(() => {
      registry = new TaskOperationRegistry();
    });

    void it("removes it and its children, and reports a terminal outcome", () => {
      const root = registry.begin(TASK, { label: "Fast Forward Review", cancellable: true });
      assert.ok(root);
      const child = registry.begin(TASK, { label: "Review", parent: root, stage: "impl-high-review" });
      assert.ok(child);
      const ended: { id: string; state: string }[] = [];
      registry.onDidEnd((snapshot) => ended.push({ id: snapshot.id, state: snapshot.state }));

      assert.equal(registry.endAbandonedOperation(root.id), true);
      assert.deepEqual(registry.getTaskOperations(TASK), [], "nothing is left advertising the task as busy");
      assert.deepEqual(ended.map((e) => e.state), ["cancelled", "cancelled"], "both are recorded, not silently dropped");
      assert.equal(registry.begin(TASK, { label: "Run Review" }) !== null, true, "and the task can be worked on again");
    });

    void it("never touches another window's mirrored work, or an unknown id", () => {
      registry.setMirroredOperations([{ ...op({ id: "op-1" }), key: TASK }]);
      assert.equal(registry.endAbandonedOperation("runner:op-1"), false, "the runner ends its own");
      assert.equal(registry.getTaskOperations(TASK).length, 1);
      assert.equal(registry.endAbandonedOperation("op-99"), false);
    });

    void it("a second Stop press force-ends an operation that ignored the first", () => {
      // The dead end seen live: the token had already fired with nobody
      // listening, so Stop answered "can no longer be cancelled" about a row
      // still shown as running, and only a window reload cleared it.
      const root = registry.begin(TASK, { label: "Fast Forward Review", cancellable: true });
      assert.ok(root);
      assert.equal(registry.cancelOperation(root.id), true, "the first press requests cancellation");
      assert.equal(root.token?.isCancellationRequested, true);
      assert.equal(registry.getTaskOperations(TASK).length, 1, "and waits for the owner to unwind");

      assert.equal(registry.cancelOperation(root.id), true, "the second press is not a dead end");
      assert.deepEqual(registry.getTaskOperations(TASK), [], "it is gone");
    });
  });
});
