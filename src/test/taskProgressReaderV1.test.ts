/**
 * Coverage for the strict V1 task-progress reader (plan §3.10/§3.12): a
 * missing/unreadable file is distinguished from an unsupported/invalid
 * document, and a supported document decodes exactly like
 * `decodeTaskProgressTextV1` would from its raw text.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

const TEST_ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reader-v1-"));

function installRealDiskReadFile(): () => void {
  const orig = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
    uri: vscode.Uri
  ): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return () => {
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = orig;
  };
}

function makeTaskFolder(name: string): vscode.Uri {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return vscode.Uri.file(dir);
}

function writeProgressFile(folderUri: vscode.Uri, text: string): void {
  fs.writeFileSync(path.join(folderUri.fsPath, "task-progress.json"), text, "utf8");
}

void describe("taskProgressReaderV1", () => {
  void it("reports a missing progress file as code: missing, not a decode recovery", async () => {
    const restore = installRealDiskReadFile();
    try {
      const folderUri = makeTaskFolder("no-progress-file");
      const result = await readTaskProgressStrictV1(folderUri);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "missing");
      }
    } finally {
      restore();
    }
  });

  void it("strictly decodes a valid legacy-family document", async () => {
    const restore = installRealDiskReadFile();
    try {
      const folderUri = makeTaskFolder("valid-legacy");
      writeProgressFile(
        folderUri,
        JSON.stringify({
          taskFolder: "valid-legacy",
          currentStage: "plan",
          status: "active",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
        })
      );
      const result = await readTaskProgressStrictV1(folderUri);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.decoded.progress.currentStage, "plan");
        assert.equal(result.decoded.progress.status, "active");
        assert.equal(result.decoded.progress.ensembleProgressVersion, 1);
        assert.equal(result.decoded.family, "workspace-legacy-v0");
      }
    } finally {
      restore();
    }
  });

  void it("strictly decodes a valid V1 document", async () => {
    const restore = installRealDiskReadFile();
    try {
      const folderUri = makeTaskFolder("valid-v1");
      writeProgressFile(
        folderUri,
        JSON.stringify({
          ensembleProgressVersion: 1,
          taskFolder: "valid-v1",
          currentStage: "impl",
          status: "active",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
        })
      );
      const result = await readTaskProgressStrictV1(folderUri);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.decoded.family, "ensemble-v1");
        assert.equal(result.decoded.progress.currentStage, "impl");
      }
    } finally {
      restore();
    }
  });

  void it("fails closed (never coerces) on invalid JSON, distinct from a missing file", async () => {
    const restore = installRealDiskReadFile();
    try {
      const folderUri = makeTaskFolder("invalid-json");
      writeProgressFile(folderUri, "{ not valid json");
      const result = await readTaskProgressStrictV1(folderUri);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "invalidJson");
      }
    } finally {
      restore();
    }
  });

  void it("fails closed on an unknown ensemble* field instead of silently dropping it", async () => {
    const restore = installRealDiskReadFile();
    try {
      const folderUri = makeTaskFolder("unknown-ensemble-field");
      writeProgressFile(
        folderUri,
        JSON.stringify({
          ensembleProgressVersion: 1,
          taskFolder: "unknown-ensemble-field",
          currentStage: "plan",
          status: "active",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
          ensembleSomeFutureField: "unknown",
        })
      );
      const result = await readTaskProgressStrictV1(folderUri);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "unknownEnsembleField");
      }
    } finally {
      restore();
    }
  });

  void it("honors expectedTaskFolder and fails closed on a mismatch", async () => {
    const restore = installRealDiskReadFile();
    try {
      const folderUri = makeTaskFolder("folder-name-mismatch");
      writeProgressFile(
        folderUri,
        JSON.stringify({
          taskFolder: "a-different-name",
          currentStage: "plan",
          status: "active",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
        })
      );
      const result = await readTaskProgressStrictV1(folderUri, {
        expectedTaskFolder: "folder-name-mismatch",
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "taskFolderMismatch");
      }
    } finally {
      restore();
    }
  });
});
