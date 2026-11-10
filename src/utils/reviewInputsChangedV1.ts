/**
 * bugs3 Step 9: have the review's non-code inputs changed since it was dispatched?
 *
 * The commit and working-tree fingerprint say whether the CODE moved. A review
 * also read the task description (owner scope and evidence live in `task.md`)
 * and the plan, and the task folder is not part of the tree fingerprint, so an
 * owner edit there leaves "the tree is unchanged" true while the review no
 * longer describes what it was asked. A resumed "Keep iterating … from Apply
 * Review" that took such a review as current would fix against stale scope.
 *
 * At dispatch the review records a digest of each input ({@link recordReviewInputsV1}),
 * so an edit made while the review was running is seen too. The record belongs to
 * the artifact only when it is no newer than the artifact: a dispatch that failed
 * leaves the previous artifact in place, and its record must not vouch for it. With
 * no usable record, a file newer than the artifact counts as changed.
 *
 * `plan-final.md` carries checklist ticks and a round summary that change after
 * every review, so only its normalized text is compared (an edit to the plan's own
 * wording counts; a tick does not), and only against a recorded digest. One that
 * cannot be inspected counts as changed (unknown is not "the same"), and a missing
 * file is simply not an input.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { countNestedChecklistItemsV1, stripPlanItemAnnotationsV1 } from "./implementationChecklist";
import { PARTIAL_SCOPE_ACCEPTANCE_FILE_V1 } from "./reviewPartialScopeV1";

/**
 * `plan-final.md` is the plan of record: its substantive text (items, their
 * wording, scope notes) is a review input, but its tick state and the round
 * summary appended after each round change after every review. It is therefore
 * digested in a normalized form (see {@link normalizePlanOfRecordForDigestV1}) and has no
 * modification-time fallback, since a bare mtime cannot tell a tick from an edit.
 */
export const PLAN_OF_RECORD_FILENAME_V1 = "plan-final.md";

/**
 * review2 Step 9 (bugs6 item 31): the review's own scope is an input. The file list a review is given
 * (`implReviewFiles` in task-progress.json), the owner's partial-scope acceptance, and the task's `evidence/`
 * folder (where the review prompts tell agents to save gathered owner evidence) all change what the review should
 * say while the code tree stays exactly as it was.
 */
export const REVIEW_SCOPE_INPUT_V1 = "implReviewFiles";
export const REVIEW_SCOPE_ACCEPTANCE_INPUT_V1 = PARTIAL_SCOPE_ACCEPTANCE_FILE_V1;
export const REVIEW_EVIDENCE_INPUT_V1 = "evidence/";

export const REVIEW_INPUT_FILENAMES_V1: readonly string[] = [
  "task.md",
  "plan.md",
  PLAN_OF_RECORD_FILENAME_V1,
  REVIEW_SCOPE_INPUT_V1,
  REVIEW_SCOPE_ACCEPTANCE_INPUT_V1,
  REVIEW_EVIDENCE_INPUT_V1,
];

/** Inputs added after the first records were written: a record without one vouches for nothing about it and is not read as "changed". */
const INPUTS_ADDED_LATER_V1: ReadonlySet<string> = new Set([
  REVIEW_SCOPE_INPUT_V1,
  REVIEW_SCOPE_ACCEPTANCE_INPUT_V1,
  REVIEW_EVIDENCE_INPUT_V1,
]);

const EVIDENCE_DIGEST_MAX_FILES_V1 = 500;
const EVIDENCE_DIGEST_MAX_DEPTH_V1 = 4;

export const REVIEW_INPUTS_RECORD_FILENAME_V1 = "review-inputs-v1.json";

const ABSENT_DIGEST_V1 = "absent";
const UNREADABLE_DIGEST_V1 = "unreadable";

const LATEST_ROUND_SUMMARY_HEADING_V1 = "\n---\n\n## Latest implementation round summary";

/**
 * The plan of record without what rounds rewrite: every checkbox reads as unticked
 * and the appended latest-round summary is dropped, so only an edit to the plan's
 * own text changes the digest.
 */
export function normalizePlanOfRecordForDigestV1(text: string): string {
  const summaryAt = text.indexOf(LATEST_ROUND_SUMMARY_HEADING_V1);
  const body = summaryAt >= 0 ? text.slice(0, summaryAt) : text;
  // review1 Step 31: Ensemble's own settle notes (`— Checked: …`, `— Excluded by you: …`, owner-decision and
  // narrowing notes) and the exclusion marker are written when the owner ticks or excludes an item. They are not
  // an edit to the plan's wording, so they must not make the review on record look stale (an owner tick with a
  // note would otherwise suppress the "stage is done" card). Item lines only; the strip is per line.
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const item = /^(\s*(?:[-*]|\d+\.)\s+)\[[xX ]\](.*)$/.exec(line);
      return item ? `${item[1]}[ ]${stripPlanItemAnnotationsV1(item[2] ?? "")}` : line;
    })
    .join("\n");
}

/**
 * The workspace a review was dispatched against. `null` records "no repository, or
 * git could not say" so that is told apart from a record that predates the field.
 */
export interface ReviewWorkspaceIdentityV1 {
  readonly headSha: string | null;
  readonly treeFingerprint: string | null;
}

interface ReviewInputsRecordEntryV1 {
  readonly recordedAtMs: number;
  readonly digests: Readonly<Record<string, string>>;
  readonly workspace?: ReviewWorkspaceIdentityV1;
  /** Nested plan items at dispatch (bugs4 item 39); absent on records that predate it. */
  readonly nestedItemCount?: number;
  /** review2 Step 10: how many files the review's scope held at dispatch, so a changed scope can say "40 → 199". */
  readonly scopeFileCount?: number;
}

async function readScopeFilesV1(taskFolderPath: string): Promise<readonly string[] | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(taskFolderPath, "task-progress.json"), "utf8"));
    const files = (parsed as { implReviewFiles?: unknown } | null)?.implReviewFiles;
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : undefined;
  } catch {
    return undefined;
  }
}

/** File names and content hashes under the task's `evidence/` folder, in a stable order. */
async function digestEvidenceFolderV1(taskFolderPath: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(path.join(taskFolderPath, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (lines.length >= EVIDENCE_DIGEST_MAX_FILES_V1) return;
      const child = path.posix.join(relative.replace(/\\/g, "/"), entry.name);
      if (entry.isDirectory()) {
        if (depth < EVIDENCE_DIGEST_MAX_DEPTH_V1) await walk(child, depth + 1);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(taskFolderPath, child));
        lines.push(`${child}:${crypto.createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  await walk("evidence", 0);
  return lines.length === 0 ? ABSENT_DIGEST_V1 : crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

type ReviewInputsRecordV1 = Readonly<Record<string, ReviewInputsRecordEntryV1>>;

async function digestInputV1(taskFolderPath: string, name: string): Promise<string> {
  if (name === REVIEW_SCOPE_INPUT_V1) {
    const files = await readScopeFilesV1(taskFolderPath);
    return files === undefined ? ABSENT_DIGEST_V1 : crypto.createHash("sha256").update([...files].sort().join("\n")).digest("hex");
  }
  if (name === REVIEW_EVIDENCE_INPUT_V1) {
    try {
      return await digestEvidenceFolderV1(taskFolderPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? ABSENT_DIGEST_V1 : UNREADABLE_DIGEST_V1;
    }
  }
  try {
    const bytes = await fs.readFile(path.join(taskFolderPath, name));
    const hashed = name === PLAN_OF_RECORD_FILENAME_V1 ? normalizePlanOfRecordForDigestV1(bytes.toString("utf8")) : bytes;
    return crypto.createHash("sha256").update(hashed).digest("hex");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? ABSENT_DIGEST_V1 : UNREADABLE_DIGEST_V1;
  }
}

async function readRecordV1(taskFolderPath: string): Promise<ReviewInputsRecordV1> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(taskFolderPath, REVIEW_INPUTS_RECORD_FILENAME_V1), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReviewInputsRecordV1) : {};
  } catch {
    return {};
  }
}

/**
 * Records the inputs a review of `reviewArtifactPath` is dispatched against.
 * Best-effort: a courtesy record must never block the review itself.
 */
export async function recordReviewInputsV1(
  taskFolderPath: string,
  reviewArtifactPath: string,
  workspace?: ReviewWorkspaceIdentityV1
): Promise<void> {
  try {
    const digests: Record<string, string> = {};
    for (const name of REVIEW_INPUT_FILENAMES_V1) {
      digests[name] = await digestInputV1(taskFolderPath, name);
    }
    let nestedItemCount: number | undefined;
    try {
      nestedItemCount = countNestedChecklistItemsV1(
        await fs.readFile(path.join(taskFolderPath, PLAN_OF_RECORD_FILENAME_V1), "utf8")
      );
    } catch {
      nestedItemCount = undefined;
    }
    const scopeFileCount = (await readScopeFilesV1(taskFolderPath))?.length;
    const record = await readRecordV1(taskFolderPath);
    const next: ReviewInputsRecordV1 = {
      ...record,
      [path.basename(reviewArtifactPath)]: {
        recordedAtMs: Date.now(),
        digests,
        ...(nestedItemCount !== undefined ? { nestedItemCount } : {}),
        ...(scopeFileCount !== undefined ? { scopeFileCount } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
      },
    };
    await fs.writeFile(path.join(taskFolderPath, REVIEW_INPUTS_RECORD_FILENAME_V1), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // Unrecorded inputs fall back to the modification-time comparison.
  }
}

export async function reviewInputsChangedSinceV1(
  taskFolderPath: string,
  reviewArtifactPath: string
): Promise<{
  readonly changed: boolean;
  readonly changedFiles: readonly string[];
  /** review2 Step 10: set when the review's file scope changed and both counts are known ("40 → 199"). */
  readonly scopeChange?: { readonly from: number; readonly to: number };
}> {
  let reviewedAtMs: number;
  try {
    reviewedAtMs = (await fs.stat(reviewArtifactPath)).mtimeMs;
  } catch {
    // No artifact to compare against: nothing is known to be current.
    return { changed: true, changedFiles: [] };
  }
  const entry = (await readRecordV1(taskFolderPath))[path.basename(reviewArtifactPath)];
  const recorded =
    entry !== undefined &&
    typeof entry.recordedAtMs === "number" &&
    entry.recordedAtMs <= reviewedAtMs &&
    entry.digests !== null &&
    typeof entry.digests === "object"
      ? entry.digests
      : undefined;
  const changedFiles: string[] = [];
  for (const name of REVIEW_INPUT_FILENAMES_V1) {
    if (recorded !== undefined) {
      // A record written before the plan of record was an input vouches for nothing about
      // it: "unknown" is not "the same", so an existing plan of record counts as changed.
      const was = recorded[name] ?? (name === PLAN_OF_RECORD_FILENAME_V1 ? "unrecorded" : undefined);
      // An input added after this record was written: the record says nothing about it, so it is not "changed".
      if (was === undefined && INPUTS_ADDED_LATER_V1.has(name)) continue;
      const now = await digestInputV1(taskFolderPath, name);
      if (was === "unrecorded" && now === ABSENT_DIGEST_V1) {
        continue;
      }
      if (was !== now || now === UNREADABLE_DIGEST_V1) {
        changedFiles.push(name);
      }
      continue;
    }
    if (name === PLAN_OF_RECORD_FILENAME_V1) {
      // Nothing recorded to compare against, and a bare mtime cannot tell a tick from an
      // edit: an existing plan of record cannot be shown unchanged.
      if ((await digestInputV1(taskFolderPath, name)) !== ABSENT_DIGEST_V1) {
        changedFiles.push(name);
      }
      continue;
    }
    try {
      const { mtimeMs } = await fs.stat(path.join(taskFolderPath, name));
      if (mtimeMs > reviewedAtMs) {
        changedFiles.push(name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        changedFiles.push(name);
      }
    }
  }
  let scopeChange: { readonly from: number; readonly to: number } | undefined;
  if (changedFiles.includes(REVIEW_SCOPE_INPUT_V1) && typeof entry?.scopeFileCount === "number") {
    const nowFiles = await readScopeFilesV1(taskFolderPath);
    if (nowFiles !== undefined) scopeChange = { from: entry.scopeFileCount, to: nowFiles.length };
  }
  return { changed: changedFiles.length > 0, changedFiles, ...(scopeChange ? { scopeChange } : {}) };
}

/**
 * Has the workspace moved since the review was dispatched? Used for review stages whose
 * artifact carries no reviewed-commit stamp (plan reviews read the repository too), so
 * the dispatch-time identity in the inputs record is the only evidence. A review with no
 * usable record, a record that predates the field, or an identity git could not give on
 * either side cannot be shown unchanged and reads as changed — including two identities
 * that are both empty, since "no repository" and "git unreadable" are not told apart.
 */
export async function reviewWorkspaceChangedSinceV1(
  taskFolderPath: string,
  reviewArtifactPath: string,
  current: ReviewWorkspaceIdentityV1
): Promise<boolean> {
  let reviewedAtMs: number;
  try {
    reviewedAtMs = (await fs.stat(reviewArtifactPath)).mtimeMs;
  } catch {
    return true;
  }
  const entry = (await readRecordV1(taskFolderPath))[path.basename(reviewArtifactPath)];
  const was = entry?.workspace;
  if (
    entry === undefined ||
    typeof entry.recordedAtMs !== "number" ||
    entry.recordedAtMs > reviewedAtMs ||
    was === undefined ||
    was === null ||
    typeof was !== "object"
  ) {
    return true;
  }
  // `null` records "no repository, or git could not say" — the two are not told apart, so a
  // missing identity on either side cannot be shown unchanged (two unavailable reads would
  // otherwise bypass the re-review every time git is unreadable).
  return (
    was.headSha === null ||
    was.treeFingerprint === null ||
    current.headSha === null ||
    current.treeFingerprint === null ||
    was.headSha !== current.headSha ||
    was.treeFingerprint !== current.treeFingerprint
  );
}

/** One review input that changed after the review was dispatched. */
export interface StaleReviewInputV1 {
  readonly name: string;
  /** ISO time of the file's last modification, when it could be read. */
  readonly modifiedAt?: string;
}

/**
 * bugs4 Step 13 (item 29): has `task.md` or the plan of record changed since the review
 * was dispatched, so that its verdict (and a "ready to move on" reading of it) no longer
 * describes the task?
 *
 * Unlike {@link reviewInputsChangedSinceV1} this gates the owner's advance, so it answers
 * only from a usable dispatch-time record: a legacy review with no record (or one newer than
 * its artifact) is reported as `recorded: false` and not stale. A modification-time guess
 * must not raise a "your plan changed" warning about an edit nobody can show was made after
 * the review. Ticks never count (the plan of record is digested with its boxes normalized
 * and its round summary dropped); a nested child, a reworded item or a new hand-off line does.
 */
export async function staleReviewInputsV1(
  taskFolderPath: string,
  reviewArtifactPath: string
): Promise<{
  readonly recorded: boolean;
  readonly stale: readonly StaleReviewInputV1[];
  /** Nested plan items present now beyond the count the review recorded; 0 when unknown or none. */
  readonly nestedItemsAdded: number;
}> {
  let reviewedAtMs: number;
  try {
    reviewedAtMs = (await fs.stat(reviewArtifactPath)).mtimeMs;
  } catch {
    return { recorded: false, stale: [], nestedItemsAdded: 0 };
  }
  const entry = (await readRecordV1(taskFolderPath))[path.basename(reviewArtifactPath)];
  if (
    entry === undefined ||
    typeof entry.recordedAtMs !== "number" ||
    entry.recordedAtMs > reviewedAtMs ||
    entry.digests === null ||
    typeof entry.digests !== "object"
  ) {
    return { recorded: false, stale: [], nestedItemsAdded: 0 };
  }
  const stale: StaleReviewInputV1[] = [];
  for (const name of ["task.md", PLAN_OF_RECORD_FILENAME_V1]) {
    const was = entry.digests[name];
    if (was === undefined) {
      continue;
    }
    const now = await digestInputV1(taskFolderPath, name);
    // An unreadable file is not evidence of an edit; a file that appeared or vanished is.
    if (now === UNREADABLE_DIGEST_V1 || was === now) {
      continue;
    }
    let modifiedAt: string | undefined;
    try {
      modifiedAt = new Date((await fs.stat(path.join(taskFolderPath, name))).mtimeMs).toISOString();
    } catch {
      modifiedAt = undefined;
    }
    stale.push({ name, ...(modifiedAt !== undefined ? { modifiedAt } : {}) });
  }
  let nestedItemsAdded = 0;
  if (typeof entry.nestedItemCount === "number") {
    try {
      const now = countNestedChecklistItemsV1(
        await fs.readFile(path.join(taskFolderPath, PLAN_OF_RECORD_FILENAME_V1), "utf8")
      );
      nestedItemsAdded = Math.max(0, now - entry.nestedItemCount);
    } catch {
      nestedItemsAdded = 0;
    }
  }
  return { recorded: true, stale, nestedItemsAdded };
}
