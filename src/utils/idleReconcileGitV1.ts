import { resolveGitRepo, runGitCommand } from "./gitRepoInfo";

/**
 * bugs5 Step 6: at Publish, the idle "checklist is flagged unreliable" card is not shown once the
 * task's work is committed (the owner may well commit by hand, which Ensemble has no record of), so
 * the question is asked of Git: `git status --porcelain -- <the task's tracked files>`.
 *
 * Returns `true` when any of them has an uncommitted change, `false` when none has, and
 * `undefined` when that cannot be told (no tracked files, not a repository, Git failed), in which
 * case the card stays: absence of an answer is never evidence that the work is committed.
 */
export async function trackedFilesHaveUncommittedChangesV1(
  taskFolderPath: string,
  trackedFiles: readonly string[] | undefined
): Promise<boolean | undefined> {
  if (!trackedFiles || trackedFiles.length === 0) {
    return undefined;
  }
  try {
    const root = await resolveGitRepo(taskFolderPath);
    if (!root) {
      return undefined;
    }
    const { stdout } = await runGitCommand(root, "status", ["--porcelain", "--", ...trackedFiles]);
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}
