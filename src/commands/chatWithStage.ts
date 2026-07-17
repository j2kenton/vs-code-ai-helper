import * as vscode from "vscode";
import * as path from "path";
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
import { runTrackedOperation } from "../utils/taskOperations";
import { safeOpenTextDocument, writeTextFile } from "../utils/fileUtils";

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

/** Chat never invokes tools or edits code — the runner is the same text-only
 * planning/review runner used to answer questions (CLI providers run in
 * `mode: "text"`, native edit permissions withheld). The one exception is
 * markdown: a response may propose the full replacement content of a single
 * `.md` file that lives inside this task's own folder (its description,
 * plan, or a review artifact), which this command applies directly. Anything
 * outside that folder, or any non-markdown file, is never written. See
 * docs/design/c4-chat-edit-spike-decision.md for why this extension-mediated
 * envelope was chosen over enabling a provider's native edit mode. */
export function buildStageResponsePrompt(
  stageName: string, taskName: string, _artifactPath: string, contextPack: string, message: string, conversation = ""
): string {
  return `You are answering a user question about the ${stageName} stage for task ${taskName}.\n\nDo not invoke tools or propose that code changes were applied. If the user asks you to make a code change, tell them to use the stage action that applies it explicitly instead. However, if the user asks you to update this task's own markdown files (its task description, plan, or a review file), you may do so directly: respond with the file's full new content wrapped in \`[[UPDATE_FILE:relative-filename.md]]\`...\`[[/UPDATE_FILE]]\`, using a path relative to this task's own folder. Only one file may be updated per response, only \`.md\` files inside this task's folder may be targeted this way, and you must never target a source code file. Give a concise, useful answer alongside any update. If you need clarification before the task can proceed, end with a single \`[[QUESTION]]your question[[/QUESTION]]\` envelope. Do not put task output in that envelope.\n\nConversation so far:\n${conversation.slice(-12000)}\n\nTask context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}`;
}

function splitQuestionEnvelope(text: string): { answer: string; question?: string } {
  const match = /\[\[QUESTION\]\]([\s\S]*?)\[\[\/QUESTION\]\]/i.exec(text);
  if (!match) return { answer: text };
  const question = (match[1] ?? "").trim();
  return { answer: text.replace(match[0], "").trim(), question: question || undefined };
}

export interface FileUpdateEnvelope {
  relPath: string;
  content: string;
}

/** Extracts every `[[UPDATE_FILE:path]]...[[/UPDATE_FILE]]` envelope and
 * returns the remaining text with all envelopes removed — no envelope may
 * survive into the displayed response, whether or not it is applied. Pure and
 * VS-Code-free so it's unit-testable without a host. */
export function splitFileUpdateEnvelopes(
  text: string
): { text: string; updates: FileUpdateEnvelope[] } {
  const updates: FileUpdateEnvelope[] = [];
  const remaining = text
    .replace(
      /\[\[UPDATE_FILE:([^\]\r\n]+)\]\]([\s\S]*?)\[\[\/UPDATE_FILE\]\]/gi,
      (_whole, relPath: string, content: string) => {
        updates.push({
          relPath: relPath.trim(),
          content: content.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
        });
        return "";
      }
    )
    .trim();
  return { text: remaining, updates };
}

export type ChatFileUpdatePlan =
  | { action: "none" }
  | { action: "reject"; note: string }
  | { action: "write"; relPath: string; targetPath: string; content: string };

/**
 * All-or-nothing validation of the chat-edit envelopes in one response.
 * The chat-edit contract allows exactly one markdown file per response, so a
 * response carrying several envelopes is rejected whole — zero writes — and
 * a single envelope is written only when its target passes
 * `resolveMarkdownUpdateTarget`. Pure so the zero-write policy is directly
 * unit-testable.
 */
export function planFileUpdate(
  taskFolderPath: string,
  updates: readonly FileUpdateEnvelope[]
): ChatFileUpdatePlan {
  if (updates.length === 0) return { action: "none" };
  if (updates.length > 1) {
    return {
      action: "reject",
      note:
        `_The response proposed updating ${updates.length} files at once; ` +
        `chat may update only one markdown file per response, so none were written. ` +
        `Ask for one file at a time._`,
    };
  }
  const update = updates[0];
  if (!update) return { action: "none" };
  const targetPath = resolveMarkdownUpdateTarget(taskFolderPath, update.relPath);
  if (!targetPath) {
    return {
      action: "reject",
      note: `_Could not update \`${update.relPath}\`: only markdown files inside this task's folder can be edited from chat._`,
    };
  }
  return { action: "write", relPath: update.relPath, targetPath, content: update.content };
}

/**
 * Resolve a chat-proposed relative path to an absolute file path, but only
 * when it is a `.md` file that stays inside `taskFolderPath` — this is the
 * entire enforcement boundary for the C4 chat-edit capability (no code
 * files, no escaping the active task's own folder via `..` or an absolute
 * path). Returns `undefined` for anything that fails that check.
 */
export function resolveMarkdownUpdateTarget(
  taskFolderPath: string,
  relPath: string
): string | undefined {
  const trimmed = relPath.trim().replace(/\\/g, "/");
  if (!trimmed || path.isAbsolute(trimmed) || !/\.md$/i.test(trimmed)) {
    return undefined;
  }
  const resolved = path.resolve(taskFolderPath, trimmed);
  const rel = path.relative(taskFolderPath, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
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
  try {
    // Tracked, cancellable chat-response operation (taxonomy: terminal entry
    // only on failure/cancel — a successful turn's answer in the chat panel is
    // its own confirmation, so no per-turn success notification is emitted).
    await runTrackedOperation(lockKey, {
      label: "Chat",
      stage: targetStage,
      taskName: task.folderName,
      exclusive: false,
      kind: "chat-send",
      cancellable: true,
    }, async (op) => {
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
    // The operation's own token guards the provider process, so the
    // Notifications-row cancel button aborts the real run.
    const result = await runner.run({ taskFolderUri, workspaceUri: workspaceFolder.uri, stage: targetStage, prompt, outputFile, modelId: nativeModelId }, op.token!);
    if (result.status === "cancelled") {
      await chatViewProvider.append("assistant", "Stage chat was cancelled.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
      return;
    }
    if (result.status !== "completed") throw new Error(result.errorMessage ?? "Stage chat did not complete.");
    const rawResponse = new TextDecoder().decode(await vscode.workspace.fs.readFile(outputFile)).trim();
    const { text: withoutUpdate, updates } = splitFileUpdateEnvelopes(rawResponse);
    const plan = planFileUpdate(task.taskFolderPath, updates);
    let updateNote = "";
    if (plan.action === "write") {
      await writeTextFile(vscode.Uri.file(plan.targetPath), plan.content);
      updateNote = `\n\n_Updated \`${plan.relPath}\`._`;
      NotificationRouter.showInformation(`Chat AI updated ${plan.relPath} for ${task.folderName}.`, plan.targetPath);
      await safeOpenTextDocument(vscode.Uri.file(plan.targetPath), plan.relPath);
    } else if (plan.action === "reject") {
      updateNote = `\n\n${plan.note}`;
    }
    const response = splitQuestionEnvelope(`${withoutUpdate}${updateNote}`.trim());
    if (response.answer) await chatViewProvider.append("assistant", response.answer, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    if (response.question) await chatViewProvider.ask({ canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath, stage: targetStage, question: response.question });
    if (!response.answer && !response.question) await chatViewProvider.append("assistant", "The stage AI did not return an answer.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    });
  } catch (error) {
    // Rethrown out of the tracked operation so its terminal state is
    // `failed` (or `cancelled` when the token fired); reported here.
    const text = error instanceof Error ? error.message : String(error);
    await chatViewProvider.append("assistant", `Unable to respond: ${text}`, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    // The operation-notification bridge owns terminal operation entries.
    // Keep the failure in the chat transcript, but do not add a second
    // Notifications entry (or a native toast) beside the bridge-backed one.
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
