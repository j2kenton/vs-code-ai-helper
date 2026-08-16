/**
 * The read-only (text-mode) retry rule — timeout-then-success retries
 * freely, non-retryable classifications (auth errors, non-zero tool exits,
 * content errors) never retry — plus the stdout event-stream analysis itself
 * and the runLog-persisted retry-audit rendering (attempt, classification,
 * capability flag, evidence, delay). A timed-out edit-capable run never
 * auto-retries except via same-conversation resume.
 */
import * as assert from "node:assert/strict";
// `import cp = require(...)` (not `import * as cp from`) deliberately: the
// latter compiles (via __importStar/__createBinding) to a fresh object with
// non-configurable getter properties, which node:test's `t.mock.method`
// cannot install a mock onto ("methodName must be a method. Received
// undefined") because it reads the *own* descriptor's `value`, not the
// getter's return. `require` gives the real, mutable child_process module
// object, and cliAgentRunner.ts's own `cp.spawn` getter dereferences that
// same live object on every call, so mutating it here still takes effect.
import cp = require("child_process");
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  analyzeCliEventStream,
  CLI_RETRY_MAX_ATTEMPTS,
  composeCliTimeoutOutcomeV1,
  execCliAgent,
  formatRetryAuditLog,
  shouldRetryReadOnlyRun,
  __testOnly,
} from "../runners/cliAgentRunner";
import { CliProviderDefinition } from "../runners/providers";
import { classifyCliFailure } from "../utils/quota";

const { applyTransportTransience } = __testOnly;

/** A structured-stream provider def — text-based transport matching is only
 * trusted for providers like this (see applyTransportTransience). */
const STRUCTURED_PROVIDER_LIKE: CliProviderDefinition = {
  id: "opencode-cli",
  label: "OpenCode",
  command: "opencode",
  installHint: "Install opencode.",
  loginHint: "Run `opencode` and use /connect.",
  authErrorMarkers: ["login", "api key"],
  signInLabel: "Sign in",
  models: [],
  usesLastMessageFile: false,
  structuredEventStream: "opencode",
  buildArgs(): string[] {
    return ["run", "--format", "json"];
  },
};

/**
 * A structured-stream provider whose text mode is NOT enforced read-only
 * (Cline/Antigravity-shaped): every tool, including shell/file-write ones,
 * stays auto-approved regardless of mode. Its permissionWarning is the only
 * signal isTextModeGuaranteedReadOnly / applyTransportTransience use to
 * withhold the "text mode is side-effect free" trust an ordinary provider
 * gets.
 */
const UNENFORCED_TEXT_MODE_PROVIDER_LIKE: CliProviderDefinition = {
  ...STRUCTURED_PROVIDER_LIKE,
  id: "cline-cli",
  label: "Cline CLI",
  permissionWarning:
    "Runs with all tools auto-approved in every mode, including plan and review.",
};

void describe("analyzeCliEventStream", () => {
  void it("reports no stream for plain-text output", () => {
    const evidence = analyzeCliEventStream("Working on it...\nAll done.\n");
    assert.deepEqual(evidence, { streamAvailable: false, sawToolOrEditEvent: false });
  });

  void it("reports an available, clean stream for JSON events without tool activity", () => {
    const evidence = analyzeCliEventStream(
      '{"type":"message_start"}\n{"type":"text","text":"thinking"}\n{"type":"message_stop"}\n'
    );
    assert.equal(evidence.streamAvailable, true);
    assert.equal(evidence.sawToolOrEditEvent, false);
  });

  void it("detects tool-use events (Claude stream-json vocabulary)", () => {
    const evidence = analyzeCliEventStream(
      '{"type":"message_start"}\n{"type":"content_block_start","content_block":{"type":"tool_use","name":"Edit"}}\n'
    );
    assert.equal(evidence.streamAvailable, true);
    assert.equal(evidence.sawToolOrEditEvent, true);
  });

  void it("detects function-call / patch events (Codex vocabulary)", () => {
    const evidence = analyzeCliEventStream(
      '{"type":"item.started","item":{"function_call":{"name":"apply_patch"}}}\n'
    );
    assert.equal(evidence.sawToolOrEditEvent, true);
  });

  void it("ignores unparseable lines and ANSI noise without claiming a stream", () => {
    const evidence = analyzeCliEventStream("[32m{not json}[0m\n{broken\n");
    assert.equal(evidence.streamAvailable, false);
  });
});

void describe("isTextModeGuaranteedReadOnly", () => {
  void it("is true for a provider with no permissionWarning", () => {
    assert.equal(__testOnly.isTextModeGuaranteedReadOnly(STRUCTURED_PROVIDER_LIKE), true);
  });

  void it("is false for a provider that carries a permissionWarning", () => {
    assert.equal(
      __testOnly.isTextModeGuaranteedReadOnly(UNENFORCED_TEXT_MODE_PROVIDER_LIKE),
      false
    );
  });
});

void describe("shouldRetryReadOnlyRun", () => {
  void it("timeout-then-success: retries a timed-out read-only run, then stops once the next attempt completes", () => {
    // Attempt 1 times out — the one transport-transient failure shape.
    const timedOut = { status: "failed", transient: true } as const;
    assert.equal(shouldRetryReadOnlyRun(timedOut, 1, false), true);
    // Attempt 2 succeeds — the loop must stop retrying.
    const succeeded = { status: "completed" } as const;
    assert.equal(shouldRetryReadOnlyRun(succeeded, 2, false), false);
  });

  void it("non-retryable classifications (auth, tool exit, empty output) are never transient", () => {
    // Auth errors, non-zero tool exits, and content errors all flow through
    // classifyCliFailure, which assigns a failureKind but never the transient
    // flag. Transience is set by the runner, on the two transport-level shapes
    // only: a run timeout, and a mid-stream drop (see the positive case below).
    for (const errorMessage of [
      "Invalid API key. Please run /login.",
      "Claude Code CLI exited with code 1.",
      "Claude Code CLI produced no output.",
    ]) {
      const classified = classifyCliFailure({ status: "failed", errorMessage });
      assert.equal(
        (classified as { transient?: boolean }).transient,
        undefined,
        `classification must not mark "${errorMessage}" transient`
      );
      assert.equal(shouldRetryReadOnlyRun(classified, 1, false), false);
    }
  });

  void it("a mid-stream transport drop IS transient for a read-only run", () => {
    // Paired with the negative case above so that list cannot drift back into
    // a universal "nothing is ever transient" claim: before this was fixed, a
    // dropped stream classified generic, which is terminal at both cascade
    // gates — six consecutive real runs died that way with four healthy backup
    // models configured and never tried.
    const dropped = applyTransportTransience(
      classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: "OpenCode CLI failed: UnknownError: Streaming response failed",
      }),
      {
        message: "OpenCode CLI failed: UnknownError: Streaming response failed",
        authFailure: false,
        diagnosticText: "OpenCode CLI failed: UnknownError: Streaming response failed",
        retryableHint: false,
      },
      "text",
      STRUCTURED_PROVIDER_LIKE
    );

    assert.equal(dropped.transient, true);
    assert.equal(shouldRetryReadOnlyRun(dropped, 1, false), true);
  });

  void it("a mid-stream transport drop is NOT transient in text mode for a provider whose text mode isn't enforced read-only", () => {
    // Codex review P1: Cline (and pre-existingly Antigravity) run every tool
    // auto-approved in EVERY mode, not just edit — so an ambiguous transient
    // failure proves nothing about whether the run already mutated the
    // workspace. Promoting it here would let shouldRetryReadOnlyRun retry the
    // same model AND let the backup cascade (gated on failureKind alone in
    // runnerRegistry.ts) dispatch a different model, both against a
    // possibly-already-mutated tree. Paired with the positive case above so
    // this list can't drift back into "every text-mode transport drop is
    // always safe to promote".
    const dropped = applyTransportTransience(
      classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: "Cline CLI failed: UnknownError: Streaming response failed",
      }),
      {
        message: "Cline CLI failed: UnknownError: Streaming response failed",
        authFailure: false,
        diagnosticText: "Cline CLI failed: UnknownError: Streaming response failed",
        retryableHint: false,
      },
      "text",
      UNENFORCED_TEXT_MODE_PROVIDER_LIKE
    );

    assert.equal(dropped.transient, undefined);
    assert.equal(dropped.failureKind, "generic");
    assert.equal(shouldRetryReadOnlyRun(dropped, 1, false), false);
  });

  void it("stops at the attempt cap and on cancellation even for transient timeouts", () => {
    const timedOut = { status: "failed", transient: true } as const;
    assert.equal(shouldRetryReadOnlyRun(timedOut, CLI_RETRY_MAX_ATTEMPTS, false), false);
    assert.equal(shouldRetryReadOnlyRun(timedOut, 1, true), false);
  });
});

void describe("formatRetryAuditLog", () => {
  void it("records attempt, classification, capability flag, evidence, and delay per entry", () => {
    const log = formatRetryAuditLog("Claude Code", "edit", [
      {
        attempt: 1,
        classification: "transient (run timeout)",
        capabilityFlag: false,
        evidence: "same-conversation continuation — preserves prior provider context and workspace state",
        delayMs: 5000,
        retried: true,
      },
      {
        attempt: 2,
        classification: "transient (run timeout)",
        capabilityFlag: false,
        evidence: "Automatic retry is disabled for Claude Code edit runs: its CLI protocol does not guarantee edit events are flushed before side effects.",
        delayMs: 5000,
        retried: false,
      },
    ]);
    assert.match(log, /# CLI Retry Audit — Claude Code \(edit\)/);
    assert.match(log, /## Attempt 1/);
    assert.match(log, /Classification: transient \(run timeout\)/);
    assert.match(log, /flush-guarantee flag: false/);
    assert.match(log, /retried after 5s/);
    assert.match(log, /## Attempt 2/);
    assert.match(log, /Decision: not retried/);
  });

  void it("marks the capability flag n/a for read-only runs", () => {
    const log = formatRetryAuditLog("Gemini CLI", "text", [
      {
        attempt: 1,
        classification: "transient (run timeout)",
        capabilityFlag: undefined,
        evidence: "read-only run",
        delayMs: 5000,
        retried: true,
      },
    ]);
    assert.match(log, /n\/a \(read-only run\)/);
  });
});

/**
 * Part 7: the honest timeout-outcome message, composed once
 * filesChanged/filesChangedUnknown are known (AFTER the retry loop and the
 * post-run git snapshot — the defect this replaces composed the hedge text
 * BEFORE the snapshot existed, so it was always the vague hedge even for a
 * run that provably changed nothing, or provably changed N known files).
 */
void describe("composeCliTimeoutOutcomeV1 (Part 7 honest timeout message)", () => {
  void it("known non-empty change set: names the files instead of hedging", () => {
    const message = composeCliTimeoutOutcomeV1(
      "Claude Code CLI timed out after 60 minutes.",
      ["src/a.ts", "src/b.ts"],
      false,
      "Automatic retry is disabled for Claude Code edit runs"
    );
    assert.match(message, /timed out after changing 2 file\(s\): src\/a\.ts, src\/b\.ts/);
    assert.match(message, /review these before retrying/);
    assert.doesNotMatch(message, /may already have made changes/);
  });

  void it("known empty change set: states plainly the tree is clean, no hedge", () => {
    const message = composeCliTimeoutOutcomeV1(
      "Claude Code CLI timed out after 60 minutes.",
      [],
      false,
      "Automatic retry is disabled for Claude Code edit runs"
    );
    assert.match(message, /left the working tree clean — no files were changed/);
    assert.doesNotMatch(message, /may already have made changes/);
    assert.doesNotMatch(message, /changing \d+ file/);
  });

  void it("filesChangedUnknown: keeps the pre-existing hedge — git couldn't be consulted", () => {
    const message = composeCliTimeoutOutcomeV1(
      "Claude Code CLI timed out after 60 minutes.",
      [],
      true,
      "Automatic retry is disabled for Claude Code edit runs"
    );
    assert.match(message, /may already have made changes; review your working tree before retrying/);
  });

  void it("falls back to a generic base clause when no prior errorMessage exists", () => {
    const message = composeCliTimeoutOutcomeV1(undefined, [], false, "reason");
    assert.match(message, /^The run did not complete\./);
  });
});

/**
 * Part 7: the inactivity watchdog. Drives execCliAgent's actual spawn/timer
 * machinery with a mocked child_process.spawn and node:test's fake timers —
 * covers (a) the watchdog firing on genuine silence, (b) NOT firing while the
 * stream stays active well past the inactivity threshold, and (c) the
 * inactivity classification/message being distinct from the wall-clock one.
 *
 * Not covered here (documented rather than fabricated): the
 * `ensemble.resilience.inactivityTimeoutMinutes` setting itself is exercised
 * at its DEFAULT (15 minutes) only — the test-stub vscode `getConfiguration`
 * always returns the schema default for this key, so a non-default
 * configured value is not exercised by this suite. `readInactivityTimeout-
 * Minutes`'s own clamping (0-180, 0 disables) is plain arithmetic covered
 * implicitly by the analogous `readResilienceRounds`/`readQuotaResetThreshold-
 * Hours` coercion, not re-tested per-setting here.
 */
void describe("execCliAgent inactivity watchdog (Part 7)", () => {
  /** A fake CliProviderDefinition with a unique command per test so the
   * module-level PATH-lookup cache (commandExistsCache, TTL-based) never
   * serves a stale result across tests or test files. */
  const fakeDef = (): CliProviderDefinition => ({
    id: "opencode-cli",
    label: "Watchdog Test CLI",
    command: `watchdog-test-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    installHint: "n/a",
    loginHint: "n/a",
    authErrorMarkers: [],
    signInLabel: "Sign in",
    models: [],
    usesLastMessageFile: false,
    buildArgs(): string[] {
      return ["run"];
    },
  });

  const fakeToken = (): vscode.CancellationToken => ({
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose(): void {} }),
  });

  /** Installs a fake cp.spawn: the PATH-lookup (`where.exe`/`which`) spawn
   * always reports found; the real provider spawn returns a fake
   * EventEmitter-based child with pid left undefined so killProcessTree is a
   * no-op (no real process to signal). Returns the main child for the test
   * to drive stdout/close events on. */
  function installFakeSpawn(t: import("node:test").TestContext): { child: EventEmitter } {
    const handle: { child: EventEmitter } = { child: undefined as unknown as EventEmitter };
    t.mock.method(
      cp,
      "spawn",
      (command: string) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          pid?: number;
          kill: () => void;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = undefined;
        child.kill = () => {};
        if (command === "where.exe" || command === "which") {
          process.nextTick(() => child.emit("close", 0));
        } else {
          handle.child = child;
        }
        return child;
      }
    );
    return handle;
  }

  void it("fires on genuine silence, well before the 60-minute wall clock, with a distinct 'inactivity' classification", async (t) => {
    const handle = installFakeSpawn(t);
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

    const resultPromise = execCliAgent({
      def: fakeDef(),
      mode: "text",
      model: undefined,
      prompt: "prompt",
      cwd: process.cwd(),
      token: fakeToken(),
    });
    // Real setImmediate (not faked) lets the PATH-lookup microtask/close
    // event and the subsequent real spawn call land before fake time moves.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(handle.child, "the main provider spawn must have been invoked");

    // Default ensemble.resilience.inactivityTimeoutMinutes is 15 (the
    // test-stub vscode config always answers the schema default). No
    // activity is ever emitted, so the watchdog's 15-second poll must catch
    // it at the 15-minute mark — long before the 60-minute wall clock.
    t.mock.timers.tick(15 * 60_000);

    const result = await resultPromise;
    assert.equal(result.status, "failed");
    assert.equal(result.timeoutReason, "inactivity");
    assert.match(result.errorMessage ?? "", /produced no output for 15 minute\(s\)/);
  });

  void it("does NOT fire while the stream stays active past the inactivity threshold", async (t) => {
    const handle = installFakeSpawn(t);
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

    const resultPromise = execCliAgent({
      def: fakeDef(),
      mode: "text",
      model: undefined,
      prompt: "prompt",
      cwd: process.cwd(),
      token: fakeToken(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(handle.child, "the main provider spawn must have been invoked");

    // 5 x 5 minutes = 25 minutes total, well past the 15-minute inactivity
    // threshold — but a chunk lands every 5 minutes (under the threshold),
    // so lastActivityAt never goes stale enough to trip the watchdog.
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(5 * 60_000);
      (handle.child as unknown as { stdout: EventEmitter }).stdout.emit(
        "data",
        Buffer.from("still working...\n")
      );
    }
    handle.child.emit("close", 0);

    const result = await resultPromise;
    // Reached a normal close — the watchdog never killed the process, which
    // would have produced status "failed" with timeoutReason "inactivity".
    assert.equal(result.status, "completed");
    assert.equal(result.timeoutReason, undefined);
  });

  void it("the wall-clock timeout is classified/worded distinctly from an inactivity kill", async (t) => {
    const handle = installFakeSpawn(t);
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

    const resultPromise = execCliAgent({
      def: fakeDef(),
      mode: "text",
      model: undefined,
      prompt: "prompt",
      cwd: process.cwd(),
      token: fakeToken(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(handle.child, "the main provider spawn must have been invoked");

    // Keep activity flowing every 10 minutes (under the 15-minute inactivity
    // threshold) all the way to the 60-minute wall clock, so ONLY the flat
    // wall-clock cap — never the inactivity watchdog — can fire.
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(10 * 60_000);
      (handle.child as unknown as { stdout: EventEmitter }).stdout.emit(
        "data",
        Buffer.from("still working...\n")
      );
    }

    const result = await resultPromise;
    assert.equal(result.status, "failed");
    assert.equal(result.timeoutReason, "wall-clock");
    assert.match(result.errorMessage ?? "", /timed out after 60 minutes/);
    // Distinct from the inactivity wording pinned above.
    assert.doesNotMatch(result.errorMessage ?? "", /produced no output/);
  });
});
