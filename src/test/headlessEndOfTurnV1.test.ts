/**
 * run1 Step 10 (bugs6 item 14): a headless Claude edit round ends when the model's turn ends.
 *
 * Session 4003f046… wrote its complete report at 18:09:34 and then stayed alive on leftover
 * Monitor waits that woke it to repeat the report; nothing ended the run until the wall clock did,
 * and the report was lost. The first successful `result` event now starts a short exit grace; a
 * process still alive after it is stopped with its whole process tree and the round settles as
 * completed with the model's answer.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  endOfTurnGraceForTestsV1,
  execCliAgent,
  END_OF_TURN_EXIT_GRACE_MS_V1,
  isSuccessfulClaudeResultLineV1,
} from "../runners/cliAgentRunner";
import type { CliProviderDefinition } from "../runners/providers";
import { safeRemoveDir } from "./testFsUtils";

const REPORT = "## Files Changed\n- src/a.ts\n\n## Verification\n- unit suite passes: 8676 tests, 0 fail";
const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: REPORT }] },
});
const SUCCESS_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: REPORT });
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

void describe("headless Claude edit round ends at the end of the model's turn (run1 Step 10)", () => {
  beforeEach(() => {
    endOfTurnGraceForTestsV1.ms = 400;
  });
  afterEach(() => {
    endOfTurnGraceForTestsV1.ms = END_OF_TURN_EXIT_GRACE_MS_V1;
  });

  void it("only a successful result event counts as the end of the turn", () => {
    assert.equal(isSuccessfulClaudeResultLineV1(SUCCESS_RESULT), true);
    assert.equal(isSuccessfulClaudeResultLineV1(ERROR_RESULT), false);
    assert.equal(isSuccessfulClaudeResultLineV1(ASSISTANT), false);
    assert.equal(isSuccessfulClaudeResultLineV1("not json at all"), false);
    assert.equal(isSuccessfulClaudeResultLineV1(JSON.stringify({ type: "result", is_error: true, subtype: "success" })), false);
  });

  void it("a fake CLI that prints a successful result and then keeps running ends with that result", async () => {
    const script =
      `process.stdout.write(${JSON.stringify(`${ASSISTANT}\n${SUCCESS_RESULT}\n`)});` +
      "setInterval(() => {}, 1000);";
    const startedAt = Date.now();
    const result = await execCliAgent({
      def: claudeLikeDef(script),
      mode: "edit",
      model: undefined,
      prompt: "do the work",
      cwd: process.cwd(),
      token: new vscode.CancellationTokenSource().token,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output, REPORT);
    assert.equal(result.endOfTurnStopV1, true);
    assert.ok(Date.now() - startedAt < 20_000, "the run must end within moments of the answer, not at a limit");
  });

  void it("a background child started by the round does not outlive it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-end-of-turn-"));
    roots.push(dir);
    const pidFile = path.join(dir, "child.pid");
    const script =
      "const cp = require('node:child_process');" +
      "const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
      `process.stdout.write(${JSON.stringify(`${ASSISTANT}\n${SUCCESS_RESULT}\n`)});` +
      "setInterval(() => {}, 1000);";
    const result = await execCliAgent({
      def: claudeLikeDef(script),
      mode: "edit",
      model: undefined,
      prompt: "do the work",
      cwd: process.cwd(),
      token: new vscode.CancellationTokenSource().token,
    });
    assert.equal(result.status, "completed");
    assert.ok(fs.existsSync(pidFile), "the fake CLI must have started its background child");
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(childPid > 0);
    assert.equal(await waitFor(() => !isAlive(childPid), 5_000), true, "the background child must be gone");
  });

  void it("a non-zero exit right after a successful result is still a completed round", async () => {
    const script =
      `process.stdout.write(${JSON.stringify(`${ASSISTANT}\n${SUCCESS_RESULT}\n`)});` +
      "setTimeout(() => process.exit(3), 50);";
    const result = await execCliAgent({
      def: claudeLikeDef(script),
      mode: "edit",
      model: undefined,
      prompt: "do the work",
      cwd: process.cwd(),
      token: new vscode.CancellationTokenSource().token,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output, REPORT);
    assert.equal(result.endOfTurnStopV1, undefined, "the process exited by itself inside the grace");
  });

  void it("an error result is never completion: it is classified as a failure", async () => {
    const script =
      `process.stdout.write(${JSON.stringify(`${ERROR_RESULT}\n`)});` +
      "setTimeout(() => process.exit(1), 50);";
    const result = await execCliAgent({
      def: claudeLikeDef(script),
      mode: "edit",
      model: undefined,
      prompt: "do the work",
      cwd: process.cwd(),
      token: new vscode.CancellationTokenSource().token,
    });
    assert.equal(result.status, "failed");
  });
});
