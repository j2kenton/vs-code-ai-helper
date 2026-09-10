/**
 * Provider dispatch (plan Part 4b): the real `EngineProviderRunnerV1` behind
 * the Part 4a task loop, porting the extension's runner-registry semantics
 * (`src/runners/runnerRegistry.ts`) for the engine's direct-API providers:
 *
 *  - **Chain resolution.** Each invocation resolves the stage's effective
 *    model chain (skip flags applied, general-model fallback) from the
 *    settings snapshot, then routes through any active sticky fallback
 *    exactly as `resolveModelForStage` does.
 *  - **Runner-entry guard.** A model whose provider the user disabled never
 *    runs, no matter which path resolved it; the guard is active only once a
 *    provider selection actually exists.
 *  - **Quota-triggered fallback cascade.** A primary failure classified
 *    quota/temporarily-unavailable/model-entitlement — and ONLY such a
 *    failure — may spend the stage's backup allocation, gated on the effective chain's
 *    "switch-to-backup" strategy. The reservation is an atomic once-per-
 *    stage-epoch claim on the fallback state store; an unresolved
 *    reservation (no backup completed) is always released, and a completed
 *    backup is recorded as the stage's sticky fallback so later invocations
 *    route straight to the known-working model.
 *  - **Auth failures never cascade.** Neither a primary nor a backup auth
 *    failure spends further backups — expired credentials must surface, not
 *    burn through every configured model. A backup's auth failure also
 *    releases the reservation (a failed backup must not become the sticky
 *    route).
 *  - **Result-frame discipline.** Every provider response parses through the
 *    strict `ensemble.aiResultContract.v1` envelope parser with the
 *    invocation's correlation as the expected echo; anything malformed is a
 *    typed retryable failure, never promoted content.
 *
 * The extension's Copilot LM path is replaced by the direct-API adapters
 * (`providerAdaptersV1.ts`) per the plan. Its CLI-transport path has one
 * counterpart here: a `sandbox-cli` provider (`claude-cli`) dispatches to an
 * injected `EngineCliTransportRunnerV1` that runs the real CLI INSIDE the
 * task's sandbox (`sandboxCliRunnerV1.ts`) — never on the engine host, which
 * is also why edit-mode dispatch exists only there: generated code executes
 * only in the user's sandbox (Part 4d). A CLI round takes part in the same
 * chain resolution, runner-entry guard, and quota cascade as an API round;
 * only the leaf "run this model" step differs.
 */
import {
  buildAiResultContractPromptV1,
} from "../../ensemble-core/src/aiResultContractV1";
import { canonicalJsonTextV1 } from "../../ensemble-core/src/structuredQuestionV1";
import { EnabledProviders, ModelSettings } from "../../ensemble-core/src/settingsV1";
import { TaskStage } from "../../ensemble-core/src/taskProgressV1";
import {
  classifyEngineProviderFailureV1,
  createQuotaObservationLedgerV1,
  EngineFailureKindV1,
  EngineQuotaObservationLedgerV1,
  isCascadeEligibleFailureKindV1,
} from "./failureClassificationV1";
import {
  backupModelsForStageV1,
  resolveEffectiveStageChainV1,
  resolveEngineModelForStageV1,
} from "./modelChainV1";
import {
  EngineModelProviderAdapterV1,
} from "./providerAdaptersV1";
import {
  EngineProviderIdV1,
  isEngineModelProviderDisabledV1,
  normalizeEngineQualifiedModelIdV1,
  parseEngineModelSelectionV1,
} from "./providerCatalogV1";
import { parseAiResultEnvelopeV1 } from "./resultEnvelopeV1";
import {
  EngineProviderInvocationV1,
  EngineProviderRunnerV1,
  EngineRoundResultV1,
} from "./taskLoopV1";

// ─── Durable per-stage fallback state ────────────────────────────────────────

export interface EngineFallbackStateV1 {
  readonly active: boolean;
  readonly modelId?: string;
}

/**
 * The per-task, per-stage fallback reservation/routing state. Semantics are
 * the extension's `fallbackActive`/`fallbackModelId` task-progress fields
 * (reserve/release/record are the ports of `reserveFallback`,
 * `releaseUnresolvedFallbackReservation`, and `recordActiveFallbackModel`);
 * the Part 5 durable store implements this same interface with a real
 * transactional CAS. Every method must behave atomically per stage.
 */
export interface EngineFallbackStateStoreV1 {
  read(stage: TaskStage): Promise<EngineFallbackStateV1>;
  /**
   * Claim the stage's single fallback switch-over for this epoch: returns
   * false when a reservation is already active (a concurrent run owns it).
   * Claiming clears any recorded model id — the intermediate "reserved, no
   * known-working backup yet" state.
   */
  reserve(stage: TaskStage): Promise<boolean>;
  /**
   * Release a reservation that never resolved to a completed backup. A named
   * fallback model is retained deliberately: it can only have been written
   * after a completed backup and is therefore a valid route to preserve.
   */
  releaseUnresolved(stage: TaskStage): Promise<void>;
  /** Record the backup that actually completed as the stage's sticky route. */
  record(stage: TaskStage, modelId: string): Promise<void>;
}

/** In-memory reference implementation (tests / single-process dev). */
export function createInMemoryFallbackStateStoreV1(): EngineFallbackStateStoreV1 {
  const state = new Map<TaskStage, { active: boolean; modelId?: string }>();
  return {
    read(stage): Promise<EngineFallbackStateV1> {
      const entry = state.get(stage);
      return Promise.resolve(
        entry ? { active: entry.active, ...(entry.modelId !== undefined ? { modelId: entry.modelId } : {}) } : { active: false }
      );
    },
    reserve(stage): Promise<boolean> {
      const entry = state.get(stage);
      if (entry?.active) {
        return Promise.resolve(false);
      }
      state.set(stage, { active: true });
      return Promise.resolve(true);
    },
    releaseUnresolved(stage): Promise<void> {
      const entry = state.get(stage);
      if (entry?.active && entry.modelId === undefined) {
        state.delete(stage);
      }
      return Promise.resolve();
    },
    record(stage, modelId): Promise<void> {
      state.set(stage, { active: true, modelId });
      return Promise.resolve();
    },
  };
}

// ─── Prompt construction ─────────────────────────────────────────────────────

export const ENGINE_ROUND_PERMITTED_RESULT_KINDS_V1 = [
  "completed",
  "questions",
  "failed",
] as const;
export const ENGINE_ROUND_MAX_RESPONSE_BYTES_V1 = 4 * 1024 * 1024;

const READ_ONLY_STAGE_RULE_V1 =
  "This stage is READ-ONLY: do not create, modify, or delete any file, and do not run commands " +
  "that change anything. If a tool is unavailable or an action is blocked, that is expected here — " +
  "do not report a failure for it; complete the stage with your best output as response text.";

/**
 * What each stage is for, told to the model in its own words. Without this
 * the prompt called every round an "implementation" round, and a
 * description-stage model — running read-only, as every non-impl stage
 * does — tried to write the requested file, was blocked, and reported the
 * whole task failed (`plan_mode_blocked_write`, observed live 2026-09-10).
 * The stage vocabulary is the core `TaskStage`; the loop's checklist rule
 * (ticked items accumulate into the plan of record; a checklist-less plan
 * advances one round per stage) is stated so the model's echo drives it.
 */
export const ENGINE_STAGE_GUIDANCE_V1: Readonly<Record<TaskStage, string>> = {
  desc:
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: understand the request. Return a concise task description as markdown — " +
    "goal, scope, constraints, and acceptance criteria. If the plan of record already carries a " +
    "checklist, echo it unchanged.",
  plan:
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: plan the work. Return an implementation plan as a markdown checklist " +
    "(`- [ ] step`), each step small and independently verifiable. If the plan of record already " +
    "carries a checklist, keep its items and their ticks; refine, do not replace.",
  "plan-high-review":
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: review the plan of record for correctness, completeness, ordering, and " +
    "risk. Return the checklist (ticks preserved) followed by your review findings.",
  "plan-low-review":
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: a second, detail-level review of the plan of record — missing steps, " +
    "unclear acceptance criteria, edge cases. Return the checklist (ticks preserved) followed by " +
    "your findings.",
  impl:
    "This stage IMPLEMENTS the plan of record: edit files in the working directory and run the " +
    "commands the work needs. When you stop, return the plan's checklist with every item you " +
    "completed ticked (`- [x]`), untouched items left as they were, and a `<!-- progress: N/M -->` " +
    "marker. Do not tick what you did not do.",
  "impl-high-review":
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: review the implemented changes against the plan of record — correctness, " +
    "completeness, tests. Return the checklist reflecting what is ACTUALLY done (untick anything " +
    "claimed but not delivered) followed by your findings.",
  "impl-low-review":
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: a detail-level review of the implemented changes — edge cases, error " +
    "handling, naming, leftover debug code. Return the checklist reflecting what is actually done, " +
    "followed by your findings.",
  publish:
    `${READ_ONLY_STAGE_RULE_V1}\n` +
    "Goal of this stage: summarize what was delivered for the person who asked — what changed, " +
    "how to verify it, anything left open. Return the final checklist followed by that summary.",
};

/**
 * Deterministic round prompt: the stage's guidance, the plan of record, the
 * user's validated answers when resuming a question pause, and the
 * result-contract fragment (which embeds the invocation's correlation
 * echo). Same inputs, same bytes — the prompt-contract digest recorded in
 * Chat transactions relies on it.
 */
export function buildEngineRoundPromptV1(input: EngineProviderInvocationV1): string {
  const sections: string[] = [
    "You are the Ensemble engine's agent for one round of a staged task.",
    `Task: ${input.taskId} (stage: ${input.stage}, round ${input.round}).`,
    "",
    "--- Stage ---",
    ENGINE_STAGE_GUIDANCE_V1[input.stage],
    "--- End stage ---",
    "",
    "--- Plan of record ---",
    input.planOfRecord,
    "--- End plan of record ---",
  ];
  if (input.answers !== undefined) {
    sections.push(
      "",
      "--- User answers to your structured questions ---",
      canonicalJsonTextV1(JSON.parse(JSON.stringify(input.answers))),
      "--- End user answers ---"
    );
  }
  sections.push(
    "",
    buildAiResultContractPromptV1({
      correlation: input.correlation,
      permittedResultKinds: ENGINE_ROUND_PERMITTED_RESULT_KINDS_V1,
      completedContentType: "markdown-artifact.v1",
      maxResponseBytes: ENGINE_ROUND_MAX_RESPONSE_BYTES_V1,
    })
  );
  return sections.join("\n");
}

// ─── Failure codes shared by every transport ─────────────────────────────────

/**
 * The round failure codes that carry capacity/credential meaning across the
 * dispatch boundary. Both transports report failures with these exact codes
 * so the cascade decision (`engineFailureKindForCodeV1`) reads the same
 * whether the round ran through an HTTP adapter or a sandboxed CLI.
 */
export const ENGINE_CLASSIFIED_FAILURE_CODES_V1 = {
  quota: "quotaExhausted",
  temporarilyUnavailable: "temporarilyUnavailable",
  modelEntitlement: "modelEntitlementBlocked",
  authentication: "authenticationFailed",
} as const;

/** The failure code for a classified provider failure; `genericCode` when it is neither capacity- nor auth-shaped. */
export function engineFailureCodeForKindV1(
  failureKind: EngineFailureKindV1,
  authFailure: boolean,
  genericCode: string
): string {
  switch (failureKind) {
    case "quota":
      return ENGINE_CLASSIFIED_FAILURE_CODES_V1.quota;
    case "temporarily-unavailable":
      return ENGINE_CLASSIFIED_FAILURE_CODES_V1.temporarilyUnavailable;
    case "model-entitlement":
      return ENGINE_CLASSIFIED_FAILURE_CODES_V1.modelEntitlement;
    case "generic":
      return authFailure ? ENGINE_CLASSIFIED_FAILURE_CODES_V1.authentication : genericCode;
  }
}

/** The inverse: which classification a transport-reported code stands for; undefined for any other code. */
export function engineFailureKindForCodeV1(
  code: string
): { readonly failureKind: EngineFailureKindV1; readonly authFailure: boolean } | undefined {
  switch (code) {
    case ENGINE_CLASSIFIED_FAILURE_CODES_V1.quota:
      return { failureKind: "quota", authFailure: false };
    case ENGINE_CLASSIFIED_FAILURE_CODES_V1.temporarilyUnavailable:
      return { failureKind: "temporarily-unavailable", authFailure: false };
    case ENGINE_CLASSIFIED_FAILURE_CODES_V1.modelEntitlement:
      return { failureKind: "model-entitlement", authFailure: false };
    case ENGINE_CLASSIFIED_FAILURE_CODES_V1.authentication:
      return { failureKind: "generic", authFailure: true };
    default:
      return undefined;
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * The leaf runner for a `sandbox-cli` provider. Unlike an HTTP adapter it
 * returns a FINISHED round: prompt construction, frame parsing, and failure
 * classification happen inside it, so the CLI path and the API path parse
 * the same bytes with the same parser and report the same codes. The model
 * is the selection's provider-native part (`claude-cli:opus@high` → `opus@high`),
 * or undefined for the CLI's own default.
 */
export interface EngineCliTransportRunnerV1 {
  invokeWithModel(
    input: EngineProviderInvocationV1,
    model: string | undefined
  ): Promise<EngineRoundResultV1>;
}

export interface CreateEngineProviderRunnerOptionsV1 {
  /** Settings snapshots — the control plane's per-user settings store. */
  getModelSettings(): ModelSettings;
  getEnabledProviders(): EnabledProviders | undefined;
  /**
   * Resolve the user's API key for a provider (Part 5 custody: decrypted
   * only in engine-run memory; never logged, never persisted by the engine).
   */
  getProviderApiKey(provider: EngineProviderIdV1): string | undefined;
  readonly adapters: ReadonlyMap<EngineProviderIdV1, EngineModelProviderAdapterV1>;
  /**
   * The runner for a `sandbox-cli` provider, resolved per call because it is
   * bound to the task's sandbox (which may not exist yet, or any more).
   * Absent — or returning undefined — a CLI selection fails the round with
   * `cliRunnerUnavailable`, a terminal (non-cascading) failure: routing
   * around a missing sandbox to an API-keyed backup would silently change
   * who pays for the round.
   */
  cliRunnerFor?(provider: EngineProviderIdV1): EngineCliTransportRunnerV1 | undefined;
  /** Defaults to a fresh in-memory store (tests / single-process dev). */
  readonly fallbackState?: EngineFallbackStateStoreV1;
  readonly quotaLedger?: EngineQuotaObservationLedgerV1;
  readonly now?: () => Date;
}

type AttemptOutcome =
  | { readonly kind: "round"; readonly result: EngineRoundResultV1 }
  | {
      readonly kind: "failure";
      readonly failureKind: EngineFailureKindV1;
      readonly authFailure: boolean;
      readonly code: string;
      readonly errorMessage: string;
    };

export function createEngineProviderRunnerV1(
  options: CreateEngineProviderRunnerOptionsV1
): EngineProviderRunnerV1 {
  const fallbackState = options.fallbackState ?? createInMemoryFallbackStateStoreV1();
  const quotaLedger =
    options.quotaLedger ?? createQuotaObservationLedgerV1(options.now ?? (() => new Date()));

  async function attempt(
    modelId: string,
    input: EngineProviderInvocationV1,
    enabledProviders: EnabledProviders | undefined
  ): Promise<AttemptOutcome> {
    const parsed = parseEngineModelSelectionV1(modelId);
    if (!parsed.ok) {
      return {
        kind: "failure",
        failureKind: "generic",
        authFailure: false,
        code: parsed.code,
        errorMessage: parsed.reason,
      };
    }
    const { provider, model } = parsed.selection;
    if (isEngineModelProviderDisabledV1(enabledProviders, modelId)) {
      // Runner-entry guard: never run a disabled provider's model, no matter
      // which path resolved it. Generic (never cascade-eligible) — routing
      // around the user's explicit disable via a backup would defeat it.
      return {
        kind: "failure",
        failureKind: "generic",
        authFailure: false,
        code: "providerDisabled",
        errorMessage:
          `The selected model ("${modelId}") belongs to ${provider.label}, which is disabled ` +
          "in Provider Selection. Enable the provider or choose another model.",
      };
    }
    if (provider.transport === "sandbox-cli") {
      const cliRunner = options.cliRunnerFor?.(provider.id);
      if (cliRunner === undefined) {
        return {
          kind: "failure",
          failureKind: "generic",
          authFailure: false,
          code: "cliRunnerUnavailable",
          errorMessage:
            `${provider.label} runs inside the task's sandbox, and no sandbox is available to this run.`,
        };
      }
      const result = await cliRunner.invokeWithModel(input, model);
      // The CLI runner already classified its failure; lift the capacity-
      // and credential-shaped ones back into cascade decisions so a CLI
      // quota exhaustion spends a backup exactly as an API 429 would.
      const lifted = result.kind === "failed" ? engineFailureKindForCodeV1(result.code) : undefined;
      if (result.kind === "failed" && lifted !== undefined) {
        return {
          kind: "failure",
          failureKind: lifted.failureKind,
          authFailure: lifted.authFailure,
          code: result.code,
          errorMessage: `${provider.label} reported ${result.code}`,
        };
      }
      return { kind: "round", result };
    }

    const apiKey = options.getProviderApiKey(provider.id);
    if (apiKey === undefined || apiKey.length === 0) {
      // Credentials problems are terminal for the provider (auth semantics):
      // they must surface to the user, never silently burn a backup.
      return {
        kind: "failure",
        failureKind: "generic",
        authFailure: true,
        code: "missingApiKey",
        errorMessage: `No API key is configured for ${provider.label}. Add one in Settings.`,
      };
    }
    const adapter = options.adapters.get(provider.id);
    if (adapter === undefined) {
      return {
        kind: "failure",
        failureKind: "generic",
        authFailure: false,
        code: "adapterUnavailable",
        errorMessage: `No adapter is registered for provider ${provider.label}.`,
      };
    }

    const invoked = await adapter.invokeText({
      prompt: buildEngineRoundPromptV1(input),
      model,
      apiKey,
    });
    if (invoked.status === "failed") {
      const classified = classifyEngineProviderFailureV1({
        errorMessage: invoked.errorMessage,
        ...(invoked.authFailure !== undefined ? { authFailure: invoked.authFailure } : {}),
      });
      return {
        kind: "failure",
        failureKind: classified.failureKind,
        authFailure: invoked.authFailure === true,
        code: engineFailureCodeForKindV1(
          classified.failureKind,
          invoked.authFailure === true,
          "providerRequestFailed"
        ),
        errorMessage: invoked.errorMessage,
      };
    }

    const envelope = parseAiResultEnvelopeV1(invoked.text, input.correlation);
    if (envelope.kind === "malformed") {
      // Malformed output is a provider-behavior defect, not capacity: it is
      // retryable but never cascade-eligible (a different model would run a
      // duplicate round for what may be a prompt/framing issue).
      return {
        kind: "round",
        result: {
          kind: "failed",
          code: `malformedResult.${envelope.code}`,
          retryable: true,
        },
      };
    }
    if (envelope.kind === "questions") {
      return { kind: "round", result: { kind: "questions", questions: envelope.questions } };
    }
    if (envelope.kind === "completed") {
      if (envelope.content.contentType !== "markdown-artifact.v1") {
        return {
          kind: "round",
          result: { kind: "failed", code: "unexpectedContentType", retryable: true },
        };
      }
      return {
        kind: "round",
        result: { kind: "completed", summaryMarkdown: envelope.content.markdown },
      };
    }
    if (envelope.kind === "cancelled") {
      return {
        kind: "round",
        result: { kind: "failed", code: "cancelled", retryable: false },
      };
    }
    // envelope.kind === "failed": the model itself reported a typed failure.
    // Its message still participates in quota classification so a provider
    // that reports its own rate limiting through the frame cascades too.
    const classified = classifyEngineProviderFailureV1({ errorMessage: envelope.message });
    if (classified.failureKind === "generic") {
      return {
        kind: "round",
        result: { kind: "failed", code: envelope.code, retryable: envelope.retryable },
      };
    }
    return {
      kind: "failure",
      failureKind: classified.failureKind,
      authFailure: false,
      code: envelope.code,
      errorMessage: envelope.message,
    };
  }

  function toFailedRound(outcome: Extract<AttemptOutcome, { kind: "failure" }>): EngineRoundResultV1 {
    return {
      kind: "failed",
      code: outcome.code,
      retryable: !outcome.authFailure && outcome.failureKind !== "generic",
    };
  }

  return {
    async invoke(input: EngineProviderInvocationV1): Promise<EngineRoundResultV1> {
      const settings = options.getModelSettings();
      const enabledProviders = options.getEnabledProviders();
      const chain = resolveEffectiveStageChainV1(settings, input.stage);
      if (!chain.primary) {
        return { kind: "failed", code: "noModelConfigured", retryable: false };
      }

      // Sticky fallback routing: an active reservation with a recorded
      // known-working backup routes straight to it.
      const resolved = resolveEngineModelForStageV1(
        settings,
        input.stage,
        await fallbackState.read(input.stage)
      );
      const primaryModelId = resolved.modelId ?? chain.primary;

      const primary = await attempt(primaryModelId, input, enabledProviders);
      if (primary.kind === "round") {
        quotaLedger.record(input.stage, primaryModelId, undefined);
        return primary.result;
      }
      quotaLedger.record(
        input.stage,
        primaryModelId,
        primary.failureKind,
        primary.errorMessage
      );

      const cascadeEligible =
        !primary.authFailure && isCascadeEligibleFailureKindV1(primary.failureKind);
      const backups = backupModelsForStageV1(
        settings,
        enabledProviders,
        input.stage,
        primaryModelId
      );
      if (!cascadeEligible || backups.length === 0) {
        return toFailedRound(primary);
      }

      // Atomic once-per-stage-epoch switch-over claim: a concurrent run that
      // lost the claim reports its own failure instead of double-spending
      // the backup allocation.
      const reserved = await fallbackState.reserve(input.stage);
      if (!reserved) {
        return toFailedRound(primary);
      }

      let last: Extract<AttemptOutcome, { kind: "failure" }> = primary;
      for (const backupModel of backups) {
        const outcome = await attempt(backupModel, input, enabledProviders);
        if (outcome.kind === "round") {
          quotaLedger.record(input.stage, backupModel, undefined);
          if (outcome.result.kind === "failed") {
            // A failed backup (malformed frame, cancelled, model-reported
            // failure) cannot be the stage's sticky fallback — release the
            // reservation and stop rather than cascading a third candidate.
            await fallbackState.releaseUnresolved(input.stage);
            return outcome.result;
          }
          await fallbackState.record(
            input.stage,
            normalizeEngineQualifiedModelIdV1(backupModel)
          );
          return outcome.result;
        }
        quotaLedger.record(input.stage, backupModel, outcome.failureKind, outcome.errorMessage);
        last = outcome;
        // Auth and generic failures are terminal for this run, and neither
        // makes this backup a known-good route for later runs.
        if (outcome.authFailure || outcome.failureKind === "generic") {
          await fallbackState.releaseUnresolved(input.stage);
          return toFailedRound(outcome);
        }
      }
      await fallbackState.releaseUnresolved(input.stage);
      return toFailedRound(last);
    },
  };
}
