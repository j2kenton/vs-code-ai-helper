/**
 * Engine chat-interaction transaction store (plan Part 4a).
 *
 * Semantic port of the extension's durable store
 * (`src/services/chatInteractionTransactionStoreV1.ts`) for a plain Node
 * service context: exactly one record per question-returning operation, every
 * state change journaled as a transition receipt and self-verified through
 * the strict @ensemble/core decoder BEFORE it becomes visible, idempotent
 * answer submission and Resume scheduling (identical id + identical
 * canonical content is a no-op; anything else rejects), settle-exactly-once,
 * and an atomic invocation-once claim with a recoverable terminal outcome
 * ("recover the claimed terminal result", AC-RUNNER-03).
 *
 * The interface is storage-agnostic: the store logic is written once over a
 * small storage backend (`EngineTransactionStoreBackendV1`) holding
 * canonical-encoded record bytes plus the invocation-once claim registry.
 * This module ships the in-memory backend (tests, single-process dev); the
 * Part 5 control plane supplies a durable backend over its persisted store,
 * so question-paused interactions survive a control-plane restart. Records
 * are held as canonical-encoded bytes and strictly re-decoded on every read,
 * so every backend exercises the identical encode/decode path — a record
 * that would not survive persistence cannot exist in memory either.
 */
import {
  ActionCorrelationV1,
  allocateHex128IdV1,
  isHex128IdV1,
  ResumeSemanticsV1,
} from "../../ensemble-core/src/actionCorrelationV1";
import {
  ChatInteractionSettlementV1,
  ChatInteractionTransactionStateV1,
  ChatInteractionTransactionV1,
  ChatTransactionPromptContractV1,
  ChatTransactionResumeResolutionV1,
  ChatTransactionTransitionReceiptV1,
  computeChatTransactionAnswersSha256V1,
  computeChatTransactionInputSha256V1,
  computeChatTransactionQuestionSetSha256V1,
  decodeChatInteractionTransactionV1,
  encodeChatInteractionTransactionV1,
} from "../../ensemble-core/src/chatInteractionTransactionV1";
import {
  outcomeCorrelationV1,
  TaskActionOutcomeV1,
} from "../../ensemble-core/src/taskActionOutcomeV1";
import {
  canonicalJsonByteLengthV1,
  canonicalJsonTextV1,
  CanonicalJsonErrorV1,
  decodeStructuredAnswersArrayV1,
  MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1,
  MAX_QUESTION_SET_CANONICAL_BYTES_V1,
  MAX_QUESTIONS_V1,
  StructuredAnswerV1,
  StructuredQuestionV1,
  validateStructuredAnswersV1,
} from "../../ensemble-core/src/structuredQuestionV1";
import { TaskStage } from "../../ensemble-core/src/taskProgressV1";

export type EngineTransactionStoreResultV1 =
  | {
      readonly kind: "ok";
      readonly transaction: ChatInteractionTransactionV1;
      /** True when an idempotent re-submission / re-schedule was a no-op. */
      readonly duplicate?: boolean;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "rejected"; readonly reason: string }
  | {
      /** Undecodable or corrupt persisted record: read-only, non-resumable. */
      readonly kind: "recoveryRequired";
      readonly reason: string;
    }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  | { readonly kind: "unavailable"; readonly code: "workflowStorageUnavailable" };

export interface BeginEngineTransactionInputV1 {
  readonly correlation: ActionCorrelationV1;
  readonly interactionId: string;
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly validatedInput: unknown;
  readonly promptContract: ChatTransactionPromptContractV1;
  readonly questions: readonly StructuredQuestionV1[];
}

export interface BeginEngineInvocationInputV1 {
  readonly correlation: ActionCorrelationV1;
  readonly interactionId: string;
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  readonly validatedInput: unknown;
  readonly promptContract: ChatTransactionPromptContractV1;
}

/**
 * The store surface the engine's conversation orchestrator consumes —
 * operation-for-operation the extension store's contract, minus the
 * filesystem-only retention sweep (a durable Part 5 implementation adds its
 * own retention policy).
 */
export interface EngineChatTransactionStoreV1 {
  /**
   * Create the operation's single record already carrying its posted
   * questions; transitions an existing `invocationPending` admission in
   * place (its identity wins), otherwise creates a fresh record spanning
   * both receipts.
   */
  begin(input: BeginEngineTransactionInputV1): Promise<EngineTransactionStoreResultV1>;
  /** Admit the record in `invocationPending` BEFORE the provider ever runs. */
  beginInvocation(input: BeginEngineInvocationInputV1): Promise<EngineTransactionStoreResultV1>;
  /**
   * Discard an admitted `invocationPending` record whose invocation resolved
   * to anything other than questions. Missing is a no-op; a record that
   * progressed past `invocationPending` rejects.
   */
  discardPendingInvocation(operationId: string): Promise<EngineTransactionStoreResultV1>;
  /** Load and strictly decode one operation's record. */
  load(operationId: string): Promise<EngineTransactionStoreResultV1>;
  /** Save a (possibly partial) answers draft; repeat saves rewrite in place. */
  saveAnswersDraft(operationId: string, rawAnswers: unknown): Promise<EngineTransactionStoreResultV1>;
  /**
   * Validate and write through submitted answers. Idempotent only for the
   * identical idempotency id and canonical answers.
   */
  submitAnswers(
    operationId: string,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<EngineTransactionStoreResultV1>;
  /**
   * Record the Resume idempotency binding: answersSubmitted →
   * resumeScheduled. Idempotent for the identical id; any other second
   * schedule is rejected.
   */
  scheduleResume(
    operationId: string,
    resumeIdempotencyId: string
  ): Promise<EngineTransactionStoreResultV1>;
  /** Settle a scheduled Resume with its resolution (kind must match semantics). */
  settleResumed(
    operationId: string,
    resolution: ChatTransactionResumeResolutionV1
  ): Promise<EngineTransactionStoreResultV1>;
  /**
   * Durably claim, at most once, the provider invocation a settled Resume
   * resolution drives. `duplicate: true` means a claim was already recorded —
   * the caller MUST NOT invoke the provider.
   */
  claimResumeInvocation(operationId: string): Promise<EngineTransactionStoreResultV1>;
  /**
   * Durably record the terminal outcome the claimed invocation produced.
   * Idempotent: only the FIRST recorded outcome is ever authoritative.
   */
  recordResumeInvocationOutcome(
    operationId: string,
    outcome: TaskActionOutcomeV1
  ): Promise<EngineTransactionStoreResultV1>;
  /** Settle without provider invocation from any unsettled state. */
  cancel(operationId: string): Promise<EngineTransactionStoreResultV1>;
  /** Expiry settlement: the interaction downgrades to read-only. */
  expire(operationId: string): Promise<EngineTransactionStoreResultV1>;
  /**
   * Every not-yet-settled transaction bound to `chatDocumentId`
   * (`invocationPending` admissions are never renderable and are excluded).
   */
  listUnresolvedForChatDocument(
    chatDocumentId: string
  ): Promise<readonly ChatInteractionTransactionV1[]>;
}

function rejected(reason: string): EngineTransactionStoreResultV1 {
  return { kind: "rejected", reason };
}

const decoder = new TextDecoder();

/**
 * The storage seam the transaction-store logic runs over: canonical-encoded
 * record bytes per operation plus the invocation-once claim registry. Every
 * operation is synchronous and each mutation must be durable before it
 * returns (the in-memory backend is trivially so; a durable backend persists
 * before returning). `claim` is the atomic check-and-set standing in for the
 * extension's exclusive-create marker file / a database unique constraint —
 * it returns false when a claim already exists, and a backend must make the
 * check and the write one atomic step.
 */
export interface EngineTransactionStoreBackendV1 {
  readRecordBytes(operationId: string): Uint8Array | undefined;
  writeRecordBytes(operationId: string, bytes: Uint8Array): void;
  deleteRecord(operationId: string): void;
  listOperationIds(): readonly string[];
  /** Atomically record the invocation-once claim; false when already claimed. */
  claim(operationId: string, claimedAt: string): boolean;
  hasClaim(operationId: string): boolean;
}

/** The in-memory backend: Maps, atomic by construction in one JS runtime. */
export function createInMemoryEngineTransactionBackendV1(): EngineTransactionStoreBackendV1 {
  const records = new Map<string, Uint8Array>();
  const claims = new Map<string, string>();
  return {
    readRecordBytes: (operationId): Uint8Array | undefined => records.get(operationId),
    writeRecordBytes(operationId, bytes): void {
      records.set(operationId, bytes);
    },
    deleteRecord(operationId): void {
      records.delete(operationId);
    },
    listOperationIds: (): readonly string[] => [...records.keys()],
    claim(operationId, claimedAt): boolean {
      if (claims.has(operationId)) {
        return false;
      }
      claims.set(operationId, claimedAt);
      return true;
    },
    hasClaim: (operationId): boolean => claims.has(operationId),
  };
}

/**
 * In-memory reference store (tests, single-process dev): the shared logic
 * over the in-memory backend.
 */
export function createInMemoryEngineTransactionStoreV1(options?: {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}): EngineChatTransactionStoreV1 {
  return createEngineTransactionStoreV1({
    backend: createInMemoryEngineTransactionBackendV1(),
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });
}

/**
 * The transaction-store logic over an injected backend. Mutations are
 * serialized per operation (the same cooperative queue the extension store
 * keeps), and the invocation-once claim delegates to the backend's atomic
 * check-and-set.
 */
export function createEngineTransactionStoreV1(options: {
  readonly backend: EngineTransactionStoreBackendV1;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}): EngineChatTransactionStoreV1 {
  const now = options.now ?? ((): Date => new Date());
  const backend = options.backend;
  const mutationQueues = new Map<string, Promise<unknown>>();

  function serialized(
    operationId: string,
    work: () => Promise<EngineTransactionStoreResultV1>
  ): Promise<EngineTransactionStoreResultV1> {
    const tail = mutationQueues.get(operationId) ?? Promise.resolve();
    const run = tail.then(work, work);
    mutationQueues.set(
      operationId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  function readRecord(operationId: string): EngineTransactionStoreResultV1 {
    if (!isHex128IdV1(operationId)) {
      return rejected("operationId must be a 128-bit lowercase-hex identity");
    }
    const bytes = backend.readRecordBytes(operationId);
    if (bytes === undefined) {
      return { kind: "missing" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
    } catch {
      return { kind: "recoveryRequired", reason: "transaction record is not valid JSON" };
    }
    const decoded = decodeChatInteractionTransactionV1(parsed);
    if (!decoded.ok) {
      return { kind: "recoveryRequired", reason: decoded.reason };
    }
    if (decoded.transaction.operationId !== operationId) {
      return {
        kind: "recoveryRequired",
        reason: "transaction record does not match its storage identity",
      };
    }
    return { kind: "ok", transaction: decoded.transaction };
  }

  /** Self-check through the strict decoder, then store canonical bytes. */
  function writeRecord(
    operationId: string,
    next: ChatInteractionTransactionV1
  ): EngineTransactionStoreResultV1 {
    const encoded = encodeChatInteractionTransactionV1(next);
    const selfCheck = decodeChatInteractionTransactionV1(JSON.parse(decoder.decode(encoded)));
    if (!selfCheck.ok) {
      return rejected(`transaction record would not decode: ${selfCheck.reason}`);
    }
    backend.writeRecordBytes(operationId, encodeChatInteractionTransactionV1(selfCheck.transaction));
    return { kind: "ok", transaction: selfCheck.transaction };
  }

  function appendReceipt(
    transaction: ChatInteractionTransactionV1,
    to: ChatInteractionTransactionStateV1
  ): readonly ChatTransactionTransitionReceiptV1[] {
    return [
      ...transaction.transitions,
      { receiptId: allocateHex128IdV1(), from: transaction.state, to, at: now().toISOString() },
    ];
  }

  function settleFrom(
    transaction: ChatInteractionTransactionV1,
    settlement: ChatInteractionSettlementV1
  ): ChatInteractionTransactionV1 | EngineTransactionStoreResultV1 {
    if (transaction.state === "settled") {
      return rejected(
        `transaction already settled (${String(transaction.settlement)}); a record settles exactly once`
      );
    }
    return {
      ...transaction,
      state: "settled",
      settlement,
      transitions: appendReceipt(transaction, "settled"),
    };
  }

  function loadForMutation(
    operationId: string
  ):
    | { readonly ok: true; readonly transaction: ChatInteractionTransactionV1 }
    | { readonly ok: false; readonly result: EngineTransactionStoreResultV1 } {
    const loaded = readRecord(operationId);
    if (loaded.kind !== "ok") {
      return { ok: false, result: loaded };
    }
    return { ok: true, transaction: loaded.transaction };
  }

  function settleTerminal(
    operationId: string,
    settlement: ChatInteractionSettlementV1
  ): Promise<EngineTransactionStoreResultV1> {
    return serialized(operationId, async () => {
      const loaded = loadForMutation(operationId);
      if (!loaded.ok) {
        return loaded.result;
      }
      const next = settleFrom(loaded.transaction, settlement);
      if ("kind" in next) {
        return next;
      }
      return writeRecord(operationId, next);
    });
  }

  function rejectMalformedCorrelation(
    correlation: ActionCorrelationV1,
    interactionId: string
  ): EngineTransactionStoreResultV1 | undefined {
    if (
      !isHex128IdV1(correlation.operationId) ||
      !isHex128IdV1(correlation.attemptId) ||
      !isHex128IdV1(interactionId) ||
      correlation.actionKey.length === 0 ||
      correlation.taskBindingId.length === 0 ||
      correlation.chatDocumentId.length === 0
    ) {
      return rejected("a transaction requires a complete, well-formed correlation tuple");
    }
    return undefined;
  }

  function buildInputSnapshot(
    validatedInput: unknown
  ): { canonicalJson: string; sha256: string } | EngineTransactionStoreResultV1 {
    try {
      const canonicalJson = canonicalJsonTextV1(validatedInput);
      return { canonicalJson, sha256: computeChatTransactionInputSha256V1(canonicalJson) };
    } catch (error) {
      if (error instanceof CanonicalJsonErrorV1) {
        return rejected(`transaction content has no canonical JSON form: ${error.message}`);
      }
      throw error;
    }
  }

  function createRecordExclusive(
    operationId: string,
    candidate: ChatInteractionTransactionV1
  ): EngineTransactionStoreResultV1 {
    if (backend.readRecordBytes(operationId) !== undefined) {
      return rejected(
        "a transaction already exists for this operation (exactly one per question-returning operation)"
      );
    }
    return writeRecord(operationId, candidate);
  }

  return {
    begin(input: BeginEngineTransactionInputV1): Promise<EngineTransactionStoreResultV1> {
      const { correlation } = input;
      return serialized(correlation.operationId, async () => {
        const malformed = rejectMalformedCorrelation(correlation, input.interactionId);
        if (malformed) {
          return malformed;
        }
        if (
          !Array.isArray(input.questions) ||
          input.questions.length === 0 ||
          input.questions.length > MAX_QUESTIONS_V1
        ) {
          return rejected("a transaction requires 1-16 structured questions");
        }
        let questionBytes: number;
        try {
          questionBytes = canonicalJsonByteLengthV1(input.questions);
        } catch (error) {
          if (error instanceof CanonicalJsonErrorV1) {
            return rejected(`transaction content has no canonical JSON form: ${error.message}`);
          }
          throw error;
        }
        if (questionBytes > MAX_QUESTION_SET_CANONICAL_BYTES_V1) {
          return rejected(
            `question set exceeds the ${MAX_QUESTION_SET_CANONICAL_BYTES_V1}-byte canonical limit`
          );
        }

        // Pre-invocation admission: transition an existing pending record in
        // place, reusing its identity (this call's corresponding fields are
        // ignored — the admitted record is authoritative).
        const existing = loadForMutation(correlation.operationId);
        if (existing.ok) {
          if (existing.transaction.state !== "invocationPending") {
            return rejected(
              "a transaction already exists for this operation (exactly one per question-returning operation)"
            );
          }
          const next: ChatInteractionTransactionV1 = {
            ...existing.transaction,
            questions: input.questions,
            questionSetSha256: computeChatTransactionQuestionSetSha256V1(input.questions),
            state: "questionsPosted",
            transitions: appendReceipt(existing.transaction, "questionsPosted"),
          };
          return writeRecord(correlation.operationId, next);
        }
        if (existing.result.kind !== "missing") {
          return existing.result;
        }

        const inputSnapshot = buildInputSnapshot(input.validatedInput);
        if (!("canonicalJson" in inputSnapshot)) {
          return inputSnapshot;
        }
        const pendingReceipt: ChatTransactionTransitionReceiptV1 = {
          receiptId: allocateHex128IdV1(),
          from: null,
          to: "invocationPending",
          at: now().toISOString(),
        };
        const candidate: ChatInteractionTransactionV1 = {
          schemaVersion: 1,
          actionKey: correlation.actionKey,
          operationId: correlation.operationId,
          sourceAttemptId: correlation.attemptId,
          taskBindingId: correlation.taskBindingId,
          chatDocumentId: correlation.chatDocumentId,
          interactionId: input.interactionId,
          stage: input.stage,
          resumeSemantics: input.resumeSemantics,
          inputSnapshot,
          promptContract: input.promptContract,
          questions: input.questions,
          questionSetSha256: computeChatTransactionQuestionSetSha256V1(input.questions),
          state: "questionsPosted",
          transitions: [
            pendingReceipt,
            {
              receiptId: allocateHex128IdV1(),
              from: "invocationPending",
              to: "questionsPosted",
              at: now().toISOString(),
            },
          ],
        };
        return createRecordExclusive(correlation.operationId, candidate);
      });
    },

    beginInvocation(input: BeginEngineInvocationInputV1): Promise<EngineTransactionStoreResultV1> {
      const { correlation } = input;
      return serialized(correlation.operationId, async () => {
        const malformed = rejectMalformedCorrelation(correlation, input.interactionId);
        if (malformed) {
          return malformed;
        }
        const inputSnapshot = buildInputSnapshot(input.validatedInput);
        if (!("canonicalJson" in inputSnapshot)) {
          return inputSnapshot;
        }
        const candidate: ChatInteractionTransactionV1 = {
          schemaVersion: 1,
          actionKey: correlation.actionKey,
          operationId: correlation.operationId,
          sourceAttemptId: correlation.attemptId,
          taskBindingId: correlation.taskBindingId,
          chatDocumentId: correlation.chatDocumentId,
          interactionId: input.interactionId,
          stage: input.stage,
          resumeSemantics: input.resumeSemantics,
          inputSnapshot,
          promptContract: input.promptContract,
          state: "invocationPending",
          transitions: [
            {
              receiptId: allocateHex128IdV1(),
              from: null,
              to: "invocationPending",
              at: now().toISOString(),
            },
          ],
        };
        return createRecordExclusive(correlation.operationId, candidate);
      });
    },

    discardPendingInvocation(operationId: string): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          // "missing" (nothing to discard) passes through; callers treat it
          // as a successful no-op.
          return loaded.result;
        }
        if (loaded.transaction.state !== "invocationPending") {
          return rejected(
            `cannot discard: the record has already progressed to ${loaded.transaction.state}`
          );
        }
        backend.deleteRecord(operationId);
        return { kind: "ok", transaction: loaded.transaction };
      });
    },

    async load(operationId: string): Promise<EngineTransactionStoreResultV1> {
      return readRecord(operationId);
    },

    saveAnswersDraft(operationId: string, rawAnswers: unknown): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (transaction.state !== "questionsPosted" && transaction.state !== "answersDraft") {
          return rejected(`a draft cannot be saved in state ${transaction.state}`);
        }
        const decoded = decodeStructuredAnswersArrayV1(rawAnswers);
        if (!decoded.ok) {
          return rejected(decoded.reason);
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          answers: decoded.answers,
          state: "answersDraft",
          // A draft RE-save is not a state change and does not journal
          // (bounded receipts).
          transitions:
            transaction.state === "answersDraft"
              ? transaction.transitions
              : appendReceipt(transaction, "answersDraft"),
        };
        return writeRecord(operationId, next);
      });
    },

    submitAnswers(
      operationId: string,
      rawAnswers: unknown,
      answerIdempotencyId: string
    ): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (!isHex128IdV1(answerIdempotencyId)) {
          return rejected("answer idempotency ids are 128-bit lowercase-hex identifiers");
        }
        let answerBytes: number;
        try {
          answerBytes = canonicalJsonByteLengthV1(rawAnswers);
        } catch (error) {
          if (error instanceof CanonicalJsonErrorV1) {
            return rejected(`answer submission is not JSON data: ${error.message}`);
          }
          throw error;
        }
        if (answerBytes > MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1) {
          return rejected(
            `answer submission exceeds the ${MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1}-byte limit`
          );
        }
        const decoded = decodeStructuredAnswersArrayV1(rawAnswers);
        if (!decoded.ok) {
          return rejected(decoded.reason);
        }
        const answers: readonly StructuredAnswerV1[] = decoded.answers;
        const digest = computeChatTransactionAnswersSha256V1(answers);
        if (transaction.answerIdempotencyId !== undefined) {
          // Already submitted: a byte-identical re-submission under the same
          // idempotency id is a no-op; anything else is rejected.
          if (
            transaction.answerIdempotencyId === answerIdempotencyId &&
            transaction.answersSha256 === digest
          ) {
            return { kind: "ok", transaction, duplicate: true };
          }
          return rejected(
            "answers were already submitted for this interaction with a different idempotency record"
          );
        }
        if (transaction.state !== "questionsPosted" && transaction.state !== "answersDraft") {
          return rejected(`answers cannot be submitted in state ${transaction.state}`);
        }
        if (transaction.questions === undefined) {
          return rejected("transaction has no posted question set to answer");
        }
        const validation = validateStructuredAnswersV1(transaction.questions, answers);
        if (!validation.ok) {
          return rejected(validation.reason ?? "invalid answers");
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          answers,
          answerIdempotencyId,
          answersSha256: digest,
          state: "answersSubmitted",
          transitions: appendReceipt(transaction, "answersSubmitted"),
        };
        return writeRecord(operationId, next);
      });
    },

    scheduleResume(
      operationId: string,
      resumeIdempotencyId: string
    ): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (!isHex128IdV1(resumeIdempotencyId)) {
          return rejected("resume idempotency ids are 128-bit lowercase-hex identifiers");
        }
        if (transaction.resumeIdempotencyId !== undefined) {
          if (
            transaction.resumeIdempotencyId === resumeIdempotencyId &&
            transaction.state === "resumeScheduled"
          ) {
            return { kind: "ok", transaction, duplicate: true };
          }
          // Includes every settled record: the recorded idempotency binding
          // rejects a second Resume of the same interaction.
          return rejected("a Resume was already recorded for this interaction");
        }
        if (transaction.state !== "answersSubmitted") {
          return rejected(`Resume requires submitted answers; state is ${transaction.state}`);
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          resumeIdempotencyId,
          state: "resumeScheduled",
          transitions: appendReceipt(transaction, "resumeScheduled"),
        };
        return writeRecord(operationId, next);
      });
    },

    settleResumed(
      operationId: string,
      resolution: ChatTransactionResumeResolutionV1
    ): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (transaction.state === "settled") {
          return rejected(
            `transaction already settled (${String(transaction.settlement)}); a record settles exactly once`
          );
        }
        if (transaction.state !== "resumeScheduled") {
          return rejected(`Resume settlement requires a scheduled Resume; state is ${transaction.state}`);
        }
        if (resolution.kind !== transaction.resumeSemantics) {
          return rejected(
            `the resolution kind must match the row's declared semantics (${transaction.resumeSemantics})`
          );
        }
        let settlement: ChatInteractionSettlementV1;
        if (resolution.kind === "sameOperation") {
          if (!isHex128IdV1(resolution.newAttemptId)) {
            return rejected("a sameOperation resolution requires a valid new attempt id");
          }
          if (resolution.newAttemptId === transaction.sourceAttemptId) {
            return rejected("a Resume attempt must be globally distinct from the source attempt");
          }
          settlement = "resumed";
        } else {
          if (!isHex128IdV1(resolution.replacementOperationId)) {
            return rejected("a replacementOperation resolution requires a valid replacement operation id");
          }
          if (resolution.replacementOperationId === transaction.operationId) {
            return rejected("a replacement operation must be distinct from the source operation");
          }
          settlement = "supersededByReplacementOperation";
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          state: "settled",
          settlement,
          resumeResolution: resolution,
          transitions: appendReceipt(transaction, "settled"),
        };
        return writeRecord(operationId, next);
      });
    },

    claimResumeInvocation(operationId: string): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (transaction.state !== "settled" || transaction.resumeResolution === undefined) {
          return rejected(
            "a resume invocation claim requires a record settled with a Resume resolution"
          );
        }
        // The backend's atomic check-and-set — the stand-in for the
        // extension's exclusive-create marker and a database unique
        // constraint.
        if (transaction.resumeInvocationClaimedAt !== undefined || backend.hasClaim(operationId)) {
          return { kind: "ok", transaction, duplicate: true };
        }
        const claimedAt = now().toISOString();
        if (!backend.claim(operationId, claimedAt)) {
          return { kind: "ok", transaction, duplicate: true };
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          resumeInvocationClaimedAt: claimedAt,
        };
        const written = writeRecord(operationId, next);
        // The claim itself stands even if the mirror write is rejected: the
        // claims entry is authoritative, exactly like the marker file.
        return written.kind === "ok" ? written : { kind: "ok", transaction };
      });
    },

    recordResumeInvocationOutcome(
      operationId: string,
      outcome: TaskActionOutcomeV1
    ): Promise<EngineTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (transaction.state !== "settled" || transaction.resumeResolution === undefined) {
          return rejected(
            "a resume invocation outcome requires a record settled with a Resume resolution"
          );
        }
        if (transaction.resumeInvocationClaimedAt === undefined) {
          return rejected("a resume invocation outcome requires the invocation to be claimed first");
        }
        if (transaction.resumeInvocationOutcome !== undefined) {
          // Only the FIRST recorded outcome is ever authoritative: a
          // concurrent claim loser recovers exactly it.
          return { kind: "ok", transaction, duplicate: true };
        }
        if (outcomeCorrelationV1(outcome) === undefined) {
          return rejected("a resume invocation outcome must carry a correlation tuple");
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          resumeInvocationOutcome: outcome,
        };
        return writeRecord(operationId, next);
      });
    },

    cancel(operationId: string): Promise<EngineTransactionStoreResultV1> {
      return settleTerminal(operationId, "cancelled");
    },

    expire(operationId: string): Promise<EngineTransactionStoreResultV1> {
      return settleTerminal(operationId, "expired");
    },

    async listUnresolvedForChatDocument(
      chatDocumentId: string
    ): Promise<readonly ChatInteractionTransactionV1[]> {
      const matches: ChatInteractionTransactionV1[] = [];
      for (const operationId of backend.listOperationIds()) {
        const loaded = readRecord(operationId);
        if (loaded.kind !== "ok") {
          continue;
        }
        const { transaction } = loaded;
        if (
          transaction.chatDocumentId === chatDocumentId &&
          transaction.state !== "settled" &&
          transaction.state !== "invocationPending"
        ) {
          matches.push(transaction);
        }
      }
      return matches;
    },
  };
}
