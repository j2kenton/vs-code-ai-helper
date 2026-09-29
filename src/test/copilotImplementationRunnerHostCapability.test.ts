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

  void it("every User message across a full tool-call round trip carries non-empty text (RC2 item 14, Step 10)", async () => {
    // This runner's tool loop (runImplementationRounds) builds its own User
    // messages independently of languageModelToolSessionV1's — the shared
    // fix (createLmUserMessageWithPartsV1) covers the tool-results message at
    // its one call site here, but this is the end-to-end proof for THIS
    // loop: Copilot's `auto` router fails outright if the LAST User message
    // it sees has no non-empty text part.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawVscode = require("vscode") as {
      LanguageModelToolCallPart: new (callId: string, name: string, input: object) => object;
      LanguageModelTextPart: new (value: string) => object;
    };
    const lm = (vscode as unknown as { lm: { selectChatModels: () => Promise<unknown[]> } }).lm;
    const originalSelectChatModels = lm.selectChatModels;
    const sent: Array<Array<{ role: string; content: unknown }>> = [];
    let round = 0;
    const rounds: readonly (readonly object[])[] = [
      [new rawVscode.LanguageModelToolCallPart("call-1", "read_file", { path: "missing.txt" })],
      [new rawVscode.LanguageModelTextPart("Done implementing.")],
    ];
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          sendRequest: (messages: ReadonlyArray<{ role: string; content: unknown }>) => {
            sent.push([...messages]);
            const parts = rounds[Math.min(round, rounds.length - 1)]!;
            round += 1;
            return Promise.resolve({
              stream: (function* (): Generator<object> {
                for (const part of parts) {
                  yield part;
                }
              })(),
            });
          },
        },
      ] as unknown[]);

    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const result = await runImplementationWithCopilot({
        prompt: "Implement the plan.",
        modelId: "gpt-test",
        // safeResolve realpath-checks the workspace root, so this must be a
        // real, existing directory — the read_file call below targets a
        // nonexistent file under it, which is safe (returns an error string,
        // touches nothing).
        workspaceUri: vscode.Uri.file(process.cwd()),
        token: tokenSource.token,
        onProgress: () => undefined,
      });

      assert.equal(result.status, "completed");
      assert.ok(sent.length >= 2, `expected at least 2 requests, got ${sent.length}`);

      const textOf = (message: { role: string; content: unknown }): string | undefined => {
        if (typeof message.content === "string") {
          return message.content;
        }
        if (!Array.isArray(message.content)) {
          return undefined;
        }
        const textPart = (message.content as Array<{ value?: unknown }>).find(
          (part) => typeof part.value === "string"
        );
        return textPart?.value as string | undefined;
      };

      for (const request of sent) {
        for (const message of request) {
          if (message.role !== "user") {
            continue;
          }
          const text = textOf(message);
          assert.ok(
            typeof text === "string" && text.length > 0,
            `every User message must carry non-empty text, got: ${JSON.stringify(message)}`
          );
        }
      }
    } finally {
      lm.selectChatModels = originalSelectChatModels;
    }
  });
});
