import * as vscode from "vscode";
import { TaskStage } from "./taskProgress";

/**
 * The workflow stage an agent run is producing output for.
 */
export type AgentWorkflowStage = TaskStage;

/**
 * Capabilities a given AgentRunner supports. Phase 1 runners only need
 * planning/review; later phases add implementation and diff review.
 */
export interface AgentRunnerCapabilities {
  planning: boolean;
  review: boolean;
  /** Can produce a task-scoped, non-session assistant response. */
  assistant: boolean;
}

/**
 * Whether a runner is currently usable, and why not if it isn't.
 */
export interface AgentAvailability {
  available: boolean;
  reason?: string;
}

/**
 * A single request to produce content for a workflow stage.
 */
export interface AgentRunRequest {
  taskFolderUri: vscode.Uri;
  workspaceUri: vscode.Uri;
  stage: AgentWorkflowStage;
  prompt: string;
  outputFile: vscode.Uri;
  modelId?: string;
}

/**
 * The result of running an agent for a given request.
 */
export interface AgentRunResult {
  runnerId: string;
  status: "completed" | "failed" | "cancelled";
  outputFile?: vscode.Uri;
  logFile?: vscode.Uri;
  summary?: string;
  errorMessage?: string;
  /** Stable provider-neutral failure classification. */
  failureKind?: "quota" | "temporarily-unavailable" | "generic";
  modelId?: string;
  /**
   * The provider's own pre-hint authentication verdict, when the runner can
   * produce one (CLI runners; Copilot leaves it undefined). Captured before
   * any login hint was appended to errorMessage — any future auth check on
   * this text/review-path result should prefer this (or authDiagnosticText)
   * over regexing errorMessage, for the same reason the implementation path
   * does: the appended hint text can itself trip an auth-pattern match.
   */
  authFailure?: boolean;
  /** errorMessage minus any appended login hint — the classification-safe form. */
  authDiagnosticText?: string;
}

/**
 * Provider-neutral interface for an AI agent runner.
 * Phase 1 only implements a read-only planning/review runner (Copilot).
 */
export interface AgentRunner {
  readonly id: string;
  readonly label: string;
  readonly capabilities: AgentRunnerCapabilities;
  isAvailable(): Promise<AgentAvailability>;
  run(
    request: AgentRunRequest,
    token: vscode.CancellationToken
  ): Promise<AgentRunResult>;
}
