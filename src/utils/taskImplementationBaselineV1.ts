/**
 * Records the git commit SHA that was HEAD immediately before this task's
 * FIRST implementation round ran, so a task's first implementation review
 * (which has no prior `<!-- reviewed-commit: SHA --> ` marker to anchor to,
 * see `parseReviewedCommitSha` in reviewReadiness.ts) can still diff against
 * "everything this task has changed" instead of falling back to
 * `computeChangedLineRangesForFileV1`'s last-commit-vs-parent proxy in
 * contextPack.ts, which only ever sees the single most recent commit that
 * touched a file and silently drops any earlier round's hunk in the same
 * task (workflow findings round 8, item 1's re-review-only baseline gap).
 *
 * The task folder itself (`.ensemble/...`) is gitignored, so there is no git
 * history to derive this from after the fact — it must be captured live, the
 * first time an implementation round is about to dispatch, before any edit
 * happens. `recordTaskImplementationBaselineShaIfAbsentV1` is idempotent
 * (write-once, first round wins) and best-effort: a failure to read/write the
 * sidecar never blocks a round, it just leaves later first-reviews without a
 * baseline, falling back to the pre-existing heuristics exactly as before
 * this module existed.
 */
import * as vscode from "vscode";
import { readTextIfExists, statIfExists } from "./fileUtils";
import { resolveHeadCommitSha } from "./gitRepoInfo";

const TASK_IMPLEMENTATION_BASELINE_FILENAME = ".impl-baseline-commit";

/** URI of this task's baseline-commit sidecar file. */
export function getTaskImplementationBaselineUri(
  taskFolderUri: vscode.Uri
): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, TASK_IMPLEMENTATION_BASELINE_FILENAME);
}

/**
 * Read the previously-recorded baseline commit SHA for this task, or
 * undefined when none was ever recorded (task predates this mechanism, the
 * workspace has no git repo, or every implementation round for it ran
 * through an entry point this module isn't wired into yet).
 */
export async function readTaskImplementationBaselineShaV1(
  taskFolderUri: vscode.Uri
): Promise<string | undefined> {
  const content = await readTextIfExists(getTaskImplementationBaselineUri(taskFolderUri));
  const trimmed = content?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * On the FIRST call for a given task, snapshot the current HEAD commit SHA
 * to the task's baseline sidecar file. Every subsequent call for the same
 * task is a no-op — the file's existence alone is the "already recorded"
 * signal, regardless of its content, so a snapshot that resolved to no repo
 * (nothing written) is retried on the next round rather than permanently
 * stuck absent.
 *
 * Must be called before any edit this round might make, so the recorded SHA
 * genuinely predates the task's implementation work.
 */
export async function recordTaskImplementationBaselineShaIfAbsentV1(
  taskFolderUri: vscode.Uri,
  workspaceFolderPath: string
): Promise<void> {
  try {
    const uri = getTaskImplementationBaselineUri(taskFolderUri);
    if (await statIfExists(uri)) {
      return;
    }
    const headSha = await resolveHeadCommitSha(workspaceFolderPath);
    if (!headSha) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(headSha));
  } catch {
    // Best-effort only — a missing baseline just means the first review for
    // this task falls back to the pre-existing no-baseline heuristics.
  }
}
