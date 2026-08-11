import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { runCompletionLint } from "../utils/completionLint";
import { runPublishScopeCheck } from "../utils/publishScopeCheck";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { PUBLISH_CHECKS_FILENAME } from "../types/taskProgress";
import {
  runTrackedOperation,
  taskOperations,
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
 *
 * The explicit { canonicalId / taskFolderPath } shape wins over the tree-node
 * { task } shape: the keyboard-shortcut router (applyCurrentStageAction)
 * dispatches both fields plus a partial `task` carrying only `progress`, so
 * reading `task.folderUri.fsPath` first would throw on that arg.
 *
 * @internal exported for testing
 */
export function normalizeRunPublishChecksArg(node: RunPublishChecksArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  if (n.canonicalId || n.taskFolderPath) {
    return { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath };
  }

  if ("task" in node && node.task && node.task.folderUri?.fsPath) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  return undefined;
}

/**
 * First Publish action: run the completion checks (lint/type/test against the
 * task's Publish verification scope, plus the AI-assisted plan-item
 * verification) and record the result as the Publish-stage report in
 * publish-checks.md. This command only checks and reports — fixing what the
 * report found is the separate second action (runLintingFixes).
 */
export async function runPublishChecks(
  inventory: TaskInventory,
  explicitArg?: RunPublishChecksArg,
  parentOperation?: TaskOperationHandle
): Promise<void> {
  // Activation-order barrier (plan §1.4): never read task state while the
  // startup creating-folder classification pass is still running.
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const resolverArg = normalizeRunPublishChecksArg(explicitArg);

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
          NotificationRouter.emitProgressSummary(
            "Running Publish checks...",
            taskOperations.rootOperationIdFor(lockKey)
          );
          try {
            progress.report({ message: "Running lint, type and test checks..." });
            const result = await runCompletionLint(
              taskFolderUri,
              resolvedTask.progress.implReviewFiles
            );
            await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);

            // Keep the tree aligned with the persisted lint payload.
            await inventory.refresh();

            // Opens the report these checks just wrote, not the reviewer's
            // artifact. This used to open publish-review.md and announce
            // "Report saved" — but the checks only ever upserted a section
            // partway down that file, so what surfaced was the AI verdict at
            // the top, from whichever commit the last review ran against.
            // Observed live 2026-08-11: a fully passing run opened a
            // "Readiness: 2/10" document listing three blockers that had all
            // been fixed, and re-running the checks could not change it.
            await safeOpenTextDocument(
              vscode.Uri.joinPath(taskFolderUri, PUBLISH_CHECKS_FILENAME),
              "Publish checks report"
            );

            if (result.passed) {
              NotificationRouter.showInformation(
                `Publish checks passed. Report saved to ${PUBLISH_CHECKS_FILENAME}.`
              );
            } else {
              NotificationRouter.showWarning(
                `Publish checks found issues: ${result.summary} ` +
                  'Use "Fix Linting & Code Errors" to address the report.'
              );
            }
          } catch (error) {
            NotificationRouter.showError(
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
