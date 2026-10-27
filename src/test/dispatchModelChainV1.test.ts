import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ModelSettings } from "../utils/modelFallback";
import {
  candidateInvocationMessageV1,
  captureDispatchModelChainV1,
  formatDispatchModelChainForRunLogV1,
  selectDispatchModelChainsForRunLogV1,
  dispatchCorrelationFromOutcomeV1,
} from "../utils/dispatchModelChainV1";

void describe("dispatch-time model chain evidence", () => {
  const settings: ModelSettings = {
    impl: {
      primary: "antigravity-cli:gemini-3.8-flash-high",
      backups: ["codex-cli:gpt-6-sol@high"],
      backupsEnabled: [true],
      strategy: "switch-to-backup",
    },
  };

  void it("names the resolved model at invocation and when a backup starts", () => {
    assert.equal(
      candidateInvocationMessageV1("implementation", "antigravity-cli:gemini-3.8-flash-high", "Antigravity CLI", false),
      "Running implementation with Antigravity CLI — antigravity-cli:gemini-3.8-flash-high."
    );
    assert.equal(
      candidateInvocationMessageV1("implementation", "codex-cli:gpt-6-sol@high", "OpenAI Codex", true),
      "Backup started for implementation: OpenAI Codex — codex-cli:gpt-6-sol@high."
    );
  });

  void it("formats the captured configured and effective chains in the run log", () => {
    const snapshot = captureDispatchModelChainV1("impl", settings);
    const log = formatDispatchModelChainForRunLogV1({
      ...snapshot,
      runnerId: "antigravity-cli",
      invoked: { storedModelId: "antigravity-cli:gemini-3.8-flash-high", providerLabel: "Antigravity CLI" },
    });
    assert.match(log, /Invoked: Antigravity CLI — antigravity-cli:gemini-3\.8-flash-high/);
    assert.match(log, /Effective primary: antigravity-cli:gemini-3\.8-flash-high/);
    assert.match(log, /Effective enabled backups: codex-cli:gpt-6-sol@high/);
    assert.match(log, /configured/i);
  });

  void it("binds run-log evidence to operation and attempt identities and preserves candidate order", () => {
    const first = { ...captureDispatchModelChainV1("impl", settings), operationId: "op-1", attemptId: "attempt-1", candidateOrdinal: 1,
      runnerId: "antigravity-cli", invoked: { storedModelId: "antigravity-cli:primary", providerLabel: "Antigravity CLI" } };
    const backup = { ...first, attemptId: "attempt-2", candidateOrdinal: 2,
      invoked: { storedModelId: "codex-cli:backup", providerLabel: "OpenAI Codex" } };
    const stale = { ...first, operationId: "op-old", attemptId: "attempt-old", candidateOrdinal: 99 };
    assert.deepEqual(selectDispatchModelChainsForRunLogV1([backup, stale, first], { operationId: "op-1" }), [first, backup]);
    assert.deepEqual(selectDispatchModelChainsForRunLogV1([backup, stale, first], { operationId: "op-1", attemptIds: ["attempt-2"] }), [backup]);
    assert.deepEqual(selectDispatchModelChainsForRunLogV1([stale], { operationId: "op-1" }), []);
    assert.deepEqual(dispatchCorrelationFromOutcomeV1({
      kind: "completed",
      correlation: { operationId: "op-1", attemptId: "attempt-2" },
    }), { operationId: "op-1", attemptId: "attempt-2" });
    assert.equal(dispatchCorrelationFromOutcomeV1({ kind: "duplicateRejected" }), undefined);
  });

  void it("routes lint-fix invocations through the same candidate observer and dispatch snapshot writer", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/runLintingFixes.ts"), "utf8");
    assert.match(source, /dispatchOperationId:\s*op\.id/);
    assert.match(source, /onCandidateInvokedV1:\s*async \(info: CandidateInvocationInfoV1\)/);
    assert.match(source, /candidateInvocationMessageV1\(\s*"AI final fixes"/);
    assert.match(source, /persistCandidateDispatchModelChainV1\(\{/);
    assert.match(source, /info\.backup\s*\n\s*\);/);
  });
});
