import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import type { TaskStage } from "../types/taskProgress";
import { parseReadiness } from "../utils/reviewReadiness";
import { batchFilesFromVariablesV1, REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1 } from "../utils/reviewBatchPassV1";
import {
  combineBatchRecordsV1,
  extractBlockerLinesV1,
  rewriteReviewAsCombinedV1,
  upsertBatchRecordV1,
  validBatchRecordsV1,
  type BatchPassRecordV1,
  type BatchStoreV1,
} from "../utils/reviewBatchStoreV1";
import { parseFilesNotFullyInspectedV1, statesIncompleteInspectionV1 } from "../utils/reviewCoverageV1";
import { hashWorkspaceFilesV1 } from "../utils/reviewCoverageIoV1";
import { resolveWorkspaceRootForTaskV1 } from "./applyReviewerVerifiedTicks";

export const REVIEW_BATCH_STORE_FILENAME_V1 = "review-batches-v1.json";
export const REVIEW_BATCH_PARTS_FOLDER_V1 = "review-batches";

export interface BatchPassOutcomeV1 {
  /** The review file's content after it was rewritten as the combined verdict. */
  readonly content: string;
  /** Every scope file has been read by a valid pass. */
  readonly complete: boolean;
  readonly unreadFiles: readonly string[];
  /** "Reviewed N of M": scope files a valid pass has read, and the scope's size. */
  readonly readFileCount: number;
  readonly totalFileCount: number;
  /** This pass read at least one file no valid pass had read. A pass that did not cannot be followed by another. */
  readonly progressed: boolean;
  readonly position: number;
  readonly count: number;
  /** Files this pass could not read in full (cut by the size limit, or declared uninspected). */
  readonly notReadFiles: readonly string[];
}

function normalizeV1(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

export async function readStoreV1(taskFolderPath: string): Promise<Record<string, BatchPassRecordV1[]>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(taskFolderPath, REVIEW_BATCH_STORE_FILENAME_V1), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, BatchPassRecordV1[]>) : {};
  } catch {
    return {};
  }
}

/** The stage's records still valid against the files' current content. */
async function currentValidRecordsV1(
  workspaceRoot: string,
  records: readonly BatchPassRecordV1[]
): Promise<BatchPassRecordV1[]> {
  const files = [...new Set(records.flatMap((record) => record.filesRead))];
  return validBatchRecordsV1(records, await hashWorkspaceFilesV1(workspaceRoot, files));
}

/**
 * review2 Step 30: after a batch pass ends, records its verdict in its own part file and in the stage's batch store,
 * and rewrites the stage's review file as the combined verdict (lowest score, blockers of every pass, "covered N of M").
 * `undefined` for a review that ran over the whole list. Best effort: a failure leaves the review file as the reviewer
 * wrote it and the caller treats the stage as not fully covered.
 */
export async function applyBatchPassToReviewV1(input: {
  readonly folderUri: vscode.Uri;
  readonly variables: Readonly<Record<string, string>>;
  readonly reviewUri: vscode.Uri;
  readonly content: string;
  readonly stage: TaskStage;
  readonly runId: string;
  /** Files outside the pack (cut by the size limit with no file access). */
  readonly missingFiles: readonly string[];
}): Promise<BatchPassOutcomeV1 | undefined> {
  const batchFiles = batchFilesFromVariablesV1(input.variables);
  if (batchFiles === undefined) return undefined;
  const root = resolveWorkspaceRootForTaskV1(input.folderUri);
  const strict = await readTaskProgressStrictV1(input.folderUri);
  if (root === undefined || !strict.ok) return undefined;
  const scopeFiles = (strict.decoded.progress.implReviewFiles ?? []).map(normalizeV1);
  const [position = 1, count = 1] = (input.variables[REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1] ?? "1/1").split("/").map(Number);
  const missing = new Set(input.missingFiles.map(normalizeV1));
  const planned = batchFiles.map(normalizeV1);
  const listed = parseFilesNotFullyInspectedV1(input.content).map(normalizeV1);
  // Step 31: a reviewer that says in prose it did not inspect its batch, without listing files, declines all of it.
  const declined = new Set(listed.length === 0 && statesIncompleteInspectionV1(input.content) ? planned : listed);
  const canSplit = declined.size > 0 && planned.length > 1;
  const filesRead = planned.filter((file) => !missing.has(file) && !declined.has(file));
  const hashes = await hashWorkspaceFilesV1(root, filesRead);
  const record: BatchPassRecordV1 = {
    position,
    count,
    files: planned,
    filesRead,
    hashes: Object.fromEntries(filesRead.map((file) => [file, hashes.get(file) ?? ""])),
    score: parseReadiness(input.content).score,
    declinedFiles: planned.filter((file) => declined.has(file) && !missing.has(file)),
    // Step 31: "did not inspect the whole batch" is a reason to split it, not a blocker the owner must clear.
    blockerLines: extractBlockerLinesV1(input.content).filter((line) => !canSplit || !/\[\s*review-confidence\s*\]/i.test(line)),
    runId: input.runId,
    at: new Date().toISOString(),
  };
  const taskFolder = input.folderUri.fsPath;
  const store: BatchStoreV1 = await readStoreV1(taskFolder);
  const prior = await currentValidRecordsV1(root, store[input.stage] ?? []);
  const before = combineBatchRecordsV1(scopeFiles, prior);
  const records = upsertBatchRecordV1(prior, record);
  const combined = combineBatchRecordsV1(scopeFiles, records);
  // This pass's own findings keep their own file: the stage's review file becomes the combined verdict.
  try {
    await fs.mkdir(path.join(taskFolder, REVIEW_BATCH_PARTS_FOLDER_V1), { recursive: true });
    await fs.writeFile(
      path.join(taskFolder, REVIEW_BATCH_PARTS_FOLDER_V1, `${input.stage}-part-${position}-of-${count}.md`),
      input.content,
      "utf8"
    );
    await fs.writeFile(
      path.join(taskFolder, REVIEW_BATCH_STORE_FILENAME_V1),
      JSON.stringify({ ...store, [input.stage]: records }, null, 2),
      "utf8"
    );
  } catch {
    // Best effort: the verdict below does not depend on the part file.
  }
  const rewritten = rewriteReviewAsCombinedV1(input.content, combined, records);
  if (rewritten !== input.content) {
    try {
      await vscode.workspace.fs.writeFile(input.reviewUri, new TextEncoder().encode(rewritten));
    } catch {
      return {
        content: input.content,
        complete: false,
        unreadFiles: combined.unreadFiles,
        readFileCount: combined.filesRead,
        totalFileCount: combined.filesTotal,
        progressed: false,
        position,
        count,
        notReadFiles: planned.filter((file) => !filesRead.includes(file)),
      };
    }
  }
  return {
    content: rewritten,
    complete: combined.complete,
    unreadFiles: combined.unreadFiles,
    readFileCount: combined.filesRead,
    totalFileCount: combined.filesTotal,
    // A pass that declined a batch it can still split is followed by a smaller one; halving ends at one file.
    progressed: combined.unreadFiles.length < before.unreadFiles.length || canSplit,
    position,
    count,
    notReadFiles: planned.filter((file) => !filesRead.includes(file)),
  };
}
