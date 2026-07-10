import * as vscode from "vscode";
import { spawn } from "child_process";
import { patchTaskProgress, updateLintPayload } from "./taskProgressUtils";

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
    // shell:true on Windows so pnpm.cmd (an npm/pnpm global-install shim, not
    // a real executable) can be exec'd at all — spawning a .cmd file directly
    // with shell:false fails with EINVAL. See cliAgentRunner.ts for the same
    // pattern applied to the CLI provider runners.
    const child = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args,
      { cwd, shell: process.platform === "win32" }
    );
    let output = "";
    child.stdout?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.stderr?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Collect diagnostics after fresh lint/type checks have completed. */
export async function collectCompletionLint(folder: string): Promise<CompletionLintResult> {
  const checks = await Promise.all([
    ["pnpm run lint", ["run", "lint"]] as const,
    ["pnpm run check-types", ["run", "check-types"]] as const,
  ].map(async ([command, args]) => ({ command, ...(await runCheck(folder, [...args])) })));
  const issues = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    isInFolder(uri, folder)
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
export async function runCompletionLint(folderUri: vscode.Uri): Promise<CompletionLintResult> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  const result = await collectCompletionLint(workspaceFolder?.uri.fsPath ?? folderUri.fsPath);
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
