import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage, RUNS_DIRNAME } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkRunnerAvailabilityForModel,
  resolveRunnerForModel,
} from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { ChatViewProvider } from "../views/chatView";
import { NotificationRouter } from "../utils/notificationRouter";
import { notifyDesktop } from "../utils/desktopNotifier";
import { taskOperations } from "../utils/taskOperations";

type ChatWithStageArg =
  | { task?: IncompleteTask; stage?: TaskStage; message?: string }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; message?: string };

function normalizeArg(node: ChatWithStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined; message: string | undefined;
} {
  if (!node) return { resolverArg: undefined, stage: undefined, message: undefined };
  if ("task" in node && node.task) {
    return { resolverArg: { taskFolderPath: node.task.folderUri.fsPath }, stage: node.stage, message: node.message };
  }
  const value = node as { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; message?: string };
  return {
    resolverArg: value.canonicalId || value.taskFolderPath
      ? { canonicalId: value.canonicalId, taskFolderPath: value.taskFolderPath }
      : undefined,
    stage: value.stage,
    message: value.message,
  };
}

/** Chat is deliberately text-only.  It uses the planning/review runner rather
 * than an implementation runner, so no tool calls or workspace edits occur. */
export function buildStageResponsePrompt(
  stageName: string, taskName: string, _artifactPath: string, contextPack: string, message: string, conversation = ""
): string {
  return `You are answering a user question about the ${stageName} stage for task ${taskName}.\n\nDo not modify files, invoke tools, or propose that changes were applied. If the user asks you to make a change, tell them to use the stage action that applies it explicitly instead. Give a concise, useful answer. If you need clarification before the task can proceed, end with a single \`[[QUESTION]]your question[[/QUESTION]]\` envelope. Do not put task output in that envelope.\n\nConversation so far:\n${conversation.slice(-12000)}\n\nTask context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}`;
}

function splitQuestionEnvelope(text: string): { answer: string; question?: string } {
  const match = /\[\[QUESTION\]\]([\s\S]*?)\[\[\/QUESTION\]\]/i.exec(text);
  if (!match) return { answer: text };
  const question = (match[1] ?? "").trim();
  return { answer: text.replace(match[0], "").trim(), question: question || undefined };
}

export async function chatWithStage(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  explicitArg?: ChatWithStageArg
): Promise<void> {
  const { resolverArg, stage, message } = normalizeArg(explicitArg);
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: true });
  if (!task) {
    void vscode.window.showInformationMessage("No task found. Please select a task first.");
    return;
  }
  const targetStage = stage ?? task.progress.currentStage;
  if (!message?.trim()) {
    await chatViewProvider.open({ canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath, stage: targetStage });
    return;
  }
  if (!(await ensureAiConsent(context))) return;

  const lockKey = task.taskFolderPath;
  const op = taskOperations.begin(lockKey, {
    label: "Chat",
    stage: targetStage,
    taskName: task.folderName,
    exclusive: false,
  });
  try {
    const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
    if (!workspaceFolder) throw new Error("The task is not inside an open workspace.");
    const { modelId } = await resolveFreshModelForStage(taskFolderUri, targetStage);
    if (!modelId) {
      const choice = await vscode.window.showWarningMessage(
        "No model is configured for this stage. Open Ensemble Settings and choose a primary model before continuing.",
        { modal: true }, "Open Settings"
      );
      if (choice === "Open Settings") await vscode.commands.executeCommand("vs-code-ai-helper.openSettings");
      return;
    }
    const { runner, nativeModelId } = resolveRunnerForModel(modelId, targetStage, taskFolderUri);
    const { availability: available, providerLabel } = await checkRunnerAvailabilityForModel(modelId, targetStage);
    if (!available.available) throw new Error(available.reason ?? `${providerLabel} is unavailable.`);
    const conversation = (await chatViewProvider.transcript(task.taskFolderPath, task.canonicalId))
      .slice(-20)
      .map(entry => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n");
    const prompt = buildStageResponsePrompt(STAGE_DISPLAY_NAMES[targetStage], task.folderName, "",
      await generateContextPack(taskFolderUri, workspaceFolder.uri), message, conversation);
    const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") return;

    const runsUri = vscode.Uri.joinPath(taskFolderUri, RUNS_DIRNAME);
    await vscode.workspace.fs.createDirectory(runsUri);
    const outputFile = vscode.Uri.joinPath(runsUri, `chat-${Date.now()}.md`);
    NotificationRouter.emitProgressSummary(`Chatting with ${STAGE_DISPLAY_NAMES[targetStage]} AI using ${providerLabel}...`);
    const tokenSource = new vscode.CancellationTokenSource();
    const result = await runner.run({ taskFolderUri, workspaceUri: workspaceFolder.uri, stage: targetStage, prompt, outputFile, modelId: nativeModelId }, tokenSource.token);
    tokenSource.dispose();
    if (result.status === "cancelled") {
      await chatViewProvider.append("assistant", "Stage chat was cancelled.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
      return;
    }
    if (result.status !== "completed") throw new Error(result.errorMessage ?? "Stage chat did not complete.");
    const response = splitQuestionEnvelope(new TextDecoder().decode(await vscode.workspace.fs.readFile(outputFile)).trim());
    if (response.answer) await chatViewProvider.append("assistant", response.answer, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    if (response.question) await chatViewProvider.ask({ canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath, stage: targetStage, question: response.question });
    if (!response.answer && !response.question) await chatViewProvider.append("assistant", "The stage AI did not return an answer.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    NotificationRouter.showInformation(`Stage AI response received for ${STAGE_DISPLAY_NAMES[targetStage]}.`);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await chatViewProvider.append("assistant", `Unable to respond: ${text}`, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    const failureMessage = `Stage response failed: ${text}`;
    NotificationRouter.showError(failureMessage);
    notifyDesktop("Ensemble — error", failureMessage);
  } finally {
    taskOperations.end(op);
  }
}

export function registerChatWithStageCommand(context: vscode.ExtensionContext, inventory: TaskInventory, chatViewProvider: ChatViewProvider): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.chatWithStage", (arg?: ChatWithStageArg) => chatWithStage(context, inventory, chatViewProvider, arg)
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.postStageQuestion",
    (question: import("../views/chatView").StageChatQuestion) => chatViewProvider.ask(question)
  ));
}
