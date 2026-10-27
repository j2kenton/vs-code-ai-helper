/**
 * The large-prompt confirmation never opens a modal under automation
 * (RC1 item 3): it declines, says so, and leaves human-driven calls asking.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { runAsAutomationDispatchV1 } from "../state/automationDispatchContextV1";
import { CONTEXT_CONFIRM_THRESHOLD_BYTES, PROMPT_TOTAL_MAX_BYTES } from "../utils/contextEligibility";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-prompt-size-chat-"));
after(() => safeRemoveDir(ROOT));

async function withFsBridge<T>(run: () => Promise<T>): Promise<T> {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buffer) => new Uint8Array(buffer));
  try { return await run(); } finally { target.readFile = original; }
}

void describe("prompt-size confirmation under automation", () => {
  const bigPrompt = "x".repeat(CONTEXT_CONFIRM_THRESHOLD_BYTES + 1000);

  void it("declines with a visible notice and opens no modal", async () => {
    const notices: string[] = [];
    initNotificationRouter({
      addEntry: (message: string) => {
        notices.push(message);
      },
    });
    const values = new Map<string, unknown>();
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
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const original = vscode.window.showWarningMessage;
    let modalCalls = 0;
    vscode.window.showWarningMessage = ((..._args: unknown[]) => {
      modalCalls += 1;
      return Promise.resolve("Proceed");
    }) as unknown as typeof vscode.window.showWarningMessage;
    try {
      const result = await runAsAutomationDispatchV1(() => checkAndConfirmPromptSize(bigPrompt, "Claude"));
      assert.equal(result, "declined");
      assert.equal(modalCalls, 0, "no dialog may open when nobody can answer it");
      assert.ok(notices.some((n) => /automated round did not send/.test(n)), "the refusal is visible");

      const attendedPromise = checkAndConfirmPromptSize(bigPrompt, "Claude");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const store = new WorkflowDecisionStoreV1(memento);
      const pending = store.listPending().find((d) => d.decisionKey === "confirmLargePromptSize");
      assert.ok(pending, "human-driven large prompt confirmation must post to global chat");
      await store.resolve(pending.decisionId, "proceed");
      const attended = await attendedPromise;
      assert.equal(attended, "confirmed", "a human-driven call still asks in chat");
      assert.equal(modalCalls, 0, "attended prompt-size confirmation uses chat rather than a modal");
    } finally {
      vscode.window.showWarningMessage = original;
      __extensionContextV1TestOnly.reset();
      deactivateNotificationRouter();
    }
  });

  void it("posts the settings remedy in task chat when automation declines a large prompt", async () => {
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
    const values = new Map<string, unknown>();
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
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    try {
      const result = await withFsBridge(() => runAsAutomationDispatchV1(() => checkAndConfirmPromptSize(
        bigPrompt,
        "Claude",
        0,
        { folderPath: taskFolderPath }
      )));
      assert.equal(result, "declined");
      await withFsBridge(() => runAsAutomationDispatchV1(() => checkAndConfirmPromptSize(
        bigPrompt,
        "Claude",
        0,
        { folderPath: taskFolderPath }
      )));
      const decisions = new WorkflowDecisionStoreV1(memento).listPending(taskFolderPath).filter((item) =>
        item.decisionKey === "chatActionOffer:openSettings"
      );
      assert.equal(decisions.length, 1, "repeated hand-backs update one stable decision");
      const decision = decisions[0];
      assert.ok(decision, "the stop and remedy are posted in task chat");
      assert.match(decision.whatHappened, /large prompts need a confirmation/);
      assert.deepEqual(decision.options.map((item) => item.label), [
        "Open Ensemble Settings", "Open task.md to shorten the prompt", "Not now",
      ]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.equal(decision.options.find((item) => item.optionId === "runAction")?.label, "Open Ensemble Settings");
      assert.deepEqual(decision.options.find((item) => item.optionId === "runAction")?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.openSettings",
        args: [],
      });
      assert.deepEqual(decision.options[1]?.effect, {
        kind: "command",
        command: "vscode.open",
        args: [vscode.Uri.file(path.join(taskFolderPath, "task.md"))],
      });
    } finally {
      __extensionContextV1TestOnly.reset();
      deactivateNotificationRouter();
    }
  });

  void it("posts a task-chat next action when automation hits the hard prompt ceiling", async () => {
    initNotificationRouter({ addEntry: () => undefined });
    const taskFolderPath = path.join(ROOT, "hard-ceiling-task");
    fs.mkdirSync(taskFolderPath, { recursive: true });
    fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify({
      taskFolder: path.basename(taskFolderPath),
      currentStage: "impl",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: fixtureOwnershipFor(taskFolderPath),
    }), "utf8");
    const values = new Map<string, unknown>();
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
    __extensionContextV1TestOnly.set({
      subscriptions: [], extensionUri: vscode.Uri.file(ROOT), workspaceState: memento, globalState: memento,
    } as unknown as vscode.ExtensionContext);
    try {
      const result = await withFsBridge(() => runAsAutomationDispatchV1(() => checkAndConfirmPromptSize(
        "x".repeat(PROMPT_TOTAL_MAX_BYTES + 1), "Codex", 0, { folderPath: taskFolderPath }
      )));
      assert.equal(result, "abort", "the hard limit remains in force");
      await withFsBridge(() => runAsAutomationDispatchV1(() => checkAndConfirmPromptSize(
        "x".repeat(PROMPT_TOTAL_MAX_BYTES + 1), "Codex", 0, { folderPath: taskFolderPath }
      )));
      const decisions = new WorkflowDecisionStoreV1(memento).listPending(taskFolderPath).filter((item) =>
        item.decisionKey === "chatActionOffer:vscode.open"
      );
      assert.equal(decisions.length, 1, "repeated hand-backs update one stable decision");
      const decision = decisions[0];
      assert.ok(decision, "automation explains the hard stop and offers a useful next action");
      assert.match(decision.whatHappened, /hard limit/);
      assert.match(decision.whatHappened, /close large editors/);
      assert.deepEqual(decision.options.map((item) => item.label), [
        "Open task.md to shorten the prompt", "Close all editors", "Not now",
      ]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.equal(decision.options.find((item) => item.optionId === "runAction")?.label, "Open task.md to shorten the prompt");
      assert.deepEqual(decision.options.find((item) => item.optionId === "runAction")?.effect, {
        kind: "command",
        command: "vscode.open",
        args: [vscode.Uri.file(path.join(taskFolderPath, "task.md"))],
      });
      assert.deepEqual(decision.options[1]?.effect, {
        kind: "command",
        command: "workbench.action.closeAllEditors",
        args: [],
      });
    } finally {
      __extensionContextV1TestOnly.reset();
      deactivateNotificationRouter();
    }
  });
});
