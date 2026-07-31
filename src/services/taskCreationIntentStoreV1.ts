/**
 * Task-creation intent/journal/sentinel store (plan §4.2, Creation cohort /
 * executable-order step 13).
 *
 * The one writer/reader for the three record kinds `taskCreationIntentV1.ts`
 * defines. Every filesystem operation goes through the shared
 * `WorkflowFileStoreV1` (exclusive-create, revision-guarded replacement,
 * bounded reads — plan §1.8) over locators the shared `WorkflowPathRegistryV1`
 * allocates (plan §2.1); this module holds no path authority of its own.
 * `getWorkflowFileStoreV1()`/`getWorkflowPathRegistryV1()` are evaluated at
 * every call site (never cached), matching `chatHistoryStore.ts`'s own
 * documented reason: registering a not-yet-seen root rebuilds the shared file
 * store, and an earlier-captured store reference would not know about it.
 *
 * `startNewTask.ts` is this store's one production writer, called around its
 * actual (non-staged) creation steps — see `taskCreationIntentV1.ts`'s module
 * header for the "NON-STAGED INTERPRETATION" scoping note.
 * `TaskCreationStartupReconcilerV1` is its one production reader: a verified,
 * not-yet-`resolved` journal for a `status: "creating"` folder means the
 * folder's entries are ALL known and extension-created (`createdV1`), which
 * is a strictly stronger, more precise answer than the legacy conservative
 * classifier's seed-matching guess.
 *
 * Every write is crash-resumable: `recordTaskCreationIntentV1` is the only
 * call that creates records from nothing (exclusive-create, so a retry after
 * a crash mid-write fails loud with `rejected` rather than silently
 * duplicating); every later transition re-reads the current journal, applies
 * an idempotent short-circuit when already at the target state, and rejects
 * a transition that is not legal from the journal's current state (plan
 * §4.2's "permitted next states"). `commitCreationSentinelV1` additionally
 * tolerates a sentinel file that a crashed earlier attempt already wrote,
 * provided it is byte-identical to what this call would write — anything
 * else is a real conflict, surfaced as `recoveryRequired`, never silently
 * overwritten.
 */
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  computeTaskCreationIntentDigestV1,
  decodeTaskCreationIntentV1,
  decodeTaskCreationJournalV1,
  encodeTaskCreationIntentV1,
  encodeTaskCreationJournalV1,
  encodeTaskCreationSentinelV1,
  isLegalCreationIntentTransitionV1,
  MAX_CREATION_INTENT_FILE_BYTES_V1,
  MAX_CREATION_JOURNAL_FILE_BYTES_V1,
  MAX_CREATION_SENTINEL_FILE_BYTES_V1,
  TaskCreationIntentEntryV1,
  TaskCreationIntentOwnershipClassificationV1,
  TaskCreationIntentStateV1,
  TaskCreationIntentV1,
  TaskCreationJournalV1,
  TaskCreationSentinelV1,
} from "../types/taskCreationIntentV1";
import { WorkflowUnavailableV1 } from "../types/workflowAvailabilityV1";
import { normalizePath } from "../utils/taskRoot";
import { WorkflowFileRevisionV1, WorkflowFileStoreResultV1 } from "./workflowFileStoreV1";
import {
  ensureWorkflowMetaRootV1,
  ensureWorkflowTaskFolderRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
} from "./workflowRuntimeServicesV1";

export type TaskCreationIntentStoreResultV1 =
  | { readonly kind: "ok"; readonly intent: TaskCreationIntentV1; readonly journal: TaskCreationJournalV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "rejected"; readonly reason: string }
  /** Undecodable/corrupt/inconsistent record: read-only, non-resumable — the storage-layer counterpart of a Chat transaction's recoveryRequired. */
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

function rejected(reason: string): TaskCreationIntentStoreResultV1 {
  return { kind: "rejected", reason };
}

function storageFailure(failure: { readonly kind: "failed"; readonly errno?: string }): TaskCreationIntentStoreResultV1 {
  return { kind: "storageFailure", ...(typeof failure.errno === "string" ? { errno: failure.errno } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Idempotent provisioning of one registry-vended directory (mirrors
 * `chatInteractionTransactionStoreV1.ts`'s own `ensureDirectory`): already-
 * exists and created-now both succeed — plan §1.8's nonrecursive `mkdir`
 * means a missing PARENT is still a real failure, so this must be called
 * root-downward, one directory at a time.
 */
async function ensureDirectoryV1(
  result: Promise<WorkflowFileStoreResultV1<void>>
): Promise<TaskCreationIntentStoreResultV1 | undefined> {
  const made = await result;
  if (made.kind === "unavailable") {
    return made;
  }
  if (made.kind === "failed" && made.code !== "targetExists") {
    return storageFailure(made);
  }
  return undefined;
}

/** The digest key shared by a task folder's `intent-<digest>.json`/`journal-<digest>.json` filenames. */
export function taskCreationIntentDigestV1(taskFolderPath: string): string {
  return computeTaskCreationIntentDigestV1(normalizePath(taskFolderPath));
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
  | { readonly kind: "ok"; readonly journal: TaskCreationJournalV1; readonly revision: WorkflowFileRevisionV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

async function loadJournalRecordV1(metaRootId: string, digest: string): Promise<LoadJournalOutcomeV1> {
  const locator = getWorkflowPathRegistryV1().creationJournalFile(metaRootId, digest).locator;
  const read = await getWorkflowFileStoreV1().readFileBounded(locator, MAX_CREATION_JOURNAL_FILE_BYTES_V1);
  if (read.kind === "unavailable") return read;
  if (read.kind === "failed") {
    if (read.code === "targetMissing") return { kind: "missing" };
    return { kind: "storageFailure", ...(read.errno ? { errno: read.errno } : {}) };
  }
  const decoded = decodeTaskCreationJournalV1(read.value.bytes.toString("utf8"));
  if (!decoded.ok) {
    return { kind: "recoveryRequired", reason: `creation journal failed strict decoding: ${decoded.reason}` };
  }
  return { kind: "ok", journal: decoded.journal, revision: read.value.revision };
}

type LoadIntentOutcomeV1 =
  | { readonly kind: "ok"; readonly intent: TaskCreationIntentV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

async function loadIntentRecordV1(metaRootId: string, digest: string): Promise<LoadIntentOutcomeV1> {
  const locator = getWorkflowPathRegistryV1().creationIntentFile(metaRootId, digest).locator;
  const read = await getWorkflowFileStoreV1().readFileBounded(locator, MAX_CREATION_INTENT_FILE_BYTES_V1);
  if (read.kind === "unavailable") return read;
  if (read.kind === "failed") {
    if (read.code === "targetMissing") return { kind: "missing" };
    return { kind: "storageFailure", ...(read.errno ? { errno: read.errno } : {}) };
  }
  const decoded = decodeTaskCreationIntentV1(read.value.bytes.toString("utf8"));
  if (!decoded.ok) {
    return { kind: "recoveryRequired", reason: `creation intent failed strict decoding: ${decoded.reason}` };
  }
  return { kind: "ok", intent: decoded.intent };
}

/**
 * Load the current journal (and its matching immutable intent) for a task
 * folder. Read-only; registers the meta root for read access if not already
 * registered. `missing` is the expected, common result for any folder never
 * tracked by this store (created before it existed, or one whose
 * `recordTaskCreationIntentV1` call never ran/succeeded) — callers (the
 * reconciler) must treat `missing` as "fall back to the legacy classifier",
 * never as an error.
 */
export async function loadTaskCreationJournalV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskCreationIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskCreationIntentDigestV1(taskFolderPath);
  const journalResult = await loadJournalRecordV1(metaRootId, digest);
  if (journalResult.kind !== "ok") {
    return journalResult;
  }
  const intentResult = await loadIntentRecordV1(metaRootId, digest);
  if (intentResult.kind !== "ok") {
    return intentResult.kind === "missing"
      ? { kind: "recoveryRequired", reason: "a creation journal exists with no matching intent record" }
      : intentResult;
  }
  if (normalizePath(intentResult.intent.taskFolderPath) !== normalizePath(taskFolderPath)) {
    return {
      kind: "recoveryRequired",
      reason: "the creation intent's recorded taskFolderPath does not match the folder it was looked up for",
    };
  }
  return { kind: "ok", intent: intentResult.intent, journal: journalResult.journal };
}

export interface RecordTaskCreationIntentInputV1 {
  readonly metaFolderPath: string;
  readonly taskFolderPath: string;
  readonly taskFolderName: string;
  readonly ownership: TaskCreationIntentOwnershipClassificationV1;
}

/**
 * Begin tracking a new task creation: writes the immutable intent record and
 * the journal's first (`intentRecorded`) state, both exclusive-create.
 * Rejects if either already exists for this task folder — a caller that
 * wants to retry an interrupted creation under a DIFFERENT folder identity
 * must pick a fresh `taskFolderPath` (the digest is path-derived), matching
 * `startNewTask.ts`'s own folder-numbering behavior of never reusing a name.
 */
export async function recordTaskCreationIntentV1(
  input: RecordTaskCreationIntentInputV1
): Promise<TaskCreationIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(input.metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskCreationIntentDigestV1(input.taskFolderPath);
  const registry = getWorkflowPathRegistryV1();
  const intentsDirLocator = registry.creationIntentsDir(metaRootId).locator;
  const intentLocator = registry.creationIntentFile(metaRootId, digest).locator;
  const journalLocator = registry.creationJournalFile(metaRootId, digest).locator;
  const fileStore = getWorkflowFileStoreV1();

  const provisionFailure = await ensureDirectoryV1(fileStore.createDirectory(intentsDirLocator));
  if (provisionFailure) {
    return provisionFailure;
  }

  const intentId = allocateHex128IdV1();
  const nowIso = new Date().toISOString();
  const intent: TaskCreationIntentV1 = {
    schemaVersion: 1,
    intentId,
    taskFolderName: input.taskFolderName,
    taskFolderPath: input.taskFolderPath,
    metaFolderPath: input.metaFolderPath,
    ownership: input.ownership,
    createdAt: nowIso,
  };
  const journal: TaskCreationJournalV1 = {
    schemaVersion: 1,
    intentId,
    state: "intentRecorded",
    entries: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    transitions: [{ receiptId: allocateHex128IdV1(), from: null, to: "intentRecorded", at: nowIso }],
  };

  const intentWrite = await fileStore.createFileExclusive(intentLocator, Buffer.from(encodeTaskCreationIntentV1(intent), "utf8"));
  if (intentWrite.kind === "unavailable") return intentWrite;
  if (intentWrite.kind === "failed") {
    if (intentWrite.code === "targetExists") {
      return rejected("a creation intent already exists for this task folder");
    }
    return storageFailure(intentWrite);
  }

  const journalWrite = await fileStore.createFileExclusive(journalLocator, Buffer.from(encodeTaskCreationJournalV1(journal), "utf8"));
  if (journalWrite.kind === "unavailable") return journalWrite;
  if (journalWrite.kind === "failed") {
    if (journalWrite.code === "targetExists") {
      // The intent's exclusive-create above just succeeded, so no earlier
      // caller raced this pair — a pre-existing journal here means a torn
      // write or manual tampering, not a legitimate resume.
      return { kind: "recoveryRequired", reason: "a creation journal already exists without a matching intent write" };
    }
    return storageFailure(journalWrite);
  }
  return { kind: "ok", intent, journal };
}

/**
 * Advance the journal by one legal transition, merging `newEntries` into its
 * recorded entry list. Idempotent when the journal is already at `to` (a
 * crash-resumed retry of the same call): returns the current record without
 * writing again, rather than rejecting on "no self-transition".
 */
async function appendCreationTransitionV1(
  metaFolderPath: string,
  taskFolderPath: string,
  to: TaskCreationIntentStateV1,
  newEntries: readonly TaskCreationIntentEntryV1[]
): Promise<TaskCreationIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskCreationIntentDigestV1(taskFolderPath);
  const journalResult = await loadJournalRecordV1(metaRootId, digest);
  if (journalResult.kind !== "ok") {
    return journalResult;
  }
  const intentResult = await loadIntentRecordV1(metaRootId, digest);
  if (intentResult.kind !== "ok") {
    return intentResult.kind === "missing"
      ? { kind: "recoveryRequired", reason: "a creation journal exists with no matching intent record" }
      : intentResult;
  }
  const { journal: current, revision } = journalResult;
  if (current.state === to) {
    return { kind: "ok", intent: intentResult.intent, journal: current };
  }
  if (!isLegalCreationIntentTransitionV1(current.state, to)) {
    return rejected(`illegal creation-intent transition: ${current.state} -> ${to}`);
  }
  const nowIso = new Date().toISOString();
  const next: TaskCreationJournalV1 = {
    ...current,
    state: to,
    entries: mergeEntryListsV1(current.entries, newEntries),
    updatedAt: nowIso,
    transitions: [...current.transitions, { receiptId: allocateHex128IdV1(), from: current.state, to, at: nowIso }],
  };
  const journalLocator = getWorkflowPathRegistryV1().creationJournalFile(metaRootId, digest).locator;
  const write = await getWorkflowFileStoreV1().replaceFileExact(
    journalLocator,
    Buffer.from(encodeTaskCreationJournalV1(next), "utf8"),
    revision
  );
  if (write.kind === "unavailable") return write;
  if (write.kind === "failed") {
    if (write.code === "revisionMismatch") {
      return rejected("the creation journal changed concurrently; retry the transition");
    }
    return storageFailure(write);
  }
  return { kind: "ok", intent: intentResult.intent, journal: next };
}

/**
 * `intentRecorded -> workMaterialized`: the content that will become this
 * task's files is ready (see the module header's "NON-STAGED INTERPRETATION").
 */
export function recordWorkMaterializedV1(
  metaFolderPath: string,
  taskFolderPath: string,
  entries: readonly TaskCreationIntentEntryV1[] = []
): Promise<TaskCreationIntentStoreResultV1> {
  return appendCreationTransitionV1(metaFolderPath, taskFolderPath, "workMaterialized", entries);
}

/**
 * `workMaterialized -> finalFolderClaimed`: the final task folder now holds
 * the claimed content on disk.
 */
export function recordFinalFolderClaimedV1(
  metaFolderPath: string,
  taskFolderPath: string,
  entries: readonly TaskCreationIntentEntryV1[] = []
): Promise<TaskCreationIntentStoreResultV1> {
  return appendCreationTransitionV1(metaFolderPath, taskFolderPath, "finalFolderClaimed", entries);
}

/**
 * `finalFolderClaimed -> sentinelCommitted`: writes `entries` (merged with
 * whatever the journal already recorded) into the task folder's
 * `.ensemble-creation-sentinel-v1.json` (exclusive-create) and then journals
 * the transition. Crash-resume tolerant: if a prior attempt already wrote a
 * byte-identical sentinel but crashed before the journal transition
 * committed, this call finishes the transition instead of failing on
 * `targetExists`. A sentinel that exists with DIFFERENT content is a real
 * conflict and returns `recoveryRequired`, never silently overwritten.
 */
export async function commitCreationSentinelV1(
  metaFolderPath: string,
  taskFolderPath: string,
  entries: readonly TaskCreationIntentEntryV1[] = []
): Promise<TaskCreationIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskCreationIntentDigestV1(taskFolderPath);
  const journalResult = await loadJournalRecordV1(metaRootId, digest);
  if (journalResult.kind !== "ok") {
    return journalResult;
  }
  const intentResult = await loadIntentRecordV1(metaRootId, digest);
  if (intentResult.kind !== "ok") {
    return intentResult.kind === "missing"
      ? { kind: "recoveryRequired", reason: "a creation journal exists with no matching intent record" }
      : intentResult;
  }
  const { journal: current } = journalResult;
  if (current.state === "sentinelCommitted") {
    return { kind: "ok", intent: intentResult.intent, journal: current };
  }
  if (current.state !== "finalFolderClaimed") {
    return rejected(`illegal creation-intent transition: ${current.state} -> sentinelCommitted`);
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
    intentId: current.intentId,
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
        reason: "a creation sentinel already exists for this task folder and does not match this intent",
      };
    }
  }
  return appendCreationTransitionV1(metaFolderPath, taskFolderPath, "sentinelCommitted", entries);
}

/**
 * `sentinelCommitted -> progressCommitted`: the final task-progress.json write
 * succeeded. `entries` should carry a fresh `fileCreationIntentEntryV1` for
 * `task-progress.json` reflecting its FINAL on-disk bytes (status flipped
 * from `creating` to its real initial value) — `mergeEntryListsV1` replaces
 * the earlier `finalFolderClaimed`-time entry for the same path, so a
 * classifier reading the journal after this transition sees the hash of what
 * is actually on disk, not the transient `creating`-status write.
 */
export function recordProgressCommittedV1(
  metaFolderPath: string,
  taskFolderPath: string,
  entries: readonly TaskCreationIntentEntryV1[] = []
): Promise<TaskCreationIntentStoreResultV1> {
  return appendCreationTransitionV1(metaFolderPath, taskFolderPath, "progressCommitted", entries);
}

/** `progressCommitted -> resolved`: task creation is fully complete. */
export function resolveTaskCreationV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskCreationIntentStoreResultV1> {
  return appendCreationTransitionV1(metaFolderPath, taskFolderPath, "resolved", []);
}

/**
 * Alternate terminal transition from any non-`resolved` state: the folder
 * this creation was tracking was removed by Safe Delete instead of finishing
 * creation (plan §4.6 step 1, "mark source creation/adoption records
 * resolvedDeleted"). `safeDeleteFailedTaskCreation`'s own success path and the
 * stranded-deletion startup sweep are this function's two callers.
 */
export function resolveTaskCreationDeletedV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskCreationIntentStoreResultV1> {
  return appendCreationTransitionV1(metaFolderPath, taskFolderPath, "resolvedDeleted", []);
}
