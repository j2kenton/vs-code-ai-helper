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
 * Stages a task may be in for plan review to be safe: either a plan
 * exists with no review yet, or the task is still at the plan-review
 * stage (regenerating plan-review.md in place). Later stages are
 * excluded so this command can never regress a task's progress or leave
 * stale downstream artifacts behind.
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["plan", "plan-review"];

/**
 * Generate plan-review.md for a task folder's plan.md using the user's
 * Copilot access. Falls back to informing the user when Copilot is
 * unavailable so the manual review workflow remains the fallback path.
 */
export async function reviewPlanWithAI(
  extensionUri: vscode.Uri
): Promise<void> {
  const taskFolderUri = await pickTaskFolder(
    "Review Plan with AI",
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

  const planFileUri = vscode.Uri.joinPath(taskFolderUri, "plan.md");
  let planContent: string;
  try {
    const content = await vscode.workspace.fs.readFile(planFileUri);
    planContent = new TextDecoder().decode(content).trim();
    if (planContent.length === 0) {
      throw new Error("empty");
    }
  } catch {
    void vscode.window.showWarningMessage(
      "No plan.md found (or it is empty) for this task. Generate a plan before requesting a review."
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

  const planReviewFileUriForCheck = vscode.Uri.joinPath(
    taskFolderUri,
    "plan-review.md"
  );
  const existingReviewContent = await readIfExists(
    planReviewFileUriForCheck
  );
  if (existingReviewContent && existingReviewContent.trim().length > 0) {
    const confirmation = await vscode.window.showWarningMessage(
      "plan-review.md already has content. Generating a new review will overwrite it.",
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
      title: "Reviewing plan with Copilot...",
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
        "review-plan.md",
        { contextPack: contextPackContent, plan: planContent }
      );

      const planReviewFileUri = vscode.Uri.joinPath(
        taskFolderUri,
        "plan-review.md"
      );

      progress.report({ message: "Waiting for Copilot response..." });

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: workspaceRoot.uri,
          stage: "plan-review",
          prompt,
          outputFile: planReviewFileUri,
        },
        token
      );

      await writeRunLog(
        taskFolderUri,
        runner.id,
        "plan-review",
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        const existing = await readTaskProgress(taskFolderUri);
        if (existing && ELIGIBLE_STAGES.includes(existing.currentStage)) {
          const updated = updateTaskProgressStage(existing, "plan-review");
          await writeTaskProgress(taskFolderUri, updated);
        }

        const doc = await vscode.workspace.openTextDocument(
          planReviewFileUri
        );
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `plan-review.md generated with Copilot (${result.summary ?? ""})`
        );
      } else if (result.status === "cancelled") {
        void vscode.window.showInformationMessage(
          "Plan review cancelled."
        );
      } else {
        void vscode.window.showErrorMessage(
          `Plan review failed: ${
            result.errorMessage ?? "unknown error"
          }. Use the manual review workflow instead.`
        );
      }
    }
  );
}

/**
 * Register the reviewPlanWithAI command
 */
export function registerReviewPlanWithAICommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.reviewPlanWithAI",
    () => reviewPlanWithAI(context.extensionUri)
  );
  context.subscriptions.push(disposable);
}
