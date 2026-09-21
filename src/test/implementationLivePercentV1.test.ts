import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatViewProvider } from "../views/chatView";
import { StageNode } from "../views/taskTreeProvider";
import { TaskStatusBar } from "../views/taskStatusBar";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { readPlanOfRecordForDisplayV1 } from "../utils/implementationArtifactResolver";
import { readEffectivePlanChecklistProgressForDisplayV1 } from "../utils/effectiveReviewProgress";
import { taskOperations } from "../utils/taskOperations";
import { handleImplementationChecklistChangeV1 } from "../views/implementationChecklistRefreshV1";
import type { IncompleteTask } from "../types/incompleteTask";
import type { TaskStage } from "../types/taskProgress";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const PLAN_FOUR_OF_TEN = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  ...Array.from({ length: 4 }, (_, i) => `- [x] Item ${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `- [ ] Item ${i + 5}`),
  "",
].join("\n");

const PLAN_NINE_OF_TEN_BUFFER = PLAN_FOUR_OF_TEN.replace(/- \[ \]/g, "- [x]");

class FakeMemento {
  private readonly values = new Map<string, unknown>();
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

const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
const originalReadFile = fsRecord.readFile;
const workspaceRecord = vscode.workspace as unknown as { textDocuments: unknown[] };
const originalDocuments = workspaceRecord.textDocuments;

function stubReadFile(files: Map<string, string>): void {
  fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const text = files.get(uri.fsPath);
    return text === undefined
      ? Promise.reject(new Error(`ENOENT: ${uri.fsPath}`))
      : Promise.resolve(new TextEncoder().encode(text));
  };
}

afterEach(() => {
  fsRecord.readFile = originalReadFile;
  workspaceRecord.textDocuments = originalDocuments;
});

void describe("readPlanOfRecordForDisplayV1", () => {
  const folder = vscode.Uri.file("/workspace/tasks/display-read");
  const planPath = vscode.Uri.joinPath(folder, "plan-final.md").fsPath;

  void it("returns the durable counts and never saves or reads a dirty open editor buffer", async () => {
    let saveCalls = 0;
    workspaceRecord.textDocuments = [
      {
        uri: vscode.Uri.file(planPath),
        isDirty: true,
        getText: () => PLAN_NINE_OF_TEN_BUFFER,
        save: () => {
          saveCalls += 1;
          return Promise.resolve(true);
        },
      },
    ];
    stubReadFile(new Map([[planPath, PLAN_FOUR_OF_TEN]]));

    const plan = await readPlanOfRecordForDisplayV1(folder);

    assert.equal(saveCalls, 0, "a display read must never save the user's editor");
    assert.equal(plan.hasChecklist, true);
    assert.equal(plan.counts?.total, 10);
    assert.equal(plan.counts?.settled, 4, "counts come from disk, not from the 10/10 unsaved buffer");
    assert.equal(plan.text, PLAN_FOUR_OF_TEN);
  });

  void it("reports no checklist for a missing file", async () => {
    stubReadFile(new Map());
    assert.deepEqual(await readPlanOfRecordForDisplayV1(folder), {
      text: undefined,
      hasChecklist: false,
      counts: undefined,
    });
  });

  void it("reports no checklist for a plan that never had one", async () => {
    stubReadFile(new Map([[planPath, "# Plan\n\n- [x] not a generated checklist\n"]]));
    const plan = await readPlanOfRecordForDisplayV1(folder);
    assert.equal(plan.hasChecklist, false);
    assert.equal(plan.counts, undefined);
  });

  void it("the effective display read returns the disk counts when nothing stands the checklist down", async () => {
    stubReadFile(new Map([[planPath, PLAN_FOUR_OF_TEN]]));
    const counted = await readEffectivePlanChecklistProgressForDisplayV1(folder);
    assert.equal(counted?.settled, 4);
    assert.equal(counted?.total, 10);
  });

  const progressPath = vscode.Uri.joinPath(folder, "task-progress.json").fsPath;
  const progressJson = (latched: boolean): string =>
    JSON.stringify({
      taskFolder: "display-read",
      currentStage: "impl",
      status: "active",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      ...(latched
        ? { checklistProgressUnreliable: true, checklistProgressUnreliableReason: "runner-authored result" }
        : {}),
    });

  void it("the effective display read honours the checklistProgressUnreliable latch", async () => {
    // Control: the same progress document without the latch still yields counts,
    // so the stand-down below is the latch and not a decode failure.
    stubReadFile(new Map([[planPath, PLAN_FOUR_OF_TEN], [progressPath, progressJson(false)]]));
    assert.equal((await readEffectivePlanChecklistProgressForDisplayV1(folder))?.settled, 4);

    stubReadFile(new Map([[planPath, PLAN_FOUR_OF_TEN], [progressPath, progressJson(true)]]));
    assert.equal(await readEffectivePlanChecklistProgressForDisplayV1(folder), undefined);
  });

  void it("the effective display read stands down for an unreadable task-progress file", async () => {
    stubReadFile(new Map([[planPath, PLAN_FOUR_OF_TEN], [progressPath, "{ not json"]]));
    assert.equal(await readEffectivePlanChecklistProgressForDisplayV1(folder), undefined);
  });
});

void describe("display call sites use the no-save reader", () => {
  const read = (relative: string): string => fs.readFileSync(path.join(__dirname, "..", "..", "src", relative), "utf8");

  void it("the tree, status bar and chat header read through the ForDisplay variant", () => {
    // The tree reads through `readDisplayPlanChecklistProgressV1`, which also
    // resolves the plan via `readPlanOfRecordForDisplayV1` (no editor save) and
    // additionally reports a latched count flagged `unverified`
    // (merge of `ui 12` into `v1 f2`, 2026-09-21).
    assert.match(read("views/taskTreeProvider.ts"), /readDisplayPlanChecklistProgressV1\(task\.folderUri\)/);
    assert.match(read("utils/effectiveReviewProgress.ts"), /readDisplayPlanChecklistProgressV1[\s\S]{0,400}?readPlanOfRecordForDisplayV1\(folderUri\)/);
    assert.match(read("views/taskStatusBar.ts"), /readEffectivePlanChecklistProgressForDisplayV1\(task\.folderUri\)/);
    assert.match(read("views/chatView.ts"), /readEffectivePlanChecklistProgressForDisplayV1\(\s*vscode\.Uri\.file\(target\.taskFolderPath\)/);
  });

  void it("neither the tree nor the status bar calls the saving reader", () => {
    for (const file of ["views/taskTreeProvider.ts", "views/taskStatusBar.ts"]) {
      const source = read(file);
      assert.doesNotMatch(source, /readEffectivePlanChecklistProgressV1\s*\(/, file);
      assert.doesNotMatch(source, /readPlanOfRecordV1\s*\(/, file);
    }
  });

  void it("the watcher handler module never refreshes inventory or arms schedules", () => {
    const source = read("views/implementationChecklistRefreshV1.ts");
    assert.doesNotMatch(source, /inventory\.|armAll\(|\.save\(/);
  });
});

void describe("StageNode — running implementation row", () => {
  function makeTask(stage: TaskStage): IncompleteTask {
    return {
      folderUri: vscode.Uri.file("/workspace/tasks/live-percent"),
      folderName: "live-percent",
      progress: {
        currentStage: stage,
        status: "active",
        taskFolder: "live-percent",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    } as unknown as IncompleteTask;
  }

  function withRunningStage(task: IncompleteTask, stage: TaskStage, body: () => void): void {
    const handle = taskOperations.begin(task.folderUri.fsPath, { label: "Implementing", stage, exclusive: true });
    assert.ok(handle);
    try {
      body();
    } finally {
      taskOperations.end(handle);
    }
  }

  void it("shows the live percentage while running", () => {
    const task = makeTask("impl");
    withRunningStage(task, "impl", () => {
      const node = new StageNode(
        task, "impl", "current", undefined, undefined, false, false, false, false, undefined,
        { complete: 3, total: 10 }
      );
      assert.equal(node.description, "running... (30%)");
    });
  });

  void it("keeps plain 'running' when no checklist is readable", () => {
    const task = makeTask("impl");
    withRunningStage(task, "impl", () => {
      const node = new StageNode(task, "impl", "current", undefined, undefined);
      assert.equal(node.description, "running");
    });
  });

  void it("leaves a running review row's text unchanged", () => {
    const task = makeTask("impl-high-review");
    withRunningStage(task, "impl-high-review", () => {
      const node = new StageNode(task, "impl-high-review", "current", undefined, { label: "6/10" });
      assert.equal(node.description, "running... (previous: 6/10)");
    });
  });
});

void describe("TaskStatusBar.isShowingTaskFolder", () => {
  function task(folder: string): IncompleteTask {
    const folderUri = vscode.Uri.file(folder);
    return {
      folderUri,
      folderName: path.basename(folder),
      canonicalId: folderUri.fsPath,
      progress: {
        currentStage: "plan",
        status: "active",
        taskFolder: path.basename(folder),
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    } as unknown as IncompleteTask;
  }

  void it("is true only for the folder of the task currently shown", () => {
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const shown = task("/workspace/tasks/shown");
      const other = task("/workspace/tasks/other");
      bar.update([shown, other], shown.canonicalId);
      assert.equal(bar.isShowingTaskFolder(shown.folderUri), true);
      assert.equal(bar.isShowingTaskFolder(other.folderUri), false);
      assert.equal(bar.isShowingTaskFolder(vscode.Uri.file("/workspace/tasks/unknown")), false);
    } finally {
      bar.dispose();
    }
  });

  void it("matches a canonically equivalent (un-normalised) folder path", () => {
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const shown = task("/workspace/tasks/shown");
      bar.update([shown], shown.canonicalId);
      assert.equal(bar.isShowingTaskFolder(vscode.Uri.file("/workspace/tasks/other/../shown")), true);
    } finally {
      bar.dispose();
    }
  });

  void it("is false when nothing is shown", () => {
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      assert.equal(bar.isShowingTaskFolder(vscode.Uri.file("/workspace/tasks/shown")), false);
    } finally {
      bar.dispose();
    }
  });
});

void describe("handleImplementationChecklistChangeV1", () => {
  function harness(stages: Record<string, TaskStage>, showing: string[] = []) {
    const calls: string[] = [];
    const deps = {
      findTaskStage: (folder: string): TaskStage | undefined => stages[folder],
      refreshTaskTree: (): void => void calls.push("tree"),
      isStatusBarShowingTaskFolder: (folder: vscode.Uri): boolean => showing.includes(folder.fsPath),
      refreshStatusBar: (): void => void calls.push("statusBar"),
      refreshChatImplementationProgress: (folder: vscode.Uri): Promise<boolean> => {
        calls.push(`chat:${folder.fsPath}`);
        return Promise.resolve(true);
      },
    };
    return { calls, deps };
  }
  const plan = (folder: string): vscode.Uri => vscode.Uri.file(path.join(folder, "plan-final.md"));

  void it("ignores files that are not a known task's plan, and tasks not at the implementation stage", async () => {
    const { calls, deps } = harness({ "/t/planning": "plan" });
    await handleImplementationChecklistChangeV1([plan("/elsewhere/project"), plan("/t/planning")], deps);
    assert.deepEqual(calls, []);
  });

  void it("refreshes the tree, and the status bar only when it shows a changed folder", async () => {
    const notShowing = harness({ "/t/a": "impl" });
    await handleImplementationChecklistChangeV1([plan("/t/a")], notShowing.deps);
    assert.deepEqual(notShowing.calls, ["tree", "chat:/t/a"]);

    const showing = harness({ "/t/a": "impl" }, ["/t/a"]);
    await handleImplementationChecklistChangeV1([plan("/t/a")], showing.deps);
    assert.deepEqual(showing.calls, ["tree", "statusBar", "chat:/t/a"]);
  });

  void it("delegates the chat refresh once per surviving folder", async () => {
    const { calls, deps } = harness({ "/t/a": "impl", "/t/b": "impl", "/t/c": "plan" });
    await handleImplementationChecklistChangeV1(
      [plan("/t/a"), plan("/t/a"), plan("/t/b"), plan("/t/c")],
      deps
    );
    assert.deepEqual(calls, ["tree", "chat:/t/a", "chat:/t/b"]);
  });

  void it("survives a chat refresh that rejects", async () => {
    const { deps } = harness({ "/t/a": "impl" });
    deps.refreshChatImplementationProgress = (): Promise<boolean> => Promise.reject(new Error("boom"));
    await handleImplementationChecklistChangeV1([plan("/t/a")], deps);
  });
});

void describe("ChatViewProvider.refreshImplementationProgressForTaskV1", () => {
  function fakeView() {
    const posted: Array<Record<string, unknown>> = [];
    const webview = {
      options: {},
      html: "",
      postMessage: (message: Record<string, unknown>): Promise<boolean> => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (): vscode.Disposable => ({ dispose: (): void => undefined }),
    };
    const view = {
      webview,
      visible: true,
      onDidChangeVisibility: (): vscode.Disposable => ({ dispose: (): void => undefined }),
    } as unknown as vscode.WebviewView;
    return { view, posted, states: () => posted.filter((m) => m.type === "state").length };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  async function withOpenChat(
    stage: TaskStage,
    body: (ctx: { provider: ChatViewProvider; folder: string; fake: ReturnType<typeof fakeView> }) => Promise<void>,
    kind?: "stage" | "global"
  ): Promise<void> {
    const folder = makeOwnedTaskFolder("ensemble-impl-progress-").folder;
    const provider = new ChatViewProvider(new FakeMemento() as unknown as vscode.Memento);
    const fake = fakeView();
    const cmds = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const previous = cmds._executeCommandOverride;
    cmds._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
    try {
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage, ...(kind ? { kind } : {}) });
      await settle();
      await body({ provider, folder, fake });
    } finally {
      cmds._executeCommandOverride = previous;
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  void it("repaints and resolves true for the matching task at the implementation stage, writing no chat history", async () => {
    await withOpenChat("impl", async ({ provider, folder, fake }) => {
      const filesBefore = fs.readdirSync(folder).sort();
      const statesBefore = fake.states();
      const refreshed = await provider.refreshImplementationProgressForTaskV1(vscode.Uri.file(folder));
      assert.equal(refreshed, true);
      assert.ok(fake.states() > statesBefore, "a fresh state message is posted");
      assert.deepEqual(fs.readdirSync(folder).sort(), filesBefore, "nothing is persisted into the task folder");
    });
  });

  void it("does nothing and resolves false for a non-implementation stage", async () => {
    await withOpenChat("plan", async ({ provider, folder, fake }) => {
      const statesBefore = fake.states();
      assert.equal(await provider.refreshImplementationProgressForTaskV1(vscode.Uri.file(folder)), false);
      assert.equal(fake.states(), statesBefore);
    });
  });

  void it("does nothing and resolves false for a different task folder", async () => {
    await withOpenChat("impl", async ({ provider, fake }) => {
      const statesBefore = fake.states();
      assert.equal(
        await provider.refreshImplementationProgressForTaskV1(vscode.Uri.file("/some/other/task")),
        false
      );
      assert.equal(fake.states(), statesBefore);
    });
  });

  void it("does nothing and resolves false for the global assistant", async () => {
    await withOpenChat(
      "impl",
      async ({ provider, folder, fake }) => {
        const statesBefore = fake.states();
        assert.equal(await provider.refreshImplementationProgressForTaskV1(vscode.Uri.file(folder)), false);
        assert.equal(fake.states(), statesBefore);
      },
      "global"
    );
  });

  void it("resolves false without throwing when there is no view or target", async () => {
    const provider = new ChatViewProvider(new FakeMemento() as unknown as vscode.Memento);
    try {
      assert.equal(await provider.refreshImplementationProgressForTaskV1(vscode.Uri.file("/t/a")), false);
    } finally {
      provider.dispose();
    }
  });
});
