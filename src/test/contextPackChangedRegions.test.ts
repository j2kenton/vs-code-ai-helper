/**
 * Integration coverage for the git-diff-derived changed-region excerpt path
 * (workflow findings round 8, item 1, fixes 1/2/5): a large tracked file with
 * a real git baseline must show a real excerpt of its actually-changed
 * regions in the implementation-review context pack — never the old flat
 * head-slice, and never the no-baseline paging stanza when a baseline was in
 * fact available.
 *
 * Uses a real temporary git repo (same pattern as
 * reviewReconciliationStaleness.test.ts) since computeChangedLineRangesForFileV1
 * shells out to git rather than exposing a mockable seam.
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

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
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

const REPO_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-context-pack-changed-regions-test-")
);
git(REPO_ROOT, ["init"]);
git(REPO_ROOT, ["config", "user.email", "test@example.com"]);
git(REPO_ROOT, ["config", "user.name", "Test"]);

after(() => {
  nodeFs.rmSync(REPO_ROOT, { recursive: true, force: true });
});

void describe("generateImplReviewContextPack — git-diff-derived changed-region excerpts (workflow round 8, item 1)", () => {
  void it("shows a real changed-region excerpt (uncommitted diff vs HEAD) for a large file, never a head-slice", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-uncommitted"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const original = makeLargeFileContent(999, "  const identifier999 = someExpression(argumentOne, argumentTwo); // filler");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big.ts"), original, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "initial big.ts"]);

    // Uncommitted change at line 1000 (index 999) — the working tree now
    // differs from HEAD, so the primary "git diff HEAD" path applies.
    const changed = makeLargeFileContent(999, "  const CHANGED_MARKER = totallyDifferentExpression();");
    assert.ok(Buffer.byteLength(changed, "utf8") > IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS, "fixture must exceed the inline-whole cap");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big.ts"), changed, "utf8");

    const bridge = installRealFsBridge();
    try {
      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        ["big.ts"]
      );

      assert.match(content, /### big\.ts \(changed-region excerpt\)/, "must label the section as a real changed-region excerpt");
      assert.match(content, /CHANGED_MARKER/, "the excerpt must contain the actual changed line's real text");
      assert.doesNotMatch(
        content,
        /identifier0\b/,
        "the excerpt must not include unrelated content from the start of the file (no head-slice)"
      );
    } finally {
      bridge.restore();
    }
  });

  void it("falls back to diffing the last commit vs its parent when the change is already committed", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-committed"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const original = makeLargeFileContent(1999, "  const identifier1999 = someExpression(argumentOne, argumentTwo); // filler");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big2.ts"), original, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "initial big2.ts"]);

    const changed = makeLargeFileContent(1999, "  const COMMITTED_CHANGE_MARKER = anotherExpression();");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big2.ts"), changed, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "change big2.ts"]);
    // Working tree now matches HEAD exactly — "git diff HEAD" is empty, so
    // this exercises the last-commit-vs-parent fallback path.

    const bridge = installRealFsBridge();
    try {
      const { content } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        ["big2.ts"]
      );

      assert.match(content, /### big2\.ts \(changed-region excerpt\)/, "must still find a baseline once committed");
      assert.match(content, /COMMITTED_CHANGE_MARKER/, "the excerpt must contain the actually-changed line");
    } finally {
      bridge.restore();
    }
  });

  void it("with a baselineSha, surfaces changes from ALL commits since the baseline, not just the latest one", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-multi-round"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const original = makeLargeFileContent(500, "  const identifier500 = someExpression(argumentOne, argumentTwo); // filler");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big3.ts"), original, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "initial big3.ts"]);
    const baselineSha = cp
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, windowsHide: true })
      .toString()
      .trim();

    // Round 1 (already reviewed against `baselineSha`): changes line 500.
    const afterFirstRound = makeLargeFileContent(500, "  const FIRST_ROUND_MARKER = firstExpression();");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big3.ts"), afterFirstRound, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "round 1: change line 500"]);

    // Round 2 (the newest commit): changes a DIFFERENT line, 3000.
    const afterSecondRoundLines = afterFirstRound.split("\n");
    afterSecondRoundLines[3000] = "  const SECOND_ROUND_MARKER = secondExpression();";
    const afterSecondRound = afterSecondRoundLines.join("\n");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "big3.ts"), afterSecondRound, "utf8");
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "round 2: change line 3000"]);
    // Working tree now matches HEAD exactly, and TWO commits sit between
    // `baselineSha` and HEAD, each touching a different line of the same file.

    const bridge = installRealFsBridge();
    try {
      // Without a baseline, the legacy last-commit-vs-parent proxy can only
      // ever see the single most recent commit's hunk — round 1's change is
      // silently dropped even though it was never actually reviewed either.
      const { content: withoutBaseline } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        ["big3.ts"]
      );
      assert.match(withoutBaseline, /SECOND_ROUND_MARKER/, "sanity: the no-baseline proxy still finds the latest commit's change");
      assert.doesNotMatch(
        withoutBaseline,
        /FIRST_ROUND_MARKER/,
        "sanity: the no-baseline last-commit-vs-parent proxy misses an earlier round's change to the same file — this is the gap baselineSha fixes"
      );

      // With the task/review baseline supplied, both rounds' changes must
      // be visible — this is the fix for the multi-round-commit gap.
      const { content: withBaseline } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        ["big3.ts"],
        undefined,
        baselineSha
      );
      assert.match(withBaseline, /### big3\.ts \(changed-region excerpt\)/, "must be a real changed-region excerpt, not a stanza");
      assert.match(withBaseline, /FIRST_ROUND_MARKER/, "must surface round 1's change, which predates the latest commit");
      assert.match(withBaseline, /SECOND_ROUND_MARKER/, "must still surface round 2's change");
    } finally {
      bridge.restore();
    }
  });

  void it("falls back to the no-baseline paging stanza for a large brand-new untracked file", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-untracked"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });

    const content = makeLargeFileContent(0, "  const identifier0 = someExpression(argumentOne, argumentTwo); // filler");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "brandNew.ts"), content, "utf8");
    // Deliberately never added/committed — no git history to diff against.

    const bridge = installRealFsBridge();
    try {
      const { content: packContent } = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        ["brandNew.ts"]
      );

      assert.match(
        packContent,
        /### brandNew\.ts \(too large to embed — read natively\)/,
        "no baseline exists for an untracked file — must use the no-baseline stanza, not the changed-regions label"
      );
      assert.doesNotMatch(packContent, /changed regions?/i, "must never claim diff-derived changed regions with no baseline");
    } finally {
      bridge.restore();
    }
  });
});
