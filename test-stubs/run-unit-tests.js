"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { exitStatusWithLeak, runWithLeakCheck } = require("./repoLeakCheck");

function discoverUnitTests(root = path.join(__dirname, "..", "out", "test")) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? discoverUnitTests(path.join(root, entry.name))
      : entry.isFile() && entry.name.endsWith(".test.js") ? [path.join(root, entry.name)] : [])
    .sort((a, b) => a.localeCompare(b));
}

if (require.main === module) {
  const root = path.join(__dirname, "..");
  // RELATIVE paths, and `cwd` pinned to the repo root so they resolve.
  //
  // Windows caps a command line at 32,767 characters. At 303 test files the
  // absolute form reached 33,662 and `spawnSync` could not start the child at
  // all: `result.status` was null, this exited 1, and NOTHING was printed —
  // which reads exactly like a test failure with no failing test (2026-09-22).
  // The absolute prefix is the whole difference: relative, the same list is
  // 12,452 characters. It bit a git worktree first, because
  // `.claude/worktrees/<name>/` adds ~44 characters to every one of the 303
  // entries, but the main checkout was only a couple of hundred files behind
  // it.
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("-")).map((file) => {
    if (file.endsWith(".ts")) {
      const base = path.basename(file, ".ts") + ".js";
      return path.join(root, "out", "test", base);
    }
    return file;
  });
  const tests = (explicit.length > 0 ? explicit : discoverUnitTests()).map((file) => path.relative(root, file));
  // Post-1.0 fixes, item 11: snapshot the working tree before and after the
  // child suite and name any file it left outside out/. The child's own exit
  // status is kept; a leak turns an otherwise passing run into a failure.
  const { result, report } = runWithLeakCheck(root, () =>
    spawnSync(
      process.execPath,
      ["--require", "./test-stubs/register.js", "--test", ...tests],
      { stdio: "inherit", cwd: root }
    )
  );
  if (report) {
    console.error(`\n${report}`);
  }
  process.exit(exitStatusWithLeak(result.status, report));
}

module.exports = { discoverUnitTests };
