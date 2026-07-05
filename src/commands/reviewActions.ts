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
import { CopilotLanguageModelRunner } from "../runners/copilotLanguageModelRunner";
import {
  checkImplementationAvailability,
  runImplementationWithCopilot,
} from "../runners/copilotImplementationRunner";
import { resolveModelForStage } from "../utils/modelSelection";

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
  if (!hasValidMetaResourcesPath()) {
    void vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first."
    );
    return undefined;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

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

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getMetaResourcesPath()
  );
  const allTasks = await findAllTasks(metaFolderUri);
  const eligible = allTasks.filter((task) =>
    eligibleStages.includes(task.progress.currentStage)
  );
  if (eligible.length === 0) {
    void vscode.window.showInformationMessage(
      allTasks.length === 0
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
 * Confirm overwriting an artifact that already has content. Returns true
 * when it is safe to proceed (no content, or the user confirmed).
 */
async function confirmOverwrite(
  fileUri: vscode.Uri,
  fileLabel: string
): Promise<boolean> {
  const existing = await readNonEmptyText(fileUri);
  if (!existing) {
    return true;
  }
  const confirmation = await vscode.window.showWarningMessage(
    `${fileLabel} already has content. This will overwrite it.`,
    { modal: true },
    "Overwrite"
  );
  return confirmation === "Overwrite";
}

/**
 * Shared boilerplate for every AI command: availability check, progress
 * notification, prompt render, run, run log, result handling. Returns true
 * when the run completed successfully.
 */
async function runAiToFile(options: {
  extensionUri: vscode.Uri;
  taskFolderUri: vscode.Uri;
  workspaceUri: vscode.Uri;
  logStage: TaskStage;
  templateFile: string;
  variables: Record<string, string>;
  outputFileUri: vscode.Uri;
  progressTitle: string;
  outputLabel: string;
}): Promise<boolean> {
  const runner = new CopilotLanguageModelRunner();
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `Copilot is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Write ${options.outputLabel} manually instead.`
    );
    return false;
  }

  const model = await resolveModelForStage(
    options.taskFolderUri,
    options.logStage
  );

  let completed = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      const prompt = await renderPromptTemplate(
        options.extensionUri,
        options.templateFile,
        options.variables
      );

      progress.report({ message: "Waiting for Copilot response..." });

      const result = await runner.run(
        {
          taskFolderUri: options.taskFolderUri,
          workspaceUri: options.workspaceUri,
          stage: options.logStage,
          prompt,
          outputFile: options.outputFileUri,
          modelId: model.modelId,
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
          `${options.outputLabel} generated with Copilot (${
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
 * Called by runReviewWithAI (user-invoked) and automatically after plan
 * generation, an implementation run, or applying a review completes.
 *
 * @param skipOverwriteConfirmation When true, skip the "already has content"
 *   prompt — used for auto-triggered reviews immediately after a stage runs.
 */
export async function runReviewForFolder(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  currentStage: TaskStage,
  skipOverwriteConfirmation: boolean
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
    // Implementation reviews must be measured against the APPROVED plan,
    // never the still-mutable draft — falling back to the in-progress plan
    // would let implementation proceed without the human approval gate
    // that promoting to plan-final.md represents.
    const planFinalContent = await readNonEmptyText(
      vscode.Uri.joinPath(folderUri, "plan-final.md")
    );
    if (!planFinalContent) {
      void vscode.window.showWarningMessage(
        "No plan-final.md found. Finalize a plan (Next Stage from the low-level plan review) before reviewing implementation."
      );
      return;
    }
    const implementationContent = await readNonEmptyText(
      vscode.Uri.joinPath(folderUri, "implementation.md")
    );
    if (!implementationContent) {
      void vscode.window.showWarningMessage(
        "No implementation.md found. Generate the implementation checklist first."
      );
      return;
    }
    variables.plan = planFinalContent;
    variables.implementation = implementationContent;
  }

  if (!skipOverwriteConfirmation) {
    if (!(await confirmOverwrite(reviewUri, STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review"))) {
      return;
    }
  }

  // Implementation reviews scope to the task's tracked changed files so the
  // AI assesses what was actually written, not whatever tabs happen to be
  // open. Plan reviews only need the lightweight pack (no file contents).
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

  const succeeded = await runAiToFile({
    extensionUri,
    taskFolderUri: folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: targetStage,
    templateFile,
    variables,
    outputFileUri: reviewUri,
    progressTitle: `Running ${STAGE_DISPLAY_NAMES[targetStage]} with Copilot...`,
    outputLabel: STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review",
  });

  if (succeeded) {
    await setStage(folderUri, targetStage);
  }
}

/**
 * Run (or re-run) the review for the task's current position in the
 * workflow: from "plan"/"implementation" this starts the high-level review
 * and advances the stage; from a review stage it regenerates that review.
 */
export async function runReviewWithAI(
  extensionUri: vscode.Uri,
  node?: TaskNodeArg
): Promise<void> {
  const resolved = await resolveTask(
    node,
    Object.keys(REVIEW_TARGETS) as TaskStage[],
    "Run Review with AI"
  );
  if (!resolved) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  await runReviewForFolder(
    extensionUri,
    resolved.folderUri,
    workspaceRoot,
    resolved.progress.currentStage,
    false
  );
}

/**
 * Apply the current review: for plan review stages the AI rewrites the plan
 * in place; for implementation review stages it re-runs the AI
 * implementation against the codebase to address the review's findings
 * (see applyImplementationReviewWithAI). The stage does not change —
 * re-run the review or move to the next stage explicitly.
 */
export async function applyReviewWithAI(
  extensionUri: vscode.Uri,
  node?: TaskNodeArg
): Promise<void> {
  const resolved = await resolveTask(node, REVIEW_STAGES, "Apply Review with AI");
  if (!resolved) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
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
    // Implementation reviews assess actual code, not implementation.md — so
    // "applying" the review means re-invoking the AI implementation runner
    // to fix the code the review found issues with, not rewriting a
    // checklist document that the review never assessed in the first place.
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
  // Always write to the canonical plan.md — this is how legacy
  // plan-updated.md tasks converge onto the single-plan model.
  const outputFileUri = vscode.Uri.joinPath(resolved.folderUri, PLAN_FILENAME);
  const templateFile = "apply-review.md";
  const outputLabel = PLAN_FILENAME;

  const confirmation = await vscode.window.showWarningMessage(
    `This will rewrite ${outputLabel} in place, addressing the review.`,
    { modal: true },
    "Apply"
  );
  if (confirmation !== "Apply") {
    return;
  }

  const applySucceeded = await runAiToFile({
    extensionUri,
    taskFolderUri: resolved.folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: stage,
    templateFile,
    variables,
    outputFileUri,
    progressTitle: `Applying review to ${outputLabel} with Copilot...`,
    outputLabel,
  });

  if (applySucceeded) {
    await runReviewForFolder(extensionUri, resolved.folderUri, workspaceRoot, stage, true);
  }
}

/**
 * Apply an implementation review by re-running the AI implementation
 * runner against the review's findings, making real code changes rather
 * than editing implementation.md directly. Reuses executeImplementationRun
 * so the result is written and re-reviewed exactly like a normal
 * implementation run.
 */
async function applyImplementationReviewWithAI(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  stage: TaskStage,
  reviewContent: string
): Promise<void> {
  const planFinalContent = await readNonEmptyText(
    vscode.Uri.joinPath(folderUri, "plan-final.md")
  );
  if (!planFinalContent) {
    void vscode.window.showWarningMessage(
      "No plan-final.md found. Nothing to apply the review to."
    );
    return;
  }

  const availability = await checkImplementationAvailability();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `Copilot is unavailable: ${availability.reason ?? "unknown reason"}. Address the review manually instead.`
    );
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    "This will re-run the AI implementation against the codebase to address the review.",
    { modal: true },
    "Apply"
  );
  if (confirmation !== "Apply") {
    return;
  }

  // Use the implementation stage's model, not the review stage's — this is
  // a tool-calling code-edit run like any other implementation run, and
  // users may have configured a lighter model for review-only stages.
  const model = await resolveModelForStage(folderUri, "implementation");
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

  await executeImplementationRun(
    extensionUri,
    folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    "Applying implementation review with Copilot...",
    stage
  );
}

/**
 * Open the review artifact for the task's current review stage. Offers to
 * run the review if it doesn't exist yet.
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
      "Run Review with AI",
      "Create Manually"
    );
    if (choice === "Run Review with AI") {
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
 * Required before advancing past that stage, so "Next Stage" can't skip a
 * step that hasn't actually been done yet (e.g. created -> plan with no
 * task.md written, or implementation -> review with no implementation.md).
 * Review stages are excluded here since applying/regenerating them is
 * optional by design.
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
  const content = await readNonEmptyText(
    vscode.Uri.joinPath(folderUri, name)
  );
  return content !== undefined;
}

/**
 * Advance a task to the next stage in the workflow. Entering "plan-final"
 * offers to promote the current plan into plan-final.md (the human approval
 * gate); entering "completed" asks for explicit confirmation.
 */
export async function nextStage(node?: TaskNodeArg): Promise<void> {
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

  // Command-palette usage can bypass the tree's curated created-stage
  // actions; don't allow created -> plan unless a plan artifact already
  // exists (generated or manually created).
  if (resolved.progress.currentStage === "created" && next === "plan") {
    const planUri = await resolveCurrentPlanUri(resolved.folderUri);
    const hasPlanArtifact = (await statIfExists(planUri)) !== undefined;
    if (!hasPlanArtifact) {
      void vscode.window.showWarningMessage(
        "Cannot advance to Plan yet. Generate a plan with AI or create plan.md manually first."
      );
      return;
    }
  }

  if (
    next !== "plan-final" &&
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

  if (next === "plan-final") {
    const planFinalUri = vscode.Uri.joinPath(
      resolved.folderUri,
      "plan-final.md"
    );
    const existingFinal = await readNonEmptyText(planFinalUri);
    if (!existingFinal) {
      const currentPlanUri = await resolveCurrentPlanUri(resolved.folderUri);
      const planContent = await readNonEmptyText(currentPlanUri);
      if (!planContent) {
        void vscode.window.showWarningMessage(
          "No plan to promote. Write or generate a plan first."
        );
        return;
      }
      const confirmation = await vscode.window.showInformationMessage(
        "Promote the current plan to plan-final.md and advance? Finalizing is a deliberate, human approval step.",
        { modal: true },
        "Promote & Advance"
      );
      if (confirmation !== "Promote & Advance") {
        return;
      }
      await vscode.workspace.fs.writeFile(
        planFinalUri,
        new TextEncoder().encode(planContent)
      );
    }
  } else if (next === "completed") {
    const confirmation = await vscode.window.showInformationMessage(
      `Mark ${resolved.progress.taskFolder} as completed?`,
      { modal: true },
      "Complete Task"
    );
    if (confirmation !== "Complete Task") {
      return;
    }
  } else {
    const confirmation = await vscode.window.showInformationMessage(
      `Advance ${resolved.progress.taskFolder} to "${STAGE_DISPLAY_NAMES[next]}"?`,
      { modal: true },
      "Advance"
    );
    if (confirmation !== "Advance") {
      return;
    }
  }

  await setStage(resolved.folderUri, next);
  void vscode.window.showInformationMessage(
    `${resolved.progress.taskFolder} advanced to: ${STAGE_DISPLAY_NAMES[next]}`
  );
}

/**
 * Generate implementation.md — a concrete checklist derived from the final
 * plan — using the user's Copilot access.
 */
export async function generateImplementationWithAI(
  extensionUri: vscode.Uri,
  node?: TaskNodeArg
): Promise<void> {
  const resolved = await resolveTask(
    node,
    ["plan-final", "implementation"],
    "Generate Implementation Checklist with AI"
  );
  if (!resolved) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }

  // Require the APPROVED plan, not the draft — generating the
  // implementation checklist from an unfinalized plan would let
  // implementation start without the human approval gate that promoting to
  // plan-final.md represents (e.g. if a task's stage was moved forward
  // manually via Set Task Stage without ever finalizing).
  const planFinalContent = await readNonEmptyText(
    vscode.Uri.joinPath(resolved.folderUri, "plan-final.md")
  );
  if (!planFinalContent) {
    void vscode.window.showWarningMessage(
      "No plan-final.md found. Finalize a plan (Next Stage from the low-level plan review) before generating the implementation checklist."
    );
    return;
  }

  const implementationUri = vscode.Uri.joinPath(
    resolved.folderUri,
    "implementation.md"
  );
  if (!(await confirmOverwrite(implementationUri, "implementation.md"))) {
    return;
  }

  const contextPackContent = await generateContextPack(
    resolved.folderUri,
    workspaceRoot.uri
  );

  const succeeded = await runAiToFile({
    extensionUri,
    taskFolderUri: resolved.folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: "implementation",
    templateFile: "create-implementation.md",
    variables: { contextPack: contextPackContent, plan: planFinalContent },
    outputFileUri: implementationUri,
    progressTitle: "Generating implementation checklist with Copilot...",
    outputLabel: "implementation.md",
  });

  if (succeeded) {
    await setStage(resolved.folderUri, "implementation");
  }
}

/**
 * Stages from which the AI implementation runner can be invoked: the first
 * run (plan-final), a manual re-run (implementation), or addressing an
 * implementation review's findings directly in code (impl-*-review).
 */
const IMPLEMENTATION_ELIGIBLE_STAGES: readonly TaskStage[] = [
  "plan-final",
  "implementation",
  "impl-high-review",
  "impl-low-review",
];

/**
 * Shared core of an implementation run: invoke Copilot's tool-calling loop
 * with the given prompt, write the run log, and on success write
 * implementation.md, persist the changed-file list, and auto-review.
 * Used both for the initial/manual run and for applying an implementation
 * review by re-running the AI against the code (not just editing the
 * checklist document).
 */
async function executeImplementationRun(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  prompt: string,
  modelId: string | undefined,
  progressTitle: string,
  // The stage to re-review at afterwards: "implementation" for the normal
  // (first/re-)run, which starts back at the high-level review, or the
  // impl-*-review stage a review-driven fix originated from, so applying a
  // low-level review's findings re-checks at the low level rather than
  // resetting to high-level.
  postRunReviewStage: TaskStage = "implementation"
): Promise<void> {
  const implementationUri = vscode.Uri.joinPath(folderUri, "implementation.md");

  let result: Awaited<ReturnType<typeof runImplementationWithCopilot>> | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      result = await runImplementationWithCopilot({
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

  await writeRunLog(folderUri, "copilot-lm", "implementation", logContent);

  if (result.status === "completed") {
    // Write the AI-generated summary as implementation.md
    const summary =
      result.summary?.trim() ||
      `## Implementation Complete\n\nFiles changed:\n${
        result.filesChanged.map((f) => `- ${f}`).join("\n") || "_none recorded_"
      }`;
    await writeTextFile(implementationUri, summary);

    // Persist the changed-file list for review scoping. The stage itself is
    // only force-advanced to "implementation" when the task isn't already
    // at "implementation" or an impl review stage — i.e. for the first run
    // out of "plan-final", where code has now genuinely been written and
    // the task must not be left at a stage ("plan-final") that has no
    // reviewable action if the follow-up auto-review below then fails.
    // When re-running from "implementation" or an impl review stage, that
    // stage is already a valid, recoverable resting point, so it's left
    // alone here and the follow-up auto-review owns any further transition
    // — on cancel/failure the task simply stays at its current review
    // stage instead of silently dropping to the generic "implementation"
    // stage with no record of where it was.
    const currentProgress = await readTaskProgress(folderUri);
    if (currentProgress) {
      const alreadyAtOrPastImplementation =
        currentProgress.currentStage === "implementation" ||
        isReviewStage(currentProgress.currentStage);
      const updatedProgress = alreadyAtOrPastImplementation
        ? currentProgress
        : updateTaskProgressStage(currentProgress, "implementation");
      await writeTaskProgress(
        folderUri,
        updateImplReviewFiles(updatedProgress, result.filesChanged)
      );
    }

    const doc = await vscode.workspace.openTextDocument(implementationUri);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      `Implementation complete. ${result.filesChanged.length} file(s) written.`
    );
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
 * Run the implementation: use Copilot with tool-calling to make actual
 * code changes in the workspace, then write implementation.md with the
 * AI-generated summary of what was done.
 *
 * Eligible stages: plan-final (first run), implementation (re-run), or
 * an implementation review stage (addressing findings directly in code).
 */
export async function runImplementationWithAI(
  extensionUri: vscode.Uri,
  node?: TaskNodeArg
): Promise<void> {
  const resolved = await resolveTask(
    node,
    IMPLEMENTATION_ELIGIBLE_STAGES,
    "Run Implementation with AI"
  );
  if (!resolved) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }

  const planFinalContent = await readNonEmptyText(
    vscode.Uri.joinPath(resolved.folderUri, "plan-final.md")
  );
  if (!planFinalContent) {
    void vscode.window.showWarningMessage(
      "No plan-final.md found. Finalize a plan (Next Stage from the low-level plan review) before running the implementation."
    );
    return;
  }

  const availability = await checkImplementationAvailability();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `Copilot is unavailable: ${availability.reason ?? "unknown reason"}. Implement the plan manually instead.`
    );
    return;
  }

  const implementationUri = vscode.Uri.joinPath(
    resolved.folderUri,
    "implementation.md"
  );
  if (!(await confirmOverwrite(implementationUri, "implementation.md"))) {
    return;
  }

  const model = await resolveModelForStage(resolved.folderUri, "implementation");

  const contextPackContent = await generateContextPack(
    resolved.folderUri,
    workspaceRoot.uri
  );

  const prompt = await renderPromptTemplate(
    extensionUri,
    "run-implementation.md",
    { contextPack: contextPackContent, plan: planFinalContent }
  );

  // Re-running from an impl review stage re-checks at that same level
  // (matching Apply Review's routing); the first run (plan-final) or a
  // plain re-run (implementation) starts back at the high-level review.
  const postRunReviewStage = isReviewStage(resolved.progress.currentStage)
    ? resolved.progress.currentStage
    : "implementation";

  await executeImplementationRun(
    extensionUri,
    resolved.folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    "Running implementation with Copilot...",
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
      (node?: TaskNodeArg) => runReviewWithAI(context.extensionUri, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewWithAI",
      (node?: TaskNodeArg) => applyReviewWithAI(context.extensionUri, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.viewReview",
      (node?: TaskNodeArg) => viewReview(node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.nextStage",
      (node?: TaskNodeArg) => nextStage(node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.generateImplementationWithAI",
      (node?: TaskNodeArg) =>
        generateImplementationWithAI(context.extensionUri, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runImplementationWithAI",
      (node?: TaskNodeArg) =>
        runImplementationWithAI(context.extensionUri, node)
    )
  );
}
