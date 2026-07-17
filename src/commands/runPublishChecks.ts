import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { runCompletionLint } from "../utils/completionLint";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import {
  runTrackedOperation,
  TaskOperationHandle,
} from "../utils/taskOperations";

/**
 * Accepted argument shapes for runPublishChecks.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
type RunPublishChecksArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: RunPublishChecksArg | undefined): {
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
 * First Publish action: run the completion checks (lint/type/test against the
 * task's Publish verification scope, plus the AI-assisted plan-item
 * verification) and record the result as the Publish-stage report in
 * publish-review.md. This command only checks and reports — fixing what the
 * report found is the separate second action (runLintingFixes).
 */
export async function runPublishChecks(
  inventory: TaskInventory,
  explicitArg?: RunPublishChecksArg,
  parentOperation?: TaskOperationHandle
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

  if (resolvedTask.progress.currentStage !== "publish") {
    NotificationRouter.showWarning(
      "Publish checks are only available for tasks at the Publish stage."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);

  // The inline tree button invokes this command directly (not through
  // applyCurrentStageAction), so the run-time model guard must live here
  // too: with no Publish model configured — or its provider disabled —
  // warn and open AI Models instead of running checks whose plan
  // verification would silently be recorded as unavailable.
  if (!(await ensureStageModelConfigured(taskFolderUri, "publish"))) {
    return;
  }

  const lockKey = taskFolderUri.fsPath;

  await runTrackedOperation(
    lockKey,
    {
      label: "Publish Checks",
      stage: "publish",
      taskName: resolvedTask.folderName,
      kind: "completion-checks",
      parent: parentOperation,
    },
    async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Running Publish checks (lint, tests, plan verification)...",
          cancellable: false,
        },
        async (progress) => {
          NotificationRouter.emitProgressSummary("Running Publish checks...");
          try {
            progress.report({ message: "Running lint, type and test checks..." });
            const result = await runCompletionLint(
              taskFolderUri,
              resolvedTask.progress.implReviewFiles
            );

            // Keep the tree aligned with the persisted lint payload.
            await inventory.refresh();

            const reportName = STAGE_ARTIFACT_FILENAMES.publish;
            if (reportName) {
              await safeOpenTextDocument(
                vscode.Uri.joinPath(taskFolderUri, reportName),
                "Publish report"
              );
            }

            if (result.passed) {
              NotificationRouter.showInformation(
                `Publish checks passed. Report saved to ${reportName ?? "the Publish review"}.`
              );
            } else {
              NotificationRouter.showWarning(
                `Publish checks found issues: ${result.summary} ` +
                  'Use "Fix Linting & Code Errors" to address the report.'
              );
            }
          } catch (error) {
            void vscode.window.showErrorMessage(
              `Publish checks failed to run: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      );
    }
  );
}

/**
 * Register the runPublishChecks command.
 */
export function registerRunPublishChecksCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.runPublishChecks",
    (arg?: RunPublishChecksArg) => runPublishChecks(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
