import * as vscode from "vscode";
import * as path from "path";

/** The single, user-visible previous version kept for an artifact. */
export function previousVersionUri(fileUri: vscode.Uri): vscode.Uri {
  const parsed = path.parse(fileUri.fsPath);
  // Keep the artifact's extension so the backup opens with the same VS Code
  // language mode and remains easy to recognize beside its source file.
  return vscode.Uri.file(
    path.join(parsed.dir, `${parsed.name}_prev${parsed.ext}`)
  );
}

/**
 * Store a known pre-write snapshot. This is used for open editors, where the
 * in-memory document can be newer than the version currently on disk.
 */
export async function backupArtifactContents(
  fileUri: vscode.Uri,
  contents: Uint8Array
): Promise<void> {
  await vscode.workspace.fs.writeFile(previousVersionUri(fileUri), contents);
}

/**
 * Preserve the current artifact before replacing it. Missing files deliberately
 * produce no backup: the first generated version has no previous version.
 */
export async function backupArtifactBeforeWrite(fileUri: vscode.Uri): Promise<void> {
  try {
    const contents = await vscode.workspace.fs.readFile(fileUri);
    await backupArtifactContents(fileUri, contents);
  } catch {
    // The artifact does not yet exist (or cannot be read); let the actual
    // write surface any real error rather than masking it here.
  }
}

export async function hasPreviousVersion(fileUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(previousVersionUri(fileUri));
    return true;
  } catch {
    return false;
  }
}
