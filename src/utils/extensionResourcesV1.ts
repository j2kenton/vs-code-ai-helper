import * as vscode from "vscode";

/** The message shown when this window's own extension folder has been removed. */
export const EXTENSION_FOLDER_REMOVED_MESSAGE_V1 =
  "Ensemble was updated in another window. Reload this window (Developer: Reload Window) to continue.";

/**
 * Thrown when one of Ensemble's own files cannot be read because the
 * extension's folder no longer exists — the window is still running code from
 * a version another window has since replaced. Callers stop before any model
 * call or task change, report the action as not started, and show
 * {@link EXTENSION_FOLDER_REMOVED_MESSAGE_V1}. Carries no file path.
 */
export class ExtensionFolderRemovedErrorV1 extends Error {
  constructor() {
    super(EXTENSION_FOLDER_REMOVED_MESSAGE_V1);
    this.name = "ExtensionFolderRemovedErrorV1";
  }
}

export function isExtensionFolderRemovedErrorV1(error: unknown): error is ExtensionFolderRemovedErrorV1 {
  return error instanceof ExtensionFolderRemovedErrorV1;
}

/** True only for a missing individual resource; callers may keep file-level fallbacks for this case. */
export function isExtensionResourceMissingErrorV1(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return code === "FileNotFound" || code === "ENOENT" || name === "FileNotFound" || name === "NotFound";
}

/**
 * Reads one of the extension's own files (`resources/...`). On a failed read,
 * stats the extension root: if the root itself is gone, throws
 * {@link ExtensionFolderRemovedErrorV1}; otherwise rethrows the original error
 * (a single missing file keeps its existing handling). One stat, no retry,
 * wait or lock.
 */
export async function readExtensionResourceV1(
  extensionUri: vscode.Uri,
  segments: readonly string[]
): Promise<Uint8Array> {
  try {
    return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, ...segments));
  } catch (error) {
    if (await extensionRootIsGoneV1(extensionUri)) {
      throw new ExtensionFolderRemovedErrorV1();
    }
    throw error;
  }
}

async function extensionRootIsGoneV1(extensionUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(extensionUri);
    return false;
  } catch (error) {
    // An inaccessible root is not evidence that an update removed it. Keep
    // the original resource-read error unless stat specifically reports a
    // missing path; otherwise the user would get a misleading reload prompt.
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const name = error !== null && typeof error === "object" && "name" in error ? String(error.name) : "";
    const message = error instanceof Error ? error.message : String(error);
    return code === "FileNotFound" || code === "ENOENT" || name === "FileNotFound" || /\bENOENT\b/.test(message);
  }
}
