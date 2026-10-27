import * as vscode from "vscode";
import { forwardInViewerV1 } from "../services/viewerForwardingV1";
import * as crypto from "node:crypto";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { resolveTaskContext, peekTaskFolderPathSynchronouslyV1 } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  PublishChecksCancelledError,
  describeCurrentPackageManagerV1,
  resolveCurrentPublishCommandPlanV1,
  resolvePublishScopeFolder,
  runCompletionLint,
  persistCompletionLintResultV1,
  throwIfPublishChecksCancelledV1,
} from "../utils/completionLint";
import { runPublishScopeCheck } from "../utils/publishScopeCheck";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { handBackToHumanAfterPublishChecksV1 } from "../utils/taskProgressTransforms";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { safeOpenTextDocument, writeTextFile, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { COMMIT_AND_PUSH_COMMAND_V1, publishNextStepOfferV1 } from "../utils/publishStageActionsV1";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import {
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
  resolveWorkflowRootTaskName,
} from "../utils/taskOperations";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import { normalizePath, resolveTaskRootCandidates } from "../utils/taskRoot";
import { notificationTaskDisplayNameV1 } from "../utils/notificationTaskContextV1";
import {
  clearStageActionTerminalOutcomeV1,
  recordStageActionTerminalOutcomeV1,
} from "../utils/stageActionRefusalV1";
import {
  computePublishScopeId,
  computeTreeFingerprintV1,
  invalidatePublishChecksFreshnessStampOnDiskV1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import {
  acquireEarlyWorkAdmissionForCandidatePathV1,
  acquireOrAdoptWorkAdmissionV1,
  beginTargetResolutionV1,
  describeTargetResolutionUnprotectedRootsV1,
  describeTargetResolutionWriteFailureV1,
  describeWorkAdmissionRefusalV1,
  endTargetResolutionV1,
  WorkAdmissionHandleV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
} from "../state/workAdmissionV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import { listCheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";
import { invalidatePlanItemEvidenceContradictedByFailuresV1 } from "../utils/taskProgressTransforms";
import { associatePublishFailuresWithPlanItemsV1, formatPublishFailurePlanAssociationsV1, ownerHandOffCoverageFromTaskMdV1 } from "../utils/publishFailurePlanAssociationV1";
import {
  buildFailedPublishFirstTargetsV1,
  buildFailedPublishRunSnapshotV1,
  clearFailedPublishRunSnapshotV1,
  isFailedPublishRunCompatibleV1,
  readFailedPublishRunSnapshotV1,
  writeFailedPublishRunSnapshotV1,
} from "../utils/failedPublishRunV1";

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

/** Posts the retry action when an automated Publish Checks execution throws. */
export async function offerPublishChecksRetryAfterExecutionFailureV1(
  taskFolderUri: vscode.Uri,
  taskLabel: string | undefined,
  error: unknown
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const noticeText = `Publish checks failed to run: ${detail}. Run Publish Checks again after the problem is fixed.`;
  let chatPointer: Awaited<ReturnType<typeof offerActionInChatV1>>;
  try {
    chatPointer = await offerActionInChatV1({
      taskFolderPath: taskFolderUri.fsPath,
      taskLabel,
      actionLabel: "Run Publish Checks",
      command: "vs-code-ai-helper.runPublishChecks",
      args: [{ taskFolderPath: taskFolderUri.fsPath }],
      noticeText,
      optional: true,
    });
  } catch (chatError) {
    console.warn("Could not post the Publish Checks retry in chat:", chatError);
    chatPointer = undefined;
  }
  NotificationRouter.showError(
    `${noticeText}${chatPointer ? " Open the decision in Chat to continue." : ""} /* taskLabel */`,
    undefined,
    undefined,
    undefined,
    chatPointer
  );
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
  | {
      canonicalId?: string;
      taskFolderPath?: string;
      admissionHandoffTokenV1?: string;
      /** In-process only: the live Fast Forward root this run's checks nest under. */
      parentOperation?: TaskOperationHandle;
      /** Set by `checkAndReviewPublishV1`, which starts the Publish review itself once the checks are fresh. */
      reviewFollowsV1?: boolean;
    };

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
 * Extract the in-process `parentOperation` from `explicitArg`, when present
 * (RC5 item 2). Like the handoff token, only the explicit-fields shape carries
 * it; the tree-row `{ task }` shape never does.
 */
export function extractParentOperationV1(node: RunPublishChecksArg | undefined): TaskOperationHandle | undefined {
  if (!node || !("parentOperation" in node)) {
    return undefined;
  }
  return node.parentOperation;
}

/**
 * True only for the explicit-fields shape carrying `reviewFollowsV1: true`
 * (RC11 item 1); the tree-row `{ task }` shape never does.
 *
 * @internal exported for testing
 */
export function extractReviewFollowsV1(node: RunPublishChecksArg | undefined): boolean {
  if (!node || !("reviewFollowsV1" in node)) {
    return false;
  }
  return node.reviewFollowsV1 === true;
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
  const reviewFollows = extractReviewFollowsV1(explicitArg);

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
  // 2026-09-14 review architectural blocker (`b5a1f851...-0`): see
  // `chatWithStage.ts`'s identical call site.
  if (targetResolutionHandle.unprotectedRootPaths.length > 0) {
    NotificationRouter.showError(describeTargetResolutionUnprotectedRootsV1(targetResolutionHandle));
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
      NotificationRouter.showWarning(
        describeWorkAdmissionRefusalV1(
          late,
          notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath)
        )
      );
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
      `${notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath)}: Publish checks are only available for tasks that are not paused. Resume the task first.`
    );
    return dispatched;
  }

  // The inventory snapshot can still hold the previous stage for a moment
  // after an auto-advance, so the stage check reads progress from disk.
  const freshProgress = await readTaskProgressStrictV1(vscode.Uri.file(resolvedTask.taskFolderPath));
  if (!freshProgress.ok || freshProgress.decoded.progress.currentStage !== "publish") {
    NotificationRouter.showWarning(
      `${notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath)}: Publish checks are only available for tasks at the Publish stage.`
    );
    return dispatched;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);

  // The inline tree button invokes this command directly (not through
  // applyCurrentStageAction), so the run-time model guard must live here
  // too: with no Publish model configured — or its provider disabled —
  // warn and open AI Models instead of running checks whose plan
  // verification would silently be recorded as unavailable.
  if (!(await ensureStageModelConfigured(taskFolderUri, "publish", resolvedTask.progress.displayName))) {
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
        // v1 fixes 2, item 29: Cancel appears on the operation's row like it
        // does for every other stage action, and its token reaches the check
        // processes below. The status-bar progress stays non-cancellable
        // (VS Code only honours `cancellable` for Notification progress).
        cancellable: true,
      },
      async (operation): Promise<true> => {
        const cancelToken = operation.token;
        // A terminal outcome left by an earlier run must not be read as this run's.
        clearStageActionTerminalOutcomeV1(taskFolderUri.fsPath);
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
              const beforeFingerprint = await computeTreeFingerprintV1(scopeGuess);
              await invalidatePublishChecksFreshnessStampOnDiskV1(taskFolderUri);

              throwIfPublishChecksCancelledV1(cancelToken);
              // Cancellation kills the check process trees and rejects with
              // PublishChecksCancelledError BEFORE any result is persisted;
              // the invalidation above stands, so no stale stamp survives.
              const priorFailure = await readFailedPublishRunSnapshotV1(taskFolderUri.fsPath);
              let failedFirstResult: Awaited<ReturnType<typeof runCompletionLint>> | undefined;
              let failedFirstPassNote: string | undefined;
              if (priorFailure && priorFailure.failures.length > 0 && priorFailure.runner.packageManager) {
                const currentCommands = resolveCurrentPublishCommandPlanV1(scopeGuess);
                const priorCommands = priorFailure.commands.map(({ command }) => command);
                const configuredPlanMatches = currentCommands !== null &&
                  currentCommands.length === priorCommands.length &&
                  currentCommands.every((command, index) => command.trim() === priorCommands[index]?.trim());
                // Rebuild the compatibility evidence using today's bound task,
                // scope, HEAD, environment and execution inputs. The old
                // command plan is accepted only when the current explicit
                // override still agrees; default plans are revalidated by
                // current package scripts/configuration in the fingerprint.
                const currentProbe = buildFailedPublishRunSnapshotV1({
                  taskFolder: taskFolderUri.fsPath,
                  repositoryRoot: scopeGuess,
                  verificationScopeId: computePublishScopeId(scopeGuess),
                  headCommit: beforeSha ?? undefined,
                  result: {
                    runAt: new Date().toISOString(),
                    passed: false,
                    summary: "compatibility probe",
                    issueCount: 0,
                    missingScripts: [],
                    commandsRun: currentCommands ?? [],
                    verifiedFolder: scopeGuess,
                    verificationEnvironment: {
                      cwd: scopeGuess,
                      packageManager: describeCurrentPackageManagerV1(scopeGuess),
                      envVarNames: Object.keys(process.env).sort(),
                    },
                    failedChecks: [],
                  },
                });
                if (configuredPlanMatches && isFailedPublishRunCompatibleV1(priorFailure, currentProbe)) {
                  const targets = buildFailedPublishFirstTargetsV1(priorFailure);
                  const targetChecks = targets.map((target) => target.kind === "test-files"
                    ? {
                        command: `${target.prepareCommand} && ${target.command}`,
                        executableCommand: `${target.prepareCommand} && ${target.command}`,
                        cwd: target.cwd,
                      }
                    : {
                        command: target.command,
                        executableCommand: target.executableCommand,
                        cwd: target.cwd,
                      });
                  if (targetChecks.length > 0) {
                    const elapsedStart = Date.now();
                    const failedFirst = await runCompletionLint(
                      taskFolderUri,
                      resolvedTask.progress.implReviewFiles,
                      {
                        token: cancelToken,
                        explicitChecks: targetChecks,
                        persist: false,
                        rawReportLocation: `runs/failed-first-source-${priorFailure.failedAt.replace(/[^0-9TZ]/g, "-")}-attempt-${new Date().toISOString().replace(/[^0-9TZ]/g, "-")}.log`,
                      }
                    );
                    if (!failedFirst.passed) {
                      failedFirst.passed = false;
                      failedFirst.passedModuloKnownFlakes = false;
                      failedFirst.summary = `Rechecked ${targetChecks.length} previously failing check(s) from ${priorFailure.failedAt}; they still fail after ${Math.max(0, Date.now() - elapsedStart)} ms. Remaining Publish checks were not run. ${failedFirst.summary}`;
                      await persistCompletionLintResultV1(taskFolderUri, failedFirst);
                      failedFirstResult = failedFirst;
                    } else {
                      failedFirstPassNote = `Rechecked ${targetChecks.length} previously failing check(s) from ${priorFailure.failedAt}; they passed in ${Math.max(0, Date.now() - elapsedStart)} ms. Running the complete selected Publish check set now.`;
                    }
                  }
                }
              }
              const result = failedFirstResult ?? await runCompletionLint(
                taskFolderUri,
                resolvedTask.progress.implReviewFiles,
                { token: cancelToken }
              );
              if (failedFirstPassNote && !failedFirstResult) {
                result.summary = `${failedFirstPassNote} ${result.summary}`;
                await persistCompletionLintResultV1(taskFolderUri, result);
              }
              throwIfPublishChecksCancelledV1(cancelToken);
              if (!failedFirstResult) await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);
              throwIfPublishChecksCancelledV1(cancelToken);

              const verifiedFolder = result.verifiedFolder ?? scopeGuess;
              if (!failedFirstResult && (!result.passed || (result.failedChecks?.length ?? 0) > 0)) {
                const failedRun = buildFailedPublishRunSnapshotV1({
                  taskFolder: taskFolderUri.fsPath,
                  repositoryRoot: verifiedFolder,
                  verificationScopeId: computePublishScopeId(verifiedFolder),
                  headCommit: beforeSha,
                  result,
                });
                await writeFailedPublishRunSnapshotV1(taskFolderUri.fsPath, failedRun).catch((error) => {
                  console.warn("[runPublishChecks] Could not persist failed-check identities", error);
                });
              } else if (!failedFirstResult && result.passed && (result.failedChecks?.length ?? 0) === 0) {
                await clearFailedPublishRunSnapshotV1(taskFolderUri.fsPath).catch((error) => {
                  console.warn("[runPublishChecks] Could not clear resolved failed-check identities", error);
                });
              }
              const afterSha = await resolveHeadCommitSha(verifiedFolder);
              const afterFingerprint = await computeTreeFingerprintV1(verifiedFolder);
              const checksPassed = Boolean(result.passedModuloKnownFlakes ?? result.passed);
              const freshStampWritten = Boolean(
                checksPassed &&
                beforeSha &&
                afterSha &&
                beforeSha === afterSha &&
                beforeFingerprint &&
                afterFingerprint &&
                beforeFingerprint === afterFingerprint &&
                computePublishScopeId(scopeGuess) === computePublishScopeId(verifiedFolder)
              );
              if (freshStampWritten && afterSha && afterFingerprint) {
                await writePublishChecksFreshnessStampV1(taskFolderUri, {
                  formatVersion: 1,
                  runId: crypto.randomUUID(),
                  verifiedCommitSha: afterSha,
                  completedAt: new Date().toISOString(),
                  scopeId: computePublishScopeId(verifiedFolder),
                  treeFingerprint: afterFingerprint,
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

              // Same verdict the artifact's status line and the freshness stamp
              // use: a check that failed only on a quarantined known flake is a pass.
              if (result.passedModuloKnownFlakes ?? result.passed) {
                const nextStepOffer = publishNextStepOfferV1();
                if (parentOperation !== undefined && nextStepOffer.action.command !== COMMIT_AND_PUSH_COMMAND_V1) {
                  // RC9 item 2: a parent operation (Fast Forward) runs the
                  // Publish review next on its own, so no card asks the owner
                  // to do what is about to happen.
                  NotificationRouter.showInformation(
                    `Publish checks passed. Report saved to ${publishReviewFilename}. Fast Forward runs the Publish review next.`
                  );
                  // RC11 item 1: the caller starts the review next, so no card asks
                  // for it; a run that left no fresh stamp keeps the card because
                  // the caller will stop.
                } else if (reviewFollows && freshStampWritten && nextStepOffer.action.command !== COMMIT_AND_PUSH_COMMAND_V1) {
                  NotificationRouter.showInformation(
                    `Publish checks passed. Report saved to ${publishReviewFilename}. The Publish review runs next.`
                  );
                } else {
                  const passedNotice = `Publish checks passed. Report saved to ${publishReviewFilename}. ${nextStepOffer.sentence}`;
                  // RC7 item 4: the button only opens the chat. The review step
                  // is offered there as an option; Commit & Push is not moved
                  // to the chat in this task, so that variant has no button.
                  NotificationRouter.showInformation(
                    passedNotice,
                    undefined,
                    undefined,
                    undefined,
                    nextStepOffer.action.command === COMMIT_AND_PUSH_COMMAND_V1
                      ? undefined
                      : await offerActionInChatV1({
                          taskFolderPath: taskFolderUri.fsPath,
                          actionLabel: nextStepOffer.action.title,
                          command: nextStepOffer.action.command,
                          args: [{ taskFolderPath: taskFolderUri.fsPath }],
                          noticeText: passedNotice,
                        })
                  );
                }
              } else {
                const failedChecks = result.failedChecks ?? [];
                let associationReport = "";
                let hasContradictedPlanWork = false;
                if (failedChecks.length > 0) {
                  const [plan, progressRead, ownerTaskMd] = await Promise.all([
                    readPlanOfRecordV1(taskFolderUri),
                    readTaskProgressStrictV1(taskFolderUri),
                    (async (): Promise<string> => {
                      try {
                        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(taskFolderUri, "task.md")));
                      } catch {
                        return "";
                      }
                    })(),
                  ]);
                  if (plan.hasChecklist && plan.text && progressRead.ok) {
                    const checkedItems = listCheckedChecklistItemTextsV1(plan.text);
                    const associations = associatePublishFailuresWithPlanItemsV1({
                      checkedItems,
                      evidence: progressRead.decoded.progress.planItemEvidence ?? [],
                      failures: failedChecks.map(({ command, output }) => ({ command, output })),
                      ownerHandOffCoverage: ownerHandOffCoverageFromTaskMdV1(ownerTaskMd, checkedItems),
                    });
                    associationReport = formatPublishFailurePlanAssociationsV1(associations);
                    hasContradictedPlanWork = associations.some((row) => row.disposition === "contradicted");
                    if (associationReport) {
                      // Keep machine-readable association evidence outside
                      // publish-review.md's managed sections, which later
                      // check runs may replace. The failure identity and the
                      // item relationship must remain available to the next
                      // implementation/review round.
                      const associationsUri = vscode.Uri.joinPath(taskFolderUri, "publish-failure-associations-v1.json");
                      const associationPayload = JSON.stringify({
                        schemaVersion: 1,
                        recordedAt: new Date().toISOString(),
                        taskFolder: taskFolderUri.fsPath,
                        associations,
                      }, null, 2) + "\n";
                      try {
                        let previous: string | undefined;
                        try {
                          previous = new TextDecoder().decode(await vscode.workspace.fs.readFile(associationsUri));
                        } catch (error) {
                          const code = (error as { code?: string }).code;
                          if (code !== "FileNotFound" && code !== "ENOENT") throw error;
                        }
                        let history: unknown[] = [];
                        try {
                          const decoded = JSON.parse(previous ?? "") as { schemaVersion?: number; records?: unknown[]; associations?: unknown[] };
                          if (decoded.schemaVersion === 1) history = [...(decoded.records ?? []), ...(decoded.associations ? [{ associations: decoded.associations }] : [])];
                        } catch { /* replace malformed supplemental evidence with a valid record */ }
                        const durablePayload = JSON.stringify({
                          schemaVersion: 1,
                          records: [...history, JSON.parse(associationPayload)],
                        }, null, 2) + "\n";
                        if (previous === undefined) {
                          await writeTextFile(associationsUri, durablePayload, { skipBackup: true });
                        } else {
                          await writeTextFileIfUnchangedV1(associationsUri, previous, durablePayload);
                        }
                      } catch {
                        // Existing evidence is retained if another writer won
                        // the create race; the readable report below is still
                        // recorded in the Publish artifact.
                      }
                      // Keep the failure-to-plan relationship in the task's
                      // Publish artifact for the next editing/review round.
                      const artifactUri = vscode.Uri.joinPath(taskFolderUri, STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME);
                      let existing: string | undefined;
                      try {
                        existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(artifactUri));
                      } catch (error) {
                        const code = (error as { code?: string }).code;
                        if (code !== "FileNotFound" && code !== "ENOENT") throw error;
                      }
                      const start = "<!-- publish-plan-failure-associations:start -->";
                      const end = "<!-- publish-plan-failure-associations:end -->";
                      const section = `${start}\n${associationReport}${end}`;
                      const currentArtifact = existing ?? "";
                      const markerAt = currentArtifact.indexOf(start);
                      const endAt = markerAt >= 0 ? currentArtifact.indexOf(end, markerAt + start.length) : -1;
                      const updated = markerAt >= 0 && endAt >= 0
                        ? `${currentArtifact.slice(0, markerAt)}${section}${currentArtifact.slice(endAt + end.length)}`
                        : `${currentArtifact.trimEnd()}\n\n${section}\n`;
                      try {
                        if (existing === undefined) {
                          await writeTextFile(artifactUri, updated, { skipBackup: true });
                        } else {
                          await writeTextFileIfUnchangedV1(artifactUri, existing, updated);
                        }
                      } catch {
                        // Keep the chat outcome and progress invalidation even
                        // if the supplementary artifact update is unavailable.
                      }
                    }
                    // The association was computed while its provenance was
                    // still present. Invalidate only test reports whose
                    // acceptance-test identity is an actual failing identity;
                    // source-path overlap remains a candidate and is retained.
                    await patchTaskProgressStrictV1(taskFolderUri, (current) =>
                      invalidatePlanItemEvidenceContradictedByFailuresV1(
                        current,
                        failedChecks.map(({ command, output }) => ({ command, output }))
                      )
                    ).catch(() => undefined);
                  }
                }
                const failureNotice =
                  `Publish checks found issues: ${result.summary} ` +
                  (hasContradictedPlanWork
                    ? 'A checked plan item is contradicted by a failing check; return to Implementation to address the missing behavior.'
                    : 'Choose the next action based on the failing check type.') +
                  (associationReport ? `\n\n${associationReport}` : "");
                recordStageActionTerminalOutcomeV1(taskFolderUri.fsPath, {
                  kind: "failed",
                  actionLabel: "Publish Checks",
                  reason: `Publish checks found issues: ${result.summary}`,
                  operationId: operation.id,
                });
                operation.settleAs("failed", `Publish checks found issues: ${result.summary}`);
                const hasLintOrTypeFailure = failedChecks.some((check) =>
                  /lint|type(?:check| checking)?/i.test(check.command) || /\beslint\b|\bTS\d{3,5}\b|lint(?:ing)? error|type error/i.test(check.output)
                );
                const recommendedAction = hasContradictedPlanWork || !hasLintOrTypeFailure
                  ? {
                      label: "Back to Implementation",
                      command: "vs-code-ai-helper.setTaskStage",
                      args: [{ taskFolderPath: taskFolderUri.fsPath, stage: "implementation" }],
                    }
                  : {
                      label: "Fix Linting & Code Errors",
                      command: "vs-code-ai-helper.runLintingFixes",
                      args: [{ taskFolderPath: taskFolderUri.fsPath }],
                    };
                const recoveryCard = await offerActionInChatV1({
                  taskFolderPath: taskFolderUri.fsPath,
                  taskLabel: resolvedTask.progress.displayName,
                  actionLabel: recommendedAction.label,
                  command: recommendedAction.command,
                  args: recommendedAction.args,
                  noticeText: failureNotice,
                  alternatives: [
                    ...(hasLintOrTypeFailure
                      ? [recommendedAction.command === "vs-code-ai-helper.runLintingFixes"
                          ? {
                              label: "Back to Implementation",
                              command: "vs-code-ai-helper.setTaskStage",
                              args: [{ taskFolderPath: taskFolderUri.fsPath, stage: "implementation" }],
                            }
                          : {
                              label: "Fix Linting & Code Errors",
                              command: "vs-code-ai-helper.runLintingFixes",
                              args: [{ taskFolderPath: taskFolderUri.fsPath }],
                            }]
                      : []),
                    {
                      label: "Run Publish Checks",
                      command: "vs-code-ai-helper.runPublishChecks",
                      args: [{ taskFolderPath: taskFolderUri.fsPath }],
                      consequence: "Runs the current Publish Checks again without changing the implementation.",
                    },
                  ],
                });
                NotificationRouter.showWarning(
                  failureNotice,
                  undefined,
                  undefined,
                  undefined,
                  recoveryCard
                );
              }
              // RC9 item 2: a "Run Publish Checks" card asks for work that has
              // now run (pass or fail), so it is withdrawn once the result is saved.
              await withdrawWorkflowDecisionsByKeyV1(
                { taskFolderPath: taskFolderUri.fsPath, canonicalId: taskFolderUri.fsPath },
                "chatActionOffer:runPublishChecks",
                "Publish checks have run"
              );
              // v1 fixes 2, item 8/33: the checks are done and the next step
              // (Commit & Push, or fixing what they found) is the user's.
              // Recorded here so a task that entered Publish with automation
              // expected (an auto-review arrangement that never followed the
              // checks) reads "waiting for you" instead of being paused as
              // stalled. Best-effort, and a no-op unless the task is still
              // active on Publish with nothing owed or scheduled. Nothing
              // here schedules a follow-up, so the hand-back is unconditional
              // (passed or failed): the next step is the user's.
              await patchTaskProgressStrictV1(taskFolderUri, (current) => {
                const handedBack = handBackToHumanAfterPublishChecksV1(current);
                return handedBack === current ? undefined : handedBack;
              }).catch(() => undefined);
            } catch (error) {
              if (error instanceof PublishChecksCancelledError) {
                // Not a failure: the tracked operation settles as `cancelled`
                // (its token is cancelled) and the user is told so. No stamp
                // was written and nothing was persisted for this run.
                const cancelledNotice =
                  "Publish checks were cancelled. Nothing was recorded for this run — run the checks again when you're ready.";
                // The checks STARTED and were stopped: tell the caller that
                // dispatched them (Fast Forward) so it reports "cancelled"
                // (and by whom) instead of reading the missing result as a
                // refusal to start (bugs2 finding 5).
                recordStageActionTerminalOutcomeV1(taskFolderUri.fsPath, {
                  kind: "cancelled",
                  actionLabel: "Publish Checks",
                  source: operation.cancelSource?.(),
                  operationId: operation.id,
                });
                NotificationRouter.showInformation(
                  cancelledNotice,
                  undefined,
                  undefined,
                  undefined,
                  await offerActionInChatV1({
                    taskFolderPath: taskFolderUri.fsPath,
                    taskLabel: resolvedTask.progress.displayName,
                    actionLabel: "Run Publish Checks",
                    command: "vs-code-ai-helper.runPublishChecks",
                    args: [{ taskFolderPath: taskFolderUri.fsPath }],
                    noticeText: cancelledNotice,
                    optional: true,
                  })
                );
                return;
              }
              const errorMessage = error instanceof Error ? error.message : String(error);
              recordStageActionTerminalOutcomeV1(taskFolderUri.fsPath, {
                kind: "failed",
                actionLabel: "Publish Checks",
                reason: errorMessage,
                operationId: operation.id,
              });
              operation.settleAs("failed", `Publish Checks failed: ${errorMessage}`);
              await offerPublishChecksRetryAfterExecutionFailureV1(
                taskFolderUri,
                resolvedTask.progress.displayName,
                error
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
    forwardInViewerV1("vs-code-ai-helper.runPublishChecks", (arg?: RunPublishChecksArg) =>
      runPublishChecks(inventory, arg, extractParentOperationV1(arg), currentTaskStore)
    )
  );
  context.subscriptions.push(disposable);
}
