/**
 * run1 Step 8: one decision settles a round, once, and the order signals arrive in does not decide it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  endOfTurnGraceForTestsV1,
  END_OF_TURN_EXIT_GRACE_MS_V1,
  execCliAgent,
  isErrorClaudeResultLineV1,
  recoveredReportOfStreamV1,
  isSuccessfulClaudeResultLineV1,
} from "../runners/cliAgentRunner";
import type { CliProviderDefinition } from "../runners/providers";
import { decideRoundSettlementV1 } from "../utils/roundSettlementV1";
import { safeRemoveDir } from "./testFsUtils";

const REPORT = "## Files Changed\n- src/a.ts\n\n## Verification\n- unit suite passes: 8676 tests, 0 fail";
const REPORT_AGAIN = `${REPORT}\n\n(posted again after a monitor woke the session)`;
const assistant = (text: string): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const successResult = (text: string): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text });
const ERROR_RESULT = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true });

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    safeRemoveDir(root);
  }
});

function claudeLikeDef(script: string): CliProviderDefinition {
  return {
    id: "claude-cli",
    label: "Fake Claude Code",
    command: "node",
    installHint: "install",
    loginHint: "login",
    authErrorMarkers: [],
    signInLabel: "Sign in",
    promptTransport: "stdin",
    useShell: false,
    models: [{ model: undefined, name: "default" }],
    usesLastMessageFile: false,
    structuredEventStream: "claude",
    textModeResponseContractV1: "repurposed-interactive-flow",
    buildArgs(): string[] {
      return ["-e", script];
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-settlement-"));
  roots.push(dir);
  return dir;
}

void describe("decideRoundSettlementV1 (run1 Step 8 precedence)", () => {
  void it("a successful result already received beats the owner's Cancel", () => {
    const decision = decideRoundSettlementV1([{ kind: "resultSuccess" }, { kind: "ownerCancel" }]);
    assert.equal(decision.outcome, "completed");
  });

  void it("the owner's Cancel beats a recovered report, a time cap and Ensemble's own stops", () => {
    for (const other of [
      { kind: "recoveredReport", text: "r" },
      { kind: "providerTimeCap" },
      { kind: "ensembleStop", cause: "ensembleBackstop" },
      { kind: "resultError" },
    ] as const) {
      assert.equal(decideRoundSettlementV1([other, { kind: "ownerCancel" }]).outcome, "cancelled");
      assert.equal(decideRoundSettlementV1([{ kind: "ownerCancel" }, other]).outcome, "cancelled");
    }
  });

  void it("a report recovered from a stream Ensemble stopped is completed, whatever stop came with it", () => {
    const decision = decideRoundSettlementV1([
      { kind: "ensembleStop", cause: "ensembleIdleStop" },
      { kind: "recoveredReport", text: REPORT },
    ]);
    assert.equal(decision.outcome, "completed");
    assert.equal(decision.outcome === "completed" ? decision.text : undefined, REPORT);
    assert.equal(decision.outcome === "completed" ? decision.stoppedByEnsemble : undefined, true);
  });

  void it("provider limits beat Ensemble's own stops, which beat the process simply ending", () => {
    assert.deepEqual(
      decideRoundSettlementV1([{ kind: "ensembleStop", cause: "ensembleBackstop" }, { kind: "providerTimeCap" }]),
      { outcome: "failed", cause: "providerTimeCap" }
    );
    assert.deepEqual(
      decideRoundSettlementV1([{ kind: "processEnded" }, { kind: "ensembleStop", cause: "ensembleRepeatStop" }]),
      { outcome: "failed", cause: "ensembleRepeatStop" }
    );
    assert.deepEqual(decideRoundSettlementV1([{ kind: "processEnded" }]), { outcome: "failed", cause: "processEnded" });
  });

  void it("an error result is a failure with a named cause, never completion", () => {
    assert.deepEqual(decideRoundSettlementV1([{ kind: "resultError" }, { kind: "processEnded" }]), {
      outcome: "failed",
      cause: "providerError",
    });
  });
});

void describe("a round is settled once by the runner (run1 Step 8)", () => {
  beforeEach(() => {
    endOfTurnGraceForTestsV1.ms = 300;
  });
  afterEach(() => {
    endOfTurnGraceForTestsV1.ms = END_OF_TURN_EXIT_GRACE_MS_V1;
  });

  const run = (script: string, token: vscode.CancellationToken = new vscode.CancellationTokenSource().token) =>
    execCliAgent({
      def: claudeLikeDef(script),
      mode: "edit",
      model: undefined,
      prompt: "do the work",
      cwd: process.cwd(),
      token,
    });

  void it("a result without the success subtype is not completion", () => {
    assert.equal(isSuccessfulClaudeResultLineV1(JSON.stringify({ type: "result", is_error: false, result: "x" })), false);
    assert.equal(isErrorClaudeResultLineV1(JSON.stringify({ type: "result", is_error: false, result: "x" })), true);
    assert.equal(isErrorClaudeResultLineV1(successResult("x")), false);
  });

  void it("an error result followed by exit code 0 is a failure with a named cause, not a completed round", async () => {
    const result = await run(`process.stdout.write(${JSON.stringify(`${ERROR_RESULT}\n`)});`);
    assert.equal(result.status, "failed");
    assert.equal(result.stopCauseV1, "providerError");
  });

  void it("a report that exists only in the terminal result event is kept", async () => {
    const result = await run(
      `process.stdout.write(${JSON.stringify(`${successResult(REPORT)}\n`)});setInterval(() => {}, 1000);`
    );
    assert.equal(result.status, "completed");
    assert.equal(result.output, REPORT);
  });

  void it("repeated complete reports after the first successful result do not replace the first", async () => {
    const stream = [assistant(REPORT), successResult(REPORT), assistant(REPORT_AGAIN), successResult(REPORT_AGAIN)].join("\n");
    const result = await run(`process.stdout.write(${JSON.stringify(`${stream}\n`)});`);
    assert.equal(result.status, "completed");
    assert.equal(result.output, REPORT);
  });

  void it("a Cancel pressed during the exit grace cannot discard the finished report", async () => {
    endOfTurnGraceForTestsV1.ms = 5_000;
    const source = new vscode.CancellationTokenSource();
    const script =
      `process.stdout.write(${JSON.stringify(`${assistant(REPORT)}\n${successResult(REPORT)}\n`)});setInterval(() => {}, 1000);`;
    const pending = run(script, source.token);
    await new Promise((resolve) => setTimeout(resolve, 600));
    source.cancel();
    const result = await pending;
    assert.equal(result.status, "completed");
    assert.equal(result.output, REPORT);
  });

  void it("a leader that ignores SIGTERM is still stopped within a bound, and nothing is left alive", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "leader.pid");
    const script =
      "process.on('SIGTERM', () => {});" +
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `process.stdout.write(${JSON.stringify(`${assistant(REPORT)}\n${successResult(REPORT)}\n`)});` +
      "setInterval(() => {}, 1000);";
    const startedAt = Date.now();
    const result = await run(script);
    assert.equal(result.status, "completed");
    assert.ok(Date.now() - startedAt < 15_000, "cleanup must be bounded");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(await waitFor(() => !isAlive(pid), 2_000), true, "the leader must be gone");
  });

  void it("a descendant that ignores SIGTERM is killed too before the outcome is handed on", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "descendant.pid");
    const script =
      "const cp = require('node:child_process');" +
      "const child = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });" +
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
      `process.stdout.write(${JSON.stringify(`${assistant(REPORT)}\n${successResult(REPORT)}\n`)});` +
      "setInterval(() => {}, 1000);";
    const result = await run(script);
    assert.equal(result.status, "completed");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    // Confirmed before the result was returned, not eventually: no waiting here.
    assert.equal(isAlive(pid), false, "the stubborn descendant must already be gone when the round settles");
  });

  void it("the exit that follows settlement does not settle the round again", async () => {
    const script =
      `process.stdout.write(${JSON.stringify(`${assistant(REPORT)}\n${successResult(REPORT)}\n`)});setInterval(() => {}, 1000);`;
    const result = await run(script);
    assert.equal(result.status, "completed");
    assert.equal(result.endOfTurnStopV1, true);
    assert.equal(result.stopCauseV1, "ensembleEndOfTurn");
  });
});

void describe("run1 Step 8 review fixes: Cancel ordering, error results in every mode, first report, descendants", () => {
  const runMode = (
    script: string,
    mode: "edit" | "text",
    token: vscode.CancellationToken = new vscode.CancellationTokenSource().token
  ) =>
    execCliAgent({
      def: claudeLikeDef(script),
      mode,
      model: undefined,
      prompt: "do the work",
      cwd: process.cwd(),
      token,
    });
  const emit = (text: string): string => `process.stdout.write(${JSON.stringify(text)});`;

  void it("a success that arrives AFTER the owner's Cancel does not override it", () => {
    assert.equal(decideRoundSettlementV1([{ kind: "ownerCancel" }, { kind: "resultSuccess" }]).outcome, "cancelled");
    assert.equal(decideRoundSettlementV1([{ kind: "resultSuccess" }, { kind: "ownerCancel" }]).outcome, "completed");
  });

  void it("a text-mode review whose terminal result is an error is failed even when the CLI exits 0", async () => {
    const result = await runMode(emit(`${ERROR_RESULT}\n`), "text");
    assert.equal(result.status, "failed");
    assert.equal(result.stopCauseV1, "providerError");
  });

  void it("an error result on a final line with no newline is still a failure", async () => {
    const result = await runMode(emit(ERROR_RESULT), "edit");
    assert.equal(result.status, "failed");
    assert.equal(result.stopCauseV1, "providerError");
  });

  void it("a successful result on a final line with no newline, then a non-zero exit, is still completed", async () => {
    const result = await runMode(`${emit(`${assistant(REPORT)}\n${successResult(REPORT)}`)}process.exit(3);`, "edit");
    assert.equal(result.status, "completed");
    assert.equal(result.output, REPORT);
  });

  void it("a later error result does not undo the first terminal result", async () => {
    const result = await runMode(emit(`${assistant(REPORT)}\n${successResult(REPORT)}\n${ERROR_RESULT}\n`), "edit");
    assert.equal(result.status, "completed");
  });

  void it("a stopped stream with complete report repetitions and no terminal result keeps the FIRST report", () => {
    const stream = [assistant(REPORT), assistant(REPORT_AGAIN), assistant(`${REPORT_AGAIN}\n(and once more)`)].join("\n");
    assert.equal(recoveredReportOfStreamV1(claudeLikeDef(""), `${stream}\n`), REPORT);
  });

  void it("an ordinary successful exit still stops a descendant the round left running, before the outcome is returned", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "leftover.pid");
    const script =
      "const cp = require('node:child_process');" +
      "const child = cp.spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });" +
      "child.unref();" +
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
      emit(`${assistant(REPORT)}\n${successResult(REPORT)}\n`);
    const result = await runMode(script, "edit");
    assert.equal(result.status, "completed");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    assert.equal(isAlive(pid), false, "the descendant must be gone when the outcome is returned");
  });
});

void describe("run1 Step 8: an ordinary exit is decided by the same settlement", () => {
  void it("an exit 0 with output and no cut-off completes the round", () => {
    const decision = decideRoundSettlementV1([{ kind: "processEnded", exit: { code: 0, hasOutput: true } }]);
    assert.equal(decision.outcome, "completed");
    if (decision.outcome === "completed") {
      assert.equal(decision.via, "exit");
      assert.equal(decision.stoppedByEnsemble, false);
    }
  });

  void it("an exit 0 with no output, or a non-zero exit, is a failure", () => {
    assert.deepEqual(decideRoundSettlementV1([{ kind: "processEnded", exit: { code: 0, hasOutput: false } }]), {
      outcome: "failed",
      cause: "processEnded",
    });
    assert.deepEqual(decideRoundSettlementV1([{ kind: "processEnded", exit: { code: 1, hasOutput: true } }]), {
      outcome: "failed",
      cause: "processEnded",
    });
  });

  void it("an exit 0 that names the provider's own cut-off is a provider time cap, never a completion", () => {
    assert.deepEqual(
      decideRoundSettlementV1([{ kind: "processEnded", exit: { code: 0, hasOutput: true, providerCutOff: true } }]),
      { outcome: "failed", cause: "providerTimeCap" }
    );
  });

  void it("an error result with exit 0 is a provider error, and a Cancel before a success still wins", () => {
    assert.deepEqual(
      decideRoundSettlementV1([{ kind: "resultError" }, { kind: "processEnded", exit: { code: 0, hasOutput: true } }]),
      { outcome: "failed", cause: "providerError" }
    );
    assert.equal(
      decideRoundSettlementV1([
        { kind: "ownerCancel" },
        { kind: "resultSuccess" },
        { kind: "processEnded", exit: { code: 0, hasOutput: true } },
      ]).outcome,
      "cancelled"
    );
  });

  void it("a repeat stop is its own failure cause", () => {
    assert.deepEqual(
      decideRoundSettlementV1([{ kind: "ensembleStop", cause: "ensembleRepeatStop" }, { kind: "processEnded" }]),
      { outcome: "failed", cause: "ensembleRepeatStop" }
    );
  });
});
