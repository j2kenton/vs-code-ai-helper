import * as vscode from "vscode";
import { createHash } from "crypto";

/**
 * Durable, crash-recoverable sidecar recording which side of the
 * artifact/`_prev`-backup swap an artifact currently sits on, so the tree can
 * offer "Redo Changes" (undo the last revert) across a window reload/crash.
 *
 * The sidecar is a small JSON file written beside the artifact, versioned,
 * and fingerprinted so a swap can revalidate that the on-disk files still
 * match what the sidecar expects immediately before performing another swap.
 *
 * A missing or unparseable/unknown-version sidecar is treated as the safe
 * default: "applied" (redo not available, only revert) — this matches the
 * pre-existing behavior for artifacts that predate this file.
 */

export const REDO_SIDECAR_SUFFIX = "._redo.json";

export type RedoDirection = "applied" | "reverted";

export interface RedoSidecarRecord {
  version: 1;
  /**
   * "applied" — the artifact holds its normal (most-recently-generated)
   * content; no redo is available (only revert, if a backup exists).
   * "reverted" — the artifact currently holds the content of its `_prev`
   * backup as the result of a revert (or an undone redo); Redo Changes can
   * restore the content that the revert replaced.
   */
  direction: RedoDirection;
  /** SHA-256 hex digest of the artifact's current expected content. */
  artifactFingerprint: string;
  /** SHA-256 hex digest of the `_prev` backup's current expected content. */
  backupFingerprint: string;
}

/** Minimal file-system seam so this is unit-testable like artifactRevertJournal.ts. */
export interface RedoSidecarFs {
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  delete(uri: vscode.Uri, options?: { useTrash?: boolean }): Thenable<void>;
}

const defaultFs = (): RedoSidecarFs => vscode.workspace.fs;

export function redoSidecarUri(artifact: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(artifact.fsPath + REDO_SIDECAR_SUFFIX);
}

/** Cheap content fingerprint used to detect out-of-band edits before a swap. */
export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseRedoSidecar(bytes: Uint8Array): RedoSidecarRecord | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RedoSidecarRecord>;
    if (
      parsed?.version === 1 &&
      (parsed.direction === "applied" || parsed.direction === "reverted") &&
      typeof parsed.artifactFingerprint === "string" &&
      typeof parsed.backupFingerprint === "string"
    ) {
      return {
        version: 1,
        direction: parsed.direction,
        artifactFingerprint: parsed.artifactFingerprint,
        backupFingerprint: parsed.backupFingerprint,
      };
    }
  } catch {
    // Fall through — unparseable, treated as absent by the caller.
  }
  return undefined;
}

/**
 * Read the redo sidecar for an artifact. Missing, unparseable, or
 * unknown-version content all resolve to `undefined` — callers must treat
 * that the same as an explicit "applied" (no redo available).
 */
export async function readRedoSidecar(
  artifact: vscode.Uri,
  fs: RedoSidecarFs = defaultFs()
): Promise<RedoSidecarRecord | undefined> {
  try {
    return parseRedoSidecar(await fs.readFile(redoSidecarUri(artifact)));
  } catch {
    return undefined;
  }
}

export async function writeRedoSidecar(
  artifact: vscode.Uri,
  record: RedoSidecarRecord,
  fs: RedoSidecarFs = defaultFs()
): Promise<void> {
  await fs.writeFile(redoSidecarUri(artifact), new TextEncoder().encode(JSON.stringify(record)));
}

/** Best-effort delete; a missing sidecar is not an error. */
export async function deleteRedoSidecar(
  artifact: vscode.Uri,
  fs: RedoSidecarFs = defaultFs()
): Promise<void> {
  try {
    await fs.delete(redoSidecarUri(artifact), { useTrash: false });
  } catch {
    // Nothing to delete, or delete failed — either way there is nothing more
    // to do here; a stale sidecar is caught by fingerprint revalidation.
  }
}

/** Whether a redo (undo of the last revert) is available per the sidecar. */
export function isRedoAvailableFromRecord(record: RedoSidecarRecord | undefined): boolean {
  return record?.direction === "reverted";
}

/**
 * Whether a revert is available per the sidecar. Symmetric counterpart to
 * `isRedoAvailableFromRecord` — a missing/unknown record defaults to
 * "applied" (revert available), matching the pre-existing behavior for
 * artifacts that predate this file. When a record explicitly says
 * "reverted", the artifact is already on the reverted side and Revert
 * Changes must not run again (that would silently perform a redo under the
 * Revert label).
 */
export function isRevertAvailableFromRecord(record: RedoSidecarRecord | undefined): boolean {
  return record === undefined || record.direction === "applied";
}
