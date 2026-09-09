/**
 * Coverage for the structured-question Answer/Resume/Cancel controls in
 * Chat With AI (plan §6.1's universal question flow, Chat UI side):
 *
 *  - askInteraction posts an unresolved interaction into the task-local Chat
 *    document, visible through the webview's posted "state" message.
 *  - The webview's submitInteractionAnswers/cancelInteraction/resumeInteraction
 *    messages route through ChatViewProvider to both the durable transaction
 *    store (via the injected ChatInteractionServicesV1) and the Chat
 *    document's own display mirror, in that order — a validation failure
 *    never reaches the transaction store, and answers are recorded before
 *    Resume is even attempted.
 *  - Resume is unavailable (a clear message, no throw) until interaction
 *    services declare a `resume` implementation — reflecting that nothing in
 *    production constructs the action coordinator yet.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  ChatInteractionRefV1,
  ChatInteractionServiceResultV1,
  ChatInteractionServicesV1,
  ChatViewProvider,
} from "../views/chatView";
import { readChatDocumentIdentityV1, readChatInteractions } from "../utils/chatHistoryStore";
import { StructuredAnswerV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";
import { bindingIdForOwnedFolder, makeOwnedTaskFolder } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";
import { ADMISSION_DIRNAME_V1, acquireWorkAdmissionV1 } from "../state/workAdmissionV1";

/** open() (invoked by askInteraction) raises an internal Notifications entry
 * and executes the webview-focus command — neither of which this test
 * process wires up, mirroring chatViewTaskSwitch.test.ts's harness. */
function installNotificationRouterStub(): { restore: () => void } {
  const stub: StatusSurface = { addEntry: (): void => undefined };
  initNotificationRouter(stub);
  return { restore: (): void => deactivateNotificationRouter() };
}

function installExecuteCommandCapture(): { restore: () => void } {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  return {
    restore: (): void => {
      commandsObj._executeCommandOverride = orig;
    },
  };
}

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

function makeFolder(): string {
  // Task conversations require the strict, ownership-backed task-folder
  // root contract (see workflowRuntimeServicesV1.ts); a coordinator-supplied
  // binding must equal the folder's ownership-derived binding, so tests
  // supply `bindingIdForOwnedFolder(folder)` as their binding.
  return makeOwnedTaskFolder("ensemble-chat-interaction-ui-").folder;
}

interface FakeWebviewView {
  readonly view: vscode.WebviewView;
  readonly posted: Array<Record<string, unknown>>;
  send(message: unknown): Promise<void>;
}

function makeFakeWebviewView(): FakeWebviewView {
  let handler: ((message: unknown) => unknown) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const webview = {
    options: {},
    html: "",
    postMessage: (msg: Record<string, unknown>): Promise<boolean> => {
      posted.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (cb: (message: unknown) => unknown): vscode.Disposable => {
      handler = cb;
      return { dispose: (): void => undefined };
    },
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: (): vscode.Disposable => ({ dispose: (): void => undefined }),
  } as unknown as vscode.WebviewView;
  return {
    view,
    posted,
    send: async (message: unknown): Promise<void> => {
      await handler?.(message);
    },
  };
}

const QUESTIONS: readonly StructuredQuestionV1[] = [
  {
    questionId: "scope",
    kind: "singleChoice",
    prompt: "Which artifact?",
    required: true,
    options: [
      { optionId: "plan", label: "plan.md" },
      { optionId: "task", label: "task.md" },
    ],
  },
];

const VALID_ANSWERS: readonly StructuredAnswerV1[] = [
  { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" },
];

/** The bare client-supplied selector a webview interaction message carries. */
type ClientRef = { operationId: string; interactionId: string };

/**
 * The FULL ref chatView.ts derives server-side and passes to interaction
 * services: the client selector plus the CURRENT task-local Chat document's
 * own authoritative binding, plus the mirrored interaction's own recorded
 * `sourceAttemptId` (never client-supplied — see chatView.ts's
 * `resolveInteractionRef`).
 */
async function expectedFullRef(folder: string, client: ClientRef): Promise<ChatInteractionRefV1> {
  const identity = await readChatDocumentIdentityV1(folder, folder);
  assert.ok(identity, "expected a chat document to exist for this task");
  const interactions = await readChatInteractions(folder, folder);
  const interaction = interactions.find((i) => i.interactionId === client.interactionId);
  assert.ok(interaction?.sourceAttemptId, "expected the mirrored interaction to carry its sourceAttemptId");
  return {
    ...client,
    taskBindingId: identity.taskBindingId,
    chatDocumentId: identity.documentId,
    sourceAttemptId: interaction.sourceAttemptId,
  };
}

void describe("Chat With AI — structured Answer/Resume/Cancel controls", () => {
  void it("askInteraction posts an unresolved interaction visible in the webview's rendered state", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: "1".repeat(32),
          operationId: "2".repeat(32),
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      const lastState = fake.posted.filter((m) => m.type === "state").pop();
      assert.ok(lastState, "expected a posted state message");
      const interactions = lastState.interactions as ReadonlyArray<{ interactionId: string; state: string }> | undefined;
      const interaction = interactions?.find((i) => i.interactionId === "1".repeat(32));
      assert.ok(interaction, "expected the interaction to be included in the posted state");
      assert.equal(interaction.interactionId, "1".repeat(32));
      assert.equal(interaction.state, "unresolved");

      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.state, "unresolved");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("askInteraction threads a supplied binding through to the document as its authoritative binding", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    // The supplied binding must equal the folder's ownership-derived binding
    // (the strict task-folder contract fails closed on any mismatch) — the
    // threaded-through identity this test proves is the chatDocumentId.
    const binding = { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "b".repeat(32) };
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: "1".repeat(32),
          operationId: "2".repeat(32),
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding,
        },
        true,
        false
      );

      const raw = JSON.parse(fs.readFileSync(path.join(folder, "chat-v1.json"), "utf8")) as {
        documentId: string;
        taskBindingId: string;
        taskBindingSource: string;
      };
      assert.equal(raw.documentId, binding.chatDocumentId);
      assert.equal(raw.taskBindingId, binding.taskBindingId);
      assert.equal(raw.taskBindingSource, "coordinatorSupplied");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("submitInteractionAnswers submits through interaction services before recording answers in the mirror", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "2".repeat(32), interactionId: "1".repeat(32) };
    const calls: string[] = [];
    let submittedAnswers: unknown;
    let mirrorAnswersAtSubmitTime: unknown;
    provider.setInteractionServices({
      submitAnswers: async (r, answers): Promise<ChatInteractionServiceResultV1> => {
        calls.push("submitAnswers");
        submittedAnswers = answers;
        assert.deepEqual(r, await expectedFullRef(folder, ref));
        // Prove the durable-store write happens before the display mirror
        // is touched (plan §5.5): the mirror must still show no answers.
        const beforeMirror = await readChatInteractions(folder, folder, "impl");
        mirrorAnswersAtSubmitTime = beforeMirror[0]?.answers;
        return { ok: true };
      },
      cancel: (): Promise<ChatInteractionServiceResultV1> => {
        calls.push("cancel");
        return Promise.resolve({ ok: true });
      },
    });
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({
        type: "submitInteractionAnswers",
        operationId: ref.operationId,
        interactionId: ref.interactionId,
        answers: VALID_ANSWERS,
      });

      assert.deepEqual(calls, ["submitAnswers"]);
      assert.deepEqual(submittedAnswers, VALID_ANSWERS);
      assert.equal(mirrorAnswersAtSubmitTime, undefined, "the mirror must not carry answers yet while submitAnswers runs");

      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.state, "unresolved", "answering does not settle the interaction");
      assert.deepEqual(stored[0]!.answers, VALID_ANSWERS, "the mirror is updated once submission succeeds");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("submitInteractionAnswers does not update the mirror when interaction services reject the submission", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "2".repeat(32), interactionId: "1".repeat(32) };
    provider.setInteractionServices({
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> =>
        Promise.resolve({ ok: false, reason: "stale question digest" }),
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
    });
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({
        type: "submitInteractionAnswers",
        operationId: ref.operationId,
        interactionId: ref.interactionId,
        answers: VALID_ANSWERS,
      });

      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.answers, undefined, "a rejected submission must never reach the mirror");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("rejects an invalid answer submission before it ever reaches interaction services", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "4".repeat(32), interactionId: "3".repeat(32) };
    let submitCalled = false;
    provider.setInteractionServices({
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => {
        submitCalled = true;
        return Promise.resolve({ ok: true });
      },
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
    });
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      // Missing the required answer entirely — decodeStructuredAnswersArrayV1 rejects.
      await fake.send({
        type: "submitInteractionAnswers",
        operationId: ref.operationId,
        interactionId: ref.interactionId,
        answers: [],
      });

      assert.equal(submitCalled, false, "an invalid submission must never reach interaction services");
      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.answers, undefined, "an invalid submission must not be recorded either");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("cancelInteraction settles the interaction through both interaction services and the display mirror", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "6".repeat(32), interactionId: "5".repeat(32) };
    let cancelCalled = false;
    provider.setInteractionServices({
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: async (r): Promise<ChatInteractionServiceResultV1> => {
        cancelCalled = true;
        assert.deepEqual(r, await expectedFullRef(folder, ref));
        return { ok: true };
      },
    });
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({ type: "cancelInteraction", operationId: ref.operationId, interactionId: ref.interactionId });

      assert.equal(cancelCalled, true);
      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.state, "cancelled");

      const lastState = fake.posted.filter((m) => m.type === "state").pop();
      const interactions = lastState!.interactions as ReadonlyArray<{ interactionId: string }> | undefined;
      assert.ok(
        !interactions?.some((i) => i.interactionId === ref.interactionId),
        "a settled interaction no longer renders as pending"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resumeInteraction reports 'not available yet' instead of throwing when no resume executor is wired", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "8".repeat(32), interactionId: "7".repeat(32) };
    provider.setInteractionServices({
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      // No `resume` — matches production today (no coordinator constructed yet).
    });
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({ type: "resumeInteraction", operationId: ref.operationId, interactionId: ref.interactionId });

      // Still unresolved — resume was never attempted.
      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.state, "unresolved");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resumeInteraction settles the interaction according to the resolution the resume executor reports", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "0".repeat(32), interactionId: "9".repeat(32) };
    let resumeCalled = false;
    const services: ChatInteractionServicesV1 = {
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      resume: async (r) => {
        resumeCalled = true;
        assert.deepEqual(r, await expectedFullRef(folder, ref));
        return { ok: true, settlement: "resumed" };
      },
    };
    provider.setInteractionServices(services);
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({ type: "resumeInteraction", operationId: ref.operationId, interactionId: ref.interactionId });

      assert.equal(resumeCalled, true);
      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.state, "resumed");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /**
   * 2026-09-09 review completion blocker, narrowed re-review: chatView.ts's
   * early work-admission acquisition used to be entirely best-effort — a
   * real `writeFailed` filesystem error (not just `busy`) left setup
   * (readChatInteractions/resolveInteractionRef here, and extension.ts's
   * `loadInteraction`) completely unadmitted, the exact setup-phase
   * watchdog-pause race this whole mechanism exists to close. Forcing a
   * genuine writeFailed (a plain file sitting where the admission directory
   * needs to be, the same technique workAdmissionV1.test.ts uses) must now
   * fail the Resume dispatch closed BEFORE any of that setup runs, rather
   * than falling through to it.
   */
  void it("resumeInteraction fails closed, before any setup read, when its own early admission write fails", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "3".repeat(32), interactionId: "4".repeat(32) };
    let resumeCalled = false;
    const services: ChatInteractionServicesV1 = {
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      resume: () => {
        resumeCalled = true;
        return Promise.resolve({ ok: true, settlement: "resumed" });
      },
    };
    provider.setInteractionServices(services);
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      // Force a genuine writeFailed: `fs.promises.mkdir(dir, { recursive:
      // true })` fails with a real filesystem error when a plain file
      // already occupies the admission directory's path.
      fs.writeFileSync(path.join(folder, ADMISSION_DIRNAME_V1), "not a directory");

      await fake.send({ type: "resumeInteraction", operationId: ref.operationId, interactionId: ref.interactionId });

      assert.equal(resumeCalled, false, "the Resume service must never be reached when admission write-fails");
      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.state, "unresolved", "the interaction must remain unresolved — no setup read ran");

      const lastState = fake.posted.filter((m) => m.type === "state").pop();
      const entries = (lastState?.entries as ReadonlyArray<{ role: string; text: string }> | undefined) ?? [];
      const decline = entries.find((e) => e.role === "assistant" && /Could not resume/.test(e.text));
      assert.ok(decline, "expected a declined-in-chat message naming the write failure");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /**
   * 2026-09-09 review completion blocker: a `busy` admission result used to
   * be treated as safe to proceed through, on the theory that every
   * downstream Chat-Resume handler enforces its own admission check against
   * the same owner. That is true for `resumeEditPreflightInteractionV1`, but
   * `resumeGeneratePlanInteractionV1` (the handler under test's `resume`
   * stand-in mirrors this) calls straight into real provider work with no
   * admission check of its own — so a pre-existing local admission holder let
   * Resume dispatch uncoordinated work under an unrelated owner's marker,
   * violating the single-owner invariant. This must now refuse BEFORE
   * `readChatInteractions`/`resolveInteractionRef`/the resume service are
   * ever reached, exactly like the `writeFailed` case above.
   */
  void it("resumeInteraction refuses busy, before any setup read, when durable admission is already held by another owner", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const ref: ClientRef = { operationId: "5".repeat(32), interactionId: "6".repeat(32) };
    let resumeCalled = false;
    const services: ChatInteractionServicesV1 = {
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      resume: () => {
        resumeCalled = true;
        return Promise.resolve({ ok: true, settlement: "resumed" });
      },
    };
    provider.setInteractionServices(services);

    const held = await acquireWorkAdmissionV1({
      taskFolderPath: folder,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: ref.interactionId,
          operationId: ref.operationId,
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({ type: "resumeInteraction", operationId: ref.operationId, interactionId: ref.interactionId });

      assert.equal(resumeCalled, false, "the Resume service must never be reached while another owner holds admission");
      const stored = await readChatInteractions(folder, folder, "impl");
      assert.equal(stored[0]!.state, "unresolved", "the interaction must remain unresolved — no setup read ran");

      const lastState = fake.posted.filter((m) => m.type === "state").pop();
      const entries = (lastState?.entries as ReadonlyArray<{ role: string; text: string }> | undefined) ?? [];
      const decline = entries.find((e) => e.role === "assistant" && /Could not resume/.test(e.text));
      assert.ok(decline, "expected a declined-in-chat message naming the other owner");
      assert.match(
        decline.text,
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner, not a generic refusal"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
