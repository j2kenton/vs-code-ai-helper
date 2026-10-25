/**
 * Post-1.0 fixes, item 5: a Codex edit round (Implementation, Apply Review,
 * Fix Linting) that ends with "Selected model is at capacity" is retried on
 * the same model, then reported as a temporary unavailability that the
 * backup cascade can act on — not stopped as a generic failure.
 */
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runImplementationWithCli } from "../runners/cliAgentRunner";
import type { CliProviderDefinition } from "../runners/providers";
import { describeMidRoundOutcomeV1 } from "../utils/stopBehaviourV1";
import { safeRemoveDir } from "./testFsUtils";

const CAPACITY_REPLY = "Selected model is at capacity. Please try a different model.";

function fakeCodexProvider(script: string): CliProviderDefinition {
  return {
    id: "codex-cli",
    label: "OpenAI Codex",
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
      return ["-e", script];
    },
  };
}

/** Appends a line to `counterFile` per run, so the test counts invocations. */
function countingScript(counterFile: string, body: string): string {
  return `require("fs").appendFileSync(${JSON.stringify(counterFile)}, "x\\n"); ${body}`;
}

function runCount(counterFile: string): number {
  return fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0;
}

async function runEdit(def: CliProviderDefinition, workspace: string): ReturnType<typeof runImplementationWithCli> {
  const cts = new vscode.CancellationTokenSource();
  return runImplementationWithCli({
    def,
    model: undefined,
    prompt: "Implement the requested change.",
    workspaceUri: vscode.Uri.file(workspace),
    token: cts.token,
    onProgress: () => undefined,
    requireFileChange: true,
    retryDelayMs: 1,
    typeCheckRunner: () => Promise.resolve({ passed: true, output: "" }),
  });
}

void describe("Codex edit-mode capacity replies (item 5)", () => {
  void it("retries the same model after a capacity reply and completes when a retry succeeds", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-ok-"));
    const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-count-"));
    const counter = path.join(counterDir, "runs.txt");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const script = countingScript(
        counter,
        `const n = require("fs").readFileSync(${JSON.stringify(counter)}, "utf8").split("\\n").filter(Boolean).length;` +
          ` if (n < 3) { process.stderr.write(${JSON.stringify(CAPACITY_REPLY)}); process.exit(1); }` +
          ` require("fs").writeFileSync("done.txt", "ok"); process.stdout.write("done");`
      );
      const result = await runEdit(fakeCodexProvider(script), workspace);
      assert.strictEqual(result.status, "completed");
      assert.strictEqual(runCount(counter), 3, "two retries on the same model, the third attempt succeeds");
      assert.deepStrictEqual(result.filesChanged, ["done.txt"]);
    } finally {
      safeRemoveDir(workspace);
      safeRemoveDir(counterDir);
    }
  });

  void it("after the retry limit reports a temporary unavailability flagged as capacity, not a generic failure", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-fail-"));
    const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-count-"));
    const counter = path.join(counterDir, "runs.txt");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const script = countingScript(counter, `process.stderr.write(${JSON.stringify(CAPACITY_REPLY)}); process.exit(1);`);
      const result = await runEdit(fakeCodexProvider(script), workspace);
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(runCount(counter), 3, "the first attempt plus the text path's two retries");
      assert.strictEqual(result.failureKind, "temporarily-unavailable");
      assert.strictEqual(result.providerCapacity, true);
      assert.deepStrictEqual(result.filesChanged, []);
    } finally {
      safeRemoveDir(workspace);
      safeRemoveDir(counterDir);
    }
  });

  void it("does not replay a round that already changed files, but still classifies it as capacity", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-dirty-"));
    const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-count-"));
    const counter = path.join(counterDir, "runs.txt");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const script = countingScript(
        counter,
        `require("fs").writeFileSync("partial.txt", "half"); process.stderr.write(${JSON.stringify(CAPACITY_REPLY)}); process.exit(1);`
      );
      const result = await runEdit(fakeCodexProvider(script), workspace);
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(runCount(counter), 1, "a dirty tree is never replayed");
      assert.strictEqual(result.failureKind, "temporarily-unavailable");
      assert.strictEqual(result.providerCapacity, true);
      assert.deepStrictEqual(result.filesChanged, ["partial.txt"]);
    } finally {
      safeRemoveDir(workspace);
      safeRemoveDir(counterDir);
    }
  });

  void it("leaves other providers' generic failures alone", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-other-"));
    const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-capacity-count-"));
    const counter = path.join(counterDir, "runs.txt");
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    try {
      const script = countingScript(counter, `process.stderr.write(${JSON.stringify(CAPACITY_REPLY)}); process.exit(1);`);
      const result = await runEdit({ ...fakeCodexProvider(script), id: "antigravity-cli" }, workspace);
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(runCount(counter), 1);
      assert.notStrictEqual(result.providerCapacity, true);
    } finally {
      safeRemoveDir(workspace);
      safeRemoveDir(counterDir);
    }
  });

  void it("the stop message says the model was at capacity, a temporary overload at OpenAI", () => {
    const message = describeMidRoundOutcomeV1("OpenAI Codex", CAPACITY_REPLY, {
      kind: "backupsExhausted",
      capacity: true,
      backups: [{ label: "OpenCode kimi", outcome: "tried-and-failed", reason: "it failed" }],
      remedyText: "Rerun this stage.",
    });
    assert.match(message, /the model was at capacity \(a temporary overload at OpenAI\)/);
    assert.doesNotMatch(message, /generic failure|usage limit/);
    const noBackup = describeMidRoundOutcomeV1("OpenAI Codex", CAPACITY_REPLY, {
      kind: "noBackupConfigured",
      failureKind: "temporarily-unavailable",
      capacity: true,
    });
    assert.match(noBackup, /the model was at capacity \(a temporary overload at OpenAI\)/);
  });
});
