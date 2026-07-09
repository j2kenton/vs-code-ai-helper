import * as vscode from "vscode";
import { getAiModelDefaults } from "../config/settings";
import { cliCommandExists, resolveCliCommand } from "../runners/cliAgentRunner";
import {
  CLI_PROVIDERS,
  type CliProviderId,
  type CliProviderDefinition,
  toQualifiedModelId,
} from "../runners/providers";
import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";
import {
  discoverAgyModels,
  type DiscoveredCliModel,
} from "./cliModelDiscovery";

export const TASK_MODEL_CONFIG_FILENAME = "task-models.json";

interface TaskModelSelectionFile {
  stageModels: Partial<Record<TaskStage, string>>;
  updatedAt: string;
}

export interface ResolvedStageModel {
  modelId?: string;
  source: "task" | "workspace" | "none";
}

function isConfigurableStage(stage: TaskStage): boolean {
  return AI_MODEL_STAGES.includes(stage);
}

function sanitizeStageMap(
  value: unknown
): Partial<Record<TaskStage, string>> {
  const sanitized: Partial<Record<TaskStage, string>> = {};
  if (!value || typeof value !== "object") {
    return sanitized;
  }

  const record = value as Record<string, unknown>;
  for (const stage of AI_MODEL_STAGES) {
    const stageValue = record[stage];
    if (typeof stageValue === "string" && stageValue.trim().length > 0) {
      sanitized[stage] = stageValue;
    }
  }

  return sanitized;
}

export async function readTaskStageModels(
  taskFolderUri: vscode.Uri
): Promise<Partial<Record<TaskStage, string>>> {
  const modelFileUri = vscode.Uri.joinPath(
    taskFolderUri,
    TASK_MODEL_CONFIG_FILENAME
  );

  try {
    const content = await vscode.workspace.fs.readFile(modelFileUri);
    const parsed = JSON.parse(new TextDecoder().decode(content)) as
      | TaskModelSelectionFile
      | undefined;
    return sanitizeStageMap(parsed?.stageModels);
  } catch {
    return {};
  }
}

export async function setTaskStageModel(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  modelId: string | undefined
): Promise<void> {
  if (!isConfigurableStage(stage)) {
    return;
  }

  const current = await readTaskStageModels(taskFolderUri);
  if (modelId && modelId.trim().length > 0) {
    current[stage] = modelId;
  } else {
    delete current[stage];
  }

  const hasValues = AI_MODEL_STAGES.some((candidate) => {
    const value = current[candidate];
    return typeof value === "string" && value.length > 0;
  });

  const modelFileUri = vscode.Uri.joinPath(
    taskFolderUri,
    TASK_MODEL_CONFIG_FILENAME
  );

  if (!hasValues) {
    try {
      await vscode.workspace.fs.delete(modelFileUri);
    } catch {
      // Ignore if the file was not present.
    }
    return;
  }

  const payload: TaskModelSelectionFile = {
    stageModels: current,
    updatedAt: new Date().toISOString(),
  };

  await vscode.workspace.fs.writeFile(
    modelFileUri,
    new TextEncoder().encode(JSON.stringify(payload, null, 2))
  );
}

export async function resolveModelForStage(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): Promise<ResolvedStageModel> {
  if (!isConfigurableStage(stage)) {
    return { source: "none" };
  }

  const taskModels = await readTaskStageModels(taskFolderUri);
  const taskModel = taskModels[stage];
  if (taskModel) {
    return { modelId: taskModel, source: "task" };
  }

  const defaults = getAiModelDefaults();
  const workspaceModel = defaults[stage];
  if (workspaceModel) {
    return { modelId: workspaceModel, source: "workspace" };
  }

  return { source: "none" };
}

function isAutoModel(model: vscode.LanguageModelChat): boolean {
  return model.id.toLowerCase() === "auto" || model.name.toLowerCase() === "auto";
}

/**
 * A model the user can pick for a stage, from any provider. `id` is the
 * stored form: bare Copilot model IDs (legacy format) or provider-qualified
 * IDs like "claude-cli:sonnet" for subscription CLI providers.
 */
export interface SelectableModel {
  id: string;
  name: string;
  /** Display name of where the model runs, e.g. "GitHub Copilot". */
  providerLabel: string;
}

interface ModelSelectionTestOverrides {
  getAvailableCopilotModels?: typeof getAvailableCopilotModels;
  cliCommandExists?: typeof cliCommandExists;
  getDiscoveredCliModels?: (
    def: CliProviderDefinition
  ) => Promise<readonly DiscoveredCliModel[]>;
}

let modelSelectionTestOverrides: ModelSelectionTestOverrides | undefined;

function pushSelectableModel(
  target: SelectableModel[],
  seenIds: Set<string>,
  model: SelectableModel
): void {
  if (seenIds.has(model.id)) {
    return;
  }
  seenIds.add(model.id);
  target.push(model);
}

function normalizeCopilotModelName(model: vscode.LanguageModelChat): string {
  const id = model.id.toLowerCase();
  const name = model.name;
  const lowerName = name.toLowerCase();

  if (
    (lowerName.includes("claude") || id.includes("claude")) &&
    (lowerName.includes("fable") || id.includes("fable"))
  ) {
    return name.includes("(only on Pro+ plan)")
      ? name
      : `${name} (only on Pro+ plan)`;
  }

  if (
    (lowerName.includes("claude") || id.includes("claude")) &&
    (lowerName.includes("opus") || id.includes("opus"))
  ) {
    return name.includes("(only on Pro+ plan)")
      ? name
      : `${name} (only on Pro+ plan)`;
  }

  return name;
}

const SEEDED_CLI_MODELS: Readonly<
  Partial<Record<CliProviderId, readonly DiscoveredCliModel[]>>
> = {
  "claude-cli": [
    { model: "sonnet", name: "Sonnet 4.5" },
    { model: "haiku", name: "Haiku 4.5" },
    { model: "opus", name: "Opus 4.1 (only on Max plan)" },
    { model: "fable", name: "Fable 5 (only on Max plan)" },
  ],
  "codex-cli": [
    { model: "gpt-5.5", name: "GPT-5.5" },
    { model: "gpt-5.4", name: "GPT-5.4" },
    { model: "gpt-5.4-mini", name: "GPT-5.4-Mini" },
  ],
  "antigravity-cli": [
    { model: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
    { model: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)" },
    { model: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
    { model: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { model: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    {
      model: "claude-sonnet-4.6-thinking",
      name: "Claude Sonnet 4.6 (Thinking)",
    },
    {
      model: "claude-opus-4.6-thinking",
      name: "Claude Opus 4.6 (Thinking)",
    },
    { model: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  ],
  "kiro-cli": [
    { model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { model: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { model: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { model: "deepseek-3.2", name: "DeepSeek 3.2" },
    { model: "minimax-m2.5", name: "MiniMax M2.5" },
    { model: "minimax-m2.1", name: "MiniMax M2.1" },
    { model: "glm-5", name: "GLM-5" },
    { model: "qwen3-coder-next", name: "Qwen3 Coder Next" },
  ],
};

function createSeededCliModelCache(): Map<
  string,
  {
    models: readonly DiscoveredCliModel[];
    inFlight?: Promise<readonly DiscoveredCliModel[]>;
  }
> {
  return new Map(
    Object.entries(SEEDED_CLI_MODELS).map(([providerId, models]) => [
      providerId,
      { models: [...models] },
    ])
  );
}

const cliModelCache = new Map<
  string,
  {
    models: readonly DiscoveredCliModel[];
    inFlight?: Promise<readonly DiscoveredCliModel[]>;
  }
>();

for (const [providerId, entry] of createSeededCliModelCache()) {
  cliModelCache.set(providerId, entry);
}

function resetCliModelCache(): void {
  cliModelCache.clear();
}

function restoreSeededCliModelCache(): void {
  resetCliModelCache();
  for (const [providerId, entry] of createSeededCliModelCache()) {
    cliModelCache.set(providerId, entry);
  }
}

function queueCliModelRefresh(
  def: CliProviderDefinition
): Promise<readonly DiscoveredCliModel[]> {
  const cached = cliModelCache.get(def.id);
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const refresh = (async (): Promise<readonly DiscoveredCliModel[]> => {
    const resolvedCommand = await resolveCliCommand(
      def.command,
      def.commandAliases
    );
    if (!resolvedCommand) {
      const discovered: readonly DiscoveredCliModel[] = [];
      cliModelCache.set(def.id, {
        models: discovered,
      });
      return discovered;
    }

    const discovered = await discoverAgyModels(resolvedCommand);
    cliModelCache.set(def.id, {
      models: discovered,
    });
    return discovered;
  })();

  cliModelCache.set(def.id, {
    models: cached?.models ?? [],
    inFlight: refresh,
  });

  void refresh.finally(() => {
    const latest = cliModelCache.get(def.id);
    if (latest?.inFlight === refresh) {
      cliModelCache.set(def.id, {
        models: latest.models,
      });
    }
  });

  return refresh;
}

function getDiscoveredCliModels(
  def: CliProviderDefinition
): Promise<readonly DiscoveredCliModel[]> {
  const cached = cliModelCache.get(def.id);
  if (cached) {
    return Promise.resolve(cached.models);
  }
  return Promise.resolve([]);
}

export const __testOnly = {
  resetCliModelCache,
  primeCliModelCache(
    providerId: string,
    value: {
      models: readonly DiscoveredCliModel[];
      inFlight?: Promise<readonly DiscoveredCliModel[]>;
    }
  ): void {
    cliModelCache.set(providerId, value);
  },
  setModelSelectionTestOverrides(overrides: ModelSelectionTestOverrides): void {
    modelSelectionTestOverrides = overrides;
  },
  clearModelSelectionTestOverrides(): void {
    modelSelectionTestOverrides = undefined;
  },
  restoreSeededCliModelCache,
};

export async function warmCliModelCache(): Promise<void> {
  const refreshes: Promise<readonly DiscoveredCliModel[]>[] = [];
  for (const def of CLI_PROVIDERS) {
    if (def.id === "antigravity-cli") {
      refreshes.push(queueCliModelRefresh(def));
    }
  }
  await Promise.allSettled(refreshes);
}

export async function getAvailableCopilotModels(): Promise<
  vscode.LanguageModelChat[]
> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const autoIndex = models.findIndex(isAutoModel);
  if (autoIndex <= 0) {
    return models;
  }

  // Surface an "auto" model first so it reads as the default choice.
  const reordered = [...models];
  // autoIndex > 0 guarantees splice returns the removed element.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [autoModel] = reordered.splice(autoIndex, 1) as [vscode.LanguageModelChat];
  reordered.unshift(autoModel);
  return reordered;
}

/**
 * All models selectable for a stage: Copilot models from the LM API plus,
 * for each vendor CLI that is installed (Claude Code, Codex, Gemini,
 * Antigravity, Kiro), that provider's model choices. Copilot being
 * unavailable is not an error — CLI providers still work without it,
 * and vice versa.
 */
export async function getAvailableModels(): Promise<SelectableModel[]> {
  const result: SelectableModel[] = [];
  const seenIds = new Set<string>();
  const getCopilotModels =
    modelSelectionTestOverrides?.getAvailableCopilotModels ??
    getAvailableCopilotModels;
  const commandExists =
    modelSelectionTestOverrides?.cliCommandExists ?? cliCommandExists;
  const discoverCliModels =
    modelSelectionTestOverrides?.getDiscoveredCliModels ??
    getDiscoveredCliModels;

  try {
    const copilotModels = await getCopilotModels();
    for (const model of copilotModels) {
      pushSelectableModel(result, seenIds, {
        id: model.id,
        name: normalizeCopilotModelName(model),
        providerLabel: "GitHub Copilot",
      });
    }
  } catch {
    // Copilot not signed in / not installed — CLI providers may still work.
  }

  const availability = await Promise.all(
    CLI_PROVIDERS.map((def) =>
      commandExists(def.command, def.commandAliases)
    )
  );
  for (const [index, def] of CLI_PROVIDERS.entries()) {
    if (!availability[index]) {
      continue;
    }

    for (const choice of def.models) {
      pushSelectableModel(result, seenIds, {
        id: toQualifiedModelId(def.id, choice.model),
        name: choice.name,
        providerLabel: `${def.label} (subscription CLI)`,
      });
    }

    const discoveredChoices = await discoverCliModels(def);
    for (const choice of discoveredChoices) {
      pushSelectableModel(result, seenIds, {
        id: toQualifiedModelId(def.id, choice.model),
        name: choice.name,
        providerLabel: `${def.label} (subscription CLI)`,
      });
    }
  }

  return result;
}

export function describeModel(
  modelId: string | undefined,
  availableModels: readonly SelectableModel[]
): string {
  if (!modelId) {
    return "Default (prefers auto model)";
  }

  const model = availableModels.find((candidate) => candidate.id === modelId);
  if (model) {
    return `${model.name} (${model.id})`;
  }

  return `${modelId} (currently unavailable)`;
}
