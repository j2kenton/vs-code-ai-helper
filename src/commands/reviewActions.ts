import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  getReviewReplyFilename,
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
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import {
  openOrCreateDocument,
  readNonEmptyText,
  resolveCurrentPlanUri,
  statIfExists,
} from "../utils/fileUtils";
import { generateContextPack, writeContextPack } from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { CopilotLanguageModelRunner } from "../runners/copilotLanguageModelRunner";
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

  const targetStage = REVIEW_TARGETS[resolved.progress.currentStage];
  const templateFile = targetStage && REVIEW_PROMPTS[targetStage];
  const reviewUri = targetStage && artifactUri(resolved.folderUri, targetStage);
  if (!targetStage || !templateFile || !reviewUri) {
    return;
  }

  const variables: Record<string, string> = {};
  const isPlanReview = isPlanReviewStage(targetStage);

  if (isPlanReview) {
    const planUri = await resolveCurrentPlanUri(resolved.folderUri);
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
      vscode.Uri.joinPath(resolved.folderUri, "plan-final.md")
    );
    if (!planFinalContent) {
      void vscode.window.showWarningMessage(
        "No plan-final.md found. Finalize a plan (Next Stage from the low-level plan review) before reviewing implementation."
      );
      return;
    }
    const implementationContent = await readNonEmptyText(
      vscode.Uri.joinPath(resolved.folderUri, "implementation.md")
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

  if (!(await confirmOverwrite(reviewUri, STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review"))) {
    return;
  }

  // Implementation reviews embed open-file contents so the AI can assess
  // actual code; plan reviews only need the lightweight pack.
  const contextPackUri = await writeContextPack(
    resolved.folderUri,
    workspaceRoot.uri,
    !isPlanReview
  );
  variables.contextPack = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(contextPackUri)
  );

  const succeeded = await runAiToFile({
    extensionUri,
    taskFolderUri: resolved.folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: targetStage,
    templateFile,
    variables,
    outputFileUri: reviewUri,
    progressTitle: `Running ${STAGE_DISPLAY_NAMES[targetStage]} with Copilot...`,
    outputLabel: STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review",
  });

  if (succeeded) {
    await setStage(resolved.folderUri, targetStage);
  }
}

/**
 * Apply the current review: the AI rewrites the plan (plan review stages)
 * or the implementation checklist (implementation review stages) in place,
 * taking into account the review and, if present, the user's reply file.
 * The stage does not change — re-run the review or move to the next stage
 * explicitly.
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

  const replyFilename = getReviewReplyFilename(stage);
  const replyContent = replyFilename
    ? await readNonEmptyText(
        vscode.Uri.joinPath(resolved.folderUri, replyFilename)
      )
    : undefined;

  const isPlanReview = isPlanReviewStage(stage);
  const variables: Record<string, string> = {
    review: reviewContent,
    reply: replyContent ?? "_No reply provided._",
  };

  let outputFileUri: vscode.Uri;
  let templateFile: string;
  let outputLabel: string;

  if (isPlanReview) {
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
    outputFileUri = vscode.Uri.joinPath(resolved.folderUri, PLAN_FILENAME);
    templateFile = "apply-review.md";
    outputLabel = PLAN_FILENAME;
  } else {
    const implementationUri = vscode.Uri.joinPath(
      resolved.folderUri,
      "implementation.md"
    );
    const implementationContent = await readNonEmptyText(implementationUri);
    if (!implementationContent) {
      void vscode.window.showWarningMessage(
        "No implementation.md found. Nothing to apply the review to."
      );
      return;
    }
    variables.implementation = implementationContent;
    outputFileUri = implementationUri;
    templateFile = "apply-impl-review.md";
    outputLabel = "implementation.md";
  }

  const confirmation = await vscode.window.showWarningMessage(
    `This will rewrite ${outputLabel} in place, addressing the review${
      replyContent ? " and your reply" : ""
    }.`,
    { modal: true },
    "Apply"
  );
  if (confirmation !== "Apply") {
    return;
  }

  await runAiToFile({
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
}

/**
 * Open (creating if needed) the reply file for the current review, where
 * the user can push back on or clarify review points before applying it.
 */
export async function replyToReview(node?: TaskNodeArg): Promise<void> {
  const resolved = await resolveTask(node, REVIEW_STAGES, "Reply to Review");
  if (!resolved) {
    return;
  }
  const stage = resolved.progress.currentStage;
  const replyFilename = getReviewReplyFilename(stage);
  if (!replyFilename) {
    return;
  }
  const replyUri = vscode.Uri.joinPath(resolved.folderUri, replyFilename);
  await openOrCreateDocument(
    replyUri,
    `# Reply: ${STAGE_DISPLAY_NAMES[stage]}\n\n` +
      `_Respond here to review points you disagree with or want to clarify. ` +
      `This file is sent to the AI together with the review when you Apply it._\n\n`
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
      "vs-code-ai-helper.replyToReview",
      (node?: TaskNodeArg) => replyToReview(node)
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
    )
  );
}
