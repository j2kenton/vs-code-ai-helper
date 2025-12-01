import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  isPromptDismissed,
  dismissPrompt,
  hasValidMetaResourcesPath,
} from "./config/settings";
import {
  selectMetaFolder,
  registerSelectMetaFolderCommand,
} from "./commands/selectMetaFolder";
import { registerStartNewTaskCommand } from "./commands/startNewTask";

/**
 * Button labels for the prompts
 */
const BUTTON_OK = "OK";
const BUTTON_CHANGE = "Change";
const BUTTON_DISMISS = "Dismiss";
const BUTTON_SELECT_FOLDER = "Select Folder";

/**
 * Handle the activation prompt flow based on current configuration state
 */
async function handleActivationPrompt(): Promise<void> {
  // If prompt was previously dismissed, stay silent
  if (isPromptDismissed()) {
    console.log("AI Helper: Prompt dismissed, extension inactive");
    return;
  }

  if (hasValidMetaResourcesPath()) {
    // Path exists - show info with option to change or dismiss
    const currentPath = getMetaResourcesPath();
    const selection = await vscode.window.showInformationMessage(
      `AI Helper using: ${currentPath}`,
      BUTTON_OK,
      BUTTON_CHANGE,
      BUTTON_DISMISS
    );

    if (selection === BUTTON_CHANGE) {
      await selectMetaFolder();
    } else if (selection === BUTTON_DISMISS) {
      await dismissPrompt();
      void vscode.window.showInformationMessage(
        "AI Helper has been dismissed. Reinstall to re-enable."
      );
    }
    // OK or close - continue with current path
  } else {
    // No path configured - prompt to select or dismiss
    const selection = await vscode.window.showInformationMessage(
      "Configure a folder to store AI Helper meta resources (logs, docs, tracking)",
      BUTTON_SELECT_FOLDER,
      BUTTON_DISMISS
    );

    if (selection === BUTTON_SELECT_FOLDER) {
      await selectMetaFolder();
    } else if (selection === BUTTON_DISMISS) {
      await dismissPrompt();
      void vscode.window.showInformationMessage(
        "AI Helper has been dismissed. Reinstall to re-enable."
      );
    }
    // Close without selection - will prompt again next activation
  }
}

/**
 * This method is called when your extension is activated.
 * Your extension is activated the very first time the command is executed.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("VS Code AI Helper is now active!");

  // Register commands
  registerSelectMetaFolderCommand(context);
  registerStartNewTaskCommand(context);

  // Register the hello world command (keeping for now)
  const helloWorldDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.helloWorld",
    () => {
      void vscode.window.showInformationMessage(
        "Hello from VS Code AI Helper!"
      );
    }
  );
  context.subscriptions.push(helloWorldDisposable);

  // Handle activation prompt flow
  void handleActivationPrompt();
}

/**
 * This method is called when your extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup code here
}
