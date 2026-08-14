/**
 * IO half of review-artifact freshness (the pure transforms live in
 * reviewReadiness.ts): given a task's on-disk review artifacts, mark any
 * whose recorded `reviewed-commit` is no longer HEAD with a visible stale
 * banner, and heal any that are current again.
 *
 * Shared by the trigger points so each one stays a one-liner:
 *  - View Review (reviewActions.ts's viewReview) refreshes the artifact it is
 *    about to open;
 *  - the commit lifecycle (commitAndPushTask.ts) refreshes a task's review
 *    artifacts after a successful commit advances HEAD;
 *  - re-review generation (reviewActions.ts's runReviewForFolder) refreshes
 *    the previous review it is about to reconcile against.
 *
 * Writes go through writeTextFile with skipBackup — a banner-only change must
 * not churn the artifact's `_prev` backup, which is the last REAL previous
 * version View Changes and revert rely on.
 */
import * as vscode from "vscode";

import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { readTextIfExists, writeTextFile } from "./fileUtils";
import { resolveHeadCommitSha } from "./gitRepoInfo";
import { REVIEWED_COMMIT_STAGES, upsertStaleReviewBanner } from "./reviewReadiness";

/**
 * Refresh the stale banner on one review artifact. Returns true when the
 * file was rewritten. A no-op (no write) when HEAD cannot be resolved, the
 * artifact is missing/unreadable, it is a `# Review Stale` placeholder, it
 * carries no reviewed-commit marker, or the correct banner state is already
 * on disk (the upsert is idempotent).
 */
export async function refreshStaleReviewBannerForArtifactV1(
  reviewUri: vscode.Uri,
  headSha: string | undefined
): Promise<boolean> {
  if (!headSha) {
    return false;
  }
  const content = await readTextIfExists(reviewUri);
  if (!content) {
    return false;
  }
  const updated = upsertStaleReviewBanner(content, headSha);
  if (updated === content) {
    return false;
  }
  await writeTextFile(reviewUri, updated, { skipBackup: true });
  return true;
}

/**
 * Refresh the stale banners on every reviewed-commit-stage artifact
 * (REVIEWED_COMMIT_STAGES) a task has on disk, resolving HEAD once for the
 * whole pass. Never throws: a banner is a courtesy marker, and failing the
 * caller's real work (opening a review, finishing a commit) because a marker
 * could not be written would invert the priority stack.
 */
export async function refreshStaleReviewBannersForTaskV1(
  taskFolderPath: string
): Promise<void> {
  try {
    const headSha = await resolveHeadCommitSha(taskFolderPath);
    if (!headSha) {
      return;
    }
    const folderUri = vscode.Uri.file(taskFolderPath);
    for (const stage of REVIEWED_COMMIT_STAGES) {
      const name = STAGE_ARTIFACT_FILENAMES[stage];
      if (!name) {
        continue;
      }
      await refreshStaleReviewBannerForArtifactV1(
        vscode.Uri.joinPath(folderUri, name),
        headSha
      );
    }
  } catch {
    // Best-effort only — see the doc comment above.
  }
}
