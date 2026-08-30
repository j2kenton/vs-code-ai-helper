import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { clearEscalation } from "../utils/taskProgressTransforms";
import { IncompleteTask } from "../types/incompleteTask";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { ESCALATION_DECISION_KEYS_V1 } from "../utils/reviewEscalation";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";

import { NotificationRouter } from "../utils/notificationRouter";
import { activateTask } from "../state/taskActivationCoordinator";
import { pickReopenStage, reopenCompletedTask } from "../utils/reopenTask";
import { runTrackedOperation } from "../utils/taskOperations";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

/**
 * Accepted argument shapes for resumeTask.
 *
 * Commands may be invoked from:
 *   - Tree task-row buttons: the tree TaskNode itself, which has
 *     `.task: IncompleteTask` (TaskNode shape)
 *   - Keyboard shortcut router / command-palette: `{ canonicalId?, taskFolderPath? }`
 *   - Command palette (no arg): undefined
 */
type ResumeTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a ResumeTaskArg into the shape resolveTaskContext expects.
 *
 * Handles the tree-row TaskNode shape (`{ task: IncompleteTask }`) by
 * extracting the folder path, so task-row invocations from the Tasks view
 * resolve correctly instead of falling through to the persisted current task.
 *
 * @internal exported for testing
 */
export function normalizeResumeTaskArg(
  arg: ResumeTaskArg | undefined
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  // Tree task-row shape: TaskNode passes { task: IncompleteTask }
  if ("task" in arg && arg.task) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  // Explicit canonical-id / folder-path shape
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(a.canonicalId || a.taskFolderPath);
  return hasExplicit
    ? { canonicalId: a.canonicalId, taskFolderPath: a.taskFolderPath }
    : undefined;
}

/**
 * Return whether the raw arg represents an explicit task identifier.
 *
 * Used to distinguish "caller named a specific task that could not be found"
 * (should error) from "caller did not supply a task" (should show fallback
 * message or use persisted current task).
 *
 * @internal exported for testing
 */
export function resumeTaskArgHasExplicitTask(
  arg: ResumeTaskArg | undefined
): boolean {
  if (!arg) {
    return false;
  }
  if ("task" in arg) {
    return !!arg.task;
  }
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  return !!(a.canonicalId || a.taskFolderPath);
}

/**
 * Resume a paused task (set status back to "active") and persist it as the
 * current task in CurrentTaskStore so the keyboard shortcut and status bar
 * immediately reflect the resumed task.
 *
 * Uses patchTaskProgress to preserve unrelated fields (e.g. implReviewFiles,
 * scheduled metadata, lint results) when writing the updated status.
 */
export async function resumePausedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ResumeTaskArg
): Promise<void> {
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read, so it cannot race the read-only
  // creating-folder reconciliation extension.ts kicks off during activate()
  // — see TaskCreationStartupReconcilerV1's doc comment and startNewTask.ts's
  // identical use of waitUntilReady().
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const hasExplicitTask = resumeTaskArgHasExplicitTask(explicitArg);
  const resolverArg = normalizeResumeTaskArg(explicitArg);
  const resolvedTask = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
    currentTaskStore
  );

  if (!resolvedTask) {
    // If the caller named a specific task (tree-row click, canonical ID, or
    // folder path) but resolution failed, the task no longer exists or is not
    // discoverable. Silently redirecting to a different task would be wrong.
    if (hasExplicitTask) {
      NotificationRouter.showError(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
      return;
    }
    NotificationRouter.showInformation("No paused tasks to resume.");
    return;
  }

  if (resolvedTask.progress.status === "completed") {
    return resumeCompletedTask(inventory, currentTaskStore, resolvedTask);
  }

  if (resolvedTask.progress.status !== "paused") {
    NotificationRouter.showInformation(`Task is not paused.`);
    return;
  }

  // Tracked instant mutation (taxonomy: resume-task / terminal-always). The
  // terminal entry is recorded centrally by the operation-notification bridge.
  // activateTask also persists the resumed task as the current task so the
  // keyboard shortcut router and status bar reflect it immediately —
  // CurrentTaskStore is the single source of truth for all surfaces.
  try {
    await runTrackedOperation(
      resolvedTask.taskFolderPath,
      { label: "Resume Task", taskName: resolvedTask.progress.displayName ?? resolvedTask.folderName, kind: "resume-task" },
      async () => {
        const activated = await activateTask(
          inventory, currentTaskStore, resolvedTask.taskFolderPath, resolvedTask.canonicalId
        );
        if (!activated) {
          throw new Error("Could not read task progress.");
        }
        // Resuming a task IS the human's "how would you like to proceed"
        // answer to a stuck-review escalation — clear it as a small,
        // additive follow-up write rather than threading it into
        // activateTask's own checkpoint/rollback machinery. A stale
        // escalation left behind here would otherwise linger in the task
        // tree and (once the task plateaus again) skew
        // secondOpinionTriedThisPlateau against a fresh attempt.
        // preserveFreshness: resuming is selection, not progress — it must
        // not hoist the task in the recency-ordered task list.
        await patchTaskProgressStrictV1(
          vscode.Uri.file(resolvedTask.taskFolderPath),
          (current) => clearEscalation(current, { preserveFreshness: true })
        );
        // Part 11 item 13c (event-driven half, "stage advance/resume
        // invalidates escalation cards"): every escalation card exists to
        // hold this exact pause open pending a decision — the clear above
        // just ended that, through whatever route the user actually took
        // (not necessarily the card's own "keep iterating"/"handle myself"
        // options), so any escalation card still pending for this task now
        // describes a pause that no longer holds. Withdraw all of them
        // rather than leaving `hasPendingDecision` true until the chat
        // panel's render-time safety net next runs (none is currently
        // registered for escalation keys there, so this is the only path).
        for (const decisionKey of ESCALATION_DECISION_KEYS_V1) {
          await withdrawWorkflowDecisionsByKeyV1(
            { taskFolderPath: resolvedTask.taskFolderPath, canonicalId: resolvedTask.canonicalId },
            decisionKey,
            "the task was resumed, ending the pause this escalation was holding"
          );
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showError(message);
  }
}

/**
 * Resume a completed task by reopening it at a chosen stage (Publish
 * preselected). Shows the picker BEFORE any state changes — cancelling
 * leaves the task fully completed and pauses nothing. The lifecycle marker
 * (`completedAt`) is captured here, before the picker is shown, so the
 * in-write validation inside `reopenCompletedTask` can detect the task being
 * resumed or re-completed by another window while the picker was open.
 */
async function resumeCompletedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  resolvedTask: ResolvedTaskContext
): Promise<void> {
  const capturedCompletedAt = resolvedTask.progress.completedAt;
  const chosenStage = await pickReopenStage(resolvedTask.folderName);
  if (!chosenStage) {
    return;
  }

  // Tracked instant mutation (taxonomy: resume-task). The picker stays outside
  // the operation — no lock or spinner while the user is still deciding. A
  // stale or failed reopen throws so the operation ends in the `failed`
  // terminal state instead of recording a bogus "completed" entry.
  let result: Awaited<ReturnType<typeof reopenCompletedTask>> | undefined;
  try {
    await runTrackedOperation(
      resolvedTask.taskFolderPath,
      { label: "Resume Task", taskName: resolvedTask.progress.displayName ?? resolvedTask.folderName, kind: "resume-task" },
      async (op) => {
        result = await reopenCompletedTask(
          inventory,
          currentTaskStore,
          resolvedTask,
          chosenStage,
          capturedCompletedAt
        );
        if (result.outcome !== "reopened") {
          throw new Error(result.message ?? "Could not reopen the task.");
        }
        op.report(`reopened at ${STAGE_DISPLAY_NAMES[chosenStage]}`);
      }
    );
  } catch {
    if (result?.outcome === "stale") {
      NotificationRouter.showWarning(result.message!);
    } else {
      NotificationRouter.showError(result?.message ?? "Could not reopen the task.");
    }
    return;
  }

  // A busy refusal resolves without throwing but never runs the reopen.
  if (result?.outcome !== "reopened") {
    return;
  }

  // The tracked resume operation has already produced the sole terminal
  // success entry through operationNotificationBridge.
}

/**
 * Resume a paused task and immediately re-dispatch its stage review — the
 * `WorkflowDecisionOptionEffectV1` shape only carries one command, and
 * `runReviewWithAI` itself refuses on a paused task (`reviewActions.ts`'s
 * `runReviewWithAI`: "This task is paused. Resume it before running a
 * review."), so a single-command "keep iterating" option cannot resume AND
 * rerun without a small combined command like this one. Internal-only
 * (registered here, not exposed in `package.json` contributions) — its sole
 * caller is `reviewEscalation.ts`'s `postReviewPlateauDecisionV1`, item 7b:
 * a prior revision of that decision dispatched plain `resumeTask` while
 * telling the user it "reruns" the stage, which it never did.
 *
 * `resumePausedTask` handles (and reports) its own failure modes via
 * `NotificationRouter`; this only proceeds to the review dispatch when the
 * task actually reached "active", so a failed/declined resume does not also
 * throw a confusing "task is paused" review-side message on top of whatever
 * resumePausedTask already told the user.
 */
export async function resumeAndRerunReviewV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ResumeTaskArg
): Promise<void> {
  // Resolved BEFORE the resume, from the same (possibly-cached) `inventory`
  // resumePausedTask itself resolves against — this is the target folder,
  // not a status check, so cache staleness here is irrelevant.
  const resolverArg = normalizeResumeTaskArg(explicitArg);
  const target = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
    currentTaskStore
  );
  if (!target) {
    return;
  }
  await resumePausedTask(inventory, currentTaskStore, explicitArg);
  // Re-read `task-progress.json` straight off disk rather than asking
  // `inventory`/`resolveTaskContext` again: `inventory` is an in-memory cache
  // that is not guaranteed to reflect the write `resumePausedTask` (via
  // `activateTask`) just made, and reading it a second time risks seeing the
  // pre-resume "paused" snapshot and silently skipping the review dispatch.
  const reread = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
  if (!reread.ok || reread.decoded.progress.status === "paused") {
    return;
  }
  await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", {
    taskFolderPath: target.taskFolderPath,
  });
}

/**
 * Resume a paused task and immediately re-dispatch Implementation — the
 * `WorkflowDecisionOptionEffectV1` shape only carries one command, so a
 * single-command "keep iterating" option on an implementation-side plateau
 * (continuation-budget-exhausted, or the no-progress breaker — see
 * `reviewEscalation.ts`'s `buildEscalationDecisionV1`) cannot resume AND
 * dispatch without a small combined command like this one, mirroring
 * `resumeAndRerunReviewV1` above for the review-stage case.
 *
 * Deliberately dispatches `runImplementationWithAI` rather than a specific
 * "continuation" vs "fresh implementation" command: that routing decision
 * (owed continuation vs Apply Review vs Implementation) already lives inside
 * `runImplementationWithAI` itself (`chooseAutomaticImplementationDispatchV1`
 * / the manual pre-run decision), so resuming and calling it once is
 * sufficient to reach whichever action the escalation's reason actually
 * names — a second copy of that routing logic here would drift from it.
 *
 * `resumePausedTask` handles (and reports) its own failure modes via
 * `NotificationRouter`; this only proceeds to the implementation dispatch
 * when the task actually reached "active", so a failed/declined resume does
 * not also throw a confusing "task is paused" message on top of whatever
 * resumePausedTask already told the user.
 */
export async function resumeAndDispatchImplementationV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ResumeTaskArg
): Promise<void> {
  const resolverArg = normalizeResumeTaskArg(explicitArg);
  const target = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
    currentTaskStore
  );
  if (!target) {
    return;
  }
  await resumePausedTask(inventory, currentTaskStore, explicitArg);
  // Re-read straight off disk for the same reason resumeAndRerunReviewV1
  // does: `inventory` is an in-memory cache not guaranteed to reflect the
  // write resumePausedTask (via activateTask) just made.
  const reread = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
  if (!reread.ok || reread.decoded.progress.status === "paused") {
    return;
  }
  await vscode.commands.executeCommand("vs-code-ai-helper.runImplementationWithAI", {
    taskFolderPath: target.taskFolderPath,
  });
}

/**
 * Resume a paused task and immediately set its stage — the
 * `WorkflowDecisionOptionEffectV1` shape only carries one command, so the
 * escalation cards' "Advance to <stage>" option (`reviewEscalation.ts`'s
 * `buildAdvanceOptionV1`) cannot resume AND advance without a small combined
 * command like this one, mirroring `resumeAndRerunReviewV1` /
 * `resumeAndDispatchImplementationV1` above.
 *
 * Review blocker (2026-08-30): every escalation pauses the task as part of
 * raising it, and the plain `setTaskStage` command resolves with
 * `{ allowPaused: false }` — so an Advance option that invoked it directly
 * always failed with "The task could not be found", a confusing error for a
 * task that plainly exists and is simply paused. Choosing "Advance" from an
 * escalation card is an unambiguous statement that the user wants to move
 * past the pause, so — per the same "do the whole thing" resolution already
 * used for "Keep iterating" — this resumes first.
 *
 * `resumePausedTask` handles (and reports) its own failure modes via
 * `NotificationRouter`; this only proceeds to the stage change when the task
 * actually reached "active", so a failed/declined resume does not also throw
 * a confusing "task is paused" message on top of whatever `resumePausedTask`
 * already told the user.
 */
export async function resumeAndSetTaskStageV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg: (ResumeTaskArg & { stage?: TaskStage }) | undefined
): Promise<void> {
  const resolverArg = normalizeResumeTaskArg(explicitArg);
  const target = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
    currentTaskStore
  );
  if (!target || !explicitArg?.stage) {
    return;
  }
  const stage = explicitArg.stage;
  await resumePausedTask(inventory, currentTaskStore, explicitArg);
  // Re-read straight off disk for the same reason resumeAndRerunReviewV1
  // does: `inventory` is an in-memory cache not guaranteed to reflect the
  // write resumePausedTask (via activateTask) just made.
  const reread = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
  if (!reread.ok || reread.decoded.progress.status === "paused") {
    return;
  }
  await vscode.commands.executeCommand("vs-code-ai-helper.setTaskStage", {
    taskFolderPath: target.taskFolderPath,
    stage,
  });
}

/**
 * Register the resumeTask command
 */
export function registerResumeTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeTask",
    (arg?: ResumeTaskArg) =>
      resumePausedTask(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(disposable);

  const resumeAndRerunReview = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeAndRerunReview",
    (arg?: ResumeTaskArg) =>
      resumeAndRerunReviewV1(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(resumeAndRerunReview);

  const resumeAndDispatchImplementation = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeAndDispatchImplementation",
    (arg?: ResumeTaskArg) =>
      resumeAndDispatchImplementationV1(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(resumeAndDispatchImplementation);

  const resumeAndSetTaskStage = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeAndSetTaskStage",
    (arg?: ResumeTaskArg & { stage?: TaskStage }) =>
      resumeAndSetTaskStageV1(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(resumeAndSetTaskStage);
}
