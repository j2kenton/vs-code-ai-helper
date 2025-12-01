import * as vscode from "vscode";
import { setMetaResourcesPath } from "../config/settings";

/**
 * Opens a folder picker dialog scoped to the workspace and saves the selected path.
 * Returns the selected path, or undefined if cancelled.
 */
export async function selectMetaFolder(): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const workspaceRoot = workspaceFolders[0];
  if (!workspaceRoot) {
    return undefined;
  }

  const selectedFolders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: workspaceRoot.uri,
    openLabel: "Select Meta Resources Folder",
    title: "Select folder for AI Helper meta resources",
  });

  if (!selectedFolders || selectedFolders.length === 0) {
    return undefined;
  }

  const selectedUri = selectedFolders[0];
  if (!selectedUri) {
    return undefined;
  }

  // Convert to relative path if within workspace
  const relativePath = vscode.workspace.asRelativePath(selectedUri, false);

  await setMetaResourcesPath(relativePath);

  void vscode.window.showInformationMessage(
    `Meta resources folder set to: ${relativePath}`
  );

  return relativePath;
}

/**
 * Register the selectMetaFolder command
 */
export function registerSelectMetaFolderCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.selectMetaFolder",
    selectMetaFolder
  );

  context.subscriptions.push(disposable);
}
