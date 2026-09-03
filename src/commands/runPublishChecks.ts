import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { runCompletionLint, resolvePublishScopeFolder } from "../utils/completionLint";
import { runPublishScopeCheck } from "../utils/publishScopeCheck";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import {
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
  resolveWorkflowRootTaskName,
} from "../utils/taskOperations";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import { normalizePath } from "../utils/taskRoot";
import {
  computePublishScopeId,
  invalidatePublishChecksFreshnessStampOnDiskV1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";

/**
 * Per-task queue for `runPublishChecks` invocations (plan PART 2, step 6): a
 * second trigger arriving while one is already running for the same task
 * must queue behind it and resolve its OWN starting `HEAD` once it actually
 * acquires its turn, rather than either interleaving with the active run or
 * being refused outright. `runTrackedOperation`'s per-task exclusive lock is
 * what makes two overlapping runs impossible; this queue is what turns that
 * refusal into a wait, specifically for two `runPublishChecks` calls
 * stacking on each other. Other exclusive operations (Implementation,
 * Review, ...) are unaffected — they keep the ordinary busy refusal.
 *
 * @internal exported for testing
 */
const publishChecksRunQueues = new Map<string, Promise<unknown>>();

/**
 * @internal exported for testing
 */
export function queuePublishChecksRunV1<T>(
  taskFolderPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = normalizePath(taskFolderPath);
  const previous = publishChecksRunQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  publishChecksRunQueues.set(key, run.catch(() => undefined));
  return run;
}

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
 * verification) and record the result as the Publish-stage report, spliced
 * into publish-review.md (the single unified Publish-stage artifact — plan
 * item 17, step 20). This command only checks and reports — fixing what the
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

  // Queue behind any other runPublishChecks call already in flight for this
  // task (see queuePublishChecksRunV1) so a second closely-triggered run
  // waits its turn instead of being refused. Everything that must observe
  // this run's OWN starting HEAD — the scope guess and beforeSha below —
  // lives inside this queued closure, so it is resolved only once this
  // run actually acquires the lock, never at the moment it was triggered.
  await queuePublishChecksRunV1(lockKey, () =>
    runTrackedOperation(
      lockKey,
      {
        label: "Publish Checks",
        stage: "publish",
        taskName: resolveWorkflowRootTaskName(
          resolvedTask.progress.displayName ?? resolvedTask.folderName,
          resolvedTask.taskFolderPath
        ),
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

              // Freshness stamp (plan PART 2, step 6): resolve HEAD before
              // either check runs, invalidate any previous stamp so nothing
              // can read a stamp whose commit predates this run's output, run
              // both checks, then resolve HEAD again. Only write a new stamp
              // when both resolve and match — proving the checks below ran
              // back-to-back against one unchanged commit. A best-effort
              // pre-run scope guess is used for the "before" SHA; the actual
              // verified folder (known only once checks complete) is used for
              // the "after" SHA and the stamped scope id, so a scope re-pick
              // mid-run correctly fails the match rather than false-passing.
              const scopeGuess = resolvePublishScopeFolder(
                taskFolderUri,
                resolvedTask.progress
              ).folder;
              const beforeSha = await resolveHeadCommitSha(scopeGuess);
              await invalidatePublishChecksFreshnessStampOnDiskV1(taskFolderUri);

              const result = await runCompletionLint(
                taskFolderUri,
                resolvedTask.progress.implReviewFiles
              );
              await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);

              const verifiedFolder = result.verifiedFolder ?? scopeGuess;
              const afterSha = await resolveHeadCommitSha(verifiedFolder);
              if (beforeSha && afterSha && beforeSha === afterSha) {
                await writePublishChecksFreshnessStampV1(taskFolderUri, {
                  formatVersion: 1,
                  runId: crypto.randomUUID(),
                  verifiedCommitSha: afterSha,
                  completedAt: new Date().toISOString(),
                  scopeId: computePublishScopeId(verifiedFolder),
                });
              }
              // A mismatch (working tree advanced mid-run, or HEAD could not be
              // resolved) leaves no stamp — the previous one was already
              // invalidated above, so the report correctly reads as stale
              // rather than carrying a commit that no longer matches its own
              // check output.

              // Keep the tree aligned with the persisted lint payload.
              await inventory.refresh();

              // Opens publish-review.md — the single Publish-stage artifact
              // (plan item 17, step 20). Before the split reversal this used
              // to open publish-review.md too and announce "Report saved" —
              // then the checks were moved to a separate publish-checks.md so
              // the two writers could not clobber each other, which caused a
              // different failure: a user mistook a 49 KB publish-checks.md
              // for their real review (observed 2026-08-23). The split is now
              // reversed — checks upsert their sections directly into
              // publish-review.md under "## Verification (ground truth)" and
              // are re-injected after every AI review write, so this can open
              // the one artifact again without either failure mode returning.
              const publishReviewFilename = STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME;
              await safeOpenTextDocument(
                vscode.Uri.joinPath(taskFolderUri, publishReviewFilename),
                "Publish review"
              );

              if (result.passed) {
                NotificationRouter.showInformation(
                  `Publish checks passed. Report saved to ${publishReviewFilename}.`
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
    )
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
