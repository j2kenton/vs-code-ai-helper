import * as vscode from "vscode";
import { TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { SettingsViewProvider } from "../views/settingsView";
import { NotificationRouter } from "../utils/notificationRouter";

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

export function configureStepModels(
  _arg?: ConfigureModelArg,
  settingsViewProvider?: SettingsViewProvider
): void {
  // Opening Settings must not wait on provider/model discovery.  The view
  // itself posts its cached rows immediately and refreshes in the background.
  void revealSettingsView(settingsViewProvider);
}

export function setStageModel(
  node?: StageNodeArg,
  settingsViewProvider?: SettingsViewProvider
): void {
  void revealSettingsView(settingsViewProvider);
  if (node?.stage && settingsViewProvider) {
    settingsViewProvider.focusStage(node.stage);
  }
}

/** Open the workspace settings table focused on a stage's backup controls. */
export function setStageBackupModel(
  node?: StageNodeArg,
  settingsViewProvider?: SettingsViewProvider
): void {
  void revealSettingsView(settingsViewProvider);
  if (node?.stage && settingsViewProvider) {
    settingsViewProvider.focusStage(node.stage, "backup");
  }
}

async function revealSettingsView(
  settingsViewProvider?: SettingsViewProvider
): Promise<void> {
  if (settingsViewProvider?.reveal()) {
    return;
  }

  try {
    await vscode.commands.executeCommand(
      "workbench.action.focusView",
      SettingsViewProvider.viewType
    );
    return;
  } catch {
    // Older or non-standard VS Code hosts may not expose focusView. Opening
    // the Ensemble container is the closest safe fallback and avoids failing
    // the user command.
  }

  try {
    await vscode.commands.executeCommand("workbench.view.extension.ai-helper");
  } catch {
    NotificationRouter.showError(
      "Could not open Ensemble Settings automatically. Open the Ensemble sidebar and select Settings."
    );
  }
}

export function registerConfigureStepModelsCommand(
  context: vscode.ExtensionContext,
  settingsViewProvider?: SettingsViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.configureStepModels",
    (arg?: ConfigureModelArg) => configureStepModels(arg, settingsViewProvider)
  );
  context.subscriptions.push(disposable);

  const taskDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.configureTaskStepModels",
    (arg?: ConfigureModelArg) => configureStepModels(arg, settingsViewProvider)
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
    () => revealSettingsView(settingsViewProvider)
  );
  context.subscriptions.push(focusDisposable);
}
