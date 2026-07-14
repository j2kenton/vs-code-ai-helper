import * as vscode from "vscode";
import { AgentRunRequest, AgentRunResult } from "../types/agentRunner";
import type { TaskStage } from "../types/taskProgress";
import { notifyDesktop } from "./desktopNotifier";
import { taskOperations } from "./taskOperations";

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
const TEMPORARY_MARKERS = ["temporarily unavailable", "service unavailable", "too many requests", "try again later"];

export function isQuotaError(message: string | undefined): boolean {
  const value = (message ?? "").toLowerCase();
  return QUOTA_MARKERS.some((marker) => value.includes(marker));
}

export function classifyFailure<T extends { errorMessage?: string }>(result: T): T & { failureKind: "quota" | "temporarily-unavailable" | "generic" } {
  const message = (result.errorMessage ?? "").toLowerCase();
  return { ...result, failureKind: isQuotaError(result.errorMessage) ? "quota" : TEMPORARY_MARKERS.some(m => message.includes(m)) ? "temporarily-unavailable" : "generic" };
}

export function classifyCliFailure<T extends { status: "completed" | "failed" | "cancelled"; errorMessage?: string }>(result: T): T & { failureKind: "quota" | "temporarily-unavailable" | "generic" } {
  return classifyFailure(result);
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
  if (result.failureKind !== "quota") {
    return undefined;
  }
  await savePendingResume(context, request);
  notifyDesktop("Ensemble — question", "AI credits are exhausted. Resume when they restore, or switch model?");
  taskOperations.report(request.taskFolderUri.fsPath, "waiting for your answer — credits exhausted");
  const choice = await vscode.window.showWarningMessage("AI credits are exhausted.", "Resume when credits restore", "Switch model");
  taskOperations.report(request.taskFolderUri.fsPath, undefined);
  if (choice === "Switch model") { await switchModel?.(); return "switch"; }
  return choice === "Resume when credits restore" ? "resume" : undefined;
}

// ─── Session-observed quota status ──────────────────────────────────────────
//
// No provider exposes a numeric "percent of quota remaining" through its
// discovery/CLI surface, so a fabricated percentage would just be a made-up
// number (see the settings webview's explicit "never present fabricated
// usage data" comment). What we *can* report honestly is what this session
// has actually observed: the most recent run for a given stage+model either
// completed/failed for a non-quota reason ("ok"), or failed because the
// provider reported quota/rate-limit exhaustion ("exhausted"). This is reset
// each time the extension host restarts — it is a live signal, not a
// persisted ledger.

export type QuotaState = "ok" | "exhausted" | "unavailable";

export interface QuotaObservation {
  state: QuotaState;
  observedAt: string;
  /** Only present when the provider explicitly reported a percentage. */
  remainingPercent?: number;
}

const quotaObservations = new Map<string, QuotaObservation>();

function quotaKey(stage: TaskStage, modelId: string | undefined): string {
  return `${stage}::${modelId ?? "(default)"}`;
}

/**
 * Record what a completed run revealed about a stage+model's quota state.
 * Called after every run that has a `failureKind` classification (quota or
 * generic) or completed successfully — anything other than "quota" means the
 * provider was reachable and not currently blocked by quota exhaustion.
 */
export function recordQuotaObservation(
  stage: TaskStage,
  modelId: string | undefined,
  failureKind: "quota" | "temporarily-unavailable" | "generic" | undefined,
  errorMessage?: string
): void {
  const percentMatch = /(?:remaining|left|available)[^\d]{0,12}(\d{1,3})\s*%/i.exec(errorMessage ?? "");
  const parsedPercent = percentMatch ? Number(percentMatch[1]) : undefined;
  quotaObservations.set(quotaKey(stage, modelId), {
    state: failureKind === "quota" ? "exhausted" : failureKind === "temporarily-unavailable" ? "unavailable" : "ok",
    observedAt: new Date().toISOString(),
    ...(parsedPercent !== undefined && parsedPercent <= 100 ? { remainingPercent: parsedPercent } : {}),
  });
}

export function getQuotaObservation(
  stage: TaskStage,
  modelId: string | undefined
): QuotaObservation | undefined {
  return quotaObservations.get(quotaKey(stage, modelId));
}

/** Human-readable status for the settings webview. Never fabricates a number. */
export function formatQuotaStatus(observation: QuotaObservation | undefined): string {
  if (!observation) {
    return "No usage observed yet this session";
  }
  const time = new Date(observation.observedAt).toLocaleTimeString();
  const percent = observation.remainingPercent === undefined ? "" : ` (${observation.remainingPercent}% remaining)`;
  return observation.state === "exhausted"
    ? `Quota exhausted as of ${time}${percent}`
    : observation.state === "unavailable"
      ? `Unavailable as of ${time}`
    : `OK as of ${time}${percent}`;
}

export function getQuotaStatusText(stage: TaskStage, modelId: string | undefined): string {
  if (!modelId) return "-";
  return formatQuotaStatus(getQuotaObservation(stage, modelId));
}

/** Tooltip paired with getQuotaStatusText's "-" placeholder vs. observed text. */
export function getQuotaStatusTooltip(modelId: string | undefined): string {
  if (!modelId) return "No model configured for this slot — usage cannot be observed.";
  return "Session-observed usage status, not a live percentage (no provider exposes numeric quota remaining).";
}

export const __quotaTestOnly = {
  clear(): void {
    quotaObservations.clear();
  },
};
