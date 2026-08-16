/**
 * Coverage for the registry's V1 reservation-based selection
 * (`openV1RunnerSelection`, plan §3.3/§3.4, executable-order step 5):
 *  - the registry — not the caller — chooses the runner/provider/model for
 *    every reservation, reusing the exact legacy ranking policy (the stored
 *    primary first, then the strategy-gated `backupModelsForStage` list);
 *  - every reservation is issued through the caller's selection session, so
 *    the session's one-reservation-per-attempt, claim-once, and
 *    fallback-only-after-pre-response rules all apply (AC-RUNNER-03/04);
 *  - candidates that cannot satisfy the requested mode are rejected at
 *    selection time (plan §3.4) and never silently bypassed: preflight/edit
 *    have no qualifying provider yet, and a last-message-file CLI cannot
 *    satisfy AC-RUNNER-02's stdout-only capture for text — as sole candidate
 *    the selection is providerModeUnavailable, and as a ranked candidate
 *    ahead of a capable backup it becomes an explicit settled attempt
 *    (providerUnavailablePreInvocation) before any backup attempt exists;
 *  - each reserved candidate constructs a transport for exactly the runner
 *    named in its reservation handle (the broker rejects any other).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  openV1RunnerSelection,
  preflightStageChainAvailabilityV1,
} from "../runners/runnerRegistry";
import {
  openProviderSelectionSessionV1,
  ProviderSelectionSessionV1,
} from "../services/providerSelectionPolicyV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { AgentExecutionModeV1 } from "../types/agentExecutionV1";

function installModelSettings(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : defaultValue,
    inspect: () => undefined,
  });

  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

function openSession(): ProviderSelectionSessionV1 {
  return openProviderSelectionSessionV1({
    actionKey: "generatePlan.v1",
    operationId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  });
}

function openSelection(options: {
  session: ProviderSelectionSessionV1;
  mode: AgentExecutionModeV1;
  modelId: string | undefined;
  requireGuaranteedReadOnlyText?: boolean;
}): ReturnType<typeof openV1RunnerSelection> {
  return openV1RunnerSelection({
    session: options.session,
    mode: options.mode,
    modelId: options.modelId,
    stage: "impl-high-review",
    workspaceCwd: "/workspace",
    requireGuaranteedReadOnlyText: options.requireGuaranteedReadOnlyText,
  });
}

void describe("openV1RunnerSelection", () => {
  void it("ranks the stored primary first, then strategy-gated backups, then exhausts", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "copilot:gpt-5",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({ session, mode: "text", modelId: "copilot:gpt-5" });

      const first = selection.reserveNext(session.allocateAttempt());
      assert.equal(first.kind, "reserved");
      if (first.kind !== "reserved") {
        assert.fail("expected the primary to be reserved first");
      }
      assert.equal(first.reserved.handle.runnerId, "copilot-lm");
      assert.equal(first.reserved.handle.providerId, "copilot");
      assert.equal(first.reserved.handle.modelId, "copilot:gpt-5");
      assert.equal(first.reserved.storedModelId, "copilot:gpt-5");
      session.reportAttemptOutcome(
        first.reserved.handle.correlation.attemptId,
        "providerUnavailablePreInvocation"
      );

      const second = selection.reserveNext(session.allocateAttempt());
      assert.equal(second.kind, "reserved");
      if (second.kind !== "reserved") {
        assert.fail("expected the strategy-gated backup to be reserved second");
      }
      assert.equal(second.reserved.handle.runnerId, "claude-cli");
      assert.equal(second.reserved.handle.providerId, "claude-cli");
      assert.equal(second.reserved.handle.modelId, "claude-cli:sonnet");
      session.reportAttemptOutcome(
        second.reserved.handle.correlation.attemptId,
        "transportFailurePreResponse"
      );

      const third = selection.reserveNext(session.allocateAttempt());
      assert.equal(third.kind, "noneRemaining");
      if (third.kind === "noneRemaining") {
        assert.equal(third.code, "candidatesExhausted");
        // Structured exhaustion evidence (finding 4): the diary names every
        // ranked candidate, in order, with why each could not serve.
        assert.equal(third.chainExhaustion?.stage, "impl-high-review");
        assert.deepEqual(
          third.chainExhaustion?.candidates.map((candidate) => candidate.storedModelId),
          ["copilot:gpt-5", "claude-cli:sonnet"]
        );
        for (const candidate of third.chainExhaustion?.candidates ?? []) {
          assert.match(candidate.reason, /reserved and invoked/);
        }
      }
    } finally {
      stub.restore();
    }
  });

  void it("issues every reservation through the session — one per attempt, session-enforced", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "copilot:gpt-5",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({ session, mode: "text", modelId: "copilot:gpt-5" });
      const attemptId = session.allocateAttempt();
      const first = selection.reserveNext(attemptId);
      assert.equal(first.kind, "reserved");
      // A second reservation for the same attempt is refused by the session
      // itself — the registry cannot bypass the selection policy's rules.
      assert.throws(() => selection.reserveNext(attemptId), /exactly one reservation/);
    } finally {
      stub.restore();
    }
  });

  void it("constructs each transport for exactly the reserved runner", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "copilot:gpt-5",
        backups: ["gemini-cli:default"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({ session, mode: "text", modelId: "copilot:gpt-5" });
      const first = selection.reserveNext(session.allocateAttempt());
      assert.equal(first.kind, "reserved");
      if (first.kind === "reserved") {
        assert.equal(
          first.reserved.createTransport().runnerId,
          first.reserved.handle.runnerId,
          "the transport must carry the reserved runner's id — the broker rejects any other"
        );
        session.reportAttemptOutcome(
          first.reserved.handle.correlation.attemptId,
          "providerUnavailablePreInvocation"
        );
      }
      const second = selection.reserveNext(session.allocateAttempt());
      assert.equal(second.kind, "reserved");
      if (second.kind === "reserved") {
        assert.equal(second.reserved.handle.runnerId, "gemini-cli");
        assert.equal(second.reserved.createTransport().runnerId, "gemini-cli");
      }
    } finally {
      stub.restore();
    }
  });

  void it("reserves the Copilot LM tool-session path for preflight and edit modes; CLI backups stay unavailable", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "copilot:gpt-5",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    try {
      for (const mode of ["preflight", "edit"] as const) {
        const session = openSession();
        const selection = openSelection({ session, mode, modelId: "copilot:gpt-5" });
        const firstAttempt = session.allocateAttempt();
        const first = selection.reserveNext(firstAttempt);
        assert.equal(first.kind, "reserved", `Copilot must qualify for "${mode}" (plan §7.2)`);
        if (first.kind === "reserved") {
          assert.equal(first.reserved.handle.runnerId, "copilot-lm");
          // The tool-session transport REQUIRES the coordinator's per-attempt
          // handler — constructing without one is a programmer error.
          assert.throws(() => first.reserved.createTransport(), /tool handler/);
        }
        // Settle the first attempt with a fallback-eligible outcome so the
        // session permits a fresh attempt for the ranked backup.
        session.reportAttemptOutcome(firstAttempt, "transportFailurePreResponse");
        // The CLI backup remains mode-unavailable (§7.5: no general-workspace
        // CLI edit path) — surfaced as an explicit settled attempt.
        const second = selection.reserveNext(session.allocateAttempt());
        assert.equal(second.kind, "candidateUnavailable");
        if (second.kind === "candidateUnavailable") {
          assert.equal(second.code, "providerModeUnavailable");
          assert.equal(second.runnerId, "claude-cli");
        }
      }
    } finally {
      stub.restore();
    }
  });

  void it("returns providerModeUnavailable for preflight/edit when only CLI providers are configured", () => {
    const stub = installModelSettings({
      "impl-high-review": { primary: "claude-cli:sonnet", strategy: "switch-to-backup" },
    });
    try {
      for (const mode of ["preflight", "edit"] as const) {
        const session = openSession();
        const selection = openSelection({ session, mode, modelId: "claude-cli:sonnet" });
        const result = selection.reserveNext(session.allocateAttempt());
        assert.equal(
          result.kind,
          "noneRemaining",
          `a CLI-only configuration must stay unavailable for "${mode}" (§7.5)`
        );
        if (result.kind === "noneRemaining") {
          assert.equal(result.code, "providerModeUnavailable");
          // The evidence names the mode-incapable candidate and why it was
          // skipped, so the stage owner can write an enriched run record.
          assert.equal(result.chainExhaustion?.stage, "impl-high-review");
          assert.equal(result.chainExhaustion?.candidates.length, 1);
          assert.equal(
            result.chainExhaustion?.candidates[0]?.storedModelId,
            "claude-cli:sonnet"
          );
          assert.match(
            result.chainExhaustion?.candidates[0]?.reason ?? "",
            new RegExp(`cannot satisfy the requested "${mode}" mode`)
          );
        }
      }
    } finally {
      stub.restore();
    }
  });

  void it("reserves codex-cli in text mode instead of silently skipping it", () => {
    // Regression guard. codex-cli used to declare usesLastMessageFile: true,
    // so cliProviderSupportsV1StdoutCapture rejected it here and the selection
    // returned providerModeUnavailable for a perfectly healthy, logged-in CLI.
    // Because that happens at SELECTION time, the symptom was silence: Codex
    // resolved, reported available, and stayed listed in the picker while
    // never being spawned once — zero tokens, no session file, no error, and
    // a backup model quietly answering in its place. Codex now reads its
    // result from its --json event stream (extractCodexFinalOutput), so it
    // satisfies AC-RUNNER-02 from stdout and must genuinely reserve.
    const stub = installModelSettings({
      "impl-high-review": { primary: "codex-cli:gpt-5", strategy: "switch-to-backup" },
    });
    try {
      const session = openSession();
      const selection = openSelection({ session, mode: "text", modelId: "codex-cli:gpt-5" });
      const first = selection.reserveNext(session.allocateAttempt());
      assert.equal(first.kind, "reserved");
      if (first.kind === "reserved") {
        assert.equal(first.reserved.handle.runnerId, "codex-cli");
        assert.equal(first.reserved.storedModelId, "codex-cli:gpt-5");
      }
    } finally {
      stub.restore();
    }
  });

  void it("honors the legacy fallback-strategy gate: no backups without switch-to-backup", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "copilot:gpt-5",
        backups: ["claude-cli:sonnet"],
        strategy: "pause-and-resume",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({ session, mode: "text", modelId: "copilot:gpt-5" });
      const first = selection.reserveNext(session.allocateAttempt());
      assert.equal(first.kind, "reserved");
      if (first.kind === "reserved") {
        session.reportAttemptOutcome(
          first.reserved.handle.correlation.attemptId,
          "providerUnavailablePreInvocation"
        );
      }
      // "pause-and-resume" opts out of automatic switch-over, so the backup
      // list is empty — mode-capable candidates existed but are used up.
      const exhausted = selection.reserveNext(session.allocateAttempt());
      assert.equal(exhausted.kind, "noneRemaining");
      if (exhausted.kind === "noneRemaining") {
        assert.equal(exhausted.code, "candidatesExhausted");
        assert.deepEqual(
          exhausted.chainExhaustion?.candidates.map((candidate) => candidate.storedModelId),
          ["copilot:gpt-5"]
        );
      }
    } finally {
      stub.restore();
    }
  });

  /**
   * Review blocker, 2026-08-14: a caller whose no-edit mandate must actually
   * be enforced (`summary-only` recovery continuations,
   * `implContinuationTextDispatchV1.ts`) cannot let the generic ranked
   * selection substitute a write-capable backup — cline-cli/antigravity-cli/
   * kimi-cli's text mode auto-approves every tool, so reserving one of them
   * in place of a read-only primary would defeat the whole guarantee the
   * caller opted into `requireGuaranteedReadOnlyText` for.
   */
  void it("requireGuaranteedReadOnlyText skips a write-capable backup and reserves the next read-only candidate", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "claude-cli:sonnet",
        backups: ["cline-cli:pass", "codex-cli:gpt-5"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({
        session,
        mode: "text",
        modelId: "claude-cli:sonnet",
        requireGuaranteedReadOnlyText: true,
      });

      const first = selection.reserveNext(session.allocateAttempt());
      assert.equal(first.kind, "reserved");
      if (first.kind === "reserved") {
        assert.equal(first.reserved.handle.runnerId, "claude-cli");
        session.reportAttemptOutcome(
          first.reserved.handle.correlation.attemptId,
          "providerUnavailablePreInvocation"
        );
      }

      // cline-cli is ranked next but is not guaranteed read-only — it must be
      // surfaced as an explicit skipped candidate, never silently reserved.
      const second = selection.reserveNext(session.allocateAttempt());
      assert.equal(second.kind, "candidateUnavailable");
      if (second.kind === "candidateUnavailable") {
        assert.equal(second.code, "providerModeUnavailable");
        assert.equal(second.runnerId, "cline-cli");
      }

      // codex-cli IS guaranteed read-only text mode, so selection reserves it.
      const third = selection.reserveNext(session.allocateAttempt());
      assert.equal(third.kind, "reserved");
      if (third.kind === "reserved") {
        assert.equal(third.reserved.handle.runnerId, "codex-cli");
      }
    } finally {
      stub.restore();
    }
  });

  void it("requireGuaranteedReadOnlyText exhausts to providerModeUnavailable when every candidate is write-capable", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "cline-cli:pass",
        backups: ["kimi-cli:default"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({
        session,
        mode: "text",
        modelId: "cline-cli:pass",
        requireGuaranteedReadOnlyText: true,
      });
      const result = selection.reserveNext(session.allocateAttempt());
      assert.equal(result.kind, "noneRemaining");
      if (result.kind === "noneRemaining") {
        assert.equal(result.code, "providerModeUnavailable");
        assert.deepEqual(
          result.chainExhaustion?.candidates.map((candidate) => candidate.storedModelId),
          ["cline-cli:pass", "kimi-cli:default"]
        );
      }
    } finally {
      stub.restore();
    }
  });

  void it("requireGuaranteedReadOnlyText leaves ordinary text-mode selection unaffected when omitted (default false)", () => {
    // Same chain as the skip test above, but WITHOUT the flag: cline-cli must
    // reserve normally, exactly as every other text-mode caller (chat,
    // review) has always been able to use it.
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "claude-cli:sonnet",
        backups: ["cline-cli:pass"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const session = openSession();
      const selection = openSelection({ session, mode: "text", modelId: "claude-cli:sonnet" });
      const first = selection.reserveNext(session.allocateAttempt());
      assert.equal(first.kind, "reserved");
      if (first.kind === "reserved") {
        session.reportAttemptOutcome(
          first.reserved.handle.correlation.attemptId,
          "providerUnavailablePreInvocation"
        );
      }
      const second = selection.reserveNext(session.allocateAttempt());
      assert.equal(second.kind, "reserved");
      if (second.kind === "reserved") {
        assert.equal(second.reserved.handle.runnerId, "cline-cli");
      }
    } finally {
      stub.restore();
    }
  });
});

/**
 * Stage-chain availability pre-flight (finding 4, second fix): the chain is
 * known ahead of time, so an unavailable-provider stall must be reported
 * BEFORE a round burns — but only when every candidate fails a safely
 * probeable check. Unknown (timeout) never short-circuits dispatch.
 */
void describe("preflightStageChainAvailabilityV1", () => {
  const PREFLIGHT_SETTINGS = {
    "impl-high-review": {
      primary: "claude-cli:sonnet",
      backups: ["gemini-cli:default", "codex-cli:gpt-5"],
      strategy: "switch-to-backup",
    },
  };

  void it("all candidates failing a probeable check reports exhaustion naming each candidate's reason", async () => {
    const stub = installModelSettings(PREFLIGHT_SETTINGS);
    try {
      const probed: string[] = [];
      const result = await preflightStageChainAvailabilityV1("impl-high-review", {
        modelId: "claude-cli:sonnet",
        probeCandidate: (storedModelId) => {
          probed.push(storedModelId);
          return Promise.resolve({
            available: false,
            reason: `${storedModelId} is not installed`,
          });
        },
      });
      assert.equal(result.kind, "exhausted");
      if (result.kind === "exhausted") {
        assert.equal(result.exhaustion.stage, "impl-high-review");
        assert.deepEqual(
          result.exhaustion.candidates.map((candidate) => candidate.storedModelId),
          ["claude-cli:sonnet", "gemini-cli:default", "codex-cli:gpt-5"],
          "the probed chain must be the same ranked chain selection would walk"
        );
        for (const candidate of result.exhaustion.candidates) {
          assert.match(candidate.reason, /is not installed/);
        }
      }
      assert.deepEqual(probed, [
        "claude-cli:sonnet",
        "gemini-cli:default",
        "codex-cli:gpt-5",
      ]);
    } finally {
      stub.restore();
    }
  });

  void it("one available candidate means dispatchable — no short-circuit", async () => {
    const stub = installModelSettings(PREFLIGHT_SETTINGS);
    try {
      const result = await preflightStageChainAvailabilityV1("impl-high-review", {
        modelId: "claude-cli:sonnet",
        probeCandidate: (storedModelId) =>
          Promise.resolve(
            storedModelId === "gemini-cli:default"
              ? { available: true }
              : { available: false, reason: "unavailable" }
          ),
      });
      assert.deepEqual(result, { kind: "dispatchable" });
    } finally {
      stub.restore();
    }
  });

  void it("a probe timeout is unknown — fails open to dispatch instead of short-circuiting", async () => {
    const stub = installModelSettings(PREFLIGHT_SETTINGS);
    try {
      const result = await preflightStageChainAvailabilityV1("impl-high-review", {
        modelId: "claude-cli:sonnet",
        probeTimeoutMs: 25,
        // Never resolves: the probe budget elapses and the candidate must be
        // treated as "unknown — do not short-circuit" (fail open).
        probeCandidate: () => new Promise(() => undefined),
      });
      assert.deepEqual(result, { kind: "dispatchable" });
    } finally {
      stub.restore();
    }
  });

  void it("a probe that throws is a real failure, not unknown — counted toward exhaustion", async () => {
    const stub = installModelSettings(PREFLIGHT_SETTINGS);
    try {
      const result = await preflightStageChainAvailabilityV1("impl-high-review", {
        modelId: "claude-cli:sonnet",
        probeCandidate: (storedModelId) =>
          Promise.reject(new Error(`${storedModelId} probe exploded`)),
      });
      assert.equal(result.kind, "exhausted");
      if (result.kind === "exhausted") {
        assert.match(
          result.exhaustion.candidates[0]?.reason ?? "",
          /probe exploded/
        );
      }
    } finally {
      stub.restore();
    }
  });
});
