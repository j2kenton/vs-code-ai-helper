import * as vscode from "vscode";
import { getModelSettings } from "../config/settings";
import { RUNS_DIRNAME, TaskStage } from "../types/taskProgress";
import { ModelSettings, StageModelSetting } from "./modelFallback";
import { resolveEffectiveStageChainV1 } from "./modelSelection";

export interface DispatchModelChainSnapshotV1 {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly stage: TaskStage;
  readonly configured: StageModelSetting | undefined;
  readonly effective: ReturnType<typeof resolveEffectiveStageChainV1>;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly runnerId?: string;
  readonly invoked?: { readonly storedModelId: string; readonly providerLabel: string };
  /** Monotonic ordering within this process/operation; ties never choose evidence. */
  readonly candidateOrdinal?: number;
}

export interface DispatchCorrelationV1 {
  readonly operationId: string;
  readonly attemptId?: string;
}

export function dispatchCorrelationFromOutcomeV1(value: unknown): DispatchCorrelationV1 | undefined {
  if (!value || typeof value !== "object" || !("correlation" in value)) return undefined;
  const correlation: unknown = (value as { readonly correlation?: unknown }).correlation;
  if (!correlation || typeof correlation !== "object") return undefined;
  const record = correlation as Record<string, unknown>;
  if (typeof record.operationId !== "string") return undefined;
  return {
    operationId: record.operationId,
    ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
  };
}

const capturedByOperation = new Map<string, DispatchModelChainSnapshotV1>();
const candidateOrdinalByOperation = new Map<string, number>();

export function captureDispatchModelChainV1(stage: TaskStage, settings: ModelSettings = getModelSettings()): DispatchModelChainSnapshotV1 {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    stage,
    configured: settings[stage],
    effective: resolveEffectiveStageChainV1(stage, settings),
  };
}

export function dispatchModelChainForOperationV1(stage: TaskStage, operationId: string | undefined): DispatchModelChainSnapshotV1 {
  const key = operationId ?? `anonymous:${stage}`;
  const existing = capturedByOperation.get(key);
  if (existing) return existing;
  const captured = captureDispatchModelChainV1(stage);
  capturedByOperation.set(key, captured);
  if (capturedByOperation.size > 100) capturedByOperation.delete(capturedByOperation.keys().next().value ?? key);
  return captured;
}

export function clearDispatchModelChainCaptureV1(operationId: string): void {
  capturedByOperation.delete(operationId);
}

function safeIdentity(value: string | undefined): string {
  return (value ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export async function persistCandidateDispatchModelChainV1(input: {
  readonly taskFolderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly runnerId?: string;
  readonly storedModelId: string;
  readonly providerLabel: string;
}): Promise<DispatchModelChainSnapshotV1> {
  const captured = dispatchModelChainForOperationV1(input.stage, input.operationId);
  const snapshot: DispatchModelChainSnapshotV1 = {
    ...captured,
    operationId: input.operationId,
    attemptId: input.attemptId,
    runnerId: input.runnerId,
    invoked: { storedModelId: input.storedModelId, providerLabel: input.providerLabel },
    candidateOrdinal: nextCandidateOrdinal(input.operationId),
  };
  const runsUri = vscode.Uri.joinPath(input.taskFolderUri, RUNS_DIRNAME);
  await vscode.workspace.fs.createDirectory(runsUri);
  const fileName = `dispatch-model-chain-${safeIdentity(input.operationId)}-${safeIdentity(input.attemptId)}-v1.json`;
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runsUri, fileName), new TextEncoder().encode(JSON.stringify(snapshot, null, 2) + "\n"));
  return snapshot;
}

function nextCandidateOrdinal(operationId: string | undefined): number {
  const key = operationId ?? "anonymous";
  const next = (candidateOrdinalByOperation.get(key) ?? 0) + 1;
  candidateOrdinalByOperation.set(key, next);
  return next;
}

export function candidateInvocationMessageV1(activity: string, storedModelId: string, providerLabel: string, backup: boolean): string {
  return backup
    ? `Backup started for ${activity}: ${providerLabel} — ${storedModelId}.`
    : `Running ${activity} with ${providerLabel} — ${storedModelId}.`;
}

export function formatDispatchModelChainForRunLogV1(snapshot: DispatchModelChainSnapshotV1): string {
  return [
    "## Dispatch-time model chain",
    "",
    `Captured: ${snapshot.capturedAt}`,
    `Invoked: ${snapshot.invoked ? `${snapshot.invoked.providerLabel} — ${snapshot.invoked.storedModelId}` : "not recorded"}`,
    `Configured: \`${JSON.stringify(snapshot.configured ?? null)}\``,
    `Effective primary: ${snapshot.effective.primary ?? "none"}`,
    `Effective enabled backups: ${snapshot.effective.backups.length > 0 ? snapshot.effective.backups.join(" → ") : "none"}`,
    `Chain source: ${snapshot.effective.source} (${snapshot.effective.originStage})`,
    "",
  ].join("\n");
}

export function selectDispatchModelChainsForRunLogV1(
  snapshots: readonly DispatchModelChainSnapshotV1[],
  correlation: { readonly operationId: string; readonly attemptIds?: readonly string[] }
): readonly DispatchModelChainSnapshotV1[] {
  const attemptIds = new Set(correlation.attemptIds ?? []);
  return snapshots
    .filter((snapshot) => snapshot.operationId === correlation.operationId &&
      (attemptIds.size === 0 || (snapshot.attemptId !== undefined && attemptIds.has(snapshot.attemptId))))
    .sort((a, b) => (a.candidateOrdinal ?? 0) - (b.candidateOrdinal ?? 0));
}

export async function appendLatestDispatchModelChainToRunLogV1(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  content: string,
  correlation?: { readonly operationId: string; readonly attemptIds?: readonly string[] }
): Promise<string> {
  // A stage/runner/timestamp match is not provenance. Leave the log unchanged
  // unless its caller can bind it to the operation that invoked the model.
  if (!correlation?.operationId) return content;
  const runsUri = vscode.Uri.joinPath(taskFolderUri, RUNS_DIRNAME);
  try {
    const entries = await vscode.workspace.fs.readDirectory(runsUri);
    const candidates = entries.filter(([name]) => name.startsWith("dispatch-model-chain-") && name.endsWith("-v1.json"));
    const snapshots: DispatchModelChainSnapshotV1[] = [];
    for (const [name] of candidates) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(runsUri, name)))) as DispatchModelChainSnapshotV1;
        if (parsed.schemaVersion === 1 && parsed.stage === stage && parsed.operationId === correlation.operationId &&
            (!correlation.attemptIds?.length || (parsed.attemptId !== undefined && correlation.attemptIds.includes(parsed.attemptId)))) {
          snapshots.push(parsed);
        }
      } catch { /* ignore unrelated or incomplete evidence */ }
    }
    const selected = selectDispatchModelChainsForRunLogV1(snapshots, correlation);
    return selected.length > 0
      ? `${content.trimEnd()}\n\n${selected.map(formatDispatchModelChainForRunLogV1).join("\n")}`
      : content;
  } catch {
    return content;
  }
}
