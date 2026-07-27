import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgress } from "../utils/taskProgressUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { LegacyCreatingStartupGateV0 } from "../state/legacyCreatingStartupGateV0";

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
const progressStore: SchedulerProgressStore = { patch: patchTaskProgress };
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
  await LegacyCreatingStartupGateV0.waitUntilReady();

  const resolverArg = arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg && (arg.canonicalId || arg.taskFolderPath) ? { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath } : undefined;
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: false });
  if (!task) return;
  const value = await vscode.window.showInputBox({ prompt: "Schedule current-stage action (ISO date/time)", value: new Date(clock.now() + LEASE_DURATION_MS).toISOString() });
  const runAt = value ? new Date(value) : undefined;
  if (!runAt || Number.isNaN(runAt.getTime()) || runAt.getTime() <= clock.now()) {
    if (value) NotificationRouter.showWarning("Enter a future date/time.");
    return;
  }
  await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), p => ({ ...p, scheduledRun: { runAt: runAt.toISOString(), stage: p.currentStage }, scheduledResumeTime: undefined, updatedAt: new Date(clock.now()).toISOString() }));
  await scheduler.arm(task.taskFolderPath, task.canonicalId);
  NotificationRouter.showInformation(`Current-stage action scheduled for ${runAt.toLocaleString()}.`);
}

export async function cancelScheduledTaskAction(inventory: TaskInventory, scheduler: TaskActionScheduler, arg?: ScheduleArg): Promise<void> {
  // Same activation-barrier contract as scheduleTaskResume above (plan §1.4).
  await LegacyCreatingStartupGateV0.waitUntilReady();
  const task = await resolveTaskContext(inventory, arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg, { allowPaused: true });
  if (task) await scheduler.cancel(task.taskFolderPath);
}

export function registerScheduleTaskResumeCommand(context: vscode.ExtensionContext, inventory: TaskInventory): TaskActionScheduler {
  const scheduler = new TaskActionScheduler(inventory);
  context.subscriptions.push(scheduler);
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.scheduleTaskResume", (arg?: ScheduleArg) => scheduleTaskResume(inventory, scheduler, arg)));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.cancelScheduledTaskAction", (arg?: ScheduleArg) => cancelScheduledTaskAction(inventory, scheduler, arg)));
  return scheduler;
}
