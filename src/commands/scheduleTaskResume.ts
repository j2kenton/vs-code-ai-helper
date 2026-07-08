import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../utils/taskProgressUtils";

/**
 * Accepted argument shapes for scheduleTaskResume.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
type ScheduleTaskResumeArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: ScheduleTaskResumeArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  if ("task" in node && node.task) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return hasExplicit
    ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
    : undefined;
}

/**
 * Parse HH:MM time string into a Date object for today or tomorrow.
 */
function parseTimeString(timeStr: string): Date | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match || typeof match[1] !== "string" || typeof match[2] !== "string") {
    return undefined;
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }
  const now = new Date();
  const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  // If the time has already passed today, schedule for tomorrow
  if (result <= now) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

/**
 * Schedule a task to resume at a specific time (e.g., when API credits restore).
 * This is useful when a task is paused due to rate limiting or other temporary issues.
 */
export async function scheduleTaskResume(
  inventory: TaskInventory,
  explicitArg?: ScheduleTaskResumeArg
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);

  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No task found. Please select a task first."
    );
    return;
  }

  // Ask user when to resume
  const options: vscode.QuickPickItem[] = [
    { label: "In 1 hour", description: "Resume task in 1 hour" },
    { label: "In 2 hours", description: "Resume task in 2 hours" },
    { label: "In 4 hours", description: "Resume task in 4 hours" },
    { label: "Tomorrow", description: "Resume task tomorrow at the same time" },
    { label: "Custom time", description: "Specify a custom time" },
  ];

  const selection = await vscode.window.showQuickPick(options, {
    placeHolder: "When should the task resume?",
  });

  if (!selection) {
    return;
  }

  let resumeTime: Date;
  const now = new Date();

  switch (selection.label) {
    case "In 1 hour":
      resumeTime = new Date(now.getTime() + 60 * 60 * 1000);
      break;
    case "In 2 hours":
      resumeTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      break;
    case "In 4 hours":
      resumeTime = new Date(now.getTime() + 4 * 60 * 60 * 1000);
      break;
    case "Tomorrow":
      resumeTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      break;
    case "Custom time":
      {
        const timeStr = await vscode.window.showInputBox({
          prompt: "Enter time (HH:MM or YYYY-MM-DD HH:MM)",
          placeHolder: "14:30 or 2026-07-09 14:30",
        });
        if (!timeStr) {
          return;
        }
        try {
          // Try to parse as HH:MM first
          let parsed = parseTimeString(timeStr);
          if (!parsed) {
            // Fall back to full date-time parsing
            parsed = new Date(timeStr);
          }
          if (!parsed || isNaN(parsed.getTime())) {
            throw new Error("Invalid date");
          }
          resumeTime = parsed;
        } catch {
          void vscode.window.showErrorMessage("Invalid time format.");
          return;
        }
      }
      break;
    default:
      return;
  }

  // Schedule the task
  const timeUntilResume = resumeTime.getTime() - now.getTime();
  if (timeUntilResume <= 0) {
    void vscode.window.showErrorMessage(
      "Resume time must be in the future."
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Task "${resolvedTask.folderName}" scheduled to resume at ${resumeTime.toLocaleString()}`
  );

  // Set up the timeout
  setTimeout(async () => {
    void vscode.window.showInformationMessage(
      `Resuming task "${resolvedTask.folderName}"...`
    );
    await vscode.commands.executeCommand("vs-code-ai-helper.resumeTask", {
      canonicalId: resolvedTask.canonicalId,
    });
  }, timeUntilResume);
}

/**
 * Register the scheduleTaskResume command.
 */
export function registerScheduleTaskResumeCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.scheduleTaskResume",
    (arg?: ScheduleTaskResumeArg) =>
      scheduleTaskResume(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
