import * as vscode from "vscode";
import { CONTEXT_PACK_FILENAME, TASK_FILENAME } from "../types/taskProgress";

/**
 * Read a text file, returning undefined if it does not exist or is empty.
 */
async function readTextFileIfExists(
  fileUri: vscode.Uri
): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(content).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True if fileUri is located inside workspaceUri. Used to keep files from
 * unrelated open editors (e.g. from a different workspace/folder) out of
 * the context pack sent to the AI provider.
 */
function isInsideWorkspace(
  fileUri: vscode.Uri,
  workspaceUri: vscode.Uri
): boolean {
  const workspacePath = workspaceUri.fsPath.replace(/[/\\]+$/, "");
  const filePath = fileUri.fsPath;
  return (
    filePath === workspacePath ||
    filePath.startsWith(workspacePath + "/") ||
    filePath.startsWith(workspacePath + "\\")
  );
}

/**
 * Generate context-pack.md for a task folder: the user request from
 * task.md, the workspace root, and the list of currently open editors
 * that belong to this workspace. This is an explicit, reviewable
 * selection of context, not a full repository dump.
 */
export async function generateContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri
): Promise<string> {
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  const taskContent = await readTextFileIfExists(taskFileUri);

  const openFiles = vscode.workspace.textDocuments
    .filter(
      (doc) =>
        doc.uri.scheme === "file" && isInsideWorkspace(doc.uri, workspaceUri)
    )
    .map((doc) => vscode.workspace.asRelativePath(doc.uri, false));
  const uniqueOpenFiles = Array.from(new Set(openFiles));

  const lines: string[] = [];
  lines.push("# Context Pack");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Workspace Root");
  lines.push("");
  lines.push(vscode.workspace.asRelativePath(workspaceUri, false) || ".");
  lines.push("");
  lines.push("## User Request");
  lines.push("");
  lines.push(taskContent ?? "_No task.md content found._");
  lines.push("");
  lines.push("## Open Editors");
  lines.push("");
  if (uniqueOpenFiles.length > 0) {
    for (const file of uniqueOpenFiles) {
      lines.push(`- ${file}`);
    }
  } else {
    lines.push("_No open editors._");
  }
  lines.push("");
  lines.push("## Constraints");
  lines.push("");
  lines.push("- Do not refactor unrelated files.");
  lines.push("- Keep changes scoped to the request above.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Write context-pack.md to the task folder and return its URI.
 */
export async function writeContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri
): Promise<vscode.Uri> {
  const contextPackUri = vscode.Uri.joinPath(
    taskFolderUri,
    CONTEXT_PACK_FILENAME
  );
  const content = await generateContextPack(taskFolderUri, workspaceUri);
  await vscode.workspace.fs.writeFile(
    contextPackUri,
    new TextEncoder().encode(content)
  );
  return contextPackUri;
}
