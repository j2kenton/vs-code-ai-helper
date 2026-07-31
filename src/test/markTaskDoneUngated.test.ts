/**
 * Coverage for the C3 "Complete Task is never gated" requirement: markTaskDone
 * completes a Publish-stage task unconditionally — it runs no completion
 * checks, shows no modal prompt, and never invokes the Fix-with-AI command.
 * The completion-check + override flow belongs to the publishing commands
 * (commitAndPushTask), not to task completion.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { markTaskDone } from "../commands/markTaskDone";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import { readTaskProgressForTest as readTaskProgress } from "./taskFolderFixture";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

// completionLint.ts's exported functions are monkey-patched via the shared
// CommonJS module object (see commitAndPushDuplicateGuard.test.ts for the
// same technique). Here the stub exists to PROVE it is never called: task
// completion must not run completion checks at all.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<unknown>;
};

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-mark-done-ungated-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProgress(folderPath: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
}

function fixtureProgress(taskFolderPath: string): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scheduledResumeTime: "2026-01-02T00:00:00.000Z",
  };
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 },
  ];
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig; } };
}

function makeInventory(taskFolderPath: string): TaskInventory {
  const item = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId: taskFolderPath,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: fixtureProgress(taskFolderPath),
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? item : undefined),
    getTaskByPath: (p: string) => (p === taskFolderPath ? item : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [item],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

function makeCurrentTaskStoreStub(): CurrentTaskStore & { cleared: boolean } {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore & { cleared: boolean };
  store.cleared = false;
  store.get = (): string | undefined => undefined;
  store.set = (): Promise<void> => Promise.resolve();
  store.clear = (): Promise<void> => { store.cleared = true; return Promise.resolve(); };
  return store;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

void describe("markTaskDone is ungated (C3: Complete Task never runs or blocks on checks)", () => {
  void it("completes the task without running completion checks, prompting, or invoking fixes", async () => {
    const taskFolderPath = makeTaskFolder("ungated-complete");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath));

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const originalRunCompletionLint = completionLintModule.runCompletionLint;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalExecuteCommand = vscode.commands.executeCommand;

    let lintCalls = 0;
    completionLintModule.runCompletionLint = (): Promise<unknown> => {
      lintCalls += 1;
      return Promise.resolve({ passed: false, summary: "1 completion check(s) failed.", runAt: "", issueCount: 1, failedChecks: [] });
    };
    let warningPrompts = 0;
    vscode.window.showWarningMessage = ((...args: unknown[]) => {
      warningPrompts += 1;
      return originalShowWarningMessage(...(args as Parameters<typeof vscode.window.showWarningMessage>));
    }) as unknown as typeof vscode.window.showWarningMessage;
    const executedCommands: string[] = [];
    vscode.commands.executeCommand = ((commandId: string, ...args: unknown[]) => {
      executedCommands.push(commandId);
      return originalExecuteCommand(commandId, ...args);
    }) as unknown as typeof vscode.commands.executeCommand;

    try {
      const inventory = makeInventory(taskFolderPath);
      const currentTaskStore = makeCurrentTaskStoreStub();

      await markTaskDone(inventory, currentTaskStore, { taskFolderPath });

      const progress = await readTaskProgress(vscode.Uri.file(taskFolderPath));
      assert.equal(progress?.status, "completed", "Complete Task must complete the task unconditionally");
      assert.ok(progress?.completedAt, "completedAt must be stamped");
      assert.ok(
        progress?.completedStages?.includes("publish"),
        "publish must be recorded as a completed stage"
      );
      assert.equal(progress?.scheduledResumeTime, undefined, "completed tasks must not retain an actionable timer");

      assert.equal(lintCalls, 0, "completion must never run completion checks — those belong to publishing");
      assert.equal(warningPrompts, 0, "completion must never show a gating prompt");
      assert.equal(
        executedCommands.includes("vs-code-ai-helper.runLintingFixes"),
        false,
        "completion must never invoke the Fix-with-AI flow"
      );
      assert.ok(
        surface.entries.some((e) => e.level === "info" && /complete/i.test(e.message)),
        `expected a terminal completion entry in the Notifications section; got: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      completionLintModule.runCompletionLint = originalRunCompletionLint;
      vscode.window.showWarningMessage = originalShowWarningMessage;
      vscode.commands.executeCommand = originalExecuteCommand;
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("clears the current task when no other active task remains", async () => {
    const taskFolderPath = makeTaskFolder("ungated-next-selection");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath));

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const inventory = makeInventory(taskFolderPath);
      const currentTaskStore = makeCurrentTaskStoreStub();

      await markTaskDone(inventory, currentTaskStore, { taskFolderPath });

      assert.equal(currentTaskStore.cleared, true, "with no other active task, the current task store is cleared");
      assert.ok(
        surface.entries.some((e) => /No remaining active tasks/i.test(e.message)),
        `expected the no-remaining-tasks completion entry; got: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});
