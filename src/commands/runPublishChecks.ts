import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { resolveTaskContext, peekTaskFolderPathSynchronouslyV1 } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
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
import { normalizePath, resolveTaskRootCandidates } from "../utils/taskRoot";
import {
  computePublishScopeId,
  invalidatePublishChecksFreshnessStampOnDiskV1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import {
  acquireEarlyWorkAdmissionForCandidatePathV1,
  acquireOrAdoptWorkAdmissionV1,
  beginTargetResolutionV1,
  describeTargetResolutionWriteFailureV1,
  describeWorkAdmissionRefusalV1,
  endTargetResolutionV1,
  WorkAdmissionHandleV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
} from "../state/workAdmissionV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";

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
 * - `applyCurrentStageAction` (and through it `scheduleTaskResume.ts`'s
 *   `fire()`) dispatches { canonicalId, taskFolderPath, task: { progress },
 *   admissionHandoffTokenV1? } — explicit fields plus a PARTIAL task with no
 *   `folderUri` (2026-09-09 review completion blocker; see
 *   `extractSynchronousPublishChecksFolderPathV1` and
 *   `extractAdmissionHandoffTokenV1` below).
 */
type RunPublishChecksArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; admissionHandoffTokenV1?: string };

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
 * Synchronously extract a task folder path from `explicitArg`, when the
 * shape carries one directly — mirrors
 * `runLintingFixes.ts`'s `extractSynchronousLintingFolderPathV1` (v1 fixes
 * item 1, Part 1a, "publish/complete actions" route). Lets admission be
 * acquired before the command's first awaited setup step
 * (`TaskCreationStartupReconcilerV1.waitUntilReady()`) for the dominant
 * invocation (the Publish stage's tree-row/inline button), rather than only
 * after `resolveTaskContext` resolves a bare canonicalId.
 *
 * Explicit `taskFolderPath` (or a resolvable `canonicalId`'s sibling field)
 * MUST win over the `task` shape, and `task.folderUri` MUST be read with
 * optional chaining (2026-09-09 review completion blocker): unlike a
 * tree-row button, which passes a REAL `IncompleteTask` with a live
 * `folderUri`, `applyCurrentStageAction` dispatches
 * `{ canonicalId, taskFolderPath, task: { progress } }` — a partial `task`
 * carrying no `folderUri` at all. Reading `node.task.folderUri.fsPath`
 * unconditionally, before checking the explicit fields, threw on every
 * Publish dispatch through that router (including scheduled firing),
 * mirroring `normalizeRunPublishChecksArg`'s own already-correct precedence.
 */
function extractSynchronousPublishChecksFolderPathV1(node: RunPublishChecksArg | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  const n = node as { canonicalId?: string; taskFolderPath?: string };
  if (n.taskFolderPath) {
    return n.taskFolderPath;
  }
  if ("task" in node && node.task?.folderUri?.fsPath) {
    return node.task.folderUri.fsPath;
  }
  return undefined;
}

/**
 * Extract `admissionHandoffTokenV1` from `explicitArg`, when present —
 * mirrors `reviewActions.ts`'s identically-named helper (2026-09-09 review
 * completion blocker: this route previously never accepted or adopted the
 * token `applyCurrentStageAction`/`scheduleTaskResume.ts`'s `fire()` forward,
 * so a scheduled Publish dispatch always raced a fresh genesis against the
 * caller's own already-live marker and observed `busy`). Only the
 * `{ canonicalId?, taskFolderPath?, admissionHandoffTokenV1? }` shape ever
 * carries it — the tree-row `{ task }` shape never does, so a UI-originated
 * invocation can never accidentally supply one and trigger adoption.
 */
function extractAdmissionHandoffTokenV1(node: RunPublishChecksArg | undefined): string | undefined {
  if (!node || !("admissionHandoffTokenV1" in node)) {
    return undefined;
  }
  return typeof node.admissionHandoffTokenV1 === "string" ? node.admissionHandoffTokenV1 : undefined;
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
  parentOperation?: TaskOperationHandle,
  currentTaskStore?: CurrentTaskStore
): Promise<boolean> {
  // Whether this call actually reached and began the protected checks run —
  // as opposed to refusing during an earlier guard clause (no task, wrong
  // stage, no model configured). 2026-09-09 review completion blocker: the
  // caller (applyCurrentStageAction, and through it scheduleTaskResume's
  // `fire()`) needs to distinguish the two so a scheduled fire that never
  // started real work can restore its schedule instead of losing it.
  let dispatched = false;

  // Computed up front (pure/synchronous) so it can feed BOTH the early
  // admission guess below and the authoritative resolution inside the try
  // block, without normalizing `explicitArg` twice.
  const resolverArg = normalizeRunPublishChecksArg(explicitArg);

  // ── Early work admission (v1 fixes item 1, Part 1a, "publish/complete
  // actions" route) ──────────────────────────────────────────────────────
  // Acquire durable admission BEFORE the startup activation-order barrier
  // below — this command's first awaited setup step — whenever the target
  // folder is known synchronously: directly from `explicitArg` (the
  // dominant invocation: the Publish stage's tree-row/inline button), or
  // else via `peekTaskFolderPathSynchronouslyV1`'s in-memory inventory/
  // current-task lookup (2026-09-09 review completion blocker: a
  // canonicalId-only or true no-arg invocation used to fall through to
  // "late" admission AFTER `waitUntilReady()`/`resolveTaskContext`, leaving
  // the exact setup-phase race Part 1a exists to close, open for those two
  // shapes). Publish checks run real lint/type/test work
  // (`runCompletionLint`/`runPublishScopeCheck`) that can take long enough
  // for the watchdog sweep to observe an `active` task with nothing durable
  // yet recorded.
  //
  // The peek is a best-effort GUESS (stale cache, or a persisted current-task
  // pointer that no longer matches what `resolveTaskContext` authoritatively
  // resolves to) — corrected below, once the real resolution is in, by
  // releasing a wrong guess and reacquiring for the right target.
  //
  // 2026-09-09 review completion blocker: this command's own registration
  // never threaded a `CurrentTaskStore` through at all — so a true no-arg
  // invocation (`resolverArg` undefined) never had the persisted current-task
  // pointer available to either this peek or the authoritative
  // `resolveTaskContext` call below, and always resolved as "no task found"
  // instead of acting on the current task. `registerRunPublishChecksCommand`
  // and its `extension.ts` call site now pass the shared `currentTaskStore`,
  // matching every other lifecycle command's registration.
  //
  // 2026-09-10 review completion blocker (narrowed further): the
  // resolution-in-flight stand-down (`beginTargetResolutionV1`) used to start
  // only around the `resolveTaskContext` call further below — AFTER this
  // early guessed-target admission had already been awaited. The guess can be
  // wrong (stale cache) or entirely absent (a true no-arg invocation with a
  // cold current-task-store), and while this await was outstanding the
  // watchdog was still free to pause whatever the eventual real target turns
  // out to be, since the same-process stand-down had not begun yet. Starting
  // it here closes that gap; `endTargetResolutionV1()` (in the inner
  // `finally` below, once resolution completes) balances this call on every
  // path, including the early-refusal return immediately below.
  const taskRootCandidatePathsV1 = resolveTaskRootCandidates().map((candidate) => candidate.absolutePath);
  const targetResolutionHandle = await beginTargetResolutionV1(taskRootCandidatePathsV1);
  // 2026-09-11 review completion blocker (`b5a1f851...-0`): a real filesystem
  // write error protecting this resolution window must fail dispatch before
  // setup, same as a per-task admission write error already does — never
  // silently fall through to same-process-only protection.
  if (targetResolutionHandle.writeFailedRootPaths.length > 0) {
    NotificationRouter.showError(describeTargetResolutionWriteFailureV1(targetResolutionHandle));
    await endTargetResolutionV1(targetResolutionHandle);
    return dispatched;
  }
  // 2026-09-11 review architectural blocker (`d620c877...-1`): route through
  // the shared early-admission helper (validation-before-bookkeeping plus
  // containment observability against `taskRootCandidatePathsV1`) instead of
  // acquiring bookkeeping directly against an unvalidated raw/peeked path —
  // `resolveTaskContext` below remains the sole authoritative
  // ownership/workspace-binding check.
  const earlyFolderPath =
    extractSynchronousPublishChecksFolderPathV1(explicitArg) ??
    peekTaskFolderPathSynchronouslyV1(inventory, resolverArg, currentTaskStore);
  const early = await acquireEarlyWorkAdmissionForCandidatePathV1({
    candidatePath: earlyFolderPath,
    purpose: "admission",
    commandId: "runPublishChecks",
    handoffToken: extractAdmissionHandoffTokenV1(explicitArg),
    taskRootCandidatePaths: taskRootCandidatePathsV1,
  });
  if (early && early.outcome !== "acquired") {
    await endTargetResolutionV1(targetResolutionHandle);
    NotificationRouter.showWarning(describeWorkAdmissionRefusalV1(early));
    return dispatched;
  }

  // Single mutable admission slot for the whole command — filled either by
  // the early acquisition above or, once the authoritative target is
  // resolved, right after `resolveTaskContext` below (a genuine cold-cache
  // miss, or a corrected reacquisition when the early guess above turns out
  // to have targeted the wrong folder). Released in `finally` regardless of
  // which branch of this command returns.
  let handle: WorkAdmissionHandleV1 | undefined = early?.outcome === "acquired" ? early.handle : undefined;
  let heartbeat = handle ? setInterval(() => void handle!.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1) : undefined;
  const releaseCurrentAdmissionV1 = async (): Promise<void> => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (handle) {
      const toRelease = handle;
      handle = undefined;
      await toRelease.release();
    }
  };

  try {
  // Activation-order barrier (plan §1.4): never read task state while the
  // startup creating-folder classification pass is still running.
  //
  // 2026-09-10 review completion blocker (narrowed further): per-task
  // admission cannot protect a target that is not yet known — the earlier
  // peek above can miss a refresh-discovered actual target entirely (its
  // guess predates the refresh that first reveals such a target). The
  // watchdog's whole pause pass stays stood down (via
  // `beginTargetResolutionV1`, now called BEFORE the early guessed-target
  // admission acquisition above — see that call site's own comment) through
  // this barrier plus resolution below, so a task the command is about to
  // admit and start work on can never be paused underneath it during this
  // specific gap. `endTargetResolutionV1()` in the `finally` immediately
  // below balances that single `beginTargetResolutionV1()` call.
  let resolvedTask: Awaited<ReturnType<typeof resolveTaskContext>>;
  try {
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  // 2026-09-10 review completion blocker ("publish/complete actions" route,
  // narrowed further): upgrade admission the INSTANT resolveTaskContext
  // settles on its final candidate, rather than waiting for it to fully
  // return — see `ResolveTaskOptions.onResolvedCandidate`'s doc comment. A
  // persisted pointer that is a cache miss resolving (via resolveTaskContext's
  // own awaited `inventory.refresh()`) to a paused task, while the real
  // active target only becomes visible in the POST-refresh inventory, means
  // the peek above could not have guessed that target; this hook narrows the
  // window in which it holds no admission to the architectural minimum. The
  // block below the call remains as a defense-in-depth no-op for the
  // ordinary case where this already ran.
  const admitCandidateV1 = async (candidate: TaskWithProgress): Promise<void> => {
    if (handle && handle.taskFolderPath !== candidate.taskFolderPath) {
      await releaseCurrentAdmissionV1();
    }
    if (!handle) {
      const late = await acquireOrAdoptWorkAdmissionV1({
        taskFolderPath: candidate.taskFolderPath,
        purpose: "admission",
        commandId: "runPublishChecks",
        handoffToken: extractAdmissionHandoffTokenV1(explicitArg),
      });
      if (late.outcome === "acquired") {
        handle = late.handle;
        heartbeat = setInterval(() => void handle!.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
      }
    }
  };

  resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
    onResolvedCandidate: admitCandidateV1,
  }, currentTaskStore);
  } finally {
    await endTargetResolutionV1(targetResolutionHandle);
  }

  if (!resolvedTask) {
    NotificationRouter.showInformation(
      "No task found. Please select a task first."
    );
    return dispatched;
  }

  // The early guess above (when it came from the peek, not a direct
  // explicit-arg folder path) can target the wrong task — a stale inventory
  // cache entry, or a persisted current-task pointer that resolution itself
  // corrected. Release it and fall through to the ordinary late-acquisition
  // path below, which acquires for the AUTHORITATIVE folder.
  if (handle && handle.taskFolderPath !== resolvedTask.taskFolderPath) {
    await releaseCurrentAdmissionV1();
  }

  if (!handle) {
    const late = await acquireOrAdoptWorkAdmissionV1({
      taskFolderPath: resolvedTask.taskFolderPath,
      purpose: "admission",
      commandId: "runPublishChecks",
      handoffToken: extractAdmissionHandoffTokenV1(explicitArg),
    });
    if (late.outcome !== "acquired") {
      NotificationRouter.showWarning(describeWorkAdmissionRefusalV1(late));
      return dispatched;
    }
    handle = late.handle;
    heartbeat = setInterval(() => void handle!.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
  }

  // Admission is now guaranteed live for this exact target — reverse a
  // watchdog-provenance pause (never a user pause) before any further setup,
  // exactly like `runReviewWithAI`/`runLintingFixes`.
  //
  // 2026-09-10 review completion blocker (new): the reconciliation result was
  // previously discarded — a genuine `userPaused` (a real user pause, not a
  // watchdog one) or `unreadable` (progress could not be confirmed at all)
  // outcome must stop this command from continuing into the checks below,
  // exactly as `completeCommitAndPushTask`'s own first reconciliation already
  // does. `resolvedTask.progress.status` is only the pre-reconciliation
  // snapshot and cannot by itself distinguish "genuinely paused right now"
  // from "was paused by the watchdog and this call just reversed it".
  const publishReconcileOutcome = await reconcileWatchdogPauseAgainstAdmissionV1(
    vscode.Uri.file(resolvedTask.taskFolderPath)
  );
  if (
    publishReconcileOutcome.outcome === "userPaused" ||
    publishReconcileOutcome.outcome === "unreadable"
  ) {
    NotificationRouter.showWarning(
      "Publish checks are only available for tasks that are not paused. Resume the task first."
    );
    return dispatched;
  }

  if (resolvedTask.progress.currentStage !== "publish") {
    NotificationRouter.showWarning(
      "Publish checks are only available for tasks at the Publish stage."
    );
    return dispatched;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);

  // The inline tree button invokes this command directly (not through
  // applyCurrentStageAction), so the run-time model guard must live here
  // too: with no Publish model configured — or its provider disabled —
  // warn and open AI Models instead of running checks whose plan
  // verification would silently be recorded as unavailable.
  if (!(await ensureStageModelConfigured(taskFolderUri, "publish"))) {
    return dispatched;
  }

  const lockKey = taskFolderUri.fsPath;

  // Queue behind any other runPublishChecks call already in flight for this
  // task (see queuePublishChecksRunV1) so a second closely-triggered run
  // waits its turn instead of being refused. Everything that must observe
  // this run's OWN starting HEAD — the scope guess and beforeSha below —
  // lives inside this queued closure, so it is resolved only once this
  // run actually acquires the lock, never at the moment it was triggered.
  //
  // `runTrackedOperation` resolves `undefined` both when `taskOperations`
  // refuses the run as busy (fn never invoked) AND when fn itself completes
  // normally with no return value — the two are indistinguishable from the
  // outer `undefined` alone. The callback below returns `true` once it has
  // actually been invoked, so `dispatched` can tell "began the tracked run"
  // apart from "refused as busy" (2026-09-09 review completion blocker,
  // narrowed: Publish previously reported dispatched unconditionally,
  // before knowing whether runTrackedOperation would refuse).
  const ranTrackedOperation = await queuePublishChecksRunV1(lockKey, () =>
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
      async (): Promise<true> => {
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
        return true;
      }
    )
  );
  dispatched = ranTrackedOperation === true;
  return dispatched;
  } finally {
    await releaseCurrentAdmissionV1();
  }
}

/**
 * Register the runPublishChecks command.
 */
export function registerRunPublishChecksCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore?: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.runPublishChecks",
    (arg?: RunPublishChecksArg) => runPublishChecks(inventory, arg, undefined, currentTaskStore)
  );
  context.subscriptions.push(disposable);
}
