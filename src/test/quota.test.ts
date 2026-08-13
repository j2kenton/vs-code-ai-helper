import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure, isQuotaError, isTransportError } from "../utils/quota";

void describe("isQuotaError", () => {
  void it("classifies genuine quota/rate-limit phrasing as quota errors", () => {
    assert.strictEqual(isQuotaError("You have exceeded your current quota"), true);
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later"), true);
    assert.strictEqual(isQuotaError("Your usage limit has been reached"), true);
    assert.strictEqual(isQuotaError("Insufficient credits for this request"), true);
    assert.strictEqual(
      isQuotaError("Claude Code CLI failed: You've hit your session limit · resets 2:30am (Asia/Jerusalem)."),
      true
    );
  });

  void it("does not classify unrelated 'exceeded' errors as quota errors", () => {
    // A bare "exceeded" marker previously caused these to false-positive as
    // quota exhaustion even though they're unrelated failure modes.
    assert.strictEqual(isQuotaError("Maximum context length exceeded"), false);
    assert.strictEqual(
      isQuotaError("Codex prompt is too large for this CLI mode (500 bytes; max 400 bytes exceeded)"),
      false
    );
    assert.strictEqual(isQuotaError("Buffer size exceeded while reading stdout"), false);
  });

  void it("returns false for undefined or unrelated messages", () => {
    assert.strictEqual(isQuotaError(undefined), false);
    assert.strictEqual(isQuotaError("command not found"), false);
  });

  void it("treats an explicit structured signal as an additional (not replacement) quota verdict", () => {
    // A structured error CODE like "rate_limit" (underscored) is not a
    // substring of any QUOTA_MARKERS phrase ("rate limit" with a space,
    // "ratelimit" with none), so the phrase scan alone would miss it — this
    // is exactly the gap claude-cli's structured stream closes (see
    // extractClaudeCliStructuredDiagnostics in cliAgentRunner.ts).
    assert.strictEqual(isQuotaError("You have hit the rate_limit for this account.", true), true);
    // The phrase-based scan is still the fallback: no structural signal, but
    // ordinary quota phrasing must keep working exactly as before.
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later", false), true);
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later"), true);
    // A structural signal alone (with unrelated or absent text) is trusted.
    assert.strictEqual(isQuotaError(undefined, true), true);
    assert.strictEqual(isQuotaError("unrelated failure text", true), true);
    // No structural signal and no matching phrase stays false.
    assert.strictEqual(isQuotaError("unrelated failure text", false), false);
  });
});

void describe("isTransportError", () => {
  void it("recognizes transport-level drops, including opencode's captured wording", () => {
    assert.strictEqual(isTransportError('"Streaming response failed"'), true);
    assert.strictEqual(isTransportError("socket hang up"), true);
    assert.strictEqual(isTransportError("read ECONNRESET"), true);
    assert.strictEqual(isTransportError("TypeError: fetch failed"), true);
    assert.strictEqual(isTransportError("Premature close"), true);
  });

  void it("stays narrow enough not to fire on ordinary failures", () => {
    // The list is deliberately tight: for providers whose failure detail is
    // still raw stdout, a loose marker like "network error" or "stream error"
    // would match ordinary source code echoed into the output and spend a
    // backup-model allocation on an unrelated failure.
    assert.strictEqual(isTransportError("Claude Code CLI exited with code 1."), false);
    assert.strictEqual(isTransportError("stream error"), false);
    assert.strictEqual(isTransportError("network error"), false);
    assert.strictEqual(isTransportError(undefined), false);
  });
});

void describe("classifyFailure", () => {
  void it("classifies quota phrasing as quota", () => {
    assert.strictEqual(
      classifyFailure({ errorMessage: "You have exceeded your current quota" }).failureKind,
      "quota"
    );
  });

  void it("classifies server-side unavailability as temporarily-unavailable", () => {
    for (const message of [
      "Service temporarily unavailable",
      "503 Service Unavailable",
      "Too many requests",
      "Overloaded, please try again later",
    ]) {
      assert.strictEqual(
        classifyFailure({ errorMessage: message }).failureKind,
        "temporarily-unavailable",
        `"${message}" must classify temporarily-unavailable`
      );
    }
  });

  // A provider's argv-only prompt transport (e.g. Kimi's `-p`, which has no
  // stdin/file input at all) can reject a prompt outright for being too
  // large for THAT provider's transport — a structural per-provider limit,
  // not a code defect and not quota exhaustion (isQuotaError deliberately
  // excludes this exact phrasing above, in the "does not classify unrelated
  // 'exceeded' errors" test). It IS safe to cascade to a backup model on,
  // since a different provider very likely has a higher or no such ceiling —
  // the same reasoning that makes "temporarily-unavailable" cascade-eligible.
  void it("classifies a provider's own prompt-too-large rejection as temporarily-unavailable", () => {
    assert.strictEqual(
      classifyFailure({
        errorMessage:
          "Kimi Code CLI prompt is too large for this CLI mode (118611 bytes; max 20000 bytes). " +
          "Reduce context or choose a provider that accepts stdin prompts.",
      }).failureKind,
      "temporarily-unavailable"
    );
  });

  // classifyFailure deliberately does NOT recognize transport phrases
  // ("streaming response failed", "fetch failed", etc.) at all — it is
  // shared with Copilot and has no provider context, so it cannot tell a
  // structured-stream CLI (whose diagnostic text is scoped to parsed error
  // events) from an opaque one (whose diagnostic text IS raw stdout/model
  // prose), a distinction that matters enormously for whether a transport
  // phrase match is trustworthy. See applyTransportTransience
  // (cliAgentRunner.ts), which has that context and does this instead.
  void it("leaves a transport-sounding message generic — TRANSPORT_MARKERS is not checked here", () => {
    assert.strictEqual(
      classifyFailure({ errorMessage: "OpenCode CLI failed: UnknownError: Streaming response failed" })
        .failureKind,
      "generic"
    );
  });

  void it("still lets quota win over an incidental transport phrase in the same message", () => {
    // Retrying or failing over on a rate-limited request just re-hits the
    // limit — isQuotaError is checked first regardless of anything else.
    assert.strictEqual(
      classifyFailure({ errorMessage: "Rate limit exceeded; streaming response failed" }).failureKind,
      "quota"
    );
  });

  // Regression coverage for a review finding: the text-mode backup-cascade
  // gate (runnerRegistry.ts) keys on failureKind ALONE with no auth check of
  // its own — unlike the implementation-mode gate, which separately
  // consults an authFailure verdict before ever looking at failureKind. That
  // means THIS function is the only thing standing between an
  // authentication failure and a cascade through every configured backup
  // model on the text/review path, for any message that also happens to
  // match a TEMPORARY_MARKERS phrase (e.g. "401 Unauthorized: service
  // temporarily unavailable" — note "temporarily unavailable" is a
  // substring of that, even though "service unavailable" alone is not).
  // Scoping applyTransportTransience's own auth guard (in cliAgentRunner.ts)
  // is not sufficient on its own: it only ever sees a failureKind this
  // function has already decided, and never demotes one back down.
  void it("never promotes an authentication failure to temporarily-unavailable via a temporary marker", () => {
    for (const message of [
      "401 Unauthorized: service temporarily unavailable",
      "Not authorized to perform this action; please try again later",
    ]) {
      assert.strictEqual(
        classifyFailure({ errorMessage: message }).failureKind,
        "generic",
        `"${message}" must stay generic (terminal), not cascade-eligible`
      );
    }
  });

  void it("uses authDiagnosticText over errorMessage to decide the auth gate", () => {
    // errorMessage simulates the CLI path: a clean, transient diagnostic with
    // the provider's login hint appended (a login hint always contains
    // "log in"/"API key"-style wording, which isAuthenticationFailure
    // matches on its own — see toFriendlyError in cliAgentRunner.ts).
    // authDiagnosticText is the same text WITHOUT the hint — what
    // toFriendlyError captured before appending it. Scanning errorMessage
    // directly would let the appended hint alone force isAuth=true and
    // suppress the TEMPORARY_MARKERS promotion below, even though the real
    // diagnostic never said anything about authentication — the same
    // self-reinforcing loop the hint/diagnosticText split exists to prevent
    // elsewhere, just unaddressed here until now.
    const failureKind = classifyFailure({
      errorMessage: "Service temporarily unavailable. Run `opencode` and use /connect to log in.",
      authDiagnosticText: "Service temporarily unavailable.",
    }).failureKind;

    assert.strictEqual(failureKind, "temporarily-unavailable");
  });

  void it("leaves unrelated failures generic", () => {
    assert.strictEqual(classifyFailure({ errorMessage: "exited with code 1" }).failureKind, "generic");
    assert.strictEqual(classifyFailure({}).failureKind, "generic");
  });

  void it("preserves fields it does not own", () => {
    // The spread is what carries the runner's pre-hint auth verdict through to
    // the backup-cascade gate without any plumbing here.
    const classified = classifyFailure({
      errorMessage: "boom",
      authFailure: true,
      authDiagnosticText: "boom",
    });
    assert.strictEqual(classified.authFailure, true);
    assert.strictEqual(classified.authDiagnosticText, "boom");
  });
});
