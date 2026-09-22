"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
  const tests = discoverUnitTests().map((file) => path.relative(root, file));
  const result = spawnSync(
    process.execPath,
    ["--require", "./test-stubs/register.js", "--test", ...tests],
    { stdio: "inherit", cwd: root }
  );
  process.exit(result.status ?? 1);
}

module.exports = { discoverUnitTests };
