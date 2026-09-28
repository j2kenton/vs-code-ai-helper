/**
 * RC1 item 12: every place a model is shown names its provider in words, not
 * by the `provider:` id-prefix convention.
 */
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { describeModelWithProviderV1 } from "../runners/providers";
import { describeChainCandidatesV1, describeChainExhaustionTailV1 } from "../utils/chainExhaustionMessageV1";

void describe("provider naming in words (RC1 item 12)", () => {
  void it("names GitHub Copilot for bare and copilot:-prefixed ids", () => {
    assert.equal(describeModelWithProviderV1("gpt-5"), "gpt-5 (GitHub Copilot)");
    assert.equal(describeModelWithProviderV1("copilot:gpt-5"), "gpt-5 (GitHub Copilot)");
  });

  void it("names a CLI provider by its label and never shows the id prefix", () => {
    const text = describeModelWithProviderV1("codex-cli:gpt-5");
    assert.equal(text, "gpt-5 (OpenAI Codex)");
    assert.doesNotMatch(text, /codex-cli:/);
  });

  void it("says 'default model' when the provider's default is selected", () => {
    assert.equal(describeModelWithProviderV1("codex-cli:default"), "default model (OpenAI Codex)");
    assert.equal(describeModelWithProviderV1(undefined), "default model (GitHub Copilot)");
  });

  void it("the Copilot implementation runner's visible model progress names GitHub Copilot", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "src", "runners", "copilotImplementationRunner.ts"), "utf8");
    assert.match(source, /onProgress\(`Using model: \$\{model\.name\} \(GitHub Copilot\)`\)/);
  });

  void it("the chain-exhaustion message lists each model with its provider name and reason", () => {
    const candidates = [
      { storedModelId: "copilot:gpt-5", providerLabel: "Copilot", runnerId: "copilot", reason: "out of credit" },
      { storedModelId: "codex-cli:gpt-5", providerLabel: "OpenAI Codex", runnerId: "codex-cli", reason: "disabled" },
    ];
    assert.equal(
      describeChainCandidatesV1(candidates),
      "gpt-5 (GitHub Copilot) — out of credit; gpt-5 (OpenAI Codex) — disabled"
    );
    const tail = describeChainExhaustionTailV1("Implementation", candidates);
    assert.doesNotMatch(tail, /copilot:|codex-cli:/);
  });
});
