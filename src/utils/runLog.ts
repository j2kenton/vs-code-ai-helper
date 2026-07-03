import * as vscode from "vscode";
import { RUNS_DIRNAME } from "../types/taskProgress";
import { AgentWorkflowStage } from "../types/agentRunner";

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
 * Write a run log file under runs/ named "NNN-<runnerId>-<stage>.md" and
 * return its URI. Numbers increment per task folder so logs stay ordered.
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
  const logUri = vscode.Uri.joinPath(runsUri, fileName);

  await vscode.workspace.fs.writeFile(
    logUri,
    new TextEncoder().encode(content)
  );

  return logUri;
}
