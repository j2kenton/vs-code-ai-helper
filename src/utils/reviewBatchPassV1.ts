/**
 * review2 Step 29 (dispatch): which batch the next review pass reads. No `vscode` import.
 *
 * `planReviewBatchesV1` splits a scope by the read budget. This turns that plan into one pass: the first batch holding
 * files with no coverage at their current content. The pass's pack is built from that batch only, and the files of the
 * other batches are not "missing" from it (another pass covers them), so the per-batch pass never raises "Add the
 * missing files" for them.
 */
import {
  planReviewBatchesV1,
  splitBatchFurtherV1,
  type ReviewBatchFileV1,
  type ReviewBatchPlanV1,
  type ReviewBatchV1,
} from "./reviewBatchPlanV1";
import type { ReviewReadLimitsV1 } from "./implReviewBudgetV1";

/** Prompt variable carrying the files this pass reads, one per line. Absent for a scope that fits one pass. */
export const REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1 = "reviewScopeBatchFiles";

/** Prompt variable carrying the pass's position, "2/4". Absent for a single pass. */
export const REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1 = "reviewScopeBatchPosition";

export interface ReviewBatchPassV1 {
  readonly plan: ReviewBatchPlanV1;
  /** The batch this pass reads. */
  readonly batch: ReviewBatchV1;
  /** 1-based position of this pass in the stage's batch set (batches already covered count as done). */
  readonly position: number;
  readonly count: number;
  /** Batches that still have files with no coverage at their current content, this one included. */
  readonly remaining: number;
}

/**
 * The next pass for a scope, or `undefined` when the scope fits one pass (the review then runs exactly as it always
 * did, over the whole list). `coveredFiles` are the files an earlier review read in full at their current content.
 */
export function chooseBatchPassV1(input: {
  readonly files: readonly ReviewBatchFileV1[];
  readonly coveredFiles?: ReadonlySet<string>;
  readonly limits?: ReviewReadLimitsV1;
  /** Files an earlier pass of this stage declined to inspect; the batch holding them is split further (Step 31). */
  readonly splitFiles?: ReadonlySet<string>;
}): ReviewBatchPassV1 | undefined {
  const plan = planReviewBatchesV1(input);
  if (plan.batches.length <= 1 && (input.splitFiles?.size ?? 0) === 0) return undefined;
  // The plan puts batches with uncovered files first, so the first one is the next pass. When everything is covered
  // (a review asked for anyway) the pass is the first batch again.
  let batch = plan.batches[0];
  if (batch === undefined) return undefined;
  let count = plan.batches.length;
  const declined = [...(input.splitFiles ?? [])].filter((file) => batch?.files.includes(file));
  if (declined.length > 0) {
    // Step 31: a reviewer said it did not inspect this batch. Plan its declined files again under halved limits and
    // read the first of the smaller batches now.
    const costs = new Map(input.files.map((file) => [file.path.replace(/\\/g, "/").replace(/^\.\//, ""), file.readLines]));
    const smaller = splitBatchFurtherV1(batch, costs, declined, input.limits);
    const first = smaller?.batches[0];
    if (smaller !== undefined && first !== undefined) {
      batch = { ...first, index: batch.index };
      count += smaller.batches.length - 1;
    }
  }
  if (count <= 1) return undefined;
  const remaining = plan.batches.filter((candidate) => candidate.uncoveredCount > 0).length;
  const done = plan.batches.length - remaining;
  return { plan, batch, position: Math.min(count, done + 1), count, remaining };
}

/** Prompt variables for a pass. */
export function batchPassVariablesV1(pass: ReviewBatchPassV1): Record<string, string> {
  return {
    [REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1]: pass.batch.files.join("\n"),
    [REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1]: `${pass.position}/${pass.count}`,
  };
}

/** The files a pass read, from the prompt variables; `undefined` for a review over the whole list. */
export function batchFilesFromVariablesV1(variables: Readonly<Record<string, string>>): string[] | undefined {
  const raw = variables[REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1];
  if (raw === undefined) return undefined;
  return raw.split("\n").filter((file) => file.length > 0);
}

/** "Reviewing in 4 parts (about 50 files each): part 2 of 4"; empty for a single pass. */
export function describeBatchPassV1(pass: ReviewBatchPassV1): string {
  const about = Math.max(1, Math.round(pass.plan.totalFiles / pass.count));
  return `Reviewing in ${pass.count} parts (about ${about} files each): part ${pass.position} of ${pass.count}`;
}
