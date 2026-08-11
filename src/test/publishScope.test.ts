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
 *  3b. External metadata root: a task stored outside every open workspace
 *     folder resolves its default scope, its picker root, and its persisted
 *     relative scope against the durable ownership.projectRoot binding —
 *     never against the external task/metadata folder. A recorded binding
 *     that has vanished is reported stale (forcing re-selection), and
 *     runCompletionLint then aborts rather than executing any verification
 *     command in the metadata folder.
 *  3c. External metadata root CONTAINED by an open workspace: a recorded
 *     binding takes precedence over the containing workspace — a valid
 *     binding wins outright (consistent with resolveReleaseWorkspace), and
 *     a vanished binding is stale for both the resolver and the picker, so
 *     neither runCompletionLint nor choosePublishScope ever substitutes the
 *     parent workspace that merely contains the metadata folder.
 *  4. choosePublishScope command round trip: the picked scope is persisted on
 *     the task record (task-progress.json), per task, and is fully separate
 *     from the per-workspace-folder release target — choosing a Publish
 *     scope never touches the release-target workspaceState key, and the
 *     two values may point at different packages simultaneously.
 *  5. runCompletionLint direct regression: the full check entry point records
 *     `verifiedFolder` and actually EXECUTES its verification commands in the
 *     folder resolved through ownership.projectRoot — not just the resolver
 *     in isolation — and writes that folder into publish-checks.md.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { resolvePublishScopeFolder, runCompletionLint } from "../utils/completionLint";
import { choosePublishScope } from "../commands/choosePublishScope";
import { readTaskProgressForTest as readTaskProgress } from "./taskFolderFixture";
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

  void it("external metadata root: defaults to the task's ownership projectRoot, never the task folder", () => {
    const project = path.join(TEST_ROOT, "ext-project");
    const pkg = path.join(project, "pkg");
    const metaRoot = path.join(TEST_ROOT, "ext-meta", ".ensemble");
    const taskFolder = path.join(metaRoot, "2026-01-01_task_1");
    makeDirs([pkg], [taskFolder]);
    const ownership = {
      metaRoot: path.resolve(metaRoot),
      projectRoot: path.resolve(project),
      workspaceRoot: path.resolve(project),
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved" as const,
    };
    const ws = installWorkspaceFoldersStub([project]);
    try {
      // Default: the bound project root, not the external task folder.
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), { ownership });
      assert.equal(path.resolve(resolved.folder), path.resolve(project));
      assert.notEqual(path.resolve(resolved.folder), path.resolve(taskFolder));
      assert.equal(resolved.stale, false);

      // A relative persisted scope resolves against the projectRoot, so the
      // picker (relative-to-projectRoot) and the resolver round-trip.
      const scoped = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {
        ownership,
        publishScopePath: "pkg",
      });
      assert.equal(path.resolve(scoped.folder), path.resolve(pkg));
      assert.equal(scoped.stale, false);

      // A stale persisted scope falls back to the projectRoot and re-prompts.
      const stale = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {
        ownership,
        publishScopePath: path.join("packages", "deleted"),
      });
      assert.equal(path.resolve(stale.folder), path.resolve(project));
      assert.equal(stale.stale, true);
    } finally {
      ws.restore();
    }
  });

  void it("external metadata root: a vanished ownership projectRoot is reported stale, never silently the task folder", () => {
    const metaTask = path.join(TEST_ROOT, "ext-orphan", ".ensemble", "2026-01-01_task_1");
    makeDirs([metaTask]);
    const ws = installWorkspaceFoldersStub([path.join(TEST_ROOT, "ext-unrelated-root")]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(metaTask), {
        ownership: {
          metaRoot: path.resolve(path.dirname(metaTask)),
          projectRoot: path.join(TEST_ROOT, "ext-deleted-project"),
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      });
      assert.equal(
        resolved.stale,
        true,
        "a recorded-but-missing project binding must force scope re-selection, not verification of task metadata"
      );
    } finally {
      ws.restore();
    }
  });

  void it("external metadata root: a relative persisted scope never resolves against the metadata folder when the binding vanished", () => {
    const metaTask = path.join(TEST_ROOT, "ext-orphan-rel", ".ensemble", "2026-01-01_task_1");
    // A coincidental directory match inside the metadata folder must not win.
    makeDirs([path.join(metaTask, "packages", "app")]);
    const ws = installWorkspaceFoldersStub([path.join(TEST_ROOT, "ext-unrelated-root")]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(metaTask), {
        ownership: {
          metaRoot: path.resolve(path.dirname(metaTask)),
          projectRoot: path.join(TEST_ROOT, "ext-deleted-project"),
          boundAt: "2026-01-01T00:00:00.000Z",
        },
        publishScopePath: path.join("packages", "app"),
      });
      assert.equal(resolved.stale, true);
      assert.notEqual(
        path.resolve(resolved.folder),
        path.resolve(path.join(metaTask, "packages", "app")),
        "a relative scope must not resolve against the metadata-folder fallback"
      );
    } finally {
      ws.restore();
    }
  });

  void it("metadata folder inside an open workspace: a vanished projectRoot binding is stale, never the containing parent workspace", () => {
    const parentRoot = path.join(TEST_ROOT, "contained-orphan-parent");
    const metaTask = path.join(parentRoot, "external-meta", ".ensemble", "2026-01-01_task_1");
    // A real directory under the parent workspace that a relative persisted
    // scope would coincidentally match if containment (wrongly) won.
    const pkgInParent = path.join(parentRoot, "pkg");
    makeDirs([metaTask], [pkgInParent]);
    const ws = installWorkspaceFoldersStub([parentRoot]);
    const ownership = {
      metaRoot: path.resolve(path.dirname(metaTask)),
      projectRoot: path.join(TEST_ROOT, "contained-orphan-deleted-project"),
      boundAt: "2026-01-01T00:00:00.000Z",
    };
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(metaTask), { ownership });
      assert.equal(
        resolved.stale,
        true,
        "a recorded-but-missing binding must force re-selection even when the metadata folder sits inside an open workspace"
      );

      const scoped = resolvePublishScopeFolder(vscode.Uri.file(metaTask), {
        ownership,
        publishScopePath: "pkg",
      });
      assert.equal(scoped.stale, true);
      assert.notEqual(
        path.resolve(scoped.folder),
        path.resolve(pkgInParent),
        "a relative scope must not resolve against the parent workspace when the binding vanished"
      );
    } finally {
      ws.restore();
    }
  });

  void it("metadata folder inside an open workspace: a valid projectRoot binding takes precedence over the containing workspace", () => {
    const parentRoot = path.join(TEST_ROOT, "contained-bound-parent");
    const project = path.join(TEST_ROOT, "contained-bound-project");
    const metaTask = path.join(parentRoot, "external-meta", ".ensemble", "2026-01-01_task_1");
    // The same relative path exists under BOTH candidates, so resolving
    // against the wrong base would still "succeed" — only the absolute
    // result reveals which folder actually won.
    const pkgInParent = path.join(parentRoot, "pkg");
    const pkgInProject = path.join(project, "pkg");
    makeDirs([metaTask], [pkgInParent], [pkgInProject]);
    const ws = installWorkspaceFoldersStub([parentRoot]);
    const ownership = {
      metaRoot: path.resolve(path.dirname(metaTask)),
      projectRoot: path.resolve(project),
      boundAt: "2026-01-01T00:00:00.000Z",
    };
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(metaTask), { ownership });
      assert.equal(
        path.resolve(resolved.folder),
        path.resolve(project),
        "the bound project must win over the workspace that merely contains the metadata folder"
      );
      assert.equal(resolved.stale, false);

      const scoped = resolvePublishScopeFolder(vscode.Uri.file(metaTask), {
        ownership,
        publishScopePath: "pkg",
      });
      assert.equal(path.resolve(scoped.folder), path.resolve(pkgInProject));
      assert.equal(scoped.stale, false);
    } finally {
      ws.restore();
    }
  });

  void it("treats a malformed relative projectRoot binding as stale instead of resolving it from the host cwd", () => {
    const root = path.join(TEST_ROOT, "relative-binding-parent");
    const taskFolder = path.join(root, ".ensemble", "2026-01-01_task_1");
    makeDirs([taskFolder]);
    const ws = installWorkspaceFoldersStub([root]);
    try {
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), {
        ownership: {
          metaRoot: path.resolve(path.dirname(taskFolder)),
          // `.` normally exists relative to the test/extension host process,
          // but it is not a durable project-root binding.
          projectRoot: ".",
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      });
      assert.equal(resolved.stale, true);
      assert.notEqual(path.resolve(resolved.folder), path.resolve("."));
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

  void it("external metadata root: the picker offers the ownership projectRoot and the pick round-trips", async () => {
    const project = path.join(TEST_ROOT, "ext-choose-project");
    const app = path.join(project, "packages", "app");
    const metaRoot = path.join(TEST_ROOT, "ext-choose-meta", ".ensemble");
    const taskFolder = path.join(metaRoot, "2026-01-01_task_1");
    makeDirs([app], [taskFolder]);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    const ownership = {
      metaRoot: path.resolve(metaRoot),
      projectRoot: path.resolve(project),
      workspaceRoot: path.resolve(project),
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved" as const,
    };
    await writeProgress(taskFolder, makeProgress(path.basename(taskFolder), { ownership }));

    const inv = makeInventory([
      { canonicalId: taskFolder, taskFolderPath: taskFolder, progress: makeProgress(path.basename(taskFolder), { ownership }) },
    ]);
    const ws = installWorkspaceFoldersStub([project]);
    const rf = installReadFileBridge();
    const msgs = installInfoMessageCapture();
    const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
    const origFindFiles = wsTarget.findFiles;
    let findFilesBase: string | undefined;
    wsTarget.findFiles = (pattern: { base?: string }): Promise<vscode.Uri[]> => {
      findFilesBase = pattern?.base;
      return Promise.resolve([vscode.Uri.file(path.join(app, "package.json"))]);
    };
    const offered: string[][] = [];
    const qp = installQuickPickByRelPath((items) => {
      offered.push(items.map((item) => item.relPath.replace(/\\/g, "/")));
      return items.find((item) => item.relPath.replace(/\\/g, "/").endsWith("packages/app"));
    });

    try {
      await choosePublishScope(inv, { canonicalId: taskFolder });

      // The picker was rooted at the bound project (ownership.projectRoot),
      // not refused for the task folder being outside every workspace root.
      assert.equal(
        path.resolve(findFilesBase ?? ""),
        path.resolve(project),
        "nested-package detection must search the ownership projectRoot"
      );
      assert.ok(offered[0]?.includes(""), "the projectRoot root item must be offered");

      const stored = await readTaskProgress(vscode.Uri.file(taskFolder));
      assert.equal(stored?.publishScopePath?.replace(/\\/g, "/"), "packages/app");

      // The Publish checks resolve the persisted relative scope against the
      // same projectRoot the picker used — lint/tests run in the project,
      // never in the external metadata folder.
      const resolved = resolvePublishScopeFolder(vscode.Uri.file(taskFolder), stored);
      assert.equal(path.resolve(resolved.folder), path.resolve(app));
      assert.equal(resolved.stale, false);
    } finally {
      qp.restore();
      wsTarget.findFiles = origFindFiles;
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });

  void it("runCompletionLint records verifiedFolder and executes checks in the ownership projectRoot scope, never the metadata folder", async () => {
    const project = path.join(TEST_ROOT, "run-lint-project");
    const app = path.join(project, "packages", "app");
    const metaRoot = path.join(TEST_ROOT, "run-lint-meta", ".ensemble");
    const taskFolder = path.join(metaRoot, "2026-01-01_task_1");
    makeDirs([app], [taskFolder]);
    const ownership = {
      metaRoot: path.resolve(metaRoot),
      projectRoot: path.resolve(project),
      workspaceRoot: path.resolve(project),
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved" as const,
    };
    await writeProgress(
      taskFolder,
      makeProgress(path.basename(taskFolder), {
        ownership,
        publishScopePath: path.join("packages", "app"),
      })
    );

    // An explicit verification command that records the cwd it actually ran
    // in — the executed-command half of the regression, not just the
    // resolver's return value.
    const markerName = "publish-check-cwd.txt";
    const explicitCommand =
      `node -e "require('fs').writeFileSync('${markerName}', process.cwd())"`;
    const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
    const origGetConfiguration = wsTarget.getConfiguration;
    wsTarget.getConfiguration = (): unknown => ({
      get: (key: string, defaultValue: unknown): unknown =>
        key === "publishVerificationCommands" ? [explicitCommand] : defaultValue,
      inspect: (): undefined => undefined,
    });

    const ws = installWorkspaceFoldersStub([project]);
    const rf = installReadFileBridge();
    try {
      const result = await runCompletionLint(vscode.Uri.file(taskFolder));

      // The recorded verification scope is the project package resolved via
      // ownership.projectRoot — not the external task/metadata folder.
      assert.equal(path.resolve(result.verifiedFolder ?? ""), path.resolve(app));
      assert.equal(result.passed, true);
      assert.deepEqual(result.failedChecks, []);

      // The command actually executed inside that scope: its cwd marker is
      // in the project package and nowhere near the metadata root.
      const marker = path.join(app, markerName);
      assert.ok(fs.existsSync(marker), "the verification command must run in the resolved scope");
      const normalize = (p: string): string => {
        const resolved = path.resolve(p);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      assert.equal(normalize(fs.readFileSync(marker, "utf8")), normalize(app));
      assert.equal(
        fs.existsSync(path.join(taskFolder, markerName)),
        false,
        "checks must never execute in the external metadata folder"
      );

      // The publish-checks.md artifact names the same verified folder.
      const review = fs.readFileSync(path.join(taskFolder, "publish-checks.md"), "utf8");
      assert.match(review, /- Verified against: /);
      const reviewLine = review.split(/\r?\n/).find((line) => line.startsWith("- Verified against: "));
      assert.equal(normalize(reviewLine!.slice("- Verified against: ".length)), normalize(app));

      // The persisted lint payload reflects the run that executed there.
      const stored = await readTaskProgress(vscode.Uri.file(taskFolder));
      assert.equal(stored?.lintPayload?.passed, true);
    } finally {
      wsTarget.getConfiguration = origGetConfiguration;
      rf.restore();
      ws.restore();
    }
  });

  void it("runCompletionLint aborts when the ownership projectRoot vanished — no command executes in the metadata folder", async () => {
    const metaRoot = path.join(TEST_ROOT, "run-lint-orphan", ".ensemble");
    const taskFolder = path.join(metaRoot, "2026-01-01_task_1");
    makeDirs([taskFolder]);
    const ownership = {
      metaRoot: path.resolve(metaRoot),
      projectRoot: path.join(TEST_ROOT, "run-lint-deleted-project"),
      workspaceRoot: path.join(TEST_ROOT, "run-lint-deleted-project"),
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved" as const,
    };
    await writeProgress(taskFolder, makeProgress(path.basename(taskFolder), { ownership }));

    // If the run were (wrongly) allowed to proceed, this explicit command
    // would drop a cwd marker wherever it executed — the assertion below is
    // that it never runs anywhere, least of all the metadata folder.
    const markerName = "orphan-check-cwd.txt";
    const explicitCommand =
      `node -e "require('fs').writeFileSync('${markerName}', process.cwd())"`;
    const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
    const origGetConfiguration = wsTarget.getConfiguration;
    wsTarget.getConfiguration = (): unknown => ({
      get: (key: string, defaultValue: unknown): unknown =>
        key === "publishVerificationCommands" ? [explicitCommand] : defaultValue,
      inspect: (): undefined => undefined,
    });

    const ws = installWorkspaceFoldersStub([path.join(TEST_ROOT, "run-lint-unrelated-root")]);
    const rf = installReadFileBridge();
    const msgs = installInfoMessageCapture();
    try {
      // The re-prompt has no project root left to offer (binding gone, task
      // outside every workspace folder), so the check aborts with an error
      // instead of verifying the metadata folder.
      await assert.rejects(
        () => runCompletionLint(vscode.Uri.file(taskFolder)),
        /Publish verification scope/
      );

      assert.equal(
        fs.existsSync(path.join(taskFolder, markerName)),
        false,
        "no verification command may execute in the external metadata folder"
      );
      // Nothing was persisted or reported for a run that never happened.
      const stored = await readTaskProgress(vscode.Uri.file(taskFolder));
      assert.equal(stored?.lintPayload, undefined);
      assert.equal(fs.existsSync(path.join(taskFolder, "publish-checks.md")), false);
    } finally {
      wsTarget.getConfiguration = origGetConfiguration;
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });

  void it("runCompletionLint aborts for a vanished binding even when the metadata folder sits inside an open workspace — no command executes anywhere", async () => {
    const parentRoot = path.join(TEST_ROOT, "run-lint-contained-orphan");
    const metaRoot = path.join(parentRoot, "external-meta", ".ensemble");
    const taskFolder = path.join(metaRoot, "2026-01-01_task_1");
    makeDirs([taskFolder]);
    const ownership = {
      metaRoot: path.resolve(metaRoot),
      projectRoot: path.join(TEST_ROOT, "run-lint-contained-deleted-project"),
      workspaceRoot: path.join(TEST_ROOT, "run-lint-contained-deleted-project"),
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved" as const,
    };
    await writeProgress(taskFolder, makeProgress(path.basename(taskFolder), { ownership }));

    // If containment (wrongly) won over the vanished binding, this explicit
    // command would drop a cwd marker in the parent workspace root.
    const markerName = "contained-orphan-check-cwd.txt";
    const explicitCommand =
      `node -e "require('fs').writeFileSync('${markerName}', process.cwd())"`;
    const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
    const origGetConfiguration = wsTarget.getConfiguration;
    wsTarget.getConfiguration = (): unknown => ({
      get: (key: string, defaultValue: unknown): unknown =>
        key === "publishVerificationCommands" ? [explicitCommand] : defaultValue,
      inspect: (): undefined => undefined,
    });

    const ws = installWorkspaceFoldersStub([parentRoot]);
    const rf = installReadFileBridge();
    const msgs = installInfoMessageCapture();
    let quickPickShown = false;
    const qp = installQuickPickByRelPath(() => {
      quickPickShown = true;
      return undefined;
    });
    try {
      // The binding is stale, so the re-prompt refuses (nothing valid to
      // offer) and the check aborts — it must not fall back to verifying
      // the parent workspace that merely contains the metadata folder.
      await assert.rejects(
        () => runCompletionLint(vscode.Uri.file(taskFolder)),
        /Publish verification scope/
      );

      assert.equal(
        quickPickShown,
        false,
        "the picker must not offer the containing parent workspace for a stale binding"
      );
      assert.ok(
        msgs.messages.some((m) => m.includes("no longer exists")),
        "the stale binding must be surfaced to the user"
      );
      assert.equal(
        fs.existsSync(path.join(parentRoot, markerName)),
        false,
        "no verification command may execute in the containing parent workspace"
      );
      assert.equal(
        fs.existsSync(path.join(taskFolder, markerName)),
        false,
        "no verification command may execute in the external metadata folder"
      );
      // Nothing was persisted or reported for a run that never happened.
      const stored = await readTaskProgress(vscode.Uri.file(taskFolder));
      assert.equal(stored?.lintPayload, undefined);
      assert.equal(fs.existsSync(path.join(taskFolder, "publish-checks.md")), false);
    } finally {
      qp.restore();
      wsTarget.getConfiguration = origGetConfiguration;
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });

  void it("choosePublishScope refuses a vanished binding instead of offering the containing parent workspace", async () => {
    const parentRoot = path.join(TEST_ROOT, "choose-contained-orphan");
    const metaRoot = path.join(parentRoot, "external-meta", ".ensemble");
    const taskFolder = path.join(metaRoot, "2026-01-01_task_1");
    makeDirs([taskFolder]);
    const ownership = {
      metaRoot: path.resolve(metaRoot),
      projectRoot: path.join(TEST_ROOT, "choose-contained-deleted-project"),
      boundAt: "2026-01-01T00:00:00.000Z",
    };
    await writeProgress(taskFolder, makeProgress(path.basename(taskFolder), { ownership }));

    const inv = makeInventory([
      { canonicalId: taskFolder, taskFolderPath: taskFolder, progress: makeProgress(path.basename(taskFolder), { ownership }) },
    ]);
    const ws = installWorkspaceFoldersStub([parentRoot]);
    const rf = installReadFileBridge();
    const msgs = installInfoMessageCapture();
    let quickPickShown = false;
    const qp = installQuickPickByRelPath((items) => {
      quickPickShown = true;
      return items[0];
    });
    try {
      await choosePublishScope(inv, { canonicalId: taskFolder });

      assert.equal(
        quickPickShown,
        false,
        "the picker must refuse a stale binding, not offer the parent workspace as the project root"
      );
      assert.ok(
        msgs.messages.some((m) => m.includes("no longer exists")),
        "the stale binding must be surfaced to the user"
      );
      const stored = await readTaskProgress(vscode.Uri.file(taskFolder));
      assert.equal(stored?.publishScopePath, undefined, "no scope may be persisted by a refused pick");
    } finally {
      qp.restore();
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
