/**
 * CLI failure classification: how a non-zero CLI exit becomes an auth verdict,
 * a failureKind, and a user-facing message.
 *
 * Three real production bugs are covered here, all observed together on the
 * same six runs (a plan-review task that stalled for a day and never fell back
 * to any of its four configured backup models):
 *
 *  1. toFriendlyError scanned the CLI's ENTIRE stdout for the provider's
 *     authErrorMarkers. For opencode that stdout is a `--format json` event
 *     stream which re-emits the full text of every file the agent reads, and
 *     the marker list contains "api key", "login" and "authenticate" — so a
 *     mid-stream transport drop was reported to the user as a billing problem
 *     purely because the agent had read a file whose prose mentioned an API
 *     key. Four of the six failed runs tripped this; the two that did not were
 *     exactly the two that died before reading any file.
 *
 *  2. The login hint toFriendlyError appends ("...paste the OpenCode API
 *     key.") was folded into errorMessage, which the backup-cascade gate then
 *     regexed with isAuthenticationFailure — whose pattern includes
 *     /api\s*key/i. Any error that tripped bug 1 was therefore guaranteed to
 *     be re-confirmed as an auth failure by Ensemble's own explanatory text.
 *
 *  3. "Streaming response failed" matched no quota or temporary marker, so it
 *     classified "generic", which both cascade gates treat as terminal. A
 *     recoverable network hiccup killed the run outright.
 *
 * Fixtures marked "production capture" are taken verbatim from the recorded
 * run artifacts, including opencode's double-encoded message value.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __testOnly } from "../runners/cliAgentRunner";
import { CliProviderDefinition, getCliProvider } from "../runners/providers";
import { classifyCliFailure, isAuthenticationFailure, isTransportError } from "../utils/quota";

const {
  toFriendlyError,
  extractStructuredCliDiagnostics,
  extractClineStructuredDiagnostics,
  unwrapJsonString,
  applyTransportTransience,
  truncateCliDetail,
} = __testOnly;

/** classifyCliFailure over a failed run, with the empty output such a run has. */
function classifyFailed(errorMessage: string) {
  return classifyCliFailure({ status: "failed" as const, output: "", errorMessage });
}

/**
 * An opencode-shaped provider: structured event stream, and the real marker
 * list from the shipped definition. Deliberately mirrors providers.ts rather
 * than trimming, because the false positive under test comes from the ordinary
 * markers ("api key"/"login"/"authenticate"), not from an exotic one.
 */
const OPENCODE_LIKE: CliProviderDefinition = {
  id: "opencode-cli",
  label: "OpenCode",
  command: "opencode",
  installHint: "Install opencode.",
  loginHint: "Run `opencode` and use /connect.",
  loginHintForModel(model): string {
    return model?.startsWith("opencode-go/")
      ? "OpenCode Go is unavailable to the current OpenCode account. Confirm that the Go subscription is active."
      : "OpenCode Zen is unavailable to the current OpenCode account. Run `opencode` in a terminal, use `/connect`, choose OpenCode Zen, and paste the OpenCode API key. Confirm that Zen billing is enabled, then try again.";
  },
  authErrorMarkers: [
    "not logged in",
    "login",
    "authenticate",
    "api key",
    "unauthorized",
    "no credentials",
    "no provider available",
    "401",
  ],
  signInLabel: "Sign in",
  models: [],
  usesLastMessageFile: false,
  structuredEventStream: "opencode",
  buildArgs(): string[] {
    return ["run", "--format", "json"];
  },
};

/** A cline-shaped provider: structured event stream, its real marker list. */
const CLINE_LIKE: CliProviderDefinition = {
  id: "cline-cli",
  label: "Cline CLI",
  command: "cline",
  installHint: "Install the Cline CLI.",
  loginHint: "Run `cline auth cline-pass` and sign in.",
  authErrorMarkers: [
    "not logged in",
    "login",
    "authenticate",
    "api key",
    "unauthorized",
    "401",
    "no credentials",
  ],
  signInLabel: "Sign in",
  models: [],
  usesLastMessageFile: false,
  structuredEventStream: "cline",
  buildArgs(): string[] {
    return ["--json"];
  },
};

/** A claude-shaped provider: opaque text stdout, no structured stream. */
const OPAQUE_TEXT_LIKE: CliProviderDefinition = {
  id: "claude-cli",
  label: "Claude Code",
  command: "claude",
  installHint: "Install claude.",
  loginHint: "Run `claude` and sign in.",
  authErrorMarkers: ["log in", "login", "authenticate", "api key", "oauth"],
  signInLabel: "Sign in",
  models: [],
  usesLastMessageFile: false,
  buildArgs(): string[] {
    return ["-p"];
  },
};

/**
 * Production capture: the terminal event of every one of the six failed runs.
 * Note the message value is double-encoded — a JSON string whose content is
 * itself a quoted string — and that UnknownError carries no isRetryable field,
 * which is why phrase matching rather than the structural signal is what has
 * to recognize this shape.
 */
const REAL_TRANSPORT_DROP_EVENT = JSON.stringify({
  type: "error",
  timestamp: 1784802824950,
  sessionID: "ses_07179db34ffeLynM2MaU1na4fY",
  error: { name: "UnknownError", data: { message: '"Streaming response failed"' } },
});

/**
 * A tool event carrying file contents back into the stream — the mechanism
 * behind the false positive. opencode echoes a read file's text into several
 * fields of the same event, which is why one 3-line file could produce many
 * marker hits.
 */
const FILE_CONTENTS_ECHO_EVENT = JSON.stringify({
  type: "tool",
  part: {
    type: "tool",
    tool: "read",
    state: {
      output: "const API_KEY = process.env.API_KEY;\nfunction login() { return authenticate(API_KEY); }",
      metadata: {
        preview: "const API_KEY = process.env.API_KEY;",
        display: { text: "…company research using your own Anthropic or OpenAI API key." },
      },
    },
  },
});

void describe("toFriendlyError — structured-stream providers", () => {
  void it("does not diagnose auth from file contents echoed into opencode's event stream", () => {
    // The exact production shape: the agent read an auth-related file, then the
    // stream dropped. Nothing here is an authentication problem.
    const stdout = [FILE_CONTENTS_ECHO_EVENT, REAL_TRANSPORT_DROP_EVENT].join("\n");
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/deepseek-v4-flash-free", 1, "", stdout);

    assert.equal(friendly.authFailure, false);
    assert.doesNotMatch(friendly.message, /paste the OpenCode API key/);
    assert.doesNotMatch(friendly.message, /Zen billing/);
  });

  void it("diagnoses auth from a structured error event in the stream", () => {
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: { message: "No provider available", statusCode: 401, providerID: "opencode" },
      },
    });
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 1, "", stdout);

    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /Zen billing/);
  });

  void it("diagnoses a 401 whose message matches no auth marker, via statusCode alone", () => {
    // A real balance-exhausted 401 reads "Insufficient balance..." and matches
    // NONE of the eight auth markers above. The status code is its only auth
    // signal, so an extractor that emitted just error.data.message would
    // silently downgrade a genuine credentials problem to a generic failure and
    // burn a backup model on it. The production "No provider available" 401
    // matches on both channels, which is exactly why testing against that
    // artifact alone would hide this.
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "Insufficient balance. Manage your billing here: https://opencode.ai/billing",
          statusCode: 401,
        },
      },
    });
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 1, "", stdout);

    assert.equal(friendly.authFailure, true);
  });

  void it("still diagnoses auth from stderr for a structured-stream provider", () => {
    // stderr is empirically always empty for opencode, but scoping the scan to
    // the parsed stream ALONE would silently drop any future stderr reporting.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/grok-4.5",
      1,
      "No provider available (HTTP 401)",
      ""
    );

    assert.equal(friendly.authFailure, true);
  });

  void it("keeps scanning raw stdout for providers without a structured stream", () => {
    // The narrowing is opt-in per provider: an opaque-text CLI has no event
    // stream to scope to, and a marker match in its stdout is still meaningful.
    const friendly = toFriendlyError(
      OPAQUE_TEXT_LIKE,
      undefined,
      1,
      "",
      "Invalid API key · Please run /login"
    );

    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /sign in/i);
  });

  void it("surfaces the parsed error message instead of dumping the raw stream", () => {
    // The raw error message used to be thousands of characters of tool-call
    // JSON with the actual cause buried at the end.
    const stdout = [
      FILE_CONTENTS_ECHO_EVENT,
      JSON.stringify({
        type: "error",
        error: {
          name: "APIError",
          data: {
            message: "No provider available",
            statusCode: 401,
            responseBody: '{"type":"error","error":{"type":"CreditsError"}}',
          },
        },
      }),
    ].join("\n");
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 1, "", stdout);

    assert.match(friendly.message, /APIError: No provider available \(HTTP 401\)/);
    assert.doesNotMatch(friendly.message, /sessionID|metadata|API_KEY/);
  });

  void it("falls back to the raw stream only when stdout is not an event stream at all", () => {
    // Mirrors extractOpencodeFinalOutput's own precedent: if it did not parse
    // as events, it cannot be hiding file-content blobs, and showing it beats
    // showing a bare exit code.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/grok-4.5",
      1,
      "",
      "opencode: unexpected internal error"
    );

    assert.match(friendly.message, /unexpected internal error/);
  });

  void it("diagnoses auth from a plain-text failure that never became an event stream (F1 gap)", () => {
    // opencode failing before it starts streaming, e.g. a rejected connection
    // that never emits a single JSON line. Before this fix, the auth scan
    // (scanSource) was scoped to markerScanText alone whenever the provider
    // was structured — which is empty here, since nothing parsed as an
    // event — silently missing a genuine auth signal that the message (and
    // detail, which already had this same fallback) plainly carries.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/grok-4.5",
      1,
      "",
      "Error: not logged in. Run `opencode auth login`."
    );

    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /Zen billing/);
  });

  void it("does not leak raw stdout into the auth scan once a real event stream was seen", () => {
    // The companion regression guard: a stream that DID parse (even with no
    // error event) must still never fall back to raw stdout for the scan,
    // or the very leak F1 exists to prevent comes back for the empty-scan
    // case specifically.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/grok-4.5",
      1,
      "",
      [
        FILE_CONTENTS_ECHO_EVENT,
        JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
      ].join("\n")
    );

    assert.equal(friendly.authFailure, false);
  });

  void it("reports a bare exit code rather than dumping a parsed stream with no error event", () => {
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 3, "", FILE_CONTENTS_ECHO_EVENT);

    assert.match(friendly.message, /exit code 3/);
    assert.doesNotMatch(friendly.message, /API_KEY/);
  });

  void it("replaces the diagnostic text wholesale via diagnosticTextOverride while still scanning for auth (F10)", () => {
    // The empty-output branch in execCliAgent's close handler has its own
    // "CLI produced no output" wording — this lets it reuse toFriendlyError
    // fully (auth scan, hint-append) instead of hand-rebuilding a
    // CliFriendlyError from separately-copied pieces.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/grok-4.5",
      1,
      "no provider available",
      "",
      undefined,
      "OpenCode CLI produced no output."
    );

    assert.equal(friendly.diagnosticText, "OpenCode CLI produced no output.");
    // The auth scan still runs against the real stderr, independent of the
    // override — this is the whole point of threading it through rather
    // than short-circuiting toFriendlyError entirely.
    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /Zen billing/);
  });

  void it("does not classify a balance-401 as quota", () => {
    // The 401 response body contains "CreditsError", which lowercases into the
    // "credits" quota marker. Keeping responseBody out of the user-facing
    // detail keeps it out of classifyFailure's input too.
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "APIError",
        data: {
          message: "Insufficient balance.",
          statusCode: 401,
          responseBody: '{"type":"error","error":{"type":"CreditsError"}}',
        },
      },
    });
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 1, "", stdout);
    const classified = classifyFailed(friendly.message);

    assert.notEqual(classified.failureKind, "quota");
  });
});

void describe("truncateCliDetail", () => {
  void it("keeps short, few-line text untouched", () => {
    assert.equal(truncateCliDetail("line one\nline two"), "line one\nline two");
  });

  void it("still truncates by line count when lines are short", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateCliDetail(text, 8);

    assert.match(result, /^line 0\n/);
    assert.match(result, /line 19$/);
    assert.ok(result.split("\n").length <= 8);
  });

  void it("bounds a single massive line even though it satisfies the line-count cap (F5 gap)", () => {
    // extractStructuredCliDiagnostics's JSON.stringify(fields)/JSON.stringify(parsed)
    // fallbacks (for an error shape with no recognized fields, or a
    // non-object `error`) can each produce ONE line of arbitrary size —
    // "8 lines or fewer" says nothing about how long any single line is.
    // This is exactly the "megabytes of leaked content in a user-facing
    // error" failure mode the structured scan exists to prevent.
    const hugeLine = `START${"x".repeat(200_000)}END`;
    const result = truncateCliDetail(hugeLine);

    assert.ok(result.length < 5000, `expected a bounded result, got ${result.length} chars`);
    assert.match(result, /^START/);
    assert.match(result, /END$/);
  });

  void it("bounds the combined head+tail result when both are individually large", () => {
    const head = `HEAD${"a".repeat(100_000)}`;
    const middle = Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n");
    const tail = `${"b".repeat(100_000)}TAIL`;
    const result = truncateCliDetail(`${head}\n${middle}\n${tail}`, 8);

    assert.ok(result.length < 5000, `expected a bounded result, got ${result.length} chars`);
    assert.match(result, /^HEAD/);
    assert.match(result, /TAIL$/);
  });

  void it("never expands the input, even for a degenerate maxChars of 0", () => {
    // slice(-0) behaves like slice(0) — the whole string — not an empty one,
    // in JS. A naive Math.floor(maxChars/2) guard alone would make a
    // zero-or-tiny maxChars produce a result LARGER than the input instead
    // of smaller — the opposite of "truncate".
    const text = "x".repeat(100);
    const result = truncateCliDetail(text, 8, 0);

    assert.ok(
      result.length <= text.length,
      `expected a bounded result, got ${result.length} chars for a 100-char input`
    );
  });
});

void describe("unwrapJsonString", () => {
  void it("unwraps one level of opencode's double-encoded message value", () => {
    assert.equal(unwrapJsonString('"Streaming response failed"'), "Streaming response failed");
  });

  void it("leaves an already-plain message untouched", () => {
    assert.equal(unwrapJsonString("Streaming response failed"), "Streaming response failed");
  });

  void it("does not recurse into a message that is itself quoted JSON", () => {
    // A responseBody is legitimately quoted JSON; unwrapping past one level
    // would discard structure rather than reveal it.
    const body = '"{\\"type\\":\\"error\\"}"';
    assert.equal(unwrapJsonString(body), '{"type":"error"}');
  });

  void it("returns the input unchanged on malformed JSON", () => {
    assert.equal(unwrapJsonString('"unterminated'), '"unterminated');
  });
});

void describe("extractStructuredCliDiagnostics", () => {
  void it("reads only error events, never tool events carrying file contents", () => {
    const diagnostics = extractStructuredCliDiagnostics(
      [FILE_CONTENTS_ECHO_EVENT, REAL_TRANSPORT_DROP_EVENT].join("\n")
    );

    assert.doesNotMatch(diagnostics.markerScanText, /API_KEY|authenticate/);
    assert.match(diagnostics.detail, /Streaming response failed/);
    assert.equal(diagnostics.sawAnyEvent, true);
  });

  void it("reports retryability when the provider states it structurally", () => {
    const diagnostics = extractStructuredCliDiagnostics(
      JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { message: "upstream hiccup", isRetryable: true } },
      })
    );

    assert.equal(diagnostics.retryable, true);
  });

  void it("keeps error shapes that carry no message field diagnosable", () => {
    // Several opencode error shapes have no fields at all, so extracting
    // nothing would turn a real failure into a bare exit code.
    const diagnostics = extractStructuredCliDiagnostics(
      JSON.stringify({ type: "error", error: { name: "ProviderNoProvidersError", data: {} } })
    );

    assert.match(diagnostics.markerScanText, /ProviderNoProvidersError/);
    assert.match(diagnostics.detail, /ProviderNoProvidersError/);
  });

  void it("reports sawAnyEvent false for output that is not an event stream, but still surfaces it as detail", () => {
    // F1 gap: sawAnyEvent being false must not mean the content is discarded
    // — plain, non-JSON text is exactly the case unparsedText exists to
    // surface (see extractOpencodeFinalOutput's own long-standing raw-stream
    // precedent for the same reasoning).
    const diagnostics = extractStructuredCliDiagnostics("plain text failure\n");

    assert.equal(diagnostics.sawAnyEvent, false);
    assert.equal(diagnostics.detail, "plain text failure");
  });

  void it("still surfaces trailing plain text as detail even when earlier lines WERE recognized events (F1 gap)", () => {
    // The actual reported gap: opencode streams a few normal events, then
    // dies writing a plain-text failure straight to stdout instead of a
    // structured error event. sawAnyEvent is true here (real events exist),
    // but the ACTUAL failure reason lives only in the unparsed trailing
    // line — a fallback gated on "were there any events" would incorrectly
    // suppress it, exactly what this test guards against.
    const stdout = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Looking into it..." } }),
      "You are not logged in. Run `opencode auth login`.",
    ].join("\n");
    const diagnostics = extractStructuredCliDiagnostics(stdout);

    assert.equal(diagnostics.sawAnyEvent, true);
    assert.match(diagnostics.detail, /not logged in/);
    assert.match(diagnostics.markerScanText, /not logged in/);
  });

  void it("does not let unparsed trailing text override a genuine error event's detail", () => {
    // When a real error event WAS found, the user-facing detail should stay
    // that specific text rather than being diluted with unrelated content.
    const stdout = [
      JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "bad request" } } }),
      "some trailing non-JSON noise",
    ].join("\n");
    const diagnostics = extractStructuredCliDiagnostics(stdout);

    assert.match(diagnostics.detail, /bad request/);
    assert.doesNotMatch(diagnostics.detail, /trailing non-JSON noise/);
    // markerScanText, by contrast, always includes it — it can never be
    // tool/text-event file content (those parse as objects), so there is no
    // leak risk in scanning it for auth markers too.
    assert.match(diagnostics.markerScanText, /trailing non-JSON noise/);
  });

  void it("excludes a cut-off tool-event line from markerScanText but still surfaces it in detail", () => {
    // A mid-stream transport drop truncates whatever line was being written
    // — for a JSON-lines event stream, that is exactly a tool/text event,
    // and a PARTIAL write of one can still carry embedded file content (an
    // auth-flavored preview, here) even though it never finishes parsing.
    // Unlike "some trailing non-JSON noise" above, this line DOES start with
    // "{" — it looks like a cut-off event, not plain text — so it must be
    // excluded from the auth scan even though it never parsed.
    const truncatedToolEvent =
      '{"type":"tool","part":{"type":"tool","tool":"read","state":{"output":"const API_KEY = process.env.API_KEY; function login() { return authenticate(';
    const stdout = [truncatedToolEvent, "connection reset"].join("\n");
    const diagnostics = extractStructuredCliDiagnostics(stdout);

    assert.doesNotMatch(diagnostics.markerScanText, /API_KEY|authenticate|login/);
    assert.match(diagnostics.markerScanText, /connection reset/);
    assert.match(diagnostics.detail, /API_KEY|authenticate|login/);
  });

  void it("keeps responseBody out of detail even via the JSON.stringify(fields) fallback", () => {
    // No `name`, no `message` — the only path that reaches the
    // JSON.stringify(fields) fallback in `text`. Before the fix this
    // re-admitted responseBody (and therefore "CreditsError") into detail,
    // silently reclassifying a credentials/entitlement failure as quota once
    // it reached classifyFailure via errorMessage.
    const diagnostics = extractStructuredCliDiagnostics(
      JSON.stringify({
        type: "error",
        error: {
          data: {
            responseBody: '{"error":"CreditsError: insufficient balance"}',
            statusCode: 401,
          },
        },
      })
    );

    assert.doesNotMatch(diagnostics.detail, /CreditsError|responseBody/);
    // markerScanText is unaffected — responseBody there is intentional (see
    // "diagnoses a 401 whose message matches no auth marker" above).
    assert.match(diagnostics.markerScanText, /CreditsError/);
  });
});

/**
 * A cline tool-call event re-emitting a read file's contents verbatim —
 * shape verified live against cline 3.0.46 (a `read_files` tool call on a
 * file containing "api key"/"login"/"authenticate" text echoed those words
 * straight back out into the event stream's `output` field).
 */
const CLINE_FILE_CONTENTS_ECHO_EVENT = JSON.stringify({
  type: "agent_event",
  event: {
    type: "content_end",
    contentType: "tool",
    toolCallId: "call_1",
    toolName: "read_files",
    output: [
      {
        query: "secret.txt",
        result:
          "1 | This document mentions an api key and says you must login or authenticate before use.",
        success: true,
      },
    ],
  },
});

/** A genuine cline CLI/provider failure — verified live shape. */
const CLINE_FAILED_RUN_RESULT_EVENT = JSON.stringify({
  type: "run_result",
  finishReason: "error",
  text: "invalid model format. Expected format: modelType/model",
  model: { id: "deepseek-v4-pro", provider: "cline-pass" },
});

void describe("extractClineStructuredDiagnostics", () => {
  void it("reads only a failed run's own text, never tool events carrying file contents", () => {
    const diagnostics = extractClineStructuredDiagnostics(
      [CLINE_FILE_CONTENTS_ECHO_EVENT, CLINE_FAILED_RUN_RESULT_EVENT].join("\n")
    );

    assert.doesNotMatch(diagnostics.markerScanText, /api key|authenticate|login/);
    assert.match(diagnostics.detail, /invalid model format/);
    assert.equal(diagnostics.sawAnyEvent, true);
  });

  void it("reads a top-level error event's message", () => {
    const diagnostics = extractClineStructuredDiagnostics(
      JSON.stringify({ type: "error", message: "not logged in" })
    );

    assert.match(diagnostics.markerScanText, /not logged in/);
    assert.match(diagnostics.detail, /not logged in/);
  });

  void it("ignores a benign error line that coexists with a successful run (hook-dispatch noise)", () => {
    // Observed live: "hook dispatch failed: session.hook requires a valid
    // hook event payload" appears as a bare {"type":"error",...} line even
    // on exit-0 runs. This function still surfaces it (extraction has no way
    // to know the exit code) — the caller (toFriendlyError, only invoked on
    // a non-zero exit / empty output) is what keeps this from misclassifying
    // a successful run, so this test only pins the extractor's own behavior:
    // it must not crash and must still surface the noise line as detail.
    const diagnostics = extractClineStructuredDiagnostics(
      JSON.stringify({
        type: "error",
        message: "hook dispatch failed: session.hook requires a valid hook event payload",
      })
    );

    assert.equal(diagnostics.sawAnyEvent, true);
    assert.match(diagnostics.detail, /hook dispatch failed/);
  });

  void it("re-serializes an error event whose message isn't a flat string, instead of dropping it", () => {
    // A future cline version could nest its error payload (e.g.
    // {"error":{"code":401,...}}) instead of a flat "message" string. The
    // event must still surface as diagnosable content — never silently
    // vanish into a bare "exit code N" — mirroring
    // extractStructuredCliDiagnostics's identical opencode fallback.
    const diagnostics = extractClineStructuredDiagnostics(
      JSON.stringify({ type: "error", error: { code: 401, reason: "unauthorized" } })
    );

    assert.notStrictEqual(diagnostics.detail, "");
    assert.match(diagnostics.detail, /unauthorized/);
    assert.match(diagnostics.markerScanText, /unauthorized/);
  });

  void it("re-serializes a failed run_result whose text isn't a string, instead of dropping it", () => {
    const diagnostics = extractClineStructuredDiagnostics(
      JSON.stringify({ type: "run_result", finishReason: "error", text: null })
    );

    assert.notStrictEqual(diagnostics.detail, "");
    assert.match(diagnostics.detail, /"finishReason":"error"/);
  });

  void it("keeps an unverified finishReason's text out of the auth scan, but still shows it in detail", () => {
    // Only finishReason "error" has been verified live to carry
    // CLI-generated failure text; any other non-"completed" reason might
    // instead carry a genuine partial MODEL answer (which, like a
    // successful reply, can echo file contents). Its text is still shown to
    // the user via detail (never fed to auth classification) but withheld
    // from the scan.
    const diagnostics = extractClineStructuredDiagnostics(
      JSON.stringify({
        type: "run_result",
        finishReason: "length",
        text: "...and the api key is used to login and authenticate the request.",
      })
    );

    assert.doesNotMatch(diagnostics.markerScanText, /api key|login|authenticate/);
    assert.match(diagnostics.detail, /api key/);
  });

  void it("excludes a successful run's own final answer text from the scan", () => {
    // A successful run_result.text is the model's own free-form reply (which
    // can itself quote file contents back to the user) and must never be
    // scanned for auth markers — only extractClineFinalOutput reads it.
    const diagnostics = extractClineStructuredDiagnostics(
      JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "The file mentions an api key and says to login or authenticate.",
      })
    );

    assert.doesNotMatch(diagnostics.markerScanText, /api key|authenticate|login/);
    assert.equal(diagnostics.sawAnyEvent, true);
  });
});

void describe("toFriendlyError — Cline", () => {
  void it("does not diagnose auth from file contents echoed into Cline's event stream", () => {
    const stdout = [CLINE_FILE_CONTENTS_ECHO_EVENT, CLINE_FAILED_RUN_RESULT_EVENT].join("\n");
    const friendly = toFriendlyError(CLINE_LIKE, "cline-pass/deepseek-v4-pro", 1, "", stdout);

    assert.equal(friendly.authFailure, false);
    assert.match(friendly.message, /invalid model format/);
  });

  void it("diagnoses auth from a top-level error event", () => {
    const stdout = JSON.stringify({ type: "error", message: "not logged in" });
    const friendly = toFriendlyError(CLINE_LIKE, "cline-pass/deepseek-v4-pro", 1, "", stdout);

    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /cline auth cline-pass/);
  });
});

void describe("auth classification is structural, not textual", () => {
  void it("does not re-read the injected login hint as evidence of the auth failure it describes", () => {
    // The self-reinforcing loop: the hint says "paste the OpenCode API key",
    // and isAuthenticationFailure matches /api\s*key/i. The pre-hint diagnostic
    // text is what breaks it.
    //
    // "No provider available" with no status code is the shape that isolates
    // the loop: it matches the provider's own marker list (so the hint IS
    // appended) but matches none of the regex's patterns on its own, so any
    // regex hit on the final message can only have come from the hint.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/grok-4.5",
      1,
      "",
      JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { message: "No provider available" } },
      })
    );

    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /paste the OpenCode API key/);
    assert.equal(isAuthenticationFailure(friendly.message), true);
    assert.equal(isAuthenticationFailure(friendly.diagnosticText), false);
  });

  void it("leaves a transport failure whose stream quoted 'api key' non-auth downstream", () => {
    // End-to-end over the exact production shape — the F1 to F2 amplification.
    const friendly = toFriendlyError(
      OPENCODE_LIKE,
      "opencode/deepseek-v4-flash-free",
      1,
      "",
      [FILE_CONTENTS_ECHO_EVENT, REAL_TRANSPORT_DROP_EVENT].join("\n")
    );

    assert.equal(friendly.authFailure, false);
    assert.equal(isAuthenticationFailure(friendly.diagnosticText), false);
  });

  void it("still treats a 403 as auth for a provider whose marker list omits it", () => {
    // claude-cli carries no 401/403/forbidden marker, so the provider's own
    // marker scan alone would miss this — toFriendlyError also checks the
    // broader isAuthenticationFailure regex against the same scan source, so
    // authFailure itself correctly becomes true rather than depending on a
    // caller downstream to catch it separately.
    const friendly = toFriendlyError(OPAQUE_TEXT_LIKE, undefined, 1, "HTTP 403 Forbidden", "");

    assert.equal(friendly.authFailure, true);
    assert.equal(isAuthenticationFailure(friendly.diagnosticText), true);
  });

  void it("catches a responseBody-only auth signal the provider's marker list also misses (F2 gap)", () => {
    // opencode's own markers have no "403"/"forbidden" entry, and the signal
    // here lives ONLY in responseBody — which is deliberately excluded from
    // detail/diagnosticText (see extractStructuredCliDiagnostics, G6), so
    // isAuthenticationFailure(diagnosticText) alone would also miss it. Only
    // checking the broader regex against the full scan source (which DOES
    // include responseBody) catches this.
    const stdout = JSON.stringify({
      type: "error",
      error: {
        name: "APICallError",
        data: {
          message: "request failed",
          responseBody: '{"error":"403 Forbidden: subscription not entitled"}',
        },
      },
    });
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 1, "", stdout);

    assert.equal(friendly.authFailure, true);
    // detail/diagnosticText still excludes responseBody (G6's quota-safety
    // reasoning is unaffected) — the fix is that authFailure no longer
    // depends solely on diagnosticText to know that.
    assert.doesNotMatch(friendly.diagnosticText, /403|Forbidden|entitled/);
  });

  void it("does not diagnose auth from incidental words in an opaque provider's stdout", () => {
    // kiro-cli/codex-cli have no structured stream to scope to — stdout IS
    // the model's own generated output, which can legitimately discuss (or
    // echo file content mentioning) "403"/"credentials"/"permission denied"
    // without any of it being a real auth failure. Only stderr (the CLI
    // tool's own diagnostic channel) and the provider's own narrow
    // authErrorMarkers list are trusted for an opaque provider — the
    // companion to "still treats a 403 as auth..." above, which shows stderr
    // is still scanned.
    const friendly = toFriendlyError(
      OPAQUE_TEXT_LIKE,
      undefined,
      1,
      "",
      "I reviewed handlePermissionDenied() — it returns 403 when credentials are missing, as designed."
    );

    assert.equal(friendly.authFailure, false);
  });
});

void describe("stream-transport failures are cascade-eligible", () => {
  const transportFriendly = {
    message: "OpenCode CLI failed: UnknownError: Streaming response failed",
    authFailure: false,
    diagnosticText: "OpenCode CLI failed: UnknownError: Streaming response failed",
    retryableHint: false,
  };

  void it("recognizes the captured production wording as a transport error", () => {
    assert.equal(isTransportError('"Streaming response failed"'), true);
    assert.equal(isTransportError("socket hang up"), true);
    assert.equal(isTransportError("Claude Code CLI exited with code 1."), false);
  });

  void it("classifyFailure alone leaves a transport drop generic — promotion lives only in applyTransportTransience", () => {
    // classifyFailure (quota.ts) is shared with Copilot and has no provider
    // context, so it cannot tell a structured-stream CLI (whose diagnostic
    // text is scoped) from an opaque one (whose diagnostic text is raw
    // stdout) — a distinction that matters enormously for whether a
    // transport-phrase match is trustworthy. TRANSPORT_MARKERS is therefore
    // never checked there; only applyTransportTransience, which does have
    // that context, ever promotes via a transport phrase.
    assert.equal(classifyFailed(transportFriendly.message).failureKind, "generic");
  });

  void it("promotes a structured-provider transport drop to temporarily-unavailable in text mode", () => {
    // "generic" is terminal at both cascade gates — this is the whole F3 fix,
    // now scoped correctly to where it is actually safe.
    const promoted = applyTransportTransience(
      classifyFailed(transportFriendly.message),
      transportFriendly,
      "text",
      OPENCODE_LIKE
    );

    assert.equal(promoted.failureKind, "temporarily-unavailable");
    assert.equal(promoted.transient, true);
  });

  void it("promotes an error the provider reported retryable even with no matching phrase, for any provider", () => {
    // retryableHint is structural (the provider's own error event), so it is
    // trusted even for an opaque-text provider that would never get a
    // text-matched promotion.
    const classified = classifyFailed("upstream hiccup");
    const promoted = applyTransportTransience(
      classified,
      { ...transportFriendly, diagnosticText: "upstream hiccup", retryableHint: true },
      "text",
      OPAQUE_TEXT_LIKE
    );

    assert.equal(promoted.failureKind, "temporarily-unavailable");
    assert.equal(promoted.transient, true);
  });

  void it("does NOT promote a text-matched transport phrase for an opaque-text provider (F6 gap)", () => {
    // kiro-cli/codex-cli have no structured stream to scope to, so their
    // diagnosticText IS raw stdout/model prose — a transport phrase
    // appearing in ordinary output must not be trusted the way opencode's
    // scoped diagnosticText is.
    const promoted = applyTransportTransience(
      classifyFailed(transportFriendly.message),
      transportFriendly,
      "text",
      OPAQUE_TEXT_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, undefined);
  });

  void it("does NOT promote an edit-mode transport drop at all, even for a structured provider (F4 gap)", () => {
    // Unlike the same-model retry (which never retries an edit-mode run
    // except via same-conversation resume), the backup CASCADE has no
    // dirty-tree gate at all —
    // it dispatches a different model the moment failureKind is cascade-eligible.
    // Promoting here would spend that ungated cascade on a possibly
    // half-edited tree, a strictly worse hazard than the retry withheld for
    // the same reason. Restricted to text mode until the cascade itself gains
    // real dirty-tree gating.
    const promoted = applyTransportTransience(
      classifyFailed(transportFriendly.message),
      transportFriendly,
      "edit",
      OPENCODE_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, undefined);
  });

  void it("marks Antigravity's captured response timeout for same-conversation resume in edit mode", () => {
    const antigravity = getCliProvider("antigravity-cli");
    assert.ok(antigravity, "expected antigravity-cli provider definition");
    const diagnostic = "Antigravity CLI failed: Error: timeout waiting for response";
    const promoted = applyTransportTransience(
      classifyFailed(diagnostic),
      {
        message: diagnostic,
        authFailure: false,
        diagnosticText: diagnostic,
        retryableHint: false,
      },
      "edit",
      antigravity
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, true);
    assert.equal(promoted.resumeConversation, true);
  });

  void it("does not treat the Antigravity timeout phrase as resumable for an unrelated opaque provider", () => {
    const diagnostic = "Claude Code CLI failed: Error: timeout waiting for response";
    const promoted = applyTransportTransience(
      classifyFailed(diagnostic),
      {
        message: diagnostic,
        authFailure: false,
        diagnosticText: diagnostic,
        retryableHint: false,
      },
      "edit",
      OPAQUE_TEXT_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, undefined);
    assert.equal(promoted.resumeConversation, undefined);
  });

  void it("does NOT populate editEvidence on a transport drop", () => {
    const promoted = applyTransportTransience(
      classifyFailed(transportFriendly.message),
      transportFriendly,
      "text",
      OPENCODE_LIKE
    );

    assert.equal(promoted.editEvidence, undefined);
  });

  void it("leaves a plain non-zero tool exit generic and non-transient", () => {
    // Anti-vacuity: the promotion must not fire on ordinary failures.
    const promoted = applyTransportTransience(
      classifyFailed("Claude Code CLI exited with code 1."),
      { ...transportFriendly, message: "exited with code 1", diagnosticText: "exited with code 1" },
      "text",
      OPENCODE_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, undefined);
  });

  void it("never promotes an auth failure, even when it also mentions a transport phrase", () => {
    // Load-bearing: the text-mode cascade gate checks failureKind only and has
    // no auth check of its own, so promoting here would start spending backup
    // allocations on a credentials problem.
    const promoted = applyTransportTransience(
      classifyFailed("generic wording"),
      { ...transportFriendly, authFailure: true },
      "text",
      OPENCODE_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, undefined);
  });

  void it("never promotes via retryableHint when the diagnostic text is itself an auth failure the provider's marker list misses", () => {
    // classifyFailure's own auth-aware guard (quota.ts) already prevents a
    // TEXT-matched promotion for an auth failure — but retryableHint is a
    // structural signal that bypasses text matching entirely, so
    // applyTransportTransience needs its own guard for exactly this path.
    // claude-cli's authErrorMarkers carry no 401/403/forbidden entry, so
    // friendly.authFailure alone is false here; only the broader regex over
    // diagnosticText catches it.
    const authDiagnostic = "Claude Code CLI failed: HTTP 403 Forbidden";
    const promoted = applyTransportTransience(
      classifyFailed(authDiagnostic),
      {
        message: authDiagnostic,
        authFailure: false,
        diagnosticText: authDiagnostic,
        retryableHint: true,
      },
      "text",
      OPAQUE_TEXT_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
    assert.equal(promoted.transient, undefined);
  });

  void it("lets quota win over the transport marker", () => {
    // Retrying a rate-limited request just re-hits the same limit.
    const classified = classifyFailed("Rate limit exceeded, streaming response failed");
    const promoted = applyTransportTransience(classified, transportFriendly, "text", OPENCODE_LIKE);

    assert.equal(promoted.failureKind, "quota");
    assert.equal(promoted.transient, undefined);
  });

  void it("does not promote when a source file in the stream merely quotes a transport phrase", () => {
    // F1 and F3 interact: the promotion reads the scoped diagnostic text, so a
    // file whose contents mention "socket hang up" cannot fabricate one.
    const stdout = [
      JSON.stringify({
        type: "tool",
        part: { type: "tool", state: { output: "// retry on socket hang up errors" } },
      }),
      JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "bad request" } } }),
    ].join("\n");
    const friendly = toFriendlyError(OPENCODE_LIKE, "opencode/grok-4.5", 1, "", stdout);
    const promoted = applyTransportTransience(
      classifyFailed(friendly.message),
      friendly,
      "text",
      OPENCODE_LIKE
    );

    assert.equal(promoted.failureKind, "generic");
  });
});
