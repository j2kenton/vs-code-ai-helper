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
import { retryStuckPlanRevisionAdoptionV1 } from "../utils/implementationArtifactResolver";

type ScheduleArg = { canonicalId?: string; taskFolderPath?: string; task?: { folderUri: vscode.Uri } };

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
        void this.fire(taskFolderPath, canonicalId, run.runAt, run.stage);
      }
    }, delay));
  }

  private async fire(taskFolderPath: string, canonicalId: string | undefined, expectedRunAt: string, expectedStage: TaskProgress["currentStage"]): Promise<void> {
    this.timers.delete(taskFolderPath);
    this.armedRuns.delete(taskFolderPath);
    let clearedByThisOwner = false;
    let stageStillCurrent = false;
    await this.store.patch(vscode.Uri.file(taskFolderPath), current => {
      const run = current.scheduledRun;
      // A stale callback must not consume a replacement schedule created by
      // this same window, nor may it run a stage other than the one selected
      // when the schedule was created.
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

    // A different window can cancel or replace the schedule while this timer
    // is pending. Only the lease owner that cleared its own schedule may run.
    if (clearedByThisOwner && stageStillCurrent) {
      await vscode.commands.executeCommand("vs-code-ai-helper.applyCurrentStageAction", { canonicalId, taskFolderPath });
    } else if (clearedByThisOwner) {
      NotificationRouter.showInformation("Scheduled action was skipped because the task moved to a different stage.");
    }
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
    for (const task of this.inventory.getTasks()) {
      const liveOperations = taskOperations.getTaskOperations(task.taskFolderPath);
      await reconcileRoundLedgerV1({
        taskFolderUri: vscode.Uri.file(task.taskFolderPath),
        hasLiveOperation: liveOperations.length > 0,
        hasLiveSchedulingIntent: hasLiveSchedulingIntentBestEffortV1(task.taskFolderPath),
        liveOperationIds: liveOperations.map((op) => op.id),
        liveSchedulingIntentIds: liveSchedulingIntentIdsBestEffortV1(task.taskFolderPath),
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
   * rule as scheduledRun) and dispatch the chain exactly once. A `dispatched`
   * record is NEVER re-fired — the round it names already started, and edit
   * runs give no idempotency guarantee — but once it is clearly dead (lease
   * long expired) it is surfaced as an actionable state instead of leaving
   * the task indistinguishable from "review paused, waiting on user".
   */
  private async armPendingImplRecoveries(): Promise<void> {
    // A dispatched record's lease dates from the transition, and the round it
    // covers can legitimately run for the full CLI timeout (60 minutes) —
    // only well past that is silence evidence of a dead round.
    const STALE_DISPATCH_GRACE_MS = 90 * 60 * 1000;
    for (const task of this.inventory.getTasks()) {
      const recovery = task.progress.implRecovery;
      if (!recovery) continue;
      if (task.progress.status !== "active") continue;
      if (recovery.dispatch === "dispatched") {
        const anchor = recovery.leaseUntil ?? recovery.at;
        if (
          this.clock.now() > new Date(anchor).getTime() + STALE_DISPATCH_GRACE_MS &&
          !this.staleRecoveryNotified.has(task.taskFolderPath)
        ) {
          this.staleRecoveryNotified.add(task.taskFolderPath);
          NotificationRouter.showWarning(
            `⚠️ A recovery continuation for "${task.progress.displayName ?? task.progress.taskFolder}" ` +
              "was started but never finalized a round (the window running it likely died). " +
              "It will not be re-run automatically — rerun the implementation manually; the " +
              "unreported edits are preserved in pendingImplReviewFiles."
          );
        }
        continue;
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
