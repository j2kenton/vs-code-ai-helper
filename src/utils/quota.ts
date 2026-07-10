import * as vscode from "vscode";
import { AgentRunRequest, AgentRunResult } from "../types/agentRunner";

export interface PendingResumeOperation {
  request: Omit<AgentRunRequest, "taskFolderUri" | "workspaceUri" | "outputFile"> & {
    taskFolderPath: string; workspacePath: string; outputFilePath: string;
  };
  attempts: number;
  createdAt: string;
}

const KEY = "pendingQuotaResume";
// Deliberately excludes a bare "exceeded" marker: real quota phrasing
// already matches via "quota"/"rate limit"/"usage limit" (e.g. "exceeded
// your current quota" matches on "quota" alone), while "exceeded" alone
// would false-positive on unrelated errors like "context length exceeded"
// or an argv-size cap message.
const QUOTA_MARKERS = ["quota", "rate limit", "ratelimit", "credits", "credit limit", "usage limit"];

export function isQuotaError(message: string | undefined): boolean {
  const value = (message ?? "").toLowerCase();
  return QUOTA_MARKERS.some((marker) => value.includes(marker));
}

export function classifyFailure<T extends { errorMessage?: string }>(result: T): T & { failureKind: "quota" | "generic" } {
  return { ...result, failureKind: isQuotaError(result.errorMessage) ? "quota" : "generic" };
}

export function classifyCliFailure<T extends { status: "completed" | "failed" | "cancelled"; errorMessage?: string }>(result: T): T & { failureKind: "quota" | "generic" } {
  return { ...result, failureKind: isQuotaError(result.errorMessage) ? "quota" : "generic" };
}

export async function savePendingResume(context: vscode.ExtensionContext, request: AgentRunRequest): Promise<void> {
  const existing = context.workspaceState.get<PendingResumeOperation>(KEY);
  const next: PendingResumeOperation = {
    request: { stage: request.stage, prompt: request.prompt, modelId: request.modelId, taskFolderPath: request.taskFolderUri.fsPath, workspacePath: request.workspaceUri.fsPath, outputFilePath: request.outputFile.fsPath },
    attempts: existing?.request.prompt === request.prompt ? existing.attempts + 1 : 0,
    createdAt: new Date().toISOString(),
  };
  await context.workspaceState.update(KEY, next);
}

export function getPendingResume(context: vscode.ExtensionContext): PendingResumeOperation | undefined {
  return context.workspaceState.get<PendingResumeOperation>(KEY);
}

export async function clearPendingResume(context: vscode.ExtensionContext): Promise<void> { await context.workspaceState.update(KEY, undefined); }

export async function handleQuotaFailure(context: vscode.ExtensionContext, request: AgentRunRequest, result: AgentRunResult, switchModel?: () => Thenable<void>): Promise<"resume" | "switch" | undefined> {
  if (result.failureKind !== "quota") return undefined;
  await savePendingResume(context, request);
  const choice = await vscode.window.showWarningMessage("AI credits are exhausted.", "Resume when credits restore", "Switch model");
  if (choice === "Switch model") { await switchModel?.(); return "switch"; }
  return choice === "Resume when credits restore" ? "resume" : undefined;
}
