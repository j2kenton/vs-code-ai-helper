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
import { peekTaskFolderPathSynchronouslyV1 } from "../utils/resolveTaskContext";
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
