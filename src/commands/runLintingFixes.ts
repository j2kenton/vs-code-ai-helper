import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgress } from "../utils/taskProgressUtils";
import { updateLintPayload } from "../utils/taskProgressTransforms";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  runCompletionLint,
  resolvePublishScopeFolder,
} from "../utils/completionLint";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { generateContextPack } from "../utils/contextPack";
import {
  ensureStageModelConfigured,
  resolveFreshModelForStage,
} from "../utils/modelSelection";
import { runImplementationForModel } from "../runners/runnerRegistry";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { ensureAiConsent } from "../utils/aiConsent";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import {
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
} from "../utils/taskOperations";

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
 * Check if a file URI is inside the given folder (the task's resolved
 * Publish verification scope).
 * Uses proper path boundary checking to avoid false positives.
 * Case normalization is applied on Windows only for drive-letter compatibility.
 */
function isFileInFolder(fileUri: vscode.Uri, folderPath: string): boolean {
  const filePath = fileUri.fsPath;

  // Normalize separators first
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedFolderPath = folderPath.replace(/\\/g, "/");

  // Apply case normalization on Windows only
  const isCaseSensitive = process.platform !== "win32";
  const compareFilePath = isCaseSensitive
    ? normalizedFilePath
    : normalizedFilePath.toLowerCase();
  const compareFolderPath = isCaseSensitive
    ? normalizedFolderPath
    : normalizedFolderPath.toLowerCase();

  // Ensure folder path ends with separator for boundary-safe comparison
  const folderPathWithSeparator = compareFolderPath.endsWith("/")
    ? compareFolderPath
    : compareFolderPath + "/";

  return compareFilePath.startsWith(folderPathWithSeparator) ||
         compareFilePath === compareFolderPath;
}

/**
 * Second Publish action: fix the issues the latest Publish-checks report
 * (persisted lint payload + publish-review.md, produced by runPublishChecks)
 * identified. Applies editor autofixes first, then hands remaining failures
 * to the Publish-stage AI agent, and re-runs the checks afterwards so the
 * report reflects the post-fix state. It never runs the initial checks
 * itself — with no report yet, it directs the user to the first action.
 *
 * When `parentOperation` is supplied (the publish flow's "Fix with AI"
 * choice), the fix run registers as a child of that operation (C1 nesting):
 * it never contends for the exclusive lock the parent already holds, and the
 * stage-row spinner follows the fix sub-stage instead of a second
 * Notifications row appearing.
 */
export async function runLintingFixes(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  explicitArg?: RunLintingFixesArg,
  context?: vscode.ExtensionContext,
  parentOperation?: TaskOperationHandle
): Promise<void> {
  assertLegacyAiRouteAllowedV0("lint.v1");
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
    resolvedTask.progress.currentStage !== "publish"
  ) {
    NotificationRouter.showWarning(
      "Linting fixes are only available for completed tasks."
    );
    return;
  }

  // Fix what the LAST Publish-checks report found — this action never runs
  // the initial checks itself. The first Publish action (runPublishChecks)
  // produces the report; checks re-run here only AFTER fixes, to verify them
  // and refresh the report. Gated before the tracked operation so the
  // "Run Publish Checks" fallback never contends with this action's own
  // exclusive task lock.
  const lastReport = resolvedTask.progress.lintPayload;
  if (!lastReport) {
    NotificationRouter.showWarning(
      "No Publish report found. Run the Publish checks first to generate " +
        "the report this action fixes.",
      undefined,
      undefined,
      undefined,
      {
        command: "vs-code-ai-helper.runPublishChecks",
        title: "Run Publish Checks",
        args: [{ taskFolderPath: resolvedTask.taskFolderPath }],
      }
    );
    return;
  }
  if (lastReport.passed) {
    NotificationRouter.showInformation(
      "The latest Publish checks passed — there is nothing to fix. " +
        "Re-run the Publish checks if files changed since the last report."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);

  // The inline tree button invokes this command directly (not through
  // applyCurrentStageAction), so the run-time model guard must live here
  // too — and before any mutation: with no Publish model configured, or
  // its provider disabled, the action must warn and open AI Models rather
  // than autofix/format files first and only fail at the AI pass.
  if (!(await ensureStageModelConfigured(taskFolderUri, "publish"))) {
    return;
  }

  // Deterministic autofixes and the diagnostics handed to the AI pass are
  // limited to the same Publish verification scope the report was produced
  // against — never the whole workspace, which in a monorepo would autofix
  // unrelated packages. A stale persisted scope is re-established through
  // the first action (which re-prompts for a valid one), not silently
  // widened to the workspace root. Resolved before the tracked operation so
  // the fallback dispatch below never contends with this action's own lock.
  const scope = resolvePublishScopeFolder(taskFolderUri, resolvedTask.progress);
  if (scope.stale) {
    NotificationRouter.showWarning(
      "No valid Publish verification scope could be resolved (the saved scope " +
        "or the task's project-root binding no longer exists). Re-run the " +
        "Publish checks to choose a new scope before applying fixes.",
      undefined,
      undefined,
      undefined,
      {
        command: "vs-code-ai-helper.runPublishChecks",
        title: "Run Publish Checks",
        args: [{ taskFolderPath: resolvedTask.taskFolderPath }],
      }
    );
    return;
  }
  const fixScopeFolder = scope.folder;

  const lockKey = taskFolderUri.fsPath;
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

  await runTrackedOperation(
    lockKey,
    { label: "Linting Fixes", stage: "publish", taskName: resolvedTask.folderName, kind: "lint-fixes", parent: parentOperation },
    async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Running linting fixes...",
          cancellable: false,
        },
        async (progress) => {
          NotificationRouter.emitProgressSummary(
            "Running linting fixes...",
            taskOperations.rootOperationIdFor(lockKey)
          );
          try {
            progress.report({ message: "Checking for linting errors..." });

            // Check for TypeScript/JavaScript files with problems inside the
            // task's Publish verification scope
            const diagnostics = vscode.languages.getDiagnostics();

            const lintingIssues = diagnostics.filter(([uri, diags]) => {
              // Only include diagnostics for files inside the Publish scope
              if (!isFileInFolder(uri, fixScopeFolder)) {
                return false;
              }

              return diags.some(
                (d) =>
                  d.source === "eslint" ||
                  d.source === "ts" ||
                  d.source === "typescript"
              );
            });

            const relevantFiles = resolvedTask.progress.implReviewFiles;

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

                // Fix commands can leave edits only in the in-memory document.
                // Persist them before collecting the post-fix result so the lint
                // payload describes what is actually on disk.
                if (doc.isDirty) {
                  await doc.save();
                }
              } catch {
                failedCount++;
              }
            }

            const remainingLintIssues = vscode.languages
              .getDiagnostics()
              .filter(([uri, diags]) => {
                if (!isFileInFolder(uri, fixScopeFolder)) {
                  return false;
                }
                return diags.some(
                  (d) =>
                    d.source === "eslint" ||
                    d.source === "ts" ||
                    d.source === "typescript"
                );
              }).length;

            const postFixLint = await runCompletionLint(taskFolderUri, relevantFiles);

            if (!postFixLint.passed) {

              // Automatic editor fixes are only the first pass. Give the
              // Publish-stage agent the remaining diagnostics so it can make
              // focused edits while the task remains completed.
              const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
              if (workspaceFolder) {
                // This is a Publish-stage action, so the AI fix pass runs with
                // the model configured for the Publish stage — a user who set
                // a specialized Publish model must not have their lint/test
                // fixes run by the unrelated Implementation model.
                const model = await resolveFreshModelForStage(taskFolderUri, "publish");
                const postFixDiagnostics = vscode.languages.getDiagnostics().filter(([uri, ds]) => isFileInFolder(uri, fixScopeFolder) && ds.some((d) => d.source === "eslint" || d.source === "ts" || d.source === "typescript"));
                const lint = JSON.stringify({
                  summary: postFixLint.summary,
                  issueCount: postFixLint.issueCount,
                  failedChecks: postFixLint.failedChecks,
                  remainingFiles: remainingLintIssues,
                  diagnostics: postFixDiagnostics.map(([uri, ds]) => ({ file: uri.fsPath, messages: ds.map((d) => d.message) })),
                }, null, 2);
                const contextPack = await generateContextPack(taskFolderUri, workspaceFolder.uri);
                const prompt = await renderPromptTemplate(extensionUri, "final-fixes-code.md", { lint, contextPack });
                const sizeCheck = await checkAndConfirmPromptSize(prompt, "the configured Publish-stage agent");
                if (sizeCheck === "ok" || sizeCheck === "confirmed") {
                  if (!context || !(await ensureAiConsent(context))) {
                    return;
                  }
                  let result: Awaited<ReturnType<typeof runImplementationForModel>> | undefined;
                  await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Applying AI final fixes...", cancellable: true }, async (aiProgress, token) => {
                    // `model` is resolved from the "publish" stage above —
                    // fallback bookkeeping must use that same stage.
                    result = await runImplementationForModel({ modelId: model.modelId, prompt, workspaceUri: workspaceFolder.uri, token, stage: "publish", taskFolderUri: taskFolderUri, onProgress: (message) => aiProgress.report({ message }) });
                  });
                  if (result?.status === "completed") {
                    await runCompletionLint(taskFolderUri, relevantFiles);
                    await inventory.refresh();
                    NotificationRouter.showInformation("AI final fixes applied; completion lint was rerun.");
                  } else {
                    await runCompletionLint(taskFolderUri, relevantFiles);
                    if (result?.errorMessage) {
                      NotificationRouter.showWarning(`AI final fixes failed: ${result.errorMessage}`);
                    } else {
                      NotificationRouter.showWarning("AI final fixes were cancelled; completion lint was rerun.");
                    }
                  }
                }
              }
            }

            // Keep the tree and subsequent command resolution aligned with the
            // refreshed persisted lint payload.
            await inventory.refresh();

            if (fixedCount > 0) {
              NotificationRouter.showInformation(
                `Linting fixes applied to ${fixedCount} file(s) in the Publish scope!` +
                (failedCount > 0 ? ` (${failedCount} file(s) could not be fixed automatically)` : "")
              );
            } else {
              NotificationRouter.showWarning(
                "Could not apply automatic fixes. Please install ESLint extension or fix issues manually."
              );
            }
          } catch (error) {
            try {
              await runCompletionLint(taskFolderUri, resolvedTask.progress.implReviewFiles);
            } catch {
              await persistLintState(
                false,
                `Linting run failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            NotificationRouter.showError(
              `Linting fixes failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      );
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
      runLintingFixes(inventory, context.extensionUri, arg, context)
  );
  context.subscriptions.push(disposable);
}
