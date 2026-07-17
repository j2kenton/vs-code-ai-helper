/**
 * Coverage for the per-task Publish verification scope (plan step 29):
 *
 *  1. resolvePublishScopeFolder — the default (workspace folder containing
 *     the task, never just the task folder), the stale-path branch (persisted
 *     scope deleted or no longer a directory), absolute persisted paths, and
 *     tasks outside any workspace folder.
 *  2. Monorepo: two tasks in the SAME workspace folder resolving DIFFERENT
 *     scopes — the scope is keyed by task, not by workspace folder (the
 *     defect the plan revision existed to fix).
 *  3. Multi-root: a relative scope resolves against the task's own workspace
 *     folder, not the first/other root.
 *  4. choosePublishScope command round trip: the picked scope is persisted on
 *     the task record (task-progress.json), per task, and is fully separate
 *     from the per-workspace-folder release target — choosing a Publish
 *     scope never touches the release-target workspaceState key, and the
 *     two values may point at different packages simultaneously.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { resolvePublishScopeFolder } from "../utils/completionLint";
import { choosePublishScope } from "../commands/choosePublishScope";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { initNotificationRouter } from "../utils/notificationRouter";

// Route NotificationRouter to the vscode stub's window methods, mirroring
// completedTaskResume.test.ts, so command-level flows can complete.
initNotificationRouter({
  addEntry(message, level) {
    if (level === "warning") {
      void vscode.window.showWarningMessage(message);
    } else if (level === "error") {
      void vscode.window.showErrorMessage(message);
    } else {
      void vscode.window.showInformationMessage(message);
    }
  },
});

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-scope-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeDirs(...segments: string[][]): void {
  for (const parts of segments) {
    fs.mkdirSync(path.join(...parts), { recursive: true });
  }
}

function installWorkspaceFoldersStub(roots: string[]): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = roots.map((root, index) => ({
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index,
  }));
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

void describe("resolvePublishScopeFolder", () => {
  void it("defaults to the workspace folder containing the task, never the task folder itself", () => {
    const root = path.join(TEST_ROOT, "default-root");
    const taskFolder = path.join(root, ".ensemble", "2026-01-01_task_1");
    makeDirs([taskFolder]);
    const ws = installWorkspaceFoldersStub([root]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {});
      assert.equal(path.resolve(resolved.folder), path.resolve(root));
      assert.notEqual(path.resolve(resolved.folder), path.resolve(taskFolder));
      assert.equal(resolved.stale, false);
    } finally {
      ws.restore();
    }
  });

  void it("falls back to the task folder when the task is outside every open workspace folder", () => {
    const outside = path.join(TEST_ROOT, "outside", "task");
    makeDirs([outside]);
    const ws = installWorkspaceFoldersStub([path.join(TEST_ROOT, "unrelated-root")]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(outside), {});
      assert.equal(path.resolve(resolved.folder), path.resolve(outside));
      assert.equal(resolved.stale, false);
    } finally {
      ws.restore();
    }
  });

  void it("monorepo: two tasks in the same workspace folder resolve different per-task scopes", () => {
    const root = path.join(TEST_ROOT, "monorepo-root");
    const app = path.join(root, "packages", "app");
    const lib = path.join(root, "packages", "lib");
    const taskA = path.join(root, ".ensemble", "2026-01-01_task_a");
    const taskB = path.join(root, ".ensemble", "2026-01-01_task_b");
    makeDirs([app], [lib], [taskA], [taskB]);
    const ws = installWorkspaceFoldersStub([root]);
    try {
      const resolvedA = resolvePublishScopeFolder(vscode.Uri.file(taskA), {
        publishScopePath: path.join("packages", "app"),
      });
      const resolvedB = resolvePublishScopeFolder(vscode.Uri.file(taskB), {
        publishScopePath: path.join("packages", "lib"),
      });
      assert.equal(path.resolve(resolvedA.folder), path.resolve(app));
      assert.equal(path.resolve(resolvedB.folder), path.resolve(lib));
      assert.notEqual(
        path.resolve(resolvedA.folder),
        path.resolve(resolvedB.folder),
        "two tasks in one workspace folder must be able to verify against different packages"
      );
      assert.equal(resolvedA.stale, false);
      assert.equal(resolvedB.stale, false);
    } finally {
      ws.restore();
    }
  });

  void it("multi-root: a relative scope resolves against the task's own workspace folder", () => {
    const rootA = path.join(TEST_ROOT, "multi-root-a");
    const rootB = path.join(TEST_ROOT, "multi-root-b");
    // The same relative path exists under BOTH roots, so resolving against
    // the wrong root would still "succeed" — only the absolute result
    // reveals which folder actually won.
    const pkgA = path.join(rootA, "pkg");
    const pkgB = path.join(rootB, "pkg");
    const taskInB = path.join(rootB, ".ensemble", "2026-01-01_task_b");
    makeDirs([pkgA], [pkgB], [taskInB]);
    const ws = installWorkspaceFoldersStub([rootA, rootB]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskInB), {
        publishScopePath: "pkg",
      });
      assert.equal(path.resolve(resolved.folder), path.resolve(pkgB));

      const unscoped = resolvePublishScopeFolder(vscode.Uri.file(taskInB), {});
      assert.equal(path.resolve(unscoped.folder), path.resolve(rootB));
    } finally {
      ws.restore();
    }
  });

  void it("reports a persisted scope that no longer exists as stale and falls back to the workspace folder", () => {
    const root = path.join(TEST_ROOT, "stale-root");
    const taskFolder = path.join(root, ".ensemble", "2026-01-01_task_1");
    makeDirs([taskFolder]);
    const ws = installWorkspaceFoldersStub([root]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {
        publishScopePath: path.join("packages", "deleted"),
      });
      assert.equal(path.resolve(resolved.folder), path.resolve(root));
      assert.equal(resolved.stale, true, "a missing persisted scope must be surfaced as stale, not silently accepted");
    } finally {
      ws.restore();
    }
  });

  void it("reports a persisted scope that exists but is a file (not a directory) as stale", () => {
    const root = path.join(TEST_ROOT, "stale-file-root");
    const taskFolder = path.join(root, ".ensemble", "2026-01-01_task_1");
    makeDirs([taskFolder]);
    fs.writeFileSync(path.join(root, "not-a-dir"), "x", "utf8");
    const ws = installWorkspaceFoldersStub([root]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {
        publishScopePath: "not-a-dir",
      });
      assert.equal(path.resolve(resolved.folder), path.resolve(root));
      assert.equal(resolved.stale, true);
    } finally {
      ws.restore();
    }
  });

  void it("accepts an absolute persisted scope path", () => {
    const root = path.join(TEST_ROOT, "absolute-root");
    const taskFolder = path.join(root, ".ensemble", "2026-01-01_task_1");
    const elsewhere = path.join(TEST_ROOT, "absolute-elsewhere");
    makeDirs([taskFolder], [elsewhere]);
    const ws = installWorkspaceFoldersStub([root]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {
        publishScopePath: elsewhere,
      });
      assert.equal(path.resolve(resolved.folder), path.resolve(elsewhere));
      assert.equal(resolved.stale, false);
    } finally {
      ws.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// choosePublishScope command round trip
// ---------------------------------------------------------------------------

function makeProgress(taskFolder: string, overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder,
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function writeProgress(folderPath: string, progress: TaskProgress): Promise<void> {
  await fs.promises.writeFile(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
}

/** Minimal on-disk-backed TaskInventory stub — see completedTaskResume.test.ts. */
function makeInventory(tasks: Array<{ canonicalId: string; taskFolderPath: string; progress: TaskProgress }>): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  let items = tasks.map((t) => ({
    canonicalId: t.canonicalId,
    taskFolderPath: t.taskFolderPath,
    folderName: path.basename(t.taskFolderPath),
    sourceScopeKey: t.canonicalId,
    progress: t.progress,
  }));
  inv.refresh = async (): Promise<void> => {
    items = await Promise.all(items.map(async (item) => {
      const fresh = await readTaskProgress(vscode.Uri.file(item.taskFolderPath));
      return fresh ? { ...item, progress: fresh } : item;
    }));
  };
  inv.getTasks = (): typeof items => items;
  inv.getTaskById = (id: string): typeof items[number] | undefined => items.find((t) => t.canonicalId === id);
  inv.getTaskByPath = (p: string): typeof items[number] | undefined => items.find((t) => t.taskFolderPath === p);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function installQuickPickByRelPath(pick: (items: Array<{ relPath: string }>) => unknown): { restore: () => void } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const orig = win.showQuickPick;
  win.showQuickPick = (items: Array<{ relPath: string }>): Promise<unknown> => Promise.resolve(pick(items));
  return { restore: (): void => { win.showQuickPick = orig; } };
}

function installInfoMessageCapture(): { messages: string[]; restore: () => void } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const origInfo = win.showInformationMessage;
  const origWarn = win.showWarningMessage;
  const origErr = win.showErrorMessage;
  const messages: string[] = [];
  win.showInformationMessage = (msg: string): Promise<undefined> => { messages.push(msg); return Promise.resolve(undefined); };
  win.showWarningMessage = (msg: string): Promise<undefined> => { messages.push(msg); return Promise.resolve(undefined); };
  win.showErrorMessage = (msg: string): Promise<undefined> => { messages.push(msg); return Promise.resolve(undefined); };
  return {
    messages,
    restore: (): void => {
      win.showInformationMessage = origInfo;
      win.showWarningMessage = origWarn;
      win.showErrorMessage = origErr;
    },
  };
}

void describe("choosePublishScope command", () => {
  void it("persists per-task scopes for two tasks in one workspace folder, without touching the release target", async () => {
    const root = path.join(TEST_ROOT, "choose-root");
    const app = path.join(root, "packages", "app");
    const lib = path.join(root, "packages", "lib");
    const taskA = path.join(root, ".ensemble", "2026-01-01_task_a");
    const taskB = path.join(root, ".ensemble", "2026-01-01_task_b");
    makeDirs([app], [lib], [taskA], [taskB]);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    fs.writeFileSync(path.join(lib, "package.json"), JSON.stringify({ name: "lib" }), "utf8");
    await writeProgress(taskA, makeProgress(path.basename(taskA)));
    await writeProgress(taskB, makeProgress(path.basename(taskB)));

    // The user's separately persisted release target for this workspace
    // folder (per-folder workspaceState — see reviewActions.ts) points at
    // packages/lib. Choosing a Publish scope must neither read nor write it.
    const releaseTargetKey = `ensemble.releaseTarget:${process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)}`;
    const workspaceState = new Map<string, unknown>([
      [releaseTargetKey, path.join("packages", "lib", "package.json")],
    ]);

    const inv = makeInventory([
      { canonicalId: taskA, taskFolderPath: taskA, progress: makeProgress(path.basename(taskA)) },
      { canonicalId: taskB, taskFolderPath: taskB, progress: makeProgress(path.basename(taskB)) },
    ]);
    const ws = installWorkspaceFoldersStub([root]);
    const rf = installReadFileBridge();
    const msgs = installInfoMessageCapture();
    const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
    const origFindFiles = wsTarget.findFiles;
    wsTarget.findFiles = (): Promise<vscode.Uri[]> =>
      Promise.resolve([
        vscode.Uri.file(path.join(app, "package.json")),
        vscode.Uri.file(path.join(lib, "package.json")),
      ]);

    const pickEndingWith = (suffix: string) =>
      installQuickPickByRelPath((items) =>
        items.find((item) => item.relPath.replace(/\\/g, "/").endsWith(suffix))
      );

    let qp = pickEndingWith("packages/app");
    try {
      await choosePublishScope(inv, { canonicalId: taskA });
      qp.restore();
      qp = pickEndingWith("packages/lib");
      await choosePublishScope(inv, { canonicalId: taskB });

      const storedA = await readTaskProgress(vscode.Uri.file(taskA));
      const storedB = await readTaskProgress(vscode.Uri.file(taskB));
      assert.equal(storedA?.publishScopePath?.replace(/\\/g, "/"), "packages/app");
      assert.equal(storedB?.publishScopePath?.replace(/\\/g, "/"), "packages/lib");
      assert.notEqual(
        storedA?.publishScopePath,
        storedB?.publishScopePath,
        "the scope must be keyed per task, not per workspace folder"
      );

      // The resolution used by the Publish checks honors each task's own scope.
      const resolvedA = resolvePublishScopeFolder(vscode.Uri.file(taskA), storedA);
      const resolvedB = resolvePublishScopeFolder(vscode.Uri.file(taskB), storedB);
      assert.equal(path.resolve(resolvedA.folder), path.resolve(app));
      assert.equal(path.resolve(resolvedB.folder), path.resolve(lib));

      // Release target untouched — and legitimately different from task A's
      // Publish scope under the same workspace folder.
      assert.equal(
        workspaceState.get(releaseTargetKey),
        path.join("packages", "lib", "package.json"),
        "choosing a Publish scope must never rewrite the per-folder release target"
      );
      assert.notEqual(
        path.dirname(path.join(root, workspaceState.get(releaseTargetKey) as string)),
        resolvedA.folder,
        "the Publish scope and the release target are separate values and may differ"
      );
      assert.equal(storedA && "releaseTarget" in storedA, false, "no release-target field may leak onto the task record");
    } finally {
      qp.restore();
      wsTarget.findFiles = origFindFiles;
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });

  void it("picking the workspace root clears the persisted scope back to the default", async () => {
    const root = path.join(TEST_ROOT, "choose-clear-root");
    const app = path.join(root, "packages", "app");
    const taskFolder = path.join(root, ".ensemble", "2026-01-01_task_1");
    makeDirs([app], [taskFolder]);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    await writeProgress(
      taskFolder,
      makeProgress(path.basename(taskFolder), { publishScopePath: path.join("packages", "app") })
    );

    const inv = makeInventory([
      {
        canonicalId: taskFolder,
        taskFolderPath: taskFolder,
        progress: makeProgress(path.basename(taskFolder), { publishScopePath: path.join("packages", "app") }),
      },
    ]);
    const ws = installWorkspaceFoldersStub([root]);
    const rf = installReadFileBridge();
    const msgs = installInfoMessageCapture();
    const qp = installQuickPickByRelPath((items) => items.find((item) => item.relPath === ""));

    try {
      await choosePublishScope(inv, { canonicalId: taskFolder });

      const stored = await readTaskProgress(vscode.Uri.file(taskFolder));
      assert.equal(stored?.publishScopePath, undefined);
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), stored);
      assert.equal(path.resolve(resolved.folder), path.resolve(root));
    } finally {
      qp.restore();
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });
});
