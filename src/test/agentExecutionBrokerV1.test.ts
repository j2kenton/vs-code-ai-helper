/**
 * Coverage for the V1 agent execution broker (plan §3.2):
 *  - the broker seals, hashes, and bounds provider output itself; runners
 *    receive only the bounded writer (AC-RUNNER-01/02);
 *  - invocation authority comes solely from a claimed reservation with a
 *    matching correlation tuple, reservation id, and mode (plan §1.3's
 *    "V1 invocation requires registry-issued correlation and reservation
 *    data"), and only migrated action keys pass the V1 boundary;
 *  - overflow, cancellation, transport failure (with the response-started
 *    flag), and invalid-UTF-8 output map onto the declared
 *    `RawAgentExecutionResultV1` states, and unsealed output is discarded;
 *  - large results spool through the private claim-once store.
 */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type * as vscode from "vscode";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  BoundedResultWriterV1,
  MAX_NORMAL_RESPONSE_BYTES_V1,
  MAX_PREFLIGHT_RESPONSE_BYTES_V1,
  maxResponseBytesCeilingForModeV1,
} from "../types/agentExecutionV1";
import {
  AgentExecutionBrokerErrorV1,
  createBoundedResultWriterV1,
  executeAgentRequestV1,
} from "../services/agentExecutionBrokerV1";
import { BoundedResultStoreV1, createBoundedResultStoreV1 } from "../services/boundedResultStoreV1";
import { MIGRATED_ACTION_KEYS_V0 } from "../services/legacyAiActionSafetyGateV0";
import {
  ClaimedReservationV1,
  openProviderSelectionSessionV1,
} from "../services/providerSelectionPolicyV1";

const TEST_ACTION_KEY = "brokerTestAction.v1";

function fakeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

function scriptedTransport(
  script: (request: AgentExecutionRequestV1, output: BoundedResultWriterV1) => AgentTransportExitV1
): AgentTransportV1 {
  return {
    runnerId: "scripted-transport",
    invoke: (request, output): Promise<AgentTransportExitV1> =>
      Promise.resolve(script(request, output)),
  };
}

interface BrokerFixture {
  request: AgentExecutionRequestV1;
  claimed: ClaimedReservationV1;
}

function makeFixture(options?: {
  mode?: "text" | "preflight" | "edit";
  maxResponseBytes?: number;
  cancelled?: boolean;
  actionKey?: string;
}): BrokerFixture {
  const session = openProviderSelectionSessionV1({
    actionKey: options?.actionKey ?? TEST_ACTION_KEY,
    operationId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  });
  const mode = options?.mode ?? "text";
  const attemptId = session.allocateAttempt();
  const handle = session.reserve({
    attemptId,
    mode,
    runnerId: "scripted-transport",
    providerId: "copilot",
    modelId: "copilot:test",
  });
  const claimed = session.claim(handle.reservationId);
  const request: AgentExecutionRequestV1 = {
    correlation: session.correlationForAttempt(attemptId),
    reservationId: handle.reservationId,
    mode,
    prompt: "prompt text",
    maxResponseBytes: options?.maxResponseBytes ?? 1024,
    cancellationToken: fakeToken(options?.cancelled ?? false),
  };
  return { request, claimed };
}

void describe("agentExecutionBrokerV1", () => {
  before(() => {
    (MIGRATED_ACTION_KEYS_V0 as unknown as Set<string>).add(TEST_ACTION_KEY);
  });
  after(() => {
    (MIGRATED_ACTION_KEYS_V0 as unknown as Set<string>).delete(TEST_ACTION_KEY);
  });

  void it("seals a completed response in memory with exact length and hash", async () => {
    const { request, claimed } = makeFixture();
    // Multibyte content split mid-character across chunks: sealing must be
    // byte-accurate regardless of chunk boundaries.
    const text = "résultat ✓";
    const bytes = Buffer.from(text, "utf8");
    const result = await executeAgentRequestV1(
      request,
      claimed,
      scriptedTransport((_req, output) => {
        output.write(bytes.subarray(0, 3));
        output.write(bytes.subarray(3));
        return { kind: "completed" };
      })
    );
    assert.equal(result.kind, "response");
    if (result.kind !== "response" || result.payload.storage !== "memory") {
      assert.fail("expected an in-memory sealed payload");
    }
    assert.equal(result.payload.utf8Text, text);
    assert.equal(result.payload.byteLength, bytes.length);
    assert.equal(result.payload.sha256, createHash("sha256").update(bytes).digest("hex"));
  });

  void it("rejects an unmigrated action key at the V1 boundary", async () => {
    const key = "unmigratedAction.v1";
    const { request, claimed } = makeFixture({ actionKey: key });
    assert.equal(MIGRATED_ACTION_KEYS_V0.has(key), false);
    await assert.rejects(
      executeAgentRequestV1(request, claimed, scriptedTransport(() => ({ kind: "completed" }))),
      AgentExecutionBrokerErrorV1
    );
  });

  void it("rejects a request smuggling a legacy artifact/result path field", async () => {
    for (const forbidden of ["outputFile", "outputPath", "resultPath", "logFile"]) {
      const { request, claimed } = makeFixture();
      const smuggled = { ...request, [forbidden]: "/tmp/somewhere" } as AgentExecutionRequestV1;
      await assert.rejects(
        executeAgentRequestV1(smuggled, claimed, scriptedTransport(() => ({ kind: "completed" }))),
        (error: unknown) =>
          error instanceof AgentExecutionBrokerErrorV1 && error.message.includes(forbidden)
      );
    }
  });

  void it("rejects reservation, correlation, and mode mismatches before invoking", async () => {
    let invoked = false;
    const transport = scriptedTransport(() => {
      invoked = true;
      return { kind: "completed" };
    });

    const wrongReservation = makeFixture();
    await assert.rejects(
      executeAgentRequestV1(
        { ...wrongReservation.request, reservationId: allocateHex128IdV1() },
        wrongReservation.claimed,
        transport
      ),
      /reservation id does not match/
    );

    const wrongAttempt = makeFixture();
    await assert.rejects(
      executeAgentRequestV1(
        {
          ...wrongAttempt.request,
          correlation: { ...wrongAttempt.request.correlation, attemptId: allocateHex128IdV1() },
        },
        wrongAttempt.claimed,
        transport
      ),
      /correlation tuple does not match/
    );

    const wrongMode = makeFixture({ mode: "text" });
    await assert.rejects(
      executeAgentRequestV1(
        { ...wrongMode.request, mode: "edit" },
        wrongMode.claimed,
        transport
      ),
      /mode/
    );

    assert.equal(invoked, false, "no mismatched request may reach the transport");
  });

  void it("rejects a transport whose runnerId differs from the claimed reservation's runner", async () => {
    const { request, claimed } = makeFixture(); // reserved for runnerId "scripted-transport"
    let invoked = false;
    const foreignTransport: AgentTransportV1 = {
      runnerId: "some-other-runner",
      invoke: (): Promise<AgentTransportExitV1> => {
        invoked = true;
        return Promise.resolve({ kind: "completed" });
      },
    };
    await assert.rejects(
      executeAgentRequestV1(request, claimed, foreignTransport),
      /authorizes only the runner/
    );
    assert.equal(invoked, false, "a mismatched transport must never be invoked");

    // The rejection happened before beginInvocation consumed anything: the
    // reservation's single invocation is still available to the reserved
    // runner.
    const result = await executeAgentRequestV1(
      request,
      claimed,
      scriptedTransport((_req, output) => {
        output.write("ok");
        return { kind: "completed" };
      })
    );
    assert.equal(result.kind, "response");
  });

  void it("enforces per-mode response ceilings on maxResponseBytes", async () => {
    assert.equal(maxResponseBytesCeilingForModeV1("text"), MAX_NORMAL_RESPONSE_BYTES_V1);
    assert.equal(maxResponseBytesCeilingForModeV1("edit"), MAX_NORMAL_RESPONSE_BYTES_V1);
    assert.equal(maxResponseBytesCeilingForModeV1("preflight"), MAX_PREFLIGHT_RESPONSE_BYTES_V1);

    const overCeiling = makeFixture({
      mode: "text",
      maxResponseBytes: MAX_NORMAL_RESPONSE_BYTES_V1 + 1,
    });
    await assert.rejects(
      executeAgentRequestV1(
        overCeiling.request,
        overCeiling.claimed,
        scriptedTransport(() => ({ kind: "completed" }))
      ),
      /maxResponseBytes/
    );

    const invalid = makeFixture({ maxResponseBytes: 0 });
    await assert.rejects(
      executeAgentRequestV1(
        invalid.request,
        invalid.claimed,
        scriptedTransport(() => ({ kind: "completed" }))
      ),
      /maxResponseBytes/
    );
  });

  void it("consumes the reservation's single invocation (invocation-once)", async () => {
    const { request, claimed } = makeFixture();
    const transport = scriptedTransport((_req, output) => {
      output.write("ok");
      return { kind: "completed" };
    });
    const first = await executeAgentRequestV1(request, claimed, transport);
    assert.equal(first.kind, "response");
    await assert.rejects(
      executeAgentRequestV1(request, claimed, transport),
      /invocation-once/
    );
  });

  void it("returns overflow and retains nothing once the byte limit is exceeded", async () => {
    const { request, claimed } = makeFixture({ maxResponseBytes: 8 });
    let writerRef: BoundedResultWriterV1 | undefined;
    const result = await executeAgentRequestV1(
      request,
      claimed,
      scriptedTransport((_req, output) => {
        writerRef = output;
        assert.equal(output.write("12345678"), true);
        assert.equal(output.write("9"), false, "the overflowing write must be refused");
        assert.equal(output.write("more"), false, "an overflowed writer accepts nothing further");
        return { kind: "completed" };
      })
    );
    assert.deepEqual(result, { kind: "overflow" });
    assert.equal(writerRef?.overflowed, true);
  });

  void it("maps caller/provider cancellation and pre-cancelled tokens", async () => {
    const preCancelled = makeFixture({ cancelled: true });
    let invoked = false;
    const preResult = await executeAgentRequestV1(
      preCancelled.request,
      preCancelled.claimed,
      scriptedTransport(() => {
        invoked = true;
        return { kind: "completed" };
      })
    );
    assert.deepEqual(preResult, { kind: "callerCancelled" });
    assert.equal(invoked, false, "a pre-cancelled token never reaches the transport");

    const providerCancelled = makeFixture();
    assert.deepEqual(
      await executeAgentRequestV1(
        providerCancelled.request,
        providerCancelled.claimed,
        scriptedTransport(() => ({ kind: "providerCancelled" }))
      ),
      { kind: "providerCancelled" }
    );

    const callerCancelled = makeFixture();
    assert.deepEqual(
      await executeAgentRequestV1(
        callerCancelled.request,
        callerCancelled.claimed,
        scriptedTransport(() => ({ kind: "callerCancelled" }))
      ),
      { kind: "callerCancelled" }
    );
  });

  void it("marks transport failures with an accurate responseStarted flag", async () => {
    const preResponse = makeFixture();
    assert.deepEqual(
      await executeAgentRequestV1(
        preResponse.request,
        preResponse.claimed,
        scriptedTransport(() => ({ kind: "transportFailure", code: "connectRefused" }))
      ),
      { kind: "transportFailure", code: "connectRefused", responseStarted: false }
    );

    const midResponse = makeFixture();
    assert.deepEqual(
      await executeAgentRequestV1(
        midResponse.request,
        midResponse.claimed,
        scriptedTransport((_req, output) => {
          output.write("partial");
          return { kind: "transportFailure", code: "streamReset" };
        })
      ),
      { kind: "transportFailure", code: "streamReset", responseStarted: true }
    );

    const thrown = makeFixture();
    const thrownResult = await executeAgentRequestV1(
      thrown.request,
      thrown.claimed,
      {
        runnerId: "scripted-transport", // must match the reserved runner
        invoke: () => Promise.reject(new Error("boom")),
      }
    );
    assert.deepEqual(thrownResult, {
      kind: "transportFailure",
      code: "transportException",
      responseStarted: false,
    });
  });

  /**
   * Item 14: a transport-flagged network fault (dropped HTTP/2 connection,
   * DNS failure, TLS handshake failure) forces `responseStarted` false even
   * though bytes were already written — the pipe broke, not the model, so
   * those bytes are a truncated frame fragment, not partial output. Every
   * OTHER transport failure keeps the unchanged byte-count heuristic (see
   * "streamReset" above, which stays `responseStarted: true`).
   */
  void it("treats a flagged network fault as pre-response for fallback purposes, even with partial bytes", async () => {
    const midResponseNetworkFault = makeFixture();
    assert.deepEqual(
      await executeAgentRequestV1(
        midResponseNetworkFault.request,
        midResponseNetworkFault.claimed,
        scriptedTransport((_req, output) => {
          output.write("partial fragment of a frame that will never complete");
          return {
            kind: "transportFailure",
            code: "copilotRequestFailed",
            detail: "net::ERR_HTTP2_PROTOCOL_ERROR",
            networkFault: true,
          };
        })
      ),
      {
        kind: "transportFailure",
        code: "copilotRequestFailed",
        responseStarted: false,
        detail: "net::ERR_HTTP2_PROTOCOL_ERROR",
        networkFault: true,
      }
    );

    // A transport that throws a raw network error (rather than resolving a
    // `transportFailure` exit itself) gets the same treatment, classified
    // defensively by the broker.
    const thrownNetworkFault = makeFixture();
    const thrownResult = await executeAgentRequestV1(thrownNetworkFault.request, thrownNetworkFault.claimed, {
      runnerId: "scripted-transport",
      invoke: (_req, output) => {
        output.write("partial");
        const err = new Error("socket hang up") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        return Promise.reject(err);
      },
    });
    assert.deepEqual(thrownResult, {
      kind: "transportFailure",
      code: "transportException",
      responseStarted: false,
      networkFault: true,
    });
  });

  void it("rejects invalid UTF-8 output instead of sealing it lossily", async () => {
    const { request, claimed } = makeFixture();
    const result = await executeAgentRequestV1(
      request,
      claimed,
      scriptedTransport((_req, output) => {
        output.write(Buffer.from([0xff, 0xfe, 0x41]));
        return { kind: "completed" };
      })
    );
    assert.deepEqual(result, {
      kind: "transportFailure",
      code: "invalidUtf8Output",
      responseStarted: true,
    });
  });

  void it("spools large sealed responses through the private claim-once store", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-spool-"));
    try {
      const store = createBoundedResultStoreV1({ rootDir });
      const { request, claimed } = makeFixture({ maxResponseBytes: 4096 });
      const text = "x".repeat(1000);
      const result = await executeAgentRequestV1(
        request,
        claimed,
        scriptedTransport((_req, output) => {
          output.write(text);
          return { kind: "completed" };
        }),
        { spoolStore: store, spoolThresholdBytes: 100 }
      );
      assert.equal(result.kind, "response");
      if (result.kind !== "response" || result.payload.storage !== "spool") {
        assert.fail("expected a spooled payload above the threshold");
      }
      const ref = result.payload.spoolRef;
      assert.equal(ref.byteLength, 1000);
      assert.deepEqual(
        {
          actionKey: ref.actionKey,
          operationId: ref.operationId,
          attemptId: ref.attemptId,
          taskBindingId: ref.taskBindingId,
          chatDocumentId: ref.chatDocumentId,
        },
        request.correlation
      );

      const claimResult = await store.claimSpoolOnce(ref, request.correlation);
      assert.ok(claimResult.ok, "the first claim must succeed");
      if (claimResult.ok) {
        assert.equal(claimResult.utf8Text, text);
      }
      const secondClaim = await store.claimSpoolOnce(ref, request.correlation);
      assert.deepEqual(secondClaim, { ok: false, code: "spoolAlreadyClaimed" });
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("falls back to sealing in memory when the spool store's write fails, instead of discarding the response", async () => {
    const { request, claimed } = makeFixture({ maxResponseBytes: 4096 });
    const text = "x".repeat(1000);
    const failingStore: BoundedResultStoreV1 = {
      storeId: "failing-store",
      writeSpool: () => Promise.reject(new Error("disk full")),
      claimSpoolOnce: () => Promise.reject(new Error("unused")),
      removeSpool: () => Promise.reject(new Error("unused")),
      expireStaleSpools: () => Promise.reject(new Error("unused")),
    };
    const result = await executeAgentRequestV1(
      request,
      claimed,
      scriptedTransport((_req, output) => {
        output.write(text);
        return { kind: "completed" };
      }),
      { spoolStore: failingStore, spoolThresholdBytes: 100 }
    );
    assert.equal(result.kind, "response");
    if (result.kind !== "response" || result.payload.storage !== "memory") {
      assert.fail("expected an in-memory-sealed payload, not a terminal transportFailure");
    }
    assert.equal(result.payload.utf8Text, text);
    assert.equal(result.payload.byteLength, 1000);
    assert.equal(result.payload.sha256, createHash("sha256").update(text, "utf8").digest("hex"));
  });

  void it("createBoundedResultWriterV1 counts bytes exactly and discards on overflow", () => {
    const writer = createBoundedResultWriterV1(10);
    assert.equal(writer.write("12345"), true);
    assert.equal(writer.bytesWritten, 5);
    assert.equal(writer.write("67890"), true);
    assert.equal(writer.overflowed, false);
    assert.equal(writer.write("!"), false);
    assert.equal(writer.overflowed, true);
  });
});
