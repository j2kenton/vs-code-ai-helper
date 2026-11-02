/**
 * bugs5 Step 8 / item 3: the "already has N staged change(s) alongside unstaged changes" card names
 * what "Commit Everything Together" would add: the unstaged and untracked files, the first few and
 * a count. Limited to the scope the commit uses (the task folder is excluded by default). Pure.
 */

export const COMMIT_PUSH_UNSTAGED_LIST_LIMIT_V1 = 10;

export interface CommitPushUnstagedListV1 {
  /** Repo-relative paths in the order shown, at most the limit. */
  readonly shown: readonly string[];
  /** How many in scope in all (shown + the rest). */
  readonly total: number;
  /** The paths that were changed but left out because they live in the task folder. */
  readonly excludedTaskFolderCount: number;
}

function splitLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * `git diff --name-only` (unstaged) plus `git ls-files --others --exclude-standard` (untracked), as
 * one de-duplicated list in scope. `taskFolderRelative` is the task folder relative to the repo root
 * with forward slashes; `includeTaskFolder` mirrors the commit's own scope choice.
 */
export function buildCommitPushUnstagedListV1(input: {
  readonly unstagedOutput: string;
  readonly untrackedOutput: string;
  readonly taskFolderRelative: string;
  readonly includeTaskFolder?: boolean;
  readonly limit?: number;
}): CommitPushUnstagedListV1 {
  const limit = input.limit ?? COMMIT_PUSH_UNSTAGED_LIST_LIMIT_V1;
  const taskPrefix = input.taskFolderRelative.replace(/\/+$/, "");
  const seen = new Set<string>();
  const inScope: string[] = [];
  let excludedTaskFolderCount = 0;
  for (const raw of [...splitLines(input.unstagedOutput), ...splitLines(input.untrackedOutput)]) {
    const file = raw.replace(/\\/g, "/");
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const inTaskFolder = taskPrefix.length > 0 && (file === taskPrefix || file.startsWith(`${taskPrefix}/`));
    if (inTaskFolder && input.includeTaskFolder !== true) {
      excludedTaskFolderCount += 1;
      continue;
    }
    inScope.push(file);
  }
  return { shown: inScope.slice(0, limit), total: inScope.length, excludedTaskFolderCount };
}

/** The lines the card adds under its text, or `""` when nothing in scope is unstaged. */
export function describeCommitPushUnstagedListV1(list: CommitPushUnstagedListV1): string {
  if (list.total === 0) {
    return list.excludedTaskFolderCount > 0
      ? `\n\nThe unstaged changes are all inside the task folder, which is left out of this commit by default ` +
          `(${list.excludedTaskFolderCount} file${list.excludedTaskFolderCount === 1 ? "" : "s"}).`
      : "";
  }
  const rest = list.total - list.shown.length;
  const more = rest > 0 ? `\n  … and ${rest} more` : "";
  return (
    `\n\nUnstaged or untracked files that Commit Everything Together would add (${list.total}):\n` +
    list.shown.map((file) => `  ${file}`).join("\n") +
    more
  );
}
