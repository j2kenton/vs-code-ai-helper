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
 * Stages a task may be in for plan update to be safe: either a review
 * exists with no update yet, or the task is still at the plan-updated
 * stage (regenerating plan-updated.md in place). Later stages are
 * excluded so this command can never regress a task's progress or leave
 * stale downstream artifacts behind.
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["plan-review", "plan-updated"];

/**
 * Generate plan-updated.md for a task folder's plan.md and
 * plan-review.md using the user's Copilot access. Falls back to
 * informing the user when Copilot is unavailable so the manual update
 * workflow remains the fallback path.
 */
export async function updatePlanWithAI(
  extensionUri: vscode.Uri
): Promise<void> {
  const taskFolderUri = await pickTaskFolder(
    "Update Plan with AI",
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
      "No plan.md found (or it is empty) for this task. Generate a plan before requesting an update."
    );
    return;
  }

  const planReviewFileUri = vscode.Uri.joinPath(
    taskFolderUri,
    "plan-review.md"
  );
  let planReviewContent: string;
  try {
    const content = await vscode.workspace.fs.readFile(planReviewFileUri);
    planReviewContent = new TextDecoder().decode(content).trim();
    if (planReviewContent.length === 0) {
      throw new Error("empty");
    }
  } catch {
    void vscode.window.showWarningMessage(
      "No plan-review.md found (or it is empty) for this task. Review the plan before requesting an update."
    );
    return;
  }

  const runner = new CopilotLanguageModelRunner();
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `Copilot is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Use the manual update workflow (Start New Task / Resume Task) instead.`
    );
    return;
  }

  const planUpdatedFileUriForCheck = vscode.Uri.joinPath(
    taskFolderUri,
    "plan-updated.md"
  );
  const existingUpdatedContent = await readIfExists(
    planUpdatedFileUriForCheck
  );
  if (existingUpdatedContent && existingUpdatedContent.trim().length > 0) {
    const confirmation = await vscode.window.showWarningMessage(
      "plan-updated.md already has content. Generating a new update will overwrite it.",
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
      title: "Updating plan with Copilot...",
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
        "update-plan.md",
        {
          contextPack: contextPackContent,
          plan: planContent,
          planReview: planReviewContent,
        }
      );

      const planUpdatedFileUri = vscode.Uri.joinPath(
        taskFolderUri,
        "plan-updated.md"
      );

      progress.report({ message: "Waiting for Copilot response..." });

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: workspaceRoot.uri,
          stage: "plan-updated",
          prompt,
          outputFile: planUpdatedFileUri,
        },
        token
      );

      await writeRunLog(
        taskFolderUri,
        runner.id,
        "plan-updated",
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        const existing = await readTaskProgress(taskFolderUri);
        if (existing && ELIGIBLE_STAGES.includes(existing.currentStage)) {
          const updated = updateTaskProgressStage(existing, "plan-updated");
          await writeTaskProgress(taskFolderUri, updated);
        }

        const doc = await vscode.workspace.openTextDocument(
          planUpdatedFileUri
        );
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `plan-updated.md generated with Copilot (${result.summary ?? ""})`
        );
      } else if (result.status === "cancelled") {
        void vscode.window.showInformationMessage("Plan update cancelled.");
      } else {
        void vscode.window.showErrorMessage(
          `Plan update failed: ${
            result.errorMessage ?? "unknown error"
          }. Use the manual update workflow instead.`
        );
      }
    }
  );
}

/**
 * Register the updatePlanWithAI command
 */
export function registerUpdatePlanWithAICommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.updatePlanWithAI",
    () => updatePlanWithAI(context.extensionUri)
  );
  context.subscriptions.push(disposable);
}
