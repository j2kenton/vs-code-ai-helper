import * as vscode from "vscode";
import { PLAN_FILENAME } from "../types/taskProgress";

/**
 * Read a text file's content, or undefined if it doesn't exist.
 */
export async function readTextIfExists(
  fileUri: vscode.Uri
): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(fileUri);
    return new TextDecoder().decode(content);
  } catch {
    return undefined;
  }
}

/**
 * Read a text file's trimmed content, or undefined if it doesn't exist or
 * is empty/whitespace-only.
 */
export async function readNonEmptyText(
  fileUri: vscode.Uri
): Promise<string | undefined> {
  const content = await readTextIfExists(fileUri);
  const trimmed = content?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Stat a file, or undefined if it doesn't exist.
 */
export async function statIfExists(
  fileUri: vscode.Uri
): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(fileUri);
  } catch {
    return undefined;
  }
}

/**
 * Open a document in the editor, creating it empty first if it doesn't
 * exist.
 */
export async function openOrCreateDocument(
  fileUri: vscode.Uri,
  initialContent = ""
): Promise<void> {
  const existing = await statIfExists(fileUri);
  if (!existing) {
    await vscode.workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(initialContent)
    );
  }
  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
}

/**
 * Resolve the URI holding the task's CURRENT plan text.
 *
 * The current pipeline keeps a single plan.md that is revised in place, but
 * tasks created before 0.6.0 may have their latest revision in
 * plan-updated.md. That file wins only while it is newer than plan.md —
 * the first in-place update to plan.md takes over from then on.
 */
export async function resolveCurrentPlanUri(
  taskFolderUri: vscode.Uri
): Promise<vscode.Uri> {
  const planUri = vscode.Uri.joinPath(taskFolderUri, PLAN_FILENAME);
  const legacyUpdatedUri = vscode.Uri.joinPath(
    taskFolderUri,
    "plan-updated.md"
  );

  const [planStat, legacyStat, legacyContent] = await Promise.all([
    statIfExists(planUri),
    statIfExists(legacyUpdatedUri),
    readNonEmptyText(legacyUpdatedUri),
  ]);

  if (
    legacyStat &&
    legacyContent &&
    (!planStat || legacyStat.mtime > planStat.mtime)
  ) {
    return legacyUpdatedUri;
  }
  return planUri;
}
