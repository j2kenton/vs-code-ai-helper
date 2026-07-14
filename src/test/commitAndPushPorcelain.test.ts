/**
 * Unit and integration tests for the `git status --porcelain=v2 -z` parsing
 * used by Commit and Push. Porcelain v2 reports a rename/copy as one atomic
 * record carrying both path endpoints (destination + origPath), unlike v1
 * which reports them as two independent tokens with no structural link. This
 * matters for `getChangedFiles`, which decides task-folder/run-artifact
 * scoping per record: a rename record must be treated as a single unit so it
 * can never be split across that boundary (e.g. only the deletion half
 * staged while the addition half is excluded).
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  getChangedFiles,
  parsePorcelainV2Z,
} from "../commands/commitAndPushTask";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitFixture(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-commit-push-porcelain-")
  );
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  return repoRoot;
}

void describe("parsePorcelainV2Z", () => {
  void it("parses an ordinary modified entry", () => {
    const record = "1 M. N... 100644 100644 100644 aaaa bbbb src/foo.ts";
    const entries = parsePorcelainV2Z(record + "\0");
    assert.deepStrictEqual(entries, [{ status: "M.", path: "src/foo.ts" }]);
  });

  void it("parses a rename record as one atomic entry with both paths", () => {
    const record =
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/bar.ts";
    const raw = record + "\0" + "src/foo.ts" + "\0";
    const entries = parsePorcelainV2Z(raw);
    assert.deepStrictEqual(entries, [
      { status: "R.", path: "src/bar.ts", origPath: "src/foo.ts" },
    ]);
  });

  void it("parses an untracked entry", () => {
    const entries = parsePorcelainV2Z("? src/new.ts\0");
    assert.deepStrictEqual(entries, [{ status: "??", path: "src/new.ts" }]);
  });

  void it("parses an unmerged entry", () => {
    const record =
      "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts";
    const entries = parsePorcelainV2Z(record + "\0");
    assert.deepStrictEqual(entries, [
      { status: "UU", path: "src/conflict.ts" },
    ]);
  });

  void it("parses multiple records back to back, renames interleaved with ordinary entries", () => {
    const raw =
      "1 M. N... 100644 100644 100644 aaaa bbbb src/a.ts\0" +
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/c.ts\0src/b.ts\0" +
      "? src/d.ts\0";
    const entries = parsePorcelainV2Z(raw);
    assert.deepStrictEqual(entries, [
      { status: "M.", path: "src/a.ts" },
      { status: "R.", path: "src/c.ts", origPath: "src/b.ts" },
      { status: "??", path: "src/d.ts" },
    ]);
  });
});

void describe("getChangedFiles rename atomicity", () => {
  void it("stages both endpoints of a rename that stays outside the task folder", async () => {
    const repoRoot = makeGitFixture();
    try {
      fs.mkdirSync(path.join(repoRoot, "src"));
      fs.writeFileSync(path.join(repoRoot, "src", "old.ts"), "export const x = 1;\n");
      git(repoRoot, ["add", "-A"]);
      git(repoRoot, [
        "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
        "commit", "-m", "add old.ts",
      ]);
      fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", "task.md"), "# Task\n");
      fs.renameSync(
        path.join(repoRoot, "src", "old.ts"),
        path.join(repoRoot, "src", "new.ts")
      );

      const { scopedFiles } = await getChangedFiles(
        repoRoot,
        path.join(repoRoot, "plans", "task_1"),
        false
      );
      assert.ok(scopedFiles.includes("src/new.ts"), "destination path staged");
      assert.ok(scopedFiles.includes("src/old.ts"), "origin path staged so the rename isn't split");
      assert.ok(!scopedFiles.some((f) => f.startsWith("plans/task_1/")), "task-folder file excluded by default");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
