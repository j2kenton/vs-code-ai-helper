import * as vscode from "vscode";
import { spawn } from "child_process";
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
  const issues = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    isInFolder(uri, folder) && (!relevantFiles || relevantFiles.some(file => path.resolve(folder, file) === path.resolve(uri.fsPath)))
      ? diagnostics.filter((d) => d.source === "eslint" || d.source === "ts" || d.source === "typescript")
      : []
  );
  const commandFailures = checks.filter((check) => check.code !== 0);
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
