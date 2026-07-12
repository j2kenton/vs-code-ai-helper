import * as vscode from "vscode";
import { spawn, execSync } from "child_process";
import { patchTaskProgress, updateLintPayload } from "./taskProgressUtils";
import * as fs from "fs";
import * as path from "path";

export interface CompletionLintResult {
  runAt: string;
  passed: boolean;
  summary: string;
  issueCount: number;
  failedChecks: Array<{ command: string; exitCode: number; output: string }>;
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

function outputReferencesFile(output: string, folder: string, file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const absolute = path.resolve(folder, file);
  return output.includes(normalized) || output.includes(file.replace(/\//g, "\\")) || output.includes(absolute);
}

function runCheck(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const executable = args[0] ?? "npm";
    // shell:true on Windows so pnpm.cmd (an npm/pnpm global-install shim, not
    // a real executable) can be exec'd at all — spawning a .cmd file directly
    // with shell:false fails with EINVAL. See cliAgentRunner.ts for the same
    // pattern applied to the CLI provider runners.
    const child = spawn(
      process.platform === "win32" ? `${executable}.cmd` : executable,
      args.slice(1),
      { cwd, shell: process.platform === "win32" }
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

/** Collect diagnostics after fresh lint/type checks have completed. */
export async function collectCompletionLint(folder: string, relevantFiles?: readonly string[]): Promise<CompletionLintResult> {
  const manager = packageManager(folder);
  const checks = await Promise.all([
    [`${manager} run lint`, [manager, "run", "lint"]] as const,
    [`${manager} run check-types`, [manager, "run", "check-types"]] as const,
  ].map(async ([command, args]) => ({ command, ...(await runCheck(folder, [...args])) })));

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
  const commandFailures = checks.filter((check) => {
    if (check.code === 0) return false;
    // A repo-wide command may report pre-existing failures. Attribute it to
    // this task only when the tool names one of the files in scope; if scope
    // is genuinely unknown, retain the conservative blocking behavior.
    // A non-zero exit with no attributable file is indeterminate, not a pass.
    // Compiler/configuration failures often contain no source path and must
    // remain blocking until the user resolves or explicitly reruns the check.
    return filesToCheck.length === 0 || filesToCheck.some(file => outputReferencesFile(check.output, folder, file));
  });
  const issueCount = issues.length + commandFailures.length;
  const summary = commandFailures.length > 0
    ? `${commandFailures.length} completion check(s) failed${issues.length ? `; ${issues.length} editor diagnostic(s) remain` : "."}`
    : issues.length === 0 ? "No linting issues found." : `${issues.length} lint issue(s) remain.`;
  return {
    runAt: new Date().toISOString(),
    passed: issueCount === 0,
    issueCount,
    summary,
    failedChecks: commandFailures.map(({ command, code, output }) => ({ command, exitCode: code, output })),
  };
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
  return result;
}
