/**
 * Work-admission wiring for chatWithStage (v1 fixes 2, Part 1a route audit —
 * this route dispatches a real provider round via
 * `admitAndContinueWithMalformedResultRetryV1`/`coordinator` but was found to
 * have NO admission wiring at all. This route matters more than most: it is
 * the one stage-action button left reachable on a PAUSED task (every other
 * dispatch button is gated `!(viewItem =~ /-paused/)`), so it must not itself
 * be vulnerable to the setup-phase watchdog race v1 fixes item 1 closes.
 *
 * Mirrors generatePlanWithAIWorkAdmission.test.ts's admission coverage: a
 * durable admission marker already held for the task must refuse this
 * command with a busy diagnostic BEFORE task resolution, and admission
 * acquired at command entry must be released in `finally` even when the
 * command exits early. An empty message (open-only, no send) must NOT
 * acquire admission at all — there is no provider dispatch to protect.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { chatWithStage } from "../commands/chatWithStage";
import { TaskInventory } from "../state/taskInventory";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { acquireWorkAdmissionV1, hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import type { ChatViewProvider } from "../views/chatView";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-with-stage-admission-"));

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
  getTaskById: () => undefined,
  getTaskByPath: () => undefined,
  getVisibleTaskForSuppressedId: () => undefined,
  getVisibleTaskForSuppressedPath: () => undefined,
  getTasks: () => [],
  refresh: () => Promise.resolve(undefined),
} as unknown as TaskInventory;

const dummyChatViewProvider = {
  open: (): Promise<void> => {
    throw new Error("unexpected chatViewProvider.open call before admission/resolution settled");
  },
} as unknown as ChatViewProvider;

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

void describe("chatWithStage work admission (v1 fixes 2, Part 1a route audit)", () => {
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
      await chatWithStage(makeExtensionContext(), dummyInventory, dummyChatViewProvider, {
        taskFolderPath,
        stage: "desc",
        message: "hello",
      });

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
      await chatWithStage(makeExtensionContext(), dummyInventory, dummyChatViewProvider, {
        taskFolderPath,
        stage: "desc",
        message: "hello",
      });

      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after task resolution fails"
      );
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("acquires no admission at all for an empty message (open-only, no provider dispatch)", async () => {
    const taskFolderPath = makeTaskFolder("no-admission-for-open-only");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    try {
      // `dummyInventory` resolves nothing, so this reaches the ordinary
      // "no task found" refusal regardless of message content — the point
      // under test is narrower: `earlyFolderPath` is computed from
      // `wantsSend` BEFORE task resolution even runs, so an empty/absent
      // message must never acquire admission no matter how resolution ends.
      await chatWithStage(makeExtensionContext(), dummyInventory, dummyChatViewProvider, {
        taskFolderPath,
        stage: "desc",
      });

      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "an empty/absent message must never acquire admission — there is no provider dispatch to protect"
      );
    } finally {
      deactivateNotificationRouter();
    }
  });
});
