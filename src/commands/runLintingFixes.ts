import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import {
  IncompleteTask,
  patchTaskProgress,
  updateLintPayload,
} from "../utils/taskProgressUtils";
import { NotificationRouter } from "../utils/notificationRouter";

/**
 * Accepted argument shapes for runLintingFixes.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
type RunLintingFixesArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: RunLintingFixesArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  if ("task" in node && node.task) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return hasExplicit
    ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
    : undefined;
}

/**
 * Check if a file URI is inside the task folder.
 * Uses proper path boundary checking to avoid false positives.
 * Case normalization is applied on Windows only for drive-letter compatibility.
 */
function isFileInTaskFolder(fileUri: vscode.Uri, taskFolderPath: string): boolean {
  const filePath = fileUri.fsPath;

  // Normalize separators first
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedTaskPath = taskFolderPath.replace(/\\/g, "/");

  // Apply case normalization on Windows only
  const isCaseSensitive = process.platform !== "win32";
  const compareFilePath = isCaseSensitive
    ? normalizedFilePath
    : normalizedFilePath.toLowerCase();
  const compareTaskPath = isCaseSensitive
    ? normalizedTaskPath
    : normalizedTaskPath.toLowerCase();

  // Ensure task path ends with separator for boundary-safe comparison
  const taskPathWithSeparator = compareTaskPath.endsWith("/")
    ? compareTaskPath
    : compareTaskPath + "/";

  return compareFilePath.startsWith(taskPathWithSeparator) ||
         compareFilePath === compareTaskPath;
}

/**
 * Run linting and automatically fix issues for a completed task.
 * This is intended to be run on tasks in the "completed" stage to ensure
 * code quality before committing.
 */
export async function runLintingFixes(
  inventory: TaskInventory,
  explicitArg?: RunLintingFixesArg
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);

  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    NotificationRouter.showInformation(
      "No task found. Please select a task first."
    );
    return;
  }

  if (
    resolvedTask.progress.currentStage !== "completed" &&
    resolvedTask.progress.currentStage !== "impl-low-review"
  ) {
    NotificationRouter.showWarning(
      "Linting fixes are only available for completed tasks or tasks at the final review stage."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const persistLintState = async (
    passed: boolean,
    summary: string
  ): Promise<void> => {
    await patchTaskProgress(taskFolderUri, (current) =>
      updateLintPayload(current, {
        runAt: new Date().toISOString(),
        passed,
        summary,
      })
    );
  };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Running linting fixes...",
      cancellable: false,
    },
    async (progress) => {
      NotificationRouter.emitProgressSummary("Running linting fixes...");
      try {
        progress.report({ message: "Checking for linting errors..." });

        // Check if there are any TypeScript/JavaScript files with problems in the task folder
        const diagnostics = vscode.languages.getDiagnostics();
        const taskFolderPath = resolvedTask.taskFolderPath;

        const lintingIssues = diagnostics.filter(([uri, diags]) => {
          // Only include diagnostics for files inside the task folder
          if (!isFileInTaskFolder(uri, taskFolderPath)) {
            return false;
          }

          return diags.some(
            (d) =>
              d.source === "eslint" ||
              d.source === "ts" ||
              d.source === "typescript"
          );
        });

        if (lintingIssues.length === 0) {
          await persistLintState(true, "No linting issues found.");
          NotificationRouter.showInformation(
            "No linting issues found in the task folder. Your code looks good!"
          );
          return;
        }

        progress.report({ message: "Applying automatic fixes..." });

        // Open each file with linting issues and apply fixes
        let fixedCount = 0;
        let failedCount = 0;

        for (const [uri, diags] of lintingIssues) {
          const hasEslintIssues = diags.some((d) => d.source === "eslint");

          try {
            // Open the document to ensure it's in the active editor context
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });

            if (hasEslintIssues) {
              // Try to execute ESLint fix command
              await vscode.commands.executeCommand("eslint.executeAutofix");
              fixedCount++;
            } else {
              // Try format document for TypeScript issues
              await vscode.commands.executeCommand("editor.action.formatDocument");
              fixedCount++;
            }
          } catch {
            failedCount++;
          }
        }

        const remainingLintIssues = vscode.languages
          .getDiagnostics()
          .filter(([uri, diags]) => {
            if (!isFileInTaskFolder(uri, taskFolderPath)) {
              return false;
            }
            return diags.some(
              (d) =>
                d.source === "eslint" ||
                d.source === "ts" ||
                d.source === "typescript"
            );
          }).length;

        if (remainingLintIssues === 0) {
          await persistLintState(
            true,
            `Lint fixes complete (${fixedCount} file(s) processed).`
          );
        } else {
          await persistLintState(
            false,
            `${remainingLintIssues} file(s) still report lint issues after auto-fix.`
          );
        }

        if (fixedCount > 0) {
          NotificationRouter.showInformation(
            `Linting fixes applied to ${fixedCount} file(s) in the task folder!` +
            (failedCount > 0 ? ` (${failedCount} file(s) could not be fixed automatically)` : "")
          );
        } else {
          NotificationRouter.showWarning(
            "Could not apply automatic fixes. Please install ESLint extension or fix issues manually."
          );
        }
      } catch (error) {
        await persistLintState(
          false,
          `Linting run failed: ${error instanceof Error ? error.message : String(error)}`
        );
        void vscode.window.showErrorMessage(
          `Linting fixes failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

/**
 * Register the runLintingFixes command.
 */
export function registerRunLintingFixesCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.runLintingFixes",
    (arg?: RunLintingFixesArg) =>
      runLintingFixes(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
