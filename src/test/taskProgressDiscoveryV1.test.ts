/**
 * Coverage for the §3.12 Read-cohort cutover:
 *
 *  - `findAllTasksStrictV1`/`findIncompleteTasksStrictV1` — a missing
 *    progress file still means "not a task folder" (skipped, permissive
 *    parity), while an undecodable one becomes an explicit recovery entry;
 *    completed tasks are filtered by the incomplete variant.
 *  - `TaskInventory.refresh()` — valid folders load strictly; undecodable
 *    folders publish through `getRecoveryEntries()` instead of being
 *    silently omitted (plan §3.12 step 4).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  findAllTasksStrictV1,
  findIncompleteTasksStrictV1,
} from "../services/taskProgressDiscoveryV1";
import { TaskInventory } from "../state/taskInventory";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";

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

function installReadBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = { readFile: target.readFile, readDirectory: target.readDirectory, stat: target.stat };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  };
  target.stat = (uri: vscode.Uri): Promise<vscode.FileStat> =>
    fs.promises.stat(uri.fsPath).then((s) => ({
      type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    }));
  return {
    restore: (): void => {
      target.readFile = originals.readFile;
      target.readDirectory = originals.readDirectory;
      target.stat = originals.stat;
    },
  };
}

function writeTaskFixture(
  metaRoot: string,
  name: string,
  progress: Record<string, unknown> | string | undefined
): string {
  const folder = path.join(metaRoot, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "task.md"), "# task");
  if (progress !== undefined) {
    fs.writeFileSync(
      path.join(folder, "task-progress.json"),
      typeof progress === "string" ? progress : JSON.stringify(progress, null, 2)
    );
  }
  return folder;
}

function validProgress(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    ...overrides,
  };
}

void describe("taskProgressDiscoveryV1", () => {
  void it("skips progress-less folders, loads valid tasks, and reports undecodable ones as recovery entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-strict-discovery-"));
    const meta = path.join(root, ".ensemble");
    fs.mkdirSync(meta, { recursive: true });
    const bridge = installReadBridge();
    try {
      writeTaskFixture(meta, "2026-07-01_task_1", validProgress("2026-07-01_task_1"));
      writeTaskFixture(meta, "2026-07-01_task_2", validProgress("2026-07-01_task_2", { status: "completed", completedAt: "2026-07-03T00:00:00.000Z" }));
      writeTaskFixture(meta, "2026-07-01_task_3", "{ not valid json");
      writeTaskFixture(meta, "2026-07-01_task_4", undefined); // no progress file → not a task

      const all = await findAllTasksStrictV1(vscode.Uri.file(meta));
      assert.deepEqual(all.tasks.map((t) => t.folderName).sort(), [
        "2026-07-01_task_1",
        "2026-07-01_task_2",
      ]);
      assert.equal(all.recovery.length, 1);
      assert.equal(all.recovery[0]!.folderName, "2026-07-01_task_3");
      assert.notEqual(all.recovery[0]!.code, "missing");

      const incomplete = await findIncompleteTasksStrictV1(vscode.Uri.file(meta));
      assert.deepEqual(incomplete.tasks.map((t) => t.folderName), ["2026-07-01_task_1"]);
      assert.equal(incomplete.recovery.length, 1);
    } finally {
      bridge.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("reports an unknown-status document as recovery (the permissive reader silently coerced it to active)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-strict-discovery-coerce-"));
    const meta = path.join(root, ".ensemble");
    fs.mkdirSync(meta, { recursive: true });
    const bridge = installReadBridge();
    try {
      writeTaskFixture(meta, "2026-07-01_task_9", validProgress("2026-07-01_task_9", { status: "wip" }));
      const all = await findAllTasksStrictV1(vscode.Uri.file(meta));
      assert.equal(all.tasks.length, 0);
      assert.equal(all.recovery.length, 1);
    } finally {
      bridge.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

void describe("TaskInventory strict refresh (plan §3.12 step 4)", () => {
  void it("publishes valid tasks and surfaces an undecodable folder via getRecoveryEntries()", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-inventory-strict-"));
    const meta = path.join(root, ".ensemble");
    fs.mkdirSync(meta, { recursive: true });
    const config = installConfigStub(".ensemble");
    const workspace = installWorkspaceFoldersStub([root]);
    const bridge = installReadBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    try {
      writeTaskFixture(meta, "2026-07-01_task_1", validProgress("2026-07-01_task_1"));
      // Malformed timestamp: visible under the permissive reader, recovery
      // under strict decode.
      writeTaskFixture(meta, "2026-07-01_task_2", validProgress("2026-07-01_task_2", { updatedAt: "yesterday-ish" }));

      const inventory = new TaskInventory();
      await inventory.refresh();

      assert.deepEqual(
        inventory.getTasks().map((t) => t.folderName),
        ["2026-07-01_task_1"]
      );
      const recovery = inventory.getRecoveryEntries();
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0]!.folderName, "2026-07-01_task_2");
      assert.ok(recovery[0]!.reason.length > 0);
    } finally {
      bridge.restore();
      workspace.restore();
      config.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
