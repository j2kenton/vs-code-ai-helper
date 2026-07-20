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
  stripSensitiveTaskFiles,
} from "../commands/commitAndPushTask";
import { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME } from "../utils/chatHistoryConstants";
import { safeRemoveDir } from "./testFsUtils";

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
      safeRemoveDir(repoRoot);
    }
  });
});

void describe("getChangedFiles chat-transcript exclusion (Option A staging policy)", () => {
  void it("excludes chat-v1.json from scopedFiles in include-task-folder mode, and classifies it as sensitive", async () => {
    const repoRoot = makeGitFixture();
    try {
      fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", "task.md"), "# Task\n");
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", CHAT_HISTORY_FILENAME), "{}");

      const { scopedFiles, sensitiveFilePaths } = await getChangedFiles(
        repoRoot,
        path.join(repoRoot, "plans", "task_1"),
        true
      );
      assert.ok(scopedFiles.includes("plans/task_1/task.md"), "ordinary task-folder file still staged when included");
      assert.ok(
        !scopedFiles.some((f) => f.endsWith(CHAT_HISTORY_FILENAME)),
        "chat-v1.json must never be staged, even in include-task-folder mode"
      );
      assert.ok(sensitiveFilePaths.includes(`plans/task_1/${CHAT_HISTORY_FILENAME}`));
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("excludes a SIBLING task's chat-v1.json in default mode, not just the current task's", async () => {
    const repoRoot = makeGitFixture();
    try {
      fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "plans", "task_2"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "plans", "task_2", CHAT_HISTORY_FILENAME), "{}");
      fs.writeFileSync(path.join(repoRoot, "plans", "task_2", CHAT_HISTORY_CORRUPT_FILENAME), "{}");

      const { scopedFiles, sensitiveFilePaths } = await getChangedFiles(
        repoRoot,
        path.join(repoRoot, "plans", "task_1"),
        false
      );
      // Default mode stages everything OUTSIDE the current task's own
      // folder — task_2 is a sibling, so without transcript-specific
      // scoping its chat-v1.json would otherwise be swept in as an ordinary
      // "source change".
      assert.ok(
        !scopedFiles.some((f) => f.includes(CHAT_HISTORY_FILENAME)),
        "a sibling task's transcript must never be staged either"
      );
      assert.ok(sensitiveFilePaths.includes(`plans/task_2/${CHAT_HISTORY_FILENAME}`));
      assert.ok(sensitiveFilePaths.includes(`plans/task_2/${CHAT_HISTORY_CORRUPT_FILENAME}`));
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("excludes BOTH endpoints of a chat-v1.json renamed out of the task root to an innocuous path", async () => {
    const repoRoot = makeGitFixture();
    try {
      fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", "task.md"), "# Task\n");
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", CHAT_HISTORY_FILENAME), JSON.stringify({ transcript: "secret" }));
      git(repoRoot, ["add", "-A"]);
      git(repoRoot, [
        "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
        "commit", "-m", "seed transcript",
      ]);

      // `git mv` out of the task root under an innocuous name — the content
      // (and therefore the transcript) survives at the new path. Staged via
      // `git add -A`: `git status` only ever links a deletion+addition pair
      // into a single "2" rename/copy record (the shape getChangedFiles must
      // classify correctly) for a STAGED change — an unstaged filesystem
      // move shows up as two independent, unlinked entries instead. Command
      // callers never reach getChangedFiles with staged changes present (an
      // earlier guard refuses to proceed), but getChangedFiles/
      // stripSensitiveTaskFiles must still classify a "2" record correctly
      // wherever one is presented to them, as the sole enforcement point for
      // the never-stage-transcripts invariant.
      fs.renameSync(
        path.join(repoRoot, "plans", "task_1", CHAT_HISTORY_FILENAME),
        path.join(repoRoot, "src", "archive.json")
      );
      git(repoRoot, ["add", "-A"]);

      const { scopedFiles, sensitiveFilePaths } = await getChangedFiles(
        repoRoot,
        path.join(repoRoot, "plans", "task_1"),
        false
      );
      assert.ok(
        !scopedFiles.includes("src/archive.json"),
        "the rename destination must never be staged — it still carries transcript content"
      );
      assert.ok(
        !scopedFiles.some((f) => f.includes(CHAT_HISTORY_FILENAME)),
        "the rename origin must not be staged either"
      );
      assert.ok(sensitiveFilePaths.includes("src/archive.json"), "the destination must be classified as sensitive");
      assert.ok(sensitiveFilePaths.includes(`plans/task_1/${CHAT_HISTORY_FILENAME}`));
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("excludes both endpoints of a chat-v1.json renamed to an innocuous basename INSIDE the task folder", async () => {
    const repoRoot = makeGitFixture();
    try {
      fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", "task.md"), "# Task\n");
      fs.writeFileSync(path.join(repoRoot, "plans", "task_1", CHAT_HISTORY_FILENAME), JSON.stringify({ transcript: "secret" }));
      git(repoRoot, ["add", "-A"]);
      git(repoRoot, [
        "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
        "commit", "-m", "seed transcript",
      ]);

      fs.renameSync(
        path.join(repoRoot, "plans", "task_1", CHAT_HISTORY_FILENAME),
        path.join(repoRoot, "plans", "task_1", "notes.json")
      );
      git(repoRoot, ["add", "-A"]); // staged, so git links it as a single "2" rename record

      // include-task-folder mode is where a same-folder rename would
      // otherwise be picked up as an ordinary task-folder file.
      const { scopedFiles, sensitiveFilePaths } = await getChangedFiles(
        repoRoot,
        path.join(repoRoot, "plans", "task_1"),
        true
      );
      assert.ok(
        !scopedFiles.includes("plans/task_1/notes.json"),
        "an innocuously-renamed transcript must not be staged even inside the task folder"
      );
      assert.ok(sensitiveFilePaths.includes("plans/task_1/notes.json"));
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("does not exclude an unrelated file outside the task root that happens to share the transcript basename", async () => {
    const repoRoot = makeGitFixture();
    try {
      fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "notes"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "notes", CHAT_HISTORY_FILENAME), "unrelated file with the same basename");

      const { scopedFiles, sensitiveFilePaths } = await getChangedFiles(
        repoRoot,
        path.join(repoRoot, "plans", "task_1"),
        false
      );
      assert.ok(
        scopedFiles.includes(`notes/${CHAT_HISTORY_FILENAME}`),
        "a same-named file outside the task root must be staged normally"
      );
      assert.ok(!sensitiveFilePaths.includes(`notes/${CHAT_HISTORY_FILENAME}`));
    } finally {
      safeRemoveDir(repoRoot);
    }
  });
});

void describe("stripSensitiveTaskFiles (final staging gate)", () => {
  void it("removes only transcript basenames under the task root", () => {
    const repoRoot = path.resolve("repo-root");
    const taskFolderPath = path.join(repoRoot, "plans", "task_1");
    const scopedFiles = [
      "src/foo.ts",
      `plans/task_1/${CHAT_HISTORY_FILENAME}`,
      `plans/task_2/${CHAT_HISTORY_CORRUPT_FILENAME}`,
      "notes/chat-v1.json", // outside the task root — same basename, must survive
    ];
    const result = stripSensitiveTaskFiles(scopedFiles, repoRoot, taskFolderPath);
    assert.deepEqual(result, ["src/foo.ts", "notes/chat-v1.json"]);
  });

  void it("is a no-op for a list with no sensitive files", () => {
    const repoRoot = path.resolve("repo-root");
    const taskFolderPath = path.join(repoRoot, "plans", "task_1");
    const scopedFiles = ["src/foo.ts", "src/bar.ts"];
    assert.deepEqual(stripSensitiveTaskFiles(scopedFiles, repoRoot, taskFolderPath), scopedFiles);
  });
});
