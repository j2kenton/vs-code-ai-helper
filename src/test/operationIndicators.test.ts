import * as assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as vscode from "vscode";
import { StageNode } from "../views/taskTreeProvider";
import { StatusTreeProvider, StatusOperationNode } from "../views/statusView";
import { ViewProgressBinder } from "../utils/viewProgressBinder";
import { taskOperations } from "../utils/taskOperations";
import { IncompleteTask } from "../utils/taskProgressUtils";

void describe("operationIndicators", () => {
  beforeEach(() => {
    const all = taskOperations.getAll();
    for (const op of all) {
      taskOperations.end({ id: op.id, key: op.key } as any);
    }
  });

  void describe("StageNode spinner hoist", () => {
    void it("renders StageNode with loading icon when stage is running, even if status is not current", () => {
      const mockTask: IncompleteTask = {
        folderUri: vscode.Uri.file("/dev/task_1"),
        folderName: "task_1",
        progress: {
          taskFolder: "task_1",
          createdAt: new Date().toISOString(),
          currentStage: "impl-high-review",
          completedStages: ["desc", "plan", "impl"],
          updatedAt: new Date().toISOString(),
          status: "active",
        },
        canonicalId: "/dev/task_1",
      };

      const op = taskOperations.begin("/dev/task_1", {
        label: "Running Implementation",
        stage: "impl",
      });
      assert.ok(op);

      try {
        const node = new StageNode(mockTask, "impl", "done", vscode.Uri.file("/dev/task_1/plan-final.md"));
        assert.strictEqual(node.iconPath instanceof vscode.ThemeIcon ? node.iconPath.id : "", "loading~spin");
        assert.strictEqual(node.description, "running");
      } finally {
        taskOperations.end(op);
      }
    });
  });

  void describe("StatusTreeProvider", () => {
    let provider: StatusTreeProvider;

    beforeEach(() => {
      provider = new StatusTreeProvider();
    });

    void it("puts running operation nodes before historical entries, and they are not persisted or cleared by clear()", () => {
      provider.addEntry("Done action", "info");

      const op = taskOperations.begin("/dev/task_1", {
        label: "Running Op",
        taskName: "task_1",
      });
      assert.ok(op);

      try {
        const children = provider.getChildren() as StatusOperationNode[] | undefined;
        assert.ok(children);
        assert.strictEqual(children.length, 2);
        assert.ok(children[0]);
        assert.strictEqual(children[0].kind, "operation");
        assert.strictEqual(children[0].label, "Running Op");
        assert.ok(children[1]);
        assert.strictEqual((children[1] as any).message, "Done action");

        provider.clear();

        const childrenAfterClear = provider.getChildren() as StatusOperationNode[] | undefined;
        assert.ok(childrenAfterClear);
        assert.strictEqual(childrenAfterClear.length, 1);
        assert.ok(childrenAfterClear[0]);
        assert.strictEqual(childrenAfterClear[0].kind, "operation");
      } finally {
        taskOperations.end(op);
      }
    });
  });

  void describe("ViewProgressBinder", () => {
    let binder: ViewProgressBinder;

    beforeEach(() => {
      (vscode.window as any)._withProgressCalls = [];
      binder = new ViewProgressBinder(taskOperations);
    });

    afterEach(() => {
      binder.dispose();
      (vscode.window as any)._withProgressCalls = [];
    });

    // onDidChange is coalesced through queueMicrotask so a burst of operations
    // triggers a single refresh rather than one per mutation. Callers therefore
    // observe the effect on the next microtask, not synchronously.
    const flush = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve));

    void it("opens exactly one progress bar per view on first busy, and none for a second concurrent op", async () => {
      const calls = (vscode.window as any)._withProgressCalls;
      assert.strictEqual(calls.length, 0);

      const op1 = taskOperations.begin("/dev/task_1", { label: "Op 1" });
      assert.ok(op1);
      await flush();
      // One bar for the Tasks view, one for the Notifications view.
      assert.strictEqual(calls.length, 2);

      const op2 = taskOperations.begin("/dev/task_2", { label: "Op 2" });
      assert.ok(op2);
      await flush();
      // Already busy — the bars are refcounted in aggregate, not per operation.
      assert.strictEqual(calls.length, 2);

      taskOperations.end(op1);
      taskOperations.end(op2);
      await flush();
    });

    void it("keeps the bars up until the last operation ends", async () => {
      const op1 = taskOperations.begin("/dev/task_1", { label: "Op 1" });
      const op2 = taskOperations.begin("/dev/task_2", { label: "Op 2" });
      assert.ok(op1);
      assert.ok(op2);
      await flush();

      const settled: string[] = [];
      const bars = ((vscode.window as any)._withProgressCalls as { task: () => Promise<void> }[])
        .map((call, i) => call.task().then(() => { settled.push(`bar-${i}`); }));

      taskOperations.end(op1);
      await flush();
      assert.deepStrictEqual(settled, [], "bars must stay up while another operation is still running");

      taskOperations.end(op2);
      await flush();
      await Promise.all(bars);
      assert.strictEqual(settled.length, 2, "both bars must come down once the last operation ends");
    });
  });
});
