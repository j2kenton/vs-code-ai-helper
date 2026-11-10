/**
 * review2 Steps 29 and 31: split a review scope that is too big for one reviewer to read into batches that each fit
 * the read budget (`implReviewBudgetV1.ts`), with a test kept beside its source.
 *
 * Pure: no `vscode`, no I/O. The caller measures each file (`reviewReadCostIoV1.ts`) and says which files an earlier
 * review already read at their current content; this decides the passes.
 */

import { DEFAULT_REVIEW_READ_LIMITS_V1, type ReviewReadLimitsV1 } from "./implReviewBudgetV1";
import { isProductionSourceFileV1 } from "./reviewScopeGapV1";

export interface ReviewBatchFileV1 {
  readonly path: string;
  /** Lines the reviewer must read for this file (`readCostLinesV1`). */
  readonly readLines: number;
}

export interface ReviewBatchV1 {
  /** 1-based position in the stage's batch set. */
  readonly index: number;
  readonly files: readonly string[];
  readonly readLines: number;
  /** Files in this batch with no coverage at their current content. */
  readonly uncoveredCount: number;
  /** True when one file alone is over the limits; it is a batch of its own. */
  readonly oversized: boolean;
}

export interface ReviewBatchPlanV1 {
  readonly batches: readonly ReviewBatchV1[];
  readonly totalFiles: number;
  readonly totalReadLines: number;
}

function normalizeV1(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function dirOfV1(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

function baseNameV1(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? file : file.slice(slash + 1);
}

const TEST_FILE_RE_V1 = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** A test file by the project's naming convention (`*.test.ts`, `*.spec.ts`) or a `test/`, `tests/`, `__tests__/` folder. */
export function isTestFileV1(file: string): boolean {
  const rel = normalizeV1(file);
  return TEST_FILE_RE_V1.test(rel) || /(^|\/)(test|tests|__tests__)\//.test(rel);
}

/** `src/test/fooBar.test.ts` gives `fooBar`; a non-test file gives its own name without extension. */
function stemV1(file: string): string {
  return baseNameV1(file)
    .replace(TEST_FILE_RE_V1, "")
    .replace(/\.[cm]?[jt]sx?$/, "");
}

function commonPrefixLengthV1(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

/**
 * The source file a test belongs to by name: the source whose stem equals the test's stem. When several share the
 * stem, the one whose folder is closest to the test's wins, then the shorter path, so the choice is stable.
 */
export function matchSourceForTestV1(testFile: string, sources: readonly string[]): string | undefined {
  const stem = stemV1(testFile);
  const candidates = sources.filter((source) => stemV1(source) === stem);
  if (candidates.length === 0) return undefined;
  const dir = dirOfV1(testFile);
  return [...candidates].sort((left, right) => {
    const byPrefix = commonPrefixLengthV1(dirOfV1(right), dir) - commonPrefixLengthV1(dirOfV1(left), dir);
    if (byPrefix !== 0) return byPrefix;
    return left.length - right.length || (left < right ? -1 : 1);
  })[0];
}

interface UnitV1 {
  readonly files: ReviewBatchFileV1[];
  uncovered: number;
}

interface WorkBatchV1 {
  files: ReviewBatchFileV1[];
  lines: number;
  oversized: boolean;
}

export interface PlanReviewBatchesInputV1 {
  readonly files: readonly ReviewBatchFileV1[];
  /** Files an earlier review read in full at their current content. Everything else counts as uncovered. */
  readonly coveredFiles?: ReadonlySet<string>;
  readonly limits?: ReviewReadLimitsV1;
}

function sumLinesV1(files: readonly ReviewBatchFileV1[]): number {
  return files.reduce((sum, file) => sum + file.readLines, 0);
}

function orderUncoveredFirstV1(files: readonly ReviewBatchFileV1[], covered: ReadonlySet<string>): ReviewBatchFileV1[] {
  return [...files].sort(
    (left, right) => Number(covered.has(left.path)) - Number(covered.has(right.path)) || (left.path < right.path ? -1 : 1)
  );
}

/**
 * Batches for a scope. A scope that fits the limits is one batch holding every file. Otherwise:
 *  1. each non-test file is a unit with the tests named after it;
 *  2. units whose files lack coverage at their current content come first, so they land in the earliest batches;
 *  3. units are packed in order, a unit that is too big alone being split file by file;
 *  4. a test with no source of the same name goes to the batch holding most files from its own folder, or, with
 *     none there, to the batch with the most room;
 *  5. batches holding uncovered files come before fully covered ones.
 */
export function planReviewBatchesV1(input: PlanReviewBatchesInputV1): ReviewBatchPlanV1 {
  const limits = input.limits ?? DEFAULT_REVIEW_READ_LIMITS_V1;
  const covered = new Set([...(input.coveredFiles ?? [])].map(normalizeV1));
  const byPath = new Map<string, ReviewBatchFileV1>();
  for (const file of input.files) {
    const rel = normalizeV1(file.path);
    if (rel.length > 0 && !byPath.has(rel)) {
      byPath.set(rel, { path: rel, readLines: Math.max(1, Math.floor(file.readLines)) });
    }
  }
  const all = [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
  const totalReadLines = sumLinesV1(all);
  const uncoveredOf = (files: readonly ReviewBatchFileV1[]): number => files.filter((file) => !covered.has(file.path)).length;
  const makeBatch = (files: readonly ReviewBatchFileV1[], oversized: boolean): Omit<ReviewBatchV1, "index"> => ({
    files: orderUncoveredFirstV1(files, covered).map((file) => file.path),
    readLines: sumLinesV1(files),
    uncoveredCount: uncoveredOf(files),
    oversized,
  });
  if (all.length === 0) return { batches: [], totalFiles: 0, totalReadLines: 0 };
  if (all.length <= limits.maxFiles && totalReadLines <= limits.maxLines) {
    return { batches: [{ index: 1, ...makeBatch(all, false) }], totalFiles: all.length, totalReadLines };
  }

  const tests = all.filter((file) => isTestFileV1(file.path));
  const sources = all.filter((file) => !isTestFileV1(file.path));
  const production = sources.filter((file) => isProductionSourceFileV1(file.path)).map((file) => file.path);
  const matchAgainst = production.length > 0 ? production : sources.map((file) => file.path);
  const units = new Map<string, UnitV1>();
  for (const source of sources) units.set(source.path, { files: [source], uncovered: 0 });
  const unmatchedTests: ReviewBatchFileV1[] = [];
  for (const test of tests) {
    const owner = matchSourceForTestV1(test.path, matchAgainst);
    const unit = owner === undefined ? undefined : units.get(owner);
    if (unit === undefined) unmatchedTests.push(test);
    else unit.files.push(test);
  }
  const orderedUnits = [...units.values()];
  for (const unit of orderedUnits) unit.uncovered = uncoveredOf(unit.files);
  // Stable sort: uncovered units first, otherwise path order (the units were built in path order).
  orderedUnits.sort((left, right) => Number(right.uncovered > 0) - Number(left.uncovered > 0));

  const work: WorkBatchV1[] = [];
  const fits = (batch: WorkBatchV1, extra: readonly ReviewBatchFileV1[]): boolean =>
    batch.files.length + extra.length <= limits.maxFiles && batch.lines + sumLinesV1(extra) <= limits.maxLines;
  let current: WorkBatchV1 | undefined;
  const place = (files: readonly ReviewBatchFileV1[]): void => {
    if (current !== undefined && fits(current, files)) {
      current.files.push(...files);
      current.lines += sumLinesV1(files);
      return;
    }
    const lines = sumLinesV1(files);
    if (files.length > limits.maxFiles || lines > limits.maxLines) {
      if (files.length > 1) {
        for (const file of files) place([file]);
        return;
      }
      work.push({ files: [...files], lines, oversized: true });
      current = undefined;
      return;
    }
    current = { files: [...files], lines, oversized: false };
    work.push(current);
  };
  for (const unit of orderedUnits) place(unit.files);

  for (const test of unmatchedTests) {
    const dir = dirOfV1(test.path);
    const sameDir = (batch: WorkBatchV1): number => batch.files.filter((file) => dirOfV1(file.path) === dir).length;
    const room = work.filter((batch) => !batch.oversized && fits(batch, [test]));
    const withDir = room.filter((batch) => sameDir(batch) > 0).sort((left, right) => sameDir(right) - sameDir(left));
    const target = withDir[0] ?? [...room].sort((left, right) => left.lines - right.lines)[0];
    if (target === undefined) {
      work.push({ files: [test], lines: test.readLines, oversized: test.readLines > limits.maxLines });
    } else {
      target.files.push(test);
      target.lines += test.readLines;
    }
  }

  const batches = work
    .map((batch) => makeBatch(batch.files, batch.oversized))
    .sort((left, right) => Number(right.uncoveredCount > 0) - Number(left.uncoveredCount > 0))
    .map((batch, position) => ({ index: position + 1, ...batch }));
  return { batches, totalFiles: all.length, totalReadLines };
}

/** "Reviewing in 4 parts (about 50 files each): part 2 of 4". Empty for a single pass. */
export function describeBatchProgressV1(plan: ReviewBatchPlanV1, index: number): string {
  const count = plan.batches.length;
  if (count <= 1) return "";
  const about = Math.max(1, Math.round(plan.totalFiles / count));
  return `Reviewing in ${count} parts (about ${about} files each): part ${index} of ${count}`;
}

/**
 * review2 Step 31: split a batch whose reviewer said it did not inspect all of it. The files it declined, or the whole
 * batch when the reviewer said so only in prose, are planned again under halved limits, so the next passes are
 * smaller. Returns the plan that replaces it (more than one batch), or `undefined` when it cannot get smaller.
 */
export function splitBatchFurtherV1(
  batch: ReviewBatchV1,
  costs: ReadonlyMap<string, number>,
  declined: readonly string[],
  limits: ReviewReadLimitsV1 = DEFAULT_REVIEW_READ_LIMITS_V1
): ReviewBatchPlanV1 | undefined {
  if (batch.files.length <= 1) return undefined;
  const wanted = new Set(declined.map(normalizeV1).filter((file) => batch.files.includes(file)));
  const chosen = wanted.size > 0 ? batch.files.filter((file) => wanted.has(file)) : [...batch.files];
  const files = chosen.map((file) => ({ path: file, readLines: costs.get(file) ?? 1 }));
  const halved: ReviewReadLimitsV1 = {
    maxLines: Math.max(1, Math.min(limits.maxLines, Math.ceil(sumLinesV1(files) / 2))),
    maxFiles: Math.max(1, Math.min(limits.maxFiles, Math.ceil(files.length / 2))),
  };
  const plan = planReviewBatchesV1({ files, limits: halved });
  return plan.batches.length > 1 ? plan : undefined;
}

export interface BatchVerdictV1 {
  readonly index: number;
  readonly score: number;
  readonly blockers: readonly string[];
  /** Files of the batch this pass read in full. */
  readonly filesRead: number;
  readonly filesInBatch: number;
}

export interface CombinedBatchVerdictV1 {
  /** The lowest batch score; `undefined` with no batch reviewed yet. */
  readonly score: number | undefined;
  readonly blockers: readonly string[];
  readonly filesRead: number;
  readonly filesTotal: number;
  /** Every batch of the set has a verdict that read all its files. */
  readonly complete: boolean;
}

/**
 * review2 Step 30: the stage's combined verdict. Blockers from every batch (a blocker raised by two batches counts
 * once), the lowest score, and "covered N of M files". It is complete only when every batch of the plan has a
 * verdict that read every file of its batch.
 */
export function combineBatchVerdictsV1(plan: ReviewBatchPlanV1, verdicts: readonly BatchVerdictV1[]): CombinedBatchVerdictV1 {
  const latest = new Map<number, BatchVerdictV1>();
  for (const verdict of verdicts) latest.set(verdict.index, verdict);
  const seen = new Set<string>();
  const blockers: string[] = [];
  let score: number | undefined;
  let filesRead = 0;
  for (const verdict of latest.values()) {
    score = score === undefined ? verdict.score : Math.min(score, verdict.score);
    filesRead += verdict.filesRead;
    for (const blocker of verdict.blockers) {
      const key = blocker.trim().replace(/\s+/g, " ");
      if (key.length > 0 && !seen.has(key)) {
        seen.add(key);
        blockers.push(blocker);
      }
    }
  }
  const complete =
    plan.batches.length > 0 &&
    plan.batches.every((batch) => {
      const verdict = latest.get(batch.index);
      return verdict !== undefined && verdict.filesRead >= batch.files.length;
    });
  return { score, blockers, filesRead, filesTotal: plan.totalFiles, complete };
}

/**
 * review2 Step 30: after an Apply Review only the batches whose files changed are reviewed again. `changedSince` is
 * the set of files whose content differs from what the batch's review read.
 */
export function batchesToRerunV1(plan: ReviewBatchPlanV1, changedSince: ReadonlySet<string>): readonly number[] {
  return plan.batches.filter((batch) => batch.files.some((file) => changedSince.has(file))).map((batch) => batch.index);
}
