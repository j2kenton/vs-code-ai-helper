import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgress } from "../utils/taskProgressUtils";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";

type NoteArg = { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; task?: { folderUri: vscode.Uri } };

/** Collect a multi-line stage note in a disposable markdown editor. */
export async function addPendingNote(inventory: TaskInventory, arg?: NoteArg): Promise<void> {
  const resolverArg = arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } :
    arg && (arg.canonicalId || arg.taskFolderPath) ? { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath } : undefined;
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: true });
  if (!task) return;
  const stage = arg?.stage ?? task.progress.currentStage;
  const temp = vscode.Uri.joinPath(vscode.Uri.file(task.taskFolderPath), `.pending-note-${stage}.md`);
  const existing = task.progress.pendingNotes?.[stage] ?? "# Pending note\n\n";
  await vscode.workspace.fs.writeFile(temp, new TextEncoder().encode(existing));
  const document = await vscode.workspace.openTextDocument(temp);
  await vscode.window.showTextDocument(document, { preview: false });
  const choice = await vscode.window.showInformationMessage(
    `Edit the markdown note for ${STAGE_DISPLAY_NAMES[stage]}, then choose Save Note.`,
    { modal: true }, "Save Note", "Cancel"
  );
  if (choice === "Save Note") {
    const text = document.getText().trim();
    if (text && text !== "# Pending note") {
      await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), current => ({
        ...current,
        pendingNotes: { ...current.pendingNotes, [stage]: text },
        updatedAt: new Date().toISOString(),
      }));
    }
  }
  try { await vscode.workspace.fs.delete(temp); } catch { /* best-effort temp cleanup */ }
}

export function registerAddPendingNoteCommand(context: vscode.ExtensionContext, inventory: TaskInventory): void {
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.chatWithStage", (arg?: NoteArg) => addPendingNote(inventory, arg)));
}
