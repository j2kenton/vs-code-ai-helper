import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  isPlanReviewStage,
  isReviewStage,
  PLAN_FILENAME,
  REVIEW_STAGES,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import {
  findAllTasks,
  IncompleteTask,
  readTaskProgress,
  updateImplReviewFiles,
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import {
  openOrCreateDocument,
  readNonEmptyText,
  resolveCurrentPlanUri,
  statIfExists,
  writeTextFile,
} from "../utils/fileUtils";
import { generateContextPack, writeContextPack, writeImplReviewContextPack } from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import {
  checkImplementationAvailabilityForModel,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import { resolveModelForStage } from "../utils/modelSelection";
import {
  getCanonicalImplementationUri,
  resolveImplementationArtifact,
  materializeCanonicalIfNeeded,
} from "../utils/implementationArtifactResolver";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import * as cp from "child_process";

/**
 * The optional argument tree-view buttons pass to these commands: the tree
 * node carries the task it was rendered for.
 */
export interface TaskNodeArg {
  task?: IncompleteTask;
}

interface ResolvedTask {
  folderUri: vscode.Uri;
  progress: NonNullable<Awaited<ReturnType<typeof readTaskProgress>>>;
}

/**
 * Resolve which task a command should act on: the tree node's task when
 * invoked from the view, otherwise a QuickPick over tasks whose current
 * stage is eligible. Progress is always re-read from disk so a stale tree
 * node can't act on outdated stage information.
 */
async function resolveTask(
  node: TaskNodeArg | undefined,
  eligibleStages: readonly TaskStage[],
  title: string
): Promise<ResolvedTask | undefined> {
  if (node?.task) {
    const folderUri = node.task.folderUri;
    const progress = await readTaskProgress(folderUri);
    if (!progress) {
      void vscode.window.showErrorMessage(
        `Could not read task progress for ${node.task.folderName}.`
      );
      return undefined;
    }
    if (!eligibleStages.includes(progress.currentStage)) {
      void vscode.window.showWarningMessage(
        `${node.task.folderName} is at stage "${
          STAGE_DISPLAY_NAMES[progress.currentStage]
        }", which this action doesn't apply to.`
      );
      return undefined;
    }
    return { folderUri, progress };
  }

  // Fall back to discovering tasks from the configured meta folder
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  // Attempt to discover tasks using the configured path, or .helper/plans default
  let metaFolderUri: vscode.Uri;
  if (hasValidMetaResourcesPath()) {
    metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, getMetaResourcesPath());
  } else {
    metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, ".helper/plans");
  }

  const allTasks = await findAllTasks(metaFolderUri);

  // Also check legacy plans/ folder if different
  let legacyTasks: IncompleteTask[] = [];
  try {
    const legacyUri = vscode.Uri.joinPath(workspaceRoot.uri, "plans");
    if (legacyUri.fsPath !== metaFolderUri.fsPath) {
      legacyTasks = await findAllTasks(legacyUri);
    }
  } catch {
    // Ignore errors reading legacy folder
  }

  const combinedTasks = [...allTasks, ...legacyTasks];

  const eligible = combinedTasks.filter((task) =>
    eligibleStages.includes(task.progress.currentStage)
  );
  if (eligible.length === 0) {
    void vscode.window.showInformationMessage(
      combinedTasks.length === 0
        ? "No task folders found. Use 'Start New Task' to create one."
        : "No tasks are at a stage eligible for this action."
    );
    return undefined;
  }

  let picked: IncompleteTask | undefined;
  if (eligible.length === 1) {
    picked = eligible[0];
  } else {
    const items = eligible.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      task,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a task",
      title,
    });
    picked = selected?.task;
  }
  if (!picked) {
    return undefined;
  }
  return { folderUri: picked.folderUri, progress: picked.progress };
}

function getWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function artifactUri(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): vscode.Uri | undefined {
  const name = STAGE_ARTIFACT_FILENAMES[stage];
  return name ? vscode.Uri.joinPath(taskFolderUri, name) : undefined;
}

/**
 * Check if the workspace is inside a git repository.
 * Returns true when git is available and the path is inside a repo.
 */
async function isGitWorkspace(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

/**
 * Check if the workspace has uncommitted changes (dirty state).
 * Returns true when git reports any modified/untracked files.
 */
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["status", "--porcelain"],
      { cwd, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(false); return; }
        resolve(stdout.trim().length > 0);
      }
    );
  });
}

/**
 * Shared boilerplate for every AI command: availability check, progress
 * notification, prompt render, run, run log, result handling. Returns true
 * when the run completed successfully.
 *
 * Applies the prompt-size gate (high-context confirm + hard ceiling) before
 * launching the provider process. The prompt is built here so its size is
 * measured on the exact string that will be sent.
 */
async function runAiToFile(options: {
  extensionUri: vscode.Uri;
  taskFolderUri: vscode.Uri;
  workspaceUri: vscode.Uri;
  logStage: TaskStage;
  templateFile: string;
  variables: Record<string, string>;
  outputFileUri: vscode.Uri;
  /** e.g. "Running Plan: High-Level Review" — provider name is appended. */
  progressAction: string;
  outputLabel: string;
}): Promise<boolean> {
  const model = await resolveModelForStage(
    options.taskFolderUri,
    options.logStage
  );
  const { runner, providerLabel, nativeModelId } = await resolveRunnerForModel(
    model.modelId
  );
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `${providerLabel} is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Write ${options.outputLabel} manually instead.`
    );
    return false;
  }

  // Build the prompt here so we can apply the size gate before launching.
  const prompt = await renderPromptTemplate(
    options.extensionUri,
    options.templateFile,
    options.variables
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return false;
  }

  let completed = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${options.progressAction} with ${providerLabel} (uses your ${providerLabel} quota)...`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: `Waiting for ${providerLabel} response...` });

      const result = await runner.run(
        {
          taskFolderUri: options.taskFolderUri,
          workspaceUri: options.workspaceUri,
          stage: options.logStage,
          prompt,
          outputFile: options.outputFileUri,
          modelId: nativeModelId,
        },
        token
      );

      await writeRunLog(
        options.taskFolderUri,
        runner.id,
        options.logStage,
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        completed = true;
        const doc = await vscode.workspace.openTextDocument(
          options.outputFileUri
        );
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          `${options.outputLabel} generated with ${providerLabel} (${
            result.summary ?? ""
          })`
        );
      } else if (result.status === "cancelled") {
        void vscode.window.showInformationMessage(
          `${options.outputLabel} generation cancelled.`
        );
      } else {
        void vscode.window.showErrorMessage(
          `${options.outputLabel} generation failed: ${
            result.errorMessage ?? "unknown error"
          }.`
        );
      }
    }
  );
  return completed;
}

async function setStage(
  folderUri: vscode.Uri,
  newStage: TaskStage
): Promise<void> {
  const progress = await readTaskProgress(folderUri);
  if (progress && progress.currentStage !== newStage) {
    await writeTaskProgress(
      folderUri,
      updateTaskProgressStage(progress, newStage)
    );
  }
}

/** Stages from which a review can be run, mapped to the review it produces */
const REVIEW_TARGETS: Partial<Record<TaskStage, TaskStage>> = {
  plan: "plan-high-review",
  "plan-high-review": "plan-high-review",
  "plan-low-review": "plan-low-review",
  implementation: "impl-high-review",
  "impl-high-review": "impl-high-review",
  "impl-low-review": "impl-low-review",
};

const REVIEW_PROMPTS: Partial<Record<TaskStage, string>> = {
  "plan-high-review": "review-plan-high.md",
  "plan-low-review": "review-plan-low.md",
  "impl-high-review": "review-impl-high.md",
  "impl-low-review": "review-impl-low.md",
};

/**
 * Core review logic for a known task folder: build variables, run the AI
 * review for the given stage, and advance the task to the review stage.
 * Called by runReviewWithAI (user-invoked) and by nextStage for auto-triggered reviews.
 *
 * Review commands are stage-neutral: they do NOT change currentStage.
 * Stage advancement is handled by nextStage/setTaskStage exclusively.
 *
 * No overwrite confirmation is shown (user has already triggered this deliberately).
 *
 * NOTE: Consent is checked at the entry-point level (runReviewWithAI,
 * applyReviewWithAI, etc.) — not here — so internal chaining (nextStage →
 * runReviewForFolder) does not re-prompt.
 *
 * The prompt-size gate IS applied here (via runAiToFile) since this is
 * where the final prompt string is assembled.
 */
export async function runReviewForFolder(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  currentStage: TaskStage,
  _skipOverwriteConfirmation: boolean  // kept for API compat, always skipped now
): Promise<void> {
  const targetStage = REVIEW_TARGETS[currentStage];
  const templateFile = targetStage && REVIEW_PROMPTS[targetStage];
  const reviewUri = targetStage && artifactUri(folderUri, targetStage);
  if (!targetStage || !templateFile || !reviewUri) {
    return;
  }

  const variables: Record<string, string> = {};
  const isPlanReview = isPlanReviewStage(targetStage);

  if (isPlanReview) {
    const planUri = await resolveCurrentPlanUri(folderUri);
    const planContent = await readNonEmptyText(planUri);
    if (!planContent) {
      void vscode.window.showWarningMessage(
        "No plan found (or it is empty). Generate or write a plan first."
      );
      return;
    }
    variables.plan = planContent;
  } else {
    // Implementation reviews use the canonical plan-final.md artifact
    const canonicalImpl = getCanonicalImplementationUri(folderUri);
    const planFinalContent = await readNonEmptyText(canonicalImpl);
    if (!planFinalContent) {
      void vscode.window.showWarningMessage(
        "No plan-final.md found. Finalize a plan before reviewing implementation."
      );
      return;
    }
    const implementationContent = await readNonEmptyText(canonicalImpl);
    if (!implementationContent) {
      void vscode.window.showWarningMessage(
        "No implementation artifact found. Generate the implementation first."
      );
      return;
    }
    variables.plan = planFinalContent;
    variables.implementation = implementationContent;
  }

  let contextPackContent: string;
  if (isPlanReview) {
    const contextPackUri = await writeContextPack(folderUri, workspaceRoot.uri, false);
    contextPackContent = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(contextPackUri)
    );
  } else {
    const taskProgress = await readTaskProgress(folderUri);
    const { contextPackUri, isFallback } = await writeImplReviewContextPack(
      folderUri,
      workspaceRoot.uri,
      taskProgress?.implReviewFiles
    );
    if (isFallback) {
      void vscode.window.showWarningMessage(
        "No tracked implementation file set found for this task. " +
          "The review will be based on currently open editors. " +
          "For best results, open the files you changed before running the review."
      );
    }
    contextPackContent = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(contextPackUri)
    );
  }
  variables.contextPack = contextPackContent;

  // Review commands do NOT change currentStage — stage changes are
  // handled by nextStage/setTaskStage exclusively.
  await runAiToFile({
    extensionUri,
    taskFolderUri: folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: targetStage,
    templateFile,
    variables,
    outputFileUri: reviewUri,
    progressAction: `Re-reviewing ${STAGE_DISPLAY_NAMES[targetStage]}`,
    outputLabel: STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review",
  });
  // Note: we do NOT call setStage here.
}

/**
 * Run (or re-run) the review for the task's current position in the
 * workflow. Labeled "Re-review" in the UI.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function runReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  node?: TaskNodeArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
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

  const resolved = await resolveTask(
    node,
    Object.keys(REVIEW_TARGETS) as TaskStage[],
    "Re-review with AI"
  );
  if (!resolved) {
    return;
  }
  await runReviewForFolder(
    extensionUri,
    resolved.folderUri,
    workspaceRoot,
    resolved.progress.currentStage,
    true
  );
}

/**
 * Apply the current review: for plan review stages the AI rewrites the plan
 * in place; for implementation review stages it re-runs the AI
 * implementation against the codebase to address the review's findings.
 * The stage does not change — re-run the review or move to the next stage explicitly.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function applyReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  node?: TaskNodeArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
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

  const resolved = await resolveTask(node, REVIEW_STAGES, "Apply Review with AI");
  if (!resolved) {
    return;
  }

  const stage = resolved.progress.currentStage;
  const reviewUri = artifactUri(resolved.folderUri, stage);
  const reviewContent = reviewUri && (await readNonEmptyText(reviewUri));
  if (!reviewContent) {
    void vscode.window.showWarningMessage(
      "No review found (or it is empty). Run the review before applying it."
    );
    return;
  }

  const isPlanReview = isPlanReviewStage(stage);

  if (!isPlanReview) {
    await applyImplementationReviewWithAI(
      extensionUri,
      resolved.folderUri,
      workspaceRoot,
      stage,
      reviewContent
    );
    return;
  }

  const variables: Record<string, string> = {
    review: reviewContent,
  };

  const currentPlanUri = await resolveCurrentPlanUri(resolved.folderUri);
  const planContent = await readNonEmptyText(currentPlanUri);
  if (!planContent) {
    void vscode.window.showWarningMessage(
      "No plan found (or it is empty). Nothing to apply the review to."
    );
    return;
  }
  variables.plan = planContent;
  const contextPackUri = await writeContextPack(
    resolved.folderUri,
    workspaceRoot.uri
  );
  variables.contextPack = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(contextPackUri)
  );
  // Always write to the canonical plan.md
  const outputFileUri = vscode.Uri.joinPath(resolved.folderUri, PLAN_FILENAME);
  const templateFile = "apply-review.md";
  const outputLabel = PLAN_FILENAME;

  // No overwrite confirmation — user triggered this deliberately
  // (prompt-size gate is inside runAiToFile)
  const applySucceeded = await runAiToFile({
    extensionUri,
    taskFolderUri: resolved.folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: stage,
    templateFile,
    variables,
    outputFileUri,
    progressAction: `Applying review to ${outputLabel}`,
    outputLabel,
  });

  if (applySucceeded) {
    // Re-review after applying (no confirmation, no stage change)
    await runReviewForFolder(extensionUri, resolved.folderUri, workspaceRoot, stage, true);
  }
}

/**
 * Apply an implementation review by re-running the AI implementation
 * runner against the review's findings.
 */
async function applyImplementationReviewWithAI(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  stage: TaskStage,
  reviewContent: string
): Promise<void> {
  const canonicalUri = getCanonicalImplementationUri(folderUri);
  const planFinalContent = await readNonEmptyText(canonicalUri);
  if (!planFinalContent) {
    void vscode.window.showWarningMessage(
      "No plan-final.md found. Nothing to apply the review to."
    );
    return;
  }

  // Use the implementation stage's model, not the review stage's
  const model = await resolveModelForStage(folderUri, "implementation");

  const { availability, providerLabel } =
    await checkImplementationAvailabilityForModel(model.modelId);
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}. Address the review manually instead.`
    );
    return;
  }

  const contextPackContent = await generateContextPack(folderUri, workspaceRoot.uri);

  const prompt = await renderPromptTemplate(
    extensionUri,
    "apply-impl-review-code.md",
    {
      contextPack: contextPackContent,
      plan: planFinalContent,
      review: reviewContent,
    }
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return;
  }

  await executeImplementationRun(
    extensionUri,
    folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    `Applying implementation review with ${providerLabel}...`,
    stage
  );
}

/**
 * Open the review artifact for the task's current review stage.
 */
export async function viewReview(node?: TaskNodeArg): Promise<void> {
  const resolved = await resolveTask(node, REVIEW_STAGES, "View Review");
  if (!resolved) {
    return;
  }
  const stage = resolved.progress.currentStage;
  const reviewUri = artifactUri(resolved.folderUri, stage);
  if (!reviewUri) {
    return;
  }
  const content = await readNonEmptyText(reviewUri);
  if (!content) {
    const choice = await vscode.window.showInformationMessage(
      `No ${STAGE_ARTIFACT_FILENAMES[stage]} yet for this task.`,
      "Re-review with AI",
      "Create Manually"
    );
    if (choice === "Re-review with AI") {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.runReviewWithAI",
        node
      );
    } else if (choice === "Create Manually") {
      await openOrCreateDocument(reviewUri);
    }
    return;
  }
  const doc = await vscode.workspace.openTextDocument(reviewUri);
  await vscode.window.showTextDocument(doc);
}

/**
 * Whether the artifact for a task's current stage exists and has content.
 */
async function currentStageArtifactExists(
  folderUri: vscode.Uri,
  stage: TaskStage
): Promise<boolean> {
  if (isReviewStage(stage)) {
    return true;
  }
  const name = STAGE_ARTIFACT_FILENAMES[stage];
  if (!name) {
    return true;
  }
  // For implementation stage use the artifact resolver
  if (stage === "implementation") {
    const resolved = await resolveImplementationArtifact(folderUri);
    const stat = await statIfExists(resolved.uri);
    return stat !== undefined;
  }
  const content = await readNonEmptyText(
    vscode.Uri.joinPath(folderUri, name)
  );
  return content !== undefined;
}

/**
 * Advance a task to the next stage in the workflow.
 * Auto-triggers review when advancing into a review stage from its
 * immediately preceding non-review stage (plan -> plan-high-review, or
 * plan-low-review being re-entered).
 * No confirmation dialogs.
 *
 * When auto-triggering review, this command delegates to the registered
 * runReviewWithAI command (which has access to extensionUri via closure).
 *
 * NOTE: When auto-triggering review via runReviewForFolder, consent was
 * already obtained earlier in the user-initiated flow that called nextStage.
 * The auto-triggered review does NOT re-prompt for consent.
 */
export async function nextStage(
  extensionUri: vscode.Uri,
  node?: TaskNodeArg
): Promise<void> {
  const advanceable = STAGE_ORDER.filter((stage) => stage !== "completed");
  const resolved = await resolveTask(node, advanceable, "Next Stage");
  if (!resolved) {
    return;
  }

  const currentIndex = STAGE_ORDER.indexOf(resolved.progress.currentStage);
  const next = STAGE_ORDER[currentIndex + 1];
  if (!next) {
    return;
  }

  // Check artifact existence for non-review stages
  if (
    !(await currentStageArtifactExists(
      resolved.folderUri,
      resolved.progress.currentStage
    ))
  ) {
    const artifactName =
      STAGE_ARTIFACT_FILENAMES[resolved.progress.currentStage];
    void vscode.window.showWarningMessage(
      `${artifactName ?? "The current stage's artifact"} hasn't been created yet. ` +
        `Write or generate it before advancing.`
    );
    return;
  }

  // Special handling for advancing into "implementation" stage:
  // copy the current plan to plan-final.md if not already there
  if (next === "implementation") {
    const resolved2 = await resolveImplementationArtifact(resolved.folderUri);
    if (!resolved2.isCanonical) {
      // Plan-final.md doesn't exist yet — copy current plan
      const currentPlanUri = await resolveCurrentPlanUri(resolved.folderUri);
      const planContent = await readNonEmptyText(currentPlanUri);
      if (!planContent) {
        void vscode.window.showWarningMessage(
          "No plan to promote. Write or generate a plan first."
        );
        return;
      }
      const canonicalUri = vscode.Uri.joinPath(resolved.folderUri, "plan-final.md");
      await vscode.workspace.fs.writeFile(
        canonicalUri,
        new TextEncoder().encode(planContent)
      );
    }
  }

  // Persist stage advance FIRST so auto-review reads the correct current stage
  await setStage(resolved.folderUri, next);
  void vscode.window.showInformationMessage(
    `${resolved.progress.taskFolder} advanced to: ${STAGE_DISPLAY_NAMES[next]}`
  );

  // Auto-trigger review only when advancing INTO a review stage from the
  // correct immediately-preceding source stage. Pass triggerAutoReview: false
  // implicitly by calling the review directly with a specific node arg so it
  // does not loop back here.
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }

  // Only auto-trigger plan-high-review when coming from "plan" stage, and
  // only auto-trigger plan-low-review when re-entering it.
  const shouldAutoReview =
    resolved.progress.status !== "paused" &&
    isReviewStage(next) &&
    REVIEW_TARGETS[resolved.progress.currentStage] === next;

  if (shouldAutoReview) {
    // Re-read progress to get the newly persisted stage
    const freshProgress = await readTaskProgress(resolved.folderUri);
    if (freshProgress) {
      // Bypass the consent gate for auto-triggered reviews — consent was
      // already given by the user action that triggered nextStage.
      await runReviewForFolder(
        extensionUri,
        resolved.folderUri,
        workspaceRoot,
        freshProgress.currentStage,
        true
      );
    }
  }
}

/**
 * Generate plan-final.md (Implementation stage) from a task.
 * This is the "Generate implementation" action for the merged Implementation stage.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function generateImplementationWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  node?: TaskNodeArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
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

  const resolved = await resolveTask(
    node,
    ["plan-low-review", "implementation"],
    "Generate Implementation with AI"
  );
  if (!resolved) {
    return;
  }

  const planFinalUri = getCanonicalImplementationUri(resolved.folderUri);
  const planFinalContent = await readNonEmptyText(planFinalUri);
  if (!planFinalContent) {
    void vscode.window.showWarningMessage(
      "No plan-final.md found. Advance to the Implementation stage first."
    );
    return;
  }

  const contextPackContent = await generateContextPack(
    resolved.folderUri,
    workspaceRoot.uri
  );

  const implementationUri = planFinalUri;
  // No overwrite confirmation
  // (prompt-size gate is inside runAiToFile)
  const succeeded = await runAiToFile({
    extensionUri,
    taskFolderUri: resolved.folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: "implementation",
    templateFile: "create-implementation.md",
    variables: { contextPack: contextPackContent, plan: planFinalContent },
    outputFileUri: implementationUri,
    progressAction: "Generating implementation",
    outputLabel: "plan-final.md",
  });

  if (succeeded) {
    await setStage(resolved.folderUri, "implementation");
  }
}

/**
 * Stages from which the AI implementation runner can be invoked.
 */
const IMPLEMENTATION_ELIGIBLE_STAGES: readonly TaskStage[] = [
  "implementation",
  "impl-high-review",
  "impl-low-review",
];

/**
 * Shared core of an implementation run.
 *
 * ⚠ SAFETY: Before launching, warns the user if:
 *   - the workspace is not a git repo (changes cannot be tracked/reverted)
 *   - the workspace has uncommitted changes (recommend committing first)
 *
 * The prompt-size gate (high-context confirm + hard ceiling) is applied
 * before the pre-run safety checks, so the user sees the size warning
 * before the git-state warnings.
 *
 * NOTE: When called from applyImplementationReviewWithAI, the size gate
 * has already been applied on the assembled prompt before this function
 * is reached, so it is not double-applied. This function does NOT apply
 * the size gate for the path coming from applyImplementationReviewWithAI;
 * it IS applied for paths coming directly from runImplementationWithAI
 * (where the prompt is assembled here).
 */
async function executeImplementationRun(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  prompt: string,
  modelId: string | undefined,
  progressTitle: string,
  postRunReviewStage: TaskStage = "implementation"
): Promise<void> {
  const implementationUri = getCanonicalImplementationUri(folderUri);
  const cwd = workspaceRoot.uri.fsPath;

  // Pre-run safety checks for agentic file-editing runs
  const isGit = await isGitWorkspace(cwd);
  if (!isGit) {
    // Non-git workspace: changes cannot be tracked or reverted
    const proceed = await vscode.window.showWarningMessage(
      "⚠️ This workspace is not tracked by git.\n\n" +
        "The AI implementation run will edit files in your workspace, " +
        "but there is no git history to track or revert those changes. " +
        "You will not be able to see exactly what was changed or undo it via git.\n\n" +
        "Back up your workspace before proceeding.",
      { modal: true },
      "Proceed Anyway",
    );
    if (proceed !== "Proceed Anyway") {
      void vscode.window.showInformationMessage("Implementation run cancelled.");
      return;
    }
  } else {
    // Git workspace: warn if there are uncommitted changes
    const dirty = await hasUncommittedChanges(cwd);
    if (dirty) {
      const proceed = await vscode.window.showWarningMessage(
        "⚠️ Your workspace has uncommitted changes.\n\n" +
          "The AI implementation run will edit workspace files. " +
          "For best results, commit your current changes first so you can " +
          "clearly see what the AI changed and revert if needed.",
        { modal: false },
        "Proceed",
        "Cancel",
      );
      if (proceed !== "Proceed") {
        void vscode.window.showInformationMessage("Implementation run cancelled.");
        return;
      }
    }
  }

  let result: Awaited<ReturnType<typeof runImplementationForModel>> | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      result = await runImplementationForModel({
        prompt,
        modelId,
        workspaceUri: workspaceRoot.uri,
        token,
        onProgress: (message) => progress.report({ message }),
      });
    }
  );

  if (!result) {
    return;
  }

  const logContent = `# Implementation Run\n\nStatus: ${result.status}\n\nFiles changed:\n${
    result.filesChanged.length > 0
      ? result.filesChanged.map((f) => `- ${f}`).join("\n")
      : "_none recorded_"
  }\n\n${result.summary ?? result.errorMessage ?? ""}`;

  await writeRunLog(folderUri, result.runnerId, "implementation", logContent);

  if (result.status === "completed") {
    // Post-run: show changed files or warn if tracking was unavailable
    if (result.filesChangedUnknown) {
      void vscode.window.showWarningMessage(
        "⚠️ The AI implementation run completed, but the list of changed files " +
          "could not be determined (the workspace may not be a git repository). " +
          "Review your workspace manually to see what was changed."
      );
    } else if (result.filesChanged.length > 0) {
      void vscode.window.showInformationMessage(
        `Implementation complete. ${result.filesChanged.length} file(s) changed: ` +
          result.filesChanged.slice(0, 5).join(", ") +
          (result.filesChanged.length > 5 ? ` … and ${result.filesChanged.length - 5} more` : "")
      );
    }

    const summary =
      result.summary?.trim() ||
      `## Implementation Complete\n\nFiles changed:\n${
        result.filesChanged.map((f) => `- ${f}`).join("\n") || "_none recorded_"
      }`;
    await writeTextFile(implementationUri, summary);

    const currentProgress = await readTaskProgress(folderUri);
    if (currentProgress) {
      const alreadyAtOrPastImplementation =
        currentProgress.currentStage === "implementation" ||
        isReviewStage(currentProgress.currentStage);
      const updatedProgress = alreadyAtOrPastImplementation
        ? currentProgress
        : updateTaskProgressStage(currentProgress, "implementation");
      // filesChangedUnknown means THIS run's own change detection failed
      // (git unavailable/not-a-repo), not that no files changed — it says
      // nothing about the task's previously accumulated implReviewFiles.
      // Leave that set untouched rather than clearing it, so a single
      // transient detection failure can't erase file tracking built up by
      // earlier successful runs in the same task.
      if (!result.filesChangedUnknown) {
        await writeTaskProgress(
          folderUri,
          updateImplReviewFiles(updatedProgress, result.filesChanged)
        );
      } else if (updatedProgress !== currentProgress) {
        await writeTaskProgress(folderUri, updatedProgress);
      }
    }

    const doc = await vscode.workspace.openTextDocument(implementationUri);
    await vscode.window.showTextDocument(doc);
    // Auto-review after implementation run — bypass consent (already obtained)
    await runReviewForFolder(extensionUri, folderUri, workspaceRoot, postRunReviewStage, true);
  } else if (result.status === "cancelled") {
    void vscode.window.showInformationMessage("Implementation cancelled.");
  } else {
    void vscode.window.showErrorMessage(
      `Implementation failed: ${result.errorMessage ?? "unknown error"}`
    );
  }
}

/**
 * Run the implementation: use AI with tool-calling to make actual code changes.
 * No overwrite confirmation shown.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function runImplementationWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  node?: TaskNodeArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
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

  const resolved = await resolveTask(
    node,
    IMPLEMENTATION_ELIGIBLE_STAGES,
    "Run Implementation with AI"
  );
  if (!resolved) {
    return;
  }

  // Materialize canonical plan-final.md from legacy implementation.md if needed
  let canonicalUri: vscode.Uri;
  try {
    canonicalUri = await materializeCanonicalIfNeeded(resolved.folderUri);
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  const planFinalContent = await readNonEmptyText(canonicalUri);
  if (!planFinalContent) {
    void vscode.window.showWarningMessage(
      "No plan-final.md found. Advance to the Implementation stage first."
    );
    return;
  }

  const model = await resolveModelForStage(resolved.folderUri, "implementation");

  const { availability, providerLabel } =
    await checkImplementationAvailabilityForModel(model.modelId);
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}. Implement the plan manually instead.`
    );
    return;
  }

  const contextPackContent = await generateContextPack(
    resolved.folderUri,
    workspaceRoot.uri
  );

  const prompt = await renderPromptTemplate(
    extensionUri,
    "run-implementation.md",
    { contextPack: contextPackContent, plan: planFinalContent }
  );

  // ── Prompt-size gate (applied before executeImplementationRun) ────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return;
  }

  const postRunReviewStage = isReviewStage(resolved.progress.currentStage)
    ? resolved.progress.currentStage
    : "implementation";

  await executeImplementationRun(
    extensionUri,
    resolved.folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    `Running implementation with ${providerLabel} (uses your ${providerLabel} quota)...`,
    postRunReviewStage
  );
}

/**
 * Register all review/stage action commands
 */
export function registerReviewActionCommands(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runReviewWithAI",
      (node?: TaskNodeArg) => runReviewWithAI(context.extensionUri, context, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewWithAI",
      (node?: TaskNodeArg) => applyReviewWithAI(context.extensionUri, context, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.viewReview",
      (node?: TaskNodeArg) => viewReview(node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.nextStage",
      (node?: TaskNodeArg) =>
        nextStage(context.extensionUri, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.generateImplementationWithAI",
      (node?: TaskNodeArg) =>
        generateImplementationWithAI(context.extensionUri, context, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runImplementationWithAI",
      (node?: TaskNodeArg) =>
        runImplementationWithAI(context.extensionUri, context, node)
    )
  );
}
