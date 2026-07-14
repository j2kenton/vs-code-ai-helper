import * as vscode from "vscode";
import * as path from "path";
import { TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "./notificationRouter";
import { normalizePath } from "./taskRoot";

export interface TaskOperationSpec {
  label: string;              // "Run Implementation" — reused by showTaskBusyWarning
  stage?: TaskStage;          // omit for task-level ops (commit/push, mark-done, Release)
  taskName?: string;          // for the Notifications row; defaults to basename(key)
  exclusive?: boolean;        // default true. false = advisory (chat): never refuses/refused,
}

export interface TaskOperationHandle {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly stage?: TaskStage;
  report(detail: string | undefined): void;   // live-row sub-text, e.g. "waiting for your answer"
}

export interface TaskOperationSnapshot {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly stage?: TaskStage;
  readonly taskName: string;
  readonly startedAt: number;
  readonly detail?: string;
  readonly exclusive: boolean;
}

/**
 * Internal, mutable form of an operation. Structurally assignable to the
 * readonly TaskOperationSnapshot, so the registry can mutate `detail` in place
 * while every public accessor hands out the readonly view.
 */
interface MutableOperation {
  id: string;
  key: string;
  label: string;
  stage?: TaskStage;
  taskName: string;
  startedAt: number;
  detail?: string;
  exclusive: boolean;
}

/**
 * The one canonical task identity key. Delegates to taskRoot's normalizePath so
 * there is a single implementation — a divergence here silently breaks every
 * lookup, which is the exact bug this registry exists to prevent.
 */
export function taskKey(absolutePath: string): string {
  return normalizePath(absolutePath);
}

export class TaskOperationRegistry implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  // Backing store: Map<key, Map<id, operation>>
  private readonly operations = new Map<string, Map<string, MutableOperation>>();
  private operationSeq = 0;
  private pendingChange = false;

  private triggerChange(): void {
    if (this.pendingChange) return;
    this.pendingChange = true;
    queueMicrotask(() => {
      this.pendingChange = false;
      this._onDidChange.fire();
    });
  }

  begin(taskPath: string, spec: TaskOperationSpec): TaskOperationHandle | null {
    const key = taskKey(taskPath);
    const exclusive = spec.exclusive !== false;

    if (exclusive) {
      // Check if there is already an exclusive operation on this key
      const active = this.operations.get(key);
      if (active) {
        for (const snap of active.values()) {
          if (snap.exclusive) {
            return null; // Refused
          }
        }
      }
    }

    const id = `op-${++this.operationSeq}`;
    const taskName = spec.taskName ?? path.basename(taskPath);
    const startedAt = Date.now();

    const operation: MutableOperation = {
      id,
      key,
      label: spec.label,
      stage: spec.stage,
      taskName,
      startedAt,
      exclusive,
      detail: undefined,
    };

    let keyMap = this.operations.get(key);
    if (!keyMap) {
      keyMap = new Map();
      this.operations.set(key, keyMap);
    }
    keyMap.set(id, operation);

    const handle: TaskOperationHandle = {
      id,
      key,
      label: spec.label,
      stage: spec.stage,
      report: (d: string | undefined) => {
        operation.detail = d;
        this.triggerChange();
      }
    };

    this.triggerChange();
    return handle;
  }

  /**
   * Set the live-row detail for a task's exclusive operation, for callers deep
   * in the stack that never received the handle (e.g. the quota prompt).
   *
   * `begin` refuses a second exclusive operation on the same key, so there is at
   * most one to address here.
   */
  report(taskPath: string, detail: string | undefined): void {
    const key = taskKey(taskPath);
    const exclusiveOp = [...(this.operations.get(key)?.values() ?? [])].find(op => op.exclusive);
    if (!exclusiveOp) return;
    exclusiveOp.detail = detail;
    this.triggerChange();
  }

  end(handle: TaskOperationHandle | null | undefined): void {
    if (!handle) return;
    const keyMap = this.operations.get(handle.key);
    if (keyMap) {
      if (keyMap.delete(handle.id)) {
        if (keyMap.size === 0) {
          this.operations.delete(handle.key);
        }
        this.triggerChange();
      }
    }
  }

  getTaskOperations(taskPath: string): readonly TaskOperationSnapshot[] {
    const key = taskKey(taskPath);
    const keyMap = this.operations.get(key);
    if (!keyMap) return [];
    return Array.from(keyMap.values()).sort((a, b) => a.startedAt - b.startedAt);
  }

  getAll(): readonly TaskOperationSnapshot[] {
    const all: TaskOperationSnapshot[] = [];
    for (const keyMap of this.operations.values()) {
      all.push(...keyMap.values());
    }
    return all.sort((a, b) => a.startedAt - b.startedAt);
  }

  hasAny(): boolean {
    return this.operations.size > 0;
  }

  busyLabel(taskPath: string): string | undefined {
    const ops = this.getTaskOperations(taskPath);
    const exclusiveOp = ops.find(o => o.exclusive);
    return exclusiveOp?.label;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export const taskOperations = new TaskOperationRegistry();

export function showTaskBusyWarning(taskPath: string): void {
  const label = taskOperations.busyLabel(taskPath) ?? "An operation";
  NotificationRouter.showInformation(
    `${label} is already in progress for this task. Please wait for it to finish.`
  );
}
