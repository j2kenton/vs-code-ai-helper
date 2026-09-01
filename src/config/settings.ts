import * as vscode from "vscode";
import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";
import { FallbackStrategy, ModelSettings, StageModelSetting, normalizeBackupChain } from "../utils/modelFallback";
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

/** Legacy keys already reported this session — one console notice per key. */
const reportedLegacySettingKeys = new Set<string>();

const SETTING_SCOPE_FIELDS = ["workspaceFolderValue", "workspaceValue", "globalValue"] as const;

/**
 * Read a setting from the `ensemble.*` namespace, consulting the deprecated
 * `vs-code-ai-helper.*` twin ONLY when no `ensemble.*` value is explicitly
 * configured at any scope.
 *
 * The namespaces are deliberately not interleaved per scope: a leftover
 * legacy workspace value must never shadow an `ensemble.*` value the user
 * just wrote from the Settings UI (which writes global scope) — that
 * shadowing is exactly the "I turned it off and it still runs" failure mode.
 * Leftover legacy values are surfaced with a one-time console notice per
 * key; user settings are never silently deleted.
 */
function readSetting<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  const activeConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const active = activeConfiguration.inspect<T>(key);
  if (SETTING_SCOPE_FIELDS.some((field) => active?.[field] !== undefined)) {
    for (const field of SETTING_SCOPE_FIELDS) {
      if (active?.[field] !== undefined) return active[field] as T;
    }
  } else {
    const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION, resource).inspect<T>(key);
    for (const field of SETTING_SCOPE_FIELDS) {
      if (legacy?.[field] !== undefined) {
        if (!reportedLegacySettingKeys.has(key)) {
          reportedLegacySettingKeys.add(key);
          console.warn(
            `Ensemble: using deprecated setting "${LEGACY_CONFIG_SECTION}.${key}". ` +
              `Move the value to "${CONFIG_SECTION}.${key}" — the legacy key is ignored whenever any "${CONFIG_SECTION}.${key}" value is set.`
          );
        }
        return legacy[field] as T;
      }
    }
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

/**
 * The kinds of automatic AI follow-up a completed operation can start. Each
 * maps to one three-state setting; resolveAutoRunMode below is the single
 * dispatch-time gate every automatic entry point consults (directly, or via
 * the thin mode getters that delegate to it).
 */
export type AutoRunKind =
  | "autoAdvance"
  | "autoReviewAfterPlan"
  | "autoReviewAfterImplementation"
  | "completeAndMoveOn";

/**
 * Single dispatch-time gate for automatic runs (auto-advance, auto-review
 * after plan/implementation, complete-and-move-on triggers). Reads the
 * setting fresh on every call — never cached — so turning an option off in
 * Settings stops the next automatic dispatch at the source.
 *
 * `callerMode` is a chained "auto-fast-forward" request carried on a
 * dispatched command's arg (minted by "Complete & Move On triggers AI:
 * auto-fast-forward"). It is re-validated here rather than trusted: the
 * marker only counts while that originating setting still says
 * "auto-fast-forward", so an arg queued before the user turned the option
 * off cannot resurrect a disabled automation.
 */
export function resolveAutoRunMode(kind: AutoRunKind, callerMode?: AutoTriggerMode): AutoTriggerMode {
  const base =
    kind === "autoAdvance"
      ? readAutoTriggerMode(AUTO_ADVANCE_ENABLED_KEY, "off")
      : kind === "autoReviewAfterPlan"
        ? readAutoTriggerMode(AUTO_REVIEW_AFTER_PLAN_KEY, "off")
        : kind === "autoReviewAfterImplementation"
          ? readAutoTriggerMode(AUTO_REVIEW_AFTER_IMPLEMENTATION_KEY, "off")
          : readAutoTriggerMode(COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY, "auto");
  const revalidatedCallerMode =
    callerMode === "auto-fast-forward" &&
    readAutoTriggerMode(COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY, "auto") === "auto-fast-forward"
      ? callerMode
      : undefined;
  return strongestAutoTriggerMode(base, revalidatedCallerMode);
}

/** Mode for starting the destination stage's AI action after completing a stage. */
export function getCompleteAndMoveOnTriggersAIMode(): AutoTriggerMode {
  return resolveAutoRunMode("completeAndMoveOn");
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
  /**
   * Matched against a failed check's command line — EXACTLY, not as a
   * substring (see `scope` below for the one exception). A monorepo
   * member's command carries a `[packageDir] ` prefix (e.g.
   * `[apps/server] npm run test`); with the default `scope: "exact"`, an
   * entry with `match: "npm run test"` matches ONLY the unprefixed
   * root-level command, never any bracketed member command.
   */
  match: string;
  /** Substring matched against that failed check's combined stdout/stderr. */
  failureSignature: string;
  /** Shown next to the quarantined failure so it stays explainable, not silent. */
  reason: string;
  /**
   * How `match` is compared against a failed command's line:
   *  - `"exact"` (default): the command line must equal `match` exactly.
   *  - `"any-package"`: `match` is compared with any leading
   *    `[packageDir] ` monorepo prefix stripped from the command line first
   *    — so one entry quarantines the same failure signature across every
   *    member package (and the root command) instead of needing one entry
   *    per package. Use this only when the SAME underlying flake genuinely
   *    reproduces the same way in every package; a signature specific to
   *    one package's suite should stay `"exact"` with the full
   *    `[packageDir] ...` command as `match`.
   */
  scope?: "exact" | "any-package";
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
    const scope = entry.scope === "any-package" ? "any-package" : "exact";
    if (match && failureSignature && reason) {
      entries.push({ match, failureSignature, reason, ...(scope === "any-package" ? { scope } : {}) });
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
 * Workflow-resilience feature flags (Stage A of the workflow-resilience
 * backlog). Every flag defaults to the PRE-EXISTING behavior — enabling one
 * is an explicit opt-in per behavior change, so the legacy loop-control
 * semantics stay bit-identical until a user (or a later release flipping the
 * defaults) turns a flag on. Read per-round, never cached, so mid-task
 * changes take effect on the next round.
 */
export interface ResilienceSettings {
  /** 2a: a plateau escalation raised inside a Fast Forward run lets the run
   * finish its attempt budget (escalation reported at the end) instead of
   * aborting it; external pauses still abort. */
  fastForwardSurvivesEscalation: boolean;
  /** 2d: a review round with no parseable `Readiness: N/10` line is recorded
   * as a failed attempt and never appended to reviewScoreHistory. */
  rejectDegenerateReviews: boolean;
  /** 2h: two consecutive reviews with positive zero-task-fixable-blocker
   * evidence terminate Fast Forward as success regardless of score movement. */
  zeroFixableTerminatesFastForward: boolean;
  /** 2f: plateau/stall detection compares blocker identity sets across
   * rounds instead of the score high-water mark. */
  blockerSetPlateau: boolean;
  /** Churn ceiling: escalate after this many consecutive review rounds
   * without a decrease in taskFixableCount (0 = off). */
  churnCeilingRounds: number;
  /** 2b: an implementation round that reports completion with zero file
   * changes — after prior rounds already changed the tree — routes to
   * review/complete instead of failing. */
  nothingToFixRoutesToReview: boolean;
  /** 2c: escalate after this many consecutive implementation rounds that
   * change zero files while the same blocker persists (0 = off). */
  noProgressBreakerRounds: number;
  /** wf10 item 3 / Part 5 step 13: stop and report after this many
   * consecutive `provider-failure-empty` implementation rounds on a stage's
   * ACTIVE FALLBACK provider specifically (keyed to that candidate, not the
   * whole task) — distinct from noProgressBreakerRounds, which counts across
   * any candidate (0 = off). */
  fallbackProviderBreakerRounds: number;
  /** Part 5 step 3: a quota/entitlement failure's provider-reported reset
   * time within this many hours is "near" (remedy text says to rerun after
   * it); beyond it, or unknown, remedy text advises switching models
   * instead. */
  quotaResetNearThresholdHours: number;
  /** Part 7: kill a CLI run's process tree when it has produced no
   * stdout/stderr/raw-transport bytes for this many minutes, distinct from
   * the flat RUN_TIMEOUT_MS wall clock (0 disables the watchdog). */
  inactivityTimeoutMinutes: number;
}

const RESILIENCE_FF_SURVIVES_ESCALATION_KEY = "resilience.fastForwardSurvivesEscalation";
const RESILIENCE_REJECT_DEGENERATE_REVIEWS_KEY = "resilience.rejectDegenerateReviews";
const RESILIENCE_ZERO_FIXABLE_TERMINATES_KEY = "resilience.zeroFixableTerminatesFastForward";
const RESILIENCE_BLOCKER_SET_PLATEAU_KEY = "resilience.blockerSetPlateau";
const RESILIENCE_CHURN_CEILING_ROUNDS_KEY = "resilience.churnCeilingRounds";
const RESILIENCE_NOTHING_TO_FIX_KEY = "resilience.nothingToFixRoutesToReview";
const RESILIENCE_NO_PROGRESS_BREAKER_ROUNDS_KEY = "resilience.noProgressBreakerRounds";
const RESILIENCE_FALLBACK_PROVIDER_BREAKER_ROUNDS_KEY = "resilience.fallbackProviderBreakerRounds";
const RESILIENCE_QUOTA_RESET_NEAR_THRESHOLD_HOURS_KEY = "resilience.quotaResetNearThresholdHours";
const RESILIENCE_INACTIVITY_TIMEOUT_MINUTES_KEY = "resilience.inactivityTimeoutMinutes";

/**
 * Fallbacks for the `ensemble.resilience.*` flags, mirroring the defaults
 * declared in package.json's configuration contribution.
 *
 * In production these are effectively unreachable: readSetting falls through
 * to `configuration.get(key, fallback)`, and VS Code answers that with the
 * schema default whenever the key is unset. They matter for the lightweight
 * configuration adapters used by tests and by non-VS-Code callers, where no
 * schema exists to supply one.
 *
 * They are declared here as named constants, next to the readers, so the two
 * copies of each default are at least visibly paired. They MUST be kept equal
 * to package.json — a fallback that disagrees with the schema means a flag
 * behaves one way in the product and the other way under test, which is the
 * hardest kind of drift to notice.
 *
 * 2026-08-07: flipped from the legacy-off values to on, per the plan's own
 * rollout rule ("flags... become unconditional once a full task has run green
 * under them"). Shipping off meant new users got the configuration that
 * produced the 119-round runaway these flags exist to prevent.
 */
/** @internal exported so a test can pin it against package.json's schema. */
export const RESILIENCE_DEFAULTS = {
  fastForwardSurvivesEscalation: true,
  rejectDegenerateReviews: true,
  zeroFixableTerminatesFastForward: true,
  blockerSetPlateau: true,
  // Ordered deliberately against the default fastForwardMaxIterations (5):
  // the specific breaker fires first (3 zero-change rounds), then the broader
  // churn ceiling (4), then the hard iteration cap. A breaker set at or above
  // that cap can never fire — the loop reaches the cap first, which is the
  // runaway these exist to prevent. resilienceDefaults.test.ts pins the
  // ordering.
  churnCeilingRounds: 4,
  nothingToFixRoutesToReview: true,
  noProgressBreakerRounds: 3,
  // Deliberately lower than noProgressBreakerRounds: a fallback provider is
  // ALREADY a degraded path (the primary already failed once to reach it),
  // so a narrower, faster-tripping breaker on that specific candidate is
  // appropriate — waiting for the broader task-wide breaker to also trip
  // means rerunning into the same known-broken candidate one extra round.
  fallbackProviderBreakerRounds: 2,
  quotaResetNearThresholdHours: 24,
  // 0 = off. Shipped enabled at 15 on 2026-08-16 and disabled the same day:
  // it fired 6 times in one afternoon, every one killing a healthy round that
  // had simply gone quiet while editing a 7,865-line file, and caught zero
  // wedged processes. For scale, the 60-minute wall clock has fired 9 times in
  // 3,320 runs. Losing a round's work is worse than losing 45 minutes, so the
  // default is biased against firing. See the setting's description in
  // package.json, and the note at readInactivityTimeoutMinutes.
  inactivityTimeoutMinutes: 0,
} as const;

function readResilienceRounds(key: string, fallback: number): number {
  const value = readSetting<unknown>(key, fallback);
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(99, numeric));
}

/** Same coercion as readResilienceRounds, but bounded 0-720 to match this
 * setting's own package.json schema (a small-hours-range breaker-rounds cap
 * of 99 would silently clamp a legitimate multi-day threshold). */
function readQuotaResetThresholdHours(key: string, fallback: number): number {
  const value = readSetting<unknown>(key, fallback);
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(720, numeric));
}

/** Same coercion pattern as readResilienceRounds, but bounded 0-180 to match
 * this setting's package.json schema. 0 disables the watchdog entirely. */
/**
 * Minutes of output silence before a CLI run's process tree is killed; 0 = off,
 * which is the shipped default.
 *
 * The watchdog measures the wrong thing, which is why it defaults off. It kills
 * on *output* silence and infers *wedged*, but an agentic CLI reading and
 * editing a large file produces no output for long stretches while working
 * perfectly — silence is what working looks like on a big codebase. A false
 * positive destroys the round's edits (they are quarantined, not banked) and
 * consumes recovery budget; a false negative costs at most the difference
 * between this value and the 60-minute wall clock. The asymmetry says bias
 * hard against firing.
 *
 * The right signal, if this is ever made default-on: no output AND no file
 * writes AND no CPU. Any one alone is noise; together they mean something.
 */
function readInactivityTimeoutMinutes(key: string, fallback: number): number {
  const value = readSetting<unknown>(key, fallback);
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(180, numeric));
}

export function getResilienceSettings(): ResilienceSettings {
  return {
    fastForwardSurvivesEscalation:
      readSetting<unknown>(
        RESILIENCE_FF_SURVIVES_ESCALATION_KEY,
        RESILIENCE_DEFAULTS.fastForwardSurvivesEscalation
      ) === true,
    rejectDegenerateReviews:
      readSetting<unknown>(
        RESILIENCE_REJECT_DEGENERATE_REVIEWS_KEY,
        RESILIENCE_DEFAULTS.rejectDegenerateReviews
      ) === true,
    zeroFixableTerminatesFastForward:
      readSetting<unknown>(
        RESILIENCE_ZERO_FIXABLE_TERMINATES_KEY,
        RESILIENCE_DEFAULTS.zeroFixableTerminatesFastForward
      ) === true,
    blockerSetPlateau:
      readSetting<unknown>(
        RESILIENCE_BLOCKER_SET_PLATEAU_KEY,
        RESILIENCE_DEFAULTS.blockerSetPlateau
      ) === true,
    churnCeilingRounds: readResilienceRounds(
      RESILIENCE_CHURN_CEILING_ROUNDS_KEY,
      RESILIENCE_DEFAULTS.churnCeilingRounds
    ),
    nothingToFixRoutesToReview:
      readSetting<unknown>(
        RESILIENCE_NOTHING_TO_FIX_KEY,
        RESILIENCE_DEFAULTS.nothingToFixRoutesToReview
      ) === true,
    noProgressBreakerRounds: readResilienceRounds(
      RESILIENCE_NO_PROGRESS_BREAKER_ROUNDS_KEY,
      RESILIENCE_DEFAULTS.noProgressBreakerRounds
    ),
    fallbackProviderBreakerRounds: readResilienceRounds(
      RESILIENCE_FALLBACK_PROVIDER_BREAKER_ROUNDS_KEY,
      RESILIENCE_DEFAULTS.fallbackProviderBreakerRounds
    ),
    quotaResetNearThresholdHours: readQuotaResetThresholdHours(
      RESILIENCE_QUOTA_RESET_NEAR_THRESHOLD_HOURS_KEY,
      RESILIENCE_DEFAULTS.quotaResetNearThresholdHours
    ),
    inactivityTimeoutMinutes: readInactivityTimeoutMinutes(
      RESILIENCE_INACTIVITY_TIMEOUT_MINUTES_KEY,
      RESILIENCE_DEFAULTS.inactivityTimeoutMinutes
    ),
  };
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

const PROVIDER_ACCOUNT_LABELS_KEY = "providerAccountLabels";

/**
 * User-declared account/credential labels, keyed by `ProviderAccountId`
 * (the same identity `providerAccountIdForModelId` returns).
 *
 * No CLI provider today exposes which logged-in credential answered a given
 * invocation, so real automatic account detection is not buildable without
 * new per-provider probing infrastructure. This setting is the deliberately
 * minimal alternative: a user running two credentials for the same CLI
 * provider (e.g. two separate `claude-cli` logins in different OS profiles,
 * or a personal vs. work subscription) declares which one is active so the
 * quota ledger and task-park identity (`src/utils/quota.ts`,
 * `src/runners/runnerRegistry.ts`) can key on `providerId + accountLabel +
 * modelId` instead of silently sharing state across two credentials that
 * happen to resolve to the same provider id.
 *
 * Unset (the default) reproduces exactly today's behavior: the resolved
 * account key is the bare `ProviderAccountId`, identical to
 * `providerAccountIdForModelId`'s own return value.
 */
export function getProviderAccountLabels(): Record<string, string> {
  return readSetting<Record<string, string>>(PROVIDER_ACCOUNT_LABELS_KEY, {});
}

export async function setProviderAccountLabel(
  providerAccountId: string,
  label: string | undefined
): Promise<void> {
  const current = getProviderAccountLabels();
  const next = { ...current };
  if (label && label.trim().length > 0) {
    next[providerAccountId] = label.trim();
  } else {
    delete next[providerAccountId];
  }
  await vscode.workspace.getConfiguration(CONFIG_SECTION)
    .update(PROVIDER_ACCOUNT_LABELS_KEY, next, targetFor(PROVIDER_ACCOUNT_LABELS_KEY));
}

/**
 * The account/credential context to key quota ledger and task-park identity
 * on for a given model: `providerAccountIdForModelId`'s result, refined by
 * any user-declared label for that account (see `getProviderAccountLabels`).
 *
 * This is the function quota/park identity call sites should use in place of
 * a bare `providerAccountIdForModelId(modelId)` — it is backward compatible
 * (identical output when no label is configured) but lets two credentials
 * sharing one `ProviderAccountId` stop cross-contaminating each other's
 * quota/entitlement state once the user tells them apart.
 */
export function resolveQuotaAccountKeyV1(modelId: string | undefined): string {
  const accountId = providerAccountIdForModelId(modelId);
  const label = getProviderAccountLabels()[accountId];
  return label ? `${accountId}#${label}` : accountId;
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
  return resolveAutoRunMode("autoAdvance");
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
  return resolveAutoRunMode("autoReviewAfterPlan");
}

/** Mode for auto-review after AI completes initial implementation. */
export function getAutoReviewAfterImplementationMode(): AutoTriggerMode {
  return resolveAutoRunMode("autoReviewAfterImplementation");
}

/** Whether implementation/Fast Forward runs may proceed without prompting when the workspace has unrelated uncommitted changes. */
export function allowsDirtyWorktreeChanges(): boolean {
  return readSetting(ALLOW_DIRTY_WORKTREE_CHANGES_KEY, false);
}

/** Whether native OS notifications fire for things that need attention (questions, warnings, errors). Off by default. */
export function isDesktopNotificationsEnabled(): boolean {
  return readSetting(DESKTOP_NOTIFICATIONS_KEY, false);
}

const SHOW_PROVIDER_ACCOUNT_ACTIONS_KEY = "showProviderAccountActions";

/**
 * Whether the Provider Selection section of the AI Models view shows the
 * per-provider account-action buttons (Sign in / Switch account, Check
 * usage). Hidden by default; toggled only from the VS Code settings UI —
 * there is deliberately no in-view control, and no `vs-code-ai-helper.*`
 * twin for this key.
 */
export function isProviderAccountActionsEnabled(): boolean {
  return readSetting<unknown>(SHOW_PROVIDER_ACCOUNT_ACTIONS_KEY, false) === true;
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
    // normalizeBackupChain keeps the per-row skip flags index-aligned with
    // the backups through the trim/dedup pass, so a dropped entry drops its
    // flag in the same operation.
    const chain = Array.isArray(entry.backups)
      ? normalizeBackupChain(
          entry.backups,
          Array.isArray(entry.backupsEnabled) ? entry.backupsEnabled : undefined,
          (v) => normalizeQualifiedModelId(v)
        )
      : undefined;
    const backups = chain?.backups;
    // Legacy three-way values collapsed onto the one fallback axis. Both
    // former non-switch values deliberately mean the same thing here:
    // preserve the user's no-backup choice while the failure classifier owns
    // the later pause-versus-alert behaviour.
    let strategy: FallbackStrategy = entry.strategy === "switch-to-backup"
      ? "switch-to-backup"
      : "never-switch";
    // Back-compat: the previous checkbox could save strategy:
    // "switch-to-backup" with fallbackEnabled: false. That combination meant
    // "don't use backup" — preserve it on read.
    if (strategy === "switch-to-backup" && entry.fallbackEnabled === false) {
      strategy = "never-switch";
    }
    result[stage] = {
      primary,
      backup,
      backups,
      strategy,
      ...(entry.primaryEnabled === false ? { primaryEnabled: false } : {}),
      ...(chain?.backupsEnabled ? { backupsEnabled: chain.backupsEnabled } : {}),
    };
  }
  // Migrate the older primary-only setting so existing workspaces do not
  // silently lose their configured models when the settings panel is opened.
  // This import applies ONLY to stages with no explicit modelSettings entry:
  // an explicitly saved empty entry (a stage the user cleared in the AI
  // Models view) is an object above and therefore suppresses the legacy
  // value — the read boundary the clear-vs-legacy behavior depends on.
  for (const stage of AI_MODEL_STAGES) {
    if (!result[stage]) {
      const legacy = getAiModelDefault(stage);
      if (legacy) result[stage] = { primary: legacy, strategy: "never-switch" };
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
      // Skip flags travel through the same trim/dedup/cap pass as the
      // backups themselves so the two arrays stay index-aligned.
      const chain = Array.isArray(setting.backups)
        ? normalizeBackupChain(setting.backups, setting.backupsEnabled)
        : undefined;
      const backups = chain?.backups;
      // The legacy `backup` mirror stays equal to backups[0] when the
      // extended shape is present; older callers still read it.
      const backup = backups
        ? backups[0]
        : typeof setting.backup === "string" && setting.backup.trim() ? setting.backup.trim() : undefined;
      // Preserve a configured backup even if strategy isn't switch-to-backup —
      // switching strategy back later shouldn't lose the user's backup choice.
      // Always emit the two-value canonical representation, including when a
      // caller supplied an untyped legacy payload at runtime.
      const strategy: FallbackStrategy = setting.strategy === "switch-to-backup"
        ? "switch-to-backup"
        : "never-switch";
      const entry: StageModelSetting = { ...setting, primary, backup, backups, strategy };
      delete entry.backupsEnabled;
      if (chain?.backupsEnabled) entry.backupsEnabled = chain.backupsEnabled;
      // Skip flags are stored only when they say something (absent = enabled).
      if (entry.primaryEnabled !== false) delete entry.primaryEnabled;
      clean[stage] = entry;
    }
  }
  await config.update(
    MODEL_SETTINGS_KEY,
    clean,
    targetFor(MODEL_SETTINGS_KEY)
  );
}
