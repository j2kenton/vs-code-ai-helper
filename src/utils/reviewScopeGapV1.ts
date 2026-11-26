/**
 * bugs5 Step 27 (item 15): compare what a review is shown with what the task actually changed, and say so when
 * files are missing. A review that scored 8/10 on 40 of 88 changed files used to read as a review of the task.
 *
 * Pure: no `vscode`, no I/O. `reviewActions.ts` gathers the inputs (round ledger rows, the working tree's
 * changes against HEAD) and appends the section this module formats to the review's context pack.
 */

import { isMachineMaintainedArtifactPathV1 } from "./implReviewFileSelection";

export interface ReviewScopeGapInputV1 {
  /** Every ledger row's `filesChanged`, workspace-relative. */
  readonly ledgerFiles: readonly string[];
  /** Working-tree changes against HEAD (modified, added, untracked), workspace-relative. */
  readonly workingTreeFiles: readonly string[];
  /** The review's scope (`implReviewFiles`), workspace-relative. */
  readonly scopeFiles: readonly string[];
  /** Paths held back on purpose (an incomplete round's quarantine); never reported as missing. */
  readonly quarantinedFiles?: readonly string[];
  /**
   * Paths other open tasks claim (their tracked scope, quarantine or ledger). A working-tree change that one of
   * them claims is not this task's, unless this task's own ledger or scope also names it.
   */
  readonly otherTaskFiles?: readonly string[];
  /**
   * Workspace-relative folders that hold task records, not code (the configured task root, which is not always
   * `.ensemble`). Nothing under them is part of the change set.
   */
  readonly taskRecordFolders?: readonly string[];
}

export interface ReviewScopeGapV1 {
  readonly changeSet: readonly string[];
  readonly missing: readonly string[];
  readonly reviewedCount: number;
  readonly changedCount: number;
  readonly productionChangedCount: number;
  readonly productionReviewedCount: number;
  readonly missingProduction: readonly string[];
}

function normalizeRelV1(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isTaskMetadataV1(file: string): boolean {
  return file === ".ensemble" || file.startsWith(".ensemble/");
}

/** Source under `src/` or `packages/` that is not a test or a fixture. */
export function isProductionSourceFileV1(file: string): boolean {
  const rel = normalizeRelV1(file);
  if (!(rel.startsWith("src/") || rel.startsWith("packages/"))) {
    return false;
  }
  if (/(^|\/)(test|tests|__tests__|fixtures)\//.test(rel)) {
    return false;
  }
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/** The task's change set (ledger plus working tree, `.ensemble/` left out) against the review's scope. */
export function computeReviewScopeGapV1(input: ReviewScopeGapInputV1): ReviewScopeGapV1 {
  const quarantined = new Set((input.quarantinedFiles ?? []).map(normalizeRelV1));
  const changeSet = new Set<string>();
  const ownLedger = new Set(input.ledgerFiles.map(normalizeRelV1));
  const scope = new Set(input.scopeFiles.map(normalizeRelV1));
  const claimedElsewhere = new Set((input.otherTaskFiles ?? []).map(normalizeRelV1));
  const recordFolders = (input.taskRecordFolders ?? [])
    .map((folder) => normalizeRelV1(folder).replace(/\/+$/, ""))
    .filter((folder) => folder.length > 0 && folder !== "." && !folder.startsWith(".."));
  const addToChangeSet = (file: string, fromWorkingTree: boolean): void => {
    const rel = normalizeRelV1(file);
    if (
      rel.length === 0 ||
      isTaskMetadataV1(rel) ||
      // Lockfiles, minified bundles and the like never enter a review's scope (`updateImplReviewFiles`
      // drops them), so counting them as changed would report them as missing forever.
      isMachineMaintainedArtifactPathV1(rel) ||
      quarantined.has(rel) ||
      recordFolders.some((folder) => rel === folder || rel.startsWith(`${folder}/`))
    ) {
      return;
    }
    if (fromWorkingTree && claimedElsewhere.has(rel) && !ownLedger.has(rel) && !scope.has(rel)) {
      return;
    }
    changeSet.add(rel);
  };
  input.ledgerFiles.forEach((file) => addToChangeSet(file, false));
  input.workingTreeFiles.forEach((file) => addToChangeSet(file, true));
  const changed = [...changeSet].sort();
  const missing = changed.filter((file) => !scope.has(file));
  const production = changed.filter(isProductionSourceFileV1);
  const missingProduction = missing.filter(isProductionSourceFileV1);
  return {
    changeSet: changed,
    missing,
    reviewedCount: changed.length - missing.length,
    changedCount: changed.length,
    productionChangedCount: production.length,
    productionReviewedCount: production.length - missingProduction.length,
    missingProduction,
  };
}

/** "Reviewed 40 of 88 changed files (25 of 88 production files)". */
export function describeReviewedCountV1(gap: ReviewScopeGapV1): string {
  return (
    `Reviewed ${gap.reviewedCount} of ${gap.changedCount} changed files ` +
    `(${gap.productionReviewedCount} of ${gap.productionChangedCount} production files)`
  );
}

const MAX_LISTED_MISSING_V1 = 120;

/**
 * The context-pack section for a partial scope; empty when nothing is missing, so a review whose scope matches
 * the change set shows nothing new.
 */
export function formatMissingFilesSectionV1(gap: ReviewScopeGapV1): string {
  if (gap.missing.length === 0) {
    return "";
  }
  // Production files first: they are the ones a reviewer most needs to know it has not seen.
  const ordered = [...gap.missingProduction, ...gap.missing.filter((file) => !isProductionSourceFileV1(file))];
  const listed = ordered.slice(0, MAX_LISTED_MISSING_V1).map((file) => `- ${file}`);
  const more = ordered.length - listed.length;
  return (
    "## Changed files not in this review's scope\n\n" +
    `${describeReviewedCountV1(gap)}. The ${gap.missing.length} files below changed in this task but are not part ` +
    "of the scope you were given. State in your verdict that the review covers only part of the change, and do " +
    "not treat the absence of findings in them as a pass.\n\n" +
    listed.join("\n") +
    (more > 0 ? `\n- … and ${more} more` : "") +
    "\n\n"
  );
}

/**
 * One plain chat line for when the tracked set was used because the round history could not confirm a
 * complete list. `undefined` when nothing is missing.
 */
export function describeTrackedScopeFallbackLineV1(trackedCount: number, gap: ReviewScopeGapV1): string | undefined {
  if (gap.missing.length === 0) {
    return undefined;
  }
  return (
    `Review scope: using the ${trackedCount} files already tracked; the round history couldn't confirm a complete list. ` +
    `${gap.missing.length} changed files are not included.`
  );
}
