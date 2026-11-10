import type * as vscode from "vscode";

import { chooseBatchPassV1, type ReviewBatchPassV1 } from "../utils/reviewBatchPassV1";
import { measureReviewReadCostsV1 } from "../utils/reviewReadCostIoV1";
import type { TaskStage } from "../types/taskProgress";
import { readStoreV1 } from "./reviewBatchCombineIoV1";
import { readFilesReadEarlierV1 } from "./reviewCoverageRecordV1";

/**
 * review2 Step 29: plans the next review pass for a stage's file list. Measures what the reviewer must read for each
 * file (git diff against the task's baseline), asks which files an earlier review read at their current content, and
 * lets `chooseBatchPassV1` pick the batch. `undefined` for a list that fits one pass, and on any failure to measure or
 * read the record: the review then runs over the whole list as it did before batching.
 */
export async function planBatchPassForFilesV1(input: {
  readonly folderUri: vscode.Uri;
  readonly workspaceRootPath: string;
  readonly baselineSha: string | undefined;
  readonly stage: TaskStage;
  readonly files: readonly string[];
}): Promise<ReviewBatchPassV1 | undefined> {
  if (input.files.length === 0) return undefined;
  try {
    const costs = await measureReviewReadCostsV1(input.workspaceRootPath, input.baselineSha, input.files);
    const covered = await readFilesReadEarlierV1(input.folderUri, input.files);
    // Step 31: files an earlier pass of this stage declined to inspect, and no pass has read since, split their batch.
    const store = await readStoreV1(input.folderUri.fsPath);
    const splitFiles = new Set(
      (store[input.stage] ?? [])
        .flatMap((record) => record.declinedFiles ?? [])
        .filter((file) => covered?.has(file) !== true)
    );
    return chooseBatchPassV1({
      files: input.files.map((file) => ({ path: file, readLines: costs.get(file.replace(/\\/g, "/").replace(/^\.\//, "")) ?? 1 })),
      ...(covered !== undefined ? { coveredFiles: covered } : {}),
      ...(splitFiles.size > 0 ? { splitFiles } : {}),
    });
  } catch {
    return undefined;
  }
}
