import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { resolveRunnerForModel } from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { StatusEntry } from "../views/statusView";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";

type StatusEntrySource = { getEntries(): StatusEntry[] };

/** Build the self-contained prompt sent to a one-off task assistant run. */
export function buildAssistantPrompt(
  task: { folderName: string; progress: import("../types/taskProgress").TaskProgress },
  contextPack: string,
  recentStatus: Array<{ message: string; level: StatusEntry["level"]; timestamp: string }>,
  question: string
): string {
  return `You are a one-off assistant for task ${task.folderName}. Do not create a chat session or edit files unless explicitly asked.\n\nCurrent stage: ${task.progress.currentStage}\nTask status: ${JSON.stringify({ status: task.progress.status, updatedAt: task.progress.updatedAt, currentStage: task.progress.currentStage, pendingNotes: task.progress.pendingNotes }, null, 2)}\n\nRecent status entries:\n${JSON.stringify(recentStatus, null, 2)}\n\nTask context:\n${contextPack.slice(0, 30000)}\n\nUser question:\n${question}`;
}

/** Run a single task-scoped assistant request; no chat session is created. */
export async function openGeneralAssistant(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  statusEntries?: StatusEntrySource
): Promise<void> {
  const task = await resolveTaskContext(inventory, undefined, { allowPaused: true }, currentTaskStore);
  if (!task) { void vscode.window.showInformationMessage("Select an active task before running the assistant."); return; }
  const question = await vscode.window.showInputBox({ prompt: "Ask the task assistant", placeHolder: "What do you need help with?" });
  if (!question?.trim()) return;
  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
  const workspace = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  if (!workspace) { void vscode.window.showErrorMessage("The task is not inside an open workspace."); return; }
  if (!(await ensureAiConsent(context))) return;
  try {
    const { modelId } = await resolveFreshModelForStage(taskFolderUri, task.progress.currentStage);
    if (!modelId) {
      const openSettings = await vscode.window.showWarningMessage(
        "No model is configured for this stage. Open Ensemble Settings and choose a primary model before continuing.",
        { modal: true },
        "Open Settings"
      );
      if (openSettings === "Open Settings") {
        await vscode.commands.executeCommand("vs-code-ai-helper.settingsView.focus");
      }
      return;
    }
    const resolved = resolveRunnerForModel(modelId, task.progress.currentStage, taskFolderUri);
    if (!resolved.runner.capabilities.assistant) throw new Error(`${resolved.providerLabel} does not support assistant mode.`);
    const available = await resolved.runner.isAvailable();
    if (!available.available) throw new Error(available.reason ?? "Selected assistant runner is unavailable.");
    const contextPack = await generateContextPack(taskFolderUri, workspace.uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(taskFolderUri, "runs"));
    const output = vscode.Uri.joinPath(taskFolderUri, "runs", `assistant-${Date.now()}.md`);
    const recentStatus = statusEntries?.getEntries().slice(0, 10).map(entry => ({
      message: entry.message,
      level: entry.level,
      timestamp: entry.timestamp.toISOString(),
    })) ?? [];
    const prompt = buildAssistantPrompt(task, contextPack, recentStatus, question);
    const sizeCheck = await checkAndConfirmPromptSize(prompt, resolved.providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") return;
    let result: Awaited<ReturnType<typeof resolved.runner.run>> | undefined;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running ${resolved.providerLabel} assistant`, cancellable: true }, async (_p, token) => {
      result = await resolved.runner.run({ taskFolderUri, workspaceUri: workspace.uri, stage: task.progress.currentStage, prompt, outputFile: output, modelId: resolved.nativeModelId }, token);
    });
    if (result?.status !== "completed" || !result.outputFile) throw new Error(result?.errorMessage ?? "Assistant run did not complete.");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(result.outputFile), { preview: false });
  } catch (error) { void vscode.window.showErrorMessage(`Assistant run failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export function registerOpenGeneralAssistantCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  statusEntries?: StatusEntrySource
): void {
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.openGeneralAssistant", () => openGeneralAssistant(context, inventory, currentTaskStore, statusEntries)));
}
