/**
 * run1 Step 28: remembers, per task, when the owner last cancelled a running operation and why, so a held
 * answer can tell "the owner cancelled" from "the round simply ended".
 *
 * The record is kept in memory and, once the extension has given it a store
 * ({@link setOwnerCancelStoreV1}), also in that store (the workspace state), so a held answer recovered after a
 * restart still tells an ordinary Cancel from a round that simply ended.
 *
 * Reasons:
 * - `owner`: an ordinary Cancel. A held answer does not run after it; the owner is asked.
 * - `runHeldAnswer`: the cancel behind "Run it now". It is the owner's go-ahead for the held answer.
 */
import { normalizePath } from "./taskRoot";

export type OwnerCancelReasonV1 = "owner" | "runHeldAnswer";

export interface OwnerCancelRecordV1 {
  readonly at: number;
  readonly reason: OwnerCancelReasonV1;
}

/** The part of a VS Code Memento this module needs. */
export interface OwnerCancelStoreV1 {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const STORE_KEY = "ensemble.ownerCancelRecords.v1";
/** Old records are dropped: an answer is never held for longer than this and a cancel older than it is moot. */
const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const records = new Map<string, OwnerCancelRecordV1>();
let store: OwnerCancelStoreV1 | undefined;

/** Called once at activation. Records already in the store are read lazily by {@link lastOwnerCancelV1}. */
export function setOwnerCancelStoreV1(next: OwnerCancelStoreV1 | undefined): void {
  store = next;
}

function readStored(): Record<string, OwnerCancelRecordV1> {
  const value = store?.get<Record<string, OwnerCancelRecordV1>>(STORE_KEY);
  return value !== undefined && typeof value === "object" && value !== null ? value : {};
}

function persist(key: string, record: OwnerCancelRecordV1, now: number): void {
  if (!store) return;
  const kept: Record<string, OwnerCancelRecordV1> = {};
  for (const [k, v] of Object.entries(readStored())) {
    if (now - v.at < MAX_RECORD_AGE_MS) kept[k] = v;
  }
  kept[key] = record;
  void Promise.resolve(store.update(STORE_KEY, kept)).catch(() => undefined);
}

export function recordOwnerCancelV1(
  taskFolderPath: string,
  reason: OwnerCancelReasonV1 = "owner",
  now: number = Date.now()
): void {
  const key = normalizePath(taskFolderPath);
  const previous = lastOwnerCancelV1(taskFolderPath);
  // An ordinary cancel never replaces a "Run it now" cancel recorded in the same moment: the owner's go-ahead
  // stands for the cascade that cancels the round's children as well.
  if (previous?.reason === "runHeldAnswer" && reason === "owner" && now - previous.at < 5_000) {
    return;
  }
  const record: OwnerCancelRecordV1 = { at: now, reason };
  records.set(key, record);
  persist(key, record, now);
}

/** The owner's latest cancel on the task, if any. */
export function lastOwnerCancelV1(taskFolderPath: string): OwnerCancelRecordV1 | undefined {
  const key = normalizePath(taskFolderPath);
  const local = records.get(key);
  const stored = readStored()[key];
  if (local && stored) return local.at >= stored.at ? local : stored;
  return local ?? stored;
}

/**
 * How the task's last run ended, as far as the owner's own actions go, for an answer chosen at `chosenAtMs`.
 * A cancel from before the answer was chosen is about an earlier round and does not count.
 */
export function lastRunEndedByForAnswerV1(
  taskFolderPath: string,
  chosenAtMs: number
): "owner" | "runHeldAnswer" | "other" {
  const record = lastOwnerCancelV1(taskFolderPath);
  if (!record || record.at < chosenAtMs) {
    return "other";
  }
  return record.reason === "runHeldAnswer" ? "runHeldAnswer" : "owner";
}

/** Tests only: forgets what this process remembers, as a restart does, but keeps the store. */
export function forgetInMemoryOwnerCancelsForTestV1(): void {
  records.clear();
}

export function clearOwnerCancelRecordsForTestV1(): void {
  records.clear();
  store = undefined;
}
