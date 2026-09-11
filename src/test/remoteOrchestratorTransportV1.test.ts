/**
 * Coverage for `createRemoteOrchestratorTextTransportV1`: the proxy transport
 * for the progressive "runs like local, just executes on the cloud box"
 * step. Exercises the request built (auth header, body shape), the response
 * mapping (success writes to the bounded writer; HTTP failure/auth-failure/
 * malformed-response map to distinct transportFailure codes), the
 * not-signed-in short-circuit (never calls fetch at all), and cancellation
 * (aborts the in-flight fetch and reports callerCancelled, not a generic
 * transport failure).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { createRemoteOrchestratorTextTransportV1 } from "../runners/remoteOrchestratorTransportV1";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { AgentExecutionRequestV1, BoundedResultWriterV1 } from "../types/agentExecutionV1";

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

function fakeToken(cancelled = false): vscode.CancellationToken & { fireCancel: () => void } {
  let handler: (() => void) | undefined;
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (listener: () => void) => {
      handler = listener;
      return { dispose: (): void => undefined };
    },
    fireCancel: (): void => handler?.(),
  } as unknown as vscode.CancellationToken & { fireCancel: () => void };
}

function makeRequest(
  overrides?: Partial<AgentExecutionRequestV1>
): AgentExecutionRequestV1 {
  const correlation: ActionCorrelationV1 = {
    actionKey: "remoteOrchestratorTestAction.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
  return {
    correlation,
    reservationId: allocateHex128IdV1(),
    mode: "text",
    prompt: "the prompt",
    maxResponseBytes: 4 * 1024 * 1024,
    cancellationToken: fakeToken(),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

void describe("createRemoteOrchestratorTextTransportV1", () => {
  void it("sends the bearer token and provider/model/prompt, writes the response text, and reports completed", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: "claude-opus-5",
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse(200, { text: "the model's reply" }));
      }) as typeof fetch,
    });
    const writer = makeWriter();

    const exit = await transport.invoke(makeRequest(), writer);

    assert.deepEqual(exit, { kind: "completed" });
    assert.equal(writer.text(), "the model's reply");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://orchestrator.example.com/v1/provider-calls");
    assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer cpat_test_token");
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
      provider: "anthropic",
      model: "claude-opus-5",
      prompt: "the prompt",
    });
  });

  void it("never calls fetch when there is no active session", async () => {
    let fetchCalled = false;
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve(undefined),
      fetchImpl: (() => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse(200, { text: "x" }));
      }) as unknown as typeof fetch,
    });

    const exit = await transport.invoke(makeRequest(), makeWriter());

    assert.equal(fetchCalled, false);
    assert.equal(exit.kind, "transportFailure");
    assert.ok(exit.kind === "transportFailure");
    assert.equal(exit.code, "remoteOrchestratorNotSignedIn");
  });

  void it("maps a provider auth failure (401 providerCallAuthFailed) to a distinct transportFailure code", async () => {
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse(401, { code: "providerCallAuthFailed", message: "invalid api key" })
        )) as typeof fetch,
    });

    const exit = await transport.invoke(makeRequest(), makeWriter());

    assert.equal(exit.kind, "transportFailure");
    assert.ok(exit.kind === "transportFailure");
    assert.equal(exit.code, "remoteOrchestrator.providerCallAuthFailed");
    assert.equal(exit.detail, "invalid api key");
  });

  void it("maps a malformed 200 response (no text field) to a transportFailure without writing anything", async () => {
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: (() => Promise.resolve(jsonResponse(200, { unexpected: true }))) as typeof fetch,
    });
    const writer = makeWriter();

    const exit = await transport.invoke(makeRequest(), writer);

    assert.equal(exit.kind, "transportFailure");
    assert.ok(exit.kind === "transportFailure");
    assert.equal(exit.code, "remoteOrchestratorMalformedResponse");
    assert.equal(writer.text(), "");
  });

  void it("aborts the in-flight fetch and reports callerCancelled when the caller cancels", async () => {
    const token = fakeToken();
    let observedAbort = false;
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: ((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }) as unknown as typeof fetch,
    });

    const invocation = transport.invoke(makeRequest({ cancellationToken: token }), makeWriter());
    // Cancel after invoke() has had a chance to register the listener and issue the fetch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    (token as unknown as { isCancellationRequested: boolean }).isCancellationRequested = true;
    token.fireCancel();

    const exit = await invocation;
    assert.equal(observedAbort, true);
    assert.deepEqual(exit, { kind: "callerCancelled" });
  });

  /** A 200 whose headers arrive but whose body never finishes — the stalled-proxy shape. */
  function stalledBodyFetch(): typeof fetch {
    return (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode('{"text":"partial'));
              // Never closes.
            },
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch;
  }

  void it("Cancel still works after headers arrive: a stalled body no longer hangs the stage", async () => {
    const token = fakeToken();
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: stalledBodyFetch(),
    });

    const invocation = transport.invoke(makeRequest({ cancellationToken: token }), makeWriter());
    await new Promise((resolve) => setTimeout(resolve, 10));
    (token as unknown as { isCancellationRequested: boolean }).isCancellationRequested = true;
    token.fireCancel();

    assert.deepEqual(await invocation, { kind: "callerCancelled" });
  });

  void it("an already-cancelled request never reaches the network (the server would bill the call)", async () => {
    let fetched = false;
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: (() => {
        fetched = true;
        return Promise.resolve(jsonResponse(200, { text: "x" }));
      }) as unknown as typeof fetch,
    });
    const exit = await transport.invoke(makeRequest({ cancellationToken: fakeToken(true) }), makeWriter());
    assert.deepEqual(exit, { kind: "callerCancelled" });
    assert.equal(fetched, false);
  });

  void it("a throwing session lookup and a non-string error message become failures, never a rejected invoke", async () => {
    const throwing = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.reject(new Error("keychain unavailable")),
      fetchImpl: (() => Promise.resolve(jsonResponse(200, { text: "x" }))) as typeof fetch,
    });
    const first = await throwing.invoke(makeRequest(), makeWriter());
    assert.equal(first.kind, "transportFailure");

    const oddBody = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: (() => Promise.resolve(jsonResponse(502, { code: 7, message: { nested: true } }))) as typeof fetch,
    });
    const second = await oddBody.invoke(makeRequest(), makeWriter());
    assert.equal(second.kind, "transportFailure");
    assert.ok(second.kind === "transportFailure");
    assert.equal(second.code, "remoteOrchestratorHttp502");
  });

  void it("a call past its deadline is a distinct timeout failure, never an indefinite wait", async () => {
    const transport = createRemoteOrchestratorTextTransportV1({
      baseUrl: "https://orchestrator.example.com",
      provider: "anthropic",
      model: undefined,
      getAccessToken: () => Promise.resolve("cpat_test_token"),
      fetchImpl: stalledBodyFetch(),
      requestTimeoutMs: 30,
    });

    const exit = await transport.invoke(makeRequest(), makeWriter());

    assert.equal(exit.kind, "transportFailure");
    assert.ok(exit.kind === "transportFailure");
    assert.equal(exit.code, "remoteOrchestratorTimeout");
  });
});
