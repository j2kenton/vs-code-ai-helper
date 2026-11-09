/**
 * run1 Step 8: the sealed text transport asks the same one settlement decision as the editing runner.
 * A Claude stream whose first terminal `result` is a success has already delivered the answer, so a
 * later non-zero exit, a Cancel or a watchdog stop never throws it away; a Cancel pressed with no
 * result yet stays a cancel.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { createCliTextTransportV1 } from "../runners/cliAgentRunner";
import type { CliProviderDefinition } from "../runners/providers";
import { allocateHex128IdV1, type ActionCorrelationV1 } from "../types/actionCorrelationV1";
import type { AgentExecutionRequestV1, BoundedResultWriterV1 } from "../types/agentExecutionV1";
import { parseAiResultEnvelopeV1 } from "../types/aiResultEnvelope";

const FRAME_START = "<<<ENSEMBLE_AI_RESULT_V1>>>";
const FRAME_END = "<<<END_ENSEMBLE_AI_RESULT_V1>>>";

function correlation(): ActionCorrelationV1 {
  return {
    actionKey: "textTransportSettlementTest.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

function frameFor(c: ActionCorrelationV1): string {
  const envelope = {
    version: 1,
    correlation: c,
    kind: "completed",
    content: { contentType: "chat-message.v1", schemaVersion: 1, text: "final answer" },
  };
  return `${FRAME_START}\n${JSON.stringify(envelope)}\n${FRAME_END}`;
}

function claudeStream(frame: string, result: "success" | "error"): string {
  return (
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: frame }] } }),
      JSON.stringify(
        result === "success"
          ? { type: "result", subtype: "success", is_error: false, result: frame }
          : { type: "result", subtype: "error_during_execution", is_error: true }
      ),
    ].join("\n") + "\n"
  );
}

/** A "claude-cli" whose process is node: prints `stdout`, then exits with `exitCode` or stays alive. */
function scripted(stdout: string, behaviour: { exitCode: number } | { staysAlive: true }): CliProviderDefinition {
  const tail =
    "exitCode" in behaviour ? `process.exitCode=${behaviour.exitCode};` : "setInterval(function(){},1000);";
  const script = `require("node:fs").writeSync(1, ${JSON.stringify(stdout)});${tail}`;
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
    structuredEventStream: "claude",
    promptTransport: "stdin",
    useShell: false,
    buildArgs(): string[] {
      return ["-e", script];
    },
  };
}

function cancellable(): { token: vscode.CancellationToken; cancel: () => void } {
  const listeners: Array<() => void> = [];
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: (): void => undefined };
      },
    } as unknown as vscode.CancellationToken,
    cancel: (): void => {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function request(c: ActionCorrelationV1, token: vscode.CancellationToken): AgentExecutionRequestV1 {
  return {
    correlation: c,
    reservationId: allocateHex128IdV1(),
    mode: "text",
    prompt: "prompt text",
    maxResponseBytes: 4 * 1024 * 1024,
    cancellationToken: token,
  };
}

function collecting(): { writer: BoundedResultWriterV1; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    writer: {
      write(chunk: Uint8Array | string): boolean {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
        return true;
      },
    } as unknown as BoundedResultWriterV1,
    text: (): string => Buffer.concat(chunks).toString("utf8"),
  };
}

void describe("run1 Step 8: text transport settlement precedence", () => {
  void it("a successful result followed by a non-zero exit is one completed outcome", async () => {
    const c = correlation();
    const frame = frameFor(c);
    const def = scripted(claudeStream(frame, "success"), { exitCode: 3 });
    const { writer, text } = collecting();
    const exit = await createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() }).invoke(
      request(c, cancellable().token),
      writer
    );
    assert.deepEqual(exit, { kind: "completed" });
    assert.equal(parseAiResultEnvelopeV1(text(), c).kind, "completed");
  });

  void it("an error result with a non-zero exit stays a failure", async () => {
    const c = correlation();
    const def = scripted(claudeStream(frameFor(c), "error"), { exitCode: 1 });
    const { writer, text } = collecting();
    const exit = await createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() }).invoke(
      request(c, cancellable().token),
      writer
    );
    assert.equal(exit.kind, "transportFailure");
    assert.equal(text(), "");
  });

  void it("a Cancel pressed after the successful result keeps the finished answer", async () => {
    const c = correlation();
    const frame = frameFor(c);
    const def = scripted(claudeStream(frame, "success"), { staysAlive: true });
    const token = cancellable();
    const { writer, text } = collecting();
    const pending = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() }).invoke(
      request(c, token.token),
      writer
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    token.cancel();
    const exit = await pending;
    assert.deepEqual(exit, { kind: "completed" });
    assert.equal(parseAiResultEnvelopeV1(text(), c).kind, "completed");
  });

  void it("a Cancel with no result yet stays a cancel", async () => {
    const c = correlation();
    const def = scripted(JSON.stringify({ type: "system", subtype: "init" }) + "\n", { staysAlive: true });
    const token = cancellable();
    const { writer, text } = collecting();
    const pending = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() }).invoke(
      request(c, token.token),
      writer
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    token.cancel();
    const exit = await pending;
    assert.equal(exit.kind, "callerCancelled");
    assert.equal(text(), "");
  });

  void it(
    "a Cancel pressed while leftover processes are being stopped still wins over an ordinary exit",
    { skip: process.platform === "win32" },
    async () => {
      const c = correlation();
      const initLine = JSON.stringify({ type: "system", subtype: "init" }) + "\n";
      // Exits 0 at once, leaving a descendant that ignores SIGTERM: the cleanup that follows the
      // exit takes seconds, and the Cancel arrives in the middle of it.
      const script =
        `require("node:fs").writeSync(1, ${JSON.stringify(initLine)});` +
        `require("node:child_process").spawn("sh", ["-c", "trap '' TERM; sleep 30"], { stdio: "ignore" });`;
      const def: CliProviderDefinition = {
        ...scripted("", { exitCode: 0 }),
        buildArgs: (): string[] => ["-e", script],
      };
      const token = cancellable();
      const { writer, text } = collecting();
      const pending = createCliTextTransportV1({ def, model: undefined, cwd: process.cwd() }).invoke(
        request(c, token.token),
        writer
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      token.cancel();
      const exit = await pending;
      assert.equal(exit.kind, "callerCancelled");
      assert.equal(text(), "");
    }
  );
});
