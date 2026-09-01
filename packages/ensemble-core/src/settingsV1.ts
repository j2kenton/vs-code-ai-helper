/**
 * Settings shapes (Part 2 port of the value-level contracts in
 * `src/config/settings.ts` and `src/utils/modelFallback.ts`).
 *
 * Only the CANONICAL `ensemble.*` namespace is ported. The deprecated
 * `vs-code-ai-helper.*` twin keys are deliberately NOT represented here —
 * they are a VS Code-side compatibility shim, and porting them would
 * re-introduce the two-namespace shadowing failure mode the extension's
 * reader exists to contain.
 *
 * This module carries shapes, key names, and defaults only — no reader
 * functions, since reading is host-specific (VS Code configuration there,
 * the control-plane settings store here).
 */
import { TaskStage } from "./taskProgressV1";

/** The one canonical settings namespace. */
export const ENSEMBLE_CONFIG_SECTION = "ensemble";

/**
 * Canonical setting keys, relative to the `ensemble.` namespace. Mirrors the
 * extension's declared configuration surface (the keys its
 * `migrateSettingsNamespace` enumerates plus the resilience flags).
 */
export const ENSEMBLE_SETTING_KEYS_V1 = [
  "aiModelDefaults",
  "modelSettings",
  "enabledProviders",
  "fastForwardMaxIterations",
  "autoAdvanceEnabled",
  "autoAdvanceScoreThreshold",
  "autoImplementAfterReview",
  "completeAndMoveOnTriggersAI",
  "fastForwardStopLevel",
  "fastForwardUseAcceptanceThreshold",
  "autoReviewAfterPlan",
  "autoReviewAfterImplementation",
  "maxImplementationIterations",
  "allowDirtyWorktreeChanges",
  "desktopNotifications",
  "publishVerificationCommands",
  "knownFlakyChecks",
  "reviewPlateauRounds",
  "completionCheckTimeoutMs",
  "warnings.unsavedSettings",
  "warnings.largeTokenRequest",
  "resilience.fastForwardSurvivesEscalation",
  "resilience.rejectDegenerateReviews",
  "resilience.zeroFixableTerminatesFastForward",
  "resilience.blockerSetPlateau",
  "resilience.churnCeilingRounds",
  "resilience.nothingToFixRoutesToReview",
  "resilience.noProgressBreakerRounds",
] as const;

export type EnsembleSettingKeyV1 = (typeof ENSEMBLE_SETTING_KEYS_V1)[number];

/**
 * Three-state automation mode shared by the auto-review / auto-advance /
 * complete-and-move-on settings.
 */
export type AutoTriggerMode = "off" | "auto" | "auto-fast-forward";

/** The kinds of automatic AI follow-up a completed operation can start. */
export type AutoRunKind =
  | "autoAdvance"
  | "autoReviewAfterPlan"
  | "autoReviewAfterImplementation"
  | "completeAndMoveOn";

/** What happens when a stage's primary model is unavailable. */
export type FallbackStrategy = "switch-to-backup" | "never-switch";

/** Per-stage model configuration (see `src/utils/modelFallback.ts`). */
export interface StageModelSetting {
  primary?: string;
  /** Ordered alternatives tried after the primary. `backup` is retained for migration. */
  backups?: string[];
  backup?: string;
  /** false = skip the primary during resolution while keeping its configured model. */
  primaryEnabled?: boolean;
  /** Per-row skip flags, index-aligned with `backups`. Absent means enabled. */
  backupsEnabled?: boolean[];
  strategy: FallbackStrategy;
}

/** `ensemble.modelSettings` — per-stage model configuration. */
export type ModelSettings = Partial<Record<TaskStage, StageModelSetting>>;

/** `ensemble.aiModelDefaults` — per-stage default model ids. */
export type AiModelDefaults = Partial<Record<TaskStage, string>>;

/** `ensemble.enabledProviders` — explicit provider opt-in map. */
export type EnabledProviders = Record<string, boolean>;

/** One quarantined known-flaky-check entry (`ensemble.knownFlakyChecks`). */
export interface KnownFlakyCheck {
  /** Substring matched against a failed check's command line. */
  match: string;
  /** Substring matched against that failed check's combined stdout/stderr. */
  failureSignature: string;
  /** Shown next to the quarantined failure so it stays explainable, not silent. */
  reason: string;
}

/** Workflow-resilience feature flags (`ensemble.resilience.*`). */
export interface ResilienceSettings {
  fastForwardSurvivesEscalation: boolean;
  rejectDegenerateReviews: boolean;
  zeroFixableTerminatesFastForward: boolean;
  blockerSetPlateau: boolean;
  /** 0 = off. */
  churnCeilingRounds: number;
  nothingToFixRoutesToReview: boolean;
  /** 0 = off. */
  noProgressBreakerRounds: number;
}

/**
 * Resilience defaults, kept equal to the extension's `RESILIENCE_DEFAULTS`
 * (and to package.json's configuration schema there).
 */
export const RESILIENCE_DEFAULTS: ResilienceSettings = {
  fastForwardSurvivesEscalation: true,
  rejectDegenerateReviews: true,
  zeroFixableTerminatesFastForward: true,
  blockerSetPlateau: true,
  churnCeilingRounds: 4,
  nothingToFixRoutesToReview: true,
  noProgressBreakerRounds: 3,
};
