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
 *  - When genuinely busy, an explicit "no status is available until this
 *    finishes" statement renders in place of a bare implied wait whenever no
 *    live operation has reported an incremental detail (`busyDetail`); a
 *    live operation that HAS called `report(...)` (e.g. a review loop's
 *    "iteration 2/3") surfaces that text instead.
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
  notifyPendingWorkflowDecision,
} from "../views/chatView";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { makeOwnedTaskFolder, bindingIdForOwnedFolder } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";
import { readChatDocumentIdentityV1, readChatHistory, writeChatHistory } from "../utils/chatHistoryStore";
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
   * to "Let Implementation Run" (a `doNothing` no-op) — both choices must be
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
              label: "Let Implementation Run",
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
              label: "Let Implementation Run",
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
      const ack = entries.find((e) => e.text.includes("Let Implementation Run"));
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

      let entries = (lastState(fake)?.entries as Array<{ role: string; awaitingAnswer?: boolean }> | undefined) ?? [];
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.awaitingAnswer, true, "an unanswered question must render as awaiting");

      await provider.append("user", "Use approach B.", "impl", target);

      entries = (lastState(fake)?.entries as Array<{ role: string; awaitingAnswer?: boolean }> | undefined) ?? [];
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

      op = taskOperations.begin(folder, { label: "Doing work" });
      assert.ok(op, "expected the exclusive operation lock to be acquired");
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

  void it("a stacked second pending question settles only the nearest reply, not the older unanswered one too", async () => {
    // Regression coverage for the review-flagged correlation defect:
    // settling every earlier pending question off a single later reply had
    // no correlation to which question the reply actually addressed. `ask()`
    // has no lock preventing a second question from stacking before the
    // first is answered, so this is a real, reachable state.
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
      await provider.append("user", "answering the second one", "impl", target);

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
        (lastState(fake)?.entries as Array<{ role: string; text: string; awaitingAnswer?: boolean }> | undefined) ??
        [];
      const askedEntry = questionEntries.find((e) => e.text.includes("Which way?"));
      assert.ok(askedEntry, "the question's content must still exist in the rendered transcript");
      assert.equal(askedEntry.awaitingAnswer, true, "the content must still show as awaiting an answer");
      assert.equal(
        (fake.view as unknown as { badge?: unknown }).badge,
        undefined,
        "a persisted-only pending question must not light the view badge either"
      );
      await provider.append("user", "This way.", "impl", target);
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
      await waitForState(fake, (s) => s.interaction !== undefined);
      assert.equal(
        lastState(fake)?.waitingForUser,
        false,
        "a persisted-only structured interaction must not assert the waiting posture"
      );
      assert.equal(lastState(fake)?.waitingForUserSource, undefined);
      const renderedInteraction = lastState(fake)?.interaction as { interactionId?: string } | undefined;
      assert.equal(
        renderedInteraction?.interactionId,
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
      await waitForState(fake, (s) => s.interaction !== undefined);

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

  void it("busyDetail renders the live operation's reported detail, or an explicit no-status statement when none was reported", async () => {
    // Part 4.3: "Where a transport genuinely reports nothing until it
    // finishes, render that statement explicitly (contract rule: explicit
    // unknown, not implied wait)." Most busy operations never call
    // `report(...)`, so a bare "Waiting for the AI…" cannot be told apart
    // from a genuinely narrated wait — `busyDetail` is the field that closes
    // that gap.
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
      op = taskOperations.begin(folder, { label: "Doing work" });
      assert.ok(op, "expected the exclusive operation lock to be acquired");
      await waitForState(fake, (s) => s.busy === true);
      assert.equal(
        lastState(fake)?.busyDetail,
        undefined,
        "an operation that never called report(...) must not synthesize a detail"
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

  void it("the webview's busy-status renderer actually renders the busyDetail fallback and detail text (not just the posted state field)", () => {
    // The lifecycle test above ("busyDetail renders...") only proves the
    // `busyDetail` field on the posted "state" message is computed
    // correctly. It never inspects the webview's rendering script, so it
    // would keep passing even if the busy-text branch in `chatView.ts`'s
    // `html()` (around the `bt.textContent=` assignment) regressed to a bare
    // "Waiting for the AI…" spinner that ignores `busyDetail` entirely — the
    // exact review-flagged gap. This asserts the STRUCTURE of the real
    // `bt.textContent=...` assignment pulled out of the actual generated
    // webview HTML (not a hand-duplicated copy of it): a ternary keyed on
    // `s.busyDetail`, whose false-branch is the exact required no-status
    // literal and whose true-branch concatenates `s.busyDetail` between the
    // expected prefix/suffix. A regression to a bare spinner (no ternary), a
    // swapped/merged branch, or wording drift on either branch fails to
    // match and fails this test. (No `Function`/`eval` — this file's own
    // lint config forbids implied eval — so the extracted text is verified
    // structurally rather than executed.)
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    try {
      provider.resolveWebviewView(fake.view);
      const html = fake.view.webview.html;
      const match = html.match(
        /bt\.textContent=s\.busyDetail\?\('([^']*)'\+s\.busyDetail\+'([^']*)'\):'([^']*)';b\.style\.display='block';b\.title='';\}/
      );
      assert.ok(
        match,
        "expected the busy-status assignment to be a ternary on s.busyDetail with a concatenated true-branch and a literal false-branch"
      );
      const [, detailPrefix, detailSuffix, noDetailText] = match;

      assert.equal(
        noDetailText,
        "Waiting for the AI… — no status is available until this finishes",
        "a busy operation with no reported detail must render the explicit no-status statement, not an implied wait"
      );
      assert.equal(`${detailPrefix}iteration 2/3${detailSuffix}`, "Waiting for the AI… (iteration 2/3)", "a busy operation's reported detail must render verbatim");
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
 * `withdrawStaleApplyReviewerVerifiedTicksDecisionsV1` (chatView.ts) re-derives
 * applicability against the CURRENT plan-final.md on every render and
 * withdraws (dismisses) a decision whose target items are already ticked,
 * rather than leaving a stale, now-no-op control in the panel.
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

  void it("is withdrawn (dismissed) on render once the named item is already ticked in plan-final.md", async () => {
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
      assert.equal(
        provider.workflowDecisionStore.get("decision-1")?.state,
        "dismissed",
        "the stale decision must be withdrawn in the store, not just hidden from this one render"
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
