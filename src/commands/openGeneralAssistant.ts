import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";

/**
 * "Open AI Assistant" is an entry point to the task's stage conversation,
 * not a separate one-off runner that writes a response into runs/. Keeping a
 * single stage-scoped conversation prevents questions and answers from being
 * split between unrelated UI flows.
 */
export async function openGeneralAssistant(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<void> {
  const task = await resolveTaskContext(
    inventory,
    undefined,
    { allowPaused: false, promptForOwnershipResolution: true },
    currentTaskStore
  );
  if (!task) {
    void vscode.window.showInformationMessage(
      "Select an active task before opening the AI chat."
    );
    return;
  }

  await vscode.commands.executeCommand("vs-code-ai-helper.chatWithStage", {
    canonicalId: task.canonicalId,
    taskFolderPath: task.taskFolderPath,
    stage: task.progress.currentStage,
  });
}

export function registerOpenGeneralAssistantCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.openGeneralAssistant",
    () => openGeneralAssistant(inventory, currentTaskStore)
  ));
}
