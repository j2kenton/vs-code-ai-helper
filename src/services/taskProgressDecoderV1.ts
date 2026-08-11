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
  ImplementationTypeCheckFailure,
  LintPayload,
  MAX_REVIEW_BLOCKER_IDENTITIES,
  MAX_REVIEW_REJECTIONS,
  MAX_REVIEW_SCORE_HISTORY,
  ReviewRejectionEntry,
  ReviewScoreHistoryEntry,
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
  "preImageDescription",
  "ownership",
  "createdAt",
  "updatedAt",
  "implReviewFiles",
  "lintPayload",
  "scheduledRun",
  "scheduledResumeTime",
  "fallbackActive",
  "fallbackModelId",
  "reviewAttemptId",
  "reviewScoreHistory",
  "reviewRejections",
  "escalation",
  "implementationTypeCheckFailure",
  "checklistProgressUnreliable",
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
  const allowed = new Set(["runAt", "passed", "summary", "issueCount", "failedChecks"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `lintPayload has an unknown property ${JSON.stringify(key)}`;
    }
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
      const checkAllowed = new Set(["command", "exitCode", "output", "retryCount"]);
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
      if (!Array.isArray(blockers) || blockers.length > MAX_REVIEW_BLOCKER_IDENTITIES) {
        return "reviewScoreHistory entry blockers must be a bounded array";
      }
      for (const blocker of blockers as unknown[]) {
        if (!isPlainObject(blocker)) {
          return "reviewScoreHistory entry blockers entries must be objects";
        }
        const allowedBlockerKeys = new Set(["category", "resolver", "subject"]);
        for (const key of Object.keys(blocker)) {
          if (!allowedBlockerKeys.has(key)) {
            return `reviewScoreHistory entry blocker has an unknown property ${JSON.stringify(key)}`;
          }
        }
        for (const key of ["category", "resolver", "subject"] as const) {
          const field = blocker[key];
          if (typeof field !== "string" || field.length === 0 || field.length > 200) {
            return `reviewScoreHistory entry blocker ${key} must be a bounded non-empty string`;
          }
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
      case "escalation": {
        const error = validateEscalation(value, family);
        if (error !== undefined) {
          return recovery("invalidFieldValue", error);
        }
        draft.escalation = value as TaskEscalation;
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
