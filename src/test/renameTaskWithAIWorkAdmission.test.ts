/**
 * Work-admission wiring for renameTaskWithAI (v1 fixes 2, Part 1a route audit
 * — this route dispatches a real provider round via `coordinator.executeAction`
 * (`requestAiNameV1`) but was found to have NO admission wiring at all, unlike
 * every other AI entry point. Mirrors generatePlanWithAIWorkAdmission.test.ts's
 * admission coverage: a durable admission marker already held for the task
 * must refuse this command with a busy diagnostic BEFORE the task is even
 * resolved, and admission acquired at command entry must be released in
 * `finally` even when the command exits early (here: the task cannot be
 * resolved at all).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { renameTaskWithAI } from "../commands/renameTask";
import { TaskInventory } from "../state/taskInventory";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { acquireWorkAdmissionV1, hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-rename-task-admission-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  // The shared early-admission helper (`looksLikeTaskFolderPathV1`) requires
  // a `task.md` to exist before it will even attempt admission — a bare
  // directory silently short-circuits the early-acquisition path (returns
  // `undefined` rather than a refusal), letting execution fall through to
  // task resolution instead of the busy check this test exercises.
  fs.writeFileSync(path.join(dir, "task.md"), "# Test task\n");
  return dir;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const dummyInventory = {
  getTaskById: () => undefined,
  getTaskByPath: () => undefined,
  getVisibleTaskForSuppressedId: () => undefined,
  getVisibleTaskForSuppressedPath: () => undefined,
  getTasks: () => [],
  refresh: () => Promise.resolve(undefined),
} as unknown as TaskInventory;

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(REAL_ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

void describe("renameTaskWithAI work admission (v1 fixes 2, Part 1a route audit)", () => {
  void it("refuses with the busy diagnostic, naming the other owner, when durable admission is already held for the task — before task resolution", async () => {
    const taskFolderPath = makeTaskFolder("admission-busy");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    try {
      // `dummyInventory` resolves nothing — if renameTaskWithAI reached task
      // resolution before the admission check, this would refuse silently
      // (no notification at all, per `resolve()`'s "if (!task) return"),
      // which the single-warning assertion below distinguishes from the busy
      // diagnostic this test expects.
      await renameTaskWithAI(makeExtensionContext(), dummyInventory, { taskFolderPath });

      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(
        surface.entries[0]?.message ?? "",
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner, not a generic 'task is busy' message"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      deactivateNotificationRouter();
    }
  });

  void it("releases its own admission once the command finishes, even on the fast task-not-found exit path", async () => {
    const taskFolderPath = makeTaskFolder("admission-released-on-not-found");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    try {
      // No task-progress.json was written for this folder and the dummy
      // inventory resolves nothing, so `resolve()` returns undefined and the
      // command exits on its fast "no task found" path.
      await renameTaskWithAI(makeExtensionContext(), dummyInventory, { taskFolderPath });

      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after task resolution fails"
      );
    } finally {
      deactivateNotificationRouter();
    }
  });
});
