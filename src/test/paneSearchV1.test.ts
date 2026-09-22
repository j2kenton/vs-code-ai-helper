import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { EmptyTasksNode, TaskNode, TaskTreeProvider, taskMatchesSearchV1 } from "../views/taskTreeProvider";
import { StatusTreeProvider, notificationMatchesSearchV1 } from "../views/statusView";
import { taskOperations } from "../utils/taskOperations";
import type { IncompleteTask } from "../types/incompleteTask";
import type { TaskStage } from "../types/taskProgress";

class FakeMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

function task(
  name: string,
  stage: TaskStage = "impl",
  extra: { displayName?: string; status?: string } = {}
): IncompleteTask {
  const folderUri = vscode.Uri.file(`/workspace/tasks/${name}`);
  return {
    folderUri,
    folderName: name,
    canonicalId: folderUri.fsPath,
    progress: {
      currentStage: stage,
      status: extra.status ?? "active",
      taskFolder: name,
      displayName: extra.displayName,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
  } as unknown as IncompleteTask;
}

void describe("taskMatchesSearchV1", () => {
  void it("matches case-insensitively across display name, folder name and stage name", () => {
    const t = task("2026-09-20_task_3", "impl", { displayName: "Fix Login Bug" });
    assert.equal(taskMatchesSearchV1(t, "login"), true);
    assert.equal(taskMatchesSearchV1(t, "TASK_3"), true);
    assert.equal(taskMatchesSearchV1(t, "implementation"), true);
    assert.equal(taskMatchesSearchV1(t, "payments"), false);
  });

  void it("requires every whitespace-separated word to match, in any order and field", () => {
    const t = task("2026-09-20_task_3", "impl", { displayName: "Fix Login Bug" });
    assert.equal(taskMatchesSearchV1(t, "bug login"), true);
    assert.equal(taskMatchesSearchV1(t, "login  task_3"), true);
    assert.equal(taskMatchesSearchV1(t, "login payments"), false);
  });

  void it("treats an empty or whitespace-only query as matching everything", () => {
    assert.equal(taskMatchesSearchV1(task("a"), ""), true);
    assert.equal(taskMatchesSearchV1(task("a"), "   "), true);
  });
});

void describe("notificationMatchesSearchV1", () => {
  void it("is case-insensitive, needs every word, and matches the full untruncated message", () => {
    const longTail = `${"x".repeat(400)} quota exhausted`;
    assert.equal(notificationMatchesSearchV1({ message: longTail }, "QUOTA"), true);
    assert.equal(notificationMatchesSearchV1({ message: "Round failed: quota exhausted" }, "round quota"), true);
    assert.equal(notificationMatchesSearchV1({ message: "Round failed" }, "round quota"), false);
    assert.equal(notificationMatchesSearchV1({ message: "anything" }, ""), true);
  });
});

void describe("TaskTreeProvider search", () => {
  function inventoryOf(tasks: IncompleteTask[]): import("../state/taskInventory").TaskInventory {
    return {
      getTasks: () =>
        tasks.map((t) => ({ taskFolderPath: t.folderUri.fsPath, folderName: t.folderName, progress: t.progress, canonicalId: t.canonicalId })),
      refresh: async (): Promise<void> => {},
      onDidChange: (): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;
  }

  async function children(provider: TaskTreeProvider): Promise<unknown[]> {
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const previous = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
    try {
      return await provider.getChildren();
    } finally {
      commandsStub._executeCommandOverride = previous;
    }
  }

  const names = (nodes: unknown[]): string[] =>
    nodes.filter((n): n is TaskNode => n instanceof TaskNode).map((n) => n.task.folderName);

  void it("keeps only matching tasks, and clearing restores them all", async () => {
    const memento = new FakeMemento();
    const provider = new TaskTreeProvider(
      inventoryOf([task("alpha", "impl", { displayName: "Login work" }), task("beta", "plan")]),
      undefined,
      memento as unknown as vscode.Memento
    );
    try {
      assert.deepEqual(names(await children(provider)).sort(), ["alpha", "beta"]);
      provider.setSearchQuery("login");
      assert.deepEqual(names(await children(provider)), ["alpha"]);
      assert.deepEqual(provider.getSearchSummary(), { matched: 1, total: 2 });
      provider.clearSearch();
      assert.deepEqual(names(await children(provider)).sort(), ["alpha", "beta"]);
      assert.equal(provider.getSearchSummary(), undefined);
    } finally {
      provider.dispose();
    }
  });

  void it("shows a search-specific empty row whose click clears the search", async () => {
    const provider = new TaskTreeProvider(
      inventoryOf([task("alpha")]),
      undefined,
      new FakeMemento() as unknown as vscode.Memento
    );
    try {
      provider.setSearchQuery("zzz");
      const nodes = await children(provider);
      assert.equal(nodes.length, 1);
      const empty = nodes[0] as EmptyTasksNode;
      assert.ok(empty instanceof EmptyTasksNode);
      assert.equal(empty.label, "No tasks match 'zzz'");
      assert.equal(empty.command?.command, "vs-code-ai-helper.clearTasksSearch");
    } finally {
      provider.dispose();
    }
  });

  void it("keeps the status-filter empty state when the status filter, not the search, hides everything", async () => {
    const provider = new TaskTreeProvider(
      inventoryOf([task("gone", "impl", { status: "archived" })]),
      undefined,
      new FakeMemento() as unknown as vscode.Memento
    );
    try {
      provider.setSearchQuery("gone");
      const empty = (await children(provider))[0] as EmptyTasksNode;
      assert.ok(empty instanceof EmptyTasksNode);
      assert.equal(empty.label, "No matching tasks");
      assert.equal(empty.command?.command, "vs-code-ai-helper.resetTaskStatusFilter");
    } finally {
      provider.dispose();
    }
  });

  void it("composes with the status filter and writes no workspace-state key of its own", async () => {
    const memento = new FakeMemento();
    const provider = new TaskTreeProvider(
      inventoryOf([task("alpha-old", "impl", { status: "archived" }), task("alpha-new", "impl")]),
      undefined,
      memento as unknown as vscode.Memento
    );
    try {
      const keysBefore = [...memento.values.keys()].sort();
      provider.setSearchQuery("alpha");
      assert.deepEqual(names(await children(provider)), ["alpha-new"], "archived stays hidden by the status filter");
      assert.deepEqual([...memento.values.keys()].sort(), keysBefore, "search is session-only");
    } finally {
      provider.dispose();
    }
  });
});

void describe("StatusTreeProvider search", () => {
  const messages = (nodes: unknown): string[] =>
    (nodes as Array<{ message?: string }>).filter((n) => typeof n.message === "string").map((n) => n.message!);

  void it("filters stored entries by message, AND-ed with the level filter, and clearing restores them", () => {
    const provider = new StatusTreeProvider(new FakeMemento() as unknown as vscode.Memento);
    try {
      provider.clear();
      provider.addEntry("Round failed: quota exhausted", "error");
      provider.addEntry("Plan saved", "info");
      provider.addEntry("Quota reset noticed", "warning");
      assert.equal(messages(provider.getChildren()).length, 3);

      provider.setSearchQuery("quota");
      assert.deepEqual(messages(provider.getChildren()).sort(), ["Quota reset noticed", "Round failed: quota exhausted"]);
      assert.deepEqual(provider.getSearchSummary(), { matched: 2, total: 3 });

      provider.clearSearch();
      assert.equal(messages(provider.getChildren()).length, 3);
      assert.equal(provider.getSearchSummary(), undefined);
    } finally {
      provider.dispose();
    }
  });

  void it("never hides a running-operation row, whatever the query", () => {
    const provider = new StatusTreeProvider(new FakeMemento() as unknown as vscode.Memento);
    const handle = taskOperations.begin("/workspace/tasks/search-running", {
      label: "Implementing",
      stage: "impl",
      exclusive: true,
    });
    assert.ok(handle);
    try {
      provider.addEntry("Plan saved", "info");
      provider.setSearchQuery("no-such-text");
      const nodes = provider.getChildren() as Array<{ kind?: string }>;
      assert.ok(nodes.some((n) => n.kind === "operation"), "the live operation row stays");
      assert.deepEqual(messages(nodes), []);
    } finally {
      taskOperations.end(handle);
      provider.dispose();
    }
  });

  void it("writes no workspace-state key for the search", () => {
    const memento = new FakeMemento();
    const provider = new StatusTreeProvider(memento as unknown as vscode.Memento);
    try {
      provider.setSearchQuery("anything");
      provider.clearSearch();
      for (const [key, value] of memento.values) {
        assert.doesNotMatch(`${key}${JSON.stringify(value)}`, /anything/);
      }
    } finally {
      provider.dispose();
    }
  });
});

void describe("pane search — package.json manifest", () => {
  interface Entry {
    command: string;
    when?: string;
    group?: string;
    title?: string;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as {
    contributes: { commands: Entry[]; menus: Record<string, Entry[]> };
  };
  const titleBar = manifest.contributes.menus["view/title"]!;

  void it("contributes all four commands with a title-bar entry in the right view", () => {
    const expected: Array<[string, string, string | undefined]> = [
      ["searchTasks", "vs-code-ai-helper.tasksView", undefined],
      ["clearTasksSearch", "vs-code-ai-helper.tasksView", "vs-code-ai-helper.tasksSearchActive"],
      ["searchNotifications", "vs-code-ai-helper.statusView", undefined],
      ["clearNotificationsSearch", "vs-code-ai-helper.statusView", "vs-code-ai-helper.notificationsSearchActive"],
    ];
    for (const [id, view, contextKey] of expected) {
      const command = `vs-code-ai-helper.${id}`;
      assert.ok(manifest.contributes.commands.some((c) => c.command === command), `${id} is contributed`);
      const entry = titleBar.find((e) => e.command === command);
      assert.ok(entry, `${id} has a view/title entry`);
      assert.ok(entry.when?.includes(`view == ${view}`), `${id} targets ${view}`);
      assert.ok(entry.group?.startsWith("navigation"), `${id} sits in the navigation group`);
      if (contextKey) assert.ok(entry.when?.includes(contextKey), `${id} is gated on ${contextKey}`);
    }
  });
});
