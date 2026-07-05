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
 * Per-file and total caps applied when embedding open-file contents in the
 * context pack (used by implementation reviews), so a workspace full of
 * open editors can't produce an oversized prompt.
 */
const MAX_CHARS_PER_FILE = 8000;
const MAX_TOTAL_CONTENT_CHARS = 60000;

/**
 * Generate context-pack.md for a task folder: the user request from
 * task.md, the workspace root, and the list of currently open editors
 * that belong to this workspace. This is an explicit, reviewable
 * selection of context, not a full repository dump.
 *
 * When `includeFileContents` is true (used by implementation reviews, which
 * must assess actual code), each open editor's content is embedded in a
 * fenced block, capped per file and in total.
 */
export async function generateContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  includeFileContents = false
): Promise<string> {
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  const taskContent = await readTextFileIfExists(taskFileUri);

  const openDocs = vscode.workspace.textDocuments.filter(
    (doc) =>
      doc.uri.scheme === "file" && isInsideWorkspace(doc.uri, workspaceUri)
  );
  const seenPaths = new Set<string>();
  const uniqueDocs = openDocs.filter((doc) => {
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);
    if (seenPaths.has(relPath)) {
      return false;
    }
    seenPaths.add(relPath);
    return true;
  });

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
  if (uniqueDocs.length > 0) {
    for (const doc of uniqueDocs) {
      lines.push(`- ${vscode.workspace.asRelativePath(doc.uri, false)}`);
    }
  } else {
    lines.push("_No open editors._");
  }
  lines.push("");

  if (includeFileContents && uniqueDocs.length > 0) {
    lines.push("## Open Editor Contents");
    lines.push("");
    let totalChars = 0;
    for (const doc of uniqueDocs) {
      if (totalChars >= MAX_TOTAL_CONTENT_CHARS) {
        lines.push(
          "_Further open files omitted: total content size limit reached._"
        );
        lines.push("");
        break;
      }
      const relPath = vscode.workspace.asRelativePath(doc.uri, false);
      let text = doc.getText();
      let truncated = false;
      if (text.length > MAX_CHARS_PER_FILE) {
        text = text.slice(0, MAX_CHARS_PER_FILE);
        truncated = true;
      }
      if (totalChars + text.length > MAX_TOTAL_CONTENT_CHARS) {
        text = text.slice(0, MAX_TOTAL_CONTENT_CHARS - totalChars);
        truncated = true;
      }
      totalChars += text.length;
      lines.push(`### ${relPath}${truncated ? " (truncated)" : ""}`);
      lines.push("");
      lines.push("```");
      lines.push(text);
      lines.push("```");
      lines.push("");
    }
  }

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
  workspaceUri: vscode.Uri,
  includeFileContents = false
): Promise<vscode.Uri> {
  const contextPackUri = vscode.Uri.joinPath(
    taskFolderUri,
    CONTEXT_PACK_FILENAME
  );
  const content = await generateContextPack(
    taskFolderUri,
    workspaceUri,
    includeFileContents
  );
  await vscode.workspace.fs.writeFile(
    contextPackUri,
    new TextEncoder().encode(content)
  );
  return contextPackUri;
}
