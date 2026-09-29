import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  __testOnly,
  describeStageSubstitutesV1,
  findStagesSharingBlockedPrimaryV1,
  getAvailableCopilotModels,
  getAvailableModels,
  resolveConfiguredReviewStages,
  type SelectableModel,
  describeModel,
  getModelDisplayName,
  describeModelSource,
} from "../utils/modelSelection";
import { parseOpencodeModelsOutput } from "../utils/cliModelDiscovery";
import {
  CODEX_MODEL_CAPABILITIES,
  OPENCODE_MODEL_VARIANTS,
  describeModelWithProviderV1,
  getCliProvider,
  parseCodexModelSelection,
  parseModelSelection,
  parseOpencodeModelSelection,
} from "../runners/providers";

/** Mirrors runnerRegistry.test.ts's own `installModelSettings` helper. */
function installModelSettings(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : defaultValue,
    inspect: () => undefined,
  });
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

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

/**
 * v1 fixes 2, item 19: Copilot's LM provider ignores `model_reasoning_effort`
 * and `model_context_window`, so no `@effort` / `+long` variants are offered.
 * The call sites keep the historical matrix (model, label, efforts) so the
 * expectation still documents which variants are deliberately absent.
 */
function copilotReasoningVariants(
  _model: string,
  _label: string,
  _efforts: readonly (readonly [string, string])[]
): SelectableModel[] {
  return [];
}

function copilotReasoningAndContextVariants(
  _model: string,
  _label: string,
  _efforts: readonly (readonly [string, string])[],
  _longContext: boolean
): SelectableModel[] {
  return [];
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
          {
            id: "copilot-gemini-3.6-flash",
            name: "Gemini 3.6 Flash",
          } as SelectableModel as never,
          {
            id: "copilot-gemini-3.7-flash",
            name: "Gemini 3.7 Flash",
          } as SelectableModel as never,
          {
            id: "copilot-grok-4.6",
            name: "Grok 4.6",
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
        copilotModel("auto", "Auto (provider-chosen)"),
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
        copilotModel("copilot-gemini-3.6-flash", "Gemini 3.6 Flash"),
        ...copilotReasoningAndContextVariants(
          "copilot-gemini-3.6-flash",
          "Gemini 3.6 Flash",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ],
          true
        ),
        copilotModel("copilot-gemini-3.7-flash", "Gemini 3.7 Flash"),
        ...copilotReasoningAndContextVariants(
          "copilot-gemini-3.7-flash",
          "Gemini 3.7 Flash",
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ],
          true
        ),
        copilotModel("copilot-grok-4.6", "Grok 4.6"),
        ...copilotReasoningVariants("copilot-grok-4.6", "Grok 4.6", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
        ]),
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
            id: "claude-cli:claude-fable-5-1",
            name: "Fable 5.1",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "claude-fable-5-1",
            "Fable 5.1",
            [
              ["low", "Low"],
              ["medium", "Medium"],
              ["high", "High"],
              ["xhigh", "Extra High"],
              ["max", "Max"],
            ]
          ),
          {
            id: "claude-cli:claude-fable-5",
            name: "Fable 5",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "claude-fable-5",
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
            id: "claude-cli:fable",
            name: "Fable (latest)",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "fable",
            "Fable (latest)",
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
            id: "claude-cli:claude-opus-5-5",
            name: "Opus 5.5",
            providerLabel: "Claude Code (subscription CLI)",
          },
          ...claudeCliReasoningVariants(
            "claude-opus-5-5",
            "Opus 5.5",
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
            "gpt-6-astra",
            "GPT-6-Astra",
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
            "gpt-6-sol",
            "GPT-6-Sol",
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
            "gpt-6-luna",
            "GPT-6-Luna",
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
            id: "antigravity-cli:Gemini 3.7 Flash (Low)",
            name: "Gemini 3.7 Flash (Low)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.7 Flash (Medium)",
            name: "Gemini 3.7 Flash (Medium)",
            providerLabel: "Antigravity CLI (subscription CLI)",
          },
          {
            id: "antigravity-cli:Gemini 3.7 Flash (High)",
            name: "Gemini 3.7 Flash (High)",
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
      // Opus 5.5 and the GPT-6 family, each with exactly the variants the
      // 2026-09-27 `opencode models --verbose` capture lists for it.
      const zenLadder = (base: string): string[] =>
        zenModels
          .map((m) => m.id)
          .filter((id) => id.startsWith(`opencode-cli:opencode/${base}@`))
          .map((id) => id.slice(id.lastIndexOf("@") + 1));
      for (const [base, ladder] of [
        ["claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]],
        ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
        ["gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
        ["gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
      ] as const) {
        assert.ok(
          zenModels.some((m) => m.id === `opencode-cli:opencode/${base}`),
          `expected the base ${base} entry`
        );
        assert.deepStrictEqual(zenLadder(base), [...ladder], `${base} variants`);
      }
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
        clineModels.some((m) => m.id === "cline-cli:cline-free/glm-5.2"),
        "expected the free promotional GLM-5.2 entry"
      );
      assert.ok(
        clineModels.some((m) => m.id === "cline-cli:cline-free/glm-5.2@high"),
        "expected free GLM-5.2's @high thinking-effort variant"
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
    assert.strictEqual(describeModel("gemini-3.5-flash", mockModels), "Gemini 3.5 Flash (Antigravity)");
    assert.strictEqual(describeModel("gpt-5", mockModels), "gpt-5 (GitHub Copilot) — currently unavailable");
    assert.strictEqual(describeModel("codex-cli:gpt-5", mockModels), "gpt-5 (OpenAI Codex) — currently unavailable");
  });

  void it("getModelDisplayName returns correct strings", () => {
    assert.strictEqual(getModelDisplayName(undefined, mockModels), "Automatic");
    assert.strictEqual(getModelDisplayName("gemini-3.5-flash", mockModels), "Gemini 3.5 Flash");
    assert.strictEqual(getModelDisplayName("gpt-5", mockModels), "gpt-5");
  });

  void it("describeModelSource returns correct strings", () => {
    assert.strictEqual(describeModelSource("task"), "task override");
    assert.strictEqual(describeModelSource("workspace"), "workspace default");
    assert.strictEqual(describeModelSource("general"), "general model fallback");
    assert.strictEqual(describeModelSource("none"), "automatic selection");
  });

});

void describe("findStagesSharingBlockedPrimaryV1 (Part 5 step 3b — long-outage stage-impact notice)", () => {
  void it("lists every configurable stage whose effective primary resolves to the given model id", () => {
    const settings = installModelSettings({
      plan: { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" },
      "plan-high-review": { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" },
      impl: { primary: "kiro-cli:default", strategy: "alert-and-wait" },
    });
    try {
      const affected = findStagesSharingBlockedPrimaryV1("copilot-gpt-5.6-sol");
      assert.deepEqual(affected.sort(), ["plan", "plan-high-review"].sort());
    } finally {
      settings.restore();
    }
  });

  void it("omits stages whose primary resolves to a different model, including via the general-model fallback", () => {
    const settings = installModelSettings({
      desc: { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" }, // general model
      plan: { primary: "kiro-cli:default", strategy: "alert-and-wait" }, // own primary, different model
      // "impl" has no own chain — inherits the general (desc) chain's primary.
    });
    try {
      const affected = findStagesSharingBlockedPrimaryV1("copilot-gpt-5.6-sol");
      assert.ok(affected.includes("desc"));
      assert.ok(affected.includes("impl"));
      assert.ok(!affected.includes("plan"));
    } finally {
      settings.restore();
    }
  });

  void it("returns an empty list when no stage's primary matches", () => {
    const settings = installModelSettings({
      plan: { primary: "kiro-cli:default", strategy: "alert-and-wait" },
    });
    try {
      assert.deepEqual(findStagesSharingBlockedPrimaryV1("copilot-gpt-5.6-sol"), []);
    } finally {
      settings.restore();
    }
  });

  void it("compares by provider account, not exact model id — a provider-wide block affects every stage primary'd to ANY model on that provider (review completion blocker)", () => {
    const settings = installModelSettings({
      plan: { primary: "claude-cli:opus", strategy: "alert-and-wait" },
      "plan-high-review": { primary: "claude-cli:sonnet", strategy: "alert-and-wait" },
      impl: { primary: "kiro-cli:default", strategy: "alert-and-wait" },
    });
    try {
      // The block was observed on claude-cli:opus, but claude-cli:sonnet is
      // a DIFFERENT model id on the SAME provider account — a provider-wide
      // quota/entitlement block affects it too. A prior version compared
      // exact model id and missed this.
      const affected = findStagesSharingBlockedPrimaryV1("claude-cli:opus");
      assert.deepEqual(affected.sort(), ["plan", "plan-high-review"].sort());
    } finally {
      settings.restore();
    }
  });
});

void describe("describeStageSubstitutesV1 (workflow 3 continuation, first item — named substitute per affected stage)", () => {
  void it("names the first enabled backup on a DIFFERENT provider account as the affected stage's substitute", () => {
    const settings = installModelSettings({
      plan: {
        primary: "claude-cli:opus",
        backups: ["kiro-cli:default"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const descriptions = describeStageSubstitutesV1("claude-cli:opus");
      assert.deepEqual(descriptions, [`Plan → ${describeModelWithProviderV1("kiro-cli:default")}`]);
    } finally {
      settings.restore();
    }
  });

  void it("reports no backup configured when the affected stage has none", () => {
    const settings = installModelSettings({
      plan: { primary: "claude-cli:opus", strategy: "alert-and-wait" },
    });
    try {
      const descriptions = describeStageSubstitutesV1("claude-cli:opus");
      assert.deepEqual(descriptions, ["Plan: no backup configured — this stage will pause"]);
    } finally {
      settings.restore();
    }
  });

  void it("skips a backup on the SAME blocked provider account — it is equally blocked, not a real substitute", () => {
    const settings = installModelSettings({
      plan: {
        primary: "claude-cli:opus",
        // Same account as the blocked primary (claude-cli) — not usable.
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const descriptions = describeStageSubstitutesV1("claude-cli:opus");
      assert.deepEqual(descriptions, ["Plan: no backup configured — this stage will pause"]);
    } finally {
      settings.restore();
    }
  });

  void it("falls through to the first DIFFERENT-account backup when an earlier one is on the same blocked account", () => {
    const settings = installModelSettings({
      plan: {
        primary: "claude-cli:opus",
        backups: ["claude-cli:sonnet", "kiro-cli:default"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const descriptions = describeStageSubstitutesV1("claude-cli:opus");
      assert.deepEqual(descriptions, [`Plan → ${describeModelWithProviderV1("kiro-cli:default")}`]);
    } finally {
      settings.restore();
    }
  });

  void it("excludes the stage that is itself reporting the outage", () => {
    const settings = installModelSettings({
      plan: { primary: "claude-cli:opus", strategy: "alert-and-wait" },
      "plan-high-review": { primary: "claude-cli:opus", strategy: "alert-and-wait" },
    });
    try {
      const descriptions = describeStageSubstitutesV1("claude-cli:opus", "plan");
      assert.deepEqual(descriptions, [
        "High-Level Review (Plan): no backup configured — this stage will pause",
      ]);
    } finally {
      settings.restore();
    }
  });

  void it("returns an empty list when no other stage shares the blocked primary", () => {
    const settings = installModelSettings({
      plan: { primary: "kiro-cli:default", strategy: "alert-and-wait" },
    });
    try {
      assert.deepEqual(describeStageSubstitutesV1("claude-cli:opus"), []);
    } finally {
      settings.restore();
    }
  });
});

void describe("resolveConfiguredReviewStages (auto-advance General Model fallback for optional review stages)", () => {
  void it("keeps plan-low-review configured when it has no chain of its own but the General Model is configured", async () => {
    const settings = installModelSettings({
      desc: { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" },
    });
    try {
      const configured = await resolveConfiguredReviewStages(vscode.Uri.file("/fake/task"));
      assert.ok(configured.has("plan-low-review"), "plan-low-review should inherit the General Model and stay configured");
    } finally {
      settings.restore();
    }
  });

  void it("keeps impl-low-review configured when it has no chain of its own but the General Model is configured", async () => {
    const settings = installModelSettings({
      desc: { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" },
    });
    try {
      const configured = await resolveConfiguredReviewStages(vscode.Uri.file("/fake/task"));
      assert.ok(configured.has("impl-low-review"), "impl-low-review should inherit the General Model and stay configured");
    } finally {
      settings.restore();
    }
  });

  void it("skips plan-low-review only when neither its own chain nor the General Model is configured", async () => {
    const settings = installModelSettings({});
    try {
      const configured = await resolveConfiguredReviewStages(vscode.Uri.file("/fake/task"));
      assert.ok(!configured.has("plan-low-review"), "plan-low-review should be skipped when no model is configured anywhere");
    } finally {
      settings.restore();
    }
  });

  void it("skips impl-low-review only when neither its own chain nor the General Model is configured", async () => {
    const settings = installModelSettings({});
    try {
      const configured = await resolveConfiguredReviewStages(vscode.Uri.file("/fake/task"));
      assert.ok(!configured.has("impl-low-review"), "impl-low-review should be skipped when no model is configured anywhere");
    } finally {
      settings.restore();
    }
  });

  void it("keeps every other review stage configured regardless of the General Model, since they are never opted out", async () => {
    const settings = installModelSettings({});
    try {
      const configured = await resolveConfiguredReviewStages(vscode.Uri.file("/fake/task"));
      assert.ok(configured.has("plan-high-review"));
      assert.ok(configured.has("impl-high-review"));
      assert.ok(configured.has("publish"));
    } finally {
      settings.restore();
    }
  });

  void it("prefers a stage's own configured chain over the General Model", async () => {
    const settings = installModelSettings({
      "plan-low-review": { primary: "kiro-cli:default", strategy: "alert-and-wait" },
    });
    try {
      const configured = await resolveConfiguredReviewStages(vscode.Uri.file("/fake/task"));
      assert.ok(configured.has("plan-low-review"));
    } finally {
      settings.restore();
    }
  });
});

void describe("getAvailableCopilotModels (workflow 3 continuation, sixth item — 'auto' no longer leads)", () => {
  function installCopilotModels(
    models: readonly { id: string; name: string }[]
  ): { restore: () => void } {
    const lm = (vscode as unknown as {
      lm: { selectChatModels: () => Promise<vscode.LanguageModelChat[]> };
    }).lm;
    const original = lm.selectChatModels;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve(models as vscode.LanguageModelChat[]);
    return {
      restore: (): void => {
        lm.selectChatModels = original;
      },
    };
  }

  void it("moves 'auto' to the END of the list instead of floating it to the front", async () => {
    const stub = installCopilotModels([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "auto", name: "Auto" },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    ]);
    try {
      const models = await getAvailableCopilotModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["gpt-5.6-sol", "claude-sonnet-4.6", "auto"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("leaves the list untouched when no 'auto' model is present", async () => {
    const stub = installCopilotModels([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    ]);
    try {
      const models = await getAvailableCopilotModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["gpt-5.6-sol", "claude-sonnet-4.6"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("leaves a lone 'auto' model as the only entry", async () => {
    const stub = installCopilotModels([{ id: "auto", name: "Auto" }]);
    try {
      const models = await getAvailableCopilotModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["auto"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("labels 'auto' as provider-chosen in the selectable-model list surfaced to the settings UI, and leaves concrete Copilot model names untouched", async () => {
    const stub = installCopilotModels([
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "auto", name: "Auto" },
    ]);
    try {
      const models = await getAvailableModels();
      const copilotModels = providerModels(models, "GitHub Copilot");
      const auto = copilotModels.find((m) => m.id === "auto");
      const concrete = copilotModels.find((m) => m.id === "gpt-5.6-sol");
      assert.equal(auto?.name, "Auto (provider-chosen)");
      assert.equal(concrete?.name, "GPT-5.6 Sol");
    } finally {
      stub.restore();
    }
  });
});

void describe("GPT-6 / Opus 5.5 listed entries validate against the provider ladders", () => {
  async function seededPickerIds(command: string): Promise<string[]> {
    __testOnly.restoreSeededCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(name) {
        return Promise.resolve(name === command);
      },
    });
    try {
      return (await getAvailableModels()).map((m) => m.id);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
      __testOnly.restoreSeededCliModelCache();
    }
  }

  const ladderOf = (ids: readonly string[], prefix: string): string[] =>
    ids.filter((id) => id.startsWith(`${prefix}@`)).map((id) => id.slice(id.lastIndexOf("@") + 1));

  void it("lists Codex gpt-6-astra with exactly its evidenced ladder, every listed id resolving to gpt-6-astra", async () => {
    const ids = await seededPickerIds("codex");
    // The Codex seed emits only effort-qualified and fast-qualified entries, never a bare model id.
    assert.ok(
      ids.some((id) => id.startsWith("codex-cli:gpt-6-astra@")),
      "expected effort-qualified gpt-6-astra entries"
    );
    const evidenced = ["low", "medium", "high", "xhigh", "max", "ultra"];
    assert.deepStrictEqual(
      CODEX_MODEL_CAPABILITIES["gpt-6-astra"]?.efforts.map(([effort]) => effort),
      evidenced
    );
    // Fast variants are listed for the same ladder (Codex lists the fast tier for gpt-6-astra).
    const listed = ids.filter((id) => id.startsWith("codex-cli:gpt-6-astra@"));
    assert.deepStrictEqual(
      listed.map((id) => id.slice("codex-cli:gpt-6-astra@".length)).sort(),
      [...evidenced, ...evidenced.map((e) => `${e}+fast`)].sort()
    );
    for (const id of listed) {
      const parsed = parseCodexModelSelection(parseModelSelection(id).model);
      assert.strictEqual(parsed.model, "gpt-6-astra", `${id} must not resolve to an older GPT model`);
      assert.ok(evidenced.includes(parsed.reasoningEffort ?? ""), id);
    }
  });

  void it("rejects Codex gpt-6-astra levels outside its ladder instead of falling back", () => {
    for (const bad of ["none", "minimal", "turbo", "Ultra"]) {
      assert.throws(() => parseCodexModelSelection(`gpt-6-astra@${bad}`), Error, bad);
    }
    // There is no plain gpt-6 in Codex's catalogue.
    assert.ok(!("gpt-6" in CODEX_MODEL_CAPABILITIES), "gpt-6 must not be a Codex capability");
  });

  void it("lists Codex gpt-6-sol with exactly its evidenced ladder, every listed id resolving to gpt-6-sol", async () => {
    const ids = await seededPickerIds("codex");
    assert.ok(
      ids.some((id) => id.startsWith("codex-cli:gpt-6-sol@")),
      "expected effort-qualified gpt-6-sol entries"
    );
    const evidenced = ["low", "medium", "high", "xhigh", "max", "ultra"];
    assert.deepStrictEqual(
      CODEX_MODEL_CAPABILITIES["gpt-6-sol"]?.efforts.map(([effort]) => effort),
      evidenced
    );
    const listed = ids.filter((id) => id.startsWith("codex-cli:gpt-6-sol@"));
    assert.deepStrictEqual(
      listed.map((id) => id.slice("codex-cli:gpt-6-sol@".length)).sort(),
      [...evidenced, ...evidenced.map((e) => `${e}+fast`)].sort()
    );
    for (const id of listed) {
      const parsed = parseCodexModelSelection(parseModelSelection(id).model);
      assert.strictEqual(parsed.model, "gpt-6-sol", `${id} must not resolve to a different model`);
      assert.ok(evidenced.includes(parsed.reasoningEffort ?? ""), id);
    }
  });

  void it("rejects Codex gpt-6-sol levels outside its ladder instead of falling back", () => {
    for (const bad of ["none", "minimal", "turbo", "Ultra"]) {
      assert.throws(() => parseCodexModelSelection(`gpt-6-sol@${bad}`), Error, bad);
    }
  });

  void it("lists Codex gpt-6-luna with exactly its evidenced ladder, every listed id resolving to gpt-6-luna", async () => {
    const ids = await seededPickerIds("codex");
    assert.ok(
      ids.some((id) => id.startsWith("codex-cli:gpt-6-luna@")),
      "expected effort-qualified gpt-6-luna entries"
    );
    const evidenced = ["low", "medium", "high", "xhigh", "max"];
    assert.deepStrictEqual(
      CODEX_MODEL_CAPABILITIES["gpt-6-luna"]?.efforts.map(([effort]) => effort),
      evidenced
    );
    const listed = ids.filter((id) => id.startsWith("codex-cli:gpt-6-luna@"));
    assert.deepStrictEqual(
      listed.map((id) => id.slice("codex-cli:gpt-6-luna@".length)).sort(),
      [...evidenced, ...evidenced.map((e) => `${e}+fast`)].sort()
    );
    for (const id of listed) {
      const parsed = parseCodexModelSelection(parseModelSelection(id).model);
      assert.strictEqual(parsed.model, "gpt-6-luna", `${id} must not resolve to a different model`);
      assert.ok(evidenced.includes(parsed.reasoningEffort ?? ""), id);
    }
  });

  void it("rejects Codex gpt-6-luna levels outside its ladder instead of falling back", () => {
    for (const bad of ["none", "minimal", "turbo", "ultra"]) {
      assert.throws(() => parseCodexModelSelection(`gpt-6-luna@${bad}`), Error, bad);
    }
  });

  void it("lists Claude Opus 5.5 with exactly low..max and routes each level to claude-opus-5-5", async () => {
    const ids = await seededPickerIds("claude");
    assert.ok(ids.includes("claude-cli:claude-opus-5-5"), "expected the base Opus 5.5 entry");
    const ladder = ["low", "medium", "high", "xhigh", "max"];
    assert.deepStrictEqual(ladderOf(ids, "claude-cli:claude-opus-5-5"), ladder);
    const claude = getCliProvider("claude-cli");
    assert.ok(claude, "expected the claude-cli provider");
    for (const level of ladder) {
      const args = claude.buildArgs("text", `claude-opus-5-5@${level}`);
      assert.strictEqual(args[args.indexOf("--model") + 1], "claude-opus-5-5", level);
      assert.ok(args.includes("--max-thinking-tokens"), `${level} must set a thinking budget`);
    }
    // Unsupported levels reject; the id is never aliased onto the older `opus` (Opus 5) entry.
    for (const bad of ["none", "ultra", "minimal", "turbo"]) {
      assert.throws(() => claude.buildArgs("text", `claude-opus-5-5@${bad}`), Error, bad);
    }
    const baseArgs = claude.buildArgs("text", "claude-opus-5-5");
    assert.strictEqual(baseArgs[baseArgs.indexOf("--model") + 1], "claude-opus-5-5");
  });

  void it("validates OpenCode Zen Opus 5.5 / GPT-6 variants against each model's own ladder", async () => {
    const ids = await seededPickerIds("opencode");
    for (const base of ["claude-opus-5-5", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]) {
      const zenBase = `opencode/${base}`;
      const ladder = OPENCODE_MODEL_VARIANTS[zenBase];
      assert.ok(ladder, `${zenBase} needs a known ladder`);
      assert.deepStrictEqual(ladderOf(ids, `opencode-cli:${zenBase}`), [...ladder], zenBase);
      for (const level of ladder) {
        assert.deepStrictEqual(parseOpencodeModelSelection(`${zenBase}@${level}`), {
          model: zenBase,
          variant: level,
        });
      }
      assert.throws(() => parseOpencodeModelSelection(`${zenBase}@bogus`), Error, zenBase);
    }
    // Ladders differ per model: astra and Opus 5.5 have no "none"; "ultra" is Codex-only.
    assert.throws(() => parseOpencodeModelSelection("opencode/gpt-6-astra@none"));
    assert.throws(() => parseOpencodeModelSelection("opencode/gpt-6-sol@ultra"));
    assert.deepStrictEqual(parseOpencodeModelSelection("opencode/gpt-6-sol@none"), {
      model: "opencode/gpt-6-sol",
      variant: "none",
    });
  });

  void it("offers no GPT-6 or Opus 5.5 entry under the paths recorded as not-added", async () => {
    for (const [command, prefix] of [
      ["kiro-cli", "kiro-cli:"],
      ["cline", "cline-cli:"],
      ["agy", "antigravity-cli:"],
    ] as const) {
      const ids = (await seededPickerIds(command)).filter((id) => id.startsWith(prefix));
      assert.ok(!ids.some((id) => /gpt-6|opus-5[-.]5/.test(id)), `${prefix} seeds must not carry the new models`);
    }
    const openCodeIds = await seededPickerIds("opencode");
    const goIds = openCodeIds.filter((id) => id.startsWith("opencode-cli:opencode-go/"));
    assert.ok(!goIds.some((id) => /gpt-6|opus-5[-.]5/.test(id)), "the Go tier must not carry the new models");
    assert.ok(
      !openCodeIds.some((id) => id.startsWith("opencode-cli:openai/")),
      "non-picker openai/* seeds must never be offered"
    );
  });

  void it("validates the levels of a live-discovered GPT-6 / Opus 5.5 model the same way as a seeded one", () => {
    // The shape of `opencode models --verbose`: discovery replaces the seed wholesale, and the
    // discovered variant ids must still pass the runner's per-model ladder check.
    const capture = [
      "opencode/gpt-6-luna",
      JSON.stringify({
        id: "gpt-6-luna",
        providerID: "opencode",
        name: "GPT-6 Luna",
        variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
      }),
      "opencode/claude-opus-5-5",
      JSON.stringify({
        id: "claude-opus-5-5",
        providerID: "opencode",
        name: "Claude Opus 5.5",
        variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
      }),
    ].join("\n");
    const discovered = parseOpencodeModelsOutput(capture).map((m) => m.model);
    assert.deepStrictEqual(discovered, [
      "opencode/gpt-6-luna",
      "opencode/gpt-6-luna@none",
      "opencode/gpt-6-luna@low",
      "opencode/gpt-6-luna@medium",
      "opencode/gpt-6-luna@high",
      "opencode/gpt-6-luna@xhigh",
      "opencode/gpt-6-luna@max",
      "opencode/claude-opus-5-5",
      "opencode/claude-opus-5-5@low",
      "opencode/claude-opus-5-5@medium",
      "opencode/claude-opus-5-5@high",
      "opencode/claude-opus-5-5@xhigh",
      "opencode/claude-opus-5-5@max",
    ]);
    for (const id of discovered) {
      assert.doesNotThrow(() => parseOpencodeModelSelection(id), id);
    }
  });
});
