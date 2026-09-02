/**
 * Coverage for PART 2 of "Replace hidden notification decision buttons with
 * explained, selectable decisions" — Chat With AI rendering and dispatch of
 * `WorkflowDecisionV1` records:
 *
 *  - render() surfaces a task/stage's pending decisions in the posted "state"
 *    message, scoped to the exact task + stage (a decision for a different
 *    task, a different stage of the same task, or posted while the global
 *    assistant is open must never appear).
 *  - The webview's single `resolveWorkflowDecision` message resolves the
 *    record in the store FIRST, then dispatches the chosen option's command
 *    effect exactly once; a `doNothing` option resolves without dispatching
 *    anything.
 *  - A second resolve of an already-settled decision is reported as
 *    informational ("already submitted"), never as a warning/error, and does
 *    not dispatch the command a second time (task: "an already-answered
 *    decision is not an error").
 *  - `notifyPendingWorkflowDecision` posts a single "Review decision in Chat"
 *    action that routes to `vs-code-ai-helper.openWorkflowDecision`, never
 *    itself carrying the decision's options.
 *
 * Also covers PART 4 of "Actionable Hand-offs: one contract, nine surfaces" —
 * the rendered chat state must be DERIVED from persisted state plus the live
 * in-flight registry, never a stale posture left over from an earlier render:
 *
 *  - Resolving a decision (doNothing or command) is acknowledged directly in
 *    the transcript, since the decision card itself simply disappears
 *    otherwise — indistinguishable from the click being lost.
 *  - A `question` message that has already been superseded by a later reply
 *    never renders as "awaiting your answer" again, even though its
 *    persisted `pending` flag is never rewritten (module comment on
 *    `ChatMessage.pending`).
 *  - `busy`, `waitingForUser`, AND the view badge are all tied to an actual
 *    in-flight task operation and nothing else — each goes true/set only
 *    while a live operation justifies it and clears the moment it ends. A
 *    persisted-but-not-live open question/interaction/decision is real and
 *    still renders its content and answer controls unconditionally, but does
 *    not by itself assert any of the three active-posture claims (round 5,
 *    2026-08-22: the badge was the last of the three still keyed off
 *    persisted-only state after the banner was fixed in round 4).
 *  - When genuinely busy, the panel names the running stage, start time and
 *    resolved model (when known), with any incremental `busyDetail` appended;
 *    it never mistakes missing detail for missing task status.
 *  - The rendered entry count always equals the persisted transcript length
 *    (no entry is ever synthesized or silently dropped).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import * as vm from "node:vm";
import * as vscode from "vscode";

import {
  ChatInteractionServiceResultV1,
  ChatInteractionServicesV1,
  ChatTarget,
  ChatViewProvider,
  formatChatSchedulingPostureLineV1,
  notifyPendingWorkflowDecision,
} from "../views/chatView";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { makeOwnedTaskFolder, bindingIdForOwnedFolder, fixtureOwnershipFor } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";
import {
  LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
  readChatDocumentIdentityV1,
  readChatHistory,
  readChatInteractions,
  writeChatHistory,
} from "../utils/chatHistoryStore";
import * as chatHistoryStoreModule from "../utils/chatHistoryStore";
import { taskOperations } from "../utils/taskOperations";
import { StructuredAnswerV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";

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

interface CapturedNotification {
  message: string;
  level: "info" | "warning" | "error";
  actionCommand?: { command: string; title: string; args?: unknown[] };
}

function installNotificationRouterCapture(): { entries: CapturedNotification[]; restore: () => void } {
  const entries: CapturedNotification[] = [];
  const stub: StatusSurface = {
    addEntry: (message, level, _filePath, _resultTargetUri, _sourceOperationId, actionCommand): void => {
      entries.push({ message, level, actionCommand });
    },
  };
  initNotificationRouter(stub);
  return { entries, restore: (): void => deactivateNotificationRouter() };
}

function installExecuteCommandCapture(resolveValue: unknown = undefined): {
  calls: Array<{ id: string; args: unknown[] }>;
  restore: () => void;
} {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  const calls: Array<{ id: string; args: unknown[] }> = [];
  commandsObj._executeCommandOverride = (id: string, ...args: unknown[]): Promise<unknown> => {
    calls.push({ id, args });
    return Promise.resolve(resolveValue);
  };
  return {
    calls,
    restore: (): void => {
      commandsObj._executeCommandOverride = orig;
    },
  };
}

/**
 * The test stub's `workspace.fs.readFile` is unimplemented by default (every
 * read fails closed, harmlessly, for suites that don't need real content).
 * The staleness-reconciliation tests below need `deriveApplicableVerifiedTicksV1`
 * (called from `chatView.ts`'s render path) to actually read plan-final.md and
 * the review artifact off real disk, so they can distinguish "still
 * applicable" from "already ticked" — without this, every read would fail and
 * every decision would look indistinguishable from "cannot tell".
 */
function installRealFs(): { restore: () => void } {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsRecord.readFile;
  fsRecord.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await fs.promises.readFile(uri.fsPath, "utf8"));
  return {
    restore: (): void => {
      fsRecord.readFile = original;
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
  return makeOwnedTaskFolder("ensemble-chat-workflow-decision-").folder;
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

function decisionInput(
  canonicalId: string,
  overrides: Partial<CreateWorkflowDecisionInputV1> = {}
): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "decision-1",
    decisionKey: "exampleDecision",
    taskCanonicalId: canonicalId,
    stage: "impl",
    whatHappened: "The scheduled round finished and the summary was rejected.",
    whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
    options: [
      {
        optionId: "doIt",
        label: "Do it",
        consequence: "Applies the change immediately.",
        effect: { kind: "command", command: "ensemble.doIt", args: ["arg1"] },
      },
    ],
    recommendation: { kind: "option", optionId: "doIt", reasoning: "It is safe and reversible." },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function lastDecisions(fake: FakeWebviewView): readonly WorkflowDecisionV1[] {
  const lastState = fake.posted.filter((m) => m.type === "state").pop();
  return (lastState?.decisions as readonly WorkflowDecisionV1[] | undefined) ?? [];
}

/**
 * `open()` deliberately fires `render()` without awaiting it (matches
 * production — the panel focus command must not block on a full transcript
 * read/render), so a "state" message is not guaranteed to have posted the
 * instant `open()` resolves. Poll briefly instead of asserting on a race.
 */
async function waitForStateMessage(fake: FakeWebviewView): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (fake.posted.some((m) => m.type === "state")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function lastState(fake: FakeWebviewView): Record<string, unknown> | undefined {
  return fake.posted.filter((m) => m.type === "state").pop();
}

/** Polls for a condition against the most recently posted "state" message —
 * `busy` flips asynchronously via `taskOperations.onDidChange` -> `render()`,
 * not synchronously with `taskOperations.begin`/`end`. */
async function waitForState(fake: FakeWebviewView, predicate: (state: Record<string, unknown>) => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const state = lastState(fake);
    if (state && predicate(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the expected state");
}

void describe("Chat With AI — stage-chat posture footer", () => {
  void it("uses the five posture vocabulary and names the next continuation attempt", () => {
    assert.equal(formatChatSchedulingPostureLineV1({ kind: "running" }), "running — a round is running now");
    assert.match(
      formatChatSchedulingPostureLineV1(
        { kind: "scheduled", trigger: "continuation" },
        "2026-08-28T15:20:00.000Z"
      ),
      /^scheduled — next attempt /
    );
    assert.match(
      formatChatSchedulingPostureLineV1({
        kind: "owedWillNotRetry",
        blocker: "quota",
        surfacedAt: "2026-08-28T15:00:00.000Z",
        quarantinedFiles: [],
        willRetry: false,
      }),
      /^owed-but-will-not-retry/
    );
    assert.match(formatChatSchedulingPostureLineV1({ kind: "waitingForYou" }), /^waiting-for-you/);
    assert.match(formatChatSchedulingPostureLineV1({ kind: "unknown" }), /^unknown/);
  });
});

void describe("Chat With AI — WorkflowDecisionV1 rendering and dispatch", () => {
  void it("render() surfaces a pending decision for its exact task and stage", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      const posted = await provider.workflowDecisionStore.post(decisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]!.decisionId, "decision-1");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("render() excludes a decision posted for a different stage of the same task", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder, { stage: "impl-high-review" }));

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      assert.equal(lastDecisions(fake).length, 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("render() excludes decisions when the global assistant is open", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl", kind: "global" });
      await waitForStateMessage(fake);

      assert.equal(lastDecisions(fake).length, 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  // Task "Actionable Hand-offs" PART 5: a decision that supplies `gating`
  // must render its real content, distinguishable from one that does not.
  void it("render() carries a decision's own gating claim through to the posted state", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          gating: { holdsTaskPaused: true, unblocksProgress: true, detail: "Resolving this resumes the paused task." },
        })
      );

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake) as unknown as Array<{
        gatingLine?: string;
        isGating?: boolean;
      }>;
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]!.isGating, true);
      assert.match(decisions[0]!.gatingLine ?? "", /Resolving this resumes the paused task\./);
      assert.doesNotMatch(decisions[0]!.gatingLine ?? "", /not recorded/i);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("render() falls back to an explicit 'not recorded' gating line for a decision that omits it", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake) as unknown as Array<{
        gatingLine?: string;
        isGating?: boolean;
      }>;
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]!.isGating, false);
      assert.match(decisions[0]!.gatingLine ?? "", /not recorded — unknown/i);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolveWorkflowDecision dispatches the chosen option's command exactly once and clears the pending card", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);
      assert.equal(lastDecisions(fake).length, 1, "expected the decision to render before resolving it");
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });

      assert.deepEqual(cmds.calls, [{ id: "ensemble.doIt", args: ["arg1"] }]);
      assert.equal(lastDecisions(fake).length, 0, "a resolved decision must no longer render as pending");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolveWorkflowDecision resolves a doNothing option without dispatching any command", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          options: [
            {
              optionId: "wait",
              label: "Wait",
              consequence: "Leaves the round as-is; nothing changes.",
              effect: { kind: "doNothing" },
            },
          ],
          recommendation: { kind: "option", optionId: "wait", reasoning: "Nothing needs to happen yet." },
        })
      );
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "wait" });

      assert.deepEqual(cmds.calls, [], "a doNothing option must never dispatch a command");
      assert.equal(lastDecisions(fake).length, 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a second resolve of an already-settled decision is informational, not an error, and does not re-dispatch", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });
      notify.entries.length = 0;
      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });

      assert.deepEqual(cmds.calls, [{ id: "ensemble.doIt", args: ["arg1"] }], "must dispatch exactly once total");
      assert.equal(notify.entries.length, 1);
      assert.equal(notify.entries[0]!.level, "info", "an already-settled decision must not read as a failure");
      assert.match(notify.entries[0]!.message, /already submitted/i);

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /already submitted/i.test(e.text));
      assert.ok(
        ack,
        "an already-settled race outcome must leave a transcript trace, not only a NotificationRouter entry"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolving a decision that no longer exists is acknowledged in the transcript, not only notified", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "no-such-decision", optionId: "doIt" });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /no longer pending/i.test(e.text));
      assert.ok(ack, "a missing decision must leave a transcript trace, not only a NotificationRouter entry");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolving a decision with an unknown option is acknowledged in the transcript as declined", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "no-such-option" });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /Could not record your choice/.test(e.text));
      assert.ok(ack, "a rejected option choice must leave a transcript trace, not only a NotificationRouter entry");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("notifyPendingWorkflowDecision posts a single 'Review decision in Chat' action, not the options themselves", () => {
    const folder = makeFolder();
    const notify = installNotificationRouterCapture();
    try {
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl", taskName: "My Task" };
      const decision: WorkflowDecisionV1 = {
        decisionId: "decision-1",
        decisionKey: "exampleDecision",
        taskCanonicalId: folder,
        stage: "impl",
        whatHappened: "The scheduled round finished and the summary was rejected.",
        whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
        options: [
          {
            optionId: "doIt",
            label: "Do it",
            consequence: "Applies the change immediately.",
            effect: { kind: "command", command: "ensemble.doIt" },
          },
        ],
        recommendation: { kind: "option", optionId: "doIt", reasoning: "It is safe and reversible." },
        createdAt: new Date().toISOString(),
        state: "pending",
      };

      notifyPendingWorkflowDecision(decision, target);

      assert.equal(notify.entries.length, 1);
      const entry = notify.entries[0]!;
      assert.match(entry.message, /My Task/);
      assert.match(entry.message, /rejected/);
      assert.ok(entry.actionCommand);
      assert.equal(entry.actionCommand.command, "vs-code-ai-helper.openWorkflowDecision");
      assert.equal(entry.actionCommand.title, "Review decision in Chat");
      assert.deepEqual(entry.actionCommand.args, [target]);
    } finally {
      notify.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a non-gating decision (holdsTaskPaused:false, unblocksProgress:false) is not announced as 'Decision needed' and does not post a warning", () => {
    const folder = makeFolder();
    const notify = installNotificationRouterCapture();
    try {
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl", taskName: "My Task" };
      const decision: WorkflowDecisionV1 = {
        decisionId: "decision-1",
        decisionKey: "exampleDecision",
        taskCanonicalId: folder,
        stage: "impl",
        whatHappened: "The scheduled round finished and the summary was rejected.",
        whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
        options: [
          {
            optionId: "doIt",
            label: "Do it",
            consequence: "Applies the change immediately.",
            effect: { kind: "command", command: "ensemble.doIt" },
          },
        ],
        recommendation: { kind: "option", optionId: "doIt", reasoning: "It is safe and reversible." },
        gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "This does not resume the task." },
        createdAt: new Date().toISOString(),
        state: "pending",
      };

      notifyPendingWorkflowDecision(decision, target);

      assert.equal(notify.entries.length, 1);
      const entry = notify.entries[0]!;
      assert.equal(entry.level, "info", "a non-gating decision must not be posted as a warning");
      assert.doesNotMatch(entry.message, /Decision needed/);
      // The reported fact is still `whatHappened` — only the headline/severity
      // change with gating, never the content itself (see the module comment
      // on notifyPendingWorkflowDecision).
      assert.match(entry.message, /The scheduled round finished and the summary was rejected\./);
      // Review-flagged (2026-08-24): the non-blocking path must ALSO carry
      // `gating.detail` (why it does not need urgent attention), not only
      // `whatHappened` — dropping it left the notification with no basis for
      // its own "Optional" claim.
      assert.match(entry.message, /This does not resume the task\./);
    } finally {
      notify.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("render() marks a non-gating decision so the panel does not headline it 'Decision needed'", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      const posted = await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "This does not resume the task." },
        })
      );
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake) as ReadonlyArray<WorkflowDecisionV1 & { isBlockingDecision?: boolean }>;
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]!.isBlockingDecision, false);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  // Review-flagged (2026-08-24): the previous coverage only asserted the
  // host-side `isBlockingDecision` field posted into "state" — it never
  // executed the webview's own script, so a regression that re-hardcoded
  // `title.textContent='Decision needed'` inside the webview (the surface
  // the plan item actually targets) would leave every existing test green.
  // This extracts and evaluates the ACTUAL production expression from the
  // HTML `resolveWebviewView` assigns to `webview.html` — the same string
  // VS Code would hand to the real webview — rather than re-deriving the
  // predicate independently, so a hardcoded headline fails this test either
  // by no longer matching the expected expression shape at all, or by
  // computing the wrong string once evaluated.
  void it("the webview's own title expression computes 'Decision needed' vs 'Optional' from isBlockingDecision, not a hardcoded string", () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const html = fake.view.webview.html;
      const match = html.match(
        /title\.textContent=(\(dcs\.isBlockingDecision!==false\)\?'Decision needed':'Optional');/
      );
      assert.ok(
        match,
        "expected the decision card title in the webview script to be computed from dcs.isBlockingDecision, not hardcoded"
      );
      const expression = match[1]!;
      const computeTitle = (isBlockingDecision: boolean | undefined): unknown =>
        vm.runInNewContext(expression, { dcs: { isBlockingDecision } });
      assert.equal(computeTitle(true), "Decision needed");
      assert.equal(computeTitle(false), "Optional");
      // Absence (a decision predating the gating field) must default to
      // blocking, matching the host-side predicate's own "absence is never
      // positive evidence" rule.
      assert.equal(computeTitle(undefined), "Decision needed");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("Chat With AI — PART 4: rendered state is derived from persisted state, never stale", () => {
  void it("resolving a doNothing decision is acknowledged in the transcript as doing nothing further", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          options: [
            {
              optionId: "wait",
              label: "Wait",
              consequence: "Leaves the round as-is; nothing changes.",
              effect: { kind: "doNothing" },
            },
          ],
          recommendation: { kind: "option", optionId: "wait", reasoning: "Nothing needs to happen yet." },
        })
      );
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "wait" });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.text.includes("Wait"));
      assert.ok(ack, "expected a transcript entry acknowledging the resolved decision");
      assert.match(ack.text, /does nothing further/i);

      const persisted = await readChatHistory(folder);
      assert.equal(persisted.length, 1, "the acknowledgement must actually be written to the transcript, not only rendered");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolving a command-effect decision is acknowledged in the transcript as applying", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.text.includes("Do it"));
      assert.ok(ack, "expected a transcript entry acknowledging the resolved decision");
      assert.match(ack.text, /applying now/i);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /**
   * Review-flagged (2026-08-23): `goToReviewAndApplyV1` reports a failed
   * multi-step sequence by resolving `false` rather than throwing
   * (`setTaskStage` already reports its own failure by notification and
   * returns normally), so the dispatcher's try/catch never saw it — the
   * "applying now" acknowledgement stood uncorrected even when the command it
   * described did not actually happen. This is the two-choice shape of the
   * pre-Implementation routing decision (`preImplementationRouting`):
   * "Go to Review & Apply" (a command effect that can resolve `false`) next
   * to "Keep running Implementation" (a `doNothing` no-op) — both choices must be
   * acknowledged, and a `false` resolution must be visibly distinct from a
   * successful "applying now".
   */
  void it("resolving a command-effect decision whose command reports failure by returning false is acknowledged as not completed", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture(false);
    try {
      await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          options: [
            {
              optionId: "goToReviewAndApply",
              label: "Go to Review & Apply",
              consequence: "Moves the task to review and cancels the running round first.",
              effect: { kind: "command", command: "vs-code-ai-helper.goToReviewAndApply", args: ["arg1"] },
            },
            {
              optionId: "letItRun",
              label: "Keep running Implementation",
              consequence: "Does nothing further.",
              effect: { kind: "doNothing" },
            },
          ],
          recommendation: { kind: "option", optionId: "goToReviewAndApply", reasoning: "Apply Review can fix it." },
        })
      );
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "goToReviewAndApply" });

      assert.deepEqual(
        cmds.calls,
        [{ id: "vs-code-ai-helper.goToReviewAndApply", args: ["arg1"] }],
        "the command must still be dispatched exactly once"
      );
      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const applyingAck = entries.find((e) => e.text.includes("Go to Review & Apply") && /applying now/i.test(e.text));
      assert.ok(applyingAck, "expected the immediate 'applying now' acknowledgement before the command resolves");
      const failureAck = entries.find((e) => e.text.includes("Go to Review & Apply") && /did not complete/i.test(e.text));
      assert.ok(failureAck, "expected a follow-up acknowledgement that the command did not actually complete");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolving the sibling doNothing option of a two-choice routing decision is acknowledged and never claims a failure", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture(false);
    try {
      await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          options: [
            {
              optionId: "goToReviewAndApply",
              label: "Go to Review & Apply",
              consequence: "Moves the task to review and cancels the running round first.",
              effect: { kind: "command", command: "vs-code-ai-helper.goToReviewAndApply", args: ["arg1"] },
            },
            {
              optionId: "letItRun",
              label: "Keep running Implementation",
              consequence: "Does nothing further.",
              effect: { kind: "doNothing" },
            },
          ],
          recommendation: { kind: "option", optionId: "goToReviewAndApply", reasoning: "Apply Review can fix it." },
        })
      );
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "letItRun" });

      assert.equal(cmds.calls.length, 0, "a doNothing option must never dispatch a command");
      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.text.includes("Keep running Implementation"));
      assert.ok(ack, "expected a transcript entry acknowledging the resolved decision");
      assert.match(ack.text, /does nothing further/i);
      assert.doesNotMatch(ack.text, /did not complete/i);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a question superseded by a later reply never renders as awaiting an answer again", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      await provider.ask({ ...target, question: "Which approach should I take?" }, true, false);

      let entries =
        (lastState(fake)?.entries as
          | Array<{ role: string; at: string; id?: string; awaitingAnswer?: boolean }>
          | undefined) ?? [];
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.awaitingAnswer, true, "an unanswered question must render as awaiting");

      // Bound reply channel (Part 10 item 13e), not the shared send box —
      // an ordinary append("user", ...) no longer settles anything (see the
      // dedicated regression test below).
      await provider.answerQuestion(target, entries[0]!.id ?? entries[0]!.at, "Use approach B.", "impl");

      entries =
        (lastState(fake)?.entries as
          | Array<{ role: string; at: string; id?: string; awaitingAnswer?: boolean }>
          | undefined) ?? [];
      assert.equal(entries.length, 2);
      assert.equal(
        entries[0]!.awaitingAnswer,
        false,
        "the earlier question is superseded by the reply and must no longer render as awaiting"
      );

      // The persisted record's own `pending` flag is never rewritten — this
      // is the source of the defect (module comment on ChatMessage.pending),
      // and proves the fix is in rendering, not in silently mutating history.
      const persisted = await readChatHistory(folder);
      assert.equal(persisted[0]!.pending, true, "the persisted flag itself is untouched by design");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /**
   * Review blocker (2026-08-30): the no-context escalation fallback used to
   * post a legacy free-text question whose bound option button carried only
   * `{ optionId, label, description }` — clicking it recorded the label as
   * ordinary chat text and dispatched nothing. That mechanism is gone; the
   * fallback now posts a real `singleChoice` interaction with
   * `actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1` and an `optionEffects`
   * map (`askInteraction`), settled entirely within `chatView.ts` — these
   * tests exercise that mechanism directly through the same
   * `confirmInteraction` webview message every other structured question
   * uses.
   */
  void it("confirming a local-only singleChoice interaction with a command effect actually dispatches the command", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const interactionId = "7".repeat(32);
      const operationId = "8".repeat(32);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId,
          operationId,
          actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
          optionEffects: {
            plan: { kind: "command", command: "vs-code-ai-helper.openAiModels" },
            task: { kind: "doNothing" },
          },
        },
        true,
        false
      );
      cmds.calls.length = 0; // drop any focus-command call askInteraction may issue

      await fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });

      assert.deepEqual(
        cmds.calls,
        [{ id: "vs-code-ai-helper.openAiModels", args: [] }],
        "the chosen option's bound command must actually be dispatched"
      );
      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /applying now/i.test(e.text));
      assert.ok(ack, "expected an 'applying now' acknowledgement, matching the decision-card effect path");

      const interactions = await readChatInteractions(folder, folder);
      const settled = interactions.find((i) => i.interactionId === interactionId);
      assert.equal(settled?.state, "resumed", "a local-only interaction settles as resumed, with no separate Resume step");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("confirming a local-only singleChoice interaction with a doNothing effect dispatches no command", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const interactionId = "9".repeat(32);
      const operationId = "e".repeat(32);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId,
          operationId,
          actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
          optionEffects: {
            plan: { kind: "doNothing" },
            task: { kind: "command", command: "vs-code-ai-helper.openAiModels" },
          },
        },
        true,
        false
      );
      cmds.calls.length = 0;

      await fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });

      assert.deepEqual(cmds.calls, [], "a doNothing effect must dispatch no command");
      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /does nothing further/i.test(e.text));
      assert.ok(ack, "expected a 'does nothing further' acknowledgement for the doNothing option");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("confirming a local-only interaction persists the durable, stable selectedOptionId", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const interactionId = "a".repeat(32);
      const operationId = "b".repeat(32);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId,
          operationId,
          actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
          optionEffects: { plan: { kind: "doNothing" }, task: { kind: "doNothing" } },
        },
        true,
        false
      );

      await fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });

      const interactions = await readChatInteractions(folder, folder);
      const settled = interactions.find((i) => i.interactionId === interactionId);
      assert.equal(
        settled?.answers?.[0]?.kind === "singleChoice" && settled.answers[0].state === "answered"
          ? settled.answers[0].selectedOptionId
          : undefined,
        "plan",
        "the durable record must carry the chosen option's stable id"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /**
   * Review blocker (2026-08-30, second round, now against the interaction
   * mechanism): a stale render still showing an enabled Confirm button (or
   * any other double-submit) must not re-run the chosen option's effect a
   * second time. `settleLocalOnlyInteractionAnswersV1` checks the
   * interaction's own `state` before doing anything.
   */
  void it("confirming an already-resolved local-only interaction a second time does not re-run its effect", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const interactionId = "d".repeat(32);
      const operationId = "f".repeat(32);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId,
          operationId,
          actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
          optionEffects: { plan: { kind: "command", command: "vs-code-ai-helper.openAiModels" }, task: { kind: "doNothing" } },
        },
        true,
        false
      );

      await fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });
      cmds.calls.length = 0; // drop the first confirm's own dispatch

      await fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });

      assert.deepEqual(cmds.calls, [], "the second confirm must not re-run the option's effect");
      const interactions = await readChatInteractions(folder, folder);
      const settled = interactions.find((i) => i.interactionId === interactionId);
      assert.equal(settled?.state, "resumed", "the interaction remains settled from the first confirm");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  /**
   * Review blocker (2026-09-02): the previous fix for the reentrancy
   * deadlock at the top of this describe block introduced a folder-wide
   * `queueActiveFolders` bypass in `ChatViewProvider`'s `runQueued` that could
   * not distinguish a genuinely nested call from an unrelated concurrent
   * caller for the same folder — a second `confirmInteraction` arriving while
   * the first was still awaiting I/O would see the folder "active" and run
   * outside the queue entirely, reading the pre-settlement `"unresolved"`
   * record and re-running the command effect a second time. Fixed by moving
   * the effect's execution out of the queued write
   * (`settleLocalOnlyInteractionAnswersV1` now only returns the pending
   * effect; the caller runs it after the queued call resolves) so `runQueued`
   * could go back to being a plain FIFO with no reentrancy case.
   *
   * Review blocker (2026-09-03): an earlier version of this test fired both
   * confirmations back-to-back inside one `Promise.all` without awaiting the
   * first, on the theory that their real fs I/O would "genuinely interleave".
   * Nothing forces that: `Promise.all([a(), b()])` calls `a()` and `b()`
   * synchronously in order, and each call's own synchronous prefix (up to its
   * first `await`) already runs to completion before the next expression is
   * evaluated — so whether the second confirmation's queued callback actually
   * becomes active while the first's is still running depends on incidental
   * timing, not anything the test controls. A pass there does not prove the
   * former bypass is unreachable.
   *
   * Review blocker (2026-09-02, second pass): a prior version of this test
   * gated the FIRST call to `readChatInteractions` — before it had even run
   * — and released it only after asserting nothing had dispatched. That
   * proves too little: the first callback had not yet captured the
   * pre-settlement `"unresolved"` record at the point the assertion ran, so
   * an implementation that let the second confirmation's read happen first
   * (settling before the first ever read the record) would also pass. The
   * scenario this test exists to rule out is specifically a SECOND read
   * observing the STILL-STALE `"unresolved"` record while the first
   * callback is genuinely suspended mid-settlement — which requires the
   * gate to sit AFTER the first callback's own read (so it has already
   * captured `"unresolved"`) and AT the first persistence write
   * (`recordChatInteractionAnswers`, called only once validation of that
   * captured record passes), not before the read.
   *
   * This version gates `recordChatInteractionAnswers` instead, and counts
   * calls to both it and `readChatInteractions` for two complementary
   * checks. First, WHILE the first callback sits suspended (having already
   * read the stale `"unresolved"` record), nothing else may call
   * `readChatInteractions` — under strict FIFO (`runQueued`) the second
   * callback cannot begin until the first's whole callback, including this
   * persistence write, has resolved, so that count must stay at 1
   * throughout the gated window; under the removed folder-wide reentrancy
   * bypass it would start immediately (this test's gate deliberately makes
   * the first "active"), firing its own read and observing the same stale
   * record. Second, and decisively, after both confirmations finish,
   * `recordChatInteractionAnswers` must have been called exactly ONCE
   * total: `settleLocalOnlyInteractionAnswersV1` only reaches that call when
   * its own fresh read still shows `"unresolved"`, so a second callback
   * that correctly observes the first's `"resumed"` settlement short-
   * circuits without calling it again, while one that (as under the removed
   * bypass) reads the stale `"unresolved"` record calls it a second time and
   * re-runs the option's effect — the exact double-dispatch this test
   * exists to catch.
   */
  void it("two concurrent confirmations of the same local-only interaction dispatch the command exactly once", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const originalReadChatInteractions = chatHistoryStoreModule.readChatInteractions;
    const originalRecordChatInteractionAnswers = chatHistoryStoreModule.recordChatInteractionAnswers;
    // Declared outside the `try` so `finally` can release it unconditionally.
    let releaseFirst: () => void = () => undefined;
    try {
      provider.resolveWebviewView(fake.view);
      const interactionId = "1".repeat(32);
      const operationId = "2".repeat(32);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId,
          operationId,
          actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
          optionEffects: { plan: { kind: "command", command: "vs-code-ai-helper.openAiModels" }, task: { kind: "doNothing" } },
        },
        true,
        false
      );
      cmds.calls.length = 0; // drop any focus-command call askInteraction may issue

      // Count every `readChatInteractions` call (never gated) so the
      // assertion below can prove the second confirmation's queued callback
      // has not even reached its own read while the first is held.
      let readCallCount = 0;
      (
        chatHistoryStoreModule as unknown as { readChatInteractions: typeof originalReadChatInteractions }
      ).readChatInteractions = async (
        ...args: Parameters<typeof originalReadChatInteractions>
      ): ReturnType<typeof originalReadChatInteractions> => {
        readCallCount += 1;
        return originalReadChatInteractions(...args);
      };

      // Gate the FIRST call to `recordChatInteractionAnswers`, and count
      // every call to it: by the time `doSubmitInteractionAnswers` reaches
      // it, the callback has already read `readChatInteractions`, found the
      // record `"unresolved"`, and validated the answers — so blocking here
      // suspends the callback strictly AFTER it holds the stale
      // pre-settlement state, immediately before the write that would
      // resolve that staleness. `settleLocalOnlyInteractionAnswersV1` only
      // reaches this call when its freshly-read `record.state ===
      // "unresolved"`, so the call COUNT is the real correctness signal: a
      // second callback that (correctly) observes the first's settlement
      // must short-circuit without ever calling this, while one that
      // (incorrectly) re-reads the stale `"unresolved"` record — the
      // removed folder-wide bypass's failure mode — calls it a second time
      // and re-runs the option's effect.
      let recordCallCount = 0;
      const firstIsBlockedAfterStaleRead = new Promise<void>((resolveActive) => {
        let gated = false;
        (
          chatHistoryStoreModule as unknown as {
            recordChatInteractionAnswers: typeof originalRecordChatInteractionAnswers;
          }
        ).recordChatInteractionAnswers = async (
          ...args: Parameters<typeof originalRecordChatInteractionAnswers>
        ): ReturnType<typeof originalRecordChatInteractionAnswers> => {
          recordCallCount += 1;
          if (!gated) {
            gated = true;
            resolveActive();
            await new Promise<void>((resolveRelease) => {
              releaseFirst = resolveRelease;
            });
          }
          return originalRecordChatInteractionAnswers(...args);
        };
      });

      const firstSend = fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });
      await firstIsBlockedAfterStaleRead; // the first confirmation has read the stale record and is now suspended at persistence
      assert.equal(
        readCallCount,
        1,
        "only the first confirmation's own read should have happened by the time it reaches persistence"
      );

      const secondSend = fake.send({ type: "confirmInteraction", operationId, interactionId, answers: VALID_ANSWERS });
      // Safety margin only (the second send's synchronous handler prefix —
      // up to its own `runQueued` enqueue — has already run by the time the
      // `fake.send` call above returns): flush a couple of microtask turns
      // before checking that nothing has fired yet.
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        readCallCount,
        1,
        "strict FIFO must not let the second confirmation's queued callback begin — and re-read the still-stale " +
          "record — while the first is suspended mid-settlement; a folder-wide reentrancy bypass would let this read fire early"
      );
      assert.deepEqual(
        cmds.calls,
        [],
        "the command must not dispatch while the first confirmation's settlement is still suspended"
      );

      releaseFirst();
      await Promise.all([firstSend, secondSend]);

      // The decisive assertion: `recordChatInteractionAnswers` must have
      // been called exactly ONCE across both confirmations. Note this is
      // NOT the same claim as "`readChatInteractions` was called exactly
      // twice" — `render()` and other post-settlement bookkeeping also call
      // `readChatInteractions` incidentally once each confirmation's queued
      // op resolves, so that count is not a reliable signal by itself and is
      // only asserted above, during the suspended window, where it IS
      // meaningful (nothing else reads while the first is genuinely
      // blocked). Once released, the second confirmation's callback finally
      // gets to read — and under the fix it observes `"resumed"`, takes the
      // `record.state !== "unresolved"` short-circuit in
      // `settleLocalOnlyInteractionAnswersV1`, and never reaches this call a
      // second time. Under the removed folder-wide bypass, the second
      // callback would instead have read the still-stale `"unresolved"`
      // record already (while the first was suspended, which the assertion
      // above independently rules out) or upon release would still validate
      // and persist again, driving this count to 2.
      assert.equal(
        recordCallCount,
        1,
        "the second confirmation must never re-persist the answers — it must observe the first's settlement " +
          "(\"resumed\") and short-circuit, not the stale \"unresolved\" record"
      );
      assert.deepEqual(
        cmds.calls,
        [{ id: "vs-code-ai-helper.openAiModels", args: [] }],
        "the option's bound command must be dispatched exactly once, however the two confirmations interleave"
      );
      const interactions = await originalReadChatInteractions(folder, folder);
      const settled = interactions.find((i) => i.interactionId === interactionId);
      assert.equal(settled?.state, "resumed", "the interaction settles exactly once");
    } finally {
      // Release unconditionally: an assertion failure above (or the "await
      // firstIsBlockedAfterStaleRead" step itself throwing) must not leave
      // the first confirmation's queued callback suspended forever, which
      // would otherwise hang this task's `runQueued` chain for the rest of
      // the test run.
      releaseFirst();
      (
        chatHistoryStoreModule as unknown as { readChatInteractions: typeof originalReadChatInteractions }
      ).readChatInteractions = originalReadChatInteractions;
      (
        chatHistoryStoreModule as unknown as {
          recordChatInteractionAnswers: typeof originalRecordChatInteractionAnswers;
        }
      ).recordChatInteractionAnswers = originalRecordChatInteractionAnswers;
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("an ordinary chat send is never silently interpreted as an answer to a pending question", async () => {
    // Review blocker, 2026-08-29 (wf "stage chat as a record of work" Part 10
    // item 13e): a plain `role: "user"` message posted through the shared
    // chat-send box (i.e. no `answersQuestionAt` correlation) must never
    // settle a pending question, however many are outstanding. Only a reply
    // through that specific question's own bound control
    // (`ChatViewProvider.answerQuestion`) may settle it.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      await provider.ask({ ...target, question: "Which approach should I take?" }, true, false);

      // An ordinary chat turn — same shape a user typing into the shared
      // send box would produce — carries no `answersQuestionAt`.
      await provider.append("user", "Just a general remark, not an answer.", "impl", target);

      const entries =
        (lastState(fake)?.entries as Array<{ role: string; awaitingAnswer?: boolean }> | undefined) ?? [];
      assert.equal(entries.length, 2);
      assert.equal(
        entries[0]!.awaitingAnswer,
        true,
        "an ordinary chat send must not settle a pending question it does not explicitly answer"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("busy tracks a real in-flight task operation exactly, never a stale posture", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    let op: ReturnType<typeof taskOperations.begin> = null;
    try {
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);
      assert.equal(lastState(fake)?.busy, false, "nothing is running yet");

      op = taskOperations.begin(folder, { label: "Doing work", stage: "impl" });
      assert.ok(op, "expected the exclusive operation lock to be acquired");
      op.setModel?.("claude-code");
      await waitForState(fake, (s) => s.busy === true);

      taskOperations.end(op);
      op = null;
      await waitForState(fake, (s) => s.busy === false);
    } finally {
      if (op) taskOperations.end(op);
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the rendered entry count always equals the persisted transcript length", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await provider.append("user", "hello", "impl", target);
      await provider.ask({ ...target, question: "which way?" }, true, false);
      await provider.append("user", "this way", "impl", target);
      await waitForStateMessage(fake);

      const persisted = await readChatHistory(folder);
      const entries = (lastState(fake)?.entries as unknown[] | undefined) ?? [];
      assert.equal(entries.length, persisted.length);
      assert.equal(persisted.length, 3);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a chat-history write from outside this provider instance re-renders an already-open panel", async () => {
    // Regression coverage for the review-flagged gap: `actions/rows/
    // chatSendRowV1.ts` and `globalAssistantSendRowV1.ts` both write
    // chat-v1.json directly through `writeChatHistory`, bypassing this
    // provider's own append()/ask() (which already re-render themselves).
    // Before `onDidChangeChatHistoryV1`, an already-open panel had no
    // subscription to the persisted chat store itself — only to
    // `taskOperations` and `workflowDecisionStore` — so a write from one of
    // those row actions left it stale until an unrelated trigger happened to
    // re-render it. This calls `writeChatHistory` directly, exactly as those
    // row actions do, with no call into the provider at all.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);
      assert.equal((lastState(fake)?.entries as unknown[] | undefined)?.length, 0, "starts empty");

      await writeChatHistory(folder, [{ role: "assistant", text: "written externally", stage: "impl", at: new Date().toISOString() }], folder);

      await waitForState(fake, (s) => ((s.entries as unknown[] | undefined)?.length ?? 0) === 1);
      const persisted = await readChatHistory(folder);
      assert.equal(persisted.length, 1);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a chat-history write for a different task does not re-render a panel open on another task", async () => {
    const folder = makeFolder();
    const otherFolder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      // `resolveWebviewView` and `open()` each fire an un-awaited render(),
      // so more than one "state" message can still be in flight once the
      // first appears — wait for one that actually reflects the opened
      // target, then let any trailing redundant render settle before
      // snapshotting the count, or a stray extra state message from THAT
      // settling (not from the unrelated write below) would make this test
      // flaky.
      await waitForState(fake, (s) => (s.target as ChatTarget | undefined)?.canonicalId === folder);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = fake.posted.length;

      await writeChatHistory(otherFolder, [{ role: "assistant", text: "unrelated task", stage: "impl", at: new Date().toISOString() }], otherFolder);
      // No predicate to wait on (nothing should change) — give any stray
      // re-render a turn to happen, then assert none did.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fake.posted.length, before, "a write for a different task must not re-render this panel");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(otherFolder, { recursive: true, force: true });
    }
  });

  void it("an unrelated assistant message appended after an unanswered question does not falsely settle it", async () => {
    // Regression coverage for the review-flagged defect: settlement was
    // previously computed from "is this the transcript's last entry", which
    // falsely marked a question as answered the moment ANY later entry
    // appeared — not only a user reply. Only a role:"user" entry may settle
    // a question (module comment on ChatMessage.pending).
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      await provider.ask({ ...target, question: "Which approach should I take?" }, true, false);
      await provider.append("assistant", "A status update, not an answer.", "impl", target);

      const entries =
        (lastState(fake)?.entries as Array<{ role: string; awaitingAnswer?: boolean }> | undefined) ?? [];
      assert.equal(entries.length, 2);
      assert.equal(
        entries[0]!.awaitingAnswer,
        true,
        "an unrelated later assistant message must not settle a question the user never answered"
      );
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "no live task operation is registered — a persisted-only unanswered question must not assert the active waiting posture, even though its content (awaitingAnswer above) still renders"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a decision resolved directly through the store re-renders this panel without a stale card", async () => {
    // Simulates a decision settled from elsewhere (another window, or an
    // automated dispatch) sharing the same underlying Memento — bypassing
    // this panel's own `resolveWorkflowDecision` webview message entirely —
    // and proves the panel's own onDidChange subscription still catches it.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);
      assert.equal(lastDecisions(fake).length, 1, "expected the decision to render before resolving it");

      await provider.workflowDecisionStore.resolve("decision-1", "doIt");

      await waitForState(fake, (s) => ((s.decisions as unknown[] | undefined) ?? []).length === 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("an answer-only submission (not confirmInteraction) is acknowledged in the transcript", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
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

      await fake.send({
        type: "submitInteractionAnswers",
        operationId: "2".repeat(32),
        interactionId: "1".repeat(32),
        answers: VALID_ANSWERS,
      });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /Recorded: your answer was submitted/.test(e.text));
      assert.ok(ack, "expected an answer-only submission to be acknowledged directly in the transcript");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("an invalid answer submission is acknowledged in the transcript as declined, not only notified", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: "3".repeat(32),
          operationId: "4".repeat(32),
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
        operationId: "4".repeat(32),
        interactionId: "3".repeat(32),
        answers: [],
      });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /Could not submit your answers/.test(e.text));
      assert.ok(ack, "a declined submission must leave a transcript trace, not only a NotificationRouter entry");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a refused cancel is acknowledged in the transcript as declined, not only notified", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const services: ChatInteractionServicesV1 = {
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: (): Promise<ChatInteractionServiceResultV1> =>
        Promise.resolve({ ok: false, reason: "cannot cancel now" }),
    };
    provider.setInteractionServices(services);
    try {
      provider.resolveWebviewView(fake.view);
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: "5".repeat(32),
          operationId: "6".repeat(32),
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      await fake.send({
        type: "cancelInteraction",
        operationId: "6".repeat(32),
        interactionId: "5".repeat(32),
      });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      const ack = entries.find((e) => e.role === "assistant" && /Could not cancel: cannot cancel now/.test(e.text));
      assert.ok(ack, "a refused cancel must leave a transcript trace, not only a NotificationRouter entry");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a stacked second pending question is settled by its own bound reply, not the older unanswered one too", async () => {
    // Regression coverage for the review-flagged correlation defect:
    // settling every earlier pending question off a single later reply had
    // no correlation to which question the reply actually addressed. `ask()`
    // has no lock preventing a second question from stacking before the
    // first is answered, so this is a real, reachable state. Each question's
    // bound reply control (Part 10 item 13e) names exactly which question it
    // answers via `answersQuestionAt`, so this is now settled by explicit
    // correlation rather than "the nearest one".
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      await provider.ask({ ...target, question: "First question?" }, true, false);
      await provider.ask({ ...target, question: "Second question?" }, true, false);
      const beforeReply =
        (lastState(fake)?.entries as Array<{ role: string; text: string; at: string; id?: string }> | undefined) ??
        [];
      const secondQuestion = beforeReply.find((e) => e.text.includes("Second question?"));
      assert.ok(secondQuestion, "expected the second question to be in the transcript");
      await provider.answerQuestion(target, secondQuestion.id ?? secondQuestion.at, "answering the second one", "impl");

      const entries =
        (lastState(fake)?.entries as Array<{ role: string; text: string; awaitingAnswer?: boolean }> | undefined) ??
        [];
      assert.equal(entries.length, 3);
      assert.equal(
        entries[0]!.awaitingAnswer,
        true,
        "the first, older question was never actually answered and must stay awaiting"
      );
      assert.equal(
        entries[1]!.awaitingAnswer,
        false,
        "the second question is settled by the reply that immediately followed it"
      );
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "no live task operation is registered — the still-unanswered older question renders its content (awaitingAnswer above) but must not assert the active waiting posture on its own"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("two questions sharing the same `at` timestamp are still settled independently by their own id", async () => {
    // Regression coverage for the review-flagged collision defect: before
    // `ChatMessage.id` existed, correlation was keyed solely by `entry.at`,
    // so two questions posted within the same millisecond (a real,
    // reachable case for two escalations raised back-to-back) would share a
    // map key and a reply to either one would settle whichever question
    // happened to occupy that key last. This seeds two `role: "question"`
    // entries with an IDENTICAL `at` value but distinct `id`s directly via
    // `writeChatHistory` (bypassing `ask()`'s own clock) to force the
    // collision, then proves a reply naming one `id` settles only that one.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      const sharedAt = new Date().toISOString();
      await writeChatHistory(
        folder,
        [
          { role: "question", text: "First question?", stage: "impl", at: sharedAt, pending: true, id: "question-one" },
          { role: "question", text: "Second question?", stage: "impl", at: sharedAt, pending: true, id: "question-two" },
        ],
        folder
      );

      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForState(fake, (s) => (s.entries as unknown[] | undefined)?.length === 2);

      let entries =
        (lastState(fake)?.entries as Array<{ text: string; id?: string; awaitingAnswer?: boolean }> | undefined) ??
        [];
      assert.equal(entries[0]!.awaitingAnswer, true);
      assert.equal(entries[1]!.awaitingAnswer, true);

      await provider.answerQuestion(target, "question-two", "answering only the second one", "impl");

      entries =
        (lastState(fake)?.entries as Array<{ text: string; id?: string; awaitingAnswer?: boolean }> | undefined) ??
        [];
      assert.equal(
        entries[0]!.awaitingAnswer,
        true,
        "the first question shares the second's `at` but a different `id`, and must stay awaiting"
      );
      assert.equal(entries[1]!.awaitingAnswer, false, "the second question is the one the reply named by id");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a persisted-only pending question shows neither active posture, but its content still renders", async () => {
    // Complements the "busy tracks a real in-flight task operation" test:
    // proves that a genuinely pending, durably-persisted question with ZERO
    // live `taskOperations` entries registered asserts NEITHER active
    // posture banner (`busy` nor `waitingForUser`) — per AC3's own text,
    // "The chat panel cannot show a pending posture without a live
    // in-flight transaction," and the persisted record is not itself a
    // transaction. The question's content is still real and must still
    // render (`awaitingAnswer` on its transcript entry) — that is what
    // satisfies Part 4.2's "settled renders settled... with or without
    // controls" without asserting an unbacked active posture.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      await provider.ask({ ...target, question: "Which way?" }, true, false);
      await waitForState(fake, (s) => (s.entries as Array<{ text: string }> | undefined)?.length === 1);

      const entries = (lastState(fake)?.entries as Array<{ text: string; awaitingAnswer?: boolean }> | undefined) ?? [];
      const askedEntry = entries.find((e) => e.text.includes("Which way?"));
      assert.ok(askedEntry, "the question's content must still render");
      assert.equal(askedEntry.awaitingAnswer, true, "the question's content must still show as awaiting an answer");
      assert.equal(
        lastState(fake)?.busy,
        false,
        "no task operation is registered — a persisted-only pending question must never show the busy spinner"
      );
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "no task operation is registered — a persisted-only pending question must not assert the active waiting-for-user posture either"
      );
      assert.equal(
        taskOperations.getTaskOperations(folder).length,
        0,
        "sanity: genuinely no live operation is registered for this task"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("waitingForUser is only ever asserted from a live operation; persisted-only records render their content without asserting the posture", async () => {
    // Review-flagged (2026-08-22, rounds 2-4): AC3's own text is "The chat
    // panel cannot show a pending posture without a live in-flight
    // transaction" — no carve-out for a persisted-but-not-live record. This
    // proves the property directly: `waitingForUser`/`waitingForUserSource`
    // are true, and name "liveOperation", ONLY while a live `taskOperations`
    // entry justifies it (case 2); every other case that would previously
    // have set it from a persisted-only record (a legacy free-text question,
    // a WorkflowDecisionV1, a structured interaction — cases 3-5) instead
    // leaves both false, while the record's own content still renders in
    // full and is checked against its real identity, proving the content
    // itself is not lost even though it no longer drives the posture claim.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    let op: ReturnType<typeof taskOperations.begin> = null;
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      // Case 1: nothing pending — no claim at all.
      assert.equal(lastState(fake)?.waitingForUser, false, "no source: waitingForUser must be false");
      assert.equal(lastState(fake)?.waitingForUserSource, undefined, "no source: no source name is reported");
      assert.equal(
        (fake.view as unknown as { badge?: unknown }).badge,
        undefined,
        "the view badge mirrors waitingForUser and must be unset with nothing pending"
      );

      // Case 2: a live task operation flagged as waiting on the user — the
      // only case that may legitimately set the posture, and the only case
      // that may legitimately light the view badge (it asserts the same
      // claim as the banner, on a different widget — see the review-flagged
      // 2026-08-22 round-5 fix for the badge specifically).
      op = taskOperations.begin(folder, { label: "Doing work" });
      assert.ok(op, "expected the exclusive operation lock to be acquired");
      op.setWaitingForUser(true);
      await waitForState(fake, (s) => s.waitingForUser === true);
      assert.equal(lastState(fake)?.waitingForUserSource, "liveOperation");
      assert.deepEqual(
        (fake.view as unknown as { badge?: { value: number; tooltip: string } }).badge,
        { value: 1, tooltip: "Waiting for your answer" },
        "a live waiting-for-user operation must light the view badge"
      );
      taskOperations.end(op);
      op = null;
      await waitForState(fake, (s) => s.waitingForUser === false);
      assert.equal(
        (fake.view as unknown as { badge?: unknown }).badge,
        undefined,
        "the badge must clear the instant the live operation ends"
      );

      // Case 3: a legacy free-text pending question, no live operation. The
      // posture claim must NOT fire, but the content must still render, with
      // the exact transcript entry marked `awaitingAnswer` — proving the
      // record is real even though it no longer drives the banner.
      await provider.ask({ ...target, question: "Which way?" }, true, false);
      await waitForState(fake, (s) => (s.entries as Array<{ text: string }> | undefined)?.length === 1);
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "a persisted-only question must not assert the waiting posture"
      );
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);
      const questionEntries =
        (lastState(fake)?.entries as
          | Array<{ role: string; text: string; at: string; id?: string; awaitingAnswer?: boolean }>
          | undefined) ?? [];
      const askedEntry = questionEntries.find((e) => e.text.includes("Which way?"));
      assert.ok(askedEntry, "the question's content must still exist in the rendered transcript");
      assert.equal(askedEntry.awaitingAnswer, true, "the content must still show as awaiting an answer");
      assert.equal(
        (fake.view as unknown as { badge?: unknown }).badge,
        undefined,
        "a persisted-only pending question must not light the view badge either"
      );
      // Bound reply channel (Part 10 item 13e), not the shared send box.
      await provider.answerQuestion(target, askedEntry.id ?? askedEntry.at, "This way.", "impl");
      await waitForState(fake, (s) => (s.entries as Array<{ awaitingAnswer?: boolean }> | undefined)?.[0]?.awaitingAnswer === false);
      assert.equal(lastState(fake)?.waitingForUser, false);
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);

      // Case 4: a pending WorkflowDecisionV1 record, no live operation. The
      // posture claim must NOT fire, but the rendered `decisions` array must
      // still carry the real decision id.
      await provider.workflowDecisionStore.post(decisionInput(folder));
      await waitForState(fake, (s) => (s.decisions as unknown[] | undefined)?.length === 1);
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "a persisted-only decision must not assert the waiting posture"
      );
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);
      const renderedDecisions =
        (lastState(fake)?.decisions as ReadonlyArray<{ decisionId: string }> | undefined) ?? [];
      assert.equal(renderedDecisions.length, 1);
      assert.equal(renderedDecisions[0]!.decisionId, "decision-1", "the decision content must name the actual record");
      await provider.workflowDecisionStore.resolve("decision-1", "doIt");
      await waitForState(fake, (s) => ((s.decisions as unknown[] | undefined) ?? []).length === 0);
      assert.equal(lastState(fake)?.waitingForUser, false);
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);

      // Case 5: an unresolved structured interaction, no live operation. The
      // chat document already exists (cases 3-4 created it), so its binding
      // must be read back rather than reusing the literal "chat-document-id"
      // the other, document-creating tests in this file use.
      const identity = await readChatDocumentIdentityV1(folder, folder);
      assert.ok(identity, "expected the chat document created by earlier cases to exist");
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: "7".repeat(32),
          operationId: "8".repeat(32),
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: identity.taskBindingId, chatDocumentId: identity.documentId },
        },
        true,
        false
      );
      await waitForState(fake, (s) => (s.interactions as unknown[] | undefined)?.length === 1);
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "a persisted-only structured interaction must not assert the waiting posture"
      );
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);
      const renderedInteractions = lastState(fake)?.interactions as ReadonlyArray<{ interactionId?: string }> | undefined;
      assert.equal(
        renderedInteractions?.[0]?.interactionId,
        "7".repeat(32),
        "the interaction content must name the actual posted interaction"
      );
      assert.equal(
        (fake.view as unknown as { badge?: unknown }).badge,
        undefined,
        "a persisted-only structured interaction must not light the view badge either"
      );
    } finally {
      if (op) taskOperations.end(op);
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("neither active posture is shown for a persisted-only record, even with all three waiting sources open at once", async () => {
    // Named to answer the review's second Part 4 blocker directly (rounds
    // 3-4): "Part 4 still lacks a conforming pending-requires-inflight/
    // explicit-unknown invariant test." This proves BOTH `busy` and
    // `waitingForUser` — the panel's only two active-posture banners — stay
    // false under the hardest compound case: all three persisted "someone
    // needs to look at this" sources (question, decision, interaction) open
    // simultaneously, zero live task operations registered throughout. If
    // either posture were ever derived from anything but a live
    // `taskOperations` entry, this is where it would leak true. Their
    // content (checked in the previous test, case by case) still renders —
    // this test only asserts the two posture booleans.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      assert.equal(taskOperations.getTaskOperations(folder).length, 0, "sanity: no live operation registered yet");

      await provider.ask({ ...target, question: "Which artifact?" }, true, false);
      await waitForState(fake, (s) => (s.entries as Array<{ text: string }> | undefined)?.length === 1);
      await provider.workflowDecisionStore.post(decisionInput(folder));
      await waitForState(fake, (s) => (s.decisions as unknown[] | undefined)?.length === 1);

      const identity = await readChatDocumentIdentityV1(folder, folder);
      assert.ok(identity, "expected the chat document created above to exist");
      await provider.askInteraction(
        {
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl",
          interactionId: "9".repeat(32),
          operationId: "a".repeat(32),
          actionKey: "generatePlan.v1",
          sourceAttemptId: "d".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: identity.taskBindingId, chatDocumentId: identity.documentId },
        },
        true,
        false
      );
      await waitForState(fake, (s) => (s.interactions as unknown[] | undefined)?.length === 1);

      assert.equal(
        lastState(fake)?.busy,
        false,
        "no live task operation is registered anywhere — busy must stay false with all three persisted sources open"
      );
      assert.equal(
        taskOperations.getTaskOperations(folder).length,
        0,
        "sanity: still genuinely no live operation registered for this task"
      );
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "no live task operation is registered anywhere — waitingForUser must ALSO stay false with all three persisted sources open, per AC3: no pending posture without a live in-flight transaction"
      );
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);
      assert.equal(
        (fake.view as unknown as { badge?: unknown }).badge,
        undefined,
        "the view badge is the same active-posture claim as waitingForUser and must stay unset under the same compound case"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("busy status names the live operation even before it reports incremental detail", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    let op: ReturnType<typeof taskOperations.begin> = null;
    try {
      provider.resolveWebviewView(fake.view);
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl" };
      await provider.open(target);
      await waitForStateMessage(fake);

      // A live, genuinely busy operation that never reports a detail:
      // `busy` is true but `busyDetail` stays undefined so the webview falls
      // back to the explicit no-status statement rather than implying a
      // narrated wait that isn't happening.
      op = taskOperations.begin(folder, { label: "Doing work", stage: "impl" });
      assert.ok(op, "expected the exclusive operation lock to be acquired");
      op.setModel?.("claude-code");
      await waitForState(fake, (s) => s.busy === true);
      assert.equal(
        lastState(fake)?.busyDetail,
        undefined,
        "an operation that never called report(...) must not synthesize a detail"
      );
      assert.match(
        String((lastState(fake) as { busyText?: string } | undefined)?.busyText ?? ""),
        /^Running Implementation since .* — claude-code$/,
        "a live operation without incremental detail must name its stage, start time, and resolved model"
      );

      // The same operation reports an incremental detail: it must now
      // surface verbatim as `busyDetail`.
      op.report("iteration 2/3");
      await waitForState(fake, (s) => s.busyDetail === "iteration 2/3");
      assert.equal(lastState(fake)?.busy, true, "still busy while the detail is reported");

      // Clearing the detail (report(undefined)) returns to the explicit
      // no-status statement rather than a stale leftover detail.
      op.report(undefined);
      await waitForState(fake, (s) => s.busyDetail === undefined);
      assert.equal(lastState(fake)?.busy, true, "still busy after the detail is cleared");

      taskOperations.end(op);
      op = null;
      await waitForState(fake, (s) => s.busy === false);
      assert.equal(
        lastState(fake)?.busyDetail,
        undefined,
        "busyDetail must not survive the operation it was reported on"
      );
    } finally {
      if (op) taskOperations.end(op);
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the webview's busy-status renderer uses the informative busyText and never claims task status is unavailable", () => {
    // The lifecycle test above ("busyDetail renders...") only proves the
    // `busyDetail` field on the posted "state" message is computed
    // correctly. It never inspects the webview's rendering script, so it
    // would keep passing even if the busy-text branch in `chatView.ts`'s
    // `html()` (around the `bt.textContent=` assignment) regressed to a bare
    // "Waiting for the AI…" spinner that ignores `busyDetail` entirely — the
    // exact review-flagged gap. This asserts the STRUCTURE of the real
    // `bt.textContent=...` assignment pulled out of the actual generated
    // webview HTML (not a hand-duplicated copy of it): a ternary keyed on
    // `s.busyText`, which the host derives from the live operation's stage,
    // start time, model, and optional detail. The webview must not recreate
    // the old plumbing-centric "no status is available" fallback.
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    try {
      provider.resolveWebviewView(fake.view);
      const html = fake.view.webview.html;
      assert.match(
        html,
        /bt\.textContent=s\.busyText\|\|'cannot determine what this task is doing';b\.style\.display='block';b\.title='';\}/,
        "the webview must render the host-derived informative busy text and reserve an explicit fallback for an unresolvable live operation"
      );
      assert.equal(
        html.includes("no status is available until this finishes"),
        false,
        "the obsolete plumbing-centric busy message must not remain in the webview"
      );
    } finally {
      provider.dispose();
    }
  });

  void it("renders legacy auto-starts in the collapsed Activity group and places posture after the transcript", () => {
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    try {
      provider.resolveWebviewView(fake.view);
      const html = fake.view.webview.html;
      assert.match(
        html,
        /item\.value\.kind==='activity'\|\|\(item\.value\.kind===undefined&&typeof item\.value\.text==='string'&&item\.value\.text\.trim\(\)\.startsWith\('_Auto-starting:'\)\)/,
        "legacy auto-start messages must share the collapsed Activity group with typed activity records"
      );
      assert.ok(
        html.indexOf('<div id="messages"') < html.indexOf('<div id="scheduling-posture"'),
        "the scheduling posture must be a footer after the transcript"
      );
    } finally {
      provider.dispose();
    }
  });

  void it("confirmInteraction acknowledges the submitted answer immediately, before a slow Resume completes", async () => {
    // Regression coverage for the review-flagged deferred-acknowledgement
    // defect: the "your answer was submitted" line used to be folded into
    // resumeInteraction's own message and so only appeared once the resume
    // round (potentially a long provider-backed run) had already finished.
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    let releaseResume: (() => void) | undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const services: ChatInteractionServicesV1 = {
      submitAnswers: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      cancel: (): Promise<ChatInteractionServiceResultV1> => Promise.resolve({ ok: true }),
      resume: async () => {
        await resumeGate; // held open by the test until explicitly released
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
          interactionId: "7".repeat(32),
          operationId: "8".repeat(32),
          actionKey: "generatePlan.v1",
          sourceAttemptId: "c".repeat(32),
          questions: QUESTIONS,
          binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "chat-document-id" },
        },
        true,
        false
      );

      const sendPromise = fake.send({
        type: "confirmInteraction",
        operationId: "8".repeat(32),
        interactionId: "7".repeat(32),
        answers: VALID_ANSWERS,
      });

      // Poll for the immediate submission acknowledgement while Resume is
      // still held open by resumeGate — proving it does not wait on it.
      await waitForState(fake, (s) => {
        const entries = (s.entries as Array<{ role: string; text: string }> | undefined) ?? [];
        return entries.some(
          (e) => e.role === "assistant" && /Recorded: your answer was submitted\. Resuming…/.test(e.text)
        );
      });
      let entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      assert.ok(
        !entries.some((e) => e.role === "assistant" && /^Resumed/.test(e.text)),
        "the resume-completion message must not appear before resume() has actually resolved"
      );

      releaseResume?.();
      await sendPromise;

      entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      assert.ok(
        entries.some((e) => e.role === "assistant" && /^Resumed — the action is continuing\./.test(e.text)),
        "expected the resume outcome to be acknowledged once resume() actually completes"
      );
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

/**
 * wf10 item 6d / step 7: "Apply N Reviewer-Verified Ticks" is posted from a
 * snapshot of plan-final.md and the review taken at post time. If the named
 * item(s) get ticked some other way before the user answers (a later round's
 * own echo, a hand edit, a differently-sourced reconcile), the stored record
 * still reads "pending" — `listPending`'s fresh store read (PART 4, above)
 * only re-checks `state`, not whether the underlying claim is still true.
 * `withdrawStaleDecisionsV1` (chatView.ts) re-derives applicability against
 * the CURRENT plan-final.md on every render and withdraws (item 13c: a
 * system-determined `state: "withdrawn"`, distinct from a user `dismiss`) a
 * decision whose target items are already ticked, rather than leaving a
 * stale, now-no-op control in the panel.
 */
void describe("Chat With AI — a pending 'applyReviewerVerifiedTicks' decision is re-checked against disk on render (wf10 item 6d)", () => {
  const REVIEW_WITH_VERIFIED_ITEM = [
    "Readiness: 9/10",
    "",
    "<!-- verified-complete:start -->",
    "- Wire the completeness gate",
    "<!-- verified-complete:end -->",
    "",
    "<!-- blockers:start -->",
    "<!-- blockers:end -->",
  ].join("\n");

  function applyTicksDecisionInput(folder: string): CreateWorkflowDecisionInputV1 {
    return decisionInput(folder, {
      decisionKey: "applyReviewerVerifiedTicks",
      stage: "impl-high-review",
      whatHappened:
        "impl-high-review.md named 1 plan item(s) as verified complete that are still unticked in plan-final.md.",
      options: [
        {
          optionId: "apply",
          label: "Apply 1 Reviewer-Verified Tick",
          consequence: "Ticks 1 item(s) in plan-final.md, sourced from impl-high-review.md:\n- Wire the completeness gate",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed",
            args: [{ taskFolderPath: folder, canonicalId: folder, reviewStage: "impl-high-review" }],
          },
        },
        {
          optionId: "skip",
          label: "Not yet",
          consequence: "Does nothing. The items stay unticked until you apply this or tick them yourself.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: "apply",
        reasoning: "The reviewer already verified this item against the tree.",
      },
    });
  }

  void it("stays pending when the named item is still unticked in plan-final.md", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      fs.writeFileSync(
        `${folder}/plan-final.md`,
        ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Wire the completeness gate", ""].join("\n")
      );
      fs.writeFileSync(`${folder}/impl-high-review.md`, REVIEW_WITH_VERIFIED_ITEM);
      const posted = await provider.workflowDecisionStore.post(applyTicksDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake);
      assert.ok(
        decisions.some((d) => d.decisionId === "decision-1"),
        "the decision must still render — its named item is genuinely still unticked"
      );
      assert.equal(
        provider.workflowDecisionStore.get("decision-1")?.state,
        "pending",
        "the store record must not be dismissed while the item is still unticked"
      );
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("is withdrawn on render once the named item is already ticked in plan-final.md", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      // Ticked from the start — simulates the item having been ticked by
      // some OTHER path (a later round's own echo, a hand edit, a
      // differently-sourced reconcile) after this decision was posted.
      fs.writeFileSync(
        `${folder}/plan-final.md`,
        ["<!-- ensemble:implementation-checklist -->", "", "- [x] Wire the completeness gate", ""].join("\n")
      );
      fs.writeFileSync(`${folder}/impl-high-review.md`, REVIEW_WITH_VERIFIED_ITEM);
      const posted = await provider.workflowDecisionStore.post(applyTicksDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake);
      assert.ok(
        !decisions.some((d) => d.decisionId === "decision-1"),
        "a decision whose target item is already ticked must not render as an actionable pending card"
      );
      const stored = provider.workflowDecisionStore.get("decision-1");
      assert.equal(
        stored?.state,
        "withdrawn",
        "the stale decision must be withdrawn in the store, not just hidden from this one render"
      );
      assert.ok(
        stored?.withdrawnReason && stored.withdrawnReason.length > 0,
        "a withdrawal must record why, distinct from a user dismiss which carries no reason"
      );
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("posts a 'Withdrawn: ...' transcript line, visible on the NEXT render", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      fs.writeFileSync(
        `${folder}/plan-final.md`,
        ["<!-- ensemble:implementation-checklist -->", "", "- [x] Wire the completeness gate", ""].join("\n")
      );
      fs.writeFileSync(`${folder}/impl-high-review.md`, REVIEW_WITH_VERIFIED_ITEM);
      const posted = await provider.workflowDecisionStore.post(applyTicksDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);
      // The withdrawal write happens inside the render pass above, after
      // `entries` for THAT pass was already captured — a second render picks
      // up the freshly-appended message, exactly like any other transcript
      // write that lands mid-render.
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForState(fake, (s) => {
        const entries = (s.entries as Array<{ role: string; text: string }> | undefined) ?? [];
        return entries.some((e) => e.role === "assistant" && e.text.startsWith("Withdrawn: "));
      });

      const entries = (lastState(fake)?.entries as Array<{ role: string; text: string }> | undefined) ?? [];
      assert.ok(
        entries.some((e) => e.role === "assistant" && e.text.startsWith("Withdrawn: ")),
        "expected a transcript line recording why the card was withdrawn"
      );
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

/** Writes a minimal, strictly-decodable task-progress.json for `folder`,
 * merging in `extra` on top of the same ownership-backed base
 * `writeOwnershipBackedTaskProgress` (taskFolderFixture.ts) writes — reused
 * here (rather than called directly) so a caller can also set `implRecovery`,
 * `pendingImplReviewFiles` or `checklistChangeProposals`, none of which that
 * shared helper's minimal shape carries. */
function writeTaskProgressWithExtra(folder: string, extra: Record<string, unknown>): void {
  const progress = {
    taskFolder: folder.replace(/\\/g, "/").split("/").pop(),
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    ownership: fixtureOwnershipFor(folder),
    ...extra,
  };
  fs.writeFileSync(`${folder}/task-progress.json`, JSON.stringify(progress, null, 2), "utf8");
}

/**
 * Part 11's transition-driven withdrawal for `restoreRejectedImplementationRound`:
 * a "Keep this round's changes" / "Revert this round's changes" card is only
 * defensible while there is still something restorable
 * (`implementationRecoveryV1.ts`'s `offerRestoreOption` doc comment). If
 * `implRecovery` has since been cleared or `pendingImplReviewFiles` is now
 * empty, the choice the card offers no longer applies to anything, and
 * `withdrawStaleDecisionsV1` (chatView.ts) re-checks this on every render.
 */
void describe("Chat With AI — a pending 'restoreRejectedImplementationRound' decision is re-checked against disk on render (Part 11)", () => {
  function restoreDecisionInput(folder: string): CreateWorkflowDecisionInputV1 {
    return decisionInput(folder, {
      decisionKey: "restoreRejectedImplementationRound",
      stage: "impl-high-review",
      options: [
        { optionId: "keep", label: "Keep this round's changes", consequence: "Does nothing.", effect: { kind: "doNothing" } },
        {
          optionId: "restore",
          label: "Revert this round's changes",
          consequence: "Restores the prior round's files.",
          effect: { kind: "command", command: "vs-code-ai-helper.restoreRejectedImplementationRound", args: ["a", "b"] },
        },
      ],
      recommendation: { kind: "option", optionId: "keep", reasoning: "The work is intact." },
    });
  }

  void it("stays pending while implRecovery and pendingImplReviewFiles still name something restorable", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      writeTaskProgressWithExtra(folder, {
        implRecovery: {
          sourceAttemptId: "attempt-1",
          reason: "test",
          trigger: "roundIncomplete",
          mode: "inspect-and-complete",
          dispatch: "pending",
          at: "2026-08-01T00:00:00.000Z",
        },
        pendingImplReviewFiles: ["src/example.ts"],
      });
      const posted = await provider.workflowDecisionStore.post(restoreDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);

      assert.ok(
        lastDecisions(fake).some((d) => d.decisionId === "decision-1"),
        "the decision must still render — there is genuinely something to restore"
      );
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.state, "pending");
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("is withdrawn once implRecovery is cleared and pendingImplReviewFiles is empty", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      // No implRecovery, no pendingImplReviewFiles — simulates the
      // continuation having already landed (or the round already reviewed)
      // after this decision was posted.
      writeTaskProgressWithExtra(folder, {});
      const posted = await provider.workflowDecisionStore.post(restoreDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);

      assert.ok(
        !lastDecisions(fake).some((d) => d.decisionId === "decision-1"),
        "a decision with nothing left to restore must not render as an actionable pending card"
      );
      const stored = provider.workflowDecisionStore.get("decision-1");
      assert.equal(stored?.state, "withdrawn");
      assert.ok(stored?.withdrawnReason && stored.withdrawnReason.length > 0);
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

/**
 * Part 11's transition-driven withdrawal for `checklistChangeProposed`: the
 * card is only answerable while its own proposal row is still `"pending"` —
 * once it has been discarded or adopted some other way, choosing an option on
 * a stale copy of the card would act on a proposal that no longer exists in
 * that state.
 */
void describe("Chat With AI — a pending 'checklistChangeProposed' decision is re-checked against disk on render (Part 11)", () => {
  function proposalDecisionInput(folder: string): CreateWorkflowDecisionInputV1 {
    return decisionInput(folder, {
      decisionKey: "checklistChangeProposed",
      stage: "impl",
      options: [
        {
          optionId: "revise",
          label: "Revise the plan",
          consequence: "Starts a plan revision.",
          effect: { kind: "command", command: "vs-code-ai-helper.reviseChecklistChangeProposalConfirmed", args: ["a"] },
        },
        {
          optionId: "discard",
          label: "Discard the proposal",
          consequence: "Leaves the plan untouched.",
          effect: { kind: "command", command: "vs-code-ai-helper.discardChecklistChangeProposalConfirmed", args: ["a"] },
        },
      ],
      recommendation: { kind: "option", optionId: "revise", reasoning: "New work was discovered." },
    });
  }

  void it("stays pending while its proposal row is still 'pending'", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      writeTaskProgressWithExtra(folder, {
        currentStage: "impl",
        checklistChangeProposals: [
          {
            at: "2026-08-01T00:00:00.000Z",
            roundId: "round-1",
            stage: "impl",
            kind: "added",
            proposedItems: ["- [ ] New step"],
            removedItems: [],
            status: "pending",
          },
        ],
      });
      const posted = await provider.workflowDecisionStore.post(proposalDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      assert.ok(
        lastDecisions(fake).some((d) => d.decisionId === "decision-1"),
        "the decision must still render — the proposal is genuinely still pending"
      );
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.state, "pending");
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("is withdrawn once its proposal row is no longer 'pending' (discarded)", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      writeTaskProgressWithExtra(folder, {
        currentStage: "impl",
        checklistChangeProposals: [
          {
            at: "2026-08-01T00:00:00.000Z",
            roundId: "round-1",
            stage: "impl",
            kind: "added",
            proposedItems: ["- [ ] New step"],
            removedItems: [],
            status: "discarded",
          },
        ],
      });
      const posted = await provider.workflowDecisionStore.post(proposalDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      assert.ok(
        !lastDecisions(fake).some((d) => d.decisionId === "decision-1"),
        "a decision whose proposal is already discarded must not render as an actionable pending card"
      );
      const stored = provider.workflowDecisionStore.get("decision-1");
      assert.equal(stored?.state, "withdrawn");
      assert.ok(stored?.withdrawnReason && stored.withdrawnReason.length > 0);
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

/**
 * Part 11's transition-driven withdrawal for `sterileRoundRouting` /
 * `preImplementationRouting`: both recommend "Go to Review & Apply" from a
 * snapshot of `decidePostReviewActionV1` taken when the round that posted
 * them finished. If a LATER review clears the task-fixable blockers (or the
 * checklist is completed, or a continuation becomes owed), the recommendation
 * no longer describes the current tree — `withdrawStaleDecisionsV1` re-runs
 * the same decision function fresh on every render rather than trusting the
 * card's own frozen claim.
 */
void describe("Chat With AI — a pending 'sterileRoundRouting' decision is re-checked against disk on render (Part 11)", () => {
  function sterileDecisionInput(folder: string): CreateWorkflowDecisionInputV1 {
    return decisionInput(folder, {
      decisionKey: "sterileRoundRouting",
      stage: "impl-high-review",
      options: [
        {
          optionId: "goToReviewAndApply",
          label: "Go to Review & Apply",
          consequence: "Moves the task to review and opens Apply Review.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.goToReviewAndApply",
            args: [{ taskFolderPath: folder, reviewStage: "impl-high-review" }],
          },
        },
        { optionId: "notNow", label: "Not now", consequence: "Does nothing.", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "option", optionId: "goToReviewAndApply", reasoning: "Only Apply Review can fix this." },
    });
  }

  void it("stays pending while the newest review still reports task-fixable blockers", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      writeTaskProgressWithExtra(folder, {
        currentStage: "impl-high-review",
        reviewScoreHistory: [
          {
            stage: "impl-high-review",
            score: 6,
            attemptId: "attempt-1",
            at: "2026-08-01T00:00:00.000Z",
            blockerCount: 2,
            taskFixableCount: 2,
          },
        ],
      });
      const posted = await provider.workflowDecisionStore.post(sterileDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);

      assert.ok(
        lastDecisions(fake).some((d) => d.decisionId === "decision-1"),
        "the recommendation is still correct — the newest review still carries the blockers it was posted about"
      );
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.state, "pending");
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("is withdrawn once a fresh review clears the task-fixable blockers it was posted about", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    const realFs = installRealFs();
    try {
      writeTaskProgressWithExtra(folder, {
        currentStage: "impl-high-review",
        reviewScoreHistory: [
          {
            stage: "impl-high-review",
            score: 6,
            attemptId: "attempt-1",
            at: "2026-08-01T00:00:00.000Z",
            blockerCount: 2,
            taskFixableCount: 2,
          },
          // A LATER round's review, landed after the decision was posted,
          // clearing every task-fixable blocker.
          {
            stage: "impl-high-review",
            score: 9,
            attemptId: "attempt-2",
            at: "2026-08-02T00:00:00.000Z",
            blockerCount: 0,
            taskFixableCount: 0,
          },
        ],
      });
      const posted = await provider.workflowDecisionStore.post(sterileDecisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
      await waitForStateMessage(fake);

      assert.ok(
        !lastDecisions(fake).some((d) => d.decisionId === "decision-1"),
        "a fresh review clearing the blockers must withdraw the now-stale recommendation"
      );
      const stored = provider.workflowDecisionStore.get("decision-1");
      assert.equal(stored?.state, "withdrawn");
      assert.ok(stored?.withdrawnReason && stored.withdrawnReason.length > 0);
    } finally {
      realFs.restore();
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
