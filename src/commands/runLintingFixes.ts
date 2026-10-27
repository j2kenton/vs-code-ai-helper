import * as vscode from "vscode";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { askChatChoiceV1 } from "../utils/chatChoiceV1";
import { forwardInViewerV1 } from "../services/viewerForwardingV1";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { updateLintPayload } from "../utils/taskProgressTransforms";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { notificationTaskDisplayNameV1 } from "../utils/notificationTaskContextV1";
import {
  PublishChecksCancelledError,
  runCompletionLint,
  resolvePublishScopeFolder,
  throwIfPublishChecksCancelledV1,
} from "../utils/completionLint";
import { runPublishScopeCheck } from "../utils/publishScopeCheck";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { isExtensionFolderRemovedErrorV1 } from "../utils/extensionResourcesV1";
import { generateContextPack } from "../utils/contextPack";
import {
  ensureStageModelConfigured,
  resolveFreshModelForStage,
} from "../utils/modelSelection";
import {
  checkEditActionAvailabilityV1,
  runImplementationOrSealedV1,
} from "./runEditActionV1";
import { getUnrelatedWorkspaceChanges, isGitWorkspace } from "./reviewActions";
import { allowsDirtyWorktreeChanges } from "../config/settings";
import { getProductionActionConversationOrchestratorV1 } from "../actions/productionTaskActionRuntimeV1";
import type { ChatViewProvider } from "../views/chatView";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { ensureAiConsent } from "../utils/aiConsent";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import { deterministicFixOutcomeV1 } from "../utils/deterministicFixOutcomeV1";
import { classifyFixCheckStatusesV1, fixHasUnresolvedChecksV1 } from "../utils/fixChecksReportV1";
import {
  runTrackedOperation,
  linkCancellationTokens,
  taskOperations,
  TaskOperationHandle,
  resolveWorkflowRootTaskName,
} from "../utils/taskOperations";
import {
  acquireWorkAdmissionV1,
  createSafeAdmissionReleaseStateV1,
  describeWorkAdmissionRefusalV1,
  heldAdmissionClaimIdForTaskV1,
  recordAdmissionReleaseTriggerV1,
  requestSafeAdmissionReleaseV1,
  SafeAdmissionReleaseStateV1,
  trySafeAdmissionReleaseV1,
  WorkAdmissionHandleV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
} from "../state/workAdmissionV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { createAdmissionHeldNotifierV1 } from "./releaseStuckAdmissionMarkers";
import { scheduleAutomationChain } from "../utils/automationChain";
import { CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1 } from "./checkAndReviewPublish";
import type { CandidateInvocationInfoV1 } from "../runners/runnerRegistry";
import { candidateInvocationMessageV1, persistCandidateDispatchModelChainV1 } from "../utils/dispatchModelChainV1";
import { writeRunLog } from "../utils/runLog";
import {
  computePublishScopeId,
  computeTreeFingerprintV1,
  markPublishReviewStaleV1,
  writePublishChecksFreshnessStampV1,
  writePublishFixNoteV1,
} from "../utils/publishChecksFreshness";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import type { decideAdmissionReleaseSafetyV1 } from "../state/recordedCliStopV1";

/**
 * Accepted argument shapes for runLintingFixes.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
export type RunLintingFixesArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; testDeps?: Partial<PublishFixReleaseCoordinatorDepsV1> };

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
 * Work admission (v1 fixes item 1, Part 1a) needs a task folder path
 * BEFORE any awaited setup — `resolveTaskContext` below is itself the first
 * awaited read this command performs, so it must not run unprotected. Mirrors
 * `reviewActions.ts`'s `extractSynchronousReviewFolderPathV1`: only returns a
 * path when one is known synchronously from the argument (a tree-row button
 * or a resolver-aware caller); a bare canonicalId or no-arg invocation has
 * nothing to protect until `resolveTaskContext` picks a target, so admission
 * is acquired right after resolution instead, in `runLintingFixes` itself.
 */
function extractSynchronousLintingFolderPathV1(node: RunLintingFixesArg | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if ("task" in node && node.task) {
    return node.task.folderUri.fsPath;
  }
  const n = node as { canonicalId?: string; taskFolderPath?: string };
  return n.taskFolderPath;
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

/** Build the user-visible recovery choice shared by every lint-fix hand-back. */
export function offerLintFixRecoveryInChatV1(
  taskFolderPath: string,
  taskLabel: string,
  noticeText: string,
  optional = false
): Promise<Awaited<ReturnType<typeof offerActionInChatV1>>> {
  return offerActionInChatV1({
    taskFolderPath,
    taskLabel,
    actionLabel: "Run Publish Checks",
    command: "vs-code-ai-helper.runPublishChecks",
    args: [{ taskFolderPath }],
    alternatives: [{
      label: "Back to Implementation",
      command: "vs-code-ai-helper.setTaskStage",
      args: [{ taskFolderPath, stage: "implementation" }],
    }],
    noticeText,
    ...(optional ? { optional: true as const } : {}),
  });
}

/**
 * Factory for the delegating WorkAdmissionHandleV1 used by runLintingFixes (RC6 item 5).
 * Delegates every method to the underlying handle at call time, and records marker removal
 * when release() completes.
 */
export function createReleaseTrackedHandleV1(
  getHandle: () => WorkAdmissionHandleV1 | undefined,
  onMarkerRemoved: () => void
): WorkAdmissionHandleV1 | undefined {
  const current = getHandle();
  if (!current) {
    return undefined;
  }
  const tracked: WorkAdmissionHandleV1 = {
    ownerToken: current.ownerToken,
    claimId: current.claimId,
    taskFolderPath: current.taskFolderPath,
    commandId: current.commandId,
    purpose: current.purpose,
    heartbeat: () => current.heartbeat(),
    handover: () => current.handover(),
    release: async () => {
      await current.release();
      onMarkerRemoved();
    },
  };
  return tracked;
}

export interface PublishFixReleaseCoordinatorDepsV1 {
  readonly getTaskFolderUri: () => vscode.Uri | undefined;
  readonly getLockKey: () => string | undefined;
  readonly getHandle: () => WorkAdmissionHandleV1 | undefined;
  readonly onAdmissionHeld: (taskFolderPath: string, reason: string) => void;
  readonly onAdmissionReleased: () => void;
  readonly safeReleaseState: SafeAdmissionReleaseStateV1;
  readonly getFinalChecks: () => { passed: boolean; failedChecks: readonly { command: string }[] } | undefined;
  readonly getFixSucceeded: () => boolean;
  readonly lintDispatchProbe?: { coordinatorOutcome?: TaskActionOutcomeV1 };
  readonly writeNote?: (taskFolderUri: vscode.Uri, note: string, stillWanted?: () => boolean) => Promise<boolean>;
  readonly scheduleChain?: typeof scheduleAutomationChain;
  readonly rootOperationIdFor?: (lockKey: string) => string | undefined;
  readonly showInformation?: (message: string) => void;
  readonly showWarning?: (message: string) => void;
  readonly trySafeRelease?: typeof trySafeAdmissionReleaseV1;
  readonly requestSafeRelease?: typeof requestSafeAdmissionReleaseV1;
  readonly classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2];
}

export interface PublishFixReleaseCoordinatorV1 {
  isPublishReviewOwed(): boolean;
  isPublishReviewScheduled(): boolean;
  isMarkerRemoved(): boolean;
  isReleaseFailed(): boolean;
  getReleaseFailureText(): string;
  getReleaseAttemptsInFlight(): number;
  setPublishReviewOwed(owed: boolean): void;
  releaseTrackedHandle(): WorkAdmissionHandleV1 | undefined;
  schedulePublishReviewAfterFixOnce(): void;
  writePublishFixNoteSafely(note: string, stillWanted?: () => boolean): Promise<boolean>;
  concludeOwedPublishReview(): Promise<void>;
  trackReleaseAttempt<T>(attempt: () => Promise<T>): Promise<T>;
  heartbeatTick(classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2]): Promise<void>;
  releaseAdmission(classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2]): Promise<void>;
  finishPublishFix(classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2]): Promise<void>;
}

export function createPublishFixReleaseCoordinatorV1(
  deps: PublishFixReleaseCoordinatorDepsV1
): PublishFixReleaseCoordinatorV1 {
  let publishReviewOwed = false;
  let publishReviewScheduled = false;
  let markerRemoved = false;
  let releaseFailed = false;
  let releaseFailureText = "";
  let releaseAttemptsInFlight = 0;

  const releaseTrackedHandle = (): WorkAdmissionHandleV1 | undefined =>
    createReleaseTrackedHandleV1(
      () => deps.getHandle(),
      () => {
        markerRemoved = true;
      }
    );

  const showInformationSafely = (message: string): void => {
    try {
      (deps.showInformation ?? NotificationRouter.showInformation)(message);
    } catch (error) {
      console.warn("[runLintingFixes] showInformation failed", error);
    }
  };

  const showWarningSafely = (message: string): void => {
    try {
      (deps.showWarning ?? NotificationRouter.showWarning)(message);
    } catch (error) {
      console.warn("[runLintingFixes] showWarning failed", error);
    }
  };

  const schedulePublishReviewAfterFixOnce = (): void => {
    const lockKey = deps.getLockKey();
    if (publishReviewScheduled || lockKey === undefined) {
      return;
    }
    publishReviewScheduled = true;
    const rootId = deps.rootOperationIdFor
      ? deps.rootOperationIdFor(lockKey)
      : taskOperations.rootOperationIdFor(lockKey);
    let droppedSynchronously = false;
    const scheduleFn = deps.scheduleChain ?? scheduleAutomationChain;
    void scheduleFn(
      {
        command: CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1,
        arg: { taskFolderPath: lockKey },
        taskKey: lockKey,
        chainId: "publish-review-after-fix",
        dispatchEvenIfRootFails: true,
        onDropped: (reason) => {
          droppedSynchronously = true;
          if (reason === "duplicate-chain") {
            showInformationSafely(
              "A Publish review is already scheduled for this task."
            );
          } else if (reason === "automation-disabled") {
            showInformationSafely(
              "Automatic follow-ups are off, so the Publish review was not started. Run “Run Publish Checks, Then Review”."
            );
          }
        },
        intent: {
          trigger: "Fix Linting & Code Errors ended with Publish Checks passing: review the fixed code",
          settingKey: undefined,
          expectedTiming: "right after the fix, once its admission marker is released",
          willRetry: false,
          retryNote: "Not retried automatically if dropped — run “Run Publish Checks, Then Review”.",
        },
      },
      rootId ? { id: rootId } : undefined
    ).catch((error) => {
      console.warn("[runLintingFixes] scheduling the Publish review failed", error);
    });
    if (rootId && !droppedSynchronously) {
      showInformationSafely(
        "The Publish review will run once the commit-and-push flow finishes."
      );
    }
  };

  const writePublishFixNoteSafely = async (
    note: string,
    stillWanted?: () => boolean
  ): Promise<boolean> => {
    const taskFolderUri = deps.getTaskFolderUri();
    if (!taskFolderUri) {
      return false;
    }
    try {
      if (deps.writeNote) {
        return await deps.writeNote(taskFolderUri, note, stillWanted);
      }
      return await writePublishFixNoteV1(taskFolderUri, note, stillWanted);
    } catch (error) {
      console.warn("[runLintingFixes] could not write the Publish fix note", error);
      return false;
    }
  };

  const concludeOwedPublishReview = async (): Promise<void> => {
    try {
      if (!publishReviewOwed || releaseAttemptsInFlight > 0) {
        return;
      }
      if (markerRemoved) {
        publishReviewOwed = false;
        schedulePublishReviewAfterFixOnce();
      } else if (releaseFailed) {
        publishReviewOwed = false;
        const note =
          "> Publish Checks pass after the fix, but the Publish review was not started: the task's admission " +
          `marker could not be released (${releaseFailureText}). Use Release Stuck Admission Markers, then ` +
          "Run Publish Checks, Then Review.";
        await writePublishFixNoteSafely(note);
        showWarningSafely(note.replace(/^> /, ""));
      }
    } catch (error) {
      console.warn("[runLintingFixes] concluding the owed Publish review failed", error);
    }
  };

  const trackReleaseAttempt = async <T>(attempt: () => Promise<T>): Promise<T> => {
    releaseAttemptsInFlight++;
    try {
      return await attempt();
    } catch (error) {
      if (deps.safeReleaseState.released) {
        releaseFailed = true;
        releaseFailureText = (error instanceof Error ? error.message : String(error)).slice(0, 120);
      }
      throw error;
    } finally {
      releaseAttemptsInFlight--;
      await concludeOwedPublishReview();
    }
  };

  const heartbeatTick = async (
    classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2]
  ): Promise<void> => {
    const currentHandle = deps.getHandle();
    if (!currentHandle) {
      return;
    }
    await currentHandle.heartbeat();
    if (deps.safeReleaseState.releaseRequested && !deps.safeReleaseState.released) {
      await trackReleaseAttempt(() =>
        (deps.trySafeRelease ?? trySafeAdmissionReleaseV1)(
          deps.safeReleaseState,
          releaseTrackedHandle(),
          deps.onAdmissionHeld,
          deps.onAdmissionReleased,
          classifyDeps ?? deps.classifyDeps
        )
      );
    }
  };

  const releaseAdmission = async (
    classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2]
  ): Promise<void> => {
    await trackReleaseAttempt(() =>
      (deps.requestSafeRelease ?? requestSafeAdmissionReleaseV1)(
        deps.safeReleaseState,
        releaseTrackedHandle(),
        deps.onAdmissionHeld,
        deps.onAdmissionReleased,
        classifyDeps ?? deps.classifyDeps
      )
    );
  };

  const finishPublishFix = async (
    classifyDeps?: Parameters<typeof decideAdmissionReleaseSafetyV1>[2]
  ): Promise<void> => {
    recordAdmissionReleaseTriggerV1(deps.safeReleaseState, deps.lintDispatchProbe?.coordinatorOutcome);
    if (deps.getTaskFolderUri() !== undefined) {
      const fixSucceeded = deps.getFixSucceeded();
      const finalChecks = deps.getFinalChecks();
      if (fixSucceeded && finalChecks?.passed === true) {
        publishReviewOwed = true;
      } else if (!fixSucceeded && finalChecks?.passed === false) {
        const failing =
          finalChecks.failedChecks.map((check) => check.command).join(", ") || "see Completion Checks";
        await writePublishFixNoteSafely(`> Publish Checks still fail after the fix: ${failing}.`);
      }
    }
    let releaseErrorV1: unknown;
    let releaseFailedWithErrorV1 = false;
    try {
      await releaseAdmission(classifyDeps);
    } catch (error) {
      releaseErrorV1 = error;
      releaseFailedWithErrorV1 = true;
    }
    if (!deps.getHandle()) {
      markerRemoved = true;
    }
    await concludeOwedPublishReview();
    if (publishReviewOwed) {
      const heldText =
        "Publish Checks pass after the fix. The Publish review will start once the previous provider process is confirmed stopped.";
      if (await writePublishFixNoteSafely(`> ${heldText}`, () => publishReviewOwed)) {
        showInformationSafely(heldText);
      }
    }
    if (releaseFailedWithErrorV1) {
      throw releaseErrorV1;
    }
  };

  return {
    isPublishReviewOwed: () => publishReviewOwed,
    isPublishReviewScheduled: () => publishReviewScheduled,
    isMarkerRemoved: () => markerRemoved,
    isReleaseFailed: () => releaseFailed,
    getReleaseFailureText: () => releaseFailureText,
    getReleaseAttemptsInFlight: () => releaseAttemptsInFlight,
    setPublishReviewOwed: (owed: boolean): void => {
      publishReviewOwed = owed;
    },
    releaseTrackedHandle,
    schedulePublishReviewAfterFixOnce,
    writePublishFixNoteSafely,
    concludeOwedPublishReview,
    trackReleaseAttempt,
    heartbeatTick,
    releaseAdmission,
    finishPublishFix,
  };
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
  parentOperation?: TaskOperationHandle,
  chatViewProvider?: ChatViewProvider
): Promise<void> {
  assertLegacyAiRouteAllowedV0("lint.v1");
  const resolverArg = normalizeArg(explicitArg);

  // ── Early work admission (v1 fixes item 1, Part 1a) ───────────────────────
  // Acquire durable admission BEFORE `resolveTaskContext` — the command's
  // first awaited setup read — whenever the target folder is known
  // synchronously from `explicitArg` (the dominant invocation: the Publish
  // stage's tree-row/inline button). No handoff-token adoption is wired here
  // (unlike `runReviewWithAI`/`fastForwardReviewWithAI`): no resume-then-
  // dispatch flow currently targets this command, so an ordinary
  // `acquireWorkAdmissionV1` genesis is always correct — there is no
  // same-process marker to adopt.
  const earlyFolderPath = extractSynchronousLintingFolderPathV1(explicitArg);
  // A nested fix (`parentOperation`, the commit-and-push flow's "Fix with AI")
  // runs under the parent's already-held admission marker for this task;
  // acquiring a second one would be refused as busy and the fix would never
  // start. The parent owns the marker, so the nested fix holds none.
  const parentHoldsAdmissionV1 = parentOperation !== undefined;
  const early = earlyFolderPath && !parentHoldsAdmissionV1
    ? await acquireWorkAdmissionV1({
        taskFolderPath: earlyFolderPath,
        purpose: "admission",
        commandId: "runLintingFixes",
      })
    : undefined;
  if (early && early.outcome !== "acquired") {
    NotificationRouter.showWarning(describeWorkAdmissionRefusalV1(early));
    return;
  }

  // Single mutable admission slot for the whole command — filled either by
  // the early acquisition above or, once a target is resolved (a bare
  // canonicalId or no-arg invocation), right after `resolveTaskContext`
  // below. Released in `finally` regardless of which branch of this command
  // returns, so a resolution failure, an unsupported stage, an already-passed
  // report, or a completed run all release admission exactly once.
  let handle: WorkAdmissionHandleV1 | undefined = early?.outcome === "acquired" ? early.handle : undefined;
  // Item 2 / Step 57: shared safe-release gate (`workAdmissionV1.ts`) — a
  // release is requested at most once, but only actually unlinks the marker
  // once the round's recorded processes are all confirmed gone; until then
  // the marker stays held (and the reason is written durably next to it so a
  // different process's retry refusal can name it too) and the heartbeat
  // keeps re-checking instead of blocking this command's `finally` on the
  // process actually exiting.
  const safeReleaseStateV1 = createSafeAdmissionReleaseStateV1();
  const onAdmissionHeldV1 = createAdmissionHeldNotifierV1();
  const onAdmissionReleasedV1 = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  // ── RC6 item 5: Publish review after a successful fix ─────────────────────
  // The follow-up review needs its own admission, so it may only be started
  // once THIS command's marker is actually removed. `safeReleaseStateV1.released`
  // is set before `handle.release()` resolves (and a heartbeat tick and the
  // finalizer can both be mid-release), so the marker's removal is observed
  // through the handle's own `release()` completing instead.
  const publishFixV1: { taskFolderUri?: vscode.Uri; lockKey?: string } = {};
  let finalChecksV1: { passed: boolean; failedChecks: readonly { command: string }[] } | undefined;
  let fixSucceededV1 = false;
  const changedFilesV1 = new Set<string>();
  // Item 2 / Step 57a completion fix (2026-09-29 review): out-param the AI
  // final-fixes dispatch below fills from its own runImplementationOrSealedV1
  // call, read back here so the terminal recordAdmissionReleaseTriggerV1 call
  // (right before this command's safe release) settles the held marker's
  // operationId/trigger against this round's ACTUAL coordinator outcome
  // instead of leaving them unset — mirrors runImplementationWithAI's own
  // dispatchProbe wiring.
  const lintDispatchProbeV1: { coordinatorOutcome?: TaskActionOutcomeV1 } = {};

  const coordinator = createPublishFixReleaseCoordinatorV1({
    getTaskFolderUri: () => publishFixV1.taskFolderUri,
    getLockKey: () => publishFixV1.lockKey,
    getHandle: () => handle,
    onAdmissionHeld: onAdmissionHeldV1,
    onAdmissionReleased: onAdmissionReleasedV1,
    safeReleaseState: safeReleaseStateV1,
    getFinalChecks: () => finalChecksV1,
    getFixSucceeded: () => fixSucceededV1,
    lintDispatchProbe: lintDispatchProbeV1,
    ...(explicitArg && "testDeps" in explicitArg ? explicitArg.testDeps : {}),
  });

  let heartbeat = handle ? setInterval(() => void coordinator.heartbeatTick(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1) : undefined;


  try {
  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    NotificationRouter.showInformation(
      "No task found. Please select a task first."
    );
    return;
  }

  if (!handle && !parentHoldsAdmissionV1) {
    const late = await acquireWorkAdmissionV1({
      taskFolderPath: resolvedTask.taskFolderPath,
      purpose: "admission",
      commandId: "runLintingFixes",
    });
    if (late.outcome !== "acquired") {
      NotificationRouter.showWarning(
        describeWorkAdmissionRefusalV1(
          late,
          notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath)
        )
      );
      return;
    }
    handle = late.handle;
    heartbeat = setInterval(() => void coordinator.heartbeatTick(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
  }

  const taskLabel = notificationTaskDisplayNameV1(resolvedTask.progress.displayName, resolvedTask.taskFolderPath);

  // Read the bundled prompt before watchdog reconciliation, review staleness
  // writes, or lint/fix work can change task state. The full prompt is rendered
  // later with the current diagnostics and context pack.
  try {
    await renderPromptTemplate(extensionUri, "final-fixes-code.md", { lint: "", contextPack: "" });
  } catch (error) {
    if (!isExtensionFolderRemovedErrorV1(error)) throw error;
    const notice = `${taskLabel} — Linting fixes were not started. ${error.message} ` +
      "The extension resources are unavailable, so Publish Checks cannot run from this window yet.";
    const chatPointer = await offerActionInChatV1({
      taskFolderPath: resolvedTask.taskFolderPath,
      taskLabel,
      actionLabel: "Open Extensions",
      command: "workbench.view.extensions",
      noticeText: notice,
      optional: true,
    }).catch((offerError: unknown) => {
      console.warn("Could not post the removed-extension recovery action in chat:", offerError);
      return undefined;
    });
    NotificationRouter.showError(notice /* taskLabel */, undefined, undefined, undefined, chatPointer);
    return;
  }

  // Admission is now guaranteed live for this exact target — reverse a
  // watchdog-provenance pause (never a user pause) before any further setup,
  // exactly like `runReviewWithAI`/`fastForwardReviewWithAI`. This command
  // does not itself gate on pause status (`allowPaused: true` above), but a
  // stale watchdog pause left in place would still strand the task for every
  // OTHER pause-sensitive reader once this command's own work is done.
  await reconcileWatchdogPauseAgainstAdmissionV1(vscode.Uri.file(resolvedTask.taskFolderPath));

  if (
    resolvedTask.progress.currentStage !== "publish"
  ) {
    NotificationRouter.showWarning(
      `${taskLabel}: linting fixes are only available at the Publish stage. Advance this task to Publish first.`
    );
    return;
  }

  // Fix what the LAST Publish-checks report (task-progress.json's
  // lintPayload) found — this action never runs the initial checks itself.
  // The first Publish action (runPublishChecks) produces the report; checks
  // re-run here only AFTER fixes, to verify them and refresh the report.
  // Gated before the tracked operation so the "Run Publish Checks" fallback
  // never contends with this action's own exclusive task lock.
  //
  // A Publish-stage review also populates this same lintPayload as a
  // side effect of computing its {{verifiedChecks}}/{{planItemVerification}}
  // prompt variables (reviewActions.ts's buildVerifiedChecksVariable /
  // persistPublishReviewLintPayload) — so it may already be populated here
  // even if no explicit "Run Publish Checks" ever ran. That review-sourced
  // lintPayload is marked `source: "review"`; nothing here needs to branch
  // on it, but it explains why a report can exist without runCompletionLint
  // ever having run for this task.
  const lastReport = resolvedTask.progress.lintPayload;
  if (!lastReport) {
    // No usable lintPayload: checks never ran, or the recorded result did not
    // survive. One line either way, no AI work.
    const notRunNotice = `${taskLabel}: Publish Checks have not run yet. Run them first.`;
    NotificationRouter.showWarning(
      notRunNotice,
      undefined,
      undefined,
      undefined,
      await offerLintFixRecoveryInChatV1(resolvedTask.taskFolderPath, taskLabel, notRunNotice)
    );
    return;
  }
  // The effective verdict, as Publish Checks announced it: a run whose only
  // failures are quarantined known flakes reports `passed: false` but
  // `passedModuloKnownFlakes: true`, and has nothing to fix.
  if (lastReport.passedModuloKnownFlakes ?? lastReport.passed) {
    NotificationRouter.showInformation(
      `${taskLabel}: Publish Checks passed, so there is nothing to fix.`
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const showFixHandbackV1 = async (
    noticeText: string,
    level: "warning" | "error" = "warning"
  ): Promise<void> => {
    const chatPointer = await offerLintFixRecoveryInChatV1(
      resolvedTask.taskFolderPath,
      taskLabel,
      noticeText,
      true
    );
    const message = `${noticeText}${chatPointer ? " Open the decision in Chat to continue." : ""}`;
    if (level === "error") {
      NotificationRouter.showError(message /* taskLabel */, undefined, undefined, undefined, chatPointer);
    } else {
      NotificationRouter.showWarning(message /* taskLabel */, undefined, undefined, undefined, chatPointer);
    }
  };

  // The inline tree button invokes this command directly (not through
  // applyCurrentStageAction), so the run-time model guard must live here
  // too — and before any mutation: with no Publish model configured, or
  // its provider disabled, the action must warn and open AI Models rather
  // than autofix/format files first and only fail at the AI pass.
  if (!(await ensureStageModelConfigured(taskFolderUri, "publish", resolvedTask.progress.displayName))) {
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
    const staleScopeNotice =
      `${taskLabel}: no valid Publish verification scope could be resolved (the saved scope ` +
      "or the task's project-root binding no longer exists). Re-run the " +
      "Publish checks to choose a new scope before applying fixes.";
    NotificationRouter.showWarning(
      staleScopeNotice,
      undefined,
      undefined,
      undefined,
      await offerLintFixRecoveryInChatV1(resolvedTask.taskFolderPath, taskLabel, staleScopeNotice)
    );
    return;
  }
  const fixScopeFolder = scope.folder;

  const lockKey = taskFolderUri.fsPath;
  const persistLintState = async (
    passed: boolean,
    summary: string
  ): Promise<void> => {
    await patchTaskProgressStrictV1(taskFolderUri, (current) =>
      updateLintPayload(current, {
        runAt: new Date().toISOString(),
        passed,
        summary,
      })
    );
  };

  await runTrackedOperation(
    lockKey,
    {
      label: "Linting Fixes",
      stage: "publish",
      taskName: resolveWorkflowRootTaskName(
        resolvedTask.progress.displayName ?? resolvedTask.folderName,
        resolvedTask.taskFolderPath
      ),
      kind: "lint-fixes",
      parent: parentOperation,
      cancellable: true,
    },
    async (op) => {
      let runLogRunnerId = "lint-fixes";
      let runLogOperationId = op.id;
      let runLogUriV1: vscode.Uri | undefined;
      const runLogAttemptIds: string[] = [];
      let runLogOutcome = "operation ended without a recorded terminal result";
      const settleFixOperation = (
        status: "failed" | "cancelled" | "interrupted",
        message: string
      ): void => {
        runLogOutcome = `${status}: ${message}`;
        op.settleAs(status, message);
      };
      try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Running linting fixes...",
          cancellable: true,
        },
        async (progress, progressToken) => {
          const linked = linkCancellationTokens(progressToken, op.token);
          const cancelToken = linked.token;
          try {
          NotificationRouter.emitProgressSummary(
            "Running linting fixes...",
            taskOperations.rootOperationIdFor(lockKey)
          );
          try {
            // RC6 item 5: the fix is about to change the code the Publish
            // review describes, so mark that document stale at once — it is
            // never shown as current after its code changed.
            publishFixV1.taskFolderUri = taskFolderUri;
            publishFixV1.lockKey = lockKey;
            // A write failure aborts the fix (handled by the catch below)
            // rather than letting code change under a review shown as current.
            await markPublishReviewStaleV1(
              taskFolderUri,
              "workspace files (Fix Linting & Code Errors)",
              new Date().toISOString()
            );
            throwIfPublishChecksCancelledV1(cancelToken);
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

            // Codex review finding: the deterministic autofix loop below
            // writes and saves files BEFORE the later "unrelated uncommitted
            // changes" safety check runs — so a scoped fix to any file
            // outside implReviewFiles/the task folder (getUnrelatedWorkspaceChanges's
            // own exclusions) shows up as an "unrelated" change the user is
            // warned to commit or stash, seconds after the extension itself
            // made it. Tracking exactly which paths THIS loop actually saves
            // (below) and excluding only those is what tells "this run's own
            // autofixes" apart from "genuinely pre-existing (or concurrently
            // introduced by someone else) dirty state" — a prior revision
            // instead snapshotted the whole unrelated-change set before the
            // loop and intersected the later result against it, which
            // over-excluded: a file a USER or another process modified
            // during the autofix/lint window (new since that snapshot, but
            // not this run's doing) was silently dropped from the warning
            // too, exactly like the run's own edits were. Recording actual
            // write targets instead of inferring them from a before/after
            // diff closes that gap.
            const workspaceFolderForSnapshot = vscode.workspace.getWorkspaceFolder(taskFolderUri);
            const autofixedRelativePaths = new Set<string>();

            progress.report({ message: "Applying automatic fixes..." });

            // Open each file with linting issues and apply fixes
            let fixedCount = 0;
            let failedCount = 0;
            // RC2 item 15, Step 39: whether an ESLint auto-fix was actually
            // attempted this run, and whether that specific attempt failed
            // (e.g. the ESLint extension is not installed/activated) — the
            // "install ESLint" hint below must only ever cite THIS, never
            // fire merely because there was nothing to fix or because a
            // later AI pass separately failed (RC1, 2026-09-28: the failing
            // check was a unit test, ESLint had nothing to do, and the hint
            // still told the owner to install an already-installed
            // extension).
            let eslintAutofixAttempted = false;
            let eslintUnavailable = false;

            for (const [uri, diags] of lintingIssues) {
              throwIfPublishChecksCancelledV1(cancelToken);
              const hasEslintIssues = diags.some((d) => d.source === "eslint");

              try {
                // Open the document to ensure it's in the active editor context
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });

                if (hasEslintIssues) {
                  eslintAutofixAttempted = true;
                  try {
                    // Try to execute ESLint fix command
                    await vscode.commands.executeCommand("eslint.executeAutofix");
                  } catch (eslintError) {
                    eslintUnavailable = true;
                    throw eslintError;
                  }
                  fixedCount++;
                } else {
                  // Try format document for TypeScript issues
                  await vscode.commands.executeCommand("editor.action.formatDocument");
                  fixedCount++;
                }

                // Fix commands can leave edits only in the in-memory document.
                // Persist them before collecting the post-fix result so the lint
                // payload describes what is actually on disk. Only a document
                // that was actually dirty (a real write happens) is recorded
                // below — one that the fix commands left unchanged can never
                // spuriously appear as newly dirty later, so it needs no
                // exclusion.
                if (doc.isDirty) {
                  await doc.save();
                  changedFilesV1.add(uri.fsPath);
                  if (workspaceFolderForSnapshot) {
                    const relativePath = path.relative(workspaceFolderForSnapshot.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
                    autofixedRelativePaths.add(relativePath);
                  }
                }
              } catch (error) {
                if (cancelToken.isCancellationRequested) throw error;
                failedCount++;
              }
            }

            throwIfPublishChecksCancelledV1(cancelToken);

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

            const deterministicScopeFolder = resolvePublishScopeFolder(taskFolderUri, resolvedTask.progress).folder;
            const deterministicBeforeSha = await resolveHeadCommitSha(deterministicScopeFolder);
            const deterministicBeforeFingerprint = await computeTreeFingerprintV1(deterministicScopeFolder);

            const postFixLint = await runCompletionLint(taskFolderUri, relevantFiles, { token: cancelToken });
            throwIfPublishChecksCancelledV1(cancelToken);
            await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);
            throwIfPublishChecksCancelledV1(cancelToken);
            finalChecksV1 = { passed: postFixLint.passed, failedChecks: postFixLint.failedChecks };

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
                // §7.5: the AI fix pass is the edit action here — its full
                // availability gate (host floor + tool probe + Copilot path +
                // workspace root) runs BEFORE the context pack and prompt
                // reads below. The deterministic autofixes above are not
                // edit-action work and run on any host.
                const editAvailability = await checkEditActionAvailabilityV1({
                  workspaceFsPath: workspaceFolder.uri.fsPath,
                  stageModelId: model.modelId,
                  stage: "publish",
                });
                if (!editAvailability.ok) {
                  // RC2 item 15 review fix: name the still-failing checks by
                  // command (postFixLint.failedChecks is an array of check
                  // objects, not strings), and only claim the deterministic
                  // autofixes above did something when they actually ran
                  // (fixedCount > 0) — a unit-test-only failure leaves
                  // fixedCount at 0 and must not be told autofixes helped.
                  const checkClassification = classifyFixCheckStatusesV1({
                    priorFailedChecks: postFixLint.failedChecks,
                    rerunExecuted: false,
                  });
                  const autofixNote =
                    fixedCount > 0
                      ? " The deterministic autofixes above were still applied."
                      : "";
                  settleFixOperation("failed", "AI final fixes unavailable; checks still fail");
                  await showFixHandbackV1(
                    `AI final fixes are unavailable: ${editAvailability.reason}${autofixNote} (${checkClassification.summary}) Fix the remaining issues, then run Publish Checks.`
                  );
                  return;
                }
                throwIfPublishChecksCancelledV1(cancelToken);
                const postFixDiagnostics = vscode.languages.getDiagnostics().filter(([uri, ds]) => isFileInFolder(uri, fixScopeFolder) && ds.some((d) => d.source === "eslint" || d.source === "ts" || d.source === "typescript"));
                const lint = JSON.stringify({
                  summary: postFixLint.summary,
                  issueCount: postFixLint.issueCount,
                  failedChecks: postFixLint.failedChecks,
                  remainingFiles: remainingLintIssues,
                  diagnostics: postFixDiagnostics.map(([uri, ds]) => ({ file: uri.fsPath, messages: ds.map((d) => d.message) })),
                  rawReportLocation: postFixLint.rawReportLocation ?? "runs/raw-check-output.log",
                }, null, 2);
                const contextPack = await generateContextPack(taskFolderUri, workspaceFolder.uri);
                const prompt = await renderPromptTemplate(extensionUri, "final-fixes-code.md", { lint, contextPack });
                const sizeCheck = await checkAndConfirmPromptSize(prompt, "the configured Publish-stage agent", 0, {
                  displayName: resolvedTask.progress.displayName,
                  folderPath: taskFolderUri.fsPath,
                  token: cancelToken,
                });
                throwIfPublishChecksCancelledV1(cancelToken);
                if (sizeCheck === "ok" || sizeCheck === "confirmed") {
                  if (!context || !(await ensureAiConsent(context, taskFolderUri.fsPath, cancelToken))) {
                    throwIfPublishChecksCancelledV1(cancelToken);
                    return;
                  }
                  throwIfPublishChecksCancelledV1(cancelToken);
                  // Pre-run safety checks for agentic file-editing runs —
                  // the same gate executeImplementationRun applies (in the
                  // same size-gate → consent → safety-check order) before
                  // Generate Implementation/Apply Review/Fast Forward. This
                  // branch calls runImplementationOrSealedV1 directly rather
                  // than going through that shared entry point, so it needs
                  // its own copy: a CLI-resolved model's edit-mode run has
                  // full, extension-unmediated workspace write access
                  // (unlike the sealed pipeline's receipted, revalidated
                  // mutations), so without this it could silently edit a
                  // non-git workspace or overwrite unrelated uncommitted
                  // work.
                  const cwd = workspaceFolder.uri.fsPath;
                  const isGit = await isGitWorkspace(cwd);
                  if (!isGit) {
                    const proceed = await askChatChoiceV1({
                      target: { canonicalId: taskFolderUri.fsPath, taskFolderPath: taskFolderUri.fsPath, stage: "publish" },
                      decisionKey: "confirmNonGitLintingFixes",
                      whatHappened:
                        "⚠️ This workspace is not tracked by git.\n\n" +
                        "The AI final-fixes run will edit files in your workspace, " +
                        "but there is no git history to track or revert those changes. " +
                        "You will not be able to see exactly what was changed or undo it via git.\n\n" +
                        "Back up your workspace before proceeding.",
                      whyUserNeeded: "Edits in a non-git workspace cannot be tracked or reverted via git.",
                      options: [
                        { optionId: "proceed", label: "Proceed Anyway" },
                        { optionId: "cancel", label: "Cancel" },
                      ],
                      token: cancelToken,
                    });
                    throwIfPublishChecksCancelledV1(cancelToken);
                    if (proceed !== "proceed") {
                      NotificationRouter.showInformation("AI final fixes cancelled.");
                      return;
                    }
                  } else {
                    // Excludes only paths the autofix loop above actually
                    // wrote (autofixedRelativePaths) — not "anything new
                    // since a before-loop snapshot", which would also hide a
                    // genuinely unrelated concurrent edit (the user, or
                    // another process, touching a different file during the
                    // autofix/lint window) from this warning.
                    const currentUnrelatedChanges = await getUnrelatedWorkspaceChanges(cwd, taskFolderUri);
                    const unrelatedChanges = currentUnrelatedChanges.filter(
                      (file) => !autofixedRelativePaths.has(file)
                    );
                    if (unrelatedChanges.length > 0 && !allowsDirtyWorktreeChanges()) {
                      const preview = unrelatedChanges.slice(0, 5).map((file) => `• ${file}`).join("\n");
                      const more = unrelatedChanges.length > 5
                        ? `\n• … and ${unrelatedChanges.length - 5} more`
                        : "";
                      const proceed = await askChatChoiceV1({
                        target: { canonicalId: taskFolderUri.fsPath, taskFolderPath: taskFolderUri.fsPath, stage: "publish" },
                        decisionKey: "confirmDirtyWorkspaceLintingFixes",
                        whatHappened:
                          "⚠️ Your workspace has unrelated uncommitted changes.\n\n" +
                          "The AI final-fixes run may edit workspace files. Commit, stash, " +
                          "or review these unrelated changes first:\n\n" + preview + more,
                        whyUserNeeded: "Confirming prevents unrelated uncommitted changes from being mixed into the final-fixes round.",
                        options: [
                          { optionId: "proceed", label: "Proceed" },
                          { optionId: "cancel", label: "Cancel" },
                        ],
                        token: cancelToken,
                      });
                      throwIfPublishChecksCancelledV1(cancelToken);
                      if (proceed !== "proceed") {
                        NotificationRouter.showInformation("AI final fixes cancelled.");
                        return;
                      }
                    }
                  }
                  let result: Awaited<ReturnType<typeof runImplementationOrSealedV1>> | undefined;
                  await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Applying AI final fixes...", cancellable: true }, async (aiProgress, token) => {
                    const aiLinked = linkCancellationTokens(token, cancelToken);
                    try {
                    // Copilot-resolved models run the sealed two-phase
                    // pipeline; CLI-resolved models run their own direct
                    // edit-mode invocation instead (see
                    // runImplementationOrSealedV1's header). `model` is
                    // resolved from the "publish" stage above — fallback
                    // bookkeeping lives in the coordinator's/runner's ranked
                    // selection.
                    result = await runImplementationOrSealedV1({
                      editActionKey: "lint.v1",
                      modelId: model.modelId,
                      prompt,
                      workspaceUri: workspaceFolder.uri,
                      token: aiLinked.token,
                      stage: "publish",
                      taskStage: "publish",
                      taskFolderUri: taskFolderUri,
                      taskDisplayName: resolvedTask.progress.displayName,
                      // A nested fix holds no marker of its own; record its
                      // provider process against the parent's held claim.
                      roundProcessClaimId:
                        handle?.claimId ??
                        (parentHoldsAdmissionV1 ? heldAdmissionClaimIdForTaskV1(lockKey) : undefined),
                      configuredFailingCommands: postFixLint.failedChecks.map((check) => {
                        const monorepoMatch = check.command.match(/^\[([^\]]+)\]\s*(.*)$/);
                        if (monorepoMatch && monorepoMatch[1] && monorepoMatch[2]) {
                          const pkgDir = monorepoMatch[1].trim();
                          return {
                            displayCommand: check.command,
                            executableCommand: monorepoMatch[2].trim(),
                            cwd: path.resolve(fixScopeFolder, pkgDir),
                          };
                        }
                        return {
                          displayCommand: check.command,
                          executableCommand: check.command.trim(),
                          cwd: fixScopeFolder,
                        };
                      }),
                      dispatchProbe: lintDispatchProbeV1,
                      dispatchOperationId: op.id,
                      onCandidateInvokedV1: async (info: CandidateInvocationInfoV1) => {
                        runLogRunnerId = info.runnerId;
                        runLogOperationId = info.operationId ?? op.id;
                        if (info.attemptId && !runLogAttemptIds.includes(info.attemptId)) {
                          runLogAttemptIds.push(info.attemptId);
                        }
                        op.setModel?.(info.storedModelId);
                        const message = candidateInvocationMessageV1(
                          "AI final fixes",
                          info.storedModelId,
                          info.providerLabel,
                          info.backup
                        );
                        op.report?.(message);
                        NotificationRouter.showInformation(message);
                        await persistCandidateDispatchModelChainV1({
                          taskFolderUri,
                          stage: "publish",
                          operationId: info.operationId ?? op.id,
                          attemptId: info.attemptId,
                          runnerId: info.runnerId,
                          storedModelId: info.storedModelId,
                          providerLabel: info.providerLabel,
                        }).catch((error) => console.warn("Could not persist lint-fix dispatch model chain:", error));
                        runLogUriV1 = await writeRunLog(
                          taskFolderUri,
                          runLogRunnerId,
                          "publish",
                          `# Fix Linting & Code Errors\n\nDispatch started with ${info.providerLabel} — ${info.storedModelId}.\nOperation: ${runLogOperationId}. Attempt: ${info.attemptId ?? "unknown"}.`,
                          { operationId: runLogOperationId, attemptIds: runLogAttemptIds }
                        ).catch((error) => {
                          console.warn("Could not write lint-fix dispatch run log:", error);
                          return undefined;
                        });
                      },
                      onProgress: (message) => aiProgress.report({ message }),
                      // Mirror structured preflight questions into task-local
                      // Chat so Answer/Resume work (plan §5.5).
                      onQuestions: async (questionsOutcome) => {
                        if (!chatViewProvider) {
                          return;
                        }
                        const orchestrator = getProductionActionConversationOrchestratorV1();
                        const record = await orchestrator.getRecord({
                          operationId: questionsOutcome.correlation.operationId,
                          interactionId: questionsOutcome.interactionId,
                          taskBindingId: questionsOutcome.correlation.taskBindingId,
                          chatDocumentId: questionsOutcome.correlation.chatDocumentId,
                          sourceAttemptId: questionsOutcome.correlation.attemptId,
                        });
                        if (record) {
                          await chatViewProvider.askInteraction({
                            canonicalId: taskFolderUri.fsPath,
                            taskFolderPath: taskFolderUri.fsPath,
                            stage: record.stage,
                            taskName: resolvedTask.progress.displayName,
                            interactionId: record.interactionId,
                            operationId: record.correlation.operationId,
                            actionKey: record.correlation.actionKey,
                            sourceAttemptId: record.correlation.attemptId,
                            // safe: loaded via a "questions" outcome.
                            questions: record.questions!,
                            binding: {
                              taskBindingId: record.correlation.taskBindingId,
                              chatDocumentId: record.correlation.chatDocumentId,
                            },
                          });
                        }
                      },
                    });
                    } finally {
                      aiLinked.dispose();
                    }
                  });
                  if (result?.filesChanged) {
                    for (const file of result.filesChanged) changedFilesV1.add(path.resolve(workspaceFolder.uri.fsPath, file));
                  }
                  if (cancelToken.isCancellationRequested || result?.status === "cancelled") {
                    const changed = [...changedFilesV1].sort();
                    const detail = changed.length > 0 ? ` Files already changed: ${changed.join(", ")}.` : " No changed files were reported.";
                    fixSucceededV1 = false;
                    finalChecksV1 = undefined;
                    settleFixOperation("cancelled", `Fix Linting & Code Errors was cancelled.${detail}`);
                    await showFixHandbackV1(
                      `Fix Linting & Code Errors was cancelled.${detail} Review any retained edits, then run Publish Checks to verify the current workspace.`
                    );
                    return;
                  }
                  if (result?.status === "completed") {
                    const scopeFolder = resolvePublishScopeFolder(taskFolderUri, resolvedTask.progress).folder;
                    const beforeSha = await resolveHeadCommitSha(scopeFolder);
                    const beforeFingerprint = await computeTreeFingerprintV1(scopeFolder);

                    const rerunLint = await runCompletionLint(taskFolderUri, relevantFiles, { token: cancelToken });
                    throwIfPublishChecksCancelledV1(cancelToken);
                    await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);
                    throwIfPublishChecksCancelledV1(cancelToken);
                    finalChecksV1 = { passed: rerunLint.passed, failedChecks: rerunLint.failedChecks };
                    await inventory.refresh();
                    const deniedCommands =
                      result.executedChecks?.filter((c) => c.outcome === "sandbox-denied").map((c) => c.command) ?? [];
                    const classification = classifyFixCheckStatusesV1({
                      priorFailedChecks: postFixLint.failedChecks,
                      rerunFailedChecks: rerunLint.failedChecks,
                      rerunCommandsRun: rerunLint.commandsRun,
                      rerunExecuted: true,
                      deniedCommands,
                    });
                    const hasUnresolvedChecks = fixHasUnresolvedChecksV1({
                      rerunPassed: rerunLint.passed,
                      classification,
                      priorFailedCount: postFixLint.failedChecks.length,
                    });

                    if (hasUnresolvedChecks) {
                      // B2 / Step 28: A fix without verified passing reruns for all prior failures
                      // must not read as success, write freshness stamps, or schedule review.
                      finalChecksV1 = {
                        passed: false,
                        failedChecks:
                          rerunLint.failedChecks.length > 0
                            ? rerunLint.failedChecks
                            : classification.items.filter((i) => i.status !== "passing").map((i) => ({ command: i.command })),
                      };
                      fixSucceededV1 = false;
                      if (!rerunLint.passed) {
                        settleFixOperation("failed", "checks still fail after the AI fixes were applied");
                        await showFixHandbackV1(
                          `AI final fixes were applied, but checks still fail (${classification.summary}). Fix the remaining issues, then run Publish Checks.`
                        );
                      } else if (classification.hasUnrun) {
                        settleFixOperation("failed", "prior failing checks were omitted or unrun after the AI fixes were applied");
                        await showFixHandbackV1(
                          `AI final fixes were applied, but prior checks were not rerun (${classification.summary}). Fix the remaining issues, then run Publish Checks.`
                        );
                      } else {
                        settleFixOperation("failed", "prior failing checks were denied in the sandbox and remain untested");
                        await showFixHandbackV1(
                          `AI final fixes were applied, but checks remain untested (${classification.summary}). Fix the remaining issues, then run Publish Checks.`
                        );
                      }
                    } else {
                      finalChecksV1 = { passed: true, failedChecks: [] };
                      const verifiedFolder = rerunLint.verifiedFolder ?? scopeFolder;
                      const afterSha = await resolveHeadCommitSha(verifiedFolder);
                      const afterFingerprint = await computeTreeFingerprintV1(verifiedFolder);
                      const unchangedHead = Boolean(beforeSha && afterSha && beforeSha === afterSha);
                      const unchangedFingerprint = Boolean(
                        beforeFingerprint &&
                        afterFingerprint &&
                        beforeFingerprint === afterFingerprint
                      );
                      const unchangedScope =
                        computePublishScopeId(scopeFolder) === computePublishScopeId(verifiedFolder);

                      if (
                        unchangedHead &&
                        unchangedFingerprint &&
                        unchangedScope &&
                        afterSha &&
                        afterFingerprint
                      ) {
                        throwIfPublishChecksCancelledV1(cancelToken);
                        await writePublishChecksFreshnessStampV1(taskFolderUri, {
                          formatVersion: 1,
                          runId: crypto.randomUUID(),
                          verifiedCommitSha: afterSha,
                          completedAt: new Date().toISOString(),
                          scopeId: computePublishScopeId(verifiedFolder),
                          treeFingerprint: afterFingerprint,
                        });
                      }
                      throwIfPublishChecksCancelledV1(cancelToken);
                      // Every awaited step on this path has returned.
                      fixSucceededV1 = true;
                      NotificationRouter.showInformation(
                        `AI final fixes applied; completion lint was rerun (${classification.summary}).`
                      );
                    }
                  } else {
                    // RC2 item 15, Step 40: this branch already ran the AI
                    // pass and re-ran completion lint against its (possibly
                    // absent) effect — the checks it reports here are the
                    // real, current answer to "did this help?" and must be
                    // the last word for this run, not silently overridden by
                    // the unrelated deterministic-autofix-count message
                    // below (see the `return` after this block).
                    const rerunLint = await runCompletionLint(taskFolderUri, relevantFiles, { token: cancelToken });
                    throwIfPublishChecksCancelledV1(cancelToken);
                    await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);
                    throwIfPublishChecksCancelledV1(cancelToken);
                    finalChecksV1 = { passed: rerunLint.passed, failedChecks: rerunLint.failedChecks };
                    await inventory.refresh();
                    const deniedCommands =
                      result?.executedChecks?.filter((c) => c.outcome === "sandbox-denied").map((c) => c.command) ?? [];
                    const classification = classifyFixCheckStatusesV1({
                      priorFailedChecks: postFixLint.failedChecks,
                      rerunFailedChecks: rerunLint.failedChecks,
                      rerunCommandsRun: rerunLint.commandsRun,
                      rerunExecuted: true,
                      deniedCommands,
                    });
                    // A `status: "failed"` result with an empty/missing
                    // `errorMessage` must still be reported as a failure,
                    // never mistaken for `"cancelled"` (Step 40). RC3 item 11
                    // (Step 9): neither sub-case leaves the fixes actually
                    // applied, so neither may report "completed" at the
                    // operation level.
                    if (result?.status === "failed") {
                      settleFixOperation("failed", result.errorMessage ?? "no reason was reported");
                      await showFixHandbackV1(
                        `AI final fixes failed: ${result.errorMessage ?? "no reason was reported"} (${classification.summary}). Review the changes, then run Publish Checks.`
                      );
                    } else {
                      settleFixOperation("failed", "AI final fixes were cancelled before completing");
                      await showFixHandbackV1(
                        `AI final fixes were cancelled; completion lint was rerun (${classification.summary}). Run Publish Checks when ready.`
                      );
                    }
                  }
                  return;
                }
              }
            }

            // Keep the tree and subsequent command resolution aligned with the
            // refreshed persisted lint payload.
            await inventory.refresh();

            // Deterministic path: stamp freshness (an awaited step) before the
            // success flag below is set, so every awaited step has returned
            // when `fixSucceededV1` flips.
            if (postFixLint.passed && fixedCount > 0) {
              const verifiedFolder = postFixLint.verifiedFolder ?? deterministicScopeFolder;
              const afterSha = await resolveHeadCommitSha(verifiedFolder);
              const afterFingerprint = await computeTreeFingerprintV1(verifiedFolder);
              const unchangedHead = Boolean(
                deterministicBeforeSha && afterSha && deterministicBeforeSha === afterSha
              );
              const unchangedFingerprint = Boolean(
                deterministicBeforeFingerprint &&
                afterFingerprint &&
                deterministicBeforeFingerprint === afterFingerprint
              );
              const unchangedScope =
                computePublishScopeId(deterministicScopeFolder) === computePublishScopeId(verifiedFolder);

              if (
                unchangedHead &&
                unchangedFingerprint &&
                unchangedScope &&
                afterSha &&
                afterFingerprint
              ) {
                throwIfPublishChecksCancelledV1(cancelToken);
                await writePublishChecksFreshnessStampV1(taskFolderUri, {
                  formatVersion: 1,
                  runId: crypto.randomUUID(),
                  verifiedCommitSha: afterSha,
                  completedAt: new Date().toISOString(),
                  scopeId: computePublishScopeId(verifiedFolder),
                  treeFingerprint: afterFingerprint,
                });
              }
            }

            throwIfPublishChecksCancelledV1(cancelToken);

            // A fix "succeeded" only when the checks it was meant to satisfy pass.
            if (postFixLint.passed && fixedCount > 0) {
              fixSucceededV1 = true;
            }

            const deterministicOutcome = deterministicFixOutcomeV1({
              passed: postFixLint.passed,
              fixedCount,
              failedCommands: postFixLint.failedChecks.map((check) => check.command),
            });
            if (deterministicOutcome.kind === "failure" && !fixSucceededV1) {
              settleFixOperation(
                "failed",
                fixedCount > 0 ? "deterministic fixes applied but checks still fail" : "completion lint failed with no automatic fixes available"
              );
              await showFixHandbackV1(deterministicOutcome.handback!);
            } else if (fixedCount > 0) {
              NotificationRouter.showInformation(
                `Linting fixes applied to ${fixedCount} file(s) in the Publish scope!` +
                (failedCount > 0 ? ` (${failedCount} file(s) could not be fixed automatically)` : "")
              );
            } else if (eslintAutofixAttempted && eslintUnavailable) {
              // RC2 item 15, Step 39: only reachable when an ESLint
              // auto-fix was actually attempted and that specific attempt
              // failed (extension not installed/activated) — see the flags
              // set in the loop above.
              await showFixHandbackV1(
                "Could not apply automatic fixes because the ESLint extension is unavailable. Install ESLint or activate it, fix the reported issues manually, then run Publish Checks."
              );
            } else {
              const stillFailingChecks = postFixLint.failedChecks;
              if (stillFailingChecks.length > 0) {
                // RC3 item 11 (Step 9): checks are still failing here, so the
                // operation-level notification must not read "completed".
                settleFixOperation("failed", "no automatic fixes were available; checks still fail");
              }
              await showFixHandbackV1(
                stillFailingChecks.length > 0
                  ? `No automatic fixes were available. The failing checks are unchanged: ${stillFailingChecks.map((check) => check.command).join(", ")}. Fix them manually, then run Publish Checks.`
                  : "No automatic fixes were available for the issues found in the Publish scope. Review the report, fix them manually, then run Publish Checks."
              );
            }
          } catch (error) {
            if (cancelToken.isCancellationRequested || error instanceof PublishChecksCancelledError) {
              const changed = [...changedFilesV1].sort();
              const detail = changed.length > 0 ? ` Files already changed: ${changed.join(", ")}.` : " No changed files were reported.";
              fixSucceededV1 = false;
              finalChecksV1 = undefined;
              settleFixOperation("cancelled", `Fix Linting & Code Errors was cancelled.${detail}`);
              await showFixHandbackV1(
                `Fix Linting & Code Errors was cancelled.${detail} Review any retained edits, then run Publish Checks to verify the current workspace.`
              );
              return;
            }
            if (isExtensionFolderRemovedErrorV1(error)) {
              // Do not run more checks or persist another lint verdict after
              // the extension-owned prompt read proved this window is stale.
              fixSucceededV1 = false;
              finalChecksV1 = undefined;
              settleFixOperation("failed", "linting fixes were not started because the extension folder was removed");
              await showFixHandbackV1(
                `Linting fixes were not started. ${error.message} The fix checks were not run; run Publish Checks after resolving this.`,
                "error"
              );
              return;
            }
            // An error ends the fix without a verdict: nothing is owed and no
            // note is written; the stale banner stays.
            fixSucceededV1 = false;
            finalChecksV1 = undefined;
            try {
              await runCompletionLint(taskFolderUri, resolvedTask.progress.implReviewFiles, { token: cancelToken });
              await runPublishScopeCheck(taskFolderUri, resolvedTask.progress);
            } catch {
              await persistLintState(
                false,
                `Linting run failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            await showFixHandbackV1(
              `Linting fixes failed: ${error instanceof Error ? error.message : String(error)}. The final checks could not be confirmed; run Publish Checks after reviewing the report.`,
              "error"
            );
          }
          } finally {
            linked.dispose();
          }
        }
      );
      } finally {
        if (runLogOutcome === "operation ended without a recorded terminal result") {
          runLogOutcome = fixSucceededV1
            ? "completed: lint fixes and required follow-up checks passed"
            : finalChecksV1
              ? `failed: final checks ${finalChecksV1.passed ? "passed" : "failed"} without an explicit operation outcome`
              : "interrupted or incomplete: no final check result was recorded";
        }
        const changed = [...changedFilesV1].sort();
        const summary = [
          "# Fix Linting & Code Errors",
          "",
          `Outcome: ${runLogOutcome}`,
          `Changed files: ${changed.length > 0 ? changed.join(", ") : "none reported"}`,
          finalChecksV1
            ? `Final checks: ${finalChecksV1.passed ? "passed" : "failed"}; ${finalChecksV1.failedChecks.length} failing checks.`
            : "Final checks: no final result was recorded.",
        ].join("\n");
        if (runLogUriV1) {
          try {
            const existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(runLogUriV1));
            await vscode.workspace.fs.writeFile(
              runLogUriV1,
              new TextEncoder().encode(`${existing}\n\n## Terminal outcome\n\n${summary}\n`)
            );
          } catch (error) {
            console.warn("Could not finalize lint-fix run log:", error);
          }
        } else {
          await writeRunLog(taskFolderUri, runLogRunnerId, "publish", summary, {
            operationId: runLogOperationId,
            attemptIds: runLogAttemptIds,
          }).catch((error) => console.warn("Could not write lint-fix run log:", error));
        }
      }
    }
  );
  } finally {
    await coordinator.finishPublishFix();
  }
}

/**
 * Register the runLintingFixes command.
 */
export function registerRunLintingFixesCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider?: ChatViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.runLintingFixes",
    forwardInViewerV1("vs-code-ai-helper.runLintingFixes", (arg?: RunLintingFixesArg) =>
      runLintingFixes(inventory, context.extensionUri, arg, context, undefined, chatViewProvider)
    )
  );
  context.subscriptions.push(disposable);
}
