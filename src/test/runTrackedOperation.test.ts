/**
 * Coverage for the C1 tracked-operation lifecycle: runTrackedOperation's
 * lock/terminal-state handling, the running → succeeded|failed|cancelled
 * state machine observed via onDidEnd, parent/child nesting (children skip
 * the exclusive lock, cancel cascades root → children, only roots render
 * Notifications rows), and leaf-stage spinner derivation (getActiveStages).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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

  void it("showTaskBusyWarning surfaces the busy operation's own label", async () => {
    const taskPath = `/tmp/rto-label-${Math.random()}`;
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    try {
      const handle = taskOperations.begin(taskPath, { label: "Running Implementation" });
      assert.ok(handle);
      await showTaskBusyWarning(taskPath);
      assert.ok(
        surface.entries.some((e) => e.message.includes("Running Implementation")),
        `expected the busy label in the warning; got: ${JSON.stringify(surface.entries)}`
      );
      taskOperations.end(handle);
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("stores the spec's taskName verbatim — unquoted; quoting is a render-time concern", async () => {
    const taskPath = `/tmp/rto-name-${Math.random()}`;
    let seen: TaskOperationSnapshot | undefined;

    await runTrackedOperation(
      taskPath,
      { label: "Rename Task", taskName: "ff for 1 pt 2" },
      () => {
        seen = taskOperations.getTaskOperations(taskPath)[0];
        return Promise.resolve();
      }
    );

    assert.ok(seen);
    assert.equal(seen.taskName, "ff for 1 pt 2");
    assert.equal(seen.taskName.includes('"'), false, "the stored taskName must carry no quote characters");
  });

  void it("source wiring: registers via begin() synchronously, with no progress-file read on the admission path", () => {
    // Same indexOf-over-source convention as stage3ActionMatrix.test.ts:
    // the optimistic-UI/admission contract is that runTrackedOperation's
    // body reaches taskOperations.begin() before any await or task-progress
    // read, so the Notifications row appears (or the busy refusal fires)
    // without any I/O.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "utils", "taskOperations.ts"),
      "utf8"
    );
    const fnStart = source.indexOf("export async function runTrackedOperation");
    assert.ok(fnStart >= 0, "runTrackedOperation must exist in taskOperations.ts");
    const beginCall = source.indexOf("taskOperations.begin(taskPath, spec)", fnStart);
    assert.ok(beginCall >= 0, "runTrackedOperation must register through taskOperations.begin");
    const admissionPath = source.slice(fnStart, beginCall);
    assert.ok(
      !admissionPath.includes("await"),
      "no await may precede begin() — registration must stay synchronous at entry"
    );
    assert.ok(
      !/readTaskProgress|task-progress\.json/.test(admissionPath),
      "no task-progress read may precede begin() on the admission path"
    );
  });

  void describe("workflow root taskName guard", () => {
    void it("throws when a stage-bearing root omits taskName and the basename default looks like the task-folder pattern", () => {
      const taskPath = "/workspace/tasks/2026-07-17_task_9";
      assert.throws(
        () => taskOperations.begin(taskPath, { label: "Run Implementation", stage: "impl" }),
        /taskName/,
        "a workflow root with no taskName must never silently fall back to basename(taskPath)"
      );
      // The refused/failed call must not have registered anything.
      assert.deepEqual(taskOperations.getTaskOperations(taskPath), []);
    });

    void it("does not throw for a stage-bearing root whose basename default does not look like the folder pattern", () => {
      const taskPath = `/tmp/rto-guard-safe-${Math.random()}`;
      const op = taskOperations.begin(taskPath, { label: "Run Implementation", stage: "impl" });
      assert.ok(op);
      taskOperations.end(op);
    });

    void it("does not throw when a caller explicitly resolves taskName, even when that value equals the folder-pattern string (an un-renamed task's real displayName)", () => {
      const taskPath = `/tmp/rto-guard-explicit-${Math.random()}`;
      const op = taskOperations.begin(taskPath, {
        label: "Run Implementation",
        stage: "impl",
        taskName: "2026-07-17_task_9",
      });
      assert.ok(op);
      assert.equal(taskOperations.getTaskOperations(taskPath)[0]?.taskName, "2026-07-17_task_9");
      taskOperations.end(op);
    });

    void it("does not throw for a non-stage (task-level) operation whose basename default looks like the folder pattern", () => {
      const taskPath = "/workspace/tasks/2026-07-17_task_9";
      const op = taskOperations.begin(taskPath, { label: "Commit and Push" });
      assert.ok(op);
      assert.equal(taskOperations.getTaskOperations(taskPath)[0]?.taskName, "2026-07-17_task_9");
      taskOperations.end(op);
    });

    void it("does not throw for a child operation, even when its own basename default looks like the folder pattern", async () => {
      const taskPath = "/workspace/tasks/2026-07-17_task_9";
      await runTrackedOperation(taskPath, { label: "Root", taskName: "wf9", stage: "impl-low-review" }, (root) => {
        const child = taskOperations.begin(taskPath, { parent: root, label: "Child", stage: "impl" });
        assert.ok(child, "children are exempt from the workflow-root taskName guard");
        taskOperations.end(child);
        return Promise.resolve();
      });
    });
  });

  void describe("reportActivity (in-flight Notifications status)", () => {
    void it("sets activity and an elapsed-time origin, resetting the origin only when asked", async () => {
      const taskPath = `/tmp/rto-activity-${Math.random()}`;
      const op = taskOperations.begin(taskPath, { label: "Root" });
      assert.ok(op);
      try {
        op.reportActivity("running", { resetElapsedOrigin: true });
        const first = taskOperations.getTaskOperations(taskPath)[0];
        assert.equal(first?.activity, "running");
        const firstOrigin = first?.activityStartedAt;
        assert.ok(typeof firstOrigin === "number");

        await new Promise((r) => setTimeout(r, 5));
        op.reportActivity("3 files changed"); // no resetElapsedOrigin — same activity span
        const second = taskOperations.getTaskOperations(taskPath)[0];
        assert.equal(second?.activity, "3 files changed");
        assert.equal(second?.activityStartedAt, firstOrigin, "the elapsed origin must not move on a routine repaint");

        op.reportActivity("running", { resetElapsedOrigin: true }); // a genuine stage transition
        const third = taskOperations.getTaskOperations(taskPath)[0];
        assert.ok(
          typeof third?.activityStartedAt === "number" && third.activityStartedAt >= firstOrigin,
          "resetElapsedOrigin must restart the timer"
        );
      } finally {
        taskOperations.end(op);
      }
    });

    void it("routes a child's activity report onto the root row, mirroring setResultTargetUri", async () => {
      const taskPath = `/tmp/rto-activity-child-${Math.random()}`;
      await runTrackedOperation(taskPath, { label: "Root" }, async (root) => {
        await runTrackedOperation(taskPath, { parent: root, label: "Child" }, (child) => {
          child.reportActivity("running", { resetElapsedOrigin: true });
          const rootRow = taskOperations.getRootOperations().find((op) => op.id === root.id);
          assert.equal(rootRow?.activity, "running");
          return Promise.resolve();
        });
      });
    });

    void it("is a no-op once the operation has ended — a delayed callback cannot resurrect a completed row", () => {
      const taskPath = `/tmp/rto-activity-ended-${Math.random()}`;
      const op = taskOperations.begin(taskPath, { label: "Root" });
      assert.ok(op);
      taskOperations.end(op);

      assert.doesNotThrow(() => op.reportActivity("running", { resetElapsedOrigin: true }));
      assert.deepEqual(taskOperations.getTaskOperations(taskPath), []);
    });
  });

  void describe("onDidChange persistenceRelevant flagging", () => {
    void it("flags begin/end/report/setModel/setWaitingForUser as persistence-relevant, and reportActivity as not", async () => {
      const taskPath = `/tmp/rto-flag-${Math.random()}`;
      const seen: boolean[] = [];
      const sub = taskOperations.onDidChange((event) => seen.push(event.persistenceRelevant));

      try {
        const op = taskOperations.begin(taskPath, { label: "Root", cancellable: true });
        assert.ok(op);
        await Promise.resolve();
        assert.deepEqual(seen, [true], "begin() must flag persistence-relevant");

        seen.length = 0;
        op.report("halfway there");
        await Promise.resolve();
        assert.deepEqual(seen, [true]);

        seen.length = 0;
        op.setModel?.("claude-cli:sonnet@high");
        await Promise.resolve();
        assert.deepEqual(seen, [true]);

        seen.length = 0;
        op.setWaitingForUser(true);
        await Promise.resolve();
        assert.deepEqual(seen, [true]);
        op.setWaitingForUser(false);
        await Promise.resolve();

        seen.length = 0;
        op.reportActivity("running", { resetElapsedOrigin: true });
        await Promise.resolve();
        assert.deepEqual(seen, [false], "an activity-only report must never flag persistence-relevant");

        seen.length = 0;
        taskOperations.end(op);
        await Promise.resolve();
        assert.deepEqual(seen, [true], "end() must flag persistence-relevant");
      } finally {
        sub.dispose();
      }
    });

    void it("coalesces a persistence-relevant change and an activity-only change in the same microtask as relevant", async () => {
      const taskPath = `/tmp/rto-flag-coalesce-${Math.random()}`;
      const seen: boolean[] = [];
      const sub = taskOperations.onDidChange((event) => seen.push(event.persistenceRelevant));
      try {
        const op = taskOperations.begin(taskPath, { label: "Root" });
        assert.ok(op);
        await Promise.resolve();
        seen.length = 0;

        // Both fired synchronously, before the coalesced microtask flushes.
        op.reportActivity("running", { resetElapsedOrigin: true });
        op.report("halfway there");
        await Promise.resolve();
        assert.deepEqual(seen, [true], "a persistence-relevant change in the batch must not be masked by an activity-only one");

        taskOperations.end(op);
      } finally {
        sub.dispose();
      }
    });
  });
});
