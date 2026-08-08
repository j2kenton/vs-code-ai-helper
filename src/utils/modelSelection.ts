import * as vscode from "vscode";
import {
  getModelSettings,
  isModelProviderEnabled,
  isProviderEnabled,
} from "../config/settings";
import { getConfiguredTaskRoot } from "./taskRoot";
import { NotificationRouter } from "./notificationRouter";
import { type FallbackStrategy, type StageModelSetting } from "./modelFallback";
import { cliCommandExists, resolveCliCommand } from "../runners/cliAgentRunner";
import { findAllTasksStrictV1 } from "../services/taskProgressDiscoveryV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { clearStageFallbackReservation } from "./taskProgressTransforms";
import {
  CLI_PROVIDERS,
  type CliProviderId,
  type CliProviderDefinition,
  providerAccountIdForModelId,
  toQualifiedModelId,
} from "../runners/providers";
import { AI_MODEL_STAGES, REVIEW_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  parseKimiModelsOutput,
  parseOpencodeModelsOutput,
  type DiscoveredCliModel,
} from "./cliModelDiscovery";

export const TASK_MODEL_CONFIG_FILENAME = "task-models.json";

interface TaskModelSelectionFile {
  stageModels: Partial<Record<TaskStage, string>>;
  updatedAt: string;
}

export interface ResolvedStageModel {
  modelId?: string;
  /** "general" = resolved through the general model's chain because the
   * stage itself has no (enabled) model of its own. */
  source: "task" | "workspace" | "general" | "none";
}

/**
 * The stage whose configured chain doubles as the general model (§2 of the
 * AI Models rework): "desc" heads the AI Models list, is used for the Global
 * Assistant and task-description processing, and is the default for any
 * stage with no model of its own.
 */
export const GENERAL_MODEL_STAGE: TaskStage = "desc";

export type EffectiveChainSourceV1 = "stage" | "general" | "none";

/** The effective, skip-filtered model chain a stage resolves to. */
export interface EffectiveStageChainV1 {
  /** Stage whose configured chain actually supplies the models
   * (=== the requested stage unless source is "general"). */
  originStage: TaskStage;
  source: EffectiveChainSourceV1;
  primary?: string;
  backups: string[];
  strategy?: FallbackStrategy;
}

/**
 * Skip-filtered view of one stage's OWN configured chain: backups whose
 * `backupsEnabled` flag is false are dropped, and a skipped (or absent)
 * primary promotes the first enabled backup into the effective primary slot
 * with the rest kept in order.
 */
function skipFilteredChainOf(
  setting: StageModelSetting | undefined
): { primary?: string; backups: string[] } {
  if (!setting) {
    return { backups: [] };
  }
  const configured =
    Array.isArray(setting.backups) && setting.backups.length > 0
      ? setting.backups
      : setting.backup
        ? [setting.backup]
        : [];
  const flags = setting.backupsEnabled;
  const seen = new Set<string>();
  let backups: string[] = [];
  configured.forEach((model, index) => {
    if (typeof model !== "string" || model.trim().length === 0) {
      return;
    }
    if (flags && flags[index] === false) {
      return;
    }
    const trimmed = model.trim();
    if (seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    backups.push(trimmed);
  });
  let primary = setting.primaryEnabled === false ? undefined : setting.primary;
  if (!primary && backups.length > 0) {
    primary = backups[0];
    backups = backups.slice(1);
  }
  return { primary, backups: backups.filter((model) => model !== primary) };
}

/**
 * The single, central resolver for "which model chain does this stage
 * actually run with". Synchronous and settings-only: it reads exclusively
 * from getModelSettings() output (which already folds in the legacy
 * `aiModelDefaults` import for stages with no explicit entry) and never
 * consults per-task state.
 *
 * Tier order:
 *  1. the stage's own skip-filtered chain (`source: "stage"`);
 *  2. the general model's chain, itself skip-filtered, with the general
 *     chain's backups and strategy (`source: "general"`, `originStage`
 *     = GENERAL_MODEL_STAGE) — so a blank, cleared, or fully-skipped stage
 *     is never silently unresolvable;
 *  3. nothing configured anywhere (`source: "none"`).
 *
 * Skip filtering lives ONLY here (and in the identical per-stage helper
 * above): `getBackupModels` in modelFallback.ts stays raw, and
 * provider-disabled filtering (`filterEnabledBackupModels`) stays layered on
 * top by callers.
 */
export function resolveEffectiveStageChainV1(stage: TaskStage): EffectiveStageChainV1 {
  const settings = getModelSettings();
  const own = skipFilteredChainOf(settings[stage]);
  if (own.primary) {
    return {
      originStage: stage,
      source: "stage",
      primary: own.primary,
      backups: own.backups,
      strategy: settings[stage]?.strategy,
    };
  }
  if (stage !== GENERAL_MODEL_STAGE) {
    const general = skipFilteredChainOf(settings[GENERAL_MODEL_STAGE]);
    if (general.primary) {
      return {
        originStage: GENERAL_MODEL_STAGE,
        source: "general",
        primary: general.primary,
        backups: general.backups,
        strategy: settings[GENERAL_MODEL_STAGE]?.strategy,
      };
    }
  }
  return { originStage: stage, source: "none", backups: [] };
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

/**
 * Filename of the per-task resolved-model-config snapshot written once at
 * task kickoff (plan §23/5a). Unlike task-models.json (a live per-task
 * override input, now vestigial), this is a write-once historical record:
 * model settings are global and mutable, so without a snapshot a completed
 * task's folder cannot show which models actually ran it days or weeks
 * later, after workspace settings have moved on.
 */
export const RESOLVED_MODEL_SNAPSHOT_FILENAME = "task-models.resolved.json";

/** One stage's resolved model configuration at the moment a task was created. */
export interface ResolvedModelSnapshotStage {
  primary?: string;
  backups: string[];
  strategy: FallbackStrategy;
  /** "workspace" = the stage's own configured chain; "general" = inherited
   * from the general model's chain; "none" = nothing configured anywhere. */
  source: "workspace" | "general" | "none";
  /** Stage whose configured chain supplied the models (differs from the
   * stage key only when source is "general"). */
  originStage?: TaskStage;
}

export interface ResolvedModelSnapshotV1 {
  schemaVersion: 1;
  resolvedAt: string;
  stages: Partial<Record<TaskStage, ResolvedModelSnapshotStage>>;
}

/**
 * Snapshot the workspace's current model configuration for every
 * configurable stage. Records the EFFECTIVE chain from
 * resolveEffectiveStageChainV1 (skip-filtered, general-model fallback
 * applied) plus its provenance (`source`/`originStage`), ignoring any
 * in-progress fallback state — this is kickoff provenance, not a live
 * resolution.
 *
 * schemaVersion stays 1: the new fields are purely additive and nothing in
 * the codebase reads snapshot contents back (only the filename is referenced,
 * by the workflow privacy classifier), so old snapshots remain valid and new
 * ones cannot break a reader.
 */
export function buildResolvedModelSnapshotV1(): ResolvedModelSnapshotV1 {
  const stages: ResolvedModelSnapshotV1["stages"] = {};
  for (const stage of AI_MODEL_STAGES) {
    const chain = resolveEffectiveStageChainV1(stage);
    if (chain.source === "none") {
      stages[stage] = { backups: [], strategy: "alert-and-wait", source: "none" };
      continue;
    }
    stages[stage] = {
      primary: chain.primary,
      backups: chain.backups,
      strategy: chain.strategy ?? "alert-and-wait",
      source: chain.source === "general" ? "general" : "workspace",
      originStage: chain.originStage,
    };
  }
  return { schemaVersion: 1, resolvedAt: new Date().toISOString(), stages };
}

/**
 * Write the resolved-model snapshot into a task folder. Called once at
 * kickoff (startNewTask.ts); best-effort by design — a snapshot failure must
 * never block task creation, which has already succeeded by the time this
 * runs.
 */
export async function writeResolvedModelSnapshotV1(taskFolderUri: vscode.Uri): Promise<void> {
  const snapshot = buildResolvedModelSnapshotV1();
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(taskFolderUri, RESOLVED_MODEL_SNAPSHOT_FILENAME),
    new TextEncoder().encode(JSON.stringify(snapshot, null, 2) + "\n")
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
      tasks = (await findAllTasksStrictV1(metaFolderUri)).tasks;
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

  // The effective chain (the stage's own skip-filtered chain, else the
  // general model's) is the single source of the primary and the backup list;
  // the task-progress fallbackActive layer only chooses AMONG that chain's
  // backups.
  const chain = resolveEffectiveStageChainV1(stage);
  if (!chain.primary) {
    return { source: "none" };
  }
  const source = chain.source === "general" ? "general" : "workspace";
  if (
    !options.ignoreActiveFallback &&
    chain.strategy === "switch-to-backup" &&
    chain.backups.length > 0
  ) {
    // If fallback is enabled, check if task progress has fallback active
    // for this stage.
    try {
      const readResult = await readTaskProgressStrictV1(taskFolderUri);
      const progress = readResult.ok ? readResult.decoded.progress : undefined;
      if (progress && progress.fallbackActive && progress.fallbackActive[stage]) {
        const activeFallbackModel = progress.fallbackModelId?.[stage];
        return {
          modelId:
            activeFallbackModel && chain.backups.includes(activeFallbackModel)
              ? activeFallbackModel
              : chain.backups[0],
          source,
        };
      }
    } catch {
      // No persisted progress (or unreadable) — fall through to the primary model.
    }
  }
  return { modelId: chain.primary, source };
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
    // A stage with no model of its own resolves through the general model
    // (source "general"), so this warns/blocks ONLY when the resolver
    // reports source "none" — nothing configured for the stage OR the
    // general model.
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
      const readResult = await readTaskProgressStrictV1(taskFolderUri);
      if (readResult.ok && readResult.decoded.progress.fallbackActive?.[stage]) {
        await patchTaskProgressStrictV1(
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

export function resolveConfiguredReviewStages(
  _taskFolderUri: vscode.Uri
): Promise<ReadonlySet<TaskStage>> {
  const configured = new Set<TaskStage>(REVIEW_STAGES);
  for (const stage of OPTIONAL_REVIEW_STAGES) {
    // Deliberate exception to the general-model fallback: leaving an
    // OPTIONAL deep-dive review blank is the opt-out signal auto-advance
    // relies on. Only the stage's OWN chain counts here — otherwise
    // configuring a general model would make these stages impossible to
    // skip. Required stages still fall through to the general model.
    if (resolveEffectiveStageChainV1(stage).source !== "stage") {
      configured.delete(stage);
    }
  }
  // Still Promise-shaped for its awaiting callers, though the resolver made
  // it synchronous (settings-only, no per-task read).
  return Promise.resolve(configured);
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

/**
 * Raw `devpass-code models --verbose` catalog snapshot (devpass-code
 * 1.17.13, captured 2026-07-30), compacted the same way as
 * OPENCODE_SEEDED_CATALOG_RAW above and run through the SAME
 * parseOpencodeModelsOutput parser — devpass-code is a rebrand/fork of
 * OpenCode with a byte-for-byte identical `models --verbose` shape (see
 * discoverDevpassModels in cliModelDiscovery.ts). Filtered to models whose
 * `capabilities.toolcall` was true in the live capture: the full catalog
 * (204 entries) includes embedding, image-generation, transcription, and
 * reranker models with no tool-calling support at all, which this agentic
 * coding integration can never usefully drive. Regenerate by piping a
 * fresh `devpass-code models --verbose` through the same
 * id/providerID/name/variants compaction, re-applying the toolcall filter,
 * when the catalog changes.
 */
const DEVPASS_SEEDED_CATALOG_RAW = `
llmgateway-devpass/auto
{"id":"auto","providerID":"llmgateway-devpass","name":"Auto Route","variants":{}}
llmgateway-devpass/claude-3-opus
{"id":"claude-3-opus","providerID":"llmgateway-devpass","name":"Claude 3 Opus","variants":{}}
llmgateway-devpass/claude-fable-5
{"id":"claude-fable-5","providerID":"llmgateway-devpass","name":"Claude Fable 5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-haiku-4-5
{"id":"claude-haiku-4-5","providerID":"llmgateway-devpass","name":"Claude Haiku 4.5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-haiku-4-5-20251001
{"id":"claude-haiku-4-5-20251001","providerID":"llmgateway-devpass","name":"Claude Haiku 4.5 (2025-10-01)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-haiku-4-5-free
{"id":"claude-haiku-4-5-free","providerID":"llmgateway-devpass","name":"Claude Haiku 4.5 (Free)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-opus-4-1-20250805
{"id":"claude-opus-4-1-20250805","providerID":"llmgateway-devpass","name":"Claude Opus 4.1","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-opus-4-5-20251101
{"id":"claude-opus-4-5-20251101","providerID":"llmgateway-devpass","name":"Claude Opus 4.5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-opus-4-6
{"id":"claude-opus-4-6","providerID":"llmgateway-devpass","name":"Claude Opus 4.6","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-opus-4-7
{"id":"claude-opus-4-7","providerID":"llmgateway-devpass","name":"Claude Opus 4.7","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-opus-4-8
{"id":"claude-opus-4-8","providerID":"llmgateway-devpass","name":"Claude Opus 4.8","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-opus-5
{"id":"claude-opus-5","providerID":"llmgateway-devpass","name":"Claude Opus 5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-sonnet-4-5
{"id":"claude-sonnet-4-5","providerID":"llmgateway-devpass","name":"Claude Sonnet 4.5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-sonnet-4-5-20250929
{"id":"claude-sonnet-4-5-20250929","providerID":"llmgateway-devpass","name":"Claude Sonnet 4.5 (2025-09-29)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-sonnet-4-6
{"id":"claude-sonnet-4-6","providerID":"llmgateway-devpass","name":"Claude Sonnet 4.6","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/claude-sonnet-5
{"id":"claude-sonnet-5","providerID":"llmgateway-devpass","name":"Claude Sonnet 5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/cosmos3-super-reasoner
{"id":"cosmos3-super-reasoner","providerID":"llmgateway-devpass","name":"Cosmos 3 Super Reasoner","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/deepseek-v3.2
{"id":"deepseek-v3.2","providerID":"llmgateway-devpass","name":"DeepSeek V3.2","variants":{}}
llmgateway-devpass/deepseek-v4-flash
{"id":"deepseek-v4-flash","providerID":"llmgateway-devpass","name":"DeepSeek V4 Flash","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}
llmgateway-devpass/deepseek-v4-pro
{"id":"deepseek-v4-pro","providerID":"llmgateway-devpass","name":"DeepSeek V4 Pro","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}
llmgateway-devpass/fugu-ultra
{"id":"fugu-ultra","providerID":"llmgateway-devpass","name":"Fugu Ultra","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-3-flash-preview
{"id":"gemini-3-flash-preview","providerID":"llmgateway-devpass","name":"Gemini 3 Flash (Preview)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-3.1-flash-lite
{"id":"gemini-3.1-flash-lite","providerID":"llmgateway-devpass","name":"Gemini 3.1 Flash Lite","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-3.1-pro-preview
{"id":"gemini-3.1-pro-preview","providerID":"llmgateway-devpass","name":"Gemini 3.1 Pro (Preview)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-3.5-flash
{"id":"gemini-3.5-flash","providerID":"llmgateway-devpass","name":"Gemini 3.5 Flash","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-3.5-flash-lite
{"id":"gemini-3.5-flash-lite","providerID":"llmgateway-devpass","name":"Gemini 3.5 Flash Lite","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-3.6-flash
{"id":"gemini-3.6-flash","providerID":"llmgateway-devpass","name":"Gemini 3.6 Flash","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemini-pro-latest
{"id":"gemini-pro-latest","providerID":"llmgateway-devpass","name":"Gemini Pro Latest","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemma-4-26b-a4b-it
{"id":"gemma-4-26b-a4b-it","providerID":"llmgateway-devpass","name":"Gemma 4 26B A4B IT","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gemma-4-31b-it
{"id":"gemma-4-31b-it","providerID":"llmgateway-devpass","name":"Gemma 4 31B IT","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/glm-4-32b-0414-128k
{"id":"glm-4-32b-0414-128k","providerID":"llmgateway-devpass","name":"GLM-4 32B (0414-128k)","variants":{}}
llmgateway-devpass/glm-4.5
{"id":"glm-4.5","providerID":"llmgateway-devpass","name":"GLM-4.5","variants":{}}
llmgateway-devpass/glm-4.5-air
{"id":"glm-4.5-air","providerID":"llmgateway-devpass","name":"GLM-4.5 Air","variants":{}}
llmgateway-devpass/glm-4.5-airx
{"id":"glm-4.5-airx","providerID":"llmgateway-devpass","name":"GLM-4.5 AirX","variants":{}}
llmgateway-devpass/glm-4.5-x
{"id":"glm-4.5-x","providerID":"llmgateway-devpass","name":"GLM-4.5 X","variants":{}}
llmgateway-devpass/glm-4.5v
{"id":"glm-4.5v","providerID":"llmgateway-devpass","name":"GLM-4.5V","variants":{}}
llmgateway-devpass/glm-4.6
{"id":"glm-4.6","providerID":"llmgateway-devpass","name":"GLM-4.6","variants":{}}
llmgateway-devpass/glm-4.6v
{"id":"glm-4.6v","providerID":"llmgateway-devpass","name":"GLM-4.6V","variants":{}}
llmgateway-devpass/glm-4.6v-flashx
{"id":"glm-4.6v-flashx","providerID":"llmgateway-devpass","name":"GLM-4.6V FlashX","variants":{}}
llmgateway-devpass/glm-4.7
{"id":"glm-4.7","providerID":"llmgateway-devpass","name":"GLM-4.7","variants":{}}
llmgateway-devpass/glm-4.7-flash
{"id":"glm-4.7-flash","providerID":"llmgateway-devpass","name":"GLM-4.7 Flash","variants":{}}
llmgateway-devpass/glm-4.7-flashx
{"id":"glm-4.7-flashx","providerID":"llmgateway-devpass","name":"GLM-4.7 FlashX","variants":{}}
llmgateway-devpass/glm-5
{"id":"glm-5","providerID":"llmgateway-devpass","name":"GLM-5","variants":{}}
llmgateway-devpass/glm-5.1
{"id":"glm-5.1","providerID":"llmgateway-devpass","name":"GLM-5.1","variants":{}}
llmgateway-devpass/glm-5.2
{"id":"glm-5.2","providerID":"llmgateway-devpass","name":"GLM-5.2","variants":{"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}
llmgateway-devpass/gpt-3.5-turbo
{"id":"gpt-3.5-turbo","providerID":"llmgateway-devpass","name":"GPT-3.5 Turbo","variants":{}}
llmgateway-devpass/gpt-4
{"id":"gpt-4","providerID":"llmgateway-devpass","name":"GPT-4","variants":{}}
llmgateway-devpass/gpt-4-turbo
{"id":"gpt-4-turbo","providerID":"llmgateway-devpass","name":"GPT-4 Turbo","variants":{}}
llmgateway-devpass/gpt-4.1
{"id":"gpt-4.1","providerID":"llmgateway-devpass","name":"GPT-4.1","variants":{}}
llmgateway-devpass/gpt-4.1-mini
{"id":"gpt-4.1-mini","providerID":"llmgateway-devpass","name":"GPT-4.1 Mini","variants":{}}
llmgateway-devpass/gpt-4.1-nano
{"id":"gpt-4.1-nano","providerID":"llmgateway-devpass","name":"GPT-4.1 Nano","variants":{}}
llmgateway-devpass/gpt-4o
{"id":"gpt-4o","providerID":"llmgateway-devpass","name":"GPT-4o","variants":{}}
llmgateway-devpass/gpt-4o-mini
{"id":"gpt-4o-mini","providerID":"llmgateway-devpass","name":"GPT-4o Mini","variants":{}}
llmgateway-devpass/gpt-5.1
{"id":"gpt-5.1","providerID":"llmgateway-devpass","name":"GPT-5.1","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.1-codex
{"id":"gpt-5.1-codex","providerID":"llmgateway-devpass","name":"GPT-5.1 Codex","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.1-codex-mini
{"id":"gpt-5.1-codex-mini","providerID":"llmgateway-devpass","name":"GPT-5.1 Codex mini","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.2
{"id":"gpt-5.2","providerID":"llmgateway-devpass","name":"GPT-5.2","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.2-codex
{"id":"gpt-5.2-codex","providerID":"llmgateway-devpass","name":"GPT-5.2 Codex","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.2-pro
{"id":"gpt-5.2-pro","providerID":"llmgateway-devpass","name":"GPT-5.2 Pro","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.3-codex
{"id":"gpt-5.3-codex","providerID":"llmgateway-devpass","name":"GPT-5.3 Codex","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.4
{"id":"gpt-5.4","providerID":"llmgateway-devpass","name":"GPT-5.4","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.4-mini
{"id":"gpt-5.4-mini","providerID":"llmgateway-devpass","name":"GPT-5.4 Mini","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.4-nano
{"id":"gpt-5.4-nano","providerID":"llmgateway-devpass","name":"GPT-5.4 Nano","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.4-pro
{"id":"gpt-5.4-pro","providerID":"llmgateway-devpass","name":"GPT-5.4 Pro","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.5
{"id":"gpt-5.5","providerID":"llmgateway-devpass","name":"GPT-5.5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.5-pro
{"id":"gpt-5.5-pro","providerID":"llmgateway-devpass","name":"GPT-5.5 Pro","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.6-luna
{"id":"gpt-5.6-luna","providerID":"llmgateway-devpass","name":"GPT-5.6 Luna","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.6-sol
{"id":"gpt-5.6-sol","providerID":"llmgateway-devpass","name":"GPT-5.6 Sol","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-5.6-terra
{"id":"gpt-5.6-terra","providerID":"llmgateway-devpass","name":"GPT-5.6 Terra","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-oss-120b
{"id":"gpt-oss-120b","providerID":"llmgateway-devpass","name":"GPT OSS 120B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-oss-20b
{"id":"gpt-oss-20b","providerID":"llmgateway-devpass","name":"GPT OSS 20B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-realtime-2.1
{"id":"gpt-realtime-2.1","providerID":"llmgateway-devpass","name":"GPT Realtime 2.1","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/gpt-realtime-2.1-mini
{"id":"gpt-realtime-2.1-mini","providerID":"llmgateway-devpass","name":"GPT Realtime 2.1 Mini","variants":{}}
llmgateway-devpass/grok-4
{"id":"grok-4","providerID":"llmgateway-devpass","name":"Grok 4","variants":{}}
llmgateway-devpass/grok-4-1-fast-non-reasoning
{"id":"grok-4-1-fast-non-reasoning","providerID":"llmgateway-devpass","name":"Grok 4.1 Fast Non-Reasoning","variants":{}}
llmgateway-devpass/grok-4-1-fast-reasoning
{"id":"grok-4-1-fast-reasoning","providerID":"llmgateway-devpass","name":"Grok 4.1 Fast Reasoning","variants":{}}
llmgateway-devpass/grok-4-20-beta-0309-non-reasoning
{"id":"grok-4-20-beta-0309-non-reasoning","providerID":"llmgateway-devpass","name":"Grok 4.20 Beta Non-Reasoning (0309)","variants":{}}
llmgateway-devpass/grok-4-20-beta-0309-reasoning
{"id":"grok-4-20-beta-0309-reasoning","providerID":"llmgateway-devpass","name":"Grok 4.20 Beta Reasoning (0309)","variants":{}}
llmgateway-devpass/grok-4-20-non-reasoning
{"id":"grok-4-20-non-reasoning","providerID":"llmgateway-devpass","name":"Grok 4.20 Non-Reasoning","variants":{}}
llmgateway-devpass/grok-4-20-reasoning
{"id":"grok-4-20-reasoning","providerID":"llmgateway-devpass","name":"Grok 4.20 Reasoning","variants":{}}
llmgateway-devpass/grok-4-3
{"id":"grok-4-3","providerID":"llmgateway-devpass","name":"Grok 4.3","variants":{}}
llmgateway-devpass/grok-4-5
{"id":"grok-4-5","providerID":"llmgateway-devpass","name":"Grok 4.5","variants":{}}
llmgateway-devpass/grok-build-0-1
{"id":"grok-build-0-1","providerID":"llmgateway-devpass","name":"Grok Build 0.1","variants":{}}
llmgateway-devpass/hermes-4-405b
{"id":"hermes-4-405b","providerID":"llmgateway-devpass","name":"Hermes 4 405B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/hermes-4-70b
{"id":"hermes-4-70b","providerID":"llmgateway-devpass","name":"Hermes 4 70B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/kimi-k2
{"id":"kimi-k2","providerID":"llmgateway-devpass","name":"Kimi K2","variants":{}}
llmgateway-devpass/kimi-k2.5
{"id":"kimi-k2.5","providerID":"llmgateway-devpass","name":"Kimi K2.5","variants":{}}
llmgateway-devpass/kimi-k2.6
{"id":"kimi-k2.6","providerID":"llmgateway-devpass","name":"Kimi K2.6","variants":{}}
llmgateway-devpass/kimi-k2.7-code
{"id":"kimi-k2.7-code","providerID":"llmgateway-devpass","name":"Kimi K2.7 Code","variants":{}}
llmgateway-devpass/kimi-k2.7-code-highspeed
{"id":"kimi-k2.7-code-highspeed","providerID":"llmgateway-devpass","name":"Kimi K2.7 Code Highspeed","variants":{}}
llmgateway-devpass/kimi-k3
{"id":"kimi-k3","providerID":"llmgateway-devpass","name":"Kimi K3","variants":{}}
llmgateway-devpass/llama-3.3-70b-instruct
{"id":"llama-3.3-70b-instruct","providerID":"llmgateway-devpass","name":"Llama 3.3 70B Instruct","variants":{}}
llmgateway-devpass/llama-4-maverick-17b-instruct
{"id":"llama-4-maverick-17b-instruct","providerID":"llmgateway-devpass","name":"Llama 4 Maverick 17B Instruct","variants":{}}
llmgateway-devpass/mimo-v2.5
{"id":"mimo-v2.5","providerID":"llmgateway-devpass","name":"MiMo V2.5","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/mimo-v2.5-pro
{"id":"mimo-v2.5-pro","providerID":"llmgateway-devpass","name":"MiMo V2.5 Pro","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/minimax-m2
{"id":"minimax-m2","providerID":"llmgateway-devpass","name":"MiniMax M2","variants":{}}
llmgateway-devpass/minimax-m2.1
{"id":"minimax-m2.1","providerID":"llmgateway-devpass","name":"MiniMax M2.1","variants":{}}
llmgateway-devpass/minimax-m2.1-lightning
{"id":"minimax-m2.1-lightning","providerID":"llmgateway-devpass","name":"MiniMax M2.1 Lightning","variants":{}}
llmgateway-devpass/minimax-m2.5
{"id":"minimax-m2.5","providerID":"llmgateway-devpass","name":"MiniMax M2.5","variants":{}}
llmgateway-devpass/minimax-m2.5-highspeed
{"id":"minimax-m2.5-highspeed","providerID":"llmgateway-devpass","name":"MiniMax M2.5 Highspeed","variants":{}}
llmgateway-devpass/minimax-m2.7
{"id":"minimax-m2.7","providerID":"llmgateway-devpass","name":"MiniMax M2.7","variants":{}}
llmgateway-devpass/minimax-m2.7-highspeed
{"id":"minimax-m2.7-highspeed","providerID":"llmgateway-devpass","name":"MiniMax M2.7 Highspeed","variants":{}}
llmgateway-devpass/minimax-m3
{"id":"minimax-m3","providerID":"llmgateway-devpass","name":"MiniMax M3","variants":{"none":{"thinking":{"type":"disabled"}},"thinking":{"thinking":{"type":"adaptive"}}}}
llmgateway-devpass/minimax-text-01
{"id":"minimax-text-01","providerID":"llmgateway-devpass","name":"MiniMax Text 01","variants":{}}
llmgateway-devpass/muse-spark-1.1
{"id":"muse-spark-1.1","providerID":"llmgateway-devpass","name":"Muse Spark 1.1","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/nemotron-3-nano-30b
{"id":"nemotron-3-nano-30b","providerID":"llmgateway-devpass","name":"Nemotron 3 Nano 30B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/nemotron-3-nano-omni
{"id":"nemotron-3-nano-omni","providerID":"llmgateway-devpass","name":"Nemotron 3 Nano Omni","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/nemotron-3-super-120b
{"id":"nemotron-3-super-120b","providerID":"llmgateway-devpass","name":"Nemotron 3 Super 120B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/nemotron-3-ultra-550b
{"id":"nemotron-3-ultra-550b","providerID":"llmgateway-devpass","name":"Nemotron 3 Ultra 550B","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/o4-mini
{"id":"o4-mini","providerID":"llmgateway-devpass","name":"o4 Mini","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/qwen-coder-plus
{"id":"qwen-coder-plus","providerID":"llmgateway-devpass","name":"Qwen Coder Plus","variants":{}}
llmgateway-devpass/qwen-flash
{"id":"qwen-flash","providerID":"llmgateway-devpass","name":"Qwen Flash","variants":{}}
llmgateway-devpass/qwen-max
{"id":"qwen-max","providerID":"llmgateway-devpass","name":"Qwen Max","variants":{}}
llmgateway-devpass/qwen-max-latest
{"id":"qwen-max-latest","providerID":"llmgateway-devpass","name":"Qwen Max Latest","variants":{}}
llmgateway-devpass/qwen-plus
{"id":"qwen-plus","providerID":"llmgateway-devpass","name":"Qwen Plus","variants":{}}
llmgateway-devpass/qwen-plus-latest
{"id":"qwen-plus-latest","providerID":"llmgateway-devpass","name":"Qwen Plus Latest","variants":{}}
llmgateway-devpass/qwen3-235b-a22b-instruct-2507
{"id":"qwen3-235b-a22b-instruct-2507","providerID":"llmgateway-devpass","name":"Qwen3 235B A22B Instruct 2507","variants":{}}
llmgateway-devpass/qwen3-235b-a22b-thinking-2507
{"id":"qwen3-235b-a22b-thinking-2507","providerID":"llmgateway-devpass","name":"Qwen3 235B A22B Thinking 2507","variants":{}}
llmgateway-devpass/qwen3-30b-a3b-instruct-2507
{"id":"qwen3-30b-a3b-instruct-2507","providerID":"llmgateway-devpass","name":"Qwen3 30B A3B Instruct 2507","variants":{}}
llmgateway-devpass/qwen3-32b
{"id":"qwen3-32b","providerID":"llmgateway-devpass","name":"Qwen3 32B","variants":{}}
llmgateway-devpass/qwen3-coder-30b-a3b-instruct
{"id":"qwen3-coder-30b-a3b-instruct","providerID":"llmgateway-devpass","name":"Qwen3 Coder 30B A3B Instruct","variants":{}}
llmgateway-devpass/qwen3-coder-480b-a35b-instruct
{"id":"qwen3-coder-480b-a35b-instruct","providerID":"llmgateway-devpass","name":"Qwen3 Coder 480B A35B Instruct","variants":{}}
llmgateway-devpass/qwen3-coder-flash
{"id":"qwen3-coder-flash","providerID":"llmgateway-devpass","name":"Qwen3 Coder Flash","variants":{}}
llmgateway-devpass/qwen3-coder-next
{"id":"qwen3-coder-next","providerID":"llmgateway-devpass","name":"Qwen3 Coder Next","variants":{}}
llmgateway-devpass/qwen3-max
{"id":"qwen3-max","providerID":"llmgateway-devpass","name":"Qwen3 Max","variants":{}}
llmgateway-devpass/qwen3-next-80b-a3b-instruct
{"id":"qwen3-next-80b-a3b-instruct","providerID":"llmgateway-devpass","name":"Qwen3 Next 80B A3B Instruct","variants":{}}
llmgateway-devpass/qwen3-next-80b-a3b-thinking
{"id":"qwen3-next-80b-a3b-thinking","providerID":"llmgateway-devpass","name":"Qwen3 Next 80B A3B Thinking","variants":{}}
llmgateway-devpass/qwen3-vl-235b-a22b-instruct
{"id":"qwen3-vl-235b-a22b-instruct","providerID":"llmgateway-devpass","name":"Qwen3 VL 235B A22B Instruct","variants":{}}
llmgateway-devpass/qwen3-vl-30b-a3b-instruct
{"id":"qwen3-vl-30b-a3b-instruct","providerID":"llmgateway-devpass","name":"Qwen3 VL 30B A3B Instruct","variants":{}}
llmgateway-devpass/qwen3.5-9b
{"id":"qwen3.5-9b","providerID":"llmgateway-devpass","name":"Qwen3.5 9B","variants":{}}
llmgateway-devpass/qwen3.6-35b-a3b
{"id":"qwen3.6-35b-a3b","providerID":"llmgateway-devpass","name":"Qwen3.6 35B A3B","variants":{}}
llmgateway-devpass/qwen3.6-flash
{"id":"qwen3.6-flash","providerID":"llmgateway-devpass","name":"Qwen3.6 Flash","variants":{}}
llmgateway-devpass/qwen3.6-plus
{"id":"qwen3.6-plus","providerID":"llmgateway-devpass","name":"Qwen3.6 Plus","variants":{}}
llmgateway-devpass/qwen3.7-flash
{"id":"qwen3.7-flash","providerID":"llmgateway-devpass","name":"Qwen3.7 Flash","variants":{}}
llmgateway-devpass/qwen3.7-max
{"id":"qwen3.7-max","providerID":"llmgateway-devpass","name":"Qwen3.7 Max","variants":{}}
llmgateway-devpass/qwen3.7-plus
{"id":"qwen3.7-plus","providerID":"llmgateway-devpass","name":"Qwen3.7 Plus","variants":{}}
llmgateway-devpass/qwen35-397b-a17b
{"id":"qwen35-397b-a17b","providerID":"llmgateway-devpass","name":"Qwen3.5 397B A17B","variants":{}}
llmgateway-devpass/seed-1-6-250615
{"id":"seed-1-6-250615","providerID":"llmgateway-devpass","name":"Seed 1.6 (250615)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/seed-1-6-250915
{"id":"seed-1-6-250915","providerID":"llmgateway-devpass","name":"Seed 1.6 (250915)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/seed-1-6-flash-250715
{"id":"seed-1-6-flash-250715","providerID":"llmgateway-devpass","name":"Seed 1.6 Flash (250715)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
llmgateway-devpass/seed-1-8-251228
{"id":"seed-1-8-251228","providerID":"llmgateway-devpass","name":"Seed 1.8 (251228)","variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}
`;

function createSeededDevpassModels(): readonly DiscoveredCliModel[] {
  return parseOpencodeModelsOutput(DEVPASS_SEEDED_CATALOG_RAW);
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
  "devpass-cli": createSeededDevpassModels(),
  "cline-cli": createSeededClineModels(),
  // Snapshot of `kimi provider list --json`'s "models" map (kimi-code
  // 0.29.2, re-captured 2026-08-03 against the managed `kimi-code` OAuth
  // provider), run through the real parseKimiModelsOutput (cliModelDiscovery.ts)
  // so the seeded catalog and live discovery share one code path and can't
  // drift in shape. K2.7 Coding / K2.7 Coding Highspeed have no
  // `supportEfforts` (always-on thinking), so they get one entry each; K3 /
  // K3-256k each expand into a bare entry plus @low/@high/@max variants —
  // reasoning effort is applied via KIMI_MODEL_THINKING_EFFORT, an
  // operational environment-variable override, not a CLI flag — see
  // parseKimiModelSelection's doc comment in providers.ts.
  "kimi-cli": parseKimiModelsOutput(`{
  "models": {
    "kimi-code/kimi-for-coding": { "displayName": "K2.7 Coding" },
    "kimi-code/kimi-for-coding-highspeed": { "displayName": "K2.7 Coding Highspeed" },
    "kimi-code/k3-256k": { "displayName": "K3-256k", "supportEfforts": ["low", "high", "max"], "defaultEffort": "high" },
    "kimi-code/k3": { "displayName": "K3", "supportEfforts": ["low", "high", "max"], "defaultEffort": "high" }
  }
}`),
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
  source: "task" | "workspace" | "general" | "none"
): string {
  switch (source) {
    case "task":
      return "task override";
    case "workspace":
      return "workspace default";
    case "general":
      return "general model fallback";
    case "none":
      return "automatic selection";
  }
}

