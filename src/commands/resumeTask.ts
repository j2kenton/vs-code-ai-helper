import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  isReviewStage,
  PLAN_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  TASK_FILENAME,
  TaskStage,
} from "../types/taskProgress";
import {
  findIncompleteTasks,
  IncompleteTask,
  readTaskProgress,
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import { openOrCreateDocument, resolveCurrentPlanUri } from "../utils/fileUtils";

interface StageAction {
  label: string;
  description?: string;
  run: (taskFolderUri: vscode.Uri) => Promise<void>;
}

/**
 * Run another extension command, forwarding the task so pickers are skipped.
 */
function delegate(
  commandId: string,
  task: IncompleteTask
): (taskFolderUri: vscode.Uri) => Promise<void> {
  return async () => {
    await vscode.commands.executeCommand(commandId, { task });
  };
}

/**
 * Open a stage's artifact file, creating it empty if needed, and advance
 * the task to that stage if it is currently earlier in the workflow.
 */
function openArtifactAndSetStage(
  filename: string,
  stage: TaskStage
): (taskFolderUri: vscode.Uri) => Promise<void> {
  return async (taskFolderUri) => {
    await openOrCreateDocument(vscode.Uri.joinPath(taskFolderUri, filename));
    const progress = await readTaskProgress(taskFolderUri);
    if (progress && progress.currentStage !== stage) {
      await writeTaskProgress(
        taskFolderUri,
        updateTaskProgressStage(progress, stage)
      );
    }
  };
}

/**
 * Build the QuickPick actions relevant to a task's current stage. This is
 * the manual/AI hybrid menu that replaces the old linear wizard: every AI
 * action has a manual counterpart, and nothing advances without the user
 * choosing it.
 */
function getStageActions(task: IncompleteTask): StageAction[] {
  const stage = task.progress.currentStage;

  if (stage === "created") {
    return [
      {
        label: "$(edit) Open task.md",
        description: "Describe the goal, scope, and constraints",
        run: async (uri): Promise<void> => {
          await openOrCreateDocument(vscode.Uri.joinPath(uri, TASK_FILENAME));
        },
      },
      {
        label: "$(sparkle) Generate Plan with AI",
        run: async (uri): Promise<void> => {
          await vscode.commands.executeCommand(
            "vs-code-ai-helper.generatePlanWithAI",
            uri
          );
        },
      },
      {
        label: "$(file-add) Create plan.md manually",
        run: openArtifactAndSetStage(PLAN_FILENAME, "plan"),
      },
    ];
  }

  if (stage === "plan") {
    return [
      {
        label: "$(edit) Open the plan",
        run: async (uri): Promise<void> => {
          const planUri = await resolveCurrentPlanUri(uri);
          const doc = await vscode.workspace.openTextDocument(planUri);
          await vscode.window.showTextDocument(doc);
        },
      },
      {
        label: "$(sparkle) Run High-Level Review with AI",
        run: delegate("vs-code-ai-helper.runReviewWithAI", task),
      },
      {
        label: "$(file-add) Write high-level review manually",
        run: openArtifactAndSetStage(
          "plan-high-review.md",
          "plan-high-review"
        ),
      },
      {
        label: "$(arrow-right) Next Stage",
        run: delegate("vs-code-ai-helper.nextStage", task),
      },
    ];
  }

  if (isReviewStage(stage)) {
    return [
      {
        label: "$(eye) View Review",
        run: delegate("vs-code-ai-helper.viewReview", task),
      },
      {
        label: "$(sparkle) Run / Re-run Review with AI",
        run: delegate("vs-code-ai-helper.runReviewWithAI", task),
      },
      {
        label: "$(comment) Reply to Review",
        description: "Push back or clarify before applying",
        run: delegate("vs-code-ai-helper.replyToReview", task),
      },
      {
        label: "$(wand) Apply Review with AI",
        description: "Rewrites the plan/checklist in place",
        run: delegate("vs-code-ai-helper.applyReviewWithAI", task),
      },
      {
        label: "$(arrow-right) Next Stage",
        run: delegate("vs-code-ai-helper.nextStage", task),
      },
    ];
  }

  if (stage === "plan-final") {
    return [
      {
        label: "$(edit) Open plan-final.md",
        run: async (uri): Promise<void> => {
          await openOrCreateDocument(
            vscode.Uri.joinPath(uri, "plan-final.md")
          );
        },
      },
      {
        label: "$(rocket) Run Implementation with AI",
        description: "AI makes actual code changes from the plan",
        run: delegate("vs-code-ai-helper.runImplementationWithAI", task),
      },
      {
        label: "$(tasklist) Generate Implementation Checklist with AI",
        description: "Generate a checklist document instead of running directly",
        run: delegate("vs-code-ai-helper.generateImplementationWithAI", task),
      },
      {
        label: "$(arrow-right) Next Stage",
        description: "Move on to implementation",
        run: delegate("vs-code-ai-helper.nextStage", task),
      },
    ];
  }

  if (stage === "implementation") {
    return [
      {
        label: "$(edit) Open implementation.md",
        run: async (uri): Promise<void> => {
          await openOrCreateDocument(
            vscode.Uri.joinPath(uri, "implementation.md")
          );
        },
      },
      {
        label: "$(rocket) Run Implementation with AI",
        description: "AI makes actual code changes from the plan",
        run: delegate("vs-code-ai-helper.runImplementationWithAI", task),
      },
      {
        label: "$(tasklist) Generate Implementation Checklist with AI",
        description: "Generate a checklist document instead of running directly",
        run: delegate("vs-code-ai-helper.generateImplementationWithAI", task),
      },
      {
        label: "$(sparkle) Run High-Level Review with AI",
        description: "Reviews your open files against the final plan",
        run: delegate("vs-code-ai-helper.runReviewWithAI", task),
      },
      {
        label: "$(arrow-right) Next Stage",
        run: delegate("vs-code-ai-helper.nextStage", task),
      },
    ];
  }

  return [];
}

/**
 * Resume a task: show the actions relevant to its current stage.
 * Returns the task folder name if an action ran, undefined otherwise.
 *
 * When invoked from the tasks tree view or status bar, the node is passed
 * in and the task picker is skipped.
 */
export async function resumeTask(node?: {
  task?: IncompleteTask;
}): Promise<string | undefined> {
  if (!hasValidMetaResourcesPath()) {
    const selection = await vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first.",
      "Select Folder"
    );
    if (selection === "Select Folder") {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.selectMetaFolder"
      );
    }
    return undefined;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getMetaResourcesPath()
  );
  const incompleteTasks = await findIncompleteTasks(metaFolderUri);

  // If a specific task was passed in (e.g. from the tasks tree view), act
  // on that one directly instead of showing the picker.
  const preselectedFolder = node?.task?.folderName;
  const preselectedTask = preselectedFolder
    ? incompleteTasks.find((task) => task.folderName === preselectedFolder)
    : undefined;

  if (preselectedFolder && !preselectedTask) {
    void vscode.window.showInformationMessage(
      `${preselectedFolder} is already completed.`
    );
    return undefined;
  }

  if (incompleteTasks.length === 0) {
    void vscode.window.showInformationMessage(
      "No incomplete tasks found. Use 'Start New Task' to create one."
    );
    return undefined;
  }

  let selectedTask: IncompleteTask;
  if (preselectedTask) {
    selectedTask = preselectedTask;
  } else if (incompleteTasks.length === 1 && incompleteTasks[0]) {
    selectedTask = incompleteTasks[0];
  } else {
    const items = incompleteTasks.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      detail: `Last updated: ${new Date(
        task.progress.updatedAt
      ).toLocaleString()}`,
      task,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a task to resume",
      title: "Resume Task",
    });
    if (!selected) {
      return undefined;
    }
    selectedTask = selected.task;
  }

  // Re-read progress from disk so a stale tree/status-bar node can't show
  // actions for an outdated stage.
  const freshProgress = await readTaskProgress(selectedTask.folderUri);
  if (freshProgress) {
    selectedTask = { ...selectedTask, progress: freshProgress };
  }

  const stage = selectedTask.progress.currentStage;
  const actions = getStageActions(selectedTask);
  if (actions.length === 0) {
    void vscode.window.showInformationMessage(
      `${selectedTask.folderName} is completed.`
    );
    return undefined;
  }

  const artifact = STAGE_ARTIFACT_FILENAMES[stage];
  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({
      label: action.label,
      description: action.description,
      action,
    })),
    {
      placeHolder: `Current stage: ${STAGE_DISPLAY_NAMES[stage]}${
        artifact ? ` (${artifact})` : ""
      }`,
      title: `Resume: ${selectedTask.folderName}`,
    }
  );
  if (!picked) {
    return undefined;
  }

  await picked.action.run(selectedTask.folderUri);
  return selectedTask.folderName;
}

/**
 * Register the resumeTask command
 */
export function registerResumeTaskCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeTask",
    resumeTask
  );
  context.subscriptions.push(disposable);
}
