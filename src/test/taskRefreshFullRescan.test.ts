/**
 * Coverage for Part 4 (full task refresh) of the provider-discard/review-
 * status/AI-rename/task-refresh plan: `Refresh Tasks` must perform a real
 * filesystem rescan — reflecting added, removed, and modified task
 * folders/files — not just repaint the tree from stale in-memory state, and
 * it must never disturb a running operation.
 *
 * extension.ts's `vs-code-ai-helper.refreshTasksView` command now calls
 * `inventory.refresh()` directly (rather than only `taskTreeProvider.refresh()`,
 * which merely re-fires the tree's change event over whatever the inventory
 * already held). TaskInventory.refresh() is the full-rescan primitive
 * (taskInventory.ts:118), so this test exercises it directly against a real
 * fixture directory — the same contract the command now relies on — and
 * proves it goes through discoverAllTasks() again on every call rather than
 * diffing/caching, and that it never reads or mutates the independent
 * taskOperations registry.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { TaskInventory } from "../state/taskInventory";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { taskOperations } from "../utils/taskOperations";

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

function writeTaskFixture(metaRoot: string, name: string, progress: Record<string, unknown>): string {
  const folder = path.join(metaRoot, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "task.md"), "# task");
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2));
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

void describe("TaskInventory.refresh() — full filesystem rescan (Part 4)", () => {
  void it("reflects added, removed, and modified task folders on the next call, and never touches the independent taskOperations registry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-full-refresh-"));
    const meta = path.join(root, ".ensemble");
    fs.mkdirSync(meta, { recursive: true });
    const config = installConfigStub(".ensemble");
    const workspace = installWorkspaceFoldersStub([root]);
    const bridge = installReadBridge();
    TaskCreationStartupReconcilerV1.resetForTests();

    // A running operation on a task NOT touched by any of this test's
    // filesystem churn — refresh() must never end, restart, or otherwise
    // observe it.
    const untouchedTaskPath = path.join(meta, "2026-07-01_task_untouched");
    const activeOp = taskOperations.begin(untouchedTaskPath, {
      label: "Implementation",
      stage: "impl",
      kind: "run-implementation",
    });
    assert.ok(activeOp, "precondition: the stubbed active run must be admitted");

    try {
      // Round 1: only task_stays and task_removed exist.
      writeTaskFixture(meta, "2026-07-01_task_stays", validProgress("2026-07-01_task_stays"));
      writeTaskFixture(meta, "2026-07-01_task_removed", validProgress("2026-07-01_task_removed"));

      const inventory = new TaskInventory();
      await inventory.refresh();
      assert.deepEqual(
        inventory.getTasks().map((t) => t.folderName).sort(),
        ["2026-07-01_task_removed", "2026-07-01_task_stays"]
      );
      const stageBeforeEdit = inventory
        .getTasks()
        .find((t) => t.folderName === "2026-07-01_task_stays")?.progress.currentStage;
      assert.equal(stageBeforeEdit, "impl");

      // Simulate the exact filesystem churn a full rescan must pick up: an
      // addition, a removal, and an in-place modification — all made
      // directly on disk, bypassing the inventory entirely (as an external
      // git checkout, another process, or manual edit would).
      fs.rmSync(path.join(meta, "2026-07-01_task_removed"), { recursive: true, force: true });
      writeTaskFixture(meta, "2026-07-01_task_added", validProgress("2026-07-01_task_added"));
      fs.writeFileSync(
        path.join(meta, "2026-07-01_task_stays", "task-progress.json"),
        JSON.stringify(validProgress("2026-07-01_task_stays", { currentStage: "publish" }), null, 2)
      );

      await inventory.refresh();

      assert.deepEqual(
        inventory.getTasks().map((t) => t.folderName).sort(),
        ["2026-07-01_task_added", "2026-07-01_task_stays"],
        "the second refresh must reflect the addition and removal made directly on disk"
      );
      const stageAfterEdit = inventory
        .getTasks()
        .find((t) => t.folderName === "2026-07-01_task_stays")?.progress.currentStage;
      assert.equal(
        stageAfterEdit,
        "publish",
        "the second refresh must reflect the in-place progress-file modification, not stale cached state"
      );

      // The stubbed active run is untouched: still registered, still
      // running, exactly as it was before either refresh() call.
      const stillRunning = taskOperations
        .getTaskOperations(untouchedTaskPath)
        .find((op) => op.id === activeOp.id);
      assert.ok(stillRunning, "refresh() must not end an active operation");
      assert.equal(stillRunning.state, "running");
    } finally {
      taskOperations.end(activeOp);
      bridge.restore();
      workspace.restore();
      config.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

void describe("extension.ts refreshTasksView command — source wiring", () => {
  void it("calls inventory.refresh() (a full rescan), not just taskTreeProvider.refresh() (a repaint of stale state)", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
    const marker = '"vs-code-ai-helper.refreshTasksView"';
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex >= 0, "could not locate the refreshTasksView command registration");
    const closingParenIndex = source.indexOf(");", markerIndex);
    assert.ok(closingParenIndex >= 0);
    const registrationBody = source.slice(markerIndex, closingParenIndex);
    const handlerLine = registrationBody
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("() =>"));
    assert.ok(handlerLine, "could not locate the command handler arrow function");
    assert.match(handlerLine, /inventory\.refresh\(\)/);
    assert.doesNotMatch(handlerLine, /taskTreeProvider\.refresh\(\)/);
  });
});
