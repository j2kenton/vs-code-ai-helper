/**
 * Engine conversation orchestrator (plan Part 4a) — the structured-question
 * interaction lifecycle on top of the durable engine transaction store.
 *
 * Semantic port of `src/actions/actionConversationOrchestratorV1.ts`: a
 * `questions` result begins exactly one persisted transaction — written
 * through BEFORE the questions outcome is surfaced, so no display state can
 * exist without its durable record; typed answers are submitted with an
 * idempotency record; explicit Resume settles the interaction exactly once
 * per the declared `ResumeSemanticsV1` (`sameOperation` retains the original
 * operationId with a fresh attemptId and settles `resumed`;
 * `replacementOperation` allocates a fresh linked operationId and settles
 * `supersededByReplacementOperation`). A second Resume — or a re-submission
 * with a different idempotency id or different answers — is rejected by the
 * persisted idempotency binding; the identical Resume idempotency id replays
 * the recorded resolution instead of resuming twice.
 *
 * INVOCATION-ONCE CLAIM — a settled resolution replays idempotently for the
 * identical Resume idempotency id (crash recovery), but the provider
 * invocation it drives must run at most once. `claimResumeInvocation`
 * durably claims that invocation exactly once: the task loop calls it
 * immediately before invoking the provider, and MUST NOT invoke when
 * `alreadyClaimed` is true. `recoveredOutcome` (present only alongside
 * `alreadyClaimed`) means the claimed invocation already ran to completion —
 * return that EXACT result instead of invoking again; `alreadyClaimed`
 * WITHOUT a recovered outcome is the genuinely ambiguous in-flight/unknown
 * case that must fail closed.
 */
import {
  ActionCorrelationV1,
  allocateHex128IdV1,
  AttemptIdV1,
  InteractionIdV1,
  isHex128IdV1,
  OperationIdV1,
  ResumeSemanticsV1,
} from "../../ensemble-core/src/actionCorrelationV1";
import {
  ChatInteractionSettlementV1,
  ChatInteractionTransactionStateV1,
  ChatInteractionTransactionV1,
  ChatTransactionInputSnapshotV1,
  ChatTransactionPromptContractV1,
  ChatTransactionResumeResolutionV1,
} from "../../ensemble-core/src/chatInteractionTransactionV1";
import {
  StructuredAnswerV1,
  StructuredQuestionV1,
} from "../../ensemble-core/src/structuredQuestionV1";
import { TaskActionOutcomeV1 } from "../../ensemble-core/src/taskActionOutcomeV1";
import { TaskStage } from "../../ensemble-core/src/taskProgressV1";
import {
  EngineChatTransactionStoreV1,
  EngineTransactionStoreResultV1,
} from "./transactionStoreV1";

export class EngineConversationErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineConversationErrorV1";
  }
}

/** The persisted interaction states, verbatim from the record contract. */
export type EngineInteractionStateV1 = ChatInteractionTransactionStateV1;

/** The terminal settlements, verbatim. */
export type EngineInteractionSettlementV1 = ChatInteractionSettlementV1;

/**
 * Durable interaction address: every field must match the persisted
 * transaction's own recorded values before any mutation — a stale or foreign
 * reference never reaches another operation's interaction, task, document,
 * or source attempt.
 */
export interface EngineInteractionRefV1 {
  readonly operationId: OperationIdV1;
  readonly interactionId: InteractionIdV1;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly sourceAttemptId: string;
}

export type EngineResumeResolutionV1 =
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

export interface EngineInteractionRecordV1 {
  readonly interactionId: InteractionIdV1;
  readonly correlation: ActionCorrelationV1;
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly inputSnapshot: ChatTransactionInputSnapshotV1;
  readonly questions?: readonly StructuredQuestionV1[];
  readonly questionSetDigest?: string;
  readonly state: EngineInteractionStateV1;
  readonly answers?: readonly StructuredAnswerV1[];
  readonly answerIdempotencyId?: string;
  readonly answerDigest?: string;
  readonly resumeIdempotencyId?: string;
  readonly settlement?: EngineInteractionSettlementV1;
  readonly resumeResolution?: EngineResumeResolutionV1;
  readonly resumeInvocationClaimedAt?: string;
  readonly resumeInvocationOutcome?: TaskActionOutcomeV1;
}

export type ClaimEngineResumeInvocationResultV1 =
  | {
      readonly ok: true;
      readonly alreadyClaimed: boolean;
      /**
       * Present only when `alreadyClaimed` is true AND the claimed
       * invocation's terminal outcome was already durably recorded: return
       * this EXACT outcome instead of invoking the provider again. Absent
       * alongside `alreadyClaimed: true` means the outcome is still unknown —
       * fail closed, do not guess.
       */
      readonly recoveredOutcome?: TaskActionOutcomeV1;
    }
  | {
      readonly ok: false;
      readonly code: "workflowStorageUnavailable" | "claimRejected";
      readonly reason: string;
    };

export type RecordEngineResumeInvocationOutcomeResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "workflowStorageUnavailable" | "recordRejected";
      readonly reason: string;
    };

export interface AdmitEngineInvocationInputV1 {
  readonly correlation: ActionCorrelationV1;
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly validatedInput: unknown;
  readonly promptContract: ChatTransactionPromptContractV1;
}

export type AdmitEngineInvocationResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "workflowStorageUnavailable" | "chatTransactionRejected";
      readonly reason: string;
    };

export interface PostEngineQuestionsInputV1 {
  readonly correlation: ActionCorrelationV1;
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly questions: readonly StructuredQuestionV1[];
  readonly validatedInput: unknown;
  readonly promptContract: ChatTransactionPromptContractV1;
}

export type PostEngineQuestionsResultV1 =
  | { readonly ok: true; readonly record: EngineInteractionRecordV1 }
  | {
      readonly ok: false;
      readonly code: "workflowStorageUnavailable" | "chatTransactionRejected";
      readonly reason: string;
    };

export type SubmitEngineAnswersResultV1 =
  | { readonly ok: true; readonly duplicate: boolean }
  | { readonly ok: false; readonly reason: string };

export type LoadEngineInteractionResultV1 =
  | { readonly kind: "ok"; readonly record: EngineInteractionRecordV1 }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "recoveryRequired"; readonly reason: string }
  | { readonly kind: "storageUnavailable"; readonly reason: string };

export interface EngineConversationOrchestratorV1 {
  /**
   * Admit a durable `invocationPending` record for this operation BEFORE its
   * provider invocation ever runs. Every question-capable invocation calls
   * this first, then either `postQuestions` (provider returned questions) or
   * `discardInvocation` (any other outcome).
   */
  admitInvocation(input: AdmitEngineInvocationInputV1): Promise<AdmitEngineInvocationResultV1>;
  /**
   * Discard an admitted `invocationPending` record whose invocation resolved
   * to anything other than questions. Best-effort; failures are swallowed.
   */
  discardInvocation(operationId: string): Promise<void>;
  /**
   * Record a `questions` result as a new unresolved interaction backed by
   * exactly one durable transaction, written through before this resolves.
   */
  postQuestions(input: PostEngineQuestionsInputV1): Promise<PostEngineQuestionsResultV1>;
  /**
   * Submit exactly one validated answer per question. Idempotent: the same
   * idempotency id with byte-identical canonical answers is a no-op; any
   * other re-submission is rejected.
   */
  submitAnswers(
    ref: EngineInteractionRefV1,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<SubmitEngineAnswersResultV1>;
  /**
   * Resolve an explicit Resume exactly once per the declared semantics,
   * journaling `resumeScheduled` before settlement. The id is caller-owned:
   * the identical `resumeIdempotencyId` replays the recorded resolution
   * after a crash; a second Resume under any other id throws.
   */
  resolveResume(
    ref: EngineInteractionRefV1,
    resumeIdempotencyId: string
  ): Promise<EngineResumeResolutionV1>;
  /**
   * Durably claim, at most once, the provider invocation the settled Resume
   * resolution drives. Call AFTER `resolveResume` and immediately BEFORE
   * invoking the provider.
   */
  claimResumeInvocation(ref: EngineInteractionRefV1): Promise<ClaimEngineResumeInvocationResultV1>;
  /**
   * Durably record the terminal outcome a claimed invocation produced —
   * what makes a later replay recover the result instead of failing closed.
   */
  recordResumeInvocationOutcome(
    ref: EngineInteractionRefV1,
    outcome: TaskActionOutcomeV1
  ): Promise<RecordEngineResumeInvocationOutcomeResultV1>;
  /** Settle without provider invocation. */
  cancel(ref: EngineInteractionRefV1): Promise<void>;
  /** Expiry settlement: unresolved interactions downgrade to read-only. */
  expire(ref: EngineInteractionRefV1): Promise<void>;
  /** Load the durable record for a reference; undefined for unknown refs. */
  getRecord(ref: EngineInteractionRefV1): Promise<EngineInteractionRecordV1 | undefined>;
  /** Load the durable record as data, never throwing. */
  loadInteraction(ref: EngineInteractionRefV1): Promise<LoadEngineInteractionResultV1>;
}

/** Reconstruct the full resolution shape from a persisted record. */
function recordedResolution(
  transaction: ChatInteractionTransactionV1,
  stored: ChatTransactionResumeResolutionV1
): EngineResumeResolutionV1 {
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

function toRecord(transaction: ChatInteractionTransactionV1): EngineInteractionRecordV1 {
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
    ...(transaction.questions !== undefined
      ? { questions: transaction.questions, questionSetDigest: transaction.questionSetSha256 }
      : {}),
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

/** Sanitized failure text for non-ok store results (codes only, never content). */
function storeFailureReason(
  result: Exclude<EngineTransactionStoreResultV1, { kind: "ok" }>
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

export function createEngineConversationOrchestratorV1(options: {
  /** The durable ledger; every interaction state change persists through it. */
  readonly transactionStore: EngineChatTransactionStoreV1;
}): EngineConversationOrchestratorV1 {
  const store = options.transactionStore;

  type LoadedInteractionV1 =
    | { readonly kind: "ok"; readonly transaction: ChatInteractionTransactionV1 }
    | { readonly kind: "unknown"; readonly reason: string }
    | { readonly kind: "recoveryRequired"; readonly reason: string }
    | { readonly kind: "storageUnavailable"; readonly reason: string };

  async function loadValidated(ref: EngineInteractionRefV1): Promise<LoadedInteractionV1> {
    const loaded = await store.load(ref.operationId);
    if (loaded.kind === "ok") {
      if (loaded.transaction.interactionId !== ref.interactionId) {
        return {
          kind: "unknown",
          reason: "the interaction reference does not match the operation's recorded interaction",
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

  function requireLoaded(
    ref: EngineInteractionRefV1,
    loaded: LoadedInteractionV1
  ): ChatInteractionTransactionV1 {
    if (loaded.kind === "ok") {
      return loaded.transaction;
    }
    if (loaded.kind === "unknown") {
      throw new EngineConversationErrorV1(
        `Unknown interaction ${JSON.stringify(ref.interactionId)}: ${loaded.reason}.`
      );
    }
    throw new EngineConversationErrorV1(loaded.reason);
  }

  async function settleTerminal(
    ref: EngineInteractionRefV1,
    settle: () => Promise<EngineTransactionStoreResultV1>
  ): Promise<void> {
    requireLoaded(ref, await loadValidated(ref));
    const settled = await settle();
    if (settled.kind !== "ok") {
      throw new EngineConversationErrorV1(storeFailureReason(settled));
    }
  }

  return {
    async admitInvocation(input: AdmitEngineInvocationInputV1): Promise<AdmitEngineInvocationResultV1> {
      const begun = await store.beginInvocation({
        correlation: input.correlation,
        interactionId: allocateHex128IdV1(),
        stage: input.stage,
        resumeSemantics: input.resumeSemantics,
        validatedInput: input.validatedInput,
        promptContract: input.promptContract,
      });
      if (begun.kind === "ok") {
        return { ok: true };
      }
      if (begun.kind === "rejected") {
        return { ok: false, code: "chatTransactionRejected", reason: begun.reason };
      }
      return { ok: false, code: "workflowStorageUnavailable", reason: storeFailureReason(begun) };
    },

    async discardInvocation(operationId: string): Promise<void> {
      try {
        await store.discardPendingInvocation(operationId);
      } catch {
        // Best-effort cleanup: a leftover pending record is harmless.
      }
    },

    async postQuestions(input: PostEngineQuestionsInputV1): Promise<PostEngineQuestionsResultV1> {
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
      ref: EngineInteractionRefV1,
      rawAnswers: unknown,
      answerIdempotencyId: string
    ): Promise<SubmitEngineAnswersResultV1> {
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
      ref: EngineInteractionRefV1,
      resumeIdempotencyId: string
    ): Promise<EngineResumeResolutionV1> {
      if (!isHex128IdV1(resumeIdempotencyId)) {
        throw new EngineConversationErrorV1(
          "Resume idempotency ids are 128-bit lowercase-hex identifiers."
        );
      }
      const transaction = requireLoaded(ref, await loadValidated(ref));

      if (transaction.state === "settled") {
        // Idempotent replay: the identical idempotency id maps to the
        // exactly-one recorded resolution; anything else is the rejected
        // second Resume.
        if (
          transaction.resumeIdempotencyId === resumeIdempotencyId &&
          transaction.resumeResolution !== undefined
        ) {
          return recordedResolution(transaction, transaction.resumeResolution);
        }
        throw new EngineConversationErrorV1(
          `Interaction ${ref.interactionId} already settled (${String(transaction.settlement)}); ` +
            "the Resume idempotency record rejects a second Resume."
        );
      }

      // Journal `resumeScheduled` first. A crash between scheduling and
      // settlement is recoverable: re-driving with the identical idempotency
      // id is the store's duplicate no-op and proceeds to settlement with a
      // fresh resolution.
      const scheduled = await store.scheduleResume(ref.operationId, resumeIdempotencyId);
      if (scheduled.kind !== "ok") {
        throw new EngineConversationErrorV1(storeFailureReason(scheduled));
      }

      const resolution: EngineResumeResolutionV1 =
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
        throw new EngineConversationErrorV1(storeFailureReason(settled));
      }
      return resolution;
    },

    async claimResumeInvocation(
      ref: EngineInteractionRefV1
    ): Promise<ClaimEngineResumeInvocationResultV1> {
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
      ref: EngineInteractionRefV1,
      outcome: TaskActionOutcomeV1
    ): Promise<RecordEngineResumeInvocationOutcomeResultV1> {
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

    cancel(ref: EngineInteractionRefV1): Promise<void> {
      return settleTerminal(ref, () => store.cancel(ref.operationId));
    },

    expire(ref: EngineInteractionRefV1): Promise<void> {
      return settleTerminal(ref, () => store.expire(ref.operationId));
    },

    async getRecord(ref: EngineInteractionRefV1): Promise<EngineInteractionRecordV1 | undefined> {
      const loaded = await loadValidated(ref);
      if (loaded.kind === "ok") {
        return toRecord(loaded.transaction);
      }
      if (loaded.kind === "unknown") {
        return undefined;
      }
      throw new EngineConversationErrorV1(loaded.reason);
    },

    async loadInteraction(ref: EngineInteractionRefV1): Promise<LoadEngineInteractionResultV1> {
      const loaded = await loadValidated(ref);
      if (loaded.kind === "ok") {
        return { kind: "ok", record: toRecord(loaded.transaction) };
      }
      return loaded;
    },
  };
}
