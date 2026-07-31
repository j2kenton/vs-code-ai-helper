/**
 * Task-creation Safe Delete journal record types (plan §4.6).
 *
 * A separate three-state durable transaction from `taskCreationIntentV1.ts`'s
 * six-state creation journal and `taskAdoptionIntentV1.ts`'s three-state
 * adoption journal, sharing their `creation-intents-v1/` directory at
 * `delete-<digest>.json` (same path-derived digest as the other two
 * families — `computeTaskDeletionIntentDigestV1(normalizedTaskFolderPath)`).
 *
 * Unlike creation/adoption, Safe Delete has no separate immutable "intent"
 * record — one mutable journal file carries everything from the very first
 * write (`deleteRequested`, written BEFORE any filesystem removal) through
 * `folderRemoved` (the task folder and its entries are gone) to
 * `externalStateResolved` (the current-task checkpoint has been cleared if it
 * pointed at this folder, and a tree refresh has been triggered). This
 * journal — not a durable task-inventory record, which does not exist
 * (`TaskInventory` is scan-derived; see `taskCreationRecoveryV1.ts`'s module
 * header) — is the durable evidence a deletion happened and how far it got,
 * so a crash between any two states resumes from exactly that state rather
 * than re-attempting completed work or, worse, recreating the folder.
 *
 * `entries` lists only what THIS deletion is authorized to remove, in
 * reverse-removal order (files before the directory that would contain
 * them). Per plan §4.6, `preservedUser` entries can never appear here —
 * `decodeTaskDeletionJournalV1` rejects any journal that carries one, and
 * `recordTaskDeletionRequestedV1` refuses to write one — Safe Delete may
 * remove only `createdV1` (this extension's own untouched writes) or
 * `adoptedLegacy` (explicitly adopted-for-deletion via §4.4, which classifies
 * differently depending on `TaskAdoptionActionV1`: adopting for `"retry"`
 * marks the same bytes `preservedUser` instead) content.
 */
import { createHash } from "crypto";
import { isHex128IdV1 } from "./actionCorrelationV1";
import {
  TaskCreationIntentEntryV1,
  TaskCreationIntentOwnershipClassificationV1,
} from "./taskCreationIntentV1";

/** `creation-intents-v1/delete-<digest>.json`'s file prefix. */
export const DELETION_JOURNAL_FILE_PREFIX_V1 = "delete-";

/** Bounded read/write ceiling for one deletion journal record. */
export const MAX_DELETION_JOURNAL_FILE_BYTES_V1 = 256 * 1024;
/** A deletion touches at most a handful of files plus the directory itself. */
export const MAX_DELETION_ENTRIES_V1 = 16;
/** Three legal states plus headroom. */
export const MAX_DELETION_RECEIPTS_V1 = 6;
/** Generous headroom for the creation/adoption intentId(s) this delete is based on. */
export const MAX_DELETION_SOURCE_INTENT_IDS_V1 = 4;

export type TaskDeletionStateV1 = "deleteRequested" | "folderRemoved" | "externalStateResolved";

export const DELETION_STATES_V1: readonly TaskDeletionStateV1[] = [
  "deleteRequested",
  "folderRemoved",
  "externalStateResolved",
];

/** Legal forward edges. No self-transitions; `null` is "no record yet". */
export const LEGAL_DELETION_TRANSITIONS_V1: ReadonlyMap<
  TaskDeletionStateV1 | null,
  readonly TaskDeletionStateV1[]
> = new Map<TaskDeletionStateV1 | null, readonly TaskDeletionStateV1[]>([
  [null, ["deleteRequested"]],
  ["deleteRequested", ["folderRemoved"]],
  ["folderRemoved", ["externalStateResolved"]],
  ["externalStateResolved", []],
]);

export function isLegalDeletionTransitionV1(
  from: TaskDeletionStateV1 | null,
  to: TaskDeletionStateV1
): boolean {
  return (LEGAL_DELETION_TRANSITIONS_V1.get(from) ?? []).includes(to);
}

export interface TaskDeletionTransitionReceiptV1 {
  readonly receiptId: string;
  readonly from: TaskDeletionStateV1 | null;
  readonly to: TaskDeletionStateV1;
  readonly at: string;
}

/** The durable Safe Delete transaction (`delete-<digest>.json`). */
export interface TaskDeletionJournalV1 {
  readonly schemaVersion: 1;
  readonly deletionId: string;
  readonly taskFolderName: string;
  readonly taskFolderPath: string;
  readonly metaFolderPath: string;
  readonly ownership: TaskCreationIntentOwnershipClassificationV1;
  /** The creation and/or adoption journal `intentId`(s) this delete's entries were verified against. */
  readonly sourceIntentIds: readonly string[];
  readonly confirmationReceiptId: string;
  readonly entries: readonly TaskCreationIntentEntryV1[];
  /** Whether `CurrentTaskStore` pointed at this task folder at `deleteRequested` time. */
  readonly currentTaskCheckpointObserved: boolean;
  /** Audit-only: whether a derived task-inventory rescan was performed as part of resolving this deletion. */
  readonly inventoryScanObserved: boolean;
  readonly state: TaskDeletionStateV1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitions: readonly TaskDeletionTransitionReceiptV1[];
}

/** SHA-256 of the folder's normalized absolute path — shared digest scheme with creation/adoption. */
export function computeTaskDeletionIntentDigestV1(normalizedTaskFolderPath: string): string {
  return createHash("sha256").update(normalizedTaskFolderPath, "utf8").digest("hex");
}

export function deletionJournalFileNameV1(digest: string): string {
  return `${DELETION_JOURNAL_FILE_PREFIX_V1}${digest}.json`;
}

// ---------------------------------------------------------------------------
// Strict decoding — same conventions as taskCreationIntentV1.ts: reject
// unknown fields, bounded sizes, exact shapes, no coercion. `preservedUser`
// entries are always rejected (see module header).
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

function decodeDeletionEntryV1(
  raw: unknown,
  index: number
): { ok: true; entry: TaskCreationIntentEntryV1 } | { ok: false; reason: string } {
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
  if (
    !isNonEmptyStringV1(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    relativePath.includes("..") ||
    !RELATIVE_PATH_RE_V1.test(relativePath)
  ) {
    return { ok: false, reason: `entries[${index}].relativePath is invalid` };
  }
  if (kind !== "file" && kind !== "directory") {
    return { ok: false, reason: `entries[${index}].kind must be "file" or "directory"` };
  }
  // Safe Delete may only remove content it (or a completed adoption) is
  // certain about — never a preserved user edit (plan §4.6).
  if (entryClass !== "createdV1" && entryClass !== "adoptedLegacy") {
    return {
      ok: false,
      reason: `entries[${index}].entryClass must be "createdV1" or "adoptedLegacy" — a deletion journal must never carry a "preservedUser" entry`,
    };
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

function decodeDeletionEntriesV1(
  raw: unknown
): { ok: true; entries: TaskCreationIntentEntryV1[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "entries must be an array" };
  }
  if (raw.length === 0) {
    return { ok: false, reason: "entries must not be empty" };
  }
  if (raw.length > MAX_DELETION_ENTRIES_V1) {
    return { ok: false, reason: `entries exceeds the maximum of ${MAX_DELETION_ENTRIES_V1} entries` };
  }
  const entries: TaskCreationIntentEntryV1[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const decoded = decodeDeletionEntryV1(raw[i], i);
    if (!decoded.ok) return decoded;
    if (seen.has(decoded.entry.relativePath)) {
      return { ok: false, reason: `entries[${i}] duplicates relativePath "${decoded.entry.relativePath}"` };
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

function decodeSourceIntentIdsV1(raw: unknown): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "sourceIntentIds must be a non-empty array" };
  }
  if (raw.length > MAX_DELETION_SOURCE_INTENT_IDS_V1) {
    return { ok: false, reason: `sourceIntentIds exceeds the maximum of ${MAX_DELETION_SOURCE_INTENT_IDS_V1} entries` };
  }
  const ids: string[] = [];
  for (const value of raw) {
    if (!isHex128IdV1(value)) {
      return { ok: false, reason: "sourceIntentIds must contain only 128-bit lowercase-hex identities" };
    }
    ids.push(value);
  }
  return { ok: true, ids };
}

function decodeDeletionTransitionsV1(
  raw: unknown
): { ok: true; transitions: TaskDeletionTransitionReceiptV1[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "transitions must be a non-empty array" };
  }
  if (raw.length > MAX_DELETION_RECEIPTS_V1) {
    return { ok: false, reason: `transitions exceeds the maximum of ${MAX_DELETION_RECEIPTS_V1} receipts` };
  }
  const transitions: TaskDeletionTransitionReceiptV1[] = [];
  let previousTo: TaskDeletionStateV1 | null = null;
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
    if (from !== null && !DELETION_STATES_V1.includes(from as TaskDeletionStateV1)) {
      return { ok: false, reason: `transitions[${i}].from is invalid` };
    }
    if (from !== previousTo) {
      return { ok: false, reason: `transitions[${i}].from does not chain from the previous receipt's "to"` };
    }
    const to = entry.to;
    if (typeof to !== "string" || !DELETION_STATES_V1.includes(to as TaskDeletionStateV1)) {
      return { ok: false, reason: `transitions[${i}].to is invalid` };
    }
    if (!isLegalDeletionTransitionV1(from as TaskDeletionStateV1 | null, to as TaskDeletionStateV1)) {
      return { ok: false, reason: `transitions[${i}] is not a legal state transition (${String(from)} -> ${to})` };
    }
    if (!isIsoTimestampV1(entry.at)) {
      return { ok: false, reason: `transitions[${i}].at must be a valid ISO-8601 timestamp` };
    }
    transitions.push({ receiptId: entry.receiptId, from: from as TaskDeletionStateV1 | null, to: to as TaskDeletionStateV1, at: entry.at });
    previousTo = to as TaskDeletionStateV1;
  }
  return { ok: true, transitions };
}

export type DecodeTaskDeletionJournalResultV1 =
  | { readonly ok: true; readonly journal: TaskDeletionJournalV1 }
  | { readonly ok: false; readonly reason: string };

export function decodeTaskDeletionJournalV1(text: string): DecodeTaskDeletionJournalResultV1 {
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
    new Set([
      "schemaVersion",
      "deletionId",
      "taskFolderName",
      "taskFolderPath",
      "metaFolderPath",
      "ownership",
      "sourceIntentIds",
      "confirmationReceiptId",
      "entries",
      "currentTaskCheckpointObserved",
      "inventoryScanObserved",
      "state",
      "createdAt",
      "updatedAt",
      "transitions",
    ]),
    "deletion journal"
  );
  if (unknown) return { ok: false, reason: unknown };
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be exactly 1" };
  }
  if (!isHex128IdV1(raw.deletionId)) {
    return { ok: false, reason: "deletionId must be a 128-bit lowercase-hex identity" };
  }
  if (!isNonEmptyStringV1(raw.taskFolderName) || !isNonEmptyStringV1(raw.taskFolderPath) || !isNonEmptyStringV1(raw.metaFolderPath)) {
    return { ok: false, reason: "taskFolderName, taskFolderPath, and metaFolderPath must be non-empty strings" };
  }
  const ownership = decodeOwnershipV1(raw.ownership);
  if (!ownership.ok) return ownership;
  const sourceIntentIds = decodeSourceIntentIdsV1(raw.sourceIntentIds);
  if (!sourceIntentIds.ok) return sourceIntentIds;
  if (!isHex128IdV1(raw.confirmationReceiptId)) {
    return { ok: false, reason: "confirmationReceiptId must be a 128-bit lowercase-hex identity" };
  }
  const entries = decodeDeletionEntriesV1(raw.entries);
  if (!entries.ok) return entries;
  if (typeof raw.currentTaskCheckpointObserved !== "boolean") {
    return { ok: false, reason: "currentTaskCheckpointObserved must be a boolean" };
  }
  if (typeof raw.inventoryScanObserved !== "boolean") {
    return { ok: false, reason: "inventoryScanObserved must be a boolean" };
  }
  if (typeof raw.state !== "string" || !DELETION_STATES_V1.includes(raw.state as TaskDeletionStateV1)) {
    return { ok: false, reason: "state is invalid" };
  }
  if (!isIsoTimestampV1(raw.createdAt) || !isIsoTimestampV1(raw.updatedAt)) {
    return { ok: false, reason: "createdAt and updatedAt must be valid ISO-8601 timestamps" };
  }
  const transitions = decodeDeletionTransitionsV1(raw.transitions);
  if (!transitions.ok) return transitions;
  const lastReceipt = transitions.transitions[transitions.transitions.length - 1]!;
  if (lastReceipt.to !== raw.state) {
    return { ok: false, reason: "state does not match the last journaled transition" };
  }
  return {
    ok: true,
    journal: {
      schemaVersion: 1,
      deletionId: raw.deletionId,
      taskFolderName: raw.taskFolderName,
      taskFolderPath: raw.taskFolderPath,
      metaFolderPath: raw.metaFolderPath,
      ownership: ownership.ownership,
      sourceIntentIds: sourceIntentIds.ids,
      confirmationReceiptId: raw.confirmationReceiptId,
      entries: entries.entries,
      currentTaskCheckpointObserved: raw.currentTaskCheckpointObserved,
      inventoryScanObserved: raw.inventoryScanObserved,
      state: raw.state as TaskDeletionStateV1,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      transitions: transitions.transitions,
    },
  };
}

export function encodeTaskDeletionJournalV1(journal: TaskDeletionJournalV1): string {
  return JSON.stringify(journal);
}
