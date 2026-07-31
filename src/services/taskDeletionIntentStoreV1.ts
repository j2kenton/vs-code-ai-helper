/**
 * Task-creation Safe Delete journal store (plan §4.6).
 *
 * The one writer/reader for `TaskDeletionJournalV1` (see
 * `types/taskDeletionIntentV1.ts`'s module header for the record shape and
 * why it has no separate immutable "intent" file, unlike creation/adoption).
 * Every filesystem operation goes through the shared `WorkflowFileStoreV1`
 * over locators `WorkflowPathRegistryV1` allocates, exactly like
 * `taskCreationIntentStoreV1.ts` and `taskAdoptionIntentStoreV1.ts` — this
 * module holds no path authority of its own.
 *
 * `commands/taskCreationRecovery.ts`'s `safeDeleteFailedTaskCreation` is this
 * store's one production writer: it calls `recordTaskDeletionRequestedV1`
 * BEFORE touching the task folder's files, then `recordFolderRemovedV1` after
 * physically removing them, then `recordExternalStateResolvedV1` after
 * clearing the current-task checkpoint (if it pointed here) and triggering an
 * inventory rescan. `TaskCreationStartupReconcilerV1` is this store's one
 * production reader, so a live (not yet `externalStateResolved`) journal can
 * keep a still-present folder out of the normal Open/Retry/Adopt-and-Retry
 * surface (plan §4.7's `deletionPending` context) instead of racing a
 * half-finished deletion.
 */
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  computeTaskDeletionIntentDigestV1,
  decodeTaskDeletionJournalV1,
  DELETION_JOURNAL_FILE_PREFIX_V1,
  deletionJournalFileNameV1,
  encodeTaskDeletionJournalV1,
  isLegalDeletionTransitionV1,
  MAX_DELETION_JOURNAL_FILE_BYTES_V1,
  TaskDeletionJournalV1,
  TaskDeletionStateV1,
} from "../types/taskDeletionIntentV1";
import { TaskCreationIntentEntryV1, TaskCreationIntentOwnershipClassificationV1 } from "../types/taskCreationIntentV1";
import { WorkflowUnavailableV1 } from "../types/workflowAvailabilityV1";
import { normalizePath } from "../utils/taskRoot";
import { WorkflowFileRevisionV1 } from "./workflowFileStoreV1";
import {
  ensureWorkflowMetaRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
} from "./workflowRuntimeServicesV1";
import { validateWorkflowRelativePathV1 } from "./workflowPathSafetyV1";
import { CREATION_INTENTS_DIRNAME_V1 } from "./workflowPrivacyClassifierV1";

/**
 * Stranded-deletion sweep listing ceiling — mirrors
 * `chatInteractionTransactionStoreV1.ts`'s `MAX_SWEEP_DIRECTORY_ENTRIES_V1`:
 * far beyond any plausible number of in-flight deletions, and the bounded
 * listing fails closed (sweep reports nothing this pass) rather than
 * truncating if it is ever exceeded.
 */
const MAX_DELETION_SWEEP_DIRECTORY_ENTRIES_V1 = 65536;

export type TaskDeletionIntentStoreResultV1 =
  | { readonly kind: "ok"; readonly journal: TaskDeletionJournalV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1;

function rejected(reason: string): TaskDeletionIntentStoreResultV1 {
  return { kind: "rejected", reason };
}

function storageFailure(failure: { readonly kind: "failed"; readonly errno?: string }): TaskDeletionIntentStoreResultV1 {
  return { kind: "storageFailure", ...(typeof failure.errno === "string" ? { errno: failure.errno } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The digest key shared by a task folder's `delete-<digest>.json` filename. */
export function taskDeletionIntentDigestV1(taskFolderPath: string): string {
  return computeTaskDeletionIntentDigestV1(normalizePath(taskFolderPath));
}

/**
 * `creationIntentsDir`'s sibling file — the registry has no dedicated
 * `deletionJournalFile` allocator (plan §2.1 keeps allocation narrow and
 * named-family), so this store builds the same
 * `creation-intents-v1/delete-<digest>.json` relative path the plan specifies
 * and runs it through the same `validateWorkflowRelativePathV1` shape gate
 * every registry allocation uses, rather than trusting an ad hoc string.
 */
function deletionJournalLocator(metaRootId: string, digest: string): { rootId: string; relativePath: string } {
  const relativePath = `${CREATION_INTENTS_DIRNAME_V1}/${deletionJournalFileNameV1(digest)}`;
  const validated = validateWorkflowRelativePathV1(relativePath);
  if (!validated.ok) {
    throw new Error(`Internal allocation produced an invalid locator: ${validated.reason}.`);
  }
  return { rootId: metaRootId, relativePath };
}

async function loadDeletionJournalRecordV1(
  metaRootId: string,
  digest: string
): Promise<
  | { readonly kind: "ok"; readonly journal: TaskDeletionJournalV1; readonly revision: WorkflowFileRevisionV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | WorkflowUnavailableV1
> {
  const locator = deletionJournalLocator(metaRootId, digest);
  const read = await getWorkflowFileStoreV1().readFileBounded(locator, MAX_DELETION_JOURNAL_FILE_BYTES_V1);
  if (read.kind === "unavailable") return read;
  if (read.kind === "failed") {
    if (read.code === "targetMissing") return { kind: "missing" };
    return { kind: "storageFailure", ...(read.errno ? { errno: read.errno } : {}) };
  }
  const decoded = decodeTaskDeletionJournalV1(read.value.bytes.toString("utf8"));
  if (!decoded.ok) {
    return { kind: "recoveryRequired", reason: `deletion journal failed strict decoding: ${decoded.reason}` };
  }
  return { kind: "ok", journal: decoded.journal, revision: read.value.revision };
}

/**
 * Read-only lookup for one task folder's deletion journal. `missing` is the
 * expected, common result for any folder never subject to Safe Delete —
 * callers (the classifier) must treat it as "no deletion in flight", never as
 * an error.
 */
export async function loadTaskDeletionJournalV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskDeletionIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskDeletionIntentDigestV1(taskFolderPath);
  return loadDeletionJournalRecordV1(metaRootId, digest);
}

export interface RecordTaskDeletionRequestedInputV1 {
  readonly metaFolderPath: string;
  readonly taskFolderPath: string;
  readonly taskFolderName: string;
  readonly ownership: TaskCreationIntentOwnershipClassificationV1;
  readonly sourceIntentIds: readonly string[];
  readonly confirmationReceiptId: string;
  readonly entries: readonly TaskCreationIntentEntryV1[];
  readonly currentTaskCheckpointObserved: boolean;
}

/**
 * Begins tracking a Safe Delete: writes the journal's first
 * (`deleteRequested`) state, exclusive-create, BEFORE any file on disk is
 * touched. Rejects if a deletion journal already exists for this task folder
 * — a caller must resume the existing journal (`loadTaskDeletionJournalV1`)
 * rather than starting a second, conflicting one.
 */
export async function recordTaskDeletionRequestedV1(
  input: RecordTaskDeletionRequestedInputV1
): Promise<TaskDeletionIntentStoreResultV1> {
  if (input.entries.some((entry) => entry.entryClass === "preservedUser")) {
    return rejected('a deletion journal must never carry a "preservedUser" entry');
  }
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(input.metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskDeletionIntentDigestV1(input.taskFolderPath);
  const registry = getWorkflowPathRegistryV1();
  const intentsDirLocator = registry.creationIntentsDir(metaRootId).locator;
  const journalLocator = deletionJournalLocator(metaRootId, digest);
  const fileStore = getWorkflowFileStoreV1();

  const provisioned = await fileStore.createDirectory(intentsDirLocator);
  if (provisioned.kind === "unavailable") return provisioned;
  if (provisioned.kind === "failed" && provisioned.code !== "targetExists") {
    return storageFailure(provisioned);
  }

  const deletionId = allocateHex128IdV1();
  const nowIso = new Date().toISOString();
  const journal: TaskDeletionJournalV1 = {
    schemaVersion: 1,
    deletionId,
    taskFolderName: input.taskFolderName,
    taskFolderPath: input.taskFolderPath,
    metaFolderPath: input.metaFolderPath,
    ownership: input.ownership,
    sourceIntentIds: input.sourceIntentIds,
    confirmationReceiptId: input.confirmationReceiptId,
    entries: input.entries,
    currentTaskCheckpointObserved: input.currentTaskCheckpointObserved,
    inventoryScanObserved: false,
    state: "deleteRequested",
    createdAt: nowIso,
    updatedAt: nowIso,
    transitions: [{ receiptId: allocateHex128IdV1(), from: null, to: "deleteRequested", at: nowIso }],
  };

  const write = await fileStore.createFileExclusive(journalLocator, Buffer.from(encodeTaskDeletionJournalV1(journal), "utf8"));
  if (write.kind === "unavailable") return write;
  if (write.kind === "failed") {
    if (write.code === "targetExists") {
      return rejected("a deletion journal already exists for this task folder");
    }
    return storageFailure(write);
  }
  return { kind: "ok", journal };
}

async function appendDeletionTransitionV1(
  metaFolderPath: string,
  taskFolderPath: string,
  to: TaskDeletionStateV1,
  patch: Partial<Pick<TaskDeletionJournalV1, "inventoryScanObserved">> = {}
): Promise<TaskDeletionIntentStoreResultV1> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch (error) {
    return rejected(errorMessage(error));
  }
  const digest = taskDeletionIntentDigestV1(taskFolderPath);
  const loaded = await loadDeletionJournalRecordV1(metaRootId, digest);
  if (loaded.kind !== "ok") {
    return loaded;
  }
  const { journal: current, revision } = loaded;
  if (current.state === to) {
    return { kind: "ok", journal: current };
  }
  if (!isLegalDeletionTransitionV1(current.state, to)) {
    return rejected(`illegal deletion transition: ${current.state} -> ${to}`);
  }
  const nowIso = new Date().toISOString();
  const next: TaskDeletionJournalV1 = {
    ...current,
    ...patch,
    state: to,
    updatedAt: nowIso,
    transitions: [...current.transitions, { receiptId: allocateHex128IdV1(), from: current.state, to, at: nowIso }],
  };
  const journalLocator = deletionJournalLocator(metaRootId, digest);
  const write = await getWorkflowFileStoreV1().replaceFileExact(
    journalLocator,
    Buffer.from(encodeTaskDeletionJournalV1(next), "utf8"),
    revision
  );
  if (write.kind === "unavailable") return write;
  if (write.kind === "failed") {
    if (write.code === "revisionMismatch") {
      return rejected("the deletion journal changed concurrently; retry the transition");
    }
    return storageFailure(write);
  }
  return { kind: "ok", journal: next };
}

/** `deleteRequested -> folderRemoved`: every entry has been physically removed from disk. */
export function recordFolderRemovedV1(
  metaFolderPath: string,
  taskFolderPath: string
): Promise<TaskDeletionIntentStoreResultV1> {
  return appendDeletionTransitionV1(metaFolderPath, taskFolderPath, "folderRemoved");
}

/**
 * `folderRemoved -> externalStateResolved`: the current-task checkpoint has
 * been cleared (if it pointed at this folder) and a tree refresh triggered.
 * `inventoryScanObserved` records that the audit-only rescan actually ran —
 * see `types/taskDeletionIntentV1.ts`'s module header ("no durable inventory
 * entry exists to delete").
 */
export function recordExternalStateResolvedV1(
  metaFolderPath: string,
  taskFolderPath: string,
  inventoryScanObserved: boolean
): Promise<TaskDeletionIntentStoreResultV1> {
  return appendDeletionTransitionV1(metaFolderPath, taskFolderPath, "externalStateResolved", { inventoryScanObserved });
}

export interface StrandedTaskDeletionJournalV1 {
  readonly taskFolderPath: string;
  readonly journal: TaskDeletionJournalV1;
}

/**
 * Lists every deletion journal directly under one meta root's
 * `creation-intents-v1/` directory that is stuck at `folderRemoved` — its
 * task folder was already physically removed but the journal never reached
 * `externalStateResolved`, most likely because the extension host was
 * interrupted between the two (plan §4.1 startup step 1: "Resume verified
 * Safe Delete journals/tombstones"; AC-CREATE-DELETE-02's "a crash after
 * folder removal must resume cleanup"). `TaskCreationStartupReconcilerV1`'s
 * own scan only walks folders that still exist on disk, so it can never find
 * one of these on its own — this is the independent, path-free sweep that
 * does, read-only and safe to call repeatedly.
 */
export async function listStrandedTaskDeletionJournalsV1(
  metaFolderPath: string
): Promise<readonly StrandedTaskDeletionJournalV1[]> {
  let metaRootId: string;
  try {
    metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
  } catch {
    return [];
  }
  const registry = getWorkflowPathRegistryV1();
  const intentsDirLocator = registry.creationIntentsDir(metaRootId).locator;
  const fileStore = getWorkflowFileStoreV1();
  const listed = await fileStore.listDirectoryBounded(intentsDirLocator, MAX_DELETION_SWEEP_DIRECTORY_ENTRIES_V1);
  if (listed.kind !== "ok") {
    // No intents directory yet, an unsupported root, or an over-limit
    // listing: nothing to report this pass (fail-open-to-empty, the same
    // stance chatInteractionTransactionStoreV1.ts's own sweeps take).
    return [];
  }
  const stranded: StrandedTaskDeletionJournalV1[] = [];
  for (const entry of listed.value) {
    if (
      entry.kind !== "file" ||
      !entry.name.startsWith(DELETION_JOURNAL_FILE_PREFIX_V1) ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }
    const relativePath = `${CREATION_INTENTS_DIRNAME_V1}/${entry.name}`;
    const validated = validateWorkflowRelativePathV1(relativePath);
    if (!validated.ok) {
      continue;
    }
    const read = await fileStore.readFileBounded(
      { rootId: metaRootId, relativePath },
      MAX_DELETION_JOURNAL_FILE_BYTES_V1
    );
    if (read.kind !== "ok") {
      continue;
    }
    const decoded = decodeTaskDeletionJournalV1(read.value.bytes.toString("utf8"));
    if (!decoded.ok || decoded.journal.state !== "folderRemoved") {
      continue;
    }
    stranded.push({ taskFolderPath: decoded.journal.taskFolderPath, journal: decoded.journal });
  }
  return stranded;
}
