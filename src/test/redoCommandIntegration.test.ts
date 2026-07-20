/**
 * Command-level safety coverage for `vs-code-ai-helper.revertStageChanges` /
 * `vs-code-ai-helper.redoStageChanges` (F17 "Redo changes").
 *
 * stageRevertContract.test.ts already covers the redo-availability tokens and
 * the underlying performJournaledRevertSwap/redoSidecar helpers in isolation.
 * What that file does NOT exercise is the registered commands themselves —
 * the refusal branches in viewStageChanges.ts's performStageSwap that guard
 * against a pending recovery journal, a stale sidecar direction, and a
 * fingerprint mismatch between the sidecar and the files it describes. Those
 * branches are the actual safety net a user hits when Revert/Redo Changes is
 * invoked from the tree in an unsafe state, so they are driven here through
 * `vscode.commands.executeCommand` against a real on-disk artifact/backup
 * pair, exactly as the tree would invoke them.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { registerViewStageChangesCommands } from "../commands/viewStageChanges";
import { TaskInventory } from "../state/taskInventory";
import { StageNode } from "../views/taskTreeProvider";
import { previousVersionUri } from "../utils/artifactBackups";
import { revertJournalUri } from "../utils/artifactRevertJournal";
import {
  fingerprintBytes,
  redoSidecarUri,
  RedoSidecarRecord,
  readRedoSidecar,
} from "../utils/redoSidecar";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

// Registered once: commands.registerCommand overwrites by id, so re-running
// this for every test is unnecessary and each test gets its own artifact
// folder anyway (no cross-test state leaks through the handlers themselves).
registerViewStageChangesCommands(
  { subscriptions: [] } as unknown as vscode.ExtensionContext,
  {} as unknown as TaskInventory
);

function makeTaskFolder(prefix: string): { folderPath: string; folderUri: vscode.Uri } {
  const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
}

function fakeNode(folderUri: vscode.Uri, folderName: string): StageNode {
  return {
    stage: "plan",
    task: { folderUri, folderName, canonicalId: folderUri.fsPath },
  } as unknown as StageNode;
}

/** Backs vscode.workspace.fs read/write/delete with the real filesystem for the duration of the callback. */
async function withRealFs<T>(fn: () => Promise<T>): Promise<T> {
  // The base stub does not implement workspace.fs.delete at all (only
  // readFile/writeFile/stat have real implementations), so these captured
  // originals are plain property values to restore, not methods that will be
  // invoked unbound — .bind would throw on the undefined `delete`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { readFile: originalReadFile, writeFile: originalWriteFile, delete: originalDelete } = vscode.workspace.fs;
  vscode.workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
  vscode.workspace.fs.writeFile = (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, content);
    return Promise.resolve();
  };
  vscode.workspace.fs.delete = (uri: vscode.Uri): Promise<void> => {
    try {
      fs.unlinkSync(uri.fsPath);
    } catch {
      // Matches real vscode.workspace.fs.delete: missing target rejects, but
      // every caller in this flow already treats delete as best-effort.
    }
    return Promise.resolve();
  };
  try {
    return await fn();
  } finally {
    vscode.workspace.fs.readFile = originalReadFile;
    vscode.workspace.fs.writeFile = originalWriteFile;
    vscode.workspace.fs.delete = originalDelete;
  }
}

function writeSidecar(artifact: vscode.Uri, record: RedoSidecarRecord): void {
  fs.writeFileSync(redoSidecarUri(artifact).fsPath, JSON.stringify(record));
}

void describe("revertStageChanges / redoStageChanges — registered-command safety paths", () => {
  void it("refuses both revert and redo while a recovery journal is pending, leaving both files untouched", async () => {
    await withRealFs(async () => {
      const { folderUri, folderPath } = makeTaskFolder("ensemble-redo-journal-");
      const artifact = vscode.Uri.file(path.join(folderPath, "plan.md"));
      fs.writeFileSync(artifact.fsPath, "current content");
      fs.writeFileSync(previousVersionUri(artifact).fsPath, "previous content");
      // A leftover recovery journal: some earlier swap for this artifact was
      // interrupted and has not yet been finalized by activation recovery.
      fs.writeFileSync(revertJournalUri(artifact).fsPath, JSON.stringify({ version: 1 }));

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const node = fakeNode(folderUri, "task_1");
      try {
        await vscode.commands.executeCommand("vs-code-ai-helper.revertStageChanges", node);
        assert.ok(
          surface.entries.some((e) => /interrupted revert\/redo/.test(e.message)),
          `expected pending-journal warning for revert; got: ${JSON.stringify(surface.entries)}`
        );
        surface.entries.length = 0;

        await vscode.commands.executeCommand("vs-code-ai-helper.redoStageChanges", node);
        assert.ok(
          surface.entries.some((e) => /interrupted revert\/redo/.test(e.message)),
          `expected pending-journal warning for redo; got: ${JSON.stringify(surface.entries)}`
        );

        assert.equal(fs.readFileSync(artifact.fsPath, "utf8"), "current content");
        assert.equal(fs.readFileSync(previousVersionUri(artifact).fsPath, "utf8"), "previous content");
      } finally {
        deactivateNotificationRouter();
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    });
  });

  void it("refuses redo when the sidecar shows no reverted change is available (stale-direction: nothing to redo)", async () => {
    await withRealFs(async () => {
      const { folderUri, folderPath } = makeTaskFolder("ensemble-redo-stale-1-");
      const artifact = vscode.Uri.file(path.join(folderPath, "plan.md"));
      fs.writeFileSync(artifact.fsPath, "current content");
      fs.writeFileSync(previousVersionUri(artifact).fsPath, "previous content");
      // No sidecar at all — the safe default is "applied" (revert available,
      // redo not), so Redo Changes must refuse.

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const node = fakeNode(folderUri, "task_1");
      try {
        await vscode.commands.executeCommand("vs-code-ai-helper.redoStageChanges", node);
        assert.ok(
          surface.entries.some((e) => /No reverted change is available to redo/.test(e.message)),
          `expected no-redo-available info; got: ${JSON.stringify(surface.entries)}`
        );
        assert.equal(fs.readFileSync(artifact.fsPath, "utf8"), "current content");
        assert.equal(fs.readFileSync(previousVersionUri(artifact).fsPath, "utf8"), "previous content");
      } finally {
        deactivateNotificationRouter();
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    });
  });

  void it("refuses revert when the sidecar shows the stage is already reverted (stale-direction: nothing to revert)", async () => {
    await withRealFs(async () => {
      const { folderUri, folderPath } = makeTaskFolder("ensemble-redo-stale-2-");
      const artifact = vscode.Uri.file(path.join(folderPath, "plan.md"));
      const currentBytes = new TextEncoder().encode("current content");
      const backupBytes = new TextEncoder().encode("previous content");
      fs.writeFileSync(artifact.fsPath, currentBytes);
      fs.writeFileSync(previousVersionUri(artifact).fsPath, backupBytes);
      writeSidecar(artifact, {
        version: 1,
        direction: "reverted",
        artifactFingerprint: fingerprintBytes(currentBytes),
        backupFingerprint: fingerprintBytes(backupBytes),
      });

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const node = fakeNode(folderUri, "task_1");
      try {
        await vscode.commands.executeCommand("vs-code-ai-helper.revertStageChanges", node);
        assert.ok(
          surface.entries.some((e) => /already been reverted/.test(e.message)),
          `expected already-reverted info; got: ${JSON.stringify(surface.entries)}`
        );
        assert.equal(fs.readFileSync(artifact.fsPath, "utf8"), "current content");
        assert.equal(fs.readFileSync(previousVersionUri(artifact).fsPath, "utf8"), "previous content");
      } finally {
        deactivateNotificationRouter();
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    });
  });

  void it("refuses to swap and clears the sidecar when its fingerprints no longer match the on-disk files", async () => {
    await withRealFs(async () => {
      const { folderUri, folderPath } = makeTaskFolder("ensemble-redo-fingerprint-");
      const artifact = vscode.Uri.file(path.join(folderPath, "plan.md"));
      fs.writeFileSync(artifact.fsPath, "current content");
      fs.writeFileSync(previousVersionUri(artifact).fsPath, "previous content");
      // Sidecar claims "applied" (revert available) but its fingerprints
      // don't match either file's actual bytes — e.g. an out-of-band edit
      // after the sidecar was last written.
      writeSidecar(artifact, {
        version: 1,
        direction: "applied",
        artifactFingerprint: "stale-artifact-hash",
        backupFingerprint: "stale-backup-hash",
      });

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const originalShowWarningMessage = vscode.window.showWarningMessage;
      vscode.window.showWarningMessage = ((): Promise<string> => Promise.resolve("Revert Changes")) as unknown as typeof vscode.window.showWarningMessage;
      const node = fakeNode(folderUri, "task_1");
      try {
        await vscode.commands.executeCommand("vs-code-ai-helper.revertStageChanges", node);
        assert.ok(
          surface.entries.some((e) => /out of sync with its files/.test(e.message)),
          `expected fingerprint-mismatch warning; got: ${JSON.stringify(surface.entries)}`
        );
        // Refused before any swap: both files retain their original content.
        assert.equal(fs.readFileSync(artifact.fsPath, "utf8"), "current content");
        assert.equal(fs.readFileSync(previousVersionUri(artifact).fsPath, "utf8"), "previous content");
        // The stale sidecar is cleared rather than left to cause the same
        // refusal forever.
        assert.equal(fs.existsSync(redoSidecarUri(artifact).fsPath), false);
      } finally {
        vscode.window.showWarningMessage = originalShowWarningMessage;
        deactivateNotificationRouter();
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    });
  });

  void it("performs a full revert-then-redo round trip through the registered commands, restoring identical bytes", async () => {
    await withRealFs(async () => {
      const { folderUri, folderPath } = makeTaskFolder("ensemble-redo-roundtrip-");
      const artifact = vscode.Uri.file(path.join(folderPath, "plan.md"));
      const originalContent = "current content — generated plan";
      const previousContent = "previous content — earlier plan";
      fs.writeFileSync(artifact.fsPath, originalContent);
      fs.writeFileSync(previousVersionUri(artifact).fsPath, previousContent);

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const originalShowWarningMessage = vscode.window.showWarningMessage;
      vscode.window.showWarningMessage = ((_msg: string, _opts: unknown, label: string): Promise<string> =>
        Promise.resolve(label)) as unknown as typeof vscode.window.showWarningMessage;
      const node = fakeNode(folderUri, "task_1");
      try {
        await vscode.commands.executeCommand("vs-code-ai-helper.revertStageChanges", node);
        assert.equal(fs.readFileSync(artifact.fsPath, "utf8"), previousContent);
        assert.equal(fs.readFileSync(previousVersionUri(artifact).fsPath, "utf8"), originalContent);
        const afterRevert = await readRedoSidecar(artifact, {
          readFile: (uri) => Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath))),
          writeFile: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        });
        assert.equal(afterRevert?.direction, "reverted");

        await vscode.commands.executeCommand("vs-code-ai-helper.redoStageChanges", node);
        assert.equal(fs.readFileSync(artifact.fsPath, "utf8"), originalContent);
        assert.equal(fs.readFileSync(previousVersionUri(artifact).fsPath, "utf8"), previousContent);
        const afterRedo = await readRedoSidecar(artifact, {
          readFile: (uri) => Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath))),
          writeFile: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        });
        assert.equal(afterRedo?.direction, "applied");
      } finally {
        vscode.window.showWarningMessage = originalShowWarningMessage;
        deactivateNotificationRouter();
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    });
  });
});
