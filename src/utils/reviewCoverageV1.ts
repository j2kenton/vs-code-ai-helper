/**
 * review2 Steps 17-19: which changed files a review has actually read, and what that means at the points where the
 * owner decides to move on.
 *
 * Pure: no `vscode`, no I/O. The record (`ReviewCoverageV1`, in task-progress.json) holds, per changed file, the
 * content hash it had when a review read it in full. A file the reviewer declared it did not fully inspect is never
 * entered, and a file whose current hash differs from its recorded one counts as unreviewed again.
 */
import { createHash } from "crypto";
import type { ReviewCoverageEntryV1, ReviewCoverageV1, TaskStage } from "../types/taskProgress";
import { isProductionSourceFileV1 } from "./reviewScopeGapV1";

/** The heading the review prompts ask for; one path per bullet, or "none". */
export const FILES_NOT_INSPECTED_HEADING_V1 = "## Files not fully inspected";

/** Prompt variable carrying the review's change set (newline separated) from dispatch to routing. */
export const REVIEW_SCOPE_CHANGE_SET_VARIABLE_V1 = "reviewScopeChangeSet";

const HEADING_RE = /^#{1,6}\s*files\s+not\s+fully\s+inspected\s*:?\s*$/i;
const ANY_HEADING_RE = /^#{1,6}\s+\S/;

function normalizeRelV1(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/** Content hash used for coverage entries. */
export function hashFileContentV1(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** Hash recorded for a file that no longer exists, so a deleted file never matches a read one. */
export const DELETED_FILE_HASH_V1 = "deleted";

interface SectionSpanV1 {
  readonly start: number;
  readonly end: number;
}

/** Line span of the "Files not fully inspected" section (heading through the line before the next heading). */
function findSectionSpansV1(lines: readonly string[]): SectionSpanV1[] {
  const spans: SectionSpanV1[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!HEADING_RE.test(lines[index]!.trim())) continue;
    let end = index + 1;
    while (end < lines.length && !ANY_HEADING_RE.test(lines[end]!.trim()) && !/^<!--/.test(lines[end]!.trim())) {
      end++;
    }
    spans.push({ start: index, end });
    index = end - 1;
  }
  return spans;
}

/** Paths listed under "## Files not fully inspected". "none" (or no bullets) gives an empty list. */
export function parseFilesNotFullyInspectedV1(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const files: string[] = [];
  for (const span of findSectionSpansV1(lines)) {
    for (const line of lines.slice(span.start + 1, span.end)) {
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (!bullet) continue;
      const text = bullet[1]!.trim();
      const ticked = /`([^`]+)`/.exec(text);
      const candidate = (ticked ? ticked[1]! : text.split(/\s+[—–-]\s+/)[0]!).trim().replace(/[.,;:]+$/, "");
      if (candidate.length === 0 || /^\(?none\)?$/i.test(candidate)) continue;
      files.push(normalizeRelV1(candidate));
    }
  }
  return [...new Set(files)];
}

/** True when the review has the heading at all (even as "none"): the reviewer answered the question. */
export function hasFilesNotInspectedSectionV1(content: string): boolean {
  return findSectionSpansV1(content.split(/\r?\n/)).length > 0;
}

/**
 * Removes every "Files not fully inspected" section. Run on the previous review file before a new review starts,
 * so a list the reviewer copies forward cannot stand in for its own answer (review2 Step 17).
 */
export function stripFilesNotFullyInspectedV1(content: string): string {
  const lines = content.split(/\r?\n/);
  const spans = findSectionSpansV1(lines);
  if (spans.length === 0) return content;
  const drop = new Set<number>();
  for (const span of spans) {
    for (let index = span.start; index < span.end; index++) drop.add(index);
  }
  const kept = lines.filter((_line, index) => !drop.has(index));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The prose form of "I did not inspect everything", for a reviewer that skipped the heading. Used by Part 6's
 * split rule; coverage itself trusts only the list.
 */
export function statesIncompleteInspectionV1(content: string): boolean {
  return /\b(did not|didn't|could not|couldn't|have not|haven't)\s+(?:independently\s+)?(?:inspect|read|review)\b[^.\n]*\b(every|all|entire|whole|remaining)\b/i.test(
    content
  );
}

export interface RecordReviewCoverageInputV1 {
  readonly record: ReviewCoverageV1 | undefined;
  /** The change set the review ran against. */
  readonly changedFiles: readonly string[];
  /** Files the review was shown (embedded or read natively): the change set minus the files outside its pack. */
  readonly shownFiles: readonly string[];
  /** Files the reviewer declared it did not fully inspect. */
  readonly notInspected: readonly string[];
  /** Current content hash of each shown file (`DELETED_FILE_HASH_V1` for a missing file). */
  readonly hashes: ReadonlyMap<string, string>;
  readonly runId: string;
  readonly stage: TaskStage;
  readonly now: string;
}

/**
 * The record after one review: every shown file the reviewer did not decline gets this review's hash. A declined file
 * keeps nothing from an earlier review unless the earlier entry's hash still matches (it was read then, unchanged).
 */
export function recordReviewCoverageV1(input: RecordReviewCoverageInputV1): ReviewCoverageV1 {
  const changed = [...new Set(input.changedFiles.map(normalizeRelV1).filter((file) => file.length > 0))].sort();
  const declined = new Set(input.notInspected.map(normalizeRelV1));
  const files: Record<string, ReviewCoverageEntryV1> = {};
  for (const [file, entry] of Object.entries(input.record?.files ?? {})) {
    files[file] = entry;
  }
  for (const raw of input.shownFiles) {
    const file = normalizeRelV1(raw);
    if (file.length === 0 || declined.has(file)) continue;
    const hash = input.hashes.get(file);
    if (hash === undefined || hash === DELETED_FILE_HASH_V1) continue;
    files[file] = { hash, runId: input.runId, stage: input.stage };
  }
  // Keep entries only for files still in the change set, so the record cannot grow past the change.
  const keep = new Set(changed);
  for (const file of Object.keys(files)) {
    if (!keep.has(file)) delete files[file];
  }
  return { files, changedFiles: changed, updatedAt: input.now };
}

export interface ReviewCoverageSummaryV1 {
  readonly changedCount: number;
  readonly reviewedCount: number;
  readonly unreviewed: readonly string[];
  readonly unreviewedProduction: readonly string[];
  readonly productionChangedCount: number;
  readonly productionReviewedCount: number;
}

/**
 * N of M for the current tree. `changedFiles` is the live change set (the record's snapshot plus any file added
 * since); `currentHashes` maps each file to its content hash now. A file counts as reviewed only when a review
 * recorded exactly that hash.
 */
export function computeReviewCoverageV1(
  record: ReviewCoverageV1 | undefined,
  changedFiles: readonly string[],
  currentHashes: ReadonlyMap<string, string>
): ReviewCoverageSummaryV1 {
  const changed = [...new Set(changedFiles.map(normalizeRelV1).filter((file) => file.length > 0))].sort();
  const unreviewed = changed.filter((file) => {
    const entry = record?.files[file];
    const hash = currentHashes.get(file);
    return entry === undefined || hash === undefined || entry.hash !== hash;
  });
  const production = changed.filter(isProductionSourceFileV1);
  const unreviewedProduction = unreviewed.filter(isProductionSourceFileV1);
  return {
    changedCount: changed.length,
    reviewedCount: changed.length - unreviewed.length,
    unreviewed,
    unreviewedProduction,
    productionChangedCount: production.length,
    productionReviewedCount: production.length - unreviewedProduction.length,
  };
}

/** "Reviewed: 40 of 206 changed files". */
export function describeReviewedLineV1(summary: ReviewCoverageSummaryV1): string {
  return `Reviewed: ${summary.reviewedCount} of ${summary.changedCount} changed files`;
}

/** A tree row's description with the coverage line after the score ("8/10 · Reviewed: 40 of 206 changed files"). */
export function appendReviewedLineV1(description: string | boolean | undefined, line: string | undefined): string | undefined {
  const existing = typeof description === "string" && description.length > 0 ? description : undefined;
  if (line === undefined) return existing;
  return existing === undefined ? line : `${existing} · ${line}`;
}

/** Singular/plural for a count of files. */
export function filesPhraseV1(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** The warning Advance to Publish and Commit & Push show; `undefined` when every changed file was reviewed. */
export function describeUnreviewedWarningV1(summary: ReviewCoverageSummaryV1): string | undefined {
  const missing = summary.changedCount - summary.reviewedCount;
  if (missing <= 0) return undefined;
  return (
    `${missing} changed ${missing === 1 ? "file has" : "files have"} not been reviewed ` +
    `(${describeReviewedLineV1(summary)}).`
  );
}

/** The chat line recording the owner's confirmation to move on with unreviewed files. */
export function describeUnreviewedConfirmationV1(summary: ReviewCoverageSummaryV1, action: string): string {
  const missing = summary.changedCount - summary.reviewedCount;
  return `You confirmed: ${action} with ${filesPhraseV1(missing)} not reviewed (${describeReviewedLineV1(summary)}).`;
}

/** The label a confirmation option carries; names the number so the owner cannot confirm it unseen. */
export function unreviewedConfirmLabelV1(summary: ReviewCoverageSummaryV1, action: string): string {
  const missing = summary.changedCount - summary.reviewedCount;
  return `${action} with ${filesPhraseV1(missing)} unreviewed`;
}
