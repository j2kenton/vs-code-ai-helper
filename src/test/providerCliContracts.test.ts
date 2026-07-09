import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLI_PROVIDERS,
  getCliProvider,
  parseCopilotModelSelection,
  parseCodexModelSelection,
} from "../runners/providers";

void describe("provider CLI contracts", () => {
  void it("Kiro uses stdin prompt transport for --no-interactive", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    assert.strictEqual(kiro.promptTransport, "stdin");
    assert.strictEqual(kiro.useShell, false);
    assert.strictEqual(kiro.maxArgvPromptBytes, undefined);

    const textArgs = kiro.buildArgs("text", undefined, undefined);
    assert.deepStrictEqual(textArgs, [
      "chat",
      "--no-interactive",
      "--trust-tools",
      "read,grep",
    ]);

    const editArgs = kiro.buildArgs("edit", undefined, undefined);
    assert.deepStrictEqual(editArgs, [
      "chat",
      "--no-interactive",
      "--trust-all-tools",
    ]);
  });

  void it("Antigravity supports both agy and antigravity executable names", () => {
    const antigravity = getCliProvider("antigravity-cli");
    assert.ok(antigravity, "expected antigravity-cli provider definition");

    assert.strictEqual(antigravity.command, "agy");
    assert.deepStrictEqual(antigravity.commandAliases, ["antigravity"]);
    assert.strictEqual(antigravity.promptTransport, "stdin");
    assert.strictEqual(antigravity.useShell, false);
    assert.strictEqual(antigravity.maxArgvPromptBytes, undefined);
    assert.deepStrictEqual(antigravity.models, [
      { model: undefined, name: "Antigravity (CLI default)" },
    ]);

    const textArgs = antigravity.buildArgs("text", undefined, undefined);
    assert.deepStrictEqual(textArgs, ["--print"]);

    const editArgs = antigravity.buildArgs("edit", "gemini-3-pro", undefined);
    assert.deepStrictEqual(editArgs, [
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3-pro",
    ]);
  });

  void it("Codex model variants map to base model plus reasoning config", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const parsed = parseCodexModelSelection("gpt-5.6-terra@ultra+fast");
    assert.deepStrictEqual(parsed, {
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
      serviceTier: "priority",
    });

    const textArgs = codex.buildArgs(
      "text",
      "gpt-5.6-terra@ultra+fast",
      "/tmp/codex-last-message.md"
    );
    assert.deepStrictEqual(textArgs, [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5.6-terra",
      "-c",
      'model_reasoning_effort="ultra"',
      "-c",
      'service_tier="priority"',
      "--output-last-message",
      "/tmp/codex-last-message.md",
      "-",
    ]);
  });

  void it("Copilot model variants map to base model plus reasoning config", () => {
    const parsed = parseCopilotModelSelection("gpt-5.6-terra@ultra");
    assert.deepStrictEqual(parsed, {
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
    });
  });

  void it("Kiro hints mention KIRO_API_KEY requirement", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    assert.match(kiro.installHint, /KIRO_API_KEY/i);
    assert.match(kiro.loginHint, /KIRO_API_KEY/i);
  });

  void it("argv prompt transport providers require shell=false", () => {
    for (const provider of CLI_PROVIDERS) {
      if (provider.promptTransport === "argv") {
        assert.strictEqual(
          provider.useShell,
          false,
          `${provider.id} must set useShell=false when promptTransport=argv`
        );
      }
    }
  });
});
