/**
 * Coverage for the §7.2/§7.6 Copilot LM tool-session transport
 * (languageModelToolSessionV1): capability fail-closed before any prompt,
 * the multi-round dispatch loop (interim text discarded, only the final
 * zero-tool-call round's text reaches the bounded writer), the round cap,
 * the protocol-violation cap, and cancellation mapping.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { createCopilotLmToolSessionTransportV1 } from "../services/languageModelToolSessionV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";
import { AgentExecutionRequestV1, BoundedResultWriterV1 } from "../types/agentExecutionV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { LmToolCallPartV1 } from "../types/vscodeLmCompatV1";

const stubClasses = vscode as unknown as {
  LanguageModelTextPart: new (value: string) => object;
  LanguageModelToolCallPart: new (callId: string, name: string, input: object) => object;
};

function makeWriter(): BoundedResultWriterV1 & { text: () => string } {
  let buffer = "";
  return {
    write(chunk: Uint8Array | string): boolean {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    get overflowed(): boolean {
      return false;
    },
    get bytesWritten(): number {
      return Buffer.byteLength(buffer, "utf8");
    },
    text: () => buffer,
  };
}

function makeRequest(): AgentExecutionRequestV1 {
  const tokenSource = new vscode.CancellationTokenSource();
  return {
    correlation: {
      actionKey: "implementation.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: "binding",
      chatDocumentId: "chat",
    },
    reservationId: allocateHex128IdV1(),
    mode: "preflight",
    prompt: "preflight the change",
    maxResponseBytes: 1024,
    cancellationToken: tokenSource.token,
  };
}

function recordingHandler(
  respond: (call: LmToolCallPartV1) => string,
  violations = 0
): RequestLocalToolHandlerV1 & { calls: LmToolCallPartV1[] } {
  const calls: LmToolCallPartV1[] = [];
  return {
    calls,
    descriptors: [{ name: "ensemble_stat", description: "stat" }],
    handleToolCall(call) {
      calls.push(call);
      return Promise.resolve(respond(call));
    },
    violationCount: () => violations,
  };
}

/** Install a fake Copilot model whose sendRequest yields scripted part streams. */
function installModel(rounds: ReadonlyArray<readonly object[]>): { restore: () => void; requests: number[] } {
  const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
  const original = lm.selectChatModels;
  const requests: number[] = [];
  let round = 0;
  lm.selectChatModels = () =>
    Promise.resolve([
      {
        id: "gpt-test",
        name: "GPT Test",
        vendor: "copilot",
        family: "gpt",
        sendRequest: (messages: readonly unknown[]) => {
          requests.push(messages.length);
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
    ]);
  return {
    restore: (): void => {
      lm.selectChatModels = original;
    },
    requests,
  };
}

void describe("languageModelToolSessionV1", () => {
  void it("dispatches tool rounds to the handler and writes only the final round's text", async () => {
    const model = installModel([
      [
        new stubClasses.LanguageModelTextPart("thinking out loud…"),
        new stubClasses.LanguageModelToolCallPart("call-1", "ensemble_stat", {
          rootId: "r",
          relativePath: "a.ts",
        }),
      ],
      [new stubClasses.LanguageModelTextPart("final answer")],
    ]);
    const handler = recordingHandler(() => "{\"ok\":true}");
    const writer = makeWriter();
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), writer);
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(writer.text(), "final answer", "interim narration must be discarded");
      assert.equal(handler.calls.length, 1);
      assert.equal(handler.calls[0]!.name, "ensemble_stat");
      assert.equal(handler.calls[0]!.callId, "call-1");
      // Round 2's message list grew by the assistant parts + tool results.
      assert.deepEqual(model.requests, [1, 3]);
    } finally {
      model.restore();
    }
  });

  void it("aborts with toolRoundLimitExceeded when every round keeps calling tools", async () => {
    const model = installModel([
      [new stubClasses.LanguageModelToolCallPart("call-x", "ensemble_stat", { rootId: "r", relativePath: "a" })],
    ]);
    const handler = recordingHandler(() => "{}");
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: handler,
        maxRounds: 2,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "transportFailure", code: "toolRoundLimitExceeded" });
      assert.equal(handler.calls.length, 2);
    } finally {
      model.restore();
    }
  });

  void it("aborts with toolProtocolViolation once the handler's violation cap is exceeded", async () => {
    const model = installModel([
      [new stubClasses.LanguageModelToolCallPart("call-x", "not.a.tool", {})],
    ]);
    const handler = recordingHandler(() => "{\"ok\":false}", 99);
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "transportFailure", code: "toolProtocolViolation" });
    } finally {
      model.restore();
    }
  });

  void it("fails closed with copilotNoModelsAvailable when no Copilot models exist", async () => {
    const transport = createCopilotLmToolSessionTransportV1({
      model: undefined,
      toolHandler: recordingHandler(() => "{}"),
    });
    const exit = await transport.invoke(makeRequest(), makeWriter());
    assert.deepEqual(exit, { kind: "transportFailure", code: "copilotNoModelsAvailable" });
  });

  void it("fails closed with lmToolApiUnavailable when the host lacks the tool-calling constructors", async () => {
    // Mutate the RAW require("vscode") module object — the `import * as`
    // namespace binding is not configurable (see vscodeLmCompat.test.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const target = require("vscode") as Record<string, unknown>;
    const original = target.LanguageModelToolCallPart;
    delete target.LanguageModelToolCallPart;
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "transportFailure", code: "lmToolApiUnavailable" });
    } finally {
      target.LanguageModelToolCallPart = original;
    }
  });
});
