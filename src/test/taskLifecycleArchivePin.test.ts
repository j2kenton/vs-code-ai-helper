/**
 * Archived-status and pin lifecycle invariants:
 *  - "archived" is a first-class persisted status that round-trips through
 *    the status migration, while unknown values still normalize to active.
 *  - Archived is hidden by default (DEFAULT_HIDDEN_STATUSES) so it only
 *    appears via explicit filtering.
 *  - Context tokens expose archived/pinned states for menu `when` clauses,
 *    with the pinned marker as the final suffix.
 *  - Plan-item verification never converts an unverifiable or deferred item
 *    into a pass.
 *  - The full archive → resume → re-complete round trip through the real
 *    commands (archiveTask, resumeArchivedTask, markTaskDone) against real
 *    on-disk task state: a completed task can be archived, resumed back to
 *    active at Publish, and completed again with a fresh completedAt.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  DEFAULT_HIDDEN_STATUSES,
  MAX_PINNED_TASKS,
  migrateStatus,
  TASK_STATUSES,
  TaskProgress,
} from "../types/taskProgress";
import { buildTaskContextValue } from "../utils/contextTokens";
import {
  mergeAiPlanVerdicts,
  parseAiPlanVerdicts,
  verifyPlanItems,
} from "../utils/completionLint";
import { archiveTask, resumeArchivedTask } from "../commands/archiveTask";
import { isMarkTaskDoneEligible, markTaskDone, selectNextTask } from "../commands/markTaskDone";
import { readTaskProgressForTest as readTaskProgress, fixtureOwnershipFor } from "./taskFolderFixture";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { initNotificationRouter } from "../utils/notificationRouter";

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

void describe("archived task status", () => {
  void it("round-trips through the status migration", () => {
    assert.strictEqual(migrateStatus("archived"), "archived");
    assert.strictEqual(migrateStatus("bogus"), "active");
    assert.ok(TASK_STATUSES.includes("archived"));
  });

  void it("is hidden by default but reachable through the filter", () => {
    assert.deepStrictEqual([...DEFAULT_HIDDEN_STATUSES], ["archived"]);
  });

  void it("exposes an archived context token for menu when-clauses", () => {
    const value = buildTaskContextValue({ status: "archived", currentStage: "publish" });
    assert.match(value, /^task-archived/);
  });
});

void describe("pinned task context tokens", () => {
  void it("caps pins at ten", () => {
    assert.strictEqual(MAX_PINNED_TASKS, 10);
  });

  void it("renders the pinned marker as the final suffix", () => {
    const value = buildTaskContextValue({ status: "active", currentStage: "impl", isPinned: true });
    assert.match(value, /-pinned$/);
    const unpinned = buildTaskContextValue({ status: "active", currentStage: "impl" });
    assert.doesNotMatch(unpinned, /-pinned$/);
  });
});

void describe("selectNextTask", () => {
  function inventoryOf(
    entries: Array<{ id: string; stage?: TaskProgress["currentStage"]; status?: TaskProgress["status"] }>
  ): TaskInventory {
    const items = entries.map((entry) => ({
      canonicalId: entry.id,
      taskFolderPath: entry.id,
      folderName: entry.id,
      sourceScopeKey: entry.id,
      progress: {
        taskFolder: entry.id,
        currentStage: entry.stage ?? "impl",
        status: entry.status ?? "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as TaskProgress,
    }));
    return { getTasks: (): typeof items => items } as unknown as TaskInventory;
  }

  void it("never selects an archived task as the next active task", () => {
    const inventory = inventoryOf([
      { id: "done", stage: "publish", status: "active" },
      { id: "parked", status: "archived" },
      { id: "runner-up", status: "active" },
    ]);
    assert.strictEqual(selectNextTask(inventory, "done"), "runner-up");
  });

  void it("skips paused and completed tasks, returning undefined when nothing is active", () => {
    const inventory = inventoryOf([
      { id: "done", stage: "publish", status: "active" },
      { id: "napping", status: "paused" },
      { id: "shipped", status: "completed" },
      { id: "parked", status: "archived" },
    ]);
    assert.strictEqual(selectNextTask(inventory, "done"), undefined);
  });
});

void describe("renameTask.ts — no deterministic name-derivation fallback", () => {
  void it("never derives a name from the raw description text — Rename Task with AI must fail loudly instead of silently returning a leading-substring name", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "commands", "renameTask.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      source,
      /deriveNameFromDescription|clampNameAtWordBoundary/,
      "the deterministic derive/clamp fallbacks were removed on purpose: they were the regression that made Rename Task with AI silently return the description's opening words"
    );
  });
});

void describe("verifyPlanItems", () => {
  void it("never passes any item on its own — a checkbox is not evidence", () => {
    const items = verifyPlanItems(
      [
        "- [x] Implement the feature",
        "- [ ] Write the docs",
        "- [x] Add telemetry (deferred to a follow-up)",
      ].join("\n")
    );
    assert.strictEqual(items.length, 3);
    assert.strictEqual(
      items[0]?.status,
      "inconclusive",
      "a checked item awaits AI verification; it must not pass deterministically"
    );
    assert.match(items[0]?.note ?? "", /checkbox is not evidence/);
    assert.strictEqual(items[1]?.status, "inconclusive");
    assert.strictEqual(items[2]?.status, "failed");
  });

  void it("unescapes backslash-escaped quotes via the same shared helper normalizeChecklistItemTextV1 uses", () => {
    const items = verifyPlanItems('- [ ] Fix the \\"getStageStatus\\" comparison');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(
      items[0]?.text,
      'Fix the "getStageStatus" comparison',
      "a plan item corrupted with literal backslash-escaped quotes on disk must display clean, not show the escapes to the reviewer/AI verifier"
    );
  });
});

void describe("AI plan verification verdicts", () => {
  void it("parses a fenced json array of per-item verdicts", () => {
    const verdicts = parseAiPlanVerdicts(
      [
        "Here is my assessment:",
        "```json",
        '[{"item": 1, "status": "passed", "note": "implemented in src/x.ts"},',
        ' {"item": 2, "status": "failed"}]',
        "```",
      ].join("\n"),
      2
    );
    assert.strictEqual(verdicts.size, 2);
    assert.deepStrictEqual(verdicts.get(1), { status: "passed", note: "implemented in src/x.ts" });
    assert.deepStrictEqual(verdicts.get(2), { status: "failed", note: undefined });
  });

  void it("ignores out-of-range items, invalid statuses, and non-JSON noise", () => {
    const verdicts = parseAiPlanVerdicts(
      [
        '{"item": 0, "status": "passed"}',
        '{"item": 3, "status": "passed"}',
        '{"item": 1, "status": "maybe"}',
        '{"item": 2, "status": "inconclusive"}',
        "not json at all",
      ].join("\n"),
      2
    );
    assert.strictEqual(verdicts.size, 1);
    assert.strictEqual(verdicts.get(2)?.status, "inconclusive");
  });

  void it("merges AI evidence into the baseline without laundering deferrals", () => {
    const baseline = verifyPlanItems(
      [
        "- [x] Implement the feature",
        "- [x] Add telemetry (deferred to a follow-up)",
        "- [ ] Write the docs",
      ].join("\n")
    );
    const merged = mergeAiPlanVerdicts(
      baseline,
      new Map([
        [1, { status: "passed" as const, note: "found in src/x.ts" }],
        [2, { status: "passed" as const }],
      ])
    );
    assert.strictEqual(merged[0]?.status, "passed", "AI evidence upgrades a checked item");
    assert.match(merged[0]?.note ?? "", /^AI verification:/);
    assert.strictEqual(
      merged[1]?.status,
      "failed",
      "a deferred item stays failed even when the AI claims it passed"
    );
    assert.strictEqual(
      merged[2]?.status,
      "inconclusive",
      "an item without an AI verdict keeps its baseline status"
    );
    assert.match(merged[2]?.note ?? "", /no AI verdict/);
  });
});

// ---------------------------------------------------------------------------
// archive → resume → re-complete round trip (real commands, real disk state)
// ---------------------------------------------------------------------------

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-archive-roundtrip-"));
after(() => {
  fs.rmSync(REAL_ROOT, { recursive: true, force: true });
});

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, ".ensemble", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installMessageCapture(): { captured: string[]; restore: () => void } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const origInfo = win.showInformationMessage;
  const origErr = win.showErrorMessage;
  const origWarn = win.showWarningMessage;
  const captured: string[] = [];
  win.showInformationMessage = (msg: string): Promise<undefined> => { captured.push(msg); return Promise.resolve(undefined); };
  win.showErrorMessage = (msg: string): Promise<undefined> => { captured.push(msg); return Promise.resolve(undefined); };
  win.showWarningMessage = (msg: string): Promise<undefined> => { captured.push(msg); return Promise.resolve(undefined); };
  return {
    captured,
    restore: (): void => {
      win.showInformationMessage = origInfo;
      win.showErrorMessage = origErr;
      win.showWarningMessage = origWarn;
    },
  };
}

/** Minimal on-disk-backed TaskInventory stub — see completedTaskResume.test.ts. */
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

function makeCurrentTaskStoreStub(): CurrentTaskStore {
  let current: string | undefined;
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => current;
  store.set = (id: string): Promise<void> => { current = id; return Promise.resolve(); };
  store.clear = (): Promise<void> => { current = undefined; return Promise.resolve(); };
  return store;
}

void describe("archive → resume → re-complete round trip", () => {
  void it("a completed task can be archived, resumed to Publish, and completed again", async () => {
    const folderPath = makeTaskFolder("roundtrip");
    const canonicalId = folderPath;
    const originalCompletedAt = "2026-01-01T00:00:00.000Z";
    const progress: TaskProgress = {
      taskFolder: path.basename(folderPath),
      currentStage: "publish",
      status: "completed",
      completedAt: originalCompletedAt,
      completedStages: ["publish"],
      pinnedAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2025-12-01T00:00:00.000Z",
      updatedAt: originalCompletedAt,
      ownership: fixtureOwnershipFor(folderPath),
    };
    await fs.promises.writeFile(
      path.join(folderPath, "task-progress.json"),
      JSON.stringify(progress, null, 2),
      "utf8"
    );

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const store = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();

    try {
      // 1. Archive: preserves what it was archived from AND the pin —
      // progress data (pinnedAt included) survives archive/resume; archived
      // tasks are hidden, so the kept pin occupies no visible slot and is
      // excluded from the pin cap (see pinTask.ts; resumeArchivedTask
      // re-checks the cap on the way back).
      await archiveTask(inv, store, { canonicalId });
      let stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "archived");
      assert.equal(stored?.archivedFrom, "completed");
      assert.equal(
        stored?.pinnedAt,
        "2026-01-02T00:00:00.000Z",
        "pinnedAt is progress data and must survive archiving"
      );
      assert.equal(stored?.completedAt, originalCompletedAt, "completedAt survives as historical metadata");
      assert.equal(
        stored ? isMarkTaskDoneEligible(stored) : undefined,
        false,
        "an archived task must not be completable"
      );

      // 2. Resume from the archive: back to the active lifecycle at Publish —
      // completion is not re-inferred from the preserved completedAt.
      await inv.refresh();
      await resumeArchivedTask(inv, store, { canonicalId });
      stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "active", "resuming an archived task returns it to active");
      assert.equal(stored?.archivedFrom, undefined);
      assert.equal(stored?.currentStage, "publish", "the task resumes at the Publish stage it was at");
      assert.equal(
        stored ? isMarkTaskDoneEligible(stored) : undefined,
        true,
        "after resume the task must be completable again from Publish"
      );

      // 3. Re-complete through the real command.
      await inv.refresh();
      await markTaskDone(inv, store, { canonicalId });
      stored = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(stored?.status, "completed");
      assert.ok(stored?.completedAt, "re-completion must stamp completedAt");
      assert.notEqual(
        stored?.completedAt,
        originalCompletedAt,
        "re-completion must record a fresh completedAt, not resurrect the pre-archive one"
      );
      assert.ok(stored?.completedStages?.includes("publish"));
      assert.ok(
        msgs.captured.some((m) => m.includes("complete")),
        "the completion must be reported"
      );
    } finally {
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });
});

void describe("archive clears the persisted zero-change implementation-round counter (step 8)", () => {
  void it("archiving a task with a durable zeroChangeImplRounds streak clears it", async () => {
    const folderPath = makeTaskFolder("zero-change-archive");
    const canonicalId = folderPath;
    const progress: TaskProgress = {
      taskFolder: path.basename(folderPath),
      currentStage: "impl-high-review",
      status: "active",
      completedStages: ["desc", "plan", "impl"],
      zeroChangeImplRounds: 5,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      ownership: fixtureOwnershipFor(folderPath),
    };
    await fs.promises.writeFile(
      path.join(folderPath, "task-progress.json"),
      JSON.stringify(progress, null, 2),
      "utf8"
    );

    const inv = makeInventory([{ canonicalId, taskFolderPath: folderPath, progress }]);
    const store = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();

    try {
      const before = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(before?.zeroChangeImplRounds, 5, "fixture precondition");

      await archiveTask(inv, store, { canonicalId });

      const after = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(after?.status, "archived");
      assert.equal(
        after?.zeroChangeImplRounds,
        undefined,
        "archiving a task must drop its no-progress-breaker streak, since a parked task is no longer iterating"
      );
    } finally {
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });
});

void describe("pin cap across archive/resume", () => {
  void it("drops a preserved pin on resume when the visible pin cap is already full", async () => {
    // 10 visible pinned tasks (the cap) plus one archived task that kept its
    // pin: resuming the archived task must not yield an 11th pin.
    const seed = async (name: string, progress: TaskProgress): Promise<string> => {
      const folder = makeTaskFolder(name);
      await fs.promises.writeFile(
        path.join(folder, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      return folder;
    };

    const base: Omit<TaskProgress, "taskFolder"> = {
      currentStage: "impl",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Omit<TaskProgress, "taskFolder">;

    const tasks: Array<{ canonicalId: string; taskFolderPath: string; progress: TaskProgress }> = [];
    for (let i = 0; i < 10; i++) {
      const progress: TaskProgress = {
        ...base,
        taskFolder: `pin-cap-active-${i}`,
        pinnedAt: `2026-03-0${(i % 9) + 1}T0${i % 10}:00:00.000Z`,
      } as TaskProgress;
      const folder = await seed(`pin-cap-active-${i}`, progress);
      tasks.push({ canonicalId: folder, taskFolderPath: folder, progress });
    }
    const archivedProgress: TaskProgress = {
      ...base,
      taskFolder: "pin-cap-archived",
      status: "archived",
      archivedFrom: "active",
      pinnedAt: "2026-02-01T00:00:00.000Z",
    } as TaskProgress;
    const archivedFolder = await seed("pin-cap-archived", archivedProgress);
    tasks.push({ canonicalId: archivedFolder, taskFolderPath: archivedFolder, progress: archivedProgress });

    const inv = makeInventory(tasks);
    const store = makeCurrentTaskStoreStub();
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const msgs = installMessageCapture();

    try {
      await resumeArchivedTask(inv, store, { canonicalId: archivedFolder });

      const resumed = await readTaskProgress(vscode.Uri.file(archivedFolder));
      assert.equal(resumed?.status, "active", "the task must still resume");
      assert.equal(
        resumed?.pinnedAt,
        undefined,
        "resuming into a full pin list must drop the preserved pin, never exceed the cap"
      );

      await inv.refresh();
      const pinnedVisible = inv
        .getTasks()
        .filter((t) => t.progress.pinnedAt !== undefined && t.progress.status !== "archived");
      assert.ok(
        pinnedVisible.length <= MAX_PINNED_TASKS,
        `visible pinned count (${pinnedVisible.length}) must never exceed ${MAX_PINNED_TASKS}`
      );
    } finally {
      msgs.restore();
      rf.restore();
      ws.restore();
    }
  });
});
