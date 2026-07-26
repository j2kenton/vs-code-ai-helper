import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __testOnly,
  getAvailableModels,
  type SelectableModel,
  describeModel,
  getModelDisplayName,
  describeModelSource,
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

function openCodeZenModels(
  models: readonly SelectableModel[]
): SelectableModel[] {
  return providerModels(models, "OpenCode Zen (shared OpenCode account; pay as you go)");
}

function openCodeGoModels(
  models: readonly SelectableModel[]
): SelectableModel[] {
  return providerModels(models, "OpenCode Go (shared OpenCode account; subscription)");
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
            name: "Fable 5",
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
            ]
          ),
          {
            id: "claude-cli:opus",
            name: "Opus 5",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "opus",
            "Opus 5",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
            ]
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
            id: "antigravity-cli:Gemini 3.6 Flash (Low)",
            name: "Gemini 3.6 Flash (Low)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.6 Flash (Medium)",
            name: "Gemini 3.6 Flash (Medium)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.6 Flash (High)",
            name: "Gemini 3.6 Flash (High)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.5 Flash (Medium)",
            name: "Gemini 3.5 Flash (Medium)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.5 Flash (High)",
            name: "Gemini 3.5 Flash (High)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.5 Flash (Low)",
            name: "Gemini 3.5 Flash (Low)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.1 Pro (Low)",
            name: "Gemini 3.1 Pro (Low)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.1 Pro (High)",
            name: "Gemini 3.1 Pro (High)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Claude Sonnet 4.6 (Thinking)",
            name: "Claude Sonnet 4.6 (Thinking)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Claude Opus 4.6 (Thinking)",
            name: "Claude Opus 4.6 (Thinking)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:GPT-OSS 120B (Medium)",
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

  void it("surfaces opencode's hardcoded seeded catalog, including per-model @variant entries, with no live discovery", async () => {
    // opencode's seed list (SEEDED_CLI_MODELS in modelSelection.ts) is a
    // full ~466-entry snapshot of `opencode models --verbose`, unlike the
    // small hand-curated lists for the other providers — verifying every
    // entry here would be redundant with the snapshot itself, so this
    // checks the shape (default fallback first, real seeded models present,
    // @variant-suffixed entries present) rather than the full list.
    //
    // Deliberately does NOT override getDiscoveredCliModels: production's
    // real implementation reads synchronously from cliModelCache, which
    // restoreSeededCliModelCache() pre-populates from SEEDED_CLI_MODELS at
    // module load — that's the actual "seed populates the picker with no
    // live CLI call" path this test needs to exercise. Overriding it (as
    // the Copilot/Antigravity fixtures above do to inject specific
    // discovery results) would bypass the cache and defeat the point.
    __testOnly.restoreSeededCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "opencode");
      },
    });

    try {
      const allModels = await getAvailableModels();
      const zenModels = openCodeZenModels(allModels);
      const goModels = openCodeGoModels(allModels);
      assert.ok(zenModels.length > 100, `expected Zen seeded models, got ${zenModels.length}`);
      assert.ok(goModels.length > 20, `expected Go seeded models, got ${goModels.length}`);
      assert.ok(
        !allModels.some((m) => m.id === "opencode-cli:default"),
        "a generic OpenCode CLI default would hide the Zen/Go service choice"
      );
      assert.ok(
        allModels.every((m) =>
          /^opencode-cli:(?:opencode|opencode-go)\//.test(m.id)
        ),
        "only OpenCode Zen and Go namespaces should be offered by this integration"
      );
      assert.ok(
        zenModels.some((m) => m.id === "opencode-cli:opencode/deepseek-v4-flash"),
        "expected the base deepseek-v4-flash entry"
      );
      assert.ok(
        zenModels.some((m) => m.id === "opencode-cli:opencode/deepseek-v4-flash@high"),
        "expected deepseek-v4-flash's @high variant entry"
      );
      assert.ok(
        zenModels.some((m) => m.id === "opencode-cli:opencode/north-mini-code-free@none"),
        "expected north-mini-code-free's @none variant entry"
      );
      assert.ok(
        goModels.some((m) => m.id === "opencode-cli:opencode-go/deepseek-v4-flash"),
        "expected the opencode-go tier's deepseek-v4-flash entry"
      );
      assert.ok(
        goModels.some((m) => m.id === "opencode-cli:opencode-go/deepseek-v4-flash@high"),
        "expected the opencode-go tier's deepseek-v4-flash @high variant entry"
      );
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
      __testOnly.restoreSeededCliModelCache();
    }
  });

  void it("surfaces Cline's hardcoded ClinePass seeded catalog, including deepseek and every @thinking-effort variant, with no live discovery", async () => {
    // Cline has no `cline models`-style listing subcommand (see providers.ts's
    // absent discoverModels for cline-cli), so — like Claude/Codex — its full
    // catalog lives only in the seed, populated with no live CLI call.
    __testOnly.restoreSeededCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "cline");
      },
    });

    try {
      const allModels = await getAvailableModels();
      const clineModels = allModels.filter((m) => m.id.startsWith("cline-cli:"));

      assert.ok(
        clineModels.some((m) => m.id === "cline-cli:default"),
        "expected the ClinePass account-default fallback entry"
      );
      assert.ok(
        clineModels.some(
          (m) => m.id === "cline-cli:cline-pass/deepseek-v4-pro"
        ),
        "expected the base DeepSeek V4 Pro entry"
      );
      assert.ok(
        clineModels.some(
          (m) => m.id === "cline-cli:cline-pass/deepseek-v4-pro@high"
        ),
        "expected DeepSeek V4 Pro's @high thinking-effort variant"
      );
      for (const effort of ["none", "low", "medium", "high", "xhigh"]) {
        assert.ok(
          clineModels.some(
            (m) => m.id === `cline-cli:cline-pass/deepseek-v4-flash@${effort}`
          ),
          `expected DeepSeek V4 Flash's @${effort} thinking-effort variant`
        );
      }
      assert.ok(
        clineModels.some(
          (m) => m.id === "cline-cli:deepseek/deepseek-v4-flash"
        ),
        "expected the free promotional DeepSeek V4 Flash entry"
      );
      assert.ok(
        clineModels.every((m) => m.providerLabel === "Cline CLI (subscription CLI)"),
        "every Cline model should carry the generic subscription-CLI label"
      );
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
      __testOnly.restoreSeededCliModelCache();
    }
  });

  void it("resolveRefreshedCliModels keeps the current (seeded) list when a background refresh finds nothing, and replaces it wholesale when it does", () => {
    // This is the actual merge-decision function queueCliModelRefresh calls
    // in production to update cliModelCache after a live discovery call
    // (getAvailableModels itself never merges anything — it just reads
    // whatever is currently cached). Testing it directly, rather than
    // hand-priming the cache with a pre-merged result via
    // primeCliModelCache, is what actually exercises the merge behavior:
    // a test that primes the cache with the answer it then asserts would
    // pass even if this function were deleted entirely.
    const seeded = [
      { model: "opencode/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { model: "opencode/gpt-5", name: "GPT-5" },
    ];

    // A refresh that finds nothing (CLI hung, timed out, or genuinely
    // returned an empty catalog) must not wipe out the seed.
    assert.deepStrictEqual(
      __testOnly.resolveRefreshedCliModels(seeded, []),
      seeded
    );

    // A refresh that DOES find models replaces the list wholesale with
    // whatever it found — the seed's own entries only survive if the fresh
    // discovery call itself still reports them (which parseOpencodeModelsOutput
    // does, since it always re-derives the full catalog from `opencode
    // models --verbose`, not an incremental diff).
    const discovered = [
      { model: "opencode/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { model: "opencode/brand-new-model", name: "Brand New Model" },
    ];
    assert.deepStrictEqual(
      __testOnly.resolveRefreshedCliModels(seeded, discovered),
      discovered
    );
  });

  void it("getAvailableModels reads whatever is currently in the opencode cache, seed or otherwise", async () => {
    // Complements the resolveRefreshedCliModels test above: confirms
    // getAvailableModels itself does no merging of its own and just
    // surfaces the cache's current contents — including a case where the
    // cache holds something other than the hardcoded seed (e.g. mid-way
    // through a real warmCliModelCache() refresh cycle).
    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "opencode");
      },
    });
    __testOnly.primeCliModelCache("opencode-cli", {
      models: [{ model: "opencode/brand-new-model", name: "Brand New Model" }],
    });

    try {
      const models = openCodeZenModels(await getAvailableModels());
      assert.ok(
        models.some((m) => m.id === "opencode-cli:opencode/brand-new-model"),
        "expected the primed cache entry to surface"
      );
      assert.ok(
        !models.some((m) => m.id === "opencode-cli:opencode/deepseek-v4-flash"),
        "the seed's own entries should NOT appear once the cache holds a different list " +
          "(getAvailableModels does not merge — production relies on resolveRefreshedCliModels for that)"
      );
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
      __testOnly.restoreSeededCliModelCache();
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

});
