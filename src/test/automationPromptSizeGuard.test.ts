/**
 * The large-prompt confirmation never opens a modal under automation
 * (RC1 item 3): it declines, says so, and leaves human-driven calls asking.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { runAsAutomationDispatchV1 } from "../state/automationDispatchContextV1";
import { CONTEXT_CONFIRM_THRESHOLD_BYTES } from "../utils/contextEligibility";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";

void describe("prompt-size confirmation under automation", () => {
  const bigPrompt = "x".repeat(CONTEXT_CONFIRM_THRESHOLD_BYTES + 1000);

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
      return Promise.resolve("Proceed");
    }) as unknown as typeof vscode.window.showWarningMessage;
    try {
      const result = await runAsAutomationDispatchV1(() => checkAndConfirmPromptSize(bigPrompt, "Claude"));
      assert.equal(result, "declined");
      assert.equal(modalCalls, 0, "no dialog may open when nobody can answer it");
      assert.ok(notices.some((n) => /automated round did not send/.test(n)), "the refusal is visible");

      const attended = await checkAndConfirmPromptSize(bigPrompt, "Claude");
      assert.equal(attended, "confirmed", "a human-driven call still asks");
      assert.equal(modalCalls, 1);
    } finally {
      vscode.window.showWarningMessage = original;
      deactivateNotificationRouter();
    }
  });
});
