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
import { openV1RunnerSelection } from "../runners/runnerRegistry";
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
}): ReturnType<typeof openV1RunnerSelection> {
  return openV1RunnerSelection({
    session: options.session,
    mode: options.mode,
    modelId: options.modelId,
    stage: "impl-high-review",
    workspaceCwd: "/workspace",
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
      assert.deepEqual(third, { kind: "noneRemaining", code: "candidatesExhausted" });
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
        assert.deepEqual(
          selection.reserveNext(session.allocateAttempt()),
          { kind: "noneRemaining", code: "providerModeUnavailable" },
          `a CLI-only configuration must stay unavailable for "${mode}" (§7.5)`
        );
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
      assert.deepEqual(selection.reserveNext(session.allocateAttempt()), {
        kind: "noneRemaining",
        code: "candidatesExhausted",
      });
    } finally {
      stub.restore();
    }
  });
});
