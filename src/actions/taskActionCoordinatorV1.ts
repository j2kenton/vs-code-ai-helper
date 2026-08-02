/**
 * Task action coordinator (plan §3.8, `src/actions/taskActionCoordinatorV1.ts`).
 *
 * The one component that may decode provider envelopes or promote completed
 * content (plan product decisions). For a provider row it owns the complete
 * §3.3 flow: allocate the operation, open one selection session, allocate a
 * globally unique attempt, take exactly one claim-once reservation, invoke it
 * through the execution broker, decode and correlate the framed result,
 * report the attempt outcome exactly once, and map everything into the
 * closed `TaskActionOutcomeV1` union. Fallback to another provider happens
 * only after a pre-response outcome, with a fresh attempt and an explicit
 * next reservation (AC-RUNNER-03/05).
 *
 * RESUME — `resumeAction` is the production Resume entrypoint (plan §5.5 /
 * §6.1 / AC-QUESTION-03): it loads the durable Chat interaction transaction,
 * revalidates the task/document binding, current registry eligibility, and
 * the validated-input snapshot's advisory revisions through the row's own
 * validator, settles the transaction exactly once per the row's declared
 * `ResumeSemanticsV1`, and then reconstructs and runs the action — same
 * operation with the linkage's recorded new attempt (`sameOperation`), or a
 * fresh linked operation (`replacementOperation`) — with the recorded
 * answers in the execution context. The §3.1 Resume idempotency id is
 * CALLER-OWNED and required: callers allocate and persist it before driving
 * Resume, and re-driving with the identical id after a crash replays the
 * recorded resolution — a `sameOperation` replay executes under exactly the
 * attempt id the settled transaction binds to, never an unbound fresh one.
 * Every rejection before settlement (including duplicate rejection) leaves
 * the interaction resumable.
 *
 * A settled resolution replaying idempotently is NOT the same as its
 * provider invocation being safe to run twice (AC-RUNNER-03: invocation-once
 * per attempt). `resumeAction` claims that specific invocation via
 * `orchestrator.claimResumeInvocation` immediately before calling
 * `runProviderRow` — the actual reservation/invocation boundary, deliberately
 * AFTER local session/selection setup (which is pure in-memory bookkeeping,
 * not itself "the invocation") so a crash during that setup leaves no claim
 * at all and the interaction stays fully retryable. The claim is taken over
 * the transaction store, so it survives a crash and is visible across
 * extension-host instances, not just within this process's in-memory
 * selection session.
 *
 * A bare claim alone cannot distinguish "the earlier drive completed", "it
 * is still running", and "it crashed mid-invocation" — so once a claimed
 * invocation runs `runProviderRow` to completion, `resumeAction` durably
 * mirrors its exact `TaskActionOutcomeV1` via
 * `orchestrator.recordResumeInvocationOutcome` (best-effort: the real
 * outcome is still returned to the caller even if this write fails). A
 * re-drive that finds `alreadyClaimed` now checks for that recorded outcome
 * first: present means recover and return that EXACT outcome instead of
 * invoking the provider again ("recover the claimed terminal result");
 * absent means the outcome is genuinely unknown, and only then is the
 * outcome the non-retryable `resumeInvocationAlreadyClaimed` failure — the
 * provider is NOT invoked either way once `alreadyClaimed` is true.
 *
 * THE CLAIM'S EXACT POSITION — the claim is taken from INSIDE
 * `runProviderRow`, immediately before the one line that is the true
 * invocation boundary (the broker's `invoke` call), not before
 * `runProviderRow` is called. Attempt allocation, reservation, the
 * in-memory reservation claim (`session.claim`), prompt construction,
 * execution-request assembly, TRANSPORT CONSTRUCTION, and the broker's
 * entire pre-invocation phase (`prepareAgentInvocationV1`: request/
 * reservation/transport validation, consumption of the reservation's
 * single invocation, the pre-requested cancellation check, bounded-writer
 * creation) all happen first — every one of them is local setup with no
 * side effect outside this process — so a throw or crash anywhere in that
 * work, or during the session/selection setup that precedes
 * `runProviderRow` itself, leaves no durable claim at all and the
 * interaction stays fully retryable. Only the (unavoidable) gap between the
 * durable claim write actually landing and the broker `invoke` starting is
 * ever at risk of "claimed but nothing to show for it" — every other step
 * that used to sit inside that window has been moved out of it. The claim is
 * taken exactly once per drive (via the `claimInvocationOnce` gate passed
 * into `runProviderRow`): once it has passed for the drive's first real
 * invocation attempt, any later fallback attempt within the SAME drive
 * proceeds directly, since re-claiming an already-owned invocation would be
 * meaningless. `resumeAction` only calls `recordResumeInvocationOutcome`
 * when this drive itself won the claim — never when the gate reports
 * `alreadyClaimed` (that outcome, recovered or not, was never this drive's
 * to (re-)record) and never when no candidate provider was ever reached
 * (nothing was claimed, so nothing to record).
 *

 * LEASE PHASES — plan §6.1 rule 6 releases leases before provider/user
 * waits, so a provider operation never holds its task-operation lease across
 * the broker invocation. The lease is taken in two short phases instead:
 *  - START: acquired around duplicate rejection and selection setup, released
 *    before the first provider invocation;
 *  - SETTLEMENT: re-acquired only to promote completed content, released in
 *    that phase's own finally. If another operation took the lease during
 *    the provider wait, promotion is blocked fail-safe (`duplicateRejected`)
 *    and nothing is promoted; the row's `promoteCompletedContent` remains the
 *    revision-revalidation point (plan §6.2's revision-checked replacement),
 *    so content staled by an interleaved operation cannot clobber artifacts.
 * Lifecycle rows contain no provider/user wait and keep one short lease
 * across their whole `execute`.
 *
 * PRESENTATION AND LOGGING — the coordinator centralizes both (plan §3.8):
 * every invocation presents the row's declared `progressLabel` through the
 * injected `TaskActionPresenterV1` for exactly the execution span, and every
 * invocation emits exactly one sanitized settlement record through
 * `TaskActionAuditLoggerV1` under the row's declared logging policy. The
 * record shape is closed to §2.2's permitted fields: correlation IDs,
 * timestamps, statuses, codes, byte counts, and digests — never prompt,
 * question, artifact, or provider text.
 *
 * WHICH provider serves an attempt is not this module's decision: the
 * coordinator consumes `runnerRegistry.ts`'s operation-bound V1 selection
 * contract verbatim. `RunnerSelectionOpenerV1` opens a `V1RunnerSelectionV1`
 * for the coordinator's own selection session, and every reservation is
 * issued by the registry through `reserveNext(attemptId)` — the registry
 * remains the sole source of provider/model ranking and fallback policy and
 * never invokes a provider (plan product decisions; AC-RUNNER-04). The
 * production opener is `createV1RunnerSelectionOpener` in `runnerRegistry.ts`,
 * which binds `openV1RunnerSelection` to the invocation-fixed workspace cwd
 * and the invoking route's stage-model resolution.
 *
 * After the lease is released, the coordinator consumes the row's declared
 * `followUpActionKey` for a completed outcome — at most one follow-up per
 * invocation (plan §3.8 / AC-LIFECYCLE-02) — through the injected
 * `TaskActionFollowUpSchedulerV1`.
 *
 * ENFORCEMENT STATE — nothing in production constructs a coordinator yet.
 * Every AI route remains gated (`LEGACY_AI_ROUTE_DISABLED_V0`), and the
 * broker independently rejects any action key missing from
 * `MIGRATED_ACTION_KEYS_V0`, so a coordinator built ahead of a cohort's
 * migration cannot invoke anything even if constructed.
 */
import { createHash } from "crypto";
import type * as vscode from "vscode";
import {
  ActionCorrelationV1,
  ActionKeyV1,
  allocateHex128IdV1,
  isHex128IdV1,
  OperationIdV1,
  TaskBindingRefV1,
} from "../types/actionCorrelationV1";
import {
  AgentExecutionModeV1,
  AgentExecutionRequestV1,
  AgentTransportV1,
  SealedResultPayloadV1,
} from "../types/agentExecutionV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";
import { ObservationLedgerV1 } from "../types/preflightPlanV1";
import { AiResultEnvelopeV1, parseAiResultEnvelopeV1 } from "../types/aiResultEnvelope";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { unavailableV1 } from "../types/workflowAvailabilityV1";
import {
  AgentExecutionBrokerOptionsV1,
  PreparedAgentInvocationV1,
  prepareAgentInvocationV1,
} from "../services/agentExecutionBrokerV1";
import {
  AttemptOutcomeKindV1,
  openProviderSelectionSessionV1,
  ProviderSelectionSessionV1,
} from "../services/providerSelectionPolicyV1";
import { TaskOperationLeaseAcquireResultV1, WorkflowLeaseStoreV1 } from "../services/workflowLeaseStoreV1";
import {
  AI_RESULT_CONTRACT_ID_V1,
  AI_RESULT_CONTRACT_VERSION_V1,
  buildAiResultContractPromptV1,
} from "../prompts/aiResultContractV1";
import {
  ActionConversationErrorV1,
  ActionConversationOrchestratorV1,
  InteractionRefV1,
  ResumeResolutionV1,
} from "./actionConversationOrchestratorV1";
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionLoggingPolicyV1,
  TaskActionRegistryRowV1,
  TaskActionRegistryV1,
} from "./taskActionRegistryV1";
import type { StructuredAnswerV1 } from "../types/structuredQuestionV1";
import type { V1RunnerSelectionV1 } from "../runners/runnerRegistry";
import { STAGE_ORDER, TaskProgress, TaskStage } from "../types/taskProgress";

export class TaskActionCoordinatorErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskActionCoordinatorErrorV1";
  }
}

/**
 * Everything the registry's selection needs from the coordinator to open one
 * operation-bound ranked selection: the coordinator's own selection session
 * (so every reservation flows through the session's claim-once accounting),
 * the row's provider mode, and the request's canonical stage (the registry's
 * ranking and fallback policy are stage-scoped).
 */
export interface RunnerSelectionOpenRequestV1 {
  readonly session: ProviderSelectionSessionV1;
  readonly mode: AgentExecutionModeV1;
  readonly taskStage: string;
}

/**
 * Opens `runnerRegistry.ts`'s V1 selection for one coordinator operation.
 * The returned `V1RunnerSelectionV1` is the registry's own contract — the
 * coordinator never chooses a runner/provider/model and never issues a
 * reservation itself. Production wiring: `createV1RunnerSelectionOpener`
 * (`runnerRegistry.ts`), which binds `openV1RunnerSelection`.
 */
export type RunnerSelectionOpenerV1 = (
  request: RunnerSelectionOpenRequestV1
) => V1RunnerSelectionV1;

/** At most one declared follow-up per completed invocation (plan §3.8 / AC-LIFECYCLE-02). */
export interface TaskActionFollowUpRequestV1 {
  readonly followUpActionKey: ActionKeyV1;
  readonly sourceActionKey: ActionKeyV1;
  readonly sourceOperationId: OperationIdV1;
  readonly taskBinding: TaskBindingRefV1;
}

export interface TaskActionFollowUpSchedulerV1 {
  schedule(request: TaskActionFollowUpRequestV1): void;
}

/** What the coordinator presents for one invocation: the row's declared label plus correlation. */
export interface TaskActionProgressPresentationV1 {
  readonly actionKey: ActionKeyV1;
  readonly operationId: OperationIdV1;
  /** The registry row's declared user-facing `progressLabel` (plan §3.8). */
  readonly progressLabel: string;
}

export interface TaskActionProgressHandleV1 {
  /** Ends this invocation's progress presentation; called exactly once, in the outermost finally. */
  end(): void;
}

/**
 * Coordinator-owned progress presentation (plan §3.8: the coordinator owns
 * presentation). Production wiring maps this onto the product's progress UI
 * (e.g. `vscode.window.withProgress`); the coordinator itself only ever
 * hands over the row's declared label and the invocation's correlation.
 */
export interface TaskActionPresenterV1 {
  beginProgress(presentation: TaskActionProgressPresentationV1): TaskActionProgressHandleV1;
}

/**
 * One sanitized settlement record per coordinator invocation. The shape is
 * CLOSED to plan §2.2's permitted log content — correlation identifiers,
 * timestamps, statuses, codes, byte counts, and digests. There is no field
 * that could carry prompt, question, artifact, or provider text.
 */
export interface TaskActionSettlementRecordV1 {
  readonly event: "taskActionSettled";
  /** Coordinator-clock ISO timestamp. */
  readonly at: string;
  /** The row's declared logging channel (`loggingPolicy.channel`). */
  readonly channel: string;
  readonly actionKey: ActionKeyV1;
  readonly taskBindingId: string;
  /** Absent only when the invocation failed before an operation was allocated. */
  readonly operationId?: OperationIdV1;
  /** The settled attempt, when the outcome carries provider correlation. */
  readonly attemptId?: string;
  readonly outcomeKind: TaskActionOutcomeV1["kind"];
  /** The outcome's stable code, when its variant declares one. */
  readonly outcomeCode?: string;
  /** Sealed-result byte count — only when the row's policy opts metrics in. */
  readonly resultByteLength?: number;
  /** Sealed-result SHA-256 — only when the row's policy opts metrics in. */
  readonly resultSha256?: string;
}

export interface TaskActionAuditLoggerV1 {
  log(record: TaskActionSettlementRecordV1): void;
}

export interface TaskActionRequestV1 {
  readonly actionKey: ActionKeyV1;
  readonly taskBinding: TaskBindingRefV1;
  /** Persisted task status at invocation time (strictly decoded by the caller). */
  readonly taskStatus: string;
  /** Current canonical stage at invocation time. */
  readonly taskStage: string;
  readonly rawInput: unknown;
  readonly cancellationToken: vscode.CancellationToken;
  readonly preInvocationHook?: () => Promise<void>;
  /**
   * Lifecycle-row-only side channel (plan §6.6's `nextStage.v1`): forwarded
   * verbatim into `LifecycleExecutionContextV1.beforeWrite` for a `"lifecycle"`
   * row and otherwise ignored (a provider row's admission path never reads
   * this field). Carries an in-process closure (e.g. promoting a staged
   * review artifact into place), so — unlike `rawInput` — it is never
   * validated, digested, or persisted as part of a Chat interaction
   * transaction's input snapshot; lifecycle rows have no such transaction.
   */
  readonly lifecycleBeforeWrite?: (patched: TaskProgress) => Promise<void>;
  /**
   * Lifecycle-row-only side channel like `lifecycleBeforeWrite`: forwarded
   * verbatim into `LifecycleExecutionContextV1.skipTaskLock` for a
   * `"lifecycle"` row and otherwise ignored. See that field's header — the
   * caller already holds a covering lock (e.g. the activation coordinator's
   * meta-root lock), so the row's strict patch must not re-queue on the same
   * per-process task-lock key.
   */
  readonly lifecycleSkipTaskLock?: boolean;
  /**
   * Lifecycle-row-only side channel like `lifecycleBeforeWrite`: forwarded
   * verbatim into `LifecycleExecutionContextV1.services` for a `"lifecycle"`
   * row and otherwise ignored. See that field's header.
   */
  readonly lifecycleServices?: unknown;
  /**
   * Set ONLY by a lifecycle row's own `execute` when it drives a nested
   * provider-row invocation against the SAME task binding while its own
   * coordinator lease is still held — e.g. `commitPush.v1` invoking
   * `commitPushMetadata.v1` (`commitAndPushTask.ts`'s `buildCommitMessage`/
   * `resumeCommitMessage`). Names the PARENT's own `operationId`: when set,
   * lease acquisition below calls `leaseStore.acquireChild` instead of
   * `acquire`, which succeeds ONLY while this exact operation currently
   * holds the binding's lease (see `workflowLeaseStoreV1.ts`'s header) — so
   * this can never be used to let an unrelated operation bypass the
   * binding's exclusivity, only to avoid a legitimate nested call
   * self-deadlocking against its own already-held lease.
   */
  readonly parentOperationId?: OperationIdV1;
}

/**
 * An explicit Resume of a structured-question interaction (plan §5.5 / §6.1).
 * Unlike `TaskActionRequestV1` there is no `actionKey` or `rawInput`: both
 * come from the persisted Chat interaction transaction — the recorded action
 * key selects the registry row, and the validated-input snapshot is the only
 * input the reconstructed action receives (AC-QUESTION-03).
 */
export interface TaskActionResumeRequestV1 {
  /** The durable interaction address: operation id plus recorded interaction id. */
  readonly interaction: InteractionRefV1;
  /** The invoking task's current binding — revalidated against the transaction record. */
  readonly taskBinding: TaskBindingRefV1;
  /** Persisted task status at Resume time (strictly decoded by the caller). */
  readonly taskStatus: string;
  /** Current canonical stage at Resume time. */
  readonly taskStage: string;
  /**
   * The CALLER-OWNED §3.1 Resume idempotency id (128-bit lowercase hex).
   * Callers allocate it once per user Resume and persist it before driving
   * the coordinator, so the id survives a crash. Re-driving with the
   * identical id replays the recorded resolution — a `sameOperation` replay
   * recovers the transaction's exactly-one recorded attempt linkage instead
   * of invoking an unbound fresh attempt; any other id against a settled
   * interaction is rejected by the persisted idempotency record.
   */
  readonly resumeIdempotencyId: string;
  readonly cancellationToken: vscode.CancellationToken;
  /** See `TaskActionRequestV1.parentOperationId` — identical nested-lease meaning for a Resume drive. */
  readonly parentOperationId?: OperationIdV1;
}

export interface TaskActionCoordinatorDepsV1 {
  readonly registry: TaskActionRegistryV1;
  readonly leaseStore: WorkflowLeaseStoreV1;
  /**
   * Opens the registry's ranked, session-bound selection for one operation
   * (`openV1RunnerSelection` via `createV1RunnerSelectionOpener` in
   * production). The registry — never the coordinator — ranks candidates,
   * rejects mode-incapable ones, and issues every reservation.
   */
  readonly openRunnerSelection: RunnerSelectionOpenerV1;
  /**
   * The durable interaction ledger (plan §5.5): a `questions` result persists
   * its Chat interaction transaction through this before the outcome surfaces.
   */
  readonly orchestrator: ActionConversationOrchestratorV1;
  /** Consumes each completed row's declared follow-up, after lease release. */
  readonly followUpScheduler: TaskActionFollowUpSchedulerV1;
  /** Presents each invocation under the row's declared `progressLabel` (plan §3.8). */
  readonly presenter: TaskActionPresenterV1;
  /** Receives exactly one sanitized settlement record per invocation (plan §3.8 / §2.2). */
  readonly auditLogger: TaskActionAuditLoggerV1;
  /** Coordinator clock for settlement timestamps; defaults to the system clock. */
  readonly now?: () => string;
  readonly brokerOptions?: AgentExecutionBrokerOptionsV1;
  /**
   * Request-local tool-session factories for `preflight`/`edit` provider
   * rows (plan §7.2/§7.6). Optional and consulted ONLY when a row's
   * `providerMode` is not `"text"` — every migrated text action runs
   * exactly as before without it. Each provider ATTEMPT gets a fresh
   * session, so observations from one attempt can never authorize a plan
   * returned by another.
   */
  readonly toolSessions?: TaskActionToolSessionsV1;
}

export interface TaskActionPreflightSessionV1 {
  readonly handler: RequestLocalToolHandlerV1;
  readonly ledger: ObservationLedgerV1;
  /** The single registered workspace root this session exposes. */
  readonly rootId: string;
}

export interface TaskActionToolSessionsV1 {
  /** Create one attempt's preflight read session (§7.2). May throw when the input names no valid root. */
  createPreflightSession(validatedInput: unknown): TaskActionPreflightSessionV1;
  /** Create one attempt's mutation session for an already-claimed execution (§7.6). */
  createEditSession(validatedInput: unknown): RequestLocalToolHandlerV1;
}

/**
 * Opaque handle produced by `admitAction` once an action has survived every
 * check that can independently reject it WITHOUT invoking a provider
 * (eligibility, input validation, cancellation, duplicate-lease rejection,
 * provider selection). Callers must not inspect its fields — only pass it to
 * `continueAdmittedAction`, exactly once.
 */
export interface AdmittedProviderActionTicketV1 {
  readonly row: ProviderTaskActionRowV1;
  readonly request: TaskActionRequestV1;
  readonly operationId: OperationIdV1;
  readonly stage: TaskStage;
  readonly validatedInput: unknown;
  readonly session: ProviderSelectionSessionV1;
  readonly selection: V1RunnerSelectionV1;
  readonly initialCandidate?: {
    readonly attemptId: string;
    readonly reserved: {
      readonly handle: { readonly reservationId: string; readonly correlation: ActionCorrelationV1 };
      readonly providerLabel: string;
      readonly storedModelId: string;
      readonly createTransport: (toolHandler?: RequestLocalToolHandlerV1) => AgentTransportV1;
    };
  };
  readonly acquireLeasePhase: AcquireTaskLeasePhaseV1;
  readonly progress: TaskActionProgressHandleV1;
  readonly metrics: ResultMetricsCaptureV1;
  readonly preInvocationHook?: () => Promise<void>;
}

/**
 * Result of `admitAction` (plan §5.4/AC-CHAT-TX-02 two-phase split):
 * `"settled"` means the action already ran to a final outcome (a rejection
 * before any provider row was reached, or a lifecycle row's complete
 * transition — neither has a provider wait to admit around) and has already
 * been audited/follow-up-scheduled; the caller returns the outcome as-is.
 * `"admitted"` means every pre-provider check passed for a provider row; the
 * caller may now safely do work that must not happen before a rejection is
 * possible, then MUST call `continueAdmittedAction(ticket)` exactly once.
 */
export type TaskActionAdmissionResultV1 =
  | { readonly kind: "settled"; readonly outcome: TaskActionOutcomeV1 }
  | { readonly kind: "admitted"; readonly ticket: AdmittedProviderActionTicketV1 };

export interface TaskActionCoordinatorV1 {
  /** Execute one action invocation end to end and return its stable outcome. */
  executeAction(request: TaskActionRequestV1): Promise<TaskActionOutcomeV1>;
  /** Resolve the owning row for a route and execute it (fail-closed on unowned routes). */
  executeRoute(
    routeId: string,
    request: Omit<TaskActionRequestV1, "actionKey">
  ): Promise<TaskActionOutcomeV1>;
  /**
   * Two-phase execution split (plan §5.4/AC-CHAT-TX-02), used by callers that
   * must persist caller-owned state (e.g. Chat Send's user message) only
   * once an action can no longer be rejected on eligibility, input
   * validation, cancellation, duplicate-lease, or provider-selection
   * grounds — but before the provider is actually invoked. `executeAction`
   * is exactly `admitAction` followed by `continueAdmittedAction` when
   * admission is not itself terminal; most callers should keep using
   * `executeAction` directly.
   */
  admitAction(request: TaskActionRequestV1): Promise<TaskActionAdmissionResultV1>;
  /**
   * Runs the provider, settles the outcome, and audits/schedules follow-up
   * exactly once. Call exactly once per `"admitted"` ticket — a runtime
   * claim rejects a second call for the same ticket (whether the first call
   * was to this function or to `abortAdmittedAction`) instead of silently
   * double-settling.
   */
  continueAdmittedAction(ticket: AdmittedProviderActionTicketV1): Promise<TaskActionOutcomeV1>;
  /**
   * Retire an admitted ticket that will never be continued (plan §5.4/
   * AC-CHAT-TX-02) — e.g. caller-owned work required between admission and
   * continuation itself failed. Ends progress presentation and audits/
   * schedules follow-up exactly once via the same tail `continueAdmittedAction`
   * uses, so an admitted ticket always settles through exactly one of these
   * two functions, never neither. `reason` is a short machine-readable
   * label folded into the terminal `failed` outcome's code
   * (`admissionAborted.<reason>`); it is not free text and must not carry
   * caller-owned content. Call at most once per ticket, and never after
   * `continueAdmittedAction` has been called for the same ticket — a runtime
   * claim rejects a second retirement of the same ticket through either
   * function.
   */
  abortAdmittedAction(
    ticket: AdmittedProviderActionTicketV1,
    reason: string
  ): Promise<TaskActionOutcomeV1>;
  /**
   * Execute an explicit Resume end to end (plan §5.5 / §6.1 / AC-QUESTION-03):
   * load the persisted transaction, revalidate the task/document binding and
   * current registry eligibility, reconstruct the action input from the
   * validated snapshot and revalidate it (advisory revisions) through the
   * row's own validator, settle the transaction exactly once per the row's
   * declared `ResumeSemanticsV1`, then run the reconstructed action with the
   * recorded answers. The request's caller-owned Resume idempotency id is
   * the crash-recovery key: the identical id replays a settled Resume under
   * its recorded attempt/operation linkage. No provider is invoked for an
   * unknown, unanswerable, ineligible, already-settled, or duplicate-locked
   * interaction — and every rejection before settlement leaves the
   * interaction resumable.
   */
  resumeAction(request: TaskActionResumeRequestV1): Promise<TaskActionOutcomeV1>;
}

/**
 * Narrow a request's plain `taskStage` string to a canonical `TaskStage` for
 * everything downstream that needs one (the Chat interaction transaction,
 * plan §5.1/§6.1's stage isolation) — `TaskActionRequestV1.taskStage` stays a
 * plain string at the request boundary, but nothing may cross into the
 * transaction store without a validated canonical stage.
 */
function isCanonicalTaskStageV0(value: string): value is TaskStage {
  return (STAGE_ORDER as readonly string[]).includes(value);
}

function eligibilityFailure(
  row: TaskActionRegistryRowV1,
  status: string,
  stage: string
): TaskActionOutcomeV1 | undefined {
  if (!row.eligibility.statuses.includes(status)) {
    return { kind: "failed", code: "actionNotEligibleForStatus", retryable: false };
  }
  if (row.eligibility.stages !== "anyStage" && !row.eligibility.stages.includes(stage)) {
    return { kind: "failed", code: "actionNotEligibleForStage", retryable: false };
  }
  return undefined;
}

/** Unseal a broker response payload into UTF-8 text, claiming a spool exactly once when needed. */
async function unsealPayload(
  payload: SealedResultPayloadV1,
  correlation: ActionCorrelationV1,
  brokerOptions: AgentExecutionBrokerOptionsV1 | undefined
): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly outcome: TaskActionOutcomeV1; readonly attemptOutcome: AttemptOutcomeKindV1 }
> {
  if (payload.storage === "memory") {
    return { ok: true, text: payload.utf8Text };
  }
  const store = brokerOptions?.spoolStore;
  if (!store) {
    return {
      ok: false,
      outcome: unavailableV1("workflowStorageUnavailable"),
      attemptOutcome: "malformedResult",
    };
  }
  const claim = await store.claimSpoolOnce(payload.spoolRef, correlation);
  if (!claim.ok) {
    if (claim.code === "spoolCorrelationMismatch") {
      return {
        ok: false,
        outcome: { kind: "malformedResult", correlation, code: "resultCorrelationMismatch" },
        attemptOutcome: "resultCorrelationMismatch",
      };
    }
    return {
      ok: false,
      outcome: { kind: "failed", correlation, code: `resultSpool.${claim.code}`, retryable: false },
      attemptOutcome: "malformedResult",
    };
  }
  // Spools are removed after settlement (plan §3.2); a cleanup failure never
  // invalidates the already-claimed, integrity-verified text.
  try {
    await store.removeSpool(payload.spoolRef);
  } catch {
    // Expiry sweeps collect the remainder within 24 hours.
  }
  return { ok: true, text: claim.utf8Text };
}

/**
 * One short task-operation lease phase. `acquire` either holds the lease
 * (release exactly once via `release`) or reports the stable
 * `duplicateRejected` outcome. Rows that declare no lease requirement get a
 * no-op phase so caller structure stays uniform.
 */
type TaskLeasePhaseV1 =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly outcome: TaskActionOutcomeV1 };

type AcquireTaskLeasePhaseV1 = () => TaskLeasePhaseV1;

/**
 * Shared lease-acquisition body for both `admitAction` and `executeResume`'s
 * `acquireLeasePhase` closures: plain `acquire` for a normal top-level
 * invocation, or `acquireChild` when `parentOperationId` is set (a lifecycle
 * row's own nested provider-row invocation against the SAME binding while
 * its own lease is held — see `TaskActionRequestV1.parentOperationId`).
 * `acquireChild` only ever succeeds while `parentOperationId` names the
 * binding's CURRENTLY held lease, so this cannot weaken the binding's
 * exclusivity for any other caller.
 */
function acquireTaskLease(
  leaseStore: WorkflowLeaseStoreV1,
  taskBindingId: string,
  actionKey: ActionKeyV1,
  operationId: OperationIdV1,
  parentOperationId: OperationIdV1 | undefined
): TaskOperationLeaseAcquireResultV1 {
  return parentOperationId === undefined
    ? leaseStore.acquire(taskBindingId, actionKey, operationId)
    : leaseStore.acquireChild(taskBindingId, parentOperationId, actionKey, operationId);
}

/** Sanitized sealed-result metrics captured for the settlement record (§2.2: byte counts and digests only). */
interface ResultMetricsCaptureV1 {
  byteLength?: number;
  sha256?: string;
}

/**
 * Result of the Resume-only invocation-once gate `runProviderRow` checks
 * immediately before the true invocation boundary (plan §3.1 / AC-RUNNER-03;
 * see this module's header, "THE CLAIM'S EXACT POSITION"). `proceed: false`
 * means this drive must not invoke the provider — either the durable claim
 * itself could not be taken (storage failure), or another drive already
 * claimed this invocation (whose exact outcome is recovered when known, or
 * whose still-unknown outcome fails closed).
 */
type ResumeInvocationClaimGateResultV1 =
  | { readonly proceed: true }
  | { readonly proceed: false; readonly outcome: TaskActionOutcomeV1 };

/**
 * Settlement-record fallbacks for a Resume rejected before its interaction's
 * registry row was resolved (unknown/corrupt transaction, binding mismatch):
 * there is no row logging policy to honor yet, so the record goes to a fixed
 * channel with metrics declined.
 */
const RESUME_FALLBACK_LOGGING_POLICY_V1: TaskActionLoggingPolicyV1 = {
  channel: "action.resume",
  includeResultMetrics: false,
};
const RESUME_UNRESOLVED_ACTION_KEY_V1 = "resume.unresolved";

export function createTaskActionCoordinatorV1(
  deps: TaskActionCoordinatorDepsV1
): TaskActionCoordinatorV1 {
  const now = deps.now ?? ((): string => new Date().toISOString());

  /**
   * Runtime claim-once state for admitted tickets (plan §5.4/AC-CHAT-TX-02).
   * `continueAdmittedAction` and `abortAdmittedAction` are documented as
   * mutually exclusive, call-at-most-once retirement paths for the same
   * ticket, but nothing previously enforced that at runtime: calling either
   * twice, or aborting after continuing, would run `finalizeOutcome` (and
   * its follow-up scheduling) and `progress.end()` more than once for a
   * single operation. Claiming a ticket here — synchronously, before any
   * `await` in either retirement function — makes a second retirement
   * attempt fail fast instead of silently double-settling.
   */
  const retiredAdmissionTickets = new WeakSet<AdmittedProviderActionTicketV1>();

  function claimTicketForRetirement(
    ticket: AdmittedProviderActionTicketV1,
    caller: "continueAdmittedAction" | "abortAdmittedAction"
  ): void {
    if (retiredAdmissionTickets.has(ticket)) {
      throw new Error(
        `TaskActionCoordinatorV1.${caller}: this admitted ticket was already retired via ` +
          "continueAdmittedAction or abortAdmittedAction. Each admitted ticket may settle " +
          "through exactly one of those two functions, exactly once."
      );
    }
    retiredAdmissionTickets.add(ticket);
  }

  async function runProviderRow(
    row: ProviderTaskActionRowV1,
    cancellationToken: vscode.CancellationToken,
    session: ProviderSelectionSessionV1,
    selection: V1RunnerSelectionV1,
    validatedInput: unknown,
    /** The stage this invocation is running in (plan §5.1/§6.1 stage isolation). */
    stage: TaskStage,
    acquireLeasePhase: AcquireTaskLeasePhaseV1,
    metrics: ResultMetricsCaptureV1,
    /** Recorded answers from a resumed structured-question interaction (plan §6.1). */
    answers?: readonly StructuredAnswerV1[],
    /**
     * Resume-only invocation-once gate (plan §3.1 / AC-RUNNER-03): checked
     * exactly once per drive, immediately before the true invocation
     * boundary — see this module's header, "THE CLAIM'S EXACT POSITION".
     * Absent for a fresh (non-Resume) action, which never durably claims an
     * invocation.
     */
    claimInvocationOnce?: () => Promise<ResumeInvocationClaimGateResultV1>,
    /**
     * Optional hook (plan §5.4/AC-CHAT-TX-02) called after the durable
     * invocation admission succeeds but before the provider is invoked.
     * Used by Chat Send to persist the user message only after the
     * transaction record exists, so a validation/storage failure never
     * leaves an unanswerable orphan message in the transcript.
     */
    preInvocationHook?: () => Promise<void>,
    initialCandidate?: AdmittedProviderActionTicketV1["initialCandidate"]
  ): Promise<TaskActionOutcomeV1> {
    // No task-operation lease is held anywhere in this function except the
    // settlement phase inside `settleEnvelope` (plan §6.1 rule 6: leases are
    // released before provider waits).
    let invocationGateChecked = claimInvocationOnce === undefined;
    // Pre-invocation admission (plan §6.1 step 5 / AC-CHAT-TX-02) applies
    // only to a FRESH (non-Resume) question-capable invocation. A Resume
    // drive (claimInvocationOnce present) reuses its ORIGINAL operationId,
    // whose transaction record already exists (settled) — admitting a new
    // record at that same operationId would collide with AC-CHAT-TX-01's
    // exclusive-create rather than support it, so Resume drives are left on
    // their pre-existing behavior entirely.
    const isFreshInvocation = claimInvocationOnce === undefined;
    let pendingCandidate = initialCandidate;
    for (;;) {
      let attemptId: string;
      let reserved: NonNullable<AdmittedProviderActionTicketV1["initialCandidate"]>["reserved"];

      if (pendingCandidate) {
        attemptId = pendingCandidate.attemptId;
        reserved = pendingCandidate.reserved;
        pendingCandidate = undefined;
      } else {
        attemptId = session.allocateAttempt();

        const next = selection.reserveNext(attemptId);
        if (next.kind === "noneRemaining") {
          // Nothing was reserved for this attempt — settle it explicitly so
          // the session's one-outcome-per-attempt accounting stays complete,
          // then map both exhaustion codes onto the stable mode-unavailable
          // outcome (plan §3.7).
          session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
          return unavailableV1("providerModeUnavailable");
        }
        if (next.kind === "candidateUnavailable") {
          // The registry settled this attempt (providerUnavailablePreInvocation)
          // for a ranked candidate that cannot satisfy the mode — an explicit,
          // auditable skip, never a silent bypass. A FRESH attempt reaches the
          // next ranked candidate (plan §3.4).
          continue;
        }

        reserved = next.reserved;

        const questionCapableInvocation =
          isFreshInvocation && row.permittedResultKinds.includes("questions");

        if (questionCapableInvocation) {
          const correlation = reserved.handle.correlation;
          const context: TaskActionExecutionContextV1 = {
            correlation,
            stage,
            validatedInput,
            ...(answers !== undefined ? { answers } : {}),
          };
          const prompt =
            row.buildPrompt(context) +
            "\n\n" +
            buildAiResultContractPromptV1({
              correlation,
              permittedResultKinds: row.permittedResultKinds,
              completedContentType: row.completedContentType,
              maxResponseBytes: row.maxResponseBytes,
            });
          const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");

          await deps.orchestrator.discardInvocation(correlation.operationId);
          const admitted = await deps.orchestrator.admitInvocation({
            correlation,
            stage,
            resumeSemantics: row.resumeSemantics,
            validatedInput,
            promptContract: {
              contractId: AI_RESULT_CONTRACT_ID_V1,
              contractVersion: AI_RESULT_CONTRACT_VERSION_V1,
              promptInputSha256: promptSha256,
            },
          });
          if (!admitted.ok) {
            session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
            return admitted.code === "workflowStorageUnavailable"
              ? unavailableV1("workflowStorageUnavailable")
              : {
                  kind: "failed",
                  correlation,
                  code: `chatTransaction.${admitted.code}`,
                  retryable: true,
                };
          }
        }
      }
      const correlation = reserved.handle.correlation;
      const claimed = session.claim(reserved.handle.reservationId);

      // Per-ATTEMPT request-local tool session for preflight/edit rows
      // (plan §7.2): a fresh ledger/handler every attempt, so a fallback or
      // retry can never mix observations across attempts. Text rows skip
      // this entirely — no new code runs on the migrated text paths.
      let preflightSession: TaskActionPreflightSessionV1 | undefined;
      let toolHandler: RequestLocalToolHandlerV1 | undefined;
      if (row.providerMode !== "text") {
        if (!deps.toolSessions) {
          session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
          return { kind: "failed", correlation, code: "toolSessionsUnavailable", retryable: false };
        }
        try {
          if (row.providerMode === "preflight") {
            preflightSession = deps.toolSessions.createPreflightSession(validatedInput);
            toolHandler = preflightSession.handler;
          } else {
            toolHandler = deps.toolSessions.createEditSession(validatedInput);
          }
        } catch {
          session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
          return { kind: "failed", correlation, code: "toolSessionUnavailable", retryable: false };
        }
      }

      const context: TaskActionExecutionContextV1 = {
        correlation,
        stage,
        validatedInput,
        ...(answers !== undefined ? { answers } : {}),
        ...(preflightSession !== undefined
          ? { preflight: { ledger: preflightSession.ledger, rootId: preflightSession.rootId } }
          : {}),
      };
      const prompt =
        row.buildPrompt(context) +
        "\n\n" +
        buildAiResultContractPromptV1({
          correlation,
          permittedResultKinds: row.permittedResultKinds,
          completedContentType: row.completedContentType,
          maxResponseBytes: row.maxResponseBytes,
        });
      const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
      if (preInvocationHook) {
        await preInvocationHook();
      }

      const executionRequest: AgentExecutionRequestV1 = {
        correlation,
        reservationId: reserved.handle.reservationId,
        mode: row.providerMode,
        prompt,
        maxResponseBytes: row.maxResponseBytes,
        cancellationToken,
      };

      // PRE-INVOCATION SETUP (plan §3.1 / AC-RUNNER-03; module header,
      // "THE CLAIM'S EXACT POSITION"): transport construction and the
      // broker's full pre-invocation phase — request/reservation/transport
      // validation, consumption of the reservation's single invocation,
      // the pre-requested cancellation check, bounded-writer creation —
      // all complete HERE, before the durable claim below. A throw or
      // crash in this window therefore leaves no claim at all and the
      // interaction stays fully retryable. A provider that cannot even be
      // set up for invocation is reported as unavailable pre-invocation
      // and the loop falls back to the next registry-ranked candidate.
      let prepared: PreparedAgentInvocationV1;
      try {
        prepared = prepareAgentInvocationV1(executionRequest, claimed, reserved.createTransport(toolHandler));
      } catch {
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        continue;
      }

      // THE TRUE INVOCATION BOUNDARY: everything above this point for
      // this attempt — allocation, reservation, the in-memory reservation
      // claim, prompt construction, execution-request assembly, transport
      // construction, and broker preparation — is local, claim-free setup.
      // The Resume-only durable claim is checked exactly once per drive,
      // right here, immediately before the one call that actually reaches
      // a provider. A pre-invocation outcome (a token already cancelled
      // before any provider work) never reaches a provider, so it neither
      // takes nor needs the claim.
      if (prepared.kind === "prepared" && !invocationGateChecked) {
        invocationGateChecked = true;
        const gate = await claimInvocationOnce!();
        if (!gate.proceed) {
          return gate.outcome;
        }
      }

      const raw =
        prepared.kind === "preInvocationOutcome"
          ? prepared.outcome
          : await prepared.invoke(deps.brokerOptions ?? {});

      switch (raw.kind) {
        case "callerCancelled":
          session.reportAttemptOutcome(attemptId, "callerCancelled");
          return { kind: "cancelled", correlation, code: "userCancelled" };
        case "providerCancelled":
          session.reportAttemptOutcome(attemptId, "providerCancelled");
          return { kind: "cancelled", correlation, code: "providerCancelled" };
        case "overflow":
          session.reportAttemptOutcome(attemptId, "overflow");
          return { kind: "malformedResult", correlation, code: "resultLimitExceeded" };
        case "transportFailure":
          if (raw.responseStarted) {
            session.reportAttemptOutcome(attemptId, "transportFailureResponseStarted");
            return { kind: "failed", correlation, code: raw.code, retryable: false };
          }
          session.reportAttemptOutcome(attemptId, "transportFailurePreResponse");
          // Pre-response failure is the fallback-eligible case: loop for the
          // next registry-ranked candidate with a fresh attempt and an
          // explicit next reservation.
          continue;
        case "response":
          break;
      }

      // Sanitized metrics for the settlement record (byte count + digest —
      // both §2.2-permitted), captured for every response-bearing outcome.
      if (raw.payload.storage === "memory") {
        metrics.byteLength = raw.payload.byteLength;
        metrics.sha256 = raw.payload.sha256;
      } else {
        metrics.byteLength = raw.payload.spoolRef.byteLength;
        metrics.sha256 = raw.payload.spoolRef.sha256;
      }

      const unsealed = await unsealPayload(raw.payload, correlation, deps.brokerOptions);
      if (!unsealed.ok) {
        session.reportAttemptOutcome(attemptId, unsealed.attemptOutcome);
        return unsealed.outcome;
      }

      const parsed = parseAiResultEnvelopeV1(unsealed.text, correlation);
      if (parsed.kind === "malformed") {
        session.reportAttemptOutcome(
          attemptId,
          parsed.code === "resultCorrelationMismatch" ? "resultCorrelationMismatch" : "malformedResult"
        );
        return { kind: "malformedResult", correlation, code: parsed.code };
      }

      return settleEnvelope(row, parsed, session, attemptId, context, acquireLeasePhase, promptSha256);
    }
  }

  async function settleEnvelope(
    row: ProviderTaskActionRowV1,
    envelope: AiResultEnvelopeV1,
    session: ProviderSelectionSessionV1,
    attemptId: string,
    context: TaskActionExecutionContextV1,
    acquireLeasePhase: AcquireTaskLeasePhaseV1,
    promptSha256: string
  ): Promise<TaskActionOutcomeV1> {
    const correlation = context.correlation;
    if (!row.permittedResultKinds.includes(envelope.kind)) {
      session.reportAttemptOutcome(attemptId, "malformedResult");
      return { kind: "malformedResult", correlation, code: "contentSchemaMismatch" };
    }
    switch (envelope.kind) {
      case "completed": {
        if (envelope.content.contentType !== row.completedContentType) {
          session.reportAttemptOutcome(attemptId, "malformedResult");
          return { kind: "malformedResult", correlation, code: "contentSchemaMismatch" };
        }
        session.reportAttemptOutcome(attemptId, "completed");
        // SETTLEMENT lease phase: the lease was released before the provider
        // wait (plan §6.1 rule 6), so promotion — the only task mutation on
        // this path — re-acquires it briefly. If another operation took the
        // task meanwhile, promotion is blocked fail-safe and nothing is
        // written; when the lease IS re-acquired, the row's revision-checked
        // `promoteCompletedContent` (plan §6.2) revalidates that the target
        // artifact was not changed during the wait.
        const settlement = acquireLeasePhase();
        if (!settlement.ok) {
          return settlement.outcome;
        }
        try {
          const code = await row.promoteCompletedContent(envelope.content, context);
          return { kind: "completed", correlation, code };
        } catch {
          return { kind: "failed", correlation, code: "promotionFailed", retryable: false };
        } finally {
          settlement.release();
        }
      }
      case "questions": {
        session.reportAttemptOutcome(attemptId, "questions");
        // Plan §5.5 write-through: the durable Chat interaction transaction —
        // carrying the validated input snapshot and prompt-contract identity
        // Resume needs — is persisted BEFORE the questions outcome surfaces.
        // If it cannot persist, the questions are not surfaced at all:
        // without the record, Resume would not be reconstructible.
        const posted = await deps.orchestrator.postQuestions({
          correlation,
          stage: context.stage,
          resumeSemantics: row.resumeSemantics,
          questions: envelope.questions,
          validatedInput: context.validatedInput,
          promptContract: {
            contractId: AI_RESULT_CONTRACT_ID_V1,
            contractVersion: AI_RESULT_CONTRACT_VERSION_V1,
            promptInputSha256: promptSha256,
          },
        });
        if (!posted.ok) {
          if (posted.code === "workflowStorageUnavailable") {
            return unavailableV1("workflowStorageUnavailable");
          }
          return { kind: "failed", correlation, code: "chatTransactionNotRecorded", retryable: true };
        }
        return { kind: "questions", correlation, interactionId: posted.record.interactionId };
      }
      case "cancelled": {
        if (envelope.reason === "user") {
          session.reportAttemptOutcome(attemptId, "callerCancelled");
          return { kind: "cancelled", correlation, code: "userCancelled" };
        }
        session.reportAttemptOutcome(attemptId, "providerCancelled");
        return { kind: "cancelled", correlation, code: "providerCancelled" };
      }
      case "failed": {
        session.reportAttemptOutcome(attemptId, "providerDeclaredFailure");
        return {
          kind: "failed",
          correlation,
          code: envelope.code,
          retryable: envelope.retryable,
        };
      }
    }
  }

  function buildSettlementRecord(
    loggingPolicy: TaskActionLoggingPolicyV1,
    actionKey: ActionKeyV1,
    taskBindingId: string,
    operationId: OperationIdV1 | undefined,
    outcome: TaskActionOutcomeV1,
    metrics: ResultMetricsCaptureV1
  ): TaskActionSettlementRecordV1 {
    const correlation = "correlation" in outcome ? outcome.correlation : undefined;
    const includeMetrics =
      loggingPolicy.includeResultMetrics &&
      metrics.byteLength !== undefined &&
      metrics.sha256 !== undefined;
    return {
      event: "taskActionSettled",
      at: now(),
      channel: loggingPolicy.channel,
      actionKey,
      taskBindingId,
      ...(operationId !== undefined ? { operationId } : {}),
      ...(correlation !== undefined ? { attemptId: correlation.attemptId } : {}),
      outcomeKind: outcome.kind,
      ...("code" in outcome ? { outcomeCode: outcome.code } : {}),
      ...(includeMetrics
        ? { resultByteLength: metrics.byteLength, resultSha256: metrics.sha256 }
        : {}),
    };
  }

  /**
   * Exactly one sanitized settlement record plus (for a completed outcome)
   * at most one scheduled follow-up (plan §3.8 / AC-LIFECYCLE-02; §2.2
   * log-content rule) — the shared tail both `admitAction`'s terminal
   * ("settled") branches and `continueAdmittedAction` run, so every path
   * through the coordinator audits and follows up exactly once regardless
   * of whether admission alone was terminal or a provider ran.
   */
  function finalizeOutcome(
    row: TaskActionRegistryRowV1,
    request: TaskActionRequestV1,
    operationId: OperationIdV1 | undefined,
    outcome: TaskActionOutcomeV1,
    metrics: ResultMetricsCaptureV1
  ): TaskActionOutcomeV1 {
    deps.auditLogger.log(
      buildSettlementRecord(
        row.loggingPolicy,
        row.actionKey,
        request.taskBinding.taskBindingId,
        operationId,
        outcome,
        metrics
      )
    );
    if (outcome.kind === "completed" && row.followUpActionKey !== undefined && operationId !== undefined) {
      deps.followUpScheduler.schedule({
        followUpActionKey: row.followUpActionKey,
        sourceActionKey: row.actionKey,
        sourceOperationId: operationId,
        taskBinding: request.taskBinding,
      });
    }
    return outcome;
  }

  /**
   * Admission phase (plan §5.4/AC-CHAT-TX-02): everything that can
   * independently reject an action WITHOUT invoking a provider — eligibility,
   * stage validity, input validation, cancellation, duplicate-lease
   * rejection, and (for a provider row) selection-session setup. A lifecycle
   * row has no provider wait to admit around, so it runs to completion here
   * and returns `"settled"`; a provider row that is admitted returns an
   * opaque ticket for `continueAdmittedAction`, with progress presentation
   * left open across the gap (ended only once the ticket is continued).
   */
  async function admitAction(request: TaskActionRequestV1): Promise<TaskActionAdmissionResultV1> {
    const row = deps.registry.rowForActionKey(request.actionKey);
    const metrics: ResultMetricsCaptureV1 = {};

    const ineligible = eligibilityFailure(row, request.taskStatus, request.taskStage);
    if (ineligible) {
      return { kind: "settled", outcome: finalizeOutcome(row, request, undefined, ineligible, metrics) };
    }
    if (!isCanonicalTaskStageV0(request.taskStage)) {
      const outcome: TaskActionOutcomeV1 = { kind: "failed", code: "invalidTaskStage", retryable: false };
      return { kind: "settled", outcome: finalizeOutcome(row, request, undefined, outcome, metrics) };
    }
    const stage = request.taskStage;

    const validation = row.validateInput(request.rawInput);
    if (!validation.ok) {
      const outcome: TaskActionOutcomeV1 = { kind: "failed", code: "invalidActionInput", retryable: false };
      return { kind: "settled", outcome: finalizeOutcome(row, request, undefined, outcome, metrics) };
    }

    if (request.cancellationToken.isCancellationRequested) {
      const outcome: TaskActionOutcomeV1 = { kind: "cancelled", code: "userCancelled" };
      return { kind: "settled", outcome: finalizeOutcome(row, request, undefined, outcome, metrics) };
    }

    const operationId = allocateHex128IdV1();

    const acquireLeasePhase: AcquireTaskLeasePhaseV1 = () => {
      if (!row.requiresTaskOperationLease) {
        return { ok: true, release: (): void => undefined };
      }
      const acquired = acquireTaskLease(
        deps.leaseStore,
        request.taskBinding.taskBindingId,
        row.actionKey,
        operationId,
        request.parentOperationId
      );
      if (!acquired.ok) {
        return { ok: false, outcome: acquired.outcome };
      }
      const { leaseId } = acquired.lease;
      return {
        ok: true,
        release: (): void => {
          deps.leaseStore.release(leaseId);
        },
      };
    };

    // Coordinator-owned presentation (plan §3.8): the row's declared
    // progress label covers exactly the execution span. For a lifecycle row
    // (no provider wait) it is ended below before returning. For an admitted
    // provider row it is deliberately left open — `continueAdmittedAction`
    // ends it once the provider wait and settlement are done.
    const progress = deps.presenter.beginProgress({
      actionKey: row.actionKey,
      operationId,
      progressLabel: row.progressLabel,
    });

    if (row.kind === "lifecycle") {
      // Lifecycle rows contain no provider/user wait: one short lease
      // covers the whole coordinated transition.
      const phase = acquireLeasePhase();
      if (!phase.ok) {
        progress.end();
        return { kind: "settled", outcome: finalizeOutcome(row, request, operationId, phase.outcome, metrics) };
      }
      try {
        const outcome = await row.execute({
          actionKey: row.actionKey,
          operationId,
          taskBindingId: request.taskBinding.taskBindingId,
          chatDocumentId: request.taskBinding.chatDocumentId,
          validatedInput: validation.input,
          beforeWrite: request.lifecycleBeforeWrite,
          skipTaskLock: request.lifecycleSkipTaskLock,
          services: request.lifecycleServices,
        });
        return { kind: "settled", outcome: finalizeOutcome(row, request, operationId, outcome, metrics) };
      } finally {
        phase.release();
        progress.end();
      }
    }

    // START lease phase for a provider row: duplicate rejection plus
    // selection setup only, released BEFORE any provider wait (plan §6.1
    // rule 6). The lease is re-acquired solely for completed-content
    // promotion in `settleEnvelope`'s settlement phase.
    const start = acquireLeasePhase();
    if (!start.ok) {
      progress.end();
      return { kind: "settled", outcome: finalizeOutcome(row, request, operationId, start.outcome, metrics) };
    }
    let session: ProviderSelectionSessionV1;
    let selection: V1RunnerSelectionV1;
    try {
      session = openProviderSelectionSessionV1({
        actionKey: row.actionKey,
        operationId,
        taskBindingId: request.taskBinding.taskBindingId,
        chatDocumentId: request.taskBinding.chatDocumentId,
      });
      // One ranked selection per operation: the registry owns the
      // candidate order and issues every reservation through this session
      // (plan §3.3).
      selection = deps.openRunnerSelection({
        session,
        mode: row.providerMode,
        taskStage: request.taskStage,
      });
    } finally {
      start.release();
    }

    let initialCandidate: AdmittedProviderActionTicketV1["initialCandidate"] | undefined;
    for (;;) {
      const attemptId = session.allocateAttempt();
      const next = selection.reserveNext(attemptId);
      if (next.kind === "noneRemaining") {
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        progress.end();
        return { kind: "settled", outcome: finalizeOutcome(row, request, operationId, unavailableV1("providerModeUnavailable"), metrics) };
      }
      if (next.kind === "candidateUnavailable") {
        continue;
      }
      initialCandidate = { attemptId, reserved: next.reserved };
      break;
    }

    if (row.permittedResultKinds.includes("questions")) {
      const correlation = initialCandidate.reserved.handle.correlation;
      const context: TaskActionExecutionContextV1 = {
        correlation,
        stage,
        validatedInput: validation.input,
      };
      const prompt =
        row.buildPrompt(context) +
        "\n\n" +
        buildAiResultContractPromptV1({
          correlation,
          permittedResultKinds: row.permittedResultKinds,
          completedContentType: row.completedContentType,
          maxResponseBytes: row.maxResponseBytes,
        });
      const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");

      await deps.orchestrator.discardInvocation(operationId);
      const admitted = await deps.orchestrator.admitInvocation({
        correlation,
        stage,
        resumeSemantics: row.resumeSemantics,
        validatedInput: validation.input,
        promptContract: {
          contractId: AI_RESULT_CONTRACT_ID_V1,
          contractVersion: AI_RESULT_CONTRACT_VERSION_V1,
          promptInputSha256: promptSha256,
        },
      });

      if (!admitted.ok) {
        session.reportAttemptOutcome(initialCandidate.attemptId, "providerUnavailablePreInvocation");
        progress.end();
        return {
          kind: "settled",
          outcome: finalizeOutcome(
            row,
            request,
            operationId,
            admitted.code === "workflowStorageUnavailable"
              ? unavailableV1("workflowStorageUnavailable")
              : {
                  kind: "failed",
                  correlation,
                  code: `chatTransaction.${admitted.code}`,
                  retryable: true,
                },
            metrics
          ),
        };
      }
    }

    return {
      kind: "admitted",
      ticket: {
        row,
        request,
        operationId,
        stage,
        validatedInput: validation.input,
        session,
        selection,
        initialCandidate,
        acquireLeasePhase,
        progress,
        metrics,
        preInvocationHook: request.preInvocationHook,
      },
    };
  }

  /** Continuation phase: run the provider, settle, and finalize exactly once for an admitted ticket. */
  async function continueAdmittedAction(
    ticket: AdmittedProviderActionTicketV1
  ): Promise<TaskActionOutcomeV1> {
    claimTicketForRetirement(ticket, "continueAdmittedAction");
    try {
      let outcome: TaskActionOutcomeV1;
      try {
        outcome = await runProviderRow(
          ticket.row,
          ticket.request.cancellationToken,
          ticket.session,
          ticket.selection,
          ticket.validatedInput,
          ticket.stage,
          ticket.acquireLeasePhase,
          ticket.metrics,
          undefined,
          undefined,
          ticket.preInvocationHook,
          ticket.initialCandidate
        );
      } catch (err) {
        console.error("continueAdmittedAction error:", err);
        outcome = {
          kind: "failed",
          correlation: {
            actionKey: ticket.row.actionKey,
            operationId: ticket.operationId,
            attemptId: "",
            taskBindingId: ticket.request.taskBinding.taskBindingId,
            chatDocumentId: ticket.request.taskBinding.chatDocumentId,
          },
          code: `preInvocationHookFailed.${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        };
      }
      if (outcome.kind !== "questions" && ticket.row.permittedResultKinds.includes("questions")) {
        await deps.orchestrator.discardInvocation(ticket.operationId);
      }
      return finalizeOutcome(ticket.row, ticket.request, ticket.operationId, outcome, ticket.metrics);
    } finally {
      ticket.progress.end();
    }
  }

  async function executeAction(request: TaskActionRequestV1): Promise<TaskActionOutcomeV1> {
    const admission = await admitAction(request);
    if (admission.kind === "settled") {
      return admission.outcome;
    }
    return continueAdmittedAction(admission.ticket);
  }

  /**
   * Abort an admitted ticket without invoking a provider (plan §5.4/
   * AC-CHAT-TX-02). An admitted ticket is a claim on an `operationId` and an
   * open progress presentation with no accounted-for terminal outcome yet —
   * `continueAdmittedAction` is the ONLY other function that may retire it.
   * A caller that does required work between `admitAction` and
   * `continueAdmittedAction` (e.g. Chat Send persisting the user's message)
   * and finds that work itself fails must call this exactly once instead of
   * discarding the ticket: discarding it would leave the ticket's progress
   * presentation open forever and the operation unaudited/un-followed-up —
   * silently violating "coordinator owns complete action settlement". This
   * never reaches a provider (no attempt was allocated for an admitted
   * ticket — see `admitAction`), so it needs no session/attempt bookkeeping;
   * it settles with the same exactly-once audit/follow-up tail as every
   * other coordinator exit path.
   */
  function abortAdmittedAction(
    ticket: AdmittedProviderActionTicketV1,
    reason: string
  ): Promise<TaskActionOutcomeV1> {
    // A second retirement of the same ticket (claimTicketForRetirement
    // throwing) must reject the returned promise per this function's
    // declared `Promise<...>` contract, the same as `continueAdmittedAction`
    // — not throw synchronously out of the call — so it is caught explicitly
    // here and turned into Promise.reject rather than left to propagate.
    try {
      claimTicketForRetirement(ticket, "abortAdmittedAction");
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const outcome: TaskActionOutcomeV1 = {
      kind: "failed",
      code: `admissionAborted.${reason}`,
      retryable: true,
    };
    const cleanup = ticket.row.permittedResultKinds.includes("questions")
      ? deps.orchestrator.discardInvocation(ticket.operationId).then(() => undefined, () => undefined)
      : Promise.resolve();
    return cleanup.then(
      () => {
        ticket.progress.end();
        return finalizeOutcome(ticket.row, ticket.request, ticket.operationId, outcome, ticket.metrics);
      },
      () => {
        ticket.progress.end();
        return finalizeOutcome(ticket.row, ticket.request, ticket.operationId, outcome, ticket.metrics);
      }
    );
  }

  async function executeResume(
    request: TaskActionResumeRequestV1,
    operationRef: { operationId?: OperationIdV1 },
    rowRef: { row?: ProviderTaskActionRowV1 },
    metrics: ResultMetricsCaptureV1
  ): Promise<TaskActionOutcomeV1> {
    if (!isHex128IdV1(request.resumeIdempotencyId)) {
      return { kind: "failed", code: "invalidResumeIdempotencyId", retryable: false };
    }

    const loaded = await deps.orchestrator.loadInteraction(request.interaction);
    if (loaded.kind === "storageUnavailable") {
      return unavailableV1("workflowStorageUnavailable");
    }
    if (loaded.kind !== "ok") {
      // "unknown" (no transaction / mismatched interaction id) and
      // "recoveryRequired" (corrupt record) are both AC-CHAT-TX-03's
      // read-only, non-resumable states: Resume surfaces Chat recovery and
      // never reaches a provider.
      return { kind: "recoveryRequired", code: "chatRecoveryRequired" };
    }
    const record = loaded.record;

    // §5.5 revalidation 1: the caller's task/document binding must be the
    // transaction's recorded binding.
    if (
      record.correlation.taskBindingId !== request.taskBinding.taskBindingId ||
      record.correlation.chatDocumentId !== request.taskBinding.chatDocumentId
    ) {
      return { kind: "failed", code: "resumeBindingMismatch", retryable: false };
    }

    // §5.5 revalidation 2: current registry eligibility. The recorded action
    // must still be a registered provider row whose declared Resume
    // semantics match what the transaction recorded — registry drift fails
    // closed rather than resuming under semantics the record never bound.
    if (!deps.registry.hasActionKey(record.correlation.actionKey)) {
      return { kind: "failed", code: "resumeActionUnavailable", retryable: false };
    }
    const row = deps.registry.rowForActionKey(record.correlation.actionKey);
    if (row.kind !== "provider") {
      return { kind: "failed", code: "resumeActionUnavailable", retryable: false };
    }
    rowRef.row = row;
    if (row.resumeSemantics !== record.resumeSemantics) {
      return { kind: "failed", code: "resumeSemanticsChanged", retryable: false };
    }
    const ineligible = eligibilityFailure(row, request.taskStatus, request.taskStage);
    if (ineligible) {
      return ineligible;
    }

    // Resume requires submitted answers. A settled record is re-drivable
    // only under the identical recorded idempotency id (§3.1's crash
    // recovery) — the replay recovers the recorded resolution and its bound
    // attempt; any other Resume of a settled interaction is the rejected
    // second Resume.
    if (record.state === "questionsPosted" || record.state === "answersDraft") {
      return { kind: "failed", code: "answersNotSubmitted", retryable: false };
    }
    if (
      record.state === "settled" &&
      (record.resumeResolution === undefined ||
        record.resumeIdempotencyId !== request.resumeIdempotencyId)
    ) {
      return { kind: "failed", code: "interactionAlreadySettled", retryable: false };
    }
    const answers = record.answers;
    if (answers === undefined) {
      return { kind: "failed", code: "answersNotSubmitted", retryable: false };
    }

    // §5.5 revalidation 3: reconstruct the action input from the persisted
    // validated-input snapshot (already digest-verified by the store's
    // strict decoder) and re-run the row's OWN validator — the snapshot's
    // advisory revisions are revalidated by exactly the validator that
    // produced them (AC-QUESTION-03).
    let snapshotInput: unknown;
    try {
      snapshotInput = JSON.parse(record.inputSnapshot.canonicalJson) as unknown;
    } catch {
      return { kind: "recoveryRequired", code: "chatRecoveryRequired" };
    }
    const validation = row.validateInput(snapshotInput);
    if (!validation.ok) {
      return { kind: "failed", code: "invalidActionInput", retryable: false };
    }

    if (request.cancellationToken.isCancellationRequested) {
      // Cancelled before settlement: the transaction is untouched and the
      // interaction remains resumable.
      return { kind: "cancelled", code: "userCancelled" };
    }

    // The task-operation lease closure is bound to the SOURCE operation:
    // that is the interaction being consumed, and for a replacement Resume
    // the fresh linked operation id does not exist until the transaction
    // settles — which must happen strictly AFTER duplicate rejection, so a
    // duplicateRejected Resume leaves the interaction resumable.
    const acquireLeasePhase: AcquireTaskLeasePhaseV1 = () => {
      if (!row.requiresTaskOperationLease) {
        return { ok: true, release: (): void => undefined };
      }
      const acquired = acquireTaskLease(
        deps.leaseStore,
        request.taskBinding.taskBindingId,
        row.actionKey,
        record.correlation.operationId,
        request.parentOperationId
      );
      if (!acquired.ok) {
        return { ok: false, outcome: acquired.outcome };
      }
      const { leaseId } = acquired.lease;
      return {
        ok: true,
        release: (): void => {
          deps.leaseStore.release(leaseId);
        },
      };
    };

    // Presentation begins under the source operation's identity — for
    // `sameOperation` semantics that IS the resumed operation; a replacement
    // operation's id is allocated only at settlement, below.
    const progress = deps.presenter.beginProgress({
      actionKey: row.actionKey,
      operationId: record.correlation.operationId,
      progressLabel: row.progressLabel,
    });
    try {
      // START lease phase: duplicate rejection plus settlement and selection
      // setup, released before the provider wait (plan §6.1 rule 6).
      const start = acquireLeasePhase();
      if (!start.ok) {
        return start.outcome;
      }
      let resolution: ResumeResolutionV1;
      let session: ProviderSelectionSessionV1;
      let selection: V1RunnerSelectionV1;
      try {
        try {
          // Settle the transaction exactly once (§5.5): resolveResume
          // journals `resumeScheduled` before settlement and replays the
          // recorded resolution for the identical idempotency id.
          resolution = await deps.orchestrator.resolveResume(
            request.interaction,
            request.resumeIdempotencyId
          );
        } catch (error) {
          if (error instanceof ActionConversationErrorV1) {
            // The persisted record refused the transition or storage failed
            // mid-schedule; no provider ran, so the caller may retry.
            return { kind: "failed", code: "resumeNotSettled", retryable: true };
          }
          throw error;
        }
        const operationId =
          resolution.kind === "sameOperation"
            ? resolution.operationId
            : resolution.replacementOperationId;
        operationRef.operationId = operationId;

        // Local, in-memory bookkeeping only (no I/O, cannot itself be "the
        // invocation") — this, and everything `runProviderRow` does before
        // its own invocation-boundary gate (attempt allocation, reservation,
        // prompt construction), happens before the durable claim, so a
        // crash anywhere here leaves no claim at all and the interaction
        // stays fully retryable (plan §3.1 / AC-RUNNER-03: "move the durable
        // transition to the actual reservation/invocation boundary").
        session = openProviderSelectionSessionV1(
          {
            actionKey: row.actionKey,
            operationId,
            taskBindingId: request.taskBinding.taskBindingId,
            chatDocumentId: request.taskBinding.chatDocumentId,
          },
          // A `sameOperation` Resume executes under exactly the attempt id
          // the settled linkage binds to (§3.1's exactly-one-attempt rule /
          // AC-ID-04) — including an identical-id crash replay, whose
          // replayed resolution carries the RECORDED `newAttemptId`, so the
          // re-drive recovers the recorded attempt instead of invoking an
          // unbound fresh one. Fallback attempts within the run still
          // allocate globally fresh ids (AC-ID-02). A replacement
          // operation's linkage is the operation id itself, so its attempts
          // are always fresh.
          resolution.kind === "sameOperation"
            ? { firstAttemptId: resolution.newAttemptId }
            : undefined
        );
        selection = deps.openRunnerSelection({
          session,
          mode: row.providerMode,
          taskStage: request.taskStage,
        });
      } finally {
        start.release();
      }

      // Durable invocation-once claim gate (plan §3.1 / AC-RUNNER-03):
      // `runProviderRow` checks this exactly once, immediately before the
      // TRUE invocation boundary — the broker's `invoke` call, after
      // transport construction and broker pre-invocation setup, not its
      // own attempt allocation, reservation, or prompt construction
      // (module header, "THE CLAIM'S EXACT POSITION"). A settled Resume
      // resolution replays idempotently for the identical
      // resumeIdempotencyId (crash recovery), but the provider invocation it
      // drives must run at most once. Claiming — over the durable
      // transaction store, not just this in-memory session — is what makes
      // that true across a restart: if a prior drive (this process or a
      // concurrent one, e.g. a second extension-host window replaying the
      // same crash) already claimed this invocation, this drive must not
      // invoke the provider again.
      let invocationClaimedByThisDrive = false;
      const claimInvocationOnce = async (): Promise<ResumeInvocationClaimGateResultV1> => {
        const claim = await deps.orchestrator.claimResumeInvocation(request.interaction);
        if (!claim.ok) {
          return {
            proceed: false,
            outcome:
              claim.code === "workflowStorageUnavailable"
                ? unavailableV1("workflowStorageUnavailable")
                : { kind: "failed", code: "resumeInvocationClaimFailed", retryable: true },
          };
        }
        if (claim.alreadyClaimed) {
          if (claim.recoveredOutcome !== undefined) {
            // The claimed invocation already ran to completion and its exact
            // terminal outcome was durably recorded: recover and return it
            // instead of invoking the provider again ("recover the claimed
            // terminal result").
            return { proceed: false, outcome: claim.recoveredOutcome };
          }
          // Claimed, with no recorded outcome yet: genuinely in-flight or
          // unknown (still running elsewhere, or crashed mid-invocation).
          // There is no way to tell those apart, so fail closed rather than
          // risk a second invocation.
          return {
            proceed: false,
            outcome: { kind: "failed", code: "resumeInvocationAlreadyClaimed", retryable: false },
          };
        }
        invocationClaimedByThisDrive = true;
        return { proceed: true };
      };

      // NOTE: a resumed `sameOperation` run that returns questions AGAIN
      // cannot persist a second transaction for the same operation
      // (AC-CHAT-TX-01's exclusive-create); the write-through failure path
      // maps that to the retryable `chatTransactionNotRecorded` failure and
      // surfaces nothing unresumable.
      const outcome = await runProviderRow(
        row,
        request.cancellationToken,
        session,
        selection,
        validation.input,
        record.stage,
        acquireLeasePhase,
        metrics,
        answers,
        claimInvocationOnce
      );
      // Best-effort durable mirror of the claimed invocation's terminal
      // outcome (plan §3.1 / AC-RUNNER-03): makes it recoverable by a later
      // replay instead of only ever failing closed. The REAL outcome above
      // is returned to this caller regardless of whether this write
      // succeeds — a mirror failure just means a future replay falls back
      // to the in-flight/unknown fail-closed path, exactly as before this
      // outcome was ever recorded. Only recorded when THIS drive actually
      // won the claim: a gate rejection (`alreadyClaimed`, storage failure,
      // or no candidate ever reached) never claimed anything for this drive
      // to mirror.
      if (invocationClaimedByThisDrive) {
        await deps.orchestrator.recordResumeInvocationOutcome(request.interaction, outcome);
      }
      return outcome;
    } finally {
      progress.end();
    }
  }

  async function resumeAction(request: TaskActionResumeRequestV1): Promise<TaskActionOutcomeV1> {
    const operationRef: { operationId?: OperationIdV1 } = {};
    const rowRef: { row?: ProviderTaskActionRowV1 } = {};
    const metrics: ResultMetricsCaptureV1 = {};

    const outcome = await executeResume(request, operationRef, rowRef, metrics);

    // Exactly one sanitized settlement record per Resume invocation. A
    // Resume rejected before its interaction's row was resolved has no row
    // policy to honor, so it logs under the fixed fallback channel with no
    // metrics — still only §2.2-permitted fields.
    const row = rowRef.row;
    deps.auditLogger.log(
      buildSettlementRecord(
        row?.loggingPolicy ?? RESUME_FALLBACK_LOGGING_POLICY_V1,
        row?.actionKey ?? RESUME_UNRESOLVED_ACTION_KEY_V1,
        request.taskBinding.taskBindingId,
        operationRef.operationId,
        outcome,
        metrics
      )
    );

    // The row's declared follow-up applies to a resumed completion exactly
    // as to a fresh one: at most one, consumed after lease release
    // (plan §3.8 / AC-LIFECYCLE-02).
    if (
      outcome.kind === "completed" &&
      row !== undefined &&
      row.followUpActionKey !== undefined &&
      operationRef.operationId !== undefined
    ) {
      deps.followUpScheduler.schedule({
        followUpActionKey: row.followUpActionKey,
        sourceActionKey: row.actionKey,
        sourceOperationId: operationRef.operationId,
        taskBinding: request.taskBinding,
      });
    }

    return outcome;
  }

  return {
    executeAction,
    executeRoute(
      routeId: string,
      request: Omit<TaskActionRequestV1, "actionKey">
    ): Promise<TaskActionOutcomeV1> {
      const row = deps.registry.rowForRoute(routeId);
      return executeAction({ ...request, actionKey: row.actionKey });
    },
    admitAction,
    continueAdmittedAction,
    abortAdmittedAction,
    resumeAction,
  };
}
