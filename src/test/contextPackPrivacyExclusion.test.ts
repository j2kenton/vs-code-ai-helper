/**
 * Privacy-cohort coverage for context-pack candidate exclusion (plan §2.2 /
 * path-consumer row src/utils/contextPack.ts): every tracked
 * implementation-review path is classified with the shared privacy
 * classifier, and Chat-private, workflow-control, transient-provider, and
 * legacy Chat-artifact paths are rejected from provider-bound packs — while
 * ordinary source files keep flowing through unchanged. The basename
 * denylist already covered chat-v1.json; these paths are the ones only the
 * classifier catches.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { generateImplReviewContextPack } from "../utils/contextPack";
import { formatAtomicTempBasename } from "../state/writeAtomic";

/**
 * Built by the owner's exported complete formatter (state/writeAtomic.ts) so
 * this fixture always has the shape production atomic writes actually leave
 * behind — a layout change there flows into this end-to-end proof instead of
 * silently diverging from a hand-copied name.
 */
const ATOMIC_TEMP_BASENAME = formatAtomicTempBasename(
  "task-progress.json",
  "1234_abc_1712000000000_x9y8"
);
const ATOMIC_TEMP_REL_PATH = `.ensemble/task-1/${ATOMIC_TEMP_BASENAME}`;

const WORKSPACE_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-context-pack-privacy-test-")
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

void describe("generateImplReviewContextPack — privacy classification of tracked paths (plan §2.2)", () => {
  void it("rejects tracked workflow-control, legacy Chat, and runtime-storage paths but keeps source files", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(WORKSPACE_ROOT, ".ensemble", "task-1"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    writeFile("src/commands/widget.ts", "export const widget = 1; // WIDGET-SOURCE");
    writeFile(".ensemble/task-1/task-progress.json", "CONTROL-RECORD-CONTENT");
    writeFile(".ensemble/task-1/runs/chat-2.md", "LEGACY-CHAT-TRANSCRIPT-CONTENT");
    writeFile("workflow-runtime-v1/leases/lease.json", "RUNTIME-LEASE-CONTENT");
    writeFile(".ensemble/.ensemble-migration.json", "MIGRATION-JOURNAL-CONTENT");
    writeFile(ATOMIC_TEMP_REL_PATH, "ATOMIC-TEMP-CONTENT");

    const bridge = installRealFsBridge();
    try {
      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(WORKSPACE_ROOT),
        [
          "src/commands/widget.ts",
          ".ensemble/task-1/task-progress.json",
          ".ensemble/task-1/runs/chat-2.md",
          "workflow-runtime-v1/leases/lease.json",
          ".ensemble/.ensemble-migration.json",
          ATOMIC_TEMP_REL_PATH,
        ]
      );

      assert.match(content, /WIDGET-SOURCE/, "ordinary tracked source content must still be embedded");
      assert.match(
        content,
        /5 tracked path\(s\) rejected \(unsafe, denylisted, private\/control, or outside workspace\)/,
        "all five private/control paths must be reported as rejected"
      );
      for (const forbidden of [
        "CONTROL-RECORD-CONTENT",
        "LEGACY-CHAT-TRANSCRIPT-CONTENT",
        "RUNTIME-LEASE-CONTENT",
        "MIGRATION-JOURNAL-CONTENT",
        "ATOMIC-TEMP-CONTENT",
      ]) {
        assert.doesNotMatch(
          content,
          new RegExp(forbidden),
          `private/control file content must never enter the pack (${forbidden})`
        );
      }
      // Rejected paths are listed by name (reviewable), not silently dropped.
      assert.match(content, /task-progress\.json/);
      assert.match(content, /runs\/chat-2\.md/);
      assert.match(content, /workflow-runtime-v1\/leases\/lease\.json/);
      assert.match(content, /\.ensemble-migration\.json/);
      assert.ok(
        content.includes(ATOMIC_TEMP_BASENAME),
        "the rejected atomic-temp path must be listed by its real (owner-formatted) name"
      );
    } finally {
      bridge.restore();
    }
  });
});
