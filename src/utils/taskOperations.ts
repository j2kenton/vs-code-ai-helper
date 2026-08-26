import * as vscode from "vscode";
import * as path from "path";
import { ImplRecoveryV1, MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1, TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "./notificationRouter";
import { normalizePath } from "./taskRoot";
import { OperationKind } from "./operationTaxonomy";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { describeOwedContinuationRefusalV1 } from "./owedContinuationRefusalV1";
import { writeRunLog } from "./runLog";

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
  /**
   * Default true. false = advisory (chat, rename): holds no claim on the
   * task's exclusive lock — it is never refused by, and never refuses, an
   * exclusive operation on lock grounds. Advisory operations can still be
   * excluded selectively (in both directions) via `conflictKeys` below.
   */
  exclusive?: boolean;
  /** Taxonomy classification (operationTaxonomy.ts). */
  kind?: OperationKind;
  /**
   * Selective mutual exclusion, orthogonal to `exclusive`: `begin` refuses a
   * root operation when any active operation on the same task shares one of
   * its conflict keys — even when neither side holds the exclusive lock.
   * This is how two non-exclusive-vs-exclusive operations that mutate the
   * same task field (e.g. the display name) are kept from overlapping
   * ATOMICALLY at admission, instead of via a caller-side check that a later
   * `begin` could race past. Children never declare conflicts (the parent's
   * admission already covered them).
   */
  conflictKeys?: readonly string[];
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
   * Mark this operation as blocked on the user, not doing background work —
   * e.g. a round-limit pause or a chat question the AI can't proceed past.
   * Distinct from `detail` (which is just display text): views use this flag
   * to swap the spinning "in progress" icon for a non-spinning "waiting"
   * one, since a spinner over something that is actually sitting idle for a
   * human response reads as "the computer is working, leave it alone" —
   * exactly backwards. Toggle back to `false` once work resumes (the user
   * answered, or the operation is proceeding without them).
   */
  setWaitingForUser(waiting: boolean): void;
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
  /** See TaskOperationHandle.setWaitingForUser. */
  readonly waitingForUser: boolean;
  /** See TaskOperationSpec.conflictKeys. */
  readonly conflictKeys?: readonly string[];
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
  waitingForUser: boolean;
  conflictKeys?: readonly string[];
}

/**
 * Conflict key shared by the operations that must never overlap around the
 * task's display name: Rename Task and Rename Task with AI (which write it)
 * and Task Description generation (which never writes it — naming is owned
 * exclusively by the rename actions, per handleDraftOutcomeV1 in
 * draftTaskWithAI.ts — but runs under the name captured at admission, so a
 * mid-run rename would desync its Notifications row, chat labels, and run
 * log). Declaring it on both sides makes rename-vs-description exclusion
 * atomic at `begin`, closing the window where a description run could start
 * while the rename dialog (or AI naming) is still in flight.
 */
export const TASK_NAME_WRITE_CONFLICT_KEY = "task-name-write";

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

/**
 * Render a task name for user-facing display, wrapped in straight double
 * quotes: Notifications rows and terminal entries read `Rename Task —
 * "ff for 1 pt 2": completed`. The semantic `taskName` stored on operation
 * snapshots (and in persisted entries) stays unquoted — quoting happens only
 * at the render boundary, so historical data never carries quote characters.
 */
export function formatTaskNameForDisplay(taskName: string): string {
  return `"${taskName}"`;
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

    // Admission is a single synchronous check, so both refusal rules below
    // are atomic with registration — nothing can slip in between.
    const conflictKeys = isChild ? undefined : spec.conflictKeys;
    if (!isChild) {
      const active = this.operations.get(key);
      if (active) {
        for (const snap of active.values()) {
          // Rule 1: at most one exclusive operation per task.
          if (exclusive && snap.exclusive) {
            return null; // Refused
          }
          // Rule 2: no two operations sharing a conflict key, regardless of
          // exclusivity (see TaskOperationSpec.conflictKeys).
          if (
            conflictKeys &&
            snap.conflictKeys?.some((k) => conflictKeys.includes(k))
          ) {
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
      waitingForUser: false,
      conflictKeys,
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
      setWaitingForUser: (waiting: boolean) => {
        operation.waitingForUser = waiting;
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
   * Same as `report`, addressed by task path, for `setWaitingForUser` —
   * mirrors why `report(taskPath, ...)` exists alongside the handle's own
   * `report`: some pause points (e.g. quota.ts's prompt) are deep in the
   * stack without the operation handle in scope.
   */
  setWaitingForUser(taskPath: string, waiting: boolean): void {
    const key = taskKey(taskPath);
    const exclusiveOp = [...(this.operations.get(key)?.values() ?? [])].find(op => op.exclusive);
    if (!exclusiveOp) {return;}
    exclusiveOp.waitingForUser = waiting;
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
   * The leaf running operations for a task (operations with no running
   * children) — shared by getActiveStages/getWaitingStages so "which stage
   * does this leaf's spinner belong to" logic lives in exactly one place.
   */
  private leafStages(taskPath: string, predicate: (op: MutableOperation) => boolean): TaskStage[] {
    const keyMap = this.operations.get(taskKey(taskPath));
    if (!keyMap) {return [];}
    const ops = Array.from(keyMap.values());
    const parentIds = new Set(
      ops.map(op => op.parentId).filter((id): id is string => id !== undefined)
    );
    const stages = new Set<TaskStage>();
    for (const op of ops) {
      if (parentIds.has(op.id)) {continue;} // has running children — not a leaf
      if (!predicate(op)) {continue;}
      let node: MutableOperation | undefined = op;
      while (node && node.stage === undefined) {
        node = node.parentId !== undefined ? keyMap.get(node.parentId) : undefined;
      }
      if (node?.stage !== undefined) {stages.add(node.stage);}
    }
    return [...stages];
  }

  /**
   * The stages whose rows should show a SPINNER for this task: the stages of
   * the *leaf* running operations (operations with no running children) that
   * are NOT waiting on the user. During a composite (fast-forward,
   * apply-review) the spinner therefore sits on the plan/implementation row
   * while the fix is being implemented and moves back to the review row
   * while re-reviewing, instead of parking on the root's stage for the whole
   * run. A leaf without its own stage inherits the nearest ancestor's stage.
   * See getWaitingStages for the complementary "waiting, not spinning" set.
   */
  getActiveStages(taskPath: string): readonly TaskStage[] {
    return this.leafStages(taskPath, (op) => !op.waitingForUser);
  }

  /**
   * The stages whose rows should show the "waiting for you" indicator
   * instead of a spinner — the leaf running operations that ARE waiting on
   * the user. Disjoint from getActiveStages: a leaf op is in exactly one of
   * the two sets.
   */
  getWaitingStages(taskPath: string): readonly TaskStage[] {
    return this.leafStages(taskPath, (op) => op.waitingForUser);
  }

  hasAny(): boolean {
    return this.operations.size > 0;
  }

  /**
   * True when at least one root operation, anywhere, is doing real
   * background work — i.e. NOT just sitting waiting for a user response.
   * Used to decide whether the activity-bar badge should show a live
   * progress indicator (real work running) or fall back to the idle task
   * count (nothing running, or everything running is actually waiting on
   * the user and therefore not "in progress" from the user's perspective).
   */
  hasAnyRunning(): boolean {
    for (const keyMap of this.operations.values()) {
      for (const op of keyMap.values()) {
        if (op.parentId === undefined && !op.waitingForUser) {return true;}
      }
    }
    return false;
  }

  busyLabel(taskPath: string): string | undefined {
    const ops = this.getTaskOperations(taskPath);
    // A refusal is usually the exclusive lock, but a conflict-key refusal can
    // name a non-exclusive root (e.g. "Draft Task with AI" refused while a
    // rename runs) — fall back to any root so the warning stays specific.
    const exclusiveOp = ops.find(o => o.exclusive) ?? ops.find(o => o.parentId === undefined);
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
    await showTaskBusyWarning(taskPath);
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

/**
 * Request cancellation of every running operation for the task and wait
 * (bounded) for the operations to actually terminate. Shared by every
 * caller that must guarantee no live process keeps running against a task
 * before proceeding — archiving, and stage-transition handlers ("Set as
 * Current Stage", "Complete Stage & Move On") that must abort whatever the
 * previous stage was still doing before touching progress state or (for
 * "Complete Stage & Move On") dispatching the next stage's own automation.
 */
export async function cancelRunningOperationsForTask(
  taskFolderPath: string,
  timeoutMs = 15_000
): Promise<{ ok: boolean; reason?: string }> {
  const ops = taskOperations.getTaskOperations(taskFolderPath);
  if (ops.length === 0) {
    return { ok: true };
  }

  const roots = ops.filter((op) => op.parentId === undefined);
  const uncancellable = roots.filter((op) => !op.cancellable);
  for (const op of roots) {
    taskOperations.cancelOperation(op.id);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (taskOperations.getTaskOperations(taskFolderPath).length === 0) {
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    ok: false,
    reason: uncancellable.length > 0
      ? `"${uncancellable[0]?.label}" cannot be cancelled — wait for it to finish, then try again.`
      : "The running operation did not stop in time. Try again once it has finished.",
  };
}

/**
 * True when the task has at least one live operation of `kind` whose stage —
 * translated through `translateStage` — targets `targetStage`. Shared by
 * review status display (reviewActions.ts's `isReviewActivelyRerunningV1` and
 * taskTreeProvider.ts's StageNode) to tell "a rerun of THIS stage is
 * genuinely in flight right now" apart from a merely-stale artifact with
 * nothing running.
 *
 * `translateStage` exists because an operation's own recorded `stage` can
 * still be a PRE-review stage (`plan`, `impl`, `publish`) when a rerun was
 * launched before the task advanced onto its review stage — a raw
 * `stage === targetStage` comparison would miss that case.
 *
 * `matchWaiting` optionally narrows by `op.waitingForUser`: omitted (the
 * `isReviewActivelyRerunningV1` placeholder/banner-lifecycle use) matches
 * either state, because a review paused on a question or round-limit is
 * still genuinely in flight and must keep showing "Review in progress" —
 * not reverted stale — until it actually finishes. `false` or `true` (the
 * StageNode tree-row use) narrows to spinning-only or waiting-only so the
 * row can tell the two apart, matching the disjoint running/waiting split
 * `getActiveStages`/`getWaitingStages` already use for non-review stages.
 */
export function hasActiveOperationTargetingStage(
  taskPath: string,
  kind: OperationKind,
  targetStage: TaskStage,
  translateStage: (stage: TaskStage) => TaskStage | undefined,
  matchWaiting?: boolean
): boolean {
  return taskOperations
    .getTaskOperations(taskPath)
    .some(
      (op) =>
        op.kind === kind &&
        op.stage !== undefined &&
        translateStage(op.stage) === targetStage &&
        (matchWaiting === undefined || op.waitingForUser === matchWaiting)
    );
}

/**
 * Show the busy refusal for a task whose exclusive lock is already held.
 *
 * When the task carries an owed implementation continuation (`implRecovery`),
 * the generic "already in progress" line is replaced with the plain-language
 * explainer (`describeOwedContinuationRefusalV1`) naming the blocker, the
 * lease's wall-clock expiry, the quarantined files behind it, and what to do
 * — see that function's doc comment for the incident this answers. A visible
 * "declined" run-log entry is also recorded in that case, so the refusal is
 * legible in task history rather than the silent gap a busy refusal
 * otherwise leaves (no provider is ever invoked, so nothing else logs it).
 * Both reads are best-effort: a task whose progress cannot be read, or that
 * carries no `implRecovery` record, falls back to the plain busy message
 * exactly as before.
 */
/**
 * Per-task guard for `armReleaseTriggeredContinuationRetryV1` below — at most
 * one retry armed per task at a time, so repeated busy refusals for the same
 * owed continuation while its blocker is still live (e.g. several UI actions
 * clicked in the same window) do not stack up multiple duplicate re-dispatch
 * listeners, all of which would otherwise fire the instant the blocker
 * finally clears.
 */
const armedContinuationRetries = new Set<string>();

/**
 * wf10 item 11's release-triggered retry: when the busy guard refuses a
 * dispatch while a continuation is owed and still `"pending"` (not yet
 * claimed by a running round), arm a ONE-SHOT listener that re-dispatches the
 * continuation itself the moment this task's exclusive lock is next
 * released, instead of leaving the record to sit until
 * `RECOVERY_TRANSITION_LEASE_MS` (10 minutes) expires and a sweep reclaims
 * it.
 *
 * The observed incident (2026-08-21): the in-process hand-off
 * (`scheduleAutomationChain`, fired the instant the round that needed
 * recovery ended) lost a race against an unrelated sibling operation (Fast
 * Forward Review) that was still finishing against the SAME task and had not
 * yet released the exclusive lock — that sibling deregistered a fraction of
 * a second later, but nothing was listening for it, so the continuation sat
 * "pending" for the full ten-minute lease.
 *
 * Deliberately does NOT retry the specific command that was refused (this
 * function has no way to know what that was — `showTaskBusyWarning` is
 * called generically from many sites) and does NOT re-check the caller's
 * intent. It always re-dispatches the canonical continuation command
 * (`runImplementationWithAI` with `automationDispatch: true`), because that
 * is the actual owed work regardless of which action happened to trip the
 * busy guard — matching the shape of `implementationRecoveryV1.ts`'s own
 * `finishDispatch`. Re-checks `dispatch === "pending"` at fire time (not just
 * at arm time) so a continuation claimed or cleared by some other path in the
 * meantime is not redundantly re-run.
 *
 * The continuation is NOT exempted from the busy guard itself — this only
 * shortens the wait once the guard's blocker actually clears, it never lets
 * the continuation bypass a lock still legitimately held (re-entrancy risk
 * the plan explicitly calls out). The lease sweep (`scheduleTaskResume.ts`)
 * remains as backstop if this listener itself never fires (e.g. the window
 * closes before the blocker clears).
 *
 * **No-lost-wakeup:** this is called only after `showTaskBusyWarning`'s own
 * async progress read resolves, so the blocking operation can already have
 * deregistered DURING that read — before this function ever subscribes.
 * `TaskOperationsRegistry.end()` removes the operation from the registry
 * before firing `onDidEnd` (both synchronous, no await between them), so
 * checking `getTaskOperations` immediately after subscribing below is
 * exactly as current as the subscription itself: if the release already
 * happened, that check sees the now-empty registry and fires right away
 * instead of waiting on an `onDidEnd` event that has already come and gone
 * (review-flagged, 2026-08-25 — the original fix only listened for a FUTURE
 * release and missed exactly this window).
 */
function armReleaseTriggeredContinuationRetryV1(taskPath: string): void {
  const key = taskKey(taskPath);
  if (armedContinuationRetries.has(key)) {
    return;
  }
  armedContinuationRetries.add(key);

  const fire = (): void => {
    armedContinuationRetries.delete(key);
    void (async (): Promise<void> => {
      try {
        const strict = await readTaskProgressStrictV1(vscode.Uri.file(taskPath), {
          expectedTaskFolder: path.basename(taskPath),
        });
        if (!strict.ok || strict.decoded.progress.implRecovery?.dispatch !== "pending") {
          return; // Already claimed or cleared by another path — nothing owed anymore.
        }
      } catch {
        // Best-effort re-check; fall through and let the command's own
        // routing decide, matching every other best-effort read in this file.
      }
      void vscode.commands.executeCommand("vs-code-ai-helper.runImplementationWithAI", {
        taskFolderPath: taskPath,
        automationDispatch: true,
      });
    })();
  };

  const sub = taskOperations.onDidEnd((snapshot) => {
    if (snapshot.key !== key) {
      return;
    }
    // A composite operation can end a CHILD while the root (and the
    // exclusive lock) is still held — only fire once the task is fully free.
    if (taskOperations.getTaskOperations(taskPath).length > 0) {
      return;
    }
    sub.dispose();
    fire();
  });

  // Closes the lost-wakeup window documented above: if the task is already
  // free by the time we finish subscribing, the release we needed already
  // happened and no future `onDidEnd` for it will ever come.
  if (taskOperations.getTaskOperations(taskPath).length === 0) {
    sub.dispose();
    fire();
  }
}

export async function showTaskBusyWarning(taskPath: string): Promise<void> {
  const label = taskOperations.busyLabel(taskPath) ?? "An operation";
  const genericMessage = `${label} is already in progress for this task. Please wait for it to finish.`;

  let record: ImplRecoveryV1 | undefined;
  let pendingFiles: readonly string[] = [];
  let stage: TaskStage | undefined;
  let continuations = 0;
  try {
    const folderUri = vscode.Uri.file(taskPath);
    const strict = await readTaskProgressStrictV1(folderUri, {
      expectedTaskFolder: path.basename(taskPath),
    });
    if (strict.ok) {
      record = strict.decoded.progress.implRecovery;
      pendingFiles = strict.decoded.progress.pendingImplReviewFiles ?? [];
      stage = strict.decoded.progress.currentStage;
      continuations = strict.decoded.progress.incompleteRoundContinuations ?? 0;
    }
  } catch {
    // Best-effort only — fall back to the generic message below.
  }

  if (!record) {
    NotificationRouter.showInformation(genericMessage);
    return;
  }

  const explained = describeOwedContinuationRefusalV1(record, pendingFiles, continuations);
  NotificationRouter.showInformation(explained);
  if (record.dispatch === "pending" && continuations < MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1) {
    // Same branch describeOwedContinuationRefusalV1 already tells the user
    // "will be retried automatically once any existing lease clears" for —
    // this is what makes that true immediately instead of only after the
    // lease's full 10-minute ceiling.
    armReleaseTriggeredContinuationRetryV1(taskPath);
  }
  try {
    await writeRunLog(
      vscode.Uri.file(taskPath),
      "declined",
      stage ?? "impl",
      `# Action Declined\n\nStatus: declined (owed continuation)\n\n${explained}`
    );
  } catch {
    // The declined-with-reason history entry is a courtesy record — a
    // failure to write it must never turn an already-shown refusal into an
    // unhandled error.
  }
}
