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
import {
  checkRunnerAvailabilityForModel,
  resolveRunnerForModel,
} from "../runners/runnerRegistry";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { TASK_FILENAME, TaskStage } from "../types/taskProgress";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { TaskInventory } from "../state/taskInventory";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { safeOpenTextDocument } from "../utils/fileUtils";

import {
  AutoTriggerMode,
  getAutoReviewAfterPlanMode,
  strongestAutoTriggerMode,
} from "../config/settings";
import { scheduleAutomationChain } from "../utils/automationChain";
import {
  linkCancellationTokens,
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
} from "../utils/taskOperations";

/**
 * Stages a task may be in for plan generation to be safe: either at the
 * task-description stage (first generation) or the plan stage (regeneration).
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["desc", "plan"];

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
  | {
      taskFolderPath?: string;
      /**
       * Carried only by automation-chain dispatches from "Complete & Move On
       * triggers AI: auto-fast-forward". A successful plan generation then
       * advances to Plan High-Level Review and runs the Fast Forward loop,
       * even when the standalone auto-review-after-plan setting is off or
       * plain "auto". Never set by UI surfaces.
       */
      followUpReviewMode?: "auto-fast-forward";
    };

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
): Promise<boolean | undefined> {
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
      NotificationRouter.showError(
        `Task with ID "${normalized.canonicalId}" not found. It may have been deleted or moved.`
      );
      return;
    }
  }

  if (!taskFolderUri) {
    return;
  }

  // The stage's own auto-review setting combined with a chained fast-forward
  // request from "Complete & Move On triggers AI: auto-fast-forward" —
  // whichever is stronger wins, so the chained request fires even when the
  // standalone setting is off, and a standalone "auto-fast-forward" is never
  // downgraded by a plain chained dispatch.
  const chainedReviewMode =
    arg && !(arg instanceof vscode.Uri) && "followUpReviewMode" in arg &&
    arg.followUpReviewMode === "auto-fast-forward"
      ? arg.followUpReviewMode
      : undefined;
  const effectiveReviewMode = strongestAutoTriggerMode(
    getAutoReviewAfterPlanMode(),
    chainedReviewMode
  );

  const lockKey = taskFolderUri.fsPath;
  const result = await runTrackedOperation(
    lockKey,
    { label: "Generate Plan", stage: "plan", kind: "generate-plan", cancellable: true },
    (op) =>
      generatePlanWithAIForResolvedTask(context, inventory, taskFolderUri, op, effectiveReviewMode)
  );
  if (!result) {
    // Refused (another operation holds this task's lock) — the busy warning
    // was already shown by runTrackedOperation.
    return;
  }

  // Dispatched through the automation-chain scheduler. This run's own lock
  // was already released above (runTrackedOperation returned), so no root
  // operation is passed and the follow-up runs immediately — but the chain
  // still goes through the single lock-safe dispatch point.
  if (result.triggerAutoReview && result.taskFolderPath) {
    // "auto-fast-forward" runs the review + fixes loop instead of a single
    // review pass.
    const command = effectiveReviewMode === "auto-fast-forward"
      ? "vs-code-ai-helper.fastForwardReviewWithAI"
      : "vs-code-ai-helper.runReviewWithAI";
    await scheduleAutomationChain({
      command,
      arg: { taskFolderPath: result.taskFolderPath },
      taskKey: result.taskFolderPath,
      chainId: "auto-review",
    });
  }

  return result.succeeded || undefined;
}

interface GeneratePlanResult {
  succeeded: boolean;
  triggerAutoReview: boolean;
  taskFolderPath?: string;
}

async function generatePlanWithAIForResolvedTask(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  taskFolderUri: vscode.Uri,
  op: TaskOperationHandle,
  /**
   * Effective follow-up review mode: the auto-review-after-plan setting
   * combined (strongest-wins) with any chained fast-forward request from
   * "Complete & Move On triggers AI". Anything other than "off" advances a
   * successful generation to Plan High-Level Review and asks the caller to
   * dispatch that review.
   */
  effectiveReviewMode: AutoTriggerMode
): Promise<GeneratePlanResult> {
  const model = await resolveFreshModelForStage(taskFolderUri, "plan");
  if (!model.modelId) {
    NotificationRouter.showWarning(
      "No model is configured for the Plan stage. Open Ensemble Settings and choose a primary model before continuing.",
      undefined,
      undefined,
      undefined,
      { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
    );
    return { succeeded: false, triggerAutoReview: false };
  }

  // A direct URI is not an ownership proof. Require the live inventory to
  // resolve it so this command cannot write into an unrelated workspace.
  const ownedTask = inventory.getTaskByPath(taskFolderUri.fsPath);
  if (!ownedTask) {
    NotificationRouter.showError("The selected task is not owned by this workspace.");
    return { succeeded: false, triggerAutoReview: false };
  }
  taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    NotificationRouter.showError("The selected task has no owning workspace.");
    return { succeeded: false, triggerAutoReview: false };
  }
  const { runner, nativeModelId } = resolveRunnerForModel(
    model.modelId, "plan", taskFolderUri
  );
  const { availability, providerLabel } = await checkRunnerAvailabilityForModel(
    model.modelId,
    "plan"
  );
  if (!availability.available) {
    NotificationRouter.showWarning(
      `${providerLabel} is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Use the manual planning workflow instead.`
    );
    return { succeeded: false, triggerAutoReview: false };
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
    NotificationRouter.showWarning(
      `${TASK_FILENAME} is empty. Describe the task before generating a plan.`
    );
    return { succeeded: false, triggerAutoReview: false };
  }

  // Build the context pack IN MEMORY — do NOT write context-pack.md yet.
  // The size gate below may abort or the user may decline; in either case
  // no on-disk artifact should be written for this run.
  const contextPackContent = await generateContextPack(
    taskFolderUri,
    workspaceFolderUri
  );

  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "create-plan.md",
    {
      contextPack: contextPackContent,
    }
  );

  // ── Prompt-size gate (BEFORE any artifact is written) ────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return { succeeded: false, triggerAutoReview: false };
  }

  // Size gate passed — persist the EXACT same context-pack content that was
  // assembled above (no second generation pass). This ensures context-pack.md
  // on disk is byte-for-byte identical to what was sent in the prompt, even
  // if open buffers change between the two calls.
  await writeContextPackContent(taskFolderUri, contextPackContent);

  let succeeded = false;
  let triggerAutoReview = false;

  // No overwrite confirmation — user has deliberately triggered regeneration
  await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Generating plan with ${providerLabel} (uses your ${providerLabel} quota)...`,
        cancellable: true,
      },
      async (progress, token) => {
        NotificationRouter.emitProgressSummary(
          `Generating plan with ${providerLabel}...`,
          taskOperations.rootOperationIdFor(taskFolderUri.fsPath)
        );
        const planFileUri = vscode.Uri.joinPath(taskFolderUri, "plan.md");

        progress.report({ message: `Waiting for ${providerLabel} response...` });

        // Cancellable from either surface: the native progress toast and the
        // Notifications-row cancel button both abort the same provider run.
        const linked = linkCancellationTokens(token, op.token);
        let result: Awaited<ReturnType<typeof runner.run>>;
        try {
          result = await runner.run(
            {
              taskFolderUri: taskFolderUri,
              workspaceUri: workspaceFolderUri,
              stage: "plan",
              prompt,
              outputFile: planFileUri,
              modelId: nativeModelId,
            },
            linked.token
          );
        } finally {
          linked.dispose();
        }

        const planLogUri = await writeRunLog(
          taskFolderUri,
          runner.id,
          "plan",
          `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
            result.summary ?? result.errorMessage ?? ""
          }`
        );
        op.setResultTargetUri(planLogUri);

        if (result.status === "completed") {
          // Use patchTaskProgress to preserve unrelated fields (e.g. implReviewFiles,
          // scheduled metadata, lint results) while updating the stage.
          // The destination stage must be persisted before its automatic
          // operation begins.  This keeps the tree/progress indicator and
          // review eligibility aligned with the operation actually running.
          const destinationStage: TaskStage = effectiveReviewMode !== "off"
            ? "plan-high-review"
            : "plan";
          await patchTaskProgress(taskFolderUri, (existing) => {
            if (!ELIGIBLE_STAGES.includes(existing.currentStage)) {
              return existing;
            }
            return updateTaskProgressStage(existing, destinationStage);
          });
          succeeded = true;

          await safeOpenTextDocument(planFileUri, "plan.md");
          NotificationRouter.showInformation(
            `plan.md generated with ${providerLabel} (${result.summary ?? ""})`
          );
          if (effectiveReviewMode !== "off") {
            // Deferred: the review command acquires this same task's
            // operation lock, which this run still holds until the
            // outer `finally` below runs. Trigger it from the caller
            // after that lock has been released instead of here.
            triggerAutoReview = true;
          }
        } else if (result.status === "cancelled") {
          NotificationRouter.showInformation(
            "Plan generation cancelled."
          );
        } else {
          NotificationRouter.showError(
            `Plan generation failed: ${
              result.errorMessage ?? "unknown error"
            }. Use the manual planning workflow instead.`
          );
        }
      }
    );
  return { succeeded, triggerAutoReview, taskFolderPath: taskFolderUri.fsPath };
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
