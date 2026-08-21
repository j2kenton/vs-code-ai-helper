/**
 * Transport-level coverage for `createCliTextTransportV1` (plan §3.2/§3.4),
 * driving a REAL child process (node -e) through the exact spawn path the
 * production transport uses. The contract under test is the one the review
 * flagged: a structured-event CLI's stdout is a JSON-lines stream that WRAPS
 * the model's final text (and re-emits file contents in tool events), so the
 * transport must unwrap the final text into the bounded writer — the bytes
 * the broker captures must parse as exactly one strict framed V1 envelope,
 * not as wrapper JSON.
 *
 *  - opencode-shaped stream (`{"type":"text","part":{...}}` events): the
 *    captured payload is the model's reply and parses as one strict envelope;
 *  - cline-shaped stream (`{"type":"run_result","text":...}`): same;
 *  - an opaque-text CLI still streams raw stdout through unchanged;
 *  - a failed structured run (non-zero exit) writes NOTHING to the writer,
 *    so the broker reports a pre-response transport failure (fallback stays
 *    eligible, plan §3.3);
 *  - the raw event-stream buffer is bounded: exceeding it fails the
 *    transport without writing to the writer.
 */
import * as assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type * as vscode from "vscode";
import {
  cliProviderSupportsV1StdoutCapture,
  createCliTextTransportV1,
} from "../runners/cliAgentRunner";
import {
  CLI_PROVIDERS,
  CliBuildArgsContext,
  CliProviderDefinition,
  CliRunMode,
} from "../runners/providers";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  AgentExecutionRequestV1,
  BoundedResultWriterV1,
} from "../types/agentExecutionV1";
import { parseAiResultEnvelopeV1 } from "../types/aiResultEnvelope";

const FRAME_START = "<<<ENSEMBLE_AI_RESULT_V1>>>";
const FRAME_END = "<<<END_ENSEMBLE_AI_RESULT_V1>>>";
const REQUEST_PROMPT = "prompt text";

function makeCorrelation(): ActionCorrelationV1 {
  return {
    actionKey: "cliTransportTestAction.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

function frameFor(correlation: ActionCorrelationV1): string {
  const envelope = {
    version: 1,
    correlation,
    kind: "completed",
    content: {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text: "final answer",
    },
  };
  return `${FRAME_START}\n${JSON.stringify(envelope)}\n${FRAME_END}`;
}

/**
 * A def whose "CLI" is node itself, emitting a scripted stdout stream and
 * exiting with a scripted code — the transport's own spawn/capture path runs
 * unmodified. `id` must be a real provider id because normalizeCliOutput
 * dispatches its final-text extractor on it.
 */
function scriptedDef(options: {
  id: "opencode-cli" | "cline-cli" | "claude-cli";
  structuredEventStream?: "opencode" | "cline";
  stdout: string;
  exitCode?: number;
}): CliProviderDefinition {
  const script =
    `process.stdout.write(${JSON.stringify(options.stdout)});` +
    `process.exit(${options.exitCode ?? 0});`;
  return {
    id: options.id,
    label: "Scripted CLI",
    command: "node",
    installHint: "test",
    loginHint: "test",
    authErrorMarkers: [],
    signInLabel: "test",
    models: [],
    usesLastMessageFile: false,
    textModeResponseContractV1:
      options.id === "cline-cli" ? "unproven" : "repurposed-interactive-flow",
    structuredEventStream: options.structuredEventStream,
    promptTransport: "stdin",
    useShell: false,
    buildArgs(): string[] {
      return ["-e", script];
    },
  };
}

function fakeToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

function makeRequest(correlation: ActionCorrelationV1): AgentExecutionRequestV1 {
  return {
    correlation,
    reservationId: allocateHex128IdV1(),
    mode: "text",
    prompt: REQUEST_PROMPT,
    maxResponseBytes: 4 * 1024 * 1024,
    cancellationToken: fakeToken(),
  };
}

function collectingWriter(limit = 4 * 1024 * 1024): {
  writer: BoundedResultWriterV1;
  text: () => string;
} {
  const chunks: Buffer[] = [];
  let bytesWritten = 0;
  let overflowed = false;
  return {
    writer: {
      write(chunk: Uint8Array | string): boolean {
        const bytes =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        bytesWritten += bytes.length;
        if (bytesWritten > limit) {
          overflowed = true;
          chunks.length = 0;
        }
        if (!overflowed) {
          chunks.push(bytes);
        }
        return !overflowed;
      },
      get overflowed(): boolean {
        return overflowed;
      },
      get bytesWritten(): number {
        return bytesWritten;
      },
    },
    text: (): string => Buffer.concat(chunks).toString("utf8"),
  };
}

void describe("createCliTextTransportV1 structured-event capture", () => {
  void it("unwraps an opencode event stream into one directly parseable framed envelope", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    // Realistic stream shape: a step event, a tool event re-emitting file
    // content (the leak the extractor exists to exclude), then the model's
    // final reply as a text part carrying the frame.
    const stdout = [
      JSON.stringify({ type: "step-start", part: { type: "step-start" } }),
      JSON.stringify({
        type: "tool",
        part: { type: "tool", state: { output: "const apiKey = read from a file" } },
      }),
      JSON.stringify({ type: "text", part: { type: "text", text: frame } }),
      "",
    ].join("\n");

    const def = scriptedDef({ id: "opencode-cli", structuredEventStream: "opencode", stdout });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.deepEqual(exit, { kind: "completed" });
    const captured = text();
    assert.equal(captured, frame, "the captured payload must be the framed reply, not wrapper JSON");
    const parsed = parseAiResultEnvelopeV1(captured, correlation);
    assert.equal(parsed.kind, "completed", "the captured payload must parse as one strict envelope");
  });

  /**
   * 2026-08-07 live incidents: a real agentic run narrates between tool
   * calls ("I'll check X" ... "Done."), and opencode's event stream carries
   * that as separate "text" parts. Before this fix, extractOpencodeFinalOutput
   * concatenated all of them, so the captured payload had the frame buried
   * after narration rather than isolated — this end-to-end test proves the
   * full spawn-to-writer path now isolates the model's last text part
   * (the frame) instead.
   */
  void it("keeps only the model's final text part when narration precedes the frame", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    const stdout = [
      JSON.stringify({ type: "text", part: { type: "text", text: "Let me check the implementation first." } }),
      JSON.stringify({ type: "tool", part: { type: "tool", state: { output: "some file content" } } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Verified. Writing the answer now." } }),
      JSON.stringify({ type: "text", part: { type: "text", text: frame } }),
      "",
    ].join("\n");

    const def = scriptedDef({ id: "opencode-cli", structuredEventStream: "opencode", stdout });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.deepEqual(exit, { kind: "completed" });
    const captured = text();
    assert.equal(
      captured,
      frame,
      "narration text parts must not be concatenated into the captured payload"
    );
    const parsed = parseAiResultEnvelopeV1(captured, correlation);
    assert.equal(parsed.kind, "completed", "the captured payload must parse as one strict envelope");
  });

  void it("unwraps a cline run_result into one directly parseable framed envelope", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    const stdout = [
      JSON.stringify({ type: "agent_event", event: { type: "content_start" } }),
      JSON.stringify({ type: "run_result", finishReason: "completed", text: frame }),
      "",
    ].join("\n");

    const def = scriptedDef({ id: "cline-cli", structuredEventStream: "cline", stdout });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.deepEqual(exit, { kind: "completed" });
    const captured = text();
    assert.equal(captured, frame, "the captured payload must be the framed reply, not wrapper JSON");
    const parsed = parseAiResultEnvelopeV1(captured, correlation);
    assert.equal(parsed.kind, "completed", "the captured payload must parse as one strict envelope");
  });

  void it("still streams an opaque-text CLI's stdout through unchanged", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    const def = scriptedDef({ id: "claude-cli", stdout: `${frame}\n` });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const result = await transport.invoke(makeRequest(correlation), writer);
    assert.deepEqual(result, { kind: "completed" });
    assert.equal(text(), `${frame}\n`, "opaque stdout must pass through byte-for-byte");
    const parsed = parseAiResultEnvelopeV1(text(), correlation);
    assert.equal(parsed.kind, "completed");
  });

  void it("writes nothing for a failed structured run, keeping the failure pre-response", async () => {
    const correlation = makeCorrelation();
    const stdout = `${JSON.stringify({
      type: "error",
      error: { name: "ProviderError", data: { message: "backend unavailable" } },
    })}\n`;
    const def = scriptedDef({
      id: "opencode-cli",
      structuredEventStream: "opencode",
      stdout,
      exitCode: 3,
    });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    // The code is the stable contract; the detail is diagnostic text that may
    // be reworded, so it is matched by shape rather than compared exactly.
    // What matters is that a non-zero exit now reports whether the process
    // said anything at all — "exited 3, stderr 0 bytes" and "exited 3, stderr
    // 4KB" are different failures and were previously indistinguishable.
    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliExit.3");
    assert.match(
      (exit.kind === "transportFailure" && exit.detail) || "",
      /exited 3; stderr \d+ byte\(s\)/
    );
    assert.equal(
      writer.bytesWritten,
      0,
      "a failed structured run must not write wrapper bytes to the result writer"
    );
  });

  /**
   * Item 1 (workflow findings round 8), fix 3: a structured-stream provider
   * that exits 0 but whose event stream carried zero text parts must not
   * settle as `kind: "completed"` — that silently burns the round instead of
   * engaging the backup chain (2026-08-20 field capture: Kimi Code CLI's
   * second attempt on the same stage settled on exactly its own
   * no-text-reply placeholder as a "completed" round).
   */
  void it("reports transportFailure, not completed, when a structured stream carries zero text parts", async () => {
    const correlation = makeCorrelation();
    const stdout = [
      JSON.stringify({ type: "step-start", part: { type: "step-start" } }),
      JSON.stringify({ type: "step-finish", part: { type: "step-finish", reason: "stop" } }),
      "",
    ].join("\n");

    const def = scriptedDef({ id: "opencode-cli", structuredEventStream: "opencode", stdout });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliEmptyTextReply");
    assert.equal(
      writer.bytesWritten,
      0,
      "an empty text reply must not write placeholder bytes to the result writer"
    );
  });

  /**
   * 2026-08-20 review follow-up: the placeholder-set check above only ever
   * catches "saw recognizable events but none carried text" — every
   * structured extractor's OWN "cleaned.length === 0" branch (genuinely
   * empty stdout, not just an empty-text event) returns "" directly rather
   * than routing through a placeholder, which the placeholder-only check
   * let straight through to `completed` with zero captured bytes.
   */
  void it("reports transportFailure, not completed, when a structured-stream CLI writes zero stdout bytes", async () => {
    const correlation = makeCorrelation();
    const def = scriptedDef({ id: "opencode-cli", structuredEventStream: "opencode", stdout: "" });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliEmptyTextReply");
    assert.equal(
      writer.bytesWritten,
      0,
      "zero stdout bytes must not settle as a completed round with nothing captured"
    );
  });

  /**
   * Same review follow-up: an explicit empty-string text part (the model
   * emitted a `type: "text"` event whose `part.text` is `""`) is a real
   * recognized event, so `sawRecognizedEvent` is true and the "no text
   * parts at all" placeholder branch is never reached either —
   * `extractOpencodeFinalOutput`'s `requiresFramedResult` loop falls through
   * to returning that empty part verbatim.
   */
  void it("reports transportFailure, not completed, when the only text part is an explicit empty string", async () => {
    const correlation = makeCorrelation();
    const stdout = [
      JSON.stringify({ type: "text", part: { type: "text", text: "" } }),
      JSON.stringify({ type: "step-finish", part: { type: "step-finish", reason: "stop" } }),
      "",
    ].join("\n");
    const def = scriptedDef({ id: "opencode-cli", structuredEventStream: "opencode", stdout });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliEmptyTextReply");
    assert.equal(
      writer.bytesWritten,
      0,
      "an explicit empty text part must not write an empty payload as a completed round"
    );
  });

  /**
   * Same review follow-up, opaque-text path: a CLI with no
   * `structuredEventStream` never runs through `normalizeCliOutput` or the
   * placeholder set at all — it streams stdout straight into the writer as
   * it arrives — so the gap there is a provider that exits 0 having written
   * nothing whatsoever.
   */
  void it("reports transportFailure, not completed, when an opaque-text CLI writes zero stdout bytes", async () => {
    const correlation = makeCorrelation();
    const def = scriptedDef({ id: "claude-cli", stdout: "" });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliEmptyTextReply");
    assert.equal(writer.bytesWritten, 0, "an opaque-text CLI with zero stdout must not settle as completed");
  });

  void it("bounds the buffered raw event stream and fails without writing on overflow", async () => {
    const correlation = makeCorrelation();
    // ~64 KiB of tool-event noise against a 1 KiB bound. Generated inside
    // the child (not embedded in argv) so the script stays within OS
    // command-line length limits.
    const noiseScript =
      'const line = JSON.stringify({type:"tool",part:{type:"tool",state:{output:"x".repeat(1024)}}});' +
      'for (let i = 0; i < 64; i++) process.stdout.write(line + "\\n");';
    const def: CliProviderDefinition = {
      ...scriptedDef({ id: "opencode-cli", structuredEventStream: "opencode", stdout: "" }),
      buildArgs(): string[] {
        return ["-e", noiseScript];
      },
    };
    const transport = createCliTextTransportV1({
      def,
      model: undefined,
      cwd: process.cwd(),
      maxEventStreamBytes: 1024,
    });
    const { writer } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliEventStreamTooLarge");
    assert.match(
      (exit.kind === "transportFailure" && exit.detail) || "",
      /exceeded \d+ bytes \(read \d+\)/
    );
    assert.equal(writer.bytesWritten, 0, "an overflowed event stream must never reach the writer");
  });
});

/**
 * Item 1 fix 4 (workflow findings round 8): a structured-stream reply that
 * omits the required result frame is narration, not an answer — mirrors the
 * Copilot LM transport's bounded nudge (`languageModelToolSessionV1.ts`),
 * respawning the CLI process once with the same nudge text appended to the
 * prompt instead of accepting the narration as the round's result.
 */
void describe("createCliTextTransportV1 frameless-response nudge (item 1 fix 4)", () => {
  function counterFile(): { path: string; count: () => number } {
    const p = nodePath.join(
      os.tmpdir(),
      `vs-code-ai-helper-nudge-counter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    return {
      path: p,
      count: (): number => (nodeFs.existsSync(p) ? nodeFs.readFileSync(p, "utf8").length : 0),
    };
  }

  /**
   * A stdin-fed structured-stream script that appends one byte to
   * `counterPath` on every invocation (so the test can assert exactly how
   * many processes were spawned) and inspects the prompt IT received: a
   * prompt containing `nudgeMarker` gets `framedText`, any other prompt gets
   * `narrationText`. Since each retry is a brand-new process, this is how
   * the fixture tells "first attempt" from "the nudged retry" apart without
   * any shared in-process state.
   */
  function nudgeAwareDef(options: {
    counterPath: string;
    nudgeMarker: string;
    narrationText: string;
    framedText: string;
  }): CliProviderDefinition {
    const script =
      'const fs = require("node:fs");' +
      `fs.appendFileSync(${JSON.stringify(options.counterPath)}, "x");` +
      'const prompt = fs.readFileSync(0, "utf8");' +
      `const nudged = prompt.includes(${JSON.stringify(options.nudgeMarker)});` +
      `const reply = nudged ? ${JSON.stringify(options.framedText)} : ${JSON.stringify(options.narrationText)};` +
      `process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: reply } }) + "\\n");`;
    return {
      id: "opencode-cli",
      label: "Scripted CLI",
      command: "node",
      installHint: "test",
      loginHint: "test",
      authErrorMarkers: [],
      signInLabel: "test",
      models: [],
      usesLastMessageFile: false,
      textModeResponseContractV1: "repurposed-interactive-flow",
      structuredEventStream: "opencode",
      promptTransport: "stdin",
      useShell: false,
      buildArgs(): string[] {
        return ["-e", script];
      },
    };
  }

  /**
   * Same fixture shape as `nudgeAwareDef`, but for an opaque-text CLI (no
   * `structuredEventStream`): stdout IS the model's final answer, written
   * directly rather than wrapped in a JSON-lines event.
   */
  function opaqueNudgeAwareDef(options: {
    counterPath: string;
    nudgeMarker: string;
    narrationText: string;
    framedText: string;
  }): CliProviderDefinition {
    const script =
      'const fs = require("node:fs");' +
      `fs.appendFileSync(${JSON.stringify(options.counterPath)}, "x");` +
      'const prompt = fs.readFileSync(0, "utf8");' +
      `const nudged = prompt.includes(${JSON.stringify(options.nudgeMarker)});` +
      `process.stdout.write(nudged ? ${JSON.stringify(options.framedText)} : ${JSON.stringify(options.narrationText)});`;
    return {
      id: "claude-cli",
      label: "Scripted CLI",
      command: "node",
      installHint: "test",
      loginHint: "test",
      authErrorMarkers: [],
      signInLabel: "test",
      models: [],
      usesLastMessageFile: false,
      textModeResponseContractV1: "repurposed-interactive-flow",
      promptTransport: "stdin",
      useShell: false,
      buildArgs(): string[] {
        return ["-e", script];
      },
    };
  }

  void it("respawns an opaque-text CLI exactly once and accepts the framed retry, when the first reply narrates instead of answering (2026-08-21 review finding)", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    const { path, count } = counterFile();
    const def = opaqueNudgeAwareDef({
      counterPath: path,
      nudgeMarker: "cannot be accepted",
      narrationText: "Now I'll write the re-review frame.",
      framedText: frame,
    });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.deepEqual(exit, { kind: "completed" });
    assert.equal(text(), frame, "the retry's framed reply must be the captured payload");
    const parsed = parseAiResultEnvelopeV1(text(), correlation);
    assert.equal(parsed.kind, "completed");
    assert.equal(count(), 2, "exactly one respawn: two total process invocations");
  });

  void it("respawns exactly once and accepts the framed retry, when the first reply is narration", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    const { path, count } = counterFile();
    const def = nudgeAwareDef({
      counterPath: path,
      nudgeMarker: "cannot be accepted",
      narrationText: "Let me think about this out loud first.",
      framedText: frame,
    });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.deepEqual(exit, { kind: "completed" });
    assert.equal(text(), frame, "the retry's framed reply must be the captured payload");
    const parsed = parseAiResultEnvelopeV1(text(), correlation);
    assert.equal(parsed.kind, "completed");
    assert.equal(count(), 2, "exactly one respawn: two total process invocations");
  });

  void it("never respawns when the first reply already carries the frame", async () => {
    const correlation = makeCorrelation();
    const frame = frameFor(correlation);
    const { path, count } = counterFile();
    // narrationText is unreachable here — the def always answers framed,
    // proving a framed FIRST reply is accepted without ever checking for a
    // nudge marker in the prompt.
    const def = nudgeAwareDef({
      counterPath: path,
      nudgeMarker: "__never_sent__",
      narrationText: frame,
      framedText: frame,
    });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer, text } = collectingWriter();
    const exit = await transport.invoke(makeRequest(correlation), writer);

    assert.deepEqual(exit, { kind: "completed" });
    assert.equal(text(), frame);
    assert.equal(count(), 1, "a framed first reply must not trigger a retry");
  });

  void it("never nudges a tool-only edit-mode round (no result frame is ever required)", async () => {
    const correlation = makeCorrelation();
    const { path, count } = counterFile();
    // Narrates forever without a frame — if the edit-mode path could nudge,
    // this def would need two spawns; it must instead never spawn at all,
    // since the mode guard rejects "edit" before any process starts.
    const def = nudgeAwareDef({
      counterPath: path,
      nudgeMarker: "__never_sent__",
      narrationText: "narrating, no frame",
      framedText: "narrating, no frame",
    });
    const transport = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() });
    const { writer } = collectingWriter();
    const request = { ...makeRequest(correlation), mode: "edit" as const };
    const exit = await transport.invoke(request, writer);

    assert.equal(exit.kind, "transportFailure");
    assert.equal(exit.kind === "transportFailure" && exit.code, "cliModeUnsupported");
    assert.equal(writer.bytesWritten, 0);
    assert.equal(count(), 0, "an edit-mode round must never spawn the CLI process at all");
  });
});

/**
 * One fixture per SHIPPED provider definition (review follow-up to the
 * output-shape-family tests above): each entry in CLI_PROVIDERS runs through
 * the real transport with its own declared traits — `structuredEventStream`,
 * `promptTransport`, `useShell`, `usesLastMessageFile`. Two things are
 * swapped for the scripted run: the executable becomes `node`, and
 * `buildArgs` is WRAPPED (not replaced) — the wrapper first invokes the
 * shipped definition's real `buildArgs` with the transport's exact arguments
 * and records the call, then substitutes the scripted-node argv for the
 * actual spawn. That seam proves, per definition, that the V1 call site
 * (`buildArgs("text", model, { cwd, promptFile })`) satisfies the
 * provider's own precondition contract (Antigravity throws without a
 * promptFile; codex-cli never reaches buildArgs because stdout capture is
 * rejected pre-spawn) and that the real argument construction succeeds under
 * it. Iterating the shipped list means a newly added definition is covered
 * (or fails loudly on an unrecognized event-stream schema) without editing
 * this suite.
 */
void describe("createCliTextTransportV1 per shipped CLI definition", () => {
  const createdScripts: string[] = [];
  let scriptCounter = 0;

  after(() => {
    for (const scriptPath of createdScripts) {
      try {
        nodeFs.unlinkSync(scriptPath);
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  function writeScript(body: string): string {
    const scriptPath = nodePath.join(
      os.tmpdir(),
      `vs-code-ai-helper-transport-fixture-${process.pid}-${scriptCounter++}.js`
    );
    nodeFs.writeFileSync(scriptPath, body, "utf8");
    createdScripts.push(scriptPath);
    return scriptPath;
  }

  /** One recorded invocation of a shipped definition's real `buildArgs`. */
  interface RecordedBuildArgsCallV1 {
    mode: CliRunMode;
    model: string | undefined;
    context: CliBuildArgsContext | undefined;
    /** What the REAL buildArgs produced for that invocation. */
    realArgs: string[];
  }

  /**
   * The shipped definition with the executable swapped to `node` running a
   * script file (no quoting hazards under the def's own `useShell` setting)
   * that emits the scripted stdout, and `buildArgs` wrapped: the wrapper
   * delegates to the shipped definition's REAL `buildArgs` first — so the
   * provider's own argument construction and precondition checks run with
   * exactly what the transport passes — records the call, then returns the
   * scripted argv for the spawn. A "file"-transport definition's script
   * additionally verifies the prompt actually arrived through the temp
   * prompt file the transport wrote, exercising that delivery path end to
   * end (Antigravity's contract).
   */
  function scriptedShippedDef(
    def: CliProviderDefinition,
    stdout: string
  ): { scripted: CliProviderDefinition; buildArgsCalls: RecordedBuildArgsCallV1[] } {
    const emit =
      `process.stdout.write(${JSON.stringify(stdout)});` + "process.exit(0);";
    const fileTransport = (def.promptTransport ?? "stdin") === "file";
    const body = fileTransport
      ? 'const fs = require("node:fs");' +
        'const prompt = fs.readFileSync(process.argv[2], "utf8");' +
        `if (prompt !== ${JSON.stringify(REQUEST_PROMPT)}) { process.exit(9); }` +
        emit
      : emit;
    const scriptPath = writeScript(body);
    const buildArgsCalls: RecordedBuildArgsCallV1[] = [];
    const scripted: CliProviderDefinition = {
      ...def,
      command: "node",
      commandAliases: undefined,
      buildArgs(
        mode: CliRunMode,
        model: string | undefined,
        context?: CliBuildArgsContext
      ): string[] {
        // Exercise the real construction under the transport's actual call
        // contract before substituting the scripted argv. If the provider's
        // preconditions reject the transport's arguments (e.g. Antigravity's
        // promptFile contract), this throws exactly as production would.
        const realArgs = def.buildArgs(mode, model, context);
        buildArgsCalls.push({ mode, model, context, realArgs });
        if (fileTransport) {
          if (!context?.promptFile) {
            throw new Error(
              `promptFile missing for file-transport definition ${def.id}`
            );
          }
          return [scriptPath, context.promptFile];
        }
        return [scriptPath];
      },
    };
    return { scripted, buildArgsCalls };
  }

  function stdoutFor(def: CliProviderDefinition, frame: string): string {
    if (def.structuredEventStream === "opencode") {
      return [
        JSON.stringify({ type: "step-start", part: { type: "step-start" } }),
        JSON.stringify({ type: "text", part: { type: "text", text: frame } }),
        "",
      ].join("\n");
    }
    if (def.structuredEventStream === "cline") {
      return [
        JSON.stringify({ type: "agent_event", event: { type: "content_start" } }),
        JSON.stringify({ type: "run_result", finishReason: "completed", text: frame }),
        "",
      ].join("\n");
    }
    if (def.structuredEventStream === "kimi") {
      // Kimi's stream-json message stream: narration and tool turns arrive as
      // earlier lines, and the LAST assistant `content` is the real answer —
      // which is exactly why this provider cannot use plain `text` mode (the
      // narration would precede the frame and fail the strict envelope parse).
      return [
        JSON.stringify({ role: "assistant", content: "Let me page through the file." }),
        JSON.stringify({ role: "tool", tool_call_id: "t1", content: "1\tfile contents" }),
        JSON.stringify({ role: "assistant", content: frame }),
        JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "s1" }),
        "",
      ].join("\n");
    }
    if (def.structuredEventStream === "codex") {
      // Codex's --json JSONL: reasoning and command items interleave, and the
      // LAST agent_message item is the real answer. Plain `text` mode cannot
      // be used here at all — Codex's human-readable stdout leads with a
      // banner and echoes the entire prompt back under a `user` heading, so
      // the frame would never be the first bytes of the capture.
      return [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "considering" } }),
        JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: frame } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        "",
      ].join("\n");
    }
    if (def.structuredEventStream === "claude") {
      // Claude Code CLI's --output-format stream-json: an init event, then
      // one `assistant` message per turn of output, and the LAST one is the
      // real answer — same "last message wins" shape as Codex/Kimi above,
      // and exactly why claude-cli's text mode moved off plain `text` (see
      // providers.ts's buildArgs comment).
      return [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Let me check that." }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: frame }] },
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: frame }),
        "",
      ].join("\n");
    }
    if (def.structuredEventStream !== undefined) {
      throw new Error(
        `Unrecognized structuredEventStream ${String(def.structuredEventStream)} for ${def.id} — add a fixture shape for it here.`
      );
    }
    return `${frame}\n`;
  }

  for (const shippedDef of CLI_PROVIDERS) {
    if (!cliProviderSupportsV1StdoutCapture(shippedDef)) {
      void it(`${shippedDef.id}: fails closed pre-spawn (last-message-file capture is not V1 stdout capture)`, async () => {
        const correlation = makeCorrelation();
        const transport = createCliTextTransportV1({
          def: shippedDef,
          model: undefined,
          cwd: process.cwd(),
        });
        const { writer } = collectingWriter();
        const exit = await transport.invoke(makeRequest(correlation), writer);
        assert.deepEqual(exit, {
          kind: "transportFailure",
          code: "cliStdoutCaptureUnsupported",
        });
        assert.equal(
          writer.bytesWritten,
          0,
          "an unsupported definition must write nothing to the result writer"
        );
      });
      continue;
    }

    void it(`${shippedDef.id}: captures one directly parseable framed envelope through its own declared transport`, async () => {
      const correlation = makeCorrelation();
      const frame = frameFor(correlation);
      const { scripted, buildArgsCalls } = scriptedShippedDef(
        shippedDef,
        stdoutFor(shippedDef, frame)
      );
      const cwd = process.cwd();
      const transport = createCliTextTransportV1({
        def: scripted,
        model: undefined,
        cwd,
      });
      const { writer, text } = collectingWriter();
      const exit = await transport.invoke(makeRequest(correlation), writer);

      assert.deepEqual(exit, { kind: "completed" });

      // The real buildArgs ran exactly once, under the V1 transport's exact
      // call contract: text mode, the transport's cwd, and a promptFile only
      // for "file"-transport definitions. (Results are captured only from
      // stdout, AC-RUNNER-02 — the last-message-file parameter no longer
      // exists on the signature at all.)
      assert.equal(buildArgsCalls.length, 1, "buildArgs must be invoked exactly once");
      const call = buildArgsCalls[0];
      assert.ok(call);
      assert.equal(call.mode, "text");
      assert.equal(call.model, undefined);
      assert.equal(call.context?.cwd, cwd);
      if ((shippedDef.promptTransport ?? "stdin") === "file") {
        const promptFile = call.context?.promptFile;
        assert.ok(promptFile, "file transport must receive the transport-written promptFile");
        assert.ok(
          call.realArgs.some((arg) => arg.includes(promptFile)),
          "the real args must reference the promptFile the transport supplied"
        );
      } else {
        assert.equal(
          call.context?.promptFile,
          undefined,
          "non-file transports must not receive a promptFile"
        );
      }
      // gemini-cli legitimately returns an empty argv in text mode (the
      // prompt travels via stdin and its read-only default needs no flags),
      // so the contract here is "constructed without throwing, all strings",
      // not non-emptiness.
      assert.ok(
        Array.isArray(call.realArgs) &&
          call.realArgs.every((arg) => typeof arg === "string"),
        "the real argument construction must succeed under the V1 call contract"
      );

      const captured = text();
      const expected =
        shippedDef.structuredEventStream !== undefined ? frame : `${frame}\n`;
      assert.equal(
        captured,
        expected,
        shippedDef.structuredEventStream !== undefined
          ? "the captured payload must be the unwrapped framed reply, not wrapper JSON"
          : "opaque stdout must pass through byte-for-byte"
      );
      const parsed = parseAiResultEnvelopeV1(captured, correlation);
      assert.equal(
        parsed.kind,
        "completed",
        "the captured payload must parse as one strict envelope"
      );
    });
  }
});
