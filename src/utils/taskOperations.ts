import * as vscode from "vscode";
import * as path from "path";
import { TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "./notificationRouter";
import { normalizePath } from "./taskRoot";
import { OperationKind } from "./operationTaxonomy";

/**
 * Lifecycle states of a tracked operation (contract C1):
 * `running → succeeded | failed | cancelled`. Live operations only ever exist
 * in `running`; the terminal state is recorded at `end()` and delivered via
 * `onDidEnd`. `interrupted` is reserved for entries that were persisted as
 * running and then survived a window reload (the registry itself is
 * in-memory, so it never produces `interrupted` — the notifications surface
 * applies it to stale persisted rows on activation, per contract C5).
 */
export type TaskOperationState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TaskOperationSpec {
  label: string;              // "Run Implementation" — reused by showTaskBusyWarning
  stage?: TaskStage;          // omit for task-level ops (commit/push, mark-done, Release)
  taskName?: string;          // for the Notifications row; defaults to basename(key)
  exclusive?: boolean;        // default true. false = advisory (chat): never refuses/refused,
  /** Taxonomy classification (operationTaxonomy.ts). */
  kind?: OperationKind;
  /**
   * Creates a CancellationTokenSource for this operation. The token is
   * exposed on the handle (and via `tokenFor` for code deep in the stack that
   * never received the handle) so the run it guards can actually be aborted;
   * the Notifications row shows a cancel button for cancellable root
   * operations. Cancel callbacks/token sources live in memory only and are
   * never persisted.
   */
  cancellable?: boolean;
  /**
   * Registers this operation as a child of `parent` (contract C1 nesting):
   * children never contend for the task's exclusive lock (the parent already
   * holds it), never render their own Notifications row, and instead
   * reposition the stage-row spinner onto the actively running sub-stage.
   * Cancelling the parent cascades to its running children.
   */
  parent?: TaskOperationHandle;
}

export interface TaskOperationHandle {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly stage?: TaskStage;
  readonly parentId?: string;
  /** Present when the operation was registered with `cancellable: true`. */
  readonly token?: vscode.CancellationToken;
  report(detail: string | undefined): void;   // live-row sub-text, e.g. "waiting for your answer"
  /**
   * Record the click-to-open target for this operation's terminal
   * Notifications entry (e.g. the vscode.Uri writeRunLog resolved to).
   * Always resolves to the ROOT operation, even when called from a child
   * handle, so a composite still leaves one clickable entry. No-ops
   * predictably (does nothing, no error, no duplicate notification) if the
   * operation has already ended by the time this is called.
   */
  setResultTargetUri(uri: vscode.Uri): void;
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
  readonly kind?: OperationKind;
  readonly parentId?: string;
  readonly cancellable: boolean;
  readonly state: TaskOperationState;
  readonly finishedAt?: number;
  /**
   * Stringified vscode.Uri of the artifact/run-log this operation produced,
   * when known (set via setResultTargetUri/setResultTargetUriForTask). Always
   * recorded on the ROOT operation, even when set from a child, so the one
   * Notifications row for a composite can open the result. Consumers must
   * `vscode.Uri.parse()` this — it is never a bare fsPath like the legacy
   * `filePath` field.
   */
  readonly resultTargetUri?: string;
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
  kind?: OperationKind;
  parentId?: string;
  cancellable: boolean;
  state: TaskOperationState;
  finishedAt?: number;
  resultTargetUri?: string;
}

/**
 * The one canonical task identity key. Delegates to taskRoot's normalizePath so
 * there is a single implementation — a divergence here silently breaks every
 * lookup, which is the exact bug this registry exists to prevent.
 */
export function taskKey(absolutePath: string): string {
  return normalizePath(absolutePath);
}

/**
 * Combine several cancellation tokens into one. Used where a run is guarded
 * both by a native progress token and by the tracked operation's own token
 * (the Notifications-section cancel button), so cancelling from either
 * surface aborts the same underlying run. Call `dispose()` once the run
 * settles so listeners don't leak.
 */
export function linkCancellationTokens(
  ...tokens: (vscode.CancellationToken | undefined)[]
): { token: vscode.CancellationToken; dispose(): void } {
  const source = new vscode.CancellationTokenSource();
  const subs: vscode.Disposable[] = [];
  for (const t of tokens) {
    if (!t) {continue;}
    if (t.isCancellationRequested) {
      source.cancel();
      break;
    }
    subs.push(t.onCancellationRequested(() => source.cancel()));
  }
  return {
    token: source.token,
    dispose: (): void => {
      for (const sub of subs) {sub.dispose();}
      source.dispose();
    },
  };
}

export class TaskOperationRegistry implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  /**
   * Fires the terminal snapshot (state `succeeded`/`failed`/`cancelled`)
   * exactly once per operation, when it ends. This is the observable end of
   * the C1 state machine — notification surfaces can update an in-progress
   * entry in place from it.
   */
  private readonly _onDidEnd = new vscode.EventEmitter<TaskOperationSnapshot>();
  readonly onDidEnd: vscode.Event<TaskOperationSnapshot> = this._onDidEnd.event;

  // Backing store: Map<key, Map<id, operation>>
  private readonly operations = new Map<string, Map<string, MutableOperation>>();
  // Cancel machinery lives beside the record, never on it, so snapshots handed
  // to views cannot reach a token source (cancel goes through cancelOperation).
  private readonly tokenSources = new Map<string, vscode.CancellationTokenSource>();
  private operationSeq = 0;
  private pendingChange = false;

  private triggerChange(): void {
    if (this.pendingChange) {return;}
    this.pendingChange = true;
    queueMicrotask(() => {
      this.pendingChange = false;
      this._onDidChange.fire();
    });
  }

  begin(taskPath: string, spec: TaskOperationSpec): TaskOperationHandle | null {
    const key = taskKey(taskPath);
    const isChild = spec.parent !== undefined;
    // Children never contend for the exclusive lock — the parent already
    // holds it. Registering them exclusive would deadlock every composite.
    const exclusive = !isChild && spec.exclusive !== false;

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
    const cancellable = spec.cancellable === true;

    const operation: MutableOperation = {
      id,
      key,
      label: spec.label,
      stage: spec.stage,
      taskName,
      startedAt,
      exclusive,
      detail: undefined,
      kind: spec.kind,
      parentId: spec.parent?.id,
      cancellable,
      state: "running",
    };

    let keyMap = this.operations.get(key);
    if (!keyMap) {
      keyMap = new Map();
      this.operations.set(key, keyMap);
    }
    keyMap.set(id, operation);

    let token: vscode.CancellationToken | undefined;
    if (cancellable) {
      const cts = new vscode.CancellationTokenSource();
      this.tokenSources.set(id, cts);
      token = cts.token;
    }

    const handle: TaskOperationHandle = {
      id,
      key,
      label: spec.label,
      stage: spec.stage,
      parentId: spec.parent?.id,
      token,
      report: (d: string | undefined) => {
        operation.detail = d;
        this.triggerChange();
      },
      setResultTargetUri: (uri: vscode.Uri) => {
        this.setResultTargetUri(id, uri);
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
   * most one to address here. Child operations are never exclusive, so this
   * always addresses the composite's root row.
   */
  report(taskPath: string, detail: string | undefined): void {
    const key = taskKey(taskPath);
    const exclusiveOp = [...(this.operations.get(key)?.values() ?? [])].find(op => op.exclusive);
    if (!exclusiveOp) {return;}
    exclusiveOp.detail = detail;
    this.triggerChange();
  }

  /**
   * Resolve `id` to its root operation (walking up parentId within the same
   * task) and record the click-to-open target on it. Returns false without
   * side effects when `id` is missing from the registry — meaning the
   * operation is unknown or has already ended — matching the "fails
   * predictably, no duplicate notification" contract (D11).
   */
  setResultTargetUri(id: string, uri: vscode.Uri): boolean {
    if (!uri) {return false;} // Defensive: some callers' writeRunLog can resolve to nothing.
    for (const keyMap of this.operations.values()) {
      let op = keyMap.get(id);
      if (!op) {continue;}
      while (op.parentId !== undefined) {
        const parent = keyMap.get(op.parentId);
        if (!parent) {break;}
        op = parent;
      }
      op.resultTargetUri = uri.toString();
      this.triggerChange();
      return true;
    }
    return false;
  }

  /**
   * Same as `setResultTargetUri`, addressed by task path instead of operation
   * id, for code deep in the stack that never received the operation handle
   * (mirrors `report`/`tokenFor` above). Finds the task's exclusive (root)
   * operation directly — there is at most one, and it never has a parentId.
   */
  setResultTargetUriForTask(taskPath: string, uri: vscode.Uri): boolean {
    if (!uri) {return false;} // Defensive: some callers' writeRunLog can resolve to nothing.
    const key = taskKey(taskPath);
    const exclusiveOp = [...(this.operations.get(key)?.values() ?? [])].find(op => op.exclusive);
    if (!exclusiveOp) {return false;}
    exclusiveOp.resultTargetUri = uri.toString();
    this.triggerChange();
    return true;
  }

  /**
   * The exclusive (root) operation's cancellation token for a task, for code
   * deep in the stack that launches the actual provider process without ever
   * receiving the operation handle (runAiToFile, executeImplementationRun).
   * Linking this into the process's own token makes the Notifications-section
   * cancel button abort the real run, not just hide the row.
   */
  tokenFor(taskPath: string): vscode.CancellationToken | undefined {
    const keyMap = this.operations.get(taskKey(taskPath));
    if (!keyMap) {return undefined;}
    const exclusiveOp = [...keyMap.values()].find(op => op.exclusive);
    return exclusiveOp ? this.tokenSources.get(exclusiveOp.id)?.token : undefined;
  }

  /**
   * The id of a task's live exclusive (root) operation, for code deep in the
   * stack that never received the handle — mirrors `tokenFor`. Used to stamp
   * live progress-summary notifications with `sourceOperationId` at creation
   * time (not just at termination), so the Notifications view can resolve
   * and cancel a still-running operation from its in-progress row, not only
   * after it has already ended. Returns undefined once the operation is no
   * longer registered (ended or never started), matching the "unknown id ⇒
   * no cancel affordance" invariant enforced by the surface that consumes it.
   */
  rootOperationIdFor(taskPath: string): string | undefined {
    const keyMap = this.operations.get(taskKey(taskPath));
    if (!keyMap) {return undefined;}
    const exclusiveOp = [...keyMap.values()].find(op => op.exclusive);
    return exclusiveOp?.id;
  }

  /**
   * Request cancellation of an operation and all of its running descendants
   * (children first, per C1's cascade rule). Returns true when at least one
   * cancellable operation received the request. The operations stay
   * registered (state `running`, detail "cancelling…") until their owners
   * observe the token and call `end()` — cancellation is a request, not a
   * removal.
   */
  cancelOperation(id: string): boolean {
    for (const keyMap of this.operations.values()) {
      const op = keyMap.get(id);
      if (op) {
        const requested = this.cancelSubtree(keyMap, op);
        if (requested) {this.triggerChange();}
        return requested;
      }
    }
    return false;
  }

  private cancelSubtree(keyMap: Map<string, MutableOperation>, op: MutableOperation): boolean {
    let requested = false;
    for (const candidate of keyMap.values()) {
      if (candidate.parentId === op.id) {
        requested = this.cancelSubtree(keyMap, candidate) || requested;
      }
    }
    const cts = this.tokenSources.get(op.id);
    if (cts && !cts.token.isCancellationRequested) {
      op.detail = "cancelling…";
      cts.cancel();
      requested = true;
    }
    return requested;
  }

  end(
    handle: TaskOperationHandle | null | undefined,
    state?: Exclude<TaskOperationState, "running" | "interrupted">
  ): void {
    if (!handle) {return;}
    const keyMap = this.operations.get(handle.key);
    const op = keyMap?.get(handle.id);
    if (!keyMap || !op) {return;}
    keyMap.delete(handle.id);
    if (keyMap.size === 0) {
      this.operations.delete(handle.key);
    }
    const cts = this.tokenSources.get(handle.id);
    // No explicit terminal state ⇒ derive it: an operation whose token was
    // cancelled and then unwound normally still ended by cancellation.
    op.state = state ?? (cts?.token.isCancellationRequested ? "cancelled" : "succeeded");
    op.finishedAt = Date.now();
    if (cts) {
      this.tokenSources.delete(handle.id);
      cts.dispose();
    }
    this._onDidEnd.fire(op);
    this.triggerChange();
  }

  getTaskOperations(taskPath: string): readonly TaskOperationSnapshot[] {
    const key = taskKey(taskPath);
    const keyMap = this.operations.get(key);
    if (!keyMap) {return [];}
    return Array.from(keyMap.values()).sort((a, b) => a.startedAt - b.startedAt);
  }

  getAll(): readonly TaskOperationSnapshot[] {
    const all: TaskOperationSnapshot[] = [];
    for (const keyMap of this.operations.values()) {
      all.push(...keyMap.values());
    }
    return all.sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Root operations only — the ones that render a Notifications row and
   * drive the tasks-view progress line (C1: children never create their own
   * entries). When a root has no live detail of its own, the newest detail
   * among its running descendants is surfaced in its place, so composite
   * rows still show e.g. "waiting for your answer" from a nested run.
   */
  getRootOperations(): readonly TaskOperationSnapshot[] {
    const roots: TaskOperationSnapshot[] = [];
    for (const keyMap of this.operations.values()) {
      const ops = Array.from(keyMap.values());
      for (const op of ops) {
        if (op.parentId !== undefined) {continue;}
        roots.push(
          op.detail !== undefined
            ? op
            : { ...op, detail: this.newestDescendantDetail(ops, op.id) }
        );
      }
    }
    return roots.sort((a, b) => a.startedAt - b.startedAt);
  }

  private newestDescendantDetail(ops: readonly MutableOperation[], rootId: string): string | undefined {
    let best: MutableOperation | undefined;
    const frontier = [rootId];
    while (frontier.length > 0) {
      const parentId = frontier.pop()!;
      for (const op of ops) {
        if (op.parentId !== parentId) {continue;}
        if (op.detail !== undefined && (!best || op.startedAt >= best.startedAt)) {
          best = op;
        }
        frontier.push(op.id);
      }
    }
    return best?.detail;
  }

  /**
   * The stages whose rows should show a spinner for this task: the stages of
   * the *leaf* running operations (operations with no running children).
   * During a composite (fast-forward, apply-review) the spinner therefore
   * sits on the plan/implementation row while the fix is being implemented
   * and moves back to the review row while re-reviewing, instead of parking
   * on the root's stage for the whole run. A leaf without its own stage
   * inherits the nearest ancestor's stage.
   */
  getActiveStages(taskPath: string): readonly TaskStage[] {
    const keyMap = this.operations.get(taskKey(taskPath));
    if (!keyMap) {return [];}
    const ops = Array.from(keyMap.values());
    const parentIds = new Set(
      ops.map(op => op.parentId).filter((id): id is string => id !== undefined)
    );
    const stages = new Set<TaskStage>();
    for (const op of ops) {
      if (parentIds.has(op.id)) {continue;} // has running children — not a leaf
      let node: MutableOperation | undefined = op;
      while (node && node.stage === undefined) {
        node = node.parentId !== undefined ? keyMap.get(node.parentId) : undefined;
      }
      if (node?.stage !== undefined) {stages.add(node.stage);}
    }
    return [...stages];
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
    for (const cts of this.tokenSources.values()) {
      cts.dispose();
    }
    this.tokenSources.clear();
    this._onDidChange.dispose();
    this._onDidEnd.dispose();
  }
}

export const taskOperations = new TaskOperationRegistry();

/**
 * Runs an async operation as a TrackedOperation (contract C1): registers it
 * synchronously at entry (optimistic UI — the spinner and Notifications row
 * appear before any I/O), guarantees the registration is released on every
 * exit path, and records the terminal state (`succeeded`/`failed`/
 * `cancelled`) so `onDidEnd` observers see the real outcome.
 *
 * Composite flows register children by passing `parent` in the spec: children
 * skip the exclusive-lock contention entirely (the root holds the lock),
 * never render their own Notifications row, and move the stage-row spinner
 * onto the actively running sub-stage (see getActiveStages). Cancelling the
 * root cascades to running children (see cancelOperation).
 *
 * On a busy refusal (root operations only), shows the standard busy warning
 * and resolves to `undefined`, matching every existing call site's own
 * `if (!op) { showTaskBusyWarning(...); return; }` convention.
 *
 * Errors thrown by `fn` are NOT swallowed here — the operation is ended with
 * state `failed` (or `cancelled` when its token fired), so the lock can never
 * leak, but the error itself propagates to the caller. Most existing call
 * sites have their own error handling deeply nested inside their operation
 * body (persisting failure state, tailored user-facing messages);
 * auto-catching here would silently change that behavior for every future
 * caller.
 */
export async function runTrackedOperation<T>(
  taskPath: string,
  spec: TaskOperationSpec,
  fn: (handle: TaskOperationHandle) => Promise<T>
): Promise<T | undefined> {
  const handle = taskOperations.begin(taskPath, spec);
  if (!handle) {
    showTaskBusyWarning(taskPath);
    return undefined;
  }
  try {
    const result = await fn(handle);
    taskOperations.end(handle); // derives cancelled vs succeeded from the token
    return result;
  } catch (error) {
    const cancelled =
      error instanceof vscode.CancellationError ||
      handle.token?.isCancellationRequested === true;
    taskOperations.end(handle, cancelled ? "cancelled" : "failed");
    throw error;
  }
}

export function showTaskBusyWarning(taskPath: string): void {
  const label = taskOperations.busyLabel(taskPath) ?? "An operation";
  NotificationRouter.showInformation(
    `${label} is already in progress for this task. Please wait for it to finish.`
  );
}
