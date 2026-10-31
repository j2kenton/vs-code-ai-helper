/**
 * bugs3 Step 1: an Ensemble-owned git command (`runGitCommand`, shared by Commit
 * & Push and change detection) that fails on a stale index lock reports the
 * lock's age and what to do, not git's own "another git process" text.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { runGitCommand } from "../utils/gitRepoInfo";

void describe("runGitCommand on a stale index lock (bugs3 Step 1)", () => {
  let repo: string;
  let lock: string;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-lock-diagnosis-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    lock = path.join(repo, ".git", "index.lock");
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  void it("names the lock's age and recovery instead of passing git's text through", async () => {
    fs.writeFileSync(lock, "");
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    fs.utimesSync(lock, tenHoursAgo, tenHoursAgo);
    try {
      await assert.rejects(
        () => runGitCommand(repo, "add", ["a.txt"]),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /index lock is present/);
          assert.match(message, /10 hour\(s\) old/);
          assert.ok(message.includes(lock), "the lock path is named");
          assert.doesNotMatch(message, /another git process seems to be running/);
          return true;
        }
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  void it("diagnoses the lock for Commit & Push's own commit as well", async () => {
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    fs.writeFileSync(lock, "");
    try {
      await assert.rejects(
        () => runGitCommand(repo, "commit", ["-m", "x", "--no-gpg-sign"]),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /index lock is present/);
          assert.ok(message.includes(lock), "the lock path is named");
          assert.doesNotMatch(message, /another git process seems to be running/);
          return true;
        }
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  void it("leaves other git failures untouched", async () => {
    await assert.rejects(
      () => runGitCommand(repo, "rev-parse", ["--verify", "no-such-ref"]),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /git rev-parse failed with code/);
        return true;
      }
    );
  });
});
