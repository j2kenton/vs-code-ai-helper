import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import {
  buildDelayedRetryDecisionV1,
  buildOwedContinuationDecisionV1,
  buildStalledTaskEscalationDecisionV1,
  QUOTA_RESUME_SCHEDULE_BUFFER_MS,
  registerScheduleTaskResumeCommand,
  SchedulerClock,
  SchedulerProgressStore,
  scheduleQuotaResumeAtV1,
  setPauseCommitTestHooksForTestV1,
  takeOverStaleWorkAdmissionCommandV1,
  TaskActionScheduler,
} from "../commands/scheduleTaskResume";
import { TaskProgress } from "../types/taskProgress";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";
import { resetAutomationChainGuards } from "../utils/automationChain";
import { recordStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1,
} from "../utils/taskWatchdogV1";
import {
  acquireWorkAdmissionV1,
  ADMISSION_DIRNAME_V1,
  beginTargetResolutionV1,
  endTargetResolutionV1,
  finishPauseRevocationBarrierV1,
  hasLiveWorkAdmissionBestEffortV1,
  listPendingPauseRevocationBarriersV1,
  PAUSE_COMMIT_LIKELY_STALE_MS_V1,
  readOrInitPauseFenceGenerationV1,
  resetTargetResolutionForTestV1,
  revokeStalePauseCommitClaimV1,
  setWorkAdmissionFsFailureInjectionForTestV1,
  setWorkAdmissionRootOverrideForTestV1,
  WORK_ADMISSION_LIKELY_STALE_MS_V1,
  WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1,
  WorkAdmissionResultV1,
} from "../state/workAdmissionV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import { resolveEffectivePauseStatusV1 } from "../state/effectivePauseStatusV1";
import { resolveHostIdentityV1 } from "../state/hostIdentityV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { setProcessStartTimeIoOverrideForTestV1 } from "../state/processStartTimeProbeV1";
import { safeRemoveDir } from "./testFsUtils";

/**
 * `probeWorkAdmissionOwnerLivenessV1`'s process-start-time cross-check (Part
 * 1c step 15's "readable process-start mismatch" half) is additive proof of
 * death on top of the pre-existing ESRCH check. This file's
 * `writeFakeAdmissionMarkerV1` (below) uses a placeholder `processStartTime: 0`
 * purely to mean "alive, not provably dead" for tests that plant a marker for
 * this test process's own real, alive pid — never intending to exercise real
 * cross-process start-time comparison. Disabling the real read by default
 * (no evidence — the same fail-open outcome production code takes for an
 * unreadable read) keeps those fixtures correct and the suite deterministic
 * and free of real shell-outs. See `workAdmissionV1.test.ts` for the same
 * fix, applied there first.
 */
setProcessStartTimeIoOverrideForTestV1({ readFileUtf8Sync: () => undefined, execFileCapture: () => Promise.resolve(undefined) });
after(() => {
  setProcessStartTimeIoOverrideForTestV1(undefined);
});

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

/** Same redirection this file's admission-root override above installs,
 * applied by hand so a test can plant a FAKE marker directly — mirrors
 * `workAdmissionV1.test.ts`'s own `writeFakeMarkerV1`, adapted to this file's
 * hex-encoded per-`taskFolderPath` subdirectory scheme (Part 1c step
 * 15/18 reclaim-pass coverage). */
function writeFakeAdmissionMarkerV1(
  taskFolderPath: string,
  overrides: Partial<{ purpose: "admission" | "pauseCommit"; pid: number; hostId: string; ownerToken: string }>
): string {
  const dir = path.join(admissionTestRootV1, Buffer.from(taskFolderPath).toString("hex"), ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const ownerToken = overrides.ownerToken ?? "fakeowner1";
  const markerPath = path.join(dir, `admission.${ownerToken}.g1.deadbeef`);
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      claimId: `${ownerToken}-claim`,
      purpose: overrides.purpose ?? "admission",
      ownerToken,
      pid: overrides.pid ?? 999999,
      processStartTime: 0,
      hostId: overrides.hostId ?? "fake-host",
      commandId: "fake-owner-command",
      startedAt: new Date().toISOString(),
    })
  );
  return markerPath;
}

/**
 * `nowMs` must be the SAME reference time the code under test will compare
 * the file's mtime against — for the reclaim-pass tests below that is the
 * `FakeClock`'s fixed `now()`, not the real wall clock. `armAll`'s reclaim
 * pass calls `attemptAutomaticWorkAdmissionReclamationV1(path, this.clock.now())`,
 * so backdating relative to real `Date.now()` while the scheduler runs on a
 * `FakeClock` pinned to a different moment produces a wrong (often deeply
 * negative) computed age, which silently reads as "not stale" regardless of
 * how large `ageMs` is.
 */
function backdateFileV1(filePath: string, ageMs: number, nowMs: number): void {
  const old = new Date(nowMs - ageMs);
  fs.utimesSync(filePath, old, old);
}

/** Same real spawn/wait idiom `workAdmissionV1.test.ts` uses to prove a pid is
 * genuinely dead, rather than trusting a made-up large number that might
 * coincidentally be live on the test host. */
function spawnAndWaitForDeadPidV1(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["-e", ""], { windowsHide: true });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error("spawned child has no pid"));
      return;
    }
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}
after(() => {
  setWorkAdmissionRootOverrideForTestV1(undefined);
  safeRemoveDir(admissionTestRootV1);
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

    // A refusal re-arms the schedule (adding this window's lease metadata), so
    // assert the retained intent rather than the exact record shape.
    assert.equal(state.current().scheduledRun?.runAt, "2026-01-01T00:01:00.000Z");
    assert.equal(state.current().scheduledRun?.stage, "plan");
  } finally {
    commands.executeCommand = original;
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("a firing refused because another stage action holds the task warns ONCE and backs off instead of re-firing on every re-arm (seen live 2026-09-17)", async () => {
  // Before: every task-progress.json write by the running action re-armed the
  // overdue schedule for an immediate re-fire, and every re-fire posted the
  // same "could not start yet" warning again.
  class RecordingClock extends FakeClock {
    readonly delays: number[] = [];
    override setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      this.delays.push(delay);
      return super.setTimeout(callback, delay);
    }
  }
  const clock = new RecordingClock(Date.parse("2026-01-01T00:05:00.000Z")); // the run is overdue
  const taskFolderPath = "C:\\tasks\\refused-backoff";
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const warnings: string[] = [];
  const surface: StatusSurface = {
    addEntry(message: string): void {
      if (message.includes("could not start yet")) {
        warnings.push(message);
      }
    },
  };
  initNotificationRouter(surface);
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  let dispatched = 0;
  commands.executeCommand = (() => {
    dispatched += 1;
    return Promise.resolve(true);
  }) as typeof commands.executeCommand;
  // Another stage action holds this task's admission right now.
  const holder = await acquireWorkAdmissionV1({ taskFolderPath, purpose: "admission", commandId: "runReviewWithAI" });
  assert.equal(holder.outcome, "acquired");

  try {
    await scheduler.arm(taskFolderPath, "task-id");
    assert.equal(clock.delays.at(-1), 0, "an overdue schedule fires at once the first time");
    clock.fireNext();
    await scheduler.waitForPendingFiresForTestV1();
    // The refusal re-armed on its own, at the retry delay.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.ok(state.current().scheduledRun !== undefined, "the schedule is kept");

    // Progress writes by the running action re-arm the scheduler repeatedly:
    // none of them may bring the retry forward, fire, or warn again.
    for (let i = 0; i < 5; i += 1) {
      await scheduler.arm(taskFolderPath, "task-id");
      assert.ok(clock.delays.at(-1)! >= 59_000, `re-arm ${i} waits out the retry delay (got ${clock.delays.at(-1)})`);
    }
    assert.equal(warnings.length, 1, "one warning per refused schedule, not one per retry");
    assert.equal(dispatched, 0);

    // A retry while the holder is still busy stays quiet too.
    clock.fireNext();
    await scheduler.waitForPendingFiresForTestV1();
    assert.equal(warnings.length, 1);

    // Once the holder releases, the retry dispatches and clears the schedule.
    if (holder.outcome === "acquired") {
      await holder.handle.release();
    }
    await new Promise((resolve) => setImmediate(resolve));
    clock.fireNext();
    await scheduler.waitForPendingFiresForTestV1();
    assert.equal(dispatched, 1);
    assert.equal(state.current().scheduledRun, undefined);
  } finally {
    if (holder.outcome === "acquired") {
      await holder.handle.release().catch(() => undefined);
    }
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
  return { taskFolderPath, progressPath, cleanup: () => safeRemoveDir(container) };
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
      createDirectory: (uri: vscode.Uri) => Promise<void>;
    };
  };
  const originalReadFile = workspace.fs.readFile;
  const originalWriteFile = workspace.fs.writeFile;
  const originalCreateDirectory = workspace.fs.createDirectory;
  workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
  workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
  // Needed for `writeStaleWorkAdmissionTakeoverRunLogRecordV1` (Part 1c
  // step 16), which creates `runs/` before writing into it — matches
  // `promptManifestV1.test.ts`'s identical `createDirectory` bridge for the
  // same reason.
  workspace.fs.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  return {
    restore: (): void => {
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      workspace.fs.createDirectory = originalCreateDirectory;
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
    // v1 fixes 2, Wave I chokepoint (arms a schedule): arming a scheduled
    // run means automation acts next.
    assert.equal(persisted.nextActor, "automation");
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

/**
 * Pre-1.0.0 fixes register, Part 3 Step 2 inventory: `runnerRegistry.ts`'s
 * `rerunAfterReset` option was a `known-gap` row in
 * `decisionOptionResumeKindTableV1.test.ts`, citing only that
 * `scheduleQuotaResumeAtV1` genuinely schedules (source-traced, not a
 * runtime dispatch proof). This closes that gap: it drives the REAL
 * registered `vs-code-ai-helper.scheduleQuotaResumeV1` command — through
 * `registerScheduleTaskResumeCommand`, the same registration `extension.ts`
 * performs — with the exact `{ taskFolderPath, resetAtIso }` args shape
 * `runnerRegistry.ts`'s option literal supplies, and observes the actual
 * persisted `scheduledRun`/`nextActor` effect, closing the gap between
 * "the option's effect names this command" and "choosing the option
 * genuinely arms a scheduled action."
 */
void test("the real 'vs-code-ai-helper.scheduleQuotaResumeV1' command (rerunAfterReset's effect) arms a scheduledRun", async () => {
  const folder = createRealTaskFolderV1("impl");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", readPersistedProgress(folder.progressPath));
  const surface: StatusSurface = { addEntry(): void {} };
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  const scheduler = registerScheduleTaskResumeCommand(fakeContext, inventory);

  try {
    const resetAtIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await vscode.commands.executeCommand("vs-code-ai-helper.scheduleQuotaResumeV1", {
      canonicalId: "task-id",
      taskFolderPath: folder.taskFolderPath,
      resetAtIso,
    });

    const persisted = readPersistedProgress(folder.progressPath);
    assert.ok(persisted.scheduledRun, "choosing rerunAfterReset must genuinely arm a scheduledRun, not merely name the command");
    assert.equal(persisted.scheduledRun?.stage, "impl");
    assert.equal(persisted.nextActor, "automation", "arming a schedule means automation acts next");
  } finally {
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
    // This fixture's task folder does not exist on disk, so the stage's own
    // prerequisites are unmet and resuming would be refused. The card must say
    // so (items 14 + 25) rather than offer an inert "resume" — the runnable
    // shape (button names its action) is covered by the builder test below.
    assert.ok(
      !watchdogDecision?.options.some((o) => o.optionId === "resumeAndRerun"),
      "a blocked resume plan must not offer a resume option that would be refused"
    );
    assert.equal(watchdogDecision?.gating?.unblocksProgress, false);
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
      let dispatched = 0;
      commands.executeCommand = (() => {
        dispatched += 1;
        return Promise.resolve(undefined);
      }) as typeof commands.executeCommand;
      resetAutomationChainGuards();
      try {
        await scheduler.armAll();
        assert.equal(state.current().status, "active", `must not pause: ${JSON.stringify(overrides)}`);
        await flushMicrotasksV1();
        // The fire-and-forget dispatch crosses real I/O before it reaches the
        // command; under a loaded full-suite run two macrotask turns are not
        // enough, and the stub was restored first ("command ... is not
        // registered" surfaced as an unhandledRejection after the test ended).
        // Hold the stub until the dispatch has landed (bounded).
        if ("implRecovery" in overrides) {
          for (let waited = 0; dispatched === 0 && waited < 3000; waited += 20) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          // A timeout must fail here, not defer the late rejection past the test.
          assert.ok(dispatched > 0, "the owed continuation's dispatch must land before the stub is restored");
        }
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

// ---------------------------------------------------------------------------
// v1 fixes item 1, Part 1c step 15/18: `armAll`'s automatic reclaim pass for
// admission markers whose owner is PROVABLY dead, run every sweep immediately
// before the watchdog's own stand-down check — see
// `TaskActionScheduler.reclaimStaleWorkAdmissionMarkersV1`'s own doc comment.
// These tests exercise the WIRING (is it called, in what order, does a
// reclaimed marker actually unblock the watchdog in the same sweep) — the
// underlying safety boundary itself (conservative liveness, purpose-specific
// barrier routing) is already exhaustively covered by
// `workAdmissionV1.test.ts`'s own `attemptAutomaticWorkAdmissionReclamationV1`
// suite and is deliberately not re-proven here.
// ---------------------------------------------------------------------------

void test("armAll reclaims a stale, determinately-dead admission marker and lets the watchdog pause the stalled task in the SAME sweep", async () => {
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

  const deadPid = await spawnAndWaitForDeadPidV1();
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeAdmissionMarkerV1("C:\\tasks\\task", {
    purpose: "admission",
    pid: deadPid,
    hostId: myHostId,
    ownerToken: "dead-reviewer-1",
  });
  backdateFileV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());
  // Without reclamation, this stale-but-present marker would make the
  // watchdog stand this task's pause down entirely (v1a's interim fail-open
  // policy: any present claim/marker counts as live) — confirms the fixture
  // actually exercises the reclaim pass rather than a task that would have
  // been paused anyway.
  assert.equal(hasLiveWorkAdmissionBestEffortV1("C:\\tasks\\task"), true);

  try {
    await scheduler.armAll();

    assert.equal(fs.existsSync(markerPath), false, "the dead owner's marker must be reclaimed (renamed away)");
    assert.equal(fs.existsSync(`${markerPath}.tombstone`), true, "a tombstone must be left behind");
    assert.equal(
      hasLiveWorkAdmissionBestEffortV1("C:\\tasks\\task"),
      false,
      "a reclaimed marker must no longer be reported as live admission"
    );
    assert.equal(state.current().status, "paused", "the watchdog must now be free to pause the stalled task");
    assert.equal(state.current().pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's reclaim pass never touches a stale admission marker whose owner is alive, and the watchdog stands down accordingly", async () => {
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

  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeAdmissionMarkerV1("C:\\tasks\\task", {
    purpose: "admission",
    pid: process.pid, // this test's own process: genuinely alive
    hostId: myHostId,
    ownerToken: "alive-reviewer-1",
  });
  backdateFileV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());

  try {
    await scheduler.armAll();

    assert.equal(fs.existsSync(markerPath), true, "a live owner's marker must never be reclaimed");
    assert.equal(fs.existsSync(`${markerPath}.tombstone`), false);
    assert.equal(hasLiveWorkAdmissionBestEffortV1("C:\\tasks\\task"), true);
    assert.equal(
      state.current().status,
      "active",
      "the watchdog must stand down while a live (if stale-looking) admission marker is present"
    );
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's reclaim pass reclaims a stale, determinately-dead pauseCommit marker through 1b's revocation barrier, then the watchdog pauses normally", async () => {
  // Unlike the two admission-purpose tests above, reclaiming a pauseCommit
  // marker also runs `finishPauseRevocationBarrierV1`'s best-effort
  // `task-progress.json` cleanup hook (`repairRevokedWatchdogPauseV1`), which
  // acquires a real, disk-backed `PrimarySessionLock` — a fabricated,
  // non-existent path like "C:\\tasks\\task" makes that lock acquisition fail
  // (ENOENT/EPERM walking up to a nonexistent parent) and would silently mask
  // whether the cleanup actually succeeds, since that hook is best-effort by
  // design. A real temp task folder is required here, matching the same
  // convention `runPauseFencingBoundaryCaseV1` already uses for every other
  // test that exercises this cleanup hook.
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = {
    ...readPersistedProgress(folder.progressPath),
    displayName: "stalled task",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  const deadPid = await spawnAndWaitForDeadPidV1();
  const myHostId = await resolveHostIdentityV1();
  const fenceBefore = await readOrInitPauseFenceGenerationV1(folder.taskFolderPath);
  const markerPath = writeFakeAdmissionMarkerV1(folder.taskFolderPath, {
    purpose: "pauseCommit",
    pid: deadPid,
    hostId: myHostId,
    ownerToken: "dead-sweep-owner-1",
  });
  backdateFileV1(markerPath, PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000, clock.now());

  try {
    await scheduler.armAll();

    assert.ok(
      (await readOrInitPauseFenceGenerationV1(folder.taskFolderPath)) > fenceBefore,
      "reclaiming a dead pauseCommit owner must advance the durable pause fence, not just remove the marker"
    );
    assert.equal(
      listPendingPauseRevocationBarriersV1(folder.taskFolderPath).length,
      0,
      "the revocation barrier must be fully finished within this sweep, not left pending"
    );
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(`${markerPath}.tombstone`), false, "pauseCommit reclamation must not use the admission tombstone path");
    // The dead sweep's leftover claim no longer counts as live admission, so
    // the SAME sweep pass is free to commit its own, real pauseCommit claim
    // and pause the genuinely stalled task.
    const afterSweep = readPersistedProgress(folder.progressPath);
    assert.equal(afterSweep.status, "paused");
    assert.equal(afterSweep.pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);
  } finally {
    fakeContext.restore();
    realFs.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
    folder.cleanup();
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

// ── Revoked-pause fencing invariant (v1 fixes 2, Part 1b, plan step 14):
// "suspend a `pauseCommit` owner ... at each of the five documented
// boundaries (before its pre-write check, after it, during the awaited
// write, after the raw write but before post-write validation, and after
// notification prep) ... revoke from the other window ... resume the old
// writer and verify its late pause is rejected or immediately treated as
// revoked and repaired ... At no point may the review abort, the tree show
// an effective watchdog pause, or a stale pause notification survive."
//
// `setPauseCommitTestHooksForTestV1` (scheduleTaskResume.ts) brackets the
// real, disk-backed pause-commit sequence in `detectAndRepairStalledActiveTasksV1`
// at exactly these points, so "the old owner" here is the real sweep code,
// suspended mid-sequence by an awaited test hook, not a simulation of it. A
// real "second window" revocation (`revokeStalePauseCommitClaimV1` +
// `finishPauseRevocationBarrierV1`, forced stale via a fabricated `now` —
// waiting out the real 5-minute threshold would make this suite
// impractically slow) runs inside that suspension, exactly mirroring
// production: a `pauseCommit` claim is only ever revoked once it is
// genuinely stale, which in reality means its owner has been suspended for
// minutes, not milliseconds. ───────────────────────────────────────────────

type PauseFencingBoundaryV1 =
  | "beforePreWriteCheck"
  | "afterPreWriteCheck"
  | "duringWrite"
  | "afterRawWriteBeforePostValidation"
  | "afterPostValidationBeforeNotification";

/** `revokeStalePauseCommitClaimV1`'s own staleness gate compares its `now`
 * argument against the marker's REAL mtime (set moments ago, when this
 * test's sweep acquired it) — passing a `now` already past
 * `PAUSE_COMMIT_LIKELY_STALE_MS_V1` satisfies that gate deterministically,
 * without an actual multi-minute sleep. */
function forcedStaleNowV1(): number {
  return Date.now() + PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000;
}

/** The full "another window" revocation: rename the old owner's still-live
 * `pauseCommit` marker into a pending barrier, then finish that barrier
 * (fence advance + best-effort `task-progress.json` cleanup of any
 * already-landed raw pause under the revoked claim + barrier removal) — the
 * complete sequence plan step 12 describes, run end to end by one actor
 * rather than left pending for a later one (the reverse-ordering test below
 * exercises the left-pending variant instead). */
async function revokeAndFinishFromAnotherWindowV1(taskFolderPath: string): Promise<void> {
  const revoked = await revokeStalePauseCommitClaimV1(taskFolderPath, "second-window-revoker", forcedStaleNowV1());
  assert.equal(
    revoked.outcome,
    "revoked",
    `expected the old owner's still-live pauseCommit marker to be revocable at this boundary; got ${JSON.stringify(revoked)}`
  );
  if (revoked.outcome === "revoked") {
    await finishPauseRevocationBarrierV1(taskFolderPath, revoked.barrierPath);
  }
}

async function runPauseFencingBoundaryCaseV1(boundary: PauseFencingBoundaryV1): Promise<{
  readonly taskFolderPath: string;
  readonly afterSweep: TaskProgress;
  readonly notified: boolean;
  readonly cleanup: () => void;
}> {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), status: "active" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, `window-boundary-${boundary}`);
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  // Real, unmediated concurrency for "duringWrite": kicked off (not awaited)
  // from the hook immediately before the write begins, then awaited to
  // completion from the hook immediately after the write settles — so the
  // revocation's own disk I/O genuinely overlaps the progress write's,
  // rather than being forced strictly before or after it.
  let concurrentRevoke: Promise<void> | undefined;
  setPauseCommitTestHooksForTestV1({
    onBeforePreWriteFenceCheckAsync: async () => {
      if (boundary === "beforePreWriteCheck") {
        await revokeAndFinishFromAnotherWindowV1(folder.taskFolderPath);
      }
    },
    onAfterPreWriteFenceCheckAsync: async () => {
      if (boundary === "afterPreWriteCheck") {
        await revokeAndFinishFromAnotherWindowV1(folder.taskFolderPath);
      } else if (boundary === "duringWrite") {
        concurrentRevoke = revokeAndFinishFromAnotherWindowV1(folder.taskFolderPath);
      }
    },
    onAfterRawWriteBeforePostValidationAsync: async () => {
      if (boundary === "duringWrite") {
        assert.ok(concurrentRevoke, "duringWrite boundary must have kicked off its concurrent revocation earlier");
        await concurrentRevoke;
      } else if (boundary === "afterRawWriteBeforePostValidation") {
        await revokeAndFinishFromAnotherWindowV1(folder.taskFolderPath);
      }
    },
    onAfterPostValidationBeforeNotificationAsync: async () => {
      if (boundary === "afterPostValidationBeforeNotification") {
        await revokeAndFinishFromAnotherWindowV1(folder.taskFolderPath);
      }
    },
  });

  try {
    await scheduler.armAll();
  } finally {
    // Reset the global hook immediately — regardless of what the caller does
    // with the returned folder afterward — so a throw here can never leak
    // into a later, unrelated test.
    setPauseCommitTestHooksForTestV1(undefined);
  }

  const afterSweep = readPersistedProgress(folder.progressPath);
  const notified = surface.entries.some((e) => e.level === "warning" && /was stalled/.test(e.message));
  return {
    taskFolderPath: folder.taskFolderPath,
    afterSweep,
    notified,
    cleanup: (): void => {
      deactivateNotificationRouter();
      realFs.restore();
      fakeContext.restore();
      scheduler.dispose();
      folder.cleanup();
    },
  };
}

/** Shared assertions every boundary case must satisfy, run after the old
 * owner's sweep pass has fully settled: the pause must never remain
 * effective, and a work-starting command's own admission — arriving some
 * time later, exactly like a real user reopening the task — must never be
 * blocked or aborted by whatever the old owner (or the revocation racing it)
 * left behind. */
async function assertBoundaryLeavesNoEffectivePauseAndAdmitsCleanlyV1(
  boundary: PauseFencingBoundaryV1,
  taskFolderPath: string
): Promise<void> {
  const effective = await resolveEffectivePauseStatusV1(taskFolderPath, readPersistedProgress(
    path.join(taskFolderPath, "task-progress.json")
  ));
  assert.notEqual(
    effective.kind,
    "currentWatchdogPause",
    `boundary "${boundary}": no final state may contain an effective watchdog pause once the racing revocation has run`
  );

  const genesis = await acquireWorkAdmissionV1({
    taskFolderPath,
    purpose: "admission",
    commandId: "test-work-command",
  });
  assert.equal(
    genesis.outcome,
    "acquired",
    `boundary "${boundary}": a work-starting command's admission must never be blocked by the old pauseCommit owner's activity — got ${JSON.stringify(genesis)}`
  );
  if (genesis.outcome === "acquired") {
    await genesis.handle.release();
  }
  assert.equal(
    listPendingPauseRevocationBarriersV1(taskFolderPath).length,
    0,
    `boundary "${boundary}": no pending revocation barrier may survive once a later acquisition has run`
  );
}

void test("revoked-pause fencing invariant: boundary 1 — revoked before the pre-write fence check — the sweep's own pre-write check catches it and never writes a pause at all", async () => {
  const result = await runPauseFencingBoundaryCaseV1("beforePreWriteCheck");
  try {
    assert.equal(result.afterSweep.status, "active", `expected no pause to have been written at all; got ${JSON.stringify(result.afterSweep)}`);
    assert.equal(result.afterSweep.pausedReason, undefined);
    assert.equal(result.notified, false, "no escalation may be posted for a pause that was never committed");
    await assertBoundaryLeavesNoEffectivePauseAndAdmitsCleanlyV1("beforePreWriteCheck", result.taskFolderPath);
  } finally {
    result.cleanup();
  }
});

void test("revoked-pause fencing invariant: boundary 2 — revoked after the pre-write check passes but before the write — the sweep's own post-write check catches the now-stale generation and self-reverses, no notification posted", async () => {
  const result = await runPauseFencingBoundaryCaseV1("afterPreWriteCheck");
  try {
    assert.equal(result.afterSweep.status, "active", `expected the sweep's own post-write check to self-reverse; got ${JSON.stringify(result.afterSweep)}`);
    assert.equal(result.afterSweep.pausedReason, undefined);
    assert.equal(result.afterSweep.watchdogPauseClaimId, undefined);
    assert.equal(result.notified, false, "a self-reversed pause must settle as revoked, never announced as a pause");
    await assertBoundaryLeavesNoEffectivePauseAndAdmitsCleanlyV1("afterPreWriteCheck", result.taskFolderPath);
  } finally {
    result.cleanup();
  }
});

void test("revoked-pause fencing invariant: boundary 3 — revoked during the awaited progress write itself (genuine, unmediated concurrency) — the sweep's post-write check still catches it and self-reverses", async () => {
  const result = await runPauseFencingBoundaryCaseV1("duringWrite");
  try {
    assert.equal(result.afterSweep.status, "active", `expected the sweep's own post-write check to self-reverse; got ${JSON.stringify(result.afterSweep)}`);
    assert.equal(result.afterSweep.pausedReason, undefined);
    assert.equal(result.notified, false);
    await assertBoundaryLeavesNoEffectivePauseAndAdmitsCleanlyV1("duringWrite", result.taskFolderPath);
  } finally {
    result.cleanup();
  }
});

void test("revoked-pause fencing invariant: boundary 4 — revoked after the raw pause write lands but before post-write validation runs — the revocation's own barrier-finish cleanup repairs the raw write immediately, and the sweep's later post-write check finds it already repaired (a harmless no-op), no notification posted", async () => {
  const result = await runPauseFencingBoundaryCaseV1("afterRawWriteBeforePostValidation");
  try {
    assert.equal(
      result.afterSweep.status,
      "active",
      `expected the barrier-finish's own task-progress cleanup to have already repaired the raw write; got ${JSON.stringify(result.afterSweep)}`
    );
    assert.equal(result.afterSweep.pausedReason, undefined);
    assert.equal(result.afterSweep.watchdogPauseClaimId, undefined);
    assert.equal(result.notified, false, "the sweep's own post-write check must find the pause already repaired and skip notification");
    await assertBoundaryLeavesNoEffectivePauseAndAdmitsCleanlyV1("afterRawWriteBeforePostValidation", result.taskFolderPath);
  } finally {
    result.cleanup();
  }
});

void test("revoked-pause fencing invariant: boundary 5 — revoked after post-write validation already passed (the sweep is committed to notifying) — the revocation's barrier-finish cleanup still repairs the raw write before the notification is built, so even a notification posted at this boundary refers to an already-resolved condition, never a surviving effective pause", async () => {
  const result = await runPauseFencingBoundaryCaseV1("afterPostValidationBeforeNotification");
  try {
    assert.equal(
      result.afterSweep.status,
      "active",
      `expected the barrier-finish's own task-progress cleanup to have repaired the raw write before notification, even though post-write validation already passed; got ${JSON.stringify(result.afterSweep)}`
    );
    assert.equal(result.afterSweep.pausedReason, undefined);
    // Unlike every earlier boundary: post-write validation had ALREADY
    // passed before revocation ran, so the sweep is unconditionally
    // committed to notifying by this point — the notification code has no
    // seam left to recheck status. A notification MAY therefore be posted
    // here; the correctness property this test defends is that it can never
    // refer to a pause that still blocks anything by the time it lands.
    await assertBoundaryLeavesNoEffectivePauseAndAdmitsCleanlyV1("afterPostValidationBeforeNotification", result.taskFolderPath);
  } finally {
    result.cleanup();
  }
});

void test("reverse late-writer ordering: the old pause commits (write + post-write validation + notification) before its claim is revoked — a revocation left pending (rename-only, not yet finished) never invalidates the already-committed pause on its own; a later acquisition's own barrier-finish is what advances the fence and repairs it, before that acquisition publishes its own marker", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), status: "active" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const scheduler = new TaskActionScheduler(inventory, clock, undefined, "window-reverse-ordering");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();
  const fakeContext = installFakeExtensionContextV1();

  setPauseCommitTestHooksForTestV1({
    onAfterPostValidationBeforeNotificationAsync: async () => {
      // Revoke ONLY — deliberately do not finish the barrier. The old
      // owner's claim is renamed away (it can no longer heartbeat or be
      // found live), but the fence has not yet advanced and no
      // `task-progress.json` cleanup has run — exactly a revoker that died
      // right after the rename, leaving a helpable pending barrier behind
      // (Part 1b step 12: "a later claimant can help finish an abandoned
      // revocation's idempotent steps").
      const revoked = await revokeStalePauseCommitClaimV1(
        folder.taskFolderPath,
        "reverse-ordering-revoker",
        forcedStaleNowV1()
      );
      assert.equal(revoked.outcome, "revoked");
    },
  });

  try {
    // The pause's write and post-write validation both complete normally,
    // undisturbed — the reverse of every boundary case above, where
    // revocation always lands no later than "just before notification".
    await scheduler.armAll();

    const committed = readPersistedProgress(folder.progressPath);
    assert.equal(committed.status, "paused", "the pause must have committed normally — nothing raced its write or its post-write validation");
    assert.equal(committed.pausedReason, STALLED_ACTIVE_TASK_PAUSE_REASON_V1);
    assert.equal(typeof committed.watchdogPauseFenceGeneration, "number");

    assert.equal(
      listPendingPauseRevocationBarriersV1(folder.taskFolderPath).length,
      1,
      "the claim revocation (rename-only, not yet finished) must have left exactly one pending barrier"
    );

    // The fence has NOT advanced yet — revoking the CLAIM alone never does
    // that; only finishing the barrier does — so the just-committed pause is
    // still, in isolation, indistinguishable from a real one.
    const stillCurrent = await resolveEffectivePauseStatusV1(folder.taskFolderPath, committed);
    assert.equal(
      stillCurrent.kind,
      "currentWatchdogPause",
      "revoking the CLAIM alone (without finishing the barrier) must not yet invalidate the already-committed pause"
    );

    // Admission now proceeds: a work-starting command's own acquisition is
    // what finishes the leftover barrier BEFORE it publishes its own marker
    // (plan step 12 / `acquireWorkAdmissionCoreV1`'s wiring) — "fence
    // advancement must clear the matching pause before admission proceeds".
    const genesis = await acquireWorkAdmissionV1({
      taskFolderPath: folder.taskFolderPath,
      purpose: "admission",
      commandId: "test-work-command-reverse-ordering",
    });
    assert.equal(genesis.outcome, "acquired", "admission must never be blocked by a leftover pending barrier");
    try {
      const repaired = readPersistedProgress(folder.progressPath);
      assert.equal(repaired.status, "active", "finishing the barrier during admission must have already repaired the stale pause");
      assert.equal(repaired.watchdogPauseClaimId, undefined);
      assert.equal(repaired.watchdogPauseFenceGeneration, undefined);
      assert.equal(
        listPendingPauseRevocationBarriersV1(folder.taskFolderPath).length,
        0,
        "the barrier must be gone once admission's own acquisition has finished it"
      );
    } finally {
      await genesis.handle.release();
    }
  } finally {
    setPauseCommitTestHooksForTestV1(undefined);
    deactivateNotificationRouter();
    realFs.restore();
    fakeContext.restore();
    scheduler.dispose();
    folder.cleanup();
  }
});

// ---------------------------------------------------------------------------
// v1 fixes item 1, Part 1c step 16/17: the takeover-notice tracking and
// tombstone GC passes armAll() wires alongside the reclaim pass above.
// ---------------------------------------------------------------------------

void test("armAll surfaces a takeover notice only after 3 consecutive sweeps observe the SAME stuck (foreignHost) owner, never sooner", async () => {
  // A dedicated, never-reused fixture path — several EARLIER tests in this
  // file deliberately use (and leave a leftover marker behind for) the
  // shared "C:\\tasks\\task" path; reusing it here would let a stale marker
  // from an unrelated test silently win `listMarkersSyncV1`'s `markers[0]`
  // pick and make this test observe the wrong owner entirely.
  const taskFolderPath = "C:\\tasks\\takeover-notice-streak";
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath, canonicalId: taskFolderPath, progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  const markerPath = writeFakeAdmissionMarkerV1(taskFolderPath, {
    purpose: "admission",
    pid: 424242,
    hostId: "definitely-a-different-host-id",
    ownerToken: "stuck-foreign-owner",
  });
  backdateFileV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());

  try {
    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "1 observation must not yet surface a notice"
    );

    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "2 observations must not yet surface a notice"
    );

    await scheduler.armAll();
    const takeoverEntries = surface.entries.filter((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission");
    assert.equal(takeoverEntries.length, 1, "the 3rd consecutive observation must surface exactly one notice");
    assert.equal(takeoverEntries[0]?.level, "warning");
    assert.match(takeoverEntries[0]?.message ?? "", /not this one|foreign/i);
    assert.deepEqual(takeoverEntries[0]?.actionCommand?.args, [
      { taskFolderPath, expectedMarkerPath: markerPath, expectedClaimId: "stuck-foreign-owner-claim" },
    ]);

    // A 4th consecutive observation of the SAME stuck owner must not spam a
    // second notice — this is a one-shot notice per stuck streak, not a
    // repeating alarm.
    await scheduler.armAll();
    assert.equal(
      surface.entries.filter((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission").length,
      1,
      "the notice must not repeat for the same unresolved streak"
    );

    // The marker itself must be untouched throughout — a notice is advisory
    // only, never a mutation.
    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll's takeover-notice streak resets when a DIFFERENT owner is observed, so a fresh owner never inherits a stale count", async () => {
  const taskFolderPath = "C:\\tasks\\takeover-notice-reset";
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath, canonicalId: taskFolderPath, progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  try {
    const markerPathA = writeFakeAdmissionMarkerV1(taskFolderPath, {
      purpose: "admission",
      pid: 1,
      hostId: "foreign-host-a",
      ownerToken: "owner-a",
    });
    backdateFileV1(markerPathA, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());
    await scheduler.armAll();
    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "owner-a has only 2 observations so far"
    );

    // A DIFFERENT owner takes the marker path (e.g. owner-a's process
    // finally released and a genuinely new, unrelated owner acquired) —
    // simulated here directly, since real acquisition would require a live
    // owner-a to release first. The identity (claimId) differs, so this
    // must count as observation 1 of a NEW streak, not observation 3.
    safeRemoveDir(markerPath2Dir(taskFolderPath));
    const markerPathB = writeFakeAdmissionMarkerV1(taskFolderPath, {
      purpose: "admission",
      pid: 2,
      hostId: "foreign-host-b",
      ownerToken: "owner-b",
    });
    backdateFileV1(markerPathB, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());
    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "owner-b's streak must start over at 1, not continue owner-a's count of 2"
    );
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

/** `writeFakeAdmissionMarkerV1` always writes into the same admission
 * directory for a given taskFolderPath — this returns that directory so a
 * test can clear it before planting a second, unrelated marker (simulating
 * "the old marker is gone, a new one now exists"). */
function markerPath2Dir(taskFolderPath: string): string {
  return path.join(admissionTestRootV1, Buffer.from(taskFolderPath).toString("hex"), ADMISSION_DIRNAME_V1);
}

// 2026-09-16 review, completion blocker: the consecutive-observation notice
// streak above was previously exercised only for `foreignHost`. The other two
// notice-worthy liveness kinds (`sameHostAlive`, `corrupt`) already had
// dedicated coverage for `describeStaleWorkAdmissionTakeoverNoticeV1`'s
// wording and `takeOverStaleWorkAdmissionMarkerV1`'s takeover mechanics
// (`workAdmissionV1.test.ts`), but never for the `armAll`-driven 3-consecutive
// -sweep threshold itself — leaving open the possibility that the threshold
// logic in `surfaceStaleWorkAdmissionTakeoverNoticeV1` was accidentally
// specific to the `foreignHost` branch. These two tests close that gap.

void test("armAll surfaces a takeover notice only after 3 consecutive sweeps observe the SAME stuck (sameHostAlive) owner, never sooner", async () => {
  const taskFolderPath = "C:\\tasks\\takeover-notice-streak-alive";
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath, canonicalId: taskFolderPath, progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeAdmissionMarkerV1(taskFolderPath, {
    purpose: "admission",
    pid: process.pid, // this test's own process: genuinely alive, same host
    hostId: myHostId,
    ownerToken: "stuck-alive-owner",
  });
  backdateFileV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());

  try {
    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "1 observation must not yet surface a notice"
    );

    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "2 observations must not yet surface a notice"
    );

    await scheduler.armAll();
    const takeoverEntries = surface.entries.filter((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission");
    assert.equal(takeoverEntries.length, 1, "the 3rd consecutive observation must surface exactly one notice");
    assert.equal(takeoverEntries[0]?.level, "warning");
    // sameHostAlive is the one liveness kind carrying a strong warning — see
    // `describeStaleWorkAdmissionTakeoverNoticeV1`'s own dedicated wording test.
    assert.match(takeoverEntries[0]?.message ?? "", /still respond|alive|running/i);
    assert.deepEqual(takeoverEntries[0]?.actionCommand?.args, [
      { taskFolderPath, expectedMarkerPath: markerPath, expectedClaimId: "stuck-alive-owner-claim" },
    ]);

    await scheduler.armAll();
    assert.equal(
      surface.entries.filter((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission").length,
      1,
      "the notice must not repeat for the same unresolved streak"
    );

    // A live owner's marker must never be mutated by the mere act of
    // observing and noticing it — the notice is advisory only.
    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll surfaces a takeover notice only after 3 consecutive sweeps observe the SAME stuck (corrupt) marker, never sooner", async () => {
  const taskFolderPath = "C:\\tasks\\takeover-notice-streak-corrupt";
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath, canonicalId: taskFolderPath, progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  // A corrupt marker: unparseable JSON at a well-formed marker filename, so
  // `probeWorkAdmissionOwnerLivenessV1` has an owner-record to attempt to
  // read and fails, exactly as `workAdmissionV1.test.ts`'s own corrupt-marker
  // fixtures do (see "an unreadable (corrupt) marker can be taken over...").
  const dir = markerPath2Dir(taskFolderPath);
  fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, "admission.corruptowner.g1.deadbeef");
  fs.writeFileSync(markerPath, "{ not valid json");
  backdateFileV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000, clock.now());

  try {
    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "1 observation must not yet surface a notice"
    );

    await scheduler.armAll();
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "2 observations must not yet surface a notice"
    );

    await scheduler.armAll();
    const takeoverEntries = surface.entries.filter((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission");
    assert.equal(takeoverEntries.length, 1, "the 3rd consecutive observation must surface exactly one notice");
    assert.equal(takeoverEntries[0]?.level, "warning");
    assert.match(takeoverEntries[0]?.message ?? "", /unreadable record|cannot be determined/i);
    // A corrupt record carries no readable `claimId`, so the notice-state
    // identity key falls back to the marker path itself — the takeover
    // command args must still name the exact observed marker.
    assert.deepEqual(takeoverEntries[0]?.actionCommand?.args, [
      { taskFolderPath, expectedMarkerPath: markerPath, expectedClaimId: undefined },
    ]);

    await scheduler.armAll();
    assert.equal(
      surface.entries.filter((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission").length,
      1,
      "the notice must not repeat for the same unresolved streak"
    );

    assert.equal(fs.existsSync(markerPath), true, "a corrupt marker must never be mutated by observation alone");
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

// 2026-09-16 review, narrowed completion blocker: every takeover-notice test
// above exercises a marker already PAST the stale threshold. None asserted
// the converse — that a marker still within its fresh heartbeat window never
// offers takeover, no matter how many consecutive sweeps observe it. Without
// this, a bug that dropped the staleness gate entirely (surfacing a notice
// for ANY marker) would pass every other test in this file.
void test("armAll never surfaces a takeover notice for a fresh (non-stale) admission marker, however many consecutive sweeps observe it", async () => {
  const taskFolderPath = "C:\\tasks\\takeover-notice-fresh-marker";
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath, canonicalId: taskFolderPath, progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  const myHostId = await resolveHostIdentityV1();
  // Deliberately alive (this test's own PID) and same-host, i.e. exactly the
  // ownership shape that DOES eventually warrant a notice once stale — but
  // this marker's mtime is left fresh (no backdate at all), so it must never
  // cross the staleness gate regardless of owner shape.
  const markerPath = writeFakeAdmissionMarkerV1(taskFolderPath, {
    purpose: "admission",
    pid: process.pid,
    hostId: myHostId,
    ownerToken: "fresh-owner",
  });
  // Explicitly pinned well under WORK_ADMISSION_LIKELY_STALE_MS_V1 (20m),
  // relative to the SAME clock the sweep reads, rather than left at the
  // real filesystem mtime — deterministic regardless of wall-clock skew
  // between the FakeClock's fixed epoch and the sandbox's real system time.
  backdateFileV1(markerPath, 60_000, clock.now());

  try {
    for (let i = 0; i < 5; i++) {
      await scheduler.armAll();
    }
    assert.equal(
      surface.entries.some((e) => e.actionCommand?.command === "vs-code-ai-helper.takeOverStaleWorkAdmission"),
      false,
      "a fresh marker must never surface a takeover notice, however many consecutive sweeps observe it"
    );
    assert.equal(fs.existsSync(markerPath), true, "a fresh marker must never be mutated by observation alone");
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("armAll collects an aged reclamation tombstone via the GC pass", async () => {
  const taskFolderPath = "C:\\tasks\\takeover-gc-target";
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const progress = baseStalledProgress();
  const state = memoryStore(progress);
  const inventory = {
    getTasks: () => [{ taskFolderPath, canonicalId: taskFolderPath, progress }],
  } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const fakeContext = installFakeExtensionContextV1();

  const markerPath = writeFakeAdmissionMarkerV1(taskFolderPath, { purpose: "admission", ownerToken: "gc-target" });
  const tombstonePath = `${markerPath}.tombstone`;
  fs.renameSync(markerPath, tombstonePath);
  backdateFileV1(tombstonePath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000, clock.now());

  try {
    await scheduler.armAll();
    assert.equal(fs.existsSync(tombstonePath), false, "an aged tombstone must be collected during armAll");
  } finally {
    fakeContext.restore();
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("takeOverStaleWorkAdmissionCommandV1 takes over a stale foreignHost admission marker end to end and reports success", async () => {
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), displayName: "a stuck task" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();

  // `writeFakeAdmissionMarkerV1` (not a hand-built path under
  // `folder.taskFolderPath` directly) — this file's `setWorkAdmissionRootOverrideForTestV1`
  // redirects every real admission-directory lookup to a hex-encoded
  // subdirectory of `admissionTestRootV1`; writing to the un-redirected path
  // directly would plant a marker the code under test never actually reads.
  const markerPath = writeFakeAdmissionMarkerV1(folder.taskFolderPath, {
    purpose: "admission",
    pid: 987654,
    hostId: "definitely-a-different-host-id",
    ownerToken: "stuck-real-owner",
  });
  const old = new Date(Date.now() - (WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000));
  fs.utimesSync(markerPath, old, old);

  try {
    await takeOverStaleWorkAdmissionCommandV1(inventory, {
      taskFolderPath: folder.taskFolderPath,
      expectedMarkerPath: markerPath,
      expectedClaimId: "stuck-real-owner-claim",
    });

    assert.equal(fs.existsSync(markerPath), false, "the original marker must be gone after a successful takeover");
    assert.equal(hasLiveWorkAdmissionBestEffortV1(folder.taskFolderPath), false);
    const infoEntries = surface.entries.filter((e) => e.level === "info");
    assert.ok(
      infoEntries.some((e) => /took over/i.test(e.message)),
      `expected a success notification; got: ${JSON.stringify(surface.entries)}`
    );

    // The bounded displaced-owner diagnostic must be recorded durably in the
    // task's own run log, not only the extension console (2026-09-15 review,
    // completion blocker).
    const runsDir = path.join(folder.taskFolderPath, "runs");
    const runLogFiles = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
    const takeoverRecordName = runLogFiles.find((n) => n.endsWith(".stale-work-admission-takeover.json"));
    assert.ok(takeoverRecordName, `expected a durable takeover run-log record; got: ${JSON.stringify(runLogFiles)}`);
    const takeoverRecord = JSON.parse(fs.readFileSync(path.join(runsDir, takeoverRecordName), "utf8")) as {
      outcome: string;
      purpose: string;
      displacedOwner?: { commandId: string };
    };
    assert.equal(takeoverRecord.outcome, "takenOver");
    assert.equal(takeoverRecord.purpose, "admission");
    assert.equal(takeoverRecord.displacedOwner?.commandId, "fake-owner-command");

    // A takeover must actually unblock a new acquisition.
    const retry = await acquireWorkAdmissionV1({ taskFolderPath: folder.taskFolderPath, purpose: "admission", commandId: "new-real-owner" });
    assert.equal(retry.outcome, "acquired");
    if (retry.outcome === "acquired") {
      await retry.handle.release();
    }
  } finally {
    realFs.restore();
    deactivateNotificationRouter();
    folder.cleanup();
  }
});

void test("takeOverStaleWorkAdmissionCommandV1 refuses and reports (no mutation) when the observed owner no longer matches", async () => {
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), displayName: "a stuck task" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();

  const markerPath = writeFakeAdmissionMarkerV1(folder.taskFolderPath, {
    purpose: "admission",
    hostId: "definitely-a-different-host-id",
    ownerToken: "real-current-owner",
  });
  const old = new Date(Date.now() - (WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000));
  fs.utimesSync(markerPath, old, old);

  try {
    await takeOverStaleWorkAdmissionCommandV1(inventory, {
      taskFolderPath: folder.taskFolderPath,
      expectedMarkerPath: markerPath,
      expectedClaimId: "some-stale-claim-id-that-no-longer-matches",
    });

    assert.equal(fs.existsSync(markerPath), true, "an owner mismatch must never mutate the marker");
    assert.ok(
      surface.entries.some((e) => /changed/i.test(e.message)),
      `expected an explanatory notification; got: ${JSON.stringify(surface.entries)}`
    );
  } finally {
    realFs.restore();
    deactivateNotificationRouter();
    folder.cleanup();
  }
});

void test("takeOverStaleWorkAdmissionCommandV1 does nothing when no expectedMarkerPath was supplied (2026-09-15 review: never act without the exact observed identity)", async () => {
  const folder = createRealTaskFolderV1("impl");
  const progress: TaskProgress = { ...readPersistedProgress(folder.progressPath), displayName: "a stuck task" };
  fs.writeFileSync(folder.progressPath, JSON.stringify(progress, null, 2), "utf8");
  const inventory = stubInventory(folder.taskFolderPath, "task-id", progress);
  const surface = new RecordingSurfaceV1();
  initNotificationRouter(surface);
  const realFs = installRealWorkspaceFsV1();

  const markerPath = writeFakeAdmissionMarkerV1(folder.taskFolderPath, {
    purpose: "admission",
    hostId: "definitely-a-different-host-id",
    ownerToken: "untouched-owner",
  });
  const old = new Date(Date.now() - (WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000));
  fs.utimesSync(markerPath, old, old);

  try {
    await takeOverStaleWorkAdmissionCommandV1(inventory, {
      taskFolderPath: folder.taskFolderPath,
      expectedClaimId: "untouched-owner-claim",
      // expectedMarkerPath deliberately omitted.
    });

    assert.equal(fs.existsSync(markerPath), true, "no expectedMarkerPath means no action, ever");
    assert.equal(surface.entries.length, 0, "no notification should be shown for a malformed invocation");
  } finally {
    realFs.restore();
    deactivateNotificationRouter();
    folder.cleanup();
  }
});

void test("watchdog pause card for a blocked resume plan never offers an inert resume, and restoreSummary tries again after restoring", () => {
  const target = {
    canonicalId: "task-id",
    taskFolderPath: "/tmp/task",
    stage: "impl-high-review" as const,
    taskName: "t",
  };
  const restorable = buildStalledTaskEscalationDecisionV1(false, target, {
    kind: "blocked",
    precondition: "the implementation summary is unusable.",
    restoreSummary: true,
  });
  // restoreSummary is an Ensemble-performed adjustment (resumeKind: continue),
  // so it both restores AND tries again — it dispatches
  // resumeAndApplyCurrentStageAction, but only once
  // restoreRejectedImplementationRound has confirmed the restore actually
  // replaced something (see that command's own `rerunCommandId` guard).
  assert.equal(restorable.gating?.unblocksProgress, true);
  assert.equal(restorable.recommendation.kind, "option");
  assert.equal(
    restorable.recommendation.kind === "option" ? restorable.recommendation.optionId : undefined,
    "restoreSummary"
  );
  assert.ok(!restorable.options.some((o) => o.optionId === "resumeAndRerun"), "no inert resume option");
  const restore = restorable.options.find((o) => o.optionId === "restoreSummary");
  assert.equal(restore?.resumeKind, "continue");
  assert.deepEqual(restore?.effect, {
    kind: "command",
    command: "vs-code-ai-helper.restoreRejectedImplementationRound",
    args: ["/tmp/task", "impl-high-review", "vs-code-ai-helper.resumeAndApplyCurrentStageAction"],
  });

  const unrestorable = buildStalledTaskEscalationDecisionV1(false, target, {
    kind: "blocked",
    precondition: "the implementation summary is unusable.",
  });
  assert.equal(unrestorable.recommendation.kind, "none");
  assert.equal(unrestorable.gating?.unblocksProgress, false);
  assert.ok(unrestorable.options.every((o) => o.effect.kind === "doNothing"));

  const runnable = buildStalledTaskEscalationDecisionV1(false, target, {
    kind: "run-review",
    label: "Resume and run the review again (Copilot)",
  });
  assert.equal(runnable.gating?.unblocksProgress, true);
  const resumeOption = runnable.options.find((o) => o.optionId === "resumeAndRerun");
  // item 22: a run-review plan's label says it does not edit code, resolved
  // at card-build time by describeResumeOptionV1 from the plan's own kind.
  assert.equal(
    resumeOption?.label,
    "Resume and run the review again (Copilot) — a review; it does not edit code"
  );
  assert.deepEqual(resumeOption?.effect, {
    kind: "command",
    command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
    args: [{ taskFolderPath: "/tmp/task" }],
  });
});

void test("the delayed-retry card offers Run now beside a default Wait, and says when the retry is due (v1 fixes 2, item 22)", () => {
  const dueAt = new Date("2026-01-01T00:10:00.000Z");
  const decision = buildDelayedRetryDecisionV1(
    { canonicalId: "task-id", taskFolderPath: "/tmp/task", stage: "plan", taskName: "Demo" },
    "refused",
    dueAt,
    "the review is running"
  );
  assert.equal(decision.decisionKey, "scheduledActionRunNow");
  assert.match(decision.whatHappened, /"Demo"/);
  assert.match(decision.whatHappened, /the review is running/);
  assert.ok(decision.whatHappened.includes(dueAt.toLocaleString()), "names when the next attempt is due");
  assert.equal(decision.recommendation.kind, "option");
  assert.equal((decision.recommendation as { optionId: string }).optionId, "waitForRetry");
  const wait = decision.options.find((option) => option.optionId === "waitForRetry");
  assert.deepEqual(wait?.effect, { kind: "doNothing" });
  const runNow = decision.options.find((option) => option.optionId === "runNow");
  assert.deepEqual(runNow?.effect, {
    kind: "command",
    command: "vs-code-ai-helper.runScheduledActionNow",
    args: [{ taskFolderPath: "/tmp/task", canonicalId: "task-id" }],
  });
  assert.equal(decision.gating?.unblocksProgress, false);
});

void test("Run now takes the same fire() path as the timer, before the schedule is due (v1 fixes 2, item 22)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z")); // runAt is a minute away
  const taskFolderPath = "C:\\tasks\\run-now";
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  initNotificationRouter({ addEntry(): void {} });
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  const dispatchedCommands: string[] = [];
  commands.executeCommand = ((command: string) => {
    dispatchedCommands.push(command);
    return Promise.resolve(true);
  }) as typeof commands.executeCommand;
  try {
    await scheduler.arm(taskFolderPath, "task-id");
    assert.deepEqual(dispatchedCommands, [], "nothing fires before the schedule is due");

    const outcome = await scheduler.runNow(taskFolderPath, "task-id");

    assert.equal(outcome, "started");
    assert.deepEqual(dispatchedCommands, ["vs-code-ai-helper.applyCurrentStageAction"]);
    assert.equal(state.current().scheduledRun, undefined, "the schedule is consumed exactly as a timer firing would");

    assert.equal(await scheduler.runNow(taskFolderPath, "task-id"), "nothingScheduled");
    assert.equal(dispatchedCommands.length, 1, "a second Run now dispatches nothing");
  } finally {
    commands.executeCommand = original;
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("Run now against a task another action holds is refused through fire(), naming the holder, and keeps the schedule (v1 fixes 2, item 22)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const taskFolderPath = "C:\\tasks\\run-now-busy";
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const warnings: string[] = [];
  initNotificationRouter({
    addEntry(message: string): void {
      if (message.includes("could not start yet")) {
        warnings.push(message);
      }
    },
  });
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  let dispatched = 0;
  commands.executeCommand = (() => {
    dispatched += 1;
    return Promise.resolve(true);
  }) as typeof commands.executeCommand;
  const holder = await acquireWorkAdmissionV1({ taskFolderPath, purpose: "admission", commandId: "runReviewWithAI" });
  assert.equal(holder.outcome, "acquired");
  try {
    await scheduler.arm(taskFolderPath, "task-id");
    const outcome = await scheduler.runNow(taskFolderPath, "task-id");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(outcome, "refused", "a refused Run now must not report started");
    assert.equal(dispatched, 0, "a held task is never dispatched into");
    assert.equal(warnings.length, 1, "the refusal is reported, naming what holds the task");
    assert.ok(state.current().scheduledRun !== undefined, "the schedule is kept");
  } finally {
    if (holder.outcome === "acquired") {
      await holder.handle.release();
    }
    commands.executeCommand = original;
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});

void test("the owed-continuation card offers Run now beside a default Wait, both truthful about the wait (v1 fixes 2, item 22)", () => {
  const decision = buildOwedContinuationDecisionV1(
    { canonicalId: "task-id", taskFolderPath: "C:\\tasks\\owed", stage: "impl", taskName: "Owed" },
    new Date("2026-01-01T01:00:00.000Z"),
    "an earlier attempt claimed it and has not started a round"
  );
  assert.equal(decision.decisionKey, "owedContinuationRunNow");
  assert.equal(decision.recommendation?.kind, "option");
  assert.equal(decision.recommendation?.kind === "option" ? decision.recommendation.optionId : undefined, "waitForRetry");
  assert.deepEqual(decision.options.find((option) => option.optionId === "waitForRetry")?.effect, { kind: "doNothing" });
  assert.deepEqual(decision.options.find((option) => option.optionId === "runNow")?.effect, {
    kind: "command",
    command: "vs-code-ai-helper.runOwedContinuationNow",
    args: [{ taskFolderPath: "C:\\tasks\\owed", canonicalId: "task-id" }],
  });
  assert.equal(decision.gating?.unblocksProgress, false);
  assert.match(decision.whatHappened, /has not started a round/);
});

void test("Run now on an owed continuation never clears another window's live lease and names the holder (v1 fixes 2, item 22)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const fakeContext = installFakeExtensionContextV1();
  const progress: TaskProgress = {
    ...baseStalledProgress({}),
    implRecovery: {
      sourceAttemptId: "x",
      reason: "x",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "pending",
      at: "2026-01-01T00:00:00.000Z",
      leaseOwner: "other-window",
      leaseUntil: "2026-01-01T04:00:00.000Z", // live, and NOT this window's
    },
  };
  const state = memoryStore(progress);
  const inventory = { getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", progress }] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  initNotificationRouter(new RecordingSurfaceV1());
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const originalExecute = commands.executeCommand;
  let dispatched = 0;
  commands.executeCommand = (() => {
    dispatched += 1;
    return Promise.resolve(undefined);
  }) as typeof commands.executeCommand;
  resetAutomationChainGuards();
  try {
    const outcome = await scheduler.runOwedContinuationNow("C:\\tasks\\task", "task-id");
    assert.equal(outcome, "refused");
    assert.equal(state.current().implRecovery?.leaseOwner, "other-window", "the other window's claim is left intact");
    assert.equal(state.current().implRecovery?.leaseUntil, "2026-01-01T04:00:00.000Z");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(dispatched, 0, "nothing was dispatched underneath the live claim");
  } finally {
    commands.executeCommand = originalExecute;
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    scheduler.dispose();
    fakeContext.restore();
  }
});

void test("Run now on an owed continuation ends this window's own lease wait and takes the sweep's claim-and-dispatch path (v1 fixes 2, item 22)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const fakeContext = installFakeExtensionContextV1();
  const progress: TaskProgress = {
    ...baseStalledProgress({}),
    implRecovery: {
      sourceAttemptId: "x",
      reason: "x",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "pending",
      at: "2026-01-01T00:00:00.000Z",
      leaseOwner: "test-owner",
      leaseUntil: "2026-01-01T05:00:00.000Z", // this window's own earlier claim: the sweep would wait two hours
    },
  };
  const state = memoryStore(progress);
  const inventory = { getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", progress }] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  initNotificationRouter(new RecordingSurfaceV1());
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const originalExecute = commands.executeCommand;
  let dispatched = 0;
  commands.executeCommand = (() => {
    dispatched += 1;
    return Promise.resolve(undefined);
  }) as typeof commands.executeCommand;
  resetAutomationChainGuards();
  try {
    const outcome = await scheduler.runOwedContinuationNow("C:\\tasks\\task", "task-id");
    assert.equal(outcome, "started");
    assert.equal(state.current().implRecovery?.leaseOwner, "test-owner", "this window re-claimed it, ending its own lease wait");
    assert.equal(state.current().implRecovery?.leaseUntil, "2026-01-01T04:00:00.000Z", "the old two-hour lease was replaced by a fresh one");
    for (let waited = 0; dispatched === 0 && waited < 3000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(dispatched > 0, "the continuation chain dispatches before the stub is restored");

    // Nothing owed any more -> nothing to run.
    const cleared = memoryStore({ ...progress, implRecovery: undefined });
    const idle = new TaskActionScheduler(inventory, clock, cleared.store, "test-owner");
    assert.equal(await idle.runOwedContinuationNow("C:\\tasks\\task", "task-id"), "nothingOwed");
    idle.dispose();
  } finally {
    commands.executeCommand = originalExecute;
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    scheduler.dispose();
    fakeContext.restore();
  }
});

void test("two overlapping Run-now attempts in one window: the loser neither clears nor releases the winner's lease (v1 fixes 2, item 22)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T03:00:00.000Z"));
  const fakeContext = installFakeExtensionContextV1();
  const progress: TaskProgress = {
    ...baseStalledProgress({}),
    implRecovery: {
      sourceAttemptId: "x",
      reason: "x",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "pending",
      at: "2026-01-01T00:00:00.000Z",
    },
  };
  const state = memoryStore(progress);
  const inventory = { getTasks: () => [{ taskFolderPath: "C:\\tasks\\task", progress }] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  initNotificationRouter(new RecordingSurfaceV1());
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const originalExecute = commands.executeCommand;
  let dispatched = 0;
  commands.executeCommand = (() => {
    dispatched += 1;
    return Promise.resolve(undefined);
  }) as typeof commands.executeCommand;
  resetAutomationChainGuards();
  try {
    const [first, second] = await Promise.all([
      scheduler.runOwedContinuationNow("C:\\tasks\\task", "task-id"),
      scheduler.runOwedContinuationNow("C:\\tasks\\task", "task-id"),
    ]);
    assert.deepEqual([first, second].sort(), ["refused", "started"], "exactly one attempt dispatches");
    assert.equal(state.current().implRecovery?.leaseOwner, "test-owner", "the winner's claim was not cleared by the loser");
    assert.equal(state.current().implRecovery?.leaseUntil, "2026-01-01T04:00:00.000Z");
    for (let waited = 0; dispatched === 0 && waited < 3000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(dispatched, 1, "one chain dispatched, not two");
  } finally {
    commands.executeCommand = originalExecute;
    resetAutomationChainGuards();
    deactivateNotificationRouter();
    scheduler.dispose();
    fakeContext.restore();
  }
});

void test("Run now whose downstream dispatch declines reports refused, keeps the schedule and names the reason instead of a generic toast (v1 fixes 2, item 22)", async () => {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const taskFolderPath = "C:\\tasks\\run-now-declined";
  const state = memoryStore(scheduledProgress("plan"));
  const inventory = { getTasks: () => [] } as unknown as TaskInventory;
  const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");
  const notices: string[] = [];
  initNotificationRouter({
    addEntry(message: string): void {
      notices.push(message);
    },
  });
  const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const original = commands.executeCommand;
  // The stage-action router records why it declined; the card must carry that
  // real cause, not a guess.
  commands.executeCommand = (() => {
    recordStageActionRefusalReasonV1(taskFolderPath, "no model is configured for the plan stage, or its provider is disabled");
    return Promise.resolve(false);
  }) as typeof commands.executeCommand;
  try {
    await scheduler.arm(taskFolderPath, "task-id");
    const outcome = await scheduler.runNow(taskFolderPath, "task-id");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(outcome, "refused");
    // Refusal re-arms the schedule (adding this window's lease metadata), so
    // assert the retained intent — when and which stage — not the exact shape.
    assert.equal(state.current().scheduledRun?.runAt, "2026-01-01T00:01:00.000Z", "the schedule is kept");
    assert.equal(state.current().scheduledRun?.stage, "plan");
    assert.equal(notices.filter((message) => message.includes("could not start yet")).length, 1, "one refusal notice");
    assert.ok(
      notices.some((message) => message.includes("no model is configured for the plan stage")),
      "the actual failed prerequisite is named"
    );
    assert.ok(!notices.some((message) => message.includes("may still be paused")), "no speculative reason");
    assert.ok(!notices.some((message) => message.includes("did not start")), "the old generic toast is gone");
  } finally {
    commands.executeCommand = original;
    deactivateNotificationRouter();
    scheduler.dispose();
  }
});
