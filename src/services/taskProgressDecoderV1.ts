/**
 * Strict task-progress decoder and version selector (plan §3.10).
 *
 * This is the fail-closed replacement for the permissive legacy reader in
 * `utils/taskProgressUtils` (which this module must never import from, to
 * keep the strict stack independent of the permissive one). Version selection
 * follows `ensembleProgressVersion` exactly:
 *
 *  - property ABSENT + the workspace-legacy-v0 family rules all satisfied
 *    → supported legacy input;
 *  - exact integer 1 → the ensemble-v1 family;
 *  - any other present value → recovery.
 *
 * Conflicting aliases, coercion-dependent values, duplicate properties, and
 * unknown `ensemble*` keys all enter recovery instead of being normalized.
 * Opaque non-product properties are captured as exact raw byte spans, in
 * order, so the splice-based migration path (taskProgressWriterV1) can
 * re-emit them byte-identically.
 *
 * The legacy stage/status alias tables below are deliberately duplicated
 * from the permissive reader's normalizers rather than imported: the
 * workspace-legacy-v0 family is CLOSED history — its alias set can never
 * grow — and importing the permissive module would defeat the fence. A test
 * (taskProgressDecoderV1.test.ts) pins parity with `migrateStage` so the
 * tables cannot silently drift while the permissive reader still exists.
 */
import {
  BlockerSupersessionRecordV1,
  ChecklistChangeProposalV1,
  CompletedWithMissingArtifactV1,
  ImplRecoveryV1,
  ImplementationTypeCheckFailure,
  LintPayload,
  MAX_BLOCKER_SUPERSESSIONS,
  MAX_CHECKLIST_CHANGE_PROPOSALS,
  MAX_OVERRIDDEN_ESCALATIONS,
  MAX_REVIEW_BLOCKER_IDENTITIES,
  MAX_REVIEW_REJECTIONS,
  MAX_REVIEW_SCORE_HISTORY,
  MAX_ROUND_LEDGER_ENTRIES,
  MAX_ROUND_OUTCOMES,
  PlanRevisionStateV1,
  QuotaParkRecordV1,
  ReviewRejectionEntry,
  ReviewScoreHistoryEntry,
  RoundLedgerEntryV1,
  RoundOutcomeEntryV1,
  STAGE_ORDER,
  TaskEscalation,
  TaskProgress,
  TaskStage,
  TaskStatus,
} from "../types/taskProgress";
import { decodeFallbackStateV1 } from "../types/fallbackStateV1";

/** The two supported persisted families (plan §3.10). */
export type TaskProgressFamilyV1 = "workspace-legacy-v0" | "ensemble-v1";

/** The strict persisted V1 shape: the current product fields plus the version marker. */
export interface PersistedTaskProgressV1 extends TaskProgress {
  ensembleProgressVersion: 1;
}

/** Stable recovery codes for strict decode failures (fail-closed, never coerced). */
export type TaskProgressRecoveryCodeV1 =
  | "invalidJson"
  | "notAnObject"
  | "duplicateProperty"
  | "unsupportedProgressVersion"
  | "unknownEnsembleField"
  | "conflictingAliases"
  | "invalidFieldValue"
  | "taskFolderMismatch";

/** An opaque (non-product) property captured as exact raw byte spans. */
export interface TaskProgressOpaqueEntryV1 {
  readonly name: string;
  /** Exact raw text of the key token, including quotes and escapes. */
  readonly rawKey: string;
  /** Exact raw text of the value span, byte-identical to the source. */
  readonly rawValue: string;
}

/**
 * Ordered document model: one entry per source property (envelope wrapper
 * excluded), preserving original property order so the writer can splice
 * product re-encodings between untouched opaque spans.
 */
export type TaskProgressDocumentEntryV1 =
  | { readonly kind: "product"; readonly name: keyof TaskProgress }
  | { readonly kind: "opaque"; readonly entry: TaskProgressOpaqueEntryV1 };

export interface DecodedTaskProgressV1 {
  readonly family: TaskProgressFamilyV1;
  /** Canonicalized product values, already carrying `ensembleProgressVersion: 1`. */
  readonly progress: PersistedTaskProgressV1;
  readonly entries: readonly TaskProgressDocumentEntryV1[];
  /** True when the source was the historical `{ schemaVersion, data }` envelope. */
  readonly wasEnvelopeWrapped: boolean;
}

export type TaskProgressDecodeResultV1 =
  | { readonly ok: true; readonly decoded: DecodedTaskProgressV1 }
  | {
      readonly ok: false;
      readonly code: TaskProgressRecoveryCodeV1;
      readonly reason: string;
    };

export interface DecodeTaskProgressOptionsV1 {
  /** When provided, `taskFolder` must equal the discovered folder name exactly. */
  readonly expectedTaskFolder?: string;
}

/**
 * Every persisted product field, in declaration order. The exported
 * completeness constant below fails to compile if `TaskProgress` grows a
 * field this list does not carry, so no persisted field can sit outside the
 * strict decode contract (plan §3.10/§3.11 completeness requirement).
 */
export const TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1 = [
  "taskFolder",
  "displayName",
  "nameIsDefault",
  "currentStage",
  "status",
  "completedAt",
  "archivedFrom",
  "pinnedAt",
  "publishScopePath",
  "completedStages",
  "completedWithMissingArtifacts",
  "preImageDescription",
  "ownership",
  "createdAt",
  "updatedAt",
  "progressVersion",
  "implReviewFiles",
  "lintPayload",
  "scheduledRun",
  "scheduledResumeTime",
  "fallbackActive",
  "fallbackModelId",
  "reviewAttemptId",
  "reviewScoreHistory",
  "reviewRejections",
  "roundOutcomes",
  "roundLedger",
  "blockerSupersessions",
  "checklistChangeProposals",
  "planRevision",
  "escalation",
  "overriddenEscalations",
  "implementationTypeCheckFailure",
  "checklistProgressUnreliable",
  "checklistProgressUnreliableReason",
  "zeroChangeImplRounds",
  "pendingImplReviewFiles",
  "reviewInvalidatedByRound",
  "incompleteRoundContinuations",
  "pausedReason",
  "implRecovery",
  "quotaParkRecord",
] as const satisfies readonly (keyof TaskProgress)[];

type MissingProductFieldV1 = Exclude<
  keyof TaskProgress,
  (typeof TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1)[number]
>;

/** Compile-time completeness proof: a new TaskProgress field breaks this assignment. */
export const TASK_PROGRESS_PRODUCT_FIELD_COMPLETENESS_V1: MissingProductFieldV1 extends never
  ? true
  : never = true;

const PRODUCT_FIELD_NAME_SET: ReadonlySet<string> = new Set(
  TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1
);

export const ENSEMBLE_PROGRESS_VERSION_FIELD_V1 = "ensembleProgressVersion";

/**
 * The closed workspace-legacy-v0 stage alias table (mirrors the permissive
 * reader's `migrateStage` map; parity is pinned by test). The synthetic
 * legacy "completed" stage is handled separately because it also implies
 * status resolution.
 */
const LEGACY_STAGE_ALIASES: Readonly<Record<string, TaskStage>> = {
  created: "desc",
  "task-description": "desc",
  "plan-final": "impl",
  implementation: "impl",
  "plan-review": "plan-high-review",
  "plan-updated": "plan-high-review",
  "plan-updated-review": "plan-low-review",
};

export const LEGACY_STAGE_ALIAS_TABLE_V1: Readonly<Record<string, TaskStage>> =
  LEGACY_STAGE_ALIASES;

const CANONICAL_STAGES: ReadonlySet<string> = new Set(STAGE_ORDER);
const CANONICAL_STATUSES: ReadonlySet<string> = new Set([
  "creating",
  "active",
  "paused",
  "completed",
  "archived",
]);
const ESCALATION_KINDS: ReadonlySet<string> = new Set([
  "plateau",
  "spec-defect",
  "environmental",
  "unverifiable",
  "reviewer-disagreement",
]);
const ROUND_OUTCOME_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "edits-produced",
  "genuine-no-op",
  "provider-failure-empty",
  "cancelled",
  "rejected-degenerate",
]);
const IMPLEMENTATION_DISPATCH_MODES: ReadonlySet<string> = new Set([
  "implementation",
  "apply-review",
  "continuation",
]);
// RoundLedgerModeV1 — a strict superset of IMPLEMENTATION_DISPATCH_MODES
// (adds "review" for rows recorded at a review stage; see the type's doc
// comment in taskProgress.ts). Deliberately a SEPARATE set: roundOutcomes'
// dispatchMode and implRecovery's sourceDispatchMode are genuinely
// implementation-only and must keep rejecting "review".
const ROUND_LEDGER_MODES: ReadonlySet<string> = new Set([
  ...IMPLEMENTATION_DISPATCH_MODES,
  "review",
]);
const ROUND_LEDGER_STATES: ReadonlySet<string> = new Set([
  "scheduled",
  "open",
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "quota-blocked",
  "dropped",
  "interrupted",
]);
const CHECKLIST_CHANGE_PROPOSAL_KINDS: ReadonlySet<string> = new Set([
  "added",
  "removed",
  "renumbered",
]);
const CHECKLIST_CHANGE_PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "revising",
  "discarded",
  "adopted",
]);
const MAX_CHECKLIST_CHANGE_PROPOSAL_ITEMS = 200;

/** Bounded-representation limits for strict field validation. */
const MAX_NAME_LENGTH = 4096;
const MAX_PATH_LENGTH = 1024;
const MAX_PRE_IMAGE_LENGTH = 256 * 1024;
const MAX_IMPL_REVIEW_FILES = 4096;
const MAX_SUMMARY_LENGTH = 64 * 1024;
const MAX_CHECK_OUTPUT_LENGTH = 256 * 1024;
const MAX_FAILED_CHECKS = 256;
const MAX_ID_LENGTH = 256;
const MAX_ESCALATION_REASON_LENGTH = 64 * 1024;

/** Accepts the ISO-8601 forms the product has ever emitted (toISOString and offset forms). */
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Raw top-level property scanning (exact byte spans for the splice path)
// ---------------------------------------------------------------------------

interface RawPropertyV1 {
  readonly name: string;
  readonly rawKey: string;
  readonly rawValue: string;
}

type RawScanResult =
  | { readonly ok: true; readonly properties: readonly RawPropertyV1[] }
  | { readonly ok: false; readonly reason: string; readonly duplicateName?: string };

const JSON_WHITESPACE = " \t\n\r";

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined || !JSON_WHITESPACE.includes(ch)) {
      break;
    }
    i++;
  }
  return i;
}

function scanStringEnd(text: string, start: number): number | null {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return i + 1;
    }
    i++;
  }
  return null;
}

function scanValueEnd(text: string, start: number): number | null {
  const first = text[start];
  if (first === undefined) {
    return null;
  }
  if (first === '"') {
    return scanStringEnd(text, start);
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === undefined) {
        return null;
      }
      if (ch === '"') {
        const end = scanStringEnd(text, i);
        if (end === null) {
          return null;
        }
        i = end;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
      i++;
    }
    return null;
  }
  // Number, true, false, or null: scan to the next structural delimiter.
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined || ch === "," || ch === "}" || ch === "]" || JSON_WHITESPACE.includes(ch)) {
      break;
    }
    i++;
  }
  return i;
}

/**
 * Scan the top-level properties of one JSON object text, recording exact raw
 * key/value spans in source order. The input is expected to already be valid
 * JSON (JSON.parse succeeded); this scan exists to capture byte spans and to
 * detect duplicate properties, which JSON.parse silently collapses.
 */
function scanTopLevelObject(text: string): RawScanResult {
  let i = skipWhitespace(text, 0);
  if (text[i] !== "{") {
    return { ok: false, reason: "document is not a JSON object" };
  }
  i++;
  const properties: RawPropertyV1[] = [];
  const seen = new Set<string>();
  i = skipWhitespace(text, i);
  if (text[i] === "}") {
    return { ok: true, properties };
  }
  for (;;) {
    i = skipWhitespace(text, i);
    if (text[i] !== '"') {
      return { ok: false, reason: `expected a property name at offset ${i}` };
    }
    const keyStart = i;
    const keyEnd = scanStringEnd(text, keyStart);
    if (keyEnd === null) {
      return { ok: false, reason: "unterminated property name" };
    }
    const rawKey = text.slice(keyStart, keyEnd);
    let name: string;
    try {
      name = JSON.parse(rawKey) as string;
    } catch {
      return { ok: false, reason: "unparseable property name" };
    }
    if (seen.has(name)) {
      return {
        ok: false,
        reason: `duplicate property ${JSON.stringify(name)}`,
        duplicateName: name,
      };
    }
    seen.add(name);
    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") {
      return { ok: false, reason: `expected ":" after property ${JSON.stringify(name)}` };
    }
    i = skipWhitespace(text, i + 1);
    const valueStart = i;
    const valueEnd = scanValueEnd(text, valueStart);
    if (valueEnd === null) {
      return { ok: false, reason: `unterminated value for property ${JSON.stringify(name)}` };
    }
    properties.push({ name, rawKey, rawValue: text.slice(valueStart, valueEnd) });
    i = skipWhitespace(text, valueEnd);
    const ch = text[i];
    if (ch === ",") {
      i++;
      continue;
    }
    if (ch === "}") {
      return { ok: true, properties };
    }
    return { ok: false, reason: `expected "," or "}" after property ${JSON.stringify(name)}` };
  }
}

// ---------------------------------------------------------------------------
// Version selection
// ---------------------------------------------------------------------------

export type TaskProgressFamilySelectionV1 =
  | { readonly ok: true; readonly family: TaskProgressFamilyV1 }
  | {
      readonly ok: false;
      readonly code: TaskProgressRecoveryCodeV1;
      readonly reason: string;
    };

/**
 * Strict version selector (plan §3.10): `ensembleProgressVersion` absent
 * means the single legacy-default family; exact integer 1 means V1; any
 * other present value is recovery. Does not validate field contents — use
 * `decodeTaskProgressTextV1` for full decoding.
 */
export function selectTaskProgressFamilyV1(text: string): TaskProgressFamilySelectionV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      code: "invalidJson",
      reason: `document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: "notAnObject", reason: "document is not a JSON object" };
  }
  let target = parsed;
  if (
    Object.keys(parsed).length === 2 &&
    typeof parsed["schemaVersion"] === "number" &&
    isPlainObject(parsed["data"])
  ) {
    target = parsed["data"];
    if (ENSEMBLE_PROGRESS_VERSION_FIELD_V1 in target) {
      return {
        ok: false,
        code: "unsupportedProgressVersion",
        reason: "an envelope-wrapped document cannot carry ensembleProgressVersion",
      };
    }
  }
  if (!(ENSEMBLE_PROGRESS_VERSION_FIELD_V1 in target)) {
    return { ok: true, family: "workspace-legacy-v0" };
  }
  const version = target[ENSEMBLE_PROGRESS_VERSION_FIELD_V1];
  if (typeof version === "number" && Number.isInteger(version) && version === 1) {
    return { ok: true, family: "ensemble-v1" };
  }
  return {
    ok: false,
    code: "unsupportedProgressVersion",
    reason: `ensembleProgressVersion must be the exact integer 1, found ${JSON.stringify(version)}`,
  };
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

interface DecodeFlags {
  legacyCompletedStage: boolean;
  statusWasAlias: boolean;
  statusExplicit: boolean;
}

function resolveStage(value: string, family: TaskProgressFamilyV1): TaskStage | undefined {
  if (CANONICAL_STAGES.has(value)) {
    return value as TaskStage;
  }
  if (family === "workspace-legacy-v0") {
    return LEGACY_STAGE_ALIASES[value];
  }
  return undefined;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function validateOwnership(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "ownership must be an object";
  }
  const allowed = new Set(["metaRoot", "projectRoot", "workspaceRoot", "boundAt", "state"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `ownership has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (typeof value["metaRoot"] !== "string" || value["metaRoot"].length === 0) {
    return "ownership.metaRoot must be a non-empty string";
  }
  if (typeof value["projectRoot"] !== "string" || value["projectRoot"].length === 0) {
    return "ownership.projectRoot must be a non-empty string";
  }
  if (
    value["workspaceRoot"] !== undefined &&
    (typeof value["workspaceRoot"] !== "string" || value["workspaceRoot"].length === 0)
  ) {
    return "ownership.workspaceRoot must be a non-empty string when present";
  }
  if (!isIsoTimestamp(value["boundAt"])) {
    return "ownership.boundAt must be an ISO timestamp";
  }
  if (
    value["state"] !== undefined &&
    value["state"] !== "resolved" &&
    value["state"] !== "ownership-unresolved"
  ) {
    return "ownership.state must be \"resolved\" or \"ownership-unresolved\" when present";
  }
  return undefined;
}

function validateLintPayload(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "lintPayload must be an object";
  }
  const allowed = new Set(["runAt", "passed", "summary", "issueCount", "failedChecks", "source"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `lintPayload has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (
    value["source"] !== undefined &&
    value["source"] !== "publish" &&
    value["source"] !== "review"
  ) {
    return 'lintPayload.source must be "publish" or "review" when present';
  }
  if (!isIsoTimestamp(value["runAt"])) {
    return "lintPayload.runAt must be an ISO timestamp";
  }
  if (typeof value["passed"] !== "boolean") {
    return "lintPayload.passed must be a boolean";
  }
  if (value["summary"] !== undefined && !boundedString(value["summary"], MAX_SUMMARY_LENGTH)) {
    return "lintPayload.summary must be a bounded string when present";
  }
  if (value["issueCount"] !== undefined && !isNonNegativeInteger(value["issueCount"])) {
    return "lintPayload.issueCount must be a non-negative integer when present";
  }
  const failedChecks = value["failedChecks"];
  if (failedChecks !== undefined) {
    if (!Array.isArray(failedChecks) || failedChecks.length > MAX_FAILED_CHECKS) {
      return "lintPayload.failedChecks must be a bounded array when present";
    }
    for (const check of failedChecks as unknown[]) {
      if (!isPlainObject(check)) {
        return "lintPayload.failedChecks entries must be objects";
      }
      // `retryCount` is written by completionLint.ts's runCheckWithRetry (it
      // records how many attempts a flaky check needed) and is omitted when
      // zero. It was missing here, so any task whose publish checks retried
      // wrote a progress file its own strict decoder then refused —
      // "unknown property \"retryCount\"" — leaving the task stuck needing
      // recovery. Observed 2026-08-08 on .ensemble/2026-07-24_task_1.
      //
      // `quarantine` is completionLint.ts's per-check known-flake stamp
      // (QuarantineStampV1, computed once in `collectCompletionLint`) and is
      // persisted verbatim by `runCompletionLint`/`updateLintPayload`. It was
      // missing here too, reproducing the exact same defect: a task whose
      // publish checks include a quarantined known flake wrote a progress
      // file its own strict decoder then refused to re-read (wf10
      // continuation item 12, blocker: "quarantined failed-check stamps are
      // persisted... even though the strict decoder rejects the
      // `quarantine` property").
      const checkAllowed = new Set(["command", "exitCode", "output", "retryCount", "quarantine"]);
      for (const key of Object.keys(check)) {
        if (!checkAllowed.has(key)) {
          return `lintPayload.failedChecks entry has an unknown property ${JSON.stringify(key)}`;
        }
      }
      if (!boundedString(check["command"], MAX_SUMMARY_LENGTH)) {
        return "lintPayload.failedChecks entry command must be a bounded string";
      }
      if (typeof check["exitCode"] !== "number" || !Number.isInteger(check["exitCode"])) {
        return "lintPayload.failedChecks entry exitCode must be an integer";
      }
      if (check["retryCount"] !== undefined && !isNonNegativeInteger(check["retryCount"])) {
        return "lintPayload.failedChecks entry retryCount must be a non-negative integer when present";
      }
      if (!boundedString(check["output"], MAX_CHECK_OUTPUT_LENGTH)) {
        return "lintPayload.failedChecks entry output must be a bounded string";
      }
      const quarantine = check["quarantine"];
      if (quarantine !== undefined) {
        if (!isPlainObject(quarantine)) {
          return "lintPayload.failedChecks entry quarantine must be an object when present";
        }
        const quarantineAllowed = new Set(["reason", "ruleMatch"]);
        for (const key of Object.keys(quarantine)) {
          if (!quarantineAllowed.has(key)) {
            return `lintPayload.failedChecks entry quarantine has an unknown property ${JSON.stringify(key)}`;
          }
        }
        if (!boundedString(quarantine["reason"], MAX_SUMMARY_LENGTH)) {
          return "lintPayload.failedChecks entry quarantine.reason must be a bounded string";
        }
        if (!boundedString(quarantine["ruleMatch"], MAX_SUMMARY_LENGTH)) {
          return "lintPayload.failedChecks entry quarantine.ruleMatch must be a bounded string";
        }
      }
    }
  }
  return undefined;
}

function validateScheduledRun(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!isPlainObject(value)) {
    return "scheduledRun must be an object";
  }
  const allowed = new Set(["runAt", "stage", "leaseOwner", "leaseUntil"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `scheduledRun has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (!isIsoTimestamp(value["runAt"])) {
    return "scheduledRun.runAt must be an ISO timestamp";
  }
  if (typeof value["stage"] !== "string" || resolveStage(value["stage"], family) === undefined) {
    return "scheduledRun.stage must be a recognized stage";
  }
  if (
    value["leaseOwner"] !== undefined &&
    (typeof value["leaseOwner"] !== "string" || value["leaseOwner"].length === 0 ||
      value["leaseOwner"].length > MAX_ID_LENGTH)
  ) {
    return "scheduledRun.leaseOwner must be a bounded non-empty string when present";
  }
  if (value["leaseUntil"] !== undefined && !isIsoTimestamp(value["leaseUntil"])) {
    return "scheduledRun.leaseUntil must be an ISO timestamp when present";
  }
  return undefined;
}

/**
 * Shared shape validation for a `ReviewBlockerIdentity[]` field, factored out
 * so `reviewScoreHistory` entries' `blockers` and `supersededBlockers`
 * (wf10 continuation item 18) validate identically instead of risking two
 * independently-maintained copies of the same rules drifting apart.
 * `fieldLabel` names the field in every returned message (e.g.
 * `"reviewScoreHistory entry blocker"`).
 */
function validateBlockerIdentityListV1(value: unknown, fieldLabel: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_BLOCKER_IDENTITIES) {
    return `${fieldLabel}s must be a bounded array`;
  }
  for (const blocker of value as unknown[]) {
    if (!isPlainObject(blocker)) {
      return `${fieldLabel} entries must be objects`;
    }
    const allowedBlockerKeys = new Set([
      "category",
      "resolver",
      "subject",
      "id",
      "lineage",
      "description",
      "origin",
    ]);
    for (const key of Object.keys(blocker)) {
      if (!allowedBlockerKeys.has(key)) {
        return `${fieldLabel} has an unknown property ${JSON.stringify(key)}`;
      }
    }
    for (const key of ["category", "resolver", "subject"] as const) {
      const field = blocker[key];
      if (typeof field !== "string" || field.length === 0 || field.length > 200) {
        return `${fieldLabel} ${key} must be a bounded non-empty string`;
      }
    }
    const id = blocker["id"];
    if (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH)) {
      return `${fieldLabel} id must be a bounded non-empty string`;
    }
    const description = blocker["description"];
    if (
      description !== undefined &&
      (typeof description !== "string" || description.length === 0 || description.length > 500)
    ) {
      return `${fieldLabel} description must be a bounded non-empty string`;
    }
    const origin = blocker["origin"];
    if (origin !== undefined && origin !== "reviewer" && origin !== "mechanical") {
      return `${fieldLabel} origin must be reviewer or mechanical`;
    }
    const lineage = blocker["lineage"];
    if (lineage !== undefined) {
      if (!isPlainObject(lineage)) {
        return `${fieldLabel} lineage must be an object`;
      }
      const kind = lineage["kind"];
      if (kind === "new") {
        const allowedLineageKeys = new Set(["kind"]);
        for (const key of Object.keys(lineage)) {
          if (!allowedLineageKeys.has(key)) {
            return `${fieldLabel} lineage has an unknown property ${JSON.stringify(key)}`;
          }
        }
      } else if (kind === "same" || kind === "narrowed") {
        const allowedLineageKeys = new Set(["kind", "refId"]);
        for (const key of Object.keys(lineage)) {
          if (!allowedLineageKeys.has(key)) {
            return `${fieldLabel} lineage has an unknown property ${JSON.stringify(key)}`;
          }
        }
        const refId = lineage["refId"];
        if (typeof refId !== "string" || refId.length === 0 || refId.length > MAX_ID_LENGTH) {
          return `${fieldLabel} lineage refId must be a bounded non-empty string`;
        }
      } else {
        return `${fieldLabel} lineage kind must be new, same, or narrowed`;
      }
    }
  }
  return undefined;
}

/** Shape validation for `ReviewScoreHistoryEntry.reviewerChallengedNonGoal`
 * (wf10 continuation item 18). */
function validateReviewerChallengedNonGoalV1(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_BLOCKER_IDENTITIES) {
    return "reviewScoreHistory entry reviewerChallengedNonGoal must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "reviewScoreHistory entry reviewerChallengedNonGoal entries must be objects";
    }
    const allowed = new Set(["blockerId", "nonGoalHeading"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `reviewScoreHistory entry reviewerChallengedNonGoal entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    const blockerId = entry["blockerId"];
    if (
      blockerId !== undefined &&
      (typeof blockerId !== "string" || blockerId.length === 0 || blockerId.length > MAX_ID_LENGTH)
    ) {
      return "reviewScoreHistory entry reviewerChallengedNonGoal entry blockerId must be a bounded non-empty string";
    }
    if (
      typeof entry["nonGoalHeading"] !== "string" ||
      entry["nonGoalHeading"].length === 0 ||
      entry["nonGoalHeading"].length > 200
    ) {
      return "reviewScoreHistory entry reviewerChallengedNonGoal entry nonGoalHeading must be a bounded non-empty string";
    }
  }
  return undefined;
}

function validateReviewScoreHistory(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_SCORE_HISTORY) {
    return "reviewScoreHistory must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "reviewScoreHistory entries must be objects";
    }
    const allowed = new Set([
      "stage",
      "score",
      "attemptId",
      "at",
      "blockerCount",
      "taskFixableCount",
      "blockers",
      "reviewer",
      "supersededBlockers",
      "reviewerChallengedNonGoal",
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `reviewScoreHistory entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "reviewScoreHistory entry stage must be a recognized stage";
    }
    const score = entry["score"];
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) {
      return "reviewScoreHistory entry score must be a finite number or null";
    }
    if (
      typeof entry["attemptId"] !== "string" ||
      entry["attemptId"].length === 0 ||
      entry["attemptId"].length > MAX_ID_LENGTH
    ) {
      return "reviewScoreHistory entry attemptId must be a bounded non-empty string";
    }
    if (!isIsoTimestamp(entry["at"])) {
      return "reviewScoreHistory entry at must be an ISO timestamp";
    }
    if (!isNonNegativeInteger(entry["blockerCount"])) {
      return "reviewScoreHistory entry blockerCount must be a non-negative integer";
    }
    if (!isNonNegativeInteger(entry["taskFixableCount"])) {
      return "reviewScoreHistory entry taskFixableCount must be a non-negative integer";
    }
    const blockers = entry["blockers"];
    if (blockers !== undefined) {
      const blockersError = validateBlockerIdentityListV1(blockers, "reviewScoreHistory entry blocker");
      if (blockersError) {
        return blockersError;
      }
    }
    const supersededBlockers = entry["supersededBlockers"];
    if (supersededBlockers !== undefined) {
      const supersededBlockersError = validateBlockerIdentityListV1(
        supersededBlockers,
        "reviewScoreHistory entry supersededBlocker"
      );
      if (supersededBlockersError) {
        return supersededBlockersError;
      }
    }
    const reviewerChallengedNonGoal = entry["reviewerChallengedNonGoal"];
    if (reviewerChallengedNonGoal !== undefined) {
      const challengedError = validateReviewerChallengedNonGoalV1(reviewerChallengedNonGoal);
      if (challengedError) {
        return challengedError;
      }
    }
    const reviewer = entry["reviewer"];
    if (reviewer !== undefined) {
      if (!isPlainObject(reviewer)) {
        return "reviewScoreHistory entry reviewer must be an object";
      }
      const allowedReviewerKeys = new Set(["providerLabel", "storedModelId"]);
      for (const key of Object.keys(reviewer)) {
        if (!allowedReviewerKeys.has(key)) {
          return `reviewScoreHistory entry reviewer has an unknown property ${JSON.stringify(key)}`;
        }
      }
      for (const key of ["providerLabel", "storedModelId"] as const) {
        const field = reviewer[key];
        if (typeof field !== "string" || field.length === 0 || field.length > MAX_ID_LENGTH) {
          return `reviewScoreHistory entry reviewer ${key} must be a bounded non-empty string`;
        }
      }
    }
  }
  return undefined;
}

function validateReviewRejections(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_REJECTIONS) {
    return "reviewRejections must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "reviewRejections entries must be objects";
    }
    const allowed = new Set(["stage", "attemptId", "at", "reason"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `reviewRejections entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "reviewRejections entry stage must be a recognized stage";
    }
    if (
      typeof entry["attemptId"] !== "string" ||
      entry["attemptId"].length === 0 ||
      entry["attemptId"].length > MAX_ID_LENGTH
    ) {
      return "reviewRejections entry attemptId must be a bounded non-empty string";
    }
    if (!isIsoTimestamp(entry["at"])) {
      return "reviewRejections entry at must be an ISO timestamp";
    }
    if (
      typeof entry["reason"] !== "string" ||
      entry["reason"].length === 0 ||
      entry["reason"].length > MAX_ESCALATION_REASON_LENGTH
    ) {
      return "reviewRejections entry reason must be a bounded non-empty string";
    }
  }
  return undefined;
}

function validateBlockerSupersessions(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_BLOCKER_SUPERSESSIONS) {
    return "blockerSupersessions must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "blockerSupersessions entries must be objects";
    }
    const allowed = new Set([
      "stage",
      "blockerDescription",
      "supersededAt",
      "planRelPath",
      "confirmingMessageAt",
      "source",
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `blockerSupersessions entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "blockerSupersessions entry stage must be a recognized stage";
    }
    if (
      typeof entry["blockerDescription"] !== "string" ||
      entry["blockerDescription"].length === 0 ||
      entry["blockerDescription"].length > MAX_ESCALATION_REASON_LENGTH
    ) {
      return "blockerSupersessions entry blockerDescription must be a bounded non-empty string";
    }
    if (!isIsoTimestamp(entry["supersededAt"])) {
      return "blockerSupersessions entry supersededAt must be an ISO timestamp";
    }
    if (
      typeof entry["planRelPath"] !== "string" ||
      entry["planRelPath"].length === 0 ||
      entry["planRelPath"].length > MAX_PATH_LENGTH
    ) {
      return "blockerSupersessions entry planRelPath must be a bounded non-empty string";
    }
    if (entry["confirmingMessageAt"] !== undefined && !isIsoTimestamp(entry["confirmingMessageAt"])) {
      return "blockerSupersessions entry confirmingMessageAt must be an ISO timestamp";
    }
    const source = entry["source"];
    if (source !== undefined && source !== "chat-confirmed" && source !== "plan-non-goal") {
      return "blockerSupersessions entry source must be chat-confirmed or plan-non-goal";
    }
  }
  return undefined;
}

function validateChecklistItemTextArray(value: unknown, fieldLabel: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_CHECKLIST_CHANGE_PROPOSAL_ITEMS) {
    return `${fieldLabel} must be a bounded array`;
  }
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_ESCALATION_REASON_LENGTH) {
      return `${fieldLabel} entries must be bounded non-empty strings`;
    }
  }
  return undefined;
}

function validateChecklistChangeProposals(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_CHECKLIST_CHANGE_PROPOSALS) {
    return "checklistChangeProposals must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "checklistChangeProposals entries must be objects";
    }
    const allowed = new Set([
      "at",
      "roundId",
      "stage",
      "kind",
      "proposedItems",
      "removedItems",
      "status",
      "resolvedAt",
      "itemCountBefore",
      "itemCountAfter",
      "ledgerAnnotated",
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `checklistChangeProposals entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (!isIsoTimestamp(entry["at"])) {
      return "checklistChangeProposals entry at must be an ISO timestamp";
    }
    if (
      typeof entry["roundId"] !== "string" ||
      entry["roundId"].length === 0 ||
      entry["roundId"].length > MAX_ID_LENGTH
    ) {
      return "checklistChangeProposals entry roundId must be a bounded non-empty string";
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "checklistChangeProposals entry stage must be a recognized stage";
    }
    if (typeof entry["kind"] !== "string" || !CHECKLIST_CHANGE_PROPOSAL_KINDS.has(entry["kind"])) {
      return "checklistChangeProposals entry kind must be a recognized mutation kind";
    }
    const proposedError = validateChecklistItemTextArray(
      entry["proposedItems"],
      "checklistChangeProposals entry proposedItems"
    );
    if (proposedError !== undefined) {
      return proposedError;
    }
    const removedError = validateChecklistItemTextArray(
      entry["removedItems"],
      "checklistChangeProposals entry removedItems"
    );
    if (removedError !== undefined) {
      return removedError;
    }
    if (
      typeof entry["status"] !== "string" ||
      !CHECKLIST_CHANGE_PROPOSAL_STATUSES.has(entry["status"])
    ) {
      return "checklistChangeProposals entry status must be a recognized proposal status";
    }
    if (entry["resolvedAt"] !== undefined && !isIsoTimestamp(entry["resolvedAt"])) {
      return "checklistChangeProposals entry resolvedAt must be an ISO timestamp";
    }
    if (entry["itemCountBefore"] !== undefined && !isNonNegativeInteger(entry["itemCountBefore"])) {
      return "checklistChangeProposals entry itemCountBefore must be a non-negative integer";
    }
    if (entry["itemCountAfter"] !== undefined && !isNonNegativeInteger(entry["itemCountAfter"])) {
      return "checklistChangeProposals entry itemCountAfter must be a non-negative integer";
    }
    if (entry["ledgerAnnotated"] !== undefined && typeof entry["ledgerAnnotated"] !== "boolean") {
      return "checklistChangeProposals entry ledgerAnnotated must be a boolean";
    }
  }
  return undefined;
}

function validatePlanRevision(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!isPlainObject(value)) {
    return "planRevision must be an object";
  }
  const allowed = new Set([
    "proposalAt",
    "startedAt",
    "stage",
    "discardedItems",
    "removedItems",
    "reason",
    "journaledPlanRef",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `planRevision has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (!isIsoTimestamp(value["proposalAt"])) {
    return "planRevision.proposalAt must be an ISO timestamp";
  }
  if (!isIsoTimestamp(value["startedAt"])) {
    return "planRevision.startedAt must be an ISO timestamp";
  }
  if (typeof value["stage"] !== "string" || resolveStage(value["stage"], family) === undefined) {
    return "planRevision.stage must be a recognized stage";
  }
  const discardedError = validateChecklistItemTextArray(
    value["discardedItems"],
    "planRevision.discardedItems"
  );
  if (discardedError !== undefined) {
    return discardedError;
  }
  const removedError = validateChecklistItemTextArray(
    value["removedItems"],
    "planRevision.removedItems"
  );
  if (removedError !== undefined) {
    return removedError;
  }
  if (
    typeof value["reason"] !== "string" ||
    value["reason"].length === 0 ||
    value["reason"].length > MAX_ESCALATION_REASON_LENGTH
  ) {
    return "planRevision.reason must be a bounded non-empty string";
  }
  if (
    value["journaledPlanRef"] !== undefined &&
    (typeof value["journaledPlanRef"] !== "string" ||
      value["journaledPlanRef"].length === 0 ||
      value["journaledPlanRef"].length > MAX_ID_LENGTH)
  ) {
    return "planRevision.journaledPlanRef must be a bounded non-empty string";
  }
  return undefined;
}

function validateRoundOutcomes(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_ROUND_OUTCOMES) {
    return "roundOutcomes must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "roundOutcomes entries must be objects";
    }
    const allowed = new Set([
      "stage",
      "classification",
      "at",
      "attemptId",
      "modelId",
      "providerId",
      "dispatchMode",
      "originatingReviewStage",
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `roundOutcomes entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "roundOutcomes entry stage must be a recognized stage";
    }
    if (
      typeof entry["classification"] !== "string" ||
      !ROUND_OUTCOME_CLASSIFICATIONS.has(entry["classification"])
    ) {
      return "roundOutcomes entry classification must be a recognized round-outcome classification";
    }
    if (!isIsoTimestamp(entry["at"])) {
      return "roundOutcomes entry at must be an ISO timestamp";
    }
    if (entry["attemptId"] !== undefined) {
      if (
        typeof entry["attemptId"] !== "string" ||
        entry["attemptId"].length === 0 ||
        entry["attemptId"].length > MAX_ID_LENGTH
      ) {
        return "roundOutcomes entry attemptId must be a bounded non-empty string";
      }
    }
    if (entry["modelId"] !== undefined) {
      if (
        typeof entry["modelId"] !== "string" ||
        entry["modelId"].length === 0 ||
        entry["modelId"].length > MAX_NAME_LENGTH
      ) {
        return "roundOutcomes entry modelId must be a bounded non-empty string";
      }
    }
    if (entry["providerId"] !== undefined) {
      if (
        typeof entry["providerId"] !== "string" ||
        entry["providerId"].length === 0 ||
        entry["providerId"].length > MAX_NAME_LENGTH
      ) {
        return "roundOutcomes entry providerId must be a bounded non-empty string";
      }
    }
    if (
      entry["dispatchMode"] !== undefined &&
      (typeof entry["dispatchMode"] !== "string" ||
        !IMPLEMENTATION_DISPATCH_MODES.has(entry["dispatchMode"]))
    ) {
      return "roundOutcomes entry dispatchMode must be a recognized dispatch mode";
    }
    if (
      entry["originatingReviewStage"] !== undefined &&
      (typeof entry["originatingReviewStage"] !== "string" ||
        resolveStage(entry["originatingReviewStage"], family) === undefined)
    ) {
      return "roundOutcomes entry originatingReviewStage must be a recognized stage";
    }
  }
  return undefined;
}

/** Cap on `RoundLedgerEntryV1.attemptIds` length — same bound as
 * `MAX_REVIEW_BLOCKER_IDENTITIES`; a round that somehow allocated more
 * attempts than this is a data anomaly, not a case to accommodate. */
const MAX_ROUND_LEDGER_ATTEMPT_IDS = 32;

function validateRoundLedgerOutcome(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "roundLedger entry outcome must be an object";
  }
  const allowed = new Set([
    "filesChanged",
    "filesChangedUnknown",
    "score",
    "reviewerBlockers",
    "mechanicalBlockers",
    "rejectionReason",
    "continuationOwed",
    "runLogPath",
    "roundOutcomeAttemptId",
    "reviewerChallengedNonGoal",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `roundLedger entry outcome has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (value["filesChanged"] !== undefined) {
    if (!Array.isArray(value["filesChanged"]) || value["filesChanged"].length > MAX_IMPL_REVIEW_FILES) {
      return "roundLedger entry outcome filesChanged must be a bounded array";
    }
    for (const entry of value["filesChanged"] as unknown[]) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_PATH_LENGTH) {
        return "roundLedger entry outcome filesChanged entries must be bounded non-empty strings";
      }
    }
  }
  if (value["filesChangedUnknown"] !== undefined && typeof value["filesChangedUnknown"] !== "boolean") {
    return "roundLedger entry outcome filesChangedUnknown must be a boolean";
  }
  if (
    value["score"] !== undefined &&
    (typeof value["score"] !== "number" || !Number.isFinite(value["score"]))
  ) {
    return "roundLedger entry outcome score must be a finite number";
  }
  if (
    value["reviewerBlockers"] !== undefined &&
    (typeof value["reviewerBlockers"] !== "number" || !Number.isInteger(value["reviewerBlockers"]))
  ) {
    return "roundLedger entry outcome reviewerBlockers must be an integer";
  }
  if (
    value["mechanicalBlockers"] !== undefined &&
    (typeof value["mechanicalBlockers"] !== "number" || !Number.isInteger(value["mechanicalBlockers"]))
  ) {
    return "roundLedger entry outcome mechanicalBlockers must be an integer";
  }
  if (
    value["rejectionReason"] !== undefined &&
    (typeof value["rejectionReason"] !== "string" ||
      value["rejectionReason"].length === 0 ||
      value["rejectionReason"].length > MAX_ESCALATION_REASON_LENGTH)
  ) {
    return "roundLedger entry outcome rejectionReason must be a bounded non-empty string";
  }
  if (value["continuationOwed"] !== undefined && typeof value["continuationOwed"] !== "boolean") {
    return "roundLedger entry outcome continuationOwed must be a boolean";
  }
  if (
    value["runLogPath"] !== undefined &&
    (typeof value["runLogPath"] !== "string" ||
      value["runLogPath"].length === 0 ||
      value["runLogPath"].length > MAX_PATH_LENGTH)
  ) {
    return "roundLedger entry outcome runLogPath must be a bounded non-empty string";
  }
  if (
    value["roundOutcomeAttemptId"] !== undefined &&
    (typeof value["roundOutcomeAttemptId"] !== "string" ||
      value["roundOutcomeAttemptId"].length === 0 ||
      value["roundOutcomeAttemptId"].length > MAX_ID_LENGTH)
  ) {
    return "roundLedger entry outcome roundOutcomeAttemptId must be a bounded non-empty string";
  }
  if (value["reviewerChallengedNonGoal"] !== undefined) {
    if (
      !Array.isArray(value["reviewerChallengedNonGoal"]) ||
      value["reviewerChallengedNonGoal"].length > MAX_REVIEW_BLOCKER_IDENTITIES
    ) {
      return "roundLedger entry outcome reviewerChallengedNonGoal must be a bounded array";
    }
    for (const heading of value["reviewerChallengedNonGoal"] as unknown[]) {
      if (typeof heading !== "string" || heading.length === 0 || heading.length > 200) {
        return "roundLedger entry outcome reviewerChallengedNonGoal entries must be bounded non-empty strings";
      }
    }
  }
  return undefined;
}

function validateRoundLedger(value: unknown, family: TaskProgressFamilyV1): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_ROUND_LEDGER_ENTRIES) {
    return "roundLedger must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) {
      return "roundLedger entries must be objects";
    }
    const allowed = new Set([
      "roundId",
      "intentId",
      "operationId",
      "attemptIds",
      "continuationOf",
      "stage",
      "mode",
      "startedAt",
      "state",
      "endedAt",
      "outcome",
      "checklistRevisionAdopted",
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `roundLedger entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (
      typeof entry["roundId"] !== "string" ||
      entry["roundId"].length === 0 ||
      entry["roundId"].length > MAX_ID_LENGTH
    ) {
      return "roundLedger entry roundId must be a bounded non-empty string";
    }
    if (entry["intentId"] !== undefined) {
      if (
        typeof entry["intentId"] !== "string" ||
        entry["intentId"].length === 0 ||
        entry["intentId"].length > MAX_ID_LENGTH
      ) {
        return "roundLedger entry intentId must be a bounded non-empty string";
      }
    }
    if (entry["operationId"] !== undefined) {
      if (
        typeof entry["operationId"] !== "string" ||
        entry["operationId"].length === 0 ||
        entry["operationId"].length > MAX_ID_LENGTH
      ) {
        return "roundLedger entry operationId must be a bounded non-empty string";
      }
    }
    if (
      !Array.isArray(entry["attemptIds"]) ||
      entry["attemptIds"].length > MAX_ROUND_LEDGER_ATTEMPT_IDS
    ) {
      return "roundLedger entry attemptIds must be a bounded array";
    }
    for (const attemptId of entry["attemptIds"] as unknown[]) {
      if (typeof attemptId !== "string" || attemptId.length === 0 || attemptId.length > MAX_ID_LENGTH) {
        return "roundLedger entry attemptIds entries must be bounded non-empty strings";
      }
    }
    if (entry["continuationOf"] !== undefined) {
      if (
        typeof entry["continuationOf"] !== "string" ||
        entry["continuationOf"].length === 0 ||
        entry["continuationOf"].length > MAX_ID_LENGTH
      ) {
        return "roundLedger entry continuationOf must be a bounded non-empty string";
      }
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "roundLedger entry stage must be a recognized stage";
    }
    if (typeof entry["mode"] !== "string" || !ROUND_LEDGER_MODES.has(entry["mode"])) {
      return "roundLedger entry mode must be a recognized dispatch mode";
    }
    if (!isIsoTimestamp(entry["startedAt"])) {
      return "roundLedger entry startedAt must be an ISO timestamp";
    }
    if (typeof entry["state"] !== "string" || !ROUND_LEDGER_STATES.has(entry["state"])) {
      return "roundLedger entry state must be a recognized lifecycle state";
    }
    const isTerminal = entry["state"] !== "scheduled" && entry["state"] !== "open";
    if (entry["endedAt"] !== undefined && !isIsoTimestamp(entry["endedAt"])) {
      return "roundLedger entry endedAt must be an ISO timestamp";
    }
    if (isTerminal && entry["endedAt"] === undefined) {
      return "roundLedger entry endedAt is required once state is terminal";
    }
    if (!isTerminal && entry["endedAt"] !== undefined) {
      return "roundLedger entry endedAt must be absent while state is scheduled/open";
    }
    if (entry["outcome"] !== undefined) {
      const outcomeError = validateRoundLedgerOutcome(entry["outcome"]);
      if (outcomeError) {
        return outcomeError;
      }
    }
    if (!isTerminal && entry["outcome"] !== undefined) {
      return "roundLedger entry outcome must be absent while state is scheduled/open";
    }
    if (entry["checklistRevisionAdopted"] !== undefined) {
      const revisionError = validateChecklistRevisionAdopted(entry["checklistRevisionAdopted"]);
      if (revisionError) {
        return revisionError;
      }
    }
  }
  return undefined;
}

function validateChecklistRevisionAdopted(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "roundLedger entry checklistRevisionAdopted must be an object";
  }
  const allowed = new Set(["resolvedAt", "itemCountBefore", "itemCountAfter"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `roundLedger entry checklistRevisionAdopted has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (!isIsoTimestamp(value["resolvedAt"])) {
    return "roundLedger entry checklistRevisionAdopted resolvedAt must be an ISO timestamp";
  }
  if (
    value["itemCountBefore"] !== undefined &&
    (typeof value["itemCountBefore"] !== "number" ||
      !Number.isInteger(value["itemCountBefore"]) ||
      value["itemCountBefore"] < 0)
  ) {
    return "roundLedger entry checklistRevisionAdopted itemCountBefore must be a non-negative integer";
  }
  if (
    value["itemCountAfter"] !== undefined &&
    (typeof value["itemCountAfter"] !== "number" ||
      !Number.isInteger(value["itemCountAfter"]) ||
      value["itemCountAfter"] < 0)
  ) {
    return "roundLedger entry checklistRevisionAdopted itemCountAfter must be a non-negative integer";
  }
  return undefined;
}

function validateEscalation(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!isPlainObject(value)) {
    return "escalation must be an object";
  }
  const allowed = new Set(["stage", "kind", "reason", "at", "secondOpinionAttempted"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `escalation has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (typeof value["stage"] !== "string" || resolveStage(value["stage"], family) === undefined) {
    return "escalation.stage must be a recognized stage";
  }
  if (typeof value["kind"] !== "string" || !ESCALATION_KINDS.has(value["kind"])) {
    return "escalation.kind must be a recognized escalation kind";
  }
  if (!boundedString(value["reason"], MAX_ESCALATION_REASON_LENGTH)) {
    return "escalation.reason must be a bounded string";
  }
  if (!isIsoTimestamp(value["at"])) {
    return "escalation.at must be an ISO timestamp";
  }
  if (
    value["secondOpinionAttempted"] !== undefined &&
    typeof value["secondOpinionAttempted"] !== "boolean"
  ) {
    return "escalation.secondOpinionAttempted must be a boolean when present";
  }
  return undefined;
}

function validateOverriddenEscalations(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDDEN_ESCALATIONS) {
    return "overriddenEscalations must be a bounded array";
  }
  for (const entry of value as unknown[]) {
    const error = validateEscalation(entry, family);
    if (error !== undefined) {
      return `overriddenEscalations entry invalid: ${error}`;
    }
  }
  return undefined;
}

const IMPL_RECOVERY_TRIGGERS: ReadonlySet<string> = new Set([
  "roundDeferred",
  "roundIncomplete",
  "summaryRejected",
  "externallyTerminated",
  "providerFailedMidRound",
]);
const IMPL_RECOVERY_MODES: ReadonlySet<string> = new Set([
  "summary-only",
  "inspect-and-complete",
  "unconstrained",
]);
const IMPL_RECOVERY_DISPATCH_STATES: ReadonlySet<string> = new Set([
  "pending",
  "dispatched",
]);

function validateImplRecovery(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!isPlainObject(value)) {
    return "implRecovery must be an object";
  }
  const allowed = new Set([
    "sourceAttemptId",
    "reason",
    "trigger",
    "mode",
    "dispatch",
    "at",
    "filesChangedUnknown",
    "attemptId",
    "leaseOwner",
    "leaseUntil",
    "sourceDispatchMode",
    "sourceReviewStage",
    "sourceRoundId",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `implRecovery has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (
    typeof value["sourceAttemptId"] !== "string" ||
    value["sourceAttemptId"].length === 0 ||
    value["sourceAttemptId"].length > MAX_ID_LENGTH
  ) {
    return "implRecovery.sourceAttemptId must be a bounded non-empty string";
  }
  if (
    typeof value["reason"] !== "string" ||
    value["reason"].length === 0 ||
    value["reason"].length > MAX_ESCALATION_REASON_LENGTH
  ) {
    return "implRecovery.reason must be a bounded non-empty string";
  }
  if (typeof value["trigger"] !== "string" || !IMPL_RECOVERY_TRIGGERS.has(value["trigger"])) {
    return "implRecovery.trigger must be a recognized trigger";
  }
  if (typeof value["mode"] !== "string" || !IMPL_RECOVERY_MODES.has(value["mode"])) {
    return "implRecovery.mode must be a recognized recovery mode";
  }
  if (
    typeof value["dispatch"] !== "string" ||
    !IMPL_RECOVERY_DISPATCH_STATES.has(value["dispatch"])
  ) {
    return 'implRecovery.dispatch must be "pending" or "dispatched"';
  }
  if (!isIsoTimestamp(value["at"])) {
    return "implRecovery.at must be an ISO timestamp";
  }
  if (
    value["filesChangedUnknown"] !== undefined &&
    typeof value["filesChangedUnknown"] !== "boolean"
  ) {
    return "implRecovery.filesChangedUnknown must be a boolean when present";
  }
  if (
    value["attemptId"] !== undefined &&
    (typeof value["attemptId"] !== "string" ||
      value["attemptId"].length === 0 ||
      value["attemptId"].length > MAX_ID_LENGTH)
  ) {
    return "implRecovery.attemptId must be a bounded non-empty string when present";
  }
  if (
    value["leaseOwner"] !== undefined &&
    (typeof value["leaseOwner"] !== "string" ||
      value["leaseOwner"].length === 0 ||
      value["leaseOwner"].length > MAX_ID_LENGTH)
  ) {
    return "implRecovery.leaseOwner must be a bounded non-empty string when present";
  }
  if (value["leaseUntil"] !== undefined && !isIsoTimestamp(value["leaseUntil"])) {
    return "implRecovery.leaseUntil must be an ISO timestamp when present";
  }
  if (
    value["sourceDispatchMode"] !== undefined &&
    (typeof value["sourceDispatchMode"] !== "string" ||
      !IMPLEMENTATION_DISPATCH_MODES.has(value["sourceDispatchMode"]))
  ) {
    return "implRecovery.sourceDispatchMode must be a recognized dispatch mode when present";
  }
  if (
    value["sourceReviewStage"] !== undefined &&
    (typeof value["sourceReviewStage"] !== "string" ||
      resolveStage(value["sourceReviewStage"], family) === undefined)
  ) {
    return "implRecovery.sourceReviewStage must be a recognized stage when present";
  }
  if (
    value["sourceRoundId"] !== undefined &&
    (typeof value["sourceRoundId"] !== "string" ||
      value["sourceRoundId"].length === 0 ||
      value["sourceRoundId"].length > MAX_ID_LENGTH)
  ) {
    return "implRecovery.sourceRoundId must be a bounded non-empty string when present";
  }
  return undefined;
}

const QUOTA_PARK_RECORD_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "quota",
  "model-entitlement",
]);

function validateQuotaParkRecord(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "quotaParkRecord must be an object";
  }
  const allowed = new Set([
    "modelId",
    "providerId",
    "accountKey",
    "failureKind",
    "resetAt",
    "observedAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `quotaParkRecord has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (
    typeof value["modelId"] !== "string" ||
    value["modelId"].length === 0 ||
    value["modelId"].length > MAX_ID_LENGTH
  ) {
    return "quotaParkRecord.modelId must be a bounded non-empty string";
  }
  if (
    typeof value["providerId"] !== "string" ||
    value["providerId"].length === 0 ||
    value["providerId"].length > MAX_ID_LENGTH
  ) {
    return "quotaParkRecord.providerId must be a bounded non-empty string";
  }
  if (
    value["accountKey"] !== undefined &&
    (typeof value["accountKey"] !== "string" ||
      value["accountKey"].length === 0 ||
      value["accountKey"].length > MAX_ID_LENGTH)
  ) {
    return "quotaParkRecord.accountKey must be a bounded non-empty string when present";
  }
  if (
    typeof value["failureKind"] !== "string" ||
    !QUOTA_PARK_RECORD_FAILURE_KINDS.has(value["failureKind"])
  ) {
    return 'quotaParkRecord.failureKind must be "quota" or "model-entitlement"';
  }
  if (value["resetAt"] !== undefined && !isIsoTimestamp(value["resetAt"])) {
    return "quotaParkRecord.resetAt must be an ISO timestamp when present";
  }
  if (!isIsoTimestamp(value["observedAt"])) {
    return "quotaParkRecord.observedAt must be an ISO timestamp";
  }
  return undefined;
}

function validateImplementationTypeCheckFailure(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "implementationTypeCheckFailure must be an object";
  }
  const allowed = new Set(["at", "output"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `implementationTypeCheckFailure has an unknown property ${JSON.stringify(key)}`;
    }
  }
  if (!isIsoTimestamp(value["at"])) {
    return "implementationTypeCheckFailure.at must be an ISO timestamp";
  }
  if (!boundedString(value["output"], MAX_ESCALATION_REASON_LENGTH)) {
    return "implementationTypeCheckFailure.output must be a bounded string";
  }
  return undefined;
}

function validateFallbackModelId(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "fallbackModelId must be a per-stage object map";
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!CANONICAL_STAGES.has(key)) {
      return `fallbackModelId has an unrecognized stage key ${JSON.stringify(key)}`;
    }
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_NAME_LENGTH) {
      return `fallbackModelId[${JSON.stringify(key)}] must be a bounded non-empty string`;
    }
  }
  return undefined;
}

function validateCompletedStages(
  value: unknown,
  family: TaskProgressFamilyV1
): { readonly error?: string; readonly stages?: TaskStage[] } {
  if (!Array.isArray(value)) {
    return { error: "completedStages must be an array" };
  }
  const canonical: TaskStage[] = [];
  const seen = new Set<TaskStage>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") {
      return { error: "completedStages entries must be strings" };
    }
    const stage = resolveStage(entry, family);
    if (stage === undefined) {
      return { error: `completedStages contains an unrecognized stage ${JSON.stringify(entry)}` };
    }
    if (seen.has(stage)) {
      return {
        error: `completedStages contains ${JSON.stringify(stage)} more than once after canonicalization`,
      };
    }
    seen.add(stage);
    canonical.push(stage);
  }
  // Canonicalize to the contiguous STAGE_ORDER prefix through the highest
  // recorded stage. Gapped sets are the shipped shape, not corruption: the
  // only production writer (markTaskDone.ts) persists exactly ["publish"],
  // recording the terminal tick without the stages the task passed through —
  // so earlier stages are backfilled rather than rejected (plan §3.11
  // "canonicalize to a prefix").
  if (canonical.length === 0) {
    return { stages: [] };
  }
  const highestIndex = Math.max(
    ...canonical.map((stage) => STAGE_ORDER.indexOf(stage))
  );
  return { stages: [...STAGE_ORDER.slice(0, highestIndex + 1)] };
}

function validateCompletedWithMissingArtifacts(
  value: unknown,
  family: TaskProgressFamilyV1
): string | undefined {
  if (!Array.isArray(value) || value.length > STAGE_ORDER.length * 4) {
    return "completedWithMissingArtifacts must be a bounded array";
  }
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return "completedWithMissingArtifacts entries must be objects";
    }
    const allowed = new Set(["stage", "artifact", "at", "override"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        return `completedWithMissingArtifacts entry has an unknown property ${JSON.stringify(key)}`;
      }
    }
    if (typeof entry["stage"] !== "string" || resolveStage(entry["stage"], family) === undefined) {
      return "completedWithMissingArtifacts entry stage must be a recognized stage";
    }
    if (!boundedString(entry["artifact"], MAX_PATH_LENGTH)) {
      return "completedWithMissingArtifacts entry artifact must be a bounded string";
    }
    if (!isIsoTimestamp(entry["at"])) {
      return "completedWithMissingArtifacts entry at must be an ISO timestamp";
    }
    if (entry["override"] !== "user") {
      return 'completedWithMissingArtifacts entry override must be "user"';
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Full strict decode
// ---------------------------------------------------------------------------

function recovery(
  code: TaskProgressRecoveryCodeV1,
  reason: string
): TaskProgressDecodeResultV1 {
  return { ok: false, code, reason };
}

/**
 * Strictly decode one `task-progress.json` document. Never normalizes,
 * never invents values, never drops data: anything outside the two
 * supported families' exact rules returns a recovery result.
 */
export function decodeTaskProgressTextV1(
  text: string,
  options?: DecodeTaskProgressOptionsV1
): TaskProgressDecodeResultV1 {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(text);
  } catch (error) {
    return recovery(
      "invalidJson",
      `document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isPlainObject(parsedUnknown)) {
    return recovery("notAnObject", "document is not a JSON object");
  }

  const outerScan = scanTopLevelObject(text);
  if (!outerScan.ok) {
    return recovery(
      outerScan.duplicateName !== undefined ? "duplicateProperty" : "invalidJson",
      outerScan.reason
    );
  }

  let properties = outerScan.properties;
  let parsed: Record<string, unknown> = parsedUnknown;
  let wasEnvelopeWrapped = false;

  // Historical {schemaVersion, data} envelope (workspace-legacy-v0 only):
  // exactly those two keys, a numeric schemaVersion, and an object payload.
  if (
    properties.length === 2 &&
    properties.some((p) => p.name === "schemaVersion") &&
    properties.some((p) => p.name === "data") &&
    typeof parsed["schemaVersion"] === "number" &&
    isPlainObject(parsed["data"])
  ) {
    const dataProperty = properties.find((p) => p.name === "data");
    if (dataProperty === undefined) {
      return recovery("invalidJson", "envelope data span could not be located");
    }
    const innerScan = scanTopLevelObject(dataProperty.rawValue);
    if (!innerScan.ok) {
      return recovery(
        innerScan.duplicateName !== undefined ? "duplicateProperty" : "invalidJson",
        innerScan.reason
      );
    }
    properties = innerScan.properties;
    parsed = parsed["data"];
    wasEnvelopeWrapped = true;
  }

  // --- version selection -------------------------------------------------
  let family: TaskProgressFamilyV1;
  const versionProperty = properties.find(
    (p) => p.name === ENSEMBLE_PROGRESS_VERSION_FIELD_V1
  );
  if (versionProperty !== undefined) {
    if (wasEnvelopeWrapped) {
      return recovery(
        "unsupportedProgressVersion",
        "an envelope-wrapped document cannot carry ensembleProgressVersion"
      );
    }
    const version = parsed[ENSEMBLE_PROGRESS_VERSION_FIELD_V1];
    if (typeof version !== "number" || !Number.isInteger(version) || version !== 1) {
      return recovery(
        "unsupportedProgressVersion",
        `ensembleProgressVersion must be the exact integer 1, found ${JSON.stringify(version)}`
      );
    }
    family = "ensemble-v1";
  } else {
    family = "workspace-legacy-v0";
  }

  // --- per-field validation, preserving document order --------------------
  const draft: Partial<TaskProgress> = {};
  const entries: TaskProgressDocumentEntryV1[] = [];
  const opaqueNames = new Set<string>();
  const flags: DecodeFlags = {
    legacyCompletedStage: false,
    statusWasAlias: false,
    statusExplicit: false,
  };

  for (const property of properties) {
    const { name } = property;
    if (name === ENSEMBLE_PROGRESS_VERSION_FIELD_V1) {
      continue; // Validated above; the writer always re-emits it first.
    }
    if (!PRODUCT_FIELD_NAME_SET.has(name)) {
      if (name.startsWith("ensemble")) {
        return recovery(
          "unknownEnsembleField",
          `unknown reserved field ${JSON.stringify(name)} — unknown ensemble* fields fail closed`
        );
      }
      entries.push({ kind: "opaque", entry: property });
      opaqueNames.add(name);
      continue;
    }

    const value = parsed[name];
    const fieldName = name as keyof TaskProgress;
    switch (fieldName) {
      case "taskFolder": {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > MAX_PATH_LENGTH
        ) {
          return recovery("invalidFieldValue", "taskFolder must be a bounded non-empty string");
        }
        draft.taskFolder = value;
        break;
      }
      case "displayName": {
        if (!boundedString(value, MAX_NAME_LENGTH)) {
          return recovery("invalidFieldValue", "displayName must be a bounded string");
        }
        draft.displayName = value;
        break;
      }
      case "checklistProgressUnreliable": {
        if (typeof value !== "boolean") {
          return recovery(
            "invalidFieldValue",
            "checklistProgressUnreliable must be an exact boolean"
          );
        }
        draft.checklistProgressUnreliable = value;
        break;
      }
      case "checklistProgressUnreliableReason": {
        // Mirrors pausedReason's bound: one diagnostic sentence, never free text.
        if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
          return recovery(
            "invalidFieldValue",
            "checklistProgressUnreliableReason must be a bounded non-empty string"
          );
        }
        draft.checklistProgressUnreliableReason = value;
        break;
      }
      case "zeroChangeImplRounds": {
        if (!isNonNegativeInteger(value)) {
          return recovery(
            "invalidFieldValue",
            "zeroChangeImplRounds must be a non-negative integer"
          );
        }
        draft.zeroChangeImplRounds = value;
        break;
      }
      case "nameIsDefault": {
        if (typeof value !== "boolean") {
          return recovery("invalidFieldValue", "nameIsDefault must be an exact boolean");
        }
        draft.nameIsDefault = value;
        break;
      }
      case "currentStage": {
        if (typeof value !== "string") {
          return recovery("invalidFieldValue", "currentStage must be a string");
        }
        if (family === "workspace-legacy-v0" && value === "completed") {
          flags.legacyCompletedStage = true;
          draft.currentStage = "publish";
          break;
        }
        const stage = resolveStage(value, family);
        if (stage === undefined) {
          return recovery(
            "invalidFieldValue",
            `currentStage ${JSON.stringify(value)} is not a recognized stage for family ${family}`
          );
        }
        draft.currentStage = stage;
        break;
      }
      case "status": {
        if (typeof value !== "string") {
          return recovery("invalidFieldValue", "status must be a string");
        }
        if (CANONICAL_STATUSES.has(value)) {
          draft.status = value as TaskStatus;
          flags.statusExplicit = true;
          break;
        }
        if (family === "workspace-legacy-v0" && (value === "finished" || value === "done")) {
          draft.status = "completed";
          flags.statusExplicit = true;
          flags.statusWasAlias = true;
          break;
        }
        return recovery(
          "invalidFieldValue",
          `status ${JSON.stringify(value)} is not a recognized status for family ${family}`
        );
      }
      case "completedAt": {
        if (!isIsoTimestamp(value)) {
          return recovery("invalidFieldValue", "completedAt must be an ISO timestamp");
        }
        draft.completedAt = value;
        break;
      }
      case "archivedFrom": {
        if (typeof value !== "string" || !CANONICAL_STATUSES.has(value)) {
          return recovery("invalidFieldValue", "archivedFrom must be an exact TaskStatus");
        }
        draft.archivedFrom = value as TaskStatus;
        break;
      }
      case "pinnedAt": {
        if (!isIsoTimestamp(value)) {
          return recovery("invalidFieldValue", "pinnedAt must be an ISO timestamp");
        }
        draft.pinnedAt = value;
        break;
      }
      case "publishScopePath": {
        if (!boundedString(value, MAX_PATH_LENGTH)) {
          return recovery("invalidFieldValue", "publishScopePath must be a bounded string");
        }
        draft.publishScopePath = value;
        break;
      }
      case "completedStages": {
        const result = validateCompletedStages(value, family);
        if (result.error !== undefined || result.stages === undefined) {
          return recovery("invalidFieldValue", result.error ?? "completedStages is invalid");
        }
        draft.completedStages = result.stages;
        break;
      }
      case "completedWithMissingArtifacts": {
        const error = validateCompletedWithMissingArtifacts(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.completedWithMissingArtifacts = value as CompletedWithMissingArtifactV1[];
        break;
      }
      case "preImageDescription": {
        if (!boundedString(value, MAX_PRE_IMAGE_LENGTH)) {
          return recovery("invalidFieldValue", "preImageDescription must be a bounded string");
        }
        draft.preImageDescription = value;
        break;
      }
      case "ownership": {
        const error = validateOwnership(value);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.ownership = value as TaskProgress["ownership"];
        break;
      }
      case "createdAt": {
        if (!isIsoTimestamp(value)) {
          return recovery("invalidFieldValue", "createdAt must be an ISO timestamp");
        }
        draft.createdAt = value;
        break;
      }
      case "updatedAt": {
        if (!isIsoTimestamp(value)) {
          return recovery("invalidFieldValue", "updatedAt must be an ISO timestamp");
        }
        draft.updatedAt = value;
        break;
      }
      case "progressVersion": {
        if (!isNonNegativeInteger(value)) {
          return recovery("invalidFieldValue", "progressVersion must be a non-negative integer");
        }
        draft.progressVersion = value;
        break;
      }
      case "implReviewFiles": {
        if (!Array.isArray(value) || value.length > MAX_IMPL_REVIEW_FILES) {
          return recovery("invalidFieldValue", "implReviewFiles must be a bounded array");
        }
        const files: string[] = [];
        for (const entry of value as unknown[]) {
          if (
            typeof entry !== "string" ||
            entry.length === 0 ||
            entry.length > MAX_PATH_LENGTH
          ) {
            return recovery(
              "invalidFieldValue",
              "implReviewFiles entries must be bounded non-empty strings (the permissive reader's silent filtering is coercion)"
            );
          }
          files.push(entry);
        }
        draft.implReviewFiles = files;
        break;
      }
      case "pendingImplReviewFiles": {
        // Same bounds as implReviewFiles: the quarantined set is the same
        // kind of value (workspace-relative changed paths), just not yet
        // promoted into review scope.
        if (!Array.isArray(value) || value.length > MAX_IMPL_REVIEW_FILES) {
          return recovery("invalidFieldValue", "pendingImplReviewFiles must be a bounded array");
        }
        const files: string[] = [];
        for (const entry of value as unknown[]) {
          if (
            typeof entry !== "string" ||
            entry.length === 0 ||
            entry.length > MAX_PATH_LENGTH
          ) {
            return recovery(
              "invalidFieldValue",
              "pendingImplReviewFiles entries must be bounded non-empty strings"
            );
          }
          files.push(entry);
        }
        draft.pendingImplReviewFiles = files;
        break;
      }
      case "reviewInvalidatedByRound": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return recovery("invalidFieldValue", "reviewInvalidatedByRound must be an object");
        }
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (key !== "stage" && key !== "at") {
            return recovery(
              "invalidFieldValue",
              `reviewInvalidatedByRound has an unknown field: ${key}`
            );
          }
        }
        if (typeof record["stage"] !== "string") {
          return recovery("invalidFieldValue", "reviewInvalidatedByRound.stage must be a string");
        }
        const stage = resolveStage(record["stage"], family);
        if (stage === undefined) {
          return recovery(
            "invalidFieldValue",
            "reviewInvalidatedByRound.stage must be a recognized stage"
          );
        }
        if (!isIsoTimestamp(record["at"])) {
          return recovery("invalidFieldValue", "reviewInvalidatedByRound.at must be an ISO timestamp");
        }
        draft.reviewInvalidatedByRound = { stage, at: record["at"] };
        break;
      }
      case "incompleteRoundContinuations": {
        if (!isNonNegativeInteger(value)) {
          return recovery(
            "invalidFieldValue",
            "incompleteRoundContinuations must be a non-negative integer"
          );
        }
        draft.incompleteRoundContinuations = value;
        break;
      }
      case "pausedReason": {
        // A workflow-imposed pause reason is one bounded diagnostic sentence
        // (e.g. an exhausted provider chain) — never provider free text.
        if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
          return recovery(
            "invalidFieldValue",
            "pausedReason must be a bounded non-empty string"
          );
        }
        draft.pausedReason = value;
        break;
      }
      case "lintPayload": {
        const error = validateLintPayload(value);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.lintPayload = value as LintPayload;
        break;
      }
      case "scheduledRun": {
        const error = validateScheduledRun(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        const scheduled = value as Record<string, unknown>;
        const stage = resolveStage(scheduled["stage"] as string, family);
        if (stage === undefined) {
          return recovery("invalidFieldValue", "scheduledRun.stage must be a recognized stage");
        }
        draft.scheduledRun = {
          runAt: scheduled["runAt"] as string,
          stage,
          ...(scheduled["leaseOwner"] !== undefined
            ? { leaseOwner: scheduled["leaseOwner"] as string }
            : {}),
          ...(scheduled["leaseUntil"] !== undefined
            ? { leaseUntil: scheduled["leaseUntil"] as string }
            : {}),
        };
        break;
      }
      case "scheduledResumeTime": {
        if (!isIsoTimestamp(value)) {
          return recovery("invalidFieldValue", "scheduledResumeTime must be an ISO timestamp");
        }
        draft.scheduledResumeTime = value;
        break;
      }
      case "fallbackActive": {
        const result = decodeFallbackStateV1(value);
        if (!result.ok) {
          return recovery("invalidFieldValue", result.reason);
        }
        draft.fallbackActive = result.state;
        break;
      }
      case "fallbackModelId": {
        const error = validateFallbackModelId(value);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.fallbackModelId = value as TaskProgress["fallbackModelId"];
        break;
      }
      case "reviewAttemptId": {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > MAX_ID_LENGTH
        ) {
          return recovery("invalidFieldValue", "reviewAttemptId must be a bounded non-empty string");
        }
        draft.reviewAttemptId = value;
        break;
      }
      case "reviewScoreHistory": {
        const error = validateReviewScoreHistory(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.reviewScoreHistory = value as ReviewScoreHistoryEntry[];
        break;
      }
      case "reviewRejections": {
        const error = validateReviewRejections(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.reviewRejections = value as ReviewRejectionEntry[];
        break;
      }
      case "roundOutcomes": {
        const error = validateRoundOutcomes(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.roundOutcomes = value as RoundOutcomeEntryV1[];
        break;
      }
      case "roundLedger": {
        const error = validateRoundLedger(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.roundLedger = value as RoundLedgerEntryV1[];
        break;
      }
      case "blockerSupersessions": {
        const error = validateBlockerSupersessions(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.blockerSupersessions = value as BlockerSupersessionRecordV1[];
        break;
      }
      case "checklistChangeProposals": {
        const error = validateChecklistChangeProposals(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.checklistChangeProposals = value as ChecklistChangeProposalV1[];
        break;
      }
      case "planRevision": {
        const error = validatePlanRevision(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.planRevision = value as PlanRevisionStateV1;
        break;
      }
      case "escalation": {
        const error = validateEscalation(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.escalation = value as TaskEscalation;
        break;
      }
      case "overriddenEscalations": {
        const error = validateOverriddenEscalations(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.overriddenEscalations = value as TaskEscalation[];
        break;
      }
      case "implementationTypeCheckFailure": {
        const error = validateImplementationTypeCheckFailure(value);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.implementationTypeCheckFailure = value as ImplementationTypeCheckFailure;
        break;
      }
      case "implRecovery": {
        const error = validateImplRecovery(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.implRecovery = value as ImplRecoveryV1;
        break;
      }
      case "quotaParkRecord": {
        const error = validateQuotaParkRecord(value);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.quotaParkRecord = value as QuotaParkRecordV1;
        break;
      }
    }
    entries.push({ kind: "product", name: fieldName });
  }

  // --- required fields ----------------------------------------------------
  const { taskFolder, currentStage, createdAt, updatedAt } = draft;
  if (taskFolder === undefined) {
    return recovery("invalidFieldValue", "required field taskFolder is missing");
  }
  if (currentStage === undefined) {
    return recovery("invalidFieldValue", "required field currentStage is missing");
  }
  if (createdAt === undefined) {
    return recovery("invalidFieldValue", "required field createdAt is missing");
  }
  if (updatedAt === undefined) {
    return recovery("invalidFieldValue", "required field updatedAt is missing");
  }

  // --- cross-field rules --------------------------------------------------
  if (!flags.statusExplicit) {
    if (flags.legacyCompletedStage) {
      if (draft.completedAt !== undefined) {
        draft.status = "completed";
      } else if (opaqueNames.has("publishArtifact") || opaqueNames.has("artifacts")) {
        // The permissive migrator treats these ancient opaque fields as
        // completion evidence and synthesizes a completedAt — coercion the
        // strict decoder must not reproduce or silently contradict.
        return recovery(
          "invalidFieldValue",
          "legacy \"completed\" stage with publish-artifact evidence but no completedAt is ambiguous"
        );
      } else {
        draft.status = "active";
      }
    } else {
      draft.status = "active";
    }
  }
  if (flags.statusWasAlias && draft.completedAt === undefined) {
    return recovery(
      "invalidFieldValue",
      "legacy completed-status alias without completedAt would require a synthesized timestamp (coercion-dependent value)"
    );
  }
  // completedAt alongside a non-completed status is a VALID shipped shape,
  // not corruption: completion is inferred solely from `status` and
  // completedAt survives as inert historical metadata (TaskProgress
  // declaration; archiveTask.ts/resumeArchivedTask persist archived/active
  // documents that keep it). No cross-field rejection here.
  if (draft.scheduledRun !== undefined && draft.scheduledResumeTime !== undefined) {
    return recovery(
      "conflictingAliases",
      "scheduledRun and its deprecated alias scheduledResumeTime are both present"
    );
  }
  if (
    options?.expectedTaskFolder !== undefined &&
    taskFolder !== options.expectedTaskFolder
  ) {
    return recovery(
      "taskFolderMismatch",
      `taskFolder ${JSON.stringify(taskFolder)} does not equal the discovered folder ${JSON.stringify(options.expectedTaskFolder)}`
    );
  }

  const progress: PersistedTaskProgressV1 = {
    ...draft,
    ensembleProgressVersion: 1,
    taskFolder,
    currentStage,
    createdAt,
    updatedAt,
  };

  return {
    ok: true,
    decoded: { family, progress, entries, wasEnvelopeWrapped },
  };
}
