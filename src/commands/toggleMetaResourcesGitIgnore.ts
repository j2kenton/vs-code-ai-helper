import * as vscode from "vscode";
import * as path from "path";
import { getMetaResourcesPath } from "../config/settings";

/**
 * Validates and normalizes the meta resources path.
 * Returns the normalized safe path if valid, otherwise undefined.
 */
function validateAndNormalizePath(metaPath: string): string | undefined {
  if (!metaPath || metaPath.trim() === "") {
    return undefined;
  }

  if (path.isAbsolute(metaPath)) {
    return undefined;
  }

  // Normalize and check for path traversal
  const normalized = path.normalize(metaPath);
  if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
    return undefined;
  }

  // Reject "." or paths that normalize to workspace root
  // Handle both "." and variations with trailing separators
  const withoutTrailingSep = normalized.endsWith(path.sep)
    ? normalized.slice(0, -path.sep.length)
    : normalized;

  if (withoutTrailingSep === "." || withoutTrailingSep === "") {
    return undefined;
  }

  return normalized;
}

/**
 * Toggle the meta resources folder in .gitignore.
 * Adds or removes the path from .gitignore in the correct workspace root.
 *
 * For multi-root workspaces, this command determines the workspace folder
 * containing the meta resources folder and updates that folder's .gitignore.
 */
export async function toggleMetaResourcesGitIgnore(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showErrorMessage("No workspace folder is open.");
    return;
  }

  const metaResourcesPath = getMetaResourcesPath();

  // Validate and normalize the path
  const normalizedPath = validateAndNormalizePath(metaResourcesPath);
  if (!normalizedPath) {
    void vscode.window.showErrorMessage(
      `Cannot add meta resources path to .gitignore: "${metaResourcesPath}" is not a valid relative path. ` +
      `Please configure a safe relative path in the AI Helper settings.`
    );
    return;
  }

  // Normalize path separators for gitignore (always use /)
  const gitignorePath = normalizedPath.replace(/\\/g, "/");

  // Find the workspace folder containing the meta resources folder.
  // For single-root workspaces, this is always workspaceFolders[0].
  // For multi-root workspaces, check which workspace contains the meta resources folder.
  let targetWorkspaceFolder: vscode.WorkspaceFolder | undefined = workspaceFolders[0];

  if (workspaceFolders.length > 1) {
    // Check if meta resources folder exists under any workspace
    let foundFolder: vscode.WorkspaceFolder | undefined;

    for (const folder of workspaceFolders) {
      const metaFolderPath = path.join(folder.uri.fsPath, normalizedPath);
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(metaFolderPath));
        if (stat.type === vscode.FileType.Directory) {
          foundFolder = folder;
          break;
        }
      } catch {
        // Folder doesn't exist in this workspace, continue
      }
    }

    if (!foundFolder) {
      // Meta resources folder doesn't exist yet — ask user which workspace to use
      const choices = workspaceFolders.map(f => ({
        label: path.basename(f.uri.fsPath),
        description: f.uri.fsPath,
        folder: f
      }));

      const selected = await vscode.window.showQuickPick(choices, {
        placeHolder: "Select workspace folder for meta resources .gitignore entry",
        ignoreFocusOut: false
      });

      if (!selected) {
        void vscode.window.showInformationMessage("Toggle cancelled.");
        return;
      }

      targetWorkspaceFolder = selected.folder;
    } else {
      targetWorkspaceFolder = foundFolder;
    }
  }

  if (!targetWorkspaceFolder) {
    void vscode.window.showErrorMessage("Could not determine target workspace folder.");
    return;
  }

  const workspaceRoot = targetWorkspaceFolder.uri.fsPath;
  const gitignoreFilePath = path.join(workspaceRoot, ".gitignore");
  const gitignoreUri = vscode.Uri.file(gitignoreFilePath);

  try {
    // Read existing .gitignore or create empty
    let content = "";
    try {
      const fileContent = await vscode.workspace.fs.readFile(gitignoreUri);
      content = new TextDecoder().decode(fileContent);
    } catch {
      // File doesn't exist, will create new one
    }

    const lines = content.split(/\r?\n/);
    const metaResourcesEntry = `/${gitignorePath}`;
    const commentEntry = `# AI Helper meta resources`;

    // Check if already in gitignore
    const hasEntry = lines.some((line) => line.trim() === metaResourcesEntry);

    if (hasEntry) {
      // Remove from gitignore
      const newLines = lines.filter(
        (line) =>
          line.trim() !== metaResourcesEntry && line.trim() !== commentEntry
      );
      const newContent = newLines.join("\n");
      await vscode.workspace.fs.writeFile(
        gitignoreUri,
        new TextEncoder().encode(newContent)
      );
      void vscode.window.showInformationMessage(
        `Meta resources folder (${gitignorePath}) is now visible in git.`
      );
    } else {
      // Add to gitignore
      const newLines = [...lines];
      if (newLines.length > 0 && newLines[newLines.length - 1]?.trim() !== "") {
        newLines.push(""); // Add blank line before comment
      }
      newLines.push(commentEntry);
      newLines.push(metaResourcesEntry);
      const newContent = newLines.join("\n");
      await vscode.workspace.fs.writeFile(
        gitignoreUri,
        new TextEncoder().encode(newContent)
      );
      void vscode.window.showInformationMessage(
        `Meta resources folder (${gitignorePath}) is now hidden from git.`
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Failed to update .gitignore: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Register the toggleMetaResourcesGitIgnore command.
 */
export function registerToggleMetaResourcesGitIgnoreCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.toggleMetaResourcesGitIgnore",
    () => toggleMetaResourcesGitIgnore()
  );
  context.subscriptions.push(disposable);
}
