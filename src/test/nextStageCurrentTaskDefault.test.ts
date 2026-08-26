/**
 * wf10 item 20: a "Next Stage" invocation with no explicit tree node (a
 * task-scoped stage chat, a keybinding, or the command palette) must default
 * to CurrentTaskStore's task when it is eligible, rather than always falling
 * through to a "Select a task" picker over every task in the workspace —
 * discarding context the invocation already has.
 *
 * These tests exercise `nextStage`'s (reviewActions.ts) task-discovery path
 * directly (no tree node argument), bridging `vscode.workspace.fs` to real
 * on-disk fixtures the way `resolveTask`'s discovery loop actually reads
 * them (`readDirectory` over the meta root, then `readFile` per task). The
 * downstream advance machinery is short-circuited via a stubbed
 * `cancelRunningOperationsForTask` (the very next call after resolution)
 * returning a failure — its captured argument reveals which task
 * `resolveTask` actually resolved, without needing to stub the entire
 * transition/publish chain this test does not care about.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { nextStage } from "../commands/reviewActions";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { normalizePath } from "../utils/taskRoot";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { OWNED_FIXTURE_BOUND_AT } from "./taskFolderFixture";

/* eslint-disable @typescript-eslint/no-var-requires */
const taskOperationsModule = require("../utils/taskOperations") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  showInformation(message: string): void { this.entries.push({ message, level: "info" }); }
  showWarning(message: string): void { this.entries.push({ message, level: "warning" }); }
  showError(message: string): void { this.entries.push({ message, level: "error" }); }
  addEntry(message: string, level: "info" | "warning" | "error"): void { this.entries.push({ message, level }); }
}

function writeTaskProgress(folder: string, displayName?: string): void {
  const progress = {
    taskFolder: path.basename(folder),
    currentStage: "impl",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    ...(displayName !== undefined ? { displayName } : {}),
    ownership: {
      metaRoot: path.dirname(folder),
      projectRoot: path.dirname(folder),
      boundAt: OWNED_FIXTURE_BOUND_AT,
      state: "resolved",
    },
  };
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2));
}

/** Bridges the two `vscode.workspace.fs` calls `resolveTask`'s discovery
 * loop makes (`readDirectory` over the meta root, `readFile` per task) to
 * the real filesystem, and rejects the legacy `plans/` root so only the
 * `.ensemble` fixtures below are discovered. */
function installDiscoveryFsBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadDirectory = fsObj.readDirectory;
  const origReadFile = fsObj.readFile;
  fsObj.readDirectory = (uri: vscode.Uri): Promise<[string, number][]> => {
    if (!fs.existsSync(uri.fsPath)) {
      return Promise.reject(new Error("ENOENT"));
    }
    return Promise.resolve(
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((entry) => [
        entry.name,
        entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ])
    );
  };
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return {
    restore: (): void => {
      fsObj.readDirectory = origReadDirectory;
      fsObj.readFile = origReadFile;
    },
  };
}

function installWorkspaceFoldersStub(root: string): { restore: () => void } {
  const wsObj = vscode.workspace as unknown as Record<string, unknown>;
  const orig = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    get: () => [{ uri: vscode.Uri.file(root), name: path.basename(root), index: 0 }],
  });
  return {
    restore: (): void => {
      if (orig) {
        Object.defineProperty(vscode.workspace, "workspaceFolders", orig);
      } else {
        delete wsObj.workspaceFolders;
      }
    },
  };
}

function installQuickPickCapture(): { calls: unknown[][]; restore: () => void } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const orig = win.showQuickPick;
  const calls: unknown[][] = [];
  win.showQuickPick = (...args: unknown[]): Promise<unknown> => {
    calls.push(args);
    return Promise.resolve(undefined);
  };
  return { calls, restore: (): void => { win.showQuickPick = orig; } };
}

function makeContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  return { workspaceState: memento } as unknown as vscode.ExtensionContext;
}

void describe("nextStage — defaults to CurrentTaskStore's task instead of always prompting (wf10 item 20)", () => {
  void it("skips the picker and resolves the current task when it is one of several eligible tasks", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-current-"));
    const metaRoot = path.join(container, ".ensemble");
    const taskA = path.join(metaRoot, "task-a");
    const taskB = path.join(metaRoot, "task-b");
    fs.mkdirSync(taskA, { recursive: true });
    fs.mkdirSync(taskB, { recursive: true });
    writeTaskProgress(taskA);
    writeTaskProgress(taskB);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installDiscoveryFsBridge();
    const wsBridge = installWorkspaceFoldersStub(container);
    const quickPick = installQuickPickCapture();
    const context = makeContext();

    const captured: string[] = [];
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    taskOperationsModule.cancelRunningOperationsForTask = (taskFolderPath: string): Promise<{ ok: boolean; reason?: string }> => {
      captured.push(taskFolderPath);
      return Promise.resolve({ ok: false, reason: "test-sentinel-stop" });
    };

    try {
      await new CurrentTaskStore(context.workspaceState).set(normalizePath(taskA));

      await nextStage(vscode.Uri.file(container), context, undefined);

      assert.deepEqual(quickPick.calls, [], "the current task is eligible and unambiguous — no picker should be shown");
      assert.equal(captured.length, 1, "resolution should proceed straight to the cancel-running-operations step");
      assert.equal(
        path.basename(captured[0]!),
        "task-a",
        "the CURRENT task must be the one resolved, not an arbitrary eligible task"
      );
    } finally {
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      quickPick.restore();
      wsBridge.restore();
      fsBridge.restore();
      deactivateNotificationRouter();
      fs.rmSync(container, { recursive: true, force: true });
    }
  });

  void it("falls back to the picker, listing the display name as the label and the folder id as detail, when there is no current task", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-ambiguous-"));
    const metaRoot = path.join(container, ".ensemble");
    const taskA = path.join(metaRoot, "task-a");
    const taskB = path.join(metaRoot, "task-b");
    fs.mkdirSync(taskA, { recursive: true });
    fs.mkdirSync(taskB, { recursive: true });
    writeTaskProgress(taskA, "Friendly Task Name");
    writeTaskProgress(taskB);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installDiscoveryFsBridge();
    const wsBridge = installWorkspaceFoldersStub(container);
    const quickPick = installQuickPickCapture();
    const context = makeContext();

    try {
      // No current task set — genuinely ambiguous between task-a and task-b.
      await nextStage(vscode.Uri.file(container), context, undefined);

      assert.equal(quickPick.calls.length, 1, "with no current task and two eligible tasks, the picker must be shown");
      const items = quickPick.calls[0]![0] as Array<{ label: string; detail?: string }>;
      const taskAItem = items.find((item) => item.detail === "task-a");
      assert.ok(taskAItem, "task-a's item must carry its folder id as the detail");
      assert.equal(taskAItem.label, "Friendly Task Name", "the label must be the display name, not the folder id");
      const taskBItem = items.find((item) => item.detail === "task-b");
      assert.ok(taskBItem, "task-b's item must carry its folder id as the detail");
      assert.equal(taskBItem.label, "task-b", "with no display name, the label falls back to the folder id");
    } finally {
      quickPick.restore();
      wsBridge.restore();
      fsBridge.restore();
      deactivateNotificationRouter();
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
});
