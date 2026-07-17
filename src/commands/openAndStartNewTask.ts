import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { startNewTask } from "./startNewTask";

/**
 * Keyboard shortcut entry point: switches to the Ensemble view container
 * and starts a new task, which shows the task-description input box.
 */
export async function openAndStartNewTask(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  currentTaskStore: CurrentTaskStore,
  context?: vscode.ExtensionContext
): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.ai-helper");
  await startNewTask(inventory, extensionUri, currentTaskStore, context);
}

/**
 * Register the openAndStartNewTask command.
 */
export function registerOpenAndStartNewTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.openAndStartNewTask",
    () => openAndStartNewTask(inventory, context.extensionUri, currentTaskStore, context)
  );
  context.subscriptions.push(disposable);
}
