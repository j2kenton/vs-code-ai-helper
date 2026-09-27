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
import {
  AUTO_REVIEW_ELIGIBLE_KINDS,
  enterStageV1,
  runStageEntryPostCommitV1,
  TransitionKind,
} from "../utils/stageTransition";
import { NotificationRouter } from "../utils/notificationRouter";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { ensureStageModelConfigured } from "../utils/modelSelection";
import { scheduleAutomationChain } from "../utils/automationChain";
import {
  cancelRunningOperationsForTask,
  CancelRunningOperationsResultV1,
} from "../utils/taskOperations";
import { pickReopenStage, reopenCompletedTask } from "../utils/reopenTask";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { ESCALATION_DECISION_KEYS_V1 } from "../utils/reviewEscalation";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { LifecycleStageMismatchError } from "../actions/rows/lifecyclePolicyRejection";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

/**
 * Accepted argument shapes for setTaskStage.
 * - Tree-view stage node passes { task: IncompleteTask, stage: TaskStage }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath?, stage?,
 *   expectedSourceStage? }
 */
type SetTaskStageArg =
  | { task?: IncompleteTask; stage?: TaskStage }
  | {
      canonicalId?: string;
      taskFolderPath?: string;
      stage?: TaskStage;
      /**
       * Review fix (2026-09-23, narrowed completion blocker
       * c2453680-fe42-461b-9652-1f87445cb9d3-0): the stage a caller (e.g. an
       * "Advance to <stage>" decision card, via `resumeAndSetTaskStageV1`)
       * observed when it decided this transition was legitimate. When set,
       * it — not whatever stage this command happens to freshly read off
       * disk before its own lock is acquired — is the CAS `sourceStage` fed
       * to `enterStageV1`/`advanceStage`, so a card that has since outlived
       * a further, independent stage change (one this command's own
       * pre-lock read would otherwise silently treat as "the" source) is
       * refused atomically, inside the same lock hold as the write, instead
       * of racing a non-atomic pre-check performed by the caller. See the
       * `enterStageV1` call site below and `resumeAndSetTaskStageV1`
       * (`resumeTask.ts`), its only production source today.
       */
      expectedSourceStage?: TaskStage;
      /**
       * Review fix (2026-09-23, new completion blocker on this round's own
       * `cancelResult` gating: "the second cancellation check forgets the
       * unsafe result"). `resumeAndSetTaskStageV1` used to learn whether the
       * outgoing stage's operation was actually stopped by calling
       * `cancelRunningOperationsForTask` a SECOND time, after this command's
       * own call (below) had already made it. That second call is blind to a
       * forced end: `forceEndSubtreeV1` removes the operation row the moment
       * it fires, so by the time the caller's own call ran, the registry was
       * already empty and it read that as `{ ok: true }` — silently losing
       * the "the work may still be running underneath" signal the FIRST call
       * (this one) had already observed. Rather than reconstructing that
       * signal from a second, now-empty read, the caller supplies this box
       * and this command deposits its own, single, authoritative
       * `cancelResult` into it — see the `cancelRunningOperationsForTask`
       * call site below.
       */
      cancelResultOutV1?: { current?: CancelRunningOperationsResultV1 };
    };

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
  expectedSourceStage: TaskStage | undefined;
  cancelResultOutV1: { current?: CancelRunningOperationsResultV1 } | undefined;
} {
  if (!node) {
    return {
      resolverArg: undefined,
      stage: undefined,
      hasExplicitTask: false,
      expectedSourceStage: undefined,
      cancelResultOutV1: undefined,
    };
  }

  if ("task" in node && node.task) {
    return {
      resolverArg: { taskFolderPath: node.task.folderUri.fsPath },
      stage: node.stage,
      hasExplicitTask: true,
      expectedSourceStage: undefined,
      cancelResultOutV1: undefined,
    };
  }

  const n = node as {
    canonicalId?: string;
    taskFolderPath?: string;
    stage?: TaskStage;
    expectedSourceStage?: TaskStage;
    cancelResultOutV1?: { current?: CancelRunningOperationsResultV1 };
  };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return {
    resolverArg: hasExplicit
      ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
      : undefined,
    stage: n.stage,
    hasExplicitTask: hasExplicit,
    expectedSourceStage: n.expectedSourceStage,
    cancelResultOutV1: n.cancelResultOutV1,
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
 *
 * @returns whether THIS call actually performed a stage transition — `false`
 *   for every early return, including "the task is already on the requested
 *   stage" (review finding, narrowed blocker c2453680-fe42-461b-9652-1f87445cb9d3-0):
 *   a caller that re-reads progress afterwards cannot otherwise tell "I moved
 *   it" apart from "something else (e.g. an automatic advance) already had",
 *   and conflating the two is exactly what let `resumeAndSetTaskStageV1`
 *   dispatch a destination stage's action a second time after auto-advance
 *   had already gotten there first.
 */
export async function setTaskStage(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  node?: SetTaskStageArg,
  kind: TransitionKind = "jump"
): Promise<boolean> {
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
    return false;
  }

  const { resolverArg, stage: requestedStage, hasExplicitTask, expectedSourceStage, cancelResultOutV1 } =
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
      return false;
    }

    // No explicit task was supplied (e.g. command-palette invocation with no
    // active task). Fall back to a quick pick over all known tasks.
    const allTasks = inventory.getTasks();
    if (allTasks.length === 0) {
      NotificationRouter.showInformation(
        "No task folders found. Use 'Start New Task' to create one."
      );
      return false;
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
      return false;
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
        expectedSourceStage,
        cancelResultOutV1,
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
      return false;
    }
    newStage = selectedStageItem.stage;
  }

  if (newStage === task.progress.currentStage) {
    // Not a transition performed by this call — the task was already on the
    // requested stage (e.g. an automatic advance got there first). See this
    // function's `@returns` doc: the caller MUST treat this the same as a
    // refusal (nothing further to dispatch here), not as a successful move.
    return false;
  }

  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);

  // Persist the destination stage through the shared stage-entry primitive
  // (pre-1.0.0 fixes register, Part 1, item 15): this resolves whatever the
  // destination stage needs before the task may land on it (e.g. promoting
  // plan.md -> plan-final.md for "impl") atomically with the CAS/persist
  // step `advanceStage` already performed here, instead of relying on the
  // caller to already have an artifact in place. `enterStageV1` never
  // throws — a refused entry (lost CAS, unmet entry requirement, or a
  // read/write failure) comes back as `{ ready: false, reason }`.
  // Review fix (2026-09-23, narrowed completion blocker
  // c2453680-fe42-461b-9652-1f87445cb9d3-0): when a caller supplied
  // `expectedSourceStage` (an "Advance to <stage>" card, via
  // `resumeAndSetTaskStageV1`), THAT is the CAS `sourceStage` fed to
  // `enterStageV1` — not `task.progress.currentStage`, which was only ever a
  // pre-lock read taken moments ago by `resolveTaskContext`, above. A prior
  // round's fix compared `expectedSourceStage` against a similarly non-atomic
  // pre-read performed by the CALLER before this command even ran, leaving a
  // window between that pre-read and this command's own pre-read in which an
  // independent transition could carry the task to a third stage neither
  // read observed — a stale click would then have this command re-read that
  // third stage and pass it straight through as `sourceStage`, so the CAS
  // inside `advanceStage`'s lock hold would trivially "match itself" and the
  // stale click would move the task backward to the card's destination.
  // Using `expectedSourceStage` here instead makes the enforcement atomic:
  // the ONLY read that matters is the one `advanceStageLocked` performs
  // under its own lock (`stageTransition.ts:352`), compared against the
  // stage the card actually knows about.
  //
  // Review fix (2026-09-23, closing the remaining half of completion blocker
  // c2453680-fe42-461b-9652-1f87445cb9d3-0): this CAS-protected write now
  // runs BEFORE `cancelRunningOperationsForTask`, not after it. The previous
  // shape did a "fresh" read, then cancelled, then attempted this write —
  // three separate steps sharing no lock, so an independent transition could
  // still land in the gap between the read and the (async, round-tripping)
  // cancel call, and the fresh read's own failure fell through to cancelling
  // unconditionally regardless. Reordering removes the gap structurally
  // instead of narrowing it again: cancellation (below) no longer depends on
  // any read at all — it runs only once THIS atomic, lock-protected CAS has
  // already confirmed the transition is real, so a stale command whose own
  // write the CAS goes on to refuse can never reach the cancel call in the
  // first place.
  //
  // Review fix (2026-09-23, narrowed completion blocker
  // 906d1f21-e807-48d3-9468-62856cdc7e7a-0, revised after a follow-up review
  // found the first attempt architecturally unsafe): a still-earlier version
  // of this comment requested the outgoing stage's cancellation from INSIDE
  // `enterStageV1`'s locked `beforeWrite`, strictly before the new stage's
  // bytes were written, to close the window between "bytes committed" and
  // "outgoing operation asked to stop". That is exactly backwards: `patched`
  // is validated by the time `beforeWrite` runs, but the write itself
  // (`writeAtomic`, inside `patchTaskProgressStrictV1`) can still fail after
  // `beforeWrite` returns — a full disk, an I/O error — in which case the
  // stage never actually changes, yet the cancellation (irreversible: it may
  // stop or, on a stale token, force-end genuinely unrelated running work)
  // would already have fired for a transition that never happened. There is
  // no way to roll a fired cancellation token back. So cancellation is
  // deliberately NOT threaded through `additionalBeforeWrite` here: it is
  // requested only below, via the full request-and-confirm
  // `cancelRunningOperationsForTask` call, which runs immediately after
  // `entryResult.ready` is true — i.e., only once the write has durably
  // landed. This keeps the one window that remains ("requested but not yet
  // confirmed stopped, immediately after the new stage becomes visible") the
  // same shape it already was before the pre-write attempt, without ever
  // triggering an irreversible side effect for a write that did not commit.
  // Fully closing that remaining window needs the Part 6 stale-writer fence
  // (not yet built) to reject a stale write outright rather than merely ask
  // the writer to stop first.
  const entryResult = await enterStageV1(
    taskFolderUri,
    expectedSourceStage ?? task.progress.currentStage,
    newStage,
    false,
    kind,
    {
      optIn: AUTO_REVIEW_ELIGIBLE_KINDS.has(kind),
    }
  );

  if (!entryResult.ready) {
    // Preserve the pre-reroute distinction between "the transition was
    // refused for a reason" (warning) and "the progress file itself could
    // not be read or written" (error) — the latter is the one refusal
    // `enterStageV1` reports with this exact, non-caller-specific reason.
    if (entryResult.reason === "could not read or update task progress") {
      NotificationRouter.showError(
        `Could not read or update task progress for ${task.folderName}.`
      );
      return false;
    }
    // A CAS mismatch is ambiguous by itself: the task may have already
    // reached `newStage` legitimately (an independent auto-advance beat this
    // call — the ordinary, benign race the `movedByThisCall` fix already
    // handles once a transition DOES land) or it may genuinely have moved to
    // some third stage this call knew nothing about. Neither possibility can
    // change what was written — the CAS already refused any write — so this
    // re-read only decides which message to show; it cannot reintroduce a
    // race, and it no longer gates any destructive side effect either, now
    // that cancellation (below) runs strictly after this check rather than
    // before it.
    // Review fix (2026-09-23): this disambiguation used to run only when the
    // caller supplied `expectedSourceStage` (the Advance-card path); it now
    // applies to every CAS mismatch, including a plain manual "Set Task
    // Stage" invocation, since the underlying ambiguity — "already there" vs.
    // "moved to a third stage" — is identical either way.
    if (entryResult.cause instanceof LifecycleStageMismatchError) {
      const rereadAfterMismatch = await readTaskProgressStrictV1(taskFolderUri);
      if (rereadAfterMismatch.ok && rereadAfterMismatch.decoded.progress.currentStage === newStage) {
        // Already there via an independent transition — same as the
        // pre-lock "already at destination" shortcut above: nothing further
        // to arrange, and no warning to show.
        return false;
      }
      const actualStage = rereadAfterMismatch.ok
        ? rereadAfterMismatch.decoded.progress.currentStage
        : undefined;
      NotificationRouter.showWarning(
        actualStage !== undefined
          ? `"Set stage to ${STAGE_DISPLAY_NAMES[newStage]}" no longer applies — ${task.folderName} has since moved on ` +
              `to ${STAGE_DISPLAY_NAMES[actualStage]}. No stage change was made.`
          : `Could not set stage for ${task.folderName}: ${entryResult.reason}`
      );
      return false;
    }
    NotificationRouter.showWarning(
      `Could not set stage for ${task.folderName}: ${entryResult.reason}`
    );
    return false;
  }

  // "Set Task Stage" / "Set as Current Stage" must abort whatever the task's
  // PREVIOUS stage was still running — otherwise that process keeps running
  // in the background (writing into a stage the user just navigated away
  // from), and this handler runs no AI automation of its own for the
  // destination stage (kind="jump" is excluded from both
  // AUTO_REVIEW_ELIGIBLE_KINDS and, unconditionally, publish scheduling —
  // see stageTransition.ts), so there is nothing to "hand off" to here; the
  // goal is purely to stop. This REQUEST-and-CONFIRM call is the first and
  // only place cancellation is requested for this transition (see the
  // comment above the `enterStageV1` call for why an earlier attempt to
  // request it from inside the locked write was reverted as architecturally
  // unsafe): it runs AFTER `enterStageV1` has already confirmed the write
  // landed, so a cancellation this irreversible is never fired for a
  // transition that did not actually happen. Waiting (up to 15s) for
  // confirmed termination is not something that can safely run inside the
  // locked commit either way (it would stall every other writer queued on
  // this task for that whole window, and a caller that is itself a
  // registered root operation would deadlock waiting on its own removal), so
  // it belongs here regardless. A cancellation-confirmation failure here
  // cannot mean "the transition didn't happen" — it did — so it is reported
  // on its own terms rather than folded into the transition's own
  // success/failure signal; this function's `@returns` doc answers ONLY "did
  // this call move the stage".
  // Review fix (2026-09-23, narrowed completion blocker
  // 906d1f21-e807-48d3-9468-62856cdc7e7a-0): narrowed, not closed — the
  // outgoing operation may still be executing code between its last
  // checkpoint and its next one when this call requests cancellation, so it
  // can still land a write after the new stage becomes visible. Fully
  // preventing that needs the stale-writer fence (pre-1.0.0 fixes register
  // Part 6, not yet built). This call site controls one concrete, avoidable
  // consequence of the remaining window: dispatching brand-NEW automated work
  // for the destination stage while the outgoing operation might still be
  // finishing up. `cancelResult.ok` (below) is what gates that — see the
  // `shouldAutoReview` check further down, which now requires
  // `cancelResult.ok` in addition to the model-configured guard it already
  // had, following that same "commit stands, follow-up dispatch skipped"
  // idiom this function already used for the model-guard case.
  const cancelResult = await cancelRunningOperationsForTask(task.taskFolderPath);
  if (cancelResultOutV1) {
    // Deposit the one, authoritative result — see the doc comment on
    // `cancelResultOutV1` above. A caller that needs to gate its OWN
    // follow-up dispatch (e.g. `resumeAndSetTaskStageV1`'s Advance path)
    // reads this instead of calling `cancelRunningOperationsForTask` again,
    // which would be blind to a forced end that already fired during THIS
    // call (the operation row is gone by the time a second call could see
    // it).
    cancelResultOutV1.current = cancelResult;
  }
  if (!cancelResult.ok) {
    NotificationRouter.showWarning(
      `${task.folderName} was set to stage ${STAGE_DISPLAY_NAMES[newStage]}, but a previously running operation ` +
        `for the prior stage could not be stopped: ${cancelResult.reason} No automatic follow-up was started for ` +
        `the new stage — stop the stale operation from its Notifications row (or wait for it to actually finish), ` +
        `then use the stage's own action to continue.`
    );
  }

  const transitionResult = entryResult.transition;
  // Post-commit work (e.g. a deferred plan-revision adoption write) must run
  // only once this call's own lock hold — none is held here — has released;
  // see runStageEntryPostCommitV1's doc comment. Safe to await inline.
  await runStageEntryPostCommitV1(taskFolderUri, entryResult);

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
    // Cancellation guard: never dispatch NEW automated work for the
    // destination stage while the outgoing stage's operation has not been
    // confirmed to have actually stopped (see the comment above the
    // `cancelRunningOperationsForTask` call). Same "commit stands, follow-up
    // dispatch skipped, still report `true`" shape as the model guard below.
    if (!cancelResult.ok) {
      return true;
    }
    // Run-time model guard: entering a review stage with no configured
    // model (or a disabled provider) alerts and opens AI Models instead of
    // silently kicking off a run that would fail.
    if (!(await ensureStageModelConfigured(taskFolderUri, newStage))) {
      // The stage transition itself already committed above — only the
      // auto-review dispatch is skipped — so this still reports `true`.
      return true;
    }
    // Never dispatched inline: every auto-review chain flows through the
    // single guarded dispatcher. setTaskStage holds no operation lock here,
    // so the dispatch is immediate — but the shared "auto-review" chainId
    // drops this chain when another review chain (e.g. one scheduled by a
    // racing auto-advance) is already pending or running for this task.
    await scheduleAutomationChain({
      command: "vs-code-ai-helper.runReviewWithAI",
      // No human on this path — see ReviewCommandArg.automationDispatch.
      // Without this, a task cycling back into a review stage it has
      // already visited (impl -> impl-high-review -> impl -> back here)
      // could hit the unchanged-tree guard's modal with nobody attached to
      // answer it, hanging this chain (A1, 2026-09-04 review follow-up).
      arg: { taskFolderPath: task.taskFolderPath, automationDispatch: true },
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

  return true;
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
): Promise<boolean> {
  const capturedCompletedAt = task.progress.completedAt;
  const chosenStage = requestedStage ?? (await pickReopenStage(task.folderName));
  if (!chosenStage) {
    return false;
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
    return false;
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
    return false;
  }
  if (result.outcome === "failed") {
    NotificationRouter.showError(result.message ?? "Could not reopen the task.");
    return false;
  }

  await inventory.refresh();
  NotificationRouter.showInformation(
    `${task.folderName} reopened at ${STAGE_DISPLAY_NAMES[chosenStage]}.`
  );
  return true;
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
  const handler = (node?: SetTaskStageArg): Promise<boolean> =>
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
