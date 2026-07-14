import * as assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as vscode from "vscode";
import { taskKey, TaskOperationRegistry } from "../utils/taskOperations";

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
});
