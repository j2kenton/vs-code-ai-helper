/**
 * Privacy-cohort coverage for run-log path classification (plan §2.2 /
 * path-consumer row src/utils/runLog.ts): the exported guard refuses any
 * runs/-relative log name that does not classify artifact-safe (notably the
 * legacy Chat-private `runs/chat-*.md` shape), and writeRunLog still writes
 * ordinary numbered logs through the guard unchanged.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { assertRunLogPathArtifactSafe, writeRunLog } from "../utils/runLog";

void describe("runLog privacy guard (plan §2.2)", () => {
  void it("accepts ordinary numbered run-log names", () => {
    assert.doesNotThrow(() => assertRunLogPathArtifactSafe("001-copilot-lm-impl.md"));
    assert.doesNotThrow(() => assertRunLogPathArtifactSafe("017-claude-cli-plan.md"));
  });

  void it("refuses names that classify as legacy Chat artifacts or control records", () => {
    assert.throws(
      () => assertRunLogPathArtifactSafe("chat-implement.md"),
      /legacyChatPrivateArtifact/
    );
    assert.throws(
      () => assertRunLogPathArtifactSafe("chat-v1.json"),
      /chatPrivate/
    );
    assert.throws(
      () => assertRunLogPathArtifactSafe("task-progress.json"),
      /workflowControl/
    );
  });

  void it("writeRunLog still writes an ordinary numbered log with the guard in place", async () => {
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    const origCreateDirectory = fsObj.createDirectory;
    const origReadDirectory = fsObj.readDirectory;
    const origWriteFile = fsObj.writeFile;
    const written: Array<{ path: string; bytes: Uint8Array }> = [];
    fsObj.createDirectory = (): Promise<void> => Promise.resolve();
    fsObj.readDirectory = (): Promise<Array<[string, number]>> =>
      Promise.resolve([["002-copilot-lm-impl.md", 1]]);
    fsObj.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => {
      written.push({ path: uri.fsPath.replace(/\\/g, "/"), bytes });
      return Promise.resolve();
    };
    try {
      const logUri = await writeRunLog(
        vscode.Uri.file("/ws/.ensemble/task-1"),
        "copilot-lm",
        "impl",
        "log body"
      );
      assert.equal(written.length, 1);
      assert.match(logUri.fsPath.replace(/\\/g, "/"), /runs\/003-copilot-lm-impl\.md$/);
      assert.equal(Buffer.from(written[0]!.bytes).toString("utf8"), "log body");
    } finally {
      fsObj.createDirectory = origCreateDirectory;
      fsObj.readDirectory = origReadDirectory;
      fsObj.writeFile = origWriteFile;
    }
  });
});
