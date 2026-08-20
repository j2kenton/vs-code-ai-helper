/**
 * Pins `classifyNetworkFaultV1` (item 14): distinguishes a transport-level
 * network fault (dropped connection, DNS failure, TLS handshake failure,
 * HTTP/2 protocol error) — the pipe broke, not the model — from the provider
 * actually answering, even with a refusal. Deliberately narrow, matching the
 * discipline `isTransportError`/`TRANSPORT_MARKERS` in `utils/quota.ts`
 * document: a broad text heuristic risks misclassifying an opaque provider's
 * echoed content as a network fault.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyNetworkFaultV1 } from "../types/agentExecutionV1";

function errWithCode(code: string, message = "boom"): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

void describe("classifyNetworkFaultV1", () => {
  void it("recognizes VS Code's net::ERR_* message shape (item 14's observed HTTP/2 case)", () => {
    assert.equal(
      classifyNetworkFaultV1(
        new Error(
          "Please check your firewall rules and network connection then try again. " +
            "Error Code: net::ERR_HTTP2_PROTOCOL_ERROR."
        )
      ),
      true
    );
  });

  void it("recognizes DNS, TLS, and connection net::ERR_* variants", () => {
    assert.equal(classifyNetworkFaultV1(new Error("net::ERR_NAME_NOT_RESOLVED")), true);
    assert.equal(classifyNetworkFaultV1(new Error("net::ERR_SSL_PROTOCOL_ERROR")), true);
    assert.equal(classifyNetworkFaultV1(new Error("net::ERR_CONNECTION_RESET")), true);
    assert.equal(classifyNetworkFaultV1(new Error("net::ERR_CERT_AUTHORITY_INVALID")), true);
  });

  void it("recognizes Node/undici error codes", () => {
    assert.equal(classifyNetworkFaultV1(errWithCode("ECONNRESET")), true);
    assert.equal(classifyNetworkFaultV1(errWithCode("ECONNABORTED")), true);
    assert.equal(classifyNetworkFaultV1(errWithCode("ETIMEDOUT")), true);
    assert.equal(classifyNetworkFaultV1(errWithCode("ENOTFOUND")), true);
    assert.equal(classifyNetworkFaultV1(errWithCode("EAI_AGAIN")), true);
    assert.equal(classifyNetworkFaultV1(errWithCode("ERR_TLS_CERT_ALTNAME_INVALID")), true);
  });

  void it("recognizes socket hang up by message", () => {
    assert.equal(classifyNetworkFaultV1(new Error("socket hang up")), true);
  });

  void it("does not classify an upstream inference/model fault as a network fault", () => {
    // item 14's Fireworks NaN-in-generation case: a structured 400 from the
    // inference host, not a transport-level drop. It is already
    // fallback-eligible through the ordinary pre-response path (the request
    // never streamed any bytes), so it must NOT also claim networkFault.
    assert.equal(
      classifyNetworkFaultV1(
        new Error(
          'Request Failed: 400 {"error":{"message":"Floating point NaN (not-a-number) is detected in generation."}}'
        )
      ),
      false
    );
  });

  void it("does not classify a plain quota/auth/generic failure as a network fault", () => {
    assert.equal(classifyNetworkFaultV1(new Error("quota exceeded for this billing period")), false);
    assert.equal(classifyNetworkFaultV1(new Error("401 Unauthorized: invalid API key")), false);
    assert.equal(classifyNetworkFaultV1(new Error("model_not_supported")), false);
    assert.equal(classifyNetworkFaultV1(errWithCode("ENOENT", "spawn claude ENOENT")), false);
  });

  void it("returns false for null/undefined/non-Error throws with no matching code or message", () => {
    assert.equal(classifyNetworkFaultV1(null), false);
    assert.equal(classifyNetworkFaultV1(undefined), false);
    assert.equal(classifyNetworkFaultV1("plain string failure"), false);
    assert.equal(classifyNetworkFaultV1({ code: "ECONNRESET" }), false);
  });
});
