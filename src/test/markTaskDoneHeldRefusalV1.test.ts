/**
 * chat1 Steps 18, 19 and 22: running Complete Task while another action holds the task produces
 * exactly one Notifications entry that says what holds it, since when and what to do. The bare
 * outcome code never shows, and the refused operation adds no second "failed" entry.
 * This drives the `markTaskDone` command itself, with the operation-notification bridge installed.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { markTaskDone } from "../commands/markTaskDone";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";
import { duplicateRejectedV1 } from "../types/taskActionOutcomeV1";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runtimeModule = require("../actions/productionTaskActionRuntimeV1") as {
  invokeLifecycleRowV1: (...args: unknown[]) => Promise<unknown>;
};

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-mark-done-held-"));
const ACQUIRED_AT = new Date(2026, 10, 2, 21, 20, 0).toISOString();

function fixtureProgress(taskFolderPath: string): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    displayName: "bugs5",
    ownership: fixtureOwnershipFor(taskFolderPath),
  };
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  const origStat = target.stat;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.stat = (uri: vscode.Uri): Promise<vscode.FileStat> =>
    fs.promises.stat(uri.fsPath).then((stat) => ({
      type: vscode.FileType.File,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    }));
  return { restore: (): void => { target.readFile = orig; target.stat = origStat; } };
}

function makeInventory(taskFolderPath: string, progress: TaskProgress): TaskInventory {
  const item = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId: taskFolderPath,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress,
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

function makeCurrentTaskStoreStub(): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => undefined;
  store.set = (): Promise<void> => Promise.resolve();
  store.clear = (): Promise<void> => Promise.resolve();
  return store;
}

void describe("markTaskDone refused because another action holds the task", () => {
  const original = runtimeModule.invokeLifecycleRowV1;
  afterEach(() => {
    runtimeModule.invokeLifecycleRowV1 = original;
    deactivateNotificationRouter();
  });

  void it("posts exactly one entry that names the holder, with no outcome code and no second 'failed' entry", async () => {
    const taskFolderPath = path.join(REAL_ROOT, "held");
    fs.mkdirSync(taskFolderPath, { recursive: true });
    const progress = fixtureProgress(taskFolderPath);
    fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
    fs.writeFileSync(path.join(taskFolderPath, "publish-review.md"), "Readiness: 10/10");

    const entries: unknown[][] = [];
    initNotificationRouter({ addEntry: (...args: unknown[]): void => { entries.push(args); } });
    const bridge = installOperationNotificationBridge();
    const rf = installReadFileBridge();
    const ws = (vscode.workspace as unknown as Record<string, unknown>);
    const originalFolders = ws.workspaceFolders;
    ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
    runtimeModule.invokeLifecycleRowV1 = (): Promise<unknown> =>
      Promise.resolve(duplicateRejectedV1({ actionKey: "commitPush.v1", operationId: "lease-op", acquiredAt: ACQUIRED_AT }));

    try {
      await markTaskDone(makeInventory(taskFolderPath, progress), makeCurrentTaskStoreStub(), { taskFolderPath });

      const text = entries.map((e) => String(e[0]));
      assert.equal(entries.length, 1, `one entry per refusal; got: ${JSON.stringify(text)}`);
      assert.match(text[0]!, /Can't complete "bugs5": Commit & Push has been running since /);
      assert.doesNotMatch(text[0]!, /duplicateRejected|operationAlreadyRunning/);
      assert.equal(entries[0]![1], "warning");
    } finally {
      bridge.dispose();
      rf.restore();
      ws.workspaceFolders = originalFolders;
    }
  });
});
