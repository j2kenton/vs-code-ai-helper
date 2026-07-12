import * as vscode from "vscode";
import { TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { SettingsViewProvider } from "../views/settingsView";

export type StageSave =
  | { type: "workspace"; modelId: string | undefined }
  | { type: "taskOnly"; modelId: string | undefined }
  | { type: "taskAndWorkspace"; modelId: string };

interface ConfigureModelArg {
  taskFolderUri?: vscode.Uri;
  task?: IncompleteTask;
}

interface StageNodeArg {
  stage?: TaskStage;
  task?: IncompleteTask;
}

export async function configureStepModels(
  _arg?: ConfigureModelArg
): Promise<void> {
  await vscode.commands.executeCommand("vs-code-ai-helper.settingsView.focus");
}

export async function setStageModel(
  node?: StageNodeArg,
  settingsViewProvider?: SettingsViewProvider
): Promise<void> {
  await vscode.commands.executeCommand("vs-code-ai-helper.settingsView.focus");
  if (node?.stage && settingsViewProvider) {
    settingsViewProvider.focusStage(node.stage);
  }
}

/** Open the workspace settings table focused on a stage's backup controls. */
export async function setStageBackupModel(
  node?: StageNodeArg,
  settingsViewProvider?: SettingsViewProvider
): Promise<void> {
  await vscode.commands.executeCommand("vs-code-ai-helper.settingsView.focus");
  if (node?.stage && settingsViewProvider) {
    settingsViewProvider.focusStage(node.stage, "backup");
  }
}

export function registerConfigureStepModelsCommand(
  context: vscode.ExtensionContext,
  settingsViewProvider?: SettingsViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.configureStepModels",
    (arg?: ConfigureModelArg) => configureStepModels(arg)
  );
  context.subscriptions.push(disposable);

  const taskDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.configureTaskStepModels",
    (arg?: ConfigureModelArg) => configureStepModels(arg)
  );
  context.subscriptions.push(taskDisposable);

  const stageDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setStageModel",
    (arg?: StageNodeArg) => setStageModel(arg, settingsViewProvider)
  );
  context.subscriptions.push(stageDisposable);

  const backupDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setStageBackupModel",
    (arg?: StageNodeArg) => setStageBackupModel(arg, settingsViewProvider)
  );
  context.subscriptions.push(backupDisposable);

  const focusDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.settingsView.focus",
    async () => {
      await vscode.commands.executeCommand("workbench.action.focusView", "vs-code-ai-helper.settingsView");
    }
  );
  context.subscriptions.push(focusDisposable);
}
