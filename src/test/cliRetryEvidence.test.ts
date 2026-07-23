/**
 * The edit-run auto-retry evidence matrix (plan Workstream 5): a timed-out
 * edit-capable CLI run may only be retried automatically when the provider
 * carries the flush-guarantee capability flag AND the parsed event stream
 * was available and free of tool-use/file-edit events AND the working-tree
 * snapshot is unchanged. Every other combination refuses the retry. Also
 * covers the read-only (text-mode) retry rule — timeout-then-success retries
 * freely, non-retryable classifications (auth errors, non-zero tool exits,
 * content errors) never retry — plus the stdout event-stream analysis itself
 * and the runLog-persisted retry-audit rendering (attempt, classification,
 * capability flag, evidence, delay).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeCliEventStream,
  CLI_RETRY_MAX_ATTEMPTS,
  evaluateEditRetryEligibility,
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

void describe("evaluateEditRetryEligibility", () => {
  const cleanEvidence = { streamAvailable: true, sawToolOrEditEvent: false };

  void it("never retries on a provider without the flush guarantee, even with clean evidence", () => {
    const decision = evaluateEditRetryEligibility({
      providerLabel: "Claude Code",
      guaranteesEditEventFlushBeforeSideEffects: false,
      evidence: cleanEvidence,
      snapshotClean: true,
    });
    assert.equal(decision.retry, false);
    assert.match(decision.reason, /does not guarantee/);
  });

  void it("refuses when no event stream was available on a guaranteed provider", () => {
    const decision = evaluateEditRetryEligibility({
      providerLabel: "X",
      guaranteesEditEventFlushBeforeSideEffects: true,
      evidence: { streamAvailable: false, sawToolOrEditEvent: false },
      snapshotClean: true,
    });
    assert.equal(decision.retry, false);
    assert.match(decision.reason, /No parseable event stream/);
  });

  void it("refuses when evidence is entirely missing", () => {
    const decision = evaluateEditRetryEligibility({
      providerLabel: "X",
      guaranteesEditEventFlushBeforeSideEffects: true,
      evidence: undefined,
      snapshotClean: true,
    });
    assert.equal(decision.retry, false);
  });

  void it("refuses when the stream shows tool/edit activity", () => {
    const decision = evaluateEditRetryEligibility({
      providerLabel: "X",
      guaranteesEditEventFlushBeforeSideEffects: true,
      evidence: { streamAvailable: true, sawToolOrEditEvent: true },
      snapshotClean: true,
    });
    assert.equal(decision.retry, false);
    assert.match(decision.reason, /tool\/edit activity/);
  });

  void it("refuses when the working-tree snapshot changed even with a clean stream", () => {
    const decision = evaluateEditRetryEligibility({
      providerLabel: "X",
      guaranteesEditEventFlushBeforeSideEffects: true,
      evidence: cleanEvidence,
      snapshotClean: false,
    });
    assert.equal(decision.retry, false);
    assert.match(decision.reason, /working tree/i);
  });

  void it("retries only with the full evidence set: flag + clean stream + clean snapshot", () => {
    const decision = evaluateEditRetryEligibility({
      providerLabel: "X",
      guaranteesEditEventFlushBeforeSideEffects: true,
      evidence: cleanEvidence,
      snapshotClean: true,
    });
    assert.equal(decision.retry, true);
    assert.match(decision.reason, /clean event stream/);
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
        capabilityFlag: true,
        evidence: "clean event stream + unchanged snapshot",
        delayMs: 5000,
        retried: true,
      },
      {
        attempt: 2,
        classification: "transient (run timeout)",
        capabilityFlag: true,
        evidence: "event stream shows tool/edit activity",
        delayMs: 5000,
        retried: false,
      },
    ]);
    assert.match(log, /# CLI Retry Audit — Claude Code \(edit\)/);
    assert.match(log, /## Attempt 1/);
    assert.match(log, /Classification: transient \(run timeout\)/);
    assert.match(log, /flush-guarantee flag: true/);
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
