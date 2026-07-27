import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME, TaskStatus } from "../types/taskProgress";
import {
  createTaskProgress,
  readTaskProgress,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import { getConfiguredTaskRoot, normalizePath, resolveTaskRootForCreation } from "../utils/taskRoot";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { withAllMetaRootsLock } from "../state/taskStateStore";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { runTrackedOperation } from "../utils/taskOperations";
import { ensureAutomaticMetaGitIgnore } from "./toggleMetaResourcesGitIgnore";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  LegacyCreatingStartupGateV0,
  LegacyCreatingFootprintV0,
} from "../state/legacyCreatingStartupGateV0";

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
 * folder found by `LegacyCreatingStartupGateV0`. This deliberately does not
 * mutate the folder's progress in any way — see the gate's doc comment for
 * why implicitly promoting `creating` to `paused` (the old behavior) was
 * removed. Full retry/adopt/safe-delete recovery is a separate, larger piece
 * of work; until it lands, the only available action is to open the file for
 * manual inspection.
 */
function notifyLegacyCreatingFootprint(footprint: LegacyCreatingFootprintV0): void {
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
function allMetaRootPaths(primaryMetaFolderPath: string): string[] {
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
async function hasActiveTaskOnDisk(metaFolderPaths: readonly string[]): Promise<boolean> {
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
      const progress = await readTaskProgress(vscode.Uri.joinPath(root, name));
      if (progress?.status === "active") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Load the task template from the bundled template file.
 */
async function loadTaskTemplate(extensionUri: vscode.Uri): Promise<string> {
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
    // Fallback to inline template if file read fails
    return "# Instructions\n\nDescribe the work you want to do here in as much detail as is useful. When\nyou're ready, use **Draft with AI** to turn these notes into a structured task\ndescription. Questions from the stage AI appear in the **Chat With AI** panel.\n\n# User's Description of the Task\n\n\n\n\n\n\n\n\n\n\n";
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
  // LegacyCreatingStartupGateV0's doc comment.
  await LegacyCreatingStartupGateV0.waitUntilReady();

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
  // promotion to `paused` — see LegacyCreatingStartupGateV0's doc comment for
  // why that was unsafe. It does not block creating the new task; the two
  // are independent folders/folder numbers.
  for (const footprint of await LegacyCreatingStartupGateV0.getFootprints(metaFolderPath)) {
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

    await vscode.workspace.fs.createDirectory(taskFolderUri);

    // "creating" is a durable creation sentinel. It is only promoted after
    // task.md and task-progress.json have both been written successfully.
    const progress = {
      ...createTaskProgress(taskFolderName, "desc"),
      displayName: taskFolderName,
      nameIsDefault: true,
      ownership: {
        metaRoot: path.resolve(metaFolderPath),
        projectRoot: path.resolve(workspaceRoot.uri.fsPath),
        workspaceRoot: path.resolve(workspaceRoot.uri.fsPath),
        boundAt: new Date().toISOString(),
        state: "resolved" as const,
      },
    };
    await writeTaskProgress(taskFolderUri, progress);

    // task.md is the sole initial task document. Users can write freely in
    // the editor before asking the stage AI to turn it into a structured task.
    const taskTemplate = await loadTaskTemplate(extensionUri);
    await vscode.workspace.fs.writeFile(
      taskFileUri,
      new TextEncoder().encode(taskTemplate)
    );
    await writeTaskProgress(taskFolderUri, { ...progress, status: initialStatus });
    return { taskFolderName, taskFolderPath, taskFileUri, initialStatus };
  });
  const { taskFolderName, taskFolderPath, taskFileUri, initialStatus } = created;

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
