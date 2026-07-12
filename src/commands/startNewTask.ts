import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME } from "../types/taskProgress";
import {
  createTaskProgress,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import { resolveTaskRootForCreation } from "../utils/taskRoot";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { activateTask } from "../state/taskActivationCoordinator";

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
    return `Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.

Shortcut: Apply Current Stage Action (Windows/Linux: Ctrl+Shift+Alt+I, macOS: Cmd+Shift+Alt+I).

## Task Description

## Draft with AI

## Open Questions
`;
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
 * opens task.md for the user to describe the work. The file is pre-seeded
 * with the task template (intro, shortcut note, and the three canonical
 * sections). No plan-generation prompt is shown.
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
    // Prompt for optional task description
    const description = await vscode.window.showInputBox({
      title: "New Task Description",
      prompt: "Enter an optional description for the new task. Press Escape to cancel.",
      placeHolder: "e.g., Implement sidebar status view",
    });

    // If the user cancelled the input box (returned undefined), abort creation.
    if (description === undefined) {
      return undefined;
    }

    // Resolve the task root, creating it if needed
    const metaFolderPath = await resolveTaskRootForCreation(workspaceRoot);

    const dateStr = formatDate(new Date());
    const taskNumber = await getNextTaskNumber(metaFolderPath, dateStr);
    const taskFolderName = `${dateStr}_task_${taskNumber}`;
    const taskFolderPath = path.join(metaFolderPath, taskFolderName);
    const taskFolderUri = vscode.Uri.file(taskFolderPath);

    // Create the task folder
    await vscode.workspace.fs.createDirectory(taskFolderUri);

    // Write initial progress with the new "task-description" stage
    await writeTaskProgress(
      taskFolderUri,
      {
        ...createTaskProgress(taskFolderName, "desc"),
        ownership: {
          metaRoot: path.resolve(metaFolderPath),
          projectRoot: path.resolve(workspaceRoot.uri.fsPath),
          workspaceRoot: path.resolve(workspaceRoot.uri.fsPath),
          boundAt: new Date().toISOString(),
          state: "resolved",
        },
      }
    );

    // Load and write task.md pre-seeded with the template
    let taskTemplate = await loadTaskTemplate(extensionUri);
    if (description.trim().length > 0) {
      taskTemplate = prefillTemplate(taskTemplate, description);
    }
    const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
    await vscode.workspace.fs.writeFile(
      taskFileUri,
      new TextEncoder().encode(taskTemplate)
    );

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

    // Open task.md in the editor regardless — the file was written successfully
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
 * Prefill the task template with the user-provided description under the Task Description heading.
 */
function prefillTemplate(template: string, description: string): string {
  const heading = "## Task Description";
  const index = template.indexOf(heading);
  if (index !== -1) {
    return (
      template.slice(0, index + heading.length) +
      "\n\n" +
      description.trim() +
      "\n" +
      template.slice(index + heading.length)
    );
  }
  return template + "\n\n" + description.trim() + "\n";
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
