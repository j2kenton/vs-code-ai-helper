/**
 * review1 Step 59: the code budget of an implementation review is what is left of the transport limit after the
 * measured non-code input, not a fixed number. The context pack's own sections and the task description shrink
 * before any code does, and code is guaranteed at least half of the limit.
 *
 * Pure: no `vscode`, no I/O. `reviewActions.ts` measures the assembled input and applies the plan this returns.
 */

import { MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 } from "../types/chatInteractionTransactionV1";

/** Canonical bytes one character of embedded code costs once escaped into the JSON input (multibyte and quotes). */
export const IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1 = 1.3;

/** Kept free for the review file's baseline revision, the guard fields and other small additions. */
export const IMPL_REVIEW_INPUT_HEADROOM_BYTES_V1 = 8 * 1024;

/** The smallest code budget a review is built with; below it the review has nothing to look at. */
export const IMPL_REVIEW_MIN_CODE_CHARS_V1 = 2000;

/** Task description sizes tried, largest first, when the non-code input leaves code less than half the limit. */
export const IMPL_REVIEW_TASK_DESCRIPTION_STEPS_V1: readonly number[] = [12000, 6000, 3000, 1500];

/**
 * The code budget for a caller that has not measured the non-code input: the share the code is guaranteed, which is
 * the limit minus the other half (left to the non-code input) minus the headroom. It replaces the fixed constant
 * `IMPL_REVIEW_MAX_TOTAL_CHARS`; the measured path in `reviewActions.ts` computes its own from the real input.
 */
export function guaranteedImplReviewCodeBudgetCharsV1(limitBytes: number = MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1): number {
  return planImplReviewCodeBudgetV1({ limitBytes, nonCodeBytes: Math.floor(limitBytes / 2) }).codeBudgetChars;
}

export interface ImplReviewBudgetInputV1 {
  /** The transport's canonical byte limit. */
  readonly limitBytes: number;
  /** Measured canonical bytes of everything that is not embedded code (prompt text, plan, review, pack sections). */
  readonly nonCodeBytes: number;
}

export interface ImplReviewBudgetPlanV1 {
  /** Characters of embedded code the pack may hold. At least {@link IMPL_REVIEW_MIN_CODE_CHARS_V1}. */
  readonly codeBudgetChars: number;
  /** Bytes the budget is expected to cost, before headroom. */
  readonly codeBudgetBytes: number;
  /** True when the code gets at least half of the limit. When false the non-code input should shrink first. */
  readonly codeHasHalfTheLimit: boolean;
  /** True when even the minimum code budget does not fit next to the non-code input. */
  readonly cannotFit: boolean;
}

/**
 * True when a code budget of `codeBudgetChars` characters costs at least half of the limit in bytes. The guarantee
 * applies to every budget a review is built with: the first one and the scaled retry alike.
 */
export function codeBudgetHasHalfTheLimitV1(codeBudgetChars: number, limitBytes: number): boolean {
  return Math.ceil(codeBudgetChars * IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1) >= limitBytes / 2;
}

/** What is left for code after the non-code input and the headroom, turned into a character budget. */
export function planImplReviewCodeBudgetV1(input: ImplReviewBudgetInputV1): ImplReviewBudgetPlanV1 {
  const availableBytes = input.limitBytes - input.nonCodeBytes - IMPL_REVIEW_INPUT_HEADROOM_BYTES_V1;
  const rawChars = Math.floor(availableBytes / IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1);
  const cannotFit = rawChars < IMPL_REVIEW_MIN_CODE_CHARS_V1;
  const codeBudgetChars = Math.max(IMPL_REVIEW_MIN_CODE_CHARS_V1, rawChars);
  const codeBudgetBytes = Math.ceil(codeBudgetChars * IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1);
  return {
    codeBudgetChars,
    codeBudgetBytes,
    codeHasHalfTheLimit: codeBudgetHasHalfTheLimitV1(codeBudgetChars, input.limitBytes),
    cannotFit,
  };
}

/**
 * The next smaller task-description limit to try, or `undefined` when none is left. `current` is the limit in
 * force (`undefined` meaning the default, the first step).
 */
export function nextTaskDescriptionLimitV1(current: number | undefined): number | undefined {
  const steps = IMPL_REVIEW_TASK_DESCRIPTION_STEPS_V1;
  const index = current === undefined ? 0 : steps.indexOf(current);
  return index >= 0 && index + 1 < steps.length ? steps[index + 1] : undefined;
}

/** Previous-review sizes tried, largest first, once the pack and the task description are as small as they go. */
export const IMPL_REVIEW_PREVIOUS_REVIEW_STEPS_V1: readonly number[] = [40000, 20000, 10000];

/** The next smaller previous-review limit to try (`undefined` current = the first step), or `undefined` when none is left. */
export function nextPreviousReviewLimitV1(current: number | undefined): number | undefined {
  const steps = IMPL_REVIEW_PREVIOUS_REVIEW_STEPS_V1;
  const index = current === undefined ? 0 : steps.indexOf(current) + 1;
  return index >= 0 && index < steps.length ? steps[index] : undefined;
}

/**
 * The budget to rebuild with after a build measured over the limit: the same plan, scaled by how far over it was, so
 * one retry normally fits. Never below the minimum.
 */
export function shrinkImplReviewCodeBudgetV1(
  codeBudgetChars: number,
  measuredBytes: number,
  limitBytes: number
): number {
  const overBytes = measuredBytes - limitBytes + IMPL_REVIEW_INPUT_HEADROOM_BYTES_V1;
  if (overBytes <= 0) {
    return codeBudgetChars;
  }
  return Math.max(
    IMPL_REVIEW_MIN_CODE_CHARS_V1,
    codeBudgetChars - Math.ceil(overBytes / IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1)
  );
}

/**
 * review2 Step 29: the per-pass READ budget. It is separate from the code budget above, which only bounds the bytes
 * embedded in `context-pack.md`. This one counts what the reviewer has to read for every file of a pass, whether the
 * pack embeds it or the reviewer reads it natively: the changed regions of a modified file with their context lines,
 * and the whole of a new file. Defaults come from review1's hand batches (about 52 files read in full), so its
 * 202-file, ~23,000-line change splits into about four passes.
 */
export const IMPL_REVIEW_READ_MAX_LINES_V1 = 6000;

/** The most files one review pass is given, however small they are. */
export const IMPL_REVIEW_READ_MAX_FILES_V1 = 60;

/** Unified-diff context lines around each changed region (git's default), counted into a modified file's read cost. */
export const IMPL_REVIEW_READ_CONTEXT_LINES_V1 = 3;

export interface ReviewReadLimitsV1 {
  readonly maxLines: number;
  readonly maxFiles: number;
}

export const DEFAULT_REVIEW_READ_LIMITS_V1: ReviewReadLimitsV1 = {
  maxLines: IMPL_REVIEW_READ_MAX_LINES_V1,
  maxFiles: IMPL_REVIEW_READ_MAX_FILES_V1,
};

/** How one changed file reaches the reviewer. */
export type ReviewReadKindV1 = "new" | "modified" | "deleted";

export interface ReviewReadMeasureV1 {
  readonly kind: ReviewReadKindV1;
  /** Lines in the file now (a new file's whole size). */
  readonly totalLines: number;
  /** Added plus removed lines of a modified file. */
  readonly changedLines?: number;
  /** Separate changed regions of a modified file. */
  readonly hunks?: number;
}

/**
 * Lines the reviewer must read for one file. A new file costs its whole length. A modified file costs its changed
 * lines plus the context around each region, never more than the file itself. A deleted file costs one line (its
 * name and the fact of the removal).
 */
export function readCostLinesV1(measure: ReviewReadMeasureV1): number {
  if (measure.kind === "deleted") return 1;
  const total = Math.max(0, Math.floor(measure.totalLines));
  if (measure.kind === "new") return Math.max(1, total);
  const changed = Math.max(0, Math.floor(measure.changedLines ?? 0));
  const hunks = Math.max(changed > 0 ? 1 : 0, Math.floor(measure.hunks ?? 0));
  const withContext = changed + hunks * 2 * IMPL_REVIEW_READ_CONTEXT_LINES_V1;
  return Math.max(1, total > 0 ? Math.min(total, withContext) : withContext);
}
