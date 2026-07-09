import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLI_PROVIDERS, getCliProvider } from "../runners/providers";

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
    assert.strictEqual(antigravity.promptTransport, "argv");
    assert.strictEqual(antigravity.useShell, false);
    assert.strictEqual(antigravity.maxArgvPromptBytes, 24_000);
    assert.deepStrictEqual(antigravity.models, [
      { model: undefined, name: "Antigravity (CLI default)" },
    ]);

    const textArgs = antigravity.buildArgs("text", undefined, undefined);
    assert.deepStrictEqual(textArgs, ["--prompt"]);

    const editArgs = antigravity.buildArgs("edit", "gemini-3-pro", undefined);
    assert.deepStrictEqual(editArgs, [
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3-pro",
      "--prompt",
    ]);
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
