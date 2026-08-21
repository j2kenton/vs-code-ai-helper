#!/usr/bin/env node
/**
 * Live re-verification of the `~/.claude/plans` leak mitigation (workflow 8,
 * item 5). `CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT`
 * (src/runners/providers.ts) instructs the Claude Code CLI not to write its
 * plan to a file "including anywhere under ~/.claude/plans" when run
 * headless under `--permission-mode plan`. That mitigation was verified
 * live 2026-07-21 against claude 2.1.216, then observed to regress live
 * 2026-08-20 (this repo's own workflow 6, runs 019-021).
 *
 * This script invokes the installed `claude` CLI exactly the way
 * `providers.ts`'s claude-cli definition does for text-mode rounds
 * (`-p --permission-mode plan --append-system-prompt "<mitigation>"`),
 * snapshots `~/.claude/plans` before and after, and prints a pass/fail
 * verdict: PASS if no new file appears under `~/.claude/plans` and the
 * response text itself carries a real answer (not a short stub/pointer);
 * FAIL otherwise.
 *
 * Read-only with respect to the mitigation itself — this only observes
 * current CLI behavior. It does not edit providers.ts; that update (if any)
 * is a separate, evidence-gated step once this has run and its output is
 * captured into docs/verification/plans-leak-probe-2026-08.md.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT =
  "This is a non-interactive, headless run. The ExitPlanMode and " +
  "AskUserQuestion tools are not available in this session — do not " +
  "attempt to call them, and do not write your plan or any partial " +
  "output to a file (including anywhere under ~/.claude/plans). Instead, " +
  "write your complete plan, review, or answer directly as this " +
  "response's final text, including any open questions, decisions, or " +
  "assumptions inline in that text.";

const PROBE_PROMPT =
  "Plan (do not write code, just describe the plan in your response text): " +
  "add a one-line JSDoc comment above a hypothetical `add(a, b)` function " +
  "in a file called math.js. Answer directly in this response.";

const plansDir = join(homedir(), ".claude", "plans");

function snapshotPlansDir() {
  try {
    return new Map(
      readdirSync(plansDir).map((name) => {
        const full = join(plansDir, name);
        return [name, statSync(full).mtimeMs];
      })
    );
  } catch {
    // Directory may not exist yet on a machine that has never leaked.
    return new Map();
  }
}

// On Windows, the installed `claude` command resolves to a `.ps1`/`.cmd`
// shim, not a directly-executable binary — `execFileSync("claude", ...)`
// without shell resolution fails with ENOENT even though `claude` works fine
// interactively. Route through cmd.exe on win32 so this probe actually
// invokes the CLI instead of reporting a false INCONCLUSIVE.
//
// `shell: true` hands the argv straight to cmd.exe's naive whitespace
// splitter with no quoting of its own — a multi-word argument like the
// mitigation's system prompt would be split into many separate arguments
// (reproduced and confirmed against `node -e` echoing argv before this fix).
// Quote every argument ourselves using cmd.exe's quoting rule (wrap in
// double quotes, double any embedded double quotes) so each array element
// still arrives as exactly one argument.
const isWindows = process.platform === "win32";

function cmdQuote(arg) {
  if (arg === "") return '""';
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

function execClaude(args, extraOpts) {
  const opts = { encoding: "utf8", ...extraOpts };
  if (isWindows) {
    opts.shell = true;
    return execFileSync("claude", args.map(cmdQuote), opts);
  }
  return execFileSync("claude", args, opts);
}

function getClaudeVersion() {
  try {
    return execClaude(["--version"]).trim();
  } catch (err) {
    return `(could not determine: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function main() {
  const version = getClaudeVersion();
  const before = snapshotPlansDir();

  let stdout = "";
  let errorMessage;
  const startedAt = new Date().toISOString();
  try {
    stdout = execClaude(
      [
        "-p",
        "--permission-mode",
        "plan",
        "--append-system-prompt",
        CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT,
        PROBE_PROMPT,
      ],
      { timeout: 120000 }
    );
  } catch (err) {
    const baseMessage = err instanceof Error ? err.message : String(err);
    const stderrText =
      err && typeof err === "object" && "stderr" in err && err.stderr
        ? String(err.stderr).trim()
        : "";
    const stdoutText =
      err && typeof err === "object" && "stdout" in err && err.stdout
        ? String(err.stdout).trim()
        : "";
    errorMessage = [baseMessage, stderrText && `stderr: ${stderrText}`, stdoutText && `stdout: ${stdoutText}`]
      .filter(Boolean)
      .join(" | ");
  }
  const finishedAt = new Date().toISOString();

  const after = snapshotPlansDir();
  const leaked = [...after.keys()].filter(
    (name) => !before.has(name) || before.get(name) !== after.get(name)
  );

  const hasSubstantiveReply =
    stdout.trim().length > 200 &&
    /add|jsdoc|math\.js|comment/i.test(stdout);

  const verdict =
    errorMessage !== undefined
      ? "INCONCLUSIVE (CLI invocation failed — see error below)"
      : leaked.length > 0
        ? "FAIL — a new/changed file appeared under ~/.claude/plans"
        : hasSubstantiveReply
          ? "PASS — no scratch file written, and the response carries the real answer directly"
          : "FAIL — no scratch file written, but the response text does not look like a real answer (possible stub/pointer)";

  const report = {
    claudeVersion: version,
    startedAt,
    finishedAt,
    plansDir,
    filesBefore: [...before.keys()].sort(),
    filesLeakedOrChanged: leaked.sort(),
    verdict,
    errorMessage,
    responsePreview: stdout.slice(0, 2000),
  };

  console.log(JSON.stringify(report, undefined, 2));
  console.log("\nVERDICT:", verdict);
}

main();
