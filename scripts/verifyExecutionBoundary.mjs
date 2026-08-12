#!/usr/bin/env node
/**
 * Static execution-boundary scan (plan Part 11, acceptance criterion 6).
 *
 * All generated code must execute ONLY inside the user's sandbox via the
 * E2B/Daytona provider APIs. This script proves the client-side half of that
 * statically: no file in the mobile app, the shared packages, the engine, or
 * the control plane may import or use a local execution primitive —
 * `child_process` (or `node:child_process`), `exec`/`execFile`/`spawn`/
 * `fork` and their sync variants, `eval`, the `Function` constructor, the
 * `vm` module, or `process.binding` — outside an explicit allowlist of
 * reviewed sandbox adapter files. Any new match anywhere else fails the
 * build (this script exits 1, and CI runs it on every push/PR).
 *
 * SCOPE
 * -----
 * - Production sources only: `apps/mobile` (src + entry files) and every
 *   `packages/<pkg>/src`. Test files are exempt — the engine's own test
 *   suite scans for these patterns and must be able to NAME them, and tests
 *   never ship.
 * - Comments are stripped before scanning, so documentation may explain the
 *   rule without tripping it (hyphenated forms like "child-process" in prose
 *   never match the word-bounded patterns anyway).
 *
 * ALLOWLIST DISCIPLINE
 * --------------------
 * Only reviewed sandbox adapter files may ever be listed, each with a reason
 * recorded here. The current reference adapters
 * (`packages/ensemble-engine/src/sandboxProviderAdaptersV1.ts`) are
 * fetch-based and need NO local execution primitive, so the allowlist is
 * empty — the strongest possible state. If a future SDK-backed adapter
 * genuinely requires one of these primitives, it must be reviewed, listed
 * here with its reason, and it remains the ONLY class of file eligible.
 * A listed file that no longer matches any pattern is a stale entry and
 * fails the scan, so exemptions cannot silently outlive their need.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Production-source roots covered by criterion 6 (app, packages, engine, control plane). */
const SCAN_ROOTS = [
  "apps/mobile/src",
  "apps/mobile/App.tsx",
  "apps/mobile/index.ts",
  "packages/ensemble-contract/src",
  "packages/ensemble-core/src",
  "packages/ensemble-engine/src",
  "packages/ensemble-control-plane/src",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Reviewed sandbox adapter files permitted to use an execution primitive.
 * Repo-relative POSIX paths, each with a recorded reason. Currently empty:
 * the reference E2B/Daytona adapters are fetch-based. See "ALLOWLIST
 * DISCIPLINE" above before adding anything.
 */
const EXECUTION_ALLOWLIST = [
  // { file: "packages/ensemble-engine/src/<reviewed-adapter>.ts", reason: "..." },
];

const FORBIDDEN_PATTERNS = [
  { label: "child_process module reference", pattern: /\bchild_process\b/ },
  { label: "execSync usage", pattern: /\bexecSync\b/ },
  { label: "execFileSync usage", pattern: /\bexecFileSync\b/ },
  { label: "execFile usage", pattern: /\bexecFile\b/ },
  { label: "spawnSync usage", pattern: /\bspawnSync\b/ },
  { label: "spawn() call", pattern: /(?<![.\w])spawn\s*\(/ },
  { label: "fork() call", pattern: /(?<![.\w])fork\s*\(/ },
  // Bare exec( only: `.exec(` is RegExp.prototype.exec, which is fine.
  { label: "exec() call", pattern: /(?<![.\w])exec\s*\(/ },
  { label: "eval reference", pattern: /\beval\b/ },
  { label: "Function constructor", pattern: /(?<![.\w])(?:new\s+)?Function\s*\(/ },
  { label: "vm module reference", pattern: /\bnode:vm\b|(?<![\w.])require\s*\(\s*["']vm["']\s*\)|from\s+["']vm["']/ },
  { label: "process.binding usage", pattern: /\bprocess\s*\.\s*binding\b/ },
];

function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

/** Truncates a line at its first `//` that is not inside a string literal. */
function stripLineComment(line) {
  let inString = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

function walk(target, out = []) {
  const stats = fs.statSync(target);
  if (stats.isFile()) {
    if (SOURCE_EXTENSIONS.has(path.extname(target))) {
      out.push(target);
    }
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function main() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const absolute = path.join(repoRoot, root);
    if (!fs.existsSync(absolute)) {
      throw new Error(`scan root does not exist: ${root} — refusing to treat that as a pass.`);
    }
    walk(absolute, files);
  }
  if (files.length < 20) {
    throw new Error(
      `only ${files.length} source file(s) found across the scan roots — refusing to treat that as a pass.`
    );
  }

  const allowlisted = new Map(EXECUTION_ALLOWLIST.map((entry) => [entry.file, entry]));
  const matchedAllowlistFiles = new Set();
  const violations = [];
  let filesScanned = 0;
  let testFilesExempted = 0;

  for (const file of files) {
    const relFile = toPosix(path.relative(repoRoot, file));
    if (/\.test\.[jt]sx?$/.test(file)) {
      testFilesExempted++;
      continue;
    }
    filesScanned++;

    const source = stripBlockComments(fs.readFileSync(file, "utf8"));
    const lines = source.split(/\r?\n/).map(stripLineComment);

    lines.forEach((line, index) => {
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          if (allowlisted.has(relFile)) {
            matchedAllowlistFiles.add(relFile);
          } else {
            violations.push({ file: relFile, line: index + 1, match: label });
          }
        }
      }
    });
  }

  for (const entry of EXECUTION_ALLOWLIST) {
    if (!matchedAllowlistFiles.has(entry.file)) {
      violations.push({
        file: entry.file,
        line: 0,
        match: "stale allowlist entry (no execution primitive found in this file any more)",
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `Execution boundary OK: ${filesScanned} production source file(s) scanned across app, ` +
        `packages, engine, and control plane (${testFilesExempted} test file(s) exempted); ` +
        `no execution primitive outside the ${EXECUTION_ALLOWLIST.length} allowlisted sandbox adapter file(s).`
    );
    return;
  }

  console.error("\nEXECUTION BOUNDARY SCAN FAILED\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.match}`);
  }
  console.error(
    "\nGenerated code must execute only inside the user's sandbox via the E2B/Daytona provider " +
      "APIs (plan criterion 6). Route execution through the SandboxClientV1 surface instead; if " +
      "this is a NEW reviewed sandbox adapter that genuinely needs a local primitive, add it to " +
      "EXECUTION_ALLOWLIST in this script with its reason.\n"
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`\nEXECUTION BOUNDARY SCAN ERRORED\n\n${error.message}\n`);
  process.exit(1);
}
