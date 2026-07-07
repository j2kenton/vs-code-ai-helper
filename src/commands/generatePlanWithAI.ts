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
import { resolveRunnerForModel } from "../runners/runnerRegistry";
import { resolveModelForStage } from "../utils/modelSelection";
import { TASK_FILENAME, TaskStage } from "../types/taskProgress";
import { ensureAiConsent } from "../utils/aiConsent";

/**
 * Stages a task may be in for plan generation to be safe: either at the
 * task-description stage (first generation) or the plan stage (regeneration).
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["task-description", "plan"];

/**
 * Generate plan.md for a task folder using the user's Copilot access.
 * No overwrite confirmation is shown since the user has already triggered
 * this action deliberately.
 *
 * When `targetFolderUri` is given (e.g. right after creating or resuming a
 * specific task), that task is used directly instead of prompting the user
 * to pick one.
 *
 * Requires first-use consent (ensureAiConsent) before any provider is
 * launched or any file is written.
 */
export async function generatePlanWithAI(
  context: vscode.ExtensionContext,
  targetFolderUri?: vscode.Uri
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const taskFolderUri =
    targetFolderUri ??
    (await pickTaskFolder("Generate Plan with AI", ELIGIBLE_STAGES));
  if (!taskFolderUri) {
    return;
  }

  const model = await resolveModelForStage(taskFolderUri, "plan");
  const { runner, providerLabel, nativeModelId } = await resolveRunnerForModel(
    model.modelId
  );
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `${providerLabel} is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Use the manual planning workflow instead.`
    );
    return;
  }

  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  let taskContent: string;
  try {
    // Prefer open document buffer for unsaved changes
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === taskFileUri.toString()
    );
    if (openDoc) {
      taskContent = openDoc.getText().trim();
    } else {
      const content = await vscode.workspace.fs.readFile(taskFileUri);
      taskContent = new TextDecoder().decode(content).trim();
    }
  } catch {
    taskContent = "";
  }
  if (taskContent.length === 0) {
    void vscode.window.showWarningMessage(
      `${TASK_FILENAME} is empty. Describe the task before generating a plan.`
    );
    return;
  }

  // No overwrite confirmation — user has deliberately triggered regeneration
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating plan with ${providerLabel} (uses your ${providerLabel} quota)...`,
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
        context.extensionUri,
        "create-plan.md",
        { contextPack: contextPackContent }
      );

      const planFileUri = vscode.Uri.joinPath(taskFolderUri, "plan.md");

      progress.report({ message: `Waiting for ${providerLabel} response...` });

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: workspaceRoot.uri,
          stage: "plan",
          prompt,
          outputFile: planFileUri,
          modelId: nativeModelId,
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
        // Persist stage as "plan" (generation stage, not review stage)
        const existing = await readTaskProgress(taskFolderUri);
        if (existing && ELIGIBLE_STAGES.includes(existing.currentStage)) {
          const updated = updateTaskProgressStage(existing, "plan");
          await writeTaskProgress(taskFolderUri, updated);
        }

        const doc = await vscode.workspace.openTextDocument(planFileUri);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `plan.md generated with ${providerLabel} (${result.summary ?? ""})`
        );
        // Do NOT auto-trigger review here — user advances stage manually
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
    (targetFolderUri?: vscode.Uri) =>
      generatePlanWithAI(context, targetFolderUri)
  );
  context.subscriptions.push(disposable);
}
