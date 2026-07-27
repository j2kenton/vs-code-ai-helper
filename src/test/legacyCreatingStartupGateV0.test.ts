/**
 * Coverage for LegacyCreatingStartupGateV0: the read-only replacement for the
 * old implicit `creating` -> `paused` promotion, and the activation-order
 * barrier that stops creation/recovery command bodies from racing it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { LegacyCreatingStartupGateV0 } from "../state/legacyCreatingStartupGateV0";

function installRealFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = {
    readFile: target.readFile,
    readDirectory: target.readDirectory,
    stat: target.stat,
    writeFile: target.writeFile,
  };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  };
  target.stat = async (uri: vscode.Uri): Promise<vscode.FileStat> => {
    const s = await fs.promises.stat(uri.fsPath);
    return {
      type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  };
  target.writeFile = (): Promise<void> => {
    throw new Error("LegacyCreatingStartupGateV0 must never write");
  };
  return {
    restore: (): void => {
      target.readFile = originals.readFile;
      target.readDirectory = originals.readDirectory;
      target.stat = originals.stat;
      target.writeFile = originals.writeFile;
    },
  };
}

function writeProgress(taskFolderPath: string, status: string): void {
  fs.mkdirSync(taskFolderPath, { recursive: true });
  fs.writeFileSync(
    path.join(taskFolderPath, "task-progress.json"),
    JSON.stringify({
      taskFolder: path.basename(taskFolderPath),
      currentStage: "desc",
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
}

void describe("LegacyCreatingStartupGateV0", () => {
  void it("classifies a creating folder with task.md, and ignores active/paused/completed folders", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-gate-classify-"));
    const fsBridge = installRealFsBridge();
    LegacyCreatingStartupGateV0.resetForTests();
    try {
      writeProgress(path.join(root, "2026-01-01_task_1"), "creating");
      fs.writeFileSync(path.join(root, "2026-01-01_task_1", "task.md"), "# Task");
      writeProgress(path.join(root, "2026-01-01_task_2"), "creating");
      // task_2 has no task.md — an even earlier interruption.
      writeProgress(path.join(root, "2026-01-01_task_3"), "active");
      writeProgress(path.join(root, "2026-01-01_task_4"), "completed");

      const footprints = await LegacyCreatingStartupGateV0.getFootprints(root);
      const byName = new Map(footprints.map((f) => [f.taskFolderName, f]));

      assert.equal(footprints.length, 2, "only the two creating folders should be classified");
      assert.equal(byName.get("2026-01-01_task_1")?.hasTaskMd, true);
      assert.equal(byName.get("2026-01-01_task_2")?.hasTaskMd, false);
      assert.ok(!byName.has("2026-01-01_task_3"));
      assert.ok(!byName.has("2026-01-01_task_4"));
    } finally {
      fsBridge.restore();
      LegacyCreatingStartupGateV0.resetForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("returns no footprints for a root that does not exist yet, without throwing", async () => {
    const root = path.join(os.tmpdir(), "ensemble-gate-missing-" + Math.random().toString(36).slice(2));
    const fsBridge = installRealFsBridge();
    LegacyCreatingStartupGateV0.resetForTests();
    try {
      const footprints = await LegacyCreatingStartupGateV0.getFootprints(root);
      assert.deepEqual(footprints, []);
    } finally {
      fsBridge.restore();
      LegacyCreatingStartupGateV0.resetForTests();
    }
  });

  void it("blocks a command body's read until the activation-time classification pass completes", async () => {
    LegacyCreatingStartupGateV0.resetForTests();
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalReadDirectory = target.readDirectory;

    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let scanStarted = false;
    target.readDirectory = async (): Promise<Array<[string, vscode.FileType]>> => {
      scanStarted = true;
      await scanGate;
      return [];
    };

    try {
      const barrier = LegacyCreatingStartupGateV0.beginClassification(["/fake/meta/root"]);
      assert.ok(scanStarted, "beginClassification should start the scan synchronously-ish (microtask)");

      let raced = false;
      const commandRead = LegacyCreatingStartupGateV0.waitUntilReady().then(() => {
        raced = true;
      });

      // Give the event loop a few turns; without the barrier this would
      // already have resolved even though the underlying scan is still
      // blocked on scanGate.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(raced, false, "the command body must not observe readiness before classification finishes");

      releaseScan?.();
      await barrier;
      await commandRead;
      assert.equal(raced, true, "the command body must unblock once classification publishes its snapshot");
    } finally {
      target.readDirectory = originalReadDirectory;
      LegacyCreatingStartupGateV0.resetForTests();
    }
  });

  void it("getFootprints re-scans on every call instead of serving a permanently stale cache", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-gate-rescan-"));
    const fsBridge = installRealFsBridge();
    LegacyCreatingStartupGateV0.resetForTests();
    try {
      // Nothing stuck yet — activation-time scan (or an on-demand scan) sees no footprints.
      const before = await LegacyCreatingStartupGateV0.getFootprints(root);
      assert.equal(before.length, 0);

      // A creation gets interrupted later in the same window's lifetime.
      writeProgress(path.join(root, "2026-02-02_task_1"), "creating");

      const after = await LegacyCreatingStartupGateV0.getFootprints(root);
      assert.equal(after.length, 1, "a later call must see a folder that became stuck after the first scan");
    } finally {
      fsBridge.restore();
      LegacyCreatingStartupGateV0.resetForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
