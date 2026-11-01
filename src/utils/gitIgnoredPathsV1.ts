import { execFile } from "child_process";

/** Paths handed to one `git check-ignore` call; keeps each request comfortably small. */
const CHECK_IGNORE_CHUNK_V1 = 500;

/**
 * Asks git which of these paths it ignores. Uses `execFile` (as the rest of the runner's git
 * snapshot does) and feeds the NUL-separated paths on stdin, because `-z` is only valid with
 * `--stdin`.
 */
function checkIgnoreChunkV1(cwd: string, paths: readonly string[]): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "git",
        ["check-ignore", "-z", "--stdin"],
        { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
        (error, stdout) => {
          // Exit 0: some paths are ignored. Exit 1: none are. Anything else (not a repository,
          // git missing) is "unknown", never "nothing ignored".
          const code = (error as { code?: unknown } | null)?.code;
          if (error && code !== 1) {
            resolve(undefined);
            return;
          }
          resolve(new Set(String(stdout ?? "").split("\0").filter((entry) => entry.length > 0)));
        }
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(paths.map((path) => `${path}\0`).join(""));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Drop every path git itself reports as ignored (a `.gitignore` or exclude rule
 * matches it and it is not tracked) from a round's observed change list. A
 * scratch directory the owner's repository ignores — `.scratch/` here — holds
 * test leftovers and one-off compiles, not edits to the project, so it is never
 * quarantined into `pendingImplReviewFiles` or banked as review scope
 * (bugs4 item 23). Tracked files are never reported ignored by git, so a real
 * edit to a tracked file that happens to match an ignore pattern is kept.
 *
 * Fails open: when git cannot answer, the list is returned unchanged rather than
 * guessing a path away.
 */
export async function dropGitIgnoredPathsV1(cwd: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }
  const ignored = new Set<string>();
  for (let start = 0; start < paths.length; start += CHECK_IGNORE_CHUNK_V1) {
    const answer = await checkIgnoreChunkV1(cwd, paths.slice(start, start + CHECK_IGNORE_CHUNK_V1));
    if (answer === undefined) {
      return [...paths];
    }
    for (const path of answer) {
      ignored.add(path.replace(/\\/g, "/"));
    }
  }
  return paths.filter((path) => !ignored.has(path.replace(/\\/g, "/")));
}
