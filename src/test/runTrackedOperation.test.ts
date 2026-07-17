/**
 * Coverage for the C1 tracked-operation lifecycle: runTrackedOperation's
 * lock/terminal-state handling, the running → succeeded|failed|cancelled
 * state machine observed via onDidEnd, parent/child nesting (children skip
 * the exclusive lock, cancel cascades root → children, only roots render
 * Notifications rows), and leaf-stage spinner derivation (getActiveStages).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  runTrackedOperation,
  taskOperations,
  showTaskBusyWarning,
  linkCancellationTokens,
  TaskOperationSnapshot,
} from "../utils/taskOperations";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

void describe("runTrackedOperation", () => {
  void it("begins the operation, runs fn, ends the operation, and returns fn's result", async () => {
    const taskPath = `/tmp/rto-success-${Math.random()}`;
    let sawOperationDuringRun = false;

    const result = await runTrackedOperation(taskPath, { label: "Test Op" }, () => {
      sawOperationDuringRun = taskOperations.getTaskOperations(taskPath).length === 1;
      return Promise.resolve(42);
    });

    assert.equal(result, 42);
    assert.equal(sawOperationDuringRun, true, "the operation must be registered while fn runs");
    assert.deepEqual(taskOperations.getTaskOperations(taskPath), [], "the operation must be ended afterward");
  });

  void it("refuses and warns instead of running fn when the task is already busy", async () => {
    const taskPath = `/tmp/rto-busy-${Math.random()}`;
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    try {
      const existing = taskOperations.begin(taskPath, { label: "First Op" });
      assert.ok(existing, "precondition: first operation must be admitted");

      let fnCalled = false;
      const result = await runTrackedOperation(taskPath, { label: "Second Op" }, () => {
        fnCalled = true;
        return Promise.resolve("should not run");
      });

      assert.equal(result, undefined);
      assert.equal(fnCalled, false, "fn must not run when the task is busy");
      assert.ok(
        surface.entries.some((e) => /already in progress/.test(e.message)),
        `expected a busy warning; got: ${JSON.stringify(surface.entries)}`
      );

      taskOperations.end(existing);
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("still ends the operation when fn throws, and propagates the error", async () => {
    const taskPath = `/tmp/rto-throws-${Math.random()}`;

    await assert.rejects(
      () => runTrackedOperation(taskPath, { label: "Failing Op" }, () => Promise.reject(new Error("boom"))),
      /boom/
    );

    assert.deepEqual(
      taskOperations.getTaskOperations(taskPath),
      [],
      "the operation must be ended even when fn throws, so the lock never leaks"
    );
  });

  void it("does not refuse a second non-exclusive operation on the same task", async () => {
    const taskPath = `/tmp/rto-nonexclusive-${Math.random()}`;
    const first = taskOperations.begin(taskPath, { label: "Advisory", exclusive: false });
    assert.ok(first);

    const result = await runTrackedOperation(taskPath, { label: "Second Advisory", exclusive: false }, () => Promise.resolve("ran"));
    assert.equal(result, "ran");

    taskOperations.end(first);
  });

  void it("records terminal states through the running → succeeded/failed/cancelled machine (onDidEnd)", async () => {
    const taskPath = `/tmp/rto-states-${Math.random()}`;
    const ended: TaskOperationSnapshot[] = [];
    const sub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("rto-states")) {ended.push(snap);}
    });

    try {
      await runTrackedOperation(taskPath, { label: "Succeeds" }, () => Promise.resolve("ok"));
      await assert.rejects(
        () => runTrackedOperation(taskPath, { label: "Fails" }, () => Promise.reject(new Error("boom"))),
        /boom/
      );
      await assert.rejects(
        () =>
          runTrackedOperation(taskPath, { label: "Cancels", cancellable: true }, (handle) => {
            taskOperations.cancelOperation(handle.id);
            return Promise.reject(new vscode.CancellationError());
          })
      );
      // Cancelled token + normal unwind (no throw) still ends as cancelled.
      await runTrackedOperation(taskPath, { label: "Cancels Quietly", cancellable: true }, (handle) => {
        taskOperations.cancelOperation(handle.id);
        return Promise.resolve();
      });

      assert.deepEqual(
        ended.map((snap) => snap.state),
        ["succeeded", "failed", "cancelled", "cancelled"]
      );
      assert.ok(
        ended.every((snap) => typeof snap.finishedAt === "number"),
        "every terminal snapshot must carry finishedAt"
      );
    } finally {
      sub.dispose();
    }
  });

  void it("registers children without contending for the exclusive lock, and hides them from root queries", async () => {
    const taskPath = `/tmp/rto-children-${Math.random()}`;

    await runTrackedOperation(taskPath, { label: "Root", stage: "plan-low-review" }, async (root) => {
      const result = await runTrackedOperation(
        taskPath,
        { parent: root, label: "Child Apply", stage: "plan" },
        (child) => {
          assert.equal(child.parentId, root.id);
          const roots = taskOperations
            .getRootOperations()
            .filter((op) => op.key === root.key);
          assert.equal(roots.length, 1, "only the root renders a Notifications row");
          assert.equal(roots[0]?.id, root.id);
          return Promise.resolve("child-ran");
        }
      );
      // A child begin is never refused by the root's own exclusive lock.
      assert.equal(result, "child-ran");
    });
  });

  void it("derives the stage spinner from leaf operations (getActiveStages)", async () => {
    const taskPath = `/tmp/rto-stages-${Math.random()}`;

    await runTrackedOperation(taskPath, { label: "Root", stage: "plan-low-review" }, async (root) => {
      assert.deepEqual(taskOperations.getActiveStages(taskPath), ["plan-low-review"]);

      await runTrackedOperation(taskPath, { parent: root, label: "Applying", stage: "plan" }, () => {
        // While the apply child runs, the spinner belongs to the plan row only.
        assert.deepEqual(taskOperations.getActiveStages(taskPath), ["plan"]);
        return Promise.resolve();
      });

      // Child ended — the spinner returns to the root's stage.
      assert.deepEqual(taskOperations.getActiveStages(taskPath), ["plan-low-review"]);
    });
  });

  void it("cancelling a root cascades to its running children and surfaces on tokens", async () => {
    const taskPath = `/tmp/rto-cascade-${Math.random()}`;

    await runTrackedOperation(
      taskPath,
      { label: "Root", stage: "impl-low-review", cancellable: true },
      async (root) => {
        await runTrackedOperation(
          taskPath,
          { parent: root, label: "Child Run", stage: "impl", cancellable: true },
          (child) => {
            assert.ok(root.token && child.token, "both operations carry tokens");
            assert.equal(taskOperations.cancelOperation(root.id), true);
            assert.equal(root.token.isCancellationRequested, true, "root token fired");
            assert.equal(child.token.isCancellationRequested, true, "cascade fired the child token");
            return Promise.resolve();
          }
        );
      }
    );
  });

  void it("tokenFor exposes the exclusive root's token to code that never received the handle", async () => {
    const taskPath = `/tmp/rto-tokenfor-${Math.random()}`;

    await runTrackedOperation(taskPath, { label: "Root", cancellable: true }, (root) => {
      const token = taskOperations.tokenFor(taskPath);
      assert.ok(token, "the exclusive root's token is discoverable by task path");
      taskOperations.cancelOperation(root.id);
      assert.equal(token.isCancellationRequested, true);
      return Promise.resolve();
    });

    assert.equal(taskOperations.tokenFor(taskPath), undefined, "no token once the operation ended");
  });

  void it("surfaces a running child's detail on the root row (getRootOperations fallback)", async () => {
    const taskPath = `/tmp/rto-detail-${Math.random()}`;

    await runTrackedOperation(taskPath, { label: "Root" }, async (root) => {
      await runTrackedOperation(taskPath, { parent: root, label: "Child" }, (child) => {
        child.report("iteration 2/5");
        const rootRow = taskOperations
          .getRootOperations()
          .find((op) => op.id === root.id);
        assert.equal(rootRow?.detail, "iteration 2/5");

        root.report("root detail wins");
        const rootRowAfter = taskOperations
          .getRootOperations()
          .find((op) => op.id === root.id);
        assert.equal(rootRowAfter?.detail, "root detail wins");
        return Promise.resolve();
      });
    });
  });

  void it("linkCancellationTokens fires when any source token fires, and honors pre-cancelled sources", () => {
    const a = new vscode.CancellationTokenSource();
    const b = new vscode.CancellationTokenSource();
    const linked = linkCancellationTokens(a.token, undefined, b.token);
    assert.equal(linked.token.isCancellationRequested, false);
    b.cancel();
    assert.equal(linked.token.isCancellationRequested, true);
    linked.dispose();

    const pre = new vscode.CancellationTokenSource();
    pre.cancel();
    const linkedPre = linkCancellationTokens(pre.token);
    assert.equal(linkedPre.token.isCancellationRequested, true);
    linkedPre.dispose();
  });

  void it("showTaskBusyWarning surfaces the busy operation's own label", () => {
    const taskPath = `/tmp/rto-label-${Math.random()}`;
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    try {
      const handle = taskOperations.begin(taskPath, { label: "Running Implementation" });
      assert.ok(handle);
      showTaskBusyWarning(taskPath);
      assert.ok(
        surface.entries.some((e) => e.message.includes("Running Implementation")),
        `expected the busy label in the warning; got: ${JSON.stringify(surface.entries)}`
      );
      taskOperations.end(handle);
    } finally {
      deactivateNotificationRouter();
    }
  });
});
