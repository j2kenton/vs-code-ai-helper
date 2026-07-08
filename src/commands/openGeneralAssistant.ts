import * as vscode from "vscode";

/**
 * Open a general AI assistant panel for help when the workflow gets stuck.
 * Uses Copilot Auto by default for quick assistance without configuration.
 */
export async function openGeneralAssistant(): Promise<void> {
  // Try to open Copilot Chat
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open");
    void vscode.window.showInformationMessage(
      "AI Assistant opened. Ask for help with your workflow!"
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Failed to open AI assistant: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Register the openGeneralAssistant command.
 */
export function registerOpenGeneralAssistantCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.openGeneralAssistant",
    () => openGeneralAssistant()
  );
  context.subscriptions.push(disposable);
}
