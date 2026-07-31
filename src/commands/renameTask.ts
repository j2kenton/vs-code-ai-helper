import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { TASK_DESCRIPTION_FILENAME, TASK_FILENAME } from "../types/taskProgress";
import { patchTaskProgress } from "../utils/taskProgressUtils";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { runTrackedOperation } from "../utils/taskOperations";
import { parseTaskDocument } from "../utils/taskDescriptionDocument";
import { TaskNode } from "../views/taskTreeProvider";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";

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
  // Block on the startup gate's classification pass before this command's
  // first task-state read (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

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

/**
 * Lines of abstract process/planning language ("independently shippable
 * slices", "decision gate", …) describe how the work is organized, not what
 * it does — they make meaningless task names, so name derivation skips them
 * in favor of the first line that states concrete work.
 */
const ABSTRACT_PLANNING_LINE =
  /\b(shippable|workstream|decision gate|vertical slice|slices?\b.*\bcarved|carved out of|integration checkpoint|implementation checklist|checklist below|scope and requirements|open questions)\b/i;

/**
 * Derive a concise task name from the task description text: the first
 * meaningful (non-heading, non-boilerplate, non-abstract) line, stripped of
 * markdown markup and truncated at a sentence boundary. Exported for testing.
 */
export function deriveNameFromDescription(text: string): string | undefined {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  let firstFallback: string | undefined;
  for (const rawLine of withoutCode.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^<!--/.test(line)) {
      continue;
    }
    // Strip list markers, emphasis, and inline code markup.
    line = line
      .replace(/^[-*>\d.)\s]+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    // Meta labels like "Goal:" / "Scope:" prefix real content — drop the label.
    line = line.replace(/^(Goal|Scope|Objective|Summary|Task|Description)\s*:\s*/i, "").trim();
    if (line.length < 8) {
      continue;
    }
    // Cut at the first sentence end when the line is long.
    const sentenceEnd = line.search(/[.!?](\s|$)/);
    if (sentenceEnd > 12) {
      line = line.slice(0, sentenceEnd);
    }
    const candidate = line.slice(0, 100).trim();
    if (ABSTRACT_PLANNING_LINE.test(candidate)) {
      // Remember it in case nothing concrete follows, but keep looking for a
      // line that says what the work actually changes.
      firstFallback = firstFallback ?? candidate;
      continue;
    }
    return candidate;
  }
  return firstFallback;
}

/**
 * A concise title derived from the task description without renaming
 * folders/IDs. Prefers the user's own free-text description
 * (task-description.md), then the structured "Task Description" section of
 * task.md, then the AI draft — instead of whatever heading happened to come
 * first in the document.
 */
export async function renameTaskWithAI(
  inventory: TaskInventory,
  arg?: TaskArg
): Promise<void> {
  // Same activation-barrier contract as renameTask above (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const task = await resolve(inventory, arg);
  if (!task) return;

  const readText = async (fileName: string): Promise<string> => {
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(task.taskFolderPath), fileName);
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return "";
    }
  };

  let sourceText = (await readText(TASK_DESCRIPTION_FILENAME)).trim();
  if (!sourceText) {
    const parsed = parseTaskDocument(await readText(TASK_FILENAME));
    sourceText = parsed.taskDescription || parsed.draftWithAI;
  }

  const suggestion = deriveNameFromDescription(sourceText) ?? task.folderName;
  await renameTask(inventory, arg, suggestion.slice(0, 120));
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
