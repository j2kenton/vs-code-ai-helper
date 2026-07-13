import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkImplementationAvailabilityForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { writeRunLog } from "../utils/runLog";
import {
  changedStageResponsePathsSince,
  normalizeStageResponseChangedFiles,
  partitionScopedFiles,
  resolveStageResponseScope,
  revertOutOfScopeFiles,
  scopePathsToWorkspacePaths,
  snapshotStageResponseState,
} from "../utils/stageResponseScope";

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

/**
 * The AI decides whether the message needs an edit or just an answer — this
 * command's only job is to make sure that if it does edit, it can only ever
 * touch the one artifact this stage owns (enforced afterward, see
 * revertOutOfScopeFiles; no provider CLI can be sandboxed to a single file
 * up front).
 */
export function buildStageResponsePrompt(
  stageName: string,
  taskName: string,
  artifactPath: string,
  contextPack: string,
  message: string
): string {
  return `You are assisting with the ${stageName} stage for task ${taskName}.\n\nYou may modify only one file: ${artifactPath}. Do not create, edit, or delete any other file, even if the request seems to call for it — explain what's needed instead.\n\nCurrent task context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}\n\nIf this is a question or doesn't require changing ${artifactPath}, just answer directly instead of editing anything. Otherwise make the edit directly in ${artifactPath} rather than only describing it, and summarize what changed when you finish.`;
}

type StageResponseResult = Pick<
  Awaited<ReturnType<typeof runImplementationForModel>> & { runnerId: string },
  "runnerId" | "status" | "filesChanged" | "filesChangedUnknown" | "summary" | "errorMessage"
>;

function formatFileList(files: readonly string[]): string {
  return files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "_none_";
}

function buildStageResponseLog(
  stageName: string,
  artifactPath: string,
  result: Pick<StageResponseResult, "status" | "filesChangedUnknown" | "summary" | "errorMessage">,
  keptFiles: readonly string[],
  revertedFiles: readonly string[],
  leftAloneFiles: readonly string[]
): string {
  const filesChanged = result.filesChangedUnknown
    ? "_tracking unavailable_"
    : formatFileList(keptFiles);
  const revertedSection =
    revertedFiles.length > 0
      ? `\nOut-of-scope edits reverted:\n${formatFileList(revertedFiles)}\n`
      : "";
  const leftAloneSection =
    leftAloneFiles.length > 0
      ? `\nOut-of-scope edits left in place (already had uncommitted changes before this run):\n${formatFileList(leftAloneFiles)}\n`
      : "";
  const details = result.summary?.trim() || result.errorMessage?.trim() || "_none_";

  return `# Stage Response\n\nStage: ${stageName}\nArtifact: ${artifactPath}\nStatus: ${result.status}\n\nFiles changed:\n${filesChanged}\n${revertedSection}${leftAloneSection}\n${details}\n`;
}

async function writeStageResponseLog(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  stageName: string,
  artifactPath: string,
  result: StageResponseResult,
  keptFiles: readonly string[],
  revertedFiles: readonly string[],
  leftAloneFiles: readonly string[]
): Promise<vscode.Uri> {
  return writeRunLog(
    taskFolderUri,
    result.runnerId,
    stage,
    buildStageResponseLog(stageName, artifactPath, result, keptFiles, revertedFiles, leftAloneFiles)
  );
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
    prompt: `Respond to ${stageName} AI`,
    placeHolder: "Type your response to the AI...",
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

    const { availability, providerLabel } =
      await checkImplementationAvailabilityForModel(modelId);
    if (!availability.available) {
      throw new Error(
        availability.reason ?? `${providerLabel} is not available for implementation runs.`
      );
    }

    const responseScope = await resolveStageResponseScope(
      workspaceFolder.uri,
      taskFolderUri,
      targetStage
    );
    const artifactPath = responseScope.artifactWorkspacePath;
    const contextPack = await generateContextPack(taskFolderUri, workspaceFolder.uri);
    const prompt = buildStageResponsePrompt(
      stageName,
      resolvedTask.folderName,
      artifactPath,
      contextPack,
      message
    );
    const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") {
      return;
    }

    // Captured immediately before the run so scope enforcement can diff the
    // whole primary+fallback attempt, not just the final provider result.
    // Its keys also identify files that were already dirty beforehand —
    // reverting those would destroy the user's own pre-existing work.
    const stateBefore = await snapshotStageResponseState(responseScope);
    const dirtyBefore = stateBefore ? new Set(stateBefore.keys()) : undefined;

    let result: Awaited<ReturnType<typeof runImplementationForModel>> | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Responding to ${stageName} AI`,
        cancellable: true,
      },
      async (progress, token) => {
        result = await runImplementationForModel({
          modelId,
          prompt,
          workspaceUri: workspaceFolder.uri,
          token,
          onProgress: (progressMessage) => progress.report({ message: progressMessage }),
          stage: targetStage,
          taskFolderUri,
          // The model may legitimately just answer the message rather than
          // edit the artifact — that's a completed run, not a failure.
          requireFileChange: false,
        });
      }
    );

    if (!result) {
      throw new Error("Stage response did not complete.");
    }
    if (result.status === "cancelled") {
      void vscode.window.showInformationMessage("Stage response cancelled.");
      return;
    }

    let keptFiles: string[] = [];
    let revertedFiles: string[] = [];
    let revertFailures: string[] = [];
    let leftAloneFiles: string[] = [];
    let changedFilesUnknown = result.filesChangedUnknown ?? false;
    let changedScopeFiles: string[] = [];
    const stateAfter = stateBefore
      ? await snapshotStageResponseState(responseScope)
      : undefined;
    if (stateBefore && stateAfter) {
      changedScopeFiles = changedStageResponsePathsSince(stateBefore, stateAfter);
      changedFilesUnknown = false;
    } else if (stateBefore && !stateAfter) {
      changedFilesUnknown = true;
    } else if (!result.filesChangedUnknown) {
      changedScopeFiles = normalizeStageResponseChangedFiles(
        result.filesChanged,
        responseScope,
        result.runnerId
      );
      changedFilesUnknown = false;
    }

    if (!changedFilesUnknown) {
      const { kept, outOfScope } = partitionScopedFiles(
        changedScopeFiles,
        responseScope.artifactScopePath
      );
      keptFiles = scopePathsToWorkspacePaths(responseScope, kept);
      if (outOfScope.length > 0) {
        // Undefined dirtyBefore means git was unavailable for the pre-run
        // snapshot — treat every out-of-scope path as unsafe to touch rather
        // than guessing which ones were already dirty.
        const safeToRevert = dirtyBefore
          ? outOfScope.filter((file) => !dirtyBefore.has(file))
          : [];
        leftAloneFiles = dirtyBefore
          ? outOfScope.filter((file) => dirtyBefore.has(file))
          : [...outOfScope];

        if (safeToRevert.length > 0) {
          const { restored, deleted, failed } = await revertOutOfScopeFiles(
            responseScope,
            safeToRevert
          );
          revertedFiles = scopePathsToWorkspacePaths(responseScope, [
            ...restored,
            ...deleted,
          ]);
          revertFailures = scopePathsToWorkspacePaths(responseScope, failed);
        }
        leftAloneFiles = scopePathsToWorkspacePaths(responseScope, leftAloneFiles);
      }
    }

    const scopedResult: StageResponseResult = {
      ...result,
      filesChangedUnknown: changedFilesUnknown,
    };

    const logUri = await writeStageResponseLog(
      taskFolderUri,
      targetStage,
      stageName,
      artifactPath,
      scopedResult,
      keptFiles,
      revertedFiles,
      leftAloneFiles
    );

    if (result.status !== "completed") {
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(logUri),
        { preview: false }
      );
      throw new Error(result.errorMessage ?? "Stage response did not complete.");
    }

    if (revertFailures.length > 0) {
      void vscode.window.showWarningMessage(
        `Respond to AI edited file(s) outside ${artifactPath} and could not undo it: ${revertFailures.join(", ")}. Please review and revert manually.`
      );
    } else if (revertedFiles.length > 0) {
      void vscode.window.showWarningMessage(
        `Respond to AI tried to change file(s) outside ${artifactPath}; reverted: ${revertedFiles.join(", ")}.`
      );
    }
    if (leftAloneFiles.length > 0) {
      void vscode.window.showWarningMessage(
        `Respond to AI also changed file(s) outside ${artifactPath} that already had uncommitted changes before this run, so they were left as-is to avoid discarding your work: ${leftAloneFiles.join(", ")}. Please review them manually.`
      );
    }

    if (changedFilesUnknown) {
      void vscode.window.showWarningMessage(
        "Stage response completed, but changed files could not be determined, so the single-file scope could not be verified."
      );
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(logUri),
        { preview: false }
      );
      return;
    }

    if (keptFiles.length === 0) {
      void vscode.window.showInformationMessage(
        `Stage response completed without changing ${artifactPath}.`
      );
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(logUri),
        { preview: false }
      );
      return;
    }

    void vscode.window.showInformationMessage(`Stage response updated ${artifactPath}.`);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(workspaceFolder.uri, artifactPath)
      ),
      { preview: false }
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Stage response failed: ${error instanceof Error ? error.message : String(error)}`
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
