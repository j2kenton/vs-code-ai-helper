import * as assert from "node:assert/strict";
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
  showWarningMessage: typeof vscode.window.showWarningMessage;
};

type WorkspaceStub = {
  workspaceFolders: typeof vscode.workspace.workspaceFolders;
  fs: Pick<typeof vscode.workspace.fs, "createDirectory" | "writeFile">;
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

  void describe("Status Surface retention, ordering, and trimming", () => {
    void it("should keep bounded retention, newest-first, and trim message text", () => {
      const surface = new StatusTreeProvider();
      initNotificationRouter(surface);

      // Trim message text
      NotificationRouter.showInformation("a".repeat(200));
      let entries = surface.getEntries();
      assert.strictEqual(entries.length, 1);
      const firstTrimmed = requireValue(entries[0], "missing first trimmed entry");
      assert.strictEqual(firstTrimmed.message.length, 153); // 150 characters + "..."
      assert.ok(firstTrimmed.message.endsWith("..."));

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

      // Bounded retention (50 entries)
      surface.clear();
      for (let i = 0; i < 60; i++) {
        NotificationRouter.showInformation(`message ${i}`);
      }
      entries = surface.getEntries();
      assert.strictEqual(entries.length, 50);
      const newest = requireValue(entries[0], "missing newest retained entry");
      const oldest = requireValue(entries[49], "missing oldest retained entry");
      assert.strictEqual(newest.message, "message 59"); // Newest
      assert.strictEqual(oldest.message, "message 10"); // Oldest remaining (0-9 removed)

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

  void describe("New-task creation prefill helper", () => {
    void it("should write a separate task description file when provided", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");

      // Initialize notification router
      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const origShowInputBox = win.showInputBox;
      win.showInputBox = (): Promise<string> =>
        Promise.resolve("Implement sidebar status view");

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
        const description = [...writtenFiles.entries()].find(([filePath]) =>
          filePath.endsWith("/task-description.md")
        )?.[1];
        const task = [...writtenFiles.entries()].find(([filePath]) =>
          filePath.endsWith("/task.md")
        )?.[1];
        assert.strictEqual(description, "Implement sidebar status view\n");
        assert.ok(task?.includes("## Task Description"));
        assert.ok(!task?.includes("Implement sidebar status view"));
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

    void it("should abort and do nothing when input is cancelled", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");

      // Initialize notification router
      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const origShowInputBox = win.showInputBox;
      win.showInputBox = (): Promise<string | undefined> => Promise.resolve(undefined);

      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;

      let dirCreated = false;
      workspace.fs.createDirectory = (): Promise<void> => {
        dirCreated = true;
        return Promise.resolve();
      };
      win.showErrorMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);
      win.showWarningMessage = (): Thenable<string | undefined> =>
        Promise.resolve(undefined);

      const inventory = makeInventoryStub();
      const store = makeStoreStub();

      try {
        const result = await startNewTask(inventory, vscode.Uri.file("/extension"), store);
        assert.strictEqual(result, undefined);
        assert.strictEqual(dirCreated, false, "Should not create directory when cancelled");
      } finally {
        win.showInputBox = origShowInputBox;
        win.showErrorMessage = origShowErrorMessage;
        win.showWarningMessage = origShowWarningMessage;
        workspace.workspaceFolders = origWorkspaceFolders;
        workspace.fs.createDirectory = origCreateDirectory;
        deactivateNotificationRouter();
      }
    });

    void it("should create standard task when description is empty", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");

      // Initialize notification router
      const surface: StatusSurface = {
        addEntry(): void {},
      };
      initNotificationRouter(surface);

      const win = getWindowStub();
      const origShowInputBox = win.showInputBox;
      win.showInputBox = (): Promise<string> => Promise.resolve("");

      const workspace = getWorkspaceStub();
      const origWorkspaceFolders = workspace.workspaceFolders;
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;

      let dirCreated = false;
      let writtenContent = "";
      workspace.fs.createDirectory = (): Promise<void> => {
        dirCreated = true;
        return Promise.resolve();
      };
      workspace.fs.writeFile = (
        _uri: vscode.Uri,
        bytes: Uint8Array
      ): Promise<void> => {
        writtenContent = new TextDecoder().decode(bytes);
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

      try {
        await startNewTask(inventory, vscode.Uri.file("/extension"), store);
        assert.strictEqual(dirCreated, true);
        assert.ok(writtenContent.includes("## Task Description"));
        assert.ok(!writtenContent.includes("undefined"));
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
  });
});
