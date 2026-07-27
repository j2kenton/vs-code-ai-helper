import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  checkImplementationAvailability,
  runImplementationWithCopilot,
} from "../runners/copilotImplementationRunner";

/**
 * Proves plan §1.6's host-capability gate actually runs before any model
 * selection or file read: on a host missing a tool-calling runtime
 * constructor, both entry points must fail closed with a readable reason
 * without ever calling `vscode.lm.selectChatModels` — the old behavior would
 * have called it first and only failed later, deeper in the round loop, with
 * a raw "X is not a constructor" error.
 */
void describe("copilotImplementationRunner host capability gate", () => {
  void it("runImplementationWithCopilot fails closed without selecting a model when tool-calling is unsupported", async () => {
    // Must mutate the raw `require("vscode")` module, not the `import *`
    // binding — TS's ESM interop exposes non-configurable getters over it,
    // but those getters read the raw module live (see vscodeLmCompat.test.ts).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawVscode = require("vscode") as Record<string, unknown>;
    const original = rawVscode.LanguageModelToolCallPart;
    delete rawVscode.LanguageModelToolCallPart;

    const lm = (vscode as unknown as { lm: { selectChatModels: () => Promise<unknown[]> } }).lm;
    const originalSelectChatModels = lm.selectChatModels;
    let selectChatModelsCalled = false;
    lm.selectChatModels = () => {
      selectChatModelsCalled = true;
      return Promise.resolve([]);
    };

    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const result = await runImplementationWithCopilot({
        prompt: "Implement the plan.",
        workspaceUri: vscode.Uri.file("/fake-workspace"),
        token: tokenSource.token,
        onProgress: () => undefined,
      });

      assert.equal(selectChatModelsCalled, false);
      assert.equal(result.status, "failed");
      assert.equal(result.failureKind, "temporarily-unavailable");
      assert.match(result.errorMessage ?? "", /LanguageModelToolCallPart/);
    } finally {
      rawVscode.LanguageModelToolCallPart = original;
      lm.selectChatModels = originalSelectChatModels;
    }
  });

  void it("checkImplementationAvailability fails closed without selecting a model when tool-calling is unsupported", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawVscode = require("vscode") as Record<string, unknown>;
    const original = rawVscode.LanguageModelTextPart;
    delete rawVscode.LanguageModelTextPart;

    const lm = (vscode as unknown as { lm: { selectChatModels: () => Promise<unknown[]> } }).lm;
    const originalSelectChatModels = lm.selectChatModels;
    let selectChatModelsCalled = false;
    lm.selectChatModels = () => {
      selectChatModelsCalled = true;
      return Promise.resolve([]);
    };

    try {
      const availability = await checkImplementationAvailability();
      assert.equal(selectChatModelsCalled, false);
      assert.equal(availability.available, false);
      assert.match(availability.reason ?? "", /LanguageModelTextPart/);
    } finally {
      rawVscode.LanguageModelTextPart = original;
      lm.selectChatModels = originalSelectChatModels;
    }
  });

  void it("runImplementationWithCopilot proceeds to model selection when the host is fully capable", async () => {
    const lm = (vscode as unknown as { lm: { selectChatModels: () => Promise<unknown[]> } }).lm;
    const originalSelectChatModels = lm.selectChatModels;
    let selectChatModelsCalled = false;
    lm.selectChatModels = () => {
      selectChatModelsCalled = true;
      return Promise.resolve([]);
    };

    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const result = await runImplementationWithCopilot({
        prompt: "Implement the plan.",
        workspaceUri: vscode.Uri.file("/fake-workspace"),
        token: tokenSource.token,
        onProgress: () => undefined,
      });

      assert.equal(selectChatModelsCalled, true);
      assert.equal(result.status, "failed");
      assert.match(result.errorMessage ?? "", /No Copilot language models are available/);
    } finally {
      lm.selectChatModels = originalSelectChatModels;
    }
  });
});
