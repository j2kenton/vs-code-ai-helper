/**
 * bugs5 Step 27 (item 15), the stage-hold half: a review whose scope is known to miss changed files says so in its
 * verdict, and its score does not clear the stage until the owner adds the files or accepts the gap.
 *
 * Pure: no `vscode`, no I/O. `reviewActions.ts` carries the gap from dispatch to routing through the prompt
 * `variables` (the same way the open-editors fallback travels), and `partialScopeDecisionV1.ts` owns the card.
 */
import { createHash } from "crypto";
import { IMPL_REVIEW_STAGES, type TaskStage } from "../types/taskProgress";

export const REVIEW_SCOPE_PARTIAL_COUNT_VARIABLE = "reviewScopePartialMissing";
export const REVIEW_SCOPE_PARTIAL_SUMMARY_VARIABLE = "reviewScopePartialSummary";
export const REVIEW_SCOPE_PARTIAL_HASH_VARIABLE = "reviewScopePartialHash";
export const REVIEW_SCOPE_PARTIAL_FILES_VARIABLE = "reviewScopePartialFiles";

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
  summary: string
): Record<string, string> {
  return {
    [REVIEW_SCOPE_PARTIAL_COUNT_VARIABLE]: String(missing.length),
    [REVIEW_SCOPE_PARTIAL_SUMMARY_VARIABLE]: summary,
    [REVIEW_SCOPE_PARTIAL_HASH_VARIABLE]: hashMissingFilesV1(missing),
    [REVIEW_SCOPE_PARTIAL_FILES_VARIABLE]: missing.join("\n"),
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
  return {
    missingCount,
    summary: variables[REVIEW_SCOPE_PARTIAL_SUMMARY_VARIABLE] ?? `${missingCount} changed files were not reviewed`,
    hash: variables[REVIEW_SCOPE_PARTIAL_HASH_VARIABLE] ?? hashMissingFilesV1(files),
    files,
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

/** True when the owner accepted exactly this gap for this stage. */
export function isPartialScopeAcceptedV1(
  acceptance: PartialScopeAcceptanceV1 | undefined,
  stage: TaskStage,
  hash: string
): boolean {
  return acceptance !== undefined && acceptance.stage === stage && acceptance.hash === hash;
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

/** Appends the partial-scope verdict note once; the marker makes it idempotent. */
export function qualifyReviewForPartialScopeV1(
  content: string,
  scope: PartialReviewScopeV1,
  accepted: boolean
): string {
  if (REVIEW_PARTIAL_SCOPE_MARKER_RE.test(content)) {
    return content;
  }
  return content.replace(/\s*$/, "") + formatPartialScopeVerdictNoteV1(scope, accepted);
}
