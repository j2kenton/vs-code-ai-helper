import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME } from "../types/taskProgress";
import {
  createTaskProgress,
  readTaskProgress,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import { resolveTaskRootForCreation } from "../utils/taskRoot";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { activateTask } from "../state/taskActivationCoordinator";
import { withMetaRootLock } from "../state/taskStateStore";

/**
 * The default plans root relative to workspace.
 * Used when no explicit meta resources path is configured.
 */
export const DEFAULT_PLANS_ROOT = ".helper/plans";

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
 * Finish a creation that was interrupted after both durable seed files were
 * written but before its sentinel could be promoted. Incomplete sentinels are
 * deliberately retained for inspection and never reused for a new task.
 */
async function recoverCompletedTaskCreations(metaFolderPath: string): Promise<void> {
  const root = vscode.Uri.file(metaFolderPath);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return;
  }

  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const folder = vscode.Uri.joinPath(root, name);
    const progress = await readTaskProgress(folder);
    if (progress?.status !== "creating") continue;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, TASK_FILENAME));
      await writeTaskProgress(folder, { ...progress, status: "active" });
    } catch {
      // The creation is genuinely incomplete. Preserve its sentinel rather
      // than risking deletion or silently repurposing its folder number.
    }
  }
}

/** Recover durable task-creation sentinels during extension startup. */
export async function recoverTaskCreations(metaFolderPath: string): Promise<void> {
  await withMetaRootLock(metaFolderPath, () => recoverCompletedTaskCreations(metaFolderPath));
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
    return "# Task\n\nDescribe the work you want to do here in as much detail as is useful. When\nyou're ready, use **Draft with AI** to turn these notes into a structured task\ndescription. Questions from the stage AI appear in the **Chat With AI** panel.\n";
  }
}

/**
 * Normalize a path consistently with taskRoot.ts: normalize separators and,
 * on Windows, lowercase for case-insensitive comparison.
 */
function normalizePath(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Creates a new task folder (YYYY-MM-DD_task_X) with progress tracking and
 * opens an almost-blank task.md for the user to describe the work. No input
 * popup or plan-generation prompt is shown.
 *
 * After a successful creation the new task is persisted as the current task
 * so the keyboard shortcut (Ctrl+Shift+Alt+I) works immediately without the
 * user having to navigate the tree first.
 *
 * Returns the created folder name, or undefined if cancelled/failed.
 */
export async function startNewTask(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore
): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const workspaceRoot = workspaceFolders.length <= 1
    ? workspaceFolders[0]
    : await vscode.window.showQuickPick(
        workspaceFolders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { title: "Choose the workspace for this task", placeHolder: "Tasks must belong to exactly one workspace folder" }
      ).then(selection => selection?.folder);
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  try {
    // Resolve the task root, creating it if needed
    const metaFolderPath = await resolveTaskRootForCreation(workspaceRoot);

    // The meta-root lease is shared across extension hosts. Folder-number
    // discovery, directory creation, and the initial files must be one
    // operation: otherwise two VS Code windows can both choose task_2 and
    // overwrite each other's seed files.
    const created = await withMetaRootLock(metaFolderPath, async () => {
      await recoverCompletedTaskCreations(metaFolderPath);
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
      await writeTaskProgress(taskFolderUri, { ...progress, status: "active" });
      return { taskFolderName, taskFolderPath, taskFileUri };
    });
    const { taskFolderName, taskFolderPath, taskFileUri } = created;

    // Refresh inventory so the new task is discoverable
    await inventory.refresh();

    // Resolve the newly created task back out of the inventory by its
    // normalized canonical path (mirrors the normalization in taskRoot.ts).
    const normalizedFolderPath = normalizePath(taskFolderPath);
    const newTask =
      inventory.getTaskById(normalizedFolderPath) ??
      inventory.getTaskByPath(normalizedFolderPath) ??
      // Fallback: match by folder name in case path normalization differs
      inventory.getTasks().find((t) => t.folderName === taskFolderName);

    if (newTask) {
      // Persist the new task as the current task so the shortcut router
      // finds it immediately, even before the user interacts with the tree.
      if (!(await activateTask(inventory, currentTaskStore, taskFolderPath, newTask.canonicalId))) {
        throw new Error("Could not activate the new task.");
      }
    } else {
      // The task folder was created and the inventory was refreshed, but the
      // task could not be re-resolved. This is unexpected (e.g. a race with
      // discovery filters). Surface a warning so the user knows the shortcut
      // may not work until they manually select the task in the tree.
      const warningMsg = `Task "${taskFolderName}" was created but could not be set as the ` +
        `current task automatically. Select it in the Tasks panel to activate it.`;
      try {
        const { NotificationRouter } = await import("../utils/notificationRouter.js");
        NotificationRouter.showWarning(warningMsg);
      } catch {
        void vscode.window.showWarningMessage(warningMsg);
      }
    }

    const doc = await vscode.workspace.openTextDocument(taskFileUri);
    await vscode.window.showTextDocument(doc);

    return taskFolderName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Failed to create task folder: ${message}`
    );
    return undefined;
  }
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
    () => startNewTask(inventory, context.extensionUri, currentTaskStore)
  );
  context.subscriptions.push(disposable);
}
