/**
 * Regression coverage for startNewTask's active/paused lifecycle decision: a
 * new task starts ACTIVE (and becomes the current task) only when no other
 * task under the same meta root is already active; otherwise it starts
 * PAUSED and the current-task selection is left untouched — see the doc
 * comment on startNewTask in startNewTask.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { startNewTask } from "../commands/startNewTask";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import { normalizePath } from "../utils/taskRoot";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
  StatusSurface,
} from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { safeRemoveDir } from "./testFsUtils";

function installConfigStub(configuredTaskRoot: string): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    update: () => Promise<void>;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "metaResourcesPath" ? configuredTaskRoot : defaultValue,
    update: async (): Promise<void> => {},
    inspect: () => undefined,
  });
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

function installWorkspaceFoldersStub(roots: readonly string[]): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = roots.map((root, index) => ({
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index,
  }));
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

/** Bridges the real-filesystem fs methods startNewTask needs, backed by a
 * real temp directory — writeTaskProgress itself already writes through
 * real Node fs (writeAtomic.ts), so only the read/scan/create side needs
 * bridging here. */
function installRealFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = {
    readFile: target.readFile,
    writeFile: target.writeFile,
    createDirectory: target.createDirectory,
    readDirectory: target.readDirectory,
    rename: target.rename,
  };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> =>
    fs.promises.writeFile(uri.fsPath, data);
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  };
  target.rename = (source: vscode.Uri, destination: vscode.Uri): Promise<void> =>
    fs.promises.rename(source.fsPath, destination.fsPath);
  return {
    restore: (): void => {
      target.readFile = originals.readFile;
      target.writeFile = originals.writeFile;
      target.createDirectory = originals.createDirectory;
      target.readDirectory = originals.readDirectory;
      target.rename = originals.rename;
    },
  };
}

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

function fakeInventory(): TaskInventory {
  return { refresh: () => Promise.resolve(undefined) } as unknown as TaskInventory;
}

function readProgress(taskFolderPath: string): TaskProgress {
  const raw = fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8");
  return JSON.parse(raw) as TaskProgress;
}

interface Harness {
  workspaceRoot: string;
  metaFolderPath: string;
  /** Extra workspace-folder roots installed alongside `workspaceRoot`, if any. */
  extraWorkspaceRoots: readonly string[];
  inventory: TaskInventory;
  currentTaskStore: CurrentTaskStore;
  restore(): void;
}

function installHarness(extraWorkspaceRoots: readonly string[] = []): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-start-new-task-"));
  const metaFolderPath = path.join(workspaceRoot, ".ensemble");
  const configStub = installConfigStub(".ensemble");
  const wsStub = installWorkspaceFoldersStub([workspaceRoot, ...extraWorkspaceRoots]);
  const fsBridge = installRealFsBridge();
  const currentTaskStore = new CurrentTaskStore(makeMemento());
  (vscode.window as unknown as Record<string, unknown>).showErrorMessage = (msg: string) => {
    console.error("DEBUG_ERR:", msg);
    return Promise.resolve(undefined);
  };
  (vscode.window as unknown as Record<string, unknown>).showInformationMessage = () =>
    Promise.resolve(undefined);
  // With more than one workspace folder, startNewTask prompts a QuickPick for
  // which folder the new task belongs to. Always pick the first (primary)
  // folder deterministically so multi-root tests exercise "creating in one
  // folder while another folder's meta root already has an active task".
  (vscode.window as unknown as Record<string, unknown>).showQuickPick = (
    items: ReadonlyArray<{ folder: vscode.WorkspaceFolder }>
  ): Promise<{ folder: vscode.WorkspaceFolder } | undefined> => Promise.resolve(items[0]);
  initNotificationRouter({ addEntry(): void {} } as unknown as Parameters<typeof initNotificationRouter>[0]);

  return {
    workspaceRoot,
    metaFolderPath,
    extraWorkspaceRoots,
    inventory: fakeInventory(),
    currentTaskStore,
    restore(): void {
      configStub.restore();
      wsStub.restore();
      fsBridge.restore();
      deactivateNotificationRouter();
      safeRemoveDir(workspaceRoot);
      for (const extra of extraWorkspaceRoots) {
        safeRemoveDir(extra);
      }
    },
  };
}

void describe("startNewTask — active/paused lifecycle", () => {
  void it("starts ACTIVE and becomes the current task when no task under this meta root is already active", async () => {
    const harness = installHarness();
    try {
      const folderName = await startNewTask(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore
      );
      assert.ok(folderName, "expected the created folder name to be returned");

      const taskFolderPath = path.join(harness.metaFolderPath, folderName);
      const progress = readProgress(taskFolderPath);
      assert.equal(progress.status, "active", "the first task with nothing else active must start active");

      assert.equal(
        harness.currentTaskStore.get(),
        normalizePath(taskFolderPath),
        "an active new task must become the current task"
      );
    } finally {
      harness.restore();
    }
  });

  void it("starts PAUSED and leaves the current-task selection untouched when another task is already active", async () => {
    const harness = installHarness();
    try {
      // Seed a pre-existing active task directly on disk under the same meta
      // root, before the meta-root lock startNewTask takes even exists.
      fs.mkdirSync(harness.metaFolderPath, { recursive: true });
      const existingTaskPath = path.join(harness.metaFolderPath, "2026-01-01_task_1");
      fs.mkdirSync(existingTaskPath, { recursive: true });
      const existingProgress: TaskProgress = {
        taskFolder: "2026-01-01_task_1",
        currentStage: "desc",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      fs.writeFileSync(
        path.join(existingTaskPath, "task-progress.json"),
        JSON.stringify(existingProgress, null, 2)
      );
      await harness.currentTaskStore.set(normalizePath(existingTaskPath));

      const folderName = await startNewTask(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore
      );
      assert.ok(folderName);

      const taskFolderPath = path.join(harness.metaFolderPath, folderName);
      const progress = readProgress(taskFolderPath);
      assert.equal(progress.status, "paused", "a new task must start paused when another task is already active");

      assert.equal(
        harness.currentTaskStore.get(),
        normalizePath(existingTaskPath),
        "the pre-existing active task must remain the current task"
      );
    } finally {
      harness.restore();
    }
  });

  void it("starts PAUSED when a task is already active under a DIFFERENT workspace folder's meta root", async () => {
    const secondWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-start-new-task-2-"));
    const harness = installHarness([secondWorkspaceRoot]);
    try {
      // Seed a pre-existing active task under the SECOND folder's meta root —
      // a distinct meta root from the one the new task will be created under.
      const secondMetaFolderPath = path.join(secondWorkspaceRoot, ".ensemble");
      fs.mkdirSync(secondMetaFolderPath, { recursive: true });
      const existingTaskPath = path.join(secondMetaFolderPath, "2026-01-01_task_1");
      fs.mkdirSync(existingTaskPath, { recursive: true });
      const existingProgress: TaskProgress = {
        taskFolder: "2026-01-01_task_1",
        currentStage: "desc",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      fs.writeFileSync(
        path.join(existingTaskPath, "task-progress.json"),
        JSON.stringify(existingProgress, null, 2)
      );
      await harness.currentTaskStore.set(normalizePath(existingTaskPath));

      // Create the new task in the FIRST folder (harness.workspaceRoot / its
      // own distinct meta root) — the QuickPick stub always picks it first.
      const folderName = await startNewTask(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore
      );
      assert.ok(folderName);

      const taskFolderPath = path.join(harness.metaFolderPath, folderName);
      const progress = readProgress(taskFolderPath);
      assert.equal(
        progress.status,
        "paused",
        "a new task must start paused when another task is active under ANY meta root reachable from this window, not just its own"
      );
      assert.equal(
        harness.currentTaskStore.get(),
        normalizePath(existingTaskPath),
        "the pre-existing active task in the other folder must remain the current task"
      );
    } finally {
      // harness.restore() also removes secondWorkspaceRoot (extraWorkspaceRoots).
      harness.restore();
    }
  });
});

void describe("startNewTask — resolved model snapshot retired (wf10 item 7f)", () => {
  void it("does not write task-models.resolved.json into a newly created task folder", async () => {
    const harness = installHarness();
    try {
      const folderName = await startNewTask(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore
      );
      assert.ok(folderName, "expected the created folder name to be returned");

      const taskFolderPath = path.join(harness.metaFolderPath, folderName);
      const snapshotPath = path.join(taskFolderPath, "task-models.resolved.json");
      assert.ok(
        !fs.existsSync(snapshotPath),
        "the resolved-model snapshot writer was deleted (wf10 item 7f) — a stale snapshot as write-only provenance was worse than recording nothing, since nothing ever read it back"
      );
    } finally {
      harness.restore();
    }
  });
});

void describe("startNewTask — legacy `creating` footprints are never auto-promoted", () => {
  void it(
    "leaves a stuck legacy creating folder untouched and warns instead of promoting it to paused",
    async () => {
      const harness = installHarness();
      const entries: Array<{
        message: string;
        level: string;
        filePath?: string;
      }> = [];
      const capturingSurface: StatusSurface = {
        addEntry(message, level, filePath): void {
          entries.push({ message, level, filePath });
        },
      };
      TaskCreationStartupReconcilerV1.resetForTests();
      try {
        // Seed a folder stuck in "creating" (as if the extension host died
        // mid-creation) with a task.md already written — the exact shape the
        // OLD recoverCompletedTaskCreations used to silently promote to
        // "paused" the moment any other startNewTask ran.
        const stuckTaskPath = path.join(harness.metaFolderPath, "2026-01-01_task_1");
        fs.mkdirSync(stuckTaskPath, { recursive: true });
        const stuckProgress: TaskProgress = {
          taskFolder: "2026-01-01_task_1",
          currentStage: "desc",
          status: "creating",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        fs.writeFileSync(
          path.join(stuckTaskPath, "task-progress.json"),
          JSON.stringify(stuckProgress, null, 2)
        );
        fs.writeFileSync(path.join(stuckTaskPath, "task.md"), "# Task\n");

        // installHarness() already called initNotificationRouter with a
        // no-op surface; swap in one that records entries for this test.
        initNotificationRouter(capturingSurface);

        const folderName = await startNewTask(
          harness.inventory,
          vscode.Uri.file(harness.workspaceRoot),
          harness.currentTaskStore
        );
        assert.ok(folderName, "a new task must still be created alongside the stuck one");
        assert.notEqual(folderName, "2026-01-01_task_1", "the new task must be a distinct folder");

        const stuckAfter = readProgress(stuckTaskPath);
        assert.equal(
          stuckAfter.status,
          "creating",
          "the stuck folder's status must be left exactly as found — no implicit promotion to paused"
        );

        const warning = entries.find((e) => e.message.includes("2026-01-01_task_1"));
        assert.ok(warning, "expected a warning surfaced about the stuck creating folder");
        assert.equal(warning?.level, "warning");
        assert.equal(
          warning?.filePath,
          path.join(stuckTaskPath, "task.md"),
          "the read-only Open affordance must point at the stuck folder's task.md"
        );
      } finally {
        TaskCreationStartupReconcilerV1.resetForTests();
        harness.restore();
      }
    }
  );
});
