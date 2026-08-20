import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  __testOnly,
  CliAgentRunner,
  cliProviderSupportsV1StdoutCapture,
  runImplementationWithCli,
} from "../runners/cliAgentRunner";
import { CliProviderDefinition, getCliProvider } from "../runners/providers";
import { attributionHeader, withAttribution } from "../utils/fileUtils";
import { AgentRunRequest } from "../types/agentRunner";

void describe("quotePosixShellArg", () => {
  // Codex review finding: Node's own spawn(..., {shell:true}) joins
  // [command, ...args] with plain spaces and hands the whole string to
  // `/bin/sh -c` on POSIX WITHOUT escaping any argv element (Node emits its
  // own DEP0190 deprecation warning for exactly this) — the codebase's
  // existing quoting only covered win32. Cline's fixed, multi-word
  // CLINE_CLI_ARGV_PROMPT_PLACEHOLDER (providers.ts) is exactly the shape
  // that broke on POSIX: a space-containing argv value with no quoting at
  // all arrives at the spawned process split into multiple separate
  // argv.slice(1) tokens.
  //
  // Every case below was round-tripped through a REAL shell (`eval "printf
  // '%s' $quoted"` in Git Bash / POSIX sh) during development to confirm the
  // escaping is correct, not just plausible-looking — including a
  // command-substitution payload, to prove it stays inert as literal text
  // rather than being executed.
  void it("returns a plain value unchanged when wrapped in quotes", () => {
    assert.strictEqual(
      __testOnly.quotePosixShellArg("Complete the task described in the piped input above."),
      "'Complete the task described in the piped input above.'"
    );
  });

  void it("preserves internal spacing exactly", () => {
    assert.strictEqual(
      __testOnly.quotePosixShellArg("a  double   space"),
      "'a  double   space'"
    );
  });

  void it("escapes an embedded single quote using the close-escape-reopen sequence", () => {
    assert.strictEqual(
      __testOnly.quotePosixShellArg("it's a test"),
      "'it'\\''s a test'"
    );
  });

  void it("handles a value that is entirely a single quote", () => {
    assert.strictEqual(__testOnly.quotePosixShellArg("'"), "''\\'''");
  });

  void it("neutralizes shell metacharacters as inert literal text", () => {
    // Single-quoted POSIX strings perform NO expansion at all — not $vars,
    // not command substitution, not backticks — so every metacharacter here
    // must survive verbatim inside the quotes rather than being escaped
    // individually.
    const value = "semi;colon|pipe&amp$dollar`backtick$(echo pwned)";
    assert.strictEqual(
      __testOnly.quotePosixShellArg(value),
      `'${value}'`
    );
  });

  void it("quotes an empty string as an empty pair of quotes", () => {
    assert.strictEqual(__testOnly.quotePosixShellArg(""), "''");
  });
});

void describe("CLI output normalization", () => {
  void it("extracts Kiro's final review text from a streamed transcript", () => {
    const transcript = [
      "\u001b[38;5;141m>\u001b[0m",
      "",
      "I'll analyze the implementation against the plan requirements.",
      "Batch fs_read operation with 3 operations",
      "Successfully read package.json",
      "I will run the following command: pnpm run test:unit",
      "",
      "Based on my analysis of the implementation files, here's my low-level review:",
      "",
      "## Summary Verdict",
      "",
      "Ready to complete.",
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractKiroFinalOutput(transcript),
      [
        "Based on my analysis of the implementation files, here's my low-level review:",
        "",
        "## Summary Verdict",
        "",
        "Ready to complete.",
      ].join("\n")
    );
  });

  void it("loads Kiro's linked markdown artifact when stdout points to a file URI", () => {
    const tempFile = path.join(
      process.cwd(),
      `vs-code-ai-helper-kiro-output-${Date.now()}.md`
    );
    fs.writeFileSync(tempFile, "# Review\n\nOn Track\n", "utf8");

    try {
      const stdout = [
        "I have completed a high-level review of the implementation.",
        "",
        `Please refer to the generated [high_level_review.md](${pathToFileURL(tempFile).toString()}) artifact for the full evaluation.`,
      ].join("\n");

      assert.strictEqual(
        __testOnly.extractKiroFinalOutput(stdout),
        "# Review\n\nOn Track"
      );
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  void it("extracts opencode's final answer from its --format json event stream", () => {
    // Captured shape (trimmed) verified live against opencode 1.18.4: each
    // line is a JSON event; the reply arrives as one or more type:"text"
    // events whose part.text carries the FULL text for that part (not an
    // incremental delta).
    const stream = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "PONG" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
    ].join("\n");

    assert.strictEqual(__testOnly.extractOpencodeFinalOutput(stream), "PONG");
  });

  void it("concatenates multiple opencode text parts across tool-use steps in order", () => {
    const stream = [
      JSON.stringify({ type: "text", part: { type: "text", text: "I'll create the file." } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "write" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Done." } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractOpencodeFinalOutput(stream),
      "I'll create the file.\n\nDone."
    );
  });

  // 2026-08-07: the V1 createCliTextTransportV1 path (requiresFramedResult:
  // true) needs the text part that actually carries the frame — its reply is
  // parsed by parseAiResultEnvelopeV1, and concatenating narration ahead of
  // the frame fed the parser text whose frame (if attempted at all) was
  // buried mid-response. Legacy free-text callers (the test above, and every
  // existing caller) are unaffected — requiresFramedResult defaults to false.
  void it("keeps the opencode text part carrying the frame when requiresFramedResult is true", () => {
    const stream = [
      JSON.stringify({ type: "text", part: { type: "text", text: "I'll create the file." } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "write" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "<<<ENSEMBLE_AI_RESULT_V1>>>\nreal frame\n<<<END_ENSEMBLE_AI_RESULT_V1>>>" } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractOpencodeFinalOutput(stream, undefined, true),
      "<<<ENSEMBLE_AI_RESULT_V1>>>\nreal frame\n<<<END_ENSEMBLE_AI_RESULT_V1>>>"
    );
  });

  /**
   * Code-review finding, 2026-08-07: a model that keeps talking after the
   * frame ("Done.") — or even emits a stray empty text event — used to make
   * the true last part win, discarding the frame entirely (an empty last
   * part made the WHOLE captured payload "", a hard malformedResult with no
   * chance for the parser's own scan-from-end fix to help, since the frame
   * text never reached it at all). Scanning from the end for the part that
   * actually contains the frame closes this instead of trading one failure
   * shape for another.
   */
  void it("does not lose the frame to a trailing text part emitted after it", () => {
    const stream = [
      JSON.stringify({ type: "text", part: { type: "text", text: "I'll create the file." } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "<<<ENSEMBLE_AI_RESULT_V1>>>\nreal frame\n<<<END_ENSEMBLE_AI_RESULT_V1>>>" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Done." } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractOpencodeFinalOutput(stream, undefined, true),
      "<<<ENSEMBLE_AI_RESULT_V1>>>\nreal frame\n<<<END_ENSEMBLE_AI_RESULT_V1>>>"
    );
  });

  void it("does not lose the frame to an empty trailing text part", () => {
    const stream = [
      JSON.stringify({ type: "text", part: { type: "text", text: "<<<ENSEMBLE_AI_RESULT_V1>>>\nreal frame\n<<<END_ENSEMBLE_AI_RESULT_V1>>>" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "" } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractOpencodeFinalOutput(stream, undefined, true),
      "<<<ENSEMBLE_AI_RESULT_V1>>>\nreal frame\n<<<END_ENSEMBLE_AI_RESULT_V1>>>"
    );
  });

  void it("falls back to the true last part when no part contains the frame at all", () => {
    const stream = [
      JSON.stringify({ type: "text", part: { type: "text", text: "I'll check the implementation." } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "A complete review with no frame at all." } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractOpencodeFinalOutput(stream, undefined, true),
      "A complete review with no frame at all."
    );
  });

  void it("returns a non-empty placeholder (not the raw JSON, not empty) for a recognized stream with no text reply", () => {
    // Real, reproduced-live scenario (opencode 1.18.4): a build-mode run
    // instructed to act silently ("create this file, no confirmation text")
    // can exit 0 having only emitted tool_use/step_start/step_finish events
    // and zero "text" parts. This must NOT return "" (execCliAgent's
    // "produced no output" guard fails ANY zero-length result, in every
    // mode — that would false-fail a legitimate silent edit run whose files
    // really did change) and must NOT return the raw multi-line JSON
    // transcript either (that used to leak into plan/review artifacts and
    // implementation summaries verbatim). An "error"-typed event still
    // counts as a recognized event (it has a string "type"), so it also
    // resolves to the placeholder here rather than the raw dump — the
    // non-zero exit code is what actually surfaces an error message
    // upstream (toFriendlyError diagnoses a structured-stream provider from
    // stderr plus the stream's own "error" events, not from this output).
    const noTextStream = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "write" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } }),
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } }),
    ].join("\n");

    const output = __testOnly.extractOpencodeFinalOutput(noTextStream);
    assert.notStrictEqual(output, "");
    assert.strictEqual(output, "(opencode completed the run without returning any text reply.)");

    const errorLine = JSON.stringify({
      type: "error",
      error: { name: "UnknownError", data: { message: "boom" } },
    });
    assert.strictEqual(
      __testOnly.extractOpencodeFinalOutput(errorLine),
      "(opencode completed the run without returning any text reply.)"
    );
  });

  void it("falls back to the raw stream when the output isn't a recognizable opencode event stream at all", () => {
    // Distinct from the no-text-reply case above: this is output with no
    // parseable {"type": ...} JSON object anywhere in it (a future
    // opencode version emitting a wholly different, unrecognized format).
    // The raw text is still surfaced here so the failure is visible rather
    // than reporting the same generic placeholder for a shape this parser
    // doesn't understand at all.
    const notJson = "opencode: unexpected internal error, please file a bug report";

    assert.strictEqual(__testOnly.extractOpencodeFinalOutput(notJson), notJson);
  });

  void it("normalizes opencode output via provider-specific extraction", () => {
    const opencode = getCliProvider("opencode-cli");
    assert.ok(opencode, "expected opencode-cli provider definition");

    const stream = JSON.stringify({
      type: "text",
      part: { type: "text", text: "Hello there." },
    });

    const output = __testOnly.normalizeCliOutput(opencode, stream, undefined);
    assert.strictEqual(output, "Hello there.");
  });

  void it("normalizes Kiro output via provider-specific extraction", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    const output = __testOnly.normalizeCliOutput(
      kiro,
      "\u001b[0m## Summary Verdict\u001b[0m\n\nNeeds changes.\n",
      undefined
    );

    assert.strictEqual(output, "## Summary Verdict\n\nNeeds changes.");
  });

  void it("extracts Cline's final answer from the trailing run_result event", () => {
    // Shape verified live against cline 3.0.46: intermediate agent_event
    // lines stream token-by-token, but the run's complete final answer
    // always lives in the LAST top-level run_result line's own text field —
    // no part-concatenation needed, unlike opencode.
    const stream = [
      JSON.stringify({ type: "hook_event", hookEventName: "agent_start" }),
      JSON.stringify({
        type: "agent_event",
        event: { type: "content_start", contentType: "text", text: "PO" },
      }),
      JSON.stringify({
        type: "agent_event",
        event: { type: "content_end", contentType: "text", text: "PONG" },
      }),
      JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "PONG",
        model: { id: "cline-pass/deepseek-v4-flash", provider: "cline-pass" },
      }),
    ].join("\n");

    assert.strictEqual(__testOnly.extractClineFinalOutput(stream), "PONG");
  });

  void it("returns the placeholder (not empty string) when run_result.text is an explicit empty string", () => {
    // A legitimate exit-0 run whose model returned nothing to say (a
    // silent, tool-only turn) can plausibly emit run_result with text:""
    // rather than omitting the field. That must still produce the
    // placeholder, not "" — an empty return here is misread downstream
    // (execCliAgent's close handler) as "CLI produced no output" and
    // routed through the failure path instead.
    const emptyTextStream = [
      JSON.stringify({ type: "hook_event", hookEventName: "agent_start" }),
      JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "",
      }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractClineFinalOutput(emptyTextStream),
      "(cline completed the run without returning any text reply.)"
    );
  });

  void it("takes the LAST run_result event's text when a stream carries more than one", () => {
    const stream = [
      JSON.stringify({ type: "run_result", finishReason: "completed", text: "FIRST" }),
      JSON.stringify({ type: "run_result", finishReason: "completed", text: "SECOND" }),
    ].join("\n");

    assert.strictEqual(__testOnly.extractClineFinalOutput(stream), "SECOND");
  });

  void it("returns a non-empty placeholder for a recognized Cline stream with no run_result text", () => {
    const noTextStream = [
      JSON.stringify({ type: "hook_event", hookEventName: "agent_start" }),
      JSON.stringify({
        type: "agent_event",
        event: { type: "iteration_end", iteration: 1 },
      }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractClineFinalOutput(noTextStream),
      "(cline completed the run without returning any text reply.)"
    );
  });

  void it("falls back to the raw stream when the output isn't a recognizable Cline event stream at all", () => {
    const notJson = "cline: unexpected internal error, please file a bug report";
    assert.strictEqual(__testOnly.extractClineFinalOutput(notJson), notJson);
  });

  void it("normalizes Cline output via provider-specific extraction", () => {
    const cline = getCliProvider("cline-cli");
    assert.ok(cline, "expected cline-cli provider definition");

    const stream = JSON.stringify({
      type: "run_result",
      finishReason: "completed",
      text: "Hello there.",
    });

    const output = __testOnly.normalizeCliOutput(cline, stream, undefined);
    assert.strictEqual(output, "Hello there.");
  });

  // Kimi's stream-json shape, verified live against kimi-code 0.29.2. The
  // narration lines below are why this extractor exists at all: in plain
  // `text` mode they are concatenated AHEAD of the real answer, and
  // parseAiResultEnvelopeV1 rejects any bytes before the frame marker — so a
  // correct, completed V1 review settled as malformedResult.
  void it("takes Kimi's LAST assistant message, dropping narration and tool turns", () => {
    const stream = [
      JSON.stringify({ role: "assistant", content: "The file is large. Let me page through it." }),
      JSON.stringify({
        role: "assistant",
        tool_calls: [{ type: "function", id: "t1", function: { name: "Read", arguments: "{}" } }],
      }),
      JSON.stringify({ role: "tool", tool_call_id: "t1", content: "1\tSECRET_FILE_CONTENT" }),
      JSON.stringify({ role: "assistant", content: "<<<ENSEMBLE_AI_RESULT_V1>>>\n{}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>" }),
      JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "s1" }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractKimiFinalOutput(stream),
      "<<<ENSEMBLE_AI_RESULT_V1>>>\n{}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>"
    );
  });

  void it("returns Kimi's placeholder for a tool-only turn with no text reply", () => {
    const stream = [
      JSON.stringify({ role: "assistant", tool_calls: [{ type: "function", id: "t1" }] }),
      JSON.stringify({ role: "tool", tool_call_id: "t1", content: "done" }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractKimiFinalOutput(stream),
      "(Kimi Code CLI completed the run without returning any text reply.)"
    );
  });

  void it("falls back to the raw stream when Kimi output isn't a recognizable message stream", () => {
    const notJson = "error: failed to run prompt: config.invalid: Model \"k3\" is not configured";
    assert.strictEqual(__testOnly.extractKimiFinalOutput(notJson), notJson);
  });

  void it("normalizes Kimi output via provider-specific extraction", () => {
    const kimi = getCliProvider("kimi-cli");
    assert.ok(kimi, "expected kimi-cli provider definition");

    const stream = [
      JSON.stringify({ role: "assistant", content: "narration" }),
      JSON.stringify({ role: "assistant", content: "Final answer." }),
    ].join("\n");

    assert.strictEqual(__testOnly.normalizeCliOutput(kimi, stream, undefined), "Final answer.");
  });

  void it("never feeds Kimi's tool output into the auth-marker scan", () => {
    // Kimi's {"role":"tool",...} lines re-emit whatever files it read — the
    // same leak class that made an opencode transport drop get misreported
    // as a billing/auth failure. Its real errors go to stderr (verified
    // live), which the caller concatenates separately, so stdout must
    // contribute nothing scannable here.
    const stream = [
      JSON.stringify({ role: "assistant", content: "ok" }),
      JSON.stringify({ role: "tool", tool_call_id: "t1", content: "please provide your api key to log in" }),
    ].join("\n");

    const diagnostics = __testOnly.extractKimiStructuredDiagnostics(stream);
    assert.strictEqual(diagnostics.markerScanText, "");
    assert.strictEqual(diagnostics.sawAnyEvent, true);
    assert.strictEqual(diagnostics.retryable, false);
  });

  // Codex's plain stdout is a human-readable transcript (banner, workdir/model
  // header, a `user` section echoing the whole prompt, then `codex`, then a
  // "tokens used" footer), so parseAiResultEnvelopeV1 — which requires the
  // capture to START with the frame marker — could never accept it. `--json`
  // is what makes codex-cli V1-eligible at all; these lock the event shape
  // verified live against codex 0.147.0.
  void it("takes Codex's LAST agent_message item, dropping reasoning and tool items", () => {
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "019ff1c3" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Let me check the file." } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "command_execution", text: "SECRET_FILE_CONTENT" } }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_3", type: "agent_message", text: "<<<ENSEMBLE_AI_RESULT_V1>>>\n{}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 14592, output_tokens: 11 } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractCodexFinalOutput(stream),
      "<<<ENSEMBLE_AI_RESULT_V1>>>\n{}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>"
    );
  });

  void it("returns Codex's placeholder for a turn that emits no agent_message", () => {
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 0 } }),
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractCodexFinalOutput(stream),
      "(Codex completed the run without returning any text reply.)"
    );
  });

  void it("falls back to the raw stream when Codex output isn't a recognizable event stream", () => {
    const notJson = "Not inside a trusted directory and --skip-git-repo-check was not specified.";
    assert.strictEqual(__testOnly.extractCodexFinalOutput(notJson), notJson);
  });

  void it("normalizes Codex output via provider-specific extraction", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const stream = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "narration" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer." } }),
    ].join("\n");

    assert.strictEqual(__testOnly.normalizeCliOutput(codex, stream, undefined), "Final answer.");
  });

  void it("surfaces Codex's stdout-only failure text while withholding its agent prose", () => {
    // Codex reports failures EXCLUSIVELY on stdout with an empty stderr
    // (verified live), so withholding stdout the way the opaque-text bucket
    // does would reduce every Codex failure to a bare "exit code 1". Its
    // agent_message prose still must not reach the auth-marker scan: it can
    // quote file contents back verbatim.
    const stream = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the config wants an api key to authenticate" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata not found. Defaulting to fallback metadata." } }),
      JSON.stringify({ type: "error", message: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." }),
      JSON.stringify({ type: "turn.failed", error: { message: "400 invalid_request_error" } }),
    ].join("\n");

    const diagnostics = __testOnly.extractCodexStructuredDiagnostics(stream);
    assert.ok(diagnostics.markerScanText.includes("not supported when using Codex"));
    assert.ok(diagnostics.markerScanText.includes("400 invalid_request_error"));
    assert.ok(diagnostics.markerScanText.includes("Defaulting to fallback metadata"));
    assert.ok(
      !diagnostics.markerScanText.includes("api key to authenticate"),
      "agent prose must never reach the auth-marker scan"
    );
    assert.strictEqual(diagnostics.sawAnyEvent, true);
    assert.strictEqual(diagnostics.retryable, false);
  });

  void it("keeps codex-cli eligible for V1 stdout capture", () => {
    // The regression this whole change exists for: usesLastMessageFile: true
    // made cliProviderSupportsV1StdoutCapture reject codex-cli at V1 selection
    // time, so it resolved, reported available, and appeared in the picker
    // while never being spawned — zero tokens, no session file, no error.
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");
    assert.strictEqual(codex.usesLastMessageFile ?? false, false);
    assert.strictEqual(cliProviderSupportsV1StdoutCapture(codex), true);
    assert.ok(
      codex.buildArgs("text", undefined, undefined).includes("--json"),
      "codex must request its JSONL event stream"
    );
  });

  void it("still refuses V1 stdout capture for any last-message-file CLI", () => {
    // No shipped provider sets usesLastMessageFile any more (codex-cli was the
    // last one), so this synthetic definition keeps the gate itself covered:
    // a future provider that answers only via a temp file must not be reserved
    // for V1, because AC-RUNNER-02 captures results from bounded stdout alone.
    const lastMessageFileProvider = {
      ...(getCliProvider("codex-cli") as CliProviderDefinition),
      usesLastMessageFile: true,
    };
    assert.strictEqual(cliProviderSupportsV1StdoutCapture(lastMessageFileProvider), false);
  });

  void it("fails CLI implementation runs that report completion without file changes", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      {
        status: "completed",
        output: "Implemented the requested changes.",
      },
      [],
      false
    );

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /did not modify any workspace files/);
    assert.match(result.errorMessage ?? "", /Provider output:/);
  });

  void it("treats a no-file-change CLI completion as success under ensemble.resilience.nothingToFixRoutesToReview (2b)", () => {
    // A correct implementer that inspects the tree, finds the plan already
    // satisfied, and declines to fabricate work must route to review rather
    // than be recorded as a failed run — observed five times, every time
    // with the model behaving correctly.
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      {
        status: "completed",
        output: "Verified all plan items are already implemented; no changes needed.",
      },
      [],
      false,
      true, // requireFileChange (the Run Implementation shape)
      true // noChangeCompletionIsSuccess (the resilience flag)
    );

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.summary, "Verified all plan items are already implemented; no changes needed.");
  });

  void it("keeps the zero-change hard failure when the resilience flag is off (legacy behavior)", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      { status: "completed", output: "Done." },
      [],
      false,
      true,
      false
    );

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /did not modify any workspace files/);
  });

  void it("treats a no-file-change CLI completion as success when requireFileChange is false", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      {
        status: "completed",
        output: "Just answering the question, no edit was needed.",
      },
      [],
      false,
      false
    );

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.summary, "Just answering the question, no edit was needed.");
  });

  void it("strips this extension's own Claude Code session identity from nested CLI env", () => {
    const original = { ...process.env };
    try {
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_CODE_ENTRYPOINT = "claude-vscode";
      process.env.CLAUDE_CODE_SESSION_ID = "abc123";
      process.env.CLAUDE_EFFORT = "xhigh";
      process.env.PATH = original.PATH ?? "";

      const env = __testOnly.sanitizedCliEnv();

      assert.strictEqual(env.CLAUDECODE, undefined);
      assert.strictEqual(env.CLAUDE_CODE_ENTRYPOINT, undefined);
      assert.strictEqual(env.CLAUDE_CODE_SESSION_ID, undefined);
      assert.strictEqual(env.CLAUDE_EFFORT, undefined);
      assert.strictEqual(env.PATH, original.PATH);
    } finally {
      process.env = original;
    }
  });

  void it("preserves other providers' own env vars (e.g. CODEX_HOME) rather than stripping their whole namespace", () => {
    // Regression test: an earlier version of sanitizedCliEnv also stripped
    // every CODEX_* and GEMINI_CLI_* variable, on the mistaken assumption
    // they were session-identity leaks like the CLAUDE_CODE_* ones. They're
    // not — CODEX_HOME etc. are the user's own legitimate CLI config/auth,
    // and this extension host has no comparable reason to itself be a
    // Codex or Gemini session the way it can be a Claude Code session.
    const original = { ...process.env };
    try {
      process.env.CODEX_HOME = "/home/user/.codex-custom-profile";
      process.env.GEMINI_CLI_API_KEY = "user-configured-key";

      const env = __testOnly.sanitizedCliEnv();

      assert.strictEqual(env.CODEX_HOME, "/home/user/.codex-custom-profile");
      assert.strictEqual(env.GEMINI_CLI_API_KEY, "user-configured-key");
    } finally {
      process.env = original;
    }
  });

  void it("propagates failureKind from a failed CLI run through to the AgentRunResult", async () => {
    const provider: CliProviderDefinition = {
      id: "claude-cli",
      label: "Fake Quota CLI",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInCommand: "login",
      signInLabel: "Sign in",
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      buildArgs(): string[] {
        // Exits non-zero with quota-flavored stderr, simulating Claude Code
        // reporting an exhausted session allocation.
        return [
          "-e",
          "process.stderr.write('Claude Code CLI failed: You\\'ve hit your session limit · resets 2:30am (Asia/Jerusalem).'); process.exit(1);",
        ];
      },
    };

    const runner = new CliAgentRunner(provider);
    const cts = new vscode.CancellationTokenSource();
    const request: AgentRunRequest = {
      taskFolderUri: vscode.Uri.file("/fake-task"),
      workspaceUri: vscode.Uri.file(process.cwd()),
      stage: "plan",
      prompt: "irrelevant",
      outputFile: vscode.Uri.file("/fake-task/plan.md"),
    };

    const result = await runner.run(request, cts.token);

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.failureKind, "quota");
  });

  void it("gives an OpenCode Go-specific recovery path for a no-provider 401", () => {
    const provider: CliProviderDefinition = {
      id: "opencode-cli",
      label: "OpenCode",
      command: "node",
      installHint: "install",
      loginHint: "generic login",
      loginHintForModel(model): string {
        return model?.startsWith("opencode-go/")
          ? "Connect OpenCode Go with `/connect` and confirm the Go subscription."
          : "Connect OpenCode Zen with `/connect` and confirm Zen billing.";
      },
      authErrorMarkers: ["no provider available", "401"],
      signInCommand: "opencode",
      signInLabel: "Sign in",
      useShell: false,
      models: [],
      usesLastMessageFile: false,
      textModeResponseContractV1: "repurposed-interactive-flow",
      buildArgs(): string[] {
        return [
          "-e",
          "process.stderr.write('No provider available (HTTP 401)'); process.exit(1);",
        ];
      },
    };

    const error = __testOnly.toFriendlyError(
      provider,
      "opencode-go/kimi-k3",
      1,
      "No provider available (HTTP 401)",
      ""
    );

    assert.match(error.message, /OpenCode Go/);
    assert.match(error.message, /Go subscription/);
    assert.doesNotMatch(error.message, /Zen billing/);
    // The auth verdict is now returned structurally rather than being left for
    // downstream to re-derive by regexing a message that already contains the
    // login hint this call appended.
    assert.equal(error.authFailure, true);
    assert.doesNotMatch(error.diagnosticText, /Go subscription/);
  });
});

void describe("output attribution", () => {
  void it("signs generated content with the provider and model that produced it", () => {
    const signed = withAttribution("Review body text.", "Claude Code", "sonnet");
    assert.strictEqual(
      signed,
      "<!-- Generated by Claude Code (sonnet) -->\n\nReview body text."
    );
  });

  void it("omits the model parens when no native model id is known", () => {
    assert.strictEqual(
      attributionHeader("Claude Code", undefined),
      "<!-- Generated by Claude Code -->"
    );
  });
});

// (2g) Post-implementation type-check: a round that leaves the tree
// non-compiling must never be handed to a reviewer as if it were
// reviewable. `typeCheckRunner` is the test seam — production always uses
// runProjectTypeCheckV1 (a real npm/npx spawn), which these tests
// deliberately never invoke.
void describe("post-implementation type-check (2g)", () => {
  function fakeWritingCliProvider(fileName: string): CliProviderDefinition {
    return {
      id: "antigravity-cli",
      label: "Fake CLI",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInLabel: "Sign in",
      promptTransport: "file",
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "unproven",
      buildArgs(): string[] {
        return [
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(fileName)}, "hello"); process.stdout.write("done")`,
        ];
      },
    };
  }

  void it("flags a completed round whose files DID change once the fake type-check reports failure", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-typecheck-fail-"));
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const cts = new vscode.CancellationTokenSource();
      let invokedWithCwd: string | undefined;
      const result = await runImplementationWithCli({
        def: fakeWritingCliProvider("new-file.txt"),
        model: undefined,
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(workspace),
        token: cts.token,
        onProgress: () => undefined,
        requireFileChange: true,
        typeCheckRunner: (cwd) => {
          invokedWithCwd = cwd;
          return Promise.resolve({
            passed: false,
            output: "src/foo.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
          });
        },
      });

      assert.strictEqual(result.status, "completed");
      assert.deepStrictEqual(result.filesChanged, ["new-file.txt"]);
      assert.strictEqual(result.typeCheckFailed, true);
      assert.match(result.typeCheckOutput ?? "", /TS2322/);
      assert.strictEqual(invokedWithCwd, workspace);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  void it("does not flag a completed round once the fake type-check reports success", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-typecheck-pass-"));
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const cts = new vscode.CancellationTokenSource();
      let typeCheckRan = false;
      const result = await runImplementationWithCli({
        def: fakeWritingCliProvider("new-file.txt"),
        model: undefined,
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(workspace),
        token: cts.token,
        onProgress: () => undefined,
        requireFileChange: true,
        typeCheckRunner: () => {
          typeCheckRan = true;
          return Promise.resolve({ passed: true, output: "" });
        },
      });

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(typeCheckRan, true);
      assert.strictEqual(result.typeCheckFailed, undefined);
      assert.strictEqual(result.typeCheckOutput, undefined);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  void it("never runs the type-check when the round left no known file changes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-typecheck-skip-"));
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const cts = new vscode.CancellationTokenSource();
      let typeCheckRan = false;
      const provider: CliProviderDefinition = {
        id: "antigravity-cli",
        label: "Fake no-op CLI",
        command: "node",
        installHint: "install",
        loginHint: "login",
        authErrorMarkers: ["login"],
        signInLabel: "Sign in",
        promptTransport: "file",
        useShell: false,
        models: [{ model: undefined, name: "default" }],
        usesLastMessageFile: false,
        textModeResponseContractV1: "unproven",
        buildArgs(): string[] {
          return ["-e", `process.stdout.write("no changes needed")`];
        },
      };

      const result = await runImplementationWithCli({
        def: provider,
        model: undefined,
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(workspace),
        token: cts.token,
        onProgress: () => undefined,
        // A genuine no-op completion is a legitimate outcome for a
        // requireFileChange:false caller (see 2b) — this test only cares
        // that the type-check itself is skipped, not the completion gate.
        requireFileChange: false,
        typeCheckRunner: () => {
          typeCheckRan = true;
          return Promise.resolve({ passed: false, output: "must not be reached" });
        },
      });

      assert.strictEqual(result.status, "completed");
      assert.deepStrictEqual(result.filesChanged, []);
      assert.strictEqual(
        typeCheckRan,
        false,
        "the type-check must never run when the round made no known file changes"
      );
      assert.strictEqual(result.typeCheckFailed, undefined);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
