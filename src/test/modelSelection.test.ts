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

function codexVariant(
  id: string,
  name: string
): SelectableModel {
  return {
    id,
    name,
    providerLabel: "OpenAI Codex (subscription CLI)",
  };
}

function codexVariants(
  model: string,
  label: string,
  efforts: readonly (readonly [string, string])[],
  includeFastVariants: boolean
): SelectableModel[] {
  const variants: SelectableModel[] = [];
  for (const [effort, effortLabel] of efforts) {
    variants.push(
      codexVariant(`codex-cli:${model}@${effort}`, `${label} (${effortLabel})`)
    );
    if (includeFastVariants) {
      variants.push(
        codexVariant(
          `codex-cli:${model}@${effort}+fast`,
          `${label} (${effortLabel}, Fast)`
        )
      );
    }
  }
  return variants;
}

function claudeCliReasoningVariants(
  model: string,
  label: string,
  efforts: readonly (readonly [string, string])[],
  availabilityNote?: string
): SelectableModel[] {
  return efforts.map(([effort, effortLabel]) => ({
    id: `claude-cli:${model}@${effort}`,
    name: `${label} (${effortLabel})${availabilityNote ? ` [${availabilityNote}]` : ""}`,
    providerLabel: "Claude Code (subscription CLI)",
  }));
}

function copilotReasoningVariants(
  model: string,
  label: string,
  efforts: readonly (readonly [string, string])[]
): SelectableModel[] {
  return efforts.map(([effort, effortLabel]) => ({
    id: `${model}@${effort}`,
    name: `${label} (${effortLabel})`,
    providerLabel: "GitHub Copilot",
  }));
}

function copilotReasoningAndContextVariants(
  model: string,
  label: string,
  efforts: readonly (readonly [string, string])[],
  longContext: boolean
): SelectableModel[] {
  const variants: SelectableModel[] = [];
  for (const [effort, effortLabel] of efforts) {
    variants.push({
      id: `${model}@${effort}`,
      name: `${label} (${effortLabel})`,
      providerLabel: "GitHub Copilot",
    });
    if (longContext) {
      variants.push({
        id: `${model}@${effort}+long`,
        name: `${label} (${effortLabel}, Long Context)`,
        providerLabel: "GitHub Copilot",
      });
    }
  }
  return variants;
}

function copilotModel(
  id: string,
  name: string
): SelectableModel {
  return {
    id,
    name,
    providerLabel: "GitHub Copilot",
  };
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
  void it("surfaces the current Copilot default model matrix", async () => {
    __testOnly.restoreSeededCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([
          { id: "auto", name: "Auto" } as SelectableModel as never,
          {
            id: "copilot-gpt-5.6-sol",
            name: "GPT-5.6 Sol",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.6-terra",
            name: "GPT-5.6 Terra",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.6-luna",
            name: "GPT-5.6 Luna",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.5",
            name: "GPT-5.5",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.4",
            name: "GPT-5.4",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.3-codex",
            name: "GPT-5.3-Codex",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5.4-mini",
            name: "GPT-5.4 mini",
          } as SelectableModel as never,
          {
            id: "copilot-gpt-5-mini",
            name: "GPT-5 mini",
          } as SelectableModel as never,
          {
            id: "copilot-claude-sonnet-5",
            name: "Claude Sonnet 5",
          } as SelectableModel as never,
          {
            id: "copilot-claude-sonnet-4.6",
            name: "Claude Sonnet 4.6",
          } as SelectableModel as never,
          {
            id: "copilot-claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
          } as SelectableModel as never,
          {
            id: "copilot-claude-haiku-4.5",
            name: "Claude Haiku 4.5",
          } as SelectableModel as never,
          {
            id: "copilot-claude-fable-5",
            name: "Claude Fable 5",
          } as SelectableModel as never,
          {
            id: "copilot-claude-opus-4.8",
            name: "Claude Opus 4.8",
          } as SelectableModel as never,
          {
            id: "copilot-claude-opus-4.8-fast",
            name: "Claude Opus 4.8 (fast mode) (Preview)",
          } as SelectableModel as never,
          {
            id: "copilot-claude-opus-4.7",
            name: "Claude Opus 4.7",
          } as SelectableModel as never,
          {
            id: "copilot-gemini-3.1-pro",
            name: "Gemini 3.1 Pro (Preview)",
          } as SelectableModel as never,
          {
            id: "copilot-gemini-3.5-flash",
            name: "Gemini 3.5 Flash",
          } as SelectableModel as never,
          {
            id: "copilot-kimi-k2.7-code",
            name: "Kimi K2.7 Code",
          } as SelectableModel as never,
          {
            id: "copilot-mai-code-1-flash",
            name: "MAI-Code-1-Flash",
          } as SelectableModel as never,
          {
            id: "copilot-claude-opus-4.6",
            name: "claude-opus-4.6",
          } as SelectableModel as never,
          {
            id: "copilot-claude-opus-4.5",
            name: "claude-opus-4.5",
          } as SelectableModel as never,
        ]);
      },
      cliCommandExists() {
        return Promise.resolve(false);
      },
    });

    try {
      const models = await getAvailableModels();
      const expected: SelectableModel[] = [
        copilotModel("auto", "Auto"),
        copilotModel("copilot-gpt-5.6-sol", "GPT-5.6 Sol"),
        ...copilotReasoningAndContextVariants(
          "copilot-gpt-5.6-sol",
          "GPT-5.6 Sol",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
            ["ultra", "Ultra"],
          ],
          true
        ),
        copilotModel("copilot-gpt-5.6-terra", "GPT-5.6 Terra"),
        ...copilotReasoningAndContextVariants(
          "copilot-gpt-5.6-terra",
          "GPT-5.6 Terra",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
            ["ultra", "Ultra"],
          ],
          true
        ),
        copilotModel("copilot-gpt-5.6-luna", "GPT-5.6 Luna"),
        ...copilotReasoningAndContextVariants(
          "copilot-gpt-5.6-luna",
          "GPT-5.6 Luna",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel("copilot-gpt-5.5", "GPT-5.5"),
        ...copilotReasoningAndContextVariants(
          "copilot-gpt-5.5",
          "GPT-5.5",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
          ],
          true
        ),
        copilotModel("copilot-gpt-5.4", "GPT-5.4"),
        ...copilotReasoningAndContextVariants(
          "copilot-gpt-5.4",
          "GPT-5.4",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
          ],
          true
        ),
        copilotModel("copilot-gpt-5.3-codex", "GPT-5.3-Codex"),
        ...copilotReasoningVariants("copilot-gpt-5.3-codex", "GPT-5.3-Codex", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
          ["xhigh", "Extra High"],
        ]),
        copilotModel("copilot-gpt-5.4-mini", "GPT-5.4 mini"),
        ...copilotReasoningVariants("copilot-gpt-5.4-mini", "GPT-5.4 mini", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
          ["xhigh", "Extra High"],
        ]),
        copilotModel("copilot-gpt-5-mini", "GPT-5 mini"),
        ...copilotReasoningVariants("copilot-gpt-5-mini", "GPT-5 mini", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
          ["xhigh", "Extra High"],
        ]),
        copilotModel("copilot-claude-sonnet-5", "Claude Sonnet 5"),
        ...copilotReasoningAndContextVariants(
          "copilot-claude-sonnet-5",
          "Claude Sonnet 5",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel("copilot-claude-sonnet-4.6", "Claude Sonnet 4.6"),
        ...copilotReasoningAndContextVariants(
          "copilot-claude-sonnet-4.6",
          "Claude Sonnet 4.6",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel("copilot-claude-sonnet-4.5", "Claude Sonnet 4.5"),
        copilotModel("copilot-claude-haiku-4.5", "Claude Haiku 4.5"),
        copilotModel("copilot-claude-fable-5", "Claude Fable 5"),
        ...copilotReasoningAndContextVariants(
          "copilot-claude-fable-5",
          "Claude Fable 5",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel("copilot-claude-opus-4.8", "Claude Opus 4.8"),
        ...copilotReasoningAndContextVariants(
          "copilot-claude-opus-4.8",
          "Claude Opus 4.8",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel(
          "copilot-claude-opus-4.8-fast",
          "Claude Opus 4.8 (fast mode) (Preview)"
        ),
        ...copilotReasoningAndContextVariants(
          "copilot-claude-opus-4.8-fast",
          "Claude Opus 4.8 (fast mode) (Preview)",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel("copilot-claude-opus-4.7", "Claude Opus 4.7"),
        ...copilotReasoningAndContextVariants(
          "copilot-claude-opus-4.7",
          "Claude Opus 4.7",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ],
          true
        ),
        copilotModel("copilot-gemini-3.1-pro", "Gemini 3.1 Pro (Preview)"),
        ...copilotReasoningAndContextVariants(
          "copilot-gemini-3.1-pro",
          "Gemini 3.1 Pro (Preview)",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ],
          true
        ),
        copilotModel("copilot-gemini-3.5-flash", "Gemini 3.5 Flash"),
        ...copilotReasoningAndContextVariants(
          "copilot-gemini-3.5-flash",
          "Gemini 3.5 Flash",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ],
          true
        ),
        copilotModel("copilot-kimi-k2.7-code", "Kimi K2.7 Code"),
        copilotModel("copilot-mai-code-1-flash", "MAI-Code-1-Flash"),
        ...copilotReasoningVariants("copilot-mai-code-1-flash", "MAI-Code-1-Flash", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
          ["xhigh", "Extra High"],
        ]),
        copilotModel("copilot-claude-opus-4.6", "claude-opus-4.6"),
        copilotModel("copilot-claude-opus-4.5", "claude-opus-4.5"),
      ];
      assert.deepStrictEqual(
        providerModels(models, "GitHub Copilot"),
        expected
      );
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
            name: "Sonnet 5 (Default, recommended)",
            providerLabel: "Claude Code (subscription CLI)",
          },
          {
            id: "claude-cli:sonnet",
            name: "Sonnet 5",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants("sonnet", "Sonnet 5", [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "Extra High"],
            ["max", "Max"],
          ]),
          {
            id: "claude-cli:fable",
            name: "Fable 5 [only on Max plan]",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "fable",
            "Fable 5",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
            ],
            "only on Max plan"
          ),
          {
            id: "claude-cli:opus",
            name: "Opus 4.8 [only on Max plan]",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "opus",
            "Opus 4.8",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
            ],
            "only on Max plan"
          ),
          {
            id: "claude-cli:haiku",
            name: "Haiku 4.5",
            providerLabel: "Claude Code (subscription CLI)",
          },
        ]
      );
      assert.deepStrictEqual(
        providerModels(models, "OpenAI Codex (subscription CLI)"),
        [
          codexVariant("codex-cli:default", "Codex (CLI default)"),
          ...codexVariants(
            "gpt-5.5",
            "GPT-5.5",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
            ],
            true
          ),
          ...codexVariants(
            "gpt-5.6-terra",
            "GPT-5.6-Terra",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
              ["ultra", "Ultra"],
            ],
            true
          ),
          ...codexVariants(
            "gpt-5.6-sol",
            "GPT-5.6-SOL",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
              ["ultra", "Ultra"],
            ],
            true
          ),
          ...codexVariants(
            "gpt-5.6-luna",
            "GPT-5.6-Luna",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
            ],
            true
          ),
          ...codexVariants(
            "gpt-5.4",
            "GPT-5.4",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
            ],
            true
          ),
          ...codexVariants(
            "gpt-5.4-mini",
            "GPT-5.4-Mini",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
            ],
            false
          ),
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

  void it("prefers discovered Kiro models over seeded fallback entries", async () => {
    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "kiro-cli");
      },
      getDiscoveredCliModels(def) {
        if (def.id !== "kiro-cli") {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { model: "claude-opus-4.6", name: "Claude Opus 4.6" },
          { model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          { model: "claude-opus-4.6", name: "Duplicate should be ignored" },
        ]);
      },
    });

    try {
      assert.deepStrictEqual(
        providerModels(await getAvailableModels(), "Kiro CLI (subscription CLI)"),
        [
          {
            id: "kiro-cli:default",
            name: "Kiro (CLI default)",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:claude-opus-4.6",
            name: "Claude Opus 4.6",
            providerLabel: "Kiro CLI (subscription CLI)",
          },
          {
            id: "kiro-cli:claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
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
