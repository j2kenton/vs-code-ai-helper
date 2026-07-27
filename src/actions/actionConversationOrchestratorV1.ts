/**
 * Action conversation orchestrator (plan §3.8 / §5.5,
 * `src/actions/actionConversationOrchestratorV1.ts`).
 *
 * Owns the lifecycle of one structured-question interaction on top of the
 * DURABLE Chat interaction transaction store (plan §5.5, the Chat cohort's
 * step-8 wiring): a `questions` result begins exactly one persisted
 * transaction — written through BEFORE the questions outcome is surfaced, so
 * no Chat display state can exist without its durable record (AC-CHAT-TX-02's
 * ordering rule); typed answers are submitted with an idempotency record;
 * explicit Resume settles the interaction exactly once, per the registry
 * row's declared `ResumeSemanticsV1` (plan §3.1 / AC-ID-04):
 *
 *  - `sameOperation` — Resume retains the original `operationId` and
 *    allocates a new `attemptId`; the interaction settles as `resumed`.
 *  - `replacementOperation` — Resume allocates a fresh linked `operationId`
 *    (carrying `resumedFromOperationId` and the source `interactionId`); the
 *    interaction settles as `supersededByReplacementOperation`.
 *
 * The former in-memory Map ledger is gone. Every state change is journaled
 * through `chatInteractionTransactionStoreV1` at the registry-vended
 * `chat-transactions/<operation-id>/transaction-v1.json` locator, which is
 * what makes Resume reconstructible across extension-host restarts
 * (AC-QUESTION-03): the persisted record carries the validated original
 * action input snapshot and the prompt-contract identity alongside the
 * question set. Interactions are addressed by `InteractionRefV1` — the
 * durable identity is the operation (exactly one transaction per
 * question-returning operation, AC-CHAT-TX-01), and the reference's
 * interaction id is validated against the persisted record on every access.
 *
 * A second Resume — or a re-submission with a different idempotency id or
 * different answers — is rejected by the persisted idempotency binding; the
 * identical Resume idempotency id replays the recorded resolution — the
 * linkage's exact recorded attempt/operation — instead of resuming twice.
 * Resume idempotency ids are CALLER-OWNED (§3.1): callers allocate and
 * persist them before scheduling, so the id survives a crash and the replay
 * path stays reachable. Answering never invokes a provider; the coordinator
 * performs the actual Resume execution with the resolution this module
 * returns. Storage unavailability and corrupt records surface as data
 * (`postQuestions`/`submitAnswers`) or typed errors (Resume/settlement), so
 * the coordinator can map them onto the stable §3.7 outcomes.
 *
 * INVOCATION-ONCE CLAIM — a settled resolution replays idempotently for the
 * identical Resume idempotency id (crash recovery), but the provider
 * invocation it drives must run at most once (plan §3.1 / AC-RUNNER-03).
 * `claimResumeInvocation` durably claims that invocation, exactly once, over
 * the transaction store: the coordinator calls it immediately before
 * invoking the provider (right at the reservation/invocation boundary — NOT
 * earlier, so a crash during session/selection setup leaves no claim at all
 * and stays fully retryable), and MUST NOT invoke the provider when
 * `alreadyClaimed` comes back true.
 *
 * A bare claim cannot tell "the earlier drive completed", "it is still in
 * flight", and "it crashed mid-invocation" apart — so `claimResumeInvocation`
 * also surfaces `recoveredOutcome`: once a claimed invocation actually runs
 * to completion, the coordinator durably mirrors its exact outcome via
 * `recordResumeInvocationOutcome`. A re-drive that finds `alreadyClaimed`
 * with a `recoveredOutcome` present recovers and returns that EXACT result
 * instead of invoking the provider again ("recover the claimed terminal
 * result"); only `alreadyClaimed` with no `recoveredOutcome` is the
 * genuinely ambiguous in-flight/unknown case that must still fail closed.
 */
import {
  ActionCorrelationV1,
  allocateHex128IdV1,
  AttemptIdV1,
  InteractionIdV1,
  isHex128IdV1,
  OperationIdV1,
  ResumeSemanticsV1,
} from "../types/actionCorrelationV1";
import {
  ChatInteractionSettlementV1,
  ChatInteractionTransactionStateV1,
  ChatInteractionTransactionV1,
  ChatTransactionInputSnapshotV1,
  ChatTransactionPromptContractV1,
  ChatTransactionResumeResolutionV1,
} from "../types/chatInteractionTransactionV1";
import {
  ChatInteractionTransactionStoreV1,
  ChatTransactionStoreResultV1,
} from "../services/chatInteractionTransactionStoreV1";
import { StructuredAnswerV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { TaskStage } from "../types/taskProgress";

export class ActionConversationErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionConversationErrorV1";
  }
}

/** §5.5's persisted interaction states, verbatim (the durable record's own union). */
export type InteractionStateV1 = ChatInteractionTransactionStateV1;

/** §5.5's terminal settlements, verbatim. */
export type InteractionSettlementV1 = ChatInteractionSettlementV1;

/**
 * Durable interaction address: the operation owns the persisted transaction
 * (plan §5.5's one-record-per-operation rule). `loadValidated` requires EVERY
 * field here to match the persisted transaction's OWN recorded values before
 * any mutation (plan §3.1 / AC-ID-03) — a stale or foreign reference never
 * reaches another operation's interaction, task, document, or source attempt.
 * The full task/document/source-attempt binding is REQUIRED, not optional:
 * chatView.ts's Answer/Cancel/Resume controls derive it server-side from the
 * current task-local Chat document and its mirrored interaction record
 * (chatHistoryStore.ts's `readChatDocumentIdentityV1`/`readChatInteractions`)
 * rather than trusting anything the webview supplies, so every production
 * caller can always supply the complete tuple.
 */
export interface InteractionRefV1 {
  readonly operationId: OperationIdV1;
  readonly interactionId: InteractionIdV1;
  /** The caller-asserted task/document binding (plan §3.1's authoritative binding). */
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  /** The question-time source attempt the interaction's transaction was opened under (plan §3.1). */
  readonly sourceAttemptId: string;
}

export type ResumeResolutionV1 =
  | {
      readonly kind: "sameOperation";
      readonly operationId: OperationIdV1;
      readonly newAttemptId: AttemptIdV1;
    }
  | {
      readonly kind: "replacementOperation";
      readonly replacementOperationId: OperationIdV1;
      readonly resumedFromOperationId: OperationIdV1;
      readonly sourceInteractionId: InteractionIdV1;
    };

export interface ActionInteractionRecordV1 {
  readonly interactionId: InteractionIdV1;
  /** The question-time source correlation: actionKey, operationId, source attemptId, task/document binding. */
  readonly correlation: ActionCorrelationV1;
  /** The stage these questions belong to (Chat is fully stage-isolated). */
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  /**
   * The validated original action input snapshot (plan §5.5): canonical JSON
   * plus digest, verified by the store's strict decoder on every load. The
   * coordinator's Resume path reconstructs the action from it
   * (AC-QUESTION-03). Chat-private — never loggable.
   */
  readonly inputSnapshot: ChatTransactionInputSnapshotV1;
  readonly questions: readonly StructuredQuestionV1[];
  /** SHA-256 of the canonical question set — answer submissions validate against it. */
  readonly questionSetDigest: string;
  readonly state: InteractionStateV1;
  readonly answers?: readonly StructuredAnswerV1[];
  readonly answerIdempotencyId?: string;
  readonly answerDigest?: string;
  /** The §3.1 Resume idempotency binding — present from `resumeScheduled`. */
  readonly resumeIdempotencyId?: string;
  readonly settlement?: InteractionSettlementV1;
  readonly resumeResolution?: ResumeResolutionV1;
  /** Set once the resolution's provider invocation has been durably claimed (plan §3.1 / AC-RUNNER-03). */
  readonly resumeInvocationClaimedAt?: string;
  /**
   * Durable mirror of the terminal outcome the claimed invocation produced
   * (plan §3.1 / AC-RUNNER-03 "recover the claimed terminal result").
   */
  readonly resumeInvocationOutcome?: TaskActionOutcomeV1;
}

export type ClaimResumeInvocationResultV1 =
  | {
      readonly ok: true;
      readonly alreadyClaimed: boolean;
      /**
       * Present only when `alreadyClaimed` is true AND the claimed
       * invocation's terminal outcome was already durably recorded: the
       * caller should return this EXACT outcome instead of invoking the
       * provider again. Absent alongside `alreadyClaimed: true` means the
       * outcome is still unknown (in-flight or crashed with no result) —
       * the caller must fail closed, not guess.
       */
      readonly recoveredOutcome?: TaskActionOutcomeV1;
    }
  | {
      readonly ok: false;
      /** `workflowStorageUnavailable` — the stable §3.7 code; otherwise a sanitized rejection reason. */
      readonly code: "workflowStorageUnavailable" | "claimRejected";
      readonly reason: string;
    };

export type RecordResumeInvocationOutcomeResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `workflowStorageUnavailable` — the stable §3.7 code; otherwise a sanitized rejection reason. */
      readonly code: "workflowStorageUnavailable" | "recordRejected";
      readonly reason: string;
    };

export interface PostQuestionsInputV1 {
  /** Question-time source correlation (actionKey, operationId, source attemptId, binding). */
  readonly correlation: ActionCorrelationV1;
  /** The stage these questions belong to (Chat is fully stage-isolated). */
  readonly stage: TaskStage;
  /** The registry row's declared Resume semantics (plan §3.1). */
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly questions: readonly StructuredQuestionV1[];
  /** The row's validated input, persisted as the Resume-reconstruction snapshot (plan §5.5). */
  readonly validatedInput: unknown;
  /** The prompt-contract identity/version and prompt-input digest (plan §5.5). */
  readonly promptContract: ChatTransactionPromptContractV1;
}

export type PostQuestionsResultV1 =
  | { readonly ok: true; readonly record: ActionInteractionRecordV1 }
  | {
      readonly ok: false;
      /**
       * `workflowStorageUnavailable` — the private transaction storage could
       * not persist the record (plan §3.7's stable code); the questions must
       * NOT surface, because Resume would not be reconstructible.
       * `chatTransactionRejected` — the transaction content violated the
       * §5.5 record contract (e.g. an oversized question set or input
       * snapshot) and was never persisted.
       */
      readonly code: "workflowStorageUnavailable" | "chatTransactionRejected";
      readonly reason: string;
    };

export type SubmitAnswersResultV1 =
  | { readonly ok: true; readonly duplicate: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Typed load result for `loadInteraction`, preserving the store's failure
 * distinctions so the coordinator can map each onto its stable §3.7 outcome:
 * `unknown` (no record / mismatched interaction id) and `recoveryRequired`
 * (corrupt record) are AC-CHAT-TX-03's read-only, non-resumable states;
 * `storageUnavailable` is `unavailable/workflowStorageUnavailable`.
 */
export type LoadInteractionResultV1 =
  | { readonly kind: "ok"; readonly record: ActionInteractionRecordV1 }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageUnavailable"; readonly reason: string };

export interface ActionConversationOrchestratorV1 {
  /**
   * Record a `questions` result as a new unresolved interaction backed by
   * exactly one durable Chat interaction transaction. The record is written
   * through — and self-verified by the store's strict decoder — before this
   * resolves; a failure leaves nothing persisted and nothing displayable.
   */
  postQuestions(input: PostQuestionsInputV1): Promise<PostQuestionsResultV1>;
  /**
   * Submit exactly one validated answer per question. Idempotent: the same
   * idempotency id with byte-identical canonical answers is a no-op; any
   * other re-submission is rejected. Accepts raw unknown at the boundary —
   * the store's strict decoder rejects unknown properties before validation,
   * digesting, or storage, and the durable write happens before any Chat
   * display state may change (plan §5.5).
   */
  submitAnswers(
    ref: InteractionRefV1,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<SubmitAnswersResultV1>;
  /**
   * Resolve an explicit Resume exactly once, per the interaction's declared
   * semantics, journaling `resumeScheduled` before settlement so the
   * persisted chain proves the traversal (plan §5.5). The id is
   * caller-owned and required (§3.1): callers allocate and persist it
   * before scheduling, and the identical `resumeIdempotencyId` replays the
   * recorded resolution — the linkage's exact recorded attempt or
   * replacement operation — after a crash. Throws on a second Resume under
   * any other id (the persisted idempotency record rejects it), on an
   * unanswered interaction, or on an unknown reference.
   */
  resolveResume(ref: InteractionRefV1, resumeIdempotencyId: string): Promise<ResumeResolutionV1>;
  /**
   * Durably claim, at most once, the provider invocation the interaction's
   * settled Resume resolution drives (plan §3.1 / AC-RUNNER-03). Must be
   * called AFTER `resolveResume` (fresh or replayed) and immediately BEFORE
   * invoking the provider — the actual reservation/invocation boundary, not
   * earlier. `alreadyClaimed: true` means a prior drive already claimed this
   * invocation — the caller MUST NOT invoke the provider again; if
   * `recoveredOutcome` is also present, the caller should return that exact
   * outcome instead ("recover the claimed terminal result").
   */
  claimResumeInvocation(ref: InteractionRefV1): Promise<ClaimResumeInvocationResultV1>;
  /**
   * Durably record the terminal outcome a claimed invocation produced (plan
   * §3.1 / AC-RUNNER-03). Call after the provider invocation this operation's
   * claim covers settles, regardless of outcome kind. Best-effort from the
   * caller's perspective — the real outcome should still be returned to the
   * user even if this fails to persist — but it is what makes a later replay
   * recover the result instead of only ever failing closed.
   */
  recordResumeInvocationOutcome(
    ref: InteractionRefV1,
    outcome: TaskActionOutcomeV1
  ): Promise<RecordResumeInvocationOutcomeResultV1>;
  /** Settle without provider invocation. Idempotent only as an error, never as a re-settlement. */
  cancel(ref: InteractionRefV1): Promise<void>;
  /** Expiry settlement (§5.5): unresolved interactions downgrade to read-only. */
  expire(ref: InteractionRefV1): Promise<void>;
  /**
   * Load the durable record for a reference. `undefined` for an unknown
   * operation or a mismatched interaction id; throws when the persisted
   * record is corrupt (`recoveryRequired`, AC-CHAT-TX-03) or storage is
   * unavailable.
   */
  getRecord(ref: InteractionRefV1): Promise<ActionInteractionRecordV1 | undefined>;
  /**
   * Load the durable record as data, never throwing: the typed result keeps
   * the unknown / corrupt / storage-unavailable distinctions so the
   * coordinator's Resume entrypoint can map each onto its stable outcome.
   */
  loadInteraction(ref: InteractionRefV1): Promise<LoadInteractionResultV1>;
}

/** Reconstruct the orchestrator's full resolution shape from a persisted record. */
function recordedResolution(
  transaction: ChatInteractionTransactionV1,
  stored: ChatTransactionResumeResolutionV1
): ResumeResolutionV1 {
  return stored.kind === "sameOperation"
    ? {
        kind: "sameOperation",
        operationId: transaction.operationId,
        newAttemptId: stored.newAttemptId,
      }
    : {
        kind: "replacementOperation",
        replacementOperationId: stored.replacementOperationId,
        resumedFromOperationId: transaction.operationId,
        sourceInteractionId: transaction.interactionId,
      };
}

function toRecord(transaction: ChatInteractionTransactionV1): ActionInteractionRecordV1 {
  return {
    interactionId: transaction.interactionId,
    correlation: {
      actionKey: transaction.actionKey,
      operationId: transaction.operationId,
      attemptId: transaction.sourceAttemptId,
      taskBindingId: transaction.taskBindingId,
      chatDocumentId: transaction.chatDocumentId,
    },
    stage: transaction.stage,
    resumeSemantics: transaction.resumeSemantics,
    inputSnapshot: transaction.inputSnapshot,
    questions: transaction.questions,
    questionSetDigest: transaction.questionSetSha256,
    state: transaction.state,
    ...(transaction.answers !== undefined ? { answers: transaction.answers } : {}),
    ...(transaction.answerIdempotencyId !== undefined
      ? { answerIdempotencyId: transaction.answerIdempotencyId }
      : {}),
    ...(transaction.answersSha256 !== undefined ? { answerDigest: transaction.answersSha256 } : {}),
    ...(transaction.resumeIdempotencyId !== undefined
      ? { resumeIdempotencyId: transaction.resumeIdempotencyId }
      : {}),
    ...(transaction.settlement !== undefined ? { settlement: transaction.settlement } : {}),
    ...(transaction.resumeResolution !== undefined
      ? { resumeResolution: recordedResolution(transaction, transaction.resumeResolution) }
      : {}),
    ...(transaction.resumeInvocationClaimedAt !== undefined
      ? { resumeInvocationClaimedAt: transaction.resumeInvocationClaimedAt }
      : {}),
    ...(transaction.resumeInvocationOutcome !== undefined
      ? { resumeInvocationOutcome: transaction.resumeInvocationOutcome }
      : {}),
  };
}

/** Sanitized failure text for non-ok store results (§2.2: codes and errno only, never content). */
function storeFailureReason(
  result: Exclude<ChatTransactionStoreResultV1, { kind: "ok" }>
): string {
  switch (result.kind) {
    case "missing":
      return "no interaction transaction exists for this operation";
    case "rejected":
      return result.reason;
    case "recoveryRequired":
      return `interaction transaction requires recovery: ${result.reason}`;
    case "unavailable":
      return `workflow storage is unavailable (${result.code})`;
    case "storageFailure":
      return `workflow storage failed${result.errno !== undefined ? ` (${result.errno})` : ""}`;
  }
}

export function createActionConversationOrchestratorV1(options: {
  /** The durable §5.5 ledger; every interaction state change persists through it. */
  readonly transactionStore: ChatInteractionTransactionStoreV1;
}): ActionConversationOrchestratorV1 {
  const store = options.transactionStore;

  type LoadedInteractionV1 =
    | { readonly kind: "ok"; readonly transaction: ChatInteractionTransactionV1 }
    | { readonly kind: "unknown"; readonly reason: string }
    | { readonly kind: "recoveryRequired"; readonly reason: string }
    | { readonly kind: "storageUnavailable"; readonly reason: string };

  async function loadValidated(ref: InteractionRefV1): Promise<LoadedInteractionV1> {
    const loaded = await store.load(ref.operationId);
    if (loaded.kind === "ok") {
      if (loaded.transaction.interactionId !== ref.interactionId) {
        return {
          kind: "unknown",
          reason:
            "the interaction reference does not match the operation's recorded interaction",
        };
      }
      if (loaded.transaction.taskBindingId !== ref.taskBindingId) {
        return {
          kind: "unknown",
          reason: "the interaction reference does not match the operation's recorded task binding",
        };
      }
      if (loaded.transaction.chatDocumentId !== ref.chatDocumentId) {
        return {
          kind: "unknown",
          reason: "the interaction reference does not match the operation's recorded chat document",
        };
      }
      if (loaded.transaction.sourceAttemptId !== ref.sourceAttemptId) {
        return {
          kind: "unknown",
          reason: "the interaction reference does not match the operation's recorded source attempt",
        };
      }
      return { kind: "ok", transaction: loaded.transaction };
    }
    if (loaded.kind === "missing" || loaded.kind === "rejected") {
      return { kind: "unknown", reason: storeFailureReason(loaded) };
    }
    if (loaded.kind === "recoveryRequired") {
      return { kind: "recoveryRequired", reason: storeFailureReason(loaded) };
    }
    return { kind: "storageUnavailable", reason: storeFailureReason(loaded) };
  }

  function requireLoaded(ref: InteractionRefV1, loaded: LoadedInteractionV1): ChatInteractionTransactionV1 {
    if (loaded.kind === "ok") {
      return loaded.transaction;
    }
    if (loaded.kind === "unknown") {
      throw new ActionConversationErrorV1(
        `Unknown interaction ${JSON.stringify(ref.interactionId)}: ${loaded.reason}.`
      );
    }
    throw new ActionConversationErrorV1(loaded.reason);
  }

  async function settleTerminal(ref: InteractionRefV1, settle: () => Promise<ChatTransactionStoreResultV1>): Promise<void> {
    requireLoaded(ref, await loadValidated(ref));
    const settled = await settle();
    if (settled.kind !== "ok") {
      throw new ActionConversationErrorV1(storeFailureReason(settled));
    }
  }

  return {
    async postQuestions(input: PostQuestionsInputV1): Promise<PostQuestionsResultV1> {
      const begun = await store.begin({
        correlation: input.correlation,
        interactionId: allocateHex128IdV1(),
        stage: input.stage,
        resumeSemantics: input.resumeSemantics,
        validatedInput: input.validatedInput,
        promptContract: input.promptContract,
        questions: input.questions,
      });
      if (begun.kind === "ok") {
        return { ok: true, record: toRecord(begun.transaction) };
      }
      if (begun.kind === "rejected") {
        return { ok: false, code: "chatTransactionRejected", reason: begun.reason };
      }
      return { ok: false, code: "workflowStorageUnavailable", reason: storeFailureReason(begun) };
    },

    async submitAnswers(
      ref: InteractionRefV1,
      rawAnswers: unknown,
      answerIdempotencyId: string
    ): Promise<SubmitAnswersResultV1> {
      const loaded = await loadValidated(ref);
      if (loaded.kind !== "ok") {
        return { ok: false, reason: loaded.reason };
      }
      const submitted = await store.submitAnswers(ref.operationId, rawAnswers, answerIdempotencyId);
      if (submitted.kind === "ok") {
        return { ok: true, duplicate: submitted.duplicate === true };
      }
      return { ok: false, reason: storeFailureReason(submitted) };
    },

    async resolveResume(
      ref: InteractionRefV1,
      resumeIdempotencyId: string
    ): Promise<ResumeResolutionV1> {
      if (!isHex128IdV1(resumeIdempotencyId)) {
        throw new ActionConversationErrorV1(
          "Resume idempotency ids are 128-bit lowercase-hex identifiers."
        );
      }
      const transaction = requireLoaded(ref, await loadValidated(ref));

      if (transaction.state === "settled") {
        // Idempotent replay (plan §3.1): the identical idempotency id maps
        // to the exactly-one recorded resolution; anything else is the
        // rejected second Resume.
        if (
          transaction.resumeIdempotencyId === resumeIdempotencyId &&
          transaction.resumeResolution !== undefined
        ) {
          return recordedResolution(transaction, transaction.resumeResolution);
        }
        throw new ActionConversationErrorV1(
          `Interaction ${ref.interactionId} already settled (${String(transaction.settlement)}); ` +
            "the Resume idempotency record rejects a second Resume."
        );
      }

      // Journal `resumeScheduled` first (plan §5.5's transition chain). A
      // crash between scheduling and settlement is recoverable: re-driving
      // with the identical idempotency id is the store's duplicate no-op and
      // proceeds to settlement with a fresh resolution.
      const scheduled = await store.scheduleResume(ref.operationId, resumeIdempotencyId);
      if (scheduled.kind !== "ok") {
        throw new ActionConversationErrorV1(storeFailureReason(scheduled));
      }

      const resolution: ResumeResolutionV1 =
        transaction.resumeSemantics === "sameOperation"
          ? {
              kind: "sameOperation",
              operationId: transaction.operationId,
              newAttemptId: allocateHex128IdV1(),
            }
          : {
              kind: "replacementOperation",
              replacementOperationId: allocateHex128IdV1(),
              resumedFromOperationId: transaction.operationId,
              sourceInteractionId: transaction.interactionId,
            };
      const storedResolution: ChatTransactionResumeResolutionV1 =
        resolution.kind === "sameOperation"
          ? { kind: "sameOperation", newAttemptId: resolution.newAttemptId }
          : {
              kind: "replacementOperation",
              replacementOperationId: resolution.replacementOperationId,
            };
      const settled = await store.settleResumed(ref.operationId, storedResolution);
      if (settled.kind !== "ok") {
        throw new ActionConversationErrorV1(storeFailureReason(settled));
      }
      return resolution;
    },

    async claimResumeInvocation(ref: InteractionRefV1): Promise<ClaimResumeInvocationResultV1> {
      const loaded = await loadValidated(ref);
      if (loaded.kind === "storageUnavailable") {
        return { ok: false, code: "workflowStorageUnavailable", reason: loaded.reason };
      }
      if (loaded.kind !== "ok") {
        return { ok: false, code: "claimRejected", reason: loaded.reason };
      }
      const claimed = await store.claimResumeInvocation(ref.operationId);
      if (claimed.kind === "ok") {
        const alreadyClaimed = claimed.duplicate === true;
        return {
          ok: true,
          alreadyClaimed,
          ...(alreadyClaimed && claimed.transaction.resumeInvocationOutcome !== undefined
            ? { recoveredOutcome: claimed.transaction.resumeInvocationOutcome }
            : {}),
        };
      }
      if (claimed.kind === "unavailable") {
        return { ok: false, code: "workflowStorageUnavailable", reason: storeFailureReason(claimed) };
      }
      return { ok: false, code: "claimRejected", reason: storeFailureReason(claimed) };
    },

    async recordResumeInvocationOutcome(
      ref: InteractionRefV1,
      outcome: TaskActionOutcomeV1
    ): Promise<RecordResumeInvocationOutcomeResultV1> {
      const loaded = await loadValidated(ref);
      if (loaded.kind === "storageUnavailable") {
        return { ok: false, code: "workflowStorageUnavailable", reason: loaded.reason };
      }
      if (loaded.kind !== "ok") {
        return { ok: false, code: "recordRejected", reason: loaded.reason };
      }
      const recorded = await store.recordResumeInvocationOutcome(ref.operationId, outcome);
      if (recorded.kind === "ok") {
        return { ok: true };
      }
      if (recorded.kind === "unavailable") {
        return { ok: false, code: "workflowStorageUnavailable", reason: storeFailureReason(recorded) };
      }
      return { ok: false, code: "recordRejected", reason: storeFailureReason(recorded) };
    },

    cancel(ref: InteractionRefV1): Promise<void> {
      return settleTerminal(ref, () => store.cancel(ref.operationId));
    },

    expire(ref: InteractionRefV1): Promise<void> {
      return settleTerminal(ref, () => store.expire(ref.operationId));
    },

    async getRecord(ref: InteractionRefV1): Promise<ActionInteractionRecordV1 | undefined> {
      const loaded = await loadValidated(ref);
      if (loaded.kind === "ok") {
        return toRecord(loaded.transaction);
      }
      if (loaded.kind === "unknown") {
        return undefined;
      }
      throw new ActionConversationErrorV1(loaded.reason);
    },

    async loadInteraction(ref: InteractionRefV1): Promise<LoadInteractionResultV1> {
      const loaded = await loadValidated(ref);
      if (loaded.kind === "ok") {
        return { kind: "ok", record: toRecord(loaded.transaction) };
      }
      return loaded;
    },
  };
}
