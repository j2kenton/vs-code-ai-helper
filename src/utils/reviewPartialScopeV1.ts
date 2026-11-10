/**
 * bugs5 Step 27 (item 15), the stage-hold half: a review whose scope is known to miss changed files says so in its
 * verdict, and its score does not clear the stage until the owner adds the files or accepts the gap.
 *
 * Pure: no `vscode`, no I/O. `reviewActions.ts` carries the gap from dispatch to routing through the prompt
 * `variables` (the same way the open-editors fallback travels), and `partialScopeDecisionV1.ts` owns the card.
 */
import { createHash } from "crypto";
import { IMPL_REVIEW_STAGES, type TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";

export const REVIEW_SCOPE_PARTIAL_COUNT_VARIABLE = "reviewScopePartialMissing";
export const REVIEW_SCOPE_PARTIAL_SUMMARY_VARIABLE = "reviewScopePartialSummary";
export const REVIEW_SCOPE_PARTIAL_HASH_VARIABLE = "reviewScopePartialHash";
export const REVIEW_SCOPE_PARTIAL_FILES_VARIABLE = "reviewScopePartialFiles";
/** The missing files that ARE in the review list but that the pack's size limit had no room for (review2 Step 22). */
export const REVIEW_SCOPE_PARTIAL_SIZE_LIMIT_FILES_VARIABLE = "reviewScopePartialSizeLimitFiles";

/** The owner's acceptance of a partial scope, stored beside the task's other records. */
export const PARTIAL_SCOPE_ACCEPTANCE_FILE_V1 = "review-scope-accepted-v1.json";

export const REVIEW_PARTIAL_SCOPE_MARKER_RE = /<!--\s*review-scope:\s*partial\s*-->/i;

export interface PartialReviewScopeV1 {
  readonly missingCount: number;
  /** "Reviewed 40 of 88 changed files (25 of 88 production files)". */
  readonly summary: string;
  /** Identifies this exact set of missing files, so an acceptance covers only the gap the owner saw. */
  readonly hash: string;
  readonly files: readonly string[];
  /**
   * The subset of `files` that is in the review list but that the review had no room for (size limit). The rest are
   * missing from the list. Absent when the review had no such files.
   */
  readonly sizeLimitFiles?: readonly string[];
}

export interface PartialScopeAcceptanceV1 {
  readonly stage: TaskStage;
  readonly hash: string;
  readonly missingCount: number;
  readonly acceptedAt: string;
}

export function hashMissingFilesV1(files: readonly string[]): string {
  const sorted = [...new Set(files.map((file) => file.replace(/\\/g, "/")))].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}

/** The variables dispatch sets when an implementation review's scope misses changed files. */
export function partialScopeVariablesV1(
  missing: readonly string[],
  summary: string,
  sizeLimitFiles: readonly string[] = []
): Record<string, string> {
  const cut = sizeLimitFiles.filter((file) => missing.includes(file));
  return {
    [REVIEW_SCOPE_PARTIAL_COUNT_VARIABLE]: String(missing.length),
    [REVIEW_SCOPE_PARTIAL_SUMMARY_VARIABLE]: summary,
    [REVIEW_SCOPE_PARTIAL_HASH_VARIABLE]: hashMissingFilesV1(missing),
    [REVIEW_SCOPE_PARTIAL_FILES_VARIABLE]: missing.join("\n"),
    ...(cut.length > 0 ? { [REVIEW_SCOPE_PARTIAL_SIZE_LIMIT_FILES_VARIABLE]: cut.join("\n") } : {}),
  };
}

/** The partial scope a review ran with, or `undefined` for a plan review or a scope that matched the change set. */
export function partialScopeFromVariablesV1(
  variables: Readonly<Record<string, string>>,
  stage: TaskStage
): PartialReviewScopeV1 | undefined {
  if (!IMPL_REVIEW_STAGES.includes(stage)) {
    return undefined;
  }
  const missingCount = Number(variables[REVIEW_SCOPE_PARTIAL_COUNT_VARIABLE] ?? 0);
  if (!Number.isFinite(missingCount) || missingCount <= 0) {
    return undefined;
  }
  const files = (variables[REVIEW_SCOPE_PARTIAL_FILES_VARIABLE] ?? "").split("\n").filter((file) => file.length > 0);
  const sizeLimitFiles = (variables[REVIEW_SCOPE_PARTIAL_SIZE_LIMIT_FILES_VARIABLE] ?? "")
    .split("\n")
    .filter((file) => file.length > 0);
  return {
    missingCount,
    summary: variables[REVIEW_SCOPE_PARTIAL_SUMMARY_VARIABLE] ?? `${missingCount} changed files were not reviewed`,
    hash: variables[REVIEW_SCOPE_PARTIAL_HASH_VARIABLE] ?? hashMissingFilesV1(files),
    files,
    ...(sizeLimitFiles.length > 0 ? { sizeLimitFiles } : {}),
  };
}

export function parsePartialScopeAcceptanceV1(raw: unknown): PartialScopeAcceptanceV1 | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.stage !== "string" ||
    typeof record.hash !== "string" ||
    typeof record.missingCount !== "number" ||
    typeof record.acceptedAt !== "string"
  ) {
    return undefined;
  }
  return {
    stage: record.stage as TaskStage,
    hash: record.hash,
    missingCount: record.missingCount,
    acceptedAt: record.acceptedAt,
  };
}

/**
 * review2 Step 14: the gap the latest review of a stage ran with, kept beside the acceptance record. A Fast Forward
 * stop for a partial scope reads it to put the scope card back when the owner answered "Not now" (or the card was
 * withdrawn), so a stop is never left without a card to answer.
 */
export const PARTIAL_SCOPE_GAP_FILE_V1 = "review-scope-gap-v1.json";

export interface PartialScopeGapRecordV1 {
  readonly stage: TaskStage;
  readonly scope: PartialReviewScopeV1;
  readonly score: number | null;
  readonly threshold: number;
  readonly scoreClears: boolean;
  readonly recordedAt: string;
}

export function parsePartialScopeGapRecordV1(raw: unknown): PartialScopeGapRecordV1 | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const scope = record.scope as Record<string, unknown> | undefined;
  if (
    typeof record.stage !== "string" ||
    typeof scope !== "object" ||
    scope === null ||
    typeof scope.hash !== "string" ||
    typeof scope.summary !== "string" ||
    typeof scope.missingCount !== "number" ||
    !Array.isArray(scope.files) ||
    typeof record.threshold !== "number" ||
    typeof record.recordedAt !== "string"
  ) {
    return undefined;
  }
  return {
    stage: record.stage as TaskStage,
    scope: {
      hash: scope.hash,
      summary: scope.summary,
      missingCount: scope.missingCount,
      files: scope.files.filter((file): file is string => typeof file === "string"),
      ...(Array.isArray(scope.sizeLimitFiles) && scope.sizeLimitFiles.length > 0
        ? { sizeLimitFiles: scope.sizeLimitFiles.filter((file): file is string => typeof file === "string") }
        : {}),
    },
    score: typeof record.score === "number" ? record.score : null,
    threshold: record.threshold,
    scoreClears: record.scoreClears === true,
    recordedAt: record.recordedAt,
  };
}

/** What the chat says when a partial-scope stop has no card to point at and no recorded gap to rebuild one from. */
export const PARTIAL_SCOPE_NO_GAP_RECORD_LINE_V1 =
  "No record of which files the review missed was found, so there is no card to offer. " +
  "Click Review on the stage row: the review lists the missing files again and raises the card.";

/** True when the owner accepted exactly this gap for this stage. */
export function isPartialScopeAcceptedV1(
  acceptance: PartialScopeAcceptanceV1 | undefined,
  stage: TaskStage,
  hash: string
): boolean {
  return acceptance !== undefined && acceptance.stage === stage && acceptance.hash === hash;
}

/** "1 file", "3 files" (review2 Step 22: correct plurals on the scope card). */
export function countedV1(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isProductionPathV1(file: string): boolean {
  const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    (rel.startsWith("src/") || rel.startsWith("packages/")) &&
    !/(^|\/)(test|tests|__tests__|fixtures)\//.test(rel) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

function isTestPathV1(file: string): boolean {
  const rel = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

export interface ScopeFileCausesV1 {
  /** Files that are not in the review list: adding them can change the result. */
  readonly notInList: readonly string[];
  /** Files in the list that the review had no room for: adding them changes nothing. */
  readonly sizeLimit: readonly string[];
}

/** Splits a partial scope's files by cause (review2 Step 22). */
export function classifyScopeFilesV1(scope: PartialReviewScopeV1): ScopeFileCausesV1 {
  const cut = new Set(scope.sizeLimitFiles ?? []);
  return {
    notInList: scope.files.filter((file) => !cut.has(file)),
    sizeLimit: scope.files.filter((file) => cut.has(file)),
  };
}

/**
 * One line per file the review was not shown, production files first, each with its cause and, when known, whether an
 * earlier review read its current content (`readEarlier`: the files whose recorded coverage hash is still current).
 */
export function describeScopeFilesV1(
  scope: PartialReviewScopeV1,
  readEarlier?: ReadonlySet<string>,
  maxListed = 40
): string {
  const cut = new Set(scope.sizeLimitFiles ?? []);
  const ordered = [
    ...scope.files.filter((file) => isProductionPathV1(file)),
    ...scope.files.filter((file) => !isProductionPathV1(file)),
  ];
  const lines = ordered.slice(0, maxListed).map((file) => {
    const cause = cut.has(file)
      ? "in the list, but this review had no room for it (size limit)"
      : "not in the review list";
    const earlier =
      readEarlier === undefined
        ? ""
        : readEarlier.has(file)
          ? "; an earlier review read its current content"
          : "; no earlier review read its current content";
    return `${file} — ${cause}${earlier}`;
  });
  const more = ordered.length - lines.length;
  return lines.join("\n") + (more > 0 ? `\n… and ${more} more` : "");
}

/**
 * The card's recommendation (review2 Step 23): never an option that cannot change the result.
 * - a file missing from the list: Add, because adding it is the only thing that gets it reviewed;
 * - only test files cut by the size limit: Accept, because adding them changes nothing and the cut repeats;
 * - a production file cut by the size limit: a separate pass, which reads the cut files first. Neither Add nor Accept
 *   makes the file read, so neither is recommended.
 */
export function recommendScopeOptionV1(causes: ScopeFileCausesV1): WorkflowDecisionRecommendationV1 {
  if (causes.notInList.length > 0) {
    return {
      kind: "option",
      optionId: "addAndRereview",
      reasoning:
        `${countedV1(causes.notInList.length, "changed file")} ${causes.notInList.length === 1 ? "is" : "are"} missing from the review list. ` +
        "A review of part of the change can only vouch for that part; adding them is the only way their code is read.",
    };
  }
  if (causes.sizeLimit.every((file) => isTestPathV1(file))) {
    return {
      kind: "option",
      optionId: "acceptPartial",
      reasoning:
        "Only test files were cut by the size limit and they are already in the review list, so adding them changes nothing: " +
        "the same files are cut again every time. Accepting leaves only those test files unreviewed for this stage.",
    };
  }
  return {
    kind: "option",
    optionId: "separatePass",
    reasoning:
      "A production file was cut by the size limit. It is already in the review list, so adding it cannot change the result, " +
      "and accepting leaves production code unread. A separate pass reads the cut files first, before anything else, so " +
      "their code is actually read.",
  };
}

/** The scope card's separate-pass button label (one place, so a Fast Forward stop line can name it exactly). */
export function separatePassLabelV1(sizeLimitCount: number): string {
  return `Review the ${countedV1(sizeLimitCount, "cut file")} in a separate pass`;
}

/** The verdict note appended to the review. */
export function formatPartialScopeVerdictNoteV1(scope: PartialReviewScopeV1, accepted: boolean): string {
  return (
    `\n\n> **Review scope:** partial. ${scope.summary}; ${scope.missingCount} changed file(s) were not part of ` +
    "what this review was shown, so its score says nothing about them. " +
    (accepted
      ? "The owner accepted this partial scope."
      : "The score does not clear the stage until the missing files are added and reviewed, or the owner accepts the gap.") +
    "\n\n<!-- review-scope: partial -->\n"
  );
}

/**
 * True when a review's verdict says it covered only part of the change and the owner has not accepted the gap
 * (review1 Step 59). Read from the note `formatPartialScopeVerdictNoteV1` writes, so it needs no side lookup.
 */
export function reviewHoldsForPartialScopeV1(content: string): boolean {
  return REVIEW_PARTIAL_SCOPE_MARKER_RE.test(content) && !/The owner accepted this partial scope\./.test(content);
}

/** The scope card's "Add" button label (one place, so a Fast Forward stop line can name it exactly). */
export function addAndRereviewLabelV1(notInListCount: number): string {
  return `Add the ${countedV1(notInListCount, "missing file")} and review again`;
}

/** The scope card's "Accept" button label. */
export function acceptPartialLabelV1(totalCount: number): string {
  return `Accept the partial scope (${countedV1(totalCount, "file")} not reviewed)`;
}

/**
 * review2 Step 27: the way on a stop names, with the card's exact buttons. "Add" is named only when a file is
 * actually missing from the list; for files the size limit cut, only Accept can change anything today.
 */
export function describePartialScopeNextClickV1(scope: PartialReviewScopeV1): string {
  const { notInList, sizeLimit } = classifyScopeFilesV1(scope);
  const accept = `"${acceptPartialLabelV1(scope.files.length)}"`;
  if (notInList.length === 0 && sizeLimit.length > 0) {
    return `Choose on the card below: "${separatePassLabelV1(sizeLimit.length)}" or ${accept}. Nothing is missing from the review list; the review had no room for ${sizeLimit.length === 1 ? "that file" : "those files"}.`;
  }
  return notInList.length > 0
    ? `Choose on the card below: "${addAndRereviewLabelV1(notInList.length)}" or ${accept}.`
    : `Choose on the card below: ${accept}. Nothing is missing from the review list; the review had no room for ${scope.files.length === 1 ? "that file" : "those files"}.`;
}

/**
 * review2 Step 22/21: the files the pack's size limit left out last time (only a reviewer without file access has
 * any) go first in the next pass, ahead of the files a standing blocker names, so a cut is never repeated on the same
 * files. Insertion order is the pack's spending order.
 */
export function mergeCarriedOmittedFirstV1(
  carriedOmitted: readonly string[] | undefined,
  blockerNamed: ReadonlySet<string> | undefined
): Set<string> | undefined {
  const merged = new Set<string>([...(carriedOmitted ?? []), ...(blockerNamed ?? [])]);
  return merged.size > 0 ? merged : undefined;
}

export const PARTIAL_SCOPE_HOLD_REASON_V1 =
  "the latest review was not shown every changed file, and the missing files are neither added nor accepted";

/**
 * review2 Step 25: the ONE hold both ways out of a review stage use (Fast Forward and Complete Stage & Move On).
 * A review holds when its verdict carries the partial-scope marker (Ensemble writes it; Step 26 strips a model's copy),
 * unless the owner accepted exactly the gap that review recorded: the acceptance record (stage + hash) is compared
 * with the review's recorded missing-file hash, so an acceptance given after the note was written still counts.
 * Returns the reason, or `undefined` when nothing holds. The reason names the next click when the gap is known.
 */
export function partialScopeHoldReasonV1(input: {
  readonly reviewContent: string | undefined;
  readonly stage: TaskStage;
  readonly gap: PartialScopeGapRecordV1 | undefined;
  readonly acceptance: PartialScopeAcceptanceV1 | undefined;
}): string | undefined {
  const { reviewContent, stage, gap, acceptance } = input;
  if (reviewContent === undefined || !REVIEW_PARTIAL_SCOPE_MARKER_RE.test(reviewContent)) {
    return undefined;
  }
  if (!reviewHoldsForPartialScopeV1(reviewContent)) {
    return undefined;
  }
  const gapForStage = gap !== undefined && gap.stage === stage ? gap : undefined;
  if (gapForStage !== undefined && isPartialScopeAcceptedV1(acceptance, stage, gapForStage.scope.hash)) {
    return undefined;
  }
  return gapForStage === undefined
    ? PARTIAL_SCOPE_HOLD_REASON_V1
    : `${PARTIAL_SCOPE_HOLD_REASON_V1}. ${describePartialScopeNextClickV1(gapForStage.scope)}`;
}

/** The chat line after Accept: what was accepted, that the score now counts, and how far the acceptance reaches. */
export function describeAcceptedScopeChatLineV1(
  files: readonly string[],
  outcome: "moved-on" | "kept-stage" | "rerun",
  nextStageName?: string
): string {
  const shown = files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
  const reach =
    "This holds for this stage only, and for this exact set of files: a later review that is cut at a different set asks again.";
  const accepted = `Accepted: ${shown}. This review's score now counts. ${reach}`;
  switch (outcome) {
    case "moved-on":
      return `${accepted} The review otherwise clears the stage, so the task moves on${nextStageName ? ` to ${nextStageName}` : ""} with no new review.`;
    case "kept-stage":
      return `${accepted} The review's own score or blockers still hold the stage, so no new review was started: continue with Apply Review, or start Fast Forward.`;
    case "rerun":
      return `${accepted} No record of the review's score was found, so the review runs again to count it.`;
  }
}

/**
 * review2 Step 26: removes every `review-scope` marker and every "Review scope:" note from review text. A reviewer
 * that rewrites the review file can copy the previous review's marker (or its note) into its own output; a marker the
 * model wrote must never decide a gate, so only the note Ensemble writes itself is kept.
 */
export function stripModelScopeNoteV1(content: string): string {
  return content
    .replace(/^>[ \t]*\*\*Review scope:\*\*.*(?:\n>.*)*\n?/gim, "")
    .replace(new RegExp(REVIEW_PARTIAL_SCOPE_MARKER_RE.source, "gi"), "")
    .replace(/\s*$/, "\n");
}

/**
 * Writes Ensemble's own partial-scope verdict note. Any marker or note already in the text came from the model (or
 * from an earlier call of this function) and is removed first, so the result carries exactly one note, reflecting the
 * acceptance as it stands now, and calling this again with the same arguments changes nothing.
 */
export function qualifyReviewForPartialScopeV1(
  content: string,
  scope: PartialReviewScopeV1,
  accepted: boolean
): string {
  return stripModelScopeNoteV1(content).replace(/\s*$/, "") + formatPartialScopeVerdictNoteV1(scope, accepted);
}
