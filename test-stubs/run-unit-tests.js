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

// How many test files run at once. Node's default is one less than the CPU
// count, which on a 2-core machine (the cloud devbox) means one file at a
// time. Measured there on 2026-11-04, a 76-file sample took 69 s with one
// worker and 43 s with two, with the same 2,036 tests passing. Each file runs
// in its own process either way, so files still don't share state.
// ENSEMBLE_TEST_CONCURRENCY overrides it (for example 1, to debug a test
// that only fails when run alongside others).
function testConcurrency() {
  const override = Number.parseInt(process.env.ENSEMBLE_TEST_CONCURRENCY ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  const os = require("node:os");
  return Math.max(1, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length);
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
      ["--require", "./test-stubs/register.js", `--test-concurrency=${testConcurrency()}`, "--test", ...tests],
      { stdio: "inherit", cwd: root }
    )
  );
  if (report) {
    console.error(`\n${report}`);
  }
  process.exit(exitStatusWithLeak(result.status, report));
}

module.exports = { discoverUnitTests };
