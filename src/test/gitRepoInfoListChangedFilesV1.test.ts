/**
 * RC3 item 10 (Step 6): `listChangedFilesSinceShaV1` — changed files since a
 * baseline SHA, filtered to the workspace, for rebuilding a task's Publish
 * review scope when the round ledger cannot establish it. Exercises real
 * git commands against a throwaway repo (no VS Code host needed).
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, after } from "node:test";
import { listChangedFilesSinceShaV1 } from "../utils/gitRepoInfo";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
}

const tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void describe("listChangedFilesSinceShaV1", () => {
  void it("returns files changed (committed and uncommitted) plus untracked, deduplicated", async () => {
    const repoRoot = mkTmp("ensemble-git-changed-");
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "a.ts"), "a\n");
    git(repoRoot, "add", "a.ts");
    git(repoRoot, "commit", "-q", "-m", "baseline");
    const baselineSha = git(repoRoot, "rev-parse", "HEAD").trim();

    // Committed change since baseline.
    fs.writeFileSync(path.join(repoRoot, "a.ts"), "a changed\n");
    git(repoRoot, "add", "a.ts");
    git(repoRoot, "commit", "-q", "-m", "change a");
    // Uncommitted tracked change.
    fs.writeFileSync(path.join(repoRoot, "b.ts"), "b\n");
    git(repoRoot, "add", "b.ts");
    git(repoRoot, "commit", "-q", "-m", "add b");
    fs.writeFileSync(path.join(repoRoot, "b.ts"), "b uncommitted\n");
    // Untracked file.
    fs.writeFileSync(path.join(repoRoot, "c.ts"), "c\n");

    const result = await listChangedFilesSinceShaV1(repoRoot, baselineSha, repoRoot);
    assert.deepEqual(new Set(result.files), new Set(["a.ts", "b.ts", "c.ts"]));
    assert.equal(result.droppedCount, 0);
  });

  void it("returns workspace-relative forward-slash paths for a nested subdirectory", async () => {
    const repoRoot = mkTmp("ensemble-git-nested-");
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "root.ts"), "root\n");
    git(repoRoot, "add", "root.ts");
    git(repoRoot, "commit", "-q", "-m", "baseline");
    const baselineSha = git(repoRoot, "rev-parse", "HEAD").trim();

    const nestedDir = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "src.ts"), "src\n");
    fs.writeFileSync(path.join(repoRoot, "sibling.ts"), "sibling\n");
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-q", "-m", "nested + sibling change");

    const result = await listChangedFilesSinceShaV1(repoRoot, baselineSha, nestedDir);
    assert.deepEqual(result.files, ["src.ts"]);
    // sibling.ts and packages/app/src.ts (relative to root) resolve outside
    // the nested workspace's own root — only sibling.ts should be dropped
    // here since src.ts is inside nestedDir.
    assert.equal(result.droppedCount, 1);
  });

  void it("returns an empty result when nothing changed since the baseline", async () => {
    const repoRoot = mkTmp("ensemble-git-nochange-");
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "a.ts"), "a\n");
    git(repoRoot, "add", "a.ts");
    git(repoRoot, "commit", "-q", "-m", "baseline");
    const baselineSha = git(repoRoot, "rev-parse", "HEAD").trim();

    const result = await listChangedFilesSinceShaV1(repoRoot, baselineSha, repoRoot);
    assert.deepEqual(result.files, []);
    assert.equal(result.droppedCount, 0);
  });
});
