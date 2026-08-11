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

    assert.deepEqual(exit, { kind: "transportFailure", code: "cliExit.3" });
    assert.equal(
      writer.bytesWritten,
      0,
      "a failed structured run must not write wrapper bytes to the result writer"
    );
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

    assert.deepEqual(exit, { kind: "transportFailure", code: "cliEventStreamTooLarge" });
    assert.equal(writer.bytesWritten, 0, "an overflowed event stream must never reach the writer");
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
 * (`buildArgs("text", model, undefined, { cwd, promptFile })`) satisfies the
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
    lastMessageFile: string | undefined;
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
        lastMessageFile: string | undefined,
        context?: CliBuildArgsContext
      ): string[] {
        // Exercise the real construction under the transport's actual call
        // contract before substituting the scripted argv. If the provider's
        // preconditions reject the transport's arguments (e.g. Antigravity's
        // promptFile contract), this throws exactly as production would.
        const realArgs = def.buildArgs(mode, model, lastMessageFile, context);
        buildArgsCalls.push({ mode, model, lastMessageFile, context, realArgs });
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
      // call contract: text mode, no last-message file (results are captured
      // only from stdout, AC-RUNNER-02), the transport's cwd, and a
      // promptFile only for "file"-transport definitions.
      assert.equal(buildArgsCalls.length, 1, "buildArgs must be invoked exactly once");
      const call = buildArgsCalls[0];
      assert.ok(call);
      assert.equal(call.mode, "text");
      assert.equal(call.model, undefined);
      assert.equal(
        call.lastMessageFile,
        undefined,
        "V1 stdout capture must never supply a last-message file"
      );
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
