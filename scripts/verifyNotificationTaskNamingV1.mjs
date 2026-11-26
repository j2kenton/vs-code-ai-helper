#!/usr/bin/env node
/**
 * Notification task-naming scan (1.0 plan, Part 14 / item 11: "every
 * notification names its task").
 *
 * Every non-test `NotificationRouter.show(Information|Warning|Error)(` and
 * `vscode.window.show(Information|Warning|Error)Message(` call under `src/`
 * falls into exactly one group:
 *
 *   1. attributed   — the call sits lexically inside the callback of
 *                     `runTrackedOperation(` or `runWithNotificationTaskContextV1(`,
 *                     so the router prefixes the task's name at runtime
 *                     (`attributeNotificationMessageV1`).
 *   2. self-named   — the call's own arguments interpolate a task name
 *                     (`displayName`, `taskName`, `taskLabel`, `folderName`,
 *                     `formatTaskNameForDisplay(...)`, ...).
 *   3. global       — listed in `scripts/notificationTaskNamingAllowlistV1.json`
 *                     with a reason (fires before a task is resolved, or is not
 *                     about one task). Entries are keyed by file plus a
 *                     whitespace-collapsed snippet of the call's own text, never
 *                     a line number, so an unrelated edit does not trip them.
 *   4. un-named     — everything else: a task-specific notification that would
 *                     reach the user without saying which task it is about.
 *
 * The check fails while group 4 is non-empty, or when an allowlist entry no
 * longer matches any call (stale). Like `verifyToastAllowlistV1.mjs` it is a
 * text-level scanner, not a TypeScript parse.
 *
 * Usage:
 *   node scripts/verifyNotificationTaskNamingV1.mjs            # verify (exit 1 on findings)
 *   node scripts/verifyNotificationTaskNamingV1.mjs --report   # also list every un-named site
 *   node scripts/verifyNotificationTaskNamingV1.mjs --json     # machine-readable counts + sites
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");
const allowlistPath = path.join(__dirname, "notificationTaskNamingAllowlistV1.json");

/** Calls whose callback establishes a live notification task context. */
const ATTRIBUTING_CALLS = new Set(["runTrackedOperation", "runWithNotificationTaskContextV1"]);

/**
 * Every call that creates a Notifications entry: the router's show* methods, its
 * progress-summary emitter, and the raw VS Code message APIs.
 */
const NOTIFICATION_CALL_TAIL =
  /(?:NotificationRouter\.(?:show(?:Information|Warning|Error)|emitProgressSummary)|vscode\.window\.show(?:Information|Warning|Error)Message)\($/;

/**
 * Identifiers that, inside the call's own text, mean the task is named:
 * either exactly one of these words, or any identifier ending in one of
 * them (a file-local helper like `commitPushTaskLabel(resolvedTask)` still
 * names the task even though the bare word doesn't appear on its own).
 */
const TASK_NAME_PATTERN =
  /\b[A-Za-z_$]*(?:displayName|taskName|taskLabel|taskTitle|folderName|formatTaskNameForDisplay|notificationTaskDisplayNameV1|taskDisplayName)\b/i;

const SNIPPET_MAX_CHARS = 160;

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "test") continue;
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** True when a `/` at `index` starts a regex literal rather than a division. */
function startsRegex(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(text[i])) return true;
  return /\b(?:return|typeof|case|in|of)$/.test(text.slice(Math.max(0, i - 6), i + 1));
}

/**
 * One pass over `text`: returns, for each notification call, its start index,
 * the index just past its closing paren, and whether an attributing wrapper is
 * open around it. Strings, template literals (with nested `${}`), comments and
 * regex literals are skipped so their brackets never unbalance the stack.
 */
function scanFile(text) {
  const sites = [];
  const parens = []; // { name } for each open "("
  const braces = []; // "{" | "${" for each open brace
  const templateStack = []; // brace depth at which each open template literal resumes
  let i = 0;
  const n = text.length;

  const skipString = (quote) => {
    i++;
    while (i < n && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
    i++;
  };
  // Scans template text until the closing backtick or a `${`; returns true when a `${` was entered.
  const scanTemplate = () => {
    while (i < n) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "`") { i++; return false; }
      if (text[i] === "$" && text[i + 1] === "{") {
        i += 2;
        braces.push("${");
        templateStack.push(braces.length);
        return true;
      }
      i++;
    }
    return false;
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end === -1 ? n : end + 2; continue; }
    if (ch === '"' || ch === "'") { skipString(ch); continue; }
    if (ch === "`") { i++; scanTemplate(); continue; }
    if (ch === "/" && startsRegex(text, i)) {
      i++;
      let inClass = false;
      while (i < n && (inClass || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") { braces.push("{"); i++; continue; }
    if (ch === "}") {
      const closed = braces.pop();
      i++;
      if (closed === "${" && templateStack.length > 0 && templateStack[templateStack.length - 1] === braces.length + 1) {
        templateStack.pop();
        scanTemplate();
      }
      continue;
    }
    if (ch === "(") {
      const before = text.slice(Math.max(0, i - 80), i);
      const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1] ?? "";
      const notification = (() => {
        const lookback = text.slice(Math.max(0, i - 60), i + 1);
        const m = NOTIFICATION_CALL_TAIL.exec(lookback);
        return m ? i + 1 - m[0].length : -1;
      })();
      parens.push({ name: callee, notificationStart: notification, argsStart: i + 1 });
      if (notification >= 0) {
        sites.push({
          start: notification,
          argsStart: i + 1,
          attributed: parens.slice(0, -1).some((p) => ATTRIBUTING_CALLS.has(p.name)),
          end: -1,
        });
      }
      i++;
      continue;
    }
    if (ch === ")") {
      const closed = parens.pop();
      if (closed && closed.notificationStart >= 0) {
        const site = sites.find((s) => s.start === closed.notificationStart && s.end === -1);
        if (site) site.end = i + 1;
      }
      i++;
      continue;
    }
    i++;
  }
  return sites.filter((s) => s.end !== -1);
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let k = 0; k < index; k++) if (text[k] === "\n") line++;
  return line;
}

function snippetOf(text, site) {
  return text.slice(site.start, site.end).replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS);
}

/** Classifies every notification call in `text`. Exported shape is used by the self-test below. */
export function classifyNotificationSitesV1(text, relPath, allowlistByFile, usedEntries) {
  const results = [];
  for (const site of scanFile(text)) {
    const callText = text.slice(site.start, site.end);
    const snippet = snippetOf(text, site);
    const entry = (allowlistByFile.get(relPath) ?? []).find((e) => !usedEntries.has(e) && snippet.includes(e.snippet));
    let group;
    if (site.attributed) group = "attributed";
    else if (TASK_NAME_PATTERN.test(callText)) group = "self-named";
    else if (entry) {
      usedEntries.add(entry);
      group = "global";
    } else group = "un-named";
    results.push({ file: relPath, line: lineNumberAt(text, site.start), group, snippet });
  }
  return results;
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const byFile = new Map();
  for (const entry of raw.entries) {
    if (!entry.file || !entry.snippet || !entry.reason) {
      throw new Error(`notificationTaskNamingAllowlistV1.json entry missing file/snippet/reason: ${JSON.stringify(entry)}`);
    }
    byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  }
  return { raw, byFile };
}

/** Self-test: the scanner must classify one synthetic file into all four groups. */
function selfTest() {
  const source = [
    "async function a() {",
    "  await runTrackedOperation(p, spec, async () => {",
    "    NotificationRouter.showInformation(`inside ${x}`);",
    "  });",
    "  NotificationRouter.showWarning(`Task \"${displayName}\" paused`);",
    "  NotificationRouter.showError(`global ${re.test(\"(\")} thing`);",
    "  const r = /[(]/; NotificationRouter.showError(\"nothing names a task\");",
    "  NotificationRouter.emitProgressSummary(\"progress with no task\");",
    "  await runTrackedOperation(p, spec, async () => { NotificationRouter.emitProgressSummary(\"tracked\"); });",
    "}",
  ].join("\n");
  const entry = { file: "x.ts", snippet: "NotificationRouter.showError(`global", reason: "test" };
  const results = classifyNotificationSitesV1(source, "x.ts", new Map([["x.ts", [entry]]]), new Set());
  const groups = results.map((r) => r.group).join(",");
  if (groups !== "attributed,self-named,global,un-named,un-named,attributed") {
    console.error(`verifyNotificationTaskNamingV1 self-test failed: got ${groups}`);
    process.exit(1);
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  selfTest();
  const { raw, byFile } = loadAllowlist();
  const usedEntries = new Set();
  const all = [];
  for (const file of collectTsFiles(srcRoot)) {
    const relPath = path.relative(repoRoot, file).split(path.sep).join("/");
    all.push(...classifyNotificationSitesV1(readFileSync(file, "utf8"), relPath, byFile, usedEntries));
  }
  const counts = { attributed: 0, "self-named": 0, global: 0, "un-named": 0 };
  for (const r of all) counts[r.group]++;
  const unNamed = all.filter((r) => r.group === "un-named");
  const stale = raw.entries.filter((e) => !usedEntries.has(e));

  if (args.has("--json")) {
    console.log(JSON.stringify({ counts, unNamed, stale: stale.map((e) => `${e.file} :: ${e.snippet.slice(0, 60)}`) }, null, 2));
    process.exit(unNamed.length > 0 || stale.length > 0 ? 1 : 0);
  }

  console.log(
    `notificationTaskNaming: ${all.length} sites — ${counts.attributed} attributed, ${counts["self-named"]} self-named, ` +
      `${counts.global} global (allow-listed), ${counts["un-named"]} un-named.`
  );
  if (unNamed.length > 0) {
    const shown = args.has("--report") ? unNamed : unNamed.slice(0, 25);
    console.warn(`notificationTaskNaming: ${unNamed.length} notification(s) do not name their task:`);
    for (const r of shown) console.warn(`  ${r.file}:${r.line} — ${r.snippet.slice(0, 110)}`);
    if (shown.length < unNamed.length) console.warn(`  ... and ${unNamed.length - shown.length} more (run with --report).`);
    console.warn(
      "Fix each by wrapping its producer in runWithNotificationTaskContextV1 (or runTrackedOperation), by interpolating the " +
        "task's display name into the message, or — only when it fires before a task is resolved or is not about one task — " +
        "by adding it to scripts/notificationTaskNamingAllowlistV1.json with a reason."
    );
  }
  if (stale.length > 0) {
    console.warn(`notificationTaskNaming: ${stale.length} allow-list entr${stale.length === 1 ? "y is" : "ies are"} stale:`);
    for (const e of stale) console.warn(`  ${e.file} :: ${e.snippet.slice(0, 60)}`);
  }
  process.exit(unNamed.length > 0 || stale.length > 0 ? 1 : 0);
}

main();
