/**
 * bugs4 item 23: a path git reports as ignored (a `.scratch/` the repository's
 * .gitignore lists) is never counted as a round edit, so it is never quarantined
 * into `pendingImplReviewFiles`. Proven with a real fixture repository.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";

import { dropGitIgnoredPathsV1 } from "../utils/gitIgnoredPathsV1";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function write(root: string, relative: string, content = "x\n"): void {
  const full = nodePath.join(root, relative);
  nodeFs.mkdirSync(nodePath.dirname(full), { recursive: true });
  nodeFs.writeFileSync(full, content, "utf8");
}

void describe("dropGitIgnoredPathsV1 (bugs4 item 23)", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) nodeFs.rmSync(root, { recursive: true, force: true });
  });

  function fixtureRepo(): string {
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ignored-scratch-"));
    roots.push(root);
    git(root, "init", "-q");
    write(root, ".gitignore", ".scratch/\n");
    write(root, "src/kept.ts");
    write(root, "src/tracked-but-matching.log");
    git(root, "add", "-f", "src/tracked-but-matching.log", ".gitignore", "src/kept.ts");
    return root;
  }

  void it("drops paths under an ignored .scratch/ and keeps real edits", async () => {
    const root = fixtureRepo();
    write(root, ".scratch/portable-1/out.txt");
    write(root, ".scratch/portable-2/deep/run.json");
    const result = await dropGitIgnoredPathsV1(root, [
      ".scratch/portable-1/out.txt",
      "src/kept.ts",
      ".scratch/portable-2/deep/run.json",
      "src/new-file.ts",
    ]);
    assert.deepEqual(result, ["src/kept.ts", "src/new-file.ts"]);
  });

  void it("a tracked file is never dropped, even when an ignore pattern would match it", async () => {
    const root = fixtureRepo();
    write(root, ".gitignore", ".scratch/\n*.log\n");
    const result = await dropGitIgnoredPathsV1(root, ["src/tracked-but-matching.log", "other.log"]);
    assert.deepEqual(result, ["src/tracked-but-matching.log"]);
  });

  void it("nothing ignored leaves the list untouched, and an empty list stays empty", async () => {
    const root = fixtureRepo();
    assert.deepEqual(await dropGitIgnoredPathsV1(root, ["src/a.ts", "src/b.ts"]), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(await dropGitIgnoredPathsV1(root, []), []);
  });

  void it("fails open outside a repository: the list is returned unchanged", async () => {
    const plain = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "not-a-repo-"));
    roots.push(plain);
    const paths = [".scratch/x.txt", "src/a.ts"];
    assert.deepEqual(await dropGitIgnoredPathsV1(plain, paths), paths);
  });
});
