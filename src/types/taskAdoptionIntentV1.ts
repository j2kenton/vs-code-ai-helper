import { createHash } from "crypto";
import { TaskCreationIntentEntryV1, TaskCreationIntentOwnershipClassificationV1 } from "./taskCreationIntentV1";

export const ADOPTION_INTENT_FILE_PREFIX_V1 = "adoption-";
export const ADOPTION_JOURNAL_FILE_PREFIX_V1 = "adoption-journal-";

export const MAX_ADOPTION_INTENT_FILE_BYTES_V1 = 32 * 1024;
export const MAX_ADOPTION_JOURNAL_FILE_BYTES_V1 = 256 * 1024;

export type TaskAdoptionActionV1 = "retry" | "safeDelete";

export interface TaskAdoptionIntentV1 {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly taskFolderName: string;
  readonly taskFolderPath: string;
  readonly metaFolderPath: string;
  readonly ownership: TaskCreationIntentOwnershipClassificationV1;
  readonly historicalProgressFamily: "v0" | "v1" | "unknown";
  readonly requestedAction: TaskAdoptionActionV1;
  readonly confirmationReceiptId: string;
  readonly expectedSentinelSha256: string;
  readonly expectedSentinelSizeBytes: number;
  readonly entries: readonly TaskCreationIntentEntryV1[];
  readonly createdAt: string;
}

export type TaskAdoptionIntentStateV1 =
  | "intentRecorded"
  | "sentinelCommitted"
  | "resolved"
  | "resolvedDeleted";

export const ADOPTION_INTENT_STATES_V1: readonly TaskAdoptionIntentStateV1[] = [
  "intentRecorded",
  "sentinelCommitted",
  "resolved",
  "resolvedDeleted",
];

/**
 * `resolved -> resolvedDeleted` is the alternate terminal edge Safe Delete
 * uses (plan §4.6 step 1): `buildSafeDeleteEntriesV1` always resolves a
 * `requestedAction: "safeDelete"` adoption to `resolved` before the physical
 * deletion runs, so by the time deletion succeeds the adoption journal is
 * always at `resolved` already — never at an earlier state.
 */
export const LEGAL_ADOPTION_TRANSITIONS_V1: ReadonlyMap<
  TaskAdoptionIntentStateV1 | null,
  readonly TaskAdoptionIntentStateV1[]
> = new Map([
  [null, ["intentRecorded"]],
  ["intentRecorded", ["sentinelCommitted"]],
  ["sentinelCommitted", ["resolved"]],
  ["resolved", ["resolvedDeleted"]],
  ["resolvedDeleted", []],
]);

export function isLegalAdoptionIntentTransitionV1(
  from: TaskAdoptionIntentStateV1 | null,
  to: TaskAdoptionIntentStateV1
): boolean {
  return (LEGAL_ADOPTION_TRANSITIONS_V1.get(from) ?? []).includes(to);
}

export interface TaskAdoptionIntentTransitionReceiptV1 {
  readonly receiptId: string;
  readonly from: TaskAdoptionIntentStateV1 | null;
  readonly to: TaskAdoptionIntentStateV1;
  readonly at: string;
}

export interface TaskAdoptionJournalV1 {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly state: TaskAdoptionIntentStateV1;
  readonly entries: readonly TaskCreationIntentEntryV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitions: readonly TaskAdoptionIntentTransitionReceiptV1[];
}

export function computeTaskAdoptionIntentDigestV1(normalizedTaskFolderPath: string): string {
  return createHash("sha256").update(normalizedTaskFolderPath, "utf8").digest("hex");
}

export function adoptionIntentFileNameV1(digest: string): string {
  return `${ADOPTION_INTENT_FILE_PREFIX_V1}${digest}.json`;
}

export function adoptionJournalFileNameV1(digest: string): string {
  return `${ADOPTION_JOURNAL_FILE_PREFIX_V1}${digest}.json`;
}

function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeTaskAdoptionIntentV1(intent: TaskAdoptionIntentV1): string {
  return JSON.stringify(intent);
}

export function encodeTaskAdoptionJournalV1(journal: TaskAdoptionJournalV1): string {
  return JSON.stringify(journal);
}

export type DecodeTaskAdoptionIntentResultV1 =
  | { readonly ok: true; readonly intent: TaskAdoptionIntentV1 }
  | { readonly ok: false; readonly reason: string };

export function decodeTaskAdoptionIntentV1(text: string): DecodeTaskAdoptionIntentResultV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: "must be a JSON object" };
  }
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be exactly 1" };
  }
  return { ok: true, intent: raw as unknown as TaskAdoptionIntentV1 };
}

export type DecodeTaskAdoptionJournalResultV1 =
  | { readonly ok: true; readonly journal: TaskAdoptionJournalV1 }
  | { readonly ok: false; readonly reason: string };

export function decodeTaskAdoptionJournalV1(text: string): DecodeTaskAdoptionJournalResultV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isPlainRecordV1(raw)) {
    return { ok: false, reason: "must be a JSON object" };
  }
  if (raw.schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion must be exactly 1" };
  }
  return { ok: true, journal: raw as unknown as TaskAdoptionJournalV1 };
}
