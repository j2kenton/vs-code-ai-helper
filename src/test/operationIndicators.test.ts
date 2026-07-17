import * as assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as vscode from "vscode";
import { StageNode } from "../views/taskTreeProvider";
import { StatusTreeProvider, StatusTreeNode } from "../views/statusView";
import { ViewProgressBinder } from "../utils/viewProgressBinder";
import { taskOperations, TaskOperationHandle } from "../utils/taskOperations";
import { IncompleteTask } from "../utils/taskProgressUtils";

interface WithProgressCall {
  options: unknown;
  task: () => Promise<void>;
}

/** vscode.window as exposed by test-stubs/vscode/index.js, with the test-only recorder attached. */
type TestWindow = typeof vscode.window & { _withProgressCalls: WithProgressCall[] };
const testWindow = vscode.window as TestWindow;

void describe("operationIndicators", () => {
  beforeEach(() => {
    for (const op of taskOperations.getAll()) {
      // getAll() returns readonly snapshots; end() only needs the id/key pair
      // a real TaskOperationHandle carries, so build a minimal one for cleanup.
      const handle: TaskOperationHandle = { id: op.id, key: op.key, label: op.label, stage: op.stage, report: () => {} };
      taskOperations.end(handle);
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
        const children = provider.getChildren() as StatusTreeNode[] | undefined;
        assert.ok(children);
        assert.strictEqual(children.length, 2);
        const [first, second] = children;
        assert.ok(first && "kind" in first && first.kind === "operation");
        assert.strictEqual(first.label, "Running Op");
        assert.ok(second && !("kind" in second));
        assert.strictEqual(second.message, "Done action");

        provider.clear();

        const childrenAfterClear = provider.getChildren() as StatusTreeNode[] | undefined;
        assert.ok(childrenAfterClear);
        assert.strictEqual(childrenAfterClear.length, 1);
        const [remaining] = childrenAfterClear;
        assert.ok(remaining && "kind" in remaining && remaining.kind === "operation");
      } finally {
        taskOperations.end(op);
      }
    });
  });

  void describe("ViewProgressBinder", () => {
    let binder: ViewProgressBinder;

    beforeEach(() => {
      testWindow._withProgressCalls = [];
      // Short show delay so these tests stay fast while still exercising the
      // debounced-show contract (default is VIEW_PROGRESS_SHOW_DELAY_MS).
      binder = new ViewProgressBinder(taskOperations, 5);
    });

    afterEach(() => {
      binder.dispose();
      testWindow._withProgressCalls = [];
    });

    // onDidChange is coalesced through queueMicrotask so a burst of operations
    // triggers a single refresh rather than one per mutation. Callers therefore
    // observe the effect on the next microtask, not synchronously.
    const flush = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve));
    // The bar only appears once the registry stays busy past the show delay
    // (anti-flicker debounce for instant mutations).
    const waitForShowDelay = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25));

    void it("opens exactly one progress bar (Tasks view only), and none for a second concurrent op", async () => {
      const calls = testWindow._withProgressCalls;
      assert.strictEqual(calls.length, 0);

      const op1 = taskOperations.begin("/dev/task_1", { label: "Op 1" });
      assert.ok(op1);
      await waitForShowDelay();
      // A single bar, on the Tasks view. The Notifications view deliberately
      // gets none — its persistent operation row already shows the state.
      assert.strictEqual(calls.length, 1);

      const op2 = taskOperations.begin("/dev/task_2", { label: "Op 2" });
      assert.ok(op2);
      await waitForShowDelay();
      // Already busy — the bar is refcounted in aggregate, not per operation.
      assert.strictEqual(calls.length, 1);

      taskOperations.end(op1);
      taskOperations.end(op2);
      await flush();
    });

    void it("keeps the bar up until the last operation ends", async () => {
      const op1 = taskOperations.begin("/dev/task_1", { label: "Op 1" });
      const op2 = taskOperations.begin("/dev/task_2", { label: "Op 2" });
      assert.ok(op1);
      assert.ok(op2);
      await waitForShowDelay();

      const settled: string[] = [];
      const bars = testWindow._withProgressCalls
        .map((call, i) => call.task().then(() => { settled.push(`bar-${i}`); }));
      assert.strictEqual(bars.length, 1, "exactly one bar (Tasks view) is open");

      taskOperations.end(op1);
      await flush();
      assert.deepStrictEqual(settled, [], "the bar must stay up while another operation is still running");

      taskOperations.end(op2);
      await flush();
      await Promise.all(bars);
      assert.strictEqual(settled.length, 1, "the bar must come down once the last operation ends");
    });
  });
});
