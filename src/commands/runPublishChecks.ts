import * as vscode from "vscode";
import { describeWorkAdmissionRefusalForUserV1 } from "../utils/busyAdmissionTextV1";
import { offerBusyRefusalChoicesOnceV1 } from "../utils/busyRefusalChoicesV1";
import { forwardInViewerV1 } from "../services/viewerForwardingV1";
import { getPublishVerificationCommands } from "../config/settings";
import {
  buildFailingBaselineRecordV1,
  clearFailingBaselineV1,
  writeFailingBaselineV1,
} from "../utils/failingBaselineV1";
import * as crypto from "node:crypto";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { resolveTaskContext, peekTaskFolderPathSynchronouslyV1 } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  PublishChecksCancelledError,
  resolvePublishScopeFolder,
  throwIfPublishChecksCancelledV1,
} from "../utils/completionLint";
import { runChecksFailedFirstV1 } from "../utils/failedFirstChecksV1";
import { runPublishScopeCheck } from "../utils/publishScopeCheck";
import { maybeWarnAboutAutoUpdateV1 } from "../utils/autoUpdateWarningV1";
import {
  describePublishCancelSourceV1,
  estimateChecksMinutesV1,
  readPublishChecksOutcomeV1,
  recordPublishChecksOutcomeV1,
  recordPublishChecksRunningV1,
  settleUnrecordedPublishChecksRunV1,
} from "../utils/publishChecksOutcomeV1";
import { createCompletionCheckActivityAccumulatorV1 } from "./reviewActions";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { handBackToHumanAfterPublishChecksV1 } from "../utils/taskProgressTransforms";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { safeOpenTextDocument, writeTextFile, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import {
  COMMIT_AND_PUSH_COMMAND_V1,
  publishChecksPassedHeadingV1,
  publishNextStepOfferV1,
  publishPartOneRunningLineV1,
} from "../utils/publishStageActionsV1";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES, STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { buildStalePublishTextV1, findStalePublishVerdictV1 } from "../utils/publishStaleVerdictV1";
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
  computeTreeFingerprintSnapshotV1,
  diffTreeFingerprintSnapshotsV1,
  invalidatePublishChecksFreshnessStampOnDiskV1,
  withCommandIdentityV1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import {
  acquireEarlyWorkAdmissionForCandidatePathV1,
  acquireOrAdoptWorkAdmissionV1,
  beginTargetResolutionV1,
  describeTargetResolutionUnprotectedRootsV1,
  describeTargetResolutionWriteFailureV1,
  endTargetResolutionV1,
  WorkAdmissionHandleV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
} from "../state/workAdmissionV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import { listCheckedChecklistItemTextsV1, listUnsettledPlanItemsV1 } from "../utils/implementationChecklist";
import {
  buildPublishOpenPlanItemsSectionV1,
  describePublishOpenPlanItemsSentenceV1,
  upsertPublishOpenPlanItemsSectionV1,
} from "../utils/publishOpenPlanItemsV1";
import { invalidatePlanItemEvidenceContradictedByFailuresV1 } from "../utils/taskProgressTransforms";
import { associatePublishFailuresWithPlanItemsV1, formatPublishFailurePlanAssociationsV1, ownerHandOffCoverageFromTaskMdV1 } from "../utils/publishFailurePlanAssociationV1";
import {
  buildFailedPublishRunSnapshotV1,
  clearFailedPublishRunSnapshotV1,
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
      /**
       * bugs4 Step 13 (item 29): set by the stale-verdict card's "Run Publish Checks anyway" so
       * an owner who has seen that the last review predates a plan change is not asked twice.
       */
      staleVerdictAcknowledgedV1?: boolean;
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
 * True only for the explicit-fields shape carrying `staleVerdictAcknowledgedV1: true`
 * (bugs4 Step 13); the tree-row `{ task }` shape never does.
 *
 * @internal exported for testing
 */
export function extractStaleVerdictAcknowledgedV1(node: RunPublishChecksArg | undefined): boolean {
  return !!node && "staleVerdictAcknowledgedV1" in node && node.staleVerdictAcknowledgedV1 === true;
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
    NotificationRouter.showWarning(describeWorkAdmissionRefusalForUserV1(early));
    offerBusyRefusalChoicesOnceV1(early);
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
        describeWorkAdmissionRefusalForUserV1(
          late,
          notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath)
        )
      );
      offerBusyRefusalChoicesOnceV1(
        late,
        notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath)
      );
      return dispatched;
    }
    handle = late.handle;
    heartbeat = setInterval(() => void handle!.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
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
      async (operation): Promise<boolean> => {
        const cancelToken = operation.token;
        // A terminal outcome left by an earlier run must not be read as this run's.
        clearStageActionTerminalOutcomeV1(taskFolderUri.fsPath);
        // bugs3 Step 12: the run is visible and cancellable from its first moment. The
        // admission preflight below (pause reconciliation, stage and model checks) and the
        // scope/HEAD/tree-fingerprint work after it all run inside this tracked operation,
        // so Cancel has a target and a refusal settles as an operation outcome rather than
        // vanishing as a claim-only startup.
        // bugs5 Step 18: one plain status line that says which part of Publish this is and that the
        // owner can leave; each check then updates the same row as it starts and ends.
        operation.reportActivity(
          publishPartOneRunningLineV1(
            getPublishVerificationCommands(),
            estimateChecksMinutesV1(readPublishChecksOutcomeV1(taskFolderUri.fsPath))
          ),
          { resetElapsedOrigin: true }
        );
        const displayName = notificationTaskDisplayNameV1(
          resolvedTask.progress.displayName,
          resolvedTask.taskFolderPath
        );
        // Every preflight exit leaves a durable result, not only an in-memory terminal slot, so
        // a refused or cancelled start is visible after a reload and in publish-review.md.
        // `recordOutcome: false` is for refusals raised away from the Publish stage, where
        // writing into the Publish report would create an artifact for a stage the task is not at.
        const refusePreflight = async (reason: string, recordOutcome = true): Promise<false> => {
          NotificationRouter.showWarning(`${displayName}: ${reason}`);
          if (recordOutcome) {
            await recordPublishChecksOutcomeV1(taskFolderUri, {
              outcome: "failed",
              at: new Date().toISOString(),
              failedCommands: [],
              reason: `not started — ${reason}`,
              operationId: operation.id,
            });
          }
          operation.settleAs("refused", reason);
          return false;
        };

        const cancelPreflight = async (): Promise<false> => {
          const cause = describePublishCancelSourceV1(operation.cancelSource?.());
          await recordPublishChecksOutcomeV1(taskFolderUri, {
            outcome: "cancelled",
            at: new Date().toISOString(),
            cause: `${cause}, before any command started`,
            operationId: operation.id,
          });
          recordStageActionTerminalOutcomeV1(taskFolderUri.fsPath, {
            kind: "cancelled",
            actionLabel: "Publish Checks",
            source: operation.cancelSource?.(),
            operationId: operation.id,
          });
          operation.settleAs("cancelled", `Publish Checks were cancelled before any command started (${cause}).`);
          return false;
        };

        // The inventory snapshot can still hold the previous stage for a moment after an
        // auto-advance, so the stage check reads progress from disk. It comes first and is
        // read-only, so a refusal for the wrong stage neither overwrites the previous result
        // nor creates a Publish report for a stage the task is not at.
        const freshProgress = await readTaskProgressStrictV1(taskFolderUri);
        if (!freshProgress.ok || freshProgress.decoded.progress.currentStage !== "publish") {
          return await refusePreflight("Publish checks are only available for tasks at the Publish stage.", false);
        }

        // bugs4 Step 13 (item 29): Publish Checks started directly (or by Fast Forward) rely on the
        // last code review's verdict. When `task.md` or the plan of record changed after that
        // review started, say so in chat, naming the file and time, before any check runs. The
        // owner's "Run Publish Checks anyway" carries the acknowledgement so they are not asked twice.
        if (!extractStaleVerdictAcknowledgedV1(explicitArg)) {
          const stalePublish = await findStalePublishVerdictV1(taskFolderUri.fsPath).catch(() => undefined);
          if (stalePublish) {
            const staleText = buildStalePublishTextV1({
              reviewStageName: STAGE_DISPLAY_NAMES[stalePublish.reviewStage],
              stale: stalePublish.stale,
              nestedItemsAdded: stalePublish.nestedItemsAdded,
              openNestedItems: stalePublish.openNestedItems,
            });
            const rerunReview = {
              label: `Re-run ${STAGE_DISPLAY_NAMES[stalePublish.reviewStage]}`,
              command: "vs-code-ai-helper.setTaskStage",
              args: [{ taskFolderPath: taskFolderUri.fsPath, stage: stalePublish.reviewStage }],
              consequence: `Moves the task back to ${STAGE_DISPLAY_NAMES[stalePublish.reviewStage]} so the review reads the current text.`,
            };
            const buildNewItems = {
              label: "Build the new items",
              command: "vs-code-ai-helper.setTaskStage",
              args: [{ taskFolderPath: taskFolderUri.fsPath, stage: "impl" }],
              consequence: "Moves the task back to Implementation to build the plan items added since the review.",
            };
            const runAnyway = {
              label: "Run Publish Checks anyway",
              command: "vs-code-ai-helper.runPublishChecks",
              args: [{ taskFolderPath: taskFolderUri.fsPath, staleVerdictAcknowledgedV1: true }],
              consequence: "Runs the checks now, relying on the older review.",
            };
            await recordPublishChecksOutcomeV1(taskFolderUri, {
              outcome: "failed",
              at: new Date().toISOString(),
              failedCommands: [],
              reason: `not started — ${staleText.notice}`,
              operationId: operation.id,
            });
            await offerActionInChatV1({
              taskFolderPath: taskFolderUri.fsPath,
              taskLabel: resolvedTask.progress.displayName,
              actionLabel: staleText.offerBuildNewItems ? buildNewItems.label : rerunReview.label,
              command: staleText.offerBuildNewItems ? buildNewItems.command : rerunReview.command,
              args: staleText.offerBuildNewItems ? buildNewItems.args : rerunReview.args,
              actionConsequence: staleText.offerBuildNewItems ? buildNewItems.consequence : rerunReview.consequence,
              noticeText: staleText.notice,
              recommend: { target: "action", reasoning: staleText.recommendationReasoning },
              alternatives: [...(staleText.offerBuildNewItems ? [rerunReview] : []), runAnyway],
            });
            operation.settleAs("refused", staleText.notice);
            return false;
          }
        }

        // From here on a host that disappears leaves a durable record: the "running" record is
        // written before the slower preflight (pause reconciliation, model check), so activation
        // recovery turns an abandoned preflight into an explicit "interrupted" result rather than
        // leaving the previous run's result standing as this one's. Every exit below replaces it
        // with a refused, cancelled or finished result.
        const previousChecksRecordV1 = readPublishChecksOutcomeV1(taskFolderUri.fsPath);
        const runningRecord = await recordPublishChecksRunningV1(taskFolderUri, operation.id);
        // bugs5 Step 11: a run this long can be killed by VS Code's extension auto-update.
        void maybeWarnAboutAutoUpdateV1({
          taskFolderPath: taskFolderUri.fsPath,
          expectedMinutes: estimateChecksMinutesV1(previousChecksRecordV1) ?? 20,
        });

        // Admission is guaranteed live for this exact target — reverse a watchdog-provenance
        // pause (never a user pause) before any further setup, exactly like
        // `runReviewWithAI`/`runLintingFixes`. A genuine `userPaused` or `unreadable`
        // outcome stops the command, as `completeCommitAndPushTask`'s first reconciliation
        // does. `resolvedTask.progress.status` is only the pre-reconciliation snapshot.
        // Any exception from here to the end of the run (pause reconciliation rejects when its
        // progress write fails; the progress host can too) still ends the durable record with a
        // failed result naming the error, instead of leaving "running" behind a failed operation
        // until a later activation recovers it.
        const settleOnUnexpectedError = async (error: unknown): Promise<never> => {
          const message = error instanceof Error ? error.message : String(error);
          await settleUnrecordedPublishChecksRunV1(taskFolderUri, operation.id, message).catch(() => undefined);
          throw error;
        };
        const preflightRefusal = await (async (): Promise<false | undefined> => {
          const publishReconcileOutcome = await reconcileWatchdogPauseAgainstAdmissionV1(taskFolderUri);
          if (
            publishReconcileOutcome.outcome === "userPaused" ||
            publishReconcileOutcome.outcome === "unreadable"
          ) {
            return await refusePreflight(
              "Publish checks are only available for tasks that are not paused. Resume the task first."
            );
          }
          if (cancelToken?.isCancellationRequested) {
            return await cancelPreflight();
          }

          // The inline tree button invokes this command directly (not through
          // applyCurrentStageAction), so the run-time model guard lives here too: with no
          // Publish model configured — or its provider disabled — warn and open AI Models
          // instead of running checks whose plan verification would be recorded as unavailable.
          if (!(await ensureStageModelConfigured(taskFolderUri, "publish", resolvedTask.progress.displayName))) {
            return await refusePreflight("No Publish model is configured");
          }
          if (cancelToken?.isCancellationRequested) {
            return await cancelPreflight();
          }
          return undefined;
        })().catch(settleOnUnexpectedError);
        if (preflightRefusal === false) {
          return false;
        }

        await Promise.resolve(vscode.window.withProgress(
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
              // bugs5 Step 17: the per-path records are kept so the end of the run can name the files
              // that changed while it ran, not just notice that something did.
              const beforeSnapshot = await computeTreeFingerprintSnapshotV1(scopeGuess);
              const beforeFingerprint = beforeSnapshot?.fingerprint;
              // bugs5 Step 10: the previous stamp is NOT wiped here. A run that is cancelled,
              // interrupted or killed leaves an earlier pass on the same tree standing (wiping it
              // made Commit & Push re-run 20-35 minutes of checks that had already passed). A new
              // pass replaces the stamp below, and a failure removes it
              // (`recordPublishChecksOutcomeV1`), so a stamp never outlives the result it described.

              throwIfPublishChecksCancelledV1(cancelToken);
              // Cancellation kills the check process trees and rejects with
              // PublishChecksCancelledError BEFORE any result is persisted;
              // the earlier stamp, if any, is untouched.
              // bugs3 Step 15: the failed-first run is shared with Fix Linting &
              // Code Errors' post-fix re-check (bugs2 Steps 29-30), so both consume
              // exactly one result.
              // bugs3 Step 12: each command is announced as it starts (chat "Progress"
              // lines and the Tasks row read the operation's activity) and recorded in
              // the durable running record as it starts and settles.
              const checkActivity = createCompletionCheckActivityAccumulatorV1(operation, undefined, Date.now());
              let checkOutcome: Awaited<ReturnType<typeof runChecksFailedFirstV1>>;
              try {
                checkOutcome = await runChecksFailedFirstV1({
                  taskFolderUri,
                  relevantFiles: resolvedTask.progress.implReviewFiles,
                  token: cancelToken,
                  scopeFolder: scopeGuess,
                  headCommit: beforeSha,
                  onCheckEvent: {
                    planned: (total) => checkActivity.onCheckEvent.planned(total),
                    started: (descriptor) => {
                      runningRecord.commandStarted(descriptor.command);
                      checkActivity.onCheckEvent.started(descriptor);
                    },
                    settled: (descriptor, result) => {
                      runningRecord.commandSettled(descriptor.command, result?.exitCode);
                      checkActivity.onCheckEvent.settled(descriptor);
                    },
                    batchBoundary: () => checkActivity.onCheckEvent.batchBoundary(),
                  },
                });
              } finally {
                checkActivity.close();
              }
              const result = checkOutcome.result;
              const failedFirstResult = checkOutcome.failedFirst ? result : undefined;
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
              const afterSnapshot = await computeTreeFingerprintSnapshotV1(verifiedFolder);
              const afterFingerprint = afterSnapshot?.fingerprint;
              const changedDuringRun =
                beforeSnapshot !== undefined &&
                afterSnapshot !== undefined &&
                beforeFingerprint !== afterFingerprint &&
                computePublishScopeId(scopeGuess) === computePublishScopeId(verifiedFolder)
                  ? diffTreeFingerprintSnapshotsV1(beforeSnapshot, afterSnapshot)
                  : [];
              if (!failedFirstResult) {
                // bugs3 Step 15: keep the complete failing result, bound to the commit,
                // tree fingerprint, scope and commands it ran against, so a fix round
                // on an unchanged tree starts from it instead of re-running everything.
                const baseline = buildFailingBaselineRecordV1({
                  result,
                  headBefore: beforeSha,
                  headAfter: afterSha,
                  fingerprintBefore: beforeFingerprint,
                  fingerprintAfter: afterFingerprint,
                  scopeId: computePublishScopeId(verifiedFolder),
                  configuredCommands: getPublishVerificationCommands(),
                });
                if (baseline) {
                  await writeFailingBaselineV1(taskFolderUri.fsPath, baseline).catch((error) => {
                    console.warn("[runPublishChecks] Could not record the failing result for reuse", error);
                  });
                } else {
                  await clearFailingBaselineV1(taskFolderUri.fsPath).catch(() => undefined);
                }
              }
              const checksPassed = Boolean(result.passedModuloKnownFlakes ?? result.passed);
              // bugs3 Step 12: the run's outcome is recorded beside the report on
              // every exit, so a later pause, resume or reload cannot leave it unknown.
              await recordPublishChecksOutcomeV1(
                taskFolderUri,
                checksPassed
                  ? {
                      outcome: "passed",
                      at: new Date().toISOString(),
                      operationId: operation.id,
                      ...(changedDuringRun.length > 0 ? { changedDuringRun } : {}),
                    }
                  : {
                      outcome: "failed",
                      at: new Date().toISOString(),
                      failedCommands: (result.failedChecks ?? []).map((check) => check.command),
                      operationId: operation.id,
                    }
              );
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
                  ...withCommandIdentityV1(result.commandsRun),
                });
              }
              // A finished run that cannot be tied to one unchanged commit and tree (the working
              // tree advanced mid-run, or HEAD could not be resolved) writes no stamp, and the
              // previous one is removed: it described an earlier run, and this run's output has
              // replaced the report, so the report must read as stale rather than carry a commit
              // that no longer matches its own check output.
              if (!freshStampWritten) {
                await invalidatePublishChecksFreshnessStampOnDiskV1(taskFolderUri).catch((error) => {
                  console.warn("[runPublishChecks] Could not remove the superseded freshness stamp", error);
                });
              }

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
              // bugs4 item 42: unticked plan items (top-level and nested, excluded hand-offs
              // aside) are listed in the report as blockers, whether or not the checks passed.
              let openPlanItemsSentence = "";
              try {
                const planForOpenItems = await readPlanOfRecordV1(taskFolderUri);
                const openPlanItems = planForOpenItems.hasChecklist && planForOpenItems.text
                  ? listUnsettledPlanItemsV1(planForOpenItems.text)
                  : [];
                openPlanItemsSentence = describePublishOpenPlanItemsSentenceV1(openPlanItems);
                const reportUri = vscode.Uri.joinPath(taskFolderUri, publishReviewFilename);
                let currentReport: string | undefined;
                try {
                  currentReport = new TextDecoder().decode(await vscode.workspace.fs.readFile(reportUri));
                } catch (error) {
                  const code = (error as { code?: string }).code;
                  if (code !== "FileNotFound" && code !== "ENOENT") throw error;
                }
                if (currentReport !== undefined) {
                  const withSection = upsertPublishOpenPlanItemsSectionV1(
                    currentReport,
                    buildPublishOpenPlanItemsSectionV1(openPlanItems)
                  );
                  if (withSection !== currentReport) {
                    await writeTextFileIfUnchangedV1(reportUri, currentReport, withSection);
                  }
                }
              } catch (error) {
                // The checks' own outcome stands; the open-items note is supplementary.
                console.warn("[runPublishChecks] Could not list open plan items in the Publish report", error);
              }
              await safeOpenTextDocument(
                vscode.Uri.joinPath(taskFolderUri, publishReviewFilename),
                "Publish review"
              );

              // Same verdict the artifact's status line and the freshness stamp
              // use: a check that failed only on a quarantined known flake is a pass.
              if (checksPassed && changedDuringRun.length > 0) {
                // bugs5 Step 17: the commands passed, but not on the tree as it is now. No stamp was
                // written, so no review is offered: the only honest next step is to run them again.
                const shown = changedDuringRun.slice(0, 5).join(", ");
                const more = changedDuringRun.length > 5 ? ` and ${changedDuringRun.length - 5} more` : "";
                const changedNotice =
                  `Publish Checks passed, but these files changed while they ran: ${shown}${more}. ` +
                  "Run them again to cover the change.";
                NotificationRouter.showWarning(
                  changedNotice,
                  undefined,
                  undefined,
                  undefined,
                  await offerActionInChatV1({
                    taskFolderPath: taskFolderUri.fsPath,
                    actionLabel: "Run Publish Checks",
                    command: "vs-code-ai-helper.runPublishChecks",
                    args: [{ taskFolderPath: taskFolderUri.fsPath }],
                    noticeText: changedNotice,
                  })
                );
              } else if (result.passedModuloKnownFlakes ?? result.passed) {
                const nextStepOffer = publishNextStepOfferV1();
                if (parentOperation !== undefined && nextStepOffer.action.command !== COMMIT_AND_PUSH_COMMAND_V1) {
                  // RC9 item 2: a parent operation (Fast Forward) runs the
                  // Publish review next on its own, so no card asks the owner
                  // to do what is about to happen.
                  NotificationRouter.showInformation(
                    `${publishChecksPassedHeadingV1("review")} Report saved to ${publishReviewFilename}. Fast Forward runs the Publish review next.${openPlanItemsSentence ? ` ${openPlanItemsSentence}` : ""}`
                  );
                  // RC11 item 1: the caller starts the review next, so no card asks
                  // for it; a run that left no fresh stamp keeps the card because
                  // the caller will stop.
                } else if (reviewFollows && freshStampWritten && nextStepOffer.action.command !== COMMIT_AND_PUSH_COMMAND_V1) {
                  NotificationRouter.showInformation(
                    `${publishChecksPassedHeadingV1("review")} Report saved to ${publishReviewFilename}. The Publish review runs next.${openPlanItemsSentence ? ` ${openPlanItemsSentence}` : ""}`
                  );
                } else {
                  const passedNotice = `${publishChecksPassedHeadingV1(
                    nextStepOffer.action.command === COMMIT_AND_PUSH_COMMAND_V1 ? "commit-and-push" : "review"
                  )} Report saved to ${publishReviewFilename}. ${nextStepOffer.sentence}${openPlanItemsSentence ? ` ${openPlanItemsSentence}` : ""}`;
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
                  (associationReport ? `\n\n${associationReport}` : "") +
                  (openPlanItemsSentence ? `\n\n${openPlanItemsSentence}` : "");
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
                // was written, and no check result was persisted for this run —
                // but the cancellation itself is (bugs3 Step 12), with its cause,
                // so the report's status line no longer reads "Not yet reviewed".
                const cancelCause = describePublishCancelSourceV1(operation.cancelSource?.());
                await recordPublishChecksOutcomeV1(taskFolderUri, {
                  outcome: "cancelled",
                  at: new Date().toISOString(),
                  cause: cancelCause,
                  operationId: operation.id,
                });
                const cancelledNotice =
                  `Publish checks were cancelled. Cause: ${cancelCause}. No check result was recorded for this run — run the checks again when you're ready.`;
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
              await recordPublishChecksOutcomeV1(taskFolderUri, {
                outcome: "failed",
                at: new Date().toISOString(),
                failedCommands: [],
                reason: errorMessage.slice(0, 200),
                operationId: operation.id,
              });
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
        )).catch(settleOnUnexpectedError);
        // Whatever exit the body took, the durable record never stays "running".
        await settleUnrecordedPublishChecksRunV1(taskFolderUri, operation.id);
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
