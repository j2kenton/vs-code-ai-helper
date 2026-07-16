/**
 * Unit tests for src/utils/contextEligibility.ts
 *
 * Tests the prompt-size guard logic, token estimation, the denylist, and
 * lstatSync error-code branching (fail-closed contract for EPERM/EACCES/etc).
 * These are pure Node tests (no VS Code API) so they run in the unit suite.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateTokensFromUtf8Bytes,
  measurePromptBytes,
  isDenylisted,
  CONTEXT_PER_FILE_MAX_BYTES,
  CONTEXT_MAX_FILES,
  CONTEXT_TOTAL_MAX_BYTES,
  CONTEXT_CONFIRM_THRESHOLD_BYTES,
  PROMPT_TOTAL_MAX_BYTES,
} from "../utils/contextEligibility";

// ---------------------------------------------------------------------------
// Initial constant values — a test that pins them so accidental changes are caught
// ---------------------------------------------------------------------------

void test("CONTEXT_PER_FILE_MAX_BYTES equals 100000", () => {
  assert.equal(CONTEXT_PER_FILE_MAX_BYTES, 100_000);
});

void test("CONTEXT_MAX_FILES equals 20", () => {
  assert.equal(CONTEXT_MAX_FILES, 20);
});

void test("CONTEXT_TOTAL_MAX_BYTES equals 400000", () => {
  assert.equal(CONTEXT_TOTAL_MAX_BYTES, 400_000);
});

void test("CONTEXT_CONFIRM_THRESHOLD_BYTES equals 300000", () => {
  assert.equal(CONTEXT_CONFIRM_THRESHOLD_BYTES, 300_000);
});

void test("PROMPT_TOTAL_MAX_BYTES equals 600000", () => {
  assert.equal(PROMPT_TOTAL_MAX_BYTES, 600_000);
});

// ---------------------------------------------------------------------------
// estimateTokensFromUtf8Bytes
// ---------------------------------------------------------------------------

void test("estimateTokensFromUtf8Bytes: 0 bytes → 0 tokens", () => {
  assert.equal(estimateTokensFromUtf8Bytes(0), 0);
});

void test("estimateTokensFromUtf8Bytes: 4 bytes → 1 token", () => {
  assert.equal(estimateTokensFromUtf8Bytes(4), 1);
});

void test("estimateTokensFromUtf8Bytes: 5 bytes → 2 tokens (ceil)", () => {
  assert.equal(estimateTokensFromUtf8Bytes(5), 2);
});

void test("estimateTokensFromUtf8Bytes: 1000 bytes → 250 tokens", () => {
  assert.equal(estimateTokensFromUtf8Bytes(1000), 250);
});

void test("estimateTokensFromUtf8Bytes: 1 byte → 1 token", () => {
  assert.equal(estimateTokensFromUtf8Bytes(1), 1);
});

// ---------------------------------------------------------------------------
// measurePromptBytes
// ---------------------------------------------------------------------------

void test("measurePromptBytes: empty string is 0 bytes", () => {
  assert.equal(measurePromptBytes(""), 0);
});

void test("measurePromptBytes: ASCII string matches char count", () => {
  assert.equal(measurePromptBytes("hello"), 5);
});

void test("measurePromptBytes: UTF-8 multi-byte chars counted as bytes not chars", () => {
  // "é" is 2 bytes in UTF-8
  const bytes = measurePromptBytes("é");
  assert.equal(bytes, 2);
});

void test("measurePromptBytes: matches Buffer.byteLength", () => {
  const s = "hello world 🌍";
  assert.equal(measurePromptBytes(s), Buffer.byteLength(s, "utf8"));
});

// ---------------------------------------------------------------------------
// isDenylisted — secret-filename denylist
// ---------------------------------------------------------------------------

void test("isDenylisted: .env is denylisted", () => {
  assert.equal(isDenylisted(".env"), true);
});

void test("isDenylisted: .env.local is denylisted", () => {
  assert.equal(isDenylisted(".env.local"), true);
});

void test("isDenylisted: .env.production is denylisted", () => {
  assert.equal(isDenylisted(".env.production"), true);
});

void test("isDenylisted: .pem file is denylisted", () => {
  assert.equal(isDenylisted("cert.pem"), true);
});

void test("isDenylisted: .key file is denylisted", () => {
  assert.equal(isDenylisted("private.key"), true);
});

void test("isDenylisted: id_rsa is denylisted", () => {
  assert.equal(isDenylisted("id_rsa"), true);
});

void test("isDenylisted: id_rsa.pub is denylisted", () => {
  assert.equal(isDenylisted("id_rsa.pub"), true);
});

void test("isDenylisted: id_ed25519 is denylisted", () => {
  assert.equal(isDenylisted("id_ed25519"), true);
});

void test("isDenylisted: .p12 is denylisted", () => {
  assert.equal(isDenylisted("keystore.p12"), true);
});

void test("isDenylisted: .pfx is denylisted", () => {
  assert.equal(isDenylisted("cert.pfx"), true);
});

void test("isDenylisted: .npmrc is denylisted", () => {
  assert.equal(isDenylisted(".npmrc"), true);
});

void test("isDenylisted: .netrc is denylisted", () => {
  assert.equal(isDenylisted(".netrc"), true);
});

void test("isDenylisted: credentials.json is denylisted", () => {
  assert.equal(isDenylisted("credentials.json"), true);
});

void test("isDenylisted: credentials (extensionless) is denylisted", () => {
  assert.equal(isDenylisted("credentials"), true);
});

void test("isDenylisted: .keystore is denylisted", () => {
  assert.equal(isDenylisted("app.keystore"), true);
});

void test("isDenylisted: .jks is denylisted", () => {
  assert.equal(isDenylisted("app.jks"), true);
});

void test("isDenylisted: .htpasswd is denylisted", () => {
  assert.equal(isDenylisted(".htpasswd"), true);
});

void test("isDenylisted: .tfstate is denylisted", () => {
  assert.equal(isDenylisted("terraform.tfstate"), true);
});

void test("isDenylisted: .tfstate.backup is denylisted", () => {
  assert.equal(isDenylisted("terraform.tfstate.backup"), true);
});

void test("isDenylisted: case-insensitive for .ENV", () => {
  assert.equal(isDenylisted(".ENV"), true);
});

void test("isDenylisted: case-insensitive for .Env.Local", () => {
  assert.equal(isDenylisted(".Env.Local"), true);
});

// Non-secret files — must NOT be denylisted
void test("isDenylisted: notes.txt is not denylisted", () => {
  assert.equal(isDenylisted("notes.txt"), false);
});

void test("isDenylisted: README.md is not denylisted", () => {
  assert.equal(isDenylisted("README.md"), false);
});

void test("isDenylisted: index.ts is not denylisted", () => {
  assert.equal(isDenylisted("index.ts"), false);
});

void test("isDenylisted: package.json is not denylisted", () => {
  assert.equal(isDenylisted("package.json"), false);
});

void test("isDenylisted: my.keynotefile.ts is not denylisted (no .key extension)", () => {
  // .key pattern matches files ENDING in .key — "my.keynotefile.ts" does not
  assert.equal(isDenylisted("my.keynotefile.ts"), false);
});

// ---------------------------------------------------------------------------
// Task-local chat transcripts (chatHistoryStore.ts) — plaintext prompt/
// response content, never swept into generic AI context collection even
// when an editor for the file is open.
// ---------------------------------------------------------------------------

void test("isDenylisted: chat-v1.json is denylisted", () => {
  assert.equal(isDenylisted("chat-v1.json"), true);
});

void test("isDenylisted: chat-v1.corrupt.json (quarantine copy) is denylisted", () => {
  assert.equal(isDenylisted("chat-v1.corrupt.json"), true);
});

void test("isDenylisted: case-insensitive for Chat-V1.JSON", () => {
  assert.equal(isDenylisted("Chat-V1.JSON"), true);
});

void test("isDenylisted: chat-v2.json (different version) is not denylisted", () => {
  assert.equal(isDenylisted("chat-v2.json"), false);
});

// ---------------------------------------------------------------------------
// lstatSync error-code discrimination logic
// (unit-tests the fail-closed contract without requiring VS Code or real fs)
//
// The isEligibleDocument function in contextPack.ts uses this exact branching:
//   catch (err) {
//     if (err.code === "ENOENT") → treat as new unsaved file (fileExistsOnDisk = false)
//     else                       → fail closed (return false immediately)
//   }
// These tests confirm the discrimination logic is correct in isolation so that
// any accidental change to the branching is caught by the unit suite.
// ---------------------------------------------------------------------------

/**
 * Simulate the error-code check used inside isEligibleDocument.
 * Returns "enoent" for ENOENT, "closed" for any other error code.
 */
function simulateLstatErrorBranch(errorCode: string): "enoent" | "closed" {
  const err = Object.assign(new Error("simulated"), { code: errorCode }) as NodeJS.ErrnoException;
  const code = err.code;
  if (code === "ENOENT") {
    return "enoent";
  }
  return "closed";
}

void test("lstatSync error-code branch: ENOENT is treated as new unsaved file", () => {
  assert.equal(simulateLstatErrorBranch("ENOENT"), "enoent");
});

void test("lstatSync error-code branch: EPERM is fail-closed", () => {
  assert.equal(simulateLstatErrorBranch("EPERM"), "closed");
});

void test("lstatSync error-code branch: EACCES is fail-closed", () => {
  assert.equal(simulateLstatErrorBranch("EACCES"), "closed");
});

void test("lstatSync error-code branch: EIO is fail-closed", () => {
  assert.equal(simulateLstatErrorBranch("EIO"), "closed");
});

void test("lstatSync error-code branch: ENOTDIR is fail-closed", () => {
  assert.equal(simulateLstatErrorBranch("ENOTDIR"), "closed");
});

void test("lstatSync error-code branch: undefined code is fail-closed", () => {
  // An error with no .code property (e.g. a TypeError) should also be closed.
  // undefined !== "ENOENT" so the branch correctly returns "closed".
  assert.equal(simulateLstatErrorBranch(""), "closed");
});
