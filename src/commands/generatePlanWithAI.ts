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
import { TASK_FILENAME, TaskStage } from "../types/taskProgress";

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
 * Stages a task may be in for plan generation to be safe: either no plan
 * exists yet, or the task is still at the initial plan stage (regenerating
 * plan.md in place). Later stages are excluded so this command can never
 * regress a task's progress or leave stale downstream artifacts behind.
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["created", "plan"];

/**
 * Generate plan.md for a task folder using the user's Copilot access.
 * Falls back to informing the user when Copilot is unavailable so the
 * manual planning workflow remains the fallback path.
 */
export async function generatePlanWithAI(
  extensionUri: vscode.Uri
): Promise<void> {
  const taskFolderUri = await pickTaskFolder(
    "Generate Plan with AI",
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

  const runner = new CopilotLanguageModelRunner();
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `Copilot is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Use the manual planning workflow (Start New Task / Resume Task) instead.`
    );
    return;
  }

  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  let taskContent: string;
  try {
    const content = await vscode.workspace.fs.readFile(taskFileUri);
    taskContent = new TextDecoder().decode(content).trim();
  } catch {
    taskContent = "";
  }
  if (taskContent.length === 0) {
    void vscode.window.showWarningMessage(
      `${TASK_FILENAME} is empty. Describe the task before generating a plan.`
    );
    return;
  }

  const planFileUriForCheck = vscode.Uri.joinPath(taskFolderUri, "plan.md");
  const existingPlanContent = await readIfExists(planFileUriForCheck);
  if (existingPlanContent && existingPlanContent.trim().length > 0) {
    const confirmation = await vscode.window.showWarningMessage(
      "plan.md already has content. Generating a new plan will overwrite it.",
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
      title: "Generating plan with Copilot...",
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
        "create-plan.md",
        { contextPack: contextPackContent }
      );

      const planFileUri = vscode.Uri.joinPath(taskFolderUri, "plan.md");

      progress.report({ message: "Waiting for Copilot response..." });

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: workspaceRoot.uri,
          stage: "plan",
          prompt,
          outputFile: planFileUri,
        },
        token
      );

      await writeRunLog(
        taskFolderUri,
        runner.id,
        "plan",
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        const existing = await readTaskProgress(taskFolderUri);
        if (existing && ELIGIBLE_STAGES.includes(existing.currentStage)) {
          const updated = updateTaskProgressStage(existing, "plan");
          await writeTaskProgress(taskFolderUri, updated);
        }

        const doc = await vscode.workspace.openTextDocument(planFileUri);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `plan.md generated with Copilot (${result.summary ?? ""})`
        );
      } else if (result.status === "cancelled") {
        void vscode.window.showInformationMessage(
          "Plan generation cancelled."
        );
      } else {
        void vscode.window.showErrorMessage(
          `Plan generation failed: ${
            result.errorMessage ?? "unknown error"
          }. Use the manual planning workflow instead.`
        );
      }
    }
  );
}

/**
 * Register the generatePlanWithAI command
 */
export function registerGeneratePlanWithAICommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.generatePlanWithAI",
    () => generatePlanWithAI(context.extensionUri)
  );
  context.subscriptions.push(disposable);
}
