import * as vscode from "vscode";

/**
 * This method is called when your extension is activated.
 * Your extension is activated the very first time the command is executed.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("VS Code AI Helper is now active!");

  // Register the hello world command
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.helloWorld",
    () => {
      void vscode.window.showInformationMessage(
        "Hello from VS Code AI Helper!"
      );
    }
  );

  context.subscriptions.push(disposable);
}

/**
 * This method is called when your extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup code here
}
