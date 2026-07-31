/**
 * Task-creation intent/journal/sentinel record types (plan §4.2, Creation
 * cohort / executable-order step 13).
 *
 * Three record kinds, all workflow-control (never artifact-safe — see
 * workflowPrivacyClassifierV1.ts), all rooted under one meta root's
 * `creation-intents-v1/` directory (or, for the sentinel, the task folder
 * itself):
 *
 *  - `TaskCreationIntentV1` (`intent-<digest>.json`): the IMMUTABLE
 *    provenance record — written once, exclusive-create, never replaced.
 *    Answers "was a V1-tracked creation ever begun for this task folder, and
 *    under what ownership?"
 *  - `TaskCreationJournalV1` (`journal-<digest>.json`): the MUTABLE forward
 *    state machine — replaced (revision-guarded) on every transition.
 *    Answers "how far did it get, and exactly what did it create?" This is
 *    the record `TaskCreationStartupReconcilerV1` consults to prefer a
 *    verified V1 answer over its own conservative guess (plan §4.1's
 *    "Recover verified V1 creation and adoption journals" step).
 *  - `TaskCreationSentinelV1` (`.ensemble-creation-sentinel-v1.json`, inside
 *    the task folder itself): the durable per-entry classification
 *    (`createdV1` / `adoptedLegacy` / `preservedUser`) that later recovery
 *    actions (Retry, Adopt-and-Retry, Safe Delete — plan §§4.4-4.6, not yet
 *    implemented) will need to know which files they may safely touch.
 *
 * `<digest>` is `computeTaskCreationIntentDigestV1(taskFolderPath)` — a
 * SHA-256 of the folder's normalized absolute path. Deriving the filename
 * from the path (rather than a random id) lets any caller that already knows
 * the task folder path — the creation flow itself, or the reconciler
 * classifying a `status: "creating"` folder it found by directory scan —
 * locate the matching intent/journal without an extra index or directory
 * scan of `creation-intents-v1/`.
 *
 * The six forward states (plan §4.2), enforced by `LEGAL_CREATION_TRANSITIONS_V1`
 * exactly like `chatInteractionTransactionV1.ts`'s state machine — no
 * self-transitions, no skipping, no going backward:
 *
 *   intentRecorded -> workMaterialized -> finalFolderClaimed ->
 *   sentinelCommitted -> progressCommitted -> resolved
 *
 * A seventh, alternate terminal state — `resolvedDeleted` — marks a creation
 * whose folder was instead removed by Safe Delete (plan §4.6 step 1, "mark
 * source creation/adoption records resolvedDeleted") before it ever reached
 * `resolved`. Safe Delete is only ever offered for a folder still classified
 * `status: "creating"` (`TaskCreationStartupReconcilerV1`'s
 * `classifyFromVerifiedJournalV1` already excludes a journal at `resolved`
 * from that classification — see its module comment), so in practice
 * `resolvedDeleted` is reached from one of the five non-terminal states, never
 * from `resolved` itself.
 */
import { createHash } from "crypto";
import { isHex128IdV1 } from "./actionCorrelationV1";

/** `creation-intents-v1/intent-<digest>.json`'s file prefix. */
export const CREATION_INTENT_FILE_PREFIX_V1 = "intent-";
/** `creation-intents-v1/journal-<digest>.json`'s file prefix. */
export const CREATION_JOURNAL_FILE_PREFIX_V1 = "journal-";

/** Bounded read/write ceiling for one intent record. */
export const MAX_CREATION_INTENT_FILE_BYTES_V1 = 16 * 1024;
/** Bounded read/write ceiling for one journal record. */
export const MAX_CREATION_JOURNAL_FILE_BYTES_V1 = 256 * 1024;
/** Bounded read/write ceiling for one sentinel record. */
export const MAX_CREATION_SENTINEL_FILE_BYTES_V1 = 64 * 1024;

/** A creation can plausibly touch a handful of files; this is generous headroom. */
export const MAX_CREATION_INTENT_ENTRIES_V1 = 64;
/** Six legal states plus headroom — mirrors chatInteractionTransactionV1's bound rationale. */
export const MAX_CREATION_INTENT_RECEIPTS_V1 = 8;

export type TaskCreationIntentStateV1 =
  | "intentRecorded"
  | "workMaterialized"
  | "finalFolderClaimed"
  | "sentinelCommitted"
  | "progressCommitted"
  | "resolved"
  | "resolvedDeleted";

export const CREATION_INTENT_STATES_V1: readonly TaskCreationIntentStateV1[] = [
  "intentRecorded",
  "workMaterialized",
  "finalFolderClaimed",
  "sentinelCommitted",
  "progressCommitted",
  "resolved",
  "resolvedDeleted",
];

/** The three sentinel entry classes (plan §4.2). */
export type CreationSentinelEntryClassV1 = "createdV1" | "adoptedLegacy" | "preservedUser";

export const CREATION_SENTINEL_ENTRY_CLASSES_V1: readonly CreationSentinelEntryClassV1[] = [
  "createdV1",
  "adoptedLegacy",
  "preservedUser",
];

/** Legal forward edges. No self-transitions; `null` is "no record yet". */
export const LEGAL_CREATION_TRANSITIONS_V1: ReadonlyMap<
  TaskCreationIntentStateV1 | null,
  readonly TaskCreationIntentStateV1[]
> = new Map<TaskCreationIntentStateV1 | null, readonly TaskCreationIntentStateV1[]>([
  [null, ["intentRecorded"]],
  ["intentRecorded", ["workMaterialized", "resolvedDeleted"]],
  ["workMaterialized", ["finalFolderClaimed", "resolvedDeleted"]],
  ["finalFolderClaimed", ["sentinelCommitted", "resolvedDeleted"]],
  ["sentinelCommitted", ["progressCommitted", "resolvedDeleted"]],
  ["progressCommitted", ["resolved", "resolvedDeleted"]],
  ["resolved", []],
  ["resolvedDeleted", []],
]);

export function isLegalCreationIntentTransitionV1(
  from: TaskCreationIntentStateV1 | null,
  to: TaskCreationIntentStateV1
): boolean {
  return (LEGAL_CREATION_TRANSITIONS_V1.get(from) ?? []).includes(to);
}

/**
 * One file or directory this creation touched, and how it must be treated by
 * later recovery actions. A `kind: "file"` entry MUST carry `contentSha256`/
 * `sizeBytes` for the exact bytes on disk at the moment this entry was
 * recorded — without them, a classifier consulting this entry can only
 * confirm a path of the right NAME exists, not that its content still
 * matches what this creation actually wrote (e.g. a user edit to `task.md`
 * after creation would go undetected). `kind: "directory"` entries carry
 * neither field; a directory's "content" is its listing, which the journal
 * does not separately track.
 */
export interface TaskCreationIntentEntryV1 {
  /** Forward-slash path relative to the task folder (e.g. "task.md"). */
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly entryClass: CreationSentinelEntryClassV1;
  /** Required for `kind: "file"`; sha256 (lowercase hex) of the exact bytes recorded. Absent for `kind: "directory"`. */
  readonly contentSha256?: string;
  /** Required for `kind: "file"`; exact byte length recorded. Absent for `kind: "directory"`. */
  readonly sizeBytes?: number;
}

export interface TaskCreationIntentTransitionReceiptV1 {
  /** 128-bit lowercase-hex receipt identity. */
  readonly receiptId: string;
  readonly from: TaskCreationIntentStateV1 | null;
  readonly to: TaskCreationIntentStateV1;
  readonly at: string;
}

/**
 * The ownership binding this creation was recorded under — the same three
 * fields `TaskProgress.ownership` persists, duplicated here (not a live
 * reference) so the journal remains a self-contained recovery record even if
 * the task's own progress file is later lost or corrupted.
 */
export interface TaskCreationIntentOwnershipClassificationV1 {
  readonly metaRoot: string;
  readonly projectRoot: string;
  readonly workspaceRoot: string;
}

/** The immutable provenance record (`intent-<digest>.json`), written once. */
export interface TaskCreationIntentV1 {
  readonly schemaVersion: 1;
  /** 128-bit lowercase-hex identity, shared with the journal and sentinel for this creation. */
  readonly intentId: string;
  readonly taskFolderName: string;
  readonly taskFolderPath: string;
  readonly metaFolderPath: string;
  readonly ownership: TaskCreationIntentOwnershipClassificationV1;
  readonly createdAt: string;
}

/** The mutable forward-state journal (`journal-<digest>.json`). */
export interface TaskCreationJournalV1 {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly state: TaskCreationIntentStateV1;
  readonly entries: readonly TaskCreationIntentEntryV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitions: readonly TaskCreationIntentTransitionReceiptV1[];
}

/** The durable per-entry classification left in the task folder itself. */
export interface TaskCreationSentinelV1 {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly taskFolderName: string;
  readonly createdAt: string;
  readonly entries: readonly TaskCreationIntentEntryV1[];
}

/** SHA-256 of the folder's normalized absolute path — the `<digest>` filename component. */
export function computeTaskCreationIntentDigestV1(normalizedTaskFolderPath: string): string {
  return createHash("sha256").update(normalizedTaskFolderPath, "utf8").digest("hex");
}

/** Build a `kind: "file"` entry's `contentSha256`/`sizeBytes` from the exact bytes recorded. */
export function fileCreationIntentEntryV1(
  relativePath: string,
  entryClass: CreationSentinelEntryClassV1,
  bytes: Uint8Array
): TaskCreationIntentEntryV1 {
  return {
    relativePath,
    kind: "file",
    entryClass,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export function creationIntentFileNameV1(digest: string): string {
  return `${CREATION_INTENT_FILE_PREFIX_V1}${digest}.json`;
}

export function creationJournalFileNameV1(digest: string): string {
  return `${CREATION_JOURNAL_FILE_PREFIX_V1}${digest}.json`;
}

// ---------------------------------------------------------------------------
// Strict decoding — same conventions as chatInteractionTransactionV1.ts:
// reject unknown fields, bounded sizes, exact shapes, no coercion.
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP_RE_V1 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestampV1(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_RE_V1.test(value) && Number.isFinite(Date.parse(value));
}

function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringV1(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unknownFieldV1(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return `${label} has an unknown field: ${key}`;
    }
  }
  return undefined;
}

const RELATIVE_PATH_RE_V1 = /^[^\0]+$/;
const CONTENT_SHA256_RE_V1 = /^[0-9a-f]{64}$/;

function decodeEntryV1(raw: unknown, index: number): { ok: true; entry: TaskCreationIntentEntryV1 } | { ok: false; reason: string } {
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: `entries[${index}] must be an object` };
  }
  const unknown = unknownFieldV1(
    raw,
    new Set(["relativePath", "kind", "entryClass", "contentSha256", "sizeBytes"]),
    `entries[${index}]`
  );
  if (unknown) return { ok: false, reason: unknown };
  const { relativePath, kind, entryClass, contentSha256, sizeBytes } = raw;
  if (!isNonEmptyStringV1(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\") ||
    relativePath.includes("..") || !RELATIVE_PATH_RE_V1.test(relativePath)) {
    return { ok: false, reason: `entries[${index}].relativePath is invalid` };
  }
  if (kind !== "file" && kind !== "directory") {
    return { ok: false, reason: `entries[${index}].kind must be "file" or "directory"` };
  }
  if (entryClass !== "createdV1" && entryClass !== "adoptedLegacy" && entryClass !== "preservedUser") {
    return { ok: false, reason: `entries[${index}].entryClass is invalid` };
  }
  if (kind === "file") {
    if (typeof contentSha256 !== "string" || !CONTENT_SHA256_RE_V1.test(contentSha256)) {
      return { ok: false, reason: `entries[${index}].contentSha256 must be a 64-char lowercase-hex sha256 for a file entry` };
    }
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
      return { ok: false, reason: `entries[${index}].sizeBytes must be a non-negative integer for a file entry` };
    }
    return { ok: true, entry: { relativePath, kind, entryClass, contentSha256, sizeBytes } };
  }
  if (contentSha256 !== undefined || sizeBytes !== undefined) {
    return { ok: false, reason: `entries[${index}] must not carry contentSha256/sizeBytes for a directory entry` };
  }
  return { ok: true, entry: { relativePath, kind, entryClass } };
}

function decodeEntriesV1(raw: unknown, label: string): { ok: true; entries: TaskCreationIntentEntryV1[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${label} must be an array` };
  }
  if (raw.length > MAX_CREATION_INTENT_ENTRIES_V1) {
    return { ok: false, reason: `${label} exceeds the maximum of ${MAX_CREATION_INTENT_ENTRIES_V1} entries` };
  }
  const entries: TaskCreationIntentEntryV1[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const decoded = decodeEntryV1(raw[i], i);
    if (!decoded.ok) return decoded;
    if (seen.has(decoded.entry.relativePath)) {
      return { ok: false, reason: `${label}[${i}] duplicates relativePath "${decoded.entry.relativePath}"` };
    }
    seen.add(decoded.entry.relativePath);
    entries.push(decoded.entry);
  }
  return { ok: true, entries };
}

function decodeOwnershipV1(
  raw: unknown
): { ok: true; ownership: TaskCreationIntentOwnershipClassificationV1 } | { ok: false; reason: string } {
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: "ownership must be an object" };
  }
  const unknown = unknownFieldV1(raw, new Set(["metaRoot", "projectRoot", "workspaceRoot"]), "ownership");
  if (unknown) return { ok: false, reason: unknown };
  const { metaRoot, projectRoot, workspaceRoot } = raw;
  if (!isNonEmptyStringV1(metaRoot) || !isNonEmptyStringV1(projectRoot) || !isNonEmptyStringV1(workspaceRoot)) {
    return { ok: false, reason: "ownership.metaRoot, ownership.projectRoot, and ownership.workspaceRoot must be non-empty strings" };
  }
  return { ok: true, ownership: { metaRoot, projectRoot, workspaceRoot } };
}

export type DecodeTaskCreationIntentResultV1 =
  | { readonly ok: true; readonly intent: TaskCreationIntentV1 }
  | { readonly ok: false; readonly reason: string };

export function decodeTaskCreationIntentV1(text: string): DecodeTaskCreationIntentResultV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: "must be a JSON object" };
  }
  const unknown = unknownFieldV1(
    raw,
    new Set(["schemaVersion", "intentId", "taskFolderName", "taskFolderPath", "metaFolderPath", "ownership", "createdAt"]),
    "creation intent"
  );
  if (unknown) return { ok: false, reason: unknown };
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be exactly 1" };
  }
  if (!isHex128IdV1(raw.intentId)) {
    return { ok: false, reason: "intentId must be a 128-bit lowercase-hex identity" };
  }
  if (!isNonEmptyStringV1(raw.taskFolderName) || !isNonEmptyStringV1(raw.taskFolderPath) || !isNonEmptyStringV1(raw.metaFolderPath)) {
    return { ok: false, reason: "taskFolderName, taskFolderPath, and metaFolderPath must be non-empty strings" };
  }
  const ownership = decodeOwnershipV1(raw.ownership);
  if (!ownership.ok) return ownership;
  if (!isIsoTimestampV1(raw.createdAt)) {
    return { ok: false, reason: "createdAt must be a valid ISO-8601 timestamp" };
  }
  return {
    ok: true,
    intent: {
      schemaVersion: 1,
      intentId: raw.intentId,
      taskFolderName: raw.taskFolderName,
      taskFolderPath: raw.taskFolderPath,
      metaFolderPath: raw.metaFolderPath,
      ownership: ownership.ownership,
      createdAt: raw.createdAt,
    },
  };
}

export function encodeTaskCreationIntentV1(intent: TaskCreationIntentV1): string {
  return JSON.stringify(intent);
}

function decodeTransitionsV1(
  raw: unknown
): { ok: true; transitions: TaskCreationIntentTransitionReceiptV1[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "transitions must be an array" };
  }
  if (raw.length === 0) {
    return { ok: false, reason: "transitions must not be empty" };
  }
  if (raw.length > MAX_CREATION_INTENT_RECEIPTS_V1) {
    return { ok: false, reason: `transitions exceeds the maximum of ${MAX_CREATION_INTENT_RECEIPTS_V1} receipts` };
  }
  const transitions: TaskCreationIntentTransitionReceiptV1[] = [];
  let previousTo: TaskCreationIntentStateV1 | null = null;
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isPlainRecordV1(entry)) {
      return { ok: false, reason: `transitions[${i}] must be an object` };
    }
    const unknown = unknownFieldV1(entry, new Set(["receiptId", "from", "to", "at"]), `transitions[${i}]`);
    if (unknown) return { ok: false, reason: unknown };
    if (!isHex128IdV1(entry.receiptId)) {
      return { ok: false, reason: `transitions[${i}].receiptId must be a 128-bit lowercase-hex identity` };
    }
    const from = entry.from;
    if (from !== null && !CREATION_INTENT_STATES_V1.includes(from as TaskCreationIntentStateV1)) {
      return { ok: false, reason: `transitions[${i}].from is invalid` };
    }
    if (from !== previousTo) {
      return { ok: false, reason: `transitions[${i}].from does not chain from the previous receipt's "to"` };
    }
    const to = entry.to;
    if (typeof to !== "string" || !CREATION_INTENT_STATES_V1.includes(to as TaskCreationIntentStateV1)) {
      return { ok: false, reason: `transitions[${i}].to is invalid` };
    }
    if (!isLegalCreationIntentTransitionV1(from as TaskCreationIntentStateV1 | null, to as TaskCreationIntentStateV1)) {
      return { ok: false, reason: `transitions[${i}] is not a legal state transition (${String(from)} -> ${to})` };
    }
    if (!isIsoTimestampV1(entry.at)) {
      return { ok: false, reason: `transitions[${i}].at must be a valid ISO-8601 timestamp` };
    }
    transitions.push({ receiptId: entry.receiptId, from: from as TaskCreationIntentStateV1 | null, to: to as TaskCreationIntentStateV1, at: entry.at });
    previousTo = to as TaskCreationIntentStateV1;
  }
  return { ok: true, transitions };
}

export type DecodeTaskCreationJournalResultV1 =
  | { readonly ok: true; readonly journal: TaskCreationJournalV1 }
  | { readonly ok: false; readonly reason: string };

export function decodeTaskCreationJournalV1(text: string): DecodeTaskCreationJournalResultV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: "must be a JSON object" };
  }
  const unknown = unknownFieldV1(
    raw,
    new Set(["schemaVersion", "intentId", "state", "entries", "createdAt", "updatedAt", "transitions"]),
    "creation journal"
  );
  if (unknown) return { ok: false, reason: unknown };
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be exactly 1" };
  }
  if (!isHex128IdV1(raw.intentId)) {
    return { ok: false, reason: "intentId must be a 128-bit lowercase-hex identity" };
  }
  if (typeof raw.state !== "string" || !CREATION_INTENT_STATES_V1.includes(raw.state as TaskCreationIntentStateV1)) {
    return { ok: false, reason: "state is invalid" };
  }
  const entries = decodeEntriesV1(raw.entries, "entries");
  if (!entries.ok) return entries;
  if (!isIsoTimestampV1(raw.createdAt) || !isIsoTimestampV1(raw.updatedAt)) {
    return { ok: false, reason: "createdAt and updatedAt must be valid ISO-8601 timestamps" };
  }
  const transitions = decodeTransitionsV1(raw.transitions);
  if (!transitions.ok) return transitions;
  const lastReceipt = transitions.transitions[transitions.transitions.length - 1]!;
  if (lastReceipt.to !== raw.state) {
    return { ok: false, reason: "state does not match the last journaled transition" };
  }
  return {
    ok: true,
    journal: {
      schemaVersion: 1,
      intentId: raw.intentId,
      state: raw.state as TaskCreationIntentStateV1,
      entries: entries.entries,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      transitions: transitions.transitions,
    },
  };
}

export function encodeTaskCreationJournalV1(journal: TaskCreationJournalV1): string {
  return JSON.stringify(journal);
}

export type DecodeTaskCreationSentinelResultV1 =
  | { readonly ok: true; readonly sentinel: TaskCreationSentinelV1 }
  | { readonly ok: false; readonly reason: string };

export function decodeTaskCreationSentinelV1(text: string): DecodeTaskCreationSentinelResultV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: "must be a JSON object" };
  }
  const unknown = unknownFieldV1(
    raw,
    new Set(["schemaVersion", "intentId", "taskFolderName", "createdAt", "entries"]),
    "creation sentinel"
  );
  if (unknown) return { ok: false, reason: unknown };
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be exactly 1" };
  }
  if (!isHex128IdV1(raw.intentId)) {
    return { ok: false, reason: "intentId must be a 128-bit lowercase-hex identity" };
  }
  if (!isNonEmptyStringV1(raw.taskFolderName)) {
    return { ok: false, reason: "taskFolderName must be a non-empty string" };
  }
  if (!isIsoTimestampV1(raw.createdAt)) {
    return { ok: false, reason: "createdAt must be a valid ISO-8601 timestamp" };
  }
  const entries = decodeEntriesV1(raw.entries, "entries");
  if (!entries.ok) return entries;
  if (entries.entries.length === 0) {
    return { ok: false, reason: "entries must not be empty" };
  }
  return {
    ok: true,
    sentinel: {
      schemaVersion: 1,
      intentId: raw.intentId,
      taskFolderName: raw.taskFolderName,
      createdAt: raw.createdAt,
      entries: entries.entries,
    },
  };
}

export function encodeTaskCreationSentinelV1(sentinel: TaskCreationSentinelV1): string {
  return JSON.stringify(sentinel);
}
