import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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
    assert.strictEqual(antigravity.promptTransport, "file");
    assert.strictEqual(antigravity.useShell, false);
    assert.strictEqual(antigravity.maxArgvPromptBytes, undefined);
    assert.deepStrictEqual(antigravity.models, [
      { model: undefined, name: "Antigravity (CLI default)" },
    ]);

    const textArgs = antigravity.buildArgs("text", undefined, undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(textArgs, ["--print=/tmp/prompt.txt"]);

    const editArgs = antigravity.buildArgs("edit", "gemini-3-pro", undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(editArgs, [
      "--print=/tmp/prompt.txt",
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

    const editArgs = codex.buildArgs(
      "edit",
      undefined,
      undefined,
      { cwd: "/workspace/project" }
    );
    assert.deepStrictEqual(editArgs, [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      "/workspace/project",
      "--sandbox",
      "workspace-write",
      "-",
    ]);

    // --cd must still apply when the bypass is engaged: bypassing the
    // sandbox only removes the --sandbox flag, not the working directory.
    const bypassArgs = codex.buildArgs("edit", undefined, undefined, {
      cwd: "/workspace/project",
      dangerousBypassEnabled: true,
    });
    assert.deepStrictEqual(bypassArgs, [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      "/workspace/project",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);

    // The bypass flag must never leak into "text" mode, even if enabled.
    const textWithBypassArgs = codex.buildArgs("text", undefined, undefined, {
      cwd: "/workspace/project",
      dangerousBypassEnabled: true,
    });
    assert.deepStrictEqual(textWithBypassArgs, [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      "/workspace/project",
      "--sandbox",
      "read-only",
      "-",
    ]);
  });

  void it("Codex declares a provider-owned dangerousBypass toggle scoped to edit mode", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");
    assert.ok(codex.dangerousBypass, "expected codex-cli to declare dangerousBypass");
    assert.deepStrictEqual(codex.dangerousBypass?.appliesToModes, ["edit"]);
    assert.strictEqual(typeof codex.dangerousBypass?.isEnabled, "function");
    assert.match(codex.dangerousBypass?.warningMessage ?? "", /sandbox/i);
  });

  void it("other CLI providers do not declare a dangerousBypass toggle", () => {
    for (const provider of CLI_PROVIDERS) {
      if (provider.id === "codex-cli") {
        continue;
      }
      assert.strictEqual(
        provider.dangerousBypass,
        undefined,
        `${provider.id} should not declare dangerousBypass`
      );
    }
  });

  void it("Copilot model variants map to base model plus reasoning and context config", () => {
    const parsed = parseCopilotModelSelection("gpt-5.6-terra@ultra+long");
    assert.deepStrictEqual(parsed, {
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
      contextWindow: "long",
    });
  });

  void it("Claude model variants map to base model plus thinking budget", () => {
    const claude = getCliProvider("claude-cli");
    assert.ok(claude, "expected claude-cli provider definition");

    const textArgs = claude.buildArgs("text", "sonnet@high", undefined);
    assert.deepStrictEqual(textArgs, [
      "-p",
      "--output-format",
      "text",
      "--model",
      "sonnet",
      "--max-thinking-tokens",
      "8192",
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

  void it("implementation prompts are provider-neutral for CLI agents", () => {
    for (const fileName of [
      "run-implementation.md",
      "apply-impl-review-code.md",
    ]) {
      const content = fs.readFileSync(
        path.join(process.cwd(), "resources", "prompts", fileName),
        "utf8"
      );

      assert.match(content, /CLI coding agent/);
      assert.match(content, /native shell, patch, and file-editing tools/);
      assert.match(content, /If you cannot write files, report that failure/);
      assert.doesNotMatch(
        content,
        /You have the following tools available:\s*\n\s*-\s*`read_file/
      );
    }
  });

  void it("declares explicit Codex unsafe implementation opt-in setting", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { default?: unknown; type?: string }>;
        };
      };
    };
    const setting =
      packageJson.contributes?.configuration?.properties?.[
        "vs-code-ai-helper.codexDangerouslyBypassSandboxForImplementation"
      ];

    assert.ok(setting, "expected Codex bypass setting to be contributed");
    assert.strictEqual(setting.type, "boolean");
    assert.strictEqual(setting.default, false);
  });
});
