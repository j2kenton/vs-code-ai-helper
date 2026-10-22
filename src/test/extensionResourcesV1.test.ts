/**
 * Post-1.0 fixes, Step 6: a removed extension folder stops the action with the
 * reload message; one missing file keeps today's handling.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { loadTaskTemplate } from "../commands/startNewTask";
import { matchCreationSeedV1 } from "../services/taskCreationSeedHistoryV1";
import {
  EXTENSION_FOLDER_REMOVED_MESSAGE_V1,
  ExtensionFolderRemovedErrorV1,
  readExtensionResourceV1,
} from "../utils/extensionResourcesV1";
import { renderPromptTemplate } from "../utils/promptTemplates";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ext-resources-"));
let restoreFs: (() => void) | undefined;

beforeEach(() => {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origRead = target.readFile;
  const origStat = target.stat;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  restoreFs = (): void => {
    target.readFile = origRead;
    target.stat = origStat;
  };
});

afterEach(() => {
  restoreFs?.();
});

void describe("readExtensionResourceV1", () => {
  void it("throws the typed reload error, with no path, when the extension root is gone", async () => {
    const gone = vscode.Uri.file(path.join(REAL_ROOT, "removed-0.117.1"));
    await assert.rejects(readExtensionResourceV1(gone, ["resources", "prompts", "x.md"]), (error: unknown) => {
      assert.ok(error instanceof ExtensionFolderRemovedErrorV1);
      assert.equal((error as Error).message, EXTENSION_FOLDER_REMOVED_MESSAGE_V1);
      assert.doesNotMatch((error as Error).message, /ENOENT|removed-0\.117\.1/);
      return true;
    });
  });

  void it("rethrows the original error when only one file is missing", async () => {
    const present = path.join(REAL_ROOT, "present");
    fs.mkdirSync(path.join(present, "resources", "prompts"), { recursive: true });
    await assert.rejects(
      readExtensionResourceV1(vscode.Uri.file(present), ["resources", "prompts", "missing.md"]),
      (error: unknown) => !(error instanceof ExtensionFolderRemovedErrorV1) && /ENOENT/.test(String(error))
    );
  });

  void it("does not call the extension folder removed when stat fails for another reason", async () => {
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    target.stat = (): Promise<never> => Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const present = path.join(REAL_ROOT, "stat-denied");
    fs.mkdirSync(path.join(present, "resources", "prompts"), { recursive: true });
    await assert.rejects(
      readExtensionResourceV1(vscode.Uri.file(present), ["resources", "prompts", "missing.md"]),
      (error: unknown) => !(error instanceof ExtensionFolderRemovedErrorV1) && /ENOENT/.test(String(error))
    );
  });
});

void describe("callers of readExtensionResourceV1", () => {
  void it("renderPromptTemplate surfaces the typed error when the root is gone", async () => {
    const gone = vscode.Uri.file(path.join(REAL_ROOT, "gone-render"));
    await assert.rejects(renderPromptTemplate(gone, "run-implementation.md", {}), ExtensionFolderRemovedErrorV1);
  });

  void it("loadTaskTemplate propagates the typed error instead of using the inline template", async () => {
    const gone = vscode.Uri.file(path.join(REAL_ROOT, "gone-template"));
    await assert.rejects(loadTaskTemplate(gone), ExtensionFolderRemovedErrorV1);
  });

  void it("loadTaskTemplate keeps the inline fallback when only the file is missing", async () => {
    const present = path.join(REAL_ROOT, "present-template");
    fs.mkdirSync(present, { recursive: true });
    const text = await loadTaskTemplate(vscode.Uri.file(present));
    assert.match(text, /^# Task/);
  });

  void it("loadTaskTemplate does not hide permission or transient read errors with the inline fallback", async () => {
    const present = path.join(REAL_ROOT, "denied-template");
    fs.mkdirSync(present, { recursive: true });
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    target.readFile = (): Promise<never> => Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await assert.rejects(loadTaskTemplate(vscode.Uri.file(present)), /permission denied/);
  });

  void it("seed matching does not treat permission errors as a missing seed", async () => {
    const present = path.join(REAL_ROOT, "denied-seeds");
    fs.mkdirSync(present, { recursive: true });
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    target.readFile = (): Promise<never> => Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await assert.rejects(matchCreationSeedV1(vscode.Uri.file(present), "# Task"), /permission denied/);
  });

  void it("seed matching propagates the typed error and caches nothing from a removed root", async () => {
    const gone = vscode.Uri.file(path.join(REAL_ROOT, "gone-seeds"));
    await assert.rejects(matchCreationSeedV1(gone, "# Task"), ExtensionFolderRemovedErrorV1);
    // A second call on the same (still missing) root must fail again, not
    // return an empty cached map.
    await assert.rejects(matchCreationSeedV1(gone, "# Task"), ExtensionFolderRemovedErrorV1);
  });
});
