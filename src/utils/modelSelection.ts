import * as vscode from "vscode";
import {
  getAiModelDefaults,
  getModelSettings,
  isModelProviderEnabled,
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
  providerAccountIdForModelId,
  toQualifiedModelId,
} from "../runners/providers";
import { AI_MODEL_STAGES, REVIEW_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { parseOpencodeModelsOutput, type DiscoveredCliModel } from "./cliModelDiscovery";

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
  if (!isModelProviderEnabled(resolved.modelId)) {
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
  { slug: "claude-opus-5", efforts: COPILOT_REASONING_LEVELS.claude, longContext: true },
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
    { model: "fable", name: "Fable 5" },
    ...createVariants("fable", "Fable 5", [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["max", "Max"],
    ]),
    { model: "opus", name: "Opus 5" },
    ...createVariants("opus", "Opus 5", [
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

function createClineReasoningVariant(
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

/**
 * Curated ClinePass catalog snapshot (cline 3.0.46, captured 2026-07-23 from
 * the CLI's own bundled model catalog and cross-checked against
 * https://docs.cline.bot/getting-started/clinepass, which confirms the
 * `cline-pass/<model>` id prefix). No `cline models`-style listing
 * subcommand exists to discover this live the way opencode's does — see
 * cline-cli's absent discoverModels in providers.ts — so, like Claude's and
 * Codex's catalogs, this is a hand-curated static list rather than a parsed
 * live-CLI snapshot, and is expected to go stale as ClinePass's own catalog
 * changes.
 *
 * Cline's `--thinking` flag (none|low|medium|high|xhigh, verified live via
 * `cline --help` and a rejected `--thinking bogus` call) is ONE fixed ladder
 * applied uniformly to every model rather than opencode's per-model variant
 * sets, so — like Codex/Claude — each model gets a bare entry (provider
 * default reasoning) plus one variant per ladder rung, via
 * parseClineModelSelection's "model@effort" convention (providers.ts).
 *
 * "GLM-5.2 (Free)", "DeepSeek V4 Flash (Free)", "Step 3.7 Flash (Free)",
 * and "Laguna M.1 (Free)" are separate, differently-namespaced $0
 * promotional entries inside the SAME `cline-pass` catalog grouping (ids
 * "cline-free/glm-5.2", "deepseek/deepseek-v4-flash",
 * "stepfun/step-3.7-flash", "poolside/laguna-m.1:free"). Only
 * "deepseek/deepseek-v4-flash" was confirmed live (`-P cline-pass -m
 * deepseek/deepseek-v4-flash` answered correctly); the others follow the
 * identical id/invocation shape but were not individually exercised —
 * re-verify if any is reported broken. Kept separate from the price-listed
 * "DeepSeek V4 Flash" entry above rather than merged, since they are
 * distinct model ids that could disappear independently of the paid ones.
 */
function createSeededClineModels(): readonly DiscoveredCliModel[] {
  const CLINE_THINKING_LEVELS: readonly (readonly [string, string])[] = [
    ["none", "No Thinking"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra High"],
  ];

  const createModelWithVariants = (
    model: string,
    label: string
  ): DiscoveredCliModel[] => {
    const entries: DiscoveredCliModel[] = [{ model, name: label }];
    for (const [effort, effortLabel] of CLINE_THINKING_LEVELS) {
      entries.push(
        createClineReasoningVariant(model, label, effort, effortLabel)
      );
    }
    return entries;
  };

  return [
    ...createModelWithVariants("cline-pass/deepseek-v4-pro", "DeepSeek V4 Pro"),
    ...createModelWithVariants(
      "cline-pass/deepseek-v4-flash",
      "DeepSeek V4 Flash"
    ),
    ...createModelWithVariants("cline-pass/glm-5.2", "GLM-5.2"),
    ...createModelWithVariants("cline-free/glm-5.2", "GLM-5.2 (Free)"),
    ...createModelWithVariants(
      "cline-pass/kimi-k3",
      "Kimi K3 [may be unstable, higher usage]"
    ),
    ...createModelWithVariants(
      "cline-pass/kimi-k2.7-code",
      "Kimi K2.7 Code"
    ),
    ...createModelWithVariants("cline-pass/kimi-k2.6", "Kimi K2.6"),
    ...createModelWithVariants("cline-pass/mimo-v2.5-pro", "MiMo-V2.5-Pro"),
    ...createModelWithVariants("cline-pass/mimo-v2.5", "MiMo-V2.5"),
    ...createModelWithVariants("cline-pass/minimax-m3", "MiniMax-M3"),
    ...createModelWithVariants("cline-pass/qwen3.7-max", "Qwen3.7 Max"),
    ...createModelWithVariants("cline-pass/qwen3.7-plus", "Qwen3.7 Plus"),
    ...createModelWithVariants(
      "deepseek/deepseek-v4-flash",
      "DeepSeek V4 Flash (Free)"
    ),
    ...createModelWithVariants(
      "stepfun/step-3.7-flash",
      "Step 3.7 Flash (Free)"
    ),
    ...createModelWithVariants(
      "poolside/laguna-m.1:free",
      "Laguna M.1 (Free)"
    ),
  ];
}

/**
 * Raw `opencode models --verbose` catalog snapshot (opencode 1.18.4,
 * captured 2026-07-21, refreshed 2026-07-21 to add the "opencode-go" and
 * "github-copilot" provider tiers that appeared in the live catalog after
 * the first capture — the catalog is server-side and grows over time),
 * compacted to one minified JSON object per line (only the fields
 * parseOpencodeModelsOutput reads: id, providerID, name, variants —
 * cost/limit/capabilities/etc. are dropped, they're irrelevant to model
 * selection) and run through that SAME parser used for live discovery at
 * module load, rather than a hand-expanded array of {model, name} pairs.
 * This guarantees the seed and live discovery can never structurally
 * diverge — if parseOpencodeModelsOutput's variant-naming convention ever
 * changes, this seed picks up the change automatically instead of needing a
 * matching hand-edit elsewhere. Regenerate by piping a fresh `opencode
 * models --verbose` through the same id/providerID/name/variants compaction
 * when the catalog changes.
 */
const OPENCODE_SEEDED_CATALOG_RAW = `
opencode/big-pickle
{"id":"big-pickle","providerID":"opencode","name":"Big Pickle","variants":{}}
opencode/claude-fable-5
{"id":"claude-fable-5","providerID":"opencode","name":"Claude Fable 5","variants":{"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/claude-haiku-4-5
{"id":"claude-haiku-4-5","providerID":"opencode","name":"Claude Haiku 4.5","variants":{"high":{},"max":{}}}
opencode/claude-opus-4-1
{"id":"claude-opus-4-1","providerID":"opencode","name":"Claude Opus 4.1","variants":{"high":{},"max":{}}}
opencode/claude-opus-4-5
{"id":"claude-opus-4-5","providerID":"opencode","name":"Claude Opus 4.5","variants":{"low":{},"medium":{},"high":{}}}
opencode/claude-opus-4-6
{"id":"claude-opus-4-6","providerID":"opencode","name":"Claude Opus 4.6","variants":{"low":{},"medium":{},"high":{},"max":{}}}
opencode/claude-opus-4-7
{"id":"claude-opus-4-7","providerID":"opencode","name":"Claude Opus 4.7","variants":{"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/claude-opus-4-8
{"id":"claude-opus-4-8","providerID":"opencode","name":"Claude Opus 4.8","variants":{"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/claude-opus-5
{"id":"claude-opus-5","providerID":"opencode","name":"Claude Opus 5","variants":{"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/claude-sonnet-4
{"id":"claude-sonnet-4","providerID":"opencode","name":"Claude Sonnet 4","variants":{"high":{},"max":{}}}
opencode/claude-sonnet-4-5
{"id":"claude-sonnet-4-5","providerID":"opencode","name":"Claude Sonnet 4.5","variants":{"high":{},"max":{}}}
opencode/claude-sonnet-4-6
{"id":"claude-sonnet-4-6","providerID":"opencode","name":"Claude Sonnet 4.6","variants":{"low":{},"medium":{},"high":{},"max":{}}}
opencode/claude-sonnet-5
{"id":"claude-sonnet-5","providerID":"opencode","name":"Claude Sonnet 5","variants":{"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/deepseek-v4-flash
{"id":"deepseek-v4-flash","providerID":"opencode","name":"DeepSeek V4 Flash","variants":{"high":{},"max":{}}}
opencode/deepseek-v4-flash-free
{"id":"deepseek-v4-flash-free","providerID":"opencode","name":"DeepSeek V4 Flash Free","variants":{"high":{},"max":{}}}
opencode/deepseek-v4-pro
{"id":"deepseek-v4-pro","providerID":"opencode","name":"DeepSeek V4 Pro","variants":{"high":{},"max":{}}}
opencode/gemini-3-flash
{"id":"gemini-3-flash","providerID":"opencode","name":"Gemini 3 Flash","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
opencode/gemini-3.1-pro
{"id":"gemini-3.1-pro","providerID":"opencode","name":"Gemini 3.1 Pro Preview","variants":{"low":{},"medium":{},"high":{}}}
opencode/gemini-3.5-flash
{"id":"gemini-3.5-flash","providerID":"opencode","name":"Gemini 3.5 Flash","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
opencode/glm-5
{"id":"glm-5","providerID":"opencode","name":"GLM-5","variants":{}}
opencode/glm-5.1
{"id":"glm-5.1","providerID":"opencode","name":"GLM-5.1","variants":{}}
opencode/glm-5.2
{"id":"glm-5.2","providerID":"opencode","name":"GLM-5.2","variants":{"high":{},"max":{}}}
opencode/gpt-5
{"id":"gpt-5","providerID":"opencode","name":"GPT-5","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
opencode/gpt-5-codex
{"id":"gpt-5-codex","providerID":"opencode","name":"GPT-5 Codex","variants":{"low":{},"medium":{},"high":{}}}
opencode/gpt-5-nano
{"id":"gpt-5-nano","providerID":"opencode","name":"GPT-5 Nano","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
opencode/gpt-5.1
{"id":"gpt-5.1","providerID":"opencode","name":"GPT-5.1","variants":{"none":{},"low":{},"medium":{},"high":{}}}
opencode/gpt-5.1-codex
{"id":"gpt-5.1-codex","providerID":"opencode","name":"GPT-5.1 Codex","variants":{"low":{},"medium":{},"high":{}}}
opencode/gpt-5.1-codex-max
{"id":"gpt-5.1-codex-max","providerID":"opencode","name":"GPT-5.1 Codex Max","variants":{"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.1-codex-mini
{"id":"gpt-5.1-codex-mini","providerID":"opencode","name":"GPT-5.1 Codex Mini","variants":{"low":{},"medium":{},"high":{}}}
opencode/gpt-5.2
{"id":"gpt-5.2","providerID":"opencode","name":"GPT-5.2","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.2-codex
{"id":"gpt-5.2-codex","providerID":"opencode","name":"GPT-5.2 Codex","variants":{"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.3-codex
{"id":"gpt-5.3-codex","providerID":"opencode","name":"GPT-5.3 Codex","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.3-codex-spark
{"id":"gpt-5.3-codex-spark","providerID":"opencode","name":"GPT-5.3 Codex Spark","variants":{"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.4
{"id":"gpt-5.4","providerID":"opencode","name":"GPT-5.4","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.4-mini
{"id":"gpt-5.4-mini","providerID":"opencode","name":"GPT-5.4 Mini","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.4-nano
{"id":"gpt-5.4-nano","providerID":"opencode","name":"GPT-5.4 Nano","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.4-pro
{"id":"gpt-5.4-pro","providerID":"opencode","name":"GPT-5.4 Pro","variants":{"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.5
{"id":"gpt-5.5","providerID":"opencode","name":"GPT-5.5","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.5-pro
{"id":"gpt-5.5-pro","providerID":"opencode","name":"GPT-5.5 Pro","variants":{"medium":{},"high":{},"xhigh":{}}}
opencode/gpt-5.6-luna
{"id":"gpt-5.6-luna","providerID":"opencode","name":"GPT-5.6 Luna","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/gpt-5.6-sol
{"id":"gpt-5.6-sol","providerID":"opencode","name":"GPT-5.6 Sol","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/gpt-5.6-terra
{"id":"gpt-5.6-terra","providerID":"opencode","name":"GPT-5.6 Terra","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
opencode/grok-4.5
{"id":"grok-4.5","providerID":"opencode","name":"Grok 4.5","variants":{"low":{},"medium":{},"high":{}}}
opencode/grok-build-0.1
{"id":"grok-build-0.1","providerID":"opencode","name":"Grok Build 0.1","variants":{}}
opencode/kimi-k2.5
{"id":"kimi-k2.5","providerID":"opencode","name":"Kimi K2.5","variants":{}}
opencode/kimi-k2.6
{"id":"kimi-k2.6","providerID":"opencode","name":"Kimi K2.6","variants":{}}
opencode/kimi-k2.7-code
{"id":"kimi-k2.7-code","providerID":"opencode","name":"Kimi K2.7 Code","variants":{}}
opencode/mimo-v2.5-free
{"id":"mimo-v2.5-free","providerID":"opencode","name":"MiMo V2.5 Free","variants":{}}
opencode/minimax-m2.5
{"id":"minimax-m2.5","providerID":"opencode","name":"MiniMax-M2.5","variants":{}}
opencode/minimax-m2.7
{"id":"minimax-m2.7","providerID":"opencode","name":"MiniMax-M2.7","variants":{}}
opencode/minimax-m3
{"id":"minimax-m3","providerID":"opencode","name":"MiniMax-M3","variants":{}}
opencode/nemotron-3-ultra-free
{"id":"nemotron-3-ultra-free","providerID":"opencode","name":"Nemotron 3 Ultra Free","variants":{}}
opencode/north-mini-code-free
{"id":"north-mini-code-free","providerID":"opencode","name":"North Mini Code Free","variants":{"none":{},"high":{}}}
opencode/qwen3.5-plus
{"id":"qwen3.5-plus","providerID":"opencode","name":"Qwen3.5 Plus","variants":{"high":{},"max":{}}}
opencode/qwen3.6-plus
{"id":"qwen3.6-plus","providerID":"opencode","name":"Qwen3.6 Plus","variants":{"high":{},"max":{}}}
opencode-go/deepseek-v4-flash
{"id":"deepseek-v4-flash","providerID":"opencode-go","name":"DeepSeek V4 Flash","variants":{"high":{},"max":{}}}
opencode-go/deepseek-v4-pro
{"id":"deepseek-v4-pro","providerID":"opencode-go","name":"DeepSeek V4 Pro","variants":{"high":{},"max":{}}}
opencode-go/glm-5.1
{"id":"glm-5.1","providerID":"opencode-go","name":"GLM-5.1","variants":{}}
opencode-go/glm-5.2
{"id":"glm-5.2","providerID":"opencode-go","name":"GLM-5.2","variants":{"high":{},"max":{}}}
opencode-go/grok-4.5
{"id":"grok-4.5","providerID":"opencode-go","name":"Grok 4.5","variants":{"low":{},"medium":{},"high":{}}}
opencode-go/kimi-k2.6
{"id":"kimi-k2.6","providerID":"opencode-go","name":"Kimi K2.6","variants":{}}
opencode-go/kimi-k2.7-code
{"id":"kimi-k2.7-code","providerID":"opencode-go","name":"Kimi K2.7 Code","variants":{}}
opencode-go/kimi-k3
{"id":"kimi-k3","providerID":"opencode-go","name":"Kimi K3 (2x usage)","variants":{"max":{}}}
opencode-go/mimo-v2.5
{"id":"mimo-v2.5","providerID":"opencode-go","name":"MiMo V2.5","variants":{}}
opencode-go/mimo-v2.5-pro
{"id":"mimo-v2.5-pro","providerID":"opencode-go","name":"MiMo V2.5 Pro","variants":{}}
opencode-go/minimax-m2.7
{"id":"minimax-m2.7","providerID":"opencode-go","name":"MiniMax-M2.7","variants":{}}
opencode-go/minimax-m3
{"id":"minimax-m3","providerID":"opencode-go","name":"MiniMax-M3","variants":{"none":{},"thinking":{}}}
opencode-go/qwen3.6-plus
{"id":"qwen3.6-plus","providerID":"opencode-go","name":"Qwen3.6 Plus","variants":{"high":{},"max":{}}}
opencode-go/qwen3.7-max
{"id":"qwen3.7-max","providerID":"opencode-go","name":"Qwen3.7 Max","variants":{"high":{},"max":{}}}
opencode-go/qwen3.7-plus
{"id":"qwen3.7-plus","providerID":"opencode-go","name":"Qwen3.7 Plus","variants":{"high":{},"max":{}}}
github-copilot/claude-haiku-4.5
{"id":"claude-haiku-4.5","providerID":"github-copilot","name":"Claude Haiku 4.5 (latest)","variants":{"max":{},"high":{}}}
github-copilot/claude-sonnet-4.5
{"id":"claude-sonnet-4.5","providerID":"github-copilot","name":"Claude Sonnet 4.5 (latest)","variants":{"max":{},"high":{}}}
github-copilot/claude-sonnet-4.6
{"id":"claude-sonnet-4.6","providerID":"github-copilot","name":"Claude Sonnet 4.6","variants":{"low":{},"medium":{},"high":{},"max":{}}}
github-copilot/claude-sonnet-5
{"id":"claude-sonnet-5","providerID":"github-copilot","name":"Claude Sonnet 5","variants":{"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
github-copilot/gemini-2.5-pro
{"id":"gemini-2.5-pro","providerID":"github-copilot","name":"Gemini 2.5 Pro","variants":{"max":{},"high":{}}}
github-copilot/gemini-3-flash-preview
{"id":"gemini-3-flash-preview","providerID":"github-copilot","name":"Gemini 3 Flash Preview","variants":{"low":{},"medium":{},"high":{}}}
github-copilot/gemini-3.1-pro-preview
{"id":"gemini-3.1-pro-preview","providerID":"github-copilot","name":"Gemini 3.1 Pro Preview","variants":{"low":{},"medium":{},"high":{}}}
github-copilot/gemini-3.5-flash
{"id":"gemini-3.5-flash","providerID":"github-copilot","name":"Gemini 3.5 Flash","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
github-copilot/gpt-5-mini
{"id":"gpt-5-mini","providerID":"github-copilot","name":"GPT-5 Mini","variants":{"low":{},"medium":{},"high":{}}}
github-copilot/gpt-5.3-codex
{"id":"gpt-5.3-codex","providerID":"github-copilot","name":"GPT-5.3 Codex","variants":{"low":{},"medium":{},"high":{},"xhigh":{}}}
github-copilot/gpt-5.4
{"id":"gpt-5.4","providerID":"github-copilot","name":"GPT-5.4","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
github-copilot/gpt-5.4-mini
{"id":"gpt-5.4-mini","providerID":"github-copilot","name":"GPT-5.4 mini","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
github-copilot/gpt-5.6-luna
{"id":"gpt-5.6-luna","providerID":"github-copilot","name":"GPT-5.6 Luna","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
github-copilot/gpt-5.6-terra
{"id":"gpt-5.6-terra","providerID":"github-copilot","name":"GPT-5.6 Terra","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
github-copilot/kimi-k2.7-code
{"id":"kimi-k2.7-code","providerID":"github-copilot","name":"Kimi K2.7 Code","variants":{}}
github-copilot/mai-code-1-flash-picker
{"id":"mai-code-1-flash-picker","providerID":"github-copilot","name":"MAI-Code-1-Flash","variants":{"low":{},"medium":{},"high":{}}}
openai/chatgpt-image-latest
{"id":"chatgpt-image-latest","providerID":"openai","name":"chatgpt-image-latest","variants":{}}
openai/gpt-3.5-turbo
{"id":"gpt-3.5-turbo","providerID":"openai","name":"GPT-3.5-turbo","variants":{}}
openai/gpt-4
{"id":"gpt-4","providerID":"openai","name":"GPT-4","variants":{}}
openai/gpt-4-turbo
{"id":"gpt-4-turbo","providerID":"openai","name":"GPT-4 Turbo","variants":{}}
openai/gpt-4.1
{"id":"gpt-4.1","providerID":"openai","name":"GPT-4.1","variants":{}}
openai/gpt-4.1-mini
{"id":"gpt-4.1-mini","providerID":"openai","name":"GPT-4.1 mini","variants":{}}
openai/gpt-4.1-nano
{"id":"gpt-4.1-nano","providerID":"openai","name":"GPT-4.1 nano","variants":{}}
openai/gpt-4o
{"id":"gpt-4o","providerID":"openai","name":"GPT-4o","variants":{}}
openai/gpt-4o-2024-05-13
{"id":"gpt-4o-2024-05-13","providerID":"openai","name":"GPT-4o (2024-05-13)","variants":{}}
openai/gpt-4o-2024-08-06
{"id":"gpt-4o-2024-08-06","providerID":"openai","name":"GPT-4o (2024-08-06)","variants":{}}
openai/gpt-4o-2024-11-20
{"id":"gpt-4o-2024-11-20","providerID":"openai","name":"GPT-4o (2024-11-20)","variants":{}}
openai/gpt-4o-mini
{"id":"gpt-4o-mini","providerID":"openai","name":"GPT-4o mini","variants":{}}
openai/gpt-5
{"id":"gpt-5","providerID":"openai","name":"GPT-5","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
openai/gpt-5-codex
{"id":"gpt-5-codex","providerID":"openai","name":"GPT-5-Codex","variants":{"low":{},"medium":{},"high":{}}}
openai/gpt-5-mini
{"id":"gpt-5-mini","providerID":"openai","name":"GPT-5 Mini","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
openai/gpt-5-nano
{"id":"gpt-5-nano","providerID":"openai","name":"GPT-5 Nano","variants":{"minimal":{},"low":{},"medium":{},"high":{}}}
openai/gpt-5-pro
{"id":"gpt-5-pro","providerID":"openai","name":"GPT-5 Pro","variants":{"high":{}}}
openai/gpt-5.1
{"id":"gpt-5.1","providerID":"openai","name":"GPT-5.1","variants":{"none":{},"low":{},"medium":{},"high":{}}}
openai/gpt-5.1-chat-latest
{"id":"gpt-5.1-chat-latest","providerID":"openai","name":"GPT-5.1 Chat","variants":{"medium":{}}}
openai/gpt-5.1-codex
{"id":"gpt-5.1-codex","providerID":"openai","name":"GPT-5.1 Codex","variants":{"low":{},"medium":{},"high":{}}}
openai/gpt-5.1-codex-max
{"id":"gpt-5.1-codex-max","providerID":"openai","name":"GPT-5.1 Codex Max","variants":{"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.1-codex-mini
{"id":"gpt-5.1-codex-mini","providerID":"openai","name":"GPT-5.1 Codex mini","variants":{"low":{},"medium":{},"high":{}}}
openai/gpt-5.2
{"id":"gpt-5.2","providerID":"openai","name":"GPT-5.2","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.2-chat-latest
{"id":"gpt-5.2-chat-latest","providerID":"openai","name":"GPT-5.2 Chat","variants":{"medium":{}}}
openai/gpt-5.2-codex
{"id":"gpt-5.2-codex","providerID":"openai","name":"GPT-5.2 Codex","variants":{"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.2-pro
{"id":"gpt-5.2-pro","providerID":"openai","name":"GPT-5.2 Pro","variants":{"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.3-chat-latest
{"id":"gpt-5.3-chat-latest","providerID":"openai","name":"GPT-5.3 Chat (latest)","variants":{}}
openai/gpt-5.3-codex
{"id":"gpt-5.3-codex","providerID":"openai","name":"GPT-5.3 Codex","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.3-codex-spark
{"id":"gpt-5.3-codex-spark","providerID":"openai","name":"GPT-5.3 Codex Spark","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.4
{"id":"gpt-5.4","providerID":"openai","name":"GPT-5.4","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.4-fast
{"id":"gpt-5.4-fast","providerID":"openai","name":"GPT-5.4 Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.4-mini
{"id":"gpt-5.4-mini","providerID":"openai","name":"GPT-5.4 mini","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.4-mini-fast
{"id":"gpt-5.4-mini-fast","providerID":"openai","name":"GPT-5.4 mini Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.4-nano
{"id":"gpt-5.4-nano","providerID":"openai","name":"GPT-5.4 nano","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.4-pro
{"id":"gpt-5.4-pro","providerID":"openai","name":"GPT-5.4 Pro","variants":{"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.5
{"id":"gpt-5.5","providerID":"openai","name":"GPT-5.5","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.5-fast
{"id":"gpt-5.5-fast","providerID":"openai","name":"GPT-5.5 Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.5-pro
{"id":"gpt-5.5-pro","providerID":"openai","name":"GPT-5.5 Pro","variants":{"medium":{},"high":{},"xhigh":{}}}
openai/gpt-5.6
{"id":"gpt-5.6","providerID":"openai","name":"GPT-5.6","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-fast
{"id":"gpt-5.6-fast","providerID":"openai","name":"GPT-5.6 Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-luna
{"id":"gpt-5.6-luna","providerID":"openai","name":"GPT-5.6 Luna","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-luna-fast
{"id":"gpt-5.6-luna-fast","providerID":"openai","name":"GPT-5.6 Luna Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-luna-pro
{"id":"gpt-5.6-luna-pro","providerID":"openai","name":"GPT-5.6 Luna Pro","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-pro
{"id":"gpt-5.6-pro","providerID":"openai","name":"GPT-5.6 Pro","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-sol
{"id":"gpt-5.6-sol","providerID":"openai","name":"GPT-5.6 Sol","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-sol-fast
{"id":"gpt-5.6-sol-fast","providerID":"openai","name":"GPT-5.6 Sol Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-sol-pro
{"id":"gpt-5.6-sol-pro","providerID":"openai","name":"GPT-5.6 Sol Pro","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-terra
{"id":"gpt-5.6-terra","providerID":"openai","name":"GPT-5.6 Terra","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-terra-fast
{"id":"gpt-5.6-terra-fast","providerID":"openai","name":"GPT-5.6 Terra Fast","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-5.6-terra-pro
{"id":"gpt-5.6-terra-pro","providerID":"openai","name":"GPT-5.6 Terra Pro","variants":{"none":{},"low":{},"medium":{},"high":{},"xhigh":{},"max":{}}}
openai/gpt-image-1
{"id":"gpt-image-1","providerID":"openai","name":"gpt-image-1","variants":{}}
openai/gpt-image-1-mini
{"id":"gpt-image-1-mini","providerID":"openai","name":"gpt-image-1-mini","variants":{}}
openai/gpt-image-1.5
{"id":"gpt-image-1.5","providerID":"openai","name":"gpt-image-1.5","variants":{}}
openai/gpt-image-2
{"id":"gpt-image-2","providerID":"openai","name":"gpt-image-2","variants":{}}
openai/gpt-realtime-2.1
{"id":"gpt-realtime-2.1","providerID":"openai","name":"GPT-Realtime-2.1","variants":{"minimal":{},"low":{},"medium":{},"high":{},"xhigh":{}}}
openai/o1
{"id":"o1","providerID":"openai","name":"o1","variants":{"low":{},"medium":{},"high":{}}}
openai/o1-pro
{"id":"o1-pro","providerID":"openai","name":"o1-pro","variants":{"low":{},"medium":{},"high":{}}}
openai/o3
{"id":"o3","providerID":"openai","name":"o3","variants":{"low":{},"medium":{},"high":{}}}
openai/o3-deep-research
{"id":"o3-deep-research","providerID":"openai","name":"o3-deep-research","variants":{"medium":{}}}
openai/o3-mini
{"id":"o3-mini","providerID":"openai","name":"o3-mini","variants":{"low":{},"medium":{},"high":{}}}
openai/o3-pro
{"id":"o3-pro","providerID":"openai","name":"o3-pro","variants":{"low":{},"medium":{},"high":{}}}
openai/o4-mini
{"id":"o4-mini","providerID":"openai","name":"o4-mini","variants":{"low":{},"medium":{},"high":{}}}
openai/o4-mini-deep-research
{"id":"o4-mini-deep-research","providerID":"openai","name":"o4-mini-deep-research","variants":{"medium":{}}}
openai/text-embedding-3-large
{"id":"text-embedding-3-large","providerID":"openai","name":"text-embedding-3-large","variants":{}}
openai/text-embedding-3-small
{"id":"text-embedding-3-small","providerID":"openai","name":"text-embedding-3-small","variants":{}}
openai/text-embedding-ada-002
{"id":"text-embedding-ada-002","providerID":"openai","name":"text-embedding-ada-002","variants":{}}
`;

function createSeededOpencodeModels(): readonly DiscoveredCliModel[] {
  return parseOpencodeModelsOutput(OPENCODE_SEEDED_CATALOG_RAW);
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
    { model: "Gemini 3.6 Flash (Low)", name: "Gemini 3.6 Flash (Low)" },
    { model: "Gemini 3.6 Flash (Medium)", name: "Gemini 3.6 Flash (Medium)" },
    { model: "Gemini 3.6 Flash (High)", name: "Gemini 3.6 Flash (High)" },
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
  // Snapshot of `opencode models --verbose`'s full catalog (opencode 1.18.4,
  // captured 2026-07-21), including each model's own reasoning-effort
  // variants expanded to "<provider>/<model>@<variant>" entries — see
  // parseOpencodeModelsOutput in cliModelDiscovery.ts, which produces this
  // exact same shape from a live CLI call. This is a MUCH larger catalog
  // than Claude's/Codex's curated lists (466 entries vs ~2 base models)
  // because opencode proxies dozens of upstream providers rather than
  // exposing one vendor's own lineup, and it goes stale as models.dev's
  // catalog changes — unlike the small hand-curated lists above, this block
  // is meant to be regenerated wholesale, not hand-edited entry-by-entry.
  // Regenerate by running `opencode models --verbose` through
  // discoverOpencodeModelsWithTimeout and re-pasting its output here.
  "opencode-cli": createSeededOpencodeModels(),
  "cline-cli": createSeededClineModels(),
  // Snapshot of `kimi provider list --json`'s "models" map (kimi-code
  // 0.29.2, captured 2026-07-27 against the managed `kimi-code` OAuth
  // provider) — see parseKimiModelsOutput in cliModelDiscovery.ts, which
  // produces this exact same shape from a live CLI call. K2.7 Coding /
  // K2.7 Coding Highspeed have no reasoning-effort ladder (always-on
  // thinking); K3 / K3-256k support low/high/max but that per-invocation
  // choice isn't wired up here — see the models comment in providers.ts.
  "kimi-cli": [
    { model: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
    {
      model: "kimi-code/kimi-for-coding-highspeed",
      name: "K2.7 Coding Highspeed",
    },
    { model: "kimi-code/k3-256k", name: "K3-256k" },
    { model: "kimi-code/k3", name: "K3" },
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

/** Label a CLI model by the service that will actually authorize and bill it. */
function modelProviderLabel(
  def: CliProviderDefinition,
  model: string | undefined
): string {
  if (def.id === "opencode-cli") {
    return providerAccountIdForModelId(toQualifiedModelId(def.id, model)) === "opencode-go"
      ? "OpenCode Go (shared OpenCode account; subscription)"
      : "OpenCode Zen (shared OpenCode account; pay as you go)";
  }
  return `${def.label} (subscription CLI)`;
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
    CLI_PROVIDERS.map((def) => {
      const enabled =
        def.id === "opencode-cli"
          ? isProviderEnabled("opencode-zen") || isProviderEnabled("opencode-go")
          : isProviderEnabled(def.id);
      return enabled && commandExists(def.command, def.commandAliases);
    })
  );
  for (const [index, def] of CLI_PROVIDERS.entries()) {
    if (!availability[index]) {
      continue;
    }

    for (const choice of def.models) {
      const id = toQualifiedModelId(def.id, choice.model);
      // OpenCode CLI can also list external upstream providers such as
      // `openai/...` and `github-copilot/...`. This integration deliberately
      // offers only its two explicit OpenCode services, Zen and Go; exposing
      // those external namespaces under the Zen checkbox would misstate both
      // the required credentials and billing route.
      if (
        def.id === "opencode-cli" &&
        providerAccountIdForModelId(id) === "opencode-cli"
      ) {
        continue;
      }
      if (!isModelProviderEnabled(id)) {
        continue;
      }
      pushSelectableModel(result, seenIds, {
        id,
        name: choice.name,
        providerLabel: modelProviderLabel(def, choice.model),
      });
    }

    const discoveredChoices = await discoverCliModels(def);
    for (const choice of discoveredChoices) {
      const id = toQualifiedModelId(def.id, choice.model);
      if (
        def.id === "opencode-cli" &&
        providerAccountIdForModelId(id) === "opencode-cli"
      ) {
        continue;
      }
      if (!isModelProviderEnabled(id)) {
        continue;
      }
      pushSelectableModel(result, seenIds, {
        id,
        name: choice.name,
        providerLabel: modelProviderLabel(def, choice.model),
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

