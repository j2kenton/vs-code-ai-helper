/**
 * bugs4 Step 32 (item 31): the Publish fix-round failure text and the left-failing card for a run
 * whose chain is out of quota / payment-blocked.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import * as vscodeRuntime from "vscode";

import { offerLintFixRecoveryInChatV1 } from "../commands/runLintingFixes";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { ENABLE_PUBLISH_BACKUP_AND_RERUN_FIX_COMMAND_V1 } from "../utils/enableChainModelV1";
import { classifyFixChainBlockV1, readFixChainFailureV1 } from "../utils/lintFixChainBlockV1";
import { buildChainAttemptListV1 } from "../utils/stopBehaviourV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

// The captured card text (bugs4 item 31), with the provider message intact.
const CAPTURED =
  "devpass-code hit a usage limit: HTTP 402 payment required: devpass-code CLI failed: APIError: You've reached the daily pacing " +
  "allowance on the lite plan. Upgrade for a higher daily allowance, or wait for the window to roll over — resets in 22 hours. " +
  "Enable pay-as-you-go overflow in your DevPass dashboard. Add credits or choose a free model.. " +
  "Backup devpass-code llmgateway-devpass/claude-sonnet-5-5@high was tried and failed: HTTP 402 payment required: devpass-code CLI failed: " +
  "APIError: You've reached the daily pacing allowance on the lite plan. Add credits or choose a free model. " +
  "Backup gpt-6.1-terra@high is disabled in the stage's chain; enable it to use it here. Add credits or choose a free model. " +
  "Payment-required failures do not have a quota reset schedule.";

void describe("readFixChainFailureV1", () => {
  void it("shows the reset time once, never beside 'no reset schedule', and the remedy once", () => {
    const reading = readFixChainFailureV1(CAPTURED);
    assert.equal((reading.text.match(/resets in 22 hours/g) ?? []).length, 1, reading.text);
    assert.doesNotMatch(reading.text, /reset schedule/);
    assert.equal((reading.text.match(/Add credits or choose a free model/g) ?? []).length, 1, reading.text);
    assert.doesNotMatch(reading.text, /\.\./);
  });

  void it("lists each model tried once and names the switched-off backup", () => {
    const reading = readFixChainFailureV1(CAPTURED);
    assert.deepEqual(reading.triedModels, ["devpass-code llmgateway-devpass/claude-sonnet-5-5@high"]);
    assert.deepEqual(reading.disabledBackups, ["gpt-6.1-terra@high"]);
  });

  void it("gives each model tried its own outcome, once (item 67)", () => {
    const reading = readFixChainFailureV1(CAPTURED);
    assert.deepEqual(reading.triedOutcomes, [
      { label: "devpass-code llmgateway-devpass/claude-sonnet-5-5@high", outcome: "payment required" },
    ]);
    const mixed = readFixChainFailureV1(
      "Backup a@high was tried and failed: Individual quota reached. Resets in 1h13m30s. " +
        "Backup b@high was tried and failed: 401 Unauthorized: token is not active. " +
        "Backup a@high was tried and failed: Individual quota reached."
    );
    assert.deepEqual(mixed.triedOutcomes, [
      // The provider's own text says "quota reached", so the card says quota, not "usage limit".
      { label: "a@high", outcome: "quota or rate limit, resets in 1h13m30s" },
      { label: "b@high", outcome: "sign-in failed" },
    ]);
  });

  void it("includes the primary's own outcome from the headline when no record names its model, never twice (item 67)", () => {
    const withPrimary = readFixChainFailureV1(
      "Antigravity CLI hit a usage limit: Individual quota reached. Resets in 1h13m30s. " +
        "Backup devpass-code llmgateway-devpass/claude-sonnet-5-5@high was tried and failed: HTTP 402 payment required: add credits."
    );
    assert.deepEqual(withPrimary.triedOutcomes, [
      { label: "Antigravity CLI", outcome: "quota or rate limit, resets in 1h13m30s" },
      { label: "devpass-code llmgateway-devpass/claude-sonnet-5-5@high", outcome: "payment required" },
    ]);
    // The captured text's headline provider is the same attempt as the backup record below it: listed once.
    assert.equal(readFixChainFailureV1(CAPTURED).triedOutcomes.length, 1);
  });

  void it("keeps the 'no reset schedule' line when the provider gave no reset time (control)", () => {
    const reading = readFixChainFailureV1("HTTP 402 payment required: add credits. Payment-required failures do not have a quota reset schedule.");
    assert.match(reading.text, /reset schedule/);
    assert.deepEqual(reading.triedModels, []);
    assert.deepEqual(reading.disabledBackups, []);
  });
});

void describe("left-failing card for a run that changed files and ended failed with HTTP 402", () => {
  void it("recommends enabling the switched-off backup and rerunning the fix, never Run Publish Checks, and is not Optional", async () => {
    assert.equal(classifyFixChainBlockV1(CAPTURED), "payment-required");
    const owned = makeOwnedTaskFolder("ensemble-fix-chain-card-");
    const folder = owned.folder;
    const state = new Map<string, unknown>();
    const memento = {
      keys: () => [...state.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined => (state.has(key) ? (state.get(key) as T) : defaultValue),
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
        return Promise.resolve();
      },
    } as vscode.Memento;
    __extensionContextV1TestOnly.set({ subscriptions: [], workspaceState: memento, globalState: memento } as unknown as vscode.ExtensionContext);
    const fsTarget = vscodeRuntime.workspace.fs as unknown as Record<string, unknown>;
    const originalReadFile = fsTarget.readFile;
    fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buffer) => new Uint8Array(buffer));
    try {
      await offerLintFixRecoveryInChatV1(folder, "Task", "AI final fixes failed: quota. Checks still fail.", true, {
        chainBlock: "payment-required",
        disabledBackups: ["gpt-6.1-terra@high"],
      });
      const decision = new WorkflowDecisionStoreV1(memento).listPending(folder)[0];
      assert.ok(decision, "the card is posted");
      const labels = decision.options.map((option) => option.label);
      assert.ok(labels.includes("Enable gpt-6.1-terra@high and rerun the fix"), labels.join(" | "));
      assert.ok(labels.includes("Choose a different Publish model"), labels.join(" | "));
      const enableOption = decision.options.find((option) => option.label === "Enable gpt-6.1-terra@high and rerun the fix");
      assert.equal(enableOption?.effect.kind === "command" ? enableOption.effect.command : undefined, ENABLE_PUBLISH_BACKUP_AND_RERUN_FIX_COMMAND_V1);
      assert.match(enableOption?.consequence ?? "", /already one of your configured backups/);
      const recommended = decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined;
      assert.equal(decision.options.find((option) => option.optionId === recommended)?.label, "Enable gpt-6.1-terra@high and rerun the fix");
      assert.notEqual(decision.options.find((option) => option.optionId === recommended)?.label, "Run Publish Checks");
      assert.equal(decision.gating?.unblocksProgress, true, "a card the task cannot move on without is not Optional");
    } finally {
      fsTarget.readFile = originalReadFile;
      __extensionContextV1TestOnly.reset();
      fs.rmSync(path.dirname(path.dirname(folder)), { recursive: true, force: true });
    }
  });
});

void describe("structured primary-inclusive attempt list (bugs4 item 31 / plan item 62)", () => {
  const QUOTA = "Individual quota reached. Resets in 1h13m30s.";
  const PAYMENT = "HTTP 402 payment required: add credits.";

  void it("lists the primary first, then each backup once, each with its own outcome", () => {
    const attempts = buildChainAttemptListV1("Antigravity CLI", "Antigravity CLI claude-sonnet-5-5-high", QUOTA, [
      { label: "devpass-code llmgateway-devpass/claude-sonnet-5-5@high", outcome: "tried-and-failed", reason: PAYMENT },
      { label: "gpt-6.1-terra@high", outcome: "disabled", reason: "disabled in the stage's chain" },
    ]);
    assert.deepEqual(
      attempts.map((attempt) => [attempt.label, attempt.isPrimary, attempt.outcome]),
      [
        ["Antigravity CLI claude-sonnet-5-5-high", true, "tried-and-failed"],
        ["devpass-code llmgateway-devpass/claude-sonnet-5-5@high", false, "tried-and-failed"],
        ["gpt-6.1-terra@high", false, "disabled"],
      ]
    );
    const reading = readFixChainFailureV1("a message with no per-model sentences at all", attempts);
    assert.deepEqual(reading.triedOutcomes, [
      { label: "Antigravity CLI claude-sonnet-5-5-high", outcome: "quota or rate limit, resets in 1h13m30s" },
      { label: "devpass-code llmgateway-devpass/claude-sonnet-5-5@high", outcome: "payment required" },
    ]);
    assert.deepEqual(reading.disabledBackups, ["gpt-6.1-terra@high"]);
  });

  void it("a primary the registry already recorded is not listed a second time from the headline", () => {
    const attempts = buildChainAttemptListV1("Codex", "Codex gpt-6.1-terra@high", QUOTA, [
      { label: "Codex gpt-6.1-terra@high", outcome: "tried-and-failed", isPrimary: true, reason: QUOTA },
      { label: "Claude Code claude-sonnet-5-5@high", outcome: "tried-and-failed", reason: PAYMENT },
    ]);
    assert.deepEqual(
      attempts.map((attempt) => attempt.label),
      ["Codex gpt-6.1-terra@high", "Claude Code claude-sonnet-5-5@high"]
    );
    assert.equal(attempts.filter((attempt) => attempt.isPrimary).length, 1);
  });

  void it("with no structured list the text reading still applies (control)", () => {
    const reading = readFixChainFailureV1(CAPTURED, undefined);
    assert.equal(reading.triedOutcomes.length, 1);
    assert.deepEqual(readFixChainFailureV1(CAPTURED, []).triedModels, reading.triedModels);
  });
});
