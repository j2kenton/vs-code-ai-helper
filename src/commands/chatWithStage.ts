import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkImplementationAvailabilityForModel,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { AgentRunResult } from "../types/agentRunner";
import { ensureRunsDirectory, writeRunLog } from "../utils/runLog";

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

export function buildStageChatPrompt(
  stageName: string,
  taskName: string,
  contextPack: string,
  message: string
): string {
  return `You are assisting with the ${stageName} stage for task ${taskName}.\n\nCurrent task context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}\n\nRespond directly and concisely. If the user requests workspace changes, describe the exact edits or next action to take instead of claiming they were already made.`;
}

export function buildStageEditPrompt(
  stageName: string,
  taskName: string,
  contextPack: string,
  message: string
): string {
  return `You are assisting with the ${stageName} stage for task ${taskName}.\n\nCurrent task context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}\n\nCarry out the requested workspace changes directly in the workspace when appropriate. Update the relevant task artifacts instead of only describing them. When you finish, summarize what changed and mention the files you edited.`;
}

const READ_ONLY_STAGE_CHAT_REQUEST_RE =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+|i\s+need\s+you\s+to\s+|i\s+want\s+you\s+to\s+)?(?:what|why|how|when|where|which|who|explain|describe|summari[sz]e|tell\s+me|show\s+me|walk\s+me\s+through|analy[sz]e)\b/i;
const DIRECT_STAGE_EDIT_REQUEST_RE =
  /(?:^|[.!?\n,;:]\s*|\b(?:and|then|also)\b\s+)(?:please\s+)?(?:(?:can|could|would)\s+you\s+|i\s+need\s+you\s+to\s+|i\s+want\s+you\s+to\s+|let'?s\s+)?(?:update|edit|change|modify|rewrite|revise|fix|apply|implement|create|add|remove|delete|rename|move|refactor|revert|restore|patch|incorporate)\b/i;
const STAGE_CHAT_REQUEST_FRAME_AFTER_BOUNDARY_RE =
  /^[;:]\s*(?:please\s+|(?:can|could|would)\s+you\s+|i\s+need\s+you\s+to\s+|i\s+want\s+you\s+to\s+|let'?s\s+)/i;
const STAGE_CHAT_REQUEST_LEAD_IN_RE =
  /(?:^|[\s.!?\n,;:])(?:please|(?:can|could|would)\s+you|i\s+need\s+you\s+to|i\s+want\s+you\s+to|let'?s|do\s+this|make\s+(?:this|these|the)\s+changes?|apply\s+(?:this|these|the)\s+changes?|next\s+step|action\s+item)\b/i;
const STAGE_CHAT_NON_IMPERATIVE_TAIL_RE =
  /^(?:looks?|seems?|appears?|sounds?|feels?|is|are|was|were|be|been|being|like)\b/i;
const STAGE_CHAT_EDIT_OBJECT_PATH_RE =
  /^(?:["'`([{<]\s*)?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+\b/i;
const STAGE_CHAT_EDIT_OBJECT_RE =
  /^(?:["'`([{<]\s*)?(?:(?:the|this|that|these|those|my|our|current|latest|relevant|existing|following|same|whole)\s+)*(?:task(?:\.md)?|plan(?:\.md)?|review(?:-[\w-]+)?(?:\.md)?|implementation(?:-[\w-]+)?(?:\.md)?|workspace|artifact|artifacts|file|files|section|paragraph|heading|description|details|content|text|wording|word|sentence|line|lines|clarifications?|feedback|change|changes)\b/i;
const STAGE_CHAT_PRONOUN_EDIT_OBJECT_RE =
  /^(?:["'`([{<]\s*)?(?:it|them|this|that|these|those)\b[\s\S]{0,80}\b(?:in|within|inside|to|for)\s+(?:the\s+)?(?:task(?:\.md)?|plan(?:\.md)?|review(?:-[\w-]+)?(?:\.md)?|implementation(?:-[\w-]+)?(?:\.md)?|workspace|artifact|artifacts|file|files|section|paragraph|heading|description|text|content)\b/i;

function hasStageEditObject(afterVerb: string): boolean {
  const tail = afterVerb.trimStart().slice(0, 120);
  if (!tail || STAGE_CHAT_NON_IMPERATIVE_TAIL_RE.test(tail)) {
    return false;
  }
  return (
    STAGE_CHAT_EDIT_OBJECT_PATH_RE.test(tail) ||
    STAGE_CHAT_EDIT_OBJECT_RE.test(tail) ||
    STAGE_CHAT_PRONOUN_EDIT_OBJECT_RE.test(tail)
  );
}

function hasRequestLikeBoundaryContext(
  message: string,
  matchIndex: number,
  matchText: string
): boolean {
  if (!/^[;:]/.test(matchText)) {
    return true;
  }
  return (
    STAGE_CHAT_REQUEST_FRAME_AFTER_BOUNDARY_RE.test(matchText) ||
    STAGE_CHAT_REQUEST_LEAD_IN_RE.test(message.slice(0, matchIndex))
  );
}

export function looksLikeStageEditRequest(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (READ_ONLY_STAGE_CHAT_REQUEST_RE.test(trimmed)) {
    return false;
  }
  const matcher = new RegExp(DIRECT_STAGE_EDIT_REQUEST_RE.source, "gi");
  for (const match of trimmed.matchAll(matcher)) {
    const index = match.index ?? 0;
    const matchText = match[0] ?? "";
    if (
      hasRequestLikeBoundaryContext(trimmed, index, matchText) &&
      hasStageEditObject(trimmed.slice(index + matchText.length))
    ) {
      return true;
    }
  }
  return false;
}

export function resolveStageChatOutcome(
  result: Pick<AgentRunResult, "status" | "outputFile" | "errorMessage"> | undefined
) {
  if (result?.status === "cancelled") {
    return { kind: "cancelled" as const };
  }
  if (result?.status !== "completed" || !result.outputFile) {
    throw new Error(result?.errorMessage ?? "Stage chat did not complete.");
  }
  return {
    kind: "completed" as const,
    outputFile: result.outputFile,
  };
}

function buildImplementationChatLog(
  stageName: string,
  result: Pick<
    Awaited<ReturnType<typeof runImplementationForModel>> & { runnerId: string },
    "status" | "filesChanged" | "filesChangedUnknown" | "summary" | "errorMessage"
  >
): string {
  const filesChanged = result.filesChangedUnknown
    ? "_tracking unavailable_"
    : result.filesChanged.length > 0
      ? result.filesChanged.map((file) => `- ${file}`).join("\n")
      : "_none_";
  const details = result.summary?.trim() || result.errorMessage?.trim() || "_none_";

  return `# Stage Chat\n\nStage: ${stageName}\nMode: implementation\nStatus: ${result.status}\n\nFiles changed:\n${filesChanged}\n\n${details}\n`;
}

async function writeImplementationChatLog(
  taskFolderUri: vscode.Uri,
  stageName: string,
  result: Pick<
    Awaited<ReturnType<typeof runImplementationForModel>> & { runnerId: string },
    | "runnerId"
    | "status"
    | "filesChanged"
    | "filesChangedUnknown"
    | "summary"
    | "errorMessage"
  >
): Promise<vscode.Uri> {
  return writeRunLog(
    taskFolderUri,
    result.runnerId,
    "impl",
    buildImplementationChatLog(stageName, result)
  );
}

async function openImplementationResult(
  workspaceUri: vscode.Uri,
  filesChanged: readonly string[],
  fallbackUri: vscode.Uri
): Promise<void> {
  const singleChangedFile = filesChanged.length === 1 ? filesChanged[0] : undefined;
  const candidate = singleChangedFile
    ? vscode.Uri.joinPath(workspaceUri, singleChangedFile.replace(/\\/g, "/"))
    : fallbackUri;

  try {
    const document = await vscode.workspace.openTextDocument(candidate);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    const fallbackDocument = await vscode.workspace.openTextDocument(fallbackUri);
    await vscode.window.showTextDocument(fallbackDocument, { preview: false });
  }
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

    const implementationRequest = looksLikeStageEditRequest(message);

    if (implementationRequest) {
      const { availability, providerLabel } =
        await checkImplementationAvailabilityForModel(modelId);
      if (!availability.available) {
        throw new Error(
          availability.reason ??
            `${providerLabel} is not available for implementation runs.`
        );
      }
      const contextPack = await generateContextPack(taskFolderUri, workspaceFolder.uri);
      const prompt = buildStageEditPrompt(
        stageName,
        resolvedTask.folderName,
        contextPack,
        message
      );
      const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
      if (sizeCheck === "abort" || sizeCheck === "declined") {
        return;
      }

      let result: Awaited<ReturnType<typeof runImplementationForModel>> | undefined;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Chatting with ${stageName} AI`,
          cancellable: true,
        },
        async (progress, token) => {
          result = await runImplementationForModel({
            modelId,
            prompt,
            workspaceUri: workspaceFolder.uri,
            token,
            onProgress: (progressMessage) =>
              progress.report({ message: progressMessage }),
            stage: targetStage,
            taskFolderUri,
          });
        }
      );

      if (!result) {
        throw new Error("Stage chat did not complete.");
      }
      if (result.status === "cancelled") {
        void vscode.window.showInformationMessage("Stage chat cancelled.");
        return;
      }

      const logUri = await writeImplementationChatLog(
        taskFolderUri,
        stageName,
        result
      );

      if (result.status !== "completed") {
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(logUri),
          { preview: false }
        );
        throw new Error(result.errorMessage ?? "Stage chat did not complete.");
      }

      if (result.filesChangedUnknown) {
        void vscode.window.showWarningMessage(
          "Stage chat completed, but the changed files could not be determined."
        );
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(logUri),
          { preview: false }
        );
        return;
      }

      if (result.filesChanged.length === 0) {
        void vscode.window.showWarningMessage(
          "Stage chat completed, but no workspace files were changed."
        );
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(logUri),
          { preview: false }
        );
        return;
      }

      void vscode.window.showInformationMessage(
        `Stage chat updated ${result.filesChanged.length} file(s): ${result.filesChanged
          .slice(0, 5)
          .join(", ")}${
          result.filesChanged.length > 5
            ? ` ... and ${result.filesChanged.length - 5} more`
            : ""
        }`
      );
      await openImplementationResult(
        workspaceFolder.uri,
        result.filesChanged,
        logUri
      );
      return;
    }

    const resolved = resolveRunnerForModel(modelId, targetStage, taskFolderUri);
    if (!resolved.runner.capabilities.assistant) {
      throw new Error(`${resolved.providerLabel} does not support assistant mode.`);
    }
    const contextPack = await generateContextPack(taskFolderUri, workspaceFolder.uri);
    const prompt = buildStageChatPrompt(
      stageName,
      resolvedTask.folderName,
      contextPack,
      message
    );
    const sizeCheck = await checkAndConfirmPromptSize(prompt, resolved.providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") {
      return;
    }

    const runsUri = await ensureRunsDirectory(taskFolderUri);
    const output = vscode.Uri.joinPath(runsUri, `stage-chat-${Date.now()}.md`);
    let result: Awaited<ReturnType<typeof resolved.runner.run>> | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Chatting with ${stageName} AI`,
        cancellable: true,
      },
      async (_progress, token) => {
        result = await resolved.runner.run({
          taskFolderUri,
          workspaceUri: workspaceFolder.uri,
          stage: targetStage,
          prompt,
          outputFile: output,
          modelId: resolved.nativeModelId,
        }, token);
      }
    );

    const outcome = resolveStageChatOutcome(result);
    if (outcome.kind === "cancelled") {
      void vscode.window.showInformationMessage("Stage chat cancelled.");
      return;
    }
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(outcome.outputFile),
      { preview: false }
    );
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
