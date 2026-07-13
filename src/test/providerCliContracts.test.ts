import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  CLI_PROVIDERS,
  getCliProvider,
  parseCopilotModelSelection,
  parseCodexModelSelection,
  parseModelSelection,
  type CliProviderDefinition,
} from "../runners/providers";

void describe("provider CLI contracts", () => {
  function modelArgValue(args: readonly string[]): string | undefined {
    const index = args.indexOf("--model");
    return index >= 0 ? args[index + 1] : undefined;
  }

  function buildTextArgs(
    provider: CliProviderDefinition,
    model: string | undefined
  ): string[] {
    return provider.buildArgs("text", model, "/tmp/last-message.md", {
      cwd: "/workspace/project",
      promptFile: "/tmp/prompt.txt",
    });
  }

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
      "fs_read,grep,glob",
    ]);

    const editArgs = kiro.buildArgs("edit", "claude-opus-4.6", undefined);
    assert.deepStrictEqual(editArgs, [
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--model",
      "claude-opus-4.6",
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

    assert.ok(
      !editArgs.includes("--dangerously-bypass-approvals-and-sandbox"),
      "Codex implementation runs must always remain sandboxed"
    );
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

  void it("provider-qualified CLI selections pass only native model names to buildArgs", () => {
    const cases: Array<{
      storedId: string;
      expectedProvider: string;
      expectedModelArg: string | undefined;
    }> = [
      {
        storedId: "claude-cli:opus@max",
        expectedProvider: "claude-cli",
        expectedModelArg: "opus",
      },
      {
        storedId: "codex-cli:gpt-5.6-terra@ultra+fast",
        expectedProvider: "codex-cli",
        expectedModelArg: "gpt-5.6-terra",
      },
      {
        storedId: "gemini-cli:gemini-2.5-pro",
        expectedProvider: "gemini-cli",
        expectedModelArg: "gemini-2.5-pro",
      },
      {
        storedId: "antigravity-cli:gpt-oss-120b-medium",
        expectedProvider: "antigravity-cli",
        expectedModelArg: "gpt-oss-120b-medium",
      },
      {
        storedId: "kiro-cli:claude-opus-4.6",
        expectedProvider: "kiro-cli",
        expectedModelArg: "claude-opus-4.6",
      },
      {
        storedId: "antigravity-cli:default",
        expectedProvider: "antigravity-cli",
        expectedModelArg: undefined,
      },
      {
        storedId: "kiro-cli:default",
        expectedProvider: "kiro-cli",
        expectedModelArg: undefined,
      },
    ];

    for (const testCase of cases) {
      const parsed = parseModelSelection(testCase.storedId);
      assert.strictEqual(parsed.provider, testCase.expectedProvider);
      const provider = getCliProvider(parsed.provider);
      assert.ok(provider, `expected ${parsed.provider} provider definition`);

      const args = buildTextArgs(provider, parsed.model);
      assert.strictEqual(
        modelArgValue(args),
        testCase.expectedModelArg,
        testCase.storedId
      );
      assert.ok(
        !args.some((arg) => arg.startsWith(`${testCase.expectedProvider}:`)),
        `${testCase.storedId} leaked its storage prefix into CLI args`
      );
    }
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

  void it("does not expose a Codex sandbox-bypass setting", () => {
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

    assert.strictEqual(setting, undefined);
  });
});
