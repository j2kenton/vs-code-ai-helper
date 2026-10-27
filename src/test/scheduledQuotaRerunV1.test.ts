/**
 * bugs2 finding 13: the rerun scheduled for a quota reset.
 *
 * - it lifts the pause the SAME quota stop created, then runs once;
 * - a user pause, another cause, a legacy schedule or another active task still
 *   blocks it, and the card names which one and offers Resume first;
 * - a stale review is reviewed again, never "applied" into a refusal;
 * - a refusal is reported with its real reason, and a refusal that repeats is
 *   ONE card refreshed in place with back-off — not a new card every minute.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  REFUSED_SCHEDULE_MAX_RETRY_DELAY_MS_V1,
  REFUSED_SCHEDULE_RETRY_DELAY_MS_V1,
  refusedScheduleRetryDelayMsV1,
  SchedulerClock,
  TaskActionScheduler,
  buildDelayedRetryDecisionV1,
} from "../commands/scheduleTaskResume";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { recordStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";
import { acquireWorkAdmissionV1 } from "../state/workAdmissionV1";
import { readChatHistory } from "../utils/chatHistoryStore";
import { fixtureOwnershipFor, readTaskProgressForTest } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";
import { ResumeActionPlanV1 } from "../utils/resumeActionPlanV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-quota-rerun-"));
after(() => {
  safeRemoveDir(REAL_ROOT);
});

const STOP_ID = "stop-aaaa";
const BASE = Date.parse("2026-10-24T20:54:00.000Z");

class FakeClock implements SchedulerClock {
  private nextId = 0;
  readonly delays: number[] = [];
  private readonly callbacks = new Map<number, () => void>();
  constructor(private value: number) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = ++this.nextId;
    this.delays.push(delay);
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.callbacks.delete(timer as unknown as number);
  }
  pending(): number {
    return this.callbacks.size;
  }
  fireNext(): void {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    assert.ok(next, "expected an armed timer");
    this.callbacks.delete(next[0]);
    next[1]();
  }
}

/** The refusal card is posted from a detached call; wait for what the test asserts on. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, what = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function chatAnchorCount(folder: string): Promise<number> {
  return (await readChatHistory(folder, folder)).filter((m) => m.kind === "decision").length;
}

class RecordingSurface {
  entries: { message: string; level: string }[] = [];
  addEntry(message: string, level: string): void {
    this.entries.push({ message, level });
  }
}

function fixture(
  name: string,
  overrides: Partial<TaskProgress>
): { folder: string; progress: TaskProgress } {
  const folder = path.join(REAL_ROOT, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "task.md"), "# Task\n", "utf8");
  const progress: TaskProgress = {
    taskFolder: name,
    displayName: name,
    currentStage: "impl-low-review",
    status: "paused",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T20:36:30.000Z",
    ownership: fixtureOwnershipFor(folder),
    pausedReason: "Every configured model for impl-low-review is currently blocked by a quota/credit-limit restriction",
    quotaParkRecord: {
      modelId: "openai-codex:gpt-6",
      providerId: "codex",
      failureKind: "quota",
      resetAt: "2026-10-24T20:52:00.000Z",
      observedAt: "2026-10-24T20:36:30.000Z",
      stopId: STOP_ID,
    },
    scheduledRun: { runAt: new Date(BASE).toISOString(), stage: "impl-low-review", quotaStopId: STOP_ID },
    ...overrides,
  };
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return { folder, progress };
}

function inventoryOver(
  tasks: ReadonlyArray<{ folder: string; progress: TaskProgress }>
): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const items = tasks.map((t) => ({
    canonicalId: t.folder,
    taskFolderPath: t.folder,
    folderName: path.basename(t.folder),
    sourceScopeKey: t.folder,
    progress: t.progress,
  }));
  inv.refresh = async (): Promise<void> => {
    for (const item of items) {
      const fresh = await readTaskProgressForTest(vscode.Uri.file(item.taskFolderPath));
      if (fresh) {
        item.progress = fresh;
      }
    }
  };
  inv.getTasks = (): typeof items => items;
  inv.getTaskById = (id: string): (typeof items)[number] | undefined => items.find((t) => t.canonicalId === id);
  inv.getTaskByPath = (p: string): (typeof items)[number] | undefined => items.find((t) => t.taskFolderPath === p);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function installEnvironment(): { memento: vscode.Memento; restore: () => void; commands: string[]; reply: { value: unknown } } {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...values.keys()],
  } as unknown as vscode.Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
  const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origRead = fsTarget.readFile;
  fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  const commandsTarget = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
  const origExecute = commandsTarget.executeCommand;
  const commands: string[] = [];
  const reply = { value: true as unknown };
  commandsTarget.executeCommand = ((command: string) => {
    commands.push(command);
    return Promise.resolve(reply.value);
  }) as typeof commandsTarget.executeCommand;
  return {
    memento,
    commands,
    reply,
    restore: (): void => {
      __extensionContextV1TestOnly.reset();
      fsTarget.readFile = origRead;
      commandsTarget.executeCommand = origExecute;
    },
  };
}

async function runOnce(
  scheduler: TaskActionScheduler,
  folder: string
): Promise<"started" | "refused" | "nothingScheduled" | "heldElsewhere"> {
  return scheduler.runNow(folder, folder);
}

function pendingCard(memento: vscode.Memento, folder: string) {
  return new WorkflowDecisionStoreV1(memento).listPending(folder).find((d) => d.decisionKey === "scheduledActionRunNow");
}

/** The card once it is posted (the refusal posts it from a detached call); `undefined` if none ever appears. */
async function cardWhenPosted(memento: vscode.Memento, folder: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const card = pendingCard(memento, folder);
    if (card) {
      return card;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

afterEach(() => {
  deactivateNotificationRouter();
});

void describe("the rerun scheduled for a quota reset (bugs2 finding 13)", () => {
  void it("lifts the pause its own quota stop created and runs the stage action once, with no refusal card", async () => {
    const task = fixture("own-pause", {});
    const env = installEnvironment();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      assert.equal(await runOnce(scheduler, task.folder), "started");
      assert.deepEqual(env.commands, ["vs-code-ai-helper.applyCurrentStageAction"]);
      const after = await readTaskProgressForTest(vscode.Uri.file(task.folder));
      assert.equal(after?.status, "active", "the pause the same quota stop created is lifted");
      assert.equal(after?.pausedReason, undefined);
      assert.equal(after?.scheduledRun, undefined, "the schedule is consumed");
      assert.equal(await cardWhenPosted(env.memento, task.folder), undefined, "no refusal card");
      assert.ok(!surface.entries.some((e) => /could not start/.test(e.message)));
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("never lifts a user pause, even when a stale quota record from the earlier stop is still on the task", async () => {
    // quota stop → schedule → user resumed (pausedReason cleared, record kept) → user paused again.
    const task = fixture("user-pause", { pausedReason: undefined });
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      assert.equal(await runOnce(scheduler, task.folder), "refused");
      assert.deepEqual(env.commands, [], "nothing is dispatched into a paused task");
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.status, "paused");
      const card = await cardWhenPosted(env.memento, task.folder);
      assert.ok(card, "one card is posted");
      assert.match(card.whatHappened, /you paused it/);
      assert.equal(card.options[0]?.optionId, "resumeTask", "Resume is the first, recommended option");
      assert.deepEqual(card.recommendation, {
        kind: "option",
        optionId: "resumeTask",
        reasoning: (card.recommendation as { reasoning: string }).reasoning,
      });
      assert.ok(card.options.some((o) => o.optionId === "runNow"));
      assert.ok(card.options.some((o) => o.optionId === "waitForRetry"));
      assert.doesNotMatch(card.whyUserNeeded, /Something else was working/);
      // The schedule survives with its quota-stop binding.
      const kept = (await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.scheduledRun;
      assert.equal(kept?.quotaStopId, STOP_ID);
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("never lifts a watchdog pause and names the watchdog in the retry card", async () => {
    const task = fixture("watchdog-pause", { pausedReason: "Watchdog: 10m quiet" });
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      assert.equal(await runOnce(scheduler, task.folder), "refused");
      assert.deepEqual(env.commands, [], "nothing is dispatched into a watchdog-paused task");
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.status, "paused");
      const card = await cardWhenPosted(env.memento, task.folder);
      assert.ok(card, "one card is posted");
      assert.match(card.whatHappened, /stalled-task watchdog paused it/);
      assert.equal(card.options[0]?.optionId, "resumeTask", "Resume is the first, recommended option");
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("does not lift a pause from a DIFFERENT quota stop, nor any pause for a legacy schedule with no stop id", async () => {
    const different = fixture("different-stop", {
      quotaParkRecord: {
        modelId: "m",
        providerId: "p",
        failureKind: "quota",
        observedAt: "2026-10-24T21:00:00.000Z",
        stopId: "stop-bbbb",
      },
    });
    const legacy = fixture("legacy-schedule", {
      scheduledRun: { runAt: new Date(BASE).toISOString(), stage: "impl-low-review" },
    });
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([different, legacy]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      assert.equal(await runOnce(scheduler, different.folder), "refused");
      assert.match((await cardWhenPosted(env.memento, different.folder))?.whatHappened ?? "", /different provider quota stop/);
      assert.equal(await runOnce(scheduler, legacy.folder), "refused");
      assert.match((await cardWhenPosted(env.memento, legacy.folder))?.whatHappened ?? "", /not scheduled for that stop/);
      assert.deepEqual(env.commands, []);
      for (const t of [different, legacy]) {
        assert.equal((await readTaskProgressForTest(vscode.Uri.file(t.folder)))?.status, "paused");
      }
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("does not pause another active task to resume itself: it refuses, names that task, and offers Resume", async () => {
    const task = fixture("needs-the-slot", {});
    const other = fixture("already-active", { status: "active", pausedReason: undefined, quotaParkRecord: undefined, scheduledRun: undefined });
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([task, other]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      assert.equal(await runOnce(scheduler, task.folder), "refused");
      const card = await cardWhenPosted(env.memento, task.folder);
      assert.match(card?.whatHappened ?? "", /already-active/);
      assert.match(card?.whatHappened ?? "", /would pause/);
      assert.equal(card?.options[0]?.optionId, "resumeTask");
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.status, "paused");
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(other.folder)))?.status, "active");
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("runs the REVIEW, not Apply Review, when the review the stage would apply is stale", async () => {
    const task = fixture("stale-review", {});
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() =>
      Promise.resolve({ kind: "run-review", label: "Resume and run the review again" })
    );
    try {
      assert.equal(await runOnce(scheduler, task.folder), "started");
      assert.deepEqual(env.commands, ["vs-code-ai-helper.runReviewWithAI"]);
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.status, "active");
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("reports a blocked stage with the real unmet precondition, leaves the pause in force, and keeps the schedule", async () => {
    const task = fixture("blocked-stage", {});
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    const blocked: ResumeActionPlanV1 = { kind: "blocked", precondition: "No AI model is configured for the review." };
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve(blocked));
    try {
      assert.equal(await runOnce(scheduler, task.folder), "refused");
      const card = await cardWhenPosted(env.memento, task.folder);
      assert.match(card?.whatHappened ?? "", /No AI model is configured for the review\./);
      assert.doesNotMatch(card?.whyUserNeeded ?? "", /Something else was working/);
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.status, "paused", "a refusal leaves no lifted pause behind");
      assert.ok((await readTaskProgressForTest(vscode.Uri.file(task.folder)))?.scheduledRun !== undefined);
      assert.deepEqual(env.commands, []);
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("puts the pause back when the dispatch it lifted the pause for is refused", async () => {
    const task = fixture("dispatch-refused", {});
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    env.reply.value = false;
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      recordStageActionRefusalReasonV1(task.folder, "stale");
      assert.equal(await runOnce(scheduler, task.folder), "refused");
      const after = await readTaskProgressForTest(vscode.Uri.file(task.folder));
      assert.equal(after?.status, "paused");
      assert.equal(after?.pausedReason, task.progress.pausedReason, "the quota pause is restored exactly");
      assert.equal(after?.scheduledRun?.quotaStopId, STOP_ID);
      assert.match((await cardWhenPosted(env.memento, task.folder))?.whatHappened ?? "", /could not start/);
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("a genuinely busy task is reported as busy, naming the holder — and only then", async () => {
    const task = fixture("really-busy", { status: "active", pausedReason: undefined, quotaParkRecord: undefined, scheduledRun: { runAt: new Date(BASE).toISOString(), stage: "impl-low-review" } });
    const env = installEnvironment();
    initNotificationRouter(new RecordingSurface());
    const scheduler = new TaskActionScheduler(inventoryOver([task]), new FakeClock(BASE), undefined, "test-owner");
    const holder = await acquireWorkAdmissionV1({ taskFolderPath: task.folder, purpose: "admission", commandId: "runReviewWithAI" });
    assert.equal(holder.outcome, "acquired");
    try {
      assert.equal(await runOnce(scheduler, task.folder), "refused");
      const card = await cardWhenPosted(env.memento, task.folder);
      assert.match(card?.whatHappened ?? "", /runReviewWithAI/);
      assert.match(card?.whyUserNeeded ?? "", /Another operation holds this task/);
      assert.equal(card?.options.some((o) => o.optionId === "resumeTask"), false, "an active task is not offered Resume");
    } finally {
      if (holder.outcome === "acquired") {
        await holder.handle.release();
      }
      scheduler.dispose();
      env.restore();
    }
  });
});

void describe("repeated refusals of a scheduled action: one card, with back-off", () => {
  void it("posts ONE chat anchor and ONE notification across repeated refusals, backing off 1, 2, 4 minutes", async () => {
    const task = fixture("repeat-refusals", { pausedReason: undefined });
    const env = installEnvironment();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const clock = new FakeClock(BASE);
    const scheduler = new TaskActionScheduler(inventoryOver([task]), clock, undefined, "test-owner");
    scheduler.setScheduledActionPlanLoaderForTestV1(() => Promise.resolve({ kind: "apply-review", label: "apply" }));
    try {
      await scheduler.arm(task.folder, task.folder);
      for (let i = 0; i < 3; i++) {
        await waitUntil(() => clock.pending() > 0, `an armed timer before attempt ${i + 1}`);
        clock.fireNext();
        await scheduler.waitForPendingFiresForTestV1();
        // The refusal re-arms the schedule for its (backed-off) retry.
        await waitUntil(() => clock.pending() > 0, `a re-armed timer after refusal ${i + 1}`);
        clock.advance(clock.delays[clock.delays.length - 1] ?? 0);
      }
      await waitUntil(async () => (await chatAnchorCount(task.folder)) >= 1, "the chat anchor");
      const pending = new WorkflowDecisionStoreV1(env.memento)
        .listPending(task.folder)
        .filter((d) => d.decisionKey === "scheduledActionRunNow");
      assert.equal(pending.length, 1, "one card, refreshed in place");
      const anchors = (await readChatHistory(task.folder, task.folder)).filter((m) => m.kind === "decision");
      assert.equal(anchors.length, 1, "one chat anchor, not one per attempt");
      assert.equal(
        surface.entries.filter((e) => /could not start yet|Decision raised/.test(e.message)).length <= 1,
        true,
        "no repeated notification"
      );
      const retryDelays = clock.delays.filter((d) => d >= REFUSED_SCHEDULE_RETRY_DELAY_MS_V1);
      assert.deepEqual(retryDelays.slice(0, 3), [60_000, 120_000, 240_000], "the retry interval backs off");
    } finally {
      scheduler.dispose();
      env.restore();
    }
  });

  void it("computes a doubling, capped delay", () => {
    assert.equal(refusedScheduleRetryDelayMsV1(1), REFUSED_SCHEDULE_RETRY_DELAY_MS_V1);
    assert.equal(refusedScheduleRetryDelayMsV1(2), 2 * REFUSED_SCHEDULE_RETRY_DELAY_MS_V1);
    assert.equal(refusedScheduleRetryDelayMsV1(3), 4 * REFUSED_SCHEDULE_RETRY_DELAY_MS_V1);
    assert.equal(refusedScheduleRetryDelayMsV1(50), REFUSED_SCHEDULE_MAX_RETRY_DELAY_MS_V1);
    assert.equal(refusedScheduleRetryDelayMsV1(0), REFUSED_SCHEDULE_RETRY_DELAY_MS_V1);
  });

  void it("builds a card whose reason matches the refusal and lists its alternatives as options", () => {
    const target = { canonicalId: "c", taskFolderPath: "/t", stage: "impl-low-review" as const, taskName: "T" };
    const due = new Date("2026-10-24T21:00:00.000Z");
    const paused = buildDelayedRetryDecisionV1(target, "refused", due, "the task is paused (you paused it)", {
      category: "paused",
      offerResume: true,
    });
    assert.deepEqual(
      paused.options.map((o) => o.optionId),
      ["resumeTask", "runNow", "waitForRetry"]
    );
    assert.deepEqual(paused.options.map((option) => option.label), [
      "Resume the task", "Run now", "Wait for the automatic retry",
    ]);
    assert.equal(paused.recommendation.kind === "option" ? paused.recommendation.optionId : undefined, "resumeTask");
    assert.match(paused.whatHappened, /could not start/);
    assert.match(paused.whyUserNeeded, /task is paused/);
    assert.equal(paused.options[0]?.consequence,
      "Resumes the paused task (this pauses any other task that is active) and starts nothing by itself; " +
      "the scheduled action then runs at its next attempt, or choose Run now.");
    assert.equal(paused.options[1]?.consequence,
      "Runs the scheduled impl-low-review action immediately, exactly as the timer would. If something still stops it, this says what.");
    assert.equal(paused.options[2]?.consequence,
      `Does nothing. The scheduled action retries by itself at ${due.toLocaleString()}.`);
    assert.deepEqual(paused.options.flatMap((option) => option.effect.kind === "command" ? [option.effect.command] : []), [
      "vs-code-ai-helper.resumeTask", "vs-code-ai-helper.runScheduledActionNow",
    ]);
    assert.ok(!paused.options.some((option) => /Cancel Schedule|Open Settings/.test(option.label)),
      "the card lists the actual options rather than stale audit-register choices");
    const precondition = buildDelayedRetryDecisionV1(target, "refused", due, "the review is stale", { category: "precondition" });
    assert.deepEqual(
      precondition.options.map((o) => o.optionId),
      ["waitForRetry", "runNow"]
    );
    assert.deepEqual(precondition.options.map((option) => option.label), [
      "Wait for the automatic retry", "Run now",
    ]);
    assert.equal(precondition.recommendation.kind === "option" ? precondition.recommendation.optionId : undefined, "waitForRetry");
    assert.match(precondition.whatHappened, /the review is stale/);
    assert.match(precondition.whyUserNeeded, /retrying alone will not clear it/);
    const cancelled = buildDelayedRetryDecisionV1(target, "refused", due, "cancelled by the owner", {
      category: "cancelled",
      terminalOutcome: { kind: "cancelled", actionLabel: "Run Review" },
    });
    assert.match(cancelled.whatHappened, /was cancelled \(cancelled by the owner\)/);
    assert.equal(cancelled.recommendation.kind === "option" ? cancelled.recommendation.optionId : undefined, "waitForRetry");
    assert.deepEqual(cancelled.options.map((option) => option.label), [
      "Wait for the automatic retry", "Run now",
    ]);
    for (const card of [paused, precondition]) {
      assert.doesNotMatch(card.whyUserNeeded, /Something else was working/);
    }
  });
});
