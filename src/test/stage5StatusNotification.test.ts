import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  initNotificationRouter,
  deactivateNotificationRouter,
  NotificationRouter,
  StatusSurface,
} from "../utils/notificationRouter";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskStage } from "../types/taskProgress";
import { StatusTreeProvider } from "../views/statusView";
import { TaskStatusBar } from "../views/taskStatusBar";
import { IncompleteTask } from "../utils/taskProgressUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  fsPath: string,
  folderName: string,
  stage: TaskStage = "impl",
  status: import("../types/taskProgress").TaskStatus = "active",
  canonicalId?: string
): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(fsPath),
    folderName,
    progress: {
      currentStage: stage,
      status,
      taskFolder: folderName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    canonicalId,
  };
}

function makeStoreStub(initialId?: string): CurrentTaskStore {
  let id = initialId;
  const onDidChange: vscode.Event<void> = () => ({
    dispose(): void {},
  });

  return {
    get: (): string | undefined => id,
    set: (newId: string): Promise<void> => {
      id = newId;
      return Promise.resolve();
    },
    clear: (): Promise<void> => {
      id = undefined;
      return Promise.resolve();
    },
    onDidChange,
  } as unknown as CurrentTaskStore;
}

type WindowStub = {
  showQuickPick: typeof vscode.window.showQuickPick;
  showInputBox: typeof vscode.window.showInputBox;
  showTextDocument: typeof vscode.window.showTextDocument;
  showErrorMessage: typeof vscode.window.showErrorMessage;
  showInformationMessage: typeof vscode.window.showInformationMessage;
  showWarningMessage: typeof vscode.window.showWarningMessage;
};

type WorkspaceStub = {
  workspaceFolders: typeof vscode.workspace.workspaceFolders;
  fs: Pick<typeof vscode.workspace.fs, "createDirectory" | "writeFile" | "readDirectory" | "readFile" | "rename">;
  openTextDocument: typeof vscode.workspace.openTextDocument;
};

function getWindowStub(): WindowStub {
  return vscode.window as unknown as WindowStub;
}

function getWorkspaceStub(): WorkspaceStub {
  return vscode.workspace as unknown as WorkspaceStub;
}

function getStatusBarItem(bar: TaskStatusBar): Pick<vscode.StatusBarItem, "text"> {
  return (bar as unknown as { item: Pick<vscode.StatusBarItem, "text"> }).item;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function makeInventoryStub(
  overrides: Partial<
    Pick<TaskInventory, "refresh" | "getTaskById" | "getTaskByPath" | "getTasks">
  > = {}
): TaskInventory {
  const stub = {
    refresh: (): Promise<void> => Promise.resolve(),
    getTaskById: (): undefined => undefined,
    getTaskByPath: (): undefined => undefined,
    getTasks: (): readonly IncompleteTask[] => [],
    ...overrides,
  };
  return stub as unknown as TaskInventory;
}

/**
 * Task progress uses the filesystem-backed atomic writer rather than the VS
 * Code workspace filesystem.  Creation tests otherwise try to write their
 * synthetic /workspace path on the host machine before they reach the
 * behaviour under test.
 */
function isolateTaskCreationFilesystem(writtenFiles?: Map<string, string>): { restore: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const atomicModule = require("../state/writeAtomic") as {
    writeAtomic: (uri: vscode.Uri, content: string) => Promise<void>;
  };
  const original = atomicModule.writeAtomic;
  atomicModule.writeAtomic = (uri: vscode.Uri, content: string): Promise<void> => {
    writtenFiles?.set(uri.path, content);
    return Promise.resolve();
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stateStore = require("../state/taskStateStore") as {
    withMetaRootLock: <T>(root: string, operation: () => Promise<T>) => Promise<T>;
    withTaskLock: <T>(taskFolderPath: string, operation: () => Promise<T>) => Promise<T>;
  };
  const originalLock = stateStore.withMetaRootLock;
  stateStore.withMetaRootLock = <T>(_root: string, operation: () => Promise<T>): Promise<T> => operation();
  const originalTaskLock = stateStore.withTaskLock;
  stateStore.withTaskLock = <T>(_taskFolderPath: string, operation: () => Promise<T>): Promise<T> => operation();
  return {
    restore: (): void => {
      atomicModule.writeAtomic = original;
      stateStore.withMetaRootLock = originalLock;
      stateStore.withTaskLock = originalTaskLock;
    },
  };
}

/**
 * A minimal in-memory stand-in for `vscode.workspace.fs.rename` over the
 * `writtenFiles` map these tests use instead of real disk: moves every entry
 * whose key sits under `source`'s path to the equivalent key under
 * `destination`, mirroring a real directory rename (startNewTask.ts stages
 * task-progress.json/task.md under a work-<digest> folder, then renames it
 * into place — without this, the stale staging-path entry would still be
 * found first by a plain `.find(file => file.endsWith(...))` lookup).
 */
function renameWrittenFiles(writtenFiles: Map<string, string>, source: vscode.Uri, destination: vscode.Uri): void {
  const prefix = source.path.endsWith("/") ? source.path : `${source.path}/`;
  for (const [key, value] of [...writtenFiles.entries()]) {
    if (key === source.path || key.startsWith(prefix)) {
      writtenFiles.delete(key);
      writtenFiles.set(destination.path + key.slice(source.path.length), value);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void describe("Stage 5 — Status Surface & Notifications", () => {

  void describe("Notification Router initialization boundaries", () => {
    void it("should fail loudly before initialization", () => {
      deactivateNotificationRouter();
      assert.throws(() => {
        NotificationRouter.showInformation("This should fail");
      }, /NotificationRouter is not initialized/);
    });

    void it("should not fail after initialization", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);
      assert.doesNotThrow(() => {
        NotificationRouter.showInformation("This should succeed");
      });
      deactivateNotificationRouter();
    });
  });

  void describe("Status Surface retention, ordering, and expansion", () => {
    void it("should keep the full message text in the stored entry while truncating only the tree label", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);

      // The stored entry keeps the complete text — only the tree label is
      // shortened for display (full text remains in the hover tooltip).
      // There is no click-to-expand child row.
      const longMessage = "a".repeat(200);
      NotificationRouter.showInformation(longMessage);
      let entries = surface.getEntries();
      assert.strictEqual(entries.length, 1);
      const firstEntry = requireValue(entries[0], "missing first entry");
      assert.strictEqual(firstEntry.message, longMessage);

      const treeItem = surface.getTreeItem(firstEntry);
      assert.strictEqual(treeItem.label, `${longMessage.slice(0, 150)}…`);
      assert.strictEqual(treeItem.collapsibleState, 0 /* None */);

      const children = surface.getChildren(firstEntry);
      assert.ok(Array.isArray(children) && children.length === 0);

      // Newest-first ordering
      surface.clear();
      NotificationRouter.showInformation("first");
      NotificationRouter.showInformation("second");
      entries = surface.getEntries();
      assert.strictEqual(entries.length, 2);
      const firstOrdered = requireValue(entries[0], "missing newest entry");
      const secondOrdered = requireValue(entries[1], "missing second entry");
      assert.strictEqual(firstOrdered.message, "second"); // Newest first
      assert.strictEqual(secondOrdered.message, "first");

      // No retention cap — every notification persists until explicitly cleared.
      surface.clear();
      for (let i = 0; i < 60; i++) {
        NotificationRouter.showInformation(`message ${i}`);
      }
      entries = surface.getEntries();
      assert.strictEqual(entries.length, 60);
      const newest = requireValue(entries[0], "missing newest entry");
      const oldest = requireValue(entries[59], "missing oldest entry");
      assert.strictEqual(newest.message, "message 59"); // Newest
      assert.strictEqual(oldest.message, "message 0"); // Oldest — nothing evicted

      deactivateNotificationRouter();
    });
  });

  void describe("Click-to-open target precedence (D11)", () => {
    void it("opens the legacy filePath when present, even if resultTargetUri is also set", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);
      surface.addEntry("Done", "info", "/dev/task_1/plan.md", "ensemble-notification:/other.txt");
      const [entry] = surface.getEntries();
      const item = surface.getTreeItem(requireValue(entry, "missing entry"));
      assert.deepEqual(item.command?.arguments, [vscode.Uri.file("/dev/task_1/plan.md")]);
      deactivateNotificationRouter();
    });

    void it("opens the resultTargetUri (parsed, not treated as a bare fsPath) when there is no filePath", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);
      const runLogUri = vscode.Uri.file("/dev/task_1/runs/001-impl.md");
      surface.addEntry("Run Implementation — task_1: completed", "info", undefined, runLogUri.toString());
      const [entry] = surface.getEntries();
      const item = surface.getTreeItem(requireValue(entry, "missing entry"));
      assert.equal((item.command?.arguments?.[0] as vscode.Uri).toString(), runLogUri.toString());
      deactivateNotificationRouter();
    });

    void it("keeps navigating to the fallback text on click, exposing actionCommand only as an inline action", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);
      NotificationRouter.showWarning(
        "Auto-publish skipped for task_1: Completion checks did not pass. Publish manually once checks pass, or use Publish Anyway from Commit and Push.",
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.commitAndPushTask",
          title: "Publish Anyway",
          args: [{ taskFolderPath: "/dev/task_1" }],
        }
      );
      const [entry] = surface.getEntries();
      const item = surface.getTreeItem(requireValue(entry, "missing entry"));
      // Click still opens the full notification text — actionCommand no
      // longer hijacks row navigation (D11 regression fix).
      assert.equal(item.command?.command, "vscode.open");
      const uri = item.command?.arguments?.[0] as vscode.Uri;
      assert.equal(uri.scheme, "ensemble-notification");
      // The follow-up is available as a separate inline context-menu action.
      assert.match(item.contextValue ?? "", /\bensemble-notification-actionable\b/);

      let invokedArgs: unknown[] | undefined;
      const registration = vscode.commands.registerCommand(
        "vs-code-ai-helper.commitAndPushTask",
        (...args: unknown[]) => { invokedArgs = args; }
      );
      try {
        surface.runAction(requireValue(entry, "missing entry"));
      } finally {
        registration.dispose();
      }
      assert.deepEqual(invokedArgs, [{ taskFolderPath: "/dev/task_1" }]);
      deactivateNotificationRouter();
    });

    void it("falls back to a read-only ensemble-notification: document when neither target is known", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);
      surface.addEntry("Something happened with no target", "warning");
      const [entry] = surface.getEntries();
      const item = surface.getTreeItem(requireValue(entry, "missing entry"));
      const uri = item.command?.arguments?.[0] as vscode.Uri;
      assert.equal(uri.scheme, "ensemble-notification");
      assert.match(decodeURIComponent(uri.query), /Something happened with no target/);
      deactivateNotificationRouter();
    });
  });

  void describe("Notification routing", () => {
    void it("should route routine notifications to the status surface", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);

      NotificationRouter.showInformation("Info message");
      NotificationRouter.showWarning("Warning message");
      NotificationRouter.showError("Error message");

      const entries = surface.getEntries();
      assert.strictEqual(entries.length, 3);
      const firstEntry = requireValue(entries[0], "missing first routed entry");
      const secondEntry = requireValue(entries[1], "missing second routed entry");
      const thirdEntry = requireValue(entries[2], "missing third routed entry");
      assert.strictEqual(firstEntry.message, "Error message");
      assert.strictEqual(firstEntry.level, "error");
      assert.strictEqual(secondEntry.message, "Warning message");
      assert.strictEqual(secondEntry.level, "warning");
      assert.strictEqual(thirdEntry.message, "Info message");
      assert.strictEqual(thirdEntry.level, "info");

      deactivateNotificationRouter();
    });
  });

  void describe("TaskStatusBar states", () => {
    void it("should show neutral state when no active task exists", () => {
      const store = makeStoreStub(undefined);
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "publish", "completed")];

      bar.update(tasks, undefined);

      // Access private item stub properties
      const item = getStatusBarItem(bar);
      assert.strictEqual(item.text, "$(checklist) Ensemble: No active task");
      bar.dispose();
    });

    void it("should show paused state correctly when shown task is paused", () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "impl", "paused", "/workspace/task-a")];

      bar.update(tasks, "/workspace/task-a");

      const item = getStatusBarItem(bar);
      assert.ok(item.text.includes("[paused]"));
      assert.ok(item.text.includes("task-a"));
      bar.dispose();
    });

    void it("should show active state correctly when shown task is active", () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "impl", "active", "/workspace/task-a")];

      bar.update(tasks, "/workspace/task-a");

      const item = getStatusBarItem(bar);
      assert.ok(!item.text.includes("[paused]"));
      assert.ok(item.text.includes("task-a"));
      bar.dispose();
    });
  });

  void describe("TaskStatusBar menu actions", () => {
    void it("should offer Resume shown task when shown task is paused", async () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "impl", "paused", "/workspace/task-a")];
      bar.update(tasks, "/workspace/task-a");

      const win = getWindowStub();
      const origShowQuickPick = win.showQuickPick;
      let capturedItems: vscode.QuickPickItem[] = [];
      win.showQuickPick = async <T extends vscode.QuickPickItem>(
        items: readonly T[] | Thenable<readonly T[]>
      ): Promise<T | undefined> => {
        const resolvedItems = await Promise.resolve(items);
        capturedItems = [...resolvedItems];
        return undefined;
      };

      try {
        await bar.showMenu();
        const labels = capturedItems.map((item) => item.label);
        assert.ok(labels.includes("$(debug-continue) Resume shown task"));
        assert.ok(!labels.includes("$(file-text) Open shown task"));
        assert.ok(labels.includes("$(add) New task..."));
      } finally {
        win.showQuickPick = origShowQuickPick;
        bar.dispose();
      }
    });

    void it("should offer Open shown task when shown task is active (not paused)", async () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "impl", "active", "/workspace/task-a")];
      bar.update(tasks, "/workspace/task-a");

      const win = getWindowStub();
      const origShowQuickPick = win.showQuickPick;
      let capturedItems: vscode.QuickPickItem[] = [];
      win.showQuickPick = async <T extends vscode.QuickPickItem>(
        items: readonly T[] | Thenable<readonly T[]>
      ): Promise<T | undefined> => {
        const resolvedItems = await Promise.resolve(items);
        capturedItems = [...resolvedItems];
        return undefined;
      };

      try {
        await bar.showMenu();
        const labels = capturedItems.map((item) => item.label);
        assert.ok(!labels.includes("$(debug-continue) Resume shown task"));
        assert.ok(labels.includes("$(file-text) Open shown task"));
        assert.ok(labels.includes("$(add) New task..."));
      } finally {
        win.showQuickPick = origShowQuickPick;
        bar.dispose();
      }
    });

    void it("should offer Open shown task when shown task is completed", async () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "publish", "completed", "/workspace/task-a")];
      bar.update(tasks, "/workspace/task-a");

      const win = getWindowStub();
      const origShowQuickPick = win.showQuickPick;
      let capturedItems: vscode.QuickPickItem[] = [];
      win.showQuickPick = async <T extends vscode.QuickPickItem>(
        items: readonly T[] | Thenable<readonly T[]>
      ): Promise<T | undefined> => {
        const resolvedItems = await Promise.resolve(items);
        capturedItems = [...resolvedItems];
        return undefined;
      };

      try {
        await bar.showMenu();
        const labels = capturedItems.map((item) => item.label);
        assert.ok(!labels.includes("$(debug-continue) Resume shown task"));
        assert.ok(labels.includes("$(file-text) Open shown task"));
        assert.ok(labels.includes("$(add) New task..."));
      } finally {
        win.showQuickPick = origShowQuickPick;
        bar.dispose();
      }
    });
  });

  void describe("New-task creation", () => {
    void it("creates and opens task.md without showing an input popup", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");

      // Initialize notification router
      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const origShowInputBox = win.showInputBox;
      let inputBoxShown = false;
      win.showInputBox = (): Promise<string> => {
        inputBoxShown = true;
        return Promise.resolve("unexpected");
      };

      // Stub workspace functions and resolveTaskRootForCreation to prevent real directory writes
      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;

      const writtenFiles = new Map<string, string>();
      workspace.fs.createDirectory = (): Promise<void> => Promise.resolve();
      workspace.fs.writeFile = (
        uri: vscode.Uri,
        bytes: Uint8Array
      ): Promise<void> => {
        writtenFiles.set(uri.path, new TextDecoder().decode(bytes));
        return Promise.resolve();
      };
      workspace.openTextDocument = (): Promise<vscode.TextDocument> =>
        Promise.resolve({} as vscode.TextDocument);
      win.showTextDocument = (): Promise<vscode.TextEditor> =>
        Promise.resolve({} as vscode.TextEditor);
      win.showErrorMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);
      win.showWarningMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);

      // Inventory mock
      const inventory = makeInventoryStub();

      const store = makeStoreStub();

      try {
        await startNewTask(inventory, vscode.Uri.file("/extension"), store);
        assert.equal(inputBoxShown, false);
      } finally {
        win.showInputBox = origShowInputBox;
        win.showErrorMessage = origShowErrorMessage;
        win.showWarningMessage = origShowWarningMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        workspace.fs.writeFile = origWriteFile;
        workspace.openTextDocument = origOpenTextDocument;
        win.showTextDocument = origShowTextDocument;
        deactivateNotificationRouter();
      }
    });

    void it("creates the task document", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");

      // Initialize notification router
      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origRename = workspace.fs.rename;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;

      let dirCreated = false;
      const writtenFiles = new Map<string, string>();
      workspace.fs.createDirectory = (): Promise<void> => {
        dirCreated = true;
        return Promise.resolve();
      };
      workspace.fs.writeFile = (
        uri: vscode.Uri,
        bytes: Uint8Array
      ): Promise<void> => {
        writtenFiles.set(uri.path, new TextDecoder().decode(bytes));
        return Promise.resolve();
      };
      // The staging folder is claimed into its final location via rename
      // (see startNewTask.ts) — mirror that over the in-memory map so the
      // final task-progress.json is the only one findable by suffix.
      workspace.fs.rename = (source: vscode.Uri, destination: vscode.Uri): Promise<void> => {
        renameWrittenFiles(writtenFiles, source, destination);
        return Promise.resolve();
      };
      workspace.openTextDocument = (): Promise<vscode.TextDocument> =>
        Promise.resolve({} as vscode.TextDocument);
      win.showTextDocument = (): Promise<vscode.TextEditor> =>
        Promise.resolve({} as vscode.TextEditor);
      win.showErrorMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);
      win.showWarningMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);

      const inventory = makeInventoryStub();
      const store = makeStoreStub();
      const creationFilesystem = isolateTaskCreationFilesystem(writtenFiles);

      try {
        await startNewTask(inventory, vscode.Uri.file("/extension"), store);
        assert.strictEqual(dirCreated, true);
        const progressDocument = [...writtenFiles.entries()]
          .find(([file]) => file.endsWith("task-progress.json"))?.[1];
        assert.ok(progressDocument, "task progress should be persisted");
        const progress = JSON.parse(progressDocument) as { status?: string };
        assert.strictEqual(
          progress.status,
          "active",
          "a new task starts active when no other task under this meta root is already active"
        );
      } finally {
        creationFilesystem.restore();
        win.showErrorMessage = origShowErrorMessage;
        win.showWarningMessage = origShowWarningMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        workspace.fs.writeFile = origWriteFile;
        workspace.fs.rename = origRename;
        workspace.openTextDocument = origOpenTextDocument;
        win.showTextDocument = origShowTextDocument;
        deactivateNotificationRouter();
      }
    });

    void it("offers Resume for the newly created paused task using its explicit folder path", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");
      const entries: Array<{
        message: string;
        level: "info" | "warning" | "error";
        actionCommand?: { command: string; title: string; args?: unknown[] };
      }> = [];
      const surface: StatusSurface = {
        addEntry(message, level, _filePath, _resultTargetUri, _sourceOperationId, actionCommand): void {
          entries.push({ message, level, actionCommand });
        },
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const workspace = getWorkspaceStub();
      const commandApi = vscode.commands as unknown as {
        executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
      };
      const origWorkspaceFolders = workspace.workspaceFolders;
      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origRename = workspace.fs.rename;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowInformationMessage = win.showInformationMessage;
      const origExecuteCommand = commandApi.executeCommand;
      const origReadDirectory = workspace.fs.readDirectory;
      const origReadFile = workspace.fs.readFile;
      const writtenFiles = new Map<string, string>();
      const commands: Array<{ command: string; args: unknown[] }> = [];
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];
      workspace.fs.createDirectory = (): Promise<void> => Promise.resolve();
      workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => {
        writtenFiles.set(uri.path, new TextDecoder().decode(bytes));
        return Promise.resolve();
      };
      // See "creates the task document" above: mirror the staging-to-final
      // rename over the in-memory map.
      workspace.fs.rename = (source: vscode.Uri, destination: vscode.Uri): Promise<void> => {
        renameWrittenFiles(writtenFiles, source, destination);
        return Promise.resolve();
      };
      // Simulate a pre-existing ACTIVE task under the same meta root, so the
      // new task's disk scan finds it and starts paused — exercising the
      // Resume-offer path this test is actually about.
      workspace.fs.readDirectory = (): Promise<Array<[string, vscode.FileType]>> =>
        Promise.resolve([["2026-01-01_task_1", vscode.FileType.Directory]]);
      workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
        if (uri.path.includes("2026-01-01_task_1") && uri.path.endsWith("task-progress.json")) {
          return Promise.resolve(new TextEncoder().encode(JSON.stringify({
            taskFolder: "2026-01-01_task_1",
            currentStage: "desc",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })));
        }
        return Promise.reject(new Error("ENOENT"));
      };
      workspace.openTextDocument = (): Promise<vscode.TextDocument> => Promise.resolve({} as vscode.TextDocument);
      win.showTextDocument = (): Promise<vscode.TextEditor> => Promise.resolve({} as vscode.TextEditor);
      win.showErrorMessage = (): Thenable<string | undefined> => Promise.resolve(undefined);
      win.showInformationMessage = (): Thenable<string | undefined> => Promise.resolve("Resume");
      commandApi.executeCommand = (command: string, ...args: unknown[]): Thenable<unknown> => {
        commands.push({ command, args });
        return Promise.resolve(undefined);
      };
      const creationFilesystem = isolateTaskCreationFilesystem(writtenFiles);

      try {
        await startNewTask(makeInventoryStub(), vscode.Uri.file("/extension"), makeStoreStub());
        await Promise.resolve();
        await Promise.resolve();
        const progressDocument = [...writtenFiles.entries()]
          .find(([file]) => file.endsWith("task-progress.json"))?.[1];
        assert.ok(progressDocument, "creation should persist progress for the new task");
        const progress = JSON.parse(progressDocument) as { taskFolder: string; ownership?: { metaRoot?: string } };
        const taskFolderPath = path.join(
          workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
          ".ensemble",
          progress.taskFolder
        );
        // The Resume offer is now a non-blocking internal notification with an
        // inline action, not a modal — so nothing auto-executes resumeTask.
        assert.deepEqual(commands, []);
        const resumeEntry = entries.find((e) => e.actionCommand?.command === "vs-code-ai-helper.resumeTask");
        assert.ok(resumeEntry, "expected an internal notification offering to Resume");
        assert.equal(resumeEntry?.level, "warning");
        assert.deepEqual(resumeEntry?.actionCommand?.args, [{ taskFolderPath }]);
      } finally {
        creationFilesystem.restore();
        commandApi.executeCommand = origExecuteCommand;
        win.showInformationMessage = origShowInformationMessage;
        win.showErrorMessage = origShowErrorMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        workspace.fs.writeFile = origWriteFile;
        workspace.fs.rename = origRename;
        workspace.fs.readDirectory = origReadDirectory;
        workspace.fs.readFile = origReadFile;
        workspace.openTextDocument = origOpenTextDocument;
        win.showTextDocument = origShowTextDocument;
        deactivateNotificationRouter();
      }
    });

    void it("classifies a legacy creating sentinel read-only instead of promoting it to paused", async () => {
      const { TaskCreationStartupReconcilerV1 } = await import("../state/taskCreationStartupReconcilerV1.js");
      const { resetCreationSeedHistoryCacheForTests } = await import("../services/taskCreationSeedHistoryV1.js");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-create-recovery-"));
      const taskName = "2026-01-01_task_1";
      const taskFolderPath = path.join(root, taskName);
      fs.mkdirSync(taskFolderPath, { recursive: true });
      fs.writeFileSync(
        path.join(taskFolderPath, "task-progress.json"),
        JSON.stringify({
          taskFolder: taskName,
          currentStage: "desc",
          status: "creating",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      );
      fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n");

      // Real-fs bridge (mirrors taskCreationStartupReconcilerV1.test.ts's
      // installRealFsBridge): the reconciler reads the meta root AND every
      // candidate task folder's directory listing, so — unlike the old
      // gate's single-shape readDirectory mock this replaced — the bridge
      // must resolve each URI against the real temp tree rather than
      // returning one fixed shape for every call.
      const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalReadDirectory = workspaceFs.readDirectory;
      const originalReadFile = workspaceFs.readFile;
      const originalStat = workspaceFs.stat;
      const originalWriteFile = workspaceFs.writeFile;
      workspaceFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
        fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
      workspaceFs.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
        const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        ]);
      };
      workspaceFs.stat = async (uri: vscode.Uri): Promise<vscode.FileStat> => {
        const s = await fs.promises.stat(uri.fsPath);
        return {
          type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
          ctime: s.ctimeMs,
          mtime: s.mtimeMs,
          size: s.size,
        };
      };
      workspaceFs.writeFile = (): Promise<void> => {
        throw new Error("TaskCreationStartupReconcilerV1 must never write");
      };
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      try {
        const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(
          root,
          vscode.Uri.file(path.resolve(__dirname, "..", ".."))
        );
        assert.equal(footprints.length, 1, "the creating folder must be classified, not silently skipped");
        assert.equal(footprints[0]?.taskFolderName, taskName);
        assert.equal(footprints[0]?.hasTaskMd, true, "task.md's presence is recorded, but only informationally");
        // workspaceFs.writeFile throws unconditionally above, so simply
        // reaching this assertion without an error proves classification
        // never rewrote task-progress.json — the old promote-to-paused
        // behavior stays removed.
      } finally {
        TaskCreationStartupReconcilerV1.resetForTests();
        resetCreationSeedHistoryCacheForTests();
        workspaceFs.readDirectory = originalReadDirectory;
        workspaceFs.readFile = originalReadFile;
        workspaceFs.stat = originalStat;
        workspaceFs.writeFile = originalWriteFile;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    void it("does not pause an active review task when a new task is created", async () => {
      // This is the reported race in production terms: review startup claims
      // an already-active task after another task was created. Before the
      // paused-at-creation change, creation activated itself and paused the
      // original task, making this claim throw.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { claimReviewAttempt } = await import("../commands/reviewActions.js");

      const surface: StatusSurface = { addEntry(): void {} };
      initNotificationRouter(surface);
      const win = getWindowStub();
      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origRename = workspace.fs.rename;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const origReadFile = (workspace.fs as typeof vscode.workspace.fs).readFile;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;
      const writtenFiles = new Map<string, string>();
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-startup-"));
      const oldFolder = vscode.Uri.file(path.join(tempRoot, ".ensemble", "review-in-progress"));
      const oldProgressUri = vscode.Uri.joinPath(oldFolder, "task-progress.json");
      writtenFiles.set(oldProgressUri.path, JSON.stringify({
        taskFolder: "review-in-progress",
        currentStage: "plan",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      workspace.workspaceFolders = [{ uri: vscode.Uri.file(tempRoot), name: "workspace", index: 0 }];
      workspace.fs.createDirectory = (): Promise<void> => Promise.resolve();
      workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => {
        writtenFiles.set(uri.path, new TextDecoder().decode(bytes));
        return Promise.resolve();
      };
      workspace.fs.rename = (): Promise<void> => Promise.resolve();
      (workspace.fs as typeof vscode.workspace.fs).readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
        const content = writtenFiles.get(uri.path);
        return content === undefined
          ? Promise.reject(new Error(`missing ${uri.path}`))
          : Promise.resolve(new TextEncoder().encode(content));
      };
      workspace.openTextDocument = (): Promise<vscode.TextDocument> => Promise.resolve({} as vscode.TextDocument);
      win.showTextDocument = (): Promise<vscode.TextEditor> => Promise.resolve({} as vscode.TextEditor);
      win.showErrorMessage = (): Thenable<string | undefined> => Promise.resolve(undefined);
      win.showWarningMessage = (): Thenable<string | undefined> => Promise.resolve(undefined);
      const creationFilesystem = isolateTaskCreationFilesystem(writtenFiles);

      try {
        await startNewTask(makeInventoryStub(), vscode.Uri.file("/extension"), makeStoreStub(oldFolder.fsPath));
        const claim = await claimReviewAttempt(oldFolder, "review-attempt-after-new-task");
        assert.equal(claim?.status, "active");
        assert.equal(claim?.reviewAttemptId, "review-attempt-after-new-task");
        assert.equal(
          (JSON.parse(writtenFiles.get(oldProgressUri.path) ?? "{}") as { status?: string }).status,
          "active",
          "creating a task must not write a paused state to the task whose review is starting"
        );
      } finally {
        creationFilesystem.restore();
        win.showErrorMessage = origShowErrorMessage;
        win.showWarningMessage = origShowWarningMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        workspace.fs.writeFile = origWriteFile;
        workspace.fs.rename = origRename;
        (workspace.fs as typeof vscode.workspace.fs).readFile = origReadFile;
        workspace.openTextDocument = origOpenTextDocument;
        win.showTextDocument = origShowTextDocument;
        fs.rmSync(tempRoot, { recursive: true, force: true });
        deactivateNotificationRouter();
      }
    });

    void it("runs automatic Git-ignore maintenance when the first task is created", async () => {
      // Activation only runs the maintenance when the startup inventory
      // already has tasks, so the first creation in a fresh workspace must
      // trigger it itself — otherwise `.ensemble` shows up as unignored Git
      // changes until the next reload. Same monkey-patch recorder pattern as
      // metaResourcesMigration.test.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const gitIgnoreModule = require("../commands/toggleMetaResourcesGitIgnore") as {
        ensureAutomaticMetaGitIgnore: (...args: unknown[]) => Promise<void>;
      };

      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      const soleFolder = { uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 };
      workspace.workspaceFolders = [soleFolder];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origRename = workspace.fs.rename;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;
      const origEnsure = gitIgnoreModule.ensureAutomaticMetaGitIgnore;

      workspace.fs.createDirectory = (): Promise<void> => Promise.resolve();
      workspace.fs.writeFile = (): Promise<void> => Promise.resolve();
      workspace.fs.rename = (): Promise<void> => Promise.resolve();
      workspace.openTextDocument = (): Promise<vscode.TextDocument> =>
        Promise.resolve({} as vscode.TextDocument);
      win.showTextDocument = (): Promise<vscode.TextEditor> =>
        Promise.resolve({} as vscode.TextEditor);
      win.showErrorMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);
      win.showWarningMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);

      const gitIgnoreCalls: unknown[][] = [];
      gitIgnoreModule.ensureAutomaticMetaGitIgnore = (
        ...args: unknown[]
      ): Promise<void> => {
        gitIgnoreCalls.push(args);
        return Promise.resolve();
      };

      // Empty inventory — the fresh-workspace case activation skips.
      const inventory = makeInventoryStub();
      const store = makeStoreStub();
      const context = { workspaceState: new Map() } as unknown as vscode.ExtensionContext;
      const creationFilesystem = isolateTaskCreationFilesystem();

      try {
        await startNewTask(inventory, vscode.Uri.file("/extension"), store, context);
        assert.strictEqual(
          gitIgnoreCalls.length,
          1,
          "creating the first task must apply the managed .gitignore block"
        );
        assert.strictEqual(
          gitIgnoreCalls[0]?.[0],
          context,
          "the maintenance must receive the extension context (its once-per-root gate lives in workspaceState)"
        );
        assert.strictEqual(
          gitIgnoreCalls[0]?.[1],
          soleFolder,
          "the maintenance must receive the workspace folder the task was created in"
        );
      } finally {
        creationFilesystem.restore();
        gitIgnoreModule.ensureAutomaticMetaGitIgnore = origEnsure;
        win.showErrorMessage = origShowErrorMessage;
        win.showWarningMessage = origShowWarningMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        workspace.fs.writeFile = origWriteFile;
        workspace.fs.rename = origRename;
        workspace.openTextDocument = origOpenTextDocument;
        win.showTextDocument = origShowTextDocument;
        deactivateNotificationRouter();
      }
    });

    void it("targets the selected workspace folder for Git-ignore maintenance in a multi-root workspace", async () => {
      // Two independent folders: the task is created in the second, so the
      // Git-ignore maintenance must be told about that folder — resolving
      // from workspaceFolders[0] would update the wrong repository.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const gitIgnoreModule = require("../commands/toggleMetaResourcesGitIgnore") as {
        ensureAutomaticMetaGitIgnore: (...args: unknown[]) => Promise<void>;
      };

      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      const firstFolder = { uri: vscode.Uri.file("/repo-a"), name: "repo-a", index: 0 };
      const secondFolder = { uri: vscode.Uri.file("/repo-b"), name: "repo-b", index: 1 };
      workspace.workspaceFolders = [firstFolder, secondFolder];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origRename = workspace.fs.rename;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;
      const origShowQuickPick = win.showQuickPick;
      const origEnsure = gitIgnoreModule.ensureAutomaticMetaGitIgnore;

      workspace.fs.createDirectory = (): Promise<void> => Promise.resolve();
      workspace.fs.writeFile = (): Promise<void> => Promise.resolve();
      workspace.fs.rename = (): Promise<void> => Promise.resolve();
      workspace.openTextDocument = (): Promise<vscode.TextDocument> =>
        Promise.resolve({} as vscode.TextDocument);
      win.showTextDocument = (): Promise<vscode.TextEditor> =>
        Promise.resolve({} as vscode.TextEditor);
      win.showErrorMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);
      win.showWarningMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);
      // The user picks the second folder in the workspace quick pick.
      win.showQuickPick = (<T>(items: readonly T[]): Thenable<T | undefined> =>
        Promise.resolve(items[1])) as typeof win.showQuickPick;

      const gitIgnoreCalls: unknown[][] = [];
      gitIgnoreModule.ensureAutomaticMetaGitIgnore = (
        ...args: unknown[]
      ): Promise<void> => {
        gitIgnoreCalls.push(args);
        return Promise.resolve();
      };

      const inventory = makeInventoryStub();
      const store = makeStoreStub();
      const context = { workspaceState: new Map() } as unknown as vscode.ExtensionContext;
      const creationFilesystem = isolateTaskCreationFilesystem();

      try {
        await startNewTask(inventory, vscode.Uri.file("/extension"), store, context);
        assert.strictEqual(
          gitIgnoreCalls.length,
          1,
          "creating the first task must apply the managed .gitignore block"
        );
        assert.strictEqual(
          gitIgnoreCalls[0]?.[1],
          secondFolder,
          "the maintenance must target the folder the user selected, not workspaceFolders[0]"
        );
      } finally {
        creationFilesystem.restore();
        gitIgnoreModule.ensureAutomaticMetaGitIgnore = origEnsure;
        win.showQuickPick = origShowQuickPick;
        win.showErrorMessage = origShowErrorMessage;
        win.showWarningMessage = origShowWarningMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        workspace.fs.writeFile = origWriteFile;
        workspace.fs.rename = origRename;
        workspace.openTextDocument = origOpenTextDocument;
        win.showTextDocument = origShowTextDocument;
        deactivateNotificationRouter();
      }
    });
  });
});
