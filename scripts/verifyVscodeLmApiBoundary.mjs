#!/usr/bin/env node
/**
 * Static verifier for plan §1.6 ("Establish the VS Code Language Model
 * boundary"): fails if any production source file outside the compatibility
 * boundary (`src/services/vscodeLmCompat.ts`, `src/types/vscodeLmCompatV1.ts`)
 * references the post-1.93 Language Model tool-calling surface directly.
 *
 * WHY THIS EXISTS
 * ---------------
 * `package.json` declares VS Code `^1.93.0` as the compatibility baseline,
 * but the tool-calling constructors (`LanguageModelTextPart`,
 * `LanguageModelToolCallPart`, `LanguageModelToolResultPart`), the
 * `LanguageModelChatRequestOptions` request-options type, and the
 * `response.stream` shape were not part of the earlier, simpler `vscode.lm`
 * surface every other runner uses (`selectChatModels`, `LanguageModelChat`,
 * `sendRequest`, `response.text`). Pinning `@types/vscode` to 1.93.0 (plan
 * §1.6 step 6) is only safe once nothing outside the one boundary module
 * names these symbols in executable code — this script is that
 * zero-reference proof (step 5), re-run any time a new caller is added.
 *
 * This proves only that the reference is isolated in source; it does not
 * (and cannot, without a real 1.93.0 host) prove runtime behavior — see
 * `workflow-inventories/lm-host-capability-v1.json` and the host-matrix
 * tests plan §1.6 still requires, which this environment cannot produce.
 *
 * SCOPE
 * -----
 * - Test files (`*.test.ts`) are exempt: they intentionally construct/inspect
 *   real instances (via the `test-stubs/vscode` stub) to exercise the
 *   boundary itself, and are counted separately rather than failed on.
 * - Comments (line and block) are stripped before scanning, so documentation
 *   that names these symbols for explanatory purposes does not trip this
 *   check.
 * - A small, explicit, line-pinned allow-list covers the few remaining
 *   type-position casts at the exact hand-off points into the real
 *   `vscode.LanguageModelChatMessage.Assistant`/`.User` API, which itself is
 *   part of the earlier, simpler surface every runner already depends on.
 *   Each entry is pinned to an exact line so a future edit that moves the
 *   reference re-trips this check instead of silently staying "allowed".
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SRC_DIR = path.join(repoRoot, "src");

/** The one module allowed to reference these symbols freely, as itself. */
const BOUNDARY_FILES = new Set([
  path.join(SRC_DIR, "services", "vscodeLmCompat.ts"),
  path.join(SRC_DIR, "types", "vscodeLmCompatV1.ts"),
]);

const FORBIDDEN_SYMBOLS = [
  "LanguageModelTextPart",
  "LanguageModelToolCallPart",
  "LanguageModelToolResultPart",
  "LanguageModelChatRequestOptions",
];

const FORBIDDEN_PATTERNS = [
  { label: "response.stream property access", pattern: /\bresponse\s*\.\s*stream\b/ },
];

/**
 * Exact, line-pinned exceptions: unavoidable casts at a boundary hand-off
 * point outside vscodeLmCompat.ts. Pinned to an exact line so a future
 * refactor that moves or multiplies a reference re-trips the check rather
 * than silently staying exempt. Currently empty: the parts-array message
 * hand-offs moved into vscodeLmCompat.ts (createLmAssistantMessageWithPartsV1 /
 * createLmUserMessageWithPartsV1), so no production file outside the boundary
 * names a post-1.93 Language Model member.
 */
const ALLOWED_INLINE_REFERENCES = [];

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

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(relFile, lineNumber, symbol) {
  return ALLOWED_INLINE_REFERENCES.some(
    (entry) =>
      entry.file === relFile && entry.line === lineNumber && entry.symbols.includes(symbol)
  );
}

function main() {
  const files = walk(SRC_DIR);
  if (files.length === 0) {
    throw new Error("Found zero .ts files under src/ — refusing to treat that as a pass.");
  }

  const violations = [];
  let staleAllowListEntries = new Set(
    ALLOWED_INLINE_REFERENCES.map((e) => `${e.file}:${e.line}`)
  );
  let productionFilesScanned = 0;
  let testFilesScanned = 0;

  for (const file of files) {
    const relFile = path.relative(repoRoot, file);
    const isTestFile = /\.test\.ts$/.test(file);

    if (isTestFile) {
      testFilesScanned++;
      continue;
    }
    productionFilesScanned++;

    if (BOUNDARY_FILES.has(file)) {
      continue;
    }

    const rawSource = fs.readFileSync(file, "utf8");
    const source = stripBlockComments(rawSource);
    const lines = source.split(/\r?\n/).map(stripLineComment);

    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      for (const symbol of FORBIDDEN_SYMBOLS) {
        const re = new RegExp(`\\b${symbol}\\b`);
        if (re.test(line)) {
          if (isAllowed(relFile, lineNumber, symbol)) {
            staleAllowListEntries.delete(`${relFile}:${lineNumber}`);
            continue;
          }
          violations.push({ file: relFile, line: lineNumber, match: symbol });
        }
      }
      for (const { label, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ file: relFile, line: lineNumber, match: label });
        }
      }
    });
  }

  if (staleAllowListEntries.size > 0) {
    violations.push(
      ...[...staleAllowListEntries].map((key) => ({
        file: key.split(":")[0],
        line: key.split(":")[1],
        match: "stale allow-list entry (reference no longer found at this exact line)",
      }))
    );
  }

  if (violations.length === 0) {
    console.log(
      `VS Code LM API boundary OK: ${productionFilesScanned} production source file(s) scanned ` +
        `(${testFilesScanned} test file(s) exempted), no unlisted post-1.93 tool-calling ` +
        "reference outside src/services/vscodeLmCompat.ts / src/types/vscodeLmCompatV1.ts."
    );
    return;
  }

  console.error("\nVS CODE LM API BOUNDARY CHECK FAILED\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.match}`);
  }
  console.error(
    "\nRoute this reference through vscodeLmCompat.ts's guarded adapters instead (plan §1.6), " +
      "or update ALLOWED_INLINE_REFERENCES in this script with an exact line and reason if it " +
      "is a new, deliberate hand-off point.\n"
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`\nVS CODE LM API BOUNDARY CHECK ERRORED\n\n${error.message}\n`);
  process.exit(1);
}
