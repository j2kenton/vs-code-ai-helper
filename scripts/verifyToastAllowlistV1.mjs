#!/usr/bin/env node
/**
 * Toast-button lint (task "stage chat as a record of work" item 13 / Part 12
 * step 35e): the chat panel and the decision store (`WorkflowDecisionV1`,
 * `StructuredQuestionV1`) are the surface for anything the workflow needs
 * from the user; the VS Code notification pane is for transient pointers
 * only. A `vscode.window.showInformationMessage`/`showWarningMessage` call
 * that offers more than one actionable item is exactly the pattern item 13
 * found hiding workflow decisions — so this check fails any such call under
 * `src/` unless it is named, with a reason, in `scripts/toastAllowlistV1.json`.
 *
 * A single-button call (a plain acknowledgement, or the "Open in chat"
 * pointer `notifyPendingWorkflowDecision` already uses) never needs listing
 * — the rule is specifically about a toast asking the user to CHOOSE between
 * options, which is a decision and belongs in the chat.
 *
 * This is a text-level scanner, not a full TypeScript parse: it locates each
 * `vscode.window.show(Information|Warning)Message(` call, then walks the
 * argument list tracking bracket depth and string/template state to split it
 * into top-level arguments without a compiler dependency. A message
 * containing an escaped `${` inside a plain string is the one construct this
 * cannot distinguish from a template placeholder; no call site in the
 * codebase does that today (verified by the self-test below), and if one
 * ever does, the argument count would just be a routine finding on the next
 * lint run, not a silent miss.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");
const allowlistPath = path.join(__dirname, "toastAllowlistV1.json");

/** Split a call's argument-list text into top-level (depth-0) argument texts. */
function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let current = "";
  let i = 0;
  let inString = null; // one of '"', "'", "`", or null
  let templateDepth = 0; // nested `${` inside a template literal

  while (i < text.length) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inString) {
      current += ch;
      if (inString === "`" && ch === "$" && text[i + 1] === "{") {
        templateDepth++;
        current += "{";
        i += 2;
        continue;
      }
      if (inString === "`" && templateDepth > 0 && ch === "}") {
        templateDepth--;
      } else if (ch === inString && prev !== "\\") {
        inString = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      i++;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0 && ch === ")") {
        // Closing paren of the call itself.
        if (current.trim().length > 0) args.push(current.trim());
        return { args, endIndex: i };
      }
      depth--;
      current += ch;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  // Unterminated — should not happen on well-formed source.
  if (current.trim().length > 0) args.push(current.trim());
  return { args, endIndex: text.length };
}

const CALL_PATTERN = /vscode\.window\.show(Information|Warning)Message\(/g;

function isCommentContext(lineText) {
  const trimmed = lineText.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "test") continue; // test doubles are not user-facing UI
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function findMultiButtonCalls(filePath) {
  const text = readFileSync(filePath, "utf8");
  const findings = [];
  let match;
  CALL_PATTERN.lastIndex = 0;
  while ((match = CALL_PATTERN.exec(text)) !== null) {
    const callStart = match.index;
    const lineStart = text.lastIndexOf("\n", callStart) + 1;
    const lineEnd = text.indexOf("\n", callStart);
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (isCommentContext(lineText)) continue;

    const argsStart = callStart + match[0].length;
    const { args } = splitTopLevelArgs(text.slice(argsStart));
    if (args.length <= 1) continue; // just the message, no buttons at all

    const secondArgIsOptions = args[1].trim().startsWith("{");
    const buttonCount = args.length - (secondArgIsOptions ? 2 : 1);
    if (buttonCount > 1) {
      findings.push({
        line: lineNumberAt(text, callStart),
        buttonCount,
        method: `show${match[1]}Message`,
      });
    }
  }
  return findings;
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const byKey = new Map();
  for (const entry of raw.entries) {
    if (!entry.file || !entry.line || !entry.reason) {
      throw new Error(`toastAllowlistV1.json entry missing file/line/reason: ${JSON.stringify(entry)}`);
    }
    byKey.set(`${entry.file}:${entry.line}`, entry);
  }
  return { raw, byKey };
}

function main() {
  const { raw, byKey } = loadAllowlist();
  const files = collectTsFiles(srcRoot);
  const violations = [];
  const usedKeys = new Set();

  for (const file of files) {
    const relPath = path.relative(repoRoot, file).split(path.sep).join("/");
    for (const finding of findMultiButtonCalls(file)) {
      const key = `${relPath}:${finding.line}`;
      if (byKey.has(key)) {
        usedKeys.add(key);
        continue;
      }
      violations.push({ ...finding, file: relPath });
    }
  }

  const staleEntries = [...byKey.keys()].filter((k) => !usedKeys.has(k));

  if (violations.length > 0) {
    console.warn(`toastAllowlistV1: ${violations.length} multi-button toast call(s) are not in the allow-list:`);
    for (const v of violations) {
      console.warn(`  ${v.file}:${v.line} — ${v.method}(...) offers ${v.buttonCount} options`);
    }
    console.warn(
      "Each one is either a hidden workflow decision (post it as a WorkflowDecisionV1 / " +
      "StructuredQuestionV1 in the chat instead) or a genuine non-workflow confirmation " +
      "(add it to scripts/toastAllowlistV1.json with a reason)."
    );
  }
  if (staleEntries.length > 0) {
    console.warn(`toastAllowlistV1: ${staleEntries.length} allow-list entr${staleEntries.length === 1 ? "y is" : "ies are"} stale (no longer matches a multi-button call — the site moved, was fixed, or the line drifted):`);
    for (const key of staleEntries) {
      console.warn(`  ${key}`);
    }
  }

  const enforcing = raw.mode === "enforcing";
  if ((violations.length > 0 || staleEntries.length > 0) && enforcing) {
    console.error(`toastAllowlistV1: failing — mode is "enforcing" (see scripts/toastAllowlistV1.json).`);
    process.exit(1);
  }
  if (violations.length > 0 || staleEntries.length > 0) {
    console.warn(`toastAllowlistV1: warn-only mode — not failing the build. Set "mode": "enforcing" in scripts/toastAllowlistV1.json once triage is complete.`);
    process.exit(0);
  }
  console.log(`toastAllowlistV1: no un-triaged multi-button toasts found (${usedKeys.size} allow-listed).`);
  process.exit(0);
}

main();
