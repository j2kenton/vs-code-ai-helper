import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
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
    await new Promise(resolve => setImmediate(resolve));

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
    return Promise.resolve(undefined);
  }) as typeof commands.executeCommand;

  try {
    await scheduler.arm("C:\\tasks\\task", "task-id");
    clock.fireNext();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(command, "vs-code-ai-helper.applyCurrentStageAction");
    assert.equal(state.current().scheduledRun, undefined);
  } finally {
    commands.executeCommand = original;
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
    return Promise.resolve(undefined);
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
