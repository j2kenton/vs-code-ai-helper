import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  initNotificationRouter,
  deactivateNotificationRouter,
  NotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { TaskStatusBar } from "../views/taskStatusBar";
import { IncompleteTask } from "../utils/taskProgressUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  fsPath: string,
  folderName: string,
  stage: string = "implementation",
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

function makeStoreStub(initialId?: string) {
  let id = initialId;
  return {
    get: (): string | undefined => id,
    set: async (newId: string): Promise<void> => {
      id = newId;
    },
    clear: (): void => {
      id = undefined;
    },
    onDidChange: { event: () => ({ dispose() {} }) },
  } as unknown as import("../utils/currentTaskStore").CurrentTaskStore;
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
      assert.ok(entries[0]);
      assert.strictEqual(entries[0]!.message.length, 153); // 150 characters + "..."
      assert.ok(entries[0]!.message.endsWith("..."));

      // Newest-first ordering
      surface.clear();
      NotificationRouter.showInformation("first");
      NotificationRouter.showInformation("second");
      entries = surface.getEntries();
      assert.strictEqual(entries.length, 2);
      assert.ok(entries[0]);
      assert.ok(entries[1]);
      assert.strictEqual(entries[0]!.message, "second"); // Newest first
      assert.strictEqual(entries[1]!.message, "first");

      // Bounded retention (50 entries)
      surface.clear();
      for (let i = 0; i < 60; i++) {
        NotificationRouter.showInformation(`message ${i}`);
      }
      entries = surface.getEntries();
      assert.strictEqual(entries.length, 50);
      assert.ok(entries[0]);
      assert.ok(entries[49]);
      assert.strictEqual(entries[0]!.message, "message 59"); // Newest
      assert.strictEqual(entries[49]!.message, "message 10"); // Oldest remaining (0-9 removed)

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
      assert.ok(entries[0]);
      assert.ok(entries[1]);
      assert.ok(entries[2]);
      assert.strictEqual(entries[0]!.message, "Error message");
      assert.strictEqual(entries[0]!.level, "error");
      assert.strictEqual(entries[1]!.message, "Warning message");
      assert.strictEqual(entries[1]!.level, "warning");
      assert.strictEqual(entries[2]!.message, "Info message");
      assert.strictEqual(entries[2]!.level, "info");

      deactivateNotificationRouter();
    });
  });

  void describe("TaskStatusBar states", () => {
    void it("should show neutral state when no active task exists", () => {
      const store = makeStoreStub(undefined);
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "completed", "active")];

      bar.update(tasks, undefined);

      // Access private item stub properties
      const item = (bar as any).item;
      assert.strictEqual(item.text, "$(checklist) Ensemble: No active task");
      bar.dispose();
    });

    void it("should show paused state correctly when shown task is paused", () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "implementation", "paused", "/workspace/task-a")];

      bar.update(tasks, "/workspace/task-a");

      const item = (bar as any).item;
      assert.ok(item.text.includes("[paused]"));
      assert.ok(item.text.includes("task-a"));
      bar.dispose();
    });

    void it("should show active state correctly when shown task is active", () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "implementation", "active", "/workspace/task-a")];

      bar.update(tasks, "/workspace/task-a");

      const item = (bar as any).item;
      assert.ok(!item.text.includes("[paused]"));
      assert.ok(item.text.includes("task-a"));
      bar.dispose();
    });
  });

  void describe("TaskStatusBar menu actions", () => {
    void it("should offer Resume shown task when shown task is paused", async () => {
      const store = makeStoreStub("/workspace/task-a");
      const bar = new TaskStatusBar(store);
      const tasks = [makeTask("/workspace/task-a", "task-a", "implementation", "paused", "/workspace/task-a")];
      bar.update(tasks, "/workspace/task-a");

      const win = vscode.window as any;
      const origShowQuickPick = win.showQuickPick;
      let capturedItems: any[] = [];
      win.showQuickPick = async (items: any[]) => {
        capturedItems = items;
        return undefined; // Cancel selection
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
      const tasks = [makeTask("/workspace/task-a", "task-a", "implementation", "active", "/workspace/task-a")];
      bar.update(tasks, "/workspace/task-a");

      const win = vscode.window as any;
      const origShowQuickPick = win.showQuickPick;
      let capturedItems: any[] = [];
      win.showQuickPick = async (items: any[]) => {
        capturedItems = items;
        return undefined; // Cancel selection
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
      const tasks = [makeTask("/workspace/task-a", "task-a", "completed", "active", "/workspace/task-a")];
      bar.update(tasks, "/workspace/task-a");

      const win = vscode.window as any;
      const origShowQuickPick = win.showQuickPick;
      let capturedItems: any[] = [];
      win.showQuickPick = async (items: any[]) => {
        capturedItems = items;
        return undefined; // Cancel selection
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
    void it("should prefill description under Task Description heading if provided", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startNewTask } = await import("../commands/startNewTask.js");

      // Initialize notification router
      initNotificationRouter({ addEntry() {} });

      const win = vscode.window as any;
      const origShowInputBox = win.showInputBox;
      win.showInputBox = async () => "Implement sidebar status view";

      // Stub workspace functions and resolveTaskRootForCreation to prevent real directory writes
      const workspace = vscode.workspace as any;
      const origWorkspaceFolders = workspace.workspaceFolders;
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origWriteFile = workspace.fs.writeFile;
      const origOpenTextDocument = workspace.openTextDocument;
      const origShowTextDocument = win.showTextDocument;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;

      let writtenContent = "";
      workspace.fs.createDirectory = async () => {};
      workspace.fs.writeFile = async (_uri: any, bytes: Uint8Array) => {
        writtenContent = new TextDecoder().decode(bytes);
      };
      workspace.openTextDocument = async () => ({});
      win.showTextDocument = async () => {};
      win.showErrorMessage = async () => undefined;
      win.showWarningMessage = async () => undefined;

      // Inventory mock
      const inventory = {
        refresh: async () => {},
        getTaskById: () => undefined,
        getTaskByPath: () => undefined,
        getTasks: () => [],
      } as any;

      const store = makeStoreStub();

      try {
        await startNewTask(inventory, vscode.Uri.file("/extension"), store);
        assert.ok(writtenContent.includes("Implement sidebar status view"));
        assert.ok(writtenContent.includes("## Task Description"));
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
      initNotificationRouter({ addEntry() {} });

      const win = vscode.window as any;
      const origShowInputBox = win.showInputBox;
      win.showInputBox = async () => undefined; // Cancel

      const workspace = vscode.workspace as any;
      const origWorkspaceFolders = workspace.workspaceFolders;
      workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];

      const origCreateDirectory = workspace.fs.createDirectory;
      const origShowErrorMessage = win.showErrorMessage;
      const origShowWarningMessage = win.showWarningMessage;

      let dirCreated = false;
      workspace.fs.createDirectory = async () => {
        dirCreated = true;
      };
      win.showErrorMessage = async () => undefined;
      win.showWarningMessage = async () => undefined;

      const inventory = {
        refresh: async () => {},
        getTasks: () => [],
      } as any;
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
      initNotificationRouter({ addEntry() {} });

      const win = vscode.window as any;
      const origShowInputBox = win.showInputBox;
      win.showInputBox = async () => ""; // Empty input (Enter pressed with no text)

      const workspace = vscode.workspace as any;
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
      workspace.fs.createDirectory = async () => {
        dirCreated = true;
      };
      workspace.fs.writeFile = async (_uri: any, bytes: Uint8Array) => {
        writtenContent = new TextDecoder().decode(bytes);
      };
      workspace.openTextDocument = async () => ({});
      win.showTextDocument = async () => {};
      win.showErrorMessage = async () => undefined;
      win.showWarningMessage = async () => undefined;

      const inventory = {
        refresh: async () => {},
        getTaskById: () => undefined,
        getTaskByPath: () => undefined,
        getTasks: () => [],
      } as any;
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
