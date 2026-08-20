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
import {
  createCopilotLmToolSessionTransportV1,
  setLmToolSessionRequestIssuedObserverV1,
} from "../services/languageModelToolSessionV1";
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
  /** A minimal response that carries the required result frame. */
  const FRAMED_FINAL_ANSWER = "<<<ENSEMBLE_AI_RESULT_V1>>>\n{}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>";

  void it("sends a frameless tool-free reply back for the real answer instead of accepting it", async () => {
    // 2026-08-18, jester review: after reading the files the model wrote a
    // paragraph of findings ending "Now I'll write the re-review frame." — and
    // the session closed, recording that narration as the review. It was then
    // rejected for having no `Readiness: N/10` line, discarding a round that
    // had correctly verified the work.
    const model = installModel([
      [new stubClasses.LanguageModelTextPart("I verified both tests. Now I'll write the frame.")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ]);
    const handler = recordingHandler(() => "{}");
    const writer = makeWriter();
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), writer);
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(writer.text(), FRAMED_FINAL_ANSWER, "the narration must not be recorded as the answer");
      // Two model turns: the narration, then the nudged reply.
      assert.equal(model.requests.length, 2);
    } finally {
      model.restore();
    }
  });

  void it("accepts a frameless reply once the nudge budget is spent rather than looping", async () => {
    // The nudge must be bounded: a model that cannot produce the frame at all
    // should not burn the whole round budget being asked repeatedly.
    const model = installModel([[new stubClasses.LanguageModelTextPart("no frame, ever")]]);
    const handler = recordingHandler(() => "{}");
    const writer = makeWriter();
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), writer);
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(writer.text(), "no frame, ever");
      // One narration + the bounded nudges, not the full round cap.
      assert.ok(model.requests.length <= 3, `expected a bounded nudge, got ${model.requests.length} turns`);
    } finally {
      model.restore();
    }
  });

  void it("dispatches tool rounds to the handler and writes only the final round's text", async () => {
    const model = installModel([
      [
        new stubClasses.LanguageModelTextPart("thinking out loud…"),
        new stubClasses.LanguageModelToolCallPart("call-1", "ensemble_stat", {
          rootId: "r",
          relativePath: "a.ts",
        }),
      ],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ]);
    const handler = recordingHandler(() => "{\"ok\":true}");
    const writer = makeWriter();
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), writer);
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(writer.text(), FRAMED_FINAL_ANSWER, "interim narration must be discarded");
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

  void it("stops the session once cumulative tool-result bytes exceed the budget", async () => {
    // Each round re-sends the whole history, so accumulated tool results are
    // paid for again every round — the cost curve is quadratic, not linear.
    // Without a budget a session can bill for a very large amount of resent
    // context and still produce nothing (2026-08-17).
    const model = installModel([
      [new stubClasses.LanguageModelToolCallPart("call-x", "ensemble_readFile", { rootId: "r", relativePath: "a" })],
    ]);
    const handler = recordingHandler(() => "x".repeat(400));
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: handler,
        // Well above the round cap, so the BUDGET is what stops this and the
        // round limit cannot be mistaken for the cause.
        maxRounds: 50,
        maxResultBytes: 1000,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind, "transportFailure");
      assert.equal(
        exit.kind === "transportFailure" && exit.code,
        "toolSessionResultBudgetExceeded"
      );
      // The detail must name the measured total and the budget: a bare code
      // cannot tell an operator whether to raise the cap or fix the prompt.
      assert.match(
        (exit.kind === "transportFailure" && exit.detail) || "",
        /tool results reached \d+ bytes across \d+ round\(s\), over the 1000-byte session budget/
      );
      // Stopped promptly rather than running out the 50-round cap.
      assert.ok(handler.calls.length <= 3, `expected an early stop, got ${handler.calls.length} calls`);
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

  void it("abandons a round whose request never answers, instead of waiting forever", async () => {
    // Workflow-6 Item 18. The LM API has no timeout of its own: a request that
    // is accepted and never answered left the round awaiting indefinitely, the
    // Chat transaction pinned at `invocationPending`, and the task's chain
    // guard held — with no error, no log and no state transition. Observed
    // twice on 2026-08-19 (22 and 30+ minutes), each ending only because a
    // human gave up and cancelled.
    //
    // The stub never resolves and never yields, which is exactly that shape.
    // Without the deadline this test hangs the suite rather than failing —
    // which is itself the point.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    let cancelledByHost = false;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          sendRequest: (
            _messages: readonly unknown[],
            _options: unknown,
            token: vscode.CancellationToken
          ) =>
            new Promise((_resolve, reject) => {
              // Honour the token the transport hands us, as the real API does.
              token.onCancellationRequested(() => {
                cancelledByHost = true;
                reject(new Error("Canceled"));
              });
            }),
        },
      ]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        // Named explicitly: an undefined id resolves only a model called
        // "auto", which this stub is not.
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        roundTimeoutMs: 40,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind, "transportFailure");
      assert.equal(
        exit.kind === "transportFailure" ? exit.code : undefined,
        "copilotRequestTimedOut",
        "a timed-out round must not be reported as copilotRequestFailed or callerCancelled"
      );
      assert.match(
        exit.kind === "transportFailure" ? (exit.detail ?? "") : "",
        /round 1 exceeded the \d+s wall-clock deadline/,
        "the detail must name the round and the deadline"
      );
      assert.ok(
        cancelledByHost,
        "the in-flight request must actually be cancelled, not just abandoned by a race"
      );
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("fires the pre-request boundary marker before a hung sendRequest ever resolves", async () => {
    // Workflow-6 Item 18 fix 2. Fix 1 (the round deadline, tested above)
    // converts a hang into a reported failure but cannot say WHERE the hang
    // was: the marker fired synchronously right after `sendRequest` is
    // called is what proves the call actually reached `vscode.lm`, even
    // though its Thenable never settles — distinguishing that from a hang
    // that never got as far as calling `sendRequest` at all.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          sendRequest: (
            _messages: readonly unknown[],
            _options: unknown,
            token: vscode.CancellationToken
          ) =>
            new Promise((_resolve, reject) => {
              // Honour the token the transport hands us, as the real API does,
              // so the round deadline can actually abandon this await instead
              // of hanging the suite forever.
              token.onCancellationRequested(() => {
                reject(new Error("Canceled"));
              });
            }),
        },
      ]);
    const issued: Array<{ round: string }> = [];
    setLmToolSessionRequestIssuedObserverV1((event) =>
      issued.push({ round: `${event.round}/${event.maxRounds}` })
    );
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        roundTimeoutMs: 40,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(
        exit.kind === "transportFailure" ? exit.code : exit.kind,
        "copilotRequestTimedOut"
      );
      assert.deepEqual(
        issued,
        [{ round: "1/64" }],
        "the marker must fire exactly once, for the one round that was actually issued"
      );
    } finally {
      lm.selectChatModels = original;
      setLmToolSessionRequestIssuedObserverV1(undefined);
    }
  });

  void it("does not fire the pre-request boundary marker when capability probing fails closed first", async () => {
    // The marker exists to prove a round REACHED `sendRequest` — a failure
    // that never gets that far (no tool-calling host support) must not
    // report a request that was never issued.
    // Mutate the RAW require("vscode") module object — the `import * as`
    // namespace binding is not configurable (see vscodeLmCompat.test.ts and
    // the "fails closed with lmToolApiUnavailable" test below).
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const target = require("vscode") as Record<string, unknown>;
    const original = target.LanguageModelToolCallPart;
    delete target.LanguageModelToolCallPart;
    const issued: unknown[] = [];
    setLmToolSessionRequestIssuedObserverV1((event) => issued.push(event));
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "transportFailure", code: "lmToolApiUnavailable" });
      assert.deepEqual(issued, []);
    } finally {
      target.LanguageModelToolCallPart = original;
      setLmToolSessionRequestIssuedObserverV1(undefined);
    }
  });

  void it("reports a timeout even when the stream ENDS on cancellation instead of throwing", async () => {
    // Covers the re-check after the `try`. A stream that terminates quietly
    // when its token is cancelled — rather than rejecting — falls straight
    // through the try/catch with a truncated round and no error, so a
    // deadline checked only inside `catch` would let it continue to the next
    // round (or settle as a normal tool-free round) and lose the diagnosis.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          sendRequest: (
            _messages: readonly unknown[],
            _options: unknown,
            token: vscode.CancellationToken
          ) =>
            Promise.resolve({
              // An async iterable whose first `next()` never yields and simply
              // reports `done` once cancelled — no value, no throw. Written
              // out rather than as a generator because the point is that it
              // yields nothing, which `require-yield` (correctly) rejects in
              // a generator.
              stream: {
                [Symbol.asyncIterator]: () => ({
                  next: (): Promise<IteratorResult<object>> =>
                    new Promise((resolve) => {
                      token.onCancellationRequested(() =>
                        resolve({ done: true, value: undefined })
                      );
                    }),
                }),
              },
            }),
        },
      ]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        roundTimeoutMs: 40,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(
        exit.kind === "transportFailure" ? exit.code : exit.kind,
        "copilotRequestTimedOut",
        "a quietly-ended stream past the deadline must still report the timeout"
      );
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("abandons model enumeration that never answers, before any round starts", async () => {
    // The per-round deadline above does NOT cover this: `selectChatModels` is
    // awaited before the round loop. Shipping only the round deadline left
    // this path unbounded, and a run at 16:55 on 2026-08-19 hung there — 12
    // minutes past a 6-minute round deadline, with no round, no run log and
    // no context pack, on a build that already carried it.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    lm.selectChatModels = () => new Promise(() => undefined);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        modelSelectionTimeoutMs: 40,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(
        exit.kind === "transportFailure" ? exit.code : exit.kind,
        "copilotModelSelectionTimedOut",
        "a hang enumerating models must be reported distinctly from a selection error"
      );
    } finally {
      lm.selectChatModels = original;
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
