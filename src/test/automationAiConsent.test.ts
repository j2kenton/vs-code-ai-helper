/**
 * The first-use AI consent prompt never opens a modal under automation
 * (RC1 item 3): with no consent recorded it declines and says so, and it
 * leaves human-driven calls asking.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { runAsAutomationDispatchV1 } from "../state/automationDispatchContextV1";
import { ensureAiConsent } from "../utils/aiConsent";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

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
    let modalCalls = 0;
    vscode.window.showWarningMessage = ((..._args: unknown[]) => {
      modalCalls += 1;
      return Promise.resolve(undefined);
    }) as unknown as typeof vscode.window.showWarningMessage;
    try {
      const result = await runAsAutomationDispatchV1(() => ensureAiConsent(emptyContext));
      assert.equal(result, false);
      assert.equal(modalCalls, 0, "no dialog may open when nobody can answer it");
      assert.ok(notices.some((n) => /AI consent has not been given/.test(n)), "the refusal is visible");

      const attended = await ensureAiConsent(emptyContext);
      assert.equal(attended, false, "dismissing the dialog still declines");
      assert.equal(modalCalls, 1, "a human-driven call still asks");
    } finally {
      vscode.window.showWarningMessage = original;
      deactivateNotificationRouter();
    }
  });
});
