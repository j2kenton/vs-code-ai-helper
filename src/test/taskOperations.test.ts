import * as assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as vscode from "vscode";
import { taskKey, TaskOperationRegistry, runTrackedOperation } from "../utils/taskOperations";

void describe("taskOperations", () => {
  let registry: TaskOperationRegistry;

  beforeEach(() => {
    registry = new TaskOperationRegistry();
  });

  void describe("Windows key normalization", () => {
    void it("normalizes Windows paths to be case-insensitive", () => {
      const path1 = "C:\\Dev\\Plans\\Task_1";
      const path2 = "c:\\dev\\plans\\task_1";
      const key1 = taskKey(path1);
      const key2 = taskKey(path2);
      if (process.platform === "win32") {
        assert.strictEqual(key1, key2);
      } else {
        assert.notStrictEqual(key1, key2);
      }
    });

    void it("can retrieve active task operations with normalized key", () => {
      const path1 = process.platform === "win32" ? "C:\\Dev\\Plans\\Task_1" : "/dev/plans/task_1";
      const path2 = process.platform === "win32" ? "c:\\dev\\plans\\task_1" : "/dev/plans/task_1";

      const op = registry.begin(path1, { label: "Test Op" });
      assert.ok(op);

      const ops = registry.getTaskOperations(path2);
      assert.strictEqual(ops.length, 1);
      assert.ok(ops[0]);
      assert.strictEqual(ops[0].label, "Test Op");

      registry.end(op);
      assert.strictEqual(registry.getTaskOperations(path2).length, 0);
    });
  });

  void describe("lock and exclusivity rules", () => {
    void it("refuses a second exclusive operation on a busy task", () => {
      const task = "/dev/task_1";
      const op1 = registry.begin(task, { label: "Op 1", exclusive: true });
      assert.ok(op1);

      const op2 = registry.begin(task, { label: "Op 2", exclusive: true });
      assert.strictEqual(op2, null);

      registry.end(op1);

      const op3 = registry.begin(task, { label: "Op 3", exclusive: true });
      assert.ok(op3);
      registry.end(op3);
    });

    void it("allows multiple non-exclusive operations and does not block exclusive ones", () => {
      const task = "/dev/task_1";
      const op1 = registry.begin(task, { label: "Op 1", exclusive: false });
      assert.ok(op1);

      const op2 = registry.begin(task, { label: "Op 2", exclusive: false });
      assert.ok(op2);

      const op3 = registry.begin(task, { label: "Op 3", exclusive: true });
      assert.ok(op3);

      const op4 = registry.begin(task, { label: "Op 4", exclusive: true });
      assert.strictEqual(op4, null);

      registry.end(op1);
      registry.end(op2);
      registry.end(op3);
    });

    void it("end is idempotent", () => {
      const task = "/dev/task_1";
      const op = registry.begin(task, { label: "Op" });
      assert.ok(op);

      registry.end(op);
      assert.strictEqual(registry.hasAny(), false);

      assert.doesNotThrow(() => registry.end(op));
      assert.strictEqual(registry.hasAny(), false);
    });
  });

  void describe("leak / try-finally guarantees", () => {
    void it("leaves hasAny() as false on success, error, and cancellation", async () => {
      const task = "/dev/task_1";

      const runWithLock = async (fn: () => void | Promise<void>): Promise<void> => {
        const op = registry.begin(task, { label: "Work" });
        assert.ok(op);
        try {
          await fn();
        } finally {
          registry.end(op);
        }
      };

      await runWithLock(async () => {});
      assert.strictEqual(registry.hasAny(), false);

      await assert.rejects(
        runWithLock(() => {
          throw new Error("fail");
        })
      );
      assert.strictEqual(registry.hasAny(), false);

      await assert.rejects(
        runWithLock(() => {
          throw new vscode.CancellationError();
        })
      );
      assert.strictEqual(registry.hasAny(), false);
    });
  });

  void describe("setResultTargetUri / setResultTargetUriForTask (D11)", () => {
    void it("records the click-to-open target on the handle's own operation when it is the root", () => {
      const task = "/dev/task_1";
      const op = registry.begin(task, { label: "Generate Plan" });
      assert.ok(op);
      op.setResultTargetUri(vscode.Uri.file("/dev/task_1/runs/001-plan.md"));
      const [snap] = registry.getTaskOperations(task);
      assert.equal(snap?.resultTargetUri, vscode.Uri.file("/dev/task_1/runs/001-plan.md").toString());
      registry.end(op);
    });

    void it("resolves a child's setResultTargetUri call onto the root operation, not the child", () => {
      const task = "/dev/task_1";
      const root = registry.begin(task, { label: "Fast Forward" });
      assert.ok(root);
      const child = registry.begin(task, { label: "Run Implementation", parent: root });
      assert.ok(child);

      child.setResultTargetUri(vscode.Uri.file("/dev/task_1/runs/002-impl.md"));

      const rootSnap = registry.getTaskOperations(task).find((o) => o.id === root.id);
      const childSnap = registry.getTaskOperations(task).find((o) => o.id === child.id);
      assert.equal(rootSnap?.resultTargetUri, vscode.Uri.file("/dev/task_1/runs/002-impl.md").toString());
      assert.equal(childSnap?.resultTargetUri, undefined);

      registry.end(child);
      registry.end(root);
    });

    void it("setResultTargetUriForTask addresses the task's exclusive (root) operation directly", () => {
      const task = "/dev/task_1";
      const op = registry.begin(task, { label: "Run Implementation" });
      assert.ok(op);
      const ok = registry.setResultTargetUriForTask(task, vscode.Uri.file("/dev/task_1/runs/003-impl.md"));
      assert.equal(ok, true);
      const [snap] = registry.getTaskOperations(task);
      assert.equal(snap?.resultTargetUri, vscode.Uri.file("/dev/task_1/runs/003-impl.md").toString());
      registry.end(op);
    });

    void it("fails predictably (returns false, no throw) for an unknown or already-ended operation", () => {
      const task = "/dev/task_1";
      const op = registry.begin(task, { label: "Draft" });
      assert.ok(op);
      registry.end(op);

      // Ended operation: the id is no longer in the registry.
      assert.equal(
        registry.setResultTargetUri(op.id, vscode.Uri.file("/dev/task_1/runs/late.md")),
        false
      );
      // Unknown task path: no exclusive operation to address.
      assert.equal(
        registry.setResultTargetUriForTask("/dev/task_999", vscode.Uri.file("/dev/task_999/runs/x.md")),
        false
      );
    });
  });

  void describe("rootOperationIdFor (live progress-summary sourceOperationId)", () => {
    void it("resolves to the task's live exclusive (root) operation id while it is running", () => {
      const task = "/dev/task_1";
      const op = registry.begin(task, { label: "Draft with AI", cancellable: true });
      assert.ok(op);
      assert.equal(registry.rootOperationIdFor(task), op.id);
      registry.end(op);
    });

    void it("resolves a nested call's task path onto the root, not a child id", () => {
      const task = "/dev/task_1";
      const root = registry.begin(task, { label: "Fast Forward" });
      assert.ok(root);
      const child = registry.begin(task, { label: "Run Implementation", parent: root });
      assert.ok(child);

      // Both root and child share the same task path, so a live progress
      // summary emitted from deep inside the child's work still resolves to
      // the ROOT id — that's the id the Notifications surface's
      // isLiveCancellableOperation check looks up via getRootOperations().
      assert.equal(registry.rootOperationIdFor(task), root.id);

      registry.end(child);
      registry.end(root);
    });

    void it("returns undefined once the operation has ended (no stale id lingers)", () => {
      const task = "/dev/task_1";
      const op = registry.begin(task, { label: "Draft with AI" });
      assert.ok(op);
      registry.end(op);
      assert.equal(registry.rootOperationIdFor(task), undefined);
    });

    void it("returns undefined for a task with no live operation at all", () => {
      assert.equal(registry.rootOperationIdFor("/dev/never_started"), undefined);
    });
  });

  // Part 4 / item 16 (Step 10): a best-effort observer, given the operation's
  // FINAL terminal state before end() removes the row, so a caller with many
  // early-return guard clauses (e.g. `runImplementationWithAI`) can react to
  // "this run achieved nothing" in one place without threading a run-log
  // write through every guard clause individually. Uses the module-level
  // `runTrackedOperation` (the global singleton registry), not the local
  // `registry` instance the rest of this file exercises directly.
  void describe("runTrackedOperation onSettled observer (item 16, Part 4 Step 10)", () => {
    void it("reports the explicit settleAs state and reason before end() removes the row", async () => {
      const seen: { state?: string; reason?: string } = {};
      const result = await runTrackedOperation(
        "/dev/onSettled_explicit",
        {
          label: "Test Op",
          refusedWhenFalse: true,
          onSettled: (state, reason) => {
            seen.state = state;
            seen.reason = reason;
          },
        },
        (op) => {
          op.settleAs("refused", "no plan-final.md to implement from");
          return Promise.resolve(false);
        }
      );
      assert.equal(result, false);
      assert.equal(seen.state, "refused");
      assert.equal(seen.reason, "no plan-final.md to implement from");
    });

    void it("reports 'refused' when refusedWhenFalse derives the outcome (no explicit settleAs)", async () => {
      const seen: { state?: string } = {};
      const result = await runTrackedOperation(
        "/dev/onSettled_refusedWhenFalse",
        { label: "Test Op", refusedWhenFalse: true, onSettled: (state) => { seen.state = state; } },
        () => Promise.resolve(false)
      );
      assert.equal(result, false);
      assert.equal(seen.state, "refused");
    });

    void it("reports 'succeeded' on a normal successful return", async () => {
      const seen: { state?: string } = {};
      const result = await runTrackedOperation(
        "/dev/onSettled_succeeded",
        { label: "Test Op", onSettled: (state) => { seen.state = state; } },
        () => Promise.resolve(true)
      );
      assert.equal(result, true);
      assert.equal(seen.state, "succeeded");
    });

    void it("reports 'failed' when the body throws, and the error still propagates", async () => {
      const seen: { state?: string } = {};
      await assert.rejects(
        runTrackedOperation(
          "/dev/onSettled_thrown",
          { label: "Test Op", onSettled: (state) => { seen.state = state; } },
          () => Promise.reject(new Error("boom"))
        ),
        /boom/
      );
      assert.equal(seen.state, "failed");
    });

    void it("swallows an observer that itself throws, without breaking the operation's own settlement", async () => {
      const result = await runTrackedOperation(
        "/dev/onSettled_observerThrows",
        {
          label: "Test Op",
          onSettled: () => {
            throw new Error("observer boom");
          },
        },
        () => Promise.resolve(true)
      );
      assert.equal(result, true);
    });
  });
});
