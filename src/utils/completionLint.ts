import * as vscode from "vscode";
import { spawn, execSync, execFileSync } from "child_process";
import { patchTaskProgress, updateLintPayload } from "./taskProgressUtils";
import * as fs from "fs";
import * as path from "path";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";

/**
 * Resolve a package manager executable to an absolute path, preferring a
 * .cmd/.bat/.exe shim on Windows. `where.exe` also matches extension-less
 * POSIX shim scripts that npm installs alongside the real Windows shim (e.g.
 * a bare `pnpm` file next to `pnpm.CMD`), and can list them first — spawning
 * that extension-less file directly fails with ENOENT. Falls back to the
 * bare executable name (relying on PATH resolution via shell:true) if
 * `where`/`which` can't resolve it.
 */
function resolveManagerExecutable(cwd: string, manager: string): string {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const candidates = execFileSync(locator, [manager], { cwd, windowsHide: true })
      .toString("utf8").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const preferred = process.platform === "win32"
      ? candidates.find(value => /\.(cmd|bat|exe)$/i.test(value)) ?? candidates[0]
      : candidates[0];
    if (preferred) return preferred;
  } catch {
    // Fall through to the PATH-relative name below.
  }
  return process.platform === "win32" ? `${manager}.cmd` : manager;
}

export interface CompletionLintResult {
  runAt: string;
  passed: boolean;
  summary: string;
  issueCount: number;
  failedChecks: Array<{ command: string; exitCode: number; output: string }>;
  /** `scripts` entries (from the conventional `lint`/`test` names) not found
   * in the workspace `package.json`, and therefore skipped rather than run. */
  missingScripts: string[];
}

/**
 * Read the workspace `package.json`'s `scripts` map, or `undefined` if the
 * file is missing/unreadable. Used to skip conventional `lint`/`test`
 * checks that aren't configured instead of misreporting a package-manager
 * "missing script" error as a real check failure.
 */
export function readPackageScripts(folder: string): Record<string, string> | undefined {
  try {
    const raw = fs.readFileSync(path.join(folder, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts;
  } catch {
    return undefined;
  }
}

function isInFolder(uri: vscode.Uri, folder: string): boolean {
  const file = uri.fsPath.replace(/\\/g, "/");
  const root = folder.replace(/\\/g, "/").replace(/\/$/, "");
  return file === root || file.startsWith(`${root}/`);
}

function getGitModifiedFiles(folder: string): string[] {
  try {
    const stdout = execSync("git status --porcelain", { cwd: folder, stdio: "pipe", windowsHide: true }).toString("utf8");
    const files: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const filePath = trimmed.slice(3).trim();
      if (filePath) {
        files.push(filePath);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function getOpenWorkspaceFiles(folder: string): string[] {
  const files: string[] = [];
  try {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri && isInFolder(doc.uri, folder)) {
        files.push(path.relative(folder, doc.uri.fsPath));
      }
    }
  } catch {
    // Ignore
  }
  return files;
}

function runCheck(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const executable = args[0] ?? "npm";
    const resolved = resolveManagerExecutable(cwd, executable);
    // shell:true on Windows so a .cmd/.bat shim (an npm/pnpm global-install
    // shim, not a real executable) can be exec'd at all — spawning a .cmd
    // file directly with shell:false fails with EINVAL. See cliAgentRunner.ts
    // for the same pattern applied to the CLI provider runners.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
    // With shell:true, Node builds `cmd.exe /d /s /c "<command> <args...>"`
    // without quoting `command` itself — an unquoted path containing spaces
    // (e.g. the default Windows Node.js install, "C:\Program Files\nodejs\
    // npm.cmd") gets split at the first space and misreported as
    // "'C:\Program' is not recognized...", silently failing every lint/
    // check-types/test check. Quote both the resolved executable and any
    // argument containing spaces, mirroring cliAgentRunner.ts's existing
    // argument-quoting for the same shell:true-on-Windows situation.
    const quote = (value: string): string => (value.includes(" ") ? `"${value}"` : value);
    const child = spawn(
      useShell ? quote(resolved) : resolved,
      useShell ? args.slice(1).map(quote) : args.slice(1),
      { cwd, shell: useShell }
    );
    let output = "";
    child.stdout?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.stderr?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function packageManager(folder: string): string {
  if (fs.existsSync(path.join(folder, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(folder, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(folder, "bun.lockb")) || fs.existsSync(path.join(folder, "bun.lock"))) return "bun";
  return "npm";
}

/** Collect diagnostics after fresh lint/type/test checks have completed. */
export async function collectCompletionLint(folder: string, relevantFiles?: readonly string[]): Promise<CompletionLintResult> {
  const manager = packageManager(folder);
  const scripts = readPackageScripts(folder);
  const missingScripts: string[] = [];

  const candidateChecks: Array<readonly [string, string[]]> = [
    [`${manager} run lint`, [manager, "run", "lint"]],
    [`${manager} run check-types`, [manager, "run", "check-types"]],
    [`${manager} run test`, [manager, "run", "test"]],
  ];

  // The conventional `lint`/`test` scripts (publish pre-check contract) are
  // skipped rather than run when not present in package.json's `scripts`, so
  // an unconfigured workspace gets clean setup guidance instead of every
  // publish check being misreported as a failure. `check-types` predates
  // that contract and keeps its existing unconditional-run behavior.
  const runnableChecks = candidateChecks.filter(([, args]) => {
    const scriptName = args[2];
    if (scriptName !== "lint" && scriptName !== "test") return true;
    const configured = !!scripts && Object.prototype.hasOwnProperty.call(scripts, scriptName);
    if (!configured) missingScripts.push(scriptName);
    return configured;
  });

  const checks = await Promise.all(
    runnableChecks.map(async ([command, args]) => ({ command, ...(await runCheck(folder, [...args])) }))
  );

  let filesToCheck = relevantFiles ? [...relevantFiles] : [];
  if (filesToCheck.length === 0) {
    const gitFiles = getGitModifiedFiles(folder);
    const openFiles = getOpenWorkspaceFiles(folder);
    const union = new Set([...gitFiles, ...openFiles]);
    filesToCheck = [...union];
  }

  const issues = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    isInFolder(uri, folder) && filesToCheck.length > 0 && filesToCheck.some(file => path.resolve(folder, file) === path.resolve(uri.fsPath))
      ? diagnostics.filter((d) => d.source === "eslint" || d.source === "ts" || d.source === "typescript")
      : []
  );
  // A configured publish check is a workspace-level gate. Its exit status is
  // authoritative: runner/configuration failures frequently name no source
  // file at all, and filtering those by task-file attribution previously
  // converted a real non-zero exit into a passing publish result. Keep every
  // failed configured check so publish-review.md and the Publish Anyway / Fix
  // / Cancel prompt always reflect the actual command outcome.
  const commandFailures = checks.filter((check) => check.code !== 0);
  const issueCount = issues.length + commandFailures.length;
  const baseSummary = commandFailures.length > 0
    ? `${commandFailures.length} completion check(s) failed${issues.length ? `; ${issues.length} editor diagnostic(s) remain` : "."}`
    : issues.length === 0 ? "No linting issues found." : `${issues.length} lint issue(s) remain.`;
  const summary = missingScripts.length > 0
    ? `${baseSummary} (${missingScripts.join("/")} script(s) not configured — add them to package.json's ` +
      `"scripts" to enable publish checks for them.)`
    : baseSummary;
  return {
    runAt: new Date().toISOString(),
    passed: issueCount === 0,
    issueCount,
    summary,
    failedChecks: commandFailures.map(({ command, code, output }) => ({ command, exitCode: code, output })),
    missingScripts,
  };
}

const PUBLISH_CHECKS_SECTION_START = "<!-- completion-checks:start -->";
const PUBLISH_CHECKS_SECTION_END = "<!-- completion-checks:end -->";
/** Cap per-failed-check output embedded in publish-review.md — this is a
 * human-facing artifact, not an AI prompt, so it only needs enough of the
 * output to identify the failure, not the full log. */
const PUBLISH_CHECKS_MAX_OUTPUT_CHARS = 4000;

function renderCompletionChecksSection(
  result: CompletionLintResult,
  override?: { reason: string }
): string {
  const lines: string[] = [PUBLISH_CHECKS_SECTION_START, "## Completion Checks", ""];
  lines.push(`- Status: ${result.passed ? "Passed" : "Failed"}`);
  lines.push(`- Last run: ${result.runAt}`);
  lines.push(`- Summary: ${result.summary}`);
  if (result.failedChecks.length > 0) {
    lines.push("", "### Failed checks");
    for (const check of result.failedChecks) {
      const output = check.output.length > PUBLISH_CHECKS_MAX_OUTPUT_CHARS
        ? `${check.output.slice(0, PUBLISH_CHECKS_MAX_OUTPUT_CHARS)}\n… (truncated)`
        : check.output;
      lines.push("", `**${check.command}** (exit ${check.exitCode})`, "```", output, "```");
    }
  }
  if (override) {
    lines.push("", `_Published anyway despite failing checks — ${override.reason}._`);
  }
  lines.push(PUBLISH_CHECKS_SECTION_END);
  return lines.join("\n");
}

/**
 * Merge a rendered "Completion Checks" section into whatever publish-review.md
 * content already exists, replacing a previous run of the managed section in
 * place so the AI-authored publish-readiness review (generated separately by
 * the review-publish.md prompt) around it is preserved.
 *
 * @internal exported for testing
 */
export function mergeCompletionChecksSection(existing: string, section: string): string {
  const startIdx = existing.indexOf(PUBLISH_CHECKS_SECTION_START);
  const endIdx = existing.indexOf(PUBLISH_CHECKS_SECTION_END);
  return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
    ? existing.slice(0, startIdx) + section + existing.slice(endIdx + PUBLISH_CHECKS_SECTION_END.length)
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}\n`
      : `${section}\n`;
}

/**
 * Upsert a "Completion Checks" section into publish-review.md. Every
 * completion lint run at the Publish stage calls this, so both the "check"
 * and "fix" paths keep this artifact current. Uses plain `node:fs` (like
 * `readPackageScripts` above) rather than `vscode.workspace.fs` — this is
 * always a plain file on disk inside the task folder, never a virtual FS
 * scheme, so there's nothing the VS Code FS abstraction adds here.
 */
export async function upsertCompletionChecksInPublishReview(
  taskFolderUri: vscode.Uri,
  result: CompletionLintResult,
  override?: { reason: string }
): Promise<void> {
  const filename = STAGE_ARTIFACT_FILENAMES.publish;
  if (!filename) {
    return;
  }
  const targetPath = path.join(taskFolderUri.fsPath, filename);

  let existing = "";
  try {
    existing = await fs.promises.readFile(targetPath, "utf8");
  } catch {
    existing = "";
  }

  const section = renderCompletionChecksSection(result, override);
  await fs.promises.writeFile(targetPath, mergeCompletionChecksSection(existing, section), "utf8");
}

/** Persist the latest completion lint result without changing the task stage. */
export async function runCompletionLint(folderUri: vscode.Uri, relevantFiles?: readonly string[]): Promise<CompletionLintResult> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  const result = await collectCompletionLint(workspaceFolder?.uri.fsPath ?? folderUri.fsPath, relevantFiles);
  const persisted = await patchTaskProgress(folderUri, (current) => updateLintPayload(current, {
    runAt: result.runAt,
    passed: result.passed,
    summary: result.summary,
    issueCount: result.issueCount,
    failedChecks: result.failedChecks,
  }));
  if (!persisted) {
    throw new Error("Could not persist completion lint result.");
  }
  // Every runCompletionLint call site gates on the task already being at (or
  // advancing into) the Publish stage, so it's always safe to keep
  // publish-review.md's checks section current here rather than at each of
  // the eight call sites individually.
  await upsertCompletionChecksInPublishReview(folderUri, result);
  return result;
}
