import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  computeTaskAdoptionIntentDigestV1,
  decodeTaskAdoptionIntentV1,
  decodeTaskAdoptionJournalV1,
  encodeTaskAdoptionIntentV1,
  encodeTaskAdoptionJournalV1,
  isLegalAdoptionIntentTransitionV1,
  MAX_ADOPTION_INTENT_FILE_BYTES_V1,
  MAX_ADOPTION_JOURNAL_FILE_BYTES_V1,
  TaskAdoptionActionV1,
  TaskAdoptionIntentStateV1,
  TaskAdoptionIntentV1,
  TaskAdoptionJournalV1,
} from "../types/taskAdoptionIntentV1";
import {
  encodeTaskCreationSentinelV1,
  MAX_CREATION_SENTINEL_FILE_BYTES_V1,
  TaskCreationIntentEntryV1,
  TaskCreationIntentOwnershipClassificationV1,
  TaskCreationSentinelV1,
} from "../types/taskCreationIntentV1";
import { WorkflowUnavailableV1 } from "../types/workflowAvailabilityV1";
import { normalizePath } from "../utils/taskRoot";
import { WorkflowFileRevisionV1, WorkflowFileStoreResultV1 } from "./workflowFileStoreV1";
import {
  ensureWorkflowMetaRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
} from "./workflowRuntimeServicesV1";

export type TaskAdoptionIntentStoreResultV1 =
  | { readonly kind: "ok"; readonly intent: TaskAdoptionIntentV1; readonly journal: TaskAdoptionJournalV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

function rejected(reason: string): TaskAdoptionIntentStoreResultV1 {
  return { kind: "rejected", reason };
}

function storageFailure(failure: { readonly kind: "failed"; readonly errno?: string }): TaskAdoptionIntentStoreResultV1 {
  return { kind: "storageFailure", ...(typeof failure.errno === "string" ? { errno: failure.errno } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDirectoryV1(
  result: Promise<WorkflowFileStoreResultV1<void>>
): Promise<TaskAdoptionIntentStoreResultV1 | undefined> {
  const made = await result;
  if (made.kind === "unavailable") {
    return made;
  }
  if (made.kind === "failed" && made.code !== "targetExists") {
    return storageFailure(made);
  }
  return undefined;
}

export function taskAdoptionIntentDigestV1(taskFolderPath: string): string {
  return computeTaskAdoptionIntentDigestV1(normalizePath(taskFolderPath));
}

function mergeEntryListsV1(
  existing: readonly TaskCreationIntentEntryV1[],
  additional: readonly TaskCreationIntentEntryV1[]
): TaskCreationIntentEntryV1[] {
  const byPath = new Map<string, TaskCreationIntentEntryV1>();
  for (const entry of existing) byPath.set(entry.relativePath, entry);
  for (const entry of additional) byPath.set(entry.relativePath, entry);
  return [...byPath.values()];
}

type LoadJournalOutcomeV1 =
  | { readonly kind: "ok"; readonly journal: TaskAdoptionJournalV1; readonly revision: WorkflowFileRevisionV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

async function loadAdoptionJournalRecordV1(metaRootId: string, digest: string): Promise<LoadJournalOutcomeV1> {
  const locator = getWorkflowPathRegistryV1().adoptionJournalFile(metaRootId, digest).locator;
  const read = await getWorkflowFileStoreV1().readFileBounded(locator, MAX_ADOPTION_JOURNAL_FILE_BYTES_V1);
  if (read.kind === "unavailable") return read;
  if (read.kind === "failed") {
    if (read.code === "targetMissing") return { kind: "missing" };
    return { kind: "storageFailure", ...(read.errno ? { errno: read.errno } : {}) };
  }
  const decoded = decodeTaskAdoptionJournalV1(read.value.bytes.toString("utf8"));
  if (!decoded.ok) {
    return { kind: "recoveryRequired", reason: `adoption journal failed strict decoding: ${decoded.reason}` };
  }
  return { kind: "ok", journal: decoded.journal, revision: read.value.revision };
}

type LoadIntentOutcomeV1 =
  | { readonly kind: "ok"; readonly intent: TaskAdoptionIntentV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

async function loadAdoptionIntentRecordV1(metaRootId: string, digest: string): Promise<LoadIntentOutcomeV1> {
  const locator = getWorkflowPathRegistryV1().adoptionIntentFile(metaRootId, digest).locator;
  const read = await getWorkflowFileStoreV1().readFileBounded(locator, MAX_ADOPTION_INTENT_FILE_BYTES_V1);
  if (read.kind === "unavailable") return read;
  if (read.kind === "failed") {
    if (read.code === "targetMissing") return { kind: "missing" };
    return { kind: "storageFailure", ...(read.errno ? { errno: read.errno } : {}) };
  }
  const decoded = decodeTaskAdoptionIntentV1(read.value.bytes.toString("utf8"));
  if (!decoded.ok) {
    return { kind: "recoveryRequired", reason: `adoption intent failed strict decoding: ${decoded.reason}` };
  }
  return { kind: "ok", intent: decoded.intent };
}

export async function loadTaskAdoptionJournalV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskAdoptionIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskAdoptionIntentDigestV1(taskFolderPath);
  const journalResult = await loadAdoptionJournalRecordV1(metaRootId, digest);
  if (journalResult.kind !== "ok") {
    return journalResult;
  }
  const intentResult = await loadAdoptionIntentRecordV1(metaRootId, digest);
  if (intentResult.kind !== "ok") {
    return intentResult.kind === "missing"
      ? { kind: "recoveryRequired", reason: "an adoption journal exists with no matching intent record" }
      : intentResult;
  }
  if (normalizePath(intentResult.intent.taskFolderPath) !== normalizePath(taskFolderPath)) {
    return {
      kind: "recoveryRequired",
      reason: "the adoption intent's recorded taskFolderPath does not match the folder it was looked up for",
    };
  }
  return { kind: "ok", intent: intentResult.intent, journal: journalResult.journal };
}

export interface RecordTaskAdoptionIntentInputV1 {
  readonly metaFolderPath: string;
  readonly taskFolderPath: string;
  readonly taskFolderName: string;
  readonly ownership: TaskCreationIntentOwnershipClassificationV1;
  readonly historicalProgressFamily: "v0" | "v1" | "unknown";
  readonly requestedAction: TaskAdoptionActionV1;
  readonly confirmationReceiptId: string;
  readonly expectedSentinelSha256: string;
  readonly expectedSentinelSizeBytes: number;
  readonly entries: readonly TaskCreationIntentEntryV1[];
}

export async function recordTaskAdoptionIntentV1(
  input: RecordTaskAdoptionIntentInputV1
): Promise<TaskAdoptionIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(input.metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskAdoptionIntentDigestV1(input.taskFolderPath);
  const registry = getWorkflowPathRegistryV1();
  const intentsDirLocator = registry.creationIntentsDir(metaRootId).locator;
  const intentLocator = registry.adoptionIntentFile(metaRootId, digest).locator;
  const journalLocator = registry.adoptionJournalFile(metaRootId, digest).locator;
  const fileStore = getWorkflowFileStoreV1();

  const provisionFailure = await ensureDirectoryV1(fileStore.createDirectory(intentsDirLocator));
  if (provisionFailure) {
    return provisionFailure;
  }

  const intentId = allocateHex128IdV1();
  const nowIso = new Date().toISOString();
  const intent: TaskAdoptionIntentV1 = {
    schemaVersion: 1,
    intentId,
    taskFolderName: input.taskFolderName,
    taskFolderPath: input.taskFolderPath,
    metaFolderPath: input.metaFolderPath,
    ownership: input.ownership,
    historicalProgressFamily: input.historicalProgressFamily,
    requestedAction: input.requestedAction,
    confirmationReceiptId: input.confirmationReceiptId,
    expectedSentinelSha256: input.expectedSentinelSha256,
    expectedSentinelSizeBytes: input.expectedSentinelSizeBytes,
    entries: input.entries,
    createdAt: nowIso,
  };
  const journal: TaskAdoptionJournalV1 = {
    schemaVersion: 1,
    intentId,
    state: "intentRecorded",
    entries: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    transitions: [{ receiptId: allocateHex128IdV1(), from: null, to: "intentRecorded", at: nowIso }],
  };

  const intentWrite = await fileStore.createFileExclusive(intentLocator, Buffer.from(encodeTaskAdoptionIntentV1(intent), "utf8"));
  if (intentWrite.kind === "unavailable") return intentWrite;
  if (intentWrite.kind === "failed") {
    if (intentWrite.code === "targetExists") {
      return rejected("an adoption intent already exists for this task folder");
    }
    return storageFailure(intentWrite);
  }

  const journalWrite = await fileStore.createFileExclusive(journalLocator, Buffer.from(encodeTaskAdoptionJournalV1(journal), "utf8"));
  if (journalWrite.kind === "unavailable") return journalWrite;
  if (journalWrite.kind === "failed") {
    if (journalWrite.code === "targetExists") {
      return { kind: "recoveryRequired", reason: "an adoption journal already exists without a matching intent write" };
    }
    return storageFailure(journalWrite);
  }
  return { kind: "ok", intent, journal };
}

async function appendAdoptionTransitionV1(
  metaFolderPath: string,
  taskFolderPath: string,
  to: TaskAdoptionIntentStateV1,
  newEntries: readonly TaskCreationIntentEntryV1[]
): Promise<TaskAdoptionIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskAdoptionIntentDigestV1(taskFolderPath);
  const journalResult = await loadAdoptionJournalRecordV1(metaRootId, digest);
  if (journalResult.kind !== "ok") {
    return journalResult;
  }
  const intentResult = await loadAdoptionIntentRecordV1(metaRootId, digest);
  if (intentResult.kind !== "ok") {
    return intentResult.kind === "missing"
      ? { kind: "recoveryRequired", reason: "an adoption journal exists with no matching intent record" }
      : intentResult;
  }
  const { journal: current, revision } = journalResult;
  if (current.state === to) {
    return { kind: "ok", intent: intentResult.intent, journal: current };
  }
  if (!isLegalAdoptionIntentTransitionV1(current.state, to)) {
    return rejected(`illegal adoption-intent transition: ${current.state} -> ${to}`);
  }
  const nowIso = new Date().toISOString();
  const next: TaskAdoptionJournalV1 = {
    ...current,
    state: to,
    entries: mergeEntryListsV1(current.entries, newEntries),
    updatedAt: nowIso,
    transitions: [...current.transitions, { receiptId: allocateHex128IdV1(), from: current.state, to, at: nowIso }],
  };
  const journalLocator = getWorkflowPathRegistryV1().adoptionJournalFile(metaRootId, digest).locator;
  const write = await getWorkflowFileStoreV1().replaceFileExact(
    journalLocator,
    Buffer.from(encodeTaskAdoptionJournalV1(next), "utf8"),
    revision
  );
  if (write.kind === "unavailable") return write;
  if (write.kind === "failed") {
    if (write.code === "revisionMismatch") {
      return rejected("the adoption journal changed concurrently; retry the transition");
    }
    return storageFailure(write);
  }
  return { kind: "ok", intent: intentResult.intent, journal: next };
}

import { ensureWorkflowTaskFolderRootV1 } from "./workflowRuntimeServicesV1";

export async function commitAdoptionSentinelV1(
  metaFolderPath: string,
  taskFolderPath: string,
  entries: readonly TaskCreationIntentEntryV1[] = []
): Promise<TaskAdoptionIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskAdoptionIntentDigestV1(taskFolderPath);
  const journalResult = await loadAdoptionJournalRecordV1(metaRootId, digest);
  if (journalResult.kind !== "ok") {
    return journalResult;
  }
  const intentResult = await loadAdoptionIntentRecordV1(metaRootId, digest);
  if (intentResult.kind !== "ok") {
    return intentResult.kind === "missing"
      ? { kind: "recoveryRequired", reason: "an adoption journal exists with no matching intent record" }
      : intentResult;
  }
  const { journal: current } = journalResult;
  if (current.state === "sentinelCommitted") {
    return { kind: "ok", intent: intentResult.intent, journal: current };
  }
  if (current.state !== "intentRecorded") {
    return rejected(`illegal adoption-intent transition: ${current.state} -> sentinelCommitted`);
  }

  let taskRootId: string;
  try {
    taskRootId = ensureWorkflowTaskFolderRootV1(taskFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const mergedEntries = mergeEntryListsV1(current.entries, entries);
  const sentinel: TaskCreationSentinelV1 = {
    schemaVersion: 1,
    intentId: current.intentId, // Note: using adoption intent id as the sentinel's intent id
    taskFolderName: intentResult.intent.taskFolderName,
    createdAt: current.createdAt,
    entries: mergedEntries,
  };
  const sentinelText = encodeTaskCreationSentinelV1(sentinel);
  const sentinelLocator = getWorkflowPathRegistryV1().creationSentinelFile(taskRootId).locator;
  const fileStore = getWorkflowFileStoreV1();
  const write = await fileStore.createFileExclusive(sentinelLocator, Buffer.from(sentinelText, "utf8"));
  if (write.kind === "unavailable") return write;
  if (write.kind === "failed") {
    if (write.code !== "targetExists") {
      return storageFailure(write);
    }
    const existing = await fileStore.readFileBounded(sentinelLocator, MAX_CREATION_SENTINEL_FILE_BYTES_V1);
    if (existing.kind !== "ok" || existing.value.bytes.toString("utf8") !== sentinelText) {
      return {
        kind: "recoveryRequired",
        reason: "a creation sentinel already exists for this task folder and does not match this adoption intent",
      };
    }
  }
  return appendAdoptionTransitionV1(metaFolderPath, taskFolderPath, "sentinelCommitted", entries);
}

export function recordAdoptionSentinelCommittedV1(
  metaFolderPath: string,
  taskFolderPath: string,
  entries: readonly TaskCreationIntentEntryV1[] = []
): Promise<TaskAdoptionIntentStoreResultV1> {
  return appendAdoptionTransitionV1(metaFolderPath, taskFolderPath, "sentinelCommitted", entries);
}

export function resolveTaskAdoptionV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskAdoptionIntentStoreResultV1> {
  return appendAdoptionTransitionV1(metaFolderPath, taskFolderPath, "resolved", []);
}

/**
 * Alternate terminal transition from `resolved`: the folder this
 * `requestedAction: "safeDelete"` adoption authorized was actually removed
 * (plan §4.6 step 1, "mark source creation/adoption records
 * resolvedDeleted"). Never call this for a `requestedAction: "retry"`
 * adoption — that folder is alive, not deleted.
 */
export function resolveTaskAdoptionDeletedV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskAdoptionIntentStoreResultV1> {
  return appendAdoptionTransitionV1(metaFolderPath, taskFolderPath, "resolvedDeleted", []);
}
