import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME, TASK_PROGRESS_FILENAME, TaskStatus } from "../types/taskProgress";
import { writeResolvedModelSnapshotV1 } from "../utils/modelSelection";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { createTaskProgressV1, writeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { getConfiguredTaskRoot, normalizePath, resolveTaskRootForCreation } from "../utils/taskRoot";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { withAllMetaRootsLock } from "../state/taskStateStore";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { runTrackedOperation } from "../utils/taskOperations";
import { ensureAutomaticMetaGitIgnore } from "./toggleMetaResourcesGitIgnore";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { ClassifiedCreatingFootprintV1 } from "../types/taskCreationRecoveryV1";
import {
  commitCreationSentinelV1,
  recordFinalFolderClaimedV1,
  recordProgressCommittedV1,
  recordTaskCreationIntentV1,
  recordWorkMaterializedV1,
  resolveTaskCreationV1,
  TaskCreationIntentStoreResultV1,
  taskCreationIntentDigestV1,
} from "../services/taskCreationIntentStoreV1";
import { fileCreationIntentEntryV1, TaskCreationIntentEntryV1 } from "../types/taskCreationIntentV1";
import {
  ensureWorkflowMetaRootV1,
  getWorkflowPathRegistryV1,
  resolveWorkflowAllocatedFsPathV1,
} from "../services/workflowRuntimeServicesV1";
import { SchedulingIntentStoreV1 } from "../state/schedulingIntentV1";

/**
 * Describe a `TaskCreationIntentStoreResultV1` for a diagnostics log line.
 * Never includes a raw filesystem path (only the caller-supplied
 * `taskFolderName`/step label do that) — matching the sanitized-diagnostics
 * convention `taskCreationStartupReconcilerV1.ts` documents.
 */
function describeCreationIntentOutcome(result: TaskCreationIntentStoreResultV1): string {
  switch (result.kind) {
    case "ok":
      return "ok";
    case "missing":
      return "missing";
    case "rejected":
      return `rejected: ${result.reason}`;
    case "recoveryRequired":
      return `recoveryRequired: ${result.reason}`;
    case "storageFailure":
      return `storageFailure${result.errno ? ` (${result.errno})` : ""}`;
    case "unavailable":
      return `unavailable (${result.code})`;
    default:
      return "unknown outcome";
  }
}

/**
 * Best-effort journal bookkeeping (plan §4.2): a failure here must never
 * fail the task creation that already succeeded (or is about to) — the same
 * "non-fatal" policy `ensureAutomaticMetaGitIgnore`'s call site already
 * documents for its own auxiliary bookkeeping. The journal exists to make a
 * FUTURE interrupted creation more precisely recoverable, and is now also
 * consumed directly by `commands/taskCreationRecovery.ts`'s Retry command
 * (plan §4.5's "verified V1 journal" branch), so a journal write failure is
 * logged for diagnostics and otherwise ignored rather than failing the
 * caller — Retry's own re-verification immediately before mutating is what
 * actually protects correctness, not this bookkeeping call succeeding.
 */
export async function journalCreationStep(
  stepLabel: string,
  taskFolderName: string,
  run: () => Promise<TaskCreationIntentStoreResultV1>
): Promise<void> {
  try {
    const result = await run();
    if (result.kind !== "ok") {
      console.error(
        `Task creation journal step "${stepLabel}" for "${taskFolderName}" did not succeed: ${describeCreationIntentOutcome(result)}`
      );
    }
  } catch (error) {
    console.error(`Task creation journal step "${stepLabel}" for "${taskFolderName}" threw`, error);
  }
}

/**
 * Reads back a just-written file's ACTUAL on-disk bytes and builds its
 * `createdV1` journal entry from them (content hash + size), rather than
 * hashing the in-memory string this call site intended to write — so the
 * journal's recorded evidence always matches what the filesystem really has,
 * even if some write-path normalization (encoding, line endings) differs
 * from the in-memory value. Best-effort like `journalCreationStep`: a read
 * failure here must never fail task creation, it only means this entry is
 * omitted from the journal (so `classifyFromVerifiedJournalV1` correctly
 * declines to vouch for the folder later, rather than recording a wrong hash).
 */
export async function tryReadCreatedFileEntryV1(
  fileUri: vscode.Uri,
  relativePath: string,
  taskFolderName: string
): Promise<TaskCreationIntentEntryV1 | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    return fileCreationIntentEntryV1(relativePath, "createdV1", bytes);
  } catch (error) {
    console.error(
      `Task creation journal: could not read "${relativePath}" for "${taskFolderName}" to record its content hash`,
      error
    );
    return undefined;
  }
}

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get the next task number for a given date by checking existing folders
 */
async function getNextTaskNumber(
  metaFolderPath: string,
  dateStr: string
): Promise<number> {
  const pattern = new RegExp(`^${dateStr}_task_(\\d+)$`);
  let maxTaskNumber = 0;

  try {
    const metaFolderUri = vscode.Uri.file(metaFolderPath);
    const entries = await vscode.workspace.fs.readDirectory(metaFolderUri);

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        const match = pattern.exec(name);
        if (match && match[1]) {
          const taskNum = parseInt(match[1], 10);
          if (taskNum > maxTaskNumber) {
            maxTaskNumber = taskNum;
          }
        }
      }
    }
  } catch {
    // Directory might not exist yet or be empty, start with task 1
  }

  return maxTaskNumber + 1;
}

/**
 * Surface a read-only "Open" affordance for a legacy `status: "creating"`
 * folder found by `TaskCreationStartupReconcilerV1`. This deliberately does
 * not mutate the folder's progress in any way — see the reconciler's doc
 * comment for why implicitly promoting `creating` to `paused` (the old
 * behavior) was removed. Full retry/adopt/safe-delete recovery (plan
 * §§4.4-4.6) is a separate, larger piece of work keyed off `footprintClass`;
 * until it lands, every class still only gets this same read-only Open
 * affordance.
 */
function notifyLegacyCreatingFootprint(footprint: ClassifiedCreatingFootprintV1): void {
  const taskFileUri = vscode.Uri.joinPath(vscode.Uri.file(footprint.taskFolderPath), TASK_FILENAME);
  NotificationRouter.showWarning(
    `${footprint.taskFolderName} was left in an incomplete "creating" state (likely an interrupted extension host). ` +
      (footprint.hasTaskMd
        ? "It was not automatically resumed — open it to inspect and finish it manually."
        : "It has no task.md yet — open its folder to inspect it manually."),
    footprint.hasTaskMd ? taskFileUri.fsPath : undefined
  );
}

/**
 * Every workspace folder's CONFIGURED meta root (never the legacy fallback
 * roots `resolveTaskRootCandidates` also discovers for backward-compat task
 * discovery — those aren't valid creation targets and, worse, several of
 * them share a lock-file parent directory with the configured root, so
 * treating them as independent lockable roots caused the two to collide on
 * the same on-disk session lock and fail with "Another Ensemble session").
 * A relative configured root resolves to one path per workspace folder, so a
 * multi-root workspace can have several distinct meta roots reachable from
 * this window; an absolute configured root is shared by every folder and
 * resolves to exactly one.
 *
 * "No task is active" must be decided against ALL of these, not just the
 * target root — an active task in a sibling workspace folder's meta root is
 * still the task shortcuts and in-flight operations should keep targeting.
 * This is a best-effort BROADER check, not an additional lock scope: only
 * the target root (`primaryMetaFolderPath`, via the caller's existing
 * `withMetaRootLock`) is locked, matching the same "lock the target, scan
 * the rest" precedent `taskActivationCoordinator.ts`'s `activateTaskLocked`
 * already uses when pausing other active tasks across the whole inventory.
 */
export function allMetaRootPaths(primaryMetaFolderPath: string): string[] {
  const configuredRoot = getConfiguredTaskRoot();
  const paths = new Set<string>();
  paths.add(normalizePath(primaryMetaFolderPath));
  if (path.isAbsolute(configuredRoot)) {
    paths.add(normalizePath(configuredRoot));
  } else {
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      paths.add(normalizePath(path.join(ws.uri.fsPath, configuredRoot)));
    }
  }
  return Array.from(paths);
}

/**
 * Fresh from-disk scan for any task whose persisted status is "active",
 * across every meta root in `metaFolderPaths`. Deliberately re-reads every
 * task-progress.json rather than consulting TaskInventory's cached state —
 * the inventory can be stale relative to another window's concurrent write.
 * The PRIMARY root (metaFolderPaths[0] by convention — see allMetaRootPaths)
 * is scanned under the caller's `withMetaRootLock`, so staleness there is
 * fully excluded; the other, sibling-workspace-folder roots are scanned
 * best-effort without an additional lock (seeSee allMetaRootPaths's doc
 * comment for why this scope is intentional), so a wholly independent
 * concurrent creation under a DIFFERENT meta root is a narrow, pre-existing-
 * style race window rather than one this check newly closes.
 */
export async function hasActiveTaskOnDisk(metaFolderPaths: readonly string[]): Promise<boolean> {
  for (const metaFolderPath of metaFolderPaths) {
    const root = vscode.Uri.file(metaFolderPath);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
      continue;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      const result = await readTaskProgressStrictV1(vscode.Uri.joinPath(root, name));
      if (result.ok && result.decoded.progress.status === "active") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Load the task template from the bundled template file.
 */
export async function loadTaskTemplate(extensionUri: vscode.Uri): Promise<string> {
  const templateUri = vscode.Uri.joinPath(
    extensionUri,
    "resources",
    "prompts",
    "task-template.md"
  );
  try {
    const bytes = await vscode.workspace.fs.readFile(templateUri);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    // Fallback to inline template if file read fails — must stay
    // byte-identical to resources/prompts/task-template.md (see
    // test-fixtures/creation-seeds/README.md).
    return "# Task\n\n## Task Description\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n## Draft with AI\n\n[Click the Draft with AI button, or press Ctrl+Shift+Alt+I]\n";
  }
}


/**
 * Creates a new task folder (YYYY-MM-DD_task_X) with progress tracking and
 * opens an almost-blank task.md for the user to describe the work. No input
 * popup or plan-generation prompt is shown.
 *
 * A new task starts active (and becomes the current task) only when no task
 * under this meta root is already active; otherwise it starts paused,
 * leaving the existing active task as the target of shortcuts and in-flight
 * operations. Creating one must never mutate another task's lifecycle while
 * it is running.
 *
 * Returns the created folder name, or undefined if cancelled/failed.
 */
export async function startNewTask(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore,
  context?: vscode.ExtensionContext
): Promise<string | undefined> {
  // Block on the startup gate's classification pass before this command body
  // performs its first read, so it cannot race the read-only reconciliation
  // extension.ts kicks off during activate() — see
  // TaskCreationStartupReconcilerV1's doc comment.
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const workspaceRoot = workspaceFolders.length <= 1
    ? workspaceFolders[0]
    : await vscode.window.showQuickPick(
        workspaceFolders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { title: "Choose the workspace for this task", placeHolder: "Tasks must belong to exactly one workspace folder" }
      ).then(selection => selection?.folder);
  if (!workspaceRoot) {
    NotificationRouter.showWarning(
      "Open your repo folder in VS Code before starting a task. Ensemble will create .ensemble there automatically."
    );
    return undefined;
  }

  try {
    // Tracked instant mutation (taxonomy: create-task / terminal-always),
    // keyed on the workspace root because the task folder does not exist yet.
    // Registration is synchronous, so the Notifications row appears the moment
    // the button is pressed; the terminal entry (including the new folder
    // name, via report()) is recorded centrally by the operation-notification
    // bridge.
    return await runTrackedOperation(
      workspaceRoot.uri.fsPath,
      { label: "Create Task", taskName: workspaceRoot.name, kind: "create-task" },
      (op) => createTask(inventory, extensionUri, currentTaskStore, workspaceRoot, op, context)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(
      `Failed to create task folder: ${message}`
    );
    return undefined;
  }
}

async function createTask(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore,
  workspaceRoot: vscode.WorkspaceFolder,
  op: { report(detail: string | undefined): void },
  context?: vscode.ExtensionContext
): Promise<string> {
  // Resolve the task root, creating it if needed
  const metaFolderPath = await resolveTaskRootForCreation(workspaceRoot);

  // Read-only: surface (but never auto-fix) any legacy `creating` folders
  // left behind under this meta root. This replaces the old implicit
  // promotion to `paused` — see TaskCreationStartupReconcilerV1's doc comment
  // for why that was unsafe. It does not block creating the new task; the
  // two are independent folders/folder numbers.
  for (const footprint of await TaskCreationStartupReconcilerV1.getClassifiedFootprints(metaFolderPath, extensionUri)) {
    notifyLegacyCreatingFootprint(footprint);
  }

  // The meta-root lease is shared across extension hosts. Folder-number
  // discovery, directory creation, and the initial files must be one
  // operation: otherwise two VS Code windows can both choose task_2 and
  // overwrite each other's seed files. All meta roots reachable from this
  // window are locked together (see withAllMetaRootsLock) so the "no active
  // task exists anywhere" check below can't race a concurrent creation or
  // activation under a sibling workspace folder's meta root.
  const metaFolderPaths = allMetaRootPaths(metaFolderPath);
  const created = await withAllMetaRootsLock(metaFolderPaths, async () => {
    // A new task starts active only when no other task under ANY meta root
    // reachable from this window already is — an existing active task must
    // remain the target of shortcuts and in-flight operations. The disk scan
    // and this task's status write happen in the same locked section, so two
    // windows can never both see "nothing active" and both create an active
    // task.
    const initialStatus: TaskStatus = (await hasActiveTaskOnDisk(metaFolderPaths))
      ? "paused"
      : "active";
    const dateStr = formatDate(new Date());
    const taskNumber = await getNextTaskNumber(metaFolderPath, dateStr);
    const taskFolderName = `${dateStr}_task_${taskNumber}`;
    const taskFolderPath = path.join(metaFolderPath, taskFolderName);
    const taskFolderUri = vscode.Uri.file(taskFolderPath);
    const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);

    const ownership = {
      metaRoot: path.resolve(metaFolderPath),
      projectRoot: path.resolve(workspaceRoot.uri.fsPath),
      workspaceRoot: path.resolve(workspaceRoot.uri.fsPath),
      boundAt: new Date().toISOString(),
      state: "resolved" as const,
    };

    // task.md is the sole initial task document. Users can write freely in
    // the editor before asking the stage AI to turn it into a structured task.
    // Loaded before any disk mutation so the §4.2 "workMaterialized" journal
    // step (below) genuinely reflects content being ready, not yet written.
    const taskTemplate = await loadTaskTemplate(extensionUri);

    // §4.2 creation journal (plan): best-effort bookkeeping, never fatal to
    // task creation itself — see journalCreationStep's doc comment.
    await journalCreationStep("recordIntent", taskFolderName, () =>
      recordTaskCreationIntentV1({
        metaFolderPath,
        taskFolderPath,
        taskFolderName,
        ownership: {
          metaRoot: ownership.metaRoot,
          projectRoot: ownership.projectRoot,
          workspaceRoot: ownership.workspaceRoot,
        },
      })
    );
    const digest = taskCreationIntentDigestV1(taskFolderPath);
    // Staging is ALLOCATED by the path registry (plan §2.1: the registry is
    // the sole allocator under `creation-intents-v1/`): `creationWorkDir`
    // yields `creation-intents-v1/work-<digest>`. Nesting it there keeps a
    // crashed staging folder out of both `discoverTasksInRoot` (taskRoot.ts)
    // and `classifyMetaRoot` (taskCreationStartupReconcilerV1.ts), which only
    // scan the meta root's DIRECT children, so it can never surface as a
    // phantom task or a duplicate recovery node (plan §4.2). Registration is
    // fail-loud here — unlike the best-effort journal writes above, a staging
    // path we cannot allocate means task creation cannot proceed safely.
    const metaRootId = ensureWorkflowMetaRootV1(metaFolderPath);
    const workDirAllocation = getWorkflowPathRegistryV1().creationWorkDir(metaRootId, digest);
    const workFolderUri = vscode.Uri.file(resolveWorkflowAllocatedFsPathV1(workDirAllocation));

    await vscode.workspace.fs.createDirectory(workFolderUri);

    // "creating" is a durable creation sentinel. It is only promoted after
    // task.md and task-progress.json have both been written successfully.
    const progress = {
      ...createTaskProgressV1(taskFolderName, "desc"),
      displayName: taskFolderName,
      nameIsDefault: true,
      ownership,
    };
    await writeTaskProgressV1(workFolderUri, progress);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(workFolderUri, TASK_FILENAME),
      new TextEncoder().encode(taskTemplate)
    );

    // Best-effort model-config provenance (plan §23/5a): model settings are
    // global and mutable, so without a snapshot taken at kickoff, a
    // completed task's folder cannot show which models actually ran it once
    // workspace settings have since moved on. Never fatal to task creation,
    // which has effectively already succeeded by this point.
    try {
      await writeResolvedModelSnapshotV1(workFolderUri);
    } catch {
      // Non-fatal: the snapshot is provenance, not required for the task to function.
    }

    const [progressEntry, taskMdEntry] = await Promise.all([
      tryReadCreatedFileEntryV1(vscode.Uri.joinPath(workFolderUri, TASK_PROGRESS_FILENAME), TASK_PROGRESS_FILENAME, taskFolderName),
      tryReadCreatedFileEntryV1(vscode.Uri.joinPath(workFolderUri, TASK_FILENAME), TASK_FILENAME, taskFolderName),
    ]);
    const createdEntries: TaskCreationIntentEntryV1[] = [progressEntry, taskMdEntry].filter(
      (entry): entry is TaskCreationIntentEntryV1 => entry !== undefined
    );

    await journalCreationStep("recordWorkMaterialized", taskFolderName, () =>
      recordWorkMaterializedV1(metaFolderPath, taskFolderPath, createdEntries)
    );

    // Atomically claim the staging directory into the final task folder
    await vscode.workspace.fs.rename(workFolderUri, taskFolderUri, { overwrite: false });

    await journalCreationStep("recordFinalFolderClaimed", taskFolderName, () =>
      recordFinalFolderClaimedV1(metaFolderPath, taskFolderPath, createdEntries)
    );
    await journalCreationStep("commitCreationSentinel", taskFolderName, () =>
      commitCreationSentinelV1(metaFolderPath, taskFolderPath)
    );

    await writeTaskProgressV1(taskFolderUri, { ...progress, status: initialStatus });
    // task-progress.json was just rewritten (status flipped from "creating" to
    // its real initial value) -- re-read it so the journal's recorded hash for
    // this path reflects the FINAL bytes, not the transient "creating" write
    // recorded above.
    const finalProgressEntry = await tryReadCreatedFileEntryV1(
      vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME),
      TASK_PROGRESS_FILENAME,
      taskFolderName
    );
    await journalCreationStep("recordProgressCommitted", taskFolderName, () =>
      recordProgressCommittedV1(metaFolderPath, taskFolderPath, finalProgressEntry ? [finalProgressEntry] : [])
    );
    return { taskFolderName, taskFolderPath, taskFileUri, initialStatus };
  });
  const { taskFolderName, taskFolderPath, taskFileUri, initialStatus } = created;

  await journalCreationStep("resolveTaskCreation", taskFolderName, () =>
    resolveTaskCreationV1(metaFolderPath, taskFolderPath)
  );

  // Activation only runs Git-ignore maintenance when the inventory already
  // holds tasks, so the very first creation in a fresh workspace must apply
  // the managed block itself or the new `.ensemble` resources would show up
  // as unignored Git changes until the next reload. The selected workspace
  // folder is passed explicitly: in a multi-root workspace the task may live
  // in a repository other than the first folder's. Non-fatal: a gitignore
  // failure must not fail the task creation that already succeeded.
  if (context) {
    try {
      await ensureAutomaticMetaGitIgnore(context, workspaceRoot);
    } catch (err) {
      console.error("Automatic meta .gitignore maintenance failed", err);
    }
    // Mark the scheduling-intent ledger's coverage marker at creation (task
    // "Actionable Hand-offs", PART 6): without this, a brand-new task that
    // has not yet passed through the `scheduleAutomationChain` chokepoint
    // would have an empty ledger indistinguishable from "never observed",
    // and would report the safe-but-wrong `unknown` posture instead of the
    // correct `waitingForYou` for its entire early life. Non-fatal, mirroring
    // the git-ignore maintenance above — a marker write failure must not fail
    // task creation, which has already succeeded by this point.
    try {
      await new SchedulingIntentStoreV1(context.workspaceState).markCoverage(taskFolderPath);
    } catch (err) {
      console.error("Scheduling-intent coverage marker failed", err);
    }
  }

  // Refresh inventory so the new task is discoverable
  await inventory.refresh();

  if (initialStatus === "active") {
    // No other task under this meta root was active, so this one becomes the
    // target of shortcuts and in-flight operations immediately.
    await currentTaskStore.set(normalizePath(taskFolderPath));
    NotificationRouter.showInformation(`${taskFolderName} created and set as the active task.`);
  } else {
    // An existing active task remains the target of shortcuts and in-flight
    // operations. The explicit argument is essential; a bare resume command
    // would instead resume the older current task.
    NotificationRouter.showWarning(
      "Task created in paused state.",
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

  // Surface the new folder name on the operation row (and in its terminal
  // Notifications entry via the bridge).
  op.report(taskFolderName);

  await safeOpenTextDocument(taskFileUri, "task.md");

  return taskFolderName;
}

/**
 * Register the startNewTask command
 */
export function registerStartNewTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.startNewTask",
    () => startNewTask(inventory, context.extensionUri, currentTaskStore, context)
  );
  context.subscriptions.push(disposable);
}
