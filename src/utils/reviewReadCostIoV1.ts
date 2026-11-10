/**
 * review2 Step 29: measures what the reviewer must read for each file of a scope. No `vscode` import.
 *
 * A modified file costs the lines of its `git diff` against the task's baseline (changed lines plus the context git
 * prints around each region); a new file costs its length; a deleted file costs one line.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { readCostLinesV1 } from "./implReviewBudgetV1";

/** Per-file read cost from the text of a `git diff` (unified, with context). Files absent from the diff are not returned. */
export function parseDiffReadCostsV1(diffText: string): Map<string, number> {
  const costs = new Map<string, number>();
  let file: string | undefined;
  let kind: "new" | "modified" | "deleted" = "modified";
  let changed = 0;
  let body = 0;
  const flush = (): void => {
    if (file === undefined) return;
    if (kind === "deleted") costs.set(file, readCostLinesV1({ kind: "deleted", totalLines: 0 }));
    else if (kind === "new") costs.set(file, readCostLinesV1({ kind: "new", totalLines: changed }));
    else costs.set(file, Math.max(1, body));
  };
  let inHunk = false;
  for (const line of diffText.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) {
      flush();
      file = header[2];
      kind = "modified";
      changed = 0;
      body = 0;
      inHunk = false;
      continue;
    }
    if (file === undefined) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) kind = "new";
      else if (line.startsWith("deleted file mode")) kind = "deleted";
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      changed += 1;
      body += 1;
    } else if (line.startsWith(" ")) {
      body += 1;
    }
  }
  flush();
  return costs;
}

function runGitV1(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Read cost of every file in `files`. Tracked files come from one `git diff` against `baselineSha`; a file the diff
 * does not list (untracked, or the baseline cannot be read) costs its length in lines, and a missing one costs 1.
 */
export async function measureReviewReadCostsV1(
  root: string,
  baselineSha: string | undefined,
  files: readonly string[]
): Promise<Map<string, number>> {
  let fromDiff = new Map<string, number>();
  if (baselineSha !== undefined && baselineSha.length > 0) {
    try {
      fromDiff = parseDiffReadCostsV1(await runGitV1(root, ["diff", "--unified=3", "--no-color", baselineSha]));
    } catch {
      fromDiff = new Map();
    }
  }
  const costs = new Map<string, number>();
  for (const raw of files) {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const known = fromDiff.get(rel);
    if (known !== undefined) {
      costs.set(rel, known);
      continue;
    }
    if (rel.length === 0 || path.isAbsolute(rel) || rel.split("/").includes("..")) continue;
    try {
      const text = await fs.readFile(path.join(root, rel), "utf8");
      costs.set(rel, readCostLinesV1({ kind: "new", totalLines: text.split("\n").length }));
    } catch {
      costs.set(rel, 1);
    }
  }
  return costs;
}
