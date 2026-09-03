import * as assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as vscode from "vscode";
import { StageNode } from "../views/taskTreeProvider";
import { StatusTreeProvider, StatusTreeNode } from "../views/statusView";
import { ViewProgressBinder } from "../utils/viewProgressBinder";
import { taskOperations, TaskOperationHandle } from "../utils/taskOperations";
import { IncompleteTask } from "../types/incompleteTask";
import {
  NotificationRouter,
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";

interface WithProgressCall {
  options: unknown;
  task: () => Promise<void>;
}

/** vscode.window as exposed by test-stubs/vscode/index.js, with the test-only recorder attached. */
type TestWindow = typeof vscode.window & { _withProgressCalls: WithProgressCall[] };
const testWindow = vscode.window as TestWindow;

/** Minimal in-memory vscode.Memento stand-in for exercising StatusTreeProvider persistence. */
function makeMementoStub(initial: Record<string, unknown> = {}): vscode.Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (<T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : (defaultValue as T))) as vscode.Memento["get"],
    update: (key: string, value: unknown): Thenable<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
  } as unknown as vscode.Memento;
}

void describe("operationIndicators", () => {
  beforeEach(() => {
    for (const op of taskOperations.getAll()) {
      // getAll() returns readonly snapshots; end() only needs the id/key pair
      // a real TaskOperationHandle carries, so build a minimal one for cleanup.
      const handle: TaskOperationHandle = { id: op.id, key: op.key, label: op.label, stage: op.stage, report: () => {}, setWaitingForUser: () => {}, setResultTargetUri: () => {}, reportActivity: () => {} };
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

    void it("renders the live operation row with the task name in quotes (display name or folder-name fallback)", () => {
      const withDisplayName = taskOperations.begin("/dev/task_1", {
        label: "Rename Task",
        taskName: "ff for 1 pt 2",
      });
      const withFolderFallback = taskOperations.begin("/dev/task_2", {
        label: "Review",
        taskName: "2026-08-14_task_2",
      });
      assert.ok(withDisplayName && withFolderFallback);

      try {
        const children = provider.getChildren() as StatusTreeNode[];
        const opNodes = children.filter((n) => "kind" in n && n.kind === "operation");
        const labels = opNodes.map((n) => String(provider.getTreeItem(n).label));
        assert.ok(labels.includes('Rename Task — "ff for 1 pt 2"'), `got: ${JSON.stringify(labels)}`);
        assert.ok(labels.includes('Review — "2026-08-14_task_2"'), `got: ${JSON.stringify(labels)}`);
      } finally {
        taskOperations.end(withDisplayName);
        taskOperations.end(withFolderFallback);
      }
    });

    void it("translates a running review's stage to the review target it produces, not the pre-review stage it was launched from", () => {
      // `kind: "review"` operations register with the task's CURRENT
      // (pre-review) stage — e.g. "impl" — because a rerun can be launched
      // before the task has advanced onto its review stage (see
      // reviewReadiness.ts's REVIEW_TARGETS doc comment). The row must still
      // show "High-Level Code Review", not "Implementation", while it runs.
      const reviewOp = taskOperations.begin("/dev/task_3", {
        label: "Review",
        stage: "impl",
        taskName: "task_3",
        kind: "review",
      });
      // A non-review operation at the same pre-review stage must keep
      // showing the plain stage name (no translation) — translation is
      // scoped strictly to `kind: "review"`.
      const implOp = taskOperations.begin("/dev/task_4", {
        label: "Run Implementation",
        stage: "impl",
        taskName: "task_4",
        kind: "run-implementation",
      });
      assert.ok(reviewOp && implOp);

      try {
        const children = provider.getChildren() as StatusTreeNode[];
        const opNodes = children.filter((n) => "kind" in n && n.kind === "operation");
        const reviewNode = opNodes.find((n) => "id" in n && n.id === reviewOp.id);
        const implNode = opNodes.find((n) => "id" in n && n.id === implOp.id);
        assert.ok(reviewNode && implNode);

        const reviewDescription = String(provider.getTreeItem(reviewNode).description);
        const implDescription = String(provider.getTreeItem(implNode).description);
        assert.ok(
          reviewDescription.startsWith("High-Level Code Review"),
          `expected the review row's stage segment to read "High-Level Code Review", got: ${reviewDescription}`
        );
        assert.ok(
          implDescription.startsWith("Implementation"),
          `expected the non-review row's stage segment to stay "Implementation", got: ${implDescription}`
        );
      } finally {
        taskOperations.end(reviewOp);
        taskOperations.end(implOp);
      }
    });

    void it("shows the inline cancel action on a history entry only while its sourceOperationId is still a live cancellable root operation (D10)", () => {
      const op = taskOperations.begin("/dev/task_1", {
        label: "Fast Forward",
        taskName: "task_1",
        cancellable: true,
      });
      assert.ok(op);

      try {
        provider.addEntry("Fast Forward — task_1: running", "info", undefined, undefined, op.id);
        const children = provider.getChildren() as StatusTreeNode[];
        const live = children.find((n) => !("kind" in n));
        assert.ok(live && !("kind" in live));
        const liveItem = provider.getTreeItem(live);
        assert.strictEqual(liveItem.contextValue, "ensemble-notification-cancellable");

        taskOperations.end(op, "succeeded");

        const staleItem = provider.getTreeItem(live);
        assert.notStrictEqual(staleItem.contextValue, "ensemble-notification-cancellable");
      } catch (e) {
        taskOperations.end(op);
        throw e;
      }
    });

    void it("a live progress-summary notification (emitProgressSummary) carries a sourceOperationId that resolves to the currently-running root operation, so it can be cancelled before the operation ends", () => {
      // Regression coverage: progress-summary entries used to be created with
      // no sourceOperationId at all (only the terminal bridge — which fires
      // after the operation has already ended — attached one), so an
      // in-progress "Fast Forward — task_1: running" row had no way to
      // resolve to a live operation and never showed a cancel action while
      // it actually mattered.
      const op = taskOperations.begin("/dev/task_1", {
        label: "Fast Forward",
        taskName: "task_1",
        cancellable: true,
      });
      assert.ok(op);

      initNotificationRouter(provider);
      try {
        // Mirrors the real call sites (commitAndPushTask.ts, draftTaskWithAI.ts,
        // etc.): resolve the live root id from the registry at emit time,
        // while the operation is still running — not at termination.
        NotificationRouter.emitProgressSummary(
          "Fast Forward — task_1: running",
          taskOperations.rootOperationIdFor("/dev/task_1")
        );

        const children = provider.getChildren() as StatusTreeNode[];
        const live = children.find((n) => !("kind" in n) && n.message === "Fast Forward — task_1: running");
        assert.ok(live && !("kind" in live));
        const liveItem = provider.getTreeItem(live);
        assert.strictEqual(
          liveItem.contextValue,
          "ensemble-notification-cancellable",
          "a live progress-summary entry must resolve to a cancellable root operation while it is still running"
        );

        taskOperations.end(op, "succeeded");

        const staleItem = provider.getTreeItem(live);
        assert.notStrictEqual(
          staleItem.contextValue,
          "ensemble-notification-cancellable",
          "once the operation ends, the same entry must no longer show a cancel action"
        );
      } finally {
        deactivateNotificationRouter();
        taskOperations.end(op);
      }
    });

    void it("never shows the cancel action for an unknown/stale operation id", () => {
      provider.addEntry("Old run — task_1: completed", "info", undefined, undefined, "not-a-real-op-id");
      const [entry] = provider.getChildren() as StatusTreeNode[];
      assert.ok(entry && !("kind" in entry));
      const item = provider.getTreeItem(entry);
      assert.notStrictEqual(item.contextValue, "ensemble-notification-cancellable");
    });

    void it("never restores a persisted sourceOperationId from workspace state, even when it exactly matches a currently-live cancellable operation's id (D10 cross-session collision)", () => {
      // taskOperations mints ids from a counter that restarts at 0 every
      // activation, so an id written to workspace state in a prior session
      // can exactly match an unrelated operation's id in this session.
      // Simulate the worst case directly — a persisted entry whose id is
      // identical to a genuinely live, cancellable operation right now —
      // and confirm the restored entry still never shows a cancel action.
      const op = taskOperations.begin("/dev/task_2", {
        label: "Fast Forward",
        taskName: "task_2",
        cancellable: true,
      });
      assert.ok(op);

      try {
        const memento = makeMementoStub({
          "ensemble.notifications": [
            {
              message: "Old run — task_1: running",
              level: "info",
              timestamp: new Date().toISOString(),
              sourceOperationId: op.id,
            },
          ],
        });

        const restoredProvider = new StatusTreeProvider(memento);
        // The live "op" operation itself also renders as a running node
        // (kind: "operation") alongside the restored entry — find the entry
        // specifically rather than assuming it's first.
        const children = restoredProvider.getChildren() as StatusTreeNode[];
        const entry = children.find((n) => !("kind" in n));
        assert.ok(entry && !("kind" in entry));
        const item = restoredProvider.getTreeItem(entry);
        assert.notStrictEqual(
          item.contextValue,
          "ensemble-notification-cancellable",
          "a notification restored from workspace state must never show a cancel action, even if its persisted id collides with a genuinely live operation"
        );
      } finally {
        taskOperations.end(op);
      }
    });

    void it("does not write sourceOperationId when persisting notification entries to workspace state (D10)", async () => {
      const memento = makeMementoStub();
      const op = taskOperations.begin("/dev/task_3", {
        label: "Fast Forward",
        taskName: "task_3",
        cancellable: true,
      });
      assert.ok(op);

      try {
        const freshProvider = new StatusTreeProvider(memento);
        freshProvider.addEntry("Fast Forward — task_3: running", "info", undefined, undefined, op.id);
        // persist() writes through a promise chain (this.writes), not
        // synchronously — let it flush before inspecting the memento.
        await new Promise((r) => setImmediate(r));

        const persisted = memento.get<Array<Record<string, unknown>>>("ensemble.notifications", []);
        assert.ok(persisted.length > 0, "expected the entry to have been persisted");
        assert.ok(
          !Object.prototype.hasOwnProperty.call(persisted[0], "sourceOperationId"),
          `expected no sourceOperationId key in persisted state; got: ${JSON.stringify(persisted[0])}`
        );
      } finally {
        taskOperations.end(op);
      }
    });

    void it("never persists activity/activityStartedAt, and an activity-only report never triggers a running-operations state.update (in-flight status is ephemeral)", async () => {
      let runningOperationsWrites = 0;
      const memento = makeMementoStub();
      const trackedMemento: vscode.Memento = {
        ...memento,
        update: (key: string, value: unknown): Thenable<void> => {
          if (key === "ensemble.runningOperations") {runningOperationsWrites++;}
          return memento.update(key, value);
        },
      } as unknown as vscode.Memento;

      const freshProvider = new StatusTreeProvider(trackedMemento);
      const op = taskOperations.begin("/dev/task_activity", {
        label: "Running Implementation",
        stage: "impl",
        taskName: "task_activity",
      });
      assert.ok(op);

      try {
        // begin() is a lifecycle event — it must still persist, exactly as
        // before this task's changes.
        await new Promise((r) => setImmediate(r));
        const writesAfterBegin = runningOperationsWrites;
        assert.ok(writesAfterBegin > 0, "begin() must still trigger a running-operations persist");

        op.reportActivity("reading context (129 KB)", { resetElapsedOrigin: true });
        await new Promise((r) => setImmediate(r));
        assert.equal(
          runningOperationsWrites,
          writesAfterBegin,
          "an activity-only report must never trigger a running-operations state.update"
        );

        const persisted = memento.get<Array<Record<string, unknown>>>("ensemble.runningOperations", []);
        assert.ok(persisted.length > 0, "expected the root operation to have been persisted by begin()");
        for (const entry of persisted) {
          assert.ok(!("activity" in entry), `persisted snapshot must never carry activity; got: ${JSON.stringify(entry)}`);
          assert.ok(
            !("activityStartedAt" in entry),
            `persisted snapshot must never carry activityStartedAt; got: ${JSON.stringify(entry)}`
          );
        }

        // A genuinely persistence-relevant change afterward must still write.
        op.setModel?.("claude-cli:sonnet@high");
        await new Promise((r) => setImmediate(r));
        assert.ok(runningOperationsWrites > writesAfterBegin, "setModel must still trigger a running-operations persist");
      } finally {
        taskOperations.end(op);
        freshProvider.dispose();
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
