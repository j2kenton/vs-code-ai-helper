import * as vscode from "vscode";
import { patchTaskProgress, updateLintPayload } from "./taskProgressUtils";

export interface CompletionLintResult {
  runAt: string;
  passed: boolean;
  summary: string;
  issueCount: number;
}

function isInFolder(uri: vscode.Uri, folder: string): boolean {
  const file = uri.fsPath.replace(/\\/g, "/").toLowerCase();
  const root = folder.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  return file === root || file.startsWith(`${root}/`);
}

/** Collect the current editor diagnostics that constitute completion lint. */
export function collectCompletionLint(folder: string): CompletionLintResult {
  const issues = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    isInFolder(uri, folder)
      ? diagnostics.filter((d) => d.source === "eslint" || d.source === "ts" || d.source === "typescript")
      : []
  );
  const issueCount = issues.length;
  return {
    runAt: new Date().toISOString(),
    passed: issueCount === 0,
    issueCount,
    summary: issueCount === 0 ? "No linting issues found." : `${issueCount} lint issue(s) remain.`,
  };
}

/** Persist the latest completion lint result without changing the task stage. */
export async function runCompletionLint(folderUri: vscode.Uri): Promise<CompletionLintResult> {
  const result = collectCompletionLint(folderUri.fsPath);
  await patchTaskProgress(folderUri, (current) => updateLintPayload(current, {
    runAt: result.runAt,
    passed: result.passed,
    summary: result.summary,
  }));
  return result;
}
