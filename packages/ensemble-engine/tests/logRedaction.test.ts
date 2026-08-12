/**
 * Token/key redaction tests (plan Part 11): every recognized secret shape is
 * stripped from log lines, observability identifiers survive, and the
 * redacting sink wrapper is what callers actually receive.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRedactingLogSinkV1, redactSecretsV1 } from "../src/logRedactionV1";

test("authorization scheme credentials are redacted", () => {
  const line = "request headers: authorization: Bearer sess-abc123DEF456ghi789 accept: json";
  const redacted = redactSecretsV1(line);
  assert.ok(!redacted.includes("sess-abc123DEF456ghi789"), redacted);
  assert.ok(redacted.includes("[REDACTED]"), redacted);
  assert.ok(redacted.includes("accept: json"), "non-secret text survives");
  assert.ok(redactSecretsV1("Basic dXNlcjpwYXNz00").includes("Basic [REDACTED]"));
});

test("secret-bearing field assignments are redacted in JSON-ish and query-ish text", () => {
  const json = '{"key": "super-secret-material", "keyKind": "sandbox:e2b"}';
  const redactedJson = redactSecretsV1(json);
  assert.ok(!redactedJson.includes("super-secret-material"), redactedJson);
  assert.ok(redactedJson.includes('"keyKind": "sandbox:e2b"'), "keyKind is metadata, not material");

  const query = "callback?refreshToken=rt-0f9e8d7c6b5a&state=xyz";
  const redactedQuery = redactSecretsV1(query);
  assert.ok(!redactedQuery.includes("rt-0f9e8d7c6b5a"), redactedQuery);
  assert.ok(redactedQuery.includes("state=xyz"), "non-secret query params survive");
});

test("known credential shapes are redacted by prefix", () => {
  const line =
    "keys seen: sk-abcdef12345678 ghp_ABCDEFGH12345678 github_pat_11AAAA_abcdef123456 " +
    "e2b_0123456789abcdef AIzaSyA-1234567890abc xoxb-1234-abcdefgh " +
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZ25hdHVyZQ";
  const redacted = redactSecretsV1(line);
  for (const secret of [
    "sk-abcdef12345678",
    "ghp_ABCDEFGH12345678",
    "github_pat_11AAAA_abcdef123456",
    "e2b_0123456789abcdef",
    "AIzaSyA-1234567890abc",
    "xoxb-1234-abcdefgh",
    "eyJhbGciOiJIUzI1NiJ9",
  ]) {
    assert.ok(!redacted.includes(secret), `${secret} must not survive: ${redacted}`);
  }
});

test("hex observability identifiers are NOT redacted", () => {
  const attemptKey = "a".repeat(64);
  const line = `attempt ${attemptKey} reconciled as executed for task 0123456789abcdef`;
  assert.equal(redactSecretsV1(line), line);
});

test("the redacting sink wrapper redacts every line before the raw sink sees it", () => {
  const lines: string[] = [];
  const sink = createRedactingLogSinkV1((line) => lines.push(line));
  sink("POST /v1/auth/exchange body {\"authorizationCode\": \"code-123-abc\"} -> 200");
  sink("plain line with no secrets");
  assert.equal(lines.length, 2);
  assert.ok(!(lines[0] as string).includes("code-123-abc"), lines[0]);
  assert.equal(lines[1], "plain line with no secrets");
});
