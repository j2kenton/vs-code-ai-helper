import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { runImplementationForModel } from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";

/**
 * Accepted argument shapes for chatWithStage.
 * - Tree-view stage node passes { task: IncompleteTask, stage: TaskStage }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath?, stage? }
 */
type ChatWithStageArg =
  | { task?: IncompleteTask; stage?: TaskStage }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage };

/**
 * Normalize a command argument into the shape resolveTaskContext expects,
 * plus the requested stage.
 */
function normalizeArg(node: ChatWithStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined;
} {
  if (!node) {
    return { resolverArg: undefined, stage: undefined };
  }

  if ("task" in node && node.task) {
    return {
      resolverArg: { taskFolderPath: node.task.folderUri.fsPath },
      stage: node.stage,
    };
  }

  const n = node as {
    canonicalId?: string;
    taskFolderPath?: string;
    stage?: TaskStage;
  };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return {
    resolverArg: hasExplicit
      ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
      : undefined,
    stage: n.stage,
  };
}

/**
 * Open a chat interface to communicate with the AI model assigned to a specific stage.
 * This allows users to provide feedback, ask questions, or request modifications
 * to the current stage's output without re-running the entire stage.
 */
export async function chatWithStage(
  inventory: TaskInventory,
  explicitArg?: ChatWithStageArg
): Promise<void> {
  const { resolverArg, stage } = normalizeArg(explicitArg);

  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No task found. Please select a task first."
    );
    return;
  }

  const stageName = STAGE_DISPLAY_NAMES[stage ?? resolvedTask.progress.currentStage];

  // Get the message from the user
  const message = await vscode.window.showInputBox({
    prompt: `Chat with ${stageName} AI`,
    placeHolder: "Type your message to the AI...",
    ignoreFocusOut: true,
  });

  if (!message) {
    return;
  }

  const targetStage = stage ?? resolvedTask.progress.currentStage;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedTask.taskFolderPath));
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage("The task is not inside an open workspace.");
    return;
  }
  try {
    const { modelId } = await resolveFreshModelForStage(vscode.Uri.file(resolvedTask.taskFolderPath), targetStage);
    const contextPack = await generateContextPack(vscode.Uri.file(resolvedTask.taskFolderPath), workspaceFolder.uri);
    const prompt = `You are assisting with the ${stageName} stage for task ${resolvedTask.folderName}.\n\n` +
      `Current task context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}\n\n` +
      "Respond directly and concisely. If the user requests code changes, make them in the workspace and summarize what changed.";
    let responseText = "";
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Chatting with ${stageName} AI`, cancellable: true }, async (_progress, token) => {
      const result = await runImplementationForModel({ modelId, prompt, workspaceUri: workspaceFolder.uri, token, stage: targetStage, taskFolderUri: vscode.Uri.file(resolvedTask.taskFolderPath), onProgress: () => undefined });
      responseText = result.summary ?? result.errorMessage ?? "The model did not return a response.";
    });
    const document = await vscode.workspace.openTextDocument({ content: responseText, language: "markdown" });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    void vscode.window.showErrorMessage(`Stage chat failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Register the chatWithStage command.
 */
export function registerChatWithStageCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.chatWithStage",
    (arg?: ChatWithStageArg) =>
      chatWithStage(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
