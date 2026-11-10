/**
 * review2 Steps 17-19: the file-reading half of the review coverage record. No `vscode` import, so the runner and
 * the viewer share it.
 */
import { promises as fs } from "fs";
import * as path from "path";
import type { ReviewCoverageV1, TaskProgress } from "../types/taskProgress";
import { isMachineMaintainedArtifactPathV1 } from "./implReviewFileSelection";
import {
  computeReviewCoverageV1,
  DELETED_FILE_HASH_V1,
  hashFileContentV1,
  type ReviewCoverageSummaryV1,
} from "./reviewCoverageV1";

/** A hash remembered against the file's size and modification time, so repeated tree refreshes only `stat` files. */
export type FileHashCacheV1 = Map<string, { readonly size: number; readonly mtimeMs: number; readonly hash: string }>;

/**
 * Content hash of each file under `root` (`DELETED_FILE_HASH_V1` when unreadable or missing). With a `cache`, a file
 * whose size and modification time are unchanged is not read again; callers that need a guarantee against a same-size,
 * same-millisecond rewrite (the review itself) pass none.
 */
export async function hashWorkspaceFilesV1(
  root: string,
  files: readonly string[],
  cache?: FileHashCacheV1
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of files) {
    const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (rel.length === 0 || path.isAbsolute(rel) || rel.split("/").includes("..")) continue;
    const absolute = path.join(root, rel);
    try {
      if (cache !== undefined) {
        const stat = await fs.stat(absolute);
        const cached = cache.get(absolute);
        if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          hashes.set(rel, cached.hash);
          continue;
        }
        const hash = hashFileContentV1(await fs.readFile(absolute));
        cache.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
        hashes.set(rel, hash);
        continue;
      }
      hashes.set(rel, hashFileContentV1(await fs.readFile(absolute)));
    } catch {
      hashes.set(rel, DELETED_FILE_HASH_V1);
    }
  }
  return hashes;
}

function isReviewableChangedPathV1(file: string): boolean {
  const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return rel.length > 0 && rel !== ".ensemble" && !rel.startsWith(".ensemble/") && !isMachineMaintainedArtifactPathV1(rel);
}

/** The live change set: the last review's snapshot plus every file the task has tracked since. */
export function liveChangedFilesV1(
  record: ReviewCoverageV1 | undefined,
  progress: Pick<TaskProgress, "implReviewFiles">
): string[] {
  return [...new Set([...(record?.changedFiles ?? []), ...(progress.implReviewFiles ?? [])])].filter(
    isReviewableChangedPathV1
  );
}

/**
 * "Reviewed N of M" for the task as it stands. `undefined` when no review has recorded coverage yet (a task that
 * predates the record, or one never reviewed): nothing is claimed either way, and nothing asks for a confirmation.
 */
export async function readReviewCoverageSummaryV1(
  workspaceRoot: string,
  progress: Pick<TaskProgress, "implReviewFiles" | "reviewCoverage"> | undefined,
  cache?: FileHashCacheV1
): Promise<ReviewCoverageSummaryV1 | undefined> {
  const record = progress?.reviewCoverage;
  if (progress === undefined || record === undefined) return undefined;
  const changed = liveChangedFilesV1(record, progress);
  if (changed.length === 0) return undefined;
  const hashes = await hashWorkspaceFilesV1(workspaceRoot, changed, cache);
  return computeReviewCoverageV1(record, changed, hashes);
}

/** Shared by the Tasks tree, which refreshes often: hashes are remembered by size and modification time. */
const TREE_HASH_CACHE_V1: FileHashCacheV1 = new Map();

/** `readReviewCoverageSummaryV1` for the Tasks tree's stage rows (cheap on repeated refreshes). */
export function readReviewCoverageSummaryForTreeV1(
  workspaceRoot: string,
  progress: Pick<TaskProgress, "implReviewFiles" | "reviewCoverage"> | undefined
): Promise<ReviewCoverageSummaryV1 | undefined> {
  return readReviewCoverageSummaryV1(workspaceRoot, progress, TREE_HASH_CACHE_V1);
}

/**
 * review2 Step 22: of `files`, those an earlier review read in full at their CURRENT content (the recorded hash still
 * matches). Keyed by the strings passed in, so a caller can test its own file list against the set.
 */
export async function readFilesReadAtCurrentContentV1(
  workspaceRoot: string,
  record: ReviewCoverageV1 | undefined,
  files: readonly string[]
): Promise<Set<string>> {
  if (record === undefined || files.length === 0) return new Set();
  const hashes = await hashWorkspaceFilesV1(workspaceRoot, files);
  const read = new Set<string>();
  for (const file of files) {
    const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
    const entry = record.files[rel];
    const hash = hashes.get(rel);
    if (entry !== undefined && hash !== undefined && entry.hash === hash) read.add(file);
  }
  return read;
}
