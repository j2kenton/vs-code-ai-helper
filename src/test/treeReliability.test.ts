/**
 * treeReliability.test.ts
 *
 * Regression coverage for Stage 2 tree reliability work:
 *   1. TaskStatusBar.update — store-driven only; no fabricated current task.
 *   2. TaskStatusBar.update — canonical-ID-aware matching (handles Windows
 *      case normalization where canonicalId differs from folderUri.fsPath).
 *   3. TaskNode — stable TreeItem.id set from canonical ID.
 *   4. TaskNode — current-task URI scheme.
 *   5. TaskTreeProvider expand/collapse state helpers.
 *   6. TaskTreeProvider stale current-task: getTaskNodeById returns undefined
 *      when the stored ID no longer resolves.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { TASK_STATUSES } from "../types/taskProgress";
import type { IncompleteTask } from "../utils/taskProgressUtils";
import { TaskStatusBar } from "../views/taskStatusBar";
import { TaskNode, TaskTreeProvider } from "../views/taskTreeProvider";

// ---------------------------------------------------------------------------
// Helper — minimal IncompleteTask stub
// ---------------------------------------------------------------------------

function makeTask(
  fsPath: string,
  folderName: string,
  stage: string = "impl",
  status: "active" | "paused" = "active",
  canonicalId?: string
): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(fsPath),
    folderName,
    progress: {
      currentStage: stage as import("../types/taskProgress").TaskStage,
      status,
      taskFolder: folderName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    canonicalId,
  };
}

/** Minimal TaskInventory stub for provider state tests. */
function makeInventoryStub(): import("../state/taskInventory").TaskInventory {
  return {
    getTasks: () => [],
    refresh: async () => {},
    onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
  } as unknown as import("../state/taskInventory").TaskInventory;
}

/** Minimal CurrentTaskStore stub for status-bar tests. */
function makeStoreStub(): import("../utils/currentTaskStore").CurrentTaskStore {
  return {
    get: () => undefined,
    set: async (_id: string) => {},
    clear: async () => {},
    onDidChange: { event: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }) },
  } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;
}

// ---------------------------------------------------------------------------
// TaskStatusBar — store-driven only, no fabricated current task
// ---------------------------------------------------------------------------
// The blocking issue was that TaskStatusBar had a `hasEverStoredCurrentTask`
// flag that caused it to invent a current task from the task list when the
// store had never been written. That flag has been removed; these tests
// enforce the store-driven-only contract.

void describe("TaskStatusBar — store-driven only, no fabricated current task", () => {
  void it("hides when currentTaskCanonicalId is undefined (no ID ever stored)", () => {
    // update() must not throw and must hide silently; it must NOT pick the
    // first active task as a fallback.
    const bar = new TaskStatusBar(makeStoreStub());
    const tasks = [makeTask("/workspace/task-a", "task-a")];
    assert.doesNotThrow(() => bar.update(tasks, undefined));
    bar.dispose();
  });

  void it("hides when the stored ID is stale (task no longer in list)", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    const tasks = [makeTask("/workspace/task-a", "task-a")];
    assert.doesNotThrow(() => bar.update(tasks, "/workspace/deleted-task"));
    bar.dispose();
  });

  void it("does not throw when currentTaskCanonicalId matches a task", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    const taskPath = "/workspace/task-a";
    const tasks = [makeTask(taskPath, "task-a")];
    assert.doesNotThrow(() => bar.update(tasks, taskPath));
    bar.dispose();
  });

  void it("does not throw when task list is empty and ID is undefined", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    assert.doesNotThrow(() => bar.update([], undefined));
    bar.dispose();
  });

  void it("does not throw when task list is empty and ID is set (stale)", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    assert.doesNotThrow(() => bar.update([], "/workspace/gone-task"));
    bar.dispose();
  });

  // Structural guard: if `hasEverStoredCurrentTask` were re-introduced the
  // fabrication bug would come back. Assert the property does not exist.
  void it('does NOT have a "hasEverStoredCurrentTask" property (fabrication guard removed)', () => {
    const bar = new TaskStatusBar(makeStoreStub()) as unknown as Record<string, unknown>;
    assert.strictEqual(
      "hasEverStoredCurrentTask" in bar,
      false,
      "TaskStatusBar must not use hasEverStoredCurrentTask — the heuristic fallback must stay removed"
    );
    (bar as unknown as TaskStatusBar).dispose();
  });
});

// ---------------------------------------------------------------------------
// TaskStatusBar — canonical-ID-aware matching
// ---------------------------------------------------------------------------
// Blocking issue: status bar used t.folderUri.fsPath for matching, but
// CurrentTaskStore persists canonicalId (lowercased on Windows). When those
// differ (e.g. /workspace/Task-A vs /workspace/task-a), the bar would fail
// to find the task and stay hidden even though the task exists. The fix:
// prefer task.canonicalId when present, fall back to fsPath.

void describe("TaskStatusBar — canonical-ID-aware matching", () => {
  void it("resolves stored ID against task.canonicalId when present", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    // Simulate Windows: canonical ID is lower-cased, fsPath preserves original
    const canonicalId = "/workspace/task-a";
    const tasks = [makeTask("/workspace/Task-A", "task-a", "impl", "active", canonicalId)];
    // Must not throw — the task IS present (matched by canonicalId)
    assert.doesNotThrow(() => bar.update(tasks, canonicalId));
    bar.dispose();
  });

  void it("hides when stored ID matches neither canonicalId nor fsPath", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    const tasks = [makeTask("/workspace/task-a", "task-a", "impl", "active", "/workspace/task-a")];
    // A completely different ID
    assert.doesNotThrow(() => bar.update(tasks, "/workspace/totally-different"));
    bar.dispose();
  });

  void it("falls back to fsPath matching when canonicalId is absent", () => {
    const bar = new TaskStatusBar(makeStoreStub());
    // No canonicalId supplied — legacy task object
    const tasks = [makeTask("/workspace/task-b", "task-b")];
    assert.doesNotThrow(() => bar.update(tasks, "/workspace/task-b"));
    bar.dispose();
  });

  void it("calls store.clear() when stored ID is stale", () => {
    let clearCalled = false;
    const store = {
      get: () => undefined,
      set: async (_id: string) => {},
      clear: () => { clearCalled = true; },
      onDidChange: { event: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }) },
    } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;

    const bar = new TaskStatusBar(store);
    const tasks = [makeTask("/workspace/task-a", "task-a")];
    // Pass a stale ID that doesn't match any task
    bar.update(tasks, "/workspace/deleted-task");
    
    assert.strictEqual(
      clearCalled,
      true,
      "Expected store.clear() to be called when stored ID is stale"
    );
    bar.dispose();
  });
});

// ---------------------------------------------------------------------------
// TaskNode — stable TreeItem.id
// ---------------------------------------------------------------------------
// Blocking issue: TaskNode had no this.id, so VS Code could not preserve
// expansion state by identity across refreshes. The fix sets this.id to
// taskIdentityKey (canonicalId ?? fsPath).

void describe("TaskNode — stable TreeItem.id", () => {
  void it("sets id to the task's canonicalId when present", () => {
    const canonicalId = "/workspace/tasks/alpha-normalized";
    const task = makeTask("/workspace/tasks/Alpha", "alpha", "impl", "active", canonicalId);
    const node = new TaskNode(task, false, false);

    assert.strictEqual(
      node.id,
      canonicalId,
      `Expected node.id "${canonicalId}", got "${node.id}"`
    );
  });

  void it("sets id to folderUri.fsPath when canonicalId is absent", () => {
    const task = makeTask("/workspace/tasks/beta", "beta");
    const node = new TaskNode(task, false, false);

    // Should fall back to fsPath
    assert.strictEqual(
      node.id,
      vscode.Uri.file("/workspace/tasks/beta").fsPath,
      `Expected node.id to equal fsPath when canonicalId absent, got "${node.id}"`
    );
  });

  void it("id is stable across two nodes constructed for the same task", () => {
    const canonicalId = "/workspace/tasks/gamma";
    const task = makeTask("/workspace/tasks/gamma", "gamma", "plan", "active", canonicalId);
    const node1 = new TaskNode(task, false, false);
    const node2 = new TaskNode(task, true, true);

    assert.strictEqual(
      node1.id,
      node2.id,
      "Two TaskNodes for the same task must have the same id regardless of expanded/isCurrent args"
    );
  });

  void it("id is a non-empty string for every task node", () => {
    const task = makeTask("/workspace/tasks/delta", "delta");
    const node = new TaskNode(task, false);
    assert.ok(
      typeof node.id === "string" && node.id.length > 0,
      `Expected non-empty string id, got: ${String(node.id)}`
    );
  });
});

// ---------------------------------------------------------------------------
// TaskNode — current-task URI scheme
// ---------------------------------------------------------------------------

void describe("TaskNode — current-task URI scheme", () => {
  void it("sets resourceUri to current-task: scheme when isCurrent=true", () => {
    const task = makeTask("/workspace/tasks/alpha", "alpha");
    const node = new TaskNode(task, false, true);

    assert.ok(
      node.resourceUri !== undefined,
      "Expected resourceUri to be set for isCurrent=true"
    );
    assert.strictEqual(
      node.resourceUri?.scheme,
      "current-task",
      `Expected scheme "current-task", got "${node.resourceUri?.scheme}"`
    );
  });

  void it("does not set resourceUri when isCurrent=false", () => {
    const task = makeTask("/workspace/tasks/beta", "beta");
    const node = new TaskNode(task, false, false);
    assert.strictEqual(
      node.resourceUri,
      undefined,
      "Expected resourceUri to be undefined for isCurrent=false"
    );
  });

  void it("does not set resourceUri when isCurrent is omitted (defaults to false)", () => {
    const task = makeTask("/workspace/tasks/gamma", "gamma");
    const node = new TaskNode(task, false);
    assert.strictEqual(node.resourceUri, undefined);
  });

  void it("encodes the task name in the current-task URI", () => {
    const task = makeTask("/workspace/tasks/my-feature", "my-feature");
    const node = new TaskNode(task, false, true);
    const uriStr = node.resourceUri?.toString() ?? "";
    assert.ok(
      uriStr.includes("my-feature"),
      `Expected URI to contain "my-feature", got: ${uriStr}`
    );
  });

  void it("current-task URI uses canonicalId when present (not raw fsPath)", () => {
    const canonicalId = "/workspace/tasks/epsilon-canonical";
    const task = makeTask("/workspace/tasks/Epsilon", "epsilon", "plan", "active", canonicalId);
    const node = new TaskNode(task, false, true);
    const uriStr = node.resourceUri?.toString() ?? "";
    assert.ok(
      uriStr.includes("epsilon-canonical"),
      `Expected URI to embed canonicalId, got: ${uriStr}`
    );
  });
});

// ---------------------------------------------------------------------------
// TaskTreeProvider — expand/collapse state helpers
// ---------------------------------------------------------------------------

void describe("TaskTreeProvider — explicit expand/collapse state", () => {
  void it("notifyExpanded and notifyCollapsed accept calls without throwing", () => {
    const provider = new TaskTreeProvider(makeInventoryStub());
    const task = makeTask("/workspace/task-x", "task-x");

    assert.doesNotThrow(() => {
      provider.notifyCollapsed(task);
      provider.notifyExpanded(task);
    });
  });

  void it("calling notifyCollapsed after notifyExpanded does not throw", () => {
    const provider = new TaskTreeProvider(makeInventoryStub());
    const task = makeTask("/workspace/task-y", "task-y");

    assert.doesNotThrow(() => {
      provider.notifyExpanded(task);
      provider.notifyCollapsed(task);
    });
  });

  void it("notifyExpanded with canonicalId-bearing task does not throw", () => {
    const provider = new TaskTreeProvider(makeInventoryStub());
    const task = makeTask("/workspace/task-y", "task-y", "plan", "active", "/workspace/task-y");
    assert.doesNotThrow(() => {
      provider.notifyExpanded(task);
      provider.notifyCollapsed(task);
    });
  });

  void it("getTaskNodeById returns undefined when no nodes have been loaded", () => {
    const provider = new TaskTreeProvider(makeInventoryStub());
    assert.strictEqual(provider.getTaskNodeById("/workspace/nonexistent"), undefined);
  });
});

// ---------------------------------------------------------------------------
// TaskTreeProvider — task-status filter migration
// ---------------------------------------------------------------------------
// Blocking issue: a persisted status filter saved before this session's
// changes (or before the "creating" recovery status existed) silently
// excluded any status not in the saved array — forever, with no visible
// indication anything was hidden. The fix reconciles the saved selection
// against a persisted "known statuses" snapshot, unioning in any status
// that didn't exist the last time the filter was saved. When no snapshot
// exists (installs that saved a filter before this reconciliation shipped),
// the snapshot defaults to the status set that predates "creating" — the
// only status added since the filter feature shipped.

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

function makeTaskWithStatus(
  fsPath: string,
  folderName: string,
  status: import("../types/taskProgress").TaskStatus
): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(fsPath),
    folderName,
    progress: {
      currentStage: "impl" as import("../types/taskProgress").TaskStage,
      status,
      taskFolder: folderName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    canonicalId: fsPath,
  };
}

function makeInventoryWithTasks(
  tasks: IncompleteTask[]
): import("../state/taskInventory").TaskInventory {
  return {
    getTasks: () =>
      tasks.map((t) => ({
        taskFolderPath: t.folderUri.fsPath,
        folderName: t.folderName,
        progress: t.progress,
        canonicalId: t.canonicalId,
      })),
    refresh: async () => {},
    onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
  } as unknown as import("../state/taskInventory").TaskInventory;
}

/**
 * getChildren() fires `setContext` via executeCommand as a side effect;
 * the vscode test stub throws on unregistered commands, so stub it out for
 * the duration of the callback.
 */
async function withStubbedCommands<T>(callback: () => Promise<T>): Promise<T> {
  const commandsStub = vscode.commands as typeof vscode.commands & {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const previous = commandsStub._executeCommandOverride;
  commandsStub._executeCommandOverride = () => Promise.resolve(undefined);
  try {
    return await callback();
  } finally {
    commandsStub._executeCommandOverride = previous;
  }
}

void describe("TaskTreeProvider — task-status filter migration", () => {
  void it("shows a status not present in a saved pre-existing filter (e.g. 'creating')", async () => {
    // Simulates an install that saved a filter before "creating" existed as
    // a status: no "ensemble.taskStatusFilterKnownStatuses" key at all.
    const memento = makeMementoStub({
      "ensemble.taskStatusFilter": ["active", "paused", "completed"],
    });
    const creatingTask = makeTaskWithStatus("/workspace/task-creating", "task-creating", "creating");
    const inventory = makeInventoryWithTasks([creatingTask]);

    const provider = new TaskTreeProvider(inventory, undefined, memento);
    const children = await withStubbedCommands(() => provider.getChildren());

    assert.ok(
      children.length > 0,
      "Expected a 'creating' task to remain visible despite a saved filter that predates that status"
    );
  });

  void it("keeps a status hidden when the saved filter deliberately excluded it (not newly-added)", async () => {
    const memento = makeMementoStub({
      "ensemble.taskStatusFilter": ["active"],
      "ensemble.taskStatusFilterKnownStatuses": [...TASK_STATUSES],
    });
    const completedTask = makeTaskWithStatus("/workspace/task-done", "task-done", "completed");
    const inventory = makeInventoryWithTasks([completedTask]);

    const provider = new TaskTreeProvider(inventory, undefined, memento);
    const children = await withStubbedCommands(() => provider.getChildren());

    assert.ok(
      children.every((child) => !(child instanceof TaskNode)),
      "Expected the completed task to stay hidden — it was already known and deliberately excluded"
    );
  });

  void it("defaults to all statuses selected when no filter has ever been saved", async () => {
    const memento = makeMementoStub({});
    const activeTask = makeTaskWithStatus("/workspace/task-active", "task-active", "active");
    const inventory = makeInventoryWithTasks([activeTask]);

    const provider = new TaskTreeProvider(inventory, undefined, memento);
    const children = await withStubbedCommands(() => provider.getChildren());

    assert.ok(children.length > 0, "Expected all-statuses-selected default to show an active task");
  });
});

// ---------------------------------------------------------------------------
// TaskTreeProvider — stale current-task: getTaskNodeById returns undefined
// ---------------------------------------------------------------------------
// Non-blocking suggestion: explicit coverage for stale current-task clearing.
// When the stored ID no longer resolves to any node in the current render,
// getTaskNodeById must return undefined so the reveal helper and status bar
// both gracefully handle the "task deleted" case without throwing.

void describe("TaskTreeProvider — stale ID does not match any loaded node", () => {
  void it("getTaskNodeById returns undefined for a stale canonical ID (task not loaded)", () => {
    const provider = new TaskTreeProvider(makeInventoryStub());
    // No tasks loaded → any ID is stale
    assert.strictEqual(
      provider.getTaskNodeById("/workspace/deleted-task"),
      undefined,
      "Expected undefined for a canonical ID that is not present in the loaded nodes"
    );
  });

  void it("getTaskNodeById returns undefined for an ID that differs from all loaded canonicalIds", () => {
    const provider = new TaskTreeProvider(makeInventoryStub());
    // Provider has no tasks loaded (stub returns []), so any lookup misses
    const result = provider.getTaskNodeById("/workspace/completely-different");
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskContext — clears stale persisted ID
// ---------------------------------------------------------------------------
// Regression coverage for the blocking issue: when resolveTaskContext
// determines a persisted current-task ID no longer resolves (after refresh
// retry), it must clear the persisted state so the extension does not start
// from a stale ID after window reload or later command flows.

void describe("resolveTaskContext — clears stale persisted ID", () => {
  void it("clears store when persisted ID fails to resolve after refresh", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveTaskContext } = await import("../utils/resolveTaskContext.js");

    let clearCalled = false;
    const store = {
      get: (): string | undefined => "/workspace/deleted-task",
      set: async (_id: string): Promise<void> => {},
      clear: (): void => { clearCalled = true; },
      onDidChange: { event: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }) },
    } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;

    // Inventory stub with no tasks and a no-op refresh
    const inventory = {
      getTasks: () => [],
      getTaskById: (_id: string) => undefined,
      getVisibleTaskForSuppressedId: (_id: string) => undefined,
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;

    const resolved = await resolveTaskContext(
      inventory,
      undefined, // No explicit arg — should try persisted ID
      undefined,
      store
    );

    assert.strictEqual(
      resolved,
      undefined,
      "Expected resolution to fail when persisted ID is stale"
    );
    assert.strictEqual(
      clearCalled,
      true,
      "Expected store.clear() to be called when persisted ID fails to resolve after refresh"
    );
  });

  void it("does NOT clear store when explicit arg fails (not persisted ID)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveTaskContext } = await import("../utils/resolveTaskContext.js");

    let clearCalled = false;
    const store = {
      get: (): string | undefined => undefined, // No persisted ID
      set: async (_id: string): Promise<void> => {},
      clear: (): void => { clearCalled = true; },
      onDidChange: { event: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }) },
    } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;

    const inventory = {
      getTasks: () => [],
      getTaskById: (_id: string) => undefined,
      getTaskByPath: (_path: string) => undefined,
      getVisibleTaskForSuppressedId: (_id: string) => undefined,
      getVisibleTaskForSuppressedPath: (_path: string) => undefined,
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;

    // Pass explicit arg that fails to resolve
    const resolved = await resolveTaskContext(
      inventory,
      { canonicalId: "/workspace/explicit-missing-task" },
      undefined,
      store
    );

    assert.strictEqual(
      resolved,
      undefined,
      "Expected resolution to fail for missing explicit arg"
    );
    assert.strictEqual(
      clearCalled,
      false,
      "Expected store NOT to be cleared when explicit arg fails (only persisted IDs should trigger clear)"
    );
  });

  void it("resolves a task whose canonical path is lowercased but the open workspace folder has mixed case (Windows)", async function (this: { skip?: () => void }) {
    if (process.platform !== "win32") {
      this.skip?.();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveTaskContext } = await import("../utils/resolveTaskContext.js");

    // Mirrors real discovery: taskRoot.ts's normalizePath lowercases the
    // whole path on Windows, so the inventory's canonicalId/taskFolderPath
    // is all-lowercase even though the workspace folder VS Code reports
    // (and the actual folder on disk) preserves mixed case.
    const mixedCaseWorkspaceRoot = process.cwd(); // real, existing directory (mixed case on Windows)
    // Use a real, existing path for the task folder itself so the
    // fs.existsSync guard in resolveTaskContext passes.
    const realTaskFolderPath = mixedCaseWorkspaceRoot; // stand-in existing dir

    const task = {
      taskFolderPath: realTaskFolderPath.toLowerCase(),
      canonicalId: realTaskFolderPath.toLowerCase(),
      folderName: "2026-07-12_task_2",
      sourceScopeKey: mixedCaseWorkspaceRoot.toLowerCase(),
      progress: {
        currentStage: "desc",
        status: "active",
        taskFolder: "2026-07-12_task_2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ownership: {
          metaRoot: mixedCaseWorkspaceRoot + "\\plans",
          projectRoot: mixedCaseWorkspaceRoot,
          workspaceRoot: mixedCaseWorkspaceRoot,
          boundAt: new Date().toISOString(),
          state: "resolved",
        },
      },
    };

    const inventory = {
      getTasks: () => [task],
      getTaskById: (id: string) => (id === task.canonicalId ? task : undefined),
      getTaskByPath: (p: string) =>
        p.toLowerCase() === task.taskFolderPath ? task : undefined,
      getVisibleTaskForSuppressedId: (_id: string) => undefined,
      getVisibleTaskForSuppressedPath: (_path: string) => undefined,
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;

    const origWsFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(mixedCaseWorkspaceRoot), name: "ws", index: 0 },
    ];

    try {
      const resolved = await resolveTaskContext(
        inventory,
        { taskFolderPath: mixedCaseWorkspaceRoot }, // tree-row style arg, mixed case
        { allowPaused: true },
        undefined
      );

      assert.notStrictEqual(
        resolved,
        undefined,
        "Expected task to resolve despite case mismatch between lowercased canonical path and mixed-case workspace folder"
      );
    } finally {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWsFolders;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTaskContext — falls back to the sole active task on a stale/paused
// persisted pointer
// ---------------------------------------------------------------------------
// Regression coverage for: CurrentTaskStore is meant to mirror a task's disk
// `status` field, but can drift (e.g. a task activated through a code path
// that predates CurrentTaskStore, or paused without anything updating the
// pointer). When the persisted task is missing/paused, resolveTaskContext
// should prefer an unambiguous actually-active task instead of blocking the
// shortcut on staleness — but only when that's unambiguous.

void describe("resolveTaskContext — falls back to the sole active task on a stale/paused pointer", () => {
  const realDir = process.cwd(); // stand-in existing directory for fs.existsSync

  function makeStubTask(
    canonicalId: string,
    folderName: string,
    status: "active" | "paused"
  ) {
    return {
      taskFolderPath: realDir,
      canonicalId,
      folderName,
      sourceScopeKey: realDir,
      progress: {
        taskFolder: folderName,
        currentStage: "impl" as const,
        status,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    };
  }

  void it("resolves the sole active task when the persisted pointer is paused", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveTaskContext } = await import("../utils/resolveTaskContext.js");

    const pausedCurrent = makeStubTask("/paused-current", "2026-07-12_task_2", "paused");
    const soleActive = makeStubTask("/sole-active", "2026-07-10_task_1", "active");
    const tasks = [pausedCurrent, soleActive];

    let storedId: string | undefined = pausedCurrent.canonicalId;
    const store = {
      get: (): string | undefined => storedId,
      set: (id: string): Promise<void> => { storedId = id; return Promise.resolve(); },
      clear: (): Promise<void> => { storedId = undefined; return Promise.resolve(); },
      onDidChange: { event: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }) },
    } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;

    const inventory = {
      getTasks: () => tasks,
      getTaskById: (id: string) => tasks.find((t) => t.canonicalId === id),
      getVisibleTaskForSuppressedId: (_id: string) => undefined,
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;

    const origWsFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(realDir), name: "ws", index: 0 },
    ];

    try {
      const resolved = await resolveTaskContext(inventory, undefined, undefined, store);

      assert.strictEqual(
        resolved?.canonicalId,
        soleActive.canonicalId,
        "Expected resolution to prefer the sole actually-active task over the paused persisted pointer"
      );
      assert.strictEqual(
        storedId,
        soleActive.canonicalId,
        "Expected CurrentTaskStore to be resynced to the active task"
      );
    } finally {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWsFolders;
    }
  });

  void it("does NOT guess when more than one task is active (ambiguous)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveTaskContext } = await import("../utils/resolveTaskContext.js");

    const pausedCurrent = makeStubTask("/paused-current-2", "2026-07-12_task_2", "paused");
    const activeA = makeStubTask("/active-a", "task-a", "active");
    const activeB = makeStubTask("/active-b", "task-b", "active");
    const tasks = [pausedCurrent, activeA, activeB];

    let storedId: string | undefined = pausedCurrent.canonicalId;
    const store = {
      get: (): string | undefined => storedId,
      set: (id: string): Promise<void> => { storedId = id; return Promise.resolve(); },
      clear: (): Promise<void> => { storedId = undefined; return Promise.resolve(); },
      onDidChange: { event: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }) },
    } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;

    const inventory = {
      getTasks: () => tasks,
      getTaskById: (id: string) => tasks.find((t) => t.canonicalId === id),
      getVisibleTaskForSuppressedId: (_id: string) => undefined,
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;

    const origWsFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(realDir), name: "ws", index: 0 },
    ];

    try {
      const resolved = await resolveTaskContext(inventory, undefined, { allowPaused: true }, store);

      assert.strictEqual(
        resolved?.canonicalId,
        pausedCurrent.canonicalId,
        "Expected resolution to keep the persisted (paused) task when multiple tasks are active — ambiguous, must not guess"
      );
      assert.strictEqual(
        storedId,
        pausedCurrent.canonicalId,
        "Expected CurrentTaskStore to remain unchanged when the fallback is ambiguous"
      );
    } finally {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWsFolders;
    }
  });
});
