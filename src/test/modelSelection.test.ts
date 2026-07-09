import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __testOnly,
  getAvailableModels,
  type SelectableModel,
  describeModel,
  getModelDisplayName,
  describeModelSource,
  describeResolvedModel,
} from "../utils/modelSelection";

function providerModels(
  models: readonly SelectableModel[],
  providerLabel: string
): SelectableModel[] {
  return models.filter((model) => model.providerLabel === providerLabel);
}

function antigravityModels(
  models: readonly SelectableModel[]
): SelectableModel[] {
  return providerModels(models, "Antigravity CLI (subscription CLI)");
}

void describe("CLI model refresh fallback", () => {
  void it("keeps existing defaults when discovery returns an empty list", () => {
    const current = [
      { model: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
      { model: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    ];

    assert.deepStrictEqual(
      __testOnly.resolveRefreshedCliModels(current, []),
      current
    );
  });

  void it("replaces defaults when discovery returns a non-empty list", () => {
    const current = [
      { model: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
    ];
    const discovered = [
      { model: "gemini-3-pro", name: "Gemini 3 Pro" },
      { model: "gemini-3-flash", name: "Gemini 3 Flash" },
    ];

    assert.deepStrictEqual(
      __testOnly.resolveRefreshedCliModels(current, discovered),
      discovered
    );
  });
});

void describe("getAvailableModels", () => {
  void it("annotates Copilot Claude Fable and Opus models as Pro+ only", async () => {
    __testOnly.restoreSeededCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([
          {
            id: "copilot-claude-fable-5",
            name: "Claude Fable 5",
          } as SelectableModel as never,
          {
            id: "copilot-claude-opus-4.8",
            name: "Claude Opus 4.8",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.5",
            name: "GPT-5.5",
          } as SelectableModel as never,
        ]);
      },
      cliCommandExists() {
        return Promise.resolve(false);
      },
    });

    try {
      const models = await getAvailableModels();
      assert.deepStrictEqual(models, [
        {
          id: "copilot-claude-fable-5",
          name: "Claude Fable 5 (only on Pro+ plan)",
          providerLabel: "GitHub Copilot",
        },
        {
          id: "copilot-claude-opus-4.8",
          name: "Claude Opus 4.8 (only on Pro+ plan)",
          providerLabel: "GitHub Copilot",
        },
        {
          id: "copilot-gpt-5.5",
          name: "GPT-5.5",
          providerLabel: "GitHub Copilot",
        },
      ]);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
      __testOnly.restoreSeededCliModelCache();
    }
  });

  void it("surfaces seeded CLI models immediately for installed providers", async () => {
    __testOnly.restoreSeededCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(
          command === "claude" ||
            command === "codex" ||
            command === "agy" ||
            command === "kiro-cli"
        );
      },
    });

    try {
      const models = await getAvailableModels();
      assert.deepStrictEqual(
        providerModels(models, "Claude Code (subscription CLI)"),
        [
          {
            id: "claude-cli:default",
            name: "Claude (CLI default)",
            providerLabel: "Claude Code (subscription CLI)",
          },
          {
            id: "claude-cli:sonnet",
            name: "Sonnet 4.5",
            providerLabel: "Claude Code (subscription CLI)",
          },
          {
            id: "claude-cli:haiku",
            name: "Haiku 4.5",
            providerLabel: "Claude Code (subscription CLI)",
          },
          {
            id: "claude-cli:opus",
            name: "Opus 4.1 (only on Max plan)",
            providerLabel: "Claude Code (subscription CLI)",
          },
          {
            id: "claude-cli:fable",
            name: "Fable 5 (only on Max plan)",
            providerLabel: "Claude Code (subscription CLI)",
          },
        ]
      );
      assert.deepStrictEqual(
        providerModels(models, "OpenAI Codex (subscription CLI)"),
        [
          {
            id: "codex-cli:default",
            name: "Codex (CLI default)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.5@low",
            name: "GPT-5.5 (Low)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.5@medium",
            name: "GPT-5.5 (Medium)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.5@high",
            name: "GPT-5.5 (High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.5@xhigh",
            name: "GPT-5.5 (Extra High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-terra@low",
            name: "GPT-5.6-Terra (Low)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-terra@medium",
            name: "GPT-5.6-Terra (Medium)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-terra@high",
            name: "GPT-5.6-Terra (High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-terra@xhigh",
            name: "GPT-5.6-Terra (Extra High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-terra@max",
            name: "GPT-5.6-Terra (Max)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-terra@ultra",
            name: "GPT-5.6-Terra (Ultra)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-luna@low",
            name: "GPT-5.6-Luna (Low)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-luna@medium",
            name: "GPT-5.6-Luna (Medium)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-luna@high",
            name: "GPT-5.6-Luna (High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-luna@xhigh",
            name: "GPT-5.6-Luna (Extra High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.6-luna@max",
            name: "GPT-5.6-Luna (Max)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4@low",
            name: "GPT-5.4 (Low)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4@medium",
            name: "GPT-5.4 (Medium)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4@high",
            name: "GPT-5.4 (High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4@xhigh",
            name: "GPT-5.4 (Extra High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4-mini@low",
            name: "GPT-5.4-Mini (Low)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4-mini@medium",
            name: "GPT-5.4-Mini (Medium)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4-mini@high",
            name: "GPT-5.4-Mini (High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
          {
            id: "codex-cli:gpt-5.4-mini@xhigh",
            name: "GPT-5.4-Mini (Extra High)",
            providerLabel: "OpenAI Codex (subscription CLI)",
          },
        ]
      );
      assert.deepStrictEqual(
        antigravityModels(models),
        [
          {
            id: "antigravity-cli:default",
            name: "Antigravity (CLI default)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:gemini-3.5-flash-medium",
            name: "Gemini 3.5 Flash (Medium)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:gemini-3.5-flash-high",
            name: "Gemini 3.5 Flash (High)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:gemini-3.5-flash-low",
            name: "Gemini 3.5 Flash (Low)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:gemini-3.1-pro-low",
            name: "Gemini 3.1 Pro (Low)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:gemini-3.1-pro-high",
            name: "Gemini 3.1 Pro (High)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:claude-sonnet-4.6-thinking",
            name: "Claude Sonnet 4.6 (Thinking)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:claude-opus-4.6-thinking",
            name: "Claude Opus 4.6 (Thinking)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:gpt-oss-120b-medium",
            name: "GPT-OSS 120B (Medium)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
        ]
      );
      assert.deepStrictEqual(
        providerModels(models, "Kiro CLI (subscription CLI)"),
        [
          {
            id: "kiro-cli:default",
            name: "Kiro (CLI default)",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:claude-sonnet-4",
            name: "Claude Sonnet 4",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:claude-haiku-4.5",
            name: "Claude Haiku 4.5",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:deepseek-3.2",
            name: "DeepSeek 3.2",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:minimax-m2.5",
            name: "MiniMax M2.5",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:minimax-m2.1",
            name: "MiniMax M2.1",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:glm-5",
            name: "GLM-5",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:qwen3-coder-next",
            name: "Qwen3 Coder Next",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
        ]
      );
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
      __testOnly.restoreSeededCliModelCache();
    }
  });

  void it("prefers discovered Antigravity models over stale fallback entries", async () => {
    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "agy");
      },
      getDiscoveredCliModels(def) {
        if (def.id !== "antigravity-cli") {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { model: "gemini-3-pro", name: "Gemini 3 Pro" },
          { model: "gemini-3-flash", name: "Gemini 3 Flash" },
        ]);
      },
    });

    try {
      const models = antigravityModels(await getAvailableModels());
      assert.deepStrictEqual(models, [
        {
          id: "antigravity-cli:default",
          name: "Antigravity (CLI default)",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
        {
          id: "antigravity-cli:gemini-3-pro",
          name: "Gemini 3 Pro",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
        {
          id: "antigravity-cli:gemini-3-flash",
          name: "Gemini 3 Flash",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
      ]);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
    }
  });

  void it("uses Antigravity fallback entries when discovery returns nothing", async () => {
    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "agy");
      },
      getDiscoveredCliModels() {
        return Promise.resolve([]);
      },
    });

    try {
      const models = antigravityModels(await getAvailableModels());
      assert.deepStrictEqual(models, [
        {
          id: "antigravity-cli:default",
          name: "Antigravity (CLI default)",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
      ]);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
    }
  });

  void it("returns cached Antigravity models immediately while warmup is still in flight", async () => {
    const refresh = new Promise<readonly { model: string; name: string }[]>(
      () => {}
    );

    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "agy");
      },
    });
    __testOnly.primeCliModelCache("antigravity-cli", {
      models: [{ model: "gemini-3-pro", name: "Gemini 3 Pro" }],
      inFlight: refresh,
    });

    try {
      const models = antigravityModels(await getAvailableModels());
      assert.deepStrictEqual(models, [
        {
          id: "antigravity-cli:default",
          name: "Antigravity (CLI default)",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
        {
          id: "antigravity-cli:gemini-3-pro",
          name: "Gemini 3 Pro",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
      ]);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
    }
  });

  void it("returns fallback immediately when Antigravity warmup has no cached models yet", async () => {
    const refresh = new Promise<readonly { model: string; name: string }[]>(
      () => {}
    );

    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "agy");
      },
    });
    __testOnly.primeCliModelCache("antigravity-cli", {
      models: [],
      inFlight: refresh,
    });

    try {
      const outcome = await Promise.race([
        getAvailableModels().then((models) => ({
          kind: "resolved" as const,
          models: antigravityModels(models),
        })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 50);
        }),
      ]);

      assert.notStrictEqual(outcome.kind, "timeout");
      if (outcome.kind === "resolved") {
        assert.deepStrictEqual(outcome.models, [
          {
            id: "antigravity-cli:default",
            name: "Antigravity (CLI default)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
        ]);
      }
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
    }
  });
});

void describe("Model Selection Display States", () => {
  const mockModels: SelectableModel[] = [
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", providerLabel: "Antigravity" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", providerLabel: "Kiro" },
  ];

  void it("describeModel returns correct strings", () => {
    assert.strictEqual(describeModel(undefined, mockModels), "Automatic (no explicit selection)");
    assert.strictEqual(describeModel("gemini-3.5-flash", mockModels), "Gemini 3.5 Flash (gemini-3.5-flash)");
    assert.strictEqual(describeModel("gpt-5", mockModels), "gpt-5 (currently unavailable)");
  });

  void it("getModelDisplayName returns correct strings", () => {
    assert.strictEqual(getModelDisplayName(undefined, mockModels), "Automatic");
    assert.strictEqual(getModelDisplayName("gemini-3.5-flash", mockModels), "Gemini 3.5 Flash");
    assert.strictEqual(getModelDisplayName("gpt-5", mockModels), "gpt-5");
  });

  void it("describeModelSource returns correct strings", () => {
    assert.strictEqual(describeModelSource("task"), "task override");
    assert.strictEqual(describeModelSource("workspace"), "workspace default");
    assert.strictEqual(describeModelSource("none"), "automatic selection");
  });

  void it("describeResolvedModel covers explicit task override", () => {
    const resolved = { modelId: "gemini-3.5-flash", source: "task" as const };
    assert.strictEqual(
      describeResolvedModel(resolved, mockModels),
      "Gemini 3.5 Flash (gemini-3.5-flash) (explicit task override)"
    );
  });

  void it("describeResolvedModel covers inherited workspace default", () => {
    const resolved = { modelId: "claude-sonnet-4.5", source: "workspace" as const };
    assert.strictEqual(
      describeResolvedModel(resolved, mockModels),
      "Claude Sonnet 4.5 (claude-sonnet-4.5) (inherited workspace default)"
    );
  });

  void it("describeResolvedModel covers automatic / no selection", () => {
    const resolved = { modelId: undefined, source: "none" as const };
    assert.strictEqual(
      describeResolvedModel(resolved, mockModels),
      "Automatic (no explicit selection)"
    );
  });

  void it("describeResolvedModel covers unavailable model", () => {
    const resolved = { modelId: "gpt-5", source: "task" as const };
    assert.strictEqual(
      describeResolvedModel(resolved, mockModels),
      "gpt-5 (currently unavailable) (explicit task override)"
    );
  });
});
