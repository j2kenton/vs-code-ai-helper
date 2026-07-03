import * as vscode from "vscode";
import {
  readTaskProgress,
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import { writeContextPack } from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { pickTaskFolder } from "../utils/pickTaskFolder";
import { CopilotLanguageModelRunner } from "../runners/copilotLanguageModelRunner";
import { TaskStage } from "../types/taskProgress";

/**
 * Read a text file's content, or undefined if it doesn't exist.
 */
async function readIfExists(fileUri: vscode.Uri): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(fileUri);
    return new TextDecoder().decode(content);
  } catch {
    return undefined;
  }
}

/**
 * Stages a task may be in for updated-plan review to be safe: either an
 * updated plan exists with no review yet, or the task is still at the
 * plan-updated-review stage (regenerating plan-updated-review.md in
 * place). Later stages are excluded so this command can never regress a
 * task's progress or leave stale downstream artifacts behind.
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = [
  "plan-updated",
  "plan-updated-review",
];

/**
 * Generate plan-updated-review.md for a task folder's plan-updated.md
 * using the user's Copilot access. Falls back to informing the user
 * when Copilot is unavailable so the manual review workflow remains the
 * fallback path.
 */
export async function reviewUpdatedPlanWithAI(
  extensionUri: vscode.Uri
): Promise<void> {
  const taskFolderUri = await pickTaskFolder(
    "Review Updated Plan with AI",
    ELIGIBLE_STAGES
  );
  if (!taskFolderUri) {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const planUpdatedFileUri = vscode.Uri.joinPath(
    taskFolderUri,
    "plan-updated.md"
  );
  let planUpdatedContent: string;
  try {
    const content = await vscode.workspace.fs.readFile(planUpdatedFileUri);
    planUpdatedContent = new TextDecoder().decode(content).trim();
    if (planUpdatedContent.length === 0) {
      throw new Error("empty");
    }
  } catch {
    void vscode.window.showWarningMessage(
      "No plan-updated.md found (or it is empty) for this task. Generate an updated plan before requesting a review."
    );
    return;
  }

  const runner = new CopilotLanguageModelRunner();
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `Copilot is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Use the manual review workflow (Start New Task / Resume Task) instead.`
    );
    return;
  }

  const planUpdatedReviewFileUriForCheck = vscode.Uri.joinPath(
    taskFolderUri,
    "plan-updated-review.md"
  );
  const existingReviewContent = await readIfExists(
    planUpdatedReviewFileUriForCheck
  );
  if (existingReviewContent && existingReviewContent.trim().length > 0) {
    const confirmation = await vscode.window.showWarningMessage(
      "plan-updated-review.md already has content. Generating a new review will overwrite it.",
      { modal: true },
      "Overwrite"
    );
    if (confirmation !== "Overwrite") {
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Reviewing updated plan with Copilot...",
      cancellable: true,
    },
    async (progress, token) => {
      const contextPackUri = await writeContextPack(
        taskFolderUri,
        workspaceRoot.uri
      );
      const contextPackContent = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(contextPackUri)
      );

      const prompt = await renderPromptTemplate(
        extensionUri,
        "review-updated-plan.md",
        { contextPack: contextPackContent, planUpdated: planUpdatedContent }
      );

      const planUpdatedReviewFileUri = vscode.Uri.joinPath(
        taskFolderUri,
        "plan-updated-review.md"
      );

      progress.report({ message: "Waiting for Copilot response..." });

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: workspaceRoot.uri,
          stage: "plan-updated-review",
          prompt,
          outputFile: planUpdatedReviewFileUri,
        },
        token
      );

      await writeRunLog(
        taskFolderUri,
        runner.id,
        "plan-updated-review",
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        const existing = await readTaskProgress(taskFolderUri);
        if (existing && ELIGIBLE_STAGES.includes(existing.currentStage)) {
          const updated = updateTaskProgressStage(
            existing,
            "plan-updated-review"
          );
          await writeTaskProgress(taskFolderUri, updated);
        }

        const doc = await vscode.workspace.openTextDocument(
          planUpdatedReviewFileUri
        );
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `plan-updated-review.md generated with Copilot (${
            result.summary ?? ""
          })`
        );
      } else if (result.status === "cancelled") {
        void vscode.window.showInformationMessage(
          "Updated plan review cancelled."
        );
      } else {
        void vscode.window.showErrorMessage(
          `Updated plan review failed: ${
            result.errorMessage ?? "unknown error"
          }. Use the manual review workflow instead.`
        );
      }
    }
  );
}

/**
 * Register the reviewUpdatedPlanWithAI command
 */
export function registerReviewUpdatedPlanWithAICommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.reviewUpdatedPlanWithAI",
    () => reviewUpdatedPlanWithAI(context.extensionUri)
  );
  context.subscriptions.push(disposable);
}
