/**
 * Integration coverage for step 20's deterministic test-mapping: when an
 * implementation-review context pack is built for a tracked source file
 * under src/, its associated test file (src/test/<basename>.test.ts) must
 * be pulled into the pack automatically if it exists on disk, without the
 * test file itself having been recorded in implReviewFiles.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { generateImplReviewContextPack } from "../utils/contextPack";

const WORKSPACE_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-context-pack-mapping-test-")
);
after(() => {
  nodeFs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = nodePath.join(WORKSPACE_ROOT, relPath);
  nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  nodeFs.writeFileSync(abs, content, "utf8");
}

function installRealFsBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fsObj.readFile;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    return nodeFs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  };
  return {
    restore: (): void => {
      fsObj.readFile = origReadFile;
    },
  };
}

void describe("generateImplReviewContextPack — deterministic test mapping (step 20)", () => {
  void it("includes the mapped src/test/<name>.test.ts for a tracked src file, even though it was never itself tracked", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(WORKSPACE_ROOT, ".ensemble", "task-1"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    writeFile("src/commands/widgetAction.ts", "export function widgetAction() { return 1; }");
    writeFile("src/test/widgetAction.test.ts", "// covers widgetAction");

    const bridge = installRealFsBridge();
    try {
      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(WORKSPACE_ROOT),
        ["src/commands/widgetAction.ts"]
      );

      assert.match(
        content,
        /### src\/test\/widgetAction\.test\.ts/,
        "pack must include the deterministically mapped test file's contents section"
      );
      assert.match(
        content,
        /\/\/ covers widgetAction/,
        "pack must include the mapped test file's actual content"
      );
    } finally {
      bridge.restore();
    }
  });

  void it("does not fabricate a section for a mapped test file that does not exist on disk", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(WORKSPACE_ROOT, ".ensemble", "task-2"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    writeFile("src/commands/untested.ts", "export function untested() { return 1; }");
    // Deliberately no src/test/untested.test.ts on disk.

    const bridge = installRealFsBridge();
    try {
      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(WORKSPACE_ROOT),
        ["src/commands/untested.ts"]
      );

      assert.doesNotMatch(
        content,
        /src\/test\/untested\.test\.ts/,
        "pack must not reference a mapped test file that doesn't exist on disk"
      );
    } finally {
      bridge.restore();
    }
  });

  void it("does not duplicate an already-tracked test file", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(WORKSPACE_ROOT, ".ensemble", "task-3"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    writeFile("src/commands/bothTracked.ts", "export function bothTracked() { return 1; }");
    writeFile("src/test/bothTracked.test.ts", "// already tracked directly");

    const bridge = installRealFsBridge();
    try {
      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(WORKSPACE_ROOT),
        ["src/commands/bothTracked.ts", "src/test/bothTracked.test.ts"]
      );

      const occurrences = content.split("### src/test/bothTracked.test.ts").length - 1;
      assert.equal(occurrences, 1, "an explicitly tracked test file must not be duplicated by the mapping step");
    } finally {
      bridge.restore();
    }
  });
});
