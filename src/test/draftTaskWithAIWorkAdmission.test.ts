/**
 * Work-admission wiring for draftTaskWithAI (v1 fixes 2, Part 1a route audit
 * — this route dispatches a real provider round via `coordinator.executeAction`
 * but was found to have NO admission wiring at all: neither an early nor a
 * late `acquireWorkAdmissionV1` call, unlike every other AI entry point
 * (runReviewWithAI, generatePlanWithAI, runLintingFixes, ...). Mirrors
 * generatePlanWithAIWorkAdmission.test.ts's admission coverage: a durable
 * admission marker already held for the task must refuse this command with a
 * busy diagnostic BEFORE the (unbounded) consent modal is ever shown, and
 * admission acquired at command entry must be released in `finally` even when
 * the command exits early.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { draftTaskWithAI } from "../commands/draftTaskWithAI";
import { TaskInventory } from "../state/taskInventory";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { acquireWorkAdmissionV1, hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import type { ChatViewProvider } from "../views/chatView";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-draft-task-admission-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const dummyInventory = {
  getTaskById: () => { throw new Error("unexpected inventory access before admission/consent settled"); },
  getTaskByPath: () => { throw new Error("unexpected inventory access before admission/consent settled"); },
  refresh: () => Promise.resolve(undefined),
} as unknown as TaskInventory;
const dummyChatViewProvider = {} as unknown as ChatViewProvider;

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

void describe("draftTaskWithAI work admission (v1 fixes 2, Part 1a route audit)", () => {
  void it("refuses with the busy diagnostic, naming the other owner, when durable admission is already held for the task — before the consent modal is ever shown", async () => {
    const taskFolderPath = makeTaskFolder("admission-busy");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    // vscode.window.showWarningMessage is left as the stub's `notImplemented`
    // (it throws if called) — if draftTaskWithAI reached the consent modal
    // before the admission check, this test would fail with that throw
    // instead of a clean busy refusal.
    try {
      const result = await draftTaskWithAI(
        dummyInventory,
        makeExtensionContext(),
        dummyChatViewProvider,
        { taskFolderPath }
      );

      assert.equal(result, undefined);
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

  void it("releases its own admission once the command finishes, even on the fast consent-declined exit path", async () => {
    const taskFolderPath = makeTaskFolder("admission-released-on-decline");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const win = vscode.window as unknown as Record<string, unknown>;
    const origShowWarningMessage = win.showWarningMessage;
    // Simulate the user declining the consent modal (no button chosen).
    win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);

    try {
      const result = await draftTaskWithAI(
        dummyInventory,
        makeExtensionContext(),
        dummyChatViewProvider,
        { taskFolderPath }
      );

      assert.equal(result, undefined);
      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after consent is declined"
      );
    } finally {
      win.showWarningMessage = origShowWarningMessage;
      deactivateNotificationRouter();
    }
  });
});
