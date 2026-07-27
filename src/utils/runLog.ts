import * as vscode from "vscode";
import { RUNS_DIRNAME } from "../types/taskProgress";
import { AgentWorkflowStage } from "../types/agentRunner";
import { classifyWorkflowPathV1 } from "../services/workflowPrivacyClassifierV1";

/**
 * Ensure the runs/ directory exists under the task folder.
 */
export async function ensureRunsDirectory(
  taskFolderUri: vscode.Uri
): Promise<vscode.Uri> {
  const runsUri = vscode.Uri.joinPath(taskFolderUri, RUNS_DIRNAME);
  await vscode.workspace.fs.createDirectory(runsUri);
  return runsUri;
}

/**
 * Find the next run number by scanning existing files in runs/.
 */
async function getNextRunNumber(runsUri: vscode.Uri): Promise<number> {
  let maxRunNumber = 0;
  try {
    const entries = await vscode.workspace.fs.readDirectory(runsUri);
    for (const [name] of entries) {
      const match = /^(\d+)-/.exec(name);
      if (match && match[1]) {
        const runNumber = parseInt(match[1], 10);
        if (runNumber > maxRunNumber) {
          maxRunNumber = runNumber;
        }
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return maxRunNumber + 1;
}

/**
 * Refuse any run-log filename whose runs/-relative path does not classify as
 * artifact-safe (plan §2.2). Run logs are the product's log-attachment
 * surface; a name that collides with a Chat-private, workflow-control, or
 * legacy Chat-artifact convention (e.g. a legacy `runs/chat-*.md`
 * transcript) must be refused instead of overwritten. Exported so the guard
 * is directly testable — the current "NNN-<runnerId>-<stage>.md" naming can
 * never trip it, and this seam keeps that invariant pinned if the naming
 * scheme ever changes.
 */
export function assertRunLogPathArtifactSafe(fileName: string): void {
  const classification = classifyWorkflowPathV1(`${RUNS_DIRNAME}/${fileName}`);
  if (classification !== "artifactSafe") {
    throw new Error(
      `Refused to write run log "${fileName}": its path classifies as ${classification}, not artifact-safe (plan §2.2).`
    );
  }
}

/**
 * Write a run log file under runs/ named "NNN-<runnerId>-<stage>.md" and
 * return its URI. Numbers increment per task folder so logs stay ordered.
 * The computed path is classified before anything is written (plan §2.2 —
 * see assertRunLogPathArtifactSafe).
 */
export async function writeRunLog(
  taskFolderUri: vscode.Uri,
  runnerId: string,
  stage: AgentWorkflowStage,
  content: string
): Promise<vscode.Uri> {
  const runsUri = await ensureRunsDirectory(taskFolderUri);
  const runNumber = await getNextRunNumber(runsUri);
  const paddedNumber = String(runNumber).padStart(3, "0");
  const fileName = `${paddedNumber}-${runnerId}-${stage}.md`;
  assertRunLogPathArtifactSafe(fileName);

  const logUri = vscode.Uri.joinPath(runsUri, fileName);
  await vscode.workspace.fs.writeFile(
    logUri,
    new TextEncoder().encode(content)
  );

  return logUri;
}
