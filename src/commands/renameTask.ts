import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { TASK_FILENAME } from "../types/taskProgress";
import { patchTaskProgress } from "../utils/taskProgressUtils";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { runTrackedOperation } from "../utils/taskOperations";
import { TaskNode } from "../views/taskTreeProvider";

type TaskArg = TaskNode | { canonicalId?: string; taskFolderPath?: string };

async function resolve(inventory: TaskInventory, arg?: TaskArg) {
  if (arg instanceof TaskNode) {
    return resolveTaskContext(
      inventory,
      {
        canonicalId: arg.task.canonicalId,
        taskFolderPath: arg.task.folderUri.fsPath,
      },
      { allowPaused: true }
    );
  }
  return resolveTaskContext(inventory, arg, { allowPaused: true });
}

export async function renameTask(
  inventory: TaskInventory,
  arg?: TaskArg,
  suggestedName?: string
): Promise<void> {
  const task = await resolve(inventory, arg);
  if (!task) return;

  const name = await vscode.window.showInputBox({
    prompt: "Task name",
    value: suggestedName ?? task.progress.displayName ?? task.folderName,
    validateInput: (value) =>
      value.trim() ? undefined : "Task name cannot be blank.",
  });
  if (name === undefined) return;

  // Tracked instant mutation (taxonomy: rename-task / terminal-always). The
  // input box stays outside the operation; the terminal Notifications entry
  // (including the new name, via report()) is recorded centrally by the
  // operation-notification bridge.
  await runTrackedOperation(
    task.taskFolderPath,
    { label: "Rename Task", taskName: task.folderName, kind: "rename-task" },
    async (op) => {
      await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), (current) => ({
        ...current,
        displayName: name.trim(),
        nameIsDefault: false,
      }));
      await inventory.refresh();
      op.report(`renamed to "${name.trim()}"`);
    }
  );
}

/** A concise title can be generated from an AI draft without renaming folders/IDs. */
export async function renameTaskWithAI(
  inventory: TaskInventory,
  arg?: TaskArg
): Promise<void> {
  const task = await resolve(inventory, arg);
  if (!task) return;

  const taskUri = vscode.Uri.joinPath(
    vscode.Uri.file(task.taskFolderPath),
    TASK_FILENAME
  );
  let text = "";
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(taskUri));
  } catch {
    // The folder name remains a valid suggestion when the task artifact is missing.
  }

  const draft =
    text.match(/^#\s+(.+)$/m)?.[1] ??
    text.match(/## Draft with AI\s*\n+([^\n.#][^\n]*)/i)?.[1] ??
    task.folderName;
  await renameTask(inventory, arg, draft.replace(/^[-*\d.\s]+/, "").slice(0, 120));
}

export function registerRenameTaskCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.renameTask", (arg?: TaskArg) =>
      renameTask(inventory, arg)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.renameTaskWithAI",
      (arg?: TaskArg) => renameTaskWithAI(inventory, arg)
    )
  );
}
