/**
 * Composition test spanning scheduler -> router -> Publish admission
 * (2026-09-09 review completion blocker: "no composition test spanning
 * scheduler -> router -> Publish acquisition").
 *
 * `scheduleTaskResume.test.ts` stubs `applyCurrentStageAction` entirely and
 * only asserts which command id was dispatched and whether `scheduledRun`
 * cleared. `runPublishChecksAdmission.test.ts` calls `runPublishChecks`
 * directly with a hand-built copy of `applyCurrentStageAction`'s dispatch
 * shape. Neither exercises the real three-function chain TOGETHER, so a
 * regression in how any one of them threads `canonicalId`/`taskFolderPath`/
 * `admissionHandoffTokenV1` to the next could pass both suites while still
 * breaking the real scheduled-Publish path in production — exactly the
 * self-block ("fire() consumes the schedule without dispatching anything")
 * this task's Part 1a work exists to close.
 *
 * `vscode.commands.executeCommand` is wired to route
 * "vs-code-ai-helper.applyCurrentStageAction" and
 * "vs-code-ai-helper.runPublishChecks" to their REAL exported functions
 * (never stubbed), then `TaskActionScheduler.fire()` is driven through a fake
 * clock exactly as `scheduleTaskResume.ts`'s own production call chain does.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { applyCurrentStageAction } from "../commands/applyCurrentStageAction";
import { runPublishChecks } from "../commands/runPublishChecks";
import {
  SchedulerClock,
  SchedulerProgressStore,
  TaskActionScheduler,
} from "../commands/scheduleTaskResume";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-schedule-composition-"));
after(() => {
  fs.rmSync(REAL_ROOT, { recursive: true, force: true });
});

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

function writeProgress(folderPath: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
}

function fixtureProgress(taskFolderPath: string, overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
    ...overrides,
  };
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 },
  ];
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig; } };
}

/**
 * Configures a Publish-stage model so `ensureStageModelConfigured` passes for
 * both `applyCurrentStageAction`'s own model guard and `runPublishChecks`'
 * inline one, without a real model call. A bare (unprefixed) model id
 * resolves to the "copilot" provider (`parseModelSelection`'s default), and
 * the test shim's `getConfiguration().get("enabledProviders", ...)` always
 * reports every provider enabled regardless of this override.
 */
function installPublishModelSetting(): { restore: () => void } {
  const wsRecord = vscode.workspace as unknown as { _configOverrides: Map<string, unknown> };
  wsRecord._configOverrides.set("modelSettings", { publish: { primary: "test-publish-model" } });
  return {
    restore: (): void => {
      wsRecord._configOverrides.delete("modelSettings");
    },
  };
}

/** A fake inventory resolving exactly one task by canonical ID or path — mirrors
 * `runPublishChecksAdmission.test.ts`'s helper of the same purpose. */
function makeInventory(taskFolderPath: string, progress: TaskProgress): TaskInventory {
  const task = {
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    sourceScopeKey: taskFolderPath,
    progress,
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? task : undefined),
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [task],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

/** In-memory `SchedulerProgressStore` for the scheduler's OWN bookkeeping
 * (lease ownership, `scheduledRun` clearing) — deliberately separate from the
 * real on-disk `task-progress.json` the resolvers below read, mirroring
 * `scheduleTaskResume.test.ts`'s own `memoryStore` helper. */
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

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function fakeMemento(): vscode.Memento {
  return {
    get: () => undefined,
    update: () => Promise.resolve(undefined),
    keys: () => [],
  } as unknown as vscode.Memento;
}

void describe("scheduler -> applyCurrentStageAction -> runPublishChecks composition (2026-09-09 review completion blocker)", () => {
  void it("fire() dispatches through the REAL router into the REAL Publish command, adopting its own admission via the forwarded handoff token instead of self-blocking as busy", async () => {
    const taskFolderPath = makeTaskFolder("scheduled-publish-composition");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const inventory = makeInventory(taskFolderPath, progress);
    const currentTaskStore = new CurrentTaskStore(fakeMemento());

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const model = installPublishModelSetting();

    const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const state = memoryStore({
      ...progress,
      scheduledRun: { runAt: "2026-01-01T00:01:00.000Z", stage: "publish" },
    });
    const scheduler = new TaskActionScheduler(inventory, clock, state.store, "test-owner");

    const commands = vscode.commands as unknown as { executeCommand: typeof vscode.commands.executeCommand };
    const original = commands.executeCommand;
    const dispatchedCommandIds: string[] = [];
    commands.executeCommand = (async (id: string, arg?: unknown): Promise<unknown> => {
      dispatchedCommandIds.push(id);
      if (id === "vs-code-ai-helper.applyCurrentStageAction") {
        return applyCurrentStageAction(inventory, currentTaskStore, arg as never);
      }
      if (id === "vs-code-ai-helper.runPublishChecks") {
        return runPublishChecks(inventory, arg as never);
      }
      return undefined;
    }) as typeof commands.executeCommand;

    try {
      await scheduler.arm(taskFolderPath, taskFolderPath);
      clock.fireNext();
      // fire() acquires real, disk-backed work admission before consuming
      // scheduledRun — wait on the scheduler's own test-only signal that the
      // whole chain (including the two real downstream commands it now
      // dispatches into) has actually settled.
      await scheduler.waitForPendingFiresForTestV1();

      assert.deepEqual(
        dispatchedCommandIds,
        ["vs-code-ai-helper.applyCurrentStageAction", "vs-code-ai-helper.runPublishChecks"],
        "the scheduler must route through the real router into the real Publish command, in that order"
      );

      // fire()'s own dispatch-or-retain contract (2026-09-09 review completion
      // blocker, "scheduled firing does not dispatch-or-retain"): scheduledRun
      // is cleared only once applyCurrentStageAction reports it actually
      // dispatched real work.
      assert.equal(
        state.current().scheduledRun,
        undefined,
        "a successful end-to-end dispatch must consume the schedule, not restore it"
      );

      const busyOrSelfBlocked = surface.entries.some((entry) =>
        /busy|already in progress|already running|already held/i.test(entry.message)
      );
      assert.equal(
        busyOrSelfBlocked,
        false,
        "runPublishChecks must ADOPT the scheduler's own live admission via the forwarded handoff token, " +
          `not race a fresh genesis against it and refuse busy. Notifications: ${JSON.stringify(surface.entries)}`
      );

      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission held across the whole fire() -> applyCurrentStageAction -> runPublishChecks chain must be " +
          "fully released once everything settles"
      );
    } finally {
      commands.executeCommand = original;
      model.restore();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
      scheduler.dispose();
    }
  });
});
