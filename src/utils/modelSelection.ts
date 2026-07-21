import * as vscode from "vscode";
import {
  getAiModelDefaults,
  getModelSettings,
  isProviderEnabled,
} from "../config/settings";
import { getConfiguredTaskRoot } from "./taskRoot";
import { NotificationRouter } from "./notificationRouter";
import { canUseBackup, getBackupModels } from "./modelFallback";
import { cliCommandExists, resolveCliCommand } from "../runners/cliAgentRunner";
import {
  clearStageFallbackReservation,
  findAllTasks,
  patchTaskProgress,
  readTaskProgress,
} from "./taskProgressUtils";
import {
  CLI_PROVIDERS,
  type CliProviderId,
  type CliProviderDefinition,
  parseModelSelection,
  toQualifiedModelId,
} from "../runners/providers";
import { AI_MODEL_STAGES, REVIEW_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { type DiscoveredCliModel } from "./cliModelDiscovery";

export const TASK_MODEL_CONFIG_FILENAME = "task-models.json";

interface TaskModelSelectionFile {
  stageModels: Partial<Record<TaskStage, string>>;
  updatedAt: string;
}

export interface ResolvedStageModel {
  modelId?: string;
  source: "task" | "workspace" | "none";
}

interface ResolveStageModelOptions {
  ignoreActiveFallback?: boolean;
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

/** A task carrying a leftover per-task model override file (see below). */
export interface TaskModelConflict {
  taskFolderUri: vscode.Uri;
  folderName: string;
  stages: TaskStage[];
}

/**
 * Scan every discoverable task (active and paused) for a leftover per-task
 * model override file (`task-models.json`). Per-task overrides were removed
 * in favor of workspace-wide model configuration in the Settings panel —
 * `resolveModelForStage` above no longer reads this file at all — so a task
 * that still has one is a stale artifact from before that migration, not a
 * live override. The Settings panel surfaces this so the user can choose to
 * clear it (it's otherwise silently inert, which is confusing to find later)
 * rather than the extension silently ignoring files it once wrote.
 */
export async function findTaskModelConflicts(): Promise<TaskModelConflict[]> {
  const conflicts: TaskModelConflict[] = [];
  for (const ws of vscode.workspace.workspaceFolders ?? []) {
    const metaFolderUri = vscode.Uri.joinPath(ws.uri, getConfiguredTaskRoot());

    let tasks;
    try {
      tasks = await findAllTasks(metaFolderUri);
    } catch {
      continue;
    }

    for (const task of tasks) {
      // Completed tasks are done — a leftover per-task override there is not
      // a live conflict a user needs to resolve, so don't surface it.
      if (task.progress.status === "completed") {
        continue;
      }
      const stageModels = await readTaskStageModels(task.folderUri);
      const stages = Object.keys(stageModels) as TaskStage[];
      if (stages.length > 0) {
        conflicts.push({ taskFolderUri: task.folderUri, folderName: task.folderName, stages });
      }
    }
  }
  return conflicts;
}

/** Clear a task's leftover per-task model override for the given stages. */
export async function clearTaskStageModels(
  taskFolderUri: vscode.Uri,
  stages: readonly TaskStage[]
): Promise<void> {
  for (const stage of stages) {
    await setTaskStageModel(taskFolderUri, stage, undefined);
  }
}

export async function resolveModelForStage(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  options: ResolveStageModelOptions = {}
): Promise<ResolvedStageModel> {
  if (!isConfigurableStage(stage)) {
    return { source: "none" };
  }

  // Check new modelSettings first
  const modelSettings = getModelSettings();
  const stageSetting = modelSettings[stage];
  if (stageSetting?.primary) {
    if (!options.ignoreActiveFallback) {
      // If fallback is enabled, check if task progress has fallback active
      // for this stage.
      try {
        const progress = await readTaskProgress(taskFolderUri);
        if (
          progress &&
          progress.fallbackActive &&
          progress.fallbackActive[stage] &&
          canUseBackup(stageSetting)
        ) {
          const backupModels = getBackupModels(stageSetting);
          const activeFallbackModel = progress.fallbackModelId?.[stage];
          return {
            modelId:
              activeFallbackModel && backupModels.includes(activeFallbackModel)
                ? activeFallbackModel
                : backupModels[0],
            source: "workspace",
          };
        }
      } catch {
        // No persisted progress (or unreadable) — fall through to the primary model.
      }
    }
    return { modelId: stageSetting.primary, source: "workspace" };
  }

  const defaults = getAiModelDefaults();
  const workspaceModel = defaults[stage];
  if (workspaceModel) {
    return { modelId: workspaceModel, source: "workspace" };
  }

  return { source: "none" };
}

/**
 * Run-time guard for launching a stage: a stage with no configured model —
 * or whose configured model belongs to a provider that is currently
 * disabled in Provider Selection — must not run silently. Shows a warning
 * and opens the AI Models configuration instead. The stored model id is
 * never touched (disabled-provider selections are preserved byte-for-byte);
 * the stage is merely treated as unconfigured at run time.
 *
 * Returns true when the stage has a usable model and the caller may proceed.
 */
export async function ensureStageModelConfigured(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): Promise<boolean> {
  if (!isConfigurableStage(stage)) {
    return true;
  }
  const resolved = await resolveModelForStage(taskFolderUri, stage, {
    ignoreActiveFallback: true,
  });
  const stageName = STAGE_DISPLAY_NAMES[stage];
  if (!resolved.modelId) {
    // Copilot resolution can still pick a model automatically; only warn
    // when there is genuinely nothing configured AND no Copilot fallback.
    // resolveModelForStage returning source "none" means nothing configured.
    if (resolved.source === "none") {
      NotificationRouter.showWarning(
        `No AI model is configured for the ${stageName} stage. Configure one in AI Models.`
      );
      void vscode.commands.executeCommand("vs-code-ai-helper.openAiModels");
      return false;
    }
    return true;
  }
  const parsed = parseModelSelection(resolved.modelId);
  if (!isProviderEnabled(parsed.provider)) {
    NotificationRouter.showWarning(
      `The model configured for the ${stageName} stage (${resolved.modelId}) belongs to a disabled provider. ` +
        "Enable the provider or choose another model in AI Models."
    );
    void vscode.commands.executeCommand("vs-code-ai-helper.openAiModels");
    return false;
  }
  return true;
}

/**
 * A fresh user-invoked run should always retry the primary model first. Clear
 * any stale active fallback reservation from an earlier run, then resolve the
 * configured model without honoring fallbackActive for this lookup.
 */
export async function resolveFreshModelForStage(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): Promise<ResolvedStageModel> {
  if (isConfigurableStage(stage)) {
    try {
      const progress = await readTaskProgress(taskFolderUri);
      if (progress?.fallbackActive?.[stage]) {
        await patchTaskProgress(
          taskFolderUri,
          (current) => clearStageFallbackReservation(current, stage)
        );
      }
    } catch {
      // Ignore unreadable/missing progress; model resolution will fall back to
      // the configured primary below.
    }
  }

  return resolveModelForStage(taskFolderUri, stage, { ignoreActiveFallback: true });
}

/**
 * "plan-low-review" and "impl-low-review" are optional deep-dive reviews:
 * unlike the other review stages, auto-advance should skip straight past
 * them when no model is configured, rather than parking the task at a
 * review stage it has no way to act on. Other review stages (high-level
 * reviews, publish) are never skipped this way.
 *
 * Returns the set of review stages that auto-advance is allowed to land on
 * for this task — every review stage except an optional one with no
 * configured model — for use as `computeNextStage`'s `configuredStages`.
 */
const OPTIONAL_REVIEW_STAGES: readonly TaskStage[] = [
  "plan-low-review",
  "impl-low-review",
];

export async function resolveConfiguredReviewStages(
  taskFolderUri: vscode.Uri
): Promise<ReadonlySet<TaskStage>> {
  const configured = new Set<TaskStage>(REVIEW_STAGES);
  for (const stage of OPTIONAL_REVIEW_STAGES) {
    const resolved = await resolveModelForStage(taskFolderUri, stage);
    if (!resolved.modelId) {
      configured.delete(stage);
    }
  }
  return configured;
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
  return model.name;
}

const COPILOT_REASONING_LEVELS = {
  gpt: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "xhigh", label: "Extra High" },
  ],
  gpt56terra: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "xhigh", label: "Extra High" },
    { effort: "max", label: "Max" },
    { effort: "ultra", label: "Ultra" },
  ],
  gpt56luna: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "xhigh", label: "Extra High" },
    { effort: "max", label: "Max" },
  ],
  claude: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "xhigh", label: "Extra High" },
    { effort: "max", label: "Max" },
  ],
  claude46: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "max", label: "Max" },
  ],
  gemini: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
  ],
  gpt53: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "xhigh", label: "Extra High" },
  ],
  gpt54mini: [
    { effort: "low", label: "Low" },
    { effort: "medium", label: "Medium" },
    { effort: "high", label: "High" },
    { effort: "xhigh", label: "Extra High" },
  ],
} as const;

const COPILOT_MODEL_VARIANT_RULES: Readonly<
  Array<{
    slug: string;
    efforts: readonly { effort: string; label: string }[];
    longContext: boolean;
  }>
> = [
  { slug: "gpt-5.6-sol", efforts: COPILOT_REASONING_LEVELS.gpt56terra, longContext: true },
  { slug: "gpt-5.6-terra", efforts: COPILOT_REASONING_LEVELS.gpt56terra, longContext: true },
  { slug: "gpt-5.6-luna", efforts: COPILOT_REASONING_LEVELS.gpt56luna, longContext: true },
  { slug: "gpt-5.5", efforts: COPILOT_REASONING_LEVELS.gpt, longContext: true },
  { slug: "gpt-5.4", efforts: COPILOT_REASONING_LEVELS.gpt, longContext: true },
  { slug: "gpt-5.3-codex", efforts: COPILOT_REASONING_LEVELS.gpt53, longContext: false },
  { slug: "gpt-5.4-mini", efforts: COPILOT_REASONING_LEVELS.gpt54mini, longContext: false },
  { slug: "gpt-5-mini", efforts: COPILOT_REASONING_LEVELS.gpt53, longContext: false },
  { slug: "claude-sonnet-5", efforts: COPILOT_REASONING_LEVELS.claude, longContext: true },
  { slug: "claude-sonnet-4.6", efforts: COPILOT_REASONING_LEVELS.claude46, longContext: true },
  { slug: "claude-sonnet-4.5", efforts: [], longContext: false },
  { slug: "claude-haiku-4.5", efforts: [], longContext: false },
  { slug: "claude-fable-5", efforts: COPILOT_REASONING_LEVELS.claude, longContext: true },
  { slug: "claude-opus-4.8", efforts: COPILOT_REASONING_LEVELS.claude, longContext: true },
  { slug: "claude-opus-4.8-fast", efforts: COPILOT_REASONING_LEVELS.claude, longContext: true },
  { slug: "claude-opus-4.7", efforts: COPILOT_REASONING_LEVELS.claude, longContext: true },
  { slug: "gemini-3.1-pro", efforts: COPILOT_REASONING_LEVELS.gemini, longContext: true },
  { slug: "gemini-3.5-flash", efforts: COPILOT_REASONING_LEVELS.gemini, longContext: true },
  { slug: "kimi-k2.7-code", efforts: [], longContext: false },
  { slug: "mai-code-1-flash", efforts: COPILOT_REASONING_LEVELS.gpt53, longContext: false },
  { slug: "claude-opus-4.6", efforts: [], longContext: false },
  { slug: "claude-opus-4.5", efforts: [], longContext: false },
];

function createCopilotVariant(
  modelId: string,
  baseName: string,
  effort: string,
  effortLabel: string,
  longContext: boolean
): SelectableModel {
  return {
    id: `${modelId}@${effort}${longContext ? "+long" : ""}`,
    name: `${baseName} (${effortLabel}${longContext ? ", Long Context" : ""})`,
    providerLabel: "GitHub Copilot",
  };
}

function createSeededCopilotReasoningVariants(
  model: vscode.LanguageModelChat,
  baseName: string
): SelectableModel[] {
  const haystack = `${model.id} ${model.name}`.toLowerCase();
  // Pick the most specific (longest) matching slug rather than the first
  // one in array order, so e.g. "gpt-5.4-mini" doesn't shadow-match the
  // "gpt-5.4" rule just because it appears earlier in the list.
  let rule: (typeof COPILOT_MODEL_VARIANT_RULES)[number] | undefined;
  for (const candidate of COPILOT_MODEL_VARIANT_RULES) {
    if (
      haystack.includes(candidate.slug) &&
      (!rule || candidate.slug.length > rule.slug.length)
    ) {
      rule = candidate;
    }
  }
  if (!rule) {
    return [];
  }

  const variants: SelectableModel[] = [];
  for (const variant of rule.efforts) {
    variants.push(
      createCopilotVariant(model.id, baseName, variant.effort, variant.label, false)
    );
    if (rule.longContext) {
      variants.push(
        createCopilotVariant(
          model.id,
          baseName,
          variant.effort,
          variant.label,
          true
        )
      );
    }
  }
  return variants;
}

function createCodexReasoningVariant(
  model: string,
  label: string,
  effort: string,
  effortLabel: string
): DiscoveredCliModel {
  return {
    model: `${model}@${effort}`,
    name: `${label} (${effortLabel})`,
  };
}

function createCodexSpeedVariant(
  model: string,
  label: string,
  effort: string,
  effortLabel: string
): DiscoveredCliModel {
  return {
    model: `${model}@${effort}+fast`,
    name: `${label} (${effortLabel}, Fast)`,
  };
}

function createClaudeCliReasoningVariant(
  model: string,
  label: string,
  effort: string,
  effortLabel: string,
  availabilityNote?: string
): DiscoveredCliModel {
  return {
    model: `${model}@${effort}`,
    // Keep availability text at the end and in brackets. The settings search
    // intentionally ignores bracketed metadata, while the actual model name
    // and reasoning level remain searchable.
    name: `${label} (${effortLabel})${availabilityNote ? ` [${availabilityNote}]` : ""}`,
  };
}

function createSeededClaudeCliModels(): readonly DiscoveredCliModel[] {
  const createVariants = (
    model: string,
    label: string,
    efforts: readonly (readonly [string, string])[],
    availabilityNote?: string
  ): DiscoveredCliModel[] => {
    const variants: DiscoveredCliModel[] = [];
    for (const [effort, effortLabel] of efforts) {
      variants.push(
        createClaudeCliReasoningVariant(model, label, effort, effortLabel, availabilityNote)
      );
    }
    return variants;
  };

  return [
    { model: "sonnet", name: "Sonnet 5" },
    ...createVariants("sonnet", "Sonnet 5", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
    ]),
    { model: "fable", name: "Fable 5 [only on Max plan]" },
    ...createVariants("fable", "Fable 5", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
    ], "only on Max plan"),
    { model: "opus", name: "Opus 4.8" },
    ...createVariants("opus", "Opus 4.8", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
    ]),
    { model: "haiku", name: "Haiku 4.5" },
  ];
}

function createSeededCodexModels(): readonly DiscoveredCliModel[] {
  const createVariants = (
    model: string,
    label: string,
    efforts: readonly (readonly [string, string])[]
  ): DiscoveredCliModel[] => {
    const variants: DiscoveredCliModel[] = [];
    for (const [effort, effortLabel] of efforts) {
      variants.push(createCodexReasoningVariant(model, label, effort, effortLabel));
      variants.push(createCodexSpeedVariant(model, label, effort, effortLabel));
    }
    return variants;
  };

  return [
    ...createVariants("gpt-5.5", "GPT-5.5", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
    ]),
    ...createVariants("gpt-5.6-terra", "GPT-5.6-Terra", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
      ["ultra", "Ultra"],
    ]),
    ...createVariants("gpt-5.6-sol", "GPT-5.6-SOL", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
      ["ultra", "Ultra"],
    ]),
    ...createVariants("gpt-5.6-luna", "GPT-5.6-Luna", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
    ]),
    ...createVariants("gpt-5.4", "GPT-5.4", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
    ]),
    createCodexReasoningVariant("gpt-5.4-mini", "GPT-5.4-Mini", "low", "Low"),
    createCodexReasoningVariant(
      "gpt-5.4-mini",
      "GPT-5.4-Mini",
      "medium",
      "Medium"
    ),
    createCodexReasoningVariant("gpt-5.4-mini", "GPT-5.4-Mini", "high", "High"),
    createCodexReasoningVariant(
      "gpt-5.4-mini",
      "GPT-5.4-Mini",
      "xhigh",
      "Extra High"
    ),
  ];
}

const SEEDED_CLI_MODELS: Readonly<
  Partial<Record<CliProviderId, readonly DiscoveredCliModel[]>>
> = {
  "claude-cli": [
    ...createSeededClaudeCliModels(),
  ],
  "codex-cli": createSeededCodexModels(),
  // `model` must be the exact string `agy --model` accepts — Antigravity has
  // no separate slug/id form, its CLI takes the human display name verbatim
  // (verified live: `agy --model "Gemini 3.5 Flash (Medium)"` works, while a
  // slug like `gemini-3.5-flash-medium` fails with "invalid --model"). Keep
  // these in sync with `agy models`' own output — see cliModelDiscovery.ts.
  "antigravity-cli": [
    { model: "Gemini 3.5 Flash (Medium)", name: "Gemini 3.5 Flash (Medium)" },
    { model: "Gemini 3.5 Flash (High)", name: "Gemini 3.5 Flash (High)" },
    { model: "Gemini 3.5 Flash (Low)", name: "Gemini 3.5 Flash (Low)" },
    { model: "Gemini 3.1 Pro (Low)", name: "Gemini 3.1 Pro (Low)" },
    { model: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)" },
    {
      model: "Claude Sonnet 4.6 (Thinking)",
      name: "Claude Sonnet 4.6 (Thinking)",
    },
    {
      model: "Claude Opus 4.6 (Thinking)",
      name: "Claude Opus 4.6 (Thinking)",
    },
    { model: "GPT-OSS 120B (Medium)", name: "GPT-OSS 120B (Medium)" },
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

function resolveRefreshedCliModels(
  currentModels: readonly DiscoveredCliModel[],
  discoveredModels: readonly DiscoveredCliModel[]
): readonly DiscoveredCliModel[] {
  return discoveredModels.length > 0 ? discoveredModels : currentModels;
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
      const discovered = resolveRefreshedCliModels(cached?.models ?? [], []);
      cliModelCache.set(def.id, {
        models: discovered,
      });
      return discovered;
    }

    const discovered = resolveRefreshedCliModels(
      cached?.models ?? [],
      def.discoverModels ? await def.discoverModels(resolvedCommand) : []
    );
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
  resolveRefreshedCliModels,
};

export async function warmCliModelCache(): Promise<void> {
  const refreshes: Promise<readonly DiscoveredCliModel[]>[] = [];
  for (const def of CLI_PROVIDERS) {
    if (def.discoverModels) {
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
    // Copilot is part of the provider selection too: enabled by default,
    // but an explicit disable removes its models from every picker.
    const copilotModels = isProviderEnabled("copilot") ? await getCopilotModels() : [];
    for (const model of copilotModels) {
      const baseName = normalizeCopilotModelName(model);
      pushSelectableModel(result, seenIds, {
        id: model.id,
        name: baseName,
        providerLabel: "GitHub Copilot",
      });
      for (const variant of createSeededCopilotReasoningVariants(
        model,
        baseName
      )) {
        pushSelectableModel(result, seenIds, variant);
      }
    }
  } catch {
    // Copilot not signed in / not installed — CLI providers may still work.
  }

  const availability = await Promise.all(
    CLI_PROVIDERS.map((def) =>
      isProviderEnabled(def.id) && commandExists(def.command, def.commandAliases)
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
    return "Automatic (no explicit selection)";
  }

  const model = availableModels.find((candidate) => candidate.id === modelId);
  if (model) {
    return `${model.name} (${model.id})`;
  }

  return `${modelId} (currently unavailable)`;
}

export function getModelDisplayName(
  modelId: string | undefined,
  availableModels: readonly SelectableModel[]
): string {
  if (!modelId) {
    return "Automatic";
  }
  const model = availableModels.find((candidate) => candidate.id === modelId);
  if (model) {
    return model.name;
  }
  return modelId;
}

export function describeModelSource(
  source: "task" | "workspace" | "none"
): string {
  switch (source) {
    case "task":
      return "task override";
    case "workspace":
      return "workspace default";
    case "none":
      return "automatic selection";
  }
}

export function describeResolvedModel(
  resolved: ResolvedStageModel,
  availableModels: readonly SelectableModel[]
): string {
  const modelId = resolved.modelId;
  const source = resolved.source;

  let modelName = "Automatic (no explicit selection)";
  if (modelId) {
    const found = availableModels.find((m) => m.id === modelId);
    modelName = found ? `${found.name} (${modelId})` : `${modelId} (currently unavailable)`;
  }

  switch (source) {
    case "task":
      return `${modelName} (explicit task override)`;
    case "workspace":
      return `${modelName} (inherited workspace default)`;
    case "none":
      return "Automatic (no explicit selection)";
  }
}
