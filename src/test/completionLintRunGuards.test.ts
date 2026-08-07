/**
 * Coverage for collectCompletionLint's cancellation/timeout guards
 * (completionLint.ts's attachRunGuards, shared by runCheck and
 * runExplicitCheck). Before this, a lint/type-check/test command had no way
 * to be stopped short of the process exiting on its own — and since
 * buildVerifiedChecksVariable (reviewActions.ts) now runs these checks on
 * EVERY impl-high/impl-low/publish review round (not just at Publish), a
 * single hung command would block every subsequent review round
 * indefinitely with no recourse, even cancelling the operation from the UI.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { collectCompletionLint } from "../utils/completionLint";
import { safeRemoveDir } from "./testFsUtils";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-run-guards-test-"));
after(() => {
  // A killed check's process-tree teardown (taskkill /T) can still be
  // releasing file handles for a brief window after this test's own
  // assertions have already passed — best-effort cleanup, matching the
  // same EPERM-cleanup-race fix already applied to the git-fixture test
  // files (this is that same class of flake, now also possible here since
  // this file is the one that actually spawns and forcibly kills real
  // child processes).
  safeRemoveDir(TEST_ROOT);
});

function makeWorkspace(name: string, testScript: string): string {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "x",
        scripts: {
          lint: 'node -e "process.exit(0)"',
          "check-types": 'node -e "process.exit(0)"',
          test: testScript,
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

// A script that sleeps far longer than any timeout/cancellation this test
// configures, so a passing test proves the guard actually killed it rather
// than the script merely finishing first.
const LONG_SLEEP_SCRIPT = 'node -e "setTimeout(() => process.exit(0), 60000)"';

void describe("collectCompletionLint — timeout guard", () => {
  void it("kills a hung check after timeoutMs and reports it as a failure with a timeout marker", async () => {
    const dir = makeWorkspace("timeout-kills-hung-check", LONG_SLEEP_SCRIPT);
    const start = Date.now();
    const result = await collectCompletionLint(dir, [], { timeoutMs: 500 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 55_000, `must not wait for the full 60s sleep (took ${elapsed}ms)`);
    assert.strictEqual(result.passed, false);
    const testFailure = result.failedChecks.find((c) => c.command.includes("run test"));
    assert.ok(testFailure, "the hung test command must be reported as a failed check");
    assert.match(testFailure.output, /timed out after 500ms/);
  });

  void it("does not interfere with a normal, fast-completing check", async () => {
    const dir = makeWorkspace("timeout-does-not-affect-fast-check", 'node -e "process.exit(0)"');
    const result = await collectCompletionLint(dir, [], { timeoutMs: 30_000 });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.failedChecks.length, 0);
  });
});

void describe("collectCompletionLint — cancellation guard", () => {
  void it("kills a running check when the token is cancelled and reports a cancelled marker", async () => {
    const dir = makeWorkspace("cancellation-kills-running-check", LONG_SLEEP_SCRIPT);
    const tokenSource = new vscode.CancellationTokenSource();
    const start = Date.now();

    const resultPromise = collectCompletionLint(dir, [], {
      token: tokenSource.token,
      // A generous timeout so this test proves cancellation, not the timeout,
      // did the killing.
      timeoutMs: 55_000,
    });
    // Cancelling too soon after spawn is itself a real (narrow) race: on
    // Windows, npm.cmd's shell:true invocation chains cmd.exe -> npm.cmd ->
    // node.exe, and `taskkill /PID <pid> /T` only kills what's already in
    // the process tree at the moment it runs — cancel before the chain has
    // fully spawned and the eventual node.exe can end up orphaned outside
    // the tree taskkill saw. 2s is comfortably past that window even under
    // the concurrent process-spawning load of the full test suite (this
    // exact flake was observed at 300ms while running alongside ~1100
    // other tests, though it passed reliably at 300ms in isolation).
    setTimeout(() => tokenSource.cancel(), 2_000);

    const result = await resultPromise;
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 50_000, `must not wait for the full 60s sleep (took ${elapsed}ms)`);
    assert.strictEqual(result.passed, false);
    const testFailure = result.failedChecks.find((c) => c.command.includes("run test"));
    assert.ok(testFailure, "the cancelled test command must be reported as a failed check");
    assert.match(testFailure.output, /\[check cancelled\]/);

    tokenSource.dispose();
  });

  void it("an already-cancelled token still kills the check rather than letting it run to completion", async () => {
    const dir = makeWorkspace("pre-cancelled-token", LONG_SLEEP_SCRIPT);
    const tokenSource = new vscode.CancellationTokenSource();
    tokenSource.cancel();
    const start = Date.now();

    const result = await collectCompletionLint(dir, [], { token: tokenSource.token, timeoutMs: 55_000 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 50_000, `must not wait for the full 60s sleep (took ${elapsed}ms)`);
    assert.strictEqual(result.passed, false);

    tokenSource.dispose();
  });
});
