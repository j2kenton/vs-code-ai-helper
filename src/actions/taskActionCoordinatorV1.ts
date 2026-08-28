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
  ReservationIdV1,
  TaskBindingRefV1,
} from "../types/actionCorrelationV1";
import {
  AgentExecutionModeV1,
  AgentExecutionRequestV1,
  AgentTransportV1,
  ResultSpoolRefV1,
  SealedResultPayloadV1,
} from "../types/agentExecutionV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";
import { ObservationLedgerV1 } from "../types/preflightPlanV1";
import {
  AiResultEnvelopeV1,
  FRAME_START_V1,
  hasLoneSurrogate,
  MalformedAiResultV1,
  parseAiResultEnvelopeV1,
} from "../types/aiResultEnvelope";
import { ProviderChainExhaustionV1, TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { unavailableV1 } from "../types/workflowAvailabilityV1";
import {
  AgentExecutionBrokerOptionsV1,
  PreparedAgentInvocationV1,
  prepareAgentInvocationV1,
} from "../services/agentExecutionBrokerV1";
import {
  AttemptOutcomeKindV1,
  classifyProviderCandidateDispositionV1,
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
  buildWorkspaceReadSessionPreambleV1,
  buildWorkspaceReadSessionDegradedPreambleV1,
} from "../prompts/toolSessionPreambleV1";
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
import { EDIT_EXECUTION_ACTION_KEY_V1 } from "./rows/editExecutionRowV1";
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
   * Best-effort observability side channel (review blocker, 2026-08-26:
   * "prompt observability still uses post-run raw-prompt sidecars instead of
   * the attempt-bound canonical transaction input"). Invoked synchronously,
   * at most once per attempt, the moment THIS attempt's
   * `AssembledAttemptPromptV1` is finalized below (`assembleAttemptPromptV1`)
   * — the exact text this attempt actually dispatches, including the
   * preflight preamble and result-contract suffix a caller-supplied
   * `rawInput.prompt` does not carry on its own. Never awaited and never
   * allowed to affect dispatch: a caller (`runTwoPhaseEditActionV1`) that
   * only wants to retain the text for later inspection must not be able to
   * slow or fail a live round by doing so. Like `lifecycleBeforeWrite`, this
   * is never validated, digested, or persisted as part of a Chat interaction
   * transaction's input snapshot — it is a plain in-process callback, not
   * part of the closed `TaskActionOutcomeV1` contract.
   *
   * `operationId` (wf "make the stage chat a record of work" Part 4 review
   * follow-up, 2026-08-27, blocker "coordinator allocation sites still do not
   * attach operation and attempt identities to a round-ledger row ... at
   * allocation time"): this callback already fires once per coordinator
   * attempt, at the exact point `correlation.operationId`/`attemptId` are
   * both in scope (`runProviderRow`) — well before the round's own
   * `terminalizeRoundV1` call, which is the only place either id was
   * previously surfaced. A caller that already has this round's own
   * `roundLedger` row open (`claimReviewAttempt`) can therefore attach both
   * ids to that LIVE row the moment this fires, rather than waiting for the
   * round to end — see `attachCoordinatorIdentityToRoundV1`
   * (`roundLedgerV1.ts`).
   */
  readonly onPromptAssembled?: (info: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly prompt: string;
    readonly promptSha256: string;
  }) => void;
  /**
   * Fires SYNCHRONOUSLY the moment an attempt id is allocated
   * (`session.allocateAttempt()`), strictly earlier than `onPromptAssembled`
   * (which requires a successful `assembleAttemptPromptV1`) — review blocker,
   * 2026-08-28 (wf "make the stage chat a record of work" Part 4, narrowed
   * again): "coordinator allocation sites still do not attach operation and
   * attempt identities to a round-ledger row ... Failure branches [that occur
   * before assembly ever runs, e.g. `providerUnavailablePreInvocation` when no
   * candidate remains] can occur before that callback." An attempt that never
   * reaches assembly (every candidate exhausted before invocation, or a
   * `candidateUnavailable` skip) previously left `onPromptAssembled` unfired
   * for that attempt, so a caller with an already-open `roundLedger` row could
   * not attach that attempt's id at all — only a later attempt on the SAME
   * operation that did reach assembly would ever be recorded. This hook fires
   * for every attempt this coordinator allocates, assembly-eligible or not, so
   * `attachCoordinatorIdentityToRoundV1` can be called from it
   * instead of (or in addition to) `onPromptAssembled`. Unlike the prompt
   * observer, this hook may be awaited: callers that own a round ledger use
   * it as an admission gate. A rejected hook never escapes the coordinator;
   * it produces a settled `attemptIdentityAttachmentFailed` outcome before a
   * provider can run.
   */
  readonly onAttemptAllocated?: (
    info: { readonly attemptId: string; readonly operationId: string }
  ) => void | Promise<void>;
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
  /**
   * Carries the malformed-result invocation budget already spent by an
   * EARLIER, now-terminal `executeAction`/`executeRoute` call for this same
   * user press, forward into a genuinely fresh operation
   * (`withMalformedResultRetryV1`, `productionTaskActionRuntimeV1.ts`).
   * Without this, each fresh operation's own `runProviderRow` loop
   * (`MAX_MALFORMED_RESULT_INVOCATIONS_V1`, this module) starts counting
   * from zero, so two fresh operations could each spend the full budget —
   * the 3+3=6 (or, after candidate exhaustion mid-budget, up to 5) worst
   * case the 2026-08-12 field report's item 2 called out. Seeding this
   * operation's own counter from the value here makes the running total
   * shared across operations, not per-operation. Absent (or `0`) for a
   * fresh, first-attempt operation; never set by anything other than the
   * outer retry wrapper.
   */
  readonly malformedInvocationsAlreadyUsedV1?: number;
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
  /**
   * See `TaskActionRequestV1.onPromptAssembled` (review blocker, 2026-08-27,
   * fourth pass: "Resume execution calls `runProviderRow` without an attempt
   * observer, so fallback/retry attempts during a resumed review are also
   * absent"). `executeResume`'s own `runProviderRow` call previously omitted
   * this entirely — a resumed round's fallback candidate or item-14 retry
   * attempt had no way to report its assembled prompt back to the caller,
   * unlike a fresh `executeAction` drive (`continueAdmittedAction` already
   * forwards `ticket.request.onPromptAssembled`). Optional and best-effort,
   * exactly like the fresh-drive field it mirrors.
   */
  readonly onPromptAssembled?: TaskActionRequestV1["onPromptAssembled"];
  /** See `TaskActionRequestV1.onAttemptAllocated` — identical Resume-drive meaning. */
  readonly onAttemptAllocated?: TaskActionRequestV1["onAttemptAllocated"];
}

/**
 * One ranked candidate the registry refused to reserve, reported to
 * `TaskActionCoordinatorDepsV1.onCandidateSkipped`. Mirrors the registry's
 * own `candidateUnavailable` payload plus the stage it happened on.
 */
export interface CandidateSkippedV1 {
  readonly code: "providerModeUnavailable";
  /** The model id exactly as configured in settings, e.g. "codex-cli:gpt-5.6-sol@high". */
  readonly storedModelId: string;
  readonly providerLabel: string;
  readonly runnerId: string;
  readonly taskStage: string;
}

/**
 * Report one skipped candidate to the optional observer, swallowing anything
 * it throws. Selection correctness must never depend on a reporting side
 * channel: a notification failing (or a test stub throwing) has to leave the
 * cascade behaving exactly as it did before this seam existed.
 */
function reportCandidateSkipped(
  deps: TaskActionCoordinatorDepsV1,
  skip: {
    readonly code: "providerModeUnavailable";
    readonly storedModelId: string;
    readonly providerLabel: string;
    readonly runnerId: string;
  },
  taskStage: string
): void {
  if (!deps.onCandidateSkipped) {
    return;
  }
  try {
    deps.onCandidateSkipped({
      code: skip.code,
      storedModelId: skip.storedModelId,
      providerLabel: skip.providerLabel,
      runnerId: skip.runnerId,
      taskStage,
    });
  } catch {
    // Advisory only — see onCandidateSkipped's doc comment.
  }
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
   * Observer for a ranked candidate the registry refused to reserve
   * (`candidateUnavailable`). Optional and purely advisory: it never affects
   * selection, and throwing from it must not fail the operation.
   *
   * It exists because "auditable skip" was only ever true INSIDE the session.
   * A skipped candidate settles its attempt and the loop moves to the next
   * one, so nothing the user can see records that their configured model was
   * passed over — no notification, no run log, no artifact. That is precisely
   * how codex-cli stayed invisible for weeks: it resolved, reported
   * available, sat in the picker, and was refused here on every single
   * action while a backup answered in its place. The provider bug is fixed;
   * this is the missing signal that would have made it a ten-minute
   * diagnosis instead of an overnight one, for the NEXT provider too.
   *
   * The coordinator cannot surface this itself — it imports vscode as
   * `import type` only and holds no filesystem path — so the composition
   * root supplies the user-facing behaviour.
   */
  readonly onCandidateSkipped?: (skip: CandidateSkippedV1) => void;
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
  /**
   * Create a READ-ONLY workspace session for a text-producing row whose
   * selected provider cannot read files on its own.
   *
   * A CLI provider runs inside the workspace and opens files natively, so a
   * `text` row is fully evidenced for it. Copilot cannot: its text transport
   * has no tools, so a reviewer sees only what survived the context pack.
   * When the pack truncates the very file a review must judge, that reviewer
   * is structurally unable to verify the work — and, worse, will reason from
   * whatever weaker signals remain. On 2026-08-18 that cost ten rounds on
   * jester `2026-08-18_task_1`: the reviewer said outright "the pack truncates
   * split.test.ts", fell back on a zero-changed-paths receipt, and reported
   * work as missing that was present and committed.
   *
   * Unlike `createPreflightSession` this takes no validated input: a review
   * row carries no rootId, so the session is rooted at the task's own
   * workspace folder. Read tools only — nothing here can mutate.
   */
  createWorkspaceReadSession(): TaskActionPreflightSessionV1;
}

/**
 * The assembled prompt (and the tool session it was built with, when the row
 * has one) for a single provider attempt — see `assembleAttemptPromptV1`'s
 * doc comment for why `admitAction` and `runProviderRow` share exactly one
 * of these per question-capable operation's first attempt, rather than each
 * building — and each paying for a fresh tool session behind — their own.
 */
interface AssembledAttemptPromptV1 {
  readonly preflightSession?: TaskActionPreflightSessionV1;
  readonly toolHandler?: RequestLocalToolHandlerV1;
  readonly context: TaskActionExecutionContextV1;
  readonly prompt: string;
  readonly promptSha256: string;
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
  /**
   * Set exactly when `admitAction` performed the early questions-admission
   * for `initialCandidate` (row.permittedResultKinds includes "questions").
   * `runProviderRow` reuses this verbatim for that candidate's first attempt
   * instead of reassembling — see `assembleAttemptPromptV1`.
   */
  readonly initialCandidateAssembledPrompt?: AssembledAttemptPromptV1;
  readonly initialCandidate?: {
    readonly attemptId: string;
    readonly reserved: {
      readonly handle: {
        readonly reservationId: string;
        readonly correlation: ActionCorrelationV1;
        /**
         * The reserved candidate's identity, always populated at runtime
         * (the handle is always a full `ProviderReservationHandleV1`) —
         * named here so a same-candidate retry (item 14) can re-reserve the
         * exact runner/provider/model this attempt already tried, without
         * the loop needing to track a second, parallel identity record.
         */
        readonly runnerId: string;
        readonly providerId: string;
        readonly modelId: string;
      };
      readonly providerLabel: string;
      readonly storedModelId: string;
      readonly createTransport: (toolHandler?: RequestLocalToolHandlerV1) => AgentTransportV1;
      /** See `V1ReservedProviderV1.providerReadsWorkspaceNatively`. */
      readonly providerReadsWorkspaceNatively?: boolean;
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

/**
 * Flattens whitespace/newlines and caps length so a diagnostic string stays
 * one readable line regardless of what its source produced. Returns
 * undefined for an empty/whitespace-only input, so callers can distinguish
 * "no detail available" from "detail is an empty string".
 *
 * Shared by every settled-outcome site that surfaces OUR OWN generated
 * diagnostic text (parser reasons, validation mismatches, promotion error
 * messages) — never the model's raw free-text reply, which plan §2.2/§3.7's
 * sanitized-outcome contract forbids regardless of length. A diagnostic MAY
 * still quote a short, specific field value the provider supplied (a
 * contentType/version string, a plan stepId, a relative path) when that is
 * what the message is explaining; the cap here is what keeps any such
 * fragment bounded.
 */
function boundedDiagnosticDetailV1(text: string, maxChars = 200): string | undefined {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) {
    return undefined;
  }
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
}

/**
 * Build the `failed.code` for a rejected chat transaction, preserving the
 * store's own explanation instead of discarding it.
 *
 * A rejection here is deterministic and content-driven (plan §5.5: an
 * oversized question set or input snapshot, a malformed correlation tuple, a
 * record that would not decode). The bare `chatTransaction.<code>` this used
 * to emit told the user only THAT the transaction was refused, never why —
 * and since these outcomes are reported `retryable: true`, an unchanged
 * prompt simply fails again, indefinitely, with no diagnosable signal. That
 * cost a real multi-day stall on a review whose canonical input snapshot sat
 * ~1.5% over MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1: the store computed the
 * exact reason and this function's caller dropped it on the floor.
 *
 * `failed.code` is the outcome union's one deliberately free-form field
 * (every other variant carries a closed union), so appending the reason
 * needs no schema change. This does NOT weaken §2.2/§3.7's sanitized-outcome
 * rule: these reasons are generated by our own transaction store from its
 * own record contract and never contain provider text, prompt content, or
 * local paths. The reason is still bounded and newline-flattened here so a
 * single run-log line stays readable no matter what the store produced.
 */
/** @internal exported for testing */
export function chatTransactionFailureCodeV1(code: string, reason: string): string {
  const bounded = boundedDiagnosticDetailV1(reason);
  return bounded ? `chatTransaction.${code}: ${bounded}` : `chatTransaction.${code}`;
}

/**
 * Build the `failed.code` for a promotion failure, preserving the row's own
 * validation/write error instead of discarding it.
 *
 * Every row's `promoteCompletedContent` (actions/rows/*.ts) throws a plain
 * Error whose message describes its OWN validation or storage-write failure
 * — a missing required line, a content-type mismatch, a compare-and-set
 * conflict — never the model's raw free-text reply, since the row only
 * validates its own already-schema-checked envelope and its own storage
 * layer's result. That validation message CAN echo a short, specific field
 * value from the envelope's own schema-checked content when naming it is
 * what explains the failure (e.g. editPreflightRowsV1.ts's promotion path
 * folds validatePreflightPlanAgainstLedgerV1's reason — which may quote an
 * operation's provider-supplied stepId or relativePath — straight into this
 * message); boundedDiagnosticDetailV1 below is what keeps any such fragment
 * short and flattened, not an absence of provider-supplied values. The catch
 * block this feeds used to discard the error
 * entirely — not even into a variable — so a promotion failure surfaced only
 * the bare code "promotionFailed", indistinguishable whether the cause was a
 * CAS conflict, a validation failure, or a storage error. That cost real
 * diagnosis time on a live failure: a complete, correct review lost a
 * compare-and-set race against a concurrent artifact write, and nothing in
 * the outcome said so.
 */
/** @internal exported for testing */
export function promotionFailureCodeV1(message: string): string {
  const detail = boundedDiagnosticDetailV1(message);
  return detail ? `promotionFailed: ${detail}` : "promotionFailed";
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

/** Content types whose completed shape is a single flat string a raw, unwrapped response can losslessly become — see `tryFramelessContentFallbackV1`'s own doc comment. */
const FRAMELESS_FALLBACK_CONTENT_TYPES_V1: ReadonlySet<string> = new Set([
  "markdown-artifact.v1",
  "chat-message.v1",
]);

/**
 * Best-effort recovery for one specific, repeatedly-observed failure shape:
 * a text-mode provider does the real work correctly and writes a complete,
 * well-formed response, but never emits the `<<<ENSEMBLE_AI_RESULT_V1>>>`
 * frame ANYWHERE in it — not misplaced, not duplicated, simply never
 * attempted. Confirmed against four live incidents on 2026-08-06/07 (task
 * "workflow", runs 022/023/025/029, three of them with the recovered raw
 * text hand-inspected): every one was a substantively complete, correct
 * markdown review with zero frame markers anywhere, discarded as
 * `malformedResult`/`invalidFrame` despite the work being fine.
 *
 * Deliberately narrow, in four ways:
 *  - Only `invalidFrame`, and only when `FRAME_START_V1` does not appear
 *    ANYWHERE in the raw text. A frame that exists but is duplicated,
 *    mis-delimited, or wrapped in mismatched line endings means the model
 *    attempted the contract and got some structural detail wrong — a
 *    different, more suspicious failure this function does not touch;
 *    trusting raw content there would be a materially different judgment
 *    call than "the contract was never attempted at all". A leading BOM or
 *    an embedded lone (unpaired) UTF-16 surrogate are also refused, even
 *    though both surface as `invalidFrame` too: those are encoding defects
 *    in the transport, not "the model skipped the frame", and — for the
 *    surrogate case specifically — could otherwise flow an unrepresentable
 *    code unit straight into a promoted artifact.
 *  - Only rows whose `completedContentType` is a single flat string a raw
 *    response maps to losslessly (`markdown-artifact.v1`'s `markdown`,
 *    `chat-message.v1`'s `text`) — never `commit-metadata.v1`, whose
 *    `subject`/`body` split is a real parsing decision raw text cannot
 *    safely provide, and never a structured (preflight/edit) content type,
 *    where a plain-text response cannot substitute for actual operations.
 *  - Only non-trivial content (a short length floor) so a near-empty or
 *    whitespace-only response still settles as malformed rather than
 *    fabricating content from nothing.
 *  - Not a distinction this function makes, but worth stating: a row whose
 *    `permittedResultKinds` also includes `"questions"` (review.v1 among
 *    them) could in principle receive frameless prose that was actually
 *    meant as a clarifying question rather than a final answer. This
 *    function has no way to tell the two apart from raw text alone, and
 *    deliberately does not try — every incident that motivated it was
 *    unambiguously a completed answer, and refusing every question-capable
 *    row would gut the fix for exactly the rows it exists to help. Accepted
 *    tradeoff, not an oversight.
 *
 * Returns a synthetic `completed` envelope on success, routed through the
 * normal `settleEnvelope` promotion path exactly like a well-framed
 * response — this is a parsing-layer recovery, not a special promotion
 * path. Returns undefined for every other case, leaving the caller's
 * existing malformed-result handling (including recovery-spool
 * preservation) unchanged.
 */
const FRAMELESS_FALLBACK_MIN_CHARS_V1 = 20;

/** @internal exported for testing */
export function tryFramelessContentFallbackV1(
  row: ProviderTaskActionRowV1,
  correlation: ActionCorrelationV1,
  malformed: MalformedAiResultV1
): AiResultEnvelopeV1 | undefined {
  if (malformed.code !== "invalidFrame" || malformed.raw.includes(FRAME_START_V1)) {
    return undefined;
  }
  if (
    (malformed.raw.length > 0 && malformed.raw.charCodeAt(0) === 0xfeff) ||
    hasLoneSurrogate(malformed.raw)
  ) {
    return undefined;
  }
  if (!FRAMELESS_FALLBACK_CONTENT_TYPES_V1.has(row.completedContentType)) {
    return undefined;
  }
  const trimmed = malformed.raw.trim();
  if (trimmed.length < FRAMELESS_FALLBACK_MIN_CHARS_V1) {
    return undefined;
  }
  const content =
    row.completedContentType === "markdown-artifact.v1"
      ? ({ contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: trimmed } as const)
      : ({ contentType: "chat-message.v1", schemaVersion: 1, text: trimmed } as const);
  return { version: 1, correlation, kind: "completed", content };
}

/**
 * Best-effort recovery copy of a response that is ABOUT to be discarded as
 * `malformedResult` — preserved for the same 24h window a normal spool would
 * live (plan §3.2's existing `RESULT_SPOOL_EXPIRY_MS_V1`), reusing the
 * broker's own spool store rather than a new storage mechanism.
 *
 * Live motivation (2026-08-06): a response settling as `malformedResult` had
 * already, by construction, been correctly received and unsealed — the
 * fixed contract in front of it (frame markers, JSON shape) was the only
 * thing wrong, not the underlying work. Real incidents cost hours of
 * diagnosis and one lucky, provider-specific recovery (kimi-code happens to
 * keep its own session transcripts; a provider that doesn't would have lost
 * the response outright) precisely because nothing in Ensemble's own control
 * kept a copy once `unsealPayload` returned. This writes exactly the text
 * that was about to be handed to the parser to a spool keyed by the SAME
 * correlation/reservation tuple `unsealPayload` already used — by the time
 * this runs, that tuple's original spool (if the payload was spooled rather
 * than inline) should already have been removed by `unsealPayload`'s own
 * best-effort `removeSpool` call, so a fresh write for the same key is not
 * expected to collide with it. That removal's own errors are swallowed
 * (plan §3.2's expiry sweep is the backstop), so a fresh write CAN still
 * collide with a not-yet-removed original — `writeSpool`'s exclusive
 * creation then throws, which the catch below folds into an ordinary
 * preservation failure exactly like any other write error.
 *
 * Written with `{ purpose: "recovery" }` (boundedResultStoreV1.ts's
 * `SpoolPurposeV1`) so a reader walking the shared spool tree — the Recover
 * Last AI Response command — can tell this apart from an ordinary broker
 * spool for a large in-flight or already-settled response sharing the same
 * store and directory layout, and never surface one under a "rejected"
 * banner it doesn't deserve.
 *
 * Failure to preserve — no spool store configured, a write error, anything —
 * must never affect the settled outcome; this is best-effort diagnostics,
 * not a correctness requirement. Returns the ref on success so the caller
 * can name it (ids only, never content — plan §2.2) in the outcome's
 * `detail`; on failure, returns WHICH of the two known reasons applied
 * (`noSpoolStoreConfigured` vs. `writeError`) so the outcome's `detail` can
 * say explicitly why no recovery copy exists, instead of the response's
 * absence being silently indistinguishable from success.
 */
type PreserveRejectedResultOutcomeV1 =
  | { readonly ok: true; readonly ref: ResultSpoolRefV1 }
  | { readonly ok: false; readonly reason: "noSpoolStoreConfigured" | "writeError" };

async function preserveRejectedResultForRecoveryV1(
  text: string,
  correlation: ActionCorrelationV1,
  reservationId: ReservationIdV1,
  brokerOptions: AgentExecutionBrokerOptionsV1 | undefined,
  provider: { readonly providerLabel: string; readonly storedModelId: string }
): Promise<PreserveRejectedResultOutcomeV1> {
  const store = brokerOptions?.spoolStore;
  if (!store) {
    return { ok: false, reason: "noSpoolStoreConfigured" };
  }
  try {
    const ref = await store.writeSpool(correlation, reservationId, Buffer.from(text, "utf8"), {
      purpose: "recovery",
      provider,
    });
    return { ok: true, ref };
  } catch {
    return { ok: false, reason: "writeError" };
  }
}

/**
 * Render `preserveRejectedResultForRecoveryV1`'s outcome as one clause for a
 * `malformedResult` outcome's `detail`, naming the actual recovery route
 * (private extension storage, not the task's `runs/` directory) and the
 * command that reads it back, or stating plainly why no copy exists.
 */
function preservationDetailFragmentV1(outcome: PreserveRejectedResultOutcomeV1): string {
  if (outcome.ok) {
    return (
      `response preserved for recovery in extension private storage ` +
      `(operationId=${outcome.ref.operationId}, reservationId=${outcome.ref.reservationId}, ~24h) — ` +
      `run "Recover Last AI Response" (vs-code-ai-helper.recoverLastAiResponse, Ctrl+Shift+Alt+C) to read it back`
    );
  }
  return outcome.reason === "noSpoolStoreConfigured"
    ? "response NOT preserved (no recovery spool store is configured for this workspace)"
    : "response NOT preserved (writing the recovery copy failed)";
}

/**
 * The unsealed provider response text plus the reservation identity it was
 * received under — `settleEnvelope` is a sibling of `runProviderRow`, not
 * nested inside it, so it has no closure access to that function's local
 * `reserved`/`unsealed` bindings and needs them passed explicitly to call
 * `preserveRejectedResultForRecoveryV1` from its own two content-mismatch
 * branches.
 */
interface UnsealedResponseRefV1 {
  readonly text: string;
  readonly reservationId: ReservationIdV1;
  readonly providerLabel: string;
  readonly storedModelId: string;
}

/**
 * Human phrase for one recorded per-attempt outcome, rendered into a chain
 * -exhaustion candidate's `reason`. Closed over `AttemptOutcomeKindV1`'s own
 * union — kinds only, never provider text — so §2.2's sanitized-outcome rule
 * holds by construction.
 */
function attemptOutcomeReasonTextV1(
  outcome: AttemptOutcomeKindV1,
  detail?: string
): string {
  // The closed kind says WHAT happened; `detail` is the only place the actual
  // fault can appear (see RecordedAttemptOutcomeV1.detail). Appended rather
  // than substituted so the stable phrase stays greppable in older records.
  const suffix = detail !== undefined && detail.length > 0 ? ` - ${detail}` : "";
  return attemptOutcomeReasonPhraseV1(outcome) + suffix;
}

function attemptOutcomeReasonPhraseV1(outcome: AttemptOutcomeKindV1): string {
  switch (outcome) {
    case "completed":
      return "invoked and completed";
    case "questions":
      return "invoked and returned structured questions";
    case "providerDeclaredFailure":
      return "invoked, but the provider declared a failure";
    case "malformedResult":
      return "invoked, but the response violated the output contract (malformed result)";
    case "malformedResultPreFallback":
      return "invoked, but the response violated the output contract (malformed result; advanced to the next candidate)";
    case "contentContractFailure":
      return "invoked, but the response failed the action's own content contract";
    case "contentContractFailurePreFallback":
      return "invoked, but the response failed the action's own content contract (advanced to the next candidate)";
    case "resultCorrelationMismatch":
      return "invoked, but the response echoed a foreign correlation";
    case "overflow":
      return "invoked, but the response exceeded the size limit";
    case "providerCancelled":
      return "invoked, but the provider cancelled";
    case "callerCancelled":
      return "invocation cancelled by the caller";
    case "transportFailureResponseStarted":
      return "invoked, but the transport failed after the response started";
    case "transportFailurePreResponse":
      return "invoked, but the transport failed before any response arrived";
    case "providerUnavailablePreInvocation":
      return "could not be invoked (unavailable before invocation)";
  }
}

/**
 * Replace the registry's reservation-time placeholder reasons with what the
 * selection session actually recorded for each invoked candidate (workflow 3
 * continuation, third item): the registry writes a candidate's reason at
 * RESERVATION time — before any invocation happens — because selection never
 * sees invocation results (AC-RUNNER-04). The coordinator OWNS the session
 * and reported every per-attempt outcome itself, so this is the layer that
 * can honestly say what each invocation did. Candidates the session has no
 * reservation for (selection-time skips, the never-reserved tail) keep the
 * registry's own reason untouched. Recorded reservations appear in the same
 * ranked order selection walked the chain, so they are consumed in order,
 * matched by stored model id.
 *
 * A candidate may have MORE THAN ONE recorded attempt when a same-candidate
 * network-fault retry (item 14) ran: the retry allocates a fresh attempt
 * against the identical runner/provider/model rather than advancing the
 * registry's ranked cursor, so it never gets its own `exhaustion.candidates`
 * entry. `retryAttemptIds` names exactly those attempts (the coordinator's
 * own record of which attemptIds it allocated as a retry, never inferred
 * from matching stored model ids — two DIFFERENT ranked candidates can
 * legitimately share one model id, and conflating that case with a retry
 * would misattribute a later candidate's real outcome to an earlier one).
 * A retry attempt immediately following its original is folded into that
 * candidate's single entry, reporting the LAST (most informative — e.g. the
 * retry's own failure, not the original's) outcome.
 */
function enrichChainExhaustionWithAttemptOutcomesV1(
  exhaustion: ProviderChainExhaustionV1,
  session: ProviderSelectionSessionV1,
  retryAttemptIds: ReadonlySet<string> = new Set()
): ProviderChainExhaustionV1 {
  const reservedAttempts = session
    .recordedAttemptOutcomes()
    .filter((attempt) => attempt.modelId !== undefined);
  let cursor = 0;
  const candidates = exhaustion.candidates.map((candidate) => {
    const first = reservedAttempts[cursor];
    if (first?.modelId !== candidate.storedModelId) {
      return candidate;
    }
    cursor++;
    let lastMatch = first;
    // Fold in any immediately-following attempts this coordinator recorded
    // as a retry OF the one just consumed — never a heuristic model-id
    // match, so a later distinct candidate sharing the same model id is
    // never swallowed.
    while (
      cursor < reservedAttempts.length &&
      retryAttemptIds.has(reservedAttempts[cursor]!.attemptId)
    ) {
      lastMatch = reservedAttempts[cursor]!;
      cursor++;
    }
    if (lastMatch.outcome !== undefined) {
      return {
        ...candidate,
        reason: attemptOutcomeReasonTextV1(lastMatch.outcome, lastMatch.detail),
      };
    }
    return candidate;
  });
  return { ...exhaustion, candidates };
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

  /**
   * Item 9 fix (2026-08-17..19 workflow-defects batch): the ONE place a
   * provider row's prompt — and the `promptInputSha256` that describes it —
   * is assembled. Called both by `admitAction`'s early questions-admission
   * (before any candidate is claimed, so the durable `invocationPending`
   * record's digest is accurate from the start) and by `runProviderRow`'s
   * per-attempt loop below (the actual invocation). Previously each built
   * its own separate, narrower context — admission's omitted the tool
   * session entirely, so a `readsWorkspaceFiles` text row's read-session
   * preamble (added only once a session exists) was silently absent from
   * the admitted hash while present in the bytes actually sent.
   *
   * For a question-capable operation's FIRST attempt, `admitAction` calls
   * this once to admit and hands the exact result forward through
   * `AdmittedProviderActionTicketV1.initialCandidateAssembledPrompt`;
   * `runProviderRow` REUSES that same assembly (see the identity check
   * around `originalInitialCandidateV1` below) rather than calling this a
   * second time — calling it twice would create a second, discarded tool
   * session for no reason (an observable extra `createWorkspaceReadSession`/
   * `createPreflightSession` call, not actually free — see the regression
   * this comment replaced). Every OTHER attempt (a fallback to a new
   * candidate, an item-14 same-candidate retry, or the initial attempt of a
   * row that is not question-capable, which `admitAction` never
   * pre-assembles for) still calls this fresh, preserving the "fresh
   * ledger every attempt" guarantee unchanged.
   */
  function assembleAttemptPromptV1(
    row: ProviderTaskActionRowV1,
    correlation: ActionCorrelationV1,
    stage: TaskStage,
    validatedInput: unknown,
    answers: readonly StructuredAnswerV1[] | undefined,
    reserved: {
      readonly providerLabel: string;
      readonly storedModelId: string;
      readonly providerReadsWorkspaceNatively?: boolean;
    }
  ):
    | ({ readonly ok: true } & AssembledAttemptPromptV1)
    | { readonly ok: false; readonly code: "toolSessionsUnavailable" | "toolSessionUnavailable" } {
    let preflightSession: TaskActionPreflightSessionV1 | undefined;
    let toolHandler: RequestLocalToolHandlerV1 | undefined;
    // Item 16 follow-up B (2026-08-17..19 workflow-defects batch): set only
    // when a `readsWorkspaceFiles` row's read session was attempted and
    // failed, so the prompt can say so instead of silently reasoning from
    // the pack alone with an overstated confidence claim (item 15).
    let workspaceReadSessionDegraded = false;
    if (row.providerMode !== "text") {
      if (!deps.toolSessions) {
        return { ok: false, code: "toolSessionsUnavailable" };
      }
      try {
        if (row.providerMode === "preflight") {
          preflightSession = deps.toolSessions.createPreflightSession(validatedInput);
          toolHandler = preflightSession.handler;
        } else {
          toolHandler = deps.toolSessions.createEditSession(validatedInput);
        }
      } catch {
        return { ok: false, code: "toolSessionUnavailable" };
      }
    } else if (row.readsWorkspaceFiles && reserved.providerReadsWorkspaceNatively === false) {
      // A `text` row that must reason about file content, on a provider
      // that cannot open files. Attach the read-only tools so it can, rather
      // than leaving it to infer from a possibly-truncated context pack.
      //
      // Deliberately keyed on the RESERVED candidate, not the row: the same
      // review row runs on a CLI provider (reads the workspace natively —
      // no tools needed, no behaviour change) and on Copilot (no file access
      // at all without this). Conflating the two is what made review quality
      // depend on which subscription the user happened to have.
      //
      // Best-effort: a workspace whose root cannot be registered still runs
      // the review exactly as before rather than failing the round. A
      // reviewer with a truncated pack is poor; no reviewer at all is worse.
      try {
        preflightSession = deps.toolSessions?.createWorkspaceReadSession();
        toolHandler = preflightSession?.handler;
      } catch {
        preflightSession = undefined;
        toolHandler = undefined;
        workspaceReadSessionDegraded = true;
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
      provider: { providerLabel: reserved.providerLabel, storedModelId: reserved.storedModelId },
    };
    // A row that opted into read tools AND actually got a session must be
    // TOLD it can read — attaching tools silently leaves the model reasoning
    // from the prompt alone, which is the failure this exists to remove.
    // Assembled here rather than in the row so every future
    // `readsWorkspaceFiles` row inherits it, and so it appears only when a
    // session was really created (a CLI provider gets neither).
    const readSessionPreamble =
      row.providerMode === "text" && preflightSession !== undefined
        ? buildWorkspaceReadSessionPreambleV1({ rootId: preflightSession.rootId }) + "\n\n"
        : row.providerMode === "text" && workspaceReadSessionDegraded
          ? buildWorkspaceReadSessionDegradedPreambleV1() + "\n\n"
          : "";
    const prompt =
      readSessionPreamble +
      row.buildPrompt(context) +
      "\n\n" +
      buildAiResultContractPromptV1({
        correlation,
        permittedResultKinds: row.permittedResultKinds,
        completedContentType: row.completedContentType,
        maxResponseBytes: row.maxResponseBytes,
      });
    const promptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
    return { ok: true, preflightSession, toolHandler, context, prompt, promptSha256 };
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
    initialCandidate?: AdmittedProviderActionTicketV1["initialCandidate"],
    /**
     * See `TaskActionRequestV1.malformedInvocationsAlreadyUsedV1` — seeds
     * this operation's own malformed-invocation counter so the shared
     * budget is enforced across, not just within, one operation.
     */
    malformedInvocationsAlreadyUsedV1?: number,
    /**
     * Item 9 fix: `admitAction`'s own assembly for `initialCandidate`'s
     * first attempt, when it performed the early questions-admission for
     * it. Reused verbatim below (see `originalInitialCandidateV1`) instead
     * of calling `assembleAttemptPromptV1` a second time for that one
     * attempt.
     */
    initialCandidateAssembledPrompt?: AssembledAttemptPromptV1,
    /** See `TaskActionRequestV1.onPromptAssembled`. */
    onPromptAssembled?: TaskActionRequestV1["onPromptAssembled"],
    /**
     * This operation's id, needed so `onAttemptAllocated` can report a full
     * `{ attemptId, operationId }` pair the moment each attempt is allocated
     * — every candidate this function reserves shares the one operation
     * `admitAction`/`executeResume` already allocated before calling in.
     */
    operationId?: OperationIdV1,
    /** See `TaskActionRequestV1.onAttemptAllocated`. */
    onAttemptAllocated?: TaskActionRequestV1["onAttemptAllocated"],
    taskBinding?: TaskBindingRefV1
  ): Promise<TaskActionOutcomeV1> {
    const attachmentFailureOutcomeV1 = (attemptId: string): TaskActionOutcomeV1 => ({
      kind: "failed",
      ...(operationId !== undefined && taskBinding !== undefined
        ? {
            correlation: {
              actionKey: row.actionKey,
              operationId,
              attemptId,
              taskBindingId: taskBinding.taskBindingId,
              chatDocumentId: taskBinding.chatDocumentId,
            },
          }
        : {}),
      code: "attemptIdentityAttachmentFailed",
      retryable: true,
    });
    const reportAttemptAllocatedV1 = async (allocatedAttemptId: string): Promise<boolean> => {
      if (operationId === undefined) {
        return true;
      }
      try {
        await onAttemptAllocated?.({ attemptId: allocatedAttemptId, operationId });
        return true;
      } catch (error) {
        // The attachment is required for ledger-owning callers, but a failed
        // attachment must still take the coordinator's normal settlement
        // path. Letting it reject here previously leaked progress and skipped
        // the stage owner's terminalization path entirely.
        console.error("onAttemptAllocated failed:", error);
        return false;
      }
    };
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
    // Identity anchor for the one-time reuse below: `pendingCandidate` is
    // reassigned in-loop (consumed to `undefined` here, later reassigned to
    // a NEW object by an item-14 same-candidate retry), so comparing the
    // CURRENT `pendingCandidate` against this captured original — read
    // exactly once, before the loop ever reassigns it — is what tells the
    // first iteration apart from a later reuse of the branch that shares
    // its code.
    const originalInitialCandidateV1 = initialCandidate;

    // Malformed-result candidate advancement (2026-08-12 field report, item
    // 2): a `malformedResult` used to exhaust its two attempts
    // (`withMalformedResultRetryV1`, productionTaskActionRuntimeV1.ts)
    // against the SAME resolved primary candidate — backups configured via
    // switch-to-backup never ran. This loop now advances to the next
    // ranked candidate on a malformed result exactly like the pre-response
    // `transportFailure` case below does (`continue` back to the top, which
    // reserves the next candidate via `selection`'s ranked cursor) —
    // restricted to text-mode rows, never `editExecution.v1` (same
    // exclusion, same reasoning, as `retryOnMalformedResultV1`: a
    // partially-executed edit session cannot safely restart from a fresh
    // conversation).
    //
    // Budget: `MAX_MALFORMED_RESULT_INVOCATIONS_V1` (3) bounds the TOTAL
    // number of provider invocations this operation makes on account of
    // malformed results — the initial attempt plus at most two advances.
    // This is a PER-OPERATION cap, but it IS shared with
    // `withMalformedResultRetryV1`'s separate outer retry
    // (productionTaskActionRuntimeV1.ts): a terminal `malformedResult`
    // outcome this loop produces for an advancement-eligible row carries
    // `malformedInvocationsUsedV1` (see that field's own doc comment), and
    // the outer wrapper sums it across its own fresh-operation retries,
    // stopping once the running total reaches this same 3-invocation cap
    // instead of adding a fixed number of fresh operations on top. That
    // keeps one user press to 3 provider invocations total, not 3x2=6 —
    // closing the gap the plan's "do not multiply them" instruction called
    // out. Rows this loop never advances (editExecution.v1, non-text mode)
    // do not carry the field, so the outer wrapper falls back to its
    // original fixed-attempt behavior for them, unchanged.
    //
    // Each malformed attempt writes its own recovery spool
    // (`preserveRejectedResultForRecoveryV1`, below) keyed by that attempt's
    // own reservation, so `recoverLastAiResponse` (most-recent-wins) surfaces
    // the LAST candidate's rejected text after an exhausted advance chain,
    // not necessarily the best one among the candidates tried.
    const MAX_MALFORMED_RESULT_INVOCATIONS_V1 = 3;
    const malformedRetryEligibleV1 =
      row.providerMode === "text" && row.actionKey !== EDIT_EXECUTION_ACTION_KEY_V1;
    let malformedInvocationCountV1 = malformedInvocationsAlreadyUsedV1 ?? 0;
    let lastMalformedOutcomeV1: TaskActionOutcomeV1 | undefined;
    // Armed once a malformed result has been seen for this row — either in
    // this operation or a prior fresh operation whose count was seeded in
    // via `malformedInvocationsAlreadyUsedV1` (only ever stamped for
    // malformed-retry-eligible rows, so a defined seed already implies this
    // row's history includes a malformed result). Once armed, the shared
    // 3-invocation budget must bound EVERY subsequent invocation this loop
    // makes for the row — including one triggered by a pre-response
    // transport failure, not just one triggered by another malformed
    // result. Unarmed, transport-failure candidate advancement is
    // intentionally unbounded by this cap (it predates and is unrelated to
    // the malformed-result budget).
    let malformedBudgetArmedV1 =
      malformedRetryEligibleV1 && malformedInvocationsAlreadyUsedV1 !== undefined;

    // Item 14 same-candidate retry: identity of the currently-reserved
    // candidate (populated whenever a FRESH ranked reservation is taken, not
    // when `pendingCandidate` merely re-enters the loop for a retry of the
    // same one), and how many network-fault retries this candidate has
    // already used. A flagged network fault (dropped connection, DNS/TLS
    // failure) is a fault of the pipe, not evidence the candidate itself is
    // unsuitable, so it earns one immediate retry of the SAME
    // runner/provider/model before the loop falls through to the next ranked
    // candidate — see the "transportFailure" case below.
    let currentCandidateIdentityV1: { runnerId: string; providerId: string; modelId: string } | undefined =
      initialCandidate
        ? {
            runnerId: initialCandidate.reserved.handle.runnerId,
            providerId: initialCandidate.reserved.handle.providerId,
            modelId: initialCandidate.reserved.handle.modelId,
          }
        : undefined;
    let networkFaultRetriesUsedV1 = 0;
    const MAX_NETWORK_FAULT_RETRIES_PER_CANDIDATE_V1 = 1;
    // Attempt ids this coordinator itself allocated as a same-candidate
    // retry — the authoritative record `enrichChainExhaustionWithAttemptOutcomesV1`
    // needs to fold a retry into its original candidate's entry without
    // guessing from a repeated model id (see that function's doc comment).
    const networkFaultRetryAttemptIdsV1 = new Set<string>();

    for (;;) {
      let attemptId: string;
      let reserved: NonNullable<AdmittedProviderActionTicketV1["initialCandidate"]>["reserved"];
      // True only when THIS iteration reserved a brand-new ranked candidate
      // (the `else` branch below) rather than re-entering with a carried
      // `pendingCandidate` (the initial Resume candidate, or an item-14
      // same-candidate retry). Questions-admission is gated on this exactly
      // as it always was — admission happens once per fresh candidate
      // reservation, never on a retry of the same reservation.
      let isFreshCandidateReservationThisIterationV1 = false;
      // True only for the literal `initialCandidate` object handed in — never
      // for a later item-14 retry, which reassigns `pendingCandidate` to a
      // freshly-allocated object with the same shape but a different attempt.
      const reuseInitialAssembledPromptV1 =
        pendingCandidate !== undefined &&
        pendingCandidate === originalInitialCandidateV1 &&
        initialCandidateAssembledPrompt !== undefined;

      if (pendingCandidate) {
        attemptId = pendingCandidate.attemptId;
        reserved = pendingCandidate.reserved;
        pendingCandidate = undefined;
      } else {
        isFreshCandidateReservationThisIterationV1 = true;
        attemptId = session.allocateAttempt();
        if (!(await reportAttemptAllocatedV1(attemptId))) {
          session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
          return attachmentFailureOutcomeV1(attemptId);
        }

        const next = selection.reserveNext(attemptId);
        if (next.kind === "noneRemaining") {
          // Nothing was reserved for this attempt — settle it explicitly so
          // the session's one-outcome-per-attempt accounting stays complete,
          // then carry the registry's exhaustion code THROUGH (workflow 3
          // continuation, third item): `providerModeUnavailable` (nothing
          // could serve the mode — nothing was invoked) and
          // `candidatesExhausted` (every candidate was reserved, invoked,
          // and failed) are opposite conditions with opposite remedies, and
          // collapsing both onto "unavailable-mode" cost a multi-hour
          // misdiagnosis on 2026-08-15. EXCEPT when candidates were
          // exhausted while advancing past malformed results: the last
          // malformed outcome is the honest report of what actually
          // happened, and it takes precedence over either exhaustion code.
          //
          // The registry's structured chain-exhaustion evidence is passed
          // through with ONE addition (still no task-state mutation): each
          // invoked candidate's reservation-time placeholder reason is
          // replaced with the per-attempt outcome this coordinator itself
          // recorded in the session it owns — see
          // `enrichChainExhaustionWithAttemptOutcomesV1`. Surfacing
          // (enriched run record, paused task) still belongs to the stage
          // owner that dispatched the round.
          session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
          return (
            lastMalformedOutcomeV1 ?? {
              kind: "unavailable",
              code: next.code,
              ...(next.chainExhaustion !== undefined
                ? {
                    chainExhaustion: enrichChainExhaustionWithAttemptOutcomesV1(
                      next.chainExhaustion,
                      session,
                      networkFaultRetryAttemptIdsV1
                    ),
                  }
                : {}),
            }
          );
        }
        if (next.kind === "candidateUnavailable") {
          // The registry settled this attempt (providerUnavailablePreInvocation)
          // for a ranked candidate that cannot satisfy the mode — an explicit,
          // auditable skip, never a silent bypass. A FRESH attempt reaches the
          // next ranked candidate (plan §3.4). The audit trail only existed
          // inside the session until onCandidateSkipped; see its doc comment.
          reportCandidateSkipped(deps, next, stage);
          continue;
        }

        reserved = next.reserved;
        // A genuinely fresh ranked candidate: reset the retry budget and
        // record its identity for a possible same-candidate retry (item 14).
        currentCandidateIdentityV1 = {
          runnerId: next.reserved.handle.runnerId,
          providerId: next.reserved.handle.providerId,
          modelId: next.reserved.handle.modelId,
        };
        networkFaultRetriesUsedV1 = 0;
      }

      const correlation = reserved.handle.correlation;

      // Item 9 fix (2026-08-17..19 workflow-defects batch): reuse
      // `admitAction`'s own assembly (and the ONE tool session it created)
      // for `initialCandidate`'s first attempt rather than paying for a
      // second tool session that would only be thrown away — see
      // `assembleAttemptPromptV1`'s doc comment. Every other attempt (a
      // fallback candidate, an item-14 retry, or the first attempt of a row
      // `admitAction` never pre-assembled for) still builds fresh here.
      const assembled = reuseInitialAssembledPromptV1
        ? { ok: true as const, ...initialCandidateAssembledPrompt }
        : assembleAttemptPromptV1(row, correlation, stage, validatedInput, answers, {
            providerLabel: reserved.providerLabel,
            storedModelId: reserved.storedModelId,
            providerReadsWorkspaceNatively: reserved.providerReadsWorkspaceNatively,
          });
      if (!assembled.ok) {
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        return { kind: "failed", correlation, code: assembled.code, retryable: false };
      }
      const { toolHandler, context, prompt, promptSha256 } = assembled;
      // See `TaskActionRequestV1.onPromptAssembled`'s doc comment — best
      // effort, synchronous, never allowed to affect this attempt.
      try {
        onPromptAssembled?.({ attemptId, operationId: correlation.operationId, prompt, promptSha256 });
      } catch {
        // Caller-supplied observability hook; a failure here must never
        // affect the round it is merely observing.
      }

      // Admission only ever ran for a freshly-reserved candidate (never for
      // the initial Resume candidate or an item-14 same-candidate retry) —
      // `isFreshCandidateReservationThisIterationV1` reproduces that exact
      // gating now that the assembly above runs unconditionally every
      // iteration instead of only inside the reservation branch.
      const questionCapableInvocation =
        isFreshCandidateReservationThisIterationV1 &&
        isFreshInvocation &&
        row.permittedResultKinds.includes("questions");
      if (questionCapableInvocation) {
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
                code: chatTransactionFailureCodeV1(admitted.code, admitted.reason),
                retryable: true,
              };
        }
      }

      const claimed = session.claim(reserved.handle.reservationId);
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

      if (prepared.kind === "prepared") {
        malformedInvocationCountV1++;
        // Keep the previously-stamped malformed outcome's count current as
        // later invocations (including transport-failure advances) consume
        // more of the shared budget. Without this, a return of
        // `lastMalformedOutcomeV1` below (or at the `noneRemaining` branch
        // above) would carry the STALE count from when the malformed result
        // first occurred, understating how much of the 3-invocation budget
        // this operation actually used — letting the outer wrapper in
        // `productionTaskActionRuntimeV1.ts` open further invocations past
        // the shared cap.
        if (
          lastMalformedOutcomeV1?.kind === "malformedResult" &&
          lastMalformedOutcomeV1.malformedInvocationsUsedV1 !== undefined
        ) {
          lastMalformedOutcomeV1 = {
            ...lastMalformedOutcomeV1,
            malformedInvocationsUsedV1: malformedInvocationCountV1,
          };
        }
      }
      const raw =
        prepared.kind === "preInvocationOutcome"
          ? prepared.outcome
          : await prepared.invoke({
              ...(deps.brokerOptions ?? {}),
              provider: { providerLabel: reserved.providerLabel, storedModelId: reserved.storedModelId },
            });

      switch (raw.kind) {
        case "callerCancelled":
          session.reportAttemptOutcome(attemptId, "callerCancelled");
          return {
            kind: "cancelled",
            correlation,
            code: "userCancelled",
            provider: { providerLabel: reserved.providerLabel, storedModelId: reserved.storedModelId },
          };
        case "providerCancelled":
          session.reportAttemptOutcome(attemptId, "providerCancelled");
          return {
            kind: "cancelled",
            correlation,
            code: "providerCancelled",
            provider: { providerLabel: reserved.providerLabel, storedModelId: reserved.storedModelId },
          };
        case "overflow":
          session.reportAttemptOutcome(attemptId, "overflow");
          return {
            kind: "malformedResult",
            correlation,
            code: "resultLimitExceeded",
            ...(context.provider ? { provider: context.provider } : {}),
          };
        case "transportFailure": {
          // A transport failure's CODE is the fault class (cliRunTimeout vs
          // cliNotInstalled vs cliExit.1 — completely different remedies) and
          // was previously dropped: `attemptOutcomeReasonTextV1` renders only
          // the closed kind, so every pre-response failure read as the same
          // generic sentence in a chain-exhaustion report (workflow 5 run 039,
          // three providers, three identical lines). Carry code plus detail.
          const transportEvidence = raw.detail !== undefined
            ? `${raw.code}: ${raw.detail}`
            : raw.code;
          if (raw.responseStarted) {
            session.reportAttemptOutcome(
              attemptId,
              "transportFailureResponseStarted",
              transportEvidence
            );
            return {
              kind: "failed",
              correlation,
              code: raw.code,
              retryable: false,
              ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
              ...(context.provider ? { provider: context.provider } : {}),
            };
          }
          session.reportAttemptOutcome(attemptId, "transportFailurePreResponse", transportEvidence);
          // Item 14: a transport-flagged network fault (dropped connection,
          // DNS failure, TLS handshake failure, HTTP/2 protocol error) is a
          // property of the pipe, not the model, and is usually resolved by
          // an immediate retry — falling straight to a backup would silently
          // change which model authors the artifact for a reason that had
          // nothing to do with the model. Bounded to one retry per candidate,
          // and gated on the SAME shared invocation-cap check the ordinary
          // fallback below is gated on, so a persistent network fault cannot
          // quietly outspend the malformed-result budget once it is armed.
          // The retry re-reserves the exact runner/provider/model this
          // attempt used directly through the session (bypassing the
          // registry's ranked cursor), so it never consumes a fallback slot.
          if (
            raw.networkFault === true &&
            networkFaultRetriesUsedV1 < MAX_NETWORK_FAULT_RETRIES_PER_CANDIDATE_V1 &&
            currentCandidateIdentityV1 !== undefined &&
            !(malformedBudgetArmedV1 && malformedInvocationCountV1 >= MAX_MALFORMED_RESULT_INVOCATIONS_V1)
          ) {
            networkFaultRetriesUsedV1++;
            const retryAttemptId = session.allocateAttempt();
            if (!(await reportAttemptAllocatedV1(retryAttemptId))) {
              session.reportAttemptOutcome(retryAttemptId, "providerUnavailablePreInvocation");
              return attachmentFailureOutcomeV1(retryAttemptId);
            }
            networkFaultRetryAttemptIdsV1.add(retryAttemptId);
            const retryHandle = session.reserve({
              attemptId: retryAttemptId,
              mode: row.providerMode,
              runnerId: currentCandidateIdentityV1.runnerId,
              providerId: currentCandidateIdentityV1.providerId,
              modelId: currentCandidateIdentityV1.modelId,
            });
            pendingCandidate = {
              attemptId: retryAttemptId,
              reserved: { ...reserved, handle: retryHandle },
            };
            continue;
          }
          // Pre-response failure is the fallback-eligible case: loop for the
          // next registry-ranked candidate with a fresh attempt and an
          // explicit next reservation — UNLESS the malformed-result budget
          // is armed and already exhausted, in which case advancing again
          // would push this operation's total invocations past the shared
          // 3-invocation cap. In that case report the honest diagnosis
          // (the last malformed outcome, if this row produced one) instead
          // of masking it behind an unbounded transport-failure walk.
          if (malformedBudgetArmedV1 && malformedInvocationCountV1 >= MAX_MALFORMED_RESULT_INVOCATIONS_V1) {
            return (
              lastMalformedOutcomeV1 ?? {
                kind: "failed",
                correlation,
                code: raw.code,
                retryable: true,
                ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
                ...(context.provider ? { provider: context.provider } : {}),
              }
            );
          }
          continue;
        }
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
        if (malformedRetryEligibleV1) {
          malformedBudgetArmedV1 = true;
        }
        const framelessFallback = tryFramelessContentFallbackV1(row, correlation, parsed);
        if (framelessFallback) {
          return settleEnvelope(
            row,
            framelessFallback,
            session,
            attemptId,
            context,
            acquireLeasePhase,
            promptSha256,
            {
              text: unsealed.text,
              reservationId: reserved.handle.reservationId,
              providerLabel: reserved.providerLabel,
              storedModelId: reserved.storedModelId,
            }
          );
        }
        // Decide advance eligibility BEFORE reporting the attempt outcome.
        // `resultCorrelationMismatch` is excluded: it signals a correlation
        // bug, not a bad provider response, and a different candidate cannot
        // fix it. A malformed result the coordinator will NOT retry reports
        // the ordinary terminal `"malformedResult"` outcome, exactly as
        // before this step. One that WILL be retried reports the dedicated
        // `"malformedResultPreFallback"` outcome instead — `"malformedResult"`
        // itself is terminal by design (AC-RUNNER-05), so reporting it here
        // and then looping to `session.allocateAttempt()` would throw
        // `ProviderSelectionPolicyErrorV1` on a closed session. See that
        // outcome kind's own doc comment in `providerSelectionPolicyV1.ts`.
        const willAdvanceV1 =
          parsed.code !== "resultCorrelationMismatch" &&
          malformedRetryEligibleV1 &&
          malformedInvocationCountV1 < MAX_MALFORMED_RESULT_INVOCATIONS_V1;
        session.reportAttemptOutcome(
          attemptId,
          parsed.code === "resultCorrelationMismatch"
            ? "resultCorrelationMismatch"
            : willAdvanceV1
              ? "malformedResultPreFallback"
              : "malformedResult"
        );
        // parsed.reason is our own parser's structural diagnostic (e.g.
        // "expected the frame to start with <<<...>>>") — never parsed.raw,
        // which can carry the model's full free-text reply and must never
        // reach a settled outcome (§2.2). See detail's own doc comment for
        // the live failure this makes diagnosable.
        const reasonDetail = boundedDiagnosticDetailV1(parsed.reason);
        // The received text was correctly unsealed — only the output-format
        // contract in front of it is what failed — so it is preserved
        // (best-effort, 24h) before being discarded. See that function's own
        // doc comment for the live incident this closes.
        const preservationResult = await preserveRejectedResultForRecoveryV1(
          unsealed.text,
          correlation,
          reserved.handle.reservationId,
          deps.brokerOptions,
          { providerLabel: reserved.providerLabel, storedModelId: reserved.storedModelId }
        );
        const detailParts = [
          reasonDetail,
          preservationDetailFragmentV1(preservationResult),
        ].filter((part): part is string => part !== undefined);
        const malformedOutcomeV1: TaskActionOutcomeV1 = {
          kind: "malformedResult",
          correlation,
          code: parsed.code,
          ...(detailParts.length > 0 ? { detail: detailParts.join("; ") } : {}),
          ...(context.provider ? { provider: context.provider } : {}),
          // Only stamped for rows this loop could have advanced (see
          // `malformedRetryEligibleV1` above) — carries the shared budget
          // forward to `withMalformedResultRetryV1` so the outer wrapper
          // stops at the same 3-invocation total instead of adding its own
          // fixed retries on top. See this field's own doc comment in
          // `taskActionOutcomeV1.ts`.
          ...(malformedRetryEligibleV1 ? { malformedInvocationsUsedV1: malformedInvocationCountV1 } : {}),
        };
        // Advance to the next ranked candidate instead of surfacing this
        // outcome immediately — see the budget/eligibility doc comment
        // above the `for (;;)` loop.
        if (willAdvanceV1) {
          lastMalformedOutcomeV1 = malformedOutcomeV1;
          continue;
        }
        return malformedOutcomeV1;
      }

      // Candidate-scoped content-contract check (2026-08-16 field report,
      // fourth item): a schema-valid envelope can still fail a row's OWN
      // content rule (review.v1's required `Readiness: N/10` line). That is
      // a fault of THIS candidate's response, not of the target artifact, so
      // it is decided — exactly like the malformed-envelope branch above —
      // BEFORE `session.reportAttemptOutcome(attemptId, "completed")` closes
      // the session, so a working next-ranked candidate can still run
      // instead of the whole stage settling on a terminal `promotionFailed`
      // that a different model would not have produced.
      if (
        parsed.kind === "completed" &&
        parsed.content.contentType === row.completedContentType &&
        row.validateCompletedContent
      ) {
        const contentValidation = row.validateCompletedContent(parsed.content, context);
        if (!contentValidation.ok) {
          if (malformedRetryEligibleV1) {
            malformedBudgetArmedV1 = true;
          }
          const disposition = classifyProviderCandidateDispositionV1({
            retryEligible: malformedRetryEligibleV1,
            invocationsUsed: malformedInvocationCountV1,
            maxInvocations: MAX_MALFORMED_RESULT_INVOCATIONS_V1,
          });
          const willAdvanceContractV1 = disposition === "advanceCandidate";
          session.reportAttemptOutcome(
            attemptId,
            willAdvanceContractV1 ? "contentContractFailurePreFallback" : "contentContractFailure"
          );
          const preservationResult = await preserveRejectedResultForRecoveryV1(
            unsealed.text,
            correlation,
            reserved.handle.reservationId,
            deps.brokerOptions,
            { providerLabel: reserved.providerLabel, storedModelId: reserved.storedModelId }
          );
          const contractOutcomeV1: TaskActionOutcomeV1 = {
            kind: "failed",
            correlation,
            code: "contentContractFailed",
            retryable: false,
            detail: [
              boundedDiagnosticDetailV1(contentValidation.reason),
              preservationDetailFragmentV1(preservationResult),
            ]
              .filter((part): part is string => part !== undefined)
              .join("; "),
            ...(context.provider ? { provider: context.provider } : {}),
          };
          if (willAdvanceContractV1) {
            malformedInvocationCountV1++;
            lastMalformedOutcomeV1 = contractOutcomeV1;
            continue;
          }
          return contractOutcomeV1;
        }
      }

      return settleEnvelope(row, parsed, session, attemptId, context, acquireLeasePhase, promptSha256, {
        text: unsealed.text,
        reservationId: reserved.handle.reservationId,
        providerLabel: reserved.providerLabel,
        storedModelId: reserved.storedModelId,
      });
    }
  }

  async function settleEnvelope(
    row: ProviderTaskActionRowV1,
    envelope: AiResultEnvelopeV1,
    session: ProviderSelectionSessionV1,
    attemptId: string,
    context: TaskActionExecutionContextV1,
    acquireLeasePhase: AcquireTaskLeasePhaseV1,
    promptSha256: string,
    unsealedResponse: UnsealedResponseRefV1
  ): Promise<TaskActionOutcomeV1> {
    const correlation = context.correlation;
    if (!row.permittedResultKinds.includes(envelope.kind)) {
      session.reportAttemptOutcome(attemptId, "malformedResult");
      const preservationResult = await preserveRejectedResultForRecoveryV1(
        unsealedResponse.text,
        correlation,
        unsealedResponse.reservationId,
        deps.brokerOptions,
        { providerLabel: unsealedResponse.providerLabel, storedModelId: unsealedResponse.storedModelId }
      );
      return {
        kind: "malformedResult",
        correlation,
        code: "contentSchemaMismatch",
        detail:
          `received result kind "${envelope.kind}", but ${row.actionKey} only permits: ${row.permittedResultKinds.join(", ")}; ` +
          preservationDetailFragmentV1(preservationResult),
        ...(context.provider ? { provider: context.provider } : {}),
      };
    }
    switch (envelope.kind) {
      case "completed": {
        if (envelope.content.contentType !== row.completedContentType) {
          session.reportAttemptOutcome(attemptId, "malformedResult");
          const preservationResult = await preserveRejectedResultForRecoveryV1(
            unsealedResponse.text,
            correlation,
            unsealedResponse.reservationId,
            deps.brokerOptions,
            { providerLabel: unsealedResponse.providerLabel, storedModelId: unsealedResponse.storedModelId }
          );
          return {
            kind: "malformedResult",
            correlation,
            code: "contentSchemaMismatch",
            detail:
              `received content type "${envelope.content.contentType}", expected "${row.completedContentType}"; ` +
              preservationDetailFragmentV1(preservationResult),
            ...(context.provider ? { provider: context.provider } : {}),
          };
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
          return { kind: "completed", correlation, code, ...(context.provider ? { provider: context.provider } : {}) };
        } catch (error) {
          return {
            kind: "failed",
            correlation,
            code: promotionFailureCodeV1(error instanceof Error ? error.message : String(error)),
            retryable: false,
            ...(context.provider ? { provider: context.provider } : {}),
          };
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
          return {
            kind: "failed",
            correlation,
            code: "chatTransactionNotRecorded",
            retryable: true,
            ...(context.provider ? { provider: context.provider } : {}),
          };
        }
        return {
          kind: "questions",
          correlation,
          interactionId: posted.record.interactionId,
          ...(context.provider ? { provider: context.provider } : {}),
        };
      }
      case "cancelled": {
        if (envelope.reason === "user") {
          session.reportAttemptOutcome(attemptId, "callerCancelled");
          return {
            kind: "cancelled",
            correlation,
            code: "userCancelled",
            ...(context.provider ? { provider: context.provider } : {}),
          };
        }
        session.reportAttemptOutcome(attemptId, "providerCancelled");
        return {
          kind: "cancelled",
          correlation,
          code: "providerCancelled",
          ...(context.provider ? { provider: context.provider } : {}),
        };
      }
      case "failed": {
        session.reportAttemptOutcome(attemptId, "providerDeclaredFailure");
        // The model's own explanation was previously DISCARDED — only its
        // invented code survived. On 2026-08-18 a Copilot round failed with
        // `unreliable-manual-encoding` and nothing else, when the envelope
        // also carried a message saying precisely what it could not do. A
        // provider-declared failure is the one case where the model is
        // telling us the diagnosis directly, so throwing it away is the
        // worst possible place to lose text.
        //
        // Bounded and sanitized like every other detail: §2.2 bars the
        // model's free-form REPLY from a settled outcome, and this is a
        // short self-diagnosis in a closed envelope field, not the reply.
        const declaredDetail = boundedDiagnosticDetailV1(envelope.message);
        return {
          kind: "failed",
          correlation,
          code: envelope.code,
          retryable: envelope.retryable,
          ...(declaredDetail !== undefined ? { detail: declaredDetail } : {}),
          ...(context.provider ? { provider: context.provider } : {}),
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
      let identityAttached = true;
      try {
        await request.onAttemptAllocated?.({ attemptId, operationId });
      } catch (error) {
        // `admitAction` owns an open progress handle at this point. Convert
        // an attachment failure into a normal, settled result so it cannot
        // escape `executeAction` before `progress.end()` and audit logging.
        console.error("onAttemptAllocated failed:", error);
        identityAttached = false;
      }
      if (!identityAttached) {
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        progress.end();
        return {
          kind: "settled",
          outcome: finalizeOutcome(
            row,
            request,
            operationId,
            {
              kind: "failed",
              correlation: {
                actionKey: row.actionKey,
                operationId,
                attemptId,
                taskBindingId: request.taskBinding.taskBindingId,
                chatDocumentId: request.taskBinding.chatDocumentId,
              },
              code: "attemptIdentityAttachmentFailed",
              retryable: true,
            },
            metrics
          ),
        };
      }
      const next = selection.reserveNext(attemptId);
      if (next.kind === "noneRemaining") {
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        progress.end();
        // Same code pass-through and evidence enrichment as the invocation
        // loop's noneRemaining branch (finding 4 + workflow 3 continuation
        // third item): no task-state mutation here — the stage owner
        // surfaces the exhausted chain. At admission time no candidate has
        // been invoked yet, so this is providerModeUnavailable in practice;
        // the registry's code is still carried verbatim rather than
        // re-asserted here.
        return {
          kind: "settled",
          outcome: finalizeOutcome(
            row,
            request,
            operationId,
            {
              kind: "unavailable",
              code: next.code,
              ...(next.chainExhaustion !== undefined
                ? {
                    chainExhaustion: enrichChainExhaustionWithAttemptOutcomesV1(
                      next.chainExhaustion,
                      session
                    ),
                  }
                : {}),
            },
            metrics
          ),
        };
      }
      if (next.kind === "candidateUnavailable") {
        reportCandidateSkipped(deps, next, request.taskStage);
        continue;
      }
      initialCandidate = { attemptId, reserved: next.reserved };
      break;
    }

    // Item 9 fix (2026-08-17..19 workflow-defects batch): populated only when
    // the questions-admission branch below actually assembles and admits a
    // prompt for `initialCandidate` — carried into the returned ticket so
    // `runProviderRow` reuses this exact assembly (and its tool session)
    // for that candidate's first attempt instead of building — and paying
    // for a second tool session behind — its own. See
    // `assembleAttemptPromptV1`'s doc comment.
    let initialCandidateAssembledPrompt: AssembledAttemptPromptV1 | undefined;

    if (row.permittedResultKinds.includes("questions")) {
      const correlation = initialCandidate.reserved.handle.correlation;
      // Built through the same `assembleAttemptPromptV1` helper
      // `runProviderRow` uses to invoke, so the record admitted HERE —
      // before any candidate has actually been invoked — carries the digest
      // of the exact bytes that will later be sent, including a
      // `readsWorkspaceFiles` row's read-session preamble.
      const assembled = assembleAttemptPromptV1(
        row,
        correlation,
        stage,
        validation.input,
        undefined,
        {
          providerLabel: initialCandidate.reserved.providerLabel,
          storedModelId: initialCandidate.reserved.storedModelId,
          providerReadsWorkspaceNatively: initialCandidate.reserved.providerReadsWorkspaceNatively,
        }
      );
      if (!assembled.ok) {
        session.reportAttemptOutcome(initialCandidate.attemptId, "providerUnavailablePreInvocation");
        progress.end();
        return {
          kind: "settled",
          outcome: finalizeOutcome(
            row,
            request,
            operationId,
            { kind: "failed", correlation, code: assembled.code, retryable: false },
            metrics
          ),
        };
      }
      const { promptSha256 } = assembled;
      initialCandidateAssembledPrompt = assembled;

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
                  code: chatTransactionFailureCodeV1(admitted.code, admitted.reason),
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
        ...(initialCandidateAssembledPrompt !== undefined ? { initialCandidateAssembledPrompt } : {}),
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
          ticket.initialCandidate,
          ticket.request.malformedInvocationsAlreadyUsedV1,
          ticket.initialCandidateAssembledPrompt,
          ticket.request.onPromptAssembled,
          ticket.operationId,
          ticket.request.onAttemptAllocated,
          ticket.request.taskBinding
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
        claimInvocationOnce,
        undefined,
        undefined,
        undefined,
        undefined,
        request.onPromptAssembled,
        operationRef.operationId,
        request.onAttemptAllocated,
        request.taskBinding
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
