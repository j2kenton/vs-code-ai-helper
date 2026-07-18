import * as vscode from "vscode";

/**
 * The commit-message review session (Commit and Push).
 *
 * The review surface is an UNTITLED editor document (git-commit language):
 * the editor's lifetime IS the session. Closing the editor cancels the
 * review; there is no durable file and no cross-reload persistence — a
 * window reload simply ends the session with nothing committed (staging,
 * commit, and push only happen AFTER the user confirms, so there is never
 * anything to resume). The session record therefore lives in memory only.
 *
 * Settlement is idempotent: whichever caller CLAIMS the session first
 * performs the git operations; every other caller finds no session.
 */

export interface PendingCommitSession {
  version: 2;
  taskFolderPath: string;
  taskName: string;
  repoRoot: string;
  /** Repo-relative files to stage at settlement (already sensitivity-filtered). */
  scopedFiles: string[];
  /** URI (toString) of the untitled commit-message document. */
  documentUri: string;
  currentBranch: string;
  hasUpstream: boolean;
  singleRemote?: string;
  pushDestination: string;
  createdAt: number;
}

let inMemory: PendingCommitSession | undefined;
let claiming = false;

/**
 * Keep the editor-title "Confirm Commit Message" button scoped to the ONE
 * untitled document that is the live session, not every untitled git-commit
 * editor: the `vs-code-ai-helper.pendingCommitFilenames` context key holds
 * the session document's filename (empty when no session), and the menu's
 * `when` clause checks `resourceFilename in` it. Best-effort — context keys
 * are a UI affordance and must never block session bookkeeping (nor exist
 * in the unit-test host).
 */
function syncCommitMenuContext(): void {
  try {
    const filename = inMemory
      ? vscode.Uri.parse(inMemory.documentUri).path.split("/").pop()
      : undefined;
    void Promise.resolve(
      vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.pendingCommitFilenames",
        filename ? [filename] : []
      )
    ).catch(() => undefined);
  } catch {
    // No command host (unit tests) — nothing to sync.
  }
}

export function getPendingCommitSession(): PendingCommitSession | undefined {
  return inMemory;
}

export function storePendingCommitSession(session: PendingCommitSession): void {
  inMemory = session;
  syncCommitMenuContext();
}

export function clearPendingCommitSession(): void {
  inMemory = undefined;
  syncCommitMenuContext();
}

/**
 * Wake channel for a LIVE commit-message review. While the originating
 * Commit and Push operation is awaiting the review notification it still
 * holds the task's exclusive operation lock, so external settlement surfaces
 * (the editor-title "Confirm Commit Message" command, the close-cancel
 * listener) must not claim a second exclusive operation on the same task —
 * that claim would be refused as busy and the session would silently stay
 * uncommitted. Instead they wake the awaiting operation, which re-reads the
 * session and settles (or finishes as cancelled) under the lock it already
 * holds. The registration is one-shot: a successful wake consumes it.
 */
let liveReviewWake: (() => void) | undefined;

export function registerLiveCommitReviewWake(wake: () => void): void {
  liveReviewWake = wake;
}

export function clearLiveCommitReviewWake(): void {
  liveReviewWake = undefined;
}

/**
 * Returns true when a live review operation was woken — the caller must NOT
 * start its own settlement; the woken operation performs it under the
 * exclusive lock it already holds. Returns false when no review is awaiting
 * (the originating operation has ended), in which case the caller settles
 * under its own tracked operation.
 */
export function requestLiveCommitReviewWake(): boolean {
  const wake = liveReviewWake;
  if (!wake) {
    return false;
  }
  liveReviewWake = undefined;
  wake();
  return true;
}

/**
 * Claim the pending session for settlement: returns it and clears it in one
 * step. The synchronous `claiming` latch makes concurrent claims on the same
 * event loop mutually exclusive, so two settlement paths (the review
 * notification button, the editor-title button, and the close-cancel
 * listener) can never both act on the same session.
 */
export function claimPendingCommitSession(): PendingCommitSession | undefined {
  if (claiming) {
    return undefined;
  }
  claiming = true;
  try {
    const session = inMemory;
    if (!session) {
      return undefined;
    }
    inMemory = undefined;
    syncCommitMenuContext();
    return session;
  } finally {
    claiming = false;
  }
}

/**
 * Best-effort close of the untitled commit-message editor without a
 * save-changes prompt: reveal the document and revert-and-close it. Used
 * after a settled commit (the message has served its purpose) — never on
 * the cancel path, where the user closing the editor is itself the signal.
 */
export async function closeCommitMessageEditor(documentUri: string): Promise<void> {
  try {
    const doc = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === documentUri
    );
    if (!doc) {
      return;
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  } catch {
    // Best effort — an open leftover buffer is harmless; the close-cancel
    // listener no-ops once the session has been claimed.
  }
}
