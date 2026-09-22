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
  TOOL_ROUND_WIND_DOWN_NOTICE_ROUNDS_V1,
  toolRoundWindDownNoticeV1,
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
      assert.deepEqual(exit, {
        kind: "transportFailure",
        code: "toolRoundLimitExceeded",
        detail: "used all 2 tool rounds without replying with a final answer",
      });
      assert.equal(handler.calls.length, 2);
    } finally {
      model.restore();
    }
  });

  /** The wind-down notices a request carried, in order. */
  const windDownNotices = (request: ReadonlyArray<{ role: string; content: unknown }>): string[] =>
    request
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => message.content as string)
      .filter((text) => text.startsWith("Tool round limit"));

  void it("tells a session how many rounds remain before the cap, so it answers instead of failing", async () => {
    // v1 fixes 2, item 26 (2026-09-15): a Copilot review spent all 64 rounds
    // reading — every request succeeded — and ended in toolRoundLimitExceeded,
    // discarding everything it had read. Nothing had told it the cap existed.
    const model = installBudgetedModel(128_000, [
      [toolCall("call-1")],
      [toolCall("call-2")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ]);
    const writer = makeWriter();
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        maxRounds: 3,
      });
      const exit = await transport.invoke(makeRequest(), writer);
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(writer.text(), FRAMED_FINAL_ANSWER);
      assert.deepEqual(windDownNotices(model.sent[0]!), []);
      // makeRequest() is a preflight session, so it gets the plan-authoring
      // wording (2026-09-18, run 2060: the generic notice was answered with an
      // empty plan after 59 rounds of reads).
      assert.deepEqual(windDownNotices(model.sent[1]!), [toolRoundWindDownNoticeV1(2, "preflight")]);
      assert.deepEqual(windDownNotices(model.sent[2]!), [
        toolRoundWindDownNoticeV1(2, "preflight"),
        toolRoundWindDownNoticeV1(1, "preflight"),
      ]);
      assert.match(toolRoundWindDownNoticeV1(1, "preflight"), /An empty plan discards everything/);
      assert.match(toolRoundWindDownNoticeV1(2, "preflight"), /an empty plan is not a way to stop early/);

      // The text-mode wording is pinned EXACTLY, not by substring: adding the
      // preflight branch must leave a review session's notice byte-identical,
      // and a substring check would pass through any accidental rewrite
      // (2026-09-18 adversarial review, area 6).
      const legacyLastRound =
        "Tool round limit: your next reply is the LAST one this session allows. If it calls a tool, " +
        "the session ends with no result and everything you have read is lost. Reply now with your " +
        "complete final result frame, as the result contract requires, based on what you have " +
        "already read. Where you could not verify something, say so in the result as a confidence " +
        "limitation.";
      const legacyEarlier =
        "Tool round limit: 2 rounds remain in this session. Read only what your answer " +
        "still depends on, putting the remaining reads in as few replies as you can, then reply with " +
        "your complete final result frame. A session that runs out of rounds produces no result at all.";
      assert.equal(toolRoundWindDownNoticeV1(1), legacyLastRound);
      assert.equal(toolRoundWindDownNoticeV1(1, "text"), legacyLastRound);
      assert.equal(toolRoundWindDownNoticeV1(2), legacyEarlier);
      assert.equal(toolRoundWindDownNoticeV1(2, "text"), legacyEarlier);
      assert.notEqual(toolRoundWindDownNoticeV1(1, "preflight"), legacyLastRound);
      assert.notEqual(toolRoundWindDownNoticeV1(2, "preflight"), legacyEarlier);

      // The notice follows the tool results; it never separates a call from its result.
      const last = model.sent[2]!;
      for (let i = 0; i < last.length; i++) {
        const message = last[i]!;
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
          continue;
        }
        const callIds = (message.content as Array<{ callId?: string; name?: string }>)
          .filter((part) => part.name !== undefined && part.callId !== undefined)
          .map((part) => part.callId);
        const answered = ((last[i + 1]?.content as Array<{ callId?: string }> | undefined) ?? []).map(
          (part) => part.callId
        );
        assert.deepEqual(answered, callIds, `tool calls at message ${i} must be answered by the next message`);
      }
    } finally {
      model.restore();
    }
  });

  void it("does not warn far from the cap, and never warns an edit session", async () => {
    const rounds = [[toolCall("call-1")], [toolCall("call-2")], [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)]];
    const far = installBudgetedModel(128_000, rounds);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        maxRounds: 3 + TOOL_ROUND_WIND_DOWN_NOTICE_ROUNDS_V1,
      });
      assert.deepEqual(await transport.invoke(makeRequest(), makeWriter()), { kind: "completed" });
      assert.deepEqual(far.sent.flatMap((request) => windDownNotices(request)), []);
    } finally {
      far.restore();
    }

    // An edit session is executing sealed steps; telling it to stop would
    // leave a plan half-applied.
    const edit = installBudgetedModel(128_000, rounds);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        maxRounds: 3,
      });
      assert.deepEqual(await transport.invoke({ ...makeRequest(), mode: "edit" as const }, makeWriter()), {
        kind: "completed",
      });
      assert.deepEqual(edit.sent.flatMap((request) => windDownNotices(request)), []);
    } finally {
      edit.restore();
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

  /**
   * A fake Copilot model that advertises `maxInputTokens` and keeps a copy of
   * every request's message list (the session edits earlier entries in place
   * when it sheds a result, so a live reference would show only the end state).
   */
  function installBudgetedModel(
    maxInputTokens: number,
    rounds: ReadonlyArray<readonly object[]>
  ): { restore: () => void; sent: Array<Array<{ role: string; content: unknown }>> } {
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    const sent: Array<Array<{ role: string; content: unknown }>> = [];
    let round = 0;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens,
          sendRequest: (messages: ReadonlyArray<{ role: string; content: unknown }>) => {
            sent.push([...messages]);
            const parts = rounds[Math.min(round, rounds.length - 1)]!;
            round += 1;
            return Promise.resolve({
              stream: (function* (): Generator<object> {
                yield* parts;
              })(),
            });
          },
        },
      ]);
    return {
      restore: (): void => {
        lm.selectChatModels = original;
      },
      sent,
    };
  }

  const toolCall = (callId: string): object =>
    new stubClasses.LanguageModelToolCallPart(callId, "ensemble_readFile", { rootId: "r", relativePath: callId });

  void it("sheds the oldest tool results rather than letting the provider prune the conversation", async () => {
    // v1 fixes 2, item 17 (2026-09-11): over its prompt budget, Copilot's LM
    // provider prunes the conversation oldest-first — the prompt, then the
    // first assistant turn — so a tool result survives its own tool call and
    // the API rejects it: "400 No tool call found for function call output".
    // The session must stay under budget itself, and when it sheds, it must
    // keep every call/result pair intact.
    const model = installBudgetedModel(1000, [
      [toolCall("call-1")],
      [toolCall("call-2")],
      [toolCall("call-3")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ]);
    // ~500 estimated tokens each against a ~700-token session budget: any two
    // unshed results together are over it.
    const handler = recordingHandler(() => "x".repeat(1500));
    const writer = makeWriter();
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), writer);
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(model.sent.length, 4);

      const last = model.sent[3]!;
      assert.equal(last[0]!.content, "preflight the change", "the original prompt must survive");

      const resultText = (callId: string): string => {
        for (const message of last) {
          if (!Array.isArray(message.content)) {
            continue;
          }
          for (const part of message.content as Array<{ callId?: string; content?: Array<{ value: string }> }>) {
            if (part.callId === callId && Array.isArray(part.content)) {
              return part.content.map((chunk) => chunk.value).join("");
            }
          }
        }
        throw new Error(`no tool result for ${callId}`);
      };
      assert.match(resultText("call-1"), /Ensemble removed this tool result \(1500 bytes\)/);
      assert.match(resultText("call-2"), /Ensemble removed this tool result \(1500 bytes\)/);
      assert.equal(resultText("call-3"), "x".repeat(1500), "the newest result must reach the model intact");

      // Every tool call is immediately followed by a message answering it.
      for (let i = 0; i < last.length; i++) {
        const message = last[i]!;
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
          continue;
        }
        const callIds = (message.content as Array<{ callId?: string; name?: string }>)
          .filter((part) => part.name !== undefined && part.callId !== undefined)
          .map((part) => part.callId);
        const answered = ((last[i + 1]?.content as Array<{ callId?: string }> | undefined) ?? []).map(
          (part) => part.callId
        );
        assert.deepEqual(answered, callIds, `tool calls at message ${i} must be answered by message ${i + 1}`);
      }
    } finally {
      model.restore();
    }
  });

  void it("does not trust a large advertised maxInputTokens — budgets against a fixed ceiling", async () => {
    // 2026-09-11 15:42: the first fix budgeted 70% of `maxInputTokens` and the
    // review still failed identically. Copilot advertises a model's full
    // long-context maximum there, but VS Code fills the model's default
    // "Context Size" (the smaller standard window) into every request, and
    // that is the window Copilot prunes against.
    const model = installBudgetedModel(1_000_000, [
      [toolCall("call-1")],
      [toolCall("call-2")],
      [toolCall("call-3")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ]);
    // ~50k estimated tokens each: two together overrun the ceiling's budget,
    // but not 70% of the advertised million.
    const handler = recordingHandler(() => "y".repeat(150_000));
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "completed" });
      const serialized = JSON.stringify(model.sent[3]);
      assert.match(serialized, /Ensemble removed this tool result \(150000 bytes\)/);
    } finally {
      model.restore();
    }
  });

  void it("sizes the conversation with the model's own tokenizer, not the pessimistic estimate", async () => {
    // 2026-09-11 16:50: a review whose third round read several large files
    // was refused at ~108k *estimated* tokens (3 bytes/token) — about 80k real,
    // well inside the window. The model can count; use its count.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    const rounds: object[][] = [[toolCall("call-1")], [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)]];
    let served = 0;
    const counted: unknown[] = [];
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 128_000,
          // A real tokenizer's ~4 bytes/token on this content.
          countTokens: (input: unknown) => {
            counted.push(input);
            return Promise.resolve(typeof input === "string" ? Math.ceil(input.length / 4) : 0);
          },
          sendRequest: () => {
            const parts = rounds[Math.min(served, rounds.length - 1)]!;
            served += 1;
            return Promise.resolve({ stream: (function* (): Generator<object> { yield* parts; })() });
          },
        },
      ]);
    // 330 KB: ~110k by the estimate (over the ~108.8k budget), ~82.5k counted.
    const handler = recordingHandler(() => "w".repeat(330_000));
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(served, 2);
      // Strings only: Copilot's per-message count skips tool-result parts.
      assert.ok(counted.every((input) => typeof input === "string"), "count text, never whole messages");
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("falls back to the estimate when countTokens never answers, instead of hanging", async () => {
    // `countTokens` is a Thenable with no completion guarantee, and the prompt
    // is sized before any round deadline exists. A tokenizer that never
    // settles must cost one bounded wait, then the estimate for the rest.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    const rounds: object[][] = [
      [toolCall("call-1")],
      [toolCall("call-2")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ];
    let served = 0;
    let countCalls = 0;
    const cancelledCounts: boolean[] = [];
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 128_000,
          countTokens: (_text: string, token: vscode.CancellationToken) => {
            countCalls += 1;
            token.onCancellationRequested(() => cancelledCounts.push(true));
            return new Promise<number>(() => undefined);
          },
          sendRequest: () => {
            const parts = rounds[Math.min(served, rounds.length - 1)]!;
            served += 1;
            return Promise.resolve({ stream: (function* (): Generator<object> { yield* parts; })() });
          },
        },
      ]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        countTokensTimeoutMs: 20,
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(served, 3);
      assert.equal(countCalls, 1, "after one timeout the tokenizer is not waited on again");
      assert.deepEqual(cancelledCounts, [true], "the abandoned count is cancelled");
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("dispatches no further buffered tool call once the caller cancels mid-sizing", async () => {
    // The edit broker's tools mutate the workspace. A cancel that lands while
    // one result is being sized must stop the session before the next
    // already-buffered call runs — and promptly, even if the tokenizer ignores
    // its cancellation token.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    const tokenSource = new vscode.CancellationTokenSource();
    let countCalls = 0;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 128_000,
          countTokens: (text: string) => {
            countCalls += 1;
            if (countCalls === 1) {
              return Promise.resolve(Math.ceil(text.length / 4));
            }
            // Sizing the first tool result: the user cancels, and this
            // tokenizer never answers and never honours its token.
            tokenSource.cancel();
            return new Promise<number>(() => undefined);
          },
          sendRequest: () =>
            Promise.resolve({
              stream: (function* (): Generator<object> {
                yield toolCall("call-a");
                yield toolCall("call-b");
              })(),
            }),
        },
      ]);
    const handler = recordingHandler(() => "{}");
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: handler,
        countTokensTimeoutMs: 5000,
      });
      const started = Date.now();
      const exit = await transport.invoke({ ...makeRequest(), cancellationToken: tokenSource.token }, makeWriter());
      assert.deepEqual(exit, { kind: "callerCancelled" });
      assert.deepEqual(
        handler.calls.map((call) => call.callId),
        ["call-a"],
        "call-b was buffered but must not run after the cancel"
      );
      assert.ok(Date.now() - started < 1000, "cancellation must not wait out the tokenizer deadline");
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("reports a round deadline that expires while a tool result is being sized", async () => {
    // The round deadline cancels the round's own token; token counting used to
    // watch only the caller's. A count in flight when the round expired could
    // run on under the tokenizer's separate 10s deadline and then report some
    // later outcome instead of the timeout that actually happened.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    let countCalls = 0;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 128_000,
          countTokens: (text: string) => {
            countCalls += 1;
            // The prompt sizes normally; sizing the tool result never answers.
            return countCalls === 1
              ? Promise.resolve(Math.ceil(text.length / 4))
              : new Promise<number>(() => undefined);
          },
          sendRequest: () =>
            Promise.resolve({
              stream: (function* (): Generator<object> {
                yield toolCall("call-1");
              })(),
            }),
        },
      ]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        roundTimeoutMs: 200,
        countTokensTimeoutMs: 5000,
      });
      const started = Date.now();
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind, "transportFailure");
      assert.equal(exit.kind === "transportFailure" && exit.code, "copilotRequestTimedOut");
      assert.equal(countCalls, 2, "the round must have reached the result-sizing count");
      assert.ok(
        Date.now() - started < 1000,
        "the round deadline must end the count, not the tokenizer's own 5s deadline"
      );
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("reports a cancel that lands during a tool call as cancelled, not as a protocol violation", async () => {
    // The protocol and result-budget exits run after the handler's await. A
    // cancel arriving while the handler was working used to fall through to
    // whichever of those tripped first, so a run the user stopped was
    // reported as a provider fault — which the coordinator treats quite
    // differently from a cancellation.
    const model = installModel([[toolCall("call-1")]]);
    const tokenSource = new vscode.CancellationTokenSource();
    // Already over the violation cap: without the cancellation check this
    // round exits as `toolProtocolViolation`.
    const handler = recordingHandler(() => {
      tokenSource.cancel();
      return "{}";
    }, 99);
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke({ ...makeRequest(), cancellationToken: tokenSource.token }, makeWriter());
      assert.deepEqual(exit, { kind: "callerCancelled" });
    } finally {
      model.restore();
    }
  });

  void it("ends the round when a tool handler hangs past the round deadline", async () => {
    // `handleToolCall` takes no cancellation token, so the round deadline —
    // which works by cancelling the round's token — cannot reach inside it. A
    // wedged workspace read or edit used to park the round indefinitely: the
    // exact unbounded silent wait the deadline exists to convert into a
    // reported failure. Without the race this test hangs until the runner
    // kills it.
    const model = installModel([[toolCall("call-1")]]);
    const hangingHandler: RequestLocalToolHandlerV1 = {
      descriptors: [{ name: "ensemble_readFile", description: "read" }],
      handleToolCall: () => new Promise<string>(() => undefined),
      violationCount: () => 0,
    };
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: hangingHandler,
        roundTimeoutMs: 200,
      });
      const started = Date.now();
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind, "transportFailure");
      assert.equal(exit.kind === "transportFailure" && exit.code, "copilotRequestTimedOut");
      assert.ok(Date.now() - started < 3000, "the round deadline must end a hung handler");
    } finally {
      model.restore();
    }
  });

  void it("never abandons a mutation handler mid-flight, even past the round deadline", async () => {
    // Abandoning a read is harmless; abandoning a MUTATION is not. The
    // handler keeps running after a lost race, so its write could land after
    // this transport reported a timeout and the coordinator moved to the next
    // candidate. An edit session therefore waits for its handler, and reports
    // the timeout only once the mutation has settled.
    const model = installModel([[toolCall("call-1")]]);
    let handlerSettled = false;
    const slowEditHandler: RequestLocalToolHandlerV1 = {
      descriptors: [{ name: "ensemble_replaceFile", description: "replace" }],
      handleToolCall: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        handlerSettled = true;
        return "{}";
      },
      violationCount: () => 0,
    };
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: slowEditHandler,
        roundTimeoutMs: 100,
      });
      const exit = await transport.invoke(
        { ...makeRequest(), mode: "edit" as const },
        makeWriter()
      );
      assert.ok(handlerSettled, "the mutation must not be abandoned when the round deadline fires");
      assert.equal(exit.kind === "transportFailure" && exit.code, "copilotRequestTimedOut");
    } finally {
      model.restore();
    }
  });

  void it("reports a cancel during the final round's accounting as cancelled, not as a round-limit failure", async () => {
    // The loop's cancellation check sits at the top of the next iteration,
    // which the last allowed round never reaches — so a cancel landing in
    // that round's post-round accounting fell through to
    // `toolRoundLimitExceeded`, a provider fault.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    const tokenSource = new vscode.CancellationTokenSource();
    let countCalls = 0;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 128_000,
          countTokens: (text: string) => {
            countCalls += 1;
            // 1 = the prompt, 2 = the tool result, 3 = this round's own text,
            // which is the post-round accounting the cancel lands in.
            if (countCalls === 3) {
              tokenSource.cancel();
            }
            return Promise.resolve(Math.ceil(text.length / 4));
          },
          sendRequest: () =>
            Promise.resolve({
              stream: (function* (): Generator<object> {
                yield toolCall("call-1");
              })(),
            }),
        },
      ]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
        maxRounds: 1,
      });
      const exit = await transport.invoke({ ...makeRequest(), cancellationToken: tokenSource.token }, makeWriter());
      assert.deepEqual(exit, { kind: "callerCancelled" });
      assert.equal(countCalls, 3, "the cancel must land in the post-round accounting");
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("defers the largest reads of one oversized step instead of failing the session", async () => {
    // A single step that reads several large files at once can overrun the
    // budget with nothing older left to shed. Withhold the largest, keep at
    // least one, and tell the model to re-read the rest separately.
    const model = installBudgetedModel(1000, [
      [toolCall("call-a"), toolCall("call-b")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ]);
    const handler = recordingHandler((call) => (call.callId === "call-a" ? "a".repeat(1500) : "b".repeat(1200)));
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "completed" });
      const second = JSON.stringify(model.sent[1]);
      assert.match(second, /Ensemble did not include this tool result \(1500 bytes\)/);
      assert.ok(second.includes("b".repeat(1200)), "the smaller read reaches the model intact");
    } finally {
      model.restore();
    }
  });

  void it("sheds and resends the round when the provider still orphans a tool result", async () => {
    // Even under budget, the provider's real window is unknowable from the
    // extension API. If it prunes anyway, the 400 names an orphaned tool
    // result; that is a request-size fault, so shed harder and resend the same
    // round instead of failing the review.
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    const rounds: object[][] = [
      [toolCall("call-1")],
      [toolCall("call-2")],
      [new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)],
    ];
    const sent: string[] = [];
    let served = 0;
    let rejected = false;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 1000,
          sendRequest: (messages: readonly unknown[]) => {
            sent.push(JSON.stringify(messages));
            // The third request (carrying call-1's and call-2's results) is
            // rejected once, exactly as Copilot rejected it on 2026-09-11.
            if (served === 2 && !rejected) {
              rejected = true;
              return Promise.reject(
                new Error(
                  'Request Failed: 400 {"error":{"message":"No tool call found for function call output ' +
                    'with call_id call-1.","code":"invalid_request_body"}}'
                )
              );
            }
            const parts = rounds[Math.min(served, rounds.length - 1)]!;
            served += 1;
            return Promise.resolve({ stream: (function* (): Generator<object> { yield* parts; })() });
          },
        },
      ]);
    // ~200 estimated tokens each: comfortably inside the ~700-token budget
    // together, so only the rejection makes the session shed.
    const handler = recordingHandler(() => "z".repeat(600));
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.deepEqual(exit, { kind: "completed" });
      assert.equal(sent.length, 4, "the rejected round is sent again, once");
      assert.doesNotMatch(sent[2]!, /Ensemble removed this tool result/, "nothing was shed before the rejection");
      assert.match(sent[3]!, /Ensemble removed this tool result \(600 bytes\)/, "the resend sheds call-1");
      assert.equal(handler.calls.length, 2, "no tool call is executed twice");
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("reports the orphaned-result rejection when shedding cannot shrink the request", async () => {
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    let served = 0;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          maxInputTokens: 1000,
          sendRequest: () => {
            served += 1;
            if (served === 1) {
              return Promise.resolve({ stream: (function* (): Generator<object> { yield toolCall("call-1"); })() });
            }
            return Promise.reject(new Error("Request Failed: 400 No tool call found for function call output"));
          },
        },
      ]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      // Only the newest round's result exists, and it is never shed — so a
      // resend would be identical. Fail with the provider's own words.
      assert.equal(exit.kind === "transportFailure" && exit.code, "copilotRequestFailed");
      assert.match((exit.kind === "transportFailure" && exit.detail) || "", /No tool call found/);
      assert.equal(served, 2);
    } finally {
      lm.selectChatModels = original;
    }
  });

  void it("stops with a readable reason when even the newest result cannot fit, instead of sending", async () => {
    const model = installBudgetedModel(100, [[toolCall("call-1")]]);
    const handler = recordingHandler(() => "x".repeat(3000));
    try {
      const transport = createCopilotLmToolSessionTransportV1({ model: "gpt-test", toolHandler: handler });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind === "transportFailure" && exit.code, "toolSessionContextBudgetExceeded");
      assert.match(
        (exit.kind === "transportFailure" && exit.detail) || "",
        /100-token input limit.*silently drop the start of the conversation/
      );
      // The over-budget second request was never sent.
      assert.equal(model.sent.length, 1);
    } finally {
      model.restore();
    }
  });

  void it("refuses to send a prompt that alone exceeds the budget", async () => {
    const model = installBudgetedModel(5, [[new stubClasses.LanguageModelTextPart(FRAMED_FINAL_ANSWER)]]);
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind === "transportFailure" && exit.code, "toolSessionContextBudgetExceeded");
      assert.equal(model.sent.length, 0);
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

void describe("languageModelToolSessionV1 transient faults (v1 fixes 2, item 27)", () => {
  function installFlakyModel(serve: (call: number) => Promise<{ stream: Generator<object> }>): {
    restore: () => void;
  } {
    const lm = (vscode as unknown as { lm: { selectChatModels: unknown } }).lm;
    const original = lm.selectChatModels;
    let call = 0;
    lm.selectChatModels = () =>
      Promise.resolve([
        {
          id: "gpt-test",
          name: "GPT Test",
          vendor: "copilot",
          family: "gpt",
          sendRequest: () => serve(call++),
        },
      ]);
    return {
      restore: (): void => {
        lm.selectChatModels = original;
      },
    };
  }

  const emptyReply = (): Promise<{ stream: Generator<object> }> =>
    Promise.resolve({ stream: (function* (): Generator<object> { /* no parts */ })() });

  void it("reports an empty first reply as a retryable network fault", async () => {
    const model = installFlakyModel(() => emptyReply());
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const exit = await transport.invoke(makeRequest(), makeWriter());
      assert.equal(exit.kind, "transportFailure");
      if (exit.kind === "transportFailure") {
        assert.equal(exit.code, "copilotEmptyResponse");
        assert.equal(exit.networkFault, true);
        assert.match(exit.detail ?? "", /empty response/);
      }
    } finally {
      model.restore();
    }
  });

  void it("flags a connection reset as a network fault and leaves a provider refusal unflagged", async () => {
    for (const [message, expected] of [
      ["Error Code: net::ERR_HTTP2_PROTOCOL_ERROR.", true],
      ["Request Failed: 400 invalid_request_body", false],
    ] as const) {
      const model = installFlakyModel(() => Promise.reject(new Error(message)));
      try {
        const transport = createCopilotLmToolSessionTransportV1({
          model: "gpt-test",
          toolHandler: recordingHandler(() => "{}"),
        });
        const exit = await transport.invoke(makeRequest(), makeWriter());
        assert.equal(exit.kind === "transportFailure" && exit.code, "copilotRequestFailed");
        assert.equal(exit.kind === "transportFailure" && exit.networkFault === true, expected, message);
      } finally {
        model.restore();
      }
    }
  });

  const editToolRound = (): Promise<{ stream: Generator<object> }> =>
    Promise.resolve({
      stream: (function* (): Generator<object> {
        yield new stubClasses.LanguageModelToolCallPart("call-1", "ensemble_readFile", {
          rootId: "r",
          relativePath: "a.ts",
        });
      })(),
    });

  void it("resends the current round once after a transient fault in an edit session, without replaying earlier rounds", async () => {
    let calls = 0;
    const model = installFlakyModel((call) => {
      calls = call + 1;
      if (call === 0) {
        return editToolRound();
      }
      if (call === 1) {
        return Promise.reject(new Error("Error Code: net::ERR_HTTP2_PROTOCOL_ERROR."));
      }
      return Promise.resolve({
        stream: (function* (): Generator<object> {
          yield new stubClasses.LanguageModelTextPart(
            "<<<ENSEMBLE_AI_RESULT_V1>>>\n{}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>"
          );
        })(),
      });
    });
    try {
      let toolCalls = 0;
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => {
          toolCalls += 1;
          return "{}";
        }),
      });
      const request = { ...makeRequest(), mode: "edit" } as unknown as AgentExecutionRequestV1;
      const exit = await transport.invoke(request, makeWriter());
      assert.equal(calls, 3);
      assert.equal(toolCalls, 1, "the earlier round's tool call must not be replayed");
      assert.notEqual(exit.kind, "transportFailure");
    } finally {
      model.restore();
    }
  });

  void it("does not flag a mid-session fault in an edit session that persists past the one resend", async () => {
    const toolRound = editToolRound;
    const model = installFlakyModel((call) =>
      call === 0 ? toolRound() : Promise.reject(new Error("Error Code: net::ERR_HTTP2_PROTOCOL_ERROR."))
    );
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const request = { ...makeRequest(), mode: "edit" } as unknown as AgentExecutionRequestV1;
      const exit = await transport.invoke(request, makeWriter());
      assert.equal(exit.kind === "transportFailure" && exit.code, "copilotRequestFailed");
      assert.equal(exit.kind === "transportFailure" && exit.networkFault === true, false);
      assert.match(
        (exit.kind === "transportFailure" && exit.detail) || "",
        /attempt 2 of 2 on this tool round/
      );
    } finally {
      model.restore();
    }
  });

  void it("names the attempt count when a mid-session empty response persists past the one resend", async () => {
    const model = installFlakyModel((call) => (call === 0 ? editToolRound() : emptyReply()));
    try {
      const transport = createCopilotLmToolSessionTransportV1({
        model: "gpt-test",
        toolHandler: recordingHandler(() => "{}"),
      });
      const request = { ...makeRequest(), mode: "edit" } as unknown as AgentExecutionRequestV1;
      const exit = await transport.invoke(request, makeWriter());
      assert.equal(exit.kind === "transportFailure" && exit.code, "copilotEmptyResponse");
      assert.equal(exit.kind === "transportFailure" && exit.networkFault === true, false);
      assert.match(
        (exit.kind === "transportFailure" && exit.detail) || "",
        /empty response on tool round 2 \(attempt 2 of 2 on this tool round\)/
      );
    } finally {
      model.restore();
    }
  });
});
