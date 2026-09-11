import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import {
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  TaskProgress,
} from "../types/taskProgress";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  isAutomationChainActive,
  scheduleAutomationChain,
} from "../utils/automationChain";
import { IMPL_CONTINUATION_CHAIN_ID_V1, owedContinuationSourceV1 } from "./implementationRecoveryV1";
import {
  hasLiveSchedulingIntentBestEffortV1,
  liveSchedulingIntentIdsBestEffortV1,
  syncOwedContinuationLedgerBestEffortV1,
} from "../state/schedulingIntentV1";
import { taskOperations } from "../utils/taskOperations";
import { reconcileRoundLedgerV1 } from "../utils/roundLedgerReconciliationV1";
import { listLiveRoundLeaseIdsV1 } from "../state/roundLeaseV1";
import { retryStuckPlanRevisionAdoptionV1 } from "../utils/implementationArtifactResolver";
import { pauseTaskWithReasonForClaimV1 } from "../utils/taskProgressTransforms";
import { terminalizeRoundV1 } from "../utils/roundLedgerV1";
import {
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1,
  describeStalledActiveTaskEscalationV1,
  describeUnrecoverableRecoveryEscalationV1,
  isImpossibleActiveStateV1,
  isReconstructableImplRecoveryV1,
  isStaleDispatchedImplRecoveryV1,
  isUnrecoverableImplRecoveryV1,
} from "../utils/taskWatchdogV1";
import {
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  describeWorkAdmissionRefusalV1,
  hasDurableResolutionInFlightV1,
  hasLiveWorkAdmissionExcludingOwnerV1,
  hasResolutionInFlightBestEffortV1,
  isWatchdogPauseFenceCurrentV1,
  readOrInitPauseFenceGenerationV1,
  revokeWorkAdmissionHandoffV1,
  withWorkAdmissionV1,
} from "../state/workAdmissionV1";
import { resolveTaskRootCandidates } from "../utils/taskRoot";
import { postWorkflowDecisionV1, PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";
import { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";

type ScheduleArg = { canonicalId?: string; taskFolderPath?: string; task?: { folderUri: vscode.Uri } };

/**
 * v1 fixes item 1, Part 1a step 7: the durable `WorkflowDecisionV1` card a
 * watchdog pause posts, carrying the action that undoes it — see
 * `detectAndRepairStalledActiveTasksV1`'s call site for why this is a posted
 * decision rather than a toast `actionCommand`. Shared between the generic
 * stall (`stuckRecovery: false`) and the unrecoverable-recovery route
 * (`stuckRecovery: true`, `implRecovery` already cleared by the pause write
 * that preceded this call) — both land the task in the identical "paused,
 * nothing running" state, so the same "resume and re-run" remedy applies to
 * either; only the explanatory text differs.
 */
function buildStalledTaskEscalationDecisionV1(
  stuckRecovery: boolean,
  target: ChatTarget
): PostWorkflowDecisionInputV1 {
  const displayName = target.taskName ?? target.taskFolderPath;
  const whatHappened = stuckRecovery
    ? describeUnrecoverableRecoveryEscalationV1(displayName)
    : describeStalledActiveTaskEscalationV1(displayName);
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "resumeAndRerun",
      label: "Resume and re-run this stage",
      consequence:
        "Resumes the task and immediately re-dispatches its current stage's action through the same " +
        "admission-protected path a scheduled resume uses — the task will not go active again without " +
        "genuine work arranged for it.",
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
        args: [{ taskFolderPath: target.taskFolderPath }],
      },
    },
    {
      optionId: "handleMyself",
      label: "Leave it paused — I'll review it first",
      consequence:
        "Leaves the task paused; nothing is dispatched. Review the run log for what happened before resuming.",
      effect: { kind: "doNothing" },
    },
  ];
  const recommendation: WorkflowDecisionRecommendationV1 = {
    kind: "option",
    optionId: "resumeAndRerun",
    reasoning: "The task is paused and this is the action that returns it to a runnable state.",
  };
  return {
    decisionKey: "watchdogStalledEscalation",
    taskCanonicalId: target.canonicalId,
    stage: target.stage,
    whatHappened,
    whyUserNeeded: "Automation paused this task rather than leaving it silently active with nothing running, " +
      "and cannot decide on your behalf whether the underlying stall needs investigation before continuing.",
    options,
    recommendation,
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail:
        "This decision is what is holding the task paused — resolving it with \"Resume and re-run this " +
        "stage\" resumes the task immediately; \"Leave it paused — I'll review it first\" leaves it paused " +
        "and dispatches nothing.",
    },
  };
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface SchedulerProgressStore {
  patch(folder: vscode.Uri, update: (progress: TaskProgress) => TaskProgress): Promise<TaskProgress | undefined>;
}

export const systemSchedulerClock: SchedulerClock = { now: () => Date.now(), setTimeout, clearTimeout };
const progressStore: SchedulerProgressStore = { patch: patchTaskProgressStrictV1 };
const MAX_TIMER_DELAY = 0x7fffffff;
const LEASE_DURATION_MS = 60 * 60 * 1000;

/**
 * Persisted one-shot scheduler. A lease means only one VS Code window arms a
 * timer. Long waits are re-armed in safe timer-sized chunks and each chunk
 * renews the lease. On dispose the owner releases its lease so another window
 * can immediately claim the persisted schedule.
 */
export class TaskActionScheduler implements vscode.Disposable {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Signature of the persisted run represented by each armed timer. */
  private readonly armedRuns = new Map<string, string>();
  private readonly owner: string;
  /**
   * `fire()` is deliberately fire-and-forget from its `setTimeout` callback
   * (production code cannot await a timer callback), but it now does real,
   * disk-backed work-admission I/O before it does anything else (v1 fixes
   * item 1, Part 1a step 6) — no longer the near-synchronous body it used to
   * be. Tests that drive firing via a `FakeClock` need a deterministic way to
   * wait for that I/O to actually settle, rather than guessing at a fixed
   * number of ticks; tracked here for exactly that purpose and not consulted
   * anywhere in production logic.
   */
  private readonly inFlightFiresForTestV1 = new Set<Promise<void>>();

  constructor(
    private readonly inventory: TaskInventory,
    private readonly clock: SchedulerClock = systemSchedulerClock,
    private readonly store: SchedulerProgressStore = progressStore,
    owner = `${vscode.env.sessionId}:${Math.random().toString(36).slice(2)}`
  ) {
    this.owner = owner;
  }

  async arm(taskFolderPath: string, canonicalId?: string): Promise<void> {
    const folder = vscode.Uri.file(taskFolderPath);
    const claimed = await this.store.patch(folder, progress => {
      const run = progress.scheduledRun;
      if (!run) return progress;
      const leaseIsLive = run.leaseUntil && new Date(run.leaseUntil).getTime() > this.clock.now();
      if (leaseIsLive && run.leaseOwner !== this.owner) return progress;
      return {
        ...progress,
        scheduledRun: {
          ...run,
          leaseOwner: this.owner,
          leaseUntil: new Date(this.clock.now() + LEASE_DURATION_MS).toISOString(),
        },
      };
    });

    const run = claimed?.scheduledRun;
    if (!run || run.leaseOwner !== this.owner) return;

    const remaining = new Date(run.runAt).getTime() - this.clock.now();
    // Renew the lease before it can expire. Without this, a run scheduled
    // more than an hour ahead could be claimed by another window while this
    // window still had a timer armed.
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY, LEASE_DURATION_MS / 2));
    const signature = `${run.runAt}\u0000${run.stage}`;
    const old = this.timers.get(taskFolderPath);
    if (old) this.clock.clearTimeout(old);
    this.armedRuns.set(taskFolderPath, signature);
    this.timers.set(taskFolderPath, this.clock.setTimeout(() => {
      if (remaining > delay) {
        void this.arm(taskFolderPath, canonicalId);
      } else {
        const firing = this.fire(taskFolderPath, canonicalId, run.runAt, run.stage);
        this.inFlightFiresForTestV1.add(firing);
        void firing.finally(() => this.inFlightFiresForTestV1.delete(firing));
      }
    }, delay));
  }

  /** Test-only: resolve once every `fire()` currently in flight has settled
   * — see `inFlightFiresForTestV1`'s doc comment. */
  async waitForPendingFiresForTestV1(): Promise<void> {
    await Promise.allSettled([...this.inFlightFiresForTestV1]);
  }

  /**
   * v1 fixes item 1, Part 1a step 6 ("a scheduled stage action must dispatch,
   * or must not consume its schedule"): admission is acquired BEFORE
   * `scheduledRun` is cleared below and held across the dispatch itself
   * (mirrors `resumeTask.ts`'s `resumeThenDispatchV1`), so there is no window
   * where the schedule has already been consumed but nothing yet protects the
   * task from the stalled-task watchdog. A `busy`/`writeFailed` refusal here
   * means either a genuine owner is already working this task right now, or a
   * real filesystem error prevented even trying — either way this firing is
   * skipped WITHOUT touching `scheduledRun`, so the schedule is never
   * destroyed without having dispatched anything: the very next `armAll()`
   * sweep (on activation, or the periodic 5-minute timer) sees it still
   * present and retries, rather than the run silently vanishing forever.
   */
  private async fire(taskFolderPath: string, canonicalId: string | undefined, expectedRunAt: string, expectedStage: TaskProgress["currentStage"]): Promise<void> {
    this.timers.delete(taskFolderPath);
    this.armedRuns.delete(taskFolderPath);

    await withWorkAdmissionV1(
      {
        taskFolderPath,
        purpose: "admission",
        commandId: "vs-code-ai-helper.scheduleTaskResume.fire",
        onRefused: (outcome) => {
          NotificationRouter.showWarning(
            `A scheduled stage action could not start yet (${describeWorkAdmissionRefusalV1(outcome)}); ` +
              "it remains scheduled and will be retried automatically."
          );
        },
      },
      async () => {
        let clearedByThisOwner = false;
        let stageStillCurrent = false;
        await this.store.patch(vscode.Uri.file(taskFolderPath), current => {
          const run = current.scheduledRun;
          // A stale callback must not consume a replacement schedule created
          // by this same window, nor may it run a stage other than the one
          // selected when the schedule was created.
          if (run?.leaseOwner !== this.owner || run.runAt !== expectedRunAt || run.stage !== expectedStage) return current;
          clearedByThisOwner = true;
          stageStillCurrent = current.currentStage === run.stage;
          return {
            ...current,
            scheduledRun: undefined,
            scheduledResumeTime: undefined,
            updatedAt: new Date(this.clock.now()).toISOString(),
          };
        });

        // A different window can cancel or replace the schedule while this
        // timer is pending. Only the lease owner that cleared its own
        // schedule may run.
        if (clearedByThisOwner && stageStillCurrent) {
          // 2026-09-09 review completion blocker ("scheduled firing does not
          // dispatch-or-retain"): a thrown exception was the ONLY signal this
          // used to treat as "dispatch failed, restore the schedule" —
          // `applyCurrentStageAction` refusing normally (the task is still
          // paused — `scheduleQuotaResumeAtV1` deliberately allows arming a
          // schedule against a paused task — or a downstream stage command
          // observed this call's own held admission marker as `busy` and
          // refused without dispatching) never threw, so the schedule was
          // silently consumed with nothing having run. `applyCurrentStageAction`
          // now reports back whether it actually dispatched a downstream
          // action; anything else — a thrown error OR a `false`/non-boolean
          // return — is treated identically: restore, warn, retry later.
          //
          // The handoff token also closes the self-block half of that same
          // gap: this admission marker is held for the WHOLE call below (see
          // `withWorkAdmissionV1`'s wrapping above), so a downstream stage
          // command that itself acquires admission (`generatePlanWithAI`,
          // `runImplementationWithAI`) would otherwise observe this marker as
          // an unrelated live admission and refuse `busy` — exactly the
          // "self-blocking admission" reproduction from the review. Presenting
          // the token lets that downstream acquisition ADOPT this same marker
          // instead (`acquireOrAdoptWorkAdmissionV1`), mirroring
          // `resumeTask.ts`'s `resumeThenDispatchV1`.
          const handoffToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);
          let dispatched = false;
          let failureMessage: string | undefined;
          try {
            dispatched = (await vscode.commands.executeCommand<boolean>(
              "vs-code-ai-helper.applyCurrentStageAction",
              { canonicalId, taskFolderPath, admissionHandoffTokenV1: handoffToken }
            )) === true;
          } catch (error) {
            failureMessage = error instanceof Error ? error.message : String(error);
          } finally {
            revokeWorkAdmissionHandoffV1(taskFolderPath);
          }
          if (!dispatched) {
            // Dispatch never happened (or failed before any downstream
            // mechanism — its own round ledger row, its own admission —
            // could take over protecting the task). Restore the schedule
            // with its original stage rather than leaving the task silently
            // unprotected AND with the action it promised never having run —
            // only when nobody has since created a different schedule of
            // their own.
            await this.store.patch(vscode.Uri.file(taskFolderPath), current =>
              current.scheduledRun === undefined
                ? { ...current, scheduledRun: { runAt: expectedRunAt, stage: expectedStage } }
                : current
            );
            NotificationRouter.showWarning(
              failureMessage
                ? `A scheduled stage action failed to start (${failureMessage}); it has been rescheduled and will be retried.`
                : "A scheduled stage action did not start (the task may still be paused, or another action was " +
                    "already in progress for it); it has been rescheduled and will be retried."
            );
          }
        } else if (clearedByThisOwner) {
          NotificationRouter.showInformation("Scheduled action was skipped because the task moved to a different stage.");
        }
      }
    );
  }

  async armAll(): Promise<void> {
    const scheduledPaths = new Set<string>();
    for (const task of this.inventory.getTasks()) {
      const run = task.progress.scheduledRun;
      if (!run) continue;
      scheduledPaths.add(task.taskFolderPath);
      const signature = `${run.runAt}\u0000${run.stage}`;
      // Refreshes happen for our own lease writes. Do not repeatedly patch a
      // schedule that is already represented by this window's timer.
      if (this.armedRuns.get(task.taskFolderPath) === signature) continue;
      await this.arm(task.taskFolderPath, task.canonicalId);
    }
    for (const [taskFolderPath, timer] of this.timers) {
      if (scheduledPaths.has(taskFolderPath)) continue;
      this.clock.clearTimeout(timer);
      this.timers.delete(taskFolderPath);
      this.armedRuns.delete(taskFolderPath);
    }
    // Reconcile BEFORE re-arming anything (plan step 14's explicit ordering
    // requirement, 2026-08-27 review-flagged: an earlier version ran this
    // after `armPendingImplRecoveries`, so a round-ledger row an owed
    // continuation's re-dispatch was about to open could race a still-open
    // orphaned row from the SAME task without reconciliation having had a
    // chance to close the stale one first).
    await this.reconcileRoundLedgerOrphans();
    await this.retryStuckPlanRevisionAdoptions();
    await this.armPendingImplRecoveries();
    // Last, so it only ever fires against whatever the passes above could
    // NOT resolve — an orphaned round is already closed, a reclaimable
    // continuation is already re-armed, by the time this runs.
    await this.detectAndRepairStalledActiveTasksV1();
  }

  /**
   * Guaranteed re-entry for a plan revision whose durable adoption record
   * (`checklistChangeProposals` entry flipping to `"adopted"`) failed to land
   * after its bounded in-place retry (2026-08-28 review fix, completion
   * blocker: "finalizePlanRevisionBestEffortV1 ... permits the stage
   * transition to continue with planRevision and the proposal still in
   * progress" — no code path is guaranteed to retry it, since neither
   * production caller of `preparePlanPromotion` runs again once the task has
   * left `plan`/`plan-review`). Same self-healing slot as the round-ledger
   * reconciliation above and `armPendingImplRecoveries` below: idempotent,
   * cheap once nothing is stuck, safe to call every sweep.
   */
  private async retryStuckPlanRevisionAdoptions(): Promise<void> {
    for (const task of this.inventory.getTasks()) {
      if (task.progress.planRevision === undefined) {
        continue;
      }
      await retryStuckPlanRevisionAdoptionV1(vscode.Uri.file(task.taskFolderPath));
    }
  }

  /**
   * Round-ledger reconciliation, all three passes (wf "make the stage chat a
   * record of work" Part 4 step 14, `roundLedgerReconciliationV1.ts`). Runs
   * on activation and every periodic sweep, same entry point as
   * `armPendingImplRecoveries`'s self-healing: (c) synthesizes a ledger row
   * for any legacy `_Auto-starting_` transcript entry that never had one, (a)
   * closes a `"scheduled"`/`"open"` row as `"interrupted"` once that row's OWN
   * `operationId`/`intentId` is no longer among this task's live operations/
   * scheduling-intents — falling back to the task-wide booleans only for a
   * row with neither id (see `reconcileOrphanedRoundLedgerRowsV1`'s doc
   * comment), and (b)
   * appends a missing outcome message for any terminal row — including one
   * (c) just synthesized. Unlike pass (a) alone, (b)/(c) are not gated on an
   * open row existing, so every task is reconciled every sweep; each pass is
   * independently idempotent and cheap once nothing is outstanding.
   */
  private async reconcileRoundLedgerOrphans(): Promise<void> {
    // Workspace-wide, computed once per sweep rather than per task: a live
    // round-lease entry is keyed by its own globally-unique `roundId`, so one
    // list safely covers every task's rows (2026-09-04 review follow-up,
    // closing the "manually-dispatched round in another window" architectural
    // gap — see `roundLeaseV1.ts` and `isRoundLedgerRowProtectedV1`).
    const liveRoundLeaseIds = listLiveRoundLeaseIdsV1(this.clock.now());
    for (const task of this.inventory.getTasks()) {
      const liveOperations = taskOperations.getTaskOperations(task.taskFolderPath);
      await reconcileRoundLedgerV1({
        taskFolderUri: vscode.Uri.file(task.taskFolderPath),
        hasLiveOperation: liveOperations.length > 0,
        hasLiveSchedulingIntent: hasLiveSchedulingIntentBestEffortV1(task.taskFolderPath),
        liveOperationIds: liveOperations.map((op) => op.id),
        liveSchedulingIntentIds: liveSchedulingIntentIdsBestEffortV1(task.taskFolderPath),
        liveRoundLeaseIds,
        now: this.clock.now(),
      });
    }
  }

  /**
   * Tasks whose stale `dispatched` recovery record this window has already
   * surfaced — once per window, not once per 5-minute sweep.
   */
  private readonly staleRecoveryNotified = new Set<string>();

  /**
   * Tasks whose reclaim this window has already reported as skipped because
   * the chain guard (`isAutomationChainActive`) is still live — once per
   * window per task, not once per sweep, mirroring `staleRecoveryNotified`
   * above. Workflow-6 Item 1: before the guard carried an expiry, a skipped
   * reclaim here was completely silent — a task could sit with an owed
   * continuation and `status: active` for hours with no indication that
   * anything was blocking it (observed 2026-08-17, ~2.5 hours). The guard now
   * expires on its own (`automationChain.ts`), but a *live* guard blocking a
   * reclaim is still worth surfacing: if it turns out to be another stranded
   * process rather than a genuinely in-flight chain, the operator has no way
   * to tell from silence alone.
   */
  private readonly chainGuardSkipNotified = new Set<string>();

  /**
   * Re-arm owed recovery continuations (`implRecovery`, Part 1) that were
   * persisted but never started — the durable half of the deferred-round
   * transition. A `pending` record with no live lease (and the continuation
   * cap not reached) means the transition committed but the process died
   * before the continuation round began: claim it (lease CAS, same one-window
   * rule as scheduledRun) and dispatch the chain exactly once.
   *
   * A1 (1.0.0 gate), second route: a `dispatched` record whose round never
   * settled (the dispatch itself was lost — e.g. the provider hit a usage
   * limit moments after claiming, or the window running it died) used to sit
   * `dispatched` forever, since nothing ever re-read it — the exact same
   * silent-stall symptom as the first route, just surviving instead of being
   * deleted. Once its anchor (`leaseUntil ?? at`) plus `STALE_DISPATCH_GRACE_MS`
   * has elapsed, the round it named is presumed dead and — PROVIDED it is
   * still `isReconstructableImplRecoveryV1` (a `sourceRoundId` to link back
   * to and a quarantined file set, explicit-unknown or otherwise) — it is
   * returned to `pending` so the claim path immediately below re-arms it
   * exactly as a freshly-persisted pending record would. A record still
   * within the grace window is left untouched — the round it covers can
   * legitimately run for the full CLI timeout. A record that IS stale but has
   * lost its reconstructability evidence is left alone here too — re-arming
   * it would dispatch a continuation with nothing to continue — and instead
   * falls to `detectAndRepairStalledActiveTasksV1`, which closes it out
   * through the round ledger's own terminalization path.
   */
  private async armPendingImplRecoveries(): Promise<void> {
    for (const task of this.inventory.getTasks()) {
      let recovery = task.progress.implRecovery;
      if (!recovery) continue;
      if (task.progress.status !== "active") continue;
      if (recovery.dispatch === "dispatched") {
        if (!isStaleDispatchedImplRecoveryV1(recovery, this.clock.now())) {
          continue;
        }
        if (!isReconstructableImplRecoveryV1(recovery, task.progress)) {
          // No source round or quarantined file set to hand a fresh
          // dispatch — reclaiming here would re-dispatch a continuation with
          // nothing to continue, indistinguishable from starting an
          // unrelated round under this record's name. Leave it for the
          // watchdog (`detectAndRepairStalledActiveTasksV1`) to close out
          // through the ledger's own terminalization path instead.
          continue;
        }
        // Reclaim: return the stale `dispatched` record to `pending` (CAS —
        // re-checks staleness AND reconstructability inside the patch so a
        // concurrent reclaim from another window, or a round that finalizes
        // at the last instant, cannot double-reclaim a record that is no
        // longer stale, no longer reconstructable, or no longer present) so
        // the ordinary pending-claim logic below re-arms it in this same
        // pass.
        const reclaimed = await this.store.patch(vscode.Uri.file(task.taskFolderPath), (progress) => {
          const record = progress.implRecovery;
          if (!record || record.dispatch !== "dispatched") return progress;
          if (!isStaleDispatchedImplRecoveryV1(record, this.clock.now())) return progress;
          if (!isReconstructableImplRecoveryV1(record, progress)) return progress;
          return {
            ...progress,
            implRecovery: {
              ...record,
              dispatch: "pending",
              attemptId: undefined,
              leaseOwner: undefined,
              leaseUntil: undefined,
            },
          };
        });
        if (reclaimed === undefined || reclaimed.implRecovery === undefined || reclaimed.implRecovery.dispatch !== "pending") {
          // Another window already reclaimed it, it finalized in the
          // meantime, or it was no longer stale/reconstructable under the
          // fresh read — no action needed from this pass.
          continue;
        }
        if (!this.staleRecoveryNotified.has(task.taskFolderPath)) {
          this.staleRecoveryNotified.add(task.taskFolderPath);
          NotificationRouter.showWarning(
            `⚠️ A stalled recovery continuation for "${task.progress.displayName ?? task.progress.taskFolder}" ` +
              "was reclaimed and will be re-armed automatically (the round that had claimed it never " +
              "finalized — the window running it likely died or the provider hit a usage limit). The " +
              "unreported edits remain preserved in pendingImplReviewFiles."
          );
        }
        // Fall through into the pending-claim logic below using the
        // freshly-reclaimed record (its lease fields are now clear, so the
        // liveness check immediately below passes).
        recovery = reclaimed.implRecovery;
      }
      // Cap reached: the transition already escalated (paused the task) or
      // surfaced its failure to do so; re-dispatching would burn a round the
      // budget says a human must authorize.
      if ((task.progress.incompleteRoundContinuations ?? 0) >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1) {
        continue;
      }
      // ANY live lease blocks a re-arm — including this window's own. The
      // sweep runs on every progress change and every 5 minutes; a claim it
      // could immediately re-take would turn one cancelled continuation into
      // a dispatch loop. A pending record is retried only once its previous
      // claim's lease has fully expired.
      const leaseLive =
        recovery.leaseUntil !== undefined &&
        new Date(recovery.leaseUntil).getTime() > this.clock.now();
      if (leaseLive) continue;
      if (isAutomationChainActive(task.taskFolderPath, IMPL_CONTINUATION_CHAIN_ID_V1, this.clock.now())) {
        if (!this.chainGuardSkipNotified.has(task.taskFolderPath)) {
          this.chainGuardSkipNotified.add(task.taskFolderPath);
          NotificationRouter.showWarning(
            `⚠️ A pending recovery continuation for "${task.progress.displayName ?? task.progress.taskFolder}" ` +
              "was not re-dispatched this sweep because its automation chain guard is still held. " +
              "This is expected while that chain is genuinely in flight; if it persists, the guard " +
              "will expire on its own and the next sweep will retry."
          );
        }
        continue;
      }
      this.chainGuardSkipNotified.delete(task.taskFolderPath);
      const claimed = await this.store.patch(vscode.Uri.file(task.taskFolderPath), (progress) => {
        const record = progress.implRecovery;
        if (!record || record.dispatch !== "pending") return progress;
        const live =
          record.leaseUntil !== undefined &&
          new Date(record.leaseUntil).getTime() > this.clock.now();
        if (live) return progress;
        return {
          ...progress,
          implRecovery: {
            ...record,
            leaseOwner: this.owner,
            leaseUntil: new Date(this.clock.now() + LEASE_DURATION_MS).toISOString(),
          },
        };
      });
      if (
        claimed?.implRecovery?.leaseOwner !== this.owner ||
        claimed.implRecovery.dispatch !== "pending"
      ) {
        continue;
      }
      // PART 6.5 (review-flagged 2026-08-23): this claim re-arms the lease on
      // the same `implRecovery` record the ledger tracks — push the
      // freshly-claimed fact through right after the CAS resolves (never from
      // inside the callback, which may re-run on a retry).
      await syncOwedContinuationLedgerBestEffortV1(
        task.taskFolderPath,
        owedContinuationSourceV1(claimed.implRecovery, claimed.pendingImplReviewFiles ?? [])
      );
      // No root operation: nothing holds the task lock (the transition's own
      // in-process chain either fired long ago or died with its window), so
      // the command dispatches immediately. The shared chainId keeps this
      // sweep and any in-flight in-process chain from double-firing.
      void scheduleAutomationChain({
        command: "vs-code-ai-helper.runImplementationWithAI",
        // No human on this path — see ReviewCommandArg.automationDispatch.
        arg: { taskFolderPath: task.taskFolderPath, automationDispatch: true },
        taskKey: task.taskFolderPath,
        chainId: IMPL_CONTINUATION_CHAIN_ID_V1,
        intent: {
          trigger: "owed implementation continuation re-armed by the periodic recovery sweep",
          settingKey: undefined,
          expectedTiming: "immediately — this sweep pass dispatches it now",
          willRetry: true,
          retryNote:
            "This sweep re-arms and retries while the continuation record stays 'pending'; once a round " +
            "actually starts (dispatch flips to 'dispatched'), it will not retry again automatically.",
        },
      });
    }
  }

  /**
   * Tasks whose stalled-active state this window has already escalated —
   * mirrors `staleRecoveryNotified`'s once-per-window dedup. Not strictly
   * needed for correctness (once paused, `status` is no longer `"active"` and
   * the predicate stops matching on its own), but avoids a duplicate
   * notification if the pause write itself is still in flight when the next
   * sweep starts.
   */
  private readonly stalledActiveNotified = new Set<string>();

  /**
   * A1's watchdog, both routes, through ONE call into `terminalizeRoundV1` —
   * the round ledger's sole exported transition authority (completion
   * blocker `de9851ef-f5bb-41ed-ac18-f50cafefc245-1`, resolved 2026-09-06 by
   * removing the previously-separate `pauseTaskWithNoLiveRoundV1` export and
   * folding its behavior into `terminalizeRoundV1` itself via the
   * `whenNoLiveRow` option). Given `attemptId` (the stuck-`implRecovery`
   * route's continuation row) or `undefined` (the generic route, which by
   * construction has no open round-ledger row left — see
   * `isImpossibleActiveStateV1`'s `hasOpenRoundLedgerRowV1` check), the SAME
   * call resolves the live-row case (folding the pause, and for the recovery
   * route the `implRecovery` clear, into that transaction via
   * `postTerminalizePatch` so the ledger's ending and the task's paused
   * status can never observably disagree) and the no-live-row case (via
   * `whenNoLiveRow`, never touching `roundLedger`) without the caller ever
   * choosing between two functions. `implRecovery` MUST be cleared for the
   * recovery route, not merely left in place under a paused status: without
   * this, resuming the task reproduces the identical impossible state
   * instantly (the same stuck record, nothing changed). The common case for
   * the recovery route is `alreadyTerminal`/`notFound` — this task's own
   * round-ledger reconciliation pass, earlier in this same sweep, will
   * already have closed the continuation's row as orphaned — so
   * `terminalizeRoundV1` itself falls through to `whenNoLiveRow`; the generic
   * route always takes that same fallback, for the reason above.
   * Fabricating a `RoundLedgerEntryV1` via `terminalizeRoundV1`'s
   * `synthesizeIfMissing` remains rejected for the reason recorded in prior
   * revisions of this comment (the generic route's whole premise is that NO
   * round ran; synthesizing one would render a false "_Ended: … —
   * interrupted …_" into chat history and corrupt the ledger's "one entry
   * per real round" invariant) — `whenNoLiveRow` moves `TaskProgress` off
   * `active` without ever touching `roundLedger`.
   * `isStillImpossible` re-checks `isImpossibleActiveStateV1` against the
   * FRESH state read inside the patch (not the snapshot the caller iterated
   * over) either way, so a concurrent resolution — another window's reclaim
   * of the same `implRecovery` record, or the user resuming the task by
   * hand — between this call's snapshot and its write is a safe no-op, never
   * a stale double-pause. Still writes through `this.store.patch` for the
   * no-live-row branch (the same durable, CAS-guarded,
   * re-checked-against-fresh-state primitive every other transition in this
   * codebase uses, and still injectable for tests) via `whenNoLiveRow.patch`.
   */
  private async closeStalledTaskThroughLedgerV1(
    task: { readonly taskFolderPath: string; readonly progress: TaskProgress },
    attemptId: string | undefined,
    reason: string,
    claimId: string,
    claimOwnerToken: string,
    fenceGeneration: number
  ): Promise<{ readonly progress: TaskProgress | undefined; readonly transitioned: boolean }> {
    const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
    // `excludeWorkAdmissionOwnerToken` is this call's OWN `pauseCommit` claim
    // — without it, re-checking `isImpossibleActiveStateV1` while holding
    // that very claim would see the claim's own marker as live admission and
    // conclude the state is no longer impossible, so the pause below could
    // never actually commit (2026-09-09 fix — see the field's doc comment in
    // `taskWatchdogV1.ts`).
    const isStillImpossible = (current: TaskProgress): boolean =>
      isImpossibleActiveStateV1({
        progress: current,
        taskCanonicalId: task.taskFolderPath,
        now: this.clock.now(),
        excludeWorkAdmissionOwnerToken: claimOwnerToken,
      });
    const clearImplRecovery = reason === UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1;

    // 2026-09-04 review follow-up: a disk-backed concurrency test caught two
    // windows racing the generic no-ledger-row route both reading back
    // `status: "paused"` from the shared file and both posting the
    // stalled-task escalation, even though only one of them performed the
    // write. `liveRowTransitioned` (for the live-row branch) and the result's
    // own `transitioned` field (for the no-live-row branch) are set only by
    // the window whose own fresh read still found the impossible state, so
    // the caller can post the escalation exactly once per real detection
    // rather than once per window that merely observed the already-paused
    // result.
    let liveRowTransitioned = false;
    const result = await terminalizeRoundV1(
      attemptId,
      "interrupted",
      {
        rejectionReason:
          "the continuation was dispatched but never finalized, and its record lost the evidence " +
          "needed to safely re-arm it — closed by the watchdog",
      },
      {
        taskFolderUri,
        postTerminalizePatch: (current) => {
          if (!isStillImpossible(current)) {
            return current;
          }
          liveRowTransitioned = true;
          const cleared = clearImplRecovery ? { ...current, implRecovery: undefined } : current;
          return pauseTaskWithReasonForClaimV1(cleared, reason, claimId, fenceGeneration);
        },
        whenNoLiveRow: {
          reason,
          clearImplRecovery,
          isStillImpossible,
          claimId,
          fenceGeneration,
          patch: (folder, transform) => this.store.patch(folder, transform),
        },
      }
    );

    if (result.ok && "noLiveRow" in result) {
      return { progress: result.progress, transitioned: result.transitioned };
    }
    if (!result.ok) {
      // Unreachable in practice: `whenNoLiveRow` is always supplied above, so
      // `terminalizeRoundV1` never falls through to a bare `ok: false` here.
      return { progress: undefined, transitioned: false };
    }
    return { progress: result.progress, transitioned: liveRowTransitioned };
  }

  /**
   * A1's watchdog (1.0.0 gate): after every other self-healing pass above has
   * had its chance, find any task still `status: active` with no live
   * operation, no owed continuation, and no scheduled intent —
   * `isImpossibleActiveStateV1` (`taskWatchdogV1.ts`) — and move it to an
   * explicit `paused` state with an escalation, rather than leaving it to sit
   * `active` forever with nothing running and no signal that anything is
   * wrong. Deliberately acts ONLY through durable state transitions
   * (`closeStalledTaskThroughLedgerV1` above, for both routes) — never
   * dispatches work itself — so running this twice over unchanged state is a
   * no-op: the first run's pause flips `status` away from `"active"`, which
   * the predicate itself then excludes.
   *
   * v1 fixes item 1, Part 1a step 4 ("make the ordinary pause lose the
   * ordinary race"): committing the pause now happens only while holding the
   * SAME shared `admission.claim` file a work-starting command's own genesis
   * contends for (purpose `pauseCommit`). This claim is deliberately NOT a
   * hard exclusion for a concurrent `admission`-purpose genesis (2026-09-09
   * review, narrowed architectural blocker fix): such a genesis instead
   * polls its own exclusive create (`workAdmissionV1.ts`'s
   * `CLAIM_CONTENTION_POLL_INTERVAL_MS_V1`) for as long as this claim would
   * not yet be judged stale (`WORK_ADMISSION_LIKELY_STALE_MS_V1`) while this
   * claim resolves, and once this sweep's claim becomes a MARKER,
   * `markerBlocksAcquisitionV1` lets that genesis proceed immediately rather
   * than reporting `busy` — so "the loser should be the pause, not the round"
   * holds even while this claim is held, not only once it is gone. What this
   * claim DOES still exclude is another concurrent `pauseCommit` attempt (a
   * second sweep pass or window), so two sweeps can never both believe they
   * have "won" a commit at once. A claim this sweep cannot acquire (busy —
   * another `pauseCommit` attempt is live) means the LOSER here is the pause,
   * not the round: this task is simply skipped for this sweep pass, and the
   * very next sweep re-evaluates from scratch — nothing is stranded by
   * skipping, since `isImpossibleActiveStateV1` will see the same (or a
   * resolved) state again next time.
   */
  private async detectAndRepairStalledActiveTasksV1(): Promise<void> {
    // 2026-09-10 review completion blocker, narrowed further: a command
    // resolving WHICH task it targets (`runPublishChecks.ts`,
    // `commitAndPushTask.ts`/`completeCommitAndPushTask`, between
    // `waitUntilReady()` and the moment its target settles) has no task
    // folder path to admit yet — per-task admission cannot protect a task
    // whose identity isn't known. Stand this whole pass down while any such
    // resolution is in flight in this window, rather than risk pausing the
    // very task that resolution is about to settle on and start work for.
    // See `hasResolutionInFlightBestEffortV1`'s doc comment.
    //
    // 2026-09-10 review completion blocker (new): that same-process check
    // alone is invisible to a DIFFERENT window's sweep — this pass also
    // consults the durable, cross-window counterpart
    // (`hasDurableResolutionInFlightV1`) across every task root candidate
    // this window can see, so a resolution running in ANOTHER window on the
    // same workspace stands this sweep down too.
    if (hasResolutionInFlightBestEffortV1()) {
      return;
    }
    if (hasDurableResolutionInFlightV1(resolveTaskRootCandidates().map((candidate) => candidate.absolutePath))) {
      return;
    }
    for (const task of this.inventory.getTasks()) {
      if (!isImpossibleActiveStateV1({ progress: task.progress, taskCanonicalId: task.taskFolderPath, now: this.clock.now() })) {
        this.stalledActiveNotified.delete(task.taskFolderPath);
        continue;
      }
      if (this.stalledActiveNotified.has(task.taskFolderPath)) {
        continue;
      }
      const claimResult = await acquireWorkAdmissionV1({
        taskFolderPath: task.taskFolderPath,
        purpose: "pauseCommit",
        commandId: "vs-code-ai-helper.watchdogPauseCommit",
      });
      if (claimResult.outcome !== "acquired") {
        continue;
      }
      const { ownerToken, claimId } = claimResult.handle;
      try {
        // Repeat the absence check UNDER the claim: a command's genesis could
        // have completed in the narrow window between this loop's admission
        // pre-check (inside `isImpossibleActiveStateV1` above) and this
        // claim's acquisition. Excludes this claim's own marker, which is
        // this sweep's own transitional lock, never "someone else's" live
        // work.
        if (hasLiveWorkAdmissionExcludingOwnerV1(task.taskFolderPath, ownerToken)) {
          continue;
        }
        // v1 fixes item 1, Part 1b step 1: capture the durable pause-fence
        // generation exactly once here, before this attempt's progress
        // mutation begins — every subsequent step (the write below, and both
        // currency checks) carries this SAME captured value, never a
        // re-read, so a concurrent revocation's later fence advance is
        // unambiguously "after" this attempt's own snapshot rather than
        // something this attempt could race into observing halfway.
        const fenceGeneration = await readOrInitPauseFenceGenerationV1(task.taskFolderPath);
        // Pre-write currency check: nothing can have advanced the fence
        // between the capture immediately above and here (no `await` runs in
        // between), so this is a no-op today — there is no revocation
        // protocol yet to race it. It exists so the write below never fires
        // without this check having run at least once ahead of it, matching
        // the plan's literal "pre-write and post-write checks" pairing; once
        // revocation (Part 1b's remaining steps) can advance the fence
        // asynchronously, inserting real work ahead of the write, this check
        // starts actually doing something.
        if (!(await isWatchdogPauseFenceCurrentV1(task.taskFolderPath, fenceGeneration))) {
          continue;
        }
        const recovery = task.progress.implRecovery;
        const stuckRecovery =
          recovery !== undefined && isUnrecoverableImplRecoveryV1(recovery, task.progress, this.clock.now());
        const expectedReason = stuckRecovery
          ? UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1
          : STALLED_ACTIVE_TASK_PAUSE_REASON_V1;
        const { progress: patched, transitioned } = await this.closeStalledTaskThroughLedgerV1(
          task,
          stuckRecovery ? recovery?.attemptId : undefined,
          expectedReason,
          claimId,
          ownerToken,
          fenceGeneration
        );
        if (!transitioned || patched?.status !== "paused" || patched.pausedReason !== expectedReason) {
          // Either nothing changed, or the task was already paused by a
          // racing window's write between this loop's snapshot and this
          // call's own fresh read — that window already posted the
          // escalation, so this one must not post a second copy of it.
          continue;
        }
        // Post-write checks, again excluding this claim's own marker: a
        // command's genesis that started AFTER our pre-write check but
        // BEFORE our write landed on disk must still be found here and
        // reversed, never announced as a pause — the mirror case of
        // `reconcileWatchdogPauseAgainstAdmissionV1`, which covers the same
        // race from the ADMITTING side. `watchdogPauseClaimId` is checked
        // alongside status/reason so this reversal can only ever clear the
        // EXACT pause attempt this call itself just committed. The fence
        // currency check (Part 1b step 1) is the same idea for revocation,
        // once it exists: a revoke-and-advance that lands during the awaited
        // write above must be found here too, not just a live admission
        // marker.
        const admissionArrivedDuringWrite = hasLiveWorkAdmissionExcludingOwnerV1(task.taskFolderPath, ownerToken);
        const fenceAdvancedDuringWrite = !(await isWatchdogPauseFenceCurrentV1(task.taskFolderPath, fenceGeneration));
        if (admissionArrivedDuringWrite || fenceAdvancedDuringWrite) {
          await this.store.patch(vscode.Uri.file(task.taskFolderPath), (current) => {
            if (
              current.status !== "paused" ||
              current.pausedReason !== expectedReason ||
              current.watchdogPauseClaimId !== claimId
            ) {
              // Something else already moved the task on; do not clobber it.
              return current;
            }
            return {
              ...current,
              status: "active",
              pausedReason: undefined,
              watchdogPauseClaimId: undefined,
              watchdogPauseFenceGeneration: undefined,
              updatedAt: new Date(this.clock.now()).toISOString(),
            };
          });
          continue;
        }
        this.stalledActiveNotified.add(task.taskFolderPath);
        // v1 fixes item 1, Part 1a step 7: "a watchdog pause must carry the
        // action that undoes it" — a mechanism that can pause a task must
        // offer the corresponding restart directly on the pause itself, not
        // merely leave the user to find "Resume Task" in the tree's context
        // menu on their own. Posted as a durable WorkflowDecisionV1 (mirrors
        // every other escalation-driven pause — `reviewEscalation.ts`'s
        // `buildEscalationDecisionV1`), NOT a toast `actionCommand`
        // dispatching the command directly: `scripts/verifyToastAllowlistV1.mjs`
        // enforces the project's notification-ownership rule (a workflow
        // action must not exist ONLY on a transient toast) and rejects a
        // direct-dispatch toast from a background sweep like this one — it is
        // not "inline in the user-invoked command it belongs to", the one
        // shape that would qualify for the allowlist instead. Adding
        // "watchdogStalledEscalation" to `ESCALATION_DECISION_KEYS_V1`
        // (reviewEscalation.ts) means `resumeTask.ts`'s resume-time
        // withdrawal loop retires this card the same way it retires every
        // other escalation, with no extra wiring needed here.
        const target: ChatTarget = {
          canonicalId: task.canonicalId,
          taskFolderPath: task.taskFolderPath,
          stage: task.progress.currentStage,
          taskName: task.progress.displayName,
        };
        const posted = await postWorkflowDecisionV1(
          buildStalledTaskEscalationDecisionV1(stuckRecovery, target),
          target
        );
        if (!posted) {
          // Best-effort fallback (directAllowlistEntries shape 2): no
          // activating extension context to post a decision through (e.g. a
          // unit test, or a very early sweep before activation finishes).
          // Plain text, no action button — the tree's own "Resume Task"
          // context-menu entry (package.json's `task-paused` clause) remains
          // reachable regardless of whether this notification carries one.
          NotificationRouter.showWarning(
            stuckRecovery
              ? describeUnrecoverableRecoveryEscalationV1(task.progress.displayName ?? task.progress.taskFolder)
              : describeStalledActiveTaskEscalationV1(task.progress.displayName ?? task.progress.taskFolder)
          );
        }
      } finally {
        // Released only after the write and its post-write validation have
        // fully settled (plan step 4) — never earlier, so genesis stays
        // excluded for the whole commit, not just its first half.
        await claimResult.handle.release();
      }
    }
  }

  async cancel(taskFolderPath: string): Promise<void> {
    const timer = this.timers.get(taskFolderPath);
    if (timer) this.clock.clearTimeout(timer);
    this.timers.delete(taskFolderPath);
    this.armedRuns.delete(taskFolderPath);
    await this.store.patch(vscode.Uri.file(taskFolderPath), progress => ({
      ...progress,
      scheduledRun: undefined,
      scheduledResumeTime: undefined,
      updatedAt: new Date(this.clock.now()).toISOString(),
    }));
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    // Disposal cannot await, but releasing the lease is still important for a
    // new window activating immediately after this one closes.
    const ownedPaths = new Set(this.armedRuns.keys());
    this.armedRuns.clear();
    for (const task of this.inventory.getTasks()) {
      // Only schedules leased by this window need releasing. Patching every
      // task here needlessly journals and rewrites unrelated progress files.
      // `ownedPaths` also covers a lease this scheduler just claimed before
      // the inventory watcher has refreshed its in-memory task snapshot.
      if (task.progress.scheduledRun?.leaseOwner !== this.owner && !ownedPaths.has(task.taskFolderPath)) continue;
      void this.store.patch(vscode.Uri.file(task.taskFolderPath), progress => {
        if (progress.scheduledRun?.leaseOwner !== this.owner) return progress;
        return {
          ...progress,
          scheduledRun: { ...progress.scheduledRun, leaseOwner: undefined, leaseUntil: undefined },
        };
      });
    }
    // Recovery-dispatch leases this window claimed are released the same way,
    // so another window can re-arm a still-pending continuation immediately
    // instead of waiting out the lease.
    for (const task of this.inventory.getTasks()) {
      if (task.progress.implRecovery?.leaseOwner !== this.owner) continue;
      const taskFolderPath = task.taskFolderPath;
      void this.store
        .patch(vscode.Uri.file(taskFolderPath), progress => {
          if (progress.implRecovery?.leaseOwner !== this.owner) return progress;
          return {
            ...progress,
            implRecovery: { ...progress.implRecovery, leaseOwner: undefined, leaseUntil: undefined },
          };
        })
        // PART 6.5 (review-flagged 2026-08-23): dispose() cannot await, but
        // the ledger push can still ride the same fire-and-forget chain as
        // the lease-release write itself, closing the last of the nine
        // `implRecovery` mutation sites.
        .then((patched) =>
          syncOwedContinuationLedgerBestEffortV1(
            taskFolderPath,
            owedContinuationSourceV1(patched?.implRecovery, patched?.pendingImplReviewFiles ?? [])
          )
        )
        .catch(() => undefined);
    }
  }
}

export async function scheduleTaskResume(
  inventory: TaskInventory,
  scheduler: TaskActionScheduler,
  arg?: ScheduleArg,
  clock: SchedulerClock = systemSchedulerClock
): Promise<void> {
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const resolverArg = arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg && (arg.canonicalId || arg.taskFolderPath) ? { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath } : undefined;
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: false });
  if (!task) return;
  const value = await vscode.window.showInputBox({ prompt: "Schedule current-stage action (ISO date/time)", value: new Date(clock.now() + LEASE_DURATION_MS).toISOString() });
  const runAt = value ? new Date(value) : undefined;
  if (!runAt || Number.isNaN(runAt.getTime()) || runAt.getTime() <= clock.now()) {
    if (value) NotificationRouter.showWarning("Enter a future date/time.");
    return;
  }
  await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), p => ({ ...p, scheduledRun: { runAt: runAt.toISOString(), stage: p.currentStage }, scheduledResumeTime: undefined, updatedAt: new Date(clock.now()).toISOString() }));
  await scheduler.arm(task.taskFolderPath, task.canonicalId);
  NotificationRouter.showInformation(`Current-stage action scheduled for ${runAt.toLocaleString()}.`);
}

export async function cancelScheduledTaskAction(inventory: TaskInventory, scheduler: TaskActionScheduler, arg?: ScheduleArg): Promise<void> {
  // Same activation-barrier contract as scheduleTaskResume above (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const task = await resolveTaskContext(inventory, arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg, { allowPaused: true });
  if (task) await scheduler.cancel(task.taskFolderPath);
}

/**
 * How far past a provider's own reported reset time the scheduled rerun is
 * armed — a small margin so the rerun doesn't fire the instant the window
 * theoretically reopens (clock skew between this host and the provider,
 * and providers that report a reset boundary a little optimistically).
 */
export const QUOTA_RESUME_SCHEDULE_BUFFER_MS = 2 * 60 * 1000;

/**
 * Programmatic counterpart to `scheduleTaskResume`'s interactive input box
 * (Part 5 step 1): arms a one-shot `scheduledRun` at an explicit `runAt`
 * WITHOUT prompting the user — used by the quota-park remedy's "Rerun after
 * reset" notification action (runnerRegistry.ts), where the resume time is
 * already known from the provider's own reported reset message, so there is
 * nothing left to ask. Mirrors `beginImplementationRecoveryV1`'s pattern of
 * persisting durable state directly and dispatching without an interactive
 * prompt (implementationRecoveryV1.ts).
 *
 * Goes through the exact same `scheduledRun` field and the exact same
 * `TaskActionScheduler.fire` -> `vs-code-ai-helper.applyCurrentStageAction`
 * path as the interactive command, so the fired run gets identical pre-run
 * checks to a manual rerun (dirty-tree awareness via the stage's own runner
 * cascade, a fresh quota observation via `withQuotaObservation`/
 * `recordQuotaObservationAndClearParkV1`, and the stage-moved skip guard) —
 * nothing about firing programmatically bypasses any of that.
 */
export async function scheduleQuotaResumeAtV1(
  inventory: TaskInventory,
  scheduler: TaskActionScheduler,
  arg: ScheduleArg,
  resetAt: Date,
  clock: SchedulerClock = systemSchedulerClock
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const resolverArg = arg.task
    ? { taskFolderPath: arg.task.folderUri.fsPath }
    : { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath };
  // allowPaused: true (not the sibling helpers' false) — the primary caller
  // of this entry point is the chain-exhaustion pause path
  // (pauseTaskForExhaustedChainV1), which parks the task with status
  // "paused" before this ever runs. Refusing paused tasks here made the
  // "Rerun after reset" action on that path a dead click. Arming a
  // scheduled rerun is exactly the recovery a paused task needs; the
  // eventual fire still goes through applyCurrentStageAction, which already
  // handles resuming from paused.
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: true });
  if (!task) return;
  const runAt = new Date(resetAt.getTime() + QUOTA_RESUME_SCHEDULE_BUFFER_MS);
  if (Number.isNaN(runAt.getTime())) {
    NotificationRouter.showWarning("Could not schedule a rerun: the reported reset time is unreadable.");
    return;
  }
  // A reset time already in the past (the operator clicked the action well
  // after the window reopened) is scheduled for "now plus the buffer" rather
  // than silently doing nothing or rejecting the action outright — the
  // provider's block may already have lifted, so an immediate rerun is
  // exactly the right remedy.
  const effectiveRunAt = runAt.getTime() <= clock.now() ? new Date(clock.now() + QUOTA_RESUME_SCHEDULE_BUFFER_MS) : runAt;
  await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), p => ({ ...p, scheduledRun: { runAt: effectiveRunAt.toISOString(), stage: p.currentStage }, scheduledResumeTime: undefined, updatedAt: new Date(clock.now()).toISOString() }));
  await scheduler.arm(task.taskFolderPath, task.canonicalId);
  NotificationRouter.showInformation(`Rerun scheduled for ${effectiveRunAt.toLocaleString()}, once the quota resets.`);
}

export function registerScheduleTaskResumeCommand(context: vscode.ExtensionContext, inventory: TaskInventory): TaskActionScheduler {
  const scheduler = new TaskActionScheduler(inventory);
  context.subscriptions.push(scheduler);
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.scheduleTaskResume", (arg?: ScheduleArg) => scheduleTaskResume(inventory, scheduler, arg)));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.cancelScheduledTaskAction", (arg?: ScheduleArg) => cancelScheduledTaskAction(inventory, scheduler, arg)));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.scheduleQuotaResumeV1",
    (arg?: ScheduleArg & { resetAtIso?: string }) => {
      if (!arg?.resetAtIso) return;
      const resetAt = new Date(arg.resetAtIso);
      if (Number.isNaN(resetAt.getTime())) return;
      return scheduleQuotaResumeAtV1(inventory, scheduler, arg, resetAt);
    }
  ));
  return scheduler;
}
