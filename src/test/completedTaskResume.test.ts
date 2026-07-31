/**
 * Coverage for Slice 2 of the 2026-07-14_task_5 backlog: completed-task
 * resume/reopen UX.
 *
 * Covers:
 *   1. createReopenMutation — pure-function field invalidation/preservation
 *      rules, including the implReviewFiles stage boundary and stale detection.
 *   2. resumePausedTask on a completed task — picker-driven reopen, Publish
 *      preselection, cancellation as a no-op, and stale-picker rejection.
 *   3. setTaskStage/setStageAsCurrent on a completed task — routes through the
 *      reopen transition instead of advanceStage, for both picker-driven and
 *      explicit-stage invocations.
 *   4. Activation-coordinator fault injection at the target-write-pending
 *      interval — forward/back/ambiguous resolution, and startup recovery of
 *      an ambiguous checkpoint once the target becomes readable again.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { StaleReopenError } from "../utils/reopenTask";
import {
  activateTask,
  recoverActivationCheckpoint,
} from "../state/taskActivationCoordinator";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resumePausedTask } from "../commands/resumeTask";
import { setTaskStage } from "../commands/setTaskStage";
import {
  patchTaskProgress,
  readTaskProgress,
} from "../utils/taskProgressUtils";
import { TaskProgress } from "../types/taskProgress";
import { initNotificationRouter } from "../utils/notificationRouter";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";
import { runTrackedOperation } from "../utils/taskOperations";

// Route NotificationRouter to the vscode stub's window methods, mirroring
// commandArgNormalization.test.ts, so command-level assertions can inspect
// captured messages regardless of whether a command uses NotificationRouter
// or vscode.window directly.
initNotificationRouter({
  addEntry(message, level) {
    if (level === "warning") {
      void vscode.window.showWarningMessage(message);
    } else if (level === "error") {
      void vscode.window.showErrorMessage(message);
    } else {
      void vscode.window.showInformationMessage(message);
    }
  },
});

// completionLint.ts / writeAtomic.ts are required (not `import`ed) so their
// exported functions can be monkey-patched for a test's duration — see the
// equivalent comment in commitAndPushDuplicateGuard.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const writeAtomicModule = require("../state/writeAtomic") as {
  writeAtomic: (uri: vscode.Uri, content: string) => Promise<void>;
};

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reopen-test-"));

function baseProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task",
    currentStage: "publish",
    status: "completed",
    completedAt: "2026-01-01T00:00:00.000Z",
    completedStages: ["publish"],
    createdAt: "2025-12-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    // The strict reopen row (resumeTask.v1) validates the persisted binding
    // before mutating (plan §9.1) — every completed fixture must carry a
    // derivable ownership record or the reopen reports recoveryRequired.
    ownership: {
      metaRoot: path.join(REAL_ROOT, ".ensemble"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2025-12-01T00:00:00.000Z",
      state: "resolved",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared fixture helpers for command/coordinator integration tests
// ---------------------------------------------------------------------------

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, ".ensemble", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function writeProgress(folderPath: string, progress: TaskProgress): Promise<void> {
  await fs.promises.writeFile(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 },
  ];
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig; } };
}

/**
 * readTaskProgress (used by patchTaskProgress and every command under test)
 * reads via vscode.workspace.fs.readFile, which the test stub leaves
 * unimplemented. Bridge it straight to the real filesystem for the duration
 * of a test — every fixture in this file is a real on-disk task folder, so
 * no in-memory store is needed (contrast with commandArgNormalization.test.ts's
 * installMemStore, which also has to serve a fake seeded store).
 */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

/**
 * Minimal TaskInventory stub backed by real on-disk progress files.
 *
 * `refresh()` re-reads each item's progress straight from disk (exactly what
 * the real TaskInventory.refresh does for the fields these tests care about),
 * rather than being a no-op. The coordinator relies on a genuinely fresh
 * `refresh()` to detect writes made outside its own inventory snapshot (see
 * the "two windows" test below) — a no-op stub would silently defeat that and
 * let a staleness regression pass unnoticed.
 */
function makeInventory(tasks: Array<{ canonicalId: string; taskFolderPath: string; progress: TaskProgress }>): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  let items = tasks.map((t) => ({
    canonicalId: t.canonicalId,
    taskFolderPath: t.taskFolderPath,
    folderName: path.basename(t.taskFolderPath),
    sourceScopeKey: t.canonicalId,
    progress: t.progress,
  }));
  inv.refresh = async (): Promise<void> => {
    items = await Promise.all(items.map(async (item) => {
      const fresh = await readTaskProgress(vscode.Uri.file(item.taskFolderPath));
      return fresh ? { ...item, progress: fresh } : item;
    }));
  };
  inv.getTasks = (): typeof items => items;
  inv.getTaskById = (id: string): typeof items[number] | undefined => items.find((t) => t.canonicalId === id);
  inv.getTaskByPath = (p: string): typeof items[number] | undefined => items.find((t) => t.taskFolderPath === p);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function makeCurrentTaskStoreStub(persistedId?: string): { store: CurrentTaskStore; setCalls: string[] } {
  const setCalls: string[] = [];
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => persistedId;
  store.set = (id: string): Promise<void> => { setCalls.push(id); return Promise.resolve(); };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return { store, setCalls };
}

type CapturedMessage = { method: string; message: string };
function installMessageCapture(): { captured: CapturedMessage[]; restore: () => void } {
  const captured: CapturedMessage[] = [];
  const win = vscode.window as unknown as Record<string, unknown>;
  const origInfo = win.showInformationMessage;
  const origErr = win.showErrorMessage;
  const origWarn = win.showWarningMessage;
  const origQuickPick = win.showQuickPick;
  const origWithProgress = win.withProgress;

  win.showInformationMessage = (msg: string): Promise<undefined> => { captured.push({ method: "info", message: msg }); return Promise.resolve(undefined); };
  win.showErrorMessage = (msg: string): Promise<undefined> => { captured.push({ method: "error", message: msg }); return Promise.resolve(undefined); };
  win.showWarningMessage = (msg: string): Promise<undefined> => { captured.push({ method: "warning", message: msg }); return Promise.resolve(undefined); };
  win.showQuickPick = (): Promise<undefined> => Promise.resolve(undefined);
  win.withProgress = async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>): Promise<unknown> =>
    task({ report: (): void => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(): void {} }) });

  return {
    captured,
    restore: (): void => {
      win.showInformationMessage = origInfo;
      win.showErrorMessage = origErr;
      win.showWarningMessage = origWarn;
      win.showQuickPick = origQuickPick;
      win.withProgress = origWithProgress;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. resumePausedTask on a completed task
// ---------------------------------------------------------------------------

void describe("resumePausedTask on a completed task", () => {
  void it("shows the reopen picker with Publish listed first, and reopens the task on selection", async () => {
    const folderPath = makeTaskFolder("resume-completed-publish");
    const canonicalId = folderPath;
    const progress = baseProgress({ taskFolder: path.basename(folderPath) });
    await writeProgress(folderPath, progress);

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const { store } = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();
    const bridge = installOperationNotificationBridge();

    let pickedItems: Array<{ label: string; stage: string }> | undefined;
    (vscode.window as unknown as Record<string, unknown>).showQuickPick = (
      items: Array<{ label: string; stage: string }>
    ): Promise<{ label: string; stage: string } | undefined> => {
      pickedItems = items;
      return Promise.resolve(items[0]);
    };

    try {
      await resumePausedTask(inv, store, { canonicalId });

      assert.ok(pickedItems, "expected the reopen picker to be shown");
      assert.equal(pickedItems[0]!.stage, "publish", "Publish must be the first (preselected) item");

      const stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "active");
      assert.equal(stored?.completedAt, undefined);
      assert.equal(stored?.currentStage, "publish");
      assert.equal(
        msgs.captured.filter((m) => m.method === "info" && m.message.includes("Resume Task")).length,
        1,
        "the bridge produces exactly one terminal reopen notification"
      );
    } finally {
      bridge.dispose();
      msgs.restore();
      ws.restore();
      rf.restore();
    }
  });

  void it("cancelling the picker leaves the task fully completed and changes nothing", async () => {
    const folderPath = makeTaskFolder("resume-completed-cancel");
    const canonicalId = folderPath;
    const progress = baseProgress({ taskFolder: path.basename(folderPath) });
    await writeProgress(folderPath, progress);

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const { store, setCalls } = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();
    // installMessageCapture's default showQuickPick resolves undefined (cancel).

    try {
      await resumePausedTask(inv, store, { canonicalId });

      const stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "completed");
      assert.equal(stored?.completedAt, progress.completedAt);
      assert.deepEqual(setCalls, [], "cancelling must not persist a current-task change");
    } finally {
      msgs.restore();
      ws.restore();
      rf.restore();
    }
  });

  void it("a stale picker confirmation (task modified elsewhere) is rejected with a warning, and changes nothing", async () => {
    const folderPath = makeTaskFolder("resume-completed-stale");
    const canonicalId = folderPath;
    const progress = baseProgress({ taskFolder: path.basename(folderPath) });
    await writeProgress(folderPath, progress);

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const { store } = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();

    (vscode.window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<{ label: string; stage: string }>
    ): Promise<{ label: string; stage: string } | undefined> => {
      // Simulate another window re-completing the task while this picker was open.
      await patchTaskProgress(vscode.Uri.file(folderPath), (current) => ({
        ...current,
        completedAt: "2026-06-01T00:00:00.000Z",
      }));
      return items[0];
    };

    try {
      await resumePausedTask(inv, store, { canonicalId });

      const stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "completed", "the other window's completion must be left intact");
      assert.equal(stored?.completedAt, "2026-06-01T00:00:00.000Z");
      assert.ok(
        msgs.captured.some((m) => m.method === "warning" && m.message.includes("updated elsewhere")),
        "expected a stale-picker warning"
      );
    } finally {
      msgs.restore();
      ws.restore();
      rf.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. setTaskStage / setStageAsCurrent on a completed task
// ---------------------------------------------------------------------------

void describe("setTaskStage on a completed task", () => {
  void it("routes through the reopen transition when a specific stage is passed explicitly (setStageAsCurrent)", async () => {
    const folderPath = makeTaskFolder("set-stage-completed-explicit");
    const canonicalId = folderPath;
    const progress = baseProgress({ taskFolder: path.basename(folderPath), implReviewFiles: ["src/a.ts"] });
    await writeProgress(folderPath, progress);

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const { store } = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();
    let quickPickCalled = false;
    (vscode.window as unknown as Record<string, unknown>).showQuickPick = (): Promise<undefined> => {
      quickPickCalled = true;
      return Promise.resolve(undefined);
    };

    try {
      await setTaskStage(inv, store, { canonicalId, stage: "impl-high-review" }, "jump");

      assert.equal(quickPickCalled, false, "an explicit stage must skip the picker entirely");
      const stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "active");
      assert.equal(stored?.currentStage, "impl-high-review");
      assert.equal(stored?.completedAt, undefined);
      // impl-high-review consumes implReviewFiles as its review scope.
      assert.deepEqual(stored?.implReviewFiles, ["src/a.ts"]);
    } finally {
      msgs.restore();
      ws.restore();
      rf.restore();
    }
  });

  void it("picker-driven invocation lists Publish (not filtered out) and preselects it", async () => {
    const folderPath = makeTaskFolder("set-stage-completed-picker");
    const canonicalId = folderPath;
    const progress = baseProgress({ taskFolder: path.basename(folderPath) });
    await writeProgress(folderPath, progress);

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const { store } = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();
    let pickedItems: Array<{ label: string; stage: string }> | undefined;
    (vscode.window as unknown as Record<string, unknown>).showQuickPick = (
      items: Array<{ label: string; stage: string }>
    ): Promise<{ label: string; stage: string } | undefined> => {
      pickedItems = items;
      return Promise.resolve(items[0]);
    };

    try {
      await setTaskStage(inv, store, { canonicalId }, "jump");

      assert.ok(pickedItems?.some((i) => i.stage === "publish"), "Publish must be selectable for a completed task's reopen picker");
      assert.equal(pickedItems![0]!.stage, "publish", "Publish must be preselected");
      const stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "active");
      assert.equal(stored?.currentStage, "publish");
    } finally {
      msgs.restore();
      ws.restore();
      rf.restore();
    }
  });

  void it("regression: cancels a stray tracked operation for the task before reopening it", async () => {
    // A completed task should have nothing running against it, but a race
    // (e.g. an operation still finishing when the task got marked complete)
    // could leave one live in the registry. setTaskStageOnCompletedTask must
    // cancel it BEFORE calling reopenCompletedTask, not after — otherwise the
    // stray process keeps running underneath the newly-reopened stage. This
    // is observed two ways: the operation's cancellation token actually
    // fires, and it fires strictly before reopenCompletedTask is invoked.
    const folderPath = makeTaskFolder("set-stage-completed-stray-op");
    const canonicalId = folderPath;
    const progress = baseProgress({ taskFolder: path.basename(folderPath) });
    await writeProgress(folderPath, progress);

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const { store } = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();

    const order: string[] = [];
    let cancelled = false;
    const stillRunning = runTrackedOperation(
      folderPath,
      { label: "Stub Stray Operation", stage: "publish", kind: "review", cancellable: true },
      (handle) =>
        new Promise<void>((resolve) => {
          const token = handle.token;
          if (!token || token.isCancellationRequested) {
            cancelled = !!token?.isCancellationRequested;
            order.push("cancel-observed");
            resolve();
            return;
          }
          token.onCancellationRequested(() => {
            cancelled = true;
            order.push("cancel-observed");
            resolve();
          });
        })
    );

    // reopenTaskModule.reopenCompletedTask is patched (not stubbed away) so
    // the real reopen still happens — only the call order relative to
    // cancellation is observed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reopenTaskModule = require("../utils/reopenTask") as {
      reopenCompletedTask: typeof import("../utils/reopenTask").reopenCompletedTask;
    };
    const originalReopen = reopenTaskModule.reopenCompletedTask;
    reopenTaskModule.reopenCompletedTask = (...args): ReturnType<typeof originalReopen> => {
      order.push("reopen-called");
      return originalReopen(...args);
    };

    try {
      await setTaskStage(inv, store, { canonicalId, stage: "impl-high-review" }, "jump");
      await stillRunning;

      assert.equal(cancelled, true, "the stray operation must have been cancelled");
      assert.deepEqual(
        order,
        ["cancel-observed", "reopen-called"],
        "cancellation must complete before reopenCompletedTask is called"
      );
      const stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "active", "the reopen itself must still have succeeded");
      assert.equal(stored?.currentStage, "impl-high-review");
    } finally {
      reopenTaskModule.reopenCompletedTask = originalReopen;
      msgs.restore();
      ws.restore();
      rf.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Activation-coordinator fault injection at target-write-pending
// ---------------------------------------------------------------------------

/**
 * Local stand-in for the retired createReopenMutation: production reopen now
 * flows through the resumeTask.v1 registry row (utils/reopenTask.ts routes it
 * as activateTask's writeTarget), but these fault-injection tests exercise
 * the activation coordinator's target-write machinery directly via the
 * mutateTarget seam, which needs a reopen-shaped mutation with the same
 * pre-persistence staleness contract.
 */
function reopenMutationForTest(
  chosenStage: TaskProgress["currentStage"],
  capturedCompletedAt: string | undefined
): (current: TaskProgress) => TaskProgress {
  return (current: TaskProgress): TaskProgress => {
    if (current.status !== "completed" || current.completedAt !== capturedCompletedAt) {
      throw new StaleReopenError(
        `Task "${current.taskFolder}" was updated elsewhere before the reopen could be applied.`
      );
    }
    return {
      ...current,
      completedAt: undefined,
      currentStage: chosenStage,
      completedStages: (current.completedStages ?? []).filter((s) => s !== chosenStage),
      updatedAt: new Date().toISOString(),
    };
  };
}

void describe("activateTask target-write-pending fault injection", () => {
  function patchWriteAtomicForTarget(
    targetProgressPath: string,
    behavior: (uri: vscode.Uri, content: string, original: typeof writeAtomicModule.writeAtomic) => Promise<void>
  ): () => void {
    const original = writeAtomicModule.writeAtomic;
    writeAtomicModule.writeAtomic = (uri: vscode.Uri, content: string): Promise<void> => {
      if (path.normalize(uri.fsPath) === path.normalize(targetProgressPath)) {
        return behavior(uri, content, original);
      }
      return original(uri, content);
    };
    return (): void => { writeAtomicModule.writeAtomic = original; };
  }

  void it("write fails before landing on disk (durableTargetUnchanged-style failure): rolls back, target stays completed", async () => {
    const targetPath = makeTaskFolder("fault-unchanged-target");
    const otherPath = makeTaskFolder("fault-unchanged-other");
    const targetCanonicalId = targetPath;
    const targetProgress = baseProgress({ taskFolder: path.basename(targetPath) });
    const otherProgress: TaskProgress = {
      taskFolder: path.basename(otherPath), currentStage: "impl", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeProgress(targetPath, targetProgress);
    await writeProgress(otherPath, otherProgress);

    const inv = makeInventory([
      { canonicalId: targetCanonicalId, taskFolderPath: targetPath, progress: targetProgress },
      { canonicalId: otherPath, taskFolderPath: otherPath, progress: otherProgress },
    ]);
    const { store } = makeCurrentTaskStoreStub();
    const rf = installReadFileBridge();

    const targetProgressFile = path.join(targetPath, "task-progress.json");
    const restore = patchWriteAtomicForTarget(targetProgressFile, () => {
      throw Object.assign(new Error("simulated temp-write failure"), { durableTargetUnchanged: true });
    });

    try {
      const result = await activateTask(inv, store, targetPath, targetCanonicalId, {
        mutateTarget: reopenMutationForTest("publish", targetProgress.completedAt),
      });
      assert.equal(result, false);

      const targetStored = await readTaskProgress(vscode.Uri.file(targetPath));
      assert.equal(targetStored?.status, "completed", "target must remain completed — the write never landed");

      const otherStored = await readTaskProgress(vscode.Uri.file(otherPath));
      assert.equal(otherStored?.status, "active", "the other task must be rolled back to active");
    } finally {
      restore();
      rf.restore();
    }
  });

  void it("write throws after actually landing on disk: resolves forward, sets focus, target ends up active", async () => {
    const targetPath = makeTaskFolder("fault-landed-target");
    const otherPath = makeTaskFolder("fault-landed-other");
    const targetCanonicalId = targetPath;
    const targetProgress = baseProgress({ taskFolder: path.basename(targetPath) });
    const otherProgress: TaskProgress = {
      taskFolder: path.basename(otherPath), currentStage: "impl", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeProgress(targetPath, targetProgress);
    await writeProgress(otherPath, otherProgress);

    const inv = makeInventory([
      { canonicalId: targetCanonicalId, taskFolderPath: targetPath, progress: targetProgress },
      { canonicalId: otherPath, taskFolderPath: otherPath, progress: otherProgress },
    ]);
    const { store, setCalls } = makeCurrentTaskStoreStub();
    const rf = installReadFileBridge();

    const targetProgressFile = path.join(targetPath, "task-progress.json");
    const restore = patchWriteAtomicForTarget(targetProgressFile, async (uri, content, original) => {
      // The write actually lands (as a real post-rename read-back failure
      // would have already done) before the simulated failure is thrown.
      await original(uri, content);
      throw Object.assign(new Error("simulated read-back validation failure"), { durableTargetUnchanged: false });
    });

    try {
      const result = await activateTask(inv, store, targetPath, targetCanonicalId, {
        mutateTarget: reopenMutationForTest("publish", targetProgress.completedAt),
      });
      assert.equal(result, true, "must resolve forward since the write actually landed");
      assert.deepEqual(setCalls, [targetCanonicalId], "focus must be set to the reopened target");

      const targetStored = await readTaskProgress(vscode.Uri.file(targetPath));
      assert.equal(targetStored?.status, "active");
      assert.equal(targetStored?.completedAt, undefined);

      const otherStored = await readTaskProgress(vscode.Uri.file(otherPath));
      assert.equal(otherStored?.status, "paused", "the other task legitimately stays paused — the target really is active");
    } finally {
      restore();
      rf.restore();
    }
  });

  void it("target becomes unreadable after the failed write: checkpoint is retained, paused tasks are NOT restored, and startup recovery resolves it once readable again", async () => {
    const targetPath = makeTaskFolder("fault-ambiguous-target");
    const otherPath = makeTaskFolder("fault-ambiguous-other");
    const targetCanonicalId = targetPath;
    const targetProgress = baseProgress({ taskFolder: path.basename(targetPath) });
    const otherProgress: TaskProgress = {
      taskFolder: path.basename(otherPath), currentStage: "impl", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeProgress(targetPath, targetProgress);
    await writeProgress(otherPath, otherProgress);

    const inv = makeInventory([
      { canonicalId: targetCanonicalId, taskFolderPath: targetPath, progress: targetProgress },
      { canonicalId: otherPath, taskFolderPath: otherPath, progress: otherProgress },
    ]);
    const { store } = makeCurrentTaskStoreStub();
    const rf = installReadFileBridge();

    const targetProgressFile = path.join(targetPath, "task-progress.json");
    const restore = patchWriteAtomicForTarget(targetProgressFile, async () => {
      // Corrupt the target's progress file so it reads back as unparseable —
      // simulating a state where the write's outcome cannot be determined.
      await fs.promises.writeFile(targetProgressFile, "{not valid json", "utf8");
      throw Object.assign(new Error("simulated unknown failure"), {});
    });

    try {
      const result = await activateTask(inv, store, targetPath, targetCanonicalId, {
        mutateTarget: reopenMutationForTest("publish", targetProgress.completedAt),
      });
      assert.equal(result, false, "ambiguous resolution must not report success");

      const otherStored = await readTaskProgress(vscode.Uri.file(otherPath));
      assert.equal(otherStored?.status, "paused", "must NOT restore paused tasks while the target's true state is unknown");

      const checkpointPath = path.join(REAL_ROOT, ".ensemble", ".ensemble-activation-checkpoint.json");
      assert.ok(fs.existsSync(checkpointPath), "the checkpoint must be retained, not cleared, while ambiguous");
    } finally {
      restore();
      // Repair the target file so startup recovery below can resolve it.
      await fs.promises.writeFile(targetProgressFile, JSON.stringify({ ...targetProgress, status: "active", completedAt: undefined }, null, 2), "utf8");
      const summary = await recoverActivationCheckpoint(path.join(REAL_ROOT, ".ensemble"), store);
      assert.ok(summary?.includes("active task"), `expected forward recovery once readable; got: ${summary}`);
      const otherAfterRecovery = await readTaskProgress(vscode.Uri.file(otherPath));
      assert.equal(otherAfterRecovery?.status, "paused", "recovery resolving forward must not touch the other task's paused state");
      rf.restore();
    }
  });

  void it("a fresh activation attempt is refused, and does not overwrite the checkpoint, while an earlier ambiguous checkpoint is unresolved", async () => {
    const targetPath = makeTaskFolder("fault-ambiguous-blocks-target");
    const otherPath = makeTaskFolder("fault-ambiguous-blocks-other");
    const targetCanonicalId = targetPath;
    const targetProgress = baseProgress({ taskFolder: path.basename(targetPath) });
    const otherProgress: TaskProgress = {
      taskFolder: path.basename(otherPath), currentStage: "impl", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeProgress(targetPath, targetProgress);
    await writeProgress(otherPath, otherProgress);

    const inv = makeInventory([
      { canonicalId: targetCanonicalId, taskFolderPath: targetPath, progress: targetProgress },
      { canonicalId: otherPath, taskFolderPath: otherPath, progress: otherProgress },
    ]);
    const { store } = makeCurrentTaskStoreStub();
    const rf = installReadFileBridge();

    const targetProgressFile = path.join(targetPath, "task-progress.json");
    const restore = patchWriteAtomicForTarget(targetProgressFile, async () => {
      await fs.promises.writeFile(targetProgressFile, "{not valid json", "utf8");
      throw Object.assign(new Error("simulated unknown failure"), {});
    });
    const checkpointPath = path.join(REAL_ROOT, ".ensemble", ".ensemble-activation-checkpoint.json");

    try {
      const firstResult = await activateTask(inv, store, targetPath, targetCanonicalId, {
        mutateTarget: reopenMutationForTest("publish", targetProgress.completedAt),
      });
      assert.equal(firstResult, false, "first attempt resolves ambiguous");
      assert.ok(fs.existsSync(checkpointPath));
      const checkpointBefore = fs.readFileSync(checkpointPath, "utf8");

      restore(); // normal writeAtomic resumes; targetPath's progress file is left corrupt

      // A second activation attempt must be refused rather than silently
      // proceed by writing a new "intent-recorded" checkpoint over the
      // still-unresolved one left by the first attempt — that would discard
      // the record that the first attempt's outcome is unconfirmed and could
      // reopen the two-active-tasks exposure the checkpoint exists to
      // prevent (see ensureNoPendingActivation).
      const secondResult = await activateTask(inv, store, otherPath, otherPath);
      assert.equal(secondResult, false, "must refuse a new activation while an earlier ambiguous checkpoint is unresolved");

      const otherStoredAfterRefusal = await readTaskProgress(vscode.Uri.file(otherPath));
      assert.equal(otherStoredAfterRefusal?.status, "paused", "the refused attempt's own target must be untouched");

      const checkpointAfterRefusal = fs.readFileSync(checkpointPath, "utf8");
      assert.equal(checkpointAfterRefusal, checkpointBefore, "the earlier checkpoint must survive the refused attempt byte-for-byte");
    } finally {
      // Repair the target and resolve the checkpoint so it doesn't leak into
      // later tests sharing this same root.
      await fs.promises.writeFile(targetProgressFile, JSON.stringify({ ...targetProgress, status: "active", completedAt: undefined }, null, 2), "utf8");
      await recoverActivationCheckpoint(path.join(REAL_ROOT, ".ensemble"), store);
      rf.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-window stale-inventory rollback
// ---------------------------------------------------------------------------

void describe("activateTask cross-window stale-inventory rollback", () => {
  void it("a stale window's rejected reopen must not resurrect a task another window already correctly paused", async () => {
    const activePath = makeTaskFolder("cross-window-active");
    const completedPath = makeTaskFolder("cross-window-completed");
    const activeCanonicalId = activePath;
    const completedCanonicalId = completedPath;

    const activeProgress: TaskProgress = {
      taskFolder: path.basename(activePath), currentStage: "impl", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const completedProgress = baseProgress({ taskFolder: path.basename(completedPath) });
    await writeProgress(activePath, activeProgress);
    await writeProgress(completedPath, completedProgress);

    // Window 1's inventory snapshot, captured before window 2 does anything —
    // it still believes the active task is active and the completed task is
    // completed. This is what a reopen picker in window 1 would have been
    // built against, and it is never refreshed until window 1's own
    // activateTask call runs.
    const staleInv = makeInventory([
      { canonicalId: activeCanonicalId, taskFolderPath: activePath, progress: activeProgress },
      { canonicalId: completedCanonicalId, taskFolderPath: completedPath, progress: completedProgress },
    ]);
    const { store: staleStore } = makeCurrentTaskStoreStub();
    const rf = installReadFileBridge();

    try {
      // Window 2 — its own, independent inventory/store, as a second window
      // would have — resumes the completed task first: pausing the active
      // task and activating the completed one for real, entirely unrelated
      // to window 1's stale snapshot above.
      const freshInv = makeInventory([
        { canonicalId: activeCanonicalId, taskFolderPath: activePath, progress: activeProgress },
        { canonicalId: completedCanonicalId, taskFolderPath: completedPath, progress: completedProgress },
      ]);
      const { store: freshStore } = makeCurrentTaskStoreStub();
      const windowTwoResult = await activateTask(freshInv, freshStore, completedPath, completedCanonicalId, {
        mutateTarget: reopenMutationForTest("publish", completedProgress.completedAt),
      });
      assert.equal(windowTwoResult, true, "window 2's own reopen must succeed");

      const activeAfterWindowTwo = await readTaskProgress(vscode.Uri.file(activePath));
      assert.equal(activeAfterWindowTwo?.status, "paused", "window 2 must have paused the active task");
      const completedAfterWindowTwo = await readTaskProgress(vscode.Uri.file(completedPath));
      assert.equal(completedAfterWindowTwo?.status, "active", "window 2 must have activated the reopened task");

      // Window 1's picker now resolves, using its stale inventory snapshot
      // and the completedAt marker it captured before window 2 acted. The
      // target write must be rejected as stale (mutateTarget re-reads fresh
      // state under the lock), and the failure path must roll back using
      // fresh pre-transition state — not window 1's stale belief that the
      // active task was still "active" — or this reopens the two-active-
      // tasks exposure the checkpoint/rollback machinery exists to prevent.
      await assert.rejects(
        activateTask(staleInv, staleStore, completedPath, completedCanonicalId, {
          mutateTarget: reopenMutationForTest("publish", completedProgress.completedAt),
        }),
        StaleReopenError
      );

      const activeAfterWindowOne = await readTaskProgress(vscode.Uri.file(activePath));
      assert.equal(
        activeAfterWindowOne?.status,
        "paused",
        "window 1's stale rollback must not resurrect the task window 2 already correctly paused"
      );
      const completedAfterWindowOne = await readTaskProgress(vscode.Uri.file(completedPath));
      assert.equal(completedAfterWindowOne?.status, "active", "window 2's successful reopen must remain untouched");
    } finally {
      rf.restore();
    }
  });
});
