"use strict";

/**
 * Detects files a unit-test run leaves behind in the repository.
 *
 * Why this exists (post-1.0 fixes, item 11): tests that use a Windows-style
 * absolute path as a fixture (`c:/tmp/...`, `C:/tasks/...`) get a RELATIVE
 * path on Linux and macOS, so anything written under it lands in the current
 * directory, i.e. the repository root. The folders `c:` and `C:` were then
 * staged for commit alongside real work.
 *
 * The check is a before-and-after walk of the working tree with `fs`. It does
 * not use a `git` subprocess: the sandbox the suite (and the fix rounds) run
 * in can refuse `spawnSync git`.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Directory names that are never walked, wherever they appear. `out/` is the
 * build output the run is allowed to write; dependencies and git internals
 * are never test fixture targets. All other repository directories,
 * including `.ensemble`, `.scratch`, and `dist`, are included in the snapshot
 * so any leaked test fixtures outside `out/` are detected.
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "out",
]);

/**
 * Relative paths (POSIX separators) of every file and directory under `root`,
 * excluding the ignored directories. Symlinks are recorded, never followed.
 *
 * @param {string} root
 * @param {ReadonlySet<string>} [ignoredDirectoryNames]
 * @returns {Set<string>}
 */
function snapshotRepoPaths(root, ignoredDirectoryNames = IGNORED_DIRECTORY_NAMES) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {string} absolutePath */
  const isLiveAdmissionMarker = (absolutePath) => {
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    } catch {
      return false;
    }
    if (!marker || !Number.isInteger(marker.pid) || marker.pid <= 0) {
      return false;
    }
    try {
      process.kill(marker.pid, 0);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  };
  /** @param {string} relative */
  const walk = (relative) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (ignoredDirectoryNames.has(entry.name)) {
          continue;
        }
        found.add(`${entryRelative}/`);
        walk(entryRelative);
      } else {
        if (
          /^\.ensemble\/[^/]+\/admission-v1\/admission\.[^/]+$/.test(entryRelative) &&
          isLiveAdmissionMarker(path.join(root, entryRelative))
        ) {
          continue;
        }
        found.add(entryRelative);
      }
    }
  };
  walk("");
  return found;
}

/**
 * Paths present in `after` but not in `before`, sorted.
 *
 * @param {ReadonlySet<string>} before
 * @param {ReadonlySet<string>} after
 * @returns {string[]}
 */
function diffLeakedPaths(before, after) {
  return [...after].filter((entry) => !before.has(entry)).sort((a, b) => a.localeCompare(b));
}

/**
 * Human-readable report naming every leaked path, or `undefined` when clean.
 * Directories are shown only when they hold no leaked file of their own, so a
 * leaked `c:/tmp/x.md` is not also reported as `c:/` and `c:/tmp/`.
 *
 * @param {readonly string[]} leaked
 * @returns {string | undefined}
 */
function formatLeakReport(leaked) {
  if (leaked.length === 0) {
    return undefined;
  }
  const files = leaked.filter((entry) => !entry.endsWith("/"));
  const emptyOrOnlyDirectories = leaked.filter(
    (entry) => entry.endsWith("/") && !leaked.some((other) => other !== entry && other.startsWith(entry))
  );
  const named = [...files, ...emptyOrOnlyDirectories].sort((a, b) => a.localeCompare(b));
  return [
    `The unit-test run left ${named.length} new path(s) in the repository outside out/:`,
    ...named.map((entry) => `  - ${entry}`),
    "A test wrote under a relative fixture path (for example a Windows-style \"c:/...\" literal, which is",
    "relative on Linux and macOS). Point that test at a folder under os.tmpdir() instead.",
  ].join("\n");
}

/**
 * Runs `run()` between two snapshots of `root`.
 *
 * @template T
 * @param {string} root
 * @param {() => T} run
 * @param {ReadonlySet<string>} [ignoredDirectoryNames]
 * @returns {{ result: T, leaked: string[], report: string | undefined }}
 */
function runWithLeakCheck(root, run, ignoredDirectoryNames = IGNORED_DIRECTORY_NAMES) {
  const before = snapshotRepoPaths(root, ignoredDirectoryNames);
  const result = run();
  const after = snapshotRepoPaths(root, ignoredDirectoryNames);
  const leaked = diffLeakedPaths(before, after);
  return { result, leaked, report: formatLeakReport(leaked) };
}

/**
 * The child suite's exit status, unchanged, unless it passed (0) while leaking
 * files, which is a failure (1). A child that could not start (`null`) is 1.
 *
 * @param {number | null} childStatus
 * @param {string | undefined} report
 * @returns {number}
 */
function exitStatusWithLeak(childStatus, report) {
  if (childStatus === null || childStatus === undefined) {
    return 1;
  }
  return childStatus === 0 && report ? 1 : childStatus;
}

module.exports = {
  exitStatusWithLeak,
  IGNORED_DIRECTORY_NAMES,
  snapshotRepoPaths,
  diffLeakedPaths,
  formatLeakReport,
  runWithLeakCheck,
};
