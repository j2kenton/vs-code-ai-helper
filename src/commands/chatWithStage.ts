import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { resolveRunnerForModel, runImplementationForModel } from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";

type ChatWithStageArg =
  | { task?: IncompleteTask; stage?: TaskStage }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage };

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

export async function chatWithStage(
  context: vscode.ExtensionContext,
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

  const targetStage = stage ?? resolvedTask.progress.currentStage;
  const stageName = STAGE_DISPLAY_NAMES[targetStage];
  const message = await vscode.window.showInputBox({
    prompt: `Chat with ${stageName} AI`,
    placeHolder: "Type your message to the AI...",
    ignoreFocusOut: true,
  });

  if (!message?.trim()) {
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage("The task is not inside an open workspace.");
    return;
  }
  if (!(await ensureAiConsent(context))) {
    return;
  }

  try {
    const { modelId } = await resolveFreshModelForStage(taskFolderUri, targetStage);
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

    const { providerLabel } = resolveRunnerForModel(modelId, targetStage, taskFolderUri);
    const contextPack = await generateContextPack(taskFolderUri, workspaceFolder.uri);
    const prompt = `You are assisting with the ${stageName} stage for task ${resolvedTask.folderName}.\n\n` +
      `Current task context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}\n\n` +
      "Respond directly and concisely. If the user requests code changes, make them in the workspace and summarize what changed.";

    const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") {
      return;
    }

    let responseText = "";
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Chatting with ${stageName} AI`,
        cancellable: true,
      },
      async (_progress, token) => {
        const result = await runImplementationForModel({
          modelId,
          prompt,
          workspaceUri: workspaceFolder.uri,
          token,
          onProgress: () => undefined,
          stage: targetStage,
          taskFolderUri,
        });
        responseText = result.summary ?? result.errorMessage ?? "The model did not return a response.";
      }
    );

    const document = await vscode.workspace.openTextDocument({
      content: responseText,
      language: "markdown",
    });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Stage chat failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function registerChatWithStageCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.chatWithStage",
    (arg?: ChatWithStageArg) => chatWithStage(context, inventory, arg)
  );
  context.subscriptions.push(disposable);
}
