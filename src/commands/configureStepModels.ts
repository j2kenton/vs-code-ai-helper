import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
  setAiModelDefault,
} from "../config/settings";
import { AI_MODEL_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { findAllTasks, IncompleteTask } from "../utils/taskProgressUtils";
import {
  describeModel,
  getAvailableModels,
  readTaskStageModels,
  SelectableModel,
  setTaskStageModel,
} from "../utils/modelSelection";

interface ModelPickItem extends vscode.QuickPickItem {
  modelId?: string;
  useWorkspaceDefault?: boolean;
  clearWorkspaceDefault?: boolean;
}

export type StageSave =
  | { type: "workspace"; modelId: string | undefined }
  | { type: "taskOnly"; modelId: string | undefined }
  | { type: "taskAndWorkspace"; modelId: string };

export async function applyStageSave(
  stage: TaskStage,
  save: StageSave,
  taskFolderUri: vscode.Uri | undefined
): Promise<void> {
  if (save.type === "workspace") {
    await setAiModelDefault(stage, save.modelId);
  } else if (save.type === "taskOnly") {
    await setTaskStageModel(taskFolderUri!, stage, save.modelId);
  } else {
    await setAiModelDefault(stage, save.modelId);
    await setTaskStageModel(taskFolderUri!, stage, undefined);
  }
}

interface ConfigureModelArg {
  taskFolderUri?: vscode.Uri;
  task?: IncompleteTask;
}

interface ResolvedConfigureTarget {
  cancelled: boolean;
  taskFolderUri?: vscode.Uri;
}

async function resolveTaskFolderUri(
  arg?: ConfigureModelArg
): Promise<ResolvedConfigureTarget> {
  if (arg?.taskFolderUri) {
    return { cancelled: false, taskFolderUri: arg.taskFolderUri };
  }
  if (arg?.task?.folderUri) {
    return { cancelled: false, taskFolderUri: arg.task.folderUri };
  }

  const scopeChoice = await vscode.window.showQuickPick(
    [
      {
        label: "Configure workspace defaults",
        description: "Used by all tasks unless overridden per task",
        configureWorkspace: true,
      },
      {
        label: "Configure one task",
        description: "Set models only for a specific task",
        configureWorkspace: false,
      },
    ],
    {
      title: "Configure AI Models per Step",
      placeHolder: "Choose where model selections should apply",
    }
  );

  if (!scopeChoice) {
    return { cancelled: true };
  }
  if (scopeChoice.configureWorkspace) {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showErrorMessage(
        "No workspace folder open. Please open a folder first."
      );
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  if (!hasValidMetaResourcesPath()) {
    void vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first."
    );
    return { cancelled: true };
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return { cancelled: true };
  }

  const tasks = await findAllTasks(
    vscode.Uri.joinPath(workspaceRoot.uri, getMetaResourcesPath())
  );
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
      "No tasks found yet. Start a task first, then configure task-specific models."
    );
    return { cancelled: true };
  }

  const pickedTask = await vscode.window.showQuickPick(
    tasks.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      task,
    })),
    {
      title: "Configure AI Models per Step",
      placeHolder: "Select a task",
    }
  );

  if (!pickedTask) {
    return { cancelled: true };
  }

  return { cancelled: false, taskFolderUri: pickedTask.task.folderUri };
}

export async function collectStageSelection(
  stage: TaskStage,
  models: readonly SelectableModel[],
  taskFolderUri: vscode.Uri | undefined
): Promise<StageSave | null> {
  const taskModels = taskFolderUri
    ? await readTaskStageModels(taskFolderUri)
    : {};
  const currentTaskModelId = taskModels[stage];

  const items: ModelPickItem[] = models.map((model) => ({
    label: model.name,
    description: model.id,
    detail: model.providerLabel,
    modelId: model.id,
  }));

  if (taskFolderUri) {
    items.unshift({
      label: "Use workspace default",
      description: "Clear task-specific override for this stage",
      useWorkspaceDefault: true,
    });
  } else {
    items.unshift({
      label: "Use automatic model selection",
      description: "Clear workspace default for this stage",
      clearWorkspaceDefault: true,
    });
  }

  const selection = await vscode.window.showQuickPick(items, {
    title: `Model for ${STAGE_DISPLAY_NAMES[stage]}`,
    placeHolder: taskFolderUri
      ? `Current task setting: ${describeModel(currentTaskModelId, models)}`
      : "Choose workspace default model",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selection) {
    return null;
  }

  if (taskFolderUri && selection.useWorkspaceDefault) {
    return { type: "taskOnly", modelId: undefined };
  }

  if (!taskFolderUri && selection.clearWorkspaceDefault) {
    return { type: "workspace", modelId: undefined };
  }

  const selectedModelId = selection.modelId;
  if (!selectedModelId) {
    return null;
  }

  if (!taskFolderUri) {
    return { type: "workspace", modelId: selectedModelId };
  }

  const scopeSelection = await vscode.window.showQuickPick(
    [
      {
        label: "Set as workspace default too",
        description: "Applies to all tasks unless they override this stage",
      },
    ],
    {
      title: `Scope for ${STAGE_DISPLAY_NAMES[stage]}`,
      placeHolder:
        "Checkbox: select to save globally, or leave unchecked for this task only",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );

  if (!scopeSelection) {
    return null;
  }

  if (scopeSelection.length > 0) {
    return { type: "taskAndWorkspace", modelId: selectedModelId };
  }

  return { type: "taskOnly", modelId: selectedModelId };
}

export async function configureStepModels(
  arg?: ConfigureModelArg
): Promise<void> {
  const models = await getAvailableModels();
  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      "No AI models are available. Sign in to GitHub Copilot, or install one of the subscription CLIs (claude, codex, gemini), and try again."
    );
    return;
  }

  const target = await resolveTaskFolderUri(arg);
  if (target.cancelled) {
    return;
  }
  const taskFolderUri = target.taskFolderUri;

  const selections = new Map<TaskStage, StageSave>();
  for (const stage of AI_MODEL_STAGES) {
    const save = await collectStageSelection(stage, models, taskFolderUri);
    if (!save) {
      void vscode.window.showInformationMessage(
        "Model configuration canceled. No changes were saved."
      );
      return;
    }
    selections.set(stage, save);
  }

  for (const [stage, save] of selections) {
    await applyStageSave(stage, save, taskFolderUri);
  }

  void vscode.window.showInformationMessage(
    taskFolderUri
      ? "Saved per-step model selections for this task."
      : "Saved per-step workspace default model selections."
  );
}

interface StageNodeArg {
  task: IncompleteTask;
  stage: TaskStage;
}

/**
 * Resolve which task and stage to configure when the command isn't invoked
 * from a specific stage row (e.g. from the Command Palette): prompt for a
 * task, then for one of its AI-configurable stages.
 */
async function resolveStageTarget(
  node: StageNodeArg | undefined
): Promise<StageNodeArg | undefined> {
  if (node?.task && node.stage) {
    return node;
  }

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

  const tasks = await findAllTasks(
    vscode.Uri.joinPath(workspaceRoot.uri, getMetaResourcesPath())
  );
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
      "No tasks found yet. Start a task first."
    );
    return undefined;
  }

  const pickedTask = await vscode.window.showQuickPick(
    tasks.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      task,
    })),
    {
      title: "Set Model for This Step",
      placeHolder: "Select a task",
    }
  );
  if (!pickedTask) {
    return undefined;
  }

  const pickedStage = await vscode.window.showQuickPick(
    AI_MODEL_STAGES.map((stage) => ({
      label: STAGE_DISPLAY_NAMES[stage],
      stage,
    })),
    {
      title: "Set Model for This Step",
      placeHolder: "Select a step",
    }
  );
  if (!pickedStage) {
    return undefined;
  }

  return { task: pickedTask.task, stage: pickedStage.stage };
}

export async function setStageModel(node?: StageNodeArg): Promise<void> {
  const target = await resolveStageTarget(node);
  if (!target) {
    return;
  }

  const models = await getAvailableModels();
  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      "No AI models are available. Sign in to GitHub Copilot, or install one of the subscription CLIs (claude, codex, gemini), and try again."
    );
    return;
  }

  const taskFolderUri = target.task.folderUri;
  const save = await collectStageSelection(target.stage, models, taskFolderUri);
  if (!save) {
    return;
  }

  await applyStageSave(target.stage, save, taskFolderUri);
  void vscode.window.showInformationMessage(
    `Saved model for ${STAGE_DISPLAY_NAMES[target.stage]}.`
  );
}

export function registerConfigureStepModelsCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.configureStepModels",
    (arg?: ConfigureModelArg) => configureStepModels(arg)
  );
  context.subscriptions.push(disposable);

  const stageDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setStageModel",
    (arg?: StageNodeArg) => setStageModel(arg)
  );
  context.subscriptions.push(stageDisposable);
}
