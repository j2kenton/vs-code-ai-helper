import * as vscode from "vscode";
import { createHash } from "crypto";
import {
  RedoDirection,
  RedoSidecarFs,
  fingerprintBytes,
  writeRedoSidecar,
} from "./redoSidecar";

/**
 * Journal-backed revert swap for stage artifacts.
 *
 * Reverting swaps the artifact with its `_prev` backup (so a revert is itself
 * revertible), but the swap touches two files and a crash between the writes
 * would otherwise leave them inconsistent — worst case the same content in
 * both, losing one version permanently. The journal closes that window:
 *
 *  1. Before either file is touched, a journal file beside the artifact
 *     records the intended post-swap content of BOTH files.
 *  2. The two writes are applied.
 *  3. The journal is deleted.
 *
 * Re-applying the journal is idempotent, so recovery (on the next extension
 * activation — see recoverRevertJournals) simply re-applies whatever journals
 * it finds and deletes them. An unparseable journal is quarantined by
 * deletion without touching the artifact, since its targets are unknowable.
 */

export const REVERT_JOURNAL_SUFFIX = "_revert-journal.json";

export interface RevertJournalRecord {
  version: 1;
  /** Absolute path of the artifact file (post-swap content in artifactContent). */
  artifactPath: string;
  /** Absolute path of the previous-version backup file. */
  backupPath: string;
  /** Base64 post-swap artifact content (= the old backup content). */
  artifactContent: string;
  /** Base64 post-swap backup content (= the old artifact content). */
  backupContent: string;
  /** ISO timestamp of when the journal was written. */
  createdAt: string;
  /** SHA-256 hex digest of the decoded artifactContent (journal integrity). */
  artifactSha256: string;
  /** SHA-256 hex digest of the decoded backupContent (journal integrity). */
  backupSha256: string;
  /**
   * Intended post-swap redo-sidecar direction ("reverted" for a Revert
   * Changes swap, "applied" for a Redo Changes swap). Recorded so that if the
   * extension crashes between the file swap and the sidecar write, activation
   * recovery (recoverRevertJournal) can finalize the sidecar to match
   * whatever state the swap actually left the files in. Absent on legacy
   * journals written before the sidecar existed — those are left without a
   * sidecar action, matching the safe "applied" default.
   */
  direction?: RedoDirection;
}

/** Minimal file-system seam so the swap/recovery logic is unit-testable. */
export interface RevertJournalFs {
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  delete(uri: vscode.Uri, options?: { useTrash?: boolean }): Thenable<void>;
}

const defaultFs = (): RevertJournalFs => vscode.workspace.fs;

/**
 * True when the file is open in an editor with unsaved changes. Recovery must
 * never write to disk beneath a dirty editor: the write would be invisible in
 * the buffer, and the user's next save would overwrite the recovered content
 * with stale buffer content — silently losing the recovered version.
 */
function defaultIsDirtyDocument(target: vscode.Uri): boolean {
  try {
    return vscode.workspace.textDocuments.some(
      (doc) => doc.uri.fsPath === target.fsPath && doc.isDirty
    );
  } catch {
    return false; // No editor host (tests) — nothing can be dirty.
  }
}

/**
 * Thrown by a `writeArtifact` callback when the artifact (or its open editor
 * buffer) may already reflect the swap even though the write path failed.
 * `performJournaledRevertSwap` must then KEEP the journal so activation-time
 * recovery completes the swap — deleting it would leave the two files (or
 * the buffer and the backup) able to converge on the same content, losing a
 * version permanently.
 */
export class RevertArtifactMutatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevertArtifactMutatedError";
  }
}

export function revertJournalUri(artifact: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(artifact.fsPath + REVERT_JOURNAL_SUFFIX);
}

function encodeRecord(record: RevertJournalRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseRevertJournal(bytes: Uint8Array): RevertJournalRecord | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RevertJournalRecord>;
    if (
      parsed?.version === 1 &&
      typeof parsed.artifactPath === "string" &&
      typeof parsed.backupPath === "string" &&
      typeof parsed.artifactContent === "string" &&
      typeof parsed.backupContent === "string"
    ) {
      // Integrity: when the record carries content hashes (every journal
      // written since they were added), the decoded content must match them
      // — a journal whose payload doesn't hash to its own digests is corrupt
      // and its targets unknowable, so it is treated as unparseable.
      const artifactSha = sha256Hex(Buffer.from(parsed.artifactContent, "base64"));
      const backupSha = sha256Hex(Buffer.from(parsed.backupContent, "base64"));
      if (
        (typeof parsed.artifactSha256 === "string" && parsed.artifactSha256 !== artifactSha) ||
        (typeof parsed.backupSha256 === "string" && parsed.backupSha256 !== backupSha)
      ) {
        return undefined;
      }
      return {
        version: 1,
        artifactPath: parsed.artifactPath,
        backupPath: parsed.backupPath,
        artifactContent: parsed.artifactContent,
        backupContent: parsed.backupContent,
        // Legacy journals (pre-hash) get computed digests and an epoch
        // timestamp so the rest of recovery can rely on the fields existing.
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
        artifactSha256: artifactSha,
        backupSha256: backupSha,
        direction: parsed.direction === "applied" || parsed.direction === "reverted" ? parsed.direction : undefined,
      };
    }
  } catch {
    // Fall through — unknowable targets, caller quarantines by deletion.
  }
  return undefined;
}

/**
 * Swap `artifact` with its backup under journal protection. `previousBytes`
 * and `currentBytes` are the pre-read contents of the backup and the
 * artifact; `writeArtifact` lets the caller route the artifact write through
 * a WorkspaceEdit when the file is open in an editor (the backup file is
 * always written through the file system).
 */
/**
 * Result of `performJournaledRevertSwap`. The file swap itself either lands
 * completely or throws — `sidecarFinalized` separately reports whether the
 * durable redo-direction sidecar was written to match it in THIS call.
 *
 * When `sidecarFinalized` is false, the swap succeeded but the sidecar write
 * failed: the journal was deliberately kept (see below) so the next
 * activation's recovery finalizes it, but the CURRENT session's sidecar read
 * (e.g. contextTokens.ts, viewStageChanges.ts's pre-swap revalidation) still
 * reflects the PRE-swap direction until then. Callers must not tell the user
 * the swap is fully done (in particular, must not claim the opposite action
 * — e.g. "Redo Changes" — is now available) when this is false.
 */
export interface JournaledRevertSwapResult {
  sidecarFinalized: boolean;
}

export async function performJournaledRevertSwap(
  artifact: vscode.Uri,
  backup: vscode.Uri,
  currentBytes: Uint8Array,
  previousBytes: Uint8Array,
  writeArtifact: (content: Uint8Array) => Promise<void>,
  fs: RevertJournalFs = defaultFs(),
  /**
   * Intended post-swap redo-sidecar direction: "reverted" for Revert
   * Changes, "applied" for Redo Changes. Recorded in the journal itself (so
   * crash recovery can finalize the sidecar) and written to the sidecar
   * right after the swap lands, before the journal is deleted.
   */
  direction?: RedoDirection,
  sidecarFs: RedoSidecarFs = fs
): Promise<JournaledRevertSwapResult> {
  const journal = revertJournalUri(artifact);
  const record: RevertJournalRecord = {
    version: 1,
    artifactPath: artifact.fsPath,
    backupPath: backup.fsPath,
    artifactContent: Buffer.from(previousBytes).toString("base64"),
    backupContent: Buffer.from(currentBytes).toString("base64"),
    createdAt: new Date().toISOString(),
    artifactSha256: sha256Hex(previousBytes),
    backupSha256: sha256Hex(currentBytes),
    direction,
  };
  await fs.writeFile(journal, encodeRecord(record));
  try {
    await writeArtifact(previousBytes);
  } catch (error) {
    if (error instanceof RevertArtifactMutatedError) {
      // The artifact (or its editor buffer) may already carry the swapped
      // content — keep the journal so recovery finishes the swap on the
      // next activation instead of letting the two files diverge.
      throw error;
    }
    // The artifact write failed before mutating anything, so nothing was
    // swapped — remove the journal so a later recovery doesn't apply a swap
    // the user was told did not happen.
    try {
      await fs.delete(journal, { useTrash: false });
    } catch { /* best effort */ }
    throw error;
  }
  await fs.writeFile(backup, currentBytes);
  if (direction) {
    // Write the sidecar to reflect the post-swap state BEFORE the journal is
    // deleted: if the process dies between these two writes, the journal is
    // still on disk and activation-time recovery (recoverRevertJournal) will
    // finalize the sidecar to match the files' actual resulting content.
    try {
      await writeRedoSidecar(
        artifact,
        {
          version: 1,
          direction,
          artifactFingerprint: fingerprintBytes(previousBytes),
          backupFingerprint: fingerprintBytes(currentBytes),
        },
        sidecarFs
      );
    } catch {
      // The swap itself landed, but the sidecar write failed — do NOT delete
      // the journal. Leaving it in place means the next activation's
      // recoverRevertJournal call finds the artifact already at its
      // post-swap content and finalizes the sidecar then (see
      // finalizeRedoSidecarFromRecord), instead of silently losing the
      // durable redo direction. Report this back to the caller instead of
      // returning as if fully successful — it must not tell the user the
      // opposite action is now available until the sidecar actually reflects it.
      return { sidecarFinalized: false };
    }
  }
  await fs.delete(journal, { useTrash: false });
  return { sidecarFinalized: true };
}

/**
 * What the user (or a policy) chose for a journal that needs a decision.
 * "defer" (e.g. a dismissed prompt) leaves the journal in place so a later
 * activation asks again.
 */
export type RevertRecoveryDecision = "restore" | "keep" | "defer";

/**
 * Context handed to the recovery decision callback when completing a journal
 * requires user input rather than being unambiguously safe.
 */
export interface RevertRecoveryPrompt {
  artifactPath: string;
  /**
   * True when the artifact's current content matches neither side of the
   * journaled swap — the file changed after the interruption, so restoring
   * would overwrite content the journal never saw.
   */
  artifactDiverged: boolean;
  /**
   * True when the backup file's current content matches neither side of the
   * journaled swap — completing the swap would overwrite backup content the
   * journal never saw.
   */
  backupDiverged: boolean;
  /** ISO timestamp of when the interrupted revert was started. */
  createdAt: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Validate one journal against the artifact's current content, then complete
 * or discard it. Returns true when the swap was (re-)applied.
 *
 * Content validation (artifact AND backup are both checked against the
 * journal's recorded contents, whose integrity is hash-verified at parse
 * time) decides the path:
 *  - artifact already equals the post-swap content and the backup is one of
 *    the two journaled states → the artifact write completed before the
 *    crash; silently finish the backup write (NOT finishing it would leave
 *    both files holding the same version).
 *  - artifact still equals the pre-swap content → nothing was applied; both
 *    files are consistent, so ask `decide` whether to restore (complete the
 *    confirmed revert) or keep the current files (drop the journal).
 *  - artifact or backup matches neither journaled state → it changed after
 *    the interruption; never overwrite silently — ask `decide`, flagged as
 *    diverged.
 *
 * Without a `decide` callback the ambiguous cases default to "restore",
 * matching the journal's recorded intent.
 *
 * Dirty-editor guard: when either target file is open in an editor with
 * unsaved changes, recovery DEFERS outright (journal retained, nothing
 * written, no prompt). Writing to disk beneath a dirty editor would let the
 * user's next save restore stale buffer content over the recovered version;
 * a later activation (with the buffer saved or closed) retries the journal.
 */
export async function recoverRevertJournal(
  journal: vscode.Uri,
  fs: RevertJournalFs = defaultFs(),
  decide?: (prompt: RevertRecoveryPrompt) => Promise<RevertRecoveryDecision>,
  isDirtyDocument: (target: vscode.Uri) => boolean = defaultIsDirtyDocument
): Promise<boolean> {
  let record: RevertJournalRecord | undefined;
  try {
    record = parseRevertJournal(await fs.readFile(journal));
  } catch {
    return false; // Journal vanished between discovery and read.
  }
  if (!record) {
    // Unparseable: targets unknowable, remove so it doesn't resurface forever.
    try {
      await fs.delete(journal, { useTrash: false });
    } catch { /* best effort */ }
    return false;
  }
  const artifactUri = vscode.Uri.file(record.artifactPath);
  if (isDirtyDocument(artifactUri) || isDirtyDocument(vscode.Uri.file(record.backupPath))) {
    // A target is open with unsaved changes — defer, never write beneath a
    // dirty editor (see the doc comment above).
    return false;
  }
  const postSwapArtifact = Buffer.from(record.artifactContent, "base64");
  const preSwapArtifact = Buffer.from(record.backupContent, "base64");
  let current: Uint8Array | undefined;
  try {
    current = await fs.readFile(artifactUri);
  } catch {
    current = undefined; // Missing artifact: restoring recreates it.
  }
  // Backup divergence: the journaled swap expects the backup to hold either
  // its pre-swap content (= postSwapArtifact) or its post-swap content
  // (= preSwapArtifact). Anything else means the backup changed after the
  // interruption and completing the swap would overwrite content the journal
  // never saw — never do that silently.
  let backupCurrent: Uint8Array | undefined;
  try {
    backupCurrent = await fs.readFile(vscode.Uri.file(record.backupPath));
  } catch {
    backupCurrent = undefined; // Missing backup: completing recreates it.
  }
  const backupDiverged =
    backupCurrent !== undefined &&
    !bytesEqual(backupCurrent, postSwapArtifact) &&
    !bytesEqual(backupCurrent, preSwapArtifact);
  if (current && bytesEqual(current, postSwapArtifact) && !backupDiverged) {
    // Artifact write already landed and the backup is one of the journaled
    // states — only the backup write is outstanding; finish it silently
    // (NOT finishing would leave both files holding the same version).
    await fs.writeFile(vscode.Uri.file(record.backupPath), preSwapArtifact);
    if (!(await finalizeRedoSidecarFromRecord(record, postSwapArtifact, preSwapArtifact, fs))) {
      // Sidecar write failed again — keep the journal so a later activation
      // retries finalizing it instead of silently losing the direction.
      return false;
    }
    await fs.delete(journal, { useTrash: false });
    return true;
  }
  const artifactDiverged =
    current !== undefined &&
    !bytesEqual(current, preSwapArtifact) &&
    !bytesEqual(current, postSwapArtifact);
  const decision: RevertRecoveryDecision = decide
    ? await decide({
        artifactPath: record.artifactPath,
        artifactDiverged,
        backupDiverged,
        createdAt: record.createdAt,
      })
    : "restore";
  if (decision === "defer") {
    return false; // Journal retained — a later activation asks again.
  }
  if (decision === "keep") {
    await fs.delete(journal, { useTrash: false });
    return false;
  }
  await fs.writeFile(artifactUri, postSwapArtifact);
  await fs.writeFile(vscode.Uri.file(record.backupPath), preSwapArtifact);
  if (!(await finalizeRedoSidecarFromRecord(record, postSwapArtifact, preSwapArtifact, fs))) {
    // Sidecar write failed — keep the journal so a later activation retries
    // finalizing it instead of silently losing the direction.
    return false;
  }
  await fs.delete(journal, { useTrash: false });
  return true;
}

/**
 * Crash recovery: finalize the redo sidecar to match whatever state a
 * recovered swap actually left the files in. Only acts when the journal
 * carries a `direction` (all journals written since the sidecar was added);
 * legacy journals are left without a sidecar action, which safely defaults
 * to "applied" (no redo offered) on next read.
 */
/**
 * Returns true when the sidecar was finalized (or there was nothing to
 * finalize — a legacy journal with no recorded direction). Returns false only
 * when a direction was recorded but the write failed, so the caller can keep
 * the journal around for a later retry instead of losing the direction.
 */
async function finalizeRedoSidecarFromRecord(
  record: RevertJournalRecord,
  finalArtifactContent: Uint8Array,
  finalBackupContent: Uint8Array,
  fs: RevertJournalFs
): Promise<boolean> {
  if (!record.direction) return true;
  try {
    await writeRedoSidecar(
      vscode.Uri.file(record.artifactPath),
      {
        version: 1,
        direction: record.direction,
        artifactFingerprint: fingerprintBytes(finalArtifactContent),
        backupFingerprint: fingerprintBytes(finalBackupContent),
      },
      fs
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Activation-time recovery: finish any revert swap that was interrupted by a
 * crash or window close. Returns the number of journals recovered. The
 * optional `decide` callback is consulted for journals whose completion is
 * not unambiguously safe (see recoverRevertJournal). Journals whose target
 * files are open in a dirty editor are deferred untouched, never written
 * beneath the editor.
 */
export async function recoverRevertJournals(
  decide?: (prompt: RevertRecoveryPrompt) => Promise<RevertRecoveryDecision>
): Promise<number> {
  let journals: readonly vscode.Uri[];
  try {
    journals = await vscode.workspace.findFiles(
      `**/*${REVERT_JOURNAL_SUFFIX}`,
      "**/node_modules/**"
    );
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const journal of journals) {
    try {
      if (await recoverRevertJournal(journal, defaultFs(), decide)) {
        recovered += 1;
      }
    } catch {
      // Leave the journal in place — a later activation retries it.
    }
  }
  return recovered;
}
