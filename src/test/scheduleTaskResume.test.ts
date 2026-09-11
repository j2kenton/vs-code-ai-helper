import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import {
  QUOTA_RESUME_SCHEDULE_BUFFER_MS,
  SchedulerClock,
  SchedulerProgressStore,
  scheduleQuotaResumeAtV1,
  TaskActionScheduler,
} from "../commands/scheduleTaskResume";
import { TaskProgress } from "../types/taskProgress";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";
import { resetAutomationChainGuards } from "../utils/automationChain";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1,
} from "../utils/taskWatchdogV1";
import {
  acquireWorkAdmissionV1,
  beginTargetResolutionV1,
  endTargetResolutionV1,
  resetTargetResolutionForTestV1,
  setWorkAdmissionFsFailureInjectionForTestV1,
  setWorkAdmissionRootOverrideForTestV1,
  WorkAdmissionResultV1,
} from "../state/workAdmissionV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";

/**
 * The watchdog-sweep tests below exercise `detectAndRepairStalledActiveTasksV1`,
 * which (v1 fixes item 1, Part 1a step 4) now acquires a real, on-disk
 * `pauseCommit` work-admission claim before committing a pause. These tests'
 * `taskFolderPath` fixtures (e.g. `"C:\\tasks\\task"`) are placeholders, not
 * real directories — without this override, that real filesystem I/O would
 * land on an arbitrary, non-task-owned host path instead of a disposable temp
 * directory. Installed once for the whole file; every test's fixture path is
 * redirected to its own subdirectory under one temp root, torn down after the
 * suite finishes.
 */
const admissionTestRootV1 = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-admission-test-"));
setWorkAdmissionRootOverrideForTestV1((taskFolderPath) =>
  path.join(admissionTestRootV1, Buffer.from(taskFolderPath).toString("hex"))
);
after(() => {
  setWorkAdmissionRootOverrideForTestV1(undefined);
  fs.rmSync(admissionTestRootV1, { recursive: true, force: true });
});

class FakeClock implements SchedulerClock {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  constructor(private value: number) {}

  now(): number { return this.value; }
  setTimeout(callback: () => void, _delay: number): ReturnType<typeof setTimeout> {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.callbacks.delete(timer as unknown as number);
  }
  fireNext(): void {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    assert.ok(next, "expected an armed timer");
    this.callbacks.delete(next[0]);
    next[1]();
  }
}

function scheduledProgress(stage: TaskProgress["currentStage"]): TaskProgress {
  return {
    taskFolder: "task",
    currentStage: stage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scheduledRun: {
      runAt: "2026-01-01T00:01:00.000Z",
      stage,
    },
  };
}

function memoryStore(value: TaskProgress): { store: SchedulerProgressStore; current: () => TaskProgress } {
  let progress = value;
  return {
    store: {
      patch: (_folder, update) => {
        progress = update(progress);
        return Promise.resolve(progress);
      },
    },
    current: () => progress,
  };
}

void test("scheduled action is skipped if the task moves to another stage before firing", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const window = vscode.window as unknown as { showInformationMessage: () => unknown };
  const original = commands.executeCommand;
  const originalInfo = window.showInformationMessage;
  let executed = false;
  commands.executeCommand = (() => {
    executed = true;
    return Promise.resolve(undefined);
  }) as typeof commands.executeCommand;
  window.showInformationMessage = () => undefined;
  const surface: StatusSurface = { addEntry(): void {} };
  initNotificationRouter(surface);

  try {
    await scheduler.arm("C:\\tasks\\task", "task-id");
    await state.store.patch(vscode.Uri.file("C:\\tasks\\task"), current => ({ ...current, currentStage: "impl" }));
    clock.fireNext();
    // fire() now acquires real, disk-backed work admission before consuming
    // scheduledRun (v1 fixes item 1, Part 1a step 6) — a fixed number of
    // ticks cannot be trusted to outlast that I/O, so wait on the scheduler's
    // own test-only signal that firing has actually settled.
    await scheduler.waitForPendingFiresForTestV1();

    assert.equal(executed, false);
    assert.equal(state.current().scheduledRun, undefined);
  } finally {
    commands.executeCommand = original;
    window.showInformationMessage = originalInfo;
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("scheduled action runs when the scheduled stage is still current", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  let command: string | undefined;
  commands.executeCommand = ((id: string) => {
    command = id;
    // `applyCurrentStageAction` now reports back whether it actually
    // dispatched a downstream stage action (2026-09-09 review completion
    // blocker: "scheduled firing does not dispatch-or-retain") — `fire()`
    // restores `scheduledRun` on anything other than `true`, so this stub
    // must resolve `true` for this test to observe the schedule cleared.
    return Promise.resolve(id === "vs-code-ai-helper.applyCurrentStageAction" ? true : undefined);
  }) as typeof commands.executeCommand;

  try {
    await scheduler.arm("C:\\tasks\\task", "task-id");
    clock.fireNext();
    // fire() now acquires real, disk-backed work admission before consuming
    // scheduledRun (v1 fixes item 1, Part 1a step 6) — see the identical note
    // in the previous test.
    await scheduler.waitForPendingFiresForTestV1();

    assert.equal(command, "vs-code-ai-helper.applyCurrentStageAction");
    assert.equal(state.current().scheduledRun, undefined);
  } finally {
    commands.executeCommand = original;
    scheduler.dispose();
  }
});

void test("scheduled firing restores the schedule when applyCurrentStageAction refuses without throwing (2026-09-09 review completion blocker: dispatch-or-retain)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  const surface: StatusSurface = { addEntry(): void {} };
  initNotificationRouter(surface);
  // Simulates a downstream refusal that never throws — e.g. the task is
  // still paused (`scheduleQuotaResumeAtV1` deliberately allows arming a
  // schedule against a paused task) or a downstream command observed this
  // call's own admission marker as busy and refused. Before this fix, a
  // `false`/non-boolean return was indistinguishable from success and the
  // schedule was silently lost.
  commands.executeCommand = (() => Promise.resolve(false)) as typeof commands.executeCommand;

  try {
    await scheduler.arm("C:\\tasks\\task", "task-id");
    clock.fireNext();
    await scheduler.waitForPendingFiresForTestV1();

    assert.deepEqual(state.current().scheduledRun, { runAt: "2026-01-01T00:01:00.000Z", stage: "plan" });
  } finally {
    commands.executeCommand = original;
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("a live lease held by another window prevents this scheduler from arming", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const progress = scheduledProgress("plan");
  progress.scheduledRun = {
    ...progress.scheduledRun!,
    leaseOwner: "other-window",
    leaseUntil: "2026-01-01T00:30:00.000Z",
  };
  const state = memoryStore(progress);
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");

  await scheduler.arm("C:\\tasks\\task", "task-id");

  assert.equal(state.current().scheduledRun?.leaseOwner, "other-window");
  assert.equal(state.current().scheduledRun?.leaseUntil, "2026-01-01T00:30:00.000Z");
  assert.throws(() => clock.fireNext(), /expected an armed timer/);
  scheduler.dispose();
});

void test("disposing releases only leases owned by this scheduler", () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const owned = scheduledProgress("plan");
  owned.scheduledRun = { ...owned.scheduledRun!, leaseOwner: "test-owner", leaseUntil: "2026-01-01T01:00:00.000Z" };
  const other = scheduledProgress("plan");
  other.scheduledRun = { ...other.scheduledRun!, leaseOwner: "other-window", leaseUntil: "2026-01-01T01:00:00.000Z" };
  const patchCalls: string[] = [];
  const inventory = {
    getTasks: () => [
      { taskFolderPath: "C:\\tasks\\owned", progress: owned },
      { taskFolderPath: "C:\\tasks\\other", progress: other },
      { taskFolderPath: "C:\\tasks\\unscheduled", progress: scheduledProgress("plan") },
    ],
  } as unknown as TaskInventory;
  const store: SchedulerProgressStore = {
    patch: (folder, update) => {
      patchCalls.push(folder.fsPath);
      return Promise.resolve(update(owned));
    },
  };

  new TaskActionScheduler(inventory, clock, store, "test-owner").dispose();

  assert.deepEqual(patchCalls, ["C:\\tasks\\owned"]);
});

/**
 * `scheduleQuotaResumeAtV1` — unlike the rest of this file's tests — writes
 * through the REAL disk-backed `patchTaskProgressStrictV1` (exactly like the
 * interactive `scheduleTaskResume` it mirrors), and `resolveTaskContext`
 * additionally requires the task folder to actually exist on disk
 * (`fs.existsSync`). A real temp folder with a real `task-progress.json` is
 * therefore required here — the in-memory `memoryStore` fixture used by the
 * rest of this file does not apply.
 */
/**
 * `withTaskLock` derives its shared session lock TWO levels above the task
 * folder (see taskFolderFixture.ts's `makeOwnedTaskFolder` doc comment) — a
 * task folder created only one level under `os.tmpdir()` shares that lock
 * file with every other concurrently-running `node --test` worker process,
 * and `PrimarySessionLock` throws on a concurrently-held lease. Nest the
 * fixture three levels deep (mkdtemp container / "tasks" / task folder),
 * exactly like `makeOwnedTaskFolder`, so this test's lock paths stay private.
 */
function createRealTaskFolderV1(stage: TaskProgress["currentStage"]): {
  taskFolderPath: string;
  progressPath: string;
  cleanup: () => void;
} {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-quota-resume-"));
  const taskFolderPath = path.join(container, "tasks", `${path.basename(container)}-task`);
  fs.mkdirSync(taskFolderPath, { recursive: true });
  const progressPath = path.join(taskFolderPath, "task-progress.json");
  const progress: TaskProgress = {
    taskFolder: path.basename(taskFolderPath),
    currentStage: stage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf8");
  return { taskFolderPath, progressPath, cleanup: () => fs.rmSync(container, { recursive: true, force: true }) };
}

/** Minimal TaskInventory stub resolving exactly one task, by canonicalId or
 * taskFolderPath — the two lookup keys `resolveTaskContext` tries.
 * `resolveTaskContext` additionally requires a resolvable `workspaceFolder`
 * (no workspace is open in this test harness — `vscode.workspace
 * .workspaceFolders` is `undefined`) — see `DiscoveredTask.workspaceFolder`
 * and its own final `if (!workspaceFolderUri) return undefined;` gate — plus
 * `folderName`/`sourceScopeKey`, both otherwise unused by this test. */
function stubInventory(taskFolderPath: string, canonicalId: string, progress: TaskProgress): TaskInventory {
  const task = {
    canonicalId,
    taskFolderPath,
    progress,
    folderName: path.basename(taskFolderPath),
    sourceScopeKey: taskFolderPath,
    workspaceFolder: vscode.Uri.file(path.dirname(taskFolderPath)),
  };
  return {
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedPath: () => undefined,
    getTaskById: (id?: string) => (id === canonicalId ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    refresh: () => Promise.resolve(),
    getTasks: () => [task],
  } as unknown as TaskInventory;
}

function readPersistedProgress(progressPath: string): TaskProgress {
  return JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
}

/**
 * The test-stub `vscode.workspace.fs.readFile`/`writeFile` (test-stubs/vscode/
 * index.js) are `notImplemented` stubs by default — `patchTaskProgressStrictV1`
 * (the real, disk-backed writer `scheduleQuotaResumeAtV1` uses, mirroring the
 * interactive `scheduleTaskResume`) goes through them, not raw `node:fs`.
 * Mirrors the same monkeypatch runnerRegistry.test.ts uses for its own
 * real-file-backed tests.
 */
function installRealWorkspaceFsV1(): { restore: () => void } {
  const workspace = vscode.workspace as unknown as {
    fs: {
      readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
      writeFile: (uri: vscode.Uri, bytes: Uint8Array) => Promise<void>;
    };
  };
  const originalReadFile = workspace.fs.readFile;
  const originalWriteFile = workspace.fs.writeFile;
  workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
  workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
  return {
    restore: (): void => {
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
    },
  };
}

void test("scheduleQuotaResumeAtV1 arms a scheduledRun at resetAt plus the buffer, without prompting the user", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", readPersistedProgress(folder.progressPath));
  // No injected store: `scheduleQuotaResumeAtV1` writes the initial
  // `scheduledRun` through the real `patchTaskProgressStrictV1`, so the
  // scheduler must read/write the same real store (the default), not the
  // in-memory fixture used elsewhere in this file.
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "test-owner");
  const window = vscode.window as unknown as { showInputBox: (...args: unknown[]) => unknown };
  const originalInputBox = window.showInputBox;
  window.showInputBox = () => {
    throw new Error("scheduleQuotaResumeAtV1 must never prompt the user interactively");
  };
  const surface: StatusSurface = { addEntry(): void {} };
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();

  try {
    const resetAt = new Date(Date.parse("2026-01-01T02:00:00.000Z"));
    await scheduleQuotaResumeAtV1(
      inventory,
      scheduler,
      { canonicalId: "task-id", taskFolderPath: folder.taskFolderPath },
      resetAt,
      clock
    );

    const persisted = readPersistedProgress(folder.progressPath);
    assert.equal(
      persisted.scheduledRun?.runAt,
      new Date(resetAt.getTime() + QUOTA_RESUME_SCHEDULE_BUFFER_MS).toISOString()
    );
    assert.equal(persisted.scheduledRun?.stage, "impl");
  } finally {
    window.showInputBox = originalInputBox;
    // Awaited cancel (rather than a bare `scheduler.dispose()`) releases the
    // armed timer's lease and clears `scheduledRun` deterministically —
    // `dispose()` alone fires that same release as an un-awaited write,
    // which can still be in flight when `folder.cleanup()` deletes the
    // directory out from under it.
    await scheduler.cancel(folder.taskFolderPath);
    scheduler.dispose();
    realFs.restore();
    deactivateNotificationRouter();
    folder.cleanup();
  }
});

void test("scheduleQuotaResumeAtV1 schedules 'now plus buffer' when the reset time has already passed", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", readPersistedProgress(folder.progressPath));
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "test-owner");
  const surface: StatusSurface = { addEntry(): void {} };
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();

  try {
    const pastResetAt = new Date(Date.parse("2025-12-31T00:00:00.000Z"));
    await scheduleQuotaResumeAtV1(
      inventory,
      scheduler,
      { canonicalId: "task-id", taskFolderPath: folder.taskFolderPath },
      pastResetAt,
      clock
    );

    const persisted = readPersistedProgress(folder.progressPath);
    assert.equal(
      persisted.scheduledRun?.runAt,
      new Date(clock.now() + QUOTA_RESUME_SCHEDULE_BUFFER_MS).toISOString()
    );
  } finally {
    // See the previous test's comment: awaited cancel avoids racing
    // `dispose()`'s un-awaited lease-release write against folder cleanup.
    await scheduler.cancel(folder.taskFolderPath);
    scheduler.dispose();
    realFs.restore();
    deactivateNotificationRouter();
    folder.cleanup();
  }
});

void test("scheduleQuotaResumeAtV1's fired run goes through the exact same pre-run command as a manual rerun", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", readPersistedProgress(folder.progressPath));
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "test-owner");
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  let command: string | undefined;
  commands.executeCommand = ((id: string) => {
    command = id;
    // See the identical note in "scheduled action runs when the scheduled
    // stage is still current" above: `fire()` restores `scheduledRun` unless
    // `applyCurrentStageAction` reports back `true`.
    return Promise.resolve(id === "vs-code-ai-helper.applyCurrentStageAction" ? true : undefined);
  }) as typeof commands.executeCommand;
  const surface: StatusSurface = { addEntry(): void {} };
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();

  try {
    // Close enough to "now" that the scheduler's single-timer `remaining`
    // stays under its lease-renewal threshold (`LEASE_DURATION_MS / 2` = 30
    // minutes) — otherwise `clock.fireNext()` would fire a RE-ARM callback
    // (renewing the lease and re-arming a fresh timer) rather than actually
    // running the scheduled action, and this test wants the single fire to
    // reach `applyCurrentStageAction` directly.
    const resetAt = new Date(clock.now() + 3 * 60 * 1000);
    await scheduleQuotaResumeAtV1(
      inventory,
      scheduler,
      { canonicalId: "task-id", taskFolderPath: folder.taskFolderPath },
      resetAt,
      clock
    );
    clock.fireNext();
    // `fire()` is invoked fire-and-forget from the timer callback and does
    // real (if fast) disk I/O through `patchTaskProgressStrictV1` — including
    // the real, wall-clock-timer-based session lock, not the injected
    // `clock` — before it reaches `executeCommand`. A microtask tick alone
    // does not advance real timers, so poll with a real (short) delay
    // instead of assuming a `setImmediate` queue drain suffices.
    for (let i = 0; i < 100 && command === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // Same command a manual "rerun current stage" invokes — this is what
    // gives the programmatically-armed fire the SAME pre-run checks
    // (dirty-tree awareness, fresh quota observation via the stage's own
    // runner cascade) a manual rerun gets: it is literally the same code
    // path, not a parallel one that has to be kept in sync by hand.
    assert.equal(command, "vs-code-ai-helper.applyCurrentStageAction");
    assert.equal(readPersistedProgress(folder.progressPath).scheduledRun, undefined);
  } finally {
    commands.executeCommand = original;
    scheduler.dispose();
    realFs.restore();
    deactivateNotificationRouter();
    folder.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A1 (1.0.0 gate): stale-dispatch reclaim and the "impossible active state"
// watchdog, both wired into `armAll()`'s periodic sweep.
// ---------------------------------------------------------------------------

class RecordingSurfaceV1 implements StatusSurface {
  entries: {
    message: string;
    level: "info" | "warning" | "error";
    actionCommand?: { command: string; title: string; args?: unknown[] };
  }[] = [];
  addEntry(
    message: string,
    level: "info" | "warning" | "error",
    _filePath?: string,
    _resultTargetUri?: string,
    _sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void {
    this.entries.push({ message, level, actionCommand });
  }
}

/** `hasLiveSchedulingIntentBestEffortV1` (consulted by both the reclaim
 * sweep's chain-guard-adjacent checks and the watchdog predicate) fails OPEN
 * to "live" with no `ExtensionContext` configured — the default in this test
 * file. Install a minimal one backed by an in-memory Memento so a sweep can
 * actually observe "nothing scheduled" as `false` rather than "indeterminate". */
function installFakeExtensionContextV1(): { restore: () => void; memento: import("vscode").Memento } {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  } as unknown as import("vscode").Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as import("vscode").ExtensionContext);
  return { restore: (): void => __extensionContextV1TestOnly.reset(), memento };
}

/** `armPendingImplRecoveries`'s successful claim ends with a fire-and-forget
 * `scheduleAutomationChain(...)` (`void`, deliberately not awaited by
 * production code) — let its microtask/macrotask chain settle before a test
 * restores its `executeCommand` stub, or the dispatch reaches the real
 * (unstubbed) command registry after the test has already returned. */
async function flushMicrotasksV1(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function baseStalledProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task",
    displayName: "stalled task",
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

void test("armAll reclaims a stale dispatched implRecovery and re-arms it as a fresh pending claim (A1, 1.0.0 gate)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress({
    // Reconstructable: a source round to link back to, plus a known (if
    // empty) quarantined file set — the evidence the sweep now REQUIRES
    // before reclaiming a stale dispatch (2026-09-04 review follow-up).
    pendingImplReviewFiles: ["src/example.ts"],
    implRecovery: {
      sourceAttemptId: "impl-recovery-stale-1",
      reason: "the provider's final response was cut short",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "dispatched",
      at: "2026-01-01T00:00:00.000Z",
      leaseOwner: "dead-window",
      // 90-minute STALE_DISPATCH_GRACE_MS past this anchor is 2026-01-01T01:40 — well before "now".
      leaseUntil: "2026-01-01T00:10:00.000Z",
      sourceRoundId: "round-1",
    },
  });
  const state = memoryStore(progress);
  const inventory = { getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", progress }] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const originalExecute = commands.executeCommand;
  commands.executeCommand = (() => Promise.resolve(undefined)) as typeof commands.executeCommand;
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  resetAutomationChainGuards();

  try {
    await scheduler.armAll();

    const recovered = state.current().implRecovery;
    assert.ok(recovered, "implRecovery must still be present — reclaimed, not discarded");
    assert.equal(recovered?.dispatch, "pending", "reclaimed then immediately re-claimed by the pending-claim logic below it");
    assert.equal(recovered?.leaseOwner, "test-owner", "the fresh claim must be owned by this sweep, not the dead window");
    assert.notEqual(recovered?.leaseUntil, "2026-01-01T00:10:00.000Z", "the stale lease must be replaced, not reused");
    assert.equal(recovered?.attemptId, undefined, "the reclaimed record must not carry the old dispatch's attemptId");

    assert.ok(
      surface.entries.some((e) => /reclaimed and will be re-armed automatically/.test(e.message)),
      `expected a reclaim notification; got: ${JSON.stringify(surface.entries)}`
    );
    await flushMicrotasksV1();
  } finally {
    commands.executeCommand = originalExecute;
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll leaves a dispatched implRecovery untouched while still within the stale-dispatch grace window", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress({
    implRecovery: {
      sourceAttemptId: "impl-recovery-live-1",
      reason: "still running",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "dispatched",
      at: "2026-01-01T00:00:00.000Z",
      leaseOwner: "live-window",
      // +90 minutes is 2026-01-01T04:20 — still after "now" (03:00).
      leaseUntil: "2026-01-01T02:50:00.000Z",
    },
  });
  const state = memoryStore(progress);
  const inventory = { getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", progress }] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  resetAutomationChainGuards();

  try {
    await scheduler.armAll();

    const untouched = state.current().implRecovery;
    assert.equal(untouched?.dispatch, "dispatched");
    assert.equal(untouched?.leaseOwner, "live-window");
    assert.equal(untouched?.leaseUntil, "2026-01-01T02:50:00.000Z");
    assert.ok(
      !surface.entries.some((e) => /reclaimed/.test(e.message)),
      `must not reclaim a record still within grace; got: ${JSON.stringify(surface.entries)}`
    );
  } finally {
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll does NOT reclaim a stale dispatched implRecovery that has lost its reconstructability evidence, and the watchdog closes it out instead (A1 second route, 2026-09-04 review follow-up)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress({
    // No `sourceRoundId`, no `pendingImplReviewFiles` — not reconstructable.
    // No `attemptId` either, so the watchdog's ledger-terminalization branch
    // has no live row to act on and falls back to a direct pause+clear —
    // the common case, since round-ledger reconciliation earlier in the same
    // sweep would ordinarily have already closed any real continuation row.
    implRecovery: {
      sourceAttemptId: "impl-recovery-unrecoverable-1",
      reason: "the provider hit a usage limit moments after claiming",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "dispatched",
      at: "2026-01-01T00:00:00.000Z",
      leaseOwner: "dead-window",
      leaseUntil: "2026-01-01T00:10:00.000Z",
    },
  });
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", canonicalId: "C:\\tasks\\task", progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();
  resetAutomationChainGuards();

  try {
    await scheduler.armAll();

    const after = state.current();
    assert.notEqual(
      after.implRecovery?.dispatch,
      "pending",
      "must not be reclaimed — no source round or file set to safely re-arm"
    );
    assert.equal(after.status, "paused");
    assert.equal(after.pausedReason, UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1);
    assert.equal(after.implRecovery, undefined, "the unrecoverable record must be cleared, or resuming instantly re-traps the task");
    assert.ok(
      !surface.entries.some((e) => /reclaimed and will be re-armed/.test(e.message)),
      `must not post a reclaim notification; got: ${JSON.stringify(surface.entries)}`
    );
    assert.ok(
      surface.entries.some((e) => e.level === "warning" && /could not be reclaimed/.test(e.message)),
      `expected the unrecoverable-recovery escalation; got: ${JSON.stringify(surface.entries)}`
    );
  } finally {
    fakeContext.restore();
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's watchdog pauses a task that is active with nothing running, owed, or scheduled, and posts an escalation (A1, 1.0.0 gate)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", canonicalId: "C:\\tasks\\task", progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  try {
    await scheduler.armAll();

    const after = state.current();
    assert.equal(after.status, "paused");
    assert.equal(after.pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);
    // v1 fixes item 1, Part 1b step 1: every watchdog pause carries the
    // durable pause-fence generation captured at commit time — a fresh task
    // (no prior fence activity) captures generation 0.
    assert.equal(after.watchdogPauseFenceGeneration, 0);
    const escalation = surface.entries.find((e) => e.level === "warning" && /was stalled/.test(e.message));
    assert.ok(escalation, `expected a stalled-task escalation; got: ${JSON.stringify(surface.entries)}`);
    // v1 fixes item 1, Part 1a step 7: "a watchdog pause must carry the
    // action that undoes it" — posted as a durable WorkflowDecisionV1
    // (mirrors every other escalation-driven pause), not a toast
    // `actionCommand` dispatching the command directly (the project's
    // notification-ownership rule, enforced by
    // scripts/verifyToastAllowlistV1.mjs, forbids a background sweep from
    // doing that). The toast itself only carries the chat-pointer command.
    assert.equal(
      escalation?.actionCommand?.command,
      "vs-code-ai-helper.openWorkflowDecision",
      "the pause escalation's toast must point at the durable chat decision, not dispatch a command directly"
    );
    const decisionStore = new WorkflowDecisionStoreV1(fakeContext.memento);
    const pending = decisionStore.listPending("C:\\tasks\\task");
    const watchdogDecision = pending.find((d) => d.decisionKey === "watchdogStalledEscalation");
    assert.ok(watchdogDecision, `expected a posted watchdogStalledEscalation decision; got: ${JSON.stringify(pending)}`);
    const resumeOption = watchdogDecision?.options.find((o) => o.optionId === "resumeAndRerun");
    assert.ok(resumeOption, "the decision must offer a \"resumeAndRerun\" option");
    assert.equal(resumeOption?.label, "Resume and re-run this stage");
    assert.deepEqual(resumeOption?.effect, {
      kind: "command",
      command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
      args: [{ taskFolderPath: "C:\\tasks\\task" }],
    });
    assert.equal(watchdogDecision?.gating?.holdsTaskPaused, true);
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's watchdog stands its whole pause pass down while a command elsewhere in this window is resolving which task it targets (2026-09-10 review completion blocker, narrowed further)", async () => {
  // Per-task admission cannot protect a target whose identity is not yet
  // known — this coarse, same-process gate (`beginTargetResolutionV1`/
  // `hasResolutionInFlightBestEffortV1`) is what covers that window instead:
  // the watchdog must never commit a pause anywhere while it is up, even for
  // a task that has nothing at all to do with the resolution in flight.
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", canonicalId: "C:\\tasks\\task", progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  resetTargetResolutionForTestV1();
  try {
    await beginTargetResolutionV1();
    try {
      await scheduler.armAll();
      const duringResolution = state.current();
      assert.equal(duringResolution.status, "active", "the sweep must not pause any task while a resolution is in flight");
      assert.equal(duringResolution.pausedReason, undefined);
      const escalationDuring = surface.entries.find((e) => e.level === "warning" && /was stalled/.test(e.message));
      assert.equal(escalationDuring, undefined, "no stalled-task escalation must be posted while the gate is up");
    } finally {
      await endTargetResolutionV1();
    }

    // Once resolution ends, the very next sweep must catch the same
    // impossible state normally — the gate is a temporary stand-down, never a
    // permanent suppression.
    await scheduler.armAll();
    const afterResolution = state.current();
    assert.equal(afterResolution.status, "paused");
    assert.equal(afterResolution.pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);
  } finally {
    resetTargetResolutionForTestV1();
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's watchdog is a no-op once the task is paused (idempotent — no second pause write, no duplicate escalation)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", canonicalId: "C:\\tasks\\task", progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  try {
    await scheduler.armAll();
    assert.equal(state.current().status, "paused");
    const escalationsAfterFirstSweep = surface.entries.filter((e) => /was stalled/.test(e.message)).length;
    assert.equal(escalationsAfterFirstSweep, 1);

    await scheduler.armAll();
    await scheduler.armAll();

    assert.equal(state.current().status, "paused");
    const escalationsAfterMoreSweeps = surface.entries.filter((e) => /was stalled/.test(e.message)).length;
    assert.equal(escalationsAfterMoreSweeps, 1, "a task the predicate no longer matches (status is now paused) must not be re-escalated");
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's watchdog does not pause a task with an owed implRecovery, an open round-ledger row, or a scheduledRun", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const fakeContext = installFakeExtensionContextV1();
  try {
    for (const overrides of [
      {
        implRecovery: {
          sourceAttemptId: "x",
          reason: "x",
          trigger: "roundIncomplete" as const,
          mode: "unconstrained" as const,
          dispatch: "pending" as const,
          at: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        roundLedger: [
          {
            roundId: "round-1",
            attemptIds: [],
            stage: "impl" as const,
            mode: "implementation" as const,
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "open" as const,
          },
        ],
      },
      { scheduledRun: { runAt: "2026-01-01T05:00:00.000Z", stage: "impl" as const } },
    ]) {
      const progress = baseStalledProgress(overrides);
      const state = memoryStore(progress);
      const inventory = { getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", progress }] } as unknown as TaskInventory;
      const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
      const surface = new RecordingSurfaceV1();
      initNotificationRouter(surface);
      const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
      const originalExecute = commands.executeCommand;
      // The `implRecovery: "pending"` case claims and fire-and-forget
      // dispatches exactly like the reclaim tests above — stub the same way
      // so its trailing async activity resolves against a registered command.
      commands.executeCommand = (() => Promise.resolve(undefined)) as typeof commands.executeCommand;
      resetAutomationChainGuards();
      try {
        await scheduler.armAll();
        assert.equal(state.current().status, "active", `must not pause: ${JSON.stringify(overrides)}`);
        await flushMicrotasksV1();
      } finally {
        commands.executeCommand = originalExecute;
        resetAutomationChainGuards();
        deactivateNotificationRouter();
        scheduler.dispose();
      }
    }
  } finally {
    fakeContext.restore();
  }
});

void test("armAll's stale-dispatch reclaim is race-safe across two concurrently-sweeping windows on the same task — exactly one re-dispatch, never two (2026-09-04 review follow-up: watchdog-plus-sweep concurrency)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = {
    ...readPersistedProgress(folder.progressPath),
    status: "active",
    // Reconstructable AND stale — exactly what `armPendingImplRecoveries`
    // should reclaim to `pending` and re-dispatch. Two independent
    // `TaskActionScheduler`s (simulating two VS Code windows) both sweep this
    // SAME real, disk-backed task folder concurrently: the file lock
    // (`withTaskLock`/`PrimarySessionLock` under `patchTaskProgressStrictV1`)
    // is what must serialize their competing reclaim/lease-claim CAS writes,
    // not test sequencing — this is a real concurrency test, not a simulated
    // one.
    pendingImplReviewFiles: ["src/example.ts"],
    implRecovery: {
      sourceAttemptId: "impl-recovery-race-1",
      reason: "the provider's final response was cut short",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "dispatched",
      at: "2026-01-01T00:00:00.000Z",
      leaseOwner: "dead-window",
      // 90-minute STALE_DISPATCH_GRACE_MS past this anchor is well before "now".
      leaseUntil: "2026-01-01T00:10:00.000Z",
      sourceRoundId: "round-1",
    },
  };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");

  const inventoryA = stubInventory(folder.taskFolderPath, "task-id", progress);
  const inventoryB = stubInventory(folder.taskFolderPath, "task-id", progress);
  // No injected store on either scheduler: both must go through the real,
  // disk-backed `patchTaskProgressStrictV1`/`withTaskLock` for this to be a
  // meaningful concurrency test.
  const schedulerA = new TaskActionScheduler(inventoryA, clock, undefined, "window-A");
  const schedulerB = new TaskActionScheduler(inventoryB, clock, undefined, "window-B");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const originalExecute = commands.executeCommand;
  let dispatchCount = 0;
  commands.executeCommand = ((id: string) => {
    if (id === "vs-code-ai-helper.runImplementationWithAI") {
      dispatchCount++;
    }
    return Promise.resolve(undefined);
  }) as typeof commands.executeCommand;
  resetAutomationChainGuards();

  try {
    await Promise.all([schedulerA.armAll(), schedulerB.armAll()]);
    // Fire-and-forget dispatch does real disk I/O before reaching
    // `executeCommand` (see `scheduleQuotaResumeAtV1`'s fired-run test above
    // for the same reasoning) — poll rather than assume a fixed flush
    // suffices, doubly so with two competing schedulers.
    let after = readPersistedProgress(folder.progressPath);
    for (let i = 0; i < 100 && after.implRecovery?.leaseOwner === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = readPersistedProgress(folder.progressPath);
    }

    assert.equal(
      after.implRecovery?.dispatch,
      "pending",
      "must have been reclaimed to pending by exactly one of the two windows"
    );
    assert.ok(
      after.implRecovery?.leaseOwner === "window-A" || after.implRecovery?.leaseOwner === "window-B",
      `exactly one window must own the re-armed lease; got ${JSON.stringify(after.implRecovery)}`
    );
    assert.equal(dispatchCount, 1, `exactly one re-dispatch must have fired; got ${dispatchCount}`);
  } finally {
    commands.executeCommand = originalExecute;
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    realFs.restore();
    schedulerA.dispose();
    schedulerB.dispose();
    folder.cleanup();
  }
});

void test("armAll's watchdog GENERIC route (no implRecovery, no open round-ledger row) is also race-safe across two concurrently-sweeping windows — exactly one pause write, never two competing transitions (2026-09-04 review follow-up, completion blocker de9851ef…-1: \"the generic impossible-state route always uses the direct-patch fallback\" — this proves that fallback is itself safe under the same cross-window race the reclaim route was already proven safe under above)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  // The pure "impossible active state": active, no roundLedger row, no
  // implRecovery, no scheduledRun — closeStalledTaskThroughLedgerV1's
  // `attemptId` is `undefined` for this shape (isImpossibleActiveStateV1's own
  // `hasOpenRoundLedgerRowV1` gate guarantees no row exists to terminalize),
  // so BOTH windows must fall through to the direct pause(+clear) patch. The
  // real file lock under `patchTaskProgressStrictV1` is what must serialize
  // the two competing writes here, not test sequencing.
  const progress: TaskProgress = {
    ...readPersistedProgress(folder.progressPath),
    status: "active",
  };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");

  const inventoryA = stubInventory(folder.taskFolderPath, "task-id", progress);
  const inventoryB = stubInventory(folder.taskFolderPath, "task-id", progress);
  const schedulerA = new TaskActionScheduler(inventoryA, clock, undefined, "window-A");
  const schedulerB = new TaskActionScheduler(inventoryB, clock, undefined, "window-B");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  try {
    await Promise.all([schedulerA.armAll(), schedulerB.armAll()]);

    const after = readPersistedProgress(folder.progressPath);
    assert.equal(after.status, "paused", "the task must end up paused by exactly one of the two racing sweeps");
    assert.equal(after.pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);

    const escalations = surface.entries.filter((e) => e.level === "warning" && /was stalled/.test(e.message));
    assert.equal(
      escalations.length,
      1,
      `exactly one escalation must be posted even though two windows raced the same detection; got ${JSON.stringify(surface.entries)}`
    );
  } finally {
    deactivateNotificationRouter();
    realFs.restore();
    fakeContext.restore();
    schedulerA.dispose();
    schedulerB.dispose();
    folder.cleanup();
  }
});

// ── Ordinary pause-ordering invariant (v1 fixes 2, Part 1a, plan step 10 /
// Verification: "force pause-first, marker-first, and simultaneous claim
// acquisition ... no final state contains both an effective watchdog pause
// and admitted work") ───────────────────────────────────────────────────────
//
// These three tests exercise the REAL, disk-backed sweep commit protocol
// (`detectAndRepairStalledActiveTasksV1`'s `pauseCommit` claim, re-list, and
// post-write reversal check in scheduleTaskResume.ts) against the REAL,
// disk-backed admission genesis and reconciliation (`acquireWorkAdmissionV1`,
// `reconcileWatchdogPauseAgainstAdmissionV1`) a work-starting command actually
// uses — reusing the exact real-task-folder harness the GENERIC-route
// cross-window race test above already proved safe, rather than the
// in-memory `memoryStore` the earlier declarative armAll() tests use (which
// cannot exercise `reconcileWatchdogPauseAgainstAdmissionV1`, since that
// function always writes through the real `patchTaskProgressStrictV1`, not an
// injectable store).

void test("ordinary pause-ordering invariant: marker-first — a live admission marker already held for the task means the sweep never commits a pause", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), status: "active" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");

  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "window-A");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  const genesis = await acquireWorkAdmissionV1({
    taskFolderPath: folder.taskFolderPath,
    purpose: "admission",
    commandId: "test-marker-first",
  });
  assert.equal(genesis.outcome, "acquired");

  try {
    await scheduler.armAll();

    const after = readPersistedProgress(folder.progressPath);
    assert.equal(after.status, "active", "a live admission marker must stand the sweep down before it even attempts a pauseCommit claim");
    assert.equal(after.pausedReason, undefined);
    const escalation = surface.entries.find((e) => e.level === "warning" && /was stalled/.test(e.message));
    assert.equal(escalation, undefined, "no stalled-task escalation must be posted while admission is live");
  } finally {
    if (genesis.outcome === "acquired") {
      await genesis.handle.release();
    }
    deactivateNotificationRouter();
    realFs.restore();
    fakeContext.restore();
    scheduler.dispose();
    folder.cleanup();
  }
});

void test("ordinary pause-ordering invariant: pause-first — a watchdog pause the sweep already committed is durably reconciled once a work-starting command's admission genesis arrives", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), status: "active" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");

  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "window-A");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  try {
    // Pause commits first: no admission exists yet anywhere for this task.
    await scheduler.armAll();
    const paused = readPersistedProgress(folder.progressPath);
    assert.equal(paused.status, "paused");
    assert.equal(paused.pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);

    // A work-starting command now arrives — exactly like every real
    // admission-wired route, it acquires durable admission FIRST, then
    // reconciles the watchdog pause it just proved it is doing the very work
    // the pause complained was missing.
    const genesis = await acquireWorkAdmissionV1({
      taskFolderPath: folder.taskFolderPath,
      purpose: "admission",
      commandId: "test-pause-first",
    });
    assert.equal(genesis.outcome, "acquired");
    try {
      const reconciled = await reconcileWatchdogPauseAgainstAdmissionV1(vscode.Uri.file(folder.taskFolderPath));
      assert.equal(reconciled.outcome, "reversed");

      const afterReconcile = readPersistedProgress(folder.progressPath);
      assert.equal(afterReconcile.status, "active", "a watchdog-provenance pause must be durably reversed once admission is live");
      assert.equal(afterReconcile.pausedReason, undefined);

      // Closing the loop: with admission still held, a SECOND sweep pass must
      // not re-pause the task — no final state may contain both an effective
      // watchdog pause and admitted work.
      const inventoryAfterReconcile = stubInventory(folder.taskFolderPath, "task-id", afterReconcile);
      const secondScheduler = new TaskActionScheduler(inventoryAfterReconcile, clock, undefined, "window-A");
      try {
        await secondScheduler.armAll();
        const afterSecondSweep = readPersistedProgress(folder.progressPath);
        assert.equal(afterSecondSweep.status, "active", "the sweep must not re-pause a task whose admission is still live");
      } finally {
        secondScheduler.dispose();
      }
    } finally {
      await genesis.handle.release();
    }
  } finally {
    deactivateNotificationRouter();
    realFs.restore();
    fakeContext.restore();
    scheduler.dispose();
    folder.cleanup();
  }
});

/**
 * 2026-09-10 review completion blocker: the previous single test merely
 * repeated an UNCONTROLLED `Promise.all` race 8 times and hoped both
 * orderings occurred — replaced by two tests below that each force one
 * specific ordering to actually happen, every run, plus a third that forces
 * genuine (unmediated) contention without picking a winner.
 *
 * A first attempt at forcing this raced the sweep's `armAll()` against an
 * INDEPENDENTLY started admission genesis via `Promise.all`, gated only at
 * the shared `admission.claim` exclusive-create. That deadlocked: the
 * admission side's `acquireWorkAdmissionV1` call registers its same-process
 * pending-intent marker (`registerPendingIntentV1`) SYNCHRONOUSLY, before
 * its own first `await` — almost always before `armAll()`'s per-task
 * pre-check (`isImpossibleActiveStateV1`, which itself consults that same
 * pending-intent registry via `hasLiveWorkAdmissionBestEffortV1`) ever runs.
 * With the intent already visible, the sweep's pre-check reads the task as
 * having live work and skips it WITHOUT ever attempting the `pauseCommit`
 * claim write — so a gate installed only at the claim-write step never
 * fires for `purpose: "pauseCommit"` at all, and the admission side (the
 * gate's "loser" in the pauseCommit-wins direction) waits forever.
 *
 * The fix: only start the admission side's genesis call FROM INSIDE the
 * sweep's own `onBeforeClaimWriteAsync` callback for `purpose: "pauseCommit"`
 * — i.e. only once the sweep has already reached the point of attempting
 * its claim write, which means its pre-check has already run and found no
 * interference. This reproduces the real production race precisely: both
 * sides' pre-checks pass independently (each seeing "no interference yet"),
 * and only THEN do they actually contend for the same exclusive-create.
 */
function kickOffSimultaneousAdmissionGenesisV1(
  folder: ReturnType<typeof createRealTaskFolderV1>
): { readonly start: () => void; readonly result: () => Promise<WorkAdmissionResultV1> } {
  let genesisPromise: Promise<WorkAdmissionResultV1> | undefined;
  return {
    start: (): void => {
      if (genesisPromise) {
        return;
      }
      genesisPromise = (async () => {
        const result = await acquireWorkAdmissionV1({
          taskFolderPath: folder.taskFolderPath,
          purpose: "admission",
          commandId: "test-simultaneous",
        });
        if (result.outcome === "acquired") {
          // Mirrors every real admission-wired route: reconcile immediately
          // after genesis, closing the gap left by any pause the sweep
          // committed after its own pre-check but before this genesis landed.
          await reconcileWatchdogPauseAgainstAdmissionV1(vscode.Uri.file(folder.taskFolderPath));
        }
        return result;
      })();
    },
    result: async (): Promise<WorkAdmissionResultV1> => {
      if (!genesisPromise) {
        throw new Error("kickOffSimultaneousAdmissionGenesisV1: start() was never called (the sweep never reached its claim-write attempt)");
      }
      return genesisPromise;
    },
  };
}

/** A real, wall-clock delay comfortably longer than a same-disk small-file
 * `wx` write, used to deterministically sequence which side's exclusive-
 * create is issued first (see `kickOffSimultaneousAdmissionGenesisV1`'s doc
 * comment for why the actual write attempts must be triggered this way
 * rather than raced via `Promise.all`). */
const SIMULTANEOUS_CLAIM_LOSER_DELAY_MS_V1 = 75;

function delayMsV1(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSimultaneousClaimRaceCaseV1(
  winnerPurpose: "admission" | "pauseCommit"
): Promise<{ readonly genesisOutcome: string; readonly after: TaskProgress }> {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), status: "active" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "window-simultaneous");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const admission = kickOffSimultaneousAdmissionGenesisV1(folder);
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeClaimWriteAsync: async (ctx) => {
      if (ctx.purpose === "pauseCommit") {
        admission.start();
        if (winnerPurpose === "admission") {
          await delayMsV1(SIMULTANEOUS_CLAIM_LOSER_DELAY_MS_V1);
        }
        return;
      }
      if (winnerPurpose === "pauseCommit") {
        await delayMsV1(SIMULTANEOUS_CLAIM_LOSER_DELAY_MS_V1);
      }
    },
  });

  try {
    await scheduler.armAll();
    const genesis = await admission.result();
    try {
      return { genesisOutcome: genesis.outcome, after: readPersistedProgress(folder.progressPath) };
    } finally {
      if (genesis.outcome === "acquired") {
        await genesis.handle.release();
      }
    }
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
    deactivateNotificationRouter();
    scheduler.dispose();
    folder.cleanup();
  }
}

void test("ordinary pause-ordering invariant: simultaneous claim acquisition, forced so the sweep's pauseCommit claim wins the shared exclusive-create — admission still ends up live and the task never ends up effectively paused", async () => {
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();
  try {
    const { genesisOutcome, after } = await runSimultaneousClaimRaceCaseV1("pauseCommit");
    assert.equal(
      genesisOutcome,
      "acquired",
      `admission must still succeed even though the sweep's pauseCommit claim won the shared exclusive-create first — got progress=${JSON.stringify(after)}`
    );
    assert.equal(after.status, "active");
    assert.equal(after.pausedReason, undefined);
  } finally {
    realFs.restore();
    fakeContext.restore();
  }
});

void test("ordinary pause-ordering invariant: simultaneous claim acquisition, forced so the work-starting command's admission genesis wins the shared exclusive-create — the sweep's pauseCommit is blocked outright and the task never ends up effectively paused", async () => {
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();
  try {
    const { genesisOutcome, after } = await runSimultaneousClaimRaceCaseV1("admission");
    assert.equal(genesisOutcome, "acquired");
    assert.equal(after.status, "active");
    assert.equal(
      after.pausedReason,
      undefined,
      `the sweep's pauseCommit claim must be blocked by the already-won admission claim, never commit a pause — got progress=${JSON.stringify(after)}`
    );
  } finally {
    realFs.restore();
    fakeContext.restore();
  }
});

void test("ordinary pause-ordering invariant: simultaneous claim acquisition — repeated genuine contention (both sides' pre-checks pass independently, neither ordering forced) never leaves both an effective pause and admitted work", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  try {
    // Supplementary to the two forced-ordering tests above: this exercises
    // the real, unmediated filesystem race — both sides are released at the
    // shared exclusive-create via a two-arrival barrier, with no injected
    // winner — so the invariant is also checked against whichever ordering
    // the real OS/filesystem happens to produce.
    for (let iteration = 0; iteration < 6; iteration++) {
      const folder = createRealTaskFolderV1("impl");
      const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), status: "active" };
      fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
      const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
      const scheduler = new TaskActionScheduler(inventory, clock, undefined, `window-${iteration}`);
      const surface = new RecordingSurfaceV1();
      initNotificationRouter(surface);
      const admission = kickOffSimultaneousAdmissionGenesisV1(folder);

      let arrivals = 0;
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      setWorkAdmissionFsFailureInjectionForTestV1({
        onBeforeClaimWriteAsync: async (ctx) => {
          if (ctx.purpose === "pauseCommit") {
            admission.start();
          }
          arrivals += 1;
          if (arrivals >= 2) {
            releaseBarrier?.();
          }
          await barrier;
        },
      });

      try {
        await scheduler.armAll();
        const genesis = await admission.result();

        try {
          const after = readPersistedProgress(folder.progressPath);
          const admitted = genesis.outcome === "acquired";
          const effectivelyPaused = after.status === "paused" && after.pausedReason === STALLED_ACTIVE_TASK_PAUSE_REASON_V1;
          assert.ok(
            !(admitted && effectivelyPaused),
            `iteration ${iteration}: admission was acquired but the task still shows an effective watchdog pause — ` +
              `admitted=${admitted}, progress=${JSON.stringify(after)}`
          );
        } finally {
          if (genesis.outcome === "acquired") {
            await genesis.handle.release();
          }
        }
      } finally {
        setWorkAdmissionFsFailureInjectionForTestV1(undefined);
        deactivateNotificationRouter();
        scheduler.dispose();
        folder.cleanup();
      }
    }
  } finally {
    realFs.restore();
    fakeContext.restore();
  }
});
