/**
 * bugs2 finding 8 (narrowed by the owner's 2026-10-25 decision): a message the
 * user types into a PAUSED task's stage chat resumes the task and is sent as
 * one action — no prerequisite card, no read-only branch, no intent guessing.
 * The chat then says what it did and names any other task the transition
 * paused; a blocked attempt keeps the message and reports the real blocker;
 * an automatic dispatch stays refused and logged only.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { chatWithStage, consumeSendAcceptedV1 } from "../commands/chatWithStage";
import {
  describeResumedSendAcknowledgementV1,
  describeRetainedPausedSendV1,
  getChatSendStateV1,
  reconcileChatSendStateV1,
  recordChatSendStateV1,
  resumePausedTaskForUserSendV1,
} from "../commands/pausedStageChatSendV1";
import { runWithAutomaticOriginV1 } from "../state/automationDispatchContextV1";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { fixtureOwnershipFor, readTaskProgressForTest } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";
import { writeChatHistory, type ChatMessage } from "../utils/chatHistoryStore";
import type { ChatViewProvider } from "../views/chatView";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-paused-chat-send-"));
after(() => {
  safeRemoveDir(REAL_ROOT);
});

const SEND_ID = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

void describe("resumePausedTaskForUserSendV1", () => {
  const makeDeps = (
    resumeOutcome: string,
    activeBefore: readonly string[],
    activeAfter: readonly string[],
    order: string[] = []
  ) => {
    let listCalls = 0;
    return {
      listOtherActiveTaskLabels: () => {
        listCalls += 1;
        order.push(`list${listCalls}`);
        return Promise.resolve(listCalls === 1 ? activeBefore : activeAfter);
      },
      releaseOwnAdmission: () => {
        order.push("releaseOwnAdmission");
        return Promise.resolve();
      },
      resume: () => {
        order.push("resume");
        return Promise.resolve({ outcome: resumeOutcome, release: () => Promise.resolve() });
      },
    };
  };

  void it("releases its own admission before the Resume takes it, and names the tasks the transition paused", async () => {
    const order: string[] = [];
    const result = await resumePausedTaskForUserSendV1(makeDeps("resumed", ["Other task", "Third"], ["Third"], order));
    assert.deepEqual(order, ["list1", "releaseOwnAdmission", "resume", "list2"]);
    assert.equal(result.kind, "resumed");
    if (result.kind === "resumed") {
      assert.deepEqual(result.pausedOthers, ["Other task"]);
      assert.equal(typeof result.release, "function");
    }
  });

  void it("reports no other task paused when none was active", async () => {
    const result = await resumePausedTaskForUserSendV1(makeDeps("resumed", [], []));
    assert.equal(result.kind, "resumed");
    if (result.kind === "resumed") {
      assert.deepEqual(result.pausedOthers, []);
    }
  });

  void it("blocks with the real reason for a busy, superseded or failed Resume — never as resumed", async () => {
    for (const [outcome, pattern] of [
      ["busy", /another operation holds this task/],
      ["superseded", /resumed by someone else/],
      ["failed", /could not be resumed/],
      ["notFound", /could not be found/],
    ] as const) {
      const result = await resumePausedTaskForUserSendV1(makeDeps(outcome, [], []));
      assert.equal(result.kind, "blocked", outcome);
      if (result.kind === "blocked") {
        assert.match(result.reason, pattern, outcome);
      }
    }
  });

  void it("blocks (rather than throws) when the Resume throws", async () => {
    const deps = {
      ...makeDeps("resumed", [], []),
      resume: () => Promise.reject(new Error("disk full")),
    };
    const result = await resumePausedTaskForUserSendV1(deps);
    assert.equal(result.kind, "blocked");
    if (result.kind === "blocked") {
      assert.match(result.reason, /disk full/);
    }
  });
});

void describe("paused-send wording", () => {
  void it("acknowledges the resumed task and names every other task paused as a result", () => {
    assert.equal(
      describeResumedSendAcknowledgementV1("\"Jester digest\"", []),
      "\"Jester digest\" was paused. I resumed it and sent your message."
    );
    const one = describeResumedSendAcknowledgementV1("\"Jester digest\"", ["\"bugs1\""]);
    assert.match(one, /resumed it and sent your message/);
    assert.match(one, /"bugs1" was active, so it was paused to make "Jester digest" the active task/);
    const two = describeResumedSendAcknowledgementV1("T", ["A", "B"]);
    assert.match(two, /A and B were active, so they were paused/);
  });

  void it("says a retained message was NOT sent, why, and offers nothing it did not do", () => {
    const text = describeRetainedPausedSendV1("\"Jester digest\"", "another operation holds this task right now");
    assert.match(text, /kept but NOT sent/);
    assert.match(text, /another operation holds this task right now/);
    assert.match(text, /Resume and send/);
    assert.doesNotMatch(text, /Answer without resuming/);
  });
});

// ---------------------------------------------------------------------------
// chatWithStage on a paused task
// ---------------------------------------------------------------------------

function writeProgress(folder: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
}

function pausedFixture(name: string, status: TaskProgress["status"]): { folder: string; progress: TaskProgress } {
  const folder = path.join(REAL_ROOT, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "task.md"), "# Task\n", "utf8");
  const progress: TaskProgress = {
    taskFolder: name,
    displayName: name,
    currentStage: "plan",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(folder),
    // A USER pause: no watchdog provenance in the reason.
    ...(status === "paused" ? { pausedReason: "Paused by the user." } : {}),
  };
  writeProgress(folder, progress);
  return { folder, progress };
}

function inventoryOver(tasks: ReadonlyArray<{ folder: string; progress: TaskProgress }>): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  let items = tasks.map((t) => ({
    canonicalId: t.folder,
    taskFolderPath: t.folder,
    folderName: path.basename(t.folder),
    sourceScopeKey: t.folder,
    progress: t.progress,
  }));
  inv.refresh = async (): Promise<void> => {
    items = await Promise.all(
      items.map(async (item) => {
        const fresh = await readTaskProgressForTest(vscode.Uri.file(item.taskFolderPath));
        return fresh ? { ...item, progress: fresh } : item;
      })
    );
  };
  inv.getTasks = (): typeof items => items;
  inv.getTaskById = (id: string): (typeof items)[number] | undefined => items.find((t) => t.canonicalId === id);
  inv.getTaskByPath = (p: string): (typeof items)[number] | undefined => items.find((t) => t.taskFolderPath === p);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function currentTaskStoreStub(): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => undefined;
  store.set = (): Promise<void> => Promise.resolve();
  store.clear = (): Promise<void> => Promise.resolve();
  return store;
}

interface AppendedV1 {
  readonly role: string;
  readonly text: string;
  readonly id?: string;
}

function recordingChatView(): { provider: ChatViewProvider; appended: AppendedV1[] } {
  const appended: AppendedV1[] = [];
  const provider = {
    transcript: (): Promise<ChatMessage[]> =>
      Promise.resolve(
        appended.map((entry) => ({ role: entry.role, text: entry.text, stage: "plan", at: "2026-01-01T00:00:00.000Z", ...(entry.id ? { id: entry.id } : {}) })) as ChatMessage[]
      ),
    append: (role: string, text: string, _stage: string, _identity?: unknown, _pending?: boolean, messageId?: string): Promise<void> => {
      appended.push({ role, text, ...(messageId ? { id: messageId } : {}) });
      return Promise.resolve();
    },
    open: (): Promise<void> => Promise.resolve(),
  } as unknown as ChatViewProvider;
  return { provider, appended };
}

class RecordingSurface {
  entries: { message: string; level: string }[] = [];
  addEntry(message: string, level: string): void {
    this.entries.push({ message, level });
  }
}

function extensionContext(): vscode.ExtensionContext {
  // AI consent already given at the current disclaimer version, so the send
  // reaches the paused-task branch instead of stopping at the consent modal.
  const backing = new Map<string, unknown>([
    [`aiHelper.consent.v${DISCLAIMER_VERSION}`, { acceptedAt: "2026-01-01T00:00:00.000Z", version: DISCLAIMER_VERSION }],
  ]);
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => (backing.has(key) ? (backing.get(key) as T) : defaultValue),
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) backing.delete(key);
      else backing.set(key, value);
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

function installFsAndWorkspace(): { restore: () => void } {
  const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origRead = fsTarget.readFile;
  fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const origFolders = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return {
    restore: (): void => {
      fsTarget.readFile = origRead;
      ws.workspaceFolders = origFolders;
    },
  };
}

void describe("chatWithStage on a paused task (bugs2 finding 8)", () => {
  void it("keeps the user's message, says it was NOT sent and why, and leaves the task paused when it cannot be resumed", async () => {
    const paused = pausedFixture("paused-no-store", "paused");
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([paused]),
        chat.provider,
        { taskFolderPath: paused.folder, stage: "plan", message: "why did this stop?", sendId: SEND_ID },
        undefined // no CurrentTaskStore: the Resume cannot run
      );
      assert.deepEqual(
        chat.appended.map((entry) => entry.role),
        ["user", "assistant"],
        "the message stays visible, followed by the explanation"
      );
      assert.equal(chat.appended[0]?.text, "why did this stop?");
      assert.equal(chat.appended[0]?.id, SEND_ID, "kept under its send id so a retry never writes it twice");
      assert.match(chat.appended[1]?.text ?? "", /kept but NOT sent/);
      assert.match(chat.appended[1]?.text ?? "", /current-task store is unavailable/);
      assert.doesNotMatch(chat.appended[1]?.text ?? "", /I resumed it and sent/);
      assert.equal(consumeSendAcceptedV1(paused.folder, "why did this stop?"), true, "a viewer is told the runner took it");
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(paused.folder)))?.status, "paused");
      assert.equal(hasLiveWorkAdmissionBestEffortV1(paused.folder), false);
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does not write a kept message a second time when the same send id comes back", async () => {
    const paused = pausedFixture("paused-retained-once", "paused");
    const backing = new Map<string, unknown>();
    const memento: vscode.Memento = {
      keys: (): readonly string[] => [...backing.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        backing.has(key) ? (backing.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
        return Promise.resolve();
      },
    };
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(REAL_ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await chatWithStage(
          extensionContext(),
          inventoryOver([paused]),
          chat.provider,
          { taskFolderPath: paused.folder, stage: "plan", message: "same message", sendId: SEND_ID },
          undefined
        );
      }
      assert.equal(chat.appended.filter((entry) => entry.role === "user").length, 1);
      const decisions = new WorkflowDecisionStoreV1(memento).listPending(paused.folder)
        .filter((decision) => decision.decisionKey === "chatActionOffer:chatWithStage");
      assert.equal(decisions.length, 1, "a repeated blocked send updates one persisted recovery decision");
      const decision = decisions[0]!;
      assert.match(decision.whatHappened, /kept but NOT sent/);
      assert.match(decision.whatHappened, /current-task store is unavailable/);
      assert.deepEqual(decision.options.map((option) => option.label), ["Resume and send", "Not now"]);
      assert.equal(
        decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined,
        "runAction"
      );
      assert.deepEqual(decision.options[0]!.effect, {
        kind: "command",
        command: "vs-code-ai-helper.chatWithStage",
        args: [{ canonicalId: paused.folder, taskFolderPath: paused.folder, stage: "plan", message: "same message", sendId: SEND_ID }],
      });
      assert.deepEqual(decision.options[1]!.effect, { kind: "doNothing" });
    } finally {
      env.restore();
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("resumes the paused task, pauses the other active task, and proceeds to send — no prerequisite card", async () => {
    const paused = pausedFixture("paused-target", "paused");
    const other = pausedFixture("active-other", "active");
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([paused, other]),
        chat.provider,
        { taskFolderPath: paused.folder, stage: "plan", message: "what is left?", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      const target = await readTaskProgressForTest(vscode.Uri.file(paused.folder));
      const others = await readTaskProgressForTest(vscode.Uri.file(other.folder));
      assert.equal(target?.status, "active", "the send resumed the task");
      assert.equal(others?.status, "paused", "the other active task was paused by the transition");
      assert.ok(
        !surface.entries.some((entry) => /Resume it before sending a message/.test(entry.message)),
        `no paused-task refusal: ${JSON.stringify(surface.entries)}`
      );
      // The send reached its own preconditions (this fixture configures no
      // model), proving it continued after the Resume instead of stopping.
      assert.ok(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)),
        `the send continued past the Resume: ${JSON.stringify(surface.entries)}`
      );
      assert.ok(
        !chat.appended.some((entry) => /I resumed it and sent your message/.test(entry.text)),
        "no 'sent' claim for a message that was not delivered"
      );
      assert.equal(hasLiveWorkAdmissionBestEffortV1(paused.folder), false, "the Resume's admission is released");
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("an automatic dispatch to a paused task is still refused and logged only", async () => {
    const paused = pausedFixture("paused-automatic", "paused");
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await runWithAutomaticOriginV1(() =>
        chatWithStage(
          extensionContext(),
          inventoryOver([paused]),
          chat.provider,
          { taskFolderPath: paused.folder, stage: "plan", message: "automatic", sendId: SEND_ID },
          currentTaskStoreStub()
        )
      );
      assert.deepEqual(chat.appended, [], "nothing is written to the chat");
      assert.equal(surface.entries.length, 0, "nothing is shown");
      assert.equal((await readTaskProgressForTest(vscode.Uri.file(paused.folder)))?.status, "paused");
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("records durable send state when retaining a blocked send", async () => {
    const paused = pausedFixture("retained-send-state", "paused");
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([paused]),
        chat.provider,
        { taskFolderPath: paused.folder, stage: "plan", message: "state check", sendId: SEND_ID },
        undefined
      );
      const state = await getChatSendStateV1(paused.folder, SEND_ID);
      assert.equal(state?.status, "retained");
      assert.equal(state?.sendId, SEND_ID);
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does not treat retained-send assistant notice as an answer when re-dispatching", async () => {
    const active = pausedFixture("retained-notice-not-answer", "active");
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    // Simulate that the send was retained earlier, adding user message and retained notice
    chat.appended.push(
      { role: "user", text: "retry me", id: SEND_ID },
      { role: "assistant", text: describeRetainedPausedSendV1("retained-notice-not-answer", "runner busy") }
    );
    await recordChatSendStateV1(active.folder, SEND_ID, "retained", { message: "retry me", stage: "plan" });
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "retry me", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      // The send was not treated as alreadyAnswered: it proceeded past the guard to pre-send checks
      assert.ok(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)) ||
          chat.appended.some((entry) => /no model is configured/.test(entry.text)),
        `the send continued past alreadyAnswered: ${JSON.stringify(surface.entries)} / ${JSON.stringify(chat.appended)}`
      );
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does not treat assistant 'Unable to respond' failure notice as already answered for sendId", async () => {
    const active = pausedFixture("failed-notice-not-answer", "active");
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    // Simulate that the send failed previously, appending an "Unable to respond" assistant message
    chat.appended.push(
      { role: "user", text: "retry me after failure", id: SEND_ID },
      { role: "assistant", text: "Unable to respond: timeout" }
    );
    await recordChatSendStateV1(active.folder, SEND_ID, "failed", { message: "retry me after failure", stage: "plan" });
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "retry me after failure", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      assert.ok(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)) ||
          chat.appended.some((entry) => /no model is configured/.test(entry.text)),
        `the failed send was retried rather than dropped as already answered: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("monotonicity: a completed send receipt cannot be overwritten with retained or failed", async () => {
    const fixture = pausedFixture("monotonic-receipt", "active");
    await recordChatSendStateV1(fixture.folder, SEND_ID, "completed", { message: "all done", stage: "plan" });
    const completedState = await getChatSendStateV1(fixture.folder, SEND_ID);
    assert.equal(completedState?.status, "completed");

    // Attempting to overwrite with retained
    await recordChatSendStateV1(fixture.folder, SEND_ID, "retained", { message: "re-retained", stage: "plan" });
    const afterRetained = await getChatSendStateV1(fixture.folder, SEND_ID);
    assert.equal(afterRetained?.status, "completed", "completed receipt must not be downgraded to retained");

    // Attempting to overwrite with failed
    await recordChatSendStateV1(fixture.folder, SEND_ID, "failed", { message: "failed", stage: "plan" });
    const afterFailed = await getChatSendStateV1(fixture.folder, SEND_ID);
    assert.equal(afterFailed?.status, "completed", "completed receipt must not be downgraded to failed");
  });

  void it("recovers prior execution when runner restarted at promotion before receipt write", async () => {
    const active = pausedFixture("restart-at-promotion", "active");
    const chatFilePath = path.join(active.folder, "chat-v1.json");
    // Simulate that promotion already wrote the assistant response with id: SEND_ID,
    // but the runner was interrupted before the receipt write, leaving send state retained or absent.
    fs.writeFileSync(
      chatFilePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          messages: [
            { role: "user", text: "my question", id: SEND_ID, stage: "plan" },
            { role: "assistant", text: "promoted assistant response", id: SEND_ID, stage: "plan" },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    await recordChatSendStateV1(active.folder, SEND_ID, "retained", { message: "my question", stage: "plan" });

    // reconcileChatSendStateV1 reconciles send state to completed
    const reconciled = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(reconciled.settled, true);
    assert.equal(reconciled.status, "completed");

    const stateAfter = await getChatSendStateV1(active.folder, SEND_ID);
    assert.equal(stateAfter?.status, "completed");
    assert.equal(stateAfter?.promotionSettled, true);

    // When chatWithStage is invoked with that sendId, it detects the reconciled completion and avoids re-dispatching
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "my question", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      // Since it recovered settlement, no model check warning/error was raised and no duplicate was appended
      assert.equal(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)),
        false,
        "recovered send must not re-dispatch to provider"
      );
      assert.equal(chat.appended.length, 0);
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("recovers promotion when runner restarted after task-file update and before transcript append", async () => {
    const active = pausedFixture("restart-between-file-update-and-append", "active");
    // The real retained transcript already has the user's message with this
    // identity. Recovery must select the assistant response by role.
    const transcriptEnv = installFsAndWorkspace();
    try {
      await writeChatHistory(active.folder, [
        { role: "user", text: "update plan", id: SEND_ID, stage: "plan", at: "2026-01-01T00:00:00.000Z" },
      ], active.folder);
    } finally {
      transcriptEnv.restore();
    }
    // Simulate that promotion applied effects and recorded effectsApplied + finalText,
    // but crashed before appendChatMessageV1 or receipt write.
    await recordChatSendStateV1(active.folder, SEND_ID, "promoting", {
      message: "update plan",
      stage: "plan",
      effectsApplied: true,
      finalText: "Plan has been updated successfully",
    });

    const reconciled = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(reconciled.settled, true);
    assert.equal(reconciled.status, "completed");

    const stateAfter = await getChatSendStateV1(active.folder, SEND_ID);
    assert.equal(stateAfter?.status, "completed");
    assert.equal(stateAfter?.promotionSettled, true);

    const chatFilePath = path.join(active.folder, "chat-v1.json");
    const raw = fs.readFileSync(chatFilePath, "utf8");
    const chatDoc = JSON.parse(raw) as { messages: Array<{ role: string; text: string; id?: string }> };
    const recoveredMessage = chatDoc.messages.find((m) => m.role === "assistant" && m.id === SEND_ID);
    assert.ok(recoveredMessage, "assistant response must be appended to chat-v1.json during recovery");
    assert.equal(recoveredMessage?.text, "Plan has been updated successfully");

    // Calling chatWithStage avoids duplicate execution
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "update plan", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      assert.equal(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)),
        false,
        "recovered send must not re-dispatch to provider"
      );
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("preserves applied promotion evidence when response append fails, then recovers without replay", async () => {
    const active = pausedFixture("append-failure-preserves-promotion", "active");
    // A directory at the transcript path makes append fail after the effects
    // checkpoint has been durably recorded.
    fs.mkdirSync(path.join(active.folder, "chat-v1.json"));
    await recordChatSendStateV1(active.folder, SEND_ID, "promoting", {
      message: "update plan",
      stage: "plan",
      effectsApplied: true,
      finalText: "The edit was applied",
      promotionEvidence: { source: "test" },
    });

    const failed = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(failed.settled, false);
    assert.equal(failed.status, "held");
    const heldState = await getChatSendStateV1(active.folder, SEND_ID);
    assert.equal(heldState?.effectsApplied, true);
    assert.equal(heldState?.finalText, "The edit was applied");
    assert.deepEqual(heldState?.promotionEvidence, { source: "test" });

    fs.rmdirSync(path.join(active.folder, "chat-v1.json"));
    const recovered = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(recovered.settled, true);
    assert.equal((await getChatSendStateV1(active.folder, SEND_ID))?.status, "completed");
    const transcript = JSON.parse(fs.readFileSync(path.join(active.folder, "chat-v1.json"), "utf8")) as {
      messages: Array<{ role: string; id?: string }>;
    };
    assert.equal(transcript.messages.filter((message) => message.role === "assistant" && message.id === SEND_ID).length, 1);
  });

  void it("keeps the in-memory post-effect checkpoint when its disk write fails before the failure handler runs", async () => {
    const active = pausedFixture("post-effect-checkpoint-write-failure", "active");
    const statePath = path.join(active.folder, "chat-send-state-v1.json");
    await recordChatSendStateV1(active.folder, SEND_ID, "promoting", {
      message: "update plan",
      stage: "plan",
      promotionEvidence: { contentText: "update applied", stage: "plan" },
    });
    const staleDiskState = fs.readFileSync(statePath, "utf8");

    // Promotion applied the task-file effects and updated the process cache,
    // but the corresponding disk write failed. Restore the last durable file
    // to model that exact window, then run chatWithStage's actual failed-state
    // transition, which must merge the newer cached checkpoint.
    await recordChatSendStateV1(active.folder, SEND_ID, "promoting", {
      effectsApplied: true,
      finalText: "The edit was applied",
    });
    fs.writeFileSync(statePath, staleDiskState, "utf8");
    await recordChatSendStateV1(active.folder, SEND_ID, "failed", {
      reason: "assistant response append failed",
    });

    const afterFailure = await getChatSendStateV1(active.folder, SEND_ID);
    assert.equal(afterFailure?.status, "failed");
    assert.equal(afterFailure?.effectsApplied, true);
    assert.equal(afterFailure?.finalText, "The edit was applied");
    assert.deepEqual(afterFailure?.promotionEvidence, { contentText: "update applied", stage: "plan" });

    const reconciled = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(reconciled.settled, true, "the applied effect is settled without provider replay");
    assert.equal((await getChatSendStateV1(active.folder, SEND_ID))?.status, "completed");
  });

  void it("holds indeterminate prior attempt when interrupted before promotion effects", async () => {
    const active = pausedFixture("restart-before-effects", "active");
    await recordChatSendStateV1(active.folder, SEND_ID, "promoting", {
      message: "unsettled message",
      stage: "plan",
    });

    const reconciled = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(reconciled.settled, false);
    assert.equal(reconciled.held, true);
    assert.equal(reconciled.status, "held");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "unsettled message", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      assert.equal(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)),
        false,
        "held indeterminate attempt must not re-dispatch to provider"
      );
      assert.ok(
        chat.appended.some((entry) => entry.role === "assistant" && /Unable to respond:.*interrupted/.test(entry.text)),
        "held indeterminate attempt must append explanation"
      );
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("cancellation notice in chat-v1.json does not falsely complete an undelivered send", async () => {
    const active = pausedFixture("cancelled-not-completed", "active");
    const chatFilePath = path.join(active.folder, "chat-v1.json");
    fs.writeFileSync(
      chatFilePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          messages: [
            { role: "user", text: "cancel me", id: SEND_ID, stage: "plan" },
            { role: "assistant", text: "Stage chat was cancelled.", stage: "plan" },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    await recordChatSendStateV1(active.folder, SEND_ID, "failed", {
      message: "cancel me",
      stage: "plan",
      reason: "cancelled",
    });

    const reconciled = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(reconciled.settled, false, "cancelled send must not be marked settled");
    assert.equal(reconciled.status, "failed");

    // Retrying should be allowed rather than suppressed
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "cancel me", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      assert.ok(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)) ||
          chat.appended.some((entry) => /no model is configured/.test(entry.text)),
        "cancelled send must be retried upon user request"
      );
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });

  void it("unrelated subsequent assistant message in chat-v1.json does not falsely complete an undelivered send", async () => {
    const active = pausedFixture("unrelated-assistant-not-completed", "active");
    const chatFilePath = path.join(active.folder, "chat-v1.json");
    fs.writeFileSync(
      chatFilePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          messages: [
            { role: "user", text: "pending question", id: SEND_ID, stage: "plan" },
            { role: "assistant", text: "Scheduled rerun due to quota reset", stage: "plan" },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    await recordChatSendStateV1(active.folder, SEND_ID, "retained", {
      message: "pending question",
      stage: "plan",
    });

    const reconciled = await reconcileChatSendStateV1(active.folder, SEND_ID, active.progress.taskFolder, "plan");
    assert.equal(reconciled.settled, false, "unrelated assistant message must not settle the send");
    assert.equal(reconciled.status, "retained");

    // Retrying should be allowed rather than suppressed
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const env = installFsAndWorkspace();
    const chat = recordingChatView();
    try {
      await chatWithStage(
        extensionContext(),
        inventoryOver([active]),
        chat.provider,
        { taskFolderPath: active.folder, stage: "plan", message: "pending question", sendId: SEND_ID },
        currentTaskStoreStub()
      );
      assert.ok(
        surface.entries.some((entry) => /No model is configured/.test(entry.message)) ||
          chat.appended.some((entry) => /no model is configured/.test(entry.text)),
        "retained send with unrelated subsequent assistant message must be retried upon user request"
      );
    } finally {
      env.restore();
      deactivateNotificationRouter();
    }
  });
});
