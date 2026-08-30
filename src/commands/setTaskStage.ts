import * as vscode from "vscode";
import {
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import { advanceStage, AUTO_REVIEW_ELIGIBLE_KINDS, TransitionKind } from "../utils/stageTransition";
import { NotificationRouter } from "../utils/notificationRouter";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { scheduleAutomationChain } from "../utils/automationChain";
import { cancelRunningOperationsForTask } from "../utils/taskOperations";
import { pickReopenStage, reopenCompletedTask } from "../utils/reopenTask";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { ESCALATION_DECISION_KEYS_V1 } from "../utils/reviewEscalation";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";

/**
 * Accepted argument shapes for setTaskStage.
 * - Tree-view stage node passes { task: IncompleteTask, stage: TaskStage }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath?, stage? }
 */
type SetTaskStageArg =
  | { task?: IncompleteTask; stage?: TaskStage }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage };

/**
 * Normalize a command argument into the shape resolveTaskContext expects,
 * plus the requested target stage.
 *
 * Also returns whether the caller supplied an explicit task identifier so
 * the command can distinguish "explicit task that failed to resolve" from
 * "no task context supplied at all".
 */
function normalizeArg(node: SetTaskStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined;
  hasExplicitTask: boolean;
} {
  if (!node) {
    return { resolverArg: undefined, stage: undefined, hasExplicitTask: false };
  }

  if ("task" in node && node.task) {
    return {
      resolverArg: { taskFolderPath: node.task.folderUri.fsPath },
      stage: node.stage,
      hasExplicitTask: true,
    };
  }

  const n = node as {
    canonicalId?: string;
    taskFolderPath?: string;
    stage?: TaskStage;
  };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return {
    resolverArg: hasExplicit
      ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
      : undefined,
    stage: n.stage,
    hasExplicitTask: hasExplicit,
  };
}

/**
 * Let the user jump a task's tracked stage backward or forward, overriding
 * the stage the workflow last auto-advanced it to. No confirmation dialog.
 *
 * When invoked from the tasks tree view, the tree node passes a task/stage
 * pair or canonicalId/taskFolderPath so the task picker is skipped.
 *
 * After a successful stage change the task is persisted as the current task
 * in CurrentTaskStore so the keyboard shortcut router and status bar reflect
 * it immediately — CurrentTaskStore is the single source of truth for all
 * surfaces (tree, status bar, task actions).
 *
 * @param kind - why this transition is happening. Passed straight through to
 *   `advanceStage`'s `kind` gate rather than being re-derived from a boolean,
 *   so a caller can only ever get auto-review by actually claiming a kind
 *   that's in `AUTO_REVIEW_ELIGIBLE_KINDS` — see stageTransition.ts.
 *   Default: `"jump"` (manual set-stage-as-current does not auto-trigger review).
 */
export async function setTaskStage(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  node?: SetTaskStageArg,
  kind: TransitionKind = "jump"
): Promise<void> {
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read, so it cannot race the read-only
  // creating-folder reconciliation extension.ts kicks off during activate()
  // — same barrier contract as startNewTask/resumeTask (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const { resolverArg, stage: requestedStage, hasExplicitTask } =
    normalizeArg(node);

  // Resolve via shared inventory-backed resolver, with persisted current-task
  // support so the command works correctly from both tree-item invocation and
  // command-palette invocation.
  const resolvedTask = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: false },
    currentTaskStore
  );

  if (!resolvedTask) {
    // If the caller supplied an explicit task identifier (tree
    // node, canonical ID, or folder path) but resolution failed, that means
    // the referenced task no longer exists or is no longer discoverable.
    // Silently falling through to a task picker would redirect the action
    // onto an unrelated task — exactly the wrong behaviour the resolver fix
    // was designed to prevent. Fail clearly for explicit-task callers.
    if (hasExplicitTask) {
      NotificationRouter.showError(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
      return;
    }

    // No explicit task was supplied (e.g. command-palette invocation with no
    // active task). Fall back to a quick pick over all known tasks.
    const allTasks = inventory.getTasks();
    if (allTasks.length === 0) {
      NotificationRouter.showInformation(
        "No task folders found. Use 'Start New Task' to create one."
      );
      return;
    }

    const taskItems = allTasks.map((task) => ({
      label: task.progress.displayName ?? task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      // wf10 item 21: the folder id (never shown elsewhere once displayName
      // exists) stays visible here alongside the recency hint, rather than
      // rendering only an unrecognizable folder id as the whole label.
      detail: `${task.folderName} · Last updated: ${new Date(
        task.progress.updatedAt
      ).toLocaleString()}`,
      task,
    }));

    const selectedTaskItem =
      taskItems.length === 1
        ? taskItems[0]
        : await vscode.window.showQuickPick(taskItems, {
            placeHolder: "Select a task",
            title: "Set Task Stage",
          });

    if (!selectedTaskItem) {
      return;
    }

    // Re-enter with an explicit canonical ID so the resolver path is taken on
    // the recursive call. The hasExplicitTask guard above ensures that if this
    // new lookup also fails (very unlikely after a fresh pick), it will report
    // an error rather than looping.
    return setTaskStage(
      inventory,
      currentTaskStore,
      {
        canonicalId: selectedTaskItem.task.canonicalId,
        stage: requestedStage,
      },
      kind
    );
  }

  const task = resolvedTask;

  // A completed task changing stage is always a reopen, never a plain
  // advance/jump: `advanceStage` has no notion of leaving the completed
  // lifecycle, and the current-stage-current filtering below would remove
  // Publish — a valid reopen target — from a completed task's picker. Route
  // through the same reopen transition Resume uses so this command (reachable
  // from the palette and keybindings, where menu `when`-clauses can't help)
  // can never regress a completed task into a contradictory state.
  if (task.progress.status === "completed") {
    return setTaskStageOnCompletedTask(inventory, currentTaskStore, task, requestedStage);
  }

  let newStage: TaskStage | undefined = requestedStage;

  if (!newStage) {
    const stageItems = STAGE_ORDER.filter(
      (stage) => stage !== task.progress.currentStage
    ).map((stage) => ({
      label: STAGE_DISPLAY_NAMES[stage],
      stage,
    }));

    const selectedStageItem = await vscode.window.showQuickPick(stageItems, {
      placeHolder: "Select the stage this task should be on",
      title: `Set Stage: ${task.folderName}`,
    });

    if (!selectedStageItem) {
      return;
    }
    newStage = selectedStageItem.stage;
  }

  if (newStage === task.progress.currentStage) {
    return;
  }

  // "Set Task Stage" / "Set as Current Stage" must abort whatever the
  // task's current stage was still running BEFORE moving off it — otherwise
  // the old stage's process keeps running in the background (writing into a
  // stage the user just navigated away from), and this handler runs no AI
  // automation of its own for the destination stage (kind="jump" is
  // excluded from both AUTO_REVIEW_ELIGIBLE_KINDS and, unconditionally,
  // publish scheduling — see stageTransition.ts), so there is nothing to
  // "hand off" to here; the goal is purely to stop.
  const cancelResult = await cancelRunningOperationsForTask(task.taskFolderPath);
  if (!cancelResult.ok) {
    NotificationRouter.showError(
      `Could not set stage for ${task.folderName}: ${cancelResult.reason}`
    );
    return;
  }

  // Persist the destination stage using the shared advanceStage helper.
  // This centralizes auto-review eligibility, transition sequencing, and persistence.
  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
  let transitionResult: Awaited<ReturnType<typeof advanceStage>>;
  try {
    transitionResult = await advanceStage(
      taskFolderUri,
      task.progress.currentStage,
      newStage,
      false,
      kind,
      AUTO_REVIEW_ELIGIBLE_KINDS.has(kind)
    );
  } catch (error) {
    // advanceStage throws (rather than resolving falsy) when its
    // compare-and-set is rejected — e.g. a concurrent manual/auto transition
    // already moved this task's stage under the lock. Report it the same way
    // as any other failed transition instead of letting it surface as an
    // unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showWarning(
      `Could not set stage for ${task.folderName}: ${message}`
    );
    return;
  }

  if (!transitionResult?.persisted) {
    NotificationRouter.showError(
      `Could not read or update task progress for ${task.folderName}.`
    );
    return;
  }

  // Review blocker (2026-08-30, Part 11 item 13c): `TaskProgress.escalation`
  // is already cleared by the stage-transition field policy on every advance
  // ("a stage transition resolves the departing stage's stuck iteration" —
  // taskProgressFieldPolicyV1.ts), but that clears the FIELD, not any
  // decision CARD already posted for it — those live in the separate
  // WorkflowDecisionStoreV1 and are otherwise only withdrawn by
  // resumePausedTask. A stage change reachable without going through resume
  // (this command resolves with allowPaused: false so it cannot itself act on
  // a paused task, but the invariant "escalation only exists while paused" is
  // not something this call site should have to rely on to stay correct) must
  // not leave a stale escalation card naming a stage the task has since left.
  // Best-effort and unconditional: withdraw is already a no-op when nothing
  // pending matches the key.
  for (const decisionKey of ESCALATION_DECISION_KEYS_V1) {
    await withdrawWorkflowDecisionsByKeyV1(
      { taskFolderPath: task.taskFolderPath, canonicalId: task.canonicalId },
      decisionKey,
      `the task's stage changed to ${STAGE_DISPLAY_NAMES[newStage]}, ending the pause any escalation for the prior stage was holding`
    );
  }

  // Refresh the inventory so the new stage is visible immediately
  await inventory.refresh();

  let publishPreflight: Awaited<ReturnType<typeof checkPublishPreflight>> | undefined;
  if (newStage === "publish") {
    publishPreflight = await checkPublishPreflight(taskFolderUri, task.progress.implReviewFiles);
    await inventory.refresh();
  }

  NotificationRouter.showInformation(
    `${task.folderName} set to stage: ${STAGE_DISPLAY_NAMES[newStage]}`
  );

  // Commit and push is never scheduled automatically — landing on Publish
  // (from any entry point) never runs it; only the user's own "Commit and
  // Push" button click does. Failing completion checks are still worth
  // surfacing immediately, with a one-click "Publish Anyway" affordance,
  // instead of only being discovered later inside Commit and Push's own gate.
  if (newStage === "publish" && publishPreflight?.ok === false) {
    NotificationRouter.showWarning(
      `${task.folderName}: ${publishPreflight.reason}. Publish once checks pass, or use Publish Anyway from Commit and Push.`,
      undefined,
      undefined,
      undefined,
      {
        command: "vs-code-ai-helper.commitAndPushTask",
        title: "Publish Anyway",
        args: [{ taskFolderPath: task.taskFolderPath }],
      }
    );
  }

  // Persist this task as the current task so the keyboard shortcut router and
  // status bar reflect the operated-on task immediately — CurrentTaskStore is
  // the single source of truth for all surfaces (tree, status bar, task
  // actions). This write mirrors the same write in startNewTask and
  // resumeTask, completing the "single persisted source of truth" contract.
  await currentTaskStore.set(task.canonicalId);

  // Auto-trigger review after stage is persisted, if eligible.
  // Use taskFolderPath so normalizeReviewArg in reviewActions can construct a
  // synthetic IncompleteTask for resolveTask to re-read fresh progress from
  // disk. Passing only canonicalId would fall through to the QuickPick
  // because normalizeReviewArg cannot construct a folderUri from a canonicalId.
  if (transitionResult.shouldAutoReview) {
    // Run-time model guard: entering a review stage with no configured
    // model (or a disabled provider) alerts and opens AI Models instead of
    // silently kicking off a run that would fail.
    if (!(await ensureStageModelConfigured(taskFolderUri, newStage))) {
      return;
    }
    // Never dispatched inline: every auto-review chain flows through the
    // single guarded dispatcher. setTaskStage holds no operation lock here,
    // so the dispatch is immediate — but the shared "auto-review" chainId
    // drops this chain when another review chain (e.g. one scheduled by a
    // racing auto-advance) is already pending or running for this task.
    await scheduleAutomationChain({
      command: "vs-code-ai-helper.runReviewWithAI",
      arg: { taskFolderPath: task.taskFolderPath },
      taskKey: task.taskFolderPath,
      chainId: "auto-review",
      intent: {
        trigger: "review after moving into a review-eligible stage",
        // Structural, not gated by a single toggle setting — driven by the
        // stage-transition kind itself (AUTO_REVIEW_ELIGIBLE_KINDS).
        settingKey: undefined,
        expectedTiming: "immediately — this stage transition dispatches it now",
        willRetry: false,
        retryNote: "Not retried automatically if dropped — run the review manually.",
      },
    });
  }
}

/**
 * Reopen a completed task instead of advancing it. Shared with the Resume
 * command via `reopenCompletedTask` so marker capture, stale validation, and
 * field invalidation cannot drift between entry points.
 *
 * `requestedStage` is set when this was invoked from a specific stage-row
 * button (`setStageAsCurrent`) rather than the task-row picker
 * (`setTaskStage`) — that path skips the picker but still gets the full
 * reopen transition, marker capture, and stale validation.
 *
 * Deliberately does not filter the current stage out of the picker (unlike
 * the non-completed path above) and does not run the publish auto-lint: the
 * reopen mutation already cleared `lintPayload`, so lint state is "unknown"
 * and the existing commit/push gating handles re-running it.
 */
async function setTaskStageOnCompletedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  task: ResolvedTaskContext,
  requestedStage: TaskStage | undefined
): Promise<void> {
  const capturedCompletedAt = task.progress.completedAt;
  const chosenStage = requestedStage ?? (await pickReopenStage(task.folderName));
  if (!chosenStage) {
    return;
  }

  // Same "abort first" contract as the non-completed path above: a
  // completed task should have nothing running against it, but a race (e.g.
  // an in-flight operation that was still finishing when the task got
  // marked complete) could leave one live. Reopening must not let that
  // process keep running underneath the newly-reopened stage.
  const cancelResult = await cancelRunningOperationsForTask(task.taskFolderPath);
  if (!cancelResult.ok) {
    NotificationRouter.showError(
      `Could not reopen ${task.folderName}: ${cancelResult.reason}`
    );
    return;
  }

  const result = await reopenCompletedTask(
    inventory,
    currentTaskStore,
    task,
    chosenStage,
    capturedCompletedAt
  );

  if (result.outcome === "stale") {
    NotificationRouter.showWarning(result.message!);
    return;
  }
  if (result.outcome === "failed") {
    NotificationRouter.showError(result.message ?? "Could not reopen the task.");
    return;
  }

  await inventory.refresh();
  NotificationRouter.showInformation(
    `${task.folderName} reopened at ${STAGE_DISPLAY_NAMES[chosenStage]}.`
  );
}

/**
 * Register the setTaskStage command(s).
 *
 * Two command IDs share the same underlying handler: `setTaskStage` (task-row
 * button, opens a quick-pick over all stages) and `setStageAsCurrent`
 * (stage-row button, marks that specific stage current with no picker). They
 * are split into distinct command IDs purely so each can carry its own icon
 * in package.json — sharing one command made both buttons render identically
 * and indistinguishably from "Move on to Next Stage".
 */
export function registerSetTaskStageCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  // When called from either tree view button, no auto-review — the user is
  // manually navigating stages.
  const handler = (node?: SetTaskStageArg): Promise<void> =>
    setTaskStage(inventory, currentTaskStore, node, "jump");

  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setTaskStage",
    handler
  );
  const stageDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setStageAsCurrent",
    handler
  );

  context.subscriptions.push(disposable, stageDisposable);
}
