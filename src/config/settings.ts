import * as vscode from "vscode";
import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";
import { FallbackStrategy, ModelSettings } from "../utils/modelFallback";
import {
  normalizeQualifiedModelId,
  providerAccountIdForModelId,
} from "../runners/providers";

/** Settings displayed to users. Command and extension identifiers deliberately
 * retain their historical `vs-code-ai-helper` prefix for compatibility. */
const CONFIG_SECTION = "ensemble";
const LEGACY_CONFIG_SECTION = "vs-code-ai-helper";
const SETTINGS_NAMESPACE_MIGRATION_KEY = "ensemble.settingsNamespace.v1";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const AI_MODEL_DEFAULTS_KEY = "aiModelDefaults";
const META_FILES_HIDDEN_KEY = "metaFilesHidden";
const ENABLED_PROVIDERS_KEY = "enabledProviders";
const PUBLISH_VERIFICATION_COMMANDS_KEY = "publishVerificationCommands";
const KNOWN_FLAKY_CHECKS_KEY = "knownFlakyChecks";
const REVIEW_PLATEAU_ROUNDS_KEY = "reviewPlateauRounds";
const COMPLETION_CHECK_TIMEOUT_MS_KEY = "completionCheckTimeoutMs";
const FAST_FORWARD_MAX_ITERATIONS_KEY = "fastForwardMaxIterations";
const AUTO_ADVANCE_ENABLED_KEY = "autoAdvanceEnabled";
const AUTO_ADVANCE_SCORE_KEY = "autoAdvanceScoreThreshold";
const AUTO_IMPLEMENT_AFTER_REVIEW_KEY = "autoImplementAfterReview";
const AUTO_IMPLEMENT_CONFIRMED_KEY = "ensemble.autoImplementAfterReview.confirmed.v1";
const COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY = "completeAndMoveOnTriggersAI";
const UNSAVED_SETTINGS_WARNING_KEY = "warnings.unsavedSettings";
const LARGE_TOKEN_REQUEST_WARNING_KEY = "warnings.largeTokenRequest";

const ALL_SETTING_KEYS = [
  AI_MODEL_DEFAULTS_KEY, "modelSettings", UNSAVED_SETTINGS_WARNING_KEY,
  LARGE_TOKEN_REQUEST_WARNING_KEY, ENABLED_PROVIDERS_KEY,
  FAST_FORWARD_MAX_ITERATIONS_KEY, AUTO_ADVANCE_ENABLED_KEY,
  COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY, AUTO_ADVANCE_SCORE_KEY,
  "fastForwardStopLevel", "fastForwardUseAcceptanceThreshold",
  "autoReviewAfterPlan", "autoReviewAfterImplementation",
  "maxImplementationIterations",
  "allowDirtyWorktreeChanges", "desktopNotifications",
  PUBLISH_VERIFICATION_COMMANDS_KEY,
  KNOWN_FLAKY_CHECKS_KEY, REVIEW_PLATEAU_ROUNDS_KEY,
  COMPLETION_CHECK_TIMEOUT_MS_KEY,
] as const;

/**
 * Read a setting without allowing the active schema default to mask an
 * explicitly configured legacy value during the compatibility window.
 * Values are resolved at each scope before proceeding to the next one.
 */
function readSetting<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  const activeConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const legacyConfiguration = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION, resource);
  const active = activeConfiguration.inspect<T>(key);
  const legacy = legacyConfiguration.inspect<T>(key);
  for (const field of ["workspaceFolderValue", "workspaceValue", "globalValue"] as const) {
    if (active?.[field] !== undefined) return active[field] as T;
    if (legacy?.[field] !== undefined) return legacy[field] as T;
  }
  // inspect() is authoritative for explicit-value precedence.  get() is only
  // the final schema-default fallback (and keeps lightweight configuration
  // adapters used by callers and tests compatible with VS Code's API).
  const value = activeConfiguration.get<T>(key, fallback);
  return value === undefined ? fallback : value;
}

/** Whether the unsaved-settings-change warning is shown (true = warn). */
export function isUnsavedSettingsWarningEnabled(): boolean {
  return readSetting(UNSAVED_SETTINGS_WARNING_KEY, true);
}

/** Persist the "Don't show again" opt-out for the unsaved-settings warning. */
export async function setUnsavedSettingsWarningEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION)
    .update(UNSAVED_SETTINGS_WARNING_KEY, enabled, vscode.ConfigurationTarget.Global);
}

/** Whether the large-AI-token-request warning is shown (true = warn). */
export function isLargeTokenRequestWarningEnabled(): boolean {
  return readSetting(LARGE_TOKEN_REQUEST_WARNING_KEY, true);
}

/** Persist the "Proceed and don't ask again" opt-out for the large-token warning. */
export async function setLargeTokenRequestWarningEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION)
    .update(LARGE_TOKEN_REQUEST_WARNING_KEY, enabled, vscode.ConfigurationTarget.Global);
}

/**
 * Three-state automation mode shared by the auto-review / auto-advance /
 * complete-and-move-on settings:
 *  - "off": no automatic action.
 *  - "auto": run the automatic action (a single review / advance / trigger).
 *  - "auto-fast-forward": run the automatic action and, where applicable
 *    (when it produces or lands on a review), run Fast Forward Fixes.
 */
export type AutoTriggerMode = "off" | "auto" | "auto-fast-forward";

const AUTO_TRIGGER_MODE_RANK: Record<AutoTriggerMode, number> = {
  off: 0,
  auto: 1,
  "auto-fast-forward": 2,
};

/**
 * Combine two automation modes, keeping the stronger one
 * ("off" < "auto" < "auto-fast-forward").
 *
 * Used where two independent opt-ins can request the same follow-up review:
 * a stage's own auto-review setting and a chained request carried from
 * "Complete & Move On triggers AI: auto-fast-forward". Neither may downgrade
 * the other.
 */
export function strongestAutoTriggerMode(
  a: AutoTriggerMode,
  b: AutoTriggerMode | undefined
): AutoTriggerMode {
  if (!b) return a;
  return AUTO_TRIGGER_MODE_RANK[b] > AUTO_TRIGGER_MODE_RANK[a] ? b : a;
}

/**
 * Read one of the three-state automation settings, honoring legacy boolean
 * values still present in user settings (true = "auto", false = "off").
 */
function readAutoTriggerMode(key: string, defaultMode: AutoTriggerMode): AutoTriggerMode {
  const raw = readSetting<unknown>(key, defaultMode);
  if (raw === true) return "auto";
  if (raw === false) return "off";
  if (raw === "off" || raw === "auto" || raw === "auto-fast-forward") return raw;
  return defaultMode;
}

/** Mode for starting the destination stage's AI action after completing a stage. */
export function getCompleteAndMoveOnTriggersAIMode(): AutoTriggerMode {
  return readAutoTriggerMode(COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY, "auto");
}

/** Whether completing a stage automatically starts the destination stage's AI action. */
export function completeAndMoveOnTriggersAI(): boolean {
  return getCompleteAndMoveOnTriggersAIMode() !== "off";
}
const FAST_FORWARD_STOP_LEVEL_KEY = "fastForwardStopLevel";
const FAST_FORWARD_USE_ACCEPTANCE_KEY = "fastForwardUseAcceptanceThreshold";
const AUTO_REVIEW_AFTER_PLAN_KEY = "autoReviewAfterPlan";
const AUTO_REVIEW_AFTER_IMPLEMENTATION_KEY = "autoReviewAfterImplementation";
const ALLOW_DIRTY_WORKTREE_CHANGES_KEY = "allowDirtyWorktreeChanges";
const DESKTOP_NOTIFICATIONS_KEY = "desktopNotifications";

// The legacy metaResourcesPath/metaFilesHidden keys (no longer contributed
// or written — resource storage and Git-ignore handling are automatic now)
// described *this* project, so migrateSettingsScope must never lift a
// leftover value into user settings. publishVerificationCommands likewise
// describes this project's toolchain. Every other setting is a personal
// preference the user expects to carry into a brand-new workspace, so it's
// written to user (Global) settings instead — see migrateSettingsScope()
// below for the one-time cutover of values already sitting in a workspace's
// settings.json.
const WORKSPACE_SCOPED_KEYS = new Set<string>([
  META_RESOURCES_PATH_KEY,
  META_FILES_HIDDEN_KEY,
  PUBLISH_VERIFICATION_COMMANDS_KEY,
]);

export function targetFor(key: string): vscode.ConfigurationTarget {
  return WORKSPACE_SCOPED_KEYS.has(key)
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

/**
 * Copies explicitly configured legacy settings into the Ensemble namespace.
 * Schema defaults never participate in this decision: a value already set in
 * `ensemble.*` always wins, and every workspace-folder override is considered
 * independently.  The old keys remain declared (and deprecated) for one
 * release so VS Code can continue to read old settings.json files.
 */
export async function migrateSettingsNamespace(context: vscode.ExtensionContext): Promise<void> {
  // Keep the marker machine-local. Re-running is still safe, but avoiding
  // needless configuration writes prevents Settings Sync churn on activation.
  if (context.globalState.get<boolean>(SETTINGS_NAMESPACE_MIGRATION_KEY, false)) return;

  const copyScope = async (
    key: string,
    target: vscode.ConfigurationTarget,
    resource?: vscode.Uri
  ): Promise<void> => {
    const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION, resource).inspect<unknown>(key);
    const active = vscode.workspace.getConfiguration(CONFIG_SECTION, resource).inspect<unknown>(key);
    const legacyValue = target === vscode.ConfigurationTarget.Global
      ? legacy?.globalValue
      : target === vscode.ConfigurationTarget.Workspace
        ? legacy?.workspaceValue
        : legacy?.workspaceFolderValue;
    const activeValue = target === vscode.ConfigurationTarget.Global
      ? active?.globalValue
      : target === vscode.ConfigurationTarget.Workspace
        ? active?.workspaceValue
        : active?.workspaceFolderValue;
    if (activeValue === undefined && legacyValue !== undefined) {
      await vscode.workspace.getConfiguration(CONFIG_SECTION, resource).update(key, legacyValue, target);
    }
  };

  for (const key of ALL_SETTING_KEYS) {
    await copyScope(key, vscode.ConfigurationTarget.Global);
    await copyScope(key, vscode.ConfigurationTarget.Workspace);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await copyScope(key, vscode.ConfigurationTarget.WorkspaceFolder, folder.uri);
    }
  }
  await context.globalState.update(SETTINGS_NAMESPACE_MIGRATION_KEY, true);
}

/**
 * One-time cutover of previously workspace-scoped settings to user (Global)
 * settings, so a new workspace inherits them instead of starting blank.
 * Must run before migrateEnabledProvidersForExistingModels(), which inspects
 * the post-migration state.
 */
export async function migrateSettingsScope(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const globalKeys = [
    AI_MODEL_DEFAULTS_KEY,
    MODEL_SETTINGS_KEY,
    ENABLED_PROVIDERS_KEY,
    FAST_FORWARD_MAX_ITERATIONS_KEY,
    AUTO_ADVANCE_ENABLED_KEY,
    AUTO_ADVANCE_SCORE_KEY,
    COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY,
    FAST_FORWARD_STOP_LEVEL_KEY,
    FAST_FORWARD_USE_ACCEPTANCE_KEY,
    AUTO_REVIEW_AFTER_PLAN_KEY,
    AUTO_REVIEW_AFTER_IMPLEMENTATION_KEY,
    AUTO_IMPLEMENT_AFTER_REVIEW_KEY,
    ALLOW_DIRTY_WORKTREE_CHANGES_KEY,
    DESKTOP_NOTIFICATIONS_KEY,
    MAX_IMPLEMENTATION_ITERATIONS_KEY,
  ];

  const conflicts: string[] = [];
  for (const key of globalKeys) {
    const inspected = config.inspect(key);
    if (inspected?.workspaceValue === undefined) {
      continue;
    }
    if (inspected.globalValue === undefined) {
      await config.update(key, inspected.workspaceValue, vscode.ConfigurationTarget.Global);
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    } else if (JSON.stringify(inspected.workspaceValue) === JSON.stringify(inspected.globalValue)) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    } else {
      conflicts.push(key);
    }
  }

  if (conflicts.length === 0) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `This workspace has ${conflicts.length} Ensemble setting(s) that differ from your user settings. ` +
      "Workspace values still take effect here, but won't follow you to other workspaces unless you " +
      "make them the default.",
    "Use This Workspace's Settings Everywhere",
    "Keep Workspace Overrides"
  );
  if (choice === "Use This Workspace's Settings Everywhere") {
    for (const key of conflicts) {
      const inspected = config.inspect(key);
      await config.update(key, inspected?.workspaceValue, vscode.ConfigurationTarget.Global);
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
  }
}

/**
 * Explicitly configured Publish verification command lines for this
 * project. When set, these take precedence over the conventional
 * package.json lint/test script detection in completionLint.ts.
 */
export function getPublishVerificationCommands(): string[] {
  const raw = readSetting<unknown>(PUBLISH_VERIFICATION_COMMANDS_KEY, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** One quarantined known-flaky-check entry — see getKnownFlakyChecks(). */
export interface KnownFlakyCheck {
  /** Substring matched against a failed check's command line. */
  match: string;
  /** Substring matched against that failed check's combined stdout/stderr. */
  failureSignature: string;
  /** Shown next to the quarantined failure so it stays explainable, not silent. */
  reason: string;
}

/**
 * Known-flaky-check allowlist: completion checks whose failure is a known,
 * pre-existing environmental issue (e.g. a Windows temp-dir cleanup race)
 * rather than a real regression. A failure only ever moves from `failed` to
 * `knownFlake` when BOTH `match` and `failureSignature` are found — this is
 * deliberately narrow so the allowlist can't accidentally swallow a real
 * failure that happens to share a command name. Never changes the raw
 * `passed` verdict (see collectCompletionLint) — only the modulo-known-flakes
 * one reviewers are told to treat as the readiness-relevant signal.
 */
export function getKnownFlakyChecks(): KnownFlakyCheck[] {
  const raw = readSetting<unknown>(KNOWN_FLAKY_CHECKS_KEY, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: KnownFlakyCheck[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const match = typeof entry.match === "string" ? entry.match.trim() : "";
    const failureSignature = typeof entry.failureSignature === "string" ? entry.failureSignature.trim() : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (match && failureSignature && reason) {
      entries.push({ match, failureSignature, reason });
    }
  }
  return entries;
}

/**
 * Number of consecutive rounds with no new high-water-mark review score
 * before a stage is considered plateaued (see reviewRouting.ts's
 * detectPlateau). Lower values escalate to a human sooner; higher values
 * give automated iteration more room before giving up.
 */
export function getReviewPlateauRounds(): number {
  const value = readSetting(REVIEW_PLATEAU_ROUNDS_KEY, 3);
  // A malformed configured value (non-numeric, NaN, Infinity — the schema
  // is "integer" but workspace settings.json can still hold anything) must
  // not propagate NaN into detectPlateau's window: Array.prototype.slice
  // coerces a NaN offset to 0, which makes the "prior" comparison slice
  // permanently empty and its max permanently -Infinity — plateau detection
  // then silently returns false forever instead of ever firing, disabling
  // the escalation safety valve with no visible symptom.
  const numeric = Number.isFinite(value) ? Math.floor(value) : 3;
  return Math.max(2, Math.min(20, numeric));
}

/**
 * Wall-clock cap (milliseconds) on a single completion check (lint/type-
 * check/test command, or an explicit verification command). Applies both at
 * Publish and — since review-impl-high/impl-low/publish reviews now run
 * these checks on every round to produce the {{verifiedChecks}} evidence
 * block — to every review round. Without a cap, a hung command blocks that
 * round indefinitely with no way to recover short of cancelling the whole
 * operation from the UI. Default: 10 minutes, generous enough not to
 * interrupt a legitimately slow real test suite.
 */
export function getCompletionCheckTimeoutMs(): number {
  const value = readSetting(COMPLETION_CHECK_TIMEOUT_MS_KEY, 600_000);
  const numeric = Number.isFinite(value) ? Math.floor(value) : 600_000;
  return Math.max(10_000, numeric);
}

/**
 * Whether the user (or the activation migration) has ever recorded an
 * explicit provider selection. Used by the runner-entry guard: when a
 * selection exists, models of providers missing from it are refused at run
 * time; when no selection was ever made (fresh pre-migration state), the
 * guard stays inactive so nothing is blocked before migration runs.
 */
export function isProviderSelectionConfigured(): boolean {
  const configured = (section: string): boolean => {
    const inspected = vscode.workspace.getConfiguration(section)
      .inspect<Record<string, boolean>>(ENABLED_PROVIDERS_KEY);
    return !!(inspected && (inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined));
  };
  return configured(CONFIG_SECTION) || configured(LEGACY_CONFIG_SECTION);
}

/** Providers are opt-in.  A migration on activation preserves providers that
 * are already referenced by older model settings. */
export function isProviderEnabled(provider: string): boolean {
  const enabled = getEnabledProviders();
  // Copilot (the built-in VS Code Language Model integration) predates the
  // provider selection: existing configurations have no "copilot" key, so it
  // stays enabled unless the user explicitly unchecks it.
  if (provider === "copilot") {
    return enabled[provider] !== false;
  }
  // `opencode-cli` is the shared execution adapter retained in stored model
  // IDs. Its visible account controls are OpenCode Zen and OpenCode Go, so
  // callers that only know the adapter should regard either enabled service
  // as available. Model-aware callers use isModelProviderEnabled below and
  // therefore keep the two entitlements properly separate.
  if (provider === "opencode-cli") {
    return enabled[provider] === true || enabled["opencode-zen"] === true || enabled["opencode-go"] === true;
  }
  return enabled[provider] === true;
}

/** Whether the Provider Selection row governing this exact model is enabled. */
export function isModelProviderEnabled(modelId: string | undefined): boolean {
  const accountId = providerAccountIdForModelId(modelId);
  if (accountId === "opencode-cli") {
    // This is a saved model from an external OpenCode CLI namespace, not Zen
    // or Go. Preserve legacy selections while their old checkbox exists, but
    // never let either new service checkbox implicitly authorize it.
    return getEnabledProviders()[accountId] === true;
  }
  return isProviderEnabled(accountId);
}

/** Explicit provider selection shared by Settings and runner guards. */
export function getEnabledProviders(): Record<string, boolean> {
  const configured = readSetting<Record<string, boolean>>(ENABLED_PROVIDERS_KEY, {});
  // Before Zen/Go became explicit Provider Selection rows, one
  // `opencode-cli` checkbox covered both namespaces. Preserve that prior
  // opt-in on read so existing configured models are not suddenly blocked;
  // the next save writes the two explicit choices and drops the legacy key.
  if (!Object.prototype.hasOwnProperty.call(configured, "opencode-cli")) {
    return configured;
  }
  return {
    ...configured,
    ...(configured["opencode-zen"] === undefined
      ? { "opencode-zen": configured["opencode-cli"] }
      : {}),
    ...(configured["opencode-go"] === undefined
      ? { "opencode-go": configured["opencode-cli"] }
      : {}),
  };
}

export async function setEnabledProviders(enabled: Record<string, boolean>): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION)
    .update(ENABLED_PROVIDERS_KEY, enabled, targetFor(ENABLED_PROVIDERS_KEY));
}

/**
 * One-time compatibility migration for the old implicit-enable behaviour.
 * Only providers actually referenced by a pre-existing stage model are kept
 * enabled; a new workspace therefore starts with every provider disabled.
 * Checks both scopes: migrateSettingsScope() may already have lifted this
 * key to Global before this runs, and re-running would otherwise silently
 * re-enable providers the user has since disabled.
 */
export async function migrateEnabledProvidersForExistingModels(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspected = config.inspect<Record<string, boolean>>(ENABLED_PROVIDERS_KEY);
  if (inspected?.workspaceValue !== undefined || inspected?.globalValue !== undefined) {
    return;
  }
  const settings = getModelSettings();
  const enabled: Record<string, boolean> = {};
  for (const setting of Object.values(settings)) {
    for (const model of [setting?.primary, setting?.backup, ...(setting?.backups ?? [])]) {
      if (!model) continue;
      enabled[providerAccountIdForModelId(model)] = true;
    }
  }
  if (Object.keys(enabled).length > 0) {
    await config.update(ENABLED_PROVIDERS_KEY, enabled, targetFor(ENABLED_PROVIDERS_KEY));
  }
}

export function getFastForwardMaxIterations(): number {
  const value = readSetting(FAST_FORWARD_MAX_ITERATIONS_KEY, 5);
  return Math.max(1, Math.min(99, Math.floor(value)));
}

/** Mode for score-threshold auto-advance. */
export function getAutoAdvanceMode(): AutoTriggerMode {
  return readAutoTriggerMode(AUTO_ADVANCE_ENABLED_KEY, "off");
}

export function isAutoAdvanceEnabled(): boolean {
  return getAutoAdvanceMode() !== "off";
}

/**
 * Auto implementation is deliberately a separate opt-in from auto-advance.
 * The setting may be synchronised or edited outside VS Code, so the value is
 * not trusted until this machine has recorded the supervision acknowledgement.
 */
let autoImplementConfirmed = false;

/**
 * Reset the process-local acknowledgement between isolated test cases.
 *
 * The acknowledgement normally comes from ExtensionContext.globalState when
 * the confirmation controller is constructed. Keeping this narrow reset seam
 * prevents tests from depending on module execution order without changing
 * the runtime's persisted, per-machine confirmation behavior.
 * @internal Test support only.
 */
export function resetAutoImplementConfirmationForTests(): void {
  autoImplementConfirmed = false;
}

export function getAutoImplementAfterReviewMode(): "off" | "auto" {
  const raw = readSetting<unknown>(AUTO_IMPLEMENT_AFTER_REVIEW_KEY, "off");
  return raw === "auto" && autoImplementConfirmed ? "auto" : "off";
}

export function isAutoImplementAfterReviewEnabled(): boolean {
  return getAutoImplementAfterReviewMode() === "auto";
}

/**
 * Owns the one-time, machine-local acknowledgement for automatic file
 * changes. Configuration changes are serialised so rapid updates never show
 * overlapping modals or accidentally clear an unrelated setting scope.
 */
export class AutoImplementConfirmationController implements vscode.Disposable {
  private queue: Promise<void> = Promise.resolve();
  private readonly listener: vscode.Disposable;
  private readonly foldersListener: vscode.Disposable;
  private snapshot?: AutoImplementScopeSnapshot;

  constructor(private readonly context: vscode.ExtensionContext) {
    autoImplementConfirmed = context.globalState.get<boolean>(AUTO_IMPLEMENT_CONFIRMED_KEY, false);
    this.listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${AUTO_IMPLEMENT_AFTER_REVIEW_KEY}`)) {
        this.enqueue(false);
      }
    });
    this.foldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.enqueue(false));
    this.enqueue(true); // Covers settings-sync/offline edits present at activation.
  }

  dispose(): void {
    this.listener.dispose();
    this.foldersListener.dispose();
  }

  /**
   * Wait until configuration changes observed before this call have been
   * handled. This is useful to callers that need deterministic setup and
   * keeps the controller's serialized-event contract observable in tests.
   */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  private enqueue(initial: boolean): void {
    this.queue = this.queue.then(() => this.confirmOrReset(initial)).catch((error) => {
      console.error("Auto implementation confirmation failed", error);
    });
  }

  private async confirmOrReset(initial: boolean): Promise<void> {
    const current = this.readSnapshot();
    const previous = this.snapshot;
    this.snapshot = current;

    if (autoImplementConfirmed) return;
    const enabledScopes = initial || !previous
      ? current.autoScopes()
      : current.transitionsToAuto(previous);
    if (enabledScopes.length === 0) return;

    const choice = await vscode.window.showWarningMessage(
      "Automatically implement will make real code and file changes after an approved review. Use it only with continuous human supervision.",
      { modal: true },
      "Enable"
    );
    if (choice === "Enable") {
      await this.context.globalState.update(AUTO_IMPLEMENT_CONFIRMED_KEY, true);
      autoImplementConfirmed = true;
      return;
    }
    // Clear only scopes which transitioned to auto for this event. A newly
    // cancelled workspace override must never wipe an existing global value.
    const cleared: AutoImplementScope[] = [];
    for (const scope of enabledScopes) {
      await vscode.workspace.getConfiguration(CONFIG_SECTION, scope.resource)
        .update(AUTO_IMPLEMENT_AFTER_REVIEW_KEY, undefined, scope.target);
      cleared.push(scope);
    }
    // Do not re-read the whole configuration here. A user may have changed a
    // different scope while the modal was open; that event is already queued
    // and must be compared with the pre-modal snapshot, not silently folded
    // into this controller's self-write baseline.
    this.snapshot = current.without(cleared);
  }

  private readSnapshot(): AutoImplementScopeSnapshot {
    const inspect = (resource?: vscode.Uri) => vscode.workspace
      .getConfiguration(CONFIG_SECTION, resource).inspect<unknown>(AUTO_IMPLEMENT_AFTER_REVIEW_KEY);
    const root = inspect();
    const folders = vscode.workspace.workspaceFolders ?? [];
    return new AutoImplementScopeSnapshot(
      root?.globalValue,
      root?.workspaceValue,
      new Map(folders.map(folder => [folder.uri.toString(), inspect(folder.uri)?.workspaceFolderValue])),
      new Map(folders.map(folder => [folder.uri.toString(), folder.uri]))
    );
  }
}

type AutoImplementScope = { target: vscode.ConfigurationTarget; resource?: vscode.Uri };

class AutoImplementScopeSnapshot {
  constructor(
    private readonly globalValue: unknown,
    private readonly workspaceValue: unknown,
    private readonly folderValues: Map<string, unknown>,
    private readonly folderUris: Map<string, vscode.Uri>
  ) {}

  autoScopes(): AutoImplementScope[] {
    const scopes: AutoImplementScope[] = [];
    if (this.globalValue === "auto") scopes.push({ target: vscode.ConfigurationTarget.Global });
    if (this.workspaceValue === "auto") scopes.push({ target: vscode.ConfigurationTarget.Workspace });
    for (const [folder, value] of this.folderValues) {
      if (value === "auto") scopes.push({ target: vscode.ConfigurationTarget.WorkspaceFolder, resource: this.folderUris.get(folder) });
    }
    return scopes;
  }

  transitionsToAuto(previous: AutoImplementScopeSnapshot): AutoImplementScope[] {
    const changed: AutoImplementScope[] = [];
    if (this.globalValue === "auto" && previous.globalValue !== "auto") changed.push({ target: vscode.ConfigurationTarget.Global });
    if (this.workspaceValue === "auto" && previous.workspaceValue !== "auto") changed.push({ target: vscode.ConfigurationTarget.Workspace });
    for (const [folder, value] of this.folderValues) {
      if (value === "auto" && previous.folderValues.get(folder) !== "auto") {
        changed.push({ target: vscode.ConfigurationTarget.WorkspaceFolder, resource: this.folderUris.get(folder) });
      }
    }
    return changed;
  }

  /** Return this snapshot with only controller-cleared scopes removed. */
  without(scopes: readonly AutoImplementScope[]): AutoImplementScopeSnapshot {
    let globalValue = this.globalValue;
    let workspaceValue = this.workspaceValue;
    const folderValues = new Map(this.folderValues);
    for (const scope of scopes) {
      if (scope.target === vscode.ConfigurationTarget.Global) globalValue = undefined;
      else if (scope.target === vscode.ConfigurationTarget.Workspace) workspaceValue = undefined;
      else if (scope.resource) folderValues.set(scope.resource.toString(), undefined);
    }
    return new AutoImplementScopeSnapshot(globalValue, workspaceValue, folderValues, new Map(this.folderUris));
  }
}

export function installAutoImplementConfirmation(context: vscode.ExtensionContext): vscode.Disposable {
  return new AutoImplementConfirmationController(context);
}

export function getAutoAdvanceScoreThreshold(): number {
  const value = readSetting(AUTO_ADVANCE_SCORE_KEY, 10);
  return Math.max(1, Math.min(10, Math.floor(value)));
}

export function getFastForwardStopLevel(): number {
  const value = readSetting(FAST_FORWARD_STOP_LEVEL_KEY, 0);
  return Math.max(0, Math.min(10, Math.floor(value)));
}

export function usesAcceptanceThresholdForFastForward(): boolean {
  return readSetting(FAST_FORWARD_USE_ACCEPTANCE_KEY, false);
}

/** Mode for auto-review after AI drafts a plan. */
export function getAutoReviewAfterPlanMode(): AutoTriggerMode {
  return readAutoTriggerMode(AUTO_REVIEW_AFTER_PLAN_KEY, "off");
}

/** Mode for auto-review after AI completes initial implementation. */
export function getAutoReviewAfterImplementationMode(): AutoTriggerMode {
  return readAutoTriggerMode(AUTO_REVIEW_AFTER_IMPLEMENTATION_KEY, "off");
}

/** Whether implementation/Fast Forward runs may proceed without prompting when the workspace has unrelated uncommitted changes. */
export function allowsDirtyWorktreeChanges(): boolean {
  return readSetting(ALLOW_DIRTY_WORKTREE_CHANGES_KEY, false);
}

/** Whether native OS notifications fire for things that need attention (questions, warnings, errors). Off by default. */
export function isDesktopNotificationsEnabled(): boolean {
  return readSetting(DESKTOP_NOTIFICATIONS_KEY, false);
}

/**
 * Get workspace-level default model IDs keyed by AI workflow stage.
 */
export function getAiModelDefaults(): Partial<Record<TaskStage, string>> {
  const raw = readSetting<Record<string, unknown>>(AI_MODEL_DEFAULTS_KEY, {});
  const defaults: Partial<Record<TaskStage, string>> = {};

  for (const stage of AI_MODEL_STAGES) {
    const value = raw[stage];
    if (typeof value === "string" && value.trim().length > 0) {
      defaults[stage] = normalizeQualifiedModelId(value);
    }
  }

  return defaults;
}

/**
 * Get the workspace-level default model for a single stage.
 */
export function getAiModelDefault(stage: TaskStage): string | undefined {
  const defaults = getAiModelDefaults();
  return defaults[stage];
}

/**
 * Set or clear a workspace-level default model for one AI workflow stage.
 */
export async function setAiModelDefault(
  stage: TaskStage,
  modelId: string | undefined
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = getAiModelDefaults();

  if (modelId && modelId.trim().length > 0) {
    current[stage] = modelId;
  } else {
    delete current[stage];
  }

  await config.update(
    AI_MODEL_DEFAULTS_KEY,
    current,
    targetFor(AI_MODEL_DEFAULTS_KEY)
  );
}

const MODEL_SETTINGS_KEY = "modelSettings";
const MAX_IMPLEMENTATION_ITERATIONS_KEY = "maxImplementationIterations";

export function getMaxImplementationIterations(): number {
  const value = readSetting(MAX_IMPLEMENTATION_ITERATIONS_KEY, 200);
  return Math.max(1, Math.min(200, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 200)));
}

export function getModelSettings(): ModelSettings {
  const raw = readSetting<Record<string, unknown>>(MODEL_SETTINGS_KEY, {});
  const result: ModelSettings = {};
  for (const stage of AI_MODEL_STAGES) {
    const value = raw[stage];
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    // Normalize through legacyModelAliases so a stage's selection matches
    // the same model everywhere: the execution path already applies the
    // alias inside parseModelSelection, but callers that match a stored ID
    // against getAvailableModels() by exact string (the settings webview)
    // would otherwise still see the old, no-longer-listed ID.
    const primary = typeof entry.primary === "string" && entry.primary.trim() ? normalizeQualifiedModelId(entry.primary) : undefined;
    const backup = typeof entry.backup === "string" && entry.backup.trim() ? normalizeQualifiedModelId(entry.backup) : undefined;
    const backups = Array.isArray(entry.backups)
      ? [
          ...new Set(
            entry.backups
              .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
              .map((v) => normalizeQualifiedModelId(v.trim()))
              .filter((v): v is string => v !== undefined)
          ),
        ]
      : undefined;
    let strategy: FallbackStrategy = entry.strategy === "switch-to-backup" || entry.strategy === "pause-and-resume" || entry.strategy === "alert-and-wait"
      ? entry.strategy : "alert-and-wait";
    // Back-compat: the old UI could save strategy: "switch-to-backup" with
    // fallbackEnabled: false (checkbox unchecked, strategy left untouched).
    // That combination meant "don't use backup" — downgrade it on read so
    // removing the checkbox doesn't silently turn fallback on for those
    // workspaces.
    if (strategy === "switch-to-backup" && entry.fallbackEnabled === false) {
      strategy = "alert-and-wait";
    }
    result[stage] = { primary, backup, backups, strategy };
  }
  // Migrate the older primary-only setting so existing workspaces do not
  // silently lose their configured models when the settings panel is opened.
  for (const stage of AI_MODEL_STAGES) {
    if (!result[stage]) {
      const legacy = getAiModelDefault(stage);
      if (legacy) result[stage] = { primary: legacy, strategy: "alert-and-wait" };
    }
  }
  return result;
}

export async function setModelSettings(settings: ModelSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const clean: ModelSettings = {};
  for (const stage of AI_MODEL_STAGES) {
    const setting = settings[stage];
    if (setting) {
      const primary = typeof setting.primary === "string" && setting.primary.trim() ? setting.primary.trim() : undefined;
      const backup = typeof setting.backup === "string" && setting.backup.trim() ? setting.backup.trim() : undefined;
      const backups = Array.isArray(setting.backups) ? [...new Set(setting.backups.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim()))].slice(0, 10) : undefined;
      // Preserve a configured backup even if strategy isn't switch-to-backup —
      // switching strategy back later shouldn't lose the user's backup choice.
      clean[stage] = { ...setting, primary, backup, backups };
    }
  }
  await config.update(
    MODEL_SETTINGS_KEY,
    clean,
    targetFor(MODEL_SETTINGS_KEY)
  );
}
