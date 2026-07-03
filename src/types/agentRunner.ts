import * as vscode from "vscode";

/**
 * The workflow stage an agent run is producing output for.
 */
export type AgentWorkflowStage =
  | "plan"
  | "plan-review"
  | "plan-updated"
  | "plan-updated-review";

/**
 * Capabilities a given AgentRunner supports. Phase 1 runners only need
 * planning/review; later phases add implementation and diff review.
 */
export interface AgentRunnerCapabilities {
  planning: boolean;
  review: boolean;
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
