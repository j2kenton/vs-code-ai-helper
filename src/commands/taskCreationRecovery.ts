import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import { TASK_FILENAME, TASK_PROGRESS_FILENAME, TaskStatus } from "../types/taskProgress";
import { createTaskProgress, writeTaskProgress } from "../utils/taskProgressUtils";
import { IncompleteTask } from "../types/incompleteTask";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { normalizePath } from "../utils/taskRoot";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { withAllMetaRootsLock } from "../state/taskStateStore";
import { safeOpenTextDocument, statIfExists } from "../utils/fileUtils";
import { runTrackedOperation } from "../utils/taskOperations";
import { ensureAutomaticMetaGitIgnore } from "./toggleMetaResourcesGitIgnore";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  commitCreationSentinelV1,
  loadTaskCreationJournalV1,
  recordFinalFolderClaimedV1,
  recordProgressCommittedV1,
  resolveTaskCreationDeletedV1,
  resolveTaskCreationV1,
} from "../services/taskCreationIntentStoreV1";
import {
  fileCreationIntentEntryV1,
  TaskCreationIntentEntryV1,
  TaskCreationIntentOwnershipClassificationV1,
} from "../types/taskCreationIntentV1";
import {
  commitAdoptionSentinelV1,
  loadTaskAdoptionJournalV1,
  recordTaskAdoptionIntentV1,
  resolveTaskAdoptionDeletedV1,
  resolveTaskAdoptionV1,
} from "../services/taskAdoptionIntentStoreV1";
import {
  listStrandedTaskDeletionJournalsV1,
  recordExternalStateResolvedV1,
  recordFolderRemovedV1,
  recordTaskDeletionRequestedV1,
  TaskDeletionIntentStoreResultV1,
} from "../services/taskDeletionIntentStoreV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { CREATION_SENTINEL_FILENAME_V1 } from "../services/workflowPrivacyClassifierV1";
import {
  allMetaRootPaths,
  hasActiveTaskOnDisk,
  journalCreationStep,
  loadTaskTemplate,
  tryReadCreatedFileEntryV1,
} from "./startNewTask";

/**
 * Recovery commands for a `status: "creating"` task row (plan §§4.4-4.7).
 * `TaskNode` (taskTreeProvider.ts) passes itself as the sole argument — it
 * carries `task: IncompleteTask`, mirroring the `PinTaskArg`/`ArchiveTaskArg`
 * convention every other tree-context-menu command already uses.
 *
 * Coverage this round:
 *  - Open (§4.5): always safe, no adoption or mutation, works for every
 *    footprint class.
 *  - Retry (§4.5): only the "verified V1 journal" branch — a
 *    `retryWithoutAdoptionEligible` footprint (see
 *    `types/taskCreationRecoveryV1.ts`'s doc comment).
 *  - Adopt-and-Retry (§§4.4/4.5): only `preservable` — records the folder's
 *    existing `task.md` as `preservedUser` (never overwritten) and its
 *    `task-progress.json` as `createdV1`, then finishes creation exactly like
 *    Retry's tail.
 *  - Safe Delete (§4.6): only `retryWithoutAdoptionEligible` folders (whose
 *    creation journal already proves every entry is `createdV1`) and
 *    `preservable` folders (adopted-for-deletion first, classifying
 *    `task.md` `adoptedLegacy` instead of `preservedUser` — see
 *    `TaskAdoptionActionV1`). `reconstructible`/`pristine` folders with no
 *    verified journal, and every `inspectionOnly` folder, get Open only —
 *    the non-journal "Retry with adoption"/"Safe Delete after adoption"
 *    paths in plan §4.3's table remain unimplemented.
 */
export interface TaskCreationRecoveryArg {
  task?: IncompleteTask;
}

function normalizeRecoveryArg(arg: TaskCreationRecoveryArg | undefined): IncompleteTask | undefined {
  return arg && "task" in arg ? arg.task : undefined;
}

/**
 * Opens `task.md` if the interrupted creation got far enough to write it,
 * otherwise reveals the (mostly empty) task folder. Never mutates anything —
 * plan §4.5's "Open performs no adoption or ownership mutation."
 */
export async function openFailedTaskCreation(arg?: TaskCreationRecoveryArg): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const task = normalizeRecoveryArg(arg);
  if (!task) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }

  const taskFileUri = vscode.Uri.joinPath(task.folderUri, TASK_FILENAME);
  const taskFileStat = await statIfExists(taskFileUri);
  if (taskFileStat) {
    await safeOpenTextDocument(taskFileUri, TASK_FILENAME);
    return;
  }
  try {
    await vscode.commands.executeCommand("revealInExplorer", task.folderUri);
  } catch {
    NotificationRouter.showInformation(`${task.folderName}: ${task.folderUri.fsPath}`);
  }
}

/**
 * Resumes an interrupted creation for a folder whose own §4.2 journal has
 * cryptographically verified nothing but this extension's own writes are
 * present (plan §4.5's "accepts only a verified V1 journal" branch of
 * Retry). Deliberately duplicates (rather than refactors to share)
 * `startNewTask.ts`'s `createTask` tail — see that function's neighboring
 * exports — instead of changing the already-shipping fresh-creation path to
 * be parameterized for reuse here; the two must be kept in lockstep by
 * inspection, the same accepted pattern `taskCreationSeedHistoryV1.ts`
 * documents for the template/seed byte-match.
 *
 * Reclassifies and re-verifies immediately before writing anything (the
 * folder may have changed since the row calling this was rendered) and
 * refuses — never overwrites — if the folder no longer qualifies.
 */
export async function retryTaskCreation(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore,
  context: vscode.ExtensionContext | undefined,
  arg?: TaskCreationRecoveryArg
): Promise<boolean> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const task = normalizeRecoveryArg(arg);
  if (!task) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return false;
  }

  const taskFolderPath = task.folderUri.fsPath;
  const taskFolderName = task.folderName;
  const metaFolderPath = path.dirname(taskFolderPath);
  const taskFolderUri = task.folderUri;
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);

  const confirmation = await vscode.window.showWarningMessage(
    `Retry creating "${taskFolderName}"? This writes task.md and marks the task ready to use.`,
    { modal: true },
    "Retry"
  );
  if (confirmation !== "Retry") {
    return false;
  }

  try {
    const result = await runTrackedOperation(
      taskFolderPath,
      { label: "Retry Task Creation", taskName: taskFolderName, kind: "create-task" },
      async (op) => {
        const metaFolderPaths = allMetaRootPaths(metaFolderPath);
        const outcome = await withAllMetaRootsLock(metaFolderPaths, async () => {
          // Reclassify and re-verify immediately before mutating (plan §4.4's
          // "reclassify and revalidate immediately before" pattern) — the
          // folder may have changed since this row was rendered.
          const currentFootprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(
            metaFolderPath,
            extensionUri
          );
          const fresh = currentFootprints.find(
            (f) => normalizePath(f.taskFolderPath) === normalizePath(taskFolderPath)
          );
          if (!fresh || !fresh.retryWithoutAdoptionEligible) {
            return { ok: false as const };
          }

          const journalResult = await loadTaskCreationJournalV1(metaFolderPath, taskFolderPath);
          if (journalResult.kind !== "ok") {
            return { ok: false as const };
          }
          const ownershipIntent = journalResult.intent.ownership;

          const initialStatus: TaskStatus = (await hasActiveTaskOnDisk(metaFolderPaths))
            ? "paused"
            : "active";

          const taskTemplate = await loadTaskTemplate(extensionUri);
          const ownership = {
            metaRoot: path.resolve(ownershipIntent.metaRoot),
            projectRoot: path.resolve(ownershipIntent.projectRoot),
            workspaceRoot: path.resolve(ownershipIntent.workspaceRoot),
            boundAt: new Date().toISOString(),
            state: "resolved" as const,
          };

          // A `retryWithoutAdoptionEligible` folder always has an existing,
          // journal-verified task-progress.json on disk (that is how it
          // reached "creating" scope at all) -- preserve its original
          // createdAt instead of restamping it with "now" (plan §3.11's
          // progress-field policy: "Validate and preserve").
          const existingProgressResult = await readTaskProgressStrictV1(taskFolderUri, {
            expectedTaskFolder: taskFolderName,
          });
          const existingCreatedAt = existingProgressResult.ok
            ? existingProgressResult.decoded.progress.createdAt
            : undefined;
          const progress = {
            ...createTaskProgress(taskFolderName, "desc"),
            ...(existingCreatedAt ? { createdAt: existingCreatedAt } : {}),
            displayName: taskFolderName,
            nameIsDefault: true,
            ownership,
          };
          await writeTaskProgress(taskFolderUri, progress);
          // "Never overwrites an existing entry" (plan §4.5): `fresh` can be
          // retryWithoutAdoptionEligible with task.md ALREADY present — the
          // journal-verified branch also covers a folder that reached
          // finalFolderClaimed (task.md hash-verified) but crashed before
          // resolveTaskCreationV1. Only write task.md when it is genuinely
          // absent; an already-verified task.md is left untouched.
          if (!fresh.hasTaskMd) {
            await vscode.workspace.fs.writeFile(taskFileUri, new TextEncoder().encode(taskTemplate));
          }

          const [progressEntry, taskMdEntry] = await Promise.all([
            tryReadCreatedFileEntryV1(
              vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME),
              TASK_PROGRESS_FILENAME,
              taskFolderName
            ),
            tryReadCreatedFileEntryV1(taskFileUri, TASK_FILENAME, taskFolderName),
          ]);
          const createdEntries: TaskCreationIntentEntryV1[] = [progressEntry, taskMdEntry].filter(
            (entry): entry is TaskCreationIntentEntryV1 => entry !== undefined
          );
          await journalCreationStep("recordFinalFolderClaimed", taskFolderName, () =>
            recordFinalFolderClaimedV1(metaFolderPath, taskFolderPath, createdEntries)
          );
          await journalCreationStep("commitCreationSentinel", taskFolderName, () =>
            commitCreationSentinelV1(metaFolderPath, taskFolderPath)
          );

          await writeTaskProgress(taskFolderUri, { ...progress, status: initialStatus });
          const finalProgressEntry = await tryReadCreatedFileEntryV1(
            vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME),
            TASK_PROGRESS_FILENAME,
            taskFolderName
          );
          await journalCreationStep("recordProgressCommitted", taskFolderName, () =>
            recordProgressCommittedV1(metaFolderPath, taskFolderPath, finalProgressEntry ? [finalProgressEntry] : [])
          );

          return { ok: true as const, initialStatus, workspaceRoot: ownership.workspaceRoot };
        });

        if (!outcome.ok) {
          NotificationRouter.showWarning(
            `${taskFolderName} could not be retried automatically — its state changed since this row was shown. Refresh and use Open instead.`
          );
          return false;
        }

        await journalCreationStep("resolveTaskCreation", taskFolderName, () =>
          resolveTaskCreationV1(metaFolderPath, taskFolderPath)
        );

        if (context) {
          const owningWorkspace = (vscode.workspace.workspaceFolders ?? []).find(
            (ws) => normalizePath(ws.uri.fsPath) === normalizePath(outcome.workspaceRoot)
          );
          if (owningWorkspace) {
            try {
              await ensureAutomaticMetaGitIgnore(context, owningWorkspace);
            } catch (err) {
              console.error("Automatic meta .gitignore maintenance failed", err);
            }
          }
        }

        await inventory.refresh();

        if (outcome.initialStatus === "active") {
          await currentTaskStore.set(normalizePath(taskFolderPath));
          NotificationRouter.showInformation(`${taskFolderName} creation resumed and set as the active task.`);
        } else {
          NotificationRouter.showWarning(
            "Task creation resumed in paused state.",
            undefined,
            undefined,
            undefined,
            {
              command: "vs-code-ai-helper.resumeTask",
              title: "Resume",
              args: [{ taskFolderPath }],
            }
          );
        }

        op.report(taskFolderName);
        await safeOpenTextDocument(taskFileUri, TASK_FILENAME);
        return true;
      }
    );
    return result ?? false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(`Failed to retry task creation: ${message}`);
    return false;
  }
}

/**
 * Best-effort deletion-journal bookkeeping, sibling to `startNewTask.ts`'s
 * `journalCreationStep` but typed for `TaskDeletionIntentStoreResultV1` — a
 * failure here must never abort a deletion already committed to disk (the
 * journal is provenance, not the source of truth for what got removed).
 */
async function journalDeletionStep(
  stepLabel: string,
  taskFolderName: string,
  run: () => Promise<TaskDeletionIntentStoreResultV1>
): Promise<void> {
  try {
    const result = await run();
    if (result.kind !== "ok") {
      console.error(`Task deletion journal step "${stepLabel}" for "${taskFolderName}" did not succeed: ${result.kind}`);
    }
  } catch (error) {
    console.error(`Task deletion journal step "${stepLabel}" for "${taskFolderName}" threw`, error);
  }
}

/**
 * Marks whichever source record `buildSafeDeleteEntriesV1` authorized this
 * deletion from — the creation journal for a `retryWithoutAdoptionEligible`
 * folder, or the adoption journal a `preservable` folder's deletion first
 * created — as `resolvedDeleted` (plan §4.6 step 1). Best-effort like
 * `journalDeletionStep`: the physical deletion is already committed by the
 * time this runs, so a failure here must never surface as a deletion
 * failure. Shared by `safeDeleteFailedTaskCreation`'s own success path and
 * `resumeStrandedTaskDeletionsV1`'s crash-recovery sweep.
 */
async function markSourceCreationRecordsResolvedDeletedV1(
  metaFolderPath: string,
  taskFolderPath: string,
  footprint: { readonly footprintClass: string; readonly retryWithoutAdoptionEligible: boolean },
  taskFolderName: string
): Promise<void> {
  try {
    if (footprint.retryWithoutAdoptionEligible) {
      const result = await resolveTaskCreationDeletedV1(metaFolderPath, taskFolderPath);
      if (result.kind !== "ok") {
        console.error(
          `Marking the creation record resolvedDeleted for "${taskFolderName}" did not succeed: ${result.kind}`
        );
      }
    } else if (footprint.footprintClass === "preservable") {
      const result = await resolveTaskAdoptionDeletedV1(metaFolderPath, taskFolderPath);
      if (result.kind !== "ok") {
        console.error(
          `Marking the adoption record resolvedDeleted for "${taskFolderName}" did not succeed: ${result.kind}`
        );
      }
    }
  } catch (error) {
    console.error(`Marking source creation/adoption records resolvedDeleted for "${taskFolderName}" threw`, error);
  }
}

/**
 * Reads back `relativePath`'s current on-disk bytes (if present) and builds
 * its journal/sentinel entry with `entryClass`. Sibling to
 * `startNewTask.ts`'s `tryReadCreatedFileEntryV1`, but returns `undefined`
 * silently for an absent file (never logs) — used where "this file doesn't
 * exist" is an expected, common outcome (e.g. `task.md` for a
 * `reconstructible` folder), not a swallowed error.
 */
async function tryReadEntryIfPresentV1(
  fileUri: vscode.Uri,
  relativePath: string,
  entryClass: TaskCreationIntentEntryV1["entryClass"]
): Promise<TaskCreationIntentEntryV1 | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    return fileCreationIntentEntryV1(relativePath, entryClass, bytes);
  } catch {
    return undefined;
  }
}

/**
 * Resumes an interrupted creation for a `preservable` folder (plan §§4.4/4.5)
 * by adopting its existing `task.md` as `preservedUser` — recorded, verified,
 * and NEVER overwritten — then finishing creation exactly like Retry's tail.
 * Unlike `retryTaskCreation`, there is no prior §4.2 creation journal to
 * resume from (a journal-tracked folder is always `reconstructible`, never
 * `preservable`); adoption is this folder's first durable record.
 */
export async function adoptAndRetryTaskCreation(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore,
  context: vscode.ExtensionContext | undefined,
  arg?: TaskCreationRecoveryArg
): Promise<boolean> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const task = normalizeRecoveryArg(arg);
  if (!task) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return false;
  }

  const taskFolderPath = task.folderUri.fsPath;
  const taskFolderName = task.folderName;
  const metaFolderPath = path.dirname(taskFolderPath);
  const taskFolderUri = task.folderUri;
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);

  const confirmation = await vscode.window.showWarningMessage(
    `Adopt and retry creating "${taskFolderName}"? Your existing task.md will be preserved exactly as-is and the task marked ready to use.`,
    { modal: true },
    "Adopt and Retry"
  );
  if (confirmation !== "Adopt and Retry") {
    return false;
  }
  const confirmationReceiptId = allocateHex128IdV1();

  try {
    const result = await runTrackedOperation(
      taskFolderPath,
      { label: "Adopt and Retry Task Creation", taskName: taskFolderName, kind: "create-task" },
      async (op) => {
        const metaFolderPaths = allMetaRootPaths(metaFolderPath);
        const outcome = await withAllMetaRootsLock(metaFolderPaths, async () => {
          // Reclassify and re-verify immediately before mutating (plan §4.4)
          // — the folder may have changed since this row was rendered.
          const currentFootprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(
            metaFolderPath,
            extensionUri
          );
          const fresh = currentFootprints.find(
            (f) => normalizePath(f.taskFolderPath) === normalizePath(taskFolderPath)
          );
          if (!fresh || fresh.footprintClass !== "preservable" || fresh.deletionPending) {
            return { ok: false as const };
          }

          // `fresh` was just classified via the strict reader
          // (getClassifiedFootprints), so re-reading through it here too
          // (rather than the permissive fallback) can never diverge from the
          // classification this branch already relied on (plan §3.12).
          const progressResult = await readTaskProgressStrictV1(taskFolderUri, {
            expectedTaskFolder: taskFolderName,
          });
          if (!progressResult.ok) {
            return { ok: false as const };
          }
          const progress = progressResult.decoded.progress;
          if (!progress.ownership) {
            return { ok: false as const };
          }
          const ownership: TaskCreationIntentOwnershipClassificationV1 = {
            metaRoot: path.resolve(progress.ownership.metaRoot),
            projectRoot: path.resolve(progress.ownership.projectRoot),
            workspaceRoot: path.resolve(progress.ownership.workspaceRoot ?? progress.ownership.projectRoot),
          };

          const progressEntry = await tryReadEntryIfPresentV1(
            vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME),
            TASK_PROGRESS_FILENAME,
            "createdV1"
          );
          const taskMdEntry = await tryReadEntryIfPresentV1(taskFileUri, TASK_FILENAME, "preservedUser");
          if (!progressEntry || !taskMdEntry) {
            // preservable REQUIRES task.md to be present; a missing progress
            // file would already have failed the fresh reclassification above.
            return { ok: false as const };
          }
          const entries = [progressEntry, taskMdEntry];
          const entriesDigestSource = Buffer.from(JSON.stringify(entries), "utf8");
          const sha256 = createHash("sha256").update(entriesDigestSource).digest("hex");

          const adoptionResult = await recordTaskAdoptionIntentV1({
            metaFolderPath,
            taskFolderPath,
            taskFolderName,
            ownership,
            historicalProgressFamily: "v1",
            requestedAction: "retry",
            confirmationReceiptId,
            expectedSentinelSha256: sha256,
            expectedSentinelSizeBytes: entriesDigestSource.byteLength,
            entries,
          });
          if (adoptionResult.kind !== "ok") {
            return { ok: false as const };
          }
          const sentinelResult = await commitAdoptionSentinelV1(metaFolderPath, taskFolderPath);
          if (sentinelResult.kind !== "ok") {
            return { ok: false as const };
          }

          const initialStatus: TaskStatus = (await hasActiveTaskOnDisk(metaFolderPaths))
            ? "paused"
            : "active";
          // task.md is left completely untouched — only task-progress.json is
          // rewritten, exactly like Retry's tail (plan §4.5: "never replaces
          // task.md").
          await writeTaskProgress(taskFolderUri, { ...progress, status: initialStatus });

          return { ok: true as const, initialStatus, workspaceRoot: ownership.workspaceRoot };
        });

        if (!outcome.ok) {
          NotificationRouter.showWarning(
            `${taskFolderName} could not be adopted automatically — its state changed since this row was shown. Refresh and use Open instead.`
          );
          return false;
        }

        await journalCreationStep("resolveTaskAdoption", taskFolderName, () =>
          resolveTaskAdoptionV1(metaFolderPath, taskFolderPath)
        );

        if (context) {
          const owningWorkspace = (vscode.workspace.workspaceFolders ?? []).find(
            (ws) => normalizePath(ws.uri.fsPath) === normalizePath(outcome.workspaceRoot)
          );
          if (owningWorkspace) {
            try {
              await ensureAutomaticMetaGitIgnore(context, owningWorkspace);
            } catch (err) {
              console.error("Automatic meta .gitignore maintenance failed", err);
            }
          }
        }

        await inventory.refresh();

        if (outcome.initialStatus === "active") {
          await currentTaskStore.set(normalizePath(taskFolderPath));
          NotificationRouter.showInformation(`${taskFolderName} creation resumed (task.md preserved) and set as the active task.`);
        } else {
          NotificationRouter.showWarning(
            "Task creation resumed in paused state; task.md preserved.",
            undefined,
            undefined,
            undefined,
            {
              command: "vs-code-ai-helper.resumeTask",
              title: "Resume",
              args: [{ taskFolderPath }],
            }
          );
        }

        op.report(taskFolderName);
        await safeOpenTextDocument(taskFileUri, TASK_FILENAME);
        return true;
      }
    );
    return result ?? false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(`Failed to adopt and retry task creation: ${message}`);
    return false;
  }
}

/**
 * Builds this folder's Safe Delete entries and the source journal's
 * `intentId`(s) — the two branches plan §4.6 needs to authorize deletion:
 *
 *  - `retryWithoutAdoptionEligible` (`v1Recoverable`): the creation journal
 *    already cryptographically proves every entry it recorded is `createdV1`
 *    — reused directly, with no separate adoption step.
 *  - `preservable`: no creation journal exists, so this first adopts the
 *    folder FOR DELETION (`requestedAction: "safeDelete"`), which classifies
 *    `task.md` `adoptedLegacy` (eligible for removal) rather than
 *    `preservedUser` — the opposite of `adoptAndRetryTaskCreation`'s
 *    classification for the identical bytes.
 *
 * Either way, the current on-disk sentinel file (if committed by either
 * path) is appended as its own `createdV1` entry — neither store's journal
 * tracks the sentinel it writes as one of its own `entries`.
 */
async function buildSafeDeleteEntriesV1(
  metaFolderPath: string,
  taskFolderPath: string,
  taskFolderUri: vscode.Uri,
  taskFolderName: string,
  footprint: { readonly footprintClass: string; readonly retryWithoutAdoptionEligible: boolean },
  ownership: TaskCreationIntentOwnershipClassificationV1,
  confirmationReceiptId: string
): Promise<{ readonly entries: TaskCreationIntentEntryV1[]; readonly sourceIntentIds: string[] } | undefined> {
  let sourceIntentIds: string[];
  if (footprint.retryWithoutAdoptionEligible) {
    const journalResult = await loadTaskCreationJournalV1(metaFolderPath, taskFolderPath);
    if (journalResult.kind !== "ok") {
      return undefined;
    }
    sourceIntentIds = [journalResult.intent.intentId];
  } else if (footprint.footprintClass === "preservable") {
    const progressEntry = await tryReadEntryIfPresentV1(
      vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME),
      TASK_PROGRESS_FILENAME,
      "createdV1"
    );
    const taskMdEntry = await tryReadEntryIfPresentV1(
      vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME),
      TASK_FILENAME,
      "adoptedLegacy"
    );
    if (!progressEntry || !taskMdEntry) {
      return undefined;
    }
    const entries = [progressEntry, taskMdEntry];
    const entriesDigestSource = Buffer.from(JSON.stringify(entries), "utf8");
    const sha256 = createHash("sha256").update(entriesDigestSource).digest("hex");
    const adoptionResult = await recordTaskAdoptionIntentV1({
      metaFolderPath,
      taskFolderPath,
      taskFolderName,
      ownership,
      historicalProgressFamily: "v1",
      requestedAction: "safeDelete",
      confirmationReceiptId,
      expectedSentinelSha256: sha256,
      expectedSentinelSizeBytes: entriesDigestSource.byteLength,
      entries,
    });
    if (adoptionResult.kind !== "ok") {
      return undefined;
    }
    const sentinelResult = await commitAdoptionSentinelV1(metaFolderPath, taskFolderPath);
    if (sentinelResult.kind !== "ok") {
      return undefined;
    }
    await resolveTaskAdoptionV1(metaFolderPath, taskFolderPath);
    sourceIntentIds = [adoptionResult.intent.intentId];
  } else {
    return undefined;
  }

  const progressEntry = await tryReadEntryIfPresentV1(
    vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME),
    TASK_PROGRESS_FILENAME,
    "createdV1"
  );
  const taskMdEntry = await tryReadEntryIfPresentV1(
    vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME),
    TASK_FILENAME,
    footprint.footprintClass === "preservable" ? "adoptedLegacy" : "createdV1"
  );
  const sentinelEntry = await tryReadEntryIfPresentV1(
    vscode.Uri.joinPath(taskFolderUri, CREATION_SENTINEL_FILENAME_V1),
    CREATION_SENTINEL_FILENAME_V1,
    "createdV1"
  );
  if (!progressEntry) {
    return undefined;
  }
  // Reverse-removal order: everything else before the progress marker that
  // makes this folder classify as a task at all.
  const entries = [sentinelEntry, taskMdEntry, progressEntry].filter(
    (entry): entry is TaskCreationIntentEntryV1 => entry !== undefined
  );
  return { entries, sourceIntentIds };
}

/**
 * Permanently removes an interrupted creation's own files (plan §4.6).
 * Available only for `retryWithoutAdoptionEligible` and `preservable`
 * folders (see `buildSafeDeleteEntriesV1`'s doc comment) — every other class
 * gets Open only this round. Writes a durable `deleteRequested` journal
 * BEFORE touching disk, revalidates every entry immediately before removing
 * anything (aborting, folder untouched, on any mismatch or unexpected
 * content), then removes files in reverse order followed by the now-empty
 * directory, clears the current-task checkpoint if it pointed here, and
 * triggers an inventory rescan.
 */
export async function safeDeleteFailedTaskCreation(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore,
  arg?: TaskCreationRecoveryArg
): Promise<boolean> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const task = normalizeRecoveryArg(arg);
  if (!task) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return false;
  }

  const taskFolderPath = task.folderUri.fsPath;
  const taskFolderName = task.folderName;
  const metaFolderPath = path.dirname(taskFolderPath);
  const taskFolderUri = task.folderUri;

  const preCheck = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(metaFolderPath, extensionUri);
  const preFootprint = preCheck.find((f) => normalizePath(f.taskFolderPath) === normalizePath(taskFolderPath));
  if (!preFootprint || preFootprint.deletionPending || !(preFootprint.retryWithoutAdoptionEligible || preFootprint.footprintClass === "preservable")) {
    NotificationRouter.showWarning(
      `${taskFolderName} cannot be safely deleted automatically in its current state. Use Open to inspect it instead.`
    );
    return false;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Permanently delete the incomplete task folder for "${taskFolderName}"? This cannot be undone.`,
    { modal: true },
    "Delete"
  );
  if (confirmation !== "Delete") {
    return false;
  }
  const confirmationReceiptId = allocateHex128IdV1();

  try {
    const result = await runTrackedOperation(
      taskFolderPath,
      { label: "Safe Delete Task", taskName: taskFolderName, kind: "delete-task" },
      async (op) => {
        const metaFolderPaths = allMetaRootPaths(metaFolderPath);
        const outcome = await withAllMetaRootsLock(metaFolderPaths, async () => {
          // Reclassify and re-verify immediately before mutating (plan §4.4's
          // "reclassify and revalidate immediately before" pattern applies to
          // Safe Delete too) — the folder may have changed since confirmation.
          const currentFootprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(
            metaFolderPath,
            extensionUri
          );
          const fresh = currentFootprints.find(
            (f) => normalizePath(f.taskFolderPath) === normalizePath(taskFolderPath)
          );
          if (
            !fresh ||
            fresh.deletionPending ||
            !(fresh.retryWithoutAdoptionEligible || fresh.footprintClass === "preservable")
          ) {
            return { ok: false as const, blocked: false as const };
          }

          // Same reasoning as adoptAndRetryTaskCreation above: `fresh` was
          // just classified via the strict reader, so re-reading through it
          // here cannot diverge from that classification (plan §3.12).
          const progressResult = await readTaskProgressStrictV1(taskFolderUri, {
            expectedTaskFolder: taskFolderName,
          });
          if (!progressResult.ok || !progressResult.decoded.progress.ownership) {
            return { ok: false as const, blocked: false as const };
          }
          const ownership: TaskCreationIntentOwnershipClassificationV1 = {
            metaRoot: path.resolve(progressResult.decoded.progress.ownership.metaRoot),
            projectRoot: path.resolve(progressResult.decoded.progress.ownership.projectRoot),
            workspaceRoot: path.resolve(
              progressResult.decoded.progress.ownership.workspaceRoot ?? progressResult.decoded.progress.ownership.projectRoot
            ),
          };

          const built = await buildSafeDeleteEntriesV1(
            metaFolderPath,
            taskFolderPath,
            taskFolderUri,
            taskFolderName,
            fresh,
            ownership,
            confirmationReceiptId
          );
          if (!built) {
            return { ok: false as const, blocked: false as const };
          }

          const currentTaskCheckpointObserved =
            currentTaskStore.get() === normalizePath(taskFolderPath);

          const requested = await recordTaskDeletionRequestedV1({
            metaFolderPath,
            taskFolderPath,
            taskFolderName,
            ownership,
            sourceIntentIds: built.sourceIntentIds,
            confirmationReceiptId,
            entries: built.entries,
            currentTaskCheckpointObserved,
          });
          if (requested.kind !== "ok") {
            return { ok: false as const, blocked: false as const };
          }

          // Revalidate immediately before mutating: the actual directory
          // listing must be EXACTLY the entries just journaled (no more, no
          // less), and every file's live bytes must still match the recorded
          // hash — plan §4.6's "stops with a blocked-deletion recovery node
          // on unexpected content." Nothing is removed on any mismatch.
          let liveEntries: [string, vscode.FileType][];
          try {
            liveEntries = await vscode.workspace.fs.readDirectory(taskFolderUri);
          } catch {
            return { ok: false as const, blocked: true as const };
          }
          const expectedNames = new Set(built.entries.map((e) => e.relativePath));
          if (liveEntries.length !== expectedNames.size || liveEntries.some(([name]) => !expectedNames.has(name))) {
            return { ok: false as const, blocked: true as const };
          }
          for (const entry of built.entries) {
            const verified = await tryReadEntryIfPresentV1(
              vscode.Uri.joinPath(taskFolderUri, entry.relativePath),
              entry.relativePath,
              entry.entryClass
            );
            if (!verified || verified.contentSha256 !== entry.contentSha256) {
              return { ok: false as const, blocked: true as const };
            }
          }

          for (const entry of built.entries) {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(taskFolderUri, entry.relativePath), {
              recursive: false,
              useTrash: false,
            });
          }
          await journalDeletionStep("recordFolderRemoved", taskFolderName, () =>
            recordFolderRemovedV1(metaFolderPath, taskFolderPath)
          );
          await vscode.workspace.fs.delete(taskFolderUri, { recursive: false, useTrash: false });

          // Mark the source creation/adoption record(s) `resolvedDeleted`
          // (plan §4.6 step 1) — best-effort, like every other journal
          // bookkeeping step here: the physical deletion above is already the
          // source of truth for what got removed, so a failure marking the
          // now-superseded source journal must never surface as a deletion
          // failure to the user.
          await markSourceCreationRecordsResolvedDeletedV1(metaFolderPath, taskFolderPath, fresh, taskFolderName);

          if (currentTaskCheckpointObserved && currentTaskStore.get() === normalizePath(taskFolderPath)) {
            await currentTaskStore.clear();
          }
          await inventory.refresh();
          await journalDeletionStep("recordExternalStateResolved", taskFolderName, () =>
            recordExternalStateResolvedV1(metaFolderPath, taskFolderPath, true)
          );

          return { ok: true as const };
        });

        if (!outcome.ok) {
          NotificationRouter.showWarning(
            outcome.blocked
              ? `${taskFolderName} could not be deleted — it contains content this action does not recognize. Nothing was removed; use Open to inspect it.`
              : `${taskFolderName} could not be deleted automatically — its state changed since this row was shown. Refresh and use Open instead.`
          );
          return false;
        }

        op.report(taskFolderName);
        NotificationRouter.showInformation(`${taskFolderName} was safely deleted.`);
        return true;
      }
    );
    return result ?? false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(`Failed to delete task: ${message}`);
    return false;
  }
}

/**
 * Sweep-path counterpart of `markSourceCreationRecordsResolvedDeletedV1`: the
 * folder is already gone by the time `resumeStrandedTaskDeletionsV1` runs, so
 * there is no live footprint classification to read `retryWithoutAdoptionEligible`/
 * `footprintClass` from. Looks up whichever of the two journals (creation or
 * adoption) actually exists and is not already at a terminal state instead.
 * Best-effort, like its counterpart.
 */
async function markSourceCreationRecordsResolvedDeletedByLookupV1(
  metaFolderPath: string,
  taskFolderPath: string,
  taskFolderName: string
): Promise<void> {
  try {
    const creationJournal = await loadTaskCreationJournalV1(metaFolderPath, taskFolderPath);
    if (
      creationJournal.kind === "ok" &&
      creationJournal.journal.state !== "resolved" &&
      creationJournal.journal.state !== "resolvedDeleted"
    ) {
      const result = await resolveTaskCreationDeletedV1(metaFolderPath, taskFolderPath);
      if (result.kind !== "ok") {
        console.error(
          `Marking the creation record resolvedDeleted for "${taskFolderName}" did not succeed: ${result.kind}`
        );
      }
      return;
    }
    const adoptionJournal = await loadTaskAdoptionJournalV1(metaFolderPath, taskFolderPath);
    if (adoptionJournal.kind === "ok" && adoptionJournal.journal.state === "resolved") {
      const result = await resolveTaskAdoptionDeletedV1(metaFolderPath, taskFolderPath);
      if (result.kind !== "ok") {
        console.error(
          `Marking the adoption record resolvedDeleted for "${taskFolderName}" did not succeed: ${result.kind}`
        );
      }
    }
  } catch (error) {
    console.error(`Marking source creation/adoption records resolvedDeleted for "${taskFolderName}" threw`, error);
  }
}

/**
 * Resumes every deletion journal stranded at `folderRemoved` under one meta
 * root (plan §4.1 startup step 1, "Resume verified Safe Delete
 * journals/tombstones"; AC-CREATE-DELETE-02's "a crash after folder removal
 * must resume cleanup"). `TaskCreationStartupReconcilerV1`'s own scan only
 * walks folders that still exist on disk, so a crash between the physical
 * removal and `externalStateResolved` would otherwise never be revisited —
 * the folder can never reappear (nothing recreates it), but the journal
 * would stay stuck forever and the current-task checkpoint (if it still
 * pointed here) would never clear. Touches no filesystem content — the
 * folder is already gone — only journal bookkeeping and the same
 * checkpoint-clear/inventory-refresh side effects §4.6 already specifies for
 * external resolution.
 */
export async function resumeStrandedTaskDeletionsV1(
  metaFolderPath: string,
  currentTaskStore: CurrentTaskStore,
  inventory: TaskInventory
): Promise<void> {
  const stranded = await listStrandedTaskDeletionJournalsV1(metaFolderPath);
  if (stranded.length === 0) {
    return;
  }
  for (const { taskFolderPath, journal } of stranded) {
    const taskFolderName = journal.taskFolderName;
    await markSourceCreationRecordsResolvedDeletedByLookupV1(metaFolderPath, taskFolderPath, taskFolderName);
    if (journal.currentTaskCheckpointObserved && currentTaskStore.get() === normalizePath(taskFolderPath)) {
      await currentTaskStore.clear();
    }
    await journalDeletionStep("recordExternalStateResolved", taskFolderName, () =>
      recordExternalStateResolvedV1(metaFolderPath, taskFolderPath, true)
    );
  }
  await inventory.refresh();
}

export function registerTaskCreationRecoveryCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.openFailedTaskCreation",
      (arg?: TaskCreationRecoveryArg) => openFailedTaskCreation(arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.retryTaskCreation",
      (arg?: TaskCreationRecoveryArg) =>
        retryTaskCreation(inventory, context.extensionUri, currentTaskStore, context, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.adoptAndRetryTaskCreation",
      (arg?: TaskCreationRecoveryArg) =>
        adoptAndRetryTaskCreation(inventory, context.extensionUri, currentTaskStore, context, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.safeDeleteFailedTaskCreation",
      (arg?: TaskCreationRecoveryArg) =>
        safeDeleteFailedTaskCreation(inventory, context.extensionUri, currentTaskStore, arg)
    )
  );
}
