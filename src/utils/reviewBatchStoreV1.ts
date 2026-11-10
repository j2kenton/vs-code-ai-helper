/**
 * review2 Step 30: the per-batch verdicts of one stage and the combined verdict the stage's review file is rewritten
 * to. No `vscode` import.
 *
 * Each batch pass is recorded with the files it read in full and their content hashes. A record stays valid while
 * every one of those files still has the hash it had when the pass read it, so after an Apply Review only the passes
 * whose files changed fall out of the combined verdict and are reviewed again.
 */
import { combineBatchVerdictsV1, type ReviewBatchPlanV1 } from "./reviewBatchPlanV1";

export interface BatchPassRecordV1 {
  readonly position: number;
  readonly count: number;
  /** The batch's files, as planned. */
  readonly files: readonly string[];
  /** Files the pass read in full (embedded or natively, and not declared uninspected). */
  readonly filesRead: readonly string[];
  /** Planned files the reviewer said it did not inspect (its list, or its prose for the whole batch). The batch is split further. */
  readonly declinedFiles?: readonly string[];
  /** Content hash of each file read, at the time of the pass. */
  readonly hashes: Readonly<Record<string, string>>;
  readonly score: number | null;
  /** The pass's own blocker lines, as the reviewer wrote them. */
  readonly blockerLines: readonly string[];
  readonly runId: string;
  readonly at: string;
}

export type BatchStoreV1 = Readonly<Record<string, readonly BatchPassRecordV1[]>>;

const BLOCKERS_BLOCK_RE = /(<!--\s*blockers:start\s*-->)([\s\S]*?)(<!--\s*blockers:end\s*-->)/i;
const READINESS_LINE_RE = /^Readiness:\s*(?:10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10\s*$/m;

/** The blocker lines inside the review's `<!-- blockers:start -->` block (empty with no block). */
export function extractBlockerLinesV1(content: string): string[] {
  const match = BLOCKERS_BLOCK_RE.exec(content);
  if (match === null) return [];
  return (match[2] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s/.test(line));
}

/** A blocker line without its lineage tag, so the same finding raised by two passes counts once. */
export function blockerKeyV1(line: string): string {
  return line
    .replace(/\[\s*(?:new|same\s*:\s*[\w-]+|narrowed\s*:\s*[\w-]+)\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The records whose files all still have the hash the pass read them at. */
export function validBatchRecordsV1(
  records: readonly BatchPassRecordV1[],
  currentHashes: ReadonlyMap<string, string>
): BatchPassRecordV1[] {
  return records.filter((record) => record.filesRead.every((file) => currentHashes.get(file) === record.hashes[file]));
}

/** Adds `next`, dropping earlier records it makes redundant (all their files are among its own). */
export function upsertBatchRecordV1(records: readonly BatchPassRecordV1[], next: BatchPassRecordV1): BatchPassRecordV1[] {
  const nextFiles = new Set(next.filesRead);
  const nextPlanned = new Set(next.files);
  // A record that read nothing (the reviewer declined its whole batch) is redundant once a later pass planned all its files.
  const redundant = (record: BatchPassRecordV1): boolean =>
    record.filesRead.length > 0
      ? record.filesRead.every((file) => nextFiles.has(file))
      : record.files.every((file) => nextPlanned.has(file));
  return [...records.filter((record) => !redundant(record)), next];
}

export interface CombinedBatchReviewV1 {
  readonly score: number | undefined;
  /** Blocker lines from every valid pass, one per finding. */
  readonly blockerLines: readonly string[];
  readonly filesRead: number;
  readonly filesTotal: number;
  /** Scope files no valid pass has read. */
  readonly unreadFiles: readonly string[];
  readonly complete: boolean;
}

/**
 * The stage's combined verdict over `scopeFiles`: lowest score, blockers from every pass, and the files still unread.
 * Complete only when every scope file was read by some valid pass.
 */
export function combineBatchRecordsV1(scopeFiles: readonly string[], records: readonly BatchPassRecordV1[]): CombinedBatchReviewV1 {
  const scope = [...new Set(scopeFiles)];
  const plan: ReviewBatchPlanV1 = {
    batches: records.map((record, position) => ({
      index: position + 1,
      files: record.filesRead,
      readLines: 0,
      uncoveredCount: 0,
      oversized: false,
    })),
    totalFiles: scope.length,
    totalReadLines: 0,
  };
  const scored = records.filter((record) => record.score !== null);
  const combined = combineBatchVerdictsV1(
    plan,
    scored.map((record) => ({
      index: records.indexOf(record) + 1,
      score: record.score ?? 0,
      blockers: [],
      filesRead: record.filesRead.length,
      filesInBatch: record.filesRead.length,
    }))
  );
  // The same finding raised by two passes (lineage tags aside) counts once.
  const seen = new Set<string>();
  const blockerLines: string[] = [];
  for (const line of records.flatMap((record) => record.blockerLines)) {
    const key = blockerKeyV1(line);
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      blockerLines.push(line);
    }
  }
  const read = new Set(records.flatMap((record) => record.filesRead));
  const unreadFiles = scope.filter((file) => !read.has(file));
  return {
    score: combined.score,
    blockerLines,
    filesRead: scope.length - unreadFiles.length,
    filesTotal: scope.length,
    unreadFiles,
    complete: scope.length > 0 && unreadFiles.length === 0,
  };
}

/**
 * The review file rewritten as the combined verdict: the Readiness line shows the lowest score, the blockers block
 * lists the blockers of every pass, and a "Review parts" section says what each pass read. A review with no Readiness
 * line or no blockers block keeps that part as the reviewer wrote it.
 */
export function rewriteReviewAsCombinedV1(
  content: string,
  combined: CombinedBatchReviewV1,
  records: readonly BatchPassRecordV1[]
): string {
  let next = content;
  if (combined.score !== undefined && READINESS_LINE_RE.test(next)) {
    next = next.replace(READINESS_LINE_RE, `Readiness: ${combined.score}/10`);
  }
  if (BLOCKERS_BLOCK_RE.test(next)) {
    const body = combined.blockerLines.length > 0 ? `\n${combined.blockerLines.join("\n")}\n` : "\n";
    next = next.replace(BLOCKERS_BLOCK_RE, (_all, open: string, _old: string, close: string) => `${open}${body}${close}`);
  }
  const rows = records.map(
    (record) =>
      `- Part ${record.position} of ${record.count}: read ${record.filesRead.length} of ${record.files.length} files, ` +
      `score ${record.score === null ? "not given" : `${record.score}/10`}, ${record.blockerLines.length} blocker(s) (run ${record.runId}).`
  );
  const section =
    `\n\n## Review parts\n\nCovered ${combined.filesRead} of ${combined.filesTotal} files across ${records.length} part(s)` +
    `${combined.complete ? "" : `; ${combined.unreadFiles.length} not yet read`}. ` +
    `The score is the lowest of the parts.\n\n${rows.join("\n")}\n`;
  const withoutOld = next.replace(/\n*## Review parts\n[\s\S]*?(?=\n## |\n<!--|$)/, "");
  const marker = /\n<!--\s*(?:progress|reviewed-commit)/.exec(withoutOld);
  return marker === null
    ? `${withoutOld.trimEnd()}${section}`
    : `${withoutOld.slice(0, marker.index).trimEnd()}${section}${withoutOld.slice(marker.index)}`;
}
