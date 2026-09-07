import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { TaskStatusBar } from "../views/taskStatusBar";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import type { IncompleteTask } from "../types/incompleteTask";
import type { TaskStage } from "../types/taskProgress";

// ---------------------------------------------------------------------------
// A3 Part 3 / Step 12 (2026-09-06 review, completion blocker): the status
// bar is one of the three surfaces the plan names for the implementation
// row's live checklist percentage (alongside the task tree and the chat
// header) — previously it showed no number for the impl stage at all.
// `update()` must stay synchronous (it is invoked from a plain
// `taskOperations.onDidChange` callback), so the percentage is patched in
// asynchronously once the checklist read resolves; these tests exercise
// that patch and its staleness guard.
// ---------------------------------------------------------------------------

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const PLAN_EIGHT_OF_TEN = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  ...Array.from({ length: 8 }, (_, i) => `- [x] Item ${i + 1}`),
  ...Array.from({ length: 2 }, (_, i) => `- [ ] Item ${i + 9}`),
  "",
].join("\n");

/** In-memory workspace.fs.readFile, keyed by fsPath (the stub is notImplemented). */
function installReadFileStub(files: Map<string, string>): () => void {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsRecord.readFile;
  fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const text = files.get(uri.fsPath);
    if (text === undefined) {
      return Promise.reject(new Error(`ENOENT: no such file: ${uri.fsPath}`));
    }
    return Promise.resolve(new TextEncoder().encode(text));
  };
  return (): void => {
    fsRecord.readFile = original;
  };
}

function makeTask(folderPath: string, currentStage: TaskStage): IncompleteTask {
  const folderUri = vscode.Uri.file(folderPath);
  return {
    folderUri,
    folderName: folderPath.split("/").pop() ?? folderPath,
    canonicalId: folderUri.fsPath,
    progress: {
      currentStage,
      status: "active",
      taskFolder: folderUri.fsPath.split("/").pop() ?? folderPath,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  } as unknown as IncompleteTask;
}

/** Await one microtask turn so a fire-and-forget async patch has a chance to land. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

void describe("TaskStatusBar — implementation checklist percentage (A3 Part 3 / Step 12)", () => {
  void it("patches the bar with the live checklist percentage for the impl stage", async () => {
    const folderPath = "/workspace/tasks/status-bar-impl";
    const restore = installReadFileStub(
      new Map([[vscode.Uri.joinPath(vscode.Uri.file(folderPath), "plan-final.md").fsPath, PLAN_EIGHT_OF_TEN]])
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeTask(folderPath, "impl");
      bar.update([task], task.canonicalId);
      // Synchronous pass: no percentage yet.
      const itemBeforeFlush = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(!itemBeforeFlush.text?.includes("80%"), "the percentage is not available before the async read resolves");

      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(item.text?.includes("80%"), `expected the bar text to include "80%", got "${item.text}"`);
      const tooltip = (item.tooltip as vscode.MarkdownString).value;
      assert.ok(tooltip.includes("80%"), "the tooltip also carries the percentage");
    } finally {
      restore();
      bar.dispose();
    }
  });

  void it("never shows a percentage for a non-impl stage", async () => {
    const folderPath = "/workspace/tasks/status-bar-non-impl";
    const restore = installReadFileStub(
      new Map([[vscode.Uri.joinPath(vscode.Uri.file(folderPath), "plan-final.md").fsPath, PLAN_EIGHT_OF_TEN]])
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeTask(folderPath, "impl-high-review");
      bar.update([task], task.canonicalId);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(!item.text?.includes("80%"), "implementationProgress is scoped to the impl stage only");
    } finally {
      restore();
      bar.dispose();
    }
  });

  void it("a stale async read from a superseded render never clobbers a newer one", async () => {
    const folderA = "/workspace/tasks/status-bar-stale-a";
    const folderB = "/workspace/tasks/status-bar-stale-b";
    const restore = installReadFileStub(
      new Map([[vscode.Uri.joinPath(vscode.Uri.file(folderA), "plan-final.md").fsPath, PLAN_EIGHT_OF_TEN]])
      // folderB has no plan-final.md at all — its checklist read resolves to `undefined`.
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const taskA = makeTask(folderA, "impl");
      const taskB = makeTask(folderB, "impl");
      // Render A (kicks off A's async percentage read), then immediately
      // supersede with B before A's read resolves.
      bar.update([taskA], taskA.canonicalId);
      bar.update([taskB], taskB.canonicalId);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(
        item.text?.includes("status-bar-stale-b"),
        `expected the bar to show the superseding task B, got "${item.text}"`
      );
      assert.ok(
        !item.text?.includes("80%"),
        `task A's stale percentage must not land on task B's render, got "${item.text}"`
      );
    } finally {
      restore();
      bar.dispose();
    }
  });

  // 2026-09-06 review, completion blocker: `update()`'s completed/no-active-
  // task early returns did not bump `renderGeneration`, so a percentage fetch
  // started for an earlier ACTIVE render could resolve afterward, pass the
  // (unchanged) generation check, and overwrite a neutral/completed render
  // with obsolete percentage text for a task that was no longer even shown.
  void it("a stale async read never clobbers a render that returned early into the neutral 'no active task' state", async () => {
    const folderA = "/workspace/tasks/status-bar-race-neutral";
    const restore = installReadFileStub(
      new Map([[vscode.Uri.joinPath(vscode.Uri.file(folderA), "plan-final.md").fsPath, PLAN_EIGHT_OF_TEN]])
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const taskA = makeTask(folderA, "impl");
      // Render A (kicks off A's async percentage read), then immediately
      // supersede with a render that has NO matching task at all — the
      // early-return "no active task" branch.
      bar.update([taskA], taskA.canonicalId);
      bar.update([taskA], undefined);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(
        item.text?.includes("No active task"),
        `expected the neutral render to stand, got "${item.text}"`
      );
      assert.ok(
        !item.text?.includes("80%"),
        `task A's stale percentage must not land on the neutral render, got "${item.text}"`
      );
    } finally {
      restore();
      bar.dispose();
    }
  });

  void it("a stale async read never clobbers a render that returned early into the completed-with-missing-artifact state", async () => {
    const folderA = "/workspace/tasks/status-bar-race-completed";
    const restore = installReadFileStub(
      new Map([[vscode.Uri.joinPath(vscode.Uri.file(folderA), "plan-final.md").fsPath, PLAN_EIGHT_OF_TEN]])
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const taskA = makeTask(folderA, "impl");
      const completedTask = {
        ...taskA,
        progress: {
          ...taskA.progress,
          status: "completed",
          completedWithMissingArtifacts: [{ stage: "impl" as TaskStage, artifact: "plan-final.md" }],
        },
      } as unknown as IncompleteTask;
      // Render A active (kicks off A's async percentage read), then
      // immediately supersede with the SAME task now completed with a
      // missing artifact — the other early-return branch in `update()`.
      bar.update([taskA], taskA.canonicalId);
      bar.update([completedTask], completedTask.canonicalId);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(
        item.text?.includes("completed with missing artifact"),
        `expected the completed-with-missing-artifact render to stand, got "${item.text}"`
      );
      assert.ok(
        !item.text?.includes("80%"),
        `task A's stale percentage must not land on the completed render, got "${item.text}"`
      );
    } finally {
      restore();
      bar.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// A3 Part 3 / Step 12 (2026-09-06 review, completion blocker): the status bar
// must also show the REVIEW row's score for a review stage — the previous
// round wired the implementation percentage to all three plan-named surfaces
// but left the review score off the status bar and chat header entirely.
// ---------------------------------------------------------------------------
void describe("TaskStatusBar — review stage score (A3 Part 3 / Step 12)", () => {
  void it("patches the bar with the review score for a review stage", async () => {
    const folderPath = "/workspace/tasks/status-bar-review-score";
    const restore = installReadFileStub(
      new Map([[vscode.Uri.joinPath(vscode.Uri.file(folderPath), "impl-high-review.md").fsPath, "Readiness: 6/10\n"]])
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeTask(folderPath, "impl-high-review");
      bar.update([task], task.canonicalId);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(item.text?.includes("6/10"), `expected the bar text to include "6/10", got "${item.text}"`);
      const tooltip = (item.tooltip as vscode.MarkdownString).value;
      assert.ok(tooltip.includes("Review score"), "the tooltip names the review score");
    } finally {
      restore();
      bar.dispose();
    }
  });

  void it('shows "—/10" (never reviewed), not nothing, for a review stage with no artifact', async () => {
    const folderPath = "/workspace/tasks/status-bar-review-never";
    const restore = installReadFileStub(new Map());
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeTask(folderPath, "impl-high-review");
      bar.update([task], task.canonicalId);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(item.text?.includes("—/10"), `expected the bar text to include "—/10", got "${item.text}"`);
    } finally {
      restore();
      bar.dispose();
    }
  });

  void it("never shows the implementation percentage on a review-stage row, and never the review score on an impl-stage row", async () => {
    const folderPath = "/workspace/tasks/status-bar-review-not-impl";
    const restore = installReadFileStub(
      new Map([
        [vscode.Uri.joinPath(vscode.Uri.file(folderPath), "impl-high-review.md").fsPath, "Readiness: 6/10\n"],
        [vscode.Uri.joinPath(vscode.Uri.file(folderPath), "plan-final.md").fsPath, PLAN_EIGHT_OF_TEN],
      ])
    );
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeTask(folderPath, "impl-high-review");
      bar.update([task], task.canonicalId);
      await flush();

      const item = (bar as unknown as { item: vscode.StatusBarItem }).item;
      assert.ok(!item.text?.includes("80%"), "a review-stage row must never show the implementation percentage");
    } finally {
      restore();
      bar.dispose();
    }
  });
});
