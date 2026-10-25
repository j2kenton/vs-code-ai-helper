/**
 * The first-use AI consent prompt never opens a modal under automation
 * (RC1 item 3): with no consent recorded it declines and says so, and it
 * leaves human-driven calls asking.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { runAsAutomationDispatchV1 } from "../state/automationDispatchContextV1";
import { ensureAiConsent } from "../utils/aiConsent";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ai-consent-chat-"));
after(() => safeRemoveDir(ROOT));

async function withFsBridge<T>(run: () => Promise<T>): Promise<T> {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buffer) => new Uint8Array(buffer));
  try { return await run(); } finally { target.readFile = original; }
}

void describe("AI consent under automation", () => {
  const emptyContext = {
    workspaceState: {
      get: () => undefined,
      update: () => Promise.resolve(),
    },
  } as unknown as vscode.ExtensionContext;

  void it("declines with a visible notice and opens no modal", async () => {
    const notices: string[] = [];
    initNotificationRouter({
      addEntry: (message: string) => {
        notices.push(message);
      },
    });
    const original = vscode.window.showWarningMessage;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chatChoiceModule = require("../utils/chatChoiceV1") as {
      askChatChoiceV1: (input: { decisionKey: string }) => Promise<string | undefined>;
    };
    const originalAskChoice = chatChoiceModule.askChatChoiceV1;
    let modalCalls = 0;
    let chatChoiceCalls = 0;
    vscode.window.showWarningMessage = ((..._args: unknown[]) => {
      modalCalls += 1;
      return Promise.resolve(undefined);
    }) as unknown as typeof vscode.window.showWarningMessage;
    chatChoiceModule.askChatChoiceV1 = () => {
      chatChoiceCalls += 1;
      return Promise.resolve(undefined);
    };
    try {
      const result = await runAsAutomationDispatchV1(() => ensureAiConsent(emptyContext));
      assert.equal(result, false);
      assert.equal(modalCalls, 0, "no dialog may open when nobody can answer it");
      assert.equal(chatChoiceCalls, 0, "automation declines before prompting for first-use consent");
      assert.ok(notices.some((n) => /AI consent has not been given/.test(n)), "the refusal is visible");

      const attended = await ensureAiConsent(emptyContext);
      assert.equal(attended, false, "dismissing the chat decision still declines");
      assert.equal(modalCalls, 0, "first-use consent asks in global chat, never a modal");
      assert.equal(chatChoiceCalls, 1, "a human-driven call asks in global chat");
    } finally {
      chatChoiceModule.askChatChoiceV1 = originalAskChoice;
      vscode.window.showWarningMessage = original;
      deactivateNotificationRouter();
    }
  });

  void it("posts an actionable task-chat hand-back when automation has no consent", async () => {
    initNotificationRouter({ addEntry: () => undefined });
    const taskFolderPath = path.join(ROOT, "2026-10-22_task_1");
    fs.mkdirSync(taskFolderPath, { recursive: true });
    fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify({
      taskFolder: path.basename(taskFolderPath),
      currentStage: "impl",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: fixtureOwnershipFor(taskFolderPath),
    }), "utf8");
    const values = new Map<string, unknown>([["vs-code-ai-helper.currentTaskCanonicalId", taskFolderPath]]);
    const memento = {
      keys: () => [...values.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined => values.has(key) ? values.get(key) as T : defaultValue,
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
        return Promise.resolve();
      },
    } as vscode.Memento;
    const context = { ...emptyContext, workspaceState: memento } as vscode.ExtensionContext;
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    try {
      assert.equal(await withFsBridge(() => runAsAutomationDispatchV1(() => ensureAiConsent(context))), false);
      const decision = new WorkflowDecisionStoreV1(memento).listPending().find((item) =>
        item.decisionKey === "chatActionOffer:applyCurrentStageAction"
      );
      assert.ok(decision, "the stop is explained in task chat");
      assert.match(decision.whatHappened, /AI consent has not been given/);
      assert.equal(decision.options.find((item) => item.optionId === "runAction")?.label, "Apply Current Stage Action");
      assert.deepEqual(decision.options.find((item) => item.optionId === "runAction")?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.applyCurrentStageAction",
        args: [{ taskFolderPath }],
      });
    } finally {
      __extensionContextV1TestOnly.reset();
      deactivateNotificationRouter();
    }
  });
});
