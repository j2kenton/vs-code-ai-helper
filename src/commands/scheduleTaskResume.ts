import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgress } from "../utils/taskProgressUtils";

type ScheduleArg = { canonicalId?: string; taskFolderPath?: string; task?: { folderUri: vscode.Uri } };
export interface SchedulerClock { now(): number; setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>; clearTimeout(timer: ReturnType<typeof setTimeout>): void; }
export const systemSchedulerClock: SchedulerClock = { now: () => Date.now(), setTimeout, clearTimeout };

/** Persisted one-shot scheduler. The progress-file lease makes a single window own a timer. */
export class TaskActionScheduler implements vscode.Disposable {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly owner = `${vscode.env.sessionId}:${Math.random().toString(36).slice(2)}`;
  constructor(private readonly inventory: TaskInventory, private readonly clock: SchedulerClock = systemSchedulerClock) {}
  async arm(taskFolderPath: string, canonicalId?: string): Promise<void> {
    const folder = vscode.Uri.file(taskFolderPath);
    const claimed = await patchTaskProgress(folder, progress => {
      const run = progress.scheduledRun;
      if (!run) return progress;
      if (run.leaseUntil && new Date(run.leaseUntil).getTime() > this.clock.now() && run.leaseOwner !== this.owner) return progress;
      return { ...progress, scheduledRun: { ...run, leaseOwner: this.owner, leaseUntil: new Date(this.clock.now() + 60 * 60 * 1000).toISOString() } };
    });
    const run = claimed?.scheduledRun;
    if (!run || run.leaseOwner !== this.owner) return;
    const delay = Math.max(0, new Date(run.runAt).getTime() - this.clock.now());
    const old = this.timers.get(taskFolderPath); if (old) this.clock.clearTimeout(old);
    this.timers.set(taskFolderPath, this.clock.setTimeout(() => void this.fire(taskFolderPath, canonicalId), delay));
  }
  private async fire(taskFolderPath: string, canonicalId?: string): Promise<void> {
    const folder = vscode.Uri.file(taskFolderPath);
    const progress = await patchTaskProgress(folder, current => {
      if (current.scheduledRun?.leaseOwner !== this.owner) return current;
      return { ...current, scheduledRun: undefined, scheduledResumeTime: undefined, updatedAt: new Date(this.clock.now()).toISOString() };
    });
    if (progress && !progress.scheduledRun) await vscode.commands.executeCommand("vs-code-ai-helper.applyCurrentStageAction", { canonicalId, taskFolderPath });
  }
  async armAll(): Promise<void> { for (const task of await this.inventory.getTasks()) await this.arm(task.taskFolderPath, task.canonicalId); }
  async cancel(taskFolderPath: string): Promise<void> { const timer = this.timers.get(taskFolderPath); if (timer) this.clock.clearTimeout(timer); this.timers.delete(taskFolderPath); await patchTaskProgress(vscode.Uri.file(taskFolderPath), p => ({ ...p, scheduledRun: undefined, scheduledResumeTime: undefined, updatedAt: new Date(this.clock.now()).toISOString() })); }
  dispose(): void { for (const timer of this.timers.values()) this.clock.clearTimeout(timer); this.timers.clear(); }
}

export async function scheduleTaskResume(inventory: TaskInventory, scheduler: TaskActionScheduler, arg?: ScheduleArg): Promise<void> {
  const resolverArg = arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg && (arg.canonicalId || arg.taskFolderPath) ? { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath } : undefined;
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: false }); if (!task) return;
  const value = await vscode.window.showInputBox({ prompt: "Schedule current-stage action (ISO date/time)", value: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const runAt = value ? new Date(value) : undefined;
  if (!runAt || Number.isNaN(runAt.getTime()) || runAt.getTime() <= Date.now()) { if (value) void vscode.window.showErrorMessage("Enter a future date/time."); return; }
  await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), p => ({ ...p, scheduledRun: { runAt: runAt.toISOString(), stage: p.currentStage }, scheduledResumeTime: undefined, updatedAt: new Date().toISOString() }));
  await scheduler.arm(task.taskFolderPath, task.canonicalId);
  void vscode.window.showInformationMessage(`Current-stage action scheduled for ${runAt.toLocaleString()}.`);
}
export async function cancelScheduledTaskAction(inventory: TaskInventory, scheduler: TaskActionScheduler, arg?: ScheduleArg): Promise<void> { const task = await resolveTaskContext(inventory, arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg, { allowPaused: true }); if (task) await scheduler.cancel(task.taskFolderPath); }
export function registerScheduleTaskResumeCommand(context: vscode.ExtensionContext, inventory: TaskInventory): TaskActionScheduler {
  const scheduler = new TaskActionScheduler(inventory); context.subscriptions.push(scheduler);
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.scheduleTaskResume", (arg?: ScheduleArg) => scheduleTaskResume(inventory, scheduler, arg)));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.cancelScheduledTaskAction", (arg?: ScheduleArg) => cancelScheduledTaskAction(inventory, scheduler, arg)));
  void scheduler.armAll(); return scheduler;
}
