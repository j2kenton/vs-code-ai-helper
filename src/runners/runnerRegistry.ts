import * as vscode from "vscode";
import {
  AgentAvailability,
  AgentRunner,
  AgentRunResult,
} from "../types/agentRunner";
import { AttemptIdV1 } from "../types/actionCorrelationV1";
import { AgentExecutionModeV1, AgentTransportV1 } from "../types/agentExecutionV1";
import { ProviderReservationHandleV1 } from "../types/providerReservationV1";
import { ProviderSelectionSessionV1 } from "../services/providerSelectionPolicyV1";
import {
  CopilotLanguageModelRunner,
  createCopilotLmTextTransportV1,
} from "./copilotLanguageModelRunner";
import {
  checkImplementationAvailability,
  ImplementationRunResult,
  runImplementationWithCopilot,
} from "./copilotImplementationRunner";
import {
  CliAgentRunner,
  cliCommandExists,
  cliProviderSupportsV1StdoutCapture,
  createCliTextTransportV1,
  isCliTextModeSummaryOnlyCapableV1,
  runImplementationWithCli,
} from "./cliAgentRunner";
import {
  cliDisplayLabel,
  CliProviderDefinition,
  getCliProvider,
  getProviderAccountEntry,
  normalizeQualifiedModelId,
  parseModelSelection,
  providerAccountIdForModelId,
  ProviderId,
} from "./providers";
import {
  getResilienceSettings,
  isModelProviderEnabled,
  isProviderSelectionConfigured,
  resolveQuotaAccountKeyV1,
} from "../config/settings";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { candidateHasRecentZeroFileFailuresV1 } from "../utils/fallbackProviderBreakerV1";
import {
  describeStageSubstitutesV1,
  resolveEffectiveStageChainV1,
} from "../utils/modelSelection";
import {
  buildQuotaRemedyTextV1,
  getQuotaLedgerEntry,
  getQuotaObservation,
  isAuthenticationFailure,
  isCascadeEligibleFailureKind,
  isQuotaResetBeyondThresholdV1,
  parseQuotaResetV1,
  recordQuotaObservation,
} from "../utils/quota";
import { getExtensionContextV1 } from "../utils/extensionContextV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import {
  clearQuotaParkV1,
  clearStageFallbackReservation,
  QuotaParkClearingIdentityV1,
  recordQuotaParkV1,
} from "../utils/taskProgressTransforms";
import { createCopilotLmToolSessionTransportV1 } from "../services/languageModelToolSessionV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";
import { RoundOutcomeEntryV1, TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  ProviderChainCandidateStatusV1,
  ProviderChainExhaustionV1,
} from "../types/taskActionOutcomeV1";
import { assertNoUnauthorizedV1CorrelationV0 } from "../services/legacyAiActionSafetyGateV0";

type EffectiveProvider =
  | { kind: "copilot"; model: string | undefined }
  | { kind: "cli"; def: CliProviderDefinition; model: string | undefined };

/**
 * Resolve which provider actually handles a stage's stored model ID.
 *
 * An explicit provider-qualified ID (e.g. "claude-cli:sonnet") always wins.
 * A bare/legacy ID always means Copilot (pre-provider behavior — those IDs
 * came from vscode.lm before other providers existed). When no stage model
 * is configured at all (modelId undefined, i.e. resolveModelForStage
 * returned "source: none"), Copilot is preferred if it has any models
 * available, but falls back to the first installed CLI provider — so a
 * CLI-only setup (no Copilot subscription) works without the user first
 * visiting the model picker. This is what makes "at least one of Copilot /
 * Claude Code / Codex / Gemini / Antigravity / Kiro" (see README) actually
 * hold without extra
 * configuration.
 *
 * Shared by resolveRunnerForModel (plan/review) and the two implementation
 * entry points below so all three "with AI" paths auto-detect the same way.
 */
/**
 * Runner-entry guard: a model belonging to a provider the user has disabled
 * in Provider Selection must never run, no matter which code path resolved
 * it (stage command, chat, implementation, backup fallback). The stored
 * model id itself is preserved untouched; only running it is refused. The
 * guard is active only once a provider selection actually exists — a fresh
 * pre-migration state (no enabledProviders value in any scope) blocks
 * nothing, matching migrateEnabledProvidersForExistingModels's semantics.
 * Mirrors the command-level ensureStageModelConfigured guard, which
 * additionally opens the AI Models view; this one is the last line of
 * defense for paths that never went through a guarded command entry point.
 */
function isModelProviderDisabled(modelId: string | undefined): boolean {
  // Copilot is not exempt: isProviderEnabled treats it as enabled unless the
  // user explicitly disables it in Provider Selection.
  return isProviderSelectionConfigured() && !isModelProviderEnabled(modelId);
}

/**
 * Also exported for `runEditActionV1.ts`'s §7.5 availability checks and
 * `runImplementationOrSealedV1`'s routing decision: an edit-capable action's
 * stage model must resolve to SOME runnable path before the action may
 * begin any task or source read — Copilot's sealed pipeline, or a CLI
 * provider's own direct edit-mode invocation.
 */
export function resolveEffectiveProvider(
  modelId: string | undefined
): EffectiveProvider {
  const parsed = parseModelSelection(modelId);
  if (parsed.provider !== "copilot") {
    const def = getCliProvider(parsed.provider);
    if (def) {
      if (isModelProviderDisabled(modelId)) {
        const account = getProviderAccountEntry(providerAccountIdForModelId(modelId));
        throw new Error(
          `The selected model ("${modelId}") belongs to ${account?.label ?? def.label}, which is disabled in Provider Selection. ` +
            "Enable the provider or choose another model in AI Models."
        );
      }
      return { kind: "cli", def, model: parsed.model };
    }
  }

  if (modelId !== undefined) {
    // The SAME provider-selection guard the CLI branch above applies. It was
    // missing here, which made `isModelProviderDisabled`'s own "Copilot is not
    // exempt" comment false in practice: the function was simply never called
    // on this branch, so a stage with Copilot disabled still resolved to
    // Copilot and invoked it. Observed 2026-08-18 (workflow 5 runs 060/061):
    // every entry in the impl chain was disabled, a window reload ruled out
    // stale config, and the round still ran `Provider: Copilot (auto)`.
    //
    // `parseModelSelection` funnels every unrecognized id here as
    // `provider: "copilot"`, so this check always resolves the "copilot"
    // account — which `isProviderEnabled` treats as enabled unless explicitly
    // disabled. No other account can be affected by this branch.
    if (isModelProviderDisabled(modelId)) {
      const account = getProviderAccountEntry(providerAccountIdForModelId(modelId));
      throw new Error(
        `The selected model ("${modelId}") belongs to ${account?.label ?? "Copilot"}, which is disabled in Provider Selection. ` +
          "Enable the provider or choose another model in AI Models."
      );
    }
    // Explicit (legacy/bare) selection — always Copilot, never silently
    // redirected to a different provider.
    return { kind: "copilot", model: parsed.model };
  }

  throw new Error("No model is configured for this stage. Open Settings and select a primary model.");
}

export interface ResolvedRunner {
  runner: AgentRunner;
  provider: ProviderId;
  /** Short display name for user-facing messages ("Copilot", "Claude Code"…). */
  providerLabel: string;
  /**
   * The provider-native model identifier to pass in AgentRunRequest.modelId
   * (undefined = provider default). Stored IDs are provider-qualified; this
   * is the unqualified form each runner actually understands.
   */
  nativeModelId: string | undefined;
}

export interface RunnerAvailability {
  availability: AgentAvailability;
  providerLabel: string;
  provider: ProviderId;
  modelId: string | undefined;
  nativeModelId: string | undefined;
}

function toResolvedRunner(effective: EffectiveProvider): ResolvedRunner {
  if (effective.kind === "cli") {
    return {
      runner: new CliAgentRunner(effective.def),
      provider: effective.def.id,
      providerLabel: effective.def.label,
      nativeModelId: effective.model,
    };
  }
  return {
    runner: new CopilotLanguageModelRunner(),
    provider: "copilot",
    providerLabel: "Copilot",
    nativeModelId: effective.model,
  };
}

/** Drop backup candidates whose provider is disabled so a fallback can never
 * route around the runner-entry guard above. */
function filterEnabledBackupModels(models: readonly string[]): string[] {
  return models.filter(
    (candidate) => !isModelProviderDisabled(candidate)
  );
}

/**
 * Configured backup models for a stage, excluding `modelId` itself and any
 * provider currently disabled — but ONLY when the stage's fallback strategy
 * is "switch-to-backup" (the quota-triggered automatic switch-over opt-in).
 * A stage configured with "pause-and-resume" or "alert-and-wait" returns
 * nothing here, by design: those strategies mean the user explicitly does
 * NOT want an automatic provider swap on quota failure.
 *
 * Do not reuse this for a different question than "should a quota failure
 * silently switch providers" — see getConfiguredBackupModelsForStage below
 * for "what alternate models are configured for this stage at all",
 * independent of that strategy choice.
 */
export function backupModelsForStage(
  stage: TaskStage | undefined,
  modelId: string | undefined
): string[] {
  if (!stage) {
    return [];
  }
  // The effective chain resolver applies skip flags and lets a blank stage
  // inherit the general model's backups AND its strategy; the strategy gate
  // therefore applies to whichever chain is actually in effect.
  const chain = resolveEffectiveStageChainV1(stage);
  if (chain.strategy !== "switch-to-backup") {
    return [];
  }
  const primary = normalizeQualifiedModelId(modelId);
  const seen = new Set<string>();
  return filterEnabledBackupModels(chain.backups).filter((candidate) => {
    const normalized = normalizeQualifiedModelId(candidate);
    if (normalized === primary || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

/**
 * Every configured backup model for a stage, excluding `modelId` itself and
 * any provider currently disabled — regardless of the stage's fallback
 * strategy. Exported for the deliberate second-opinion mechanism in
 * reviewActions.ts: when review-score iteration plateaus, one round is run
 * against a different model from this list, turning what used to be an
 * accidental quota-fallback reviewer swap into an intentional check.
 *
 * Deliberately does NOT gate on `strategy === "switch-to-backup"` the way
 * backupModelsForStage does: a user who configured backups under
 * "pause-and-resume" or "alert-and-wait" has explicitly opted OUT of
 * automatic quota switch-over, but still has models genuinely available —
 * gating a plateau-triggered second opinion on that unrelated setting would
 * silently make the mechanism inert (always "no alternate model was
 * available") for anyone who made that choice.
 */
export function getConfiguredBackupModelsForStage(
  stage: TaskStage | undefined,
  modelId: string | undefined
): string[] {
  if (!stage) {
    return [];
  }
  // Same effective chain as backupModelsForStage (skip flags applied, blank
  // stage inheriting the general chain) — but deliberately WITHOUT that
  // helper's strategy gate, per the contrast documented above.
  return filterEnabledBackupModels(
    resolveEffectiveStageChainV1(stage).backups.filter(candidate => candidate !== modelId)
  );
}

export async function checkRunnerAvailabilityForModel(
  modelId: string | undefined,
  stage?: TaskStage
): Promise<RunnerAvailability> {
  const resolved = toResolvedRunner(resolveEffectiveProvider(modelId));
  const primaryAvailability = await resolved.runner.isAvailable();
  const primary: RunnerAvailability = {
    availability: primaryAvailability,
    providerLabel: resolved.providerLabel,
    provider: resolved.provider,
    modelId,
    nativeModelId: resolved.nativeModelId,
  };

  if (
    primaryAvailability.available ||
    isAuthenticationFailure(primaryAvailability.reason)
  ) {
    return primary;
  }

  for (const backupModel of backupModelsForStage(stage, modelId)) {
    const fallback = toResolvedRunner(resolveEffectiveProvider(backupModel));
    const fallbackAvailability = await fallback.runner.isAvailable();
    const candidate: RunnerAvailability = {
      availability: fallbackAvailability,
      providerLabel: fallback.providerLabel,
      provider: fallback.provider,
      modelId: backupModel,
      nativeModelId: fallback.nativeModelId,
    };
    if (
      fallbackAvailability.available ||
      isAuthenticationFailure(fallbackAvailability.reason)
    ) {
      return candidate;
    }
  }

  return primary;
}

/**
 * Persist which model actually served a stage after a fallback, so a later
 * `resolveModelForStage` call honoring `fallbackActive` (e.g. a subsequent
 * Fast Forward iteration passing `preserveActiveFallback`) routes straight to
 * the known-working model instead of re-paying the cost of a known-flaky
 * primary.
 */
export async function recordActiveFallbackModel(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  modelId: string,
  options: {
    /** Decline the write if a newer review attempt now owns the stage. */
    expectedReviewAttemptId?: string;
    /** Claim and record in one locked write; decline an unrelated reservation. */
    requireUnreserved?: boolean;
    /**
     * When `requireUnreserved` is set, still allow replacing the active route
     * if it names the model this call intentionally started from. An active
     * reservation without a model id is also replaceable: that is the
     * intermediate state written by reserveFallback before a working backup
     * has been identified. A different named model continues to win.
     */
    replaceActiveModelId?: string;
  } = {}
): Promise<boolean> {
  let recorded = false;
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (
      options.expectedReviewAttemptId !== undefined &&
      current.reviewAttemptId !== options.expectedReviewAttemptId
    ) {
      return current;
    }
    if (options.requireUnreserved && current.fallbackActive?.[stage]) {
      const activeModelId = current.fallbackModelId?.[stage];
      if (
        options.replaceActiveModelId === undefined ||
        (activeModelId !== undefined &&
          normalizeQualifiedModelId(activeModelId) !==
            normalizeQualifiedModelId(options.replaceActiveModelId))
      ) {
        return current;
      }
    }
    recorded = true;
    return {
      ...current,
      fallbackActive: {
        ...current.fallbackActive,
        [stage]: true,
      },
      fallbackModelId: {
        ...current.fallbackModelId,
        [stage]: modelId,
      },
    };
  });
  return recorded;
}

/**
 * Whether a run result is fresh evidence that a prior task-level
 * `quotaParkRecord` block has resolved: either the run succeeded outright,
 * or it failed with a classified, contradicting kind. A cancelled run (or a
 * failed run with no `failureKind` classification) proves nothing about
 * whether the block resolved, so it must not clear the record.
 */
function isQuotaParkClearingEvidence(result: {
  status: "completed" | "failed" | "cancelled";
  failureKind?: "quota" | "temporarily-unavailable" | "model-entitlement" | "generic";
}): boolean {
  return (
    result.status === "completed" ||
    (result.status === "failed" &&
      result.failureKind !== undefined &&
      result.failureKind !== "quota" &&
      result.failureKind !== "model-entitlement")
  );
}

/**
 * Identity of the given model/provider for `quotaParkRecord` clearing
 * comparisons, mirroring exactly how a park record's own `providerId`/
 * `accountKey` are stamped at creation time (see the withheld-backup branch
 * further below). Returns `undefined` if the model can no longer be resolved
 * (e.g. its provider was disabled between resolution and this run) — callers
 * treat that as "cannot prove a match" and skip clearing rather than clear
 * unconditionally.
 */
function computeQuotaParkIdentityV1(
  modelId: string | undefined,
  // Pre-dispatch-resolved account key, when the caller already has one (see
  // `recordQuotaObservation`'s `accountKeyOverride` doc comment for why this
  // matters) — avoids re-resolving `ensemble.providerAccountLabels` from
  // live settings after the run this identity describes has already
  // completed.
  accountKeyOverride?: string
): QuotaParkClearingIdentityV1 | undefined {
  try {
    const effective = resolveEffectiveProvider(modelId);
    return {
      providerId: String(effective.kind === "cli" ? effective.def.id : "copilot"),
      modelId: modelId ?? "(default)",
      accountKey: accountKeyOverride ?? resolveQuotaAccountKeyV1(modelId),
    };
  } catch {
    // Best-effort quota-park bookkeeping only — an unresolvable provider
    // just means there is no park identity to clear, not a run failure.
    return undefined;
  }
}

/**
 * Records a run's quota/entitlement observation and — when the result is
 * fresh evidence the block resolved (`isQuotaParkClearingEvidence`) — clears
 * a matching task-level `quotaParkRecord` for that exact model/provider/
 * account identity. `withQuotaObservation` already does this for the
 * no-backup and stage-less paths; this is the same logic factored out so the
 * backup-configured branch of `resolveRunnerForModel` (which dispatches the
 * primary and each backup directly, not through `withQuotaObservation`) gets
 * identical park-clearing behavior instead of only updating the session/
 * global ledger. Review completion blocker: previously only the ledger was
 * updated here, so a successful or contradicting retry through this branch
 * never cleared a stale park banner even though the no-backup branch did.
 */
async function recordQuotaObservationAndClearParkV1(
  stage: TaskStage,
  modelId: string | undefined,
  result: Pick<AgentRunResult, "status" | "failureKind" | "errorMessage">,
  taskFolderUri: vscode.Uri | undefined,
  accountKey: string | undefined
): Promise<void> {
  await recordQuotaObservation(
    stage,
    modelId,
    result.failureKind,
    result.errorMessage,
    getExtensionContextV1(),
    undefined,
    accountKey
  );
  const identity = computeQuotaParkIdentityV1(modelId, accountKey);
  if (taskFolderUri && identity && isQuotaParkClearingEvidence(result)) {
    await patchTaskProgressStrictV1(taskFolderUri, (current) =>
      clearQuotaParkV1(current, identity)
    );
  }
}

function withQuotaObservation(
  runner: AgentRunner,
  stage: TaskStage,
  modelId: string | undefined,
  taskFolderUri?: vscode.Uri
): AgentRunner {
  return {
    id: runner.id,
    label: runner.label,
    capabilities: runner.capabilities,
    isAvailable: () => runner.isAvailable(),
    async run(request, token): Promise<AgentRunResult> {
      assertNoUnauthorizedV1CorrelationV0(request);
      // Captured BEFORE dispatch so a label edit made while this run is in
      // flight cannot make the ledger write below and the park-clearing
      // identity disagree about which account this one attempt belongs to.
      const accountKey = resolveQuotaAccountKeyV1(modelId);
      const result = await runner.run(request, token);
      await recordQuotaObservationAndClearParkV1(stage, modelId, result, taskFolderUri, accountKey);
      return result;
    },
  };
}

/**
 * Regression coverage for a review finding: the stage-less branch of
 * `resolveRunnerForModel` returned the raw runner from `toResolvedRunner`
 * untouched, so a caller that never passes `stage` (historically
 * `runSecondOpinionReview` in reviewActions.ts and the Global Assistant in
 * openGeneralAssistant.ts — both call sites were later removed entirely
 * during the Cleanup cohort's disposition of those two routes, see
 * legacyAiActionSafetyGateV0.ts's file header) reached the concrete
 * `CliAgentRunner`/`CopilotLanguageModelRunner` `.run()` directly — bypassing
 * `assertNoUnauthorizedV1CorrelationV0` entirely, not merely being subject to
 * it. `withQuotaObservation` and the backup-model wrapper below both already
 * assert before delegating; this gives the stage-less path the identical
 * guarantee so EVERY exit of this function enforces the same boundary, per
 * the plan's "shared runner/provider boundary ... rejects ... any legacy
 * (uncorrelated) request" rule (plan §1.3) with no caller-shape exemption —
 * kept even though no production caller of this branch remains today, since
 * `resolveRunnerForModel`/`AgentRunner.run()` stays retained, tested legacy
 * infrastructure (plan §3.4: "No supported text runner silently disappears").
 */
function withUnauthorizedV1CorrelationBackstop(runner: AgentRunner): AgentRunner {
  return {
    id: runner.id,
    label: runner.label,
    capabilities: runner.capabilities,
    isAvailable: () => runner.isAvailable(),
    async run(request, token): Promise<AgentRunResult> {
      assertNoUnauthorizedV1CorrelationV0(request);
      return runner.run(request, token);
    },
  };
}

/**
 * Atomic/durable fallback switcher to ensure we only switch to the backup
 * model once per stage epoch, preventing concurrent duplicate runs from both
 * consuming the backup.
 */
async function reserveFallback(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  expectedReviewAttemptId?: string
): Promise<boolean> {
  let activated = false;
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (
      expectedReviewAttemptId !== undefined &&
      current.reviewAttemptId !== expectedReviewAttemptId
    ) {
      return current;
    }
    if (current.fallbackActive?.[stage]) {
      return current;
    }
    activated = true;
    const fallbackModelId = { ...current.fallbackModelId };
    delete fallbackModelId[stage];
    return {
      ...current,
      fallbackActive: {
        ...current.fallbackActive,
        [stage]: true,
      },
      fallbackModelId: Object.keys(fallbackModelId).length > 0
        ? fallbackModelId
        : undefined,
    };
  });
  return activated;
}

/**
 * Release the short-lived fallback reservation when no backup actually
 * completed. `reserveFallback` writes an active flag before a backup starts
 * so concurrent runs cannot spend the same backup allocation. That flag must
 * not outlive a failed, cancelled, or unauthenticated backup: model resolution
 * would otherwise treat the failed backup as the stage's preferred route.
 *
 * A named fallback model is retained deliberately. It can only have been
 * written after a completed backup, either by this run or a concurrent run
 * that won the reservation, and is therefore a valid route to preserve.
 */
async function releaseUnresolvedFallbackReservation(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  expectedReviewAttemptId?: string
): Promise<void> {
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (
      expectedReviewAttemptId !== undefined &&
      current.reviewAttemptId !== expectedReviewAttemptId
    ) {
      return current;
    }
    if (!current.fallbackActive?.[stage] || current.fallbackModelId?.[stage]) {
      return current;
    }
    return clearStageFallbackReservation(current, stage);
  });
}

/**
 * Resolve the runner responsible for a stored stage model ID (plan/review
 * stages — see resolveEffectiveProvider for the auto-detection rules).
 * `expectedReviewAttemptId` makes fallback reservation and routing writes
 * conditional on that review still owning the stage after a long provider
 * call; callers without review-attempt ownership leave it undefined.
 */
export function resolveRunnerForModel(
  modelId: string | undefined,
  stage?: TaskStage,
  taskFolderUri?: vscode.Uri,
  expectedReviewAttemptId?: string
): ResolvedRunner {
  const resolved = toResolvedRunner(resolveEffectiveProvider(modelId));
  if (!stage) {
    return { ...resolved, runner: withUnauthorizedV1CorrelationBackstop(resolved.runner) };
  }
  const primary = resolved.runner;
  // Record what every run reveals about this stage+model's quota state
  // (session-observed only — see utils/quota.ts for why a numeric percentage
  // isn't offered) so the settings webview can show real, non-fabricated
  // telemetry instead of a permanent placeholder.
  const instrumented = withQuotaObservation(primary, stage, modelId, taskFolderUri);
  const backupModels = backupModelsForStage(stage, modelId);
  if (backupModels.length === 0) {
    return { ...resolved, runner: instrumented };
  }
  return {
    ...resolved,
    runner: {
      id: instrumented.id,
      label: instrumented.label,
      capabilities: instrumented.capabilities,
      isAvailable: async () =>
        (await checkRunnerAvailabilityForModel(modelId, stage)).availability,
      async run(request, token): Promise<AgentRunResult> {
        assertNoUnauthorizedV1CorrelationV0(request);
        const runBackups = async (): Promise<AgentRunResult> => {
          const releaseReservation = (): Promise<void> =>
            releaseUnresolvedFallbackReservation(
              taskFolderUri ?? request.taskFolderUri,
              stage,
              expectedReviewAttemptId
            );
          let last: AgentRunResult | undefined;
          for (const backupModel of backupModels) {
            // Captured before this backup's own availability check/dispatch —
            // same rationale as the primary's `accountKey` above: keeps this
            // one attempt's ledger identity fixed even if the label setting
            // changes while the backup is in flight.
            const backupAccountKey = resolveQuotaAccountKeyV1(backupModel);
            const fallback = toResolvedRunner(resolveEffectiveProvider(backupModel));
            const fallbackAvailability = await fallback.runner.isAvailable();
            if (!fallbackAvailability.available) {
              last = {
                runnerId: fallback.runner.id,
                status: "failed",
                failureKind: isAuthenticationFailure(fallbackAvailability.reason)
                  ? "generic"
                  : "temporarily-unavailable",
                errorMessage: fallbackAvailability.reason ?? "Backup model is unavailable.",
              };
              await recordQuotaObservationAndClearParkV1(
                stage,
                backupModel,
                last,
                taskFolderUri ?? request.taskFolderUri,
                backupAccountKey
              );
              if (isAuthenticationFailure(fallbackAvailability.reason)) {
                await releaseReservation();
                return last;
              }
              continue;
            }
            const fallbackResult = await fallback.runner.run({ ...request, modelId: fallback.nativeModelId }, token);
            await recordQuotaObservationAndClearParkV1(
              stage,
              backupModel,
              fallbackResult,
              taskFolderUri ?? request.taskFolderUri,
              backupAccountKey
            );
            last = fallbackResult;
            if (fallbackResult.status === "completed") {
              await recordActiveFallbackModel(
                taskFolderUri ?? request.taskFolderUri,
                stage,
                backupModel,
                { expectedReviewAttemptId }
              );
              return fallbackResult;
            }
            // A generic failure (including an auth error) and a user
            // cancellation are terminal for this run, but neither makes this
            // backup a known-good route for later runs.
            if (
              fallbackResult.status === "cancelled" ||
              !isCascadeEligibleFailureKind(fallbackResult.failureKind)
            ) {
              await releaseReservation();
              return fallbackResult;
            }
          }
          await releaseReservation();
          return last ?? { runnerId: primary.id, status: "failed", failureKind: "temporarily-unavailable", errorMessage: "No backup model is available." };
        };
        const availability = await primary.isAvailable();
        // Never spend a backup allocation on credentials/configuration errors.
        // Providers commonly report these as plain HTTP status text.
        const authenticationFailure = isAuthenticationFailure(availability.reason);
        if (!availability.available && !authenticationFailure) {
          const folder = taskFolderUri ?? request.taskFolderUri;
          if (folder && await reserveFallback(folder, stage, expectedReviewAttemptId)) {
            return runBackups();
          }
          return { runnerId: primary.id, status: "failed", failureKind: "temporarily-unavailable", errorMessage: availability.reason ?? "Model is temporarily unavailable." };
        }
        // Captured before this attempt's own dispatch — same rationale as
        // `primaryAccountKey` in withQuotaObservation above: keeps this run's
        // ledger identity fixed even if the label setting changes mid-run.
        const primaryRunAccountKey = resolveQuotaAccountKeyV1(modelId);
        const result = await primary.run(request, token);
        await recordQuotaObservationAndClearParkV1(
          stage,
          modelId,
          result,
          taskFolderUri ?? request.taskFolderUri,
          primaryRunAccountKey
        );
        if (!isCascadeEligibleFailureKind(result.failureKind)) {
          return result;
        }

        const folder = taskFolderUri ?? request.taskFolderUri;
        if (!folder) {
          return result;
        }
        const reserved = await reserveFallback(folder, stage, expectedReviewAttemptId);
        if (!reserved) {
          return result;
        }

        return runBackups();
      },
    },
  };
}

/**
 * Availability check for an implementation (code-editing) run with the
 * provider a stage's model ID selects (or auto-detects — see
 * resolveEffectiveProvider).
 */
export async function checkImplementationAvailabilityForModel(
  modelId: string | undefined,
  stage?: TaskStage,
  /**
   * wf10 review fix (Part 5 steps 13-14, narrowed blocker 1): when supplied
   * (only `runImplementationOrSealedV1`'s own pre-dispatch resolution does),
   * the backup walk below also skips a CLI backup with a recent record of
   * zero-file rounds — the same health window `runImplementationForModel`'s
   * own internal cascade already reads, just applied one step earlier, since
   * THIS walk is what actually decides which candidate an implementation
   * round dispatches to. Every other caller (informational availability
   * checks, gate probes) omits it and keeps the prior behavior unchanged.
   */
  taskFolderUri?: vscode.Uri
): Promise<RunnerAvailability> {
  const check = async (
    storedModelId: string | undefined,
    effective: EffectiveProvider
  ): Promise<RunnerAvailability> => {
    if (effective.kind === "copilot") {
      return {
        availability: await checkImplementationAvailability(),
        providerLabel: "Copilot",
        provider: "copilot",
        modelId: storedModelId,
        nativeModelId: effective.model,
      };
    }
    const { def } = effective;
    const exists = await cliCommandExists(def.command, def.commandAliases);
    return {
      availability: exists
        ? { available: true }
        : {
            available: false,
            reason: `The ${cliDisplayLabel(def)} CLI (${def.command}) is not installed. ${def.installHint}`,
          },
      providerLabel: def.label,
      provider: def.id,
      modelId: storedModelId,
      nativeModelId: effective.model,
    };
  };

  const primary = await check(modelId, resolveEffectiveProvider(modelId));
  if (
    primary.availability.available ||
    isAuthenticationFailure(primary.availability.reason)
  ) {
    return primary;
  }

  // Read once, outside the loop — a per-candidate read would re-fetch the
  // identical file once per backup for no benefit. Best-effort: an
  // unreadable progress file must never block a fallback walk that would
  // otherwise work. Mirrors `runImplementationForModel`'s own internal
  // cascade (runnerRegistry.ts, further below in this file).
  const breakerRounds = getResilienceSettings().fallbackProviderBreakerRounds;
  let roundOutcomesForHealthCheck: RoundOutcomeEntryV1[] | undefined;
  if (taskFolderUri && stage && breakerRounds > 0) {
    try {
      const progressRead = await readTaskProgressStrictV1(taskFolderUri);
      roundOutcomesForHealthCheck = progressRead.ok ? progressRead.decoded.progress.roundOutcomes : undefined;
    } catch {
      roundOutcomesForHealthCheck = undefined;
    }
  }

  for (const backupModel of backupModelsForStage(stage, modelId)) {
    const backupEffective = resolveEffectiveProvider(backupModel);
    // wf10 item 3 / Part 5 step 13: never let AUTOMATIC edit-capable backup
    // selection land on Copilot's sealed two-phase preflight pipeline
    // (runSealedImplementationV1/runTwoPhaseEditActionV1) — observed on both
    // wf9 and jester walking exactly this chain (a live CLI primary quota-
    // exhausted, its CLI backup ALSO quota-dead, landing on a bare/legacy
    // model id that resolves to Copilot) onto a path that reliably reported
    // "available" while reliably producing zero-file rounds. A user who
    // deliberately CONFIGURES Copilot as the stage's PRIMARY is unaffected —
    // this only excludes it from the unattended backup walk; `primary`
    // above is checked before this loop runs and never goes through it.
    if (backupEffective.kind === "copilot") {
      continue;
    }
    // wf10 review fix (Part 5 steps 13-14, narrowed blocker 1/2): this walk
    // is what actually resolves the candidate `runImplementationOrSealedV1`
    // dispatches to — a candidate that "reports available" but has a recent
    // record of zero-file rounds must not be walked back onto here, exactly
    // the same health window the runtime cascade further below already
    // applies to ITS OWN backup loop.
    if (
      breakerRounds > 0 &&
      stage !== undefined &&
      candidateHasRecentZeroFileFailuresV1(
        roundOutcomesForHealthCheck,
        stage,
        backupModel,
        breakerRounds,
        backupEffective.def.id
      )
    ) {
      continue;
    }
    const fallback = await check(backupModel, backupEffective);
    if (
      fallback.availability.available ||
      isAuthenticationFailure(fallback.availability.reason)
    ) {
      return fallback;
    }
  }

  return primary;
}

/**
 * Run an agentic implementation with whichever provider the stage's model
 * ID selects (or auto-detects): Copilot uses the LM API tool-calling loop;
 * CLI providers edit the workspace directly with edit-level permissions.
 */
export async function runImplementationForModel(options: {
  modelId: string | undefined;
  prompt: string;
  workspaceUri: vscode.Uri;
  token: vscode.CancellationToken;
  onProgress: (message: string) => void;
  stage?: TaskStage;
  taskFolderUri?: vscode.Uri;
  /** See runImplementationWithCli — default true; pass false when the
   * prompt may legitimately be answered without an edit. Copilot's runner
   * has no equivalent no-op failure, so this only affects CLI providers. */
  requireFileChange?: boolean;
  onBusyDetail?: (detail: string | undefined) => void;
  onWaitingForUser?: (waiting: boolean) => void;
  /**
   * V1 correlation for `assertNoUnauthorizedV1CorrelationV0` below — REQUIRED
   * (no default) so every caller states its intent explicitly, matching the
   * removed isImplementationV1Bootstrap field's own rationale. `actionKey`
   * must be one of MIGRATED_ACTION_KEYS_V0's edit-cohort keys
   * (implementation.v1/fastForward.v1/applyReviewEdit.v1/lint.v1); this
   * function reads nothing else off it — there is no coordinator lease or
   * receipt at this call site to attach a full ActionCorrelationV1 to, since
   * the CLI edit path this feeds has none of that machinery.
   */
  correlation: { readonly actionKey: string };
  /**
   * REQUIRED (no default). When false, a configured backup whose effective
   * provider kind differs from the PRIMARY's is treated as unavailable and
   * skipped by THIS function's own direct dispatch (the `run` closure below)
   * — it never silently crosses from one runner kind to another itself. This
   * matters because the two kinds have categorically different safety
   * properties: a CLI provider's edit mode is a blunt, extension-unmediated
   * workspace-wide write grant, while Copilot's callers outside this
   * function route through the sealed two-phase pipeline
   * (runSealedImplementationV1 in runEditActionV1.ts) with its own
   * preflight/receipts/host-floor gate. Dispatching a Copilot backup through
   * `run` below — runImplementationWithCopilot, the older, unsealed Copilot
   * runner — would silently bypass every one of the sealed pipeline's
   * guarantees. Pass true only for a caller that has no such distinction to
   * protect (e.g. a primary that is itself Copilot falling back to another
   * Copilot model). A caller that DOES need a cross-kind backup reachable
   * (runImplementationOrSealedV1, whose own top-level dispatch already knows
   * how to run a Copilot candidate safely) should instead pass
   * `runCrossProviderBackup` and leave this false — see that option.
   */
  allowCrossProviderBackups: boolean;
  /**
   * Safe cross-provider handoff to the sealed two-phase Copilot pipeline
   * (originally added per a Codex review finding: a CLI primary that passes
   * its pre-run availability probe but then fails at RUNTIME with a quota/
   * temporarily-unavailable error had no way to reach a configured Copilot
   * backup). wf10 item 3 / Part 5 step 13: this cascade's automatic backup
   * loop no longer calls this callback at all — every cross-kind (Copilot)
   * backup is excluded from automatic selection entirely, since that path
   * reliably reports "available" while reliably producing zero-file rounds
   * (observed on wf9 and jester). The option and its plumbing at the
   * `runImplementationOrSealedV1` call site are left in place, unused by
   * this cascade, so the exclusion stays reversible without an API change.
   */
  runCrossProviderBackup?: (modelId: string) => Promise<ImplementationRunResult & { runnerId: string }>;
  /**
   * The stage's TRUE globally-configured primary, when `modelId` above is
   * actually a pre-resolved WINNING candidate rather than that primary
   * itself (Codex review finding: runImplementationOrSealedV1 pre-resolves
   * the winning candidate — the primary if live, else the first available
   * configured backup — via checkImplementationAvailabilityForModel, then
   * dispatches straight to it as this function's `modelId`; a direct,
   * first-try success on that candidate previously went unrecorded, since
   * this function's own recordActiveFallbackModel call only fires from
   * inside its OWN internal backup loop below, never for its own top-level
   * `modelId` succeeding directly). Omit when `modelId` already IS the true
   * primary (every other caller) — this only activates the check below when
   * explicitly given a value that differs from `modelId`.
   */
  configuredPrimaryModelId?: string;
}): Promise<
  ImplementationRunResult & {
    runnerId: string;
    /**
     * Identity of whichever candidate — the primary, or a same-/cross-kind
     * backup this cascade (or `runCrossProviderBackup`) actually invoked —
     * produced THIS returned result. Unlike `runImplementationOrSealedV1`'s
     * own pre-invocation `providerLabel`/`storedModelId` (resolved BEFORE
     * dispatch), these are stamped at the exact return point, after any
     * runtime quota/temporarily-unavailable substitution inside this
     * cascade — so a caller can always report the model that actually ran,
     * not just the one that was about to be tried.
     */
    actualProviderLabel: string;
    actualStoredModelId: string | undefined;
  }
> {
  assertNoUnauthorizedV1CorrelationV0(options);
  const effective = resolveEffectiveProvider(options.modelId);
  const primaryProviderLabel = toResolvedRunner(effective).providerLabel;
  // Shared identity for this attempt's model/provider/account — used both to
  // gate quotaParkRecord clearing (below) and to stamp a new park record
  // (further below), so the two always agree on what "this run" means.
  const primaryProviderId = String(effective.kind === "cli" ? effective.def.id : "copilot");
  const primaryAccountKey = resolveQuotaAccountKeyV1(options.modelId);
  const primaryParkIdentity: QuotaParkClearingIdentityV1 = {
    providerId: primaryProviderId,
    modelId: options.modelId ?? "(default)",
    accountKey: primaryAccountKey,
  };
  const withActualIdentity = <T extends ImplementationRunResult & { runnerId: string }>(
    base: T,
    providerLabel: string,
    storedModelId: string | undefined
  ): T & { actualProviderLabel: string; actualStoredModelId: string | undefined } => ({
    ...base,
    actualProviderLabel: providerLabel,
    actualStoredModelId: storedModelId,
  });

  const run = async (
    selected: EffectiveProvider
  ): Promise<ImplementationRunResult & { runnerId: string }> => {
    const prompt = options.prompt;
    if (selected.kind === "cli") {
      const result = await runImplementationWithCli({
        def: selected.def,
        model: selected.model,
        prompt,
        workspaceUri: options.workspaceUri,
        token: options.token,
        onProgress: options.onProgress,
        requireFileChange: options.requireFileChange,
        taskFolderUri: options.taskFolderUri,
        stage: options.stage,
      });
      return { ...result, runnerId: selected.def.id };
    }

    const result = await runImplementationWithCopilot({
      prompt,
      modelId: selected.model,
      workspaceUri: options.workspaceUri,
      token: options.token,
      onProgress: options.onProgress,
      onBusyDetail: options.onBusyDetail,
      onWaitingForUser: options.onWaitingForUser,
      taskFolderUri: options.taskFolderUri,
      stage: options.stage,
    });
    return { ...result, runnerId: "copilot-lm" };
  };
  const result = await run(effective);
  if (options.stage) {
    await recordQuotaObservation(options.stage, options.modelId, result.failureKind, result.errorMessage, getExtensionContextV1(), undefined, primaryAccountKey);
  }
  // Review completion blocker: a successful same-stage retry (the withheld
  // branch below's own suggested remedy — "rerun this stage") previously
  // left a prior `quotaParkRecord` in place, so the task tree tooltip could
  // keep reporting a resolved block as still active. Clear it the moment
  // this stage's run succeeds.
  //
  // The same review also flagged that a FAILED retry contradicting the
  // parked kind (e.g. now "temporarily-unavailable" or "generic" instead of
  // "quota"/"model-entitlement") left the task-level record stale too —
  // mirroring updateQuotaLedger's own clearing rule (quota.ts), which
  // already treats "ok" or a contradicting non-quota/entitlement kind as
  // proof the provider is no longer known-blocked.
  //
  // Both clearing branches require FRESH evidence, not merely "not a quota
  // failure": a cancelled run (`status === "cancelled"`, `failureKind`
  // typically undefined) proves nothing about whether the block resolved,
  // so it must not clear the record. A second review finding: evidence from
  // a DIFFERENT model/provider than the one the persisted record actually
  // blocked proves nothing about that specific block either — `identity` is
  // matched inside `clearQuotaParkV1` against the record's own
  // providerId/modelId/accountKey, so a mismatched result now leaves the
  // record in place instead of erasing it.
  if (options.taskFolderUri && isQuotaParkClearingEvidence(result)) {
    await patchTaskProgressStrictV1(options.taskFolderUri, (current) =>
      clearQuotaParkV1(current, primaryParkIdentity)
    );
  }
  // Codex review finding: a pre-resolved winning candidate (passed as
  // `modelId` above, differing from the stage's true `configuredPrimaryModelId`)
  // that succeeds on this direct, first-try attempt was never recorded as the
  // active fallback — only a candidate discovered by THIS function's OWN
  // internal backup loop below gets that treatment. Without this, a later
  // Fast Forward iteration passing preserveActiveFallback re-resolves the
  // stage's raw configured primary instead of sticking with the
  // known-working backup this run just proved out.
  if (
    result.status === "completed" &&
    options.taskFolderUri &&
    options.stage &&
    options.modelId !== undefined &&
    options.configuredPrimaryModelId !== undefined &&
    options.configuredPrimaryModelId !== options.modelId
  ) {
    await recordActiveFallbackModel(options.taskFolderUri, options.stage, options.modelId);
  }
  // The effective chain (skip-filtered, general-model fallback applied) is
  // what governs the quota-fallback cascade below: a blank stage inherits
  // the general chain's backups and strategy.
  const chain = options.stage ? resolveEffectiveStageChainV1(options.stage) : undefined;
  const chainWantsBackup =
    chain !== undefined && chain.strategy === "switch-to-backup" && chain.backups.length > 0;
  // Prefer the provider's own pre-hint verdict; fall back to the regex over the
  // pre-hint diagnostic text, and only then over errorMessage. The layering is
  // what breaks a self-reinforcing loop: toFriendlyError APPENDS the login hint
  // ("...paste the OpenCode API key.") into errorMessage, and that hint text
  // itself matches /api\s*key/i in isAuthenticationFailure — so any error that
  // tripped a false-positive auth diagnosis was guaranteed to be re-confirmed
  // as auth by the hint Ensemble added to explain it. authDiagnosticText is the
  // same message without the hint.
  //
  // `||` rather than `??`: a false from a CLI provider means "this provider's
  // marker list didn't match", not "this is definitely not auth". Provider
  // marker lists are narrower than the regex (claude-cli carries no 401/403/
  // forbidden markers), so the regex must still get its say. The Copilot runner
  // leaves both fields undefined and lands on errorMessage — today's behavior.
  const authFailure =
    result.authFailure === true ||
    isAuthenticationFailure(result.authDiagnosticText ?? result.errorMessage);
  // A failed run may already have written partial changes before it failed
  // (a timeout on a provider whose CLI keeps writing right up to the kill,
  // e.g. Cline/Antigravity's unenforced text/edit modes — or, less likely but
  // still possible on any provider, a mid-run failure after some tool calls
  // already landed). filesChanged/filesChangedUnknown are already computed by
  // runImplementationWithCli's before/after git snapshot for exactly this
  // purpose (see its own doc comment) but were previously never consulted
  // here — this cascade dispatched a DIFFERENT model at the current, possibly
  // half-edited working tree the moment failureKind alone said quota/
  // temporarily-unavailable, with no dirty-tree gate at all (unlike the
  // same-model retry path in runImplementationWithCli, which already refuses
  // to retry without a clean git snapshot). Treat "unknown" (git unavailable
  // / not a repository) the same as "dirty" — genuinely not knowing is not
  // evidence of safety. Copilot's runner has its own tool-path boundary
  // rather than a git snapshot, but still always reports a real filesChanged
  // array (see ImplementationRunResult), so this check applies uniformly to
  // every runner kind, not just CLI providers.
  const leftTreeCleanV1 = (r: ImplementationRunResult): boolean =>
    r.filesChangedUnknown !== true && r.filesChanged.length === 0;
  const primaryLeftTreeClean = leftTreeCleanV1(result);
  if (
    !authFailure &&
    primaryLeftTreeClean &&
    isCascadeEligibleFailureKind(result.failureKind) &&
    options.stage &&
    chainWantsBackup
  ) {
    if (!options.taskFolderUri) {
      return withActualIdentity(result, primaryProviderLabel, options.modelId);
    }
    const reserved = await reserveFallback(options.taskFolderUri, options.stage);
    if (!reserved) {
      return withActualIdentity(result, primaryProviderLabel, options.modelId);
    }
    const releaseReservation = (): Promise<void> =>
      releaseUnresolvedFallbackReservation(options.taskFolderUri!, options.stage!);
    // wf10 item 3 / item 6b / Part 5 step 14: a candidate with a recent
    // record of zero-file rounds (the same `provider-failure-empty` health
    // window step 13's breaker reads) must not be automatically re-selected
    // here — this is exactly how both wf9 and jester walked their backup
    // chain onto a known-broken sealed Copilot preflight path repeatedly:
    // that candidate reports "available" (it IS reachable), so nothing
    // before this point had a reason to skip it. Read once, outside the
    // loop — a per-candidate read would re-fetch the identical file once per
    // backup for no benefit. Best-effort: an unreadable progress file must
    // never block a fallback cascade that would otherwise work.
    const breakerRounds = getResilienceSettings().fallbackProviderBreakerRounds;
    let roundOutcomesForHealthCheck: RoundOutcomeEntryV1[] | undefined;
    if (breakerRounds > 0) {
      try {
        const progressRead = await readTaskProgressStrictV1(options.taskFolderUri);
        roundOutcomesForHealthCheck = progressRead.ok ? progressRead.decoded.progress.roundOutcomes : undefined;
      } catch {
        roundOutcomesForHealthCheck = undefined;
      }
    }
    for (const backupModel of filterEnabledBackupModels(chain.backups)) {
      if (backupModel === options.modelId) {
        continue;
      }
      // wf10 review fix (Part 5 steps 13-14, narrowed blocker 1): resolved
      // BEFORE the health check below so that check can match on the full
      // provider path (provider id + model id), not `modelId` alone — the
      // same identity `runnerId: selected.def.id`/`"copilot-lm"` records at
      // this candidate's own eventual return point further down.
      let backupKind: "cli" | "copilot" | undefined;
      let backupProviderId: string | undefined;
      try {
        const backupEffective = resolveEffectiveProvider(backupModel);
        backupKind = backupEffective.kind;
        backupProviderId = backupEffective.kind === "cli" ? backupEffective.def.id : "copilot-lm";
      } catch {
        // Unresolvable — the availability check just below rejects it too;
        // treat as skip either way rather than crossing provider kinds.
      }
      if (
        breakerRounds > 0 &&
        candidateHasRecentZeroFileFailuresV1(
          roundOutcomesForHealthCheck,
          options.stage,
          backupModel,
          breakerRounds,
          backupProviderId
        )
      ) {
        continue;
      }
      // Captured before this backup's availability check/dispatch — same
      // rationale as `primaryAccountKey` above.
      const backupAccountKey = resolveQuotaAccountKeyV1(backupModel);
      if (!options.allowCrossProviderBackups) {
        if (backupKind !== effective.kind) {
          // wf10 item 3 / Part 5 step 13: the sealed two-phase Copilot
          // pipeline (runSealedImplementationV1, reached below via
          // runCrossProviderBackup) is excluded from automatic backup
          // selection entirely — the same reasoning as the preflight
          // availability walk's exclusion above (~line 810). The earlier
          // "Codex review finding" reasoning that justified reaching it here
          // (a CLI primary's RUNTIME quota failure otherwise had no way to
          // reach a configured Copilot backup) is superseded by the observed
          // wf9/jester failure: that path reliably reports "available" while
          // reliably producing zero-file rounds, which is worse than never
          // reaching it. Since this cascade is only ever entered for a CLI
          // winning candidate (a Copilot winning candidate routes through
          // runSealedImplementationV1 directly, never through here), the
          // only cross-kind backup this loop could ever reach is Copilot —
          // so excluding backupKind === "copilot" here removes Copilot from
          // automatic implementation fallback selection entirely, while an
          // unresolvable backupKind (undefined) still always skips too,
          // matching the pre-existing comment above.
          continue;
        }
      }
      const fallbackAvailability =
        await checkImplementationAvailabilityForModel(backupModel);
      if (!fallbackAvailability.availability.available) {
        const fallbackFailure = {
          ...result,
          status: "failed" as const,
          failureKind: isAuthenticationFailure(fallbackAvailability.availability.reason)
            ? "generic" as const
            : "temporarily-unavailable" as const,
          errorMessage: fallbackAvailability.availability.reason ?? "Backup model is unavailable.",
        };
        await recordQuotaObservation(options.stage, backupModel, fallbackFailure.failureKind, fallbackFailure.errorMessage, getExtensionContextV1(), undefined, backupAccountKey);
        if (isAuthenticationFailure(fallbackAvailability.availability.reason)) {
          await releaseReservation();
          return withActualIdentity(fallbackFailure, fallbackAvailability.providerLabel, backupModel);
        }
        continue;
      }
      // wf10 item 3 / Part 5 step 13: `options.runCrossProviderBackup` is
      // never invoked here — the `continue` above already excludes every
      // cross-kind (i.e. Copilot) backup this loop could otherwise reach.
      // The option stays on the type (see its header) so the exclusion
      // remains reversible without an API change, but this cascade no
      // longer calls it.
      const fallbackResult = await run(resolveEffectiveProvider(backupModel));
      await recordQuotaObservation(options.stage, backupModel, fallbackResult.failureKind, fallbackResult.errorMessage, getExtensionContextV1(), undefined, backupAccountKey);
      if (fallbackResult.status === "completed") {
        await recordActiveFallbackModel(
          options.taskFolderUri,
          options.stage,
          backupModel
        );
        return withActualIdentity(fallbackResult, fallbackAvailability.providerLabel, backupModel);
      }
      // A failed/cancelled backup cannot be the stage's sticky fallback.
      // In particular, this prevents an OpenCode 401 from routing every
      // later implementation attempt to the same unauthenticated model.
      if (
        fallbackResult.status === "cancelled" ||
        !isCascadeEligibleFailureKind(fallbackResult.failureKind)
      ) {
        await releaseReservation();
        return withActualIdentity(fallbackResult, fallbackAvailability.providerLabel, backupModel);
      }
      // Codex review finding (P1): this backup's own failure is cascadable
      // by failureKind alone, but the SAME dirty-tree gate applied to the
      // primary above was never re-applied here — a backup that writes
      // partial changes before hitting its own transient quota error would
      // let a THIRD candidate run against that now half-edited (or unknown)
      // tree with no awareness of it. Stop the cascade the moment any
      // attempt — primary or backup — may have mutated the workspace,
      // exactly as the primary's own gate does.
      if (!leftTreeCleanV1(fallbackResult)) {
        await releaseReservation();
        return withActualIdentity(fallbackResult, fallbackAvailability.providerLabel, backupModel);
      }
    }
    await releaseReservation();
  } else if (
    // (2e / plan step 17) Quota-or-outage failure that left the working tree
    // DIRTY: the clean-tree cascade above intentionally never fires here
    // because `primaryLeftTreeClean` is false, and no backup is EVER invoked
    // in this state. The zero-changed-files requirement is the cascade's
    // explicit safety boundary — dispatching a second model at a tree the
    // failed primary already half-edited risks mixing two models' edits in
    // one round, which is strictly worse than failing. What the bare
    // fall-through used to omit is any explanation: the user saw only the
    // primary's raw quota/outage error, with no way to tell that a
    // configured backup exists but was deliberately withheld (versus not
    // being configured at all). Enrich the primary's own outcome with that
    // explanation and the two real choices — rerun the stage, or switch the
    // stage's model — and return it. Only a KNOWN, non-empty change set
    // takes this branch: `filesChangedUnknown` keeps the plain fall-through
    // below, since a message claiming "N file(s) changed" cannot be written
    // about a tree whose state could not be determined.
    !authFailure &&
    result.filesChangedUnknown !== true &&
    result.filesChanged.length > 0 &&
    isCascadeEligibleFailureKind(result.failureKind) &&
    options.stage &&
    chainWantsBackup
  ) {
    const limitLabel =
      result.failureKind === "quota"
        ? "a quota/rate limit"
        : result.failureKind === "model-entitlement"
          ? "a model-entitlement block"
          : "the provider being temporarily unavailable";
    const parkProviderId = primaryProviderId;
    const parkAccountKey = primaryAccountKey;
    const extensionContext = getExtensionContextV1();
    // Known reset time, when this failure kind carries one at all. Workflow
    // 3 continuation, first item: a real Cline "monthly ... limit ... resets
    // in 8d 19h, please try again later" message classifies as
    // "temporarily-unavailable" (its "try again later" wording matches
    // TEMPORARY_MARKERS, not any QUOTA_MARKERS phrase), NOT "quota" — so a
    // check narrowed to quota/model-entitlement never even attempted to
    // parse its perfectly legible reset time, and the remedy silently fell
    // back to the generic "rerun or switch models" text regardless of how
    // far out the reset actually was. Every cascade-eligible failure kind
    // (isCascadeEligibleFailureKind — the same three kinds this whole
    // withheld-cascade branch already requires to be reached at all) may
    // carry provider-reported reset wording, so all three attempt the parse
    // here; parseQuotaResetV1 itself is what stays conservative, returning
    // undefined on anything but its two recognized phrase shapes rather than
    // guessing at an unrelated "in N ..." phrase.
    //
    // Prefers a fresh parse of THIS failure's own message, then the
    // (restart-losing) session-observed value, then the durable cross-restart
    // ledger — so a host restart between the original block and a later
    // retry attempt still recovers the previously known reset time instead
    // of silently falling back to "no known reset" wording. The session/
    // ledger fallbacks stay scoped to quota/model-entitlement observations
    // (recordQuotaObservation only ever caches a resetAt for "quota"), so
    // only the direct parse of this attempt's own message benefits from the
    // widened kind check.
    const knownResetAt =
      isCascadeEligibleFailureKind(result.failureKind)
        ? parseQuotaResetV1(result.errorMessage, new Date()) ??
          getQuotaObservation(options.stage, options.modelId)?.resetAt ??
          (extensionContext
            ? getQuotaLedgerEntry(
                extensionContext,
                parkProviderId,
                parkAccountKey,
                options.modelId ?? "(default)"
              )?.resetAt
            : undefined)
        : undefined;
    const remedyText = buildQuotaRemedyTextV1(knownResetAt);
    // Part 5 step 3b / workflow 3 continuation first item: a "far" outage
    // (beyond the near-reset threshold) is never just this one stage's
    // problem — every OTHER configurable stage whose effective primary
    // chain resolves to this SAME blocked provider account is either
    // equally blocked or has already silently fallen through to a
    // different backup. Name each affected stage's actual substitute (or
    // its absence) so the operator learns this from one notification
    // instead of one stage failure at a time.
    const affectedStageDescriptions =
      knownResetAt !== undefined && isQuotaResetBeyondThresholdV1(knownResetAt)
        ? describeStageSubstitutesV1(options.modelId ?? "(default)", options.stage)
        : [];
    const affectedStagesClause =
      affectedStageDescriptions.length > 0
        ? ` This also affects: ${affectedStageDescriptions.join("; ")}.`
        : "";
    const withheldMessage =
      `Hit ${limitLabel} on ${primaryProviderLabel}` +
      (result.errorMessage ? ` (${result.errorMessage})` : "") +
      `. This round already changed ${result.filesChanged.length} file(s), so Ensemble withheld the ` +
      "automatic switch to this stage's backup model — switching mid-round on a dirty working tree " +
      `risks mixing two models' edits in one round. ${remedyText}${affectedStagesClause}`;
    options.onProgress(withheldMessage);
    // Part 5 step 1: surface a "Rerun after reset" action alongside the
    // withheld-cascade notice whenever a concrete, NEAR reset time is known
    // — this is the one place a caller (not just a live progress stream
    // reader) can learn there is a specific time worth arming a scheduled
    // rerun for. Routed through NotificationRouter directly (rather than
    // relying on whatever the caller does with the returned/`onProgress`-
    // streamed message) so the action is attached exactly once, here,
    // regardless of which caller invoked this cascade.
    // Review completion blocker: this previously fired for EVERY known
    // reset, including a "far" one (already past the near-reset threshold,
    // same `affectedStagesClause` branch above) — offering a scheduled
    // rerun there contradicts remedyText's own switch-model-only advice for
    // a multi-day outage. Gated on the same threshold check that drives
    // affectedStagesClause so the action and the remedy text never disagree.
    if (
      options.taskFolderUri &&
      knownResetAt !== undefined &&
      !isQuotaResetBeyondThresholdV1(knownResetAt)
    ) {
      NotificationRouter.showWarning(withheldMessage, undefined, undefined, undefined, {
        command: "vs-code-ai-helper.scheduleQuotaResumeV1",
        title: "Rerun after reset",
        args: [{ taskFolderPath: options.taskFolderUri.fsPath, resetAtIso: knownResetAt }],
      });
    }
    // Persist a durable record of the block — the same transaction that
    // withholds the backup switch — so a host restart or a later
    // notification can still know WHEN (if known) this provider is expected
    // to recover, rather than relying solely on the restart-losing
    // in-memory QuotaObservation map (quota.ts). Scoped to the two failure
    // kinds "resets at" language applies to; a temporarily-unavailable
    // outage has no predictable reset time and is deliberately left
    // unrecorded here.
    if (
      options.taskFolderUri &&
      (result.failureKind === "quota" || result.failureKind === "model-entitlement")
    ) {
      const record = {
        modelId: options.modelId ?? "(default)",
        providerId: parkProviderId,
        accountKey: parkAccountKey,
        failureKind: result.failureKind,
        resetAt: knownResetAt,
        observedAt: new Date().toISOString(),
      };
      await patchTaskProgressStrictV1(options.taskFolderUri, (current) =>
        recordQuotaParkV1(current, record)
      );
    }
    return withActualIdentity(
      { ...result, errorMessage: withheldMessage },
      primaryProviderLabel,
      options.modelId
    );
  }
  // Part 7 diagnostic: neither cascade branch above fired, so this cascade-
  // eligible failure falls straight through with no explanation of WHY no
  // backup was attempted. Two distinct reasons land here and were previously
  // indistinguishable in the run record: no backup is even CONFIGURED for
  // this stage/chain (`chainWantsBackup` false), versus a backup IS
  // configured but the working tree's state is UNKNOWN
  // (`filesChangedUnknown` — git unavailable or not a repository — which the
  // withheld-cascade branch above only explains for the KNOWN-dirty case).
  if (
    !authFailure &&
    result.status === "failed" &&
    isCascadeEligibleFailureKind(result.failureKind) &&
    options.stage
  ) {
    if (!chainWantsBackup) {
      options.onProgress(
        `${primaryProviderLabel} hit ${result.failureKind ?? "a"} failure; no backup model is ` +
          "configured for this stage/chain, so no automatic fallback was attempted."
      );
    } else if (result.filesChangedUnknown === true) {
      options.onProgress(
        `${primaryProviderLabel} hit ${result.failureKind ?? "a"} failure with the working ` +
          "tree state unknown (git unavailable or not a repository); Ensemble withheld the " +
          "automatic switch to this stage's backup model because a dirty-vs-clean tree could " +
          "not be confirmed."
      );
    }
  }
  return withActualIdentity(result, primaryProviderLabel, options.modelId);
}

/* ------------------------------------------------------------------------ *
 * V1 reservation-based selection (plan §3.3/§3.4, executable-order step 5) *
 * ------------------------------------------------------------------------ */

/**
 * A registry-selected, session-reserved provider candidate. The registry —
 * not the caller — chose the runner/provider/model; the caller (the future
 * action coordinator) claims the reservation through the selection session
 * and invokes it exactly once through the execution broker.
 */
export interface V1ReservedProviderV1 {
  readonly handle: ProviderReservationHandleV1;
  /** Short display name for user-facing progress ("Copilot", "Claude Code"…). */
  readonly providerLabel: string;
  /**
   * The stored (provider-qualified) model id this reservation ranks —
   * exactly the id the registry's existing ranking policy produced.
   */
  readonly storedModelId: string;
  /**
   * Construct the transport for exactly this reservation's runner.
   * Construction is not invocation: only the execution broker
   * (`agentExecutionBrokerV1.ts`) invokes, after claiming the reservation,
   * and it rejects a transport whose runnerId differs from the handle's.
   *
   * `toolHandler` (plan §7.2/§7.4) carries the per-attempt request-local
   * tool session for `preflight`/`edit` modes — required there, ignored by
   * `text` transports. The COORDINATOR creates it (read session or edit
   * broker handler) so the registry stays a pure selection authority.
   */
  createTransport(toolHandler?: RequestLocalToolHandlerV1): AgentTransportV1;
  /**
   * Whether this provider can open workspace files on its own.
   *
   * True for every CLI provider: the process runs in the workspace and reads
   * files natively, so a `text` row is fully evidenced. False for Copilot,
   * whose text transport has no tools — it sees only what the caller put in
   * the prompt. A row that must reason about file content
   * (`readsWorkspaceFiles`) uses this to decide whether to attach the
   * read-only tool session; without it, review quality silently depended on
   * which provider the user happened to configure.
   */
  readonly providerReadsWorkspaceNatively: boolean;
}

export type V1ReserveNextResultV1 =
  | { readonly kind: "reserved"; readonly reserved: V1ReservedProviderV1 }
  | {
      /**
       * The next ranked candidate — primary or backup — cannot satisfy the
       * requested mode. It is never silently bypassed: the caller's attempt
       * has already been settled as `providerUnavailablePreInvocation`
       * (a fallback-eligible outcome, plan §3.4: a supported runner that
       * cannot satisfy V1 returns `providerModeUnavailable` rather than
       * disappearing), so the skip is an explicit, auditable attempt record.
       * The caller allocates a fresh attempt and calls `reserveNext` again
       * to reach the next ranked candidate.
       */
      readonly kind: "candidateUnavailable";
      readonly code: "providerModeUnavailable";
      /** The ranked stored model id that could not be served. */
      readonly storedModelId: string;
      readonly providerLabel: string;
      readonly runnerId: string;
    }
  | {
      readonly kind: "noneRemaining";
      /**
       * `providerModeUnavailable`: no ranked candidate can satisfy the
       * requested mode at all (maps to the stable coordinator outcome of the
       * same name). `candidatesExhausted`: mode-capable candidates existed
       * but each has already received its reservation (or been settled as an
       * explicit unavailable attempt).
       */
      readonly code: "providerModeUnavailable" | "candidatesExhausted";
      /**
       * Structured evidence of WHICH resolved chain was exhausted and why
       * each ranked candidate could not serve (2026-08-13 finding 4: a bare
       * `Status: unavailable (providerModeUnavailable)` run record named no
       * provider at all). Built from this selection's own ranked list — the
       * live settings resolution — so it can never disagree with what
       * selection actually tried. The coordinator passes it through to the
       * stage owner verbatim, performing no task-state mutation of its own.
       */
      readonly chainExhaustion?: ProviderChainExhaustionV1;
    };

export interface V1RunnerSelectionV1 {
  /**
   * Issue the single reservation for `attemptId`, bound to the next
   * registry-ranked candidate. The selection session enforces that the
   * attempt was allocated by the caller's session, that each attempt gets
   * exactly one reservation, and that fallback only proceeds after a
   * pre-response outcome — this function never invokes a provider
   * (AC-RUNNER-04).
   */
  reserveNext(attemptId: AttemptIdV1): V1ReserveNextResultV1;
}

interface V1CandidateV1 {
  readonly storedModelId: string;
  readonly providerLabel: string;
  readonly runnerId: string;
  readonly providerId: ProviderId;
  readonly nativeModelId: string | undefined;
  readonly createTransport: (toolHandler?: RequestLocalToolHandlerV1) => AgentTransportV1;
  /** See `V1ReservedProviderV1.providerReadsWorkspaceNatively`. */
  readonly providerReadsWorkspaceNatively: boolean;
}

/**
 * The exact ranked stored-model-id chain `openV1RunnerSelection` walks: the
 * stage's stored primary first, then the strategy-gated backups from live
 * settings resolution. Shared with `preflightStageChainAvailabilityV1` so a
 * pre-flight can never disagree with what selection would actually try
 * (finding 4's second fix: "the chain is known ahead of time").
 * `resolveEffectiveProvider(undefined)` is called for its fail-closed throw
 * when no primary is configured — the same legacy misconfiguration error
 * selection surfaces.
 */
function rankedStageChainStoredIdsV1(
  stage: TaskStage | undefined,
  modelId: string | undefined
): string[] {
  const rankedStoredIds: string[] = [];
  if (modelId !== undefined) {
    rankedStoredIds.push(modelId);
  } else {
    // Surface the exact legacy misconfiguration error at selection time.
    resolveEffectiveProvider(undefined);
  }
  rankedStoredIds.push(...backupModelsForStage(stage, modelId));
  return rankedStoredIds;
}

/**
 * Open the registry's V1 selection for one coordinator operation (plan §3.3:
 * selection is split from invocation; plan product decisions: this registry
 * "remains the sole source of provider/model ranking … and fallback policy,
 * but does not invoke V1 fallback providers internally").
 *
 * Ranking reuses the exact legacy policy: the stage's stored primary model
 * resolves through `resolveEffectiveProvider` (including the runner-entry
 * disabled-provider guard), and fallback candidates come from
 * `backupModelsForStage` — the same strategy-gated, provider-enabled,
 * deduplicated list the legacy cascade consumes. Candidates that cannot
 * satisfy the requested mode are rejected here, at selection time (plan
 * §3.4: "Reject providers that cannot satisfy the requested mode"), and
 * never silently bypassed:
 *  - `text`: Copilot LM plus every CLI provider whose final answer is
 *    capturable from bounded stdout (`cliProviderSupportsV1StdoutCapture`);
 *  - `preflight`/`edit`: the Copilot LM path only, through the request-local
 *    tool-session transport (`languageModelToolSessionV1.ts`, plan §7.2);
 *    CLI providers stay `providerModeUnavailable` — §7.5 explicitly requires
 *    the absence of a general-workspace CLI edit path.
 *
 * When NO ranked candidate can satisfy the mode, every `reserveNext` returns
 * `providerModeUnavailable` for the whole selection. When a ranked candidate
 * (the primary or a mid-list backup) cannot satisfy the mode but a later one
 * can, `reserveNext` settles the caller's attempt as an explicit
 * `providerUnavailablePreInvocation` outcome and returns
 * `candidateUnavailable` naming the skipped candidate — the unavailable
 * primary is represented as a settled attempt before any backup attempt is
 * allocated, so fallback stays within the session's normal
 * one-outcome-per-attempt accounting instead of hiding the skip.
 */
export function openV1RunnerSelection(options: {
  session: ProviderSelectionSessionV1;
  mode: AgentExecutionModeV1;
  /** The stage's stored (provider-qualified) primary model id. */
  modelId: string | undefined;
  stage?: TaskStage;
  /**
   * Working directory CLI transports run in (the workspace root). Fixed at
   * selection time by the caller — never carried inside a V1 request.
   */
  workspaceCwd: string;
  /**
   * `text` mode only: reject every candidate — primary AND every ranked
   * backup — whose text mode does not both (a) vendor-enforce read-only AND
   * (b) honour the requested response contract rather than repurposing an
   * interactive planning flow (review blocker, 2026-08-14, tightened by the
   * workflow findings dated 2026-08-20 — "summary-only continuations are
   * selected for claude-cli, whose text mode cannot produce the required
   * report": the generic ranked selection otherwise accepts any CLI provider
   * that can capture bounded stdout, with no regard for either property — so
   * a qualifying primary could cascade to a write-capable backup like
   * Cline/Antigravity, OR to a read-only-but-repurposed-interactive backup
   * like Claude Code/OpenCode/devpass-code, under a `summary-only` recovery
   * continuation, defeating the guarantee that dispatch mode exists to
   * enforce). Copilot's broker text mode always satisfies this (no edit
   * tools are ever granted, and it has no competing response format of its
   * own); a CLI candidate must pass `isCliTextModeSummaryOnlyCapableV1`. A
   * rejected candidate is recorded exactly like any other unsupported one —
   * an explicit settled attempt, never a silent skip — so when no candidate
   * qualifies the whole selection settles `providerModeUnavailable` instead
   * of ever reserving an unqualified provider under a summary-only mandate.
   */
  requireSummaryOnlyCapableText?: boolean;
}): V1RunnerSelectionV1 {
  const { session, mode, workspaceCwd, requireSummaryOnlyCapableText = false } = options;

  type RankedEntryV1 =
    | { readonly supported: true; readonly candidate: V1CandidateV1 }
    | {
        readonly supported: false;
        readonly storedModelId: string;
        readonly providerLabel: string;
        readonly runnerId: string;
      };

  const toRankedEntry = (storedModelId: string): RankedEntryV1 => {
    const effective = resolveEffectiveProvider(storedModelId);
    if (effective.kind === "copilot") {
      const nativeModelId = effective.model;
      if (mode !== "text") {
        // Preflight/edit run through the request-local LM tool session
        // (plan §7.2/§7.6): the coordinator supplies the per-attempt tool
        // handler; constructing without one is a programmer error, never a
        // model-reachable state.
        return {
          supported: true,
          candidate: {
            storedModelId,
            providerLabel: "Copilot",
            runnerId: "copilot-lm",
            providerId: "copilot",
            nativeModelId,
            providerReadsWorkspaceNatively: false,
            createTransport: (toolHandler) => {
              if (!toolHandler) {
                throw new Error(
                  `A ${mode} transport requires the coordinator's request-local tool handler.`
                );
              }
              return createCopilotLmToolSessionTransportV1({
                model: nativeModelId,
                toolHandler,
              });
            },
          },
        };
      }
      return {
        supported: true,
        candidate: {
          storedModelId,
          providerLabel: "Copilot",
          runnerId: "copilot-lm",
          providerId: "copilot",
          nativeModelId,
          // Copilot cannot read the workspace by itself.
          providerReadsWorkspaceNatively: false,
          createTransport: (toolHandler) =>
            toolHandler
              ? // A `readsWorkspaceFiles` row supplied the read-only session:
                // run the same tool-calling loop the preflight path uses, so
                // the model can open the files it is reasoning about. Its final
                // tool-free round is the text this row wanted all along.
                createCopilotLmToolSessionTransportV1({
                  model: nativeModelId,
                  toolHandler,
                })
              : createCopilotLmTextTransportV1({ model: nativeModelId }),
        },
      };
    }
    if (
      mode !== "text" ||
      !cliProviderSupportsV1StdoutCapture(effective.def) ||
      (requireSummaryOnlyCapableText && !isCliTextModeSummaryOnlyCapableV1(effective.def))
    ) {
      // CLI providers are unsupported for preflight/edit (plan product
      // decisions), and a last-message-file CLI cannot satisfy AC-RUNNER-02
      // ("CLI results are captured only from bounded stdout") yet; a caller
      // that requires summary-only-capable text mode (see the option's own
      // doc comment) additionally rejects a CLI whose text mode auto-approves
      // every tool OR merely withholds edits without honouring the requested
      // response contract. The candidate stays in the ranked list so
      // `reserveNext` can surface it as an explicit settled attempt instead
      // of silently bypassing it.
      return {
        supported: false,
        storedModelId,
        providerLabel: effective.def.label,
        runnerId: effective.def.id,
      };
    }
    const { def } = effective;
    const nativeModelId = effective.model;
    return {
      supported: true,
      candidate: {
        storedModelId,
        providerLabel: def.label,
        runnerId: def.id,
        providerId: def.id,
        nativeModelId,
        // A CLI provider runs inside the workspace and opens files itself, so
        // it needs no tool session and ignores any handler passed to it.
        providerReadsWorkspaceNatively: true,
        createTransport: () =>
          createCliTextTransportV1({ def, model: nativeModelId, cwd: workspaceCwd }),
      },
    };
  };

  // Ranked stored ids: the primary first, then the strategy-gated backups.
  // `resolveEffectiveProvider` throws for a disabled or unconfigured primary
  // (the same fail-closed behavior as the legacy entry points), and
  // `backupModelsForStage` already excludes disabled providers.
  const rankedStoredIds = rankedStageChainStoredIdsV1(options.stage, options.modelId);

  const ranked = rankedStoredIds.map(toRankedEntry);
  const anySupported = ranked.some((entry) => entry.supported);
  let cursor = 0;

  // Per-candidate exhaustion diary, in ranked order. Updated as selection
  // walks the chain so the noneRemaining evidence names what actually
  // happened to every candidate — never reconstructed after the fact from a
  // stale resolved-models snapshot (finding 4's bare 60-byte run record).
  const candidateStatuses: {
    storedModelId: string;
    providerLabel: string;
    runnerId: string;
    reason: string;
  }[] = ranked.map((entry) =>
    entry.supported
      ? {
          storedModelId: entry.candidate.storedModelId,
          providerLabel: entry.candidate.providerLabel,
          runnerId: entry.candidate.runnerId,
          reason: "not attempted",
        }
      : {
          storedModelId: entry.storedModelId,
          providerLabel: entry.providerLabel,
          runnerId: entry.runnerId,
          reason: `cannot satisfy the requested "${mode}" mode (skipped at selection time)`,
        }
  );
  const exhaustionEvidence = (): ProviderChainExhaustionV1 => ({
    ...(options.stage !== undefined ? { stage: options.stage } : {}),
    candidates: candidateStatuses.map((status) => ({ ...status })),
  });

  return {
    reserveNext(attemptId: AttemptIdV1): V1ReserveNextResultV1 {
      if (!anySupported) {
        // No ranked candidate can satisfy this mode at all — the whole
        // selection is mode-unavailable (there is nothing to fall back TO,
        // so no per-candidate attempt accounting is warranted).
        return {
          kind: "noneRemaining",
          code: "providerModeUnavailable",
          chainExhaustion: exhaustionEvidence(),
        };
      }
      if (cursor >= ranked.length) {
        return {
          kind: "noneRemaining",
          code: "candidatesExhausted",
          chainExhaustion: exhaustionEvidence(),
        };
      }
      const entry = ranked[cursor]!;
      cursor++;
      if (!entry.supported) {
        // Never silently bypass a ranked candidate (primary OR backup):
        // record it as an explicit settled attempt with the fallback-eligible
        // `providerUnavailablePreInvocation` outcome, so the skip is
        // auditable in the session and the caller allocates a FRESH attempt
        // for the next ranked candidate.
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        return {
          kind: "candidateUnavailable",
          code: "providerModeUnavailable",
          storedModelId: entry.storedModelId,
          providerLabel: entry.providerLabel,
          runnerId: entry.runnerId,
        };
      }
      const { candidate } = entry;
      const handle = session.reserve({
        attemptId,
        mode,
        runnerId: candidate.runnerId,
        providerId: candidate.providerId,
        modelId: candidate.storedModelId,
      });
      // Selection never sees the invocation's own failure (AC-RUNNER-04),
      // so the diary records only the OBSERVATION selection can make: the
      // reservation was handed out. It deliberately does NOT infer what the
      // invocation then did — the earlier "reserved and invoked, but did
      // not produce a usable result" wording was written BEFORE any
      // invocation happened, an inference that read as fact (workflow 3
      // continuation, third item). The session owner (the coordinator)
      // replaces this placeholder with the per-attempt outcome it actually
      // recorded before the evidence reaches any user-facing surface.
      const status = candidateStatuses[cursor - 1];
      if (status) {
        status.reason = "reserved for invocation (see the recorded per-attempt outcome)";
      }
      return {
        kind: "reserved",
        reserved: {
          handle,
          providerLabel: candidate.providerLabel,
          storedModelId: candidate.storedModelId,
          createTransport: candidate.createTransport,
          providerReadsWorkspaceNatively: candidate.providerReadsWorkspaceNatively,
        },
      };
    },
  };
}

/**
 * Production opener for the action coordinator's provider boundary
 * (`RunnerSelectionOpenerV1` in `taskActionCoordinatorV1.ts`, plan §3.8).
 *
 * Binds `openV1RunnerSelection` — keeping this registry the sole source of
 * provider/model ranking and fallback policy — to the invocation-fixed
 * workspace cwd and the invoking route's stage-model resolution. Per
 * operation, the coordinator hands over its own selection session, the
 * row's provider mode, and the request's canonical stage; the registry then
 * ranks candidates and issues every reservation through that session. The
 * opener never invokes a provider (AC-RUNNER-04) — invocation stays with
 * the execution broker.
 */
export function createV1RunnerSelectionOpener(options: {
  /** Working directory CLI transports run in (the workspace root). */
  workspaceCwd: string;
  /**
   * Resolve the coordinator request's canonical stage to the stage's stored
   * (provider-qualified) primary model id and stage key — exactly what the
   * legacy entry points pass today. Returning `modelId: undefined` surfaces
   * the legacy misconfiguration error at selection time.
   */
  resolveStagePrimaryModel: (taskStage: string) => {
    readonly modelId: string | undefined;
    readonly stage: TaskStage | undefined;
  };
  /** Forwarded verbatim to every `openV1RunnerSelection` call — see its doc comment. */
  requireSummaryOnlyCapableText?: boolean;
}): (request: {
  readonly session: ProviderSelectionSessionV1;
  readonly mode: AgentExecutionModeV1;
  readonly taskStage: string;
}) => V1RunnerSelectionV1 {
  return (request) => {
    const resolved = options.resolveStagePrimaryModel(request.taskStage);
    return openV1RunnerSelection({
      session: request.session,
      mode: request.mode,
      modelId: resolved.modelId,
      stage: resolved.stage,
      workspaceCwd: options.workspaceCwd,
      requireSummaryOnlyCapableText: options.requireSummaryOnlyCapableText,
    });
  };
}

/* ------------------------------------------------------------------------ *
 * Stage-chain availability pre-flight (2026-08-13 finding 4, second fix)   *
 * ------------------------------------------------------------------------ */

/** Result of {@link preflightStageChainAvailabilityV1}. */
export type StageChainPreflightResultV1 =
  | {
      /**
       * At least one candidate probed available — or could not be safely
       * probed within the timeout ("unknown" NEVER short-circuits dispatch;
       * the runtime exhaustion path remains the backstop for
       * probe-available/invoke-fail candidates).
       */
      readonly kind: "dispatchable";
    }
  | {
      /** Every enumerable candidate failed a safely probeable availability check. */
      readonly kind: "exhausted";
      readonly exhaustion: ProviderChainExhaustionV1;
    };

/** Per-candidate probe budget — an availability check, not an invocation. */
const STAGE_CHAIN_PREFLIGHT_PROBE_TIMEOUT_MS_V1 = 5000;

/** Race a probe against the timeout; `undefined` means "unknown — fail open". */
async function probeWithTimeoutV1(
  probe: Promise<AgentAvailability>,
  timeoutMs: number
): Promise<AgentAvailability | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch (error) {
    // A probe that throws is a real (safely probeable) failure, not unknown.
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Pre-flight the availability of a stage's ENTIRE resolved provider chain
 * before dispatching a round (finding 4: an unavailable-provider stall is
 * predictable, so it should be reported as "no configured provider for
 * <stage> is available" BEFORE a round burns, not discovered as a 60-byte
 * run file afterwards).
 *
 * Enumerates candidates through the exact same chain-building path
 * `openV1RunnerSelection` walks (`rankedStageChainStoredIdsV1` — the stored
 * primary plus live strategy-gated backups) with NO reservation commit, and
 * probes each with the existing side-effect-free availability machinery:
 * `isAvailable()` for text-capable stages (the same primitive
 * `checkRunnerAvailabilityForModel` uses, with `isAuthenticationFailure`
 * classification), or the implementation-availability check for edit-capable
 * stages. Each probe is bounded by a short timeout treated as "unknown — do
 * not short-circuit": ONLY a chain whose every candidate fails a safely
 * probeable check reports exhaustion; anything else fails open to dispatch,
 * leaving the runtime exhaustion evidence as the backstop.
 */
export async function preflightStageChainAvailabilityV1(
  stage: TaskStage,
  options: {
    /** The stage's stored primary model id (the caller's fresh resolution). */
    modelId: string | undefined;
    /** Probe the edit-capable availability path instead of the text path. */
    editCapable?: boolean;
    probeTimeoutMs?: number;
    /** Test seam: probe one candidate. Defaults to the production probes. */
    probeCandidate?: (storedModelId: string) => Promise<AgentAvailability>;
  }
): Promise<StageChainPreflightResultV1> {
  const timeoutMs = options.probeTimeoutMs ?? STAGE_CHAIN_PREFLIGHT_PROBE_TIMEOUT_MS_V1;

  let rankedStoredIds: string[];
  try {
    rankedStoredIds = rankedStageChainStoredIdsV1(stage, options.modelId);
  } catch {
    // The same misconfiguration selection would throw on. Not this
    // function's failure to report — fail open and let the dispatch path
    // surface its own configured error.
    return { kind: "dispatchable" };
  }

  const defaultProbe = async (storedModelId: string): Promise<AgentAvailability> => {
    const effective = resolveEffectiveProvider(storedModelId);
    if (options.editCapable) {
      if (effective.kind === "copilot") {
        return checkImplementationAvailability();
      }
      const exists = await cliCommandExists(effective.def.command, effective.def.commandAliases);
      return exists
        ? { available: true }
        : {
            available: false,
            reason: `The ${cliDisplayLabel(effective.def)} CLI (${effective.def.command}) is not installed. ${effective.def.installHint}`,
          };
    }
    return toResolvedRunner(effective).runner.isAvailable();
  };
  const probeCandidate = options.probeCandidate ?? defaultProbe;

  const candidates: ProviderChainCandidateStatusV1[] = [];
  for (const storedModelId of rankedStoredIds) {
    let providerLabel = storedModelId;
    let runnerId = "unknown";
    try {
      const effective = resolveEffectiveProvider(storedModelId);
      providerLabel = effective.kind === "copilot" ? "Copilot" : effective.def.label;
      runnerId = effective.kind === "copilot" ? "copilot-lm" : effective.def.id;
    } catch (error) {
      candidates.push({
        storedModelId,
        providerLabel,
        runnerId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const availability = await probeWithTimeoutV1(
      Promise.resolve().then(() => probeCandidate(storedModelId)),
      timeoutMs
    );
    if (availability === undefined || availability.available) {
      // Available, or unknown within the probe budget — either way the
      // chain is dispatchable and the pre-flight must not short-circuit.
      return { kind: "dispatchable" };
    }
    const reason = availability.reason ?? "the provider reported itself unavailable";
    candidates.push({
      storedModelId,
      providerLabel,
      runnerId,
      reason: isAuthenticationFailure(availability.reason)
        ? `authentication failure: ${reason}`
        : reason,
    });
  }

  return {
    kind: "exhausted",
    exhaustion: { stage, candidates },
  };
}
