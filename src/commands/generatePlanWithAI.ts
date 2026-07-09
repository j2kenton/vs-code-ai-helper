import * as vscode from "vscode";
import {
  patchTaskProgress,
  updateTaskProgressStage,
} from "../utils/taskProgressUtils";
import {
  generateContextPack,
  writeContextPackContent,
} from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { pickTaskFolder } from "../utils/pickTaskFolder";
import { resolveRunnerForModel } from "../runners/runnerRegistry";
import { resolveModelForStage } from "../utils/modelSelection";
import { TASK_FILENAME, TaskStage } from "../types/taskProgress";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { TaskInventory } from "../state/taskInventory";
import { IncompleteTask } from "../utils/taskProgressUtils";

/**
 * Stages a task may be in for plan generation to be safe: either at the
 * task-description stage (first generation) or the plan stage (regeneration).
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["task-description", "plan"];

/**
 * Accepted argument shapes for generatePlanWithAI.
 *
 * Commands may be invoked from:
 *   - Tree stage-row buttons: the tree node itself, which has `.task: IncompleteTask`
 *     and `.stage: TaskStage` (StageNode shape)
 *   - Tree task-row buttons / IncompleteTask wrappers: `{ task: IncompleteTask }`
 *   - Keyboard shortcut router: `{ canonicalId?: string }`
 *   - Legacy direct URI (kept for backward compat): vscode.Uri
 *   - Command palette (no arg): undefined
 */
type GeneratePlanArg =
  | vscode.Uri
  | { canonicalId?: string }
  | { task?: IncompleteTask }
  | { taskFolderPath?: string };

/**
 * Normalize a GeneratePlanArg into a resolved value for the caller to act on.
 *
 * Returns:
 *   - A `vscode.Uri` when the target folder is unambiguously resolved
 *     (direct Uri, `{ task }` shape, or `{ taskFolderPath }` shape).
 *   - `{ canonicalId: string }` sentinel when the arg carries only a canonical
 *     ID that was not found in the inventory — the caller must fail clearly
 *     rather than silently opening a folder picker.
 *   - `undefined` to fall through to the user folder picker (no arg, empty
 *     object, or `{ task: undefined }`).
 *
 * @internal exported for testing
 */
export function normalizeGeneratePlanArg(
  arg: GeneratePlanArg | undefined,
  inventory: TaskInventory
): vscode.Uri | { canonicalId: string } | undefined {
  if (!arg) {
    return undefined;
  }

  // Direct URI (legacy shape, e.g. right-click in explorer)
  if (arg instanceof vscode.Uri) {
    return arg;
  }

  // Tree stage-row shape: StageNode has `.task: IncompleteTask`
  if ("task" in arg && arg.task) {
    return arg.task.folderUri;
  }

  // Explicit folder path (e.g. from applyHighLevelReviewChanges delegation)
  if ("taskFolderPath" in arg && arg.taskFolderPath) {
    return vscode.Uri.file(arg.taskFolderPath);
  }

  // Canonical ID — resolve via inventory
  if ("canonicalId" in arg && arg.canonicalId) {
    const task = inventory.getTaskById(arg.canonicalId);
    if (task) {
      return vscode.Uri.file(task.taskFolderPath);
    }
    // Return a sentinel so the caller can report the failure rather than
    // silently falling through to the folder picker.
    return { canonicalId: arg.canonicalId };
  }

  return undefined;
}

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
  inventory: TaskInventory,
  arg?: GeneratePlanArg
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

  // Resolve the target task folder URI from the argument.
  let taskFolderUri: vscode.Uri | undefined;

  const normalized = normalizeGeneratePlanArg(arg, inventory);

  if (normalized === undefined) {
    // No arg or unresolvable arg — prompt user to pick
    taskFolderUri = await pickTaskFolder("Generate Plan with AI", ELIGIBLE_STAGES);
  } else if (normalized instanceof vscode.Uri) {
    taskFolderUri = normalized;
  } else {
    // Sentinel: canonicalId was provided but not found in the inventory.
    // After a refresh attempt the inventory still doesn't know this task —
    // fail clearly rather than silently acting on a different task.
    await inventory.refresh();
    const retried = inventory.getTaskById(normalized.canonicalId);
    if (retried) {
      taskFolderUri = vscode.Uri.file(retried.taskFolderPath);
    } else {
      void vscode.window.showErrorMessage(
        `Task with ID "${normalized.canonicalId}" not found. It may have been deleted or moved.`
      );
      return;
    }
  }

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

  // Build the context pack IN MEMORY — do NOT write context-pack.md yet.
  // The size gate below may abort or the user may decline; in either case
  // no on-disk artifact should be written for this run.
  const contextPackContent = await generateContextPack(
    taskFolderUri,
    workspaceRoot.uri
  );

  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "create-plan.md",
    { contextPack: contextPackContent }
  );

  // ── Prompt-size gate (BEFORE any artifact is written) ────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return;
  }

  // Size gate passed — persist the EXACT same context-pack content that was
  // assembled above (no second generation pass). This ensures context-pack.md
  // on disk is byte-for-byte identical to what was sent in the prompt, even
  // if open buffers change between the two calls.
  await writeContextPackContent(taskFolderUri, contextPackContent);

  // No overwrite confirmation — user has deliberately triggered regeneration
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating plan with ${providerLabel} (uses your ${providerLabel} quota)...`,
      cancellable: true,
    },
    async (progress, token) => {
      const planFileUri = vscode.Uri.joinPath(taskFolderUri!, "plan.md");

      progress.report({ message: `Waiting for ${providerLabel} response...` });

      const result = await runner.run(
        {
          taskFolderUri: taskFolderUri!,
          workspaceUri: workspaceRoot.uri,
          stage: "plan",
          prompt,
          outputFile: planFileUri,
          modelId: nativeModelId,
        },
        token
      );

      await writeRunLog(
        taskFolderUri!,
        runner.id,
        "plan",
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        // Use patchTaskProgress to preserve unrelated fields (e.g. implReviewFiles,
        // scheduled metadata, lint results) while updating the stage.
        await patchTaskProgress(taskFolderUri!, (existing) => {
          if (!ELIGIBLE_STAGES.includes(existing.currentStage)) {
            return existing;
          }
          return updateTaskProgressStage(existing, "plan");
        });

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
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.generatePlanWithAI",
    (arg?: GeneratePlanArg) =>
      generatePlanWithAI(context, inventory, arg)
  );
  context.subscriptions.push(disposable);
}
