/**
 * Work-admission wiring for runPublishChecks (v1 fixes item 1, Part 1a,
 * "publish/complete actions" route) against the EXACT dispatch shape
 * `applyCurrentStageAction` sends — { canonicalId, taskFolderPath,
 * task: { progress }, admissionHandoffTokenV1? } — and, through it, the
 * shape `scheduleTaskResume.ts`'s `fire()` forwards for a scheduled Publish
 * stage action.
 *
 * 2026-09-09 review completion blocker: `extractSynchronousPublishChecksFolderPathV1`
 * used to read `node.task.folderUri.fsPath` unconditionally, before checking
 * the explicit `taskFolderPath`/`canonicalId` fields — `applyCurrentStageAction`'s
 * `task` is a PARTIAL object carrying only `progress`, with no `folderUri`,
 * so every Publish dispatch through that router (including scheduled firing)
 * threw before admission or any check ever ran. It also never accepted or
 * adopted `admissionHandoffTokenV1`, so a scheduled dispatch that already
 * held live admission for the task (scheduleTaskResume.ts's `fire()`) always
 * raced a fresh genesis against its own marker and observed `busy`.
 *
 * Mirrors `generatePlanWithAIWorkAdmission.test.ts`'s coverage shape.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runPublishChecks } from "../commands/runPublishChecks";
import { completeCommitAndPushTask } from "../commands/commitAndPushTask";
import { peekTaskFolderPathSynchronouslyV1, resolveTaskContext } from "../utils/resolveTaskContext";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import {
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  hasLiveWorkAdmissionBestEffortV1,
} from "../state/workAdmissionV1";
import { STALLED_ACTIVE_TASK_PAUSE_REASON_V1 } from "../utils/taskWatchdogV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-checks-admission-"));

/**
 * Nested two levels inside `REAL_ROOT` (not directly under it): the session
 * lock `withTaskLock`/`reconcileWatchdogPauseAgainstAdmissionV1` acquire
 * lives TWO levels above the task folder (`taskStateStore.ts`'s
 * `metaLocksForTasksRoot`) — a folder placed only one level under `REAL_ROOT`
 * would put that lock at `REAL_ROOT`'s PARENT, i.e. the shared `os.tmpdir()`
 * every parallel test-file process contends over (see
 * `taskFolderFixture.ts`'s `makeOwnedTaskFolder` doc comment for the same
 * hazard). Nesting under `tasks/` keeps the lock inside this file's own
 * private mkdtemp root.
 */
function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function writeProgress(folderPath: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
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

function fixtureProgress(
  taskFolderPath: string,
  overrides: Partial<TaskProgress> = {}
): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "plan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
    ...overrides,
  };
}

/**
 * A fake inventory resolving exactly one task by canonical ID or path —
 * mirrors `resolveTaskContext`'s `lookupInInventory` needs, with the
 * suppression-alias lookups stubbed to `undefined` (never exercised here).
 */
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

/** The exact shape `applyCurrentStageAction`'s `execute()` dispatches: explicit
 * fields plus a PARTIAL `task` carrying only `progress` (no `folderUri`). */
function applyCurrentStageActionDispatchArg(
  taskFolderPath: string,
  progress: TaskProgress,
  admissionHandoffTokenV1?: string
): { canonicalId: string; taskFolderPath: string; task: { progress: TaskProgress }; admissionHandoffTokenV1?: string } {
  return {
    canonicalId: taskFolderPath,
    taskFolderPath,
    task: { progress },
    admissionHandoffTokenV1,
  };
}

void describe("runPublishChecks work admission against applyCurrentStageAction's dispatch shape (v1 fixes item 1, Part 1a)", () => {
  void it("does not crash on the partial-task dispatch shape, and refuses busy (naming the real owner) when durable admission is already held", async () => {
    const taskFolderPath = makeTaskFolder("acas-shape-busy");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    try {
      // Before the fix, `extractSynchronousPublishChecksFolderPathV1` threw a
      // TypeError reading `node.task.folderUri.fsPath` on this exact shape,
      // before ever reaching admission — this call must resolve, not reject.
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        applyCurrentStageActionDispatchArg(taskFolderPath, progress)
      );

      assert.equal(result, false, "must report it never dispatched real work");
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(
        surface.entries[0]?.message ?? "",
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner — proves the folder path was extracted correctly, not just that nothing threw"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("adopts a caller's already-live admission via the forwarded handoff token, instead of racing a fresh genesis and refusing busy", async () => {
    // Simulates scheduleTaskResume.ts's `fire()`: it holds live admission for
    // the whole dispatch and authorizes a single-use handoff token, then
    // applyCurrentStageAction forwards that token into this exact arg shape.
    const taskFolderPath = makeTaskFolder("acas-shape-handoff-adoption");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const outer = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "vs-code-ai-helper.scheduleTaskResume.fire",
    });
    assert.equal(outer.outcome, "acquired");
    const handoffToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);

    try {
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        applyCurrentStageActionDispatchArg(taskFolderPath, progress, handoffToken)
      );

      // The task's stage is "plan", not "publish", so this must reach and
      // hit the stage guard — proving admission was NOT refused busy —
      // rather than the busy diagnostic the previous test asserts on.
      assert.equal(result, false);
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(surface.entries[0]?.message ?? "", /Publish stage/);
      assert.doesNotMatch(surface.entries[0]?.message ?? "", /busy|already/i);
    } finally {
      await outer.handle.release();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("releases its own admission once the command finishes, even on the stage-guard early-exit path", async () => {
    const taskFolderPath = makeTaskFolder("acas-shape-release-on-stage-guard");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        applyCurrentStageActionDispatchArg(taskFolderPath, progress)
      );

      assert.equal(result, false);
      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after the stage guard refuses"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});

/** Stateful in-memory `vscode.Memento`, so `CurrentTaskStore.set`/`.get` round-trip within a test. */
function fakeStatefulMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, defaultValue?: unknown) => (values.has(key) ? values.get(key) : defaultValue),
    update: (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve(undefined);
    },
    keys: () => Array.from(values.keys()),
  } as unknown as vscode.Memento;
}

/**
 * A cold-cache-miss inventory: every lookup misses (simulating a task that
 * exists on disk but is not yet in the in-memory inventory cache), except
 * `refresh()`, which succeeds without repopulating anything — mirroring how
 * `resolveTaskContext`'s own one-shot refresh-and-retry can still miss right
 * after a task was created in another window.
 */
function makeColdCacheInventory(): TaskInventory {
  return {
    getTaskById: () => undefined,
    getTaskByPath: () => undefined,
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

void describe("runPublishChecks — true no-arg invocation with a CurrentTaskStore (2026-09-09 review completion blocker)", () => {
  void it("resolves the persisted current task instead of reporting 'No task found', once registerRunPublishChecksCommand threads a CurrentTaskStore through", async () => {
    // Regression coverage for the review's sharper finding: `runPublishChecks`
    // itself always accepted a `currentTaskStore` parameter, but
    // `registerRunPublishChecksCommand`'s registration never passed one in at
    // all — so a true no-argument invocation (the command-palette entry,
    // `arg` fully `undefined`) had no persisted current-task pointer
    // available to EITHER the early-admission peek or the authoritative
    // `resolveTaskContext` call, and always resolved as "no task found"
    // rather than acting on the current task.
    const taskFolderPath = makeTaskFolder("no-arg-current-task-store");
    const progress = fixtureProgress(taskFolderPath, { currentStage: "plan" });
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
    await currentTaskStore.set(taskFolderPath);

    try {
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        undefined,
        undefined,
        currentTaskStore
      );

      // Stage is "plan", not "publish" — reaching (and being refused by) the
      // stage guard proves the current task was actually resolved, rather
      // than the command bailing out early on "No task found."
      assert.equal(result, false);
      assert.equal(surface.entries.length, 1);
      assert.match(surface.entries[0]?.message ?? "", /Publish stage/);
      assert.doesNotMatch(surface.entries[0]?.message ?? "", /No task found/i);
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});

/**
 * A multi-task fake inventory, for exercising `peekTaskFolderPathSynchronouslyV1`'s
 * unique-active-task mirror of `resolveTaskContext`'s step 3 — an inventory
 * with more than one entry, distinguished by `progress.status`.
 */
function makeMultiTaskInventory(
  entries: { taskFolderPath: string; progress: TaskProgress }[]
): TaskInventory {
  const tasks = entries.map(({ taskFolderPath, progress }) => ({
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    sourceScopeKey: taskFolderPath,
    progress,
  }));
  return {
    getTaskById: (id: string) => tasks.find((t) => t.canonicalId === id),
    getTaskByPath: (p: string) => tasks.find((t) => t.taskFolderPath === p),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => tasks,
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

void describe("peekTaskFolderPathSynchronouslyV1 — unique-active-task fallback (2026-09-10 review completion blocker, narrowed)", () => {
  void it("falls back to the sole active task when there is no persisted current-task pointer at all", () => {
    const activeFolderPath = makeTaskFolder("peek-fallback-no-pointer-active");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => undefined } as unknown as CurrentTaskStore
    );

    assert.equal(result, activeFolderPath);
  });

  void it("redirects from a persisted pointer that resolves to a PAUSED task to the sole active task elsewhere in the inventory", () => {
    const pausedFolderPath = makeTaskFolder("peek-fallback-paused-pointer-redirect-paused");
    const activeFolderPath = makeTaskFolder("peek-fallback-paused-pointer-redirect-active");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: pausedFolderPath, progress: fixtureProgress(pausedFolderPath, { status: "paused" }) },
      { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => pausedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(result, activeFolderPath, "must mirror resolveTaskContext's redirect away from a paused persisted task");
  });

  void it("falls back to the persisted PAUSED task itself when no unique active task exists to redirect to", () => {
    const pausedFolderPath = makeTaskFolder("peek-fallback-paused-pointer-no-redirect");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: pausedFolderPath, progress: fixtureProgress(pausedFolderPath, { status: "paused" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => pausedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      pausedFolderPath,
      "must mirror `resolved` staying the paused task when resolveTaskContext finds no onlyActiveTask override (allowPaused:true callers, e.g. Publish checks, still need it)"
    );
  });

  void it("falls back to the sole active task when the persisted pointer is a cold-cache miss with no folder on disk", () => {
    const activeFolderPath = makeTaskFolder("peek-fallback-cache-miss-active");
    const deletedFolderPath = path.join(REAL_ROOT, "tasks", "peek-fallback-cache-miss-deleted-pointer");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => deletedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      activeFolderPath,
      "a genuinely-gone persisted pointer (not just an uncached one) must still redirect to an unambiguous active task, mirroring resolveTaskContext's clear()-then-fallback path"
    );
  });

  void it("returns undefined when more than one active task makes the fallback ambiguous", () => {
    const activeA = makeTaskFolder("peek-fallback-ambiguous-a");
    const activeB = makeTaskFolder("peek-fallback-ambiguous-b");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: activeA, progress: fixtureProgress(activeA, { status: "active" }) },
      { taskFolderPath: activeB, progress: fixtureProgress(activeB, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => undefined } as unknown as CurrentTaskStore
    );

    assert.equal(result, undefined, "must fail closed rather than guess between two active tasks, matching resolveTaskContext's own ambiguity rule");
  });
});

void describe("peekTaskFolderPathSynchronouslyV1 — refresh-repopulated persisted target beats a stale cached active task (2026-09-10 review completion blocker, second pass)", () => {
  void it("returns the cache-missed persisted task, not a different cached active task, when the persisted task exists on disk and is not paused", () => {
    // The exact scenario the review reproduced: `resolveTaskContext`'s step 2
    // awaits `inventory.refresh()` on this same cache miss and, once refresh
    // finds the persisted task non-paused, uses it DIRECTLY — its own step-3
    // active-task fallback (which would have picked `cachedActiveFolderPath`)
    // is never even reached. This peek must not admit the wrong task here.
    const persistedFolderPath = makeTaskFolder("peek-refresh-beats-stale-active-persisted");
    writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "active" }));
    const cachedActiveFolderPath = makeTaskFolder("peek-refresh-beats-stale-active-cached");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: cachedActiveFolderPath, progress: fixtureProgress(cachedActiveFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => persistedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      persistedFolderPath,
      "the on-disk, non-paused persisted task must win over a stale cached active task, mirroring what resolveTaskContext's refresh finds"
    );
  });

  void it("falls back to a different cached active task when the cache-missed persisted task exists on disk but is paused", () => {
    const persistedFolderPath = makeTaskFolder("peek-refresh-paused-persisted-redirects");
    writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "paused" }));
    const cachedActiveFolderPath = makeTaskFolder("peek-refresh-paused-persisted-redirects-active");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: cachedActiveFolderPath, progress: fixtureProgress(cachedActiveFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => persistedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      cachedActiveFolderPath,
      "a paused on-disk persisted task must still redirect to an unambiguous active task, same as the already-cached paused-pointer case"
    );
  });

  void it("falls back to the cache-missed persisted task itself when it exists on disk, is paused, and no active task exists to redirect to", () => {
    const persistedFolderPath = makeTaskFolder("peek-refresh-paused-persisted-no-redirect");
    writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "paused" }));
    const inventory = makeMultiTaskInventory([]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => persistedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      persistedFolderPath,
      "must mirror `resolved` staying the on-disk paused persisted task when resolveTaskContext finds no onlyActiveTask override"
    );
  });
});

void describe("peekTaskFolderPathSynchronouslyV1 — cold-cache-miss id-as-path fallback (2026-09-09 review completion blocker)", () => {
  void it("falls back to the canonicalId as the folder-path guess when it still exists on disk", () => {
    const taskFolderPath = makeTaskFolder("peek-cold-miss-existing-folder");

    const result = peekTaskFolderPathSynchronouslyV1(makeColdCacheInventory(), {
      canonicalId: taskFolderPath,
    });

    assert.equal(result, taskFolderPath);
  });

  void it("returns undefined for a stale canonicalId whose folder no longer exists, rather than resurrecting it via admission's mkdir", () => {
    const deletedFolderPath = path.join(REAL_ROOT, "tasks", "deleted-task-never-created");

    const result = peekTaskFolderPathSynchronouslyV1(makeColdCacheInventory(), {
      canonicalId: deletedFolderPath,
    });

    assert.equal(result, undefined);
  });

  void it("falls back to the persisted current-task id as the folder-path guess when it still exists on disk", () => {
    const taskFolderPath = makeTaskFolder("peek-cold-miss-current-task-store");

    const result = peekTaskFolderPathSynchronouslyV1(
      makeColdCacheInventory(),
      undefined,
      { get: () => taskFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(result, taskFolderPath);
  });
});

/**
 * A mutable multi-task inventory whose `refresh()` call transitions it from a
 * "pre-refresh" snapshot (mirroring the stale in-memory cache
 * `peekTaskFolderPathSynchronouslyV1` is limited to) to a "post-refresh"
 * snapshot that can contain tasks the pre-refresh snapshot never had —
 * mirroring `TaskInventory.refresh()`'s own real disk scan discovering a
 * task the in-memory cache did not yet know about.
 */
function makeRefreshDiscoversNewTaskInventory(
  before: { taskFolderPath: string; progress: TaskProgress }[],
  after: { taskFolderPath: string; progress: TaskProgress }[]
): TaskInventory {
  let refreshed = false;
  const snapshot = (): { taskFolderPath: string; progress: TaskProgress }[] => (refreshed ? after : before);
  const toTask = (e: { taskFolderPath: string; progress: TaskProgress }): {
    canonicalId: string;
    taskFolderPath: string;
    folderName: string;
    sourceScopeKey: string;
    progress: TaskProgress;
  } => ({
    canonicalId: e.taskFolderPath,
    taskFolderPath: e.taskFolderPath,
    folderName: path.basename(e.taskFolderPath),
    sourceScopeKey: e.taskFolderPath,
    progress: e.progress,
  });
  return {
    getTaskById: (id: string) => snapshot().map(toTask).find((t) => t.canonicalId === id),
    getTaskByPath: (p: string) => snapshot().map(toTask).find((t) => t.taskFolderPath === p),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => snapshot().map(toTask),
    refresh: () => {
      refreshed = true;
      return Promise.resolve(undefined);
    },
  } as unknown as TaskInventory;
}

void describe(
  "resolveTaskContext — onResolvedCandidate hook (2026-09-10 review completion blocker, narrowed further: admission for a refresh-discovered target)",
  () => {
    void it(
      "fires with the refresh-discovered ACTIVE task, never the stale-cache paused guess, when the persisted pointer is a cache-miss that resolves to paused",
      async () => {
        // The review's exact scenario: BEFORE refresh, the persisted pointer
        // is a cache miss and the stale cache has NO active task at all (so
        // a synchronous peek has nothing to fall back to but the paused
        // pointer itself); refresh() discovers both the persisted (paused)
        // task AND a different, unambiguous active task — exactly what
        // resolveTaskContext's own internal `inventory.refresh()` would
        // surface in production.
        const persistedFolderPath = makeTaskFolder("resolve-hook-paused-persisted");
        const activeFolderPath = makeTaskFolder("resolve-hook-active-discovered-by-refresh");
        const inventory = makeRefreshDiscoversNewTaskInventory(
          [],
          [
            { taskFolderPath: persistedFolderPath, progress: fixtureProgress(persistedFolderPath, { status: "paused" }) },
            { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
          ]
        );

        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();
        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(persistedFolderPath);

        const seen: string[] = [];
        try {
          const resolved = await resolveTaskContext(inventory, undefined, {
            allowPaused: true,
            onResolvedCandidate: (candidate) => {
              seen.push(candidate.taskFolderPath);
              return Promise.resolve();
            },
          }, currentTaskStore);

          assert.equal(resolved?.taskFolderPath, activeFolderPath, "resolveTaskContext itself must land on the refresh-discovered active task");
          assert.deepEqual(seen, [activeFolderPath], "the hook must fire exactly once, with the AUTHORITATIVE target — never the stale paused guess");
        } finally {
          rf.restore();
          ws.restore();
        }
      }
    );

    void it("never fires when nothing resolves", async () => {
      const inventory = makeColdCacheInventory();
      const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());

      let called = false;
      const resolved = await resolveTaskContext(inventory, undefined, {
        allowPaused: true,
        onResolvedCandidate: () => {
          called = true;
          return Promise.resolve();
        },
      }, currentTaskStore);

      assert.equal(resolved, undefined);
      assert.equal(called, false);
    });

    void it(
      "never fires for a candidate whose folder does not exist on disk (2026-09-10 review architectural blocker fix)",
      async () => {
        // Deliberately never created via `makeTaskFolder`/`fs.mkdirSync` — a
        // stale inventory entry for a folder that no longer exists. Before
        // the fix, the hook fired BEFORE this exact existence check, so a
        // caller's admission acquisition (`mkdir(dir, { recursive: true })`)
        // could resurrect a directory under a candidate resolveTaskContext
        // was about to reject.
        const missingFolderPath = path.join(REAL_ROOT, "tasks", "resolve-hook-never-created");
        const progress = fixtureProgress(missingFolderPath, { status: "active" });
        const inventory = makeInventory(missingFolderPath, progress);
        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        const ws = installWorkspaceFoldersStub();

        let called = false;
        try {
          const resolved = await resolveTaskContext(inventory, { canonicalId: missingFolderPath, taskFolderPath: missingFolderPath }, {
            allowPaused: true,
            onResolvedCandidate: () => {
              called = true;
              return Promise.resolve();
            },
          }, currentTaskStore);

          assert.equal(resolved, undefined, "a missing folder must still fail resolution");
          assert.equal(called, false, "the admission hook must never fire for a candidate that fails the existence check");
          assert.equal(fs.existsSync(missingFolderPath), false, "the hook must not have resurrected the folder via admission's mkdir");
        } finally {
          ws.restore();
        }
      }
    );

    void it(
      "never fires for a candidate outside every open workspace folder (2026-09-10 review architectural blocker fix)",
      async () => {
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-outside-workspace-"));
        const outsideFolderPath = path.join(outsideRoot, "some-task");
        fs.mkdirSync(outsideFolderPath, { recursive: true });
        const progress = fixtureProgress(outsideFolderPath, { status: "active" });
        const inventory = makeInventory(outsideFolderPath, progress);
        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        // REAL_ROOT is the only open workspace folder — `outsideFolderPath`
        // sits entirely outside it.
        const ws = installWorkspaceFoldersStub();

        let called = false;
        try {
          const resolved = await resolveTaskContext(inventory, { canonicalId: outsideFolderPath, taskFolderPath: outsideFolderPath }, {
            allowPaused: true,
            onResolvedCandidate: () => {
              called = true;
              return Promise.resolve();
            },
          }, currentTaskStore);

          assert.equal(resolved, undefined, "a task outside every open workspace folder must still fail resolution");
          assert.equal(called, false, "the admission hook must never fire for a candidate that fails workspace containment");
        } finally {
          ws.restore();
          fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
      }
    );
  }
);

void describe(
  "runPublishChecks — admits the refresh-discovered active task, not the stale-cache paused guess (2026-09-10 review completion blocker, narrowed further)",
  () => {
    void it(
      "attempts admission against the refresh-discovered ACTIVE task, reported busy by its real owner — proving the paused stale-cache guess was never the actual target",
      async () => {
        const persistedFolderPath = makeTaskFolder("rpc-hook-paused-persisted-busy");
        const activeFolderPath = makeTaskFolder("rpc-hook-active-discovered-by-refresh-busy");
        writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "paused" }));
        writeProgress(activeFolderPath, fixtureProgress(activeFolderPath, { status: "active" }));

        const inventory = makeRefreshDiscoversNewTaskInventory(
          [],
          [
            { taskFolderPath: persistedFolderPath, progress: fixtureProgress(persistedFolderPath, { status: "paused" }) },
            { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
          ]
        );

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(persistedFolderPath);

        // Held for the ACTIVE task specifically — never the paused one — so
        // a busy refusal naming this owner proves resolution/admission
        // targeted the correct (refresh-discovered) folder, not the
        // stale-cache guess (which has no competing holder here and would
        // have silently succeeded had it been used instead).
        const held = await acquireWorkAdmissionV1({
          taskFolderPath: activeFolderPath,
          purpose: "admission",
          commandId: "someOtherConcurrentCommand",
        });
        assert.equal(held.outcome, "acquired");

        try {
          const result = await runPublishChecks(inventory, undefined, undefined, currentTaskStore);

          assert.equal(result, false);
          assert.equal(surface.entries.length, 1);
          assert.equal(surface.entries[0]?.level, "warning");
          assert.match(
            surface.entries[0]?.message ?? "",
            /someOtherConcurrentCommand/,
            "must have attempted admission against the refresh-discovered ACTIVE task, not the stale-cache paused guess"
          );
        } finally {
          if (held.outcome === "acquired") {
            await held.handle.release();
          }
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );
  }
);

void describe(
  "completeCommitAndPushTask — a watchdog-provenance pause on the resolved target no longer fails resolution outright (2026-09-10 review completion blocker, narrowed further)",
  () => {
    void it(
      "reconciles a watchdog-provenance pause on the resolved task and proceeds (reaching the stage guard), instead of reporting 'No active task found'",
      async () => {
        const taskFolderPath = makeTaskFolder("ccpt-watchdog-pause-reconciled");
        const progress = fixtureProgress(taskFolderPath, {
          status: "paused",
          pausedReason: STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
          currentStage: "plan",
        });
        writeProgress(taskFolderPath, progress);

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(taskFolderPath);

        try {
          await completeCommitAndPushTask(makeInventory(taskFolderPath, progress), undefined, currentTaskStore);

          assert.equal(surface.entries.length, 1);
          assert.match(
            surface.entries[0]?.message ?? "",
            /Complete, Commit and Push.*final review stage/,
            "must reach the stage guard — proving the watchdog pause was reconciled rather than causing resolution to fail outright"
          );
          assert.doesNotMatch(surface.entries[0]?.message ?? "", /No active task found/i);
        } finally {
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );

    void it(
      "still reports 'No active task found' for a genuine (non-watchdog) pause — the fix narrows the failure, it does not remove it",
      async () => {
        const taskFolderPath = makeTaskFolder("ccpt-genuine-user-pause-still-blocks");
        const progress = fixtureProgress(taskFolderPath, {
          status: "paused",
          pausedReason: "Paused by the user",
          currentStage: "plan",
        });
        writeProgress(taskFolderPath, progress);

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(taskFolderPath);

        try {
          await completeCommitAndPushTask(makeInventory(taskFolderPath, progress), undefined, currentTaskStore);

          assert.equal(surface.entries.length, 1);
          assert.match(surface.entries[0]?.message ?? "", /No active task found to complete, commit, and push/);
        } finally {
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );

    void it(
      "still reports 'No active task found' when a genuine user pause lands on disk AFTER the resolved snapshot was read but BEFORE reconciliation observes it (2026-09-10 review completion blocker, new)",
      async () => {
        // The review's exact scenario: `resolveTaskContext`'s in-memory
        // resolution snapshot says "active" (the inventory's own copy,
        // captured before any pause landed), but the ON-DISK file — which is
        // what `reconcileWatchdogPauseAgainstAdmissionV1` freshly reads
        // inside the `onResolvedCandidate` hook — already carries a genuine,
        // non-watchdog pause by the time reconciliation runs. The stale
        // "active" snapshot must never override that fresh, authoritative
        // read.
        const taskFolderPath = makeTaskFolder("ccpt-user-pause-races-stale-active-snapshot");
        const activeSnapshot = fixtureProgress(taskFolderPath, {
          status: "active",
          currentStage: "plan",
        });
        // The in-memory inventory (what resolveTaskContext resolves against)
        // says active — but the disk file (what reconciliation reads) is
        // already genuinely paused by the user, simulating the race.
        writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, {
          status: "paused",
          pausedReason: "Paused by the user",
          currentStage: "plan",
        }));

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(taskFolderPath);

        try {
          await completeCommitAndPushTask(
            makeInventory(taskFolderPath, activeSnapshot),
            undefined,
            currentTaskStore
          );

          assert.equal(surface.entries.length, 1);
          assert.match(
            surface.entries[0]?.message ?? "",
            /No active task found to complete, commit, and push/,
            "a fresh userPaused reconciliation result must win over the stale 'active' snapshot, not be masked by it"
          );
        } finally {
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );
  }
);
