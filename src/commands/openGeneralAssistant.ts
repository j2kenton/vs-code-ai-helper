import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { resolveRunnerForModel } from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";

/** Run a single task-scoped assistant request; no chat session is created. */
export async function openGeneralAssistant(inventory: TaskInventory, currentTaskStore: CurrentTaskStore): Promise<void> {
  const task = await resolveTaskContext(inventory, undefined, { allowPaused: true }, currentTaskStore);
  if (!task) { void vscode.window.showInformationMessage("Select an active task before running the assistant."); return; }
  const question = await vscode.window.showInputBox({ prompt: "Ask the task assistant", placeHolder: "What do you need help with?" });
  if (!question?.trim()) return;
  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
  const workspace = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  if (!workspace) { void vscode.window.showErrorMessage("The task is not inside an open workspace."); return; }
  try {
    const { modelId } = await resolveFreshModelForStage(taskFolderUri, task.progress.currentStage);
    const resolved = resolveRunnerForModel(modelId, task.progress.currentStage, taskFolderUri);
    if (!resolved.runner.capabilities.assistant) throw new Error(`${resolved.providerLabel} does not support assistant mode.`);
    const available = await resolved.runner.isAvailable();
    if (!available.available) throw new Error(available.reason ?? "Selected assistant runner is unavailable.");
    const context = await generateContextPack(taskFolderUri, workspace.uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(taskFolderUri, "runs"));
    const output = vscode.Uri.joinPath(taskFolderUri, "runs", `assistant-${Date.now()}.md`);
    const prompt = `You are a one-off assistant for task ${task.folderName}. Do not create a chat session or edit files unless explicitly asked.\n\nCurrent stage: ${task.progress.currentStage}\nRecent task status: ${JSON.stringify({ status: task.progress.status, updatedAt: task.progress.updatedAt, currentStage: task.progress.currentStage, pendingNotes: task.progress.pendingNotes }, null, 2)}\n\nTask context:\n${context.slice(0, 30000)}\n\nUser question:\n${question}`;
    let result: Awaited<ReturnType<typeof resolved.runner.run>> | undefined;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running ${resolved.providerLabel} assistant`, cancellable: true }, async (_p, token) => {
      result = await resolved.runner.run({ taskFolderUri, workspaceUri: workspace.uri, stage: task.progress.currentStage, prompt, outputFile: output, modelId: resolved.nativeModelId }, token);
    });
    if (result?.status !== "completed" || !result.outputFile) throw new Error(result?.errorMessage ?? "Assistant run did not complete.");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(result.outputFile), { preview: false });
  } catch (error) { void vscode.window.showErrorMessage(`Assistant run failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export function registerOpenGeneralAssistantCommand(context: vscode.ExtensionContext, inventory: TaskInventory, currentTaskStore: CurrentTaskStore): void {
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.openGeneralAssistant", () => openGeneralAssistant(inventory, currentTaskStore)));
}
