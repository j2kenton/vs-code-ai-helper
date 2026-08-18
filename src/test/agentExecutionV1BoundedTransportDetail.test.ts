/**
 * Pins `boundedTransportDetailV1`'s sanitization contract (plan §3.2/§2.2):
 * a caught, unknown thrown value becomes a short, single-line, secret-free
 * cause string safe to carry on a `transportFailure` outcome.
 *
 * `copilotLanguageModelRunner.ts` and `languageModelToolSessionV1.ts` used to
 * discard the caught error entirely (`catch {}`), so a real failure surfaced
 * only as the bare code `copilotRequestFailed` with nothing to diagnose it
 * by. This function is what both sites now call from `catch (error)`; these
 * fixtures are what keep it from leaking a credential, token, or private
 * path into a run log or notification while still doing that job.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedTransportDetailV1 } from "../types/agentExecutionV1";

void describe("boundedTransportDetailV1", () => {
  void it("extracts the message from an Error object", () => {
    assert.equal(boundedTransportDetailV1(new Error("request failed: 429 too many requests")), "request failed: 429 too many requests");
  });

  void it("uses a string throw directly", () => {
    assert.equal(boundedTransportDetailV1("plain string failure"), "plain string failure");
  });

  void it("stringifies a non-Error, non-string throw", () => {
    assert.equal(boundedTransportDetailV1({ code: "ECONNRESET" }), "[object Object]");
    assert.equal(boundedTransportDetailV1(42), "42");
  });

  void it("returns undefined for null/undefined/empty throws", () => {
    assert.equal(boundedTransportDetailV1(null), undefined);
    assert.equal(boundedTransportDetailV1(undefined), undefined);
    assert.equal(boundedTransportDetailV1(new Error("")), undefined);
    assert.equal(boundedTransportDetailV1("   "), undefined);
  });

  void it("preserves quota and payload-limit causes verbatim — these are the actionable ones", () => {
    assert.equal(
      boundedTransportDetailV1(new Error("quota exceeded for this billing period")),
      "quota exceeded for this billing period"
    );
    assert.equal(
      boundedTransportDetailV1(new Error("request payload exceeds the 128000 token context limit")),
      "request payload exceeds the 128000 token context limit"
    );
  });

  void it("redacts a Bearer/Authorization header value", () => {
    const detail = boundedTransportDetailV1(
      new Error('request failed, header Authorization: Bearer sk-abcdefghijklmnopqrstuvwx rejected')
    );
    assert.ok(detail);
    assert.ok(!detail.includes("abcdefghijklmnopqrstuvwx"), detail);
    assert.ok(detail.includes("[redacted"), detail);
  });

  void it("redacts an API-key-shaped token embedded in free text", () => {
    const detail = boundedTransportDetailV1(new Error("auth error: api_key=sk-live-1234567890abcdef rejected"));
    assert.ok(detail);
    assert.ok(!detail.includes("1234567890abcdef"), detail);
  });

  void it("redacts a credential-bearing URI", () => {
    const detail = boundedTransportDetailV1(
      new Error("failed to fetch https://user:hunter2secret@api.example.com/v1/complete")
    );
    assert.ok(detail);
    assert.ok(!detail.includes("hunter2secret"), detail);
    assert.ok(detail.includes("https://[redacted]@api.example.com"), detail);
  });

  void it("redacts a Windows private app-storage path", () => {
    const detail = boundedTransportDetailV1(
      new Error(
        "ENOENT: C:\\Users\\jjk61\\AppData\\Roaming\\Code\\User\\globalStorage\\j2kenton.vs-code-ai-helper\\secret.json not found"
      )
    );
    assert.ok(detail);
    assert.ok(!detail.includes("jjk61"), detail);
    assert.ok(detail.includes("[redacted-path]"), detail);
  });

  void it("redacts a POSIX private home path", () => {
    const detail = boundedTransportDetailV1(new Error("read failed: /home/jkenton/.config/app/creds.json"));
    assert.ok(detail);
    assert.ok(!detail.includes("jkenton"), detail);
    assert.ok(detail.includes("[redacted-path]"), detail);
  });

  void it("flattens multiline text into one line", () => {
    assert.equal(boundedTransportDetailV1(new Error("line one\nline two\r\nline three")), "line one line two line three");
  });

  void it("strips control characters other than the whitespace this collapses", () => {
    const withControlChars = "before\u0001\u0007\u001Bafter";
    assert.equal(boundedTransportDetailV1(new Error(withControlChars)), "before after");
  });

  void it("bounds over-length input to maxChars with an ellipsis", () => {
    const longMessage = "x".repeat(500);
    const detail = boundedTransportDetailV1(new Error(longMessage));
    assert.ok(detail);
    assert.equal(detail.length, 200);
    assert.ok(detail.endsWith("…"), detail);
  });

  void it("bounds over-length Unicode (astral-plane) input to the UTF-16 code-unit cap", () => {
    const longUnicode = "\u{1F600}".repeat(150); // astral-plane emoji, 2 UTF-16 code units each
    const detail = boundedTransportDetailV1(new Error(longUnicode), 50);
    assert.ok(detail);
    assert.equal(detail.length, 50);
    assert.ok(detail.endsWith("…"), detail);
  });

  void it("respects a custom maxChars", () => {
    const detail = boundedTransportDetailV1(new Error("0123456789"), 5);
    assert.equal(detail, "0123…");
  });

  void it("prefixes a distinctive error name for classification", () => {
    const error = new TypeError("cannot read property 'foo' of undefined");
    assert.equal(boundedTransportDetailV1(error), "TypeError: cannot read property 'foo' of undefined");
  });

  void it("does not prefix the generic Error name", () => {
    const error = new Error("plain failure");
    error.name = "Error";
    assert.equal(boundedTransportDetailV1(error), "plain failure");
  });

  void it("redacts a terminated raw envelope echoed in an error message", () => {
    const detail = boundedTransportDetailV1(
      new Error(
        'response rejected: <<<ENSEMBLE_AI_RESULT_V1>>>{"secretPrompt":"do the thing"}<<<END_ENSEMBLE_AI_RESULT_V1>>> was not valid'
      )
    );
    assert.ok(detail);
    assert.ok(!detail.includes("secretPrompt"), detail);
    assert.ok(detail.includes("[redacted-content]"), detail);
  });

  void it("redacts an unterminated raw envelope echoed in an error message", () => {
    const detail = boundedTransportDetailV1(
      new Error('response rejected: <<<ENSEMBLE_AI_RESULT_V1>>>{"secretPrompt":"do the thing"')
    );
    assert.ok(detail);
    assert.ok(!detail.includes("secretPrompt"), detail);
    assert.ok(detail.includes("[redacted-content]"), detail);
  });

  void it("redacts a fenced code block echoed in an error message", () => {
    const detail = boundedTransportDetailV1(
      new Error("parse failed on ```\nraw provider response body\n``` near line 2")
    );
    assert.ok(detail);
    assert.ok(!detail.includes("raw provider response body"), detail);
    assert.ok(detail.includes("[redacted-content]"), detail);
  });
});
