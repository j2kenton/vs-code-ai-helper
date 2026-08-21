/**
 * Coverage for taskImplementationBaselineV1.ts (workflow findings round 8,
 * item 1's remaining architectural blocker): a task's FIRST implementation
 * review has no `<!-- reviewed-commit --> ` marker to anchor changed-region
 * excerpts to, so production must snapshot the commit that was HEAD before
 * the task's first implementation round ran, and a first review must be able
 * to read that snapshot back and use it as its baseline — surfacing every
 * committed round since the task began, not just the latest commit touching
 * each file (the exact gap contextPackChangedRegions.test.ts's "with a
 * baselineSha" case demonstrates when no baseline is supplied at all).
 *
 * Uses a real temporary git repo, with vscode.workspace.fs bridged to real
 * disk (same pattern as taskCreationStartupReconcilerV1.test.ts and
 * contextPackChangedRegions.test.ts) since both the sidecar file and the git
 * diffing shell out to real I/O rather than exposing a mockable seam.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { generateImplReviewContextPack } from "../utils/contextPack";
import { IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS } from "../utils/implReviewFileSelection";
import {
  getTaskImplementationBaselineUri,
  readTaskImplementationBaselineShaV1,
  recordTaskImplementationBaselineShaIfAbsentV1,
} from "../utils/taskImplementationBaselineV1";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function gitOut(cwd: string, args: string[]): string {
  return cp.execFileSync("git", args, { cwd, windowsHide: true }).toString("utf8").trim();
}

function makeLargeFileContent(changedLineIndex: number, changedText: string): string {
  const totalLines = 5000;
  const lines = Array.from(
    { length: totalLines },
    (_, i) => `  const identifier${i} = someExpression(argumentOne, argumentTwo); // filler`
  );
  lines[changedLineIndex] = changedText;
  return lines.join("\n");
}

function installRealFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = { readFile: target.readFile, stat: target.stat, writeFile: target.writeFile };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    nodeFs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.stat = async (uri: vscode.Uri): Promise<vscode.FileStat> => {
    const s = await nodeFs.promises.stat(uri.fsPath);
    return {
      type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  };
  target.writeFile = (uri: vscode.Uri, content: Uint8Array): Promise<void> =>
    nodeFs.promises.writeFile(uri.fsPath, content);
  return {
    restore: (): void => {
      target.readFile = originals.readFile;
      target.stat = originals.stat;
      target.writeFile = originals.writeFile;
    },
  };
}

const REPO_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-task-impl-baseline-test-")
);
git(REPO_ROOT, ["init"]);
git(REPO_ROOT, ["config", "user.email", "test@example.com"]);
git(REPO_ROOT, ["config", "user.name", "Test"]);
nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "seed.txt"), "seed");
git(REPO_ROOT, ["add", "-A"]);
git(REPO_ROOT, ["commit", "-m", "repo seed"]);

after(() => {
  nodeFs.rmSync(REPO_ROOT, { recursive: true, force: true });
});

void describe("taskImplementationBaselineV1 (workflow round 8, item 1's re-review-only baseline gap)", () => {
  void it("records HEAD on first call, and leaves it untouched on every later call", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-idempotent"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const bridge = installRealFsBridge();
    try {
      const beforeRound1Sha = gitOut(REPO_ROOT, ["rev-parse", "HEAD"]);
      await recordTaskImplementationBaselineShaIfAbsentV1(taskFolderUri, REPO_ROOT);
      assert.strictEqual(await readTaskImplementationBaselineShaV1(taskFolderUri), beforeRound1Sha);

      // Round 1 commits, moving HEAD forward.
      nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "task-idempotent-file.txt"), "round 1");
      git(REPO_ROOT, ["add", "-A"]);
      git(REPO_ROOT, ["commit", "-m", "round 1"]);

      // A second round's call must NOT overwrite the already-recorded baseline.
      await recordTaskImplementationBaselineShaIfAbsentV1(taskFolderUri, REPO_ROOT);
      assert.strictEqual(
        await readTaskImplementationBaselineShaV1(taskFolderUri),
        beforeRound1Sha,
        "baseline must stay pinned to the commit before the task's FIRST round, not shift to a later round's HEAD"
      );
    } finally {
      bridge.restore();
    }
  });

  void it("returns undefined when nothing was ever recorded for this task", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-never-recorded"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const bridge = installRealFsBridge();
    try {
      assert.strictEqual(await readTaskImplementationBaselineShaV1(taskFolderUri), undefined);
      assert.strictEqual(
        nodeFs.existsSync(getTaskImplementationBaselineUri(taskFolderUri).fsPath),
        false
      );
    } finally {
      bridge.restore();
    }
  });

  void it("a first review (no previousReview marker) reading the recorded baseline sees every committed round, not just the latest", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-first-review"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const original = makeLargeFileContent(500, "  const identifier500 = someExpression(argumentOne, argumentTwo); // filler");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big4.ts"), original, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "initial big4.ts"]);

    const bridge = installRealFsBridge();
    try {
      // Task's first implementation round starts: production snapshots the
      // baseline before making any edit (executeImplementationRun's call).
      await recordTaskImplementationBaselineShaIfAbsentV1(taskFolderUri, REPO_ROOT);

      // Round 1 changes line 500 and commits.
      const afterRound1 = makeLargeFileContent(500, "  const FIRST_ROUND_MARKER = firstExpression();");
      nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big4.ts"), afterRound1, "utf8");
      git(REPO_ROOT, ["add", "-A"]);
      git(REPO_ROOT, ["commit", "-m", "round 1: change line 500"]);

      // Round 2 changes a DIFFERENT line and commits — this is the newest
      // commit touching the file when the first review finally runs.
      const afterRound2Lines = afterRound1.split("\n");
      afterRound2Lines[3000] = "  const SECOND_ROUND_MARKER = secondExpression();";
      nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big4.ts"), afterRound2Lines.join("\n"), "utf8");
      git(REPO_ROOT, ["add", "-A"]);
      git(REPO_ROOT, ["commit", "-m", "round 2: change line 3000"]);

      assert.ok(
        Buffer.byteLength(afterRound1, "utf8") > IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS,
        "fixture must exceed the inline-whole cap"
      );

      // The FIRST review has no previousReview, so reviewActions.ts falls
      // back to exactly this read — reproduced here directly since this test
      // targets the utility, not the full command wiring.
      const baselineSha = await readTaskImplementationBaselineShaV1(taskFolderUri);
      assert.ok(baselineSha, "a baseline must have been recorded before round 1");

      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        ["big4.ts"],
        undefined,
        baselineSha
      );

      assert.match(content, /### big4\.ts \(changed-region excerpt\)/, "must be a real changed-region excerpt");
      assert.match(content, /FIRST_ROUND_MARKER/, "must surface round 1's change even though it is not the latest commit");
      assert.match(content, /SECOND_ROUND_MARKER/, "must still surface round 2's change");
    } finally {
      bridge.restore();
    }
  });
});
