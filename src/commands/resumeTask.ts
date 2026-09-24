import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import { clearEscalation, pauseTaskWithReason, setNextActorV1 } from "../utils/taskProgressTransforms";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IncompleteTask } from "../types/incompleteTask";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { ESCALATION_DECISION_KEYS_V1 } from "../utils/reviewEscalation";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import {
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  describeWorkAdmissionRefusalV1,
  revokeWorkAdmissionHandoffV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
} from "../state/workAdmissionV1";

import { NotificationRouter } from "../utils/notificationRouter";
import { activateTask } from "../state/taskActivationCoordinator";
import { pickReopenStage, reopenCompletedTask } from "../utils/reopenTask";
import { CancelRunningOperationsResultV1, runTrackedOperation } from "../utils/taskOperations";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { goToReviewAndApplyV1 } from "./goToReviewAndApplyV1";
import { loadResumeActionPlanV1, preflightFixedDispatchV1 } from "../utils/resumeActionPlanV1";

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
 * Discriminated outcome of {@link resumePausedTask}, replacing the previous
 * bare `(() => Promise<void>) | undefined` return (2026-09-08 review
 * completion blocker, narrowed form): that shape let `resumeThenDispatchV1`
 * treat "this call found the task already active, so there was nothing to
 * resume" and "this call found the task genuinely paused, but a CONCURRENT
 * resume won the admission race first" identically — both surfaced as
 * `undefined`. Only the first case is safe to fall back to a fresh
 * admission-and-dispatch: the task was never mid-resume by anyone. The
 * second case means another invocation is (or very recently was) the one
 * actually handling this resume-and-dispatch event; if its own dispatch has
 * since settled and released, a `busy`-refused caller must NOT then acquire
 * its own admission and fire a second, possibly different, dispatch for the
 * same event — that is a duplicate action, not a fallback for unprotected
 * work.
 *
 * - `"resumed"` — this call itself flipped the task to `active` (per
 *   `release`, admission may already be released, or retained for the
 *   caller when `holdAdmissionForCaller` was requested and the mutation
 *   succeeded).
 * - `"busy"` — the task was paused, but another owner already holds durable
 *   admission for it; this call made no changes at all.
 * - `"superseded"` — this call observed `paused` from the (possibly cached)
 *   `resolveTaskContext` snapshot and WON admission, and a fresh disk
 *   re-read taken immediately after acquiring admission SUCCEEDED but shows
 *   the task is no longer `paused` — a concurrent resume already completed
 *   and released before this call reached the admission directory
 *   (2026-09-08 review, narrowed completion blocker: the `"busy"` fix above
 *   only closes the case where the winner is STILL holding admission when
 *   this call arrives; it does nothing when the winner already finished and
 *   released). Admission acquired by this call is released immediately and
 *   no mutation is made — the task is already exactly where the concurrent
 *   winner left it, so writing `active`/`scheduledRun` again here would be a
 *   second, redundant (and potentially divergent) resume for the same event.
 *   Distinct from `"failed"`'s read-error case below: here the re-read
 *   succeeded and positively confirms a non-paused status, so treating it as
 *   "someone else already handled this" is actually established, not assumed.
 * - `"notPaused"` — the task exists and is not paused (already active, or
 *   some other non-paused status); this call made no changes at all.
 * - `"notFound"` — no resolvable task (deleted/moved, or no paused task and
 *   no explicit target); this call made no changes at all.
 * - `"completed"` — the task was completed; handled via the separate
 *   `resumeCompletedTask` reopen flow, not a plain resume.
 * - `"failed"` — admission was acquired but either (a) the mandatory
 *   post-admission disk re-read used to detect `"superseded"` itself failed
 *   — the file is missing, unreadable, or fails strict decode (2026-09-08
 *   review, new completion blocker: an earlier revision collapsed this into
 *   `"superseded"`, which silently misreported "this call could not confirm
 *   what happened" as "another invocation already handled it" and abandoned
 *   the resume with no explanation shown to the user) — or (b) the resume
 *   mutation itself threw (e.g. `activateTask` could not read progress).
 *   Admission is always released before this outcome is returned, regardless
 *   of `holdAdmissionForCaller`, since the resume did not actually succeed;
 *   the read-error case additionally surfaces the reader's own failure
 *   reason via `NotificationRouter.showError` before returning.
 *   `resumeThenDispatchV1` treats this identically to `"busy"`/`"superseded"`
 *   — it stops and never falls back to a fresh admission-and-dispatch
 *   (2026-09-08 review, second narrowing of the same completion blocker):
 *   since this outcome means the re-read that would have distinguished a
 *   genuine resume from a concurrent one could not be trusted, a fallback
 *   re-read could observe a status written by a *different* concurrent
 *   invocation and dispatch a duplicate action for its resume.
 */
export type ResumePausedTaskOutcomeV1 =
  | { readonly outcome: "resumed"; readonly release: (() => Promise<void>) | undefined }
  | { readonly outcome: "busy" }
  | { readonly outcome: "superseded" }
  | { readonly outcome: "notPaused" }
  | { readonly outcome: "notFound" }
  | { readonly outcome: "completed" }
  | { readonly outcome: "failed" };

/**
 * Resume a paused task (set status back to "active") and persist it as the
 * current task in CurrentTaskStore so the keyboard shortcut and status bar
 * immediately reflect the resumed task.
 *
 * Uses patchTaskProgress to preserve unrelated fields (e.g. implReviewFiles,
 * scheduled metadata, lint results) when writing the updated status.
 *
 * `options.arrangeStageDispatch` (default `false`) controls whether this
 * function itself durably arranges the current stage's action to run once
 * the task is active. It defaulted to `true` from v1 fixes item 1 ("resume
 * must arrange work, not just change a status") until 2026-09-17, when the
 * bare Resume button on a task still at `desc` re-ran Draft with AI on every
 * press — 28 provider runs nobody asked for. The product rule that decided
 * it: Resume means resume. It flips the status and nothing else; anything
 * that starts work is a separate, explicitly labelled action the user chose
 * (the `resumeAndXxxV1` helpers below, whose labels say what they dispatch).
 * Nothing infers what the user "must have wanted". The option stays only so
 * a caller can opt in deliberately; the bare `resumeTask` command never does.
 *
 * `options.holdAdmissionForCaller` (default `false`, review completion
 * blocker 2026-09-08): when `true`, this function does NOT release its own
 * durable admission marker in its `finally` — it returns the release function
 * instead, so a caller that is about to dispatch its OWN follow-up command
 * (the five `resumeAndXxxV1` helpers, via `resumeThenDispatchV1`) can keep
 * the task continuously protected across its post-resume re-read
 * (`readTaskProgressStrictV1`, a filesystem round trip) AND all the way
 * through that follow-up command's entire dispatch, releasing only once the
 * dispatch has fully settled. This closes the gap completely rather than
 * merely shrinking it: there is no longer any window where the task is
 * active with neither admission nor arranged work. Holding across the
 * dispatch does not risk a spurious `busy` refusal from a downstream command
 * that itself acquires admission (`runReviewWithAI`, `fastForwardReviewWithAI`)
 * PROVIDED `resumeThenDispatchV1` forwards it the single-use handoff token it
 * mints (`workAdmissionV1.ts`'s `authorizeWorkAdmissionHandoffV1`) — that
 * command's own admission call presents the token to
 * `acquireOrAdoptWorkAdmissionV1`, which adopts this same-process marker
 * instead of racing a fresh genesis against it, and the marker is only
 * actually unlinked once every holder has released
 * (`workAdmissionV1.ts`'s `localHolderCountsV1`). Without a matching token,
 * adoption does not happen — this is deliberate: it is what keeps an
 * unrelated, concurrent same-process command from ever joining this hold.
 * Downstream commands not themselves admission-wired (`applyCurrentStageAction`,
 * `setTaskStage`) never call that function at all, so holding through their
 * dispatch is unconditionally safe for them too. `runImplementationWithAI`
 * and `goToReviewAndApplyV1` are no longer in that category (2026-09-09
 * review completion blocker, narrowed): both now reach admission-wired
 * commands and require a forwarded handoff token from any caller that holds
 * admission across their dispatch — see each call site below.
 */
export async function resumePausedTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ResumeTaskArg,
  options?: { readonly arrangeStageDispatch?: boolean; readonly holdAdmissionForCaller?: boolean }
): Promise<ResumePausedTaskOutcomeV1> {
  const arrangeStageDispatch = options?.arrangeStageDispatch ?? false;
  const holdAdmissionForCaller = options?.holdAdmissionForCaller ?? false;
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
      return { outcome: "notFound" };
    }
    NotificationRouter.showInformation("No paused tasks to resume.");
    return { outcome: "notFound" };
  }

  if (resolvedTask.progress.status === "completed") {
    await resumeCompletedTask(inventory, currentTaskStore, resolvedTask);
    return { outcome: "completed" };
  }

  if (resolvedTask.progress.status !== "paused") {
    NotificationRouter.showInformation(`Task is not paused.`);
    return { outcome: "notPaused" };
  }

  // v1 fixes item 1 (Part 1a, step 5): acquire durable work admission for
  // this task BEFORE activateTask's status write reaches disk. That write
  // fires the progress-file watcher, which runs the stalled-task sweep —
  // this task's own headline defect, measured at 4 seconds: the sweep found
  // the freshly-activated task with no live operation, no owed continuation,
  // and nothing scheduled, and re-paused it immediately, and the pause
  // reason's own advice ("resume it") is what re-triggered it. Admission
  // held for the whole of this mutation is the exemption
  // `isImpossibleActiveStateV1` already checks
  // (`hasLiveWorkAdmissionBestEffortV1`), so the sweep now finds a task
  // under active protection instead of one that silently went active with
  // nothing running.
  const admission = await acquireWorkAdmissionV1({
    taskFolderPath: resolvedTask.taskFolderPath,
    purpose: "admission",
    commandId: "resumeTask",
  });
  if (admission.outcome !== "acquired") {
    NotificationRouter.showWarning(describeWorkAdmissionRefusalV1(admission));
    return { outcome: "busy" };
  }
  let admissionReleased = false;
  const admissionHeartbeat = setInterval(
    () => void admission.handle.heartbeat(),
    WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1
  );
  const releaseAdmissionV1 = async (): Promise<void> => {
    if (admissionReleased) {
      return;
    }
    admissionReleased = true;
    clearInterval(admissionHeartbeat);
    await admission.handle.release();
  };

  // 2026-09-08 review, narrowed completion blocker: `resolvedTask.progress`
  // above came from `resolveTaskContext`'s (possibly cached) `inventory`
  // snapshot, taken BEFORE this call reached the admission directory. A
  // concurrent invocation can observe the same "paused" snapshot, win
  // admission first, complete its own resume, and release — all before this
  // call's own `acquireWorkAdmissionV1` above resolves. Winning admission
  // here does not mean this call is the one that should perform the resume;
  // it only means the admission directory happened to be free at the moment
  // this call reached it. Re-read straight off disk, under admission, before
  // trusting the cached "paused" status for anything that mutates: if the
  // task is no longer paused, someone else already handled this exact
  // resume event and this call must not perform a second, redundant one.
  const freshStatus = await readTaskProgressStrictV1(vscode.Uri.file(resolvedTask.taskFolderPath));
  if (!freshStatus.ok) {
    // 2026-09-08 review, new completion blocker: an earlier revision folded
    // this branch into "superseded" alongside the confirmed-non-paused case
    // below. That silently misrepresented "the re-read itself failed — a
    // missing, unreadable, or invalid task-progress.json" as "a concurrent
    // resume already handled this event", which is not established here at
    // all — no other invocation's success has been observed. The labeled
    // resume-and-rerun action must not perform no work with no explanation;
    // surface the reader's own reason and stop, mirroring the
    // activateTask-threw catch below, before any mutation is even attempted.
    NotificationRouter.showError(
      `Could not confirm the task's status before resuming: ${freshStatus.reason}`
    );
    await releaseAdmissionV1();
    return { outcome: "failed" };
  }
  if (freshStatus.decoded.progress.status !== "paused") {
    await releaseAdmissionV1();
    return { outcome: "superseded" };
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
        // Resuming a task IS the human's "how would you like to proceed"
        // answer to a stuck-review escalation — clear it as a small,
        // additive follow-up write rather than threading it into
        // activateTask's own checkpoint/rollback machinery. A stale
        // escalation left behind here would otherwise linger in the task
        // tree and (once the task plateaus again) skew
        // secondOpinionTriedThisPlateau against a fresh attempt.
        // `updatedAt` IS bumped here, deliberately (v1 fixes item 1,
        // 2026-09-07). This call previously passed `preserveFreshness: true`
        // on the reasoning that "resuming is selection, not progress" and so
        // must not hoist the task in the recency-ordered list. That reasoning
        // is defensible for focus/selection (see taskActivationCoordinator,
        // which still preserves freshness when activating one task pauses the
        // others), but for an explicit resume it hands the stalled-task
        // watchdog a clock that started at the wrong moment.
        //
        // STALLED_TASK_QUIET_PERIOD_MS stands the watchdog down while a task
        // has been touched recently, measured from `updatedAt`. Pausing DOES
        // bump `updatedAt` (pauseTaskWithReason relies on updateTaskStatus's
        // default) — so a task resumed after a watchdog pause inherited the
        // PAUSE's timestamp, and its grace period was not the quiet period but
        //
        //     STALLED_TASK_QUIET_PERIOD_MS - (time since the pause)
        //
        // Measured on `version 1` 2026-09-07: watchdog pause wrote `updatedAt`
        // 09:45:28, user resumed 09:46:12 (44 seconds later), and the resumed
        // task carried the 09:45:28 stamp. Under the 90-second threshold this
        // originally shipped with, that left ~46 seconds before the sweep could
        // re-pause — which is exactly the reported "it reverted to paused
        // straight away", and exactly why being quicker sometimes worked: the
        // user was racing to open an exempting ledger row. Ten minutes made the
        // race winnable, but the window still shrinks by however long the pause
        // went unnoticed, so a pause noticed nine minutes later still leaves
        // sixty seconds.
        //
        // Bumping here makes the window a full quiet period measured from the
        // resume itself, which is the event that actually means "a human is
        // dealing with this". The cost is that an explicitly resumed task sorts
        // to the top of the task list — the correct outcome, since the user
        // just acted on it.
        // The bump is applied HERE, unconditionally, and deliberately NOT left
        // to `clearEscalation` (2026-09-08 defect report — the first shipped
        // attempt at this fix, in 0.105.0/0.106.0, did exactly that and was
        // inert for most tasks).
        //
        // `clearEscalation` early-returns `progress` untouched when there is no
        // escalation to clear (`taskProgressTransforms.ts`), so hanging the
        // refresh on it only refreshed tasks that happened to carry one. The
        // resulting behaviour, reported verbatim: "Every single task, when I try
        // to resume it, it re-pauses. I do it a second time, then it's fine."
        //
        // That two-step is the bug's own signature. First resume: no escalation,
        // so no bump, so the stale timestamp stands and the sweep re-pauses.
        // The watchdog pause then writes BOTH an escalation and a fresh
        // `updatedAt`. Second resume: an escalation now exists, `clearEscalation`
        // does bump, and it holds. The fix appeared to work in testing for
        // exactly the same reason — a task that had just been watchdog-paused
        // always had an escalation to clear.
        //
        // Resuming must refresh the clock because a human acted on the task, not
        // because that task happened to be carrying an escalation record.
        //
        // v1 fixes item 1 (Part 1a step 5): when `arrangeStageDispatch` is
        // set (the bare `resumeTask` command), also arrange the current
        // stage's action to run — a durable `scheduledRun` for "now",
        // consumed by the SAME `TaskActionScheduler.fire` ->
        // `applyCurrentStageAction` path a manually scheduled rerun uses
        // (`scheduleTaskResume.ts`). This is folded into `activateTask`'s
        // OWN `mutateTarget` hook (below) rather than written as a separate,
        // follow-up `patchTaskProgressStrictV1` call — an earlier revision
        // did the latter, leaving a real (if admission-covered) gap on disk
        // between the `active` status write and the write that added
        // `updatedAt`/`scheduledRun`: any reader of `task-progress.json`
        // between those two writes would see the task active with neither.
        // `mutateTarget` composes into `activateTask`'s single CAS write as
        // `updateTaskStatus(mutateTarget(current), "active", { preserveFreshness: true })`
        // — `mutateTarget` below stamps its own fresh `updatedAt`, so
        // `preserveFreshness: true` simply keeps that value rather than
        // discarding it, and the whole thing — status flip, escalation
        // clear, freshness bump, and scheduled dispatch intent — lands in
        // one write. Never overwrites an existing `scheduledRun` — e.g. a
        // quota-park's own future rerun — which is a deliberate future
        // intent, not a stand-in for "nothing is arranged yet".
        const activated = await activateTask(
          inventory, currentTaskStore, resolvedTask.taskFolderPath, resolvedTask.canonicalId,
          {
            mutateTarget: (current) => {
              const cleared = { ...clearEscalation(current), updatedAt: new Date().toISOString() };
              // v1 fixes 2, Wave I chokepoint (arranges a stage dispatch):
              // when this resume is the one arming the durable
              // `scheduledRun`, automation acts next — the same fact
              // `scheduleTaskResume`/`scheduleQuotaResumeAtV1` already record
              // at their own arming sites. When no NEW dispatch is arranged
              // here (arrangeStageDispatch: false, or an existing
              // `scheduledRun` — e.g. a quota-park's own future intent — is
              // left standing), `nextActor` is left untouched rather than
              // guessed: a caller-specific `resumeAndXxxV1` variant that
              // dispatches its own action separately is responsible for its
              // own chokepoint, per the inventory.
              //
              // v1 fixes 2, item 8: a task still at `desc` whose next step is
              // the human's (a new or undrafted task) has nothing for
              // automation to re-run — the stage default there is Draft with
              // AI, which on an empty description is never a recovery.
              // Resuming only reactivates it; it reads "waiting for you".
              const awaitingHumanDescription =
                current.currentStage === "desc" && current.nextActor === "human";
              if (arrangeStageDispatch && current.scheduledRun === undefined && !awaitingHumanDescription) {
                return setNextActorV1(
                  { ...cleared, scheduledRun: { runAt: new Date().toISOString(), stage: current.currentStage } },
                  "automation"
                );
              }
              return cleared;
            },
          }
        );
        if (!activated) {
          throw new Error("Could not read task progress.");
        }
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
    // The resume mutation itself did not succeed, so there is nothing for a
    // caller to hold or dispatch against — always release here regardless of
    // `holdAdmissionForCaller`. Previously this fell through to the shared
    // `finally` below and then unconditionally returned `releaseAdmissionV1`
    // whenever `holdAdmissionForCaller` was set, telling the caller "the
    // resume succeeded, here is your live handle" even though it had just
    // thrown — a caller trusting that handle would have gone on to dispatch
    // against a task that was never actually flipped to `active`.
    await releaseAdmissionV1();
    return { outcome: "failed" };
  } finally {
    if (!holdAdmissionForCaller) {
      await releaseAdmissionV1();
    }
  }
  return { outcome: "resumed", release: holdAdmissionForCaller ? releaseAdmissionV1 : undefined };
}

/**
 * Resume a paused task, then dispatch a follow-up command against it once it
 * is confirmed active — the shared shape behind all five `resumeAndXxxV1`
 * helpers below.
 *
 * Closes (2026-09-08 review completion blocker) the gap between "resume
 * finishes" and "the follow-up dispatch has itself established durable
 * protection": `resumePausedTask`'s own durable admission is held via
 * `holdAdmissionForCaller: true` through the post-resume re-read AND all the
 * way through `dispatch()` itself, released only in `finally` once dispatch
 * has fully settled. There is no window in between where the task is active
 * with neither admission nor arranged work.
 *
 * Holding across `dispatch()` no longer risks a `busy` refusal from a
 * downstream command that itself acquires admission (`runReviewWithAI`,
 * `fastForwardReviewWithAI`): `dispatch` is handed a single-use handoff
 * token (2026-09-08 review architectural blocker fix —
 * `workAdmissionV1.ts`'s `authorizeWorkAdmissionHandoffV1`/
 * `pendingHandoffTokensV1`), minted immediately before it runs and revoked
 * once it settles. A caller that forwards this token into the downstream
 * command's own arguments (see `resumeAndRerunReviewV1` below) lets that
 * command's admission-acquisition call adopt this function's already-live
 * marker via `acquireOrAdoptWorkAdmissionV1`, instead of racing a fresh
 * genesis against it. Without a matching token, adoption never happens —
 * any OTHER same-process command targeting this task (unrelated, concurrent)
 * still races an ordinary genesis and is correctly refused `busy` against
 * the live marker, exactly like a cross-process caller. The marker is only
 * actually unlinked once every holder (this function's own hold, and any
 * adopted view the dispatched command created) has released, regardless of
 * release order (see `workAdmissionV1.ts`'s `localHolderCountsV1` doc
 * comment). Downstream commands that are not themselves admission-wired
 * (`applyCurrentStageAction`, `setTaskStage`) simply never call
 * `acquireOrAdoptWorkAdmissionV1`, so holding admission through their
 * dispatch is unconditionally safe for them too — it can only add
 * protection, never conflict — and they ignore the token argument they are
 * handed. `runImplementationWithAI` and `goToReviewAndApplyV1` are no longer
 * in that category (2026-09-09 review completion blocker, narrowed): both
 * reach admission-wired commands, so a caller holding admission across their
 * dispatch MUST forward the token or risk a self-inflicted `busy` refusal —
 * see `resumeIfPausedThenGoToReviewAndApplyV1` below for the corrected
 * pattern.
 *
 * Re-reads `task-progress.json` straight off disk rather than trusting the
 * in-memory `inventory`: that cache is not guaranteed to reflect the write
 * `resumePausedTask` (via `activateTask`) just made, and re-checking through
 * the cache risks seeing the pre-resume "paused" snapshot and silently
 * skipping the dispatch.
 *
 * `resumePausedTask` used to return bare `undefined` for two different
 * reasons — the task was already active when it checked (nothing to
 * resume), or a concurrent resume raced this call to admission and lost
 * (refused `busy`) — and this function used to dispatch in EITHER case
 * merely because a disk re-read shows the task active, without this
 * function ever holding admission itself (2026-09-08 review completion
 * blocker). `resumePausedTask` now returns a discriminated
 * {@link ResumePausedTaskOutcomeV1}, and this function acts only on
 * `"resumed"` and the genuinely-nothing-to-resume outcomes (`"notPaused"`,
 * `"notFound"`, `"completed"`) via the fresh-acquisition
 * fallback below; `"busy"`, `"superseded"`, and `"failed"` (2026-09-08
 * review, second narrowing of the same blocker) all mean this call must stop
 * here and never fall back to a fresh admission-and-dispatch. `"busy"` and
 * `"superseded"` both mean another invocation is
 * (or very recently was) the one actually handling this exact
 * resume-and-dispatch event — `"busy"` when that owner still held admission
 * when this call tried to acquire it, `"superseded"` when that owner had
 * already finished and released BEFORE this call reached the admission
 * directory, caught by `resumePausedTask`'s own post-admission disk re-read
 * (2026-09-08 review, narrowed completion blocker) — so this call stops
 * immediately in either case rather than falling back to a fresh admission
 * and a SECOND, possibly different, dispatch once that owner's own dispatch
 * has settled and released — that would be a duplicate action, not a
 * recovery from unprotected work. `"failed"` means this call's OWN
 * post-admission re-read — the one that would have distinguished a genuine
 * resume from a superseded one — could not be trusted at all: it threw, or
 * decoded invalid. That is NOT the same as "nothing to resume"
 * (`"notPaused"`/`"notFound"`/`"completed"`, where no admission was ever
 * attempted for a mutation and no ambiguity exists). Falling back to a fresh
 * re-read here — as an earlier revision did — can observe a status of
 * `"active"` that a DIFFERENT, concurrent invocation wrote in the gap
 * between this call's failed re-read and its fallback re-read, and dispatch
 * a second time against that other invocation's already-in-flight or
 * already-completed resume. `resumePausedTask` has already surfaced the read
 * failure to the user and released its admission; there is nothing further
 * for this call to safely do.
 *
 * For every other outcome, several of this function's dispatch targets
 * (`runImplementationWithAI`, `applyCurrentStageAction`, `setTaskStage`,
 * `goToReviewAndApplyV1`) are not admission-wired themselves, so dispatching
 * against them with no live admission at all would be the exact impossible
 * state this whole mechanism exists to close — it must never happen merely
 * because another owner changed disk status to active out from under this
 * call. When `resumePausedTask` did not retain an admission handle
 * (`"notPaused"`/`"notFound"`/`"completed"`), this acquires a
 * fresh one of its own — after confirming via the re-read that the task is
 * genuinely `active` and worth acquiring for at all — before dispatching; if
 * that is also refused (a real owner is genuinely working right now), it
 * stops rather than double-dispatching unprotected. The re-read happens
 * BEFORE any admission attempt specifically so a task that cannot even be
 * resolved (deleted, moved) short-circuits on `!reread.ok` without ever
 * touching the admission directory for a folder that may not exist.
 *
 * `options.dispatchesAutomationWork` (default `true`, v1 fixes 2 Wave I
 * chokepoint — "arranges a stage dispatch", per-target `resumeAndXxxV1`
 * variants): when true, writes `nextActor: "automation"` immediately before
 * `dispatch()` runs, since `dispatch` is about to start a review or
 * implementation round (or an admission-wired stage action) the task did not
 * have running a moment ago — the same fact the generic resume's own
 * `scheduledRun` arming and `scheduleTaskResume`/`scheduleQuotaResumeAtV1`
 * already record at their own arming sites. `resumeAndSetTaskStageV1` used to
 * pass `false` here on the grounds that its `dispatch` only moved
 * `currentStage` (`setTaskStage`), which did not itself start a round; it now
 * uses the default `true` (pre-1.0.0 fixes register, Part 3 Step 3 — "advance"
 * is a `continue` option, so its `dispatch` closure arranges the destination
 * stage's follow-up action itself, below, rather than being a bare stage
 * move), and the stamp is still only provisional — see the paragraph below.
 *
 * The `"automation"` stamp above is provisional, not final (2026-09-17 review
 * completion blocker): once `dispatch()` resolves, a `false` result — the
 * boolean-refusal contract `applyCurrentStageAction` and
 * `goToReviewAndApplyV1` both use to report "refused before dispatching
 * anything" — clears the stamp back to unknown rather than leaving a false
 * claim standing. See the clearing logic just after the `dispatch()` call
 * below.
 */
async function resumeThenDispatchV1<T>(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg: ResumeTaskArg | undefined,
  taskFolderPath: string,
  dispatch: (admissionHandoffToken: string | undefined) => Promise<T> | Thenable<T>,
  options?: { readonly dispatchesAutomationWork?: boolean }
): Promise<T | undefined> {
  const dispatchesAutomationWork = options?.dispatchesAutomationWork ?? true;
  const resumed = await resumePausedTask(inventory, currentTaskStore, explicitArg, {
    arrangeStageDispatch: false,
    holdAdmissionForCaller: true,
  });

  // A concurrent resume owns this event (or very recently did) — never fall
  // back to a fresh admission-and-dispatch here, even if that owner has
  // since released and a re-read would show the task active. Falling back
  // would risk firing a second, possibly different, dispatch for the same
  // resume-and-dispatch request. `"busy"` covers the case where the
  // concurrent winner still holds admission when this call arrives;
  // `"superseded"` (2026-09-08 review, narrowed completion blocker) covers
  // the case where that winner already finished its own resume and released
  // BEFORE this call reached the admission directory — `resumePausedTask`'s
  // own post-admission re-read caught that and refused to act. `"failed"`
  // (2026-09-08 review, second narrowing of the same blocker) covers the
  // case where THAT SAME post-admission re-read could not be trusted at all
  // — it threw, or decoded invalid — rather than positively confirming
  // either outcome. An earlier revision let `"failed"` fall through to the
  // fresh-acquisition fallback below, which re-reads disk one more time: if
  // a DIFFERENT concurrent invocation's resume lands in the gap between the
  // failed re-read and that fallback re-read, the fallback observes
  // "active" and dispatches a second time for the same event — the exact
  // duplicate-dispatch race this function exists to prevent. All three
  // outcomes must stop here identically: none of them means "nothing is
  // protecting this task and a fresh dispatch is safe".
  if (resumed.outcome === "busy" || resumed.outcome === "superseded" || resumed.outcome === "failed") {
    return undefined;
  }

  const resumedRelease = resumed.outcome === "resumed" ? resumed.release : undefined;

  const reread = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath));
  if (!reread.ok || reread.decoded.progress.status !== "active") {
    if (resumedRelease) {
      await resumedRelease();
    }
    return undefined;
  }

  let release = resumedRelease;
  if (!release) {
    const fresh = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "resumeThenDispatchV1",
    });
    if (fresh.outcome !== "acquired") {
      return undefined;
    }
    const freshHeartbeat = setInterval(
      () => void fresh.handle.heartbeat(),
      WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1
    );
    release = async () => {
      clearInterval(freshHeartbeat);
      await fresh.handle.release();
    };
  }

  const handoffToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);
  try {
    if (dispatchesAutomationWork) {
      // v1 fixes 2, Wave I chokepoint (arranges a stage dispatch): written
      // under the admission this function already holds, immediately before
      // the follow-up command starts a round — the moment automation
      // genuinely becomes the next actor for this per-target dispatch.
      await patchTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), (p) => setNextActorV1(p, "automation"));
    }
    const result = await dispatch(handoffToken);
    // 2026-09-17 review completion blocker: the stamp above is written BEFORE
    // `dispatch` runs, on the assumption that it is about to start a round —
    // but a dispatched command can itself refuse without arranging anything
    // (`applyCurrentStageAction`'s own contract: "Returns whether a
    // downstream stage command was actually dispatched (`true`) or this call
    // refused before dispatching anything (`false` ...)"; `goToReviewAndApplyV1`
    // follows the same boolean contract). Leaving `"automation"` stamped after
    // such a refusal would claim automation is acting when nothing was
    // arranged — exactly the false state this field exists to prevent. Clear
    // back to unknown (never assert `"human"`, which would itself be a guess
    // this function cannot verify — see `setNextActorV1`'s own doc comment)
    // whenever the dispatch's own boolean contract reports a refusal. Commands
    // whose return type carries no such signal (`runReviewWithAI`,
    // `runImplementationWithAI` — both resolve `void`) are left as stamped:
    // there is no refusal signal available to act on here.
    //
    // A refused dispatch also puts the task back to paused (item 10: "never
    // leave a task active with nothing arranged"). Left active with no round,
    // no schedule and no owed continuation, the watchdog would pause it
    // minutes later as "stalled" — the state this composed action must not
    // manufacture. The command that refused has already told the user why.
    if (dispatchesAutomationWork && (result as unknown) === false) {
      await patchTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), (p) =>
        p.status === "active"
          ? pauseTaskWithReason(
              setNextActorV1(p, undefined),
              "Resume was refused: the action it arranged could not start, so nothing is running."
            )
          : setNextActorV1(p, undefined)
      );
    }
    return result;
  } finally {
    revokeWorkAdmissionHandoffV1(taskFolderPath);
    await release();
  }
}

/**
 * Says a resume stays paused because the action it names cannot start, and
 * offers the restore action when the refusal is the unusable-summary stamp. No
 * rerun command is passed: the task is still paused, so the restore only clears
 * the refusal and the user resumes again afterwards.
 */
function showResumeStaysPausedV1(
  taskName: string,
  taskFolderPath: string,
  stage: TaskStage,
  precondition: string,
  restoreSummary: boolean | undefined
): void {
  NotificationRouter.showWarning(
    `"${taskName}" stays paused: ${precondition}`,
    undefined,
    undefined,
    undefined,
    restoreSummary
      ? {
          command: "vs-code-ai-helper.restoreRejectedImplementationRound",
          title: "Restore Last Usable Summary",
          args: [taskFolderPath, stage],
        }
      : undefined
  );
}

/**
 * Preflight for the fixed-target resumes: when the action they dispatch would
 * be refused, says so and reports `true` so the caller returns without
 * resuming. The stage is read from the persisted `task-progress.json`, never
 * the resolved (possibly cached) snapshot: a stale stage would select the wrong
 * action's checks and let a known refusal through. The preflight fails closed —
 * an unreadable progress file or a failed check leaves the task paused and says
 * so, rather than resuming into an action nothing has verified.
 */
async function refuseFixedDispatchV1(
  target: ResolvedTaskContext,
  action: "review" | "implementation" | "apply-review",
  /** The stage the action runs at when it differs from the persisted one (Apply Review jumps to its review stage first). */
  stageOverride?: TaskStage
): Promise<boolean> {
  const taskName = target.progress.displayName ?? target.folderName;
  const persisted = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
  if (!persisted.ok) {
    NotificationRouter.showWarning(
      `"${taskName}" stays paused: its progress file could not be read to check that the action can start. ${persisted.reason}`
    );
    return true;
  }
  const stage = stageOverride ?? persisted.decoded.progress.currentStage;
  let refusal: Awaited<ReturnType<typeof preflightFixedDispatchV1>>;
  try {
    refusal = await preflightFixedDispatchV1(target.taskFolderPath, stage, action, persisted.decoded.progress);
  } catch (error) {
    NotificationRouter.showWarning(
      `"${taskName}" stays paused: the action's prerequisites could not be checked. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return true;
  }
  if (!refusal) {
    return false;
  }
  showResumeStaysPausedV1(taskName, target.taskFolderPath, stage, refusal.precondition, refusal.restoreSummary);
  return true;
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
  if (await refuseFixedDispatchV1(target, "review")) {
    return;
  }
  // arrangeStageDispatch: false — this function dispatches its OWN specific
  // follow-up (runReviewWithAI, below) moments after resume; letting
  // resumePausedTask also durably arrange the generic current-stage action
  // would schedule a SECOND, possibly different, stage action alongside it.
  // resumeThenDispatchV1 holds resumePausedTask's admission continuously
  // through the post-resume re-read AND the whole of runReviewWithAI's own
  // dispatch, releasing only once it settles — forwarding the single-use
  // handoff token it hands us lets runReviewWithAI's own admission call
  // adopt this same-process marker (acquireOrAdoptWorkAdmissionV1) rather
  // than racing its own genesis against it, so there is no gap and no busy
  // refusal. Without the token, adoption would not happen at all (2026-09-08
  // review architectural blocker fix — see `pendingHandoffTokensV1`'s doc
  // comment in `workAdmissionV1.ts`).
  await resumeThenDispatchV1(inventory, currentTaskStore, explicitArg, target.taskFolderPath, (admissionHandoffToken) =>
    vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", {
      taskFolderPath: target.taskFolderPath,
      admissionHandoffTokenV1: admissionHandoffToken,
    })
  );
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
  if (await refuseFixedDispatchV1(target, "implementation")) {
    return;
  }
  // arrangeStageDispatch: false — see resumeAndRerunReviewV1's identical note;
  // this function dispatches runImplementationWithAI itself, below.
  // resumeThenDispatchV1 now holds admission continuously through the whole
  // of this dispatch (see its doc comment). `runImplementationWithAI` IS
  // admission-wired (its own early-acquisition block calls
  // acquireOrAdoptWorkAdmissionV1), so the single-use handoff token must be
  // forwarded here or that call races a fresh genesis against the marker this
  // function is already holding and self-refuses busy (2026-09-09 review,
  // narrowed completion blocker `d5e4bc19-f7ad-4ff5-a1b2-9fdea1397736-1`) —
  // mirrors resumeAndRerunReviewV1's identical forwarding for runReviewWithAI.
  await resumeThenDispatchV1(inventory, currentTaskStore, explicitArg, target.taskFolderPath, (admissionHandoffToken) =>
    vscode.commands.executeCommand("vs-code-ai-helper.runImplementationWithAI", {
      taskFolderPath: target.taskFolderPath,
      admissionHandoffTokenV1: admissionHandoffToken,
    })
  );
}

/**
 * Resume a paused task and immediately dispatch `applyCurrentStageAction` —
 * the generic per-stage primary action (Apply Review for an impl-review
 * stage, Implementation for `impl`, etc. — see `applyCurrentStageAction.ts`'s
 * header). Built for the "Keep iterating" option on a review-stage plateau
 * escalation (Part C, 1.0.0 gate, "every action does what its label
 * says"): that option previously dispatched `resumeAndRerunReviewV1`, which
 * re-runs the REVIEW — against an unchanged tree the verdict is identical by
 * construction, so "another round has real work to act on" (the option's own
 * rationale) was never true. `applyCurrentStageAction` on an impl-review
 * stage instead dispatches Apply Review (`applyHighLevelReviewChanges` /
 * `applyLowLevelReviewChanges`), which edits the workspace against the
 * review's own blockers and re-reviews inline once it finishes (see
 * `applyReviewWithAI`'s `suppressAutoReviewDispatch` comment) — genuine work,
 * then a fresh verdict, in one dispatch.
 *
 * Mirrors `resumeAndRerunReviewV1` / `resumeAndDispatchImplementationV1`
 * exactly: the `WorkflowDecisionOptionEffectV1` shape only carries one
 * command, so a single-command option cannot resume AND dispatch without a
 * small combined command like this one. `resumePausedTask` handles (and
 * reports) its own failure modes via `NotificationRouter`; this only
 * proceeds to the dispatch when the task actually reached "active", so a
 * failed/declined resume does not also throw a confusing "task is paused"
 * message on top of whatever `resumePausedTask` already told the user.
 */
export async function resumeAndApplyCurrentStageActionV1(
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
  // arrangeStageDispatch: false — this function dispatches
  // applyCurrentStageAction itself, below; even though that is the same
  // command a durable arrangement would eventually reach, letting both fire
  // would still be a duplicate dispatch.
  // resumeThenDispatchV1 now holds admission continuously through the whole
  // of this dispatch (see its doc comment). `applyCurrentStageAction` forwards
  // an `admissionHandoffTokenV1` into whichever downstream stage command it
  // dispatches, and — when the impl stage redirects to Apply Review — into
  // `goToReviewAndApplyV1` as well, so the token must reach it here or every
  // one of those downstream admission-wired commands races a fresh genesis
  // against the marker this function is already holding and self-refuses busy
  // (2026-09-09 review, narrowed completion blocker
  // `d5e4bc19-f7ad-4ff5-a1b2-9fdea1397736-1`).
  //
  // v1 fixes 2, items 14 + 25: decide WHICH action to arrange from the same
  // preconditions that action enforces at dispatch, before touching the task —
  // a stale review arranges Review (Apply Review would be refused), a task
  // whose next step is the human's is only resumed, and a task with no valid
  // action stays paused and says which precondition failed.
  // Read the stage and `nextActor` straight off disk: the inventory snapshot
  // `target` came from may predate the pause that put the task here.
  const fresh = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
  const currentProgress = fresh.ok ? fresh.decoded.progress : target.progress;
  const plan = await loadResumeActionPlanV1(target.taskFolderPath, currentProgress);
  const taskName = currentProgress.displayName ?? target.folderName;
  if (plan.kind === "blocked") {
    showResumeStaysPausedV1(
      taskName,
      target.taskFolderPath,
      currentProgress.currentStage,
      plan.precondition,
      plan.restoreSummary
    );
    return;
  }
  if (plan.kind === "resume-only") {
    const resumed = await resumePausedTask(inventory, currentTaskStore, explicitArg, {
      arrangeStageDispatch: false,
    });
    if (resumed.outcome === "resumed") {
      NotificationRouter.showInformation(`Resumed "${taskName}". ${plan.reason}`);
    }
    return;
  }
  const dispatched = await resumeThenDispatchV1(
    inventory,
    currentTaskStore,
    explicitArg,
    target.taskFolderPath,
    async (admissionHandoffToken) => {
      const result = await vscode.commands.executeCommand(
        plan.kind === "run-review"
          ? "vs-code-ai-helper.runReviewWithAI"
          : "vs-code-ai-helper.applyCurrentStageAction",
        {
          taskFolderPath: target.taskFolderPath,
          admissionHandoffTokenV1: admissionHandoffToken,
        }
      );
      // `runReviewWithAI` resolves `true` only when a review round started
      // (a refusal on any guard clause, including "no model configured",
      // resolves `false` or nothing); normalise so resumeThenDispatchV1 clears
      // its `nextActor: automation` stamp on a refusal.
      return plan.kind === "run-review" ? result === true : result;
    }
  );
  // A composed action that did not start its second step must not read as
  // success: both commands report refusal as `false`.
  if (dispatched === false) {
    NotificationRouter.showWarning(
      `"${plan.label}" resumed "${taskName}" but the action was refused, so nothing is running — see the message above for the cause.`
    );
  }
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
 *
 * Pre-1.0.0 fixes register, item 14 / Part 3 Step 3: "Advance", chosen while
 * a Fast Forward run is interrupted, must CONTINUE that run at the new
 * stage, not merely move a field and leave nothing running (the reported
 * defect — the task sat idle at the new stage until the watchdog paused it
 * again). `explicitArg.resumeFastForward` is baked into the option's own
 * args at card-build time (`buildAdvanceOptionV1`), from whether Fast
 * Forward was genuinely mid-run for this task when the card was posted — see
 * `activeFastForwardRunsV1.ts`'s doc comment for why that has to be captured
 * then, not re-derived now. When it was, this dispatches
 * `fastForwardReviewWithAI` at the new stage; otherwise it dispatches the
 * new stage's own default action, resolved by `loadResumeActionPlanV1` —
 * the same resolution `resumeAndApplyCurrentStageActionV1` above uses.
 */
export async function resumeAndSetTaskStageV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg:
    | (ResumeTaskArg & {
        stage?: TaskStage;
        resumeFastForward?: boolean;
        expectedSourceStage?: TaskStage;
      })
    | undefined
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
  const resumeFastForward = explicitArg.resumeFastForward === true;
  const expectedSourceStage = explicitArg.expectedSourceStage;
  // arrangeStageDispatch: false — this function dispatches setTaskStage
  // itself, below, which is a stage MOVE, not a rerun of the current stage's
  // action; a durably arranged current-stage action would be actively wrong
  // here (it would run the escalated stage's action, not advance past it).
  // resumeThenDispatchV1 now holds admission continuously through the whole
  // of this dispatch (see its doc comment). `setTaskStage` is not yet
  // admission-wired on its own (separate, still-open plan item), but that is
  // not a conflict here — it never calls acquireOrAdoptWorkAdmissionV1, so
  // holding through its dispatch can only add protection, not refuse it.
  // dispatchesAutomationWork now defaults to true (Part 3 Step 3 — this used
  // to pass `false` here, on the grounds that a bare stage MOVE does not
  // itself start a round; it no longer is bare, since this dispatch closure
  // now arranges the follow-up action itself, below).
  await resumeThenDispatchV1(
    inventory,
    currentTaskStore,
    explicitArg,
    target.taskFolderPath,
    async (admissionHandoffToken) => {
      // Review blocker (2026-09-23, narrowed c2453680-fe42-461b-9652-1f87445cb9d3-0,
      // now closed): a stale click can only be legitimate while the task is
      // still at `expectedSourceStage` (the stage this card was raised
      // against) OR has already been carried to `stage` by an independent
      // automatic advance (the ordinary race the earlier fix handles) — a
      // task that has moved to any THIRD stage means the card has outlived a
      // further transition and must be refused, not acted on.
      //
      // The read below is a best-effort FAST PATH only — it can save a round
      // trip through `setTaskStage` for the common "obviously stale" case,
      // but it is NOT where this is actually enforced: there is still a
      // window between this read and `setTaskStage`'s own read in which an
      // independent transition could carry the task to that third stage
      // unnoticed by both. The real enforcement is atomic and lives one
      // level down — `expectedSourceStage` is passed straight through as the
      // `sourceStage` CAS `setTaskStage` feeds to `enterStageV1`/
      // `advanceStage`, so the ONLY read that matters is the one performed
      // under `advanceStageLocked`'s own lock hold (`stageTransition.ts`),
      // compared against the stage this card actually knows about — see
      // `setTaskStage`'s `enterStageV1` call site for the full comment.
      // Older persisted decisions from before this field existed carry no
      // `expectedSourceStage`; those are read as "no guard" (unchanged prior
      // behaviour) rather than refused outright, since there is nothing
      // stale to compare against.
      if (expectedSourceStage !== undefined) {
        const preCheck = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
        if (
          preCheck.ok &&
          preCheck.decoded.progress.currentStage !== expectedSourceStage &&
          preCheck.decoded.progress.currentStage !== stage
        ) {
          const staleTaskName = preCheck.decoded.progress.displayName ?? target.folderName;
          NotificationRouter.showWarning(
            `"Advance to ${STAGE_DISPLAY_NAMES[stage]}" no longer applies — ${staleTaskName} has since moved on ` +
              `to ${STAGE_DISPLAY_NAMES[preCheck.decoded.progress.currentStage]}. No stage change was made.`
          );
          // Review fix (2026-09-23, completion blocker
          // c2453680-fe42-461b-9652-1f87445cb9d3-0): this fast path refused
          // without dispatching anything — it must report that refusal as
          // `false`, the same boolean-refusal contract `applyCurrentStageAction`
          // and `goToReviewAndApplyV1` use, so `resumeThenDispatchV1`'s own
          // "a refused dispatch puts the task back to paused" handling
          // (just below the `dispatch()` call in that function) fires.
          // Reporting `true` here left `resumeThenDispatchV1` treat this as
          // success — the task was already resumed to active by the time
          // this closure ran, so a stale click would leave it active with
          // `nextActor: automation` stamped and nothing running: exactly the
          // "active with nothing arranged" state item 14 exists to prevent.
          return false;
        }
      }
      // Review fix (2026-09-23, new completion blocker: "the second
      // cancellation check forgets the unsafe result"). `setTaskStage`
      // (below) already calls `cancelRunningOperationsForTask` once, as part
      // of committing the transition. This box is how THIS caller learns
      // that call's result, rather than calling `cancelRunningOperationsForTask`
      // a second time — a second call is blind to a forced end: the moment
      // `forceEndSubtreeV1` fires (inside the FIRST call), it removes the
      // operation row, so a second call would find an empty registry and
      // report `{ ok: true }`, silently discarding the "the work may still be
      // running underneath" signal the first call already observed. See
      // `SetTaskStageArg.cancelResultOutV1`'s doc comment in setTaskStage.ts.
      const cancelResultBox: { current?: CancelRunningOperationsResultV1 } = {};
      const movedByThisCall = await vscode.commands.executeCommand<boolean>(
        "vs-code-ai-helper.setTaskStage",
        {
          taskFolderPath: target.taskFolderPath,
          stage,
          // Omitted entirely (not just `undefined`-valued) when this card
          // carries none, so an older-shaped decision's dispatch keeps the
          // exact same argument shape as before this fix.
          ...(expectedSourceStage !== undefined ? { expectedSourceStage } : {}),
          cancelResultOutV1: cancelResultBox,
        }
      );
      // Re-read to learn the outcome: setTaskStage's own refusal paths (a
      // lost compare-and-set, an unmet stage-entry requirement such as a
      // missing plan-final.md, or a read/write failure) already notified the
      // user directly — this only needs to know whether the stage genuinely
      // ended up at the destination before arranging anything further.
      const reread = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
      if (!reread.ok || reread.decoded.progress.currentStage !== stage) {
        return false;
      }
      // Race-safety fix (review finding, narrowed blocker
      // c2453680-fe42-461b-9652-1f87445cb9d3-0): the task can be sitting at
      // `stage` here for two different reasons — THIS call moved it there, or
      // an automatic advance (the same score/threshold check this option's
      // card derives from) got there first, independently, and this option
      // arrived after — whether because the card's best-effort withdrawal
      // lost the race to the click, or the withdrawal itself failed. Trusting
      // "the destination stage is current" alone (the old check, above) could
      // not tell those apart, so a stale click re-dispatched the destination
      // stage's action A SECOND TIME on top of whatever the automatic advance
      // had already started. `setTaskStage`'s own boolean return is
      // authoritative about which case this is — it reports `false` exactly
      // when the task was already on the requested stage before this call —
      // so when it did NOT move anything, there is nothing further to
      // arrange: stop here and report success (nothing was refused; the
      // destination was simply already reached), not a fresh dispatch.
      if (movedByThisCall !== true) {
        return true;
      }
      // Review fix (2026-09-23, completion blocker on the commit-then-cancel
      // ordering `setTaskStage`'s own `enterStageV1` call site uses): that
      // call already tried to stop whatever was running for the OUTGOING
      // stage, and this caller is about to arrange its own brand-new
      // automated work (Fast Forward, or the destination stage's default
      // action) on top of the same, already-moved task, so it must gate that
      // dispatch on whether cancellation actually succeeded — mirroring the
      // "commit stands, follow-up dispatch requires a confirmed stop" rule
      // `nextStage` (the other stage-advancing writer) already applies.
      //
      // This reads `cancelResultBox` — the result `setTaskStage` itself
      // deposited while performing that cancellation — rather than calling
      // `cancelRunningOperationsForTask` a second time (fixed 2026-09-23,
      // narrowed completion blocker c2453680-fe42-461b-9652-1f87445cb9d3-0):
      // a second call cannot observe a forced end that already fired during
      // the FIRST call, because `forceEndSubtreeV1` removes the operation row
      // the moment it fires — a second call on the now-empty registry read
      // `{ ok: true }`, silently discarding exactly the "the work may still
      // be running underneath" signal this gate exists to catch. The box is
      // guaranteed to be populated whenever `movedByThisCall === true` (every
      // return-true path in `setTaskStage` runs after the deposit); the
      // fallback below only guards against that invariant being broken by a
      // future refactor, and fails closed (no dispatch) rather than assuming
      // success.
      const advanceCancelResult: CancelRunningOperationsResultV1 = cancelResultBox.current ?? {
        ok: false,
        reason: "the stage-transition command did not report a cancellation result.",
      };
      if (!advanceCancelResult.ok) {
        await patchTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath), (p) =>
          setNextActorV1(p, "human")
        );
        NotificationRouter.showWarning(
          `Moved to ${STAGE_DISPLAY_NAMES[stage]}, but a previously running operation for the prior stage could ` +
            `not be stopped: ${advanceCancelResult.reason} No automatic follow-up was started — stop the stale ` +
            `operation from its Notifications row (or wait for it to actually finish), then use the stage's own ` +
            `action to continue.`
        );
        return true;
      }
      if (resumeFastForward) {
        await vscode.commands.executeCommand("vs-code-ai-helper.fastForwardReviewWithAI", {
          taskFolderPath: target.taskFolderPath,
          admissionHandoffTokenV1: admissionHandoffToken,
        });
        return true;
      }
      const plan = await loadResumeActionPlanV1(target.taskFolderPath, reread.decoded.progress);
      if (plan.kind === "blocked" || plan.kind === "resume-only") {
        // The stage move itself succeeded; there is simply nothing further
        // to arrange automatically at the new stage (e.g. its next step is
        // the human's) — not a refusal of the Advance option itself, so this
        // says so directly rather than through resumeThenDispatchV1's
        // generic "the action it arranged could not start" refusal text.
        //
        // 2026-09-2x review completion blocker: `resumeThenDispatchV1`
        // already stamped `nextActor: "automation"` before this closure ran
        // (`dispatchesAutomationWork` defaults to `true`), on the assumption
        // that `dispatch()` was about to start a round. Here it was not —
        // the new stage's next step is the human's — so that stamp is now
        // false and must be corrected directly, to "human", rather than left
        // standing. Returning `true` (this is not a refusal) means
        // `resumeThenDispatchV1`'s own `false`-only clearing branch never
        // runs and would be wrong here anyway: it also re-pauses the task,
        // which this state must not do (item 6/16/25: a legitimate
        // human-next wait is `status: active`, not paused).
        await patchTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath), (p) =>
          setNextActorV1(p, "human")
        );
        NotificationRouter.showInformation(
          `Moved to ${STAGE_DISPLAY_NAMES[stage]}. ${plan.kind === "blocked" ? plan.precondition : plan.reason}`
        );
        return true;
      }
      const result = await vscode.commands.executeCommand(
        plan.kind === "run-review"
          ? "vs-code-ai-helper.runReviewWithAI"
          : "vs-code-ai-helper.applyCurrentStageAction",
        {
          taskFolderPath: target.taskFolderPath,
          admissionHandoffTokenV1: admissionHandoffToken,
        }
      );
      return plan.kind === "run-review" ? result === true : result !== false;
    }
  );
}

/**
 * Resume the task ONLY IF it is currently paused, then move it to
 * `reviewStage` and run Apply Review there via `goToReviewAndApplyV1`.
 *
 * Review blocker (2026-08-30, wf "stage chat as a record of work" item 14 /
 * Part 12 step 34): "Go to Review & Apply" is offered from three places —
 * `sterileRoundRouting`, `preImplementationRouting`, and Fast Forward's
 * closing notice — none of which pause the task themselves
 * (`gating.holdsTaskPaused: false`), so at the moment the card or toast is
 * posted the task is normally active. But a card can sit unanswered for a
 * while, and an unrelated escalation (or another race) can pause the task
 * before the user clicks it. Dispatching the plain `goToReviewAndApply`
 * command in that state hit `setTaskStage`'s `{ allowPaused: false }`
 * resolution and failed with "The task could not be found" — a confusing
 * error for a task that plainly exists and is simply paused (the same
 * defect `resumeAndSetTaskStageV1` above already fixed for escalation
 * cards' "Advance" option). Choosing "Go to Review & Apply" is an
 * unambiguous statement that the user wants the review stage regardless —
 * resuming is part of getting there, not a separate decision.
 *
 * Unlike `resumeAndRerunReviewV1` / `resumeAndDispatchImplementationV1` /
 * `resumeAndSetTaskStageV1` above — each invoked ONLY from an escalation
 * card that itself guarantees the task is paused — this command's callers do
 * NOT guarantee that, so it checks status first and calls `resumePausedTask`
 * only when the task is actually paused. Calling `resumePausedTask`
 * unconditionally would show a spurious "Task is not paused." notification
 * on every ordinary (non-paused) click, which is the common case here.
 */
export async function resumeIfPausedThenGoToReviewAndApplyV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg: (ResumeTaskArg & { reviewStage?: TaskStage }) | undefined
): Promise<boolean> {
  const resolverArg = normalizeResumeTaskArg(explicitArg);
  const target = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
    currentTaskStore
  );
  if (!target || !explicitArg?.reviewStage) {
    return false;
  }
  const reviewStage = explicitArg.reviewStage;
  if (target.progress.status === "paused") {
    // Apply Review refuses a missing or stale review and unmet artifact
    // prerequisites; check them BEFORE resuming so a known refusal leaves the
    // task paused with the reason (v1 fixes 2, item 14).
    if (await refuseFixedDispatchV1(target, "apply-review", reviewStage)) {
      return false;
    }
    // arrangeStageDispatch: false — this function dispatches
    // goToReviewAndApplyV1 itself, via resumeThenDispatchV1 below, which now
    // holds admission continuously through the whole of that dispatch (see
    // its doc comment). `goToReviewAndApplyV1` now forwards a supplied
    // handoff token into the `applyHighLevelReviewChanges`/
    // `applyLowLevelReviewChanges` → `applyReviewWithAI`/
    // `applyReviewEditWithAI` chain it dispatches, and those ARE
    // admission-wired (2026-09-09 review completion blocker, narrowed) — so
    // forwarding the token here is required, not merely protective: without
    // it, that downstream admission call races this function's own held
    // marker and is refused `busy`, silently dropping the redirect.
    const result = await resumeThenDispatchV1(
      inventory,
      currentTaskStore,
      explicitArg,
      target.taskFolderPath,
      (admissionHandoffToken) =>
        goToReviewAndApplyV1({
          taskFolderPath: target.taskFolderPath,
          reviewStage,
          admissionHandoffTokenV1: admissionHandoffToken,
        })
    );
    return result ?? false;
  }
  return goToReviewAndApplyV1({
    taskFolderPath: target.taskFolderPath,
    reviewStage,
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
    (arg?: ResumeTaskArg & { stage?: TaskStage; resumeFastForward?: boolean }) =>
      resumeAndSetTaskStageV1(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(resumeAndSetTaskStage);

  // Not contributed to package.json's `commands`: like the three siblings
  // above, this is a wiring detail behind decision-card options, not
  // something to offer in the command palette.
  const resumeAndApplyCurrentStageAction = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
    (arg?: ResumeTaskArg) =>
      resumeAndApplyCurrentStageActionV1(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(resumeAndApplyCurrentStageAction);

  // Not contributed to package.json's `commands`: like goToReviewAndApplyV1
  // itself, this is a wiring detail behind decision-card options and
  // notification action buttons, not something to offer in the command
  // palette.
  const resumeIfPausedThenGoToReviewAndApply = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
    (arg?: ResumeTaskArg & { reviewStage?: TaskStage }) =>
      resumeIfPausedThenGoToReviewAndApplyV1(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(resumeIfPausedThenGoToReviewAndApply);
}
