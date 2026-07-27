/**
 * Durable Chat interaction transaction store (plan §5.5, Chat cohort /
 * executable-order step 8).
 *
 * Persists exactly one transaction record per question-returning operation at
 * the registry-vended locator
 *
 *   workflow-runtime-v1/chat-transactions/<operation-id>/transaction-v1.json
 *
 * under a registered `privateStorage` root (plan §2.1). This store holds no
 * path authority of its own: every locator it touches — the runtime parent,
 * the family parent, each operation directory, and each record file — is
 * allocated by `WorkflowPathRegistryV1`, and every filesystem operation goes
 * through `WorkflowFileStoreV1`'s exact, nonrecursive §1.8 surface
 * (exclusive-create, revision-guarded replacement/deletion, bounded reads
 * and listings, empty-directory rmdir, nonrecursive mkdir). Record content
 * is Chat-private (plan §2.2): questions, answers, and input snapshots must
 * never surface in logs — this module's failures carry codes and at most an
 * errno, never paths or content.
 *
 * This store is the DURABLE backing for the §5.5 state machine:
 * `actionConversationOrchestratorV1` is its one intended consumer and routes
 * every interaction state change — begin, answers, Resume scheduling and
 * settlement, cancel/expire/reset — through it (the former in-memory Map
 * ledger is gone; the orchestrator's contract is the stable surface).
 *
 * Guarantees:
 *  - exactly one record per operation (`begin` is exclusive-create; a second
 *    begin rejects — AC-CHAT-TX-01);
 *  - every state change is journaled as a transition receipt and written
 *    atomically (revision-guarded same-directory replacement) BEFORE the
 *    caller may change any Chat display state (plan §5.5 write-through rule);
 *  - answer submission and Resume scheduling are idempotent exactly for the
 *    recorded idempotency id (+ canonical answer digest); anything else is
 *    rejected;
 *  - a record settles exactly once; a second settlement of any kind rejects;
 *  - `claimResumeInvocation` durably claims, at most once, the provider
 *    invocation a settled Resume resolution drives (plan §3.1 /
 *    AC-RUNNER-03): the settled resolution itself replays idempotently for
 *    the identical Resume idempotency id (crash recovery), but the
 *    invocation it drives must never run twice — a caller that finds the
 *    claim already made (`duplicate: true`) must not invoke the provider
 *    again, whether the earlier drive completed, is still in flight, or
 *    crashed mid-invocation. The claim's TRUE atomicity comes from an
 *    exclusive-create marker file (`resume-invocation-claim-v1.json`,
 *    sibling to the record), the SAME primitive `begin()` uses for
 *    AC-CHAT-TX-01 — not from `replaceFileExact`'s revision check, which
 *    only compares a previously-read revision immediately before writing
 *    and is not itself a compare-and-swap (two genuinely concurrent writers
 *    can both pass that check before either has written). The settled
 *    record's own `resumeInvocationClaimedAt` is a best-effort mirror of
 *    the marker, written once by whichever caller wins it, for
 *    observability only;
 *  - `recordResumeInvocationOutcome` durably mirrors the claimed
 *    invocation's actual terminal `TaskActionOutcomeV1` once it runs to
 *    completion (plan §3.1 / AC-RUNNER-03 "recover the claimed terminal
 *    result"). This is what turns "already claimed" from a permanent dead
 *    end into a three-way, honestly-distinguished state for a later
 *    replay: no claim at all means not-started (safe to become the
 *    invoker); a claim with no recorded outcome means in-flight or unknown
 *    (fail closed — still running elsewhere, or crashed with no result);
 *    a claim WITH a recorded outcome means terminal (recover and return it,
 *    never invoke again). Legal only once `resumeInvocationClaimedAt` is
 *    set, and idempotent — a second report never overwrites the first,
 *    since a concurrent claim loser may already be recovering it;
 *  - an undecodable/corrupt record is `recoveryRequired` — the interaction
 *    renders read-only and non-resumable (AC-CHAT-TX-03);
 *  - unsupported/unsafe roots surface the stable §1.8 `unavailable` codes;
 *  - unresolved records past expiry settle as `expired`; settled records
 *    past expiry are removed together with their resume-invocation claim
 *    marker, if any (plan §5.5 retention) — a marker left behind would
 *    otherwise wedge the operation directory's removal forever. The marker
 *    is always cleared BEFORE the transaction record itself: the record is
 *    what makes the marker discoverable (its locator is a fixed sibling of
 *    the record's own), so if this step of the sweep is interrupted between
 *    the two deletions, the still-present record lets the very next sweep
 *    find and finish clearing the marker, instead of leaving an
 *    unreclaimable marker-only directory behind (AC-CHAT-TX-01's cleanup
 *    counterpart).
 *
 * Mutations are serialized per operation within this extension host, and the
 * file store's exact revision checks back that up — the same cooperative,
 * single-window guarantee the rest of the workflow filesystem code gives
 * (plan risks: no adversarial cross-process claim). `claimResumeInvocation`
 * is deliberately built on exclusive creation rather than that cooperative
 * guarantee, because it must also hold correctly across genuinely
 * concurrent instances (e.g. two extension-host windows replaying the same
 * crashed Resume) — see above.
 */
import {
  ActionCorrelationV1,
  allocateHex128IdV1,
  isHex128IdV1,
  ResumeSemanticsV1,
} from "../types/actionCorrelationV1";
import {
  ChatInteractionSettlementV1,
  ChatInteractionTransactionStateV1,
  ChatInteractionTransactionV1,
  ChatTransactionPromptContractV1,
  ChatTransactionResumeResolutionV1,
  computeChatTransactionAnswersSha256V1,
  computeChatTransactionInputSha256V1,
  computeChatTransactionQuestionSetSha256V1,
  decodeChatInteractionTransactionV1,
  encodeChatInteractionTransactionV1,
  MAX_CHAT_TRANSACTION_FILE_BYTES_V1,
} from "../types/chatInteractionTransactionV1";
import { outcomeCorrelationV1, TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
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
} from "../types/structuredQuestionV1";
import { WorkflowUnavailableV1 } from "../types/workflowAvailabilityV1";
import { TaskStage } from "../types/taskProgress";
import {
  WorkflowFileLocatorV1,
  WorkflowFileRevisionV1,
  WorkflowFileStoreResultV1,
  WorkflowFileStoreV1,
} from "./workflowFileStoreV1";
import { WorkflowPathRegistryV1 } from "./workflowPathRegistryV1";

/**
 * Private-storage retention for transaction records, matching the 24-hour
 * policy already applied to the provider-results family (plan §3.2): past
 * this age an unresolved record settles as `expired` and a settled record is
 * removed. Overridable for tests and future product tuning.
 */
export const CHAT_TRANSACTION_EXPIRY_MS_V1 = 24 * 60 * 60 * 1000;

/**
 * Retention-sweep listing ceiling. Far beyond any plausible number of
 * unexpired operations; the bounded listing fails closed (sweep is skipped)
 * rather than truncating if it is ever exceeded.
 */
const MAX_SWEEP_DIRECTORY_ENTRIES_V1 = 65536;

export type ChatTransactionStoreResultV1 =
  | {
      readonly kind: "ok";
      readonly transaction: ChatInteractionTransactionV1;
      /** True when an idempotent re-submission / re-schedule was a no-op. */
      readonly duplicate?: boolean;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "rejected"; readonly reason: string }
  | {
      /** Undecodable or corrupt persisted record (AC-CHAT-TX-03): read-only, non-resumable. */
      readonly kind: "recoveryRequired";
      readonly reason: string;
    }
  | { readonly kind: "storageFailure"; readonly errno?: string }
  /** Stable §1.8 availability outcome passed through from the file store. */
  | WorkflowUnavailableV1;

export interface BeginChatTransactionInputV1 {
  /** Question-time source correlation: actionKey, operationId, source attemptId, binding. */
  readonly correlation: ActionCorrelationV1;
  readonly interactionId: string;
  /** The stage these questions belong to (plan §5.1/§6.1 stage isolation) — see ChatInteractionTransactionV1's doc comment. */
  readonly stage: TaskStage;
  readonly resumeSemantics: ResumeSemanticsV1;
  /** The validated post-validation action input; canonicalized and digested here. */
  readonly validatedInput: unknown;
  readonly promptContract: ChatTransactionPromptContractV1;
  readonly questions: readonly StructuredQuestionV1[];
}

export interface ChatTransactionSweepResultV1 {
  /** Unresolved records past expiry that were settled as `expired`. */
  readonly expired: number;
  /** Settled records past expiry whose files were removed. */
  readonly removed: number;
}

export interface ChatInteractionTransactionStoreV1 {
  /** Create the operation's single durable record in `questionsPosted`. */
  begin(input: BeginChatTransactionInputV1): Promise<ChatTransactionStoreResultV1>;
  /** Load and strictly decode one operation's record. */
  load(operationId: string): Promise<ChatTransactionStoreResultV1>;
  /** Save a (possibly partial) answers draft; repeat saves rewrite in place. */
  saveAnswersDraft(operationId: string, rawAnswers: unknown): Promise<ChatTransactionStoreResultV1>;
  /**
   * Validate and write through submitted answers (plan §5.5: before any Chat
   * display change). Idempotent only for the identical idempotency id and
   * canonical answers.
   */
  submitAnswers(
    operationId: string,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<ChatTransactionStoreResultV1>;
  /**
   * Record the Resume idempotency binding (§3.1): answersSubmitted →
   * resumeScheduled. Idempotent for the identical id; any other second
   * schedule is rejected.
   */
  scheduleResume(
    operationId: string,
    resumeIdempotencyId: string
  ): Promise<ChatTransactionStoreResultV1>;
  /**
   * Settle a scheduled Resume with its resolution. The resolution's kind
   * must match the record's declared semantics: `sameOperation` settles as
   * `resumed`, `replacementOperation` as `supersededByReplacementOperation`.
   */
  settleResumed(
    operationId: string,
    resolution: ChatTransactionResumeResolutionV1
  ): Promise<ChatTransactionStoreResultV1>;
  /**
   * Durably claim, at most once, the provider invocation a settled Resume
   * resolution drives (plan §3.1 / AC-RUNNER-03). Requires a record already
   * settled with a `resumeResolution`. `duplicate: true` means a claim was
   * already recorded (by this call or an earlier one) — the caller MUST NOT
   * invoke the provider; `duplicate: false` means this call won the claim
   * and the caller may proceed to invoke exactly once.
   */
  claimResumeInvocation(operationId: string): Promise<ChatTransactionStoreResultV1>;
  /**
   * Durably record the terminal outcome the claimed invocation produced
   * (plan §3.1 / AC-RUNNER-03 "recover the claimed terminal result").
   * Requires a record already claimed via `claimResumeInvocation`.
   * Idempotent: a second report is a no-op (`duplicate: true`) regardless of
   * whether its content matches — only the FIRST recorded outcome is ever
   * authoritative, because it is what a concurrent claim loser may already
   * be about to recover.
   */
  recordResumeInvocationOutcome(
    operationId: string,
    outcome: TaskActionOutcomeV1
  ): Promise<ChatTransactionStoreResultV1>;
  /** Settle without provider invocation from any unsettled state. */
  cancel(operationId: string): Promise<ChatTransactionStoreResultV1>;
  /** Expiry settlement: the interaction downgrades to read-only. */
  expire(operationId: string): Promise<ChatTransactionStoreResultV1>;
  /** Chat Reset settlement (plan §5.1): clears the unresolved interaction. */
  settleByChatRecovery(operationId: string): Promise<ChatTransactionStoreResultV1>;
  /**
   * List every not-yet-settled transaction bound to `chatDocumentId`
   * (AC-CHAT-TX-03's "transaction without a Chat record" direction): a
   * transaction can be durably begun and then crash (or otherwise fail)
   * before its task-local Chat mirror record is ever appended, which would
   * otherwise leave it permanently undiscoverable. Callers reconcile the
   * result against their own mirror's interaction ids and render any
   * transaction with no matching mirror record as a read-only, non-resumable
   * orphan. Best-effort and bounded like `sweepExpired`: an unsupported root
   * or an over-limit listing returns an empty list rather than failing the
   * caller's read.
   */
  listUnresolvedForChatDocument(chatDocumentId: string): Promise<readonly ChatInteractionTransactionV1[]>;
  /** Apply the retention policy across the whole family. */
  sweepExpired(): Promise<ChatTransactionSweepResultV1>;
}

function rejected(reason: string): ChatTransactionStoreResultV1 {
  return { kind: "rejected", reason };
}

/** Map a file-store failure onto this store's result union. */
function storageFailure(failure: {
  readonly kind: "failed";
  readonly errno?: string;
}): ChatTransactionStoreResultV1 {
  return {
    kind: "storageFailure",
    ...(typeof failure.errno === "string" ? { errno: failure.errno } : {}),
  };
}

export function createChatInteractionTransactionStoreV1(options: {
  /** The §2.1 allocation authority; every locator this store touches is vended by it. */
  readonly registry: WorkflowPathRegistryV1;
  /** The §1.8 mutation surface; every filesystem operation goes through it. */
  readonly fileStore: WorkflowFileStoreV1;
  /** Registered `privateStorage` root id holding `workflow-runtime-v1`. */
  readonly privateRootId: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  readonly expiryMs?: number;
}): ChatInteractionTransactionStoreV1 {
  const { registry, fileStore, privateRootId } = options;
  const now = options.now ?? ((): Date => new Date());
  const expiryMs = options.expiryMs ?? CHAT_TRANSACTION_EXPIRY_MS_V1;

  /** Cooperative in-host serialization: one mutation at a time per operation. */
  const mutationQueues = new Map<string, Promise<unknown>>();

  function serialized(
    operationId: string,
    work: () => Promise<ChatTransactionStoreResultV1>
  ): Promise<ChatTransactionStoreResultV1> {
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

  interface ReadRecordResultV1 {
    readonly result: ChatTransactionStoreResultV1;
    /** Present exactly when `result.kind` is "ok" — feeds exact-revision mutation. */
    readonly revision?: WorkflowFileRevisionV1;
  }

  async function readRecord(operationId: string): Promise<ReadRecordResultV1> {
    if (!isHex128IdV1(operationId)) {
      return {
        result: rejected("operationId must be a 128-bit lowercase-hex identity (plan §3.1)"),
      };
    }
    const read = await fileStore.readFileBounded(
      registry.chatTransactionFile(privateRootId, operationId).locator,
      MAX_CHAT_TRANSACTION_FILE_BYTES_V1
    );
    if (read.kind === "unavailable") {
      return { result: read };
    }
    if (read.kind === "failed") {
      if (read.code === "targetMissing") {
        return { result: { kind: "missing" } };
      }
      if (read.code === "readLimitExceeded") {
        return {
          result: {
            kind: "recoveryRequired",
            reason: "transaction record exceeds the bounded read limit",
          },
        };
      }
      if (read.code === "notAFile") {
        return {
          result: {
            kind: "recoveryRequired",
            reason: "transaction record path is not a regular file",
          },
        };
      }
      return { result: storageFailure(read) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.value.bytes.toString("utf8"));
    } catch {
      return { result: { kind: "recoveryRequired", reason: "transaction record is not valid JSON" } };
    }
    const decoded = decodeChatInteractionTransactionV1(parsed);
    if (!decoded.ok) {
      return { result: { kind: "recoveryRequired", reason: decoded.reason } };
    }
    if (decoded.transaction.operationId !== operationId) {
      return {
        result: {
          kind: "recoveryRequired",
          reason: "transaction record does not match its directory identity",
        },
      };
    }
    return { result: { kind: "ok", transaction: decoded.transaction }, revision: read.value.revision };
  }

  /**
   * Atomic replacement of the existing record through the file store's
   * revision-guarded same-directory temp + rename (plan §1.8).
   */
  async function replaceRecord(
    operationId: string,
    next: ChatInteractionTransactionV1,
    expectedRevision: WorkflowFileRevisionV1
  ): Promise<ChatTransactionStoreResultV1> {
    const replaced = await fileStore.replaceFileExact(
      registry.chatTransactionFile(privateRootId, operationId).locator,
      encodeChatInteractionTransactionV1(next),
      expectedRevision
    );
    if (replaced.kind === "unavailable") {
      return replaced;
    }
    if (replaced.kind === "failed") {
      return storageFailure(replaced);
    }
    return { kind: "ok", transaction: next };
  }

  function appendReceipt(
    transaction: ChatInteractionTransactionV1,
    to: ChatInteractionTransactionStateV1
  ): readonly ChatInteractionTransactionV1["transitions"][number][] {
    return [
      ...transaction.transitions,
      { receiptId: allocateHex128IdV1(), from: transaction.state, to, at: now().toISOString() },
    ];
  }

  /**
   * Terminal settlement shared by cancel/expire/reset: legal from any
   * unsettled state, settles exactly once, and never invokes a provider.
   */
  function settleFrom(
    transaction: ChatInteractionTransactionV1,
    settlement: ChatInteractionSettlementV1
  ): ChatInteractionTransactionV1 | ChatTransactionStoreResultV1 {
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

  async function loadForMutation(
    operationId: string
  ): Promise<
    | {
        readonly ok: true;
        readonly transaction: ChatInteractionTransactionV1;
        readonly revision: WorkflowFileRevisionV1;
      }
    | { readonly ok: false; readonly result: ChatTransactionStoreResultV1 }
  > {
    const loaded = await readRecord(operationId);
    if (loaded.result.kind !== "ok" || loaded.revision === undefined) {
      return {
        ok: false,
        result: loaded.result.kind === "ok" ? { kind: "storageFailure" } : loaded.result,
      };
    }
    return { ok: true, transaction: loaded.result.transaction, revision: loaded.revision };
  }

  function settleTerminal(
    operationId: string,
    settlement: ChatInteractionSettlementV1
  ): Promise<ChatTransactionStoreResultV1> {
    return serialized(operationId, async () => {
      const loaded = await loadForMutation(operationId);
      if (!loaded.ok) {
        return loaded.result;
      }
      const next = settleFrom(loaded.transaction, settlement);
      if ("kind" in next) {
        return next;
      }
      return replaceRecord(operationId, next, loaded.revision);
    });
  }

  /**
   * Idempotent provisioning of one registry-vended directory: created-now
   * and already-exists both succeed; anything else is surfaced.
   */
  async function ensureDirectory(
    result: Promise<WorkflowFileStoreResultV1<void>>
  ): Promise<ChatTransactionStoreResultV1 | undefined> {
    const made = await result;
    if (made.kind === "unavailable") {
      return made;
    }
    if (made.kind === "failed" && made.code !== "targetExists") {
      return storageFailure(made);
    }
    return undefined;
  }

  /**
   * Clear the resume-invocation claim marker at `claimLocator`, if present,
   * as a distinct step BEFORE the transaction record it is a sibling of is
   * ever deleted (see `sweepExpired`'s ordering rationale). Returns `true`
   * only once the marker is confirmed absent — never having existed, or just
   * having been deleted — so the caller may safely proceed to delete the
   * transaction record next; `false` for any storage hiccup, unsupported
   * root, or unexpected (directory) shape, which must retry next round
   * rather than guess.
   */
  async function clearClaimMarkerIfPresent(claimLocator: WorkflowFileLocatorV1): Promise<boolean> {
    const claimStat = await fileStore.stat(claimLocator);
    if (claimStat.kind !== "ok") {
      return false;
    }
    if (claimStat.value.kind === "missing") {
      return true;
    }
    if (claimStat.value.kind === "directory") {
      // Never allocated as a directory; fail closed rather than guess.
      return false;
    }
    if (claimStat.value.revision === undefined) {
      return false;
    }
    const claimDeleted = await fileStore.deleteFileExact(claimLocator, claimStat.value.revision);
    return claimDeleted.kind === "ok";
  }

  return {
    begin(input: BeginChatTransactionInputV1): Promise<ChatTransactionStoreResultV1> {
      const { correlation } = input;
      return serialized(correlation.operationId, async () => {
        if (
          !isHex128IdV1(correlation.operationId) ||
          !isHex128IdV1(correlation.attemptId) ||
          !isHex128IdV1(input.interactionId) ||
          correlation.actionKey.length === 0 ||
          correlation.taskBindingId.length === 0 ||
          correlation.chatDocumentId.length === 0
        ) {
          return rejected("a transaction requires a complete, well-formed correlation tuple");
        }
        if (
          !Array.isArray(input.questions) ||
          input.questions.length === 0 ||
          input.questions.length > MAX_QUESTIONS_V1
        ) {
          return rejected("a transaction requires 1-16 structured questions");
        }
        let questionBytes: number;
        let inputCanonicalJson: string;
        try {
          questionBytes = canonicalJsonByteLengthV1(input.questions);
          inputCanonicalJson = canonicalJsonTextV1(input.validatedInput);
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
          inputSnapshot: {
            canonicalJson: inputCanonicalJson,
            sha256: computeChatTransactionInputSha256V1(inputCanonicalJson),
          },
          promptContract: input.promptContract,
          questions: input.questions,
          questionSetSha256: computeChatTransactionQuestionSetSha256V1(input.questions),
          state: "questionsPosted",
          transitions: [
            {
              receiptId: allocateHex128IdV1(),
              from: null,
              to: "questionsPosted",
              at: now().toISOString(),
            },
          ],
        };
        // Round-trip through the strict decoder so nothing undecodable is
        // ever persisted (e.g. an oversized input snapshot or a malformed
        // prompt contract) — the write path and the read path enforce the
        // identical contract.
        const selfCheck = decodeChatInteractionTransactionV1(
          JSON.parse(encodeChatInteractionTransactionV1(candidate).toString("utf8"))
        );
        if (!selfCheck.ok) {
          return rejected(`transaction record would not decode: ${selfCheck.reason}`);
        }
        // Nonrecursive provisioning of the registry-vended parents, root
        // downward (plan §1.8: no implicit mkdir -p).
        for (const allocated of [
          registry.workflowRuntimeDir(privateRootId),
          registry.chatTransactionsFamilyDir(privateRootId),
          registry.chatTransactionDir(privateRootId, correlation.operationId),
        ]) {
          const failure = await ensureDirectory(fileStore.createDirectory(allocated.locator));
          if (failure) {
            return failure;
          }
        }
        const created = await fileStore.createFileExclusive(
          registry.chatTransactionFile(privateRootId, correlation.operationId).locator,
          encodeChatInteractionTransactionV1(selfCheck.transaction)
        );
        if (created.kind === "unavailable") {
          return created;
        }
        if (created.kind === "failed") {
          if (created.code === "targetExists") {
            return rejected(
              "a transaction already exists for this operation (exactly one per question-returning operation)"
            );
          }
          return storageFailure(created);
        }
        return { kind: "ok", transaction: selfCheck.transaction };
      });
    },

    async load(operationId: string): Promise<ChatTransactionStoreResultV1> {
      return (await readRecord(operationId)).result;
    },

    saveAnswersDraft(operationId: string, rawAnswers: unknown): Promise<ChatTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = await loadForMutation(operationId);
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
          // (bounded receipts, see the type module header).
          transitions:
            transaction.state === "answersDraft"
              ? transaction.transitions
              : appendReceipt(transaction, "answersDraft"),
        };
        const selfCheck = decodeChatInteractionTransactionV1(
          JSON.parse(encodeChatInteractionTransactionV1(next).toString("utf8"))
        );
        if (!selfCheck.ok) {
          return rejected(`draft would not decode: ${selfCheck.reason}`);
        }
        return replaceRecord(operationId, selfCheck.transaction, loaded.revision);
      });
    },

    submitAnswers(
      operationId: string,
      rawAnswers: unknown,
      answerIdempotencyId: string
    ): Promise<ChatTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = await loadForMutation(operationId);
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
          // idempotency id is a no-op; anything else is rejected (§3.6).
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
        return replaceRecord(operationId, next, loaded.revision);
      });
    },

    scheduleResume(
      operationId: string,
      resumeIdempotencyId: string
    ): Promise<ChatTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = await loadForMutation(operationId);
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
          // rejects a second Resume of the same interaction (plan §3.1).
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
        return replaceRecord(operationId, next, loaded.revision);
      });
    },

    settleResumed(
      operationId: string,
      resolution: ChatTransactionResumeResolutionV1
    ): Promise<ChatTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = await loadForMutation(operationId);
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
        return replaceRecord(operationId, next, loaded.revision);
      });
    },

    claimResumeInvocation(operationId: string): Promise<ChatTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = await loadForMutation(operationId);
        if (!loaded.ok) {
          return loaded.result;
        }
        const transaction = loaded.transaction;
        if (transaction.state !== "settled" || transaction.resumeResolution === undefined) {
          return rejected(
            "a resume invocation claim requires a record settled with a Resume resolution"
          );
        }
        if (transaction.resumeInvocationClaimedAt !== undefined) {
          // Already mirrored from an earlier winning claim.
          return { kind: "ok", transaction, duplicate: true };
        }

        // The TRUE atomic gate (plan §3.1 / AC-RUNNER-03): exclusive file
        // creation is a single O_EXCL-style syscall with no check-then-act
        // window, unlike a revision-guarded replace (`replaceFileExact`
        // only compares a previously-read revision immediately before
        // writing — a real but narrower race than a true compare-and-swap,
        // and not the primitive to build an invocation-once guarantee on).
        // This is the SAME exclusive-create primitive `begin()` uses for
        // AC-CHAT-TX-01's "exactly one record per operation": at most one
        // caller — in this process or a genuinely concurrent other one —
        // can ever win it for a given operation.
        const claimedAt = now().toISOString();
        const created = await fileStore.createFileExclusive(
          registry.chatTransactionResumeInvocationClaimFile(privateRootId, operationId).locator,
          Buffer.from(JSON.stringify({ claimedAt }), "utf8")
        );
        if (created.kind === "unavailable") {
          return created;
        }
        if (created.kind === "failed") {
          if (created.code === "targetExists") {
            // Someone else already won. Their mirror write into the main
            // record (below) may not have landed yet — that does not matter
            // for correctness: the exclusive marker's existence is the
            // durable, authoritative fact, and `duplicate: true` is exactly
            // what the caller needs to know it must not invoke the
            // provider. A later load will see the mirrored timestamp once
            // the winner's write completes.
            return { kind: "ok", transaction, duplicate: true };
          }
          return storageFailure(created);
        }

        // We won the exclusive marker. Mirror the claim into the settled
        // record for observability. Nothing else ever mutates a settled
        // record (every other mutation method rejects once `state ===
        // "settled"`), and we are provably the sole winner of the marker,
        // so this single attempt cannot race — no retry loop needed. If it
        // fails anyway (e.g. an unrelated storage hiccup), the claim itself
        // still stands: the exclusive marker already exists and is
        // authoritative, so report the win using the un-mirrored record
        // rather than failing a claim that already durably succeeded.
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          resumeInvocationClaimedAt: claimedAt,
        };
        const selfCheck = decodeChatInteractionTransactionV1(
          JSON.parse(encodeChatInteractionTransactionV1(next).toString("utf8"))
        );
        if (!selfCheck.ok) {
          return { kind: "ok", transaction };
        }
        const mirrored = await replaceRecord(operationId, selfCheck.transaction, loaded.revision);
        return {
          kind: "ok",
          transaction: mirrored.kind === "ok" ? mirrored.transaction : transaction,
        };
      });
    },

    recordResumeInvocationOutcome(
      operationId: string,
      outcome: TaskActionOutcomeV1
    ): Promise<ChatTransactionStoreResultV1> {
      return serialized(operationId, async () => {
        const loaded = await loadForMutation(operationId);
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
          return rejected(
            "a resume invocation outcome requires the invocation to be claimed first"
          );
        }
        if (transaction.resumeInvocationOutcome !== undefined) {
          // Only the FIRST recorded outcome is ever authoritative: a
          // concurrent claim loser recovers exactly it, so a later report
          // (even from the rightful winner, e.g. a redundant call) must
          // never overwrite it.
          return { kind: "ok", transaction, duplicate: true };
        }
        if (outcomeCorrelationV1(outcome) === undefined) {
          // A correlation-free outcome can never be semantically bound to
          // this interaction on recovery (the transaction decoder rejects
          // such records outright), so it must not be persisted in the
          // first place.
          return rejected(
            "a resume invocation outcome must carry a correlation tuple (plan §3.1 / AC-RUNNER-03)"
          );
        }
        const next: ChatInteractionTransactionV1 = {
          ...transaction,
          resumeInvocationOutcome: outcome,
        };
        const selfCheck = decodeChatInteractionTransactionV1(
          JSON.parse(encodeChatInteractionTransactionV1(next).toString("utf8"))
        );
        if (!selfCheck.ok) {
          return rejected(`resume invocation outcome would not decode: ${selfCheck.reason}`);
        }
        return replaceRecord(operationId, selfCheck.transaction, loaded.revision);
      });
    },

    cancel(operationId: string): Promise<ChatTransactionStoreResultV1> {
      return settleTerminal(operationId, "cancelled");
    },

    expire(operationId: string): Promise<ChatTransactionStoreResultV1> {
      return settleTerminal(operationId, "expired");
    },

    async listUnresolvedForChatDocument(
      chatDocumentId: string
    ): Promise<readonly ChatInteractionTransactionV1[]> {
      const listed = await fileStore.listDirectoryBounded(
        registry.chatTransactionsFamilyDir(privateRootId).locator,
        MAX_SWEEP_DIRECTORY_ENTRIES_V1
      );
      if (listed.kind !== "ok") {
        // No family directory yet, an unsupported root, or an over-limit
        // listing: nothing to report this round (mirrors sweepExpired's
        // fail-open-to-empty stance for the same reasons).
        return [];
      }
      const matches: ChatInteractionTransactionV1[] = [];
      for (const entry of listed.value) {
        if (entry.kind !== "directory" || !isHex128IdV1(entry.name)) {
          continue;
        }
        const loaded = await readRecord(entry.name);
        if (loaded.result.kind !== "ok") {
          // Missing/corrupt/unavailable records are not this query's concern
          // (a corrupt record is its own AC-CHAT-TX-03 recovery evidence).
          continue;
        }
        const { transaction } = loaded.result;
        if (transaction.chatDocumentId === chatDocumentId && transaction.state !== "settled") {
          matches.push(transaction);
        }
      }
      return matches;
    },

    settleByChatRecovery(operationId: string): Promise<ChatTransactionStoreResultV1> {
      return settleTerminal(operationId, "resetByChatRecovery");
    },

    async sweepExpired(): Promise<ChatTransactionSweepResultV1> {
      let expired = 0;
      let removed = 0;
      const listed = await fileStore.listDirectoryBounded(
        registry.chatTransactionsFamilyDir(privateRootId).locator,
        MAX_SWEEP_DIRECTORY_ENTRIES_V1
      );
      if (listed.kind !== "ok") {
        // No family directory yet, an unsupported root, or an over-limit
        // listing: nothing is swept this round.
        return { expired: 0, removed: 0 };
      }
      const cutoff = now().getTime() - expiryMs;
      for (const entry of listed.value) {
        if (entry.kind !== "directory" || !isHex128IdV1(entry.name)) {
          continue;
        }
        const operationId = entry.name;
        const claimLocator = registry.chatTransactionResumeInvocationClaimFile(
          privateRootId,
          operationId
        ).locator;
        const loaded = await readRecord(operationId);
        if (loaded.result.kind === "missing") {
          // A crashed begin can leave an empty operation directory with no
          // record; fold it up. A crash strictly between this sweep's own
          // marker deletion (below) and its transaction-file deletion would
          // ALSO surface here as "missing" on a later round (the transaction
          // is gone, only the directory remains) — so any leftover marker is
          // cleared first, exactly as it is on the settled-removal path,
          // before the (empty-directory-only) rmdir. A concurrent begin that
          // already recreated content is untouched either way.
          const orphanClaimCleared = await clearClaimMarkerIfPresent(claimLocator);
          if (orphanClaimCleared) {
            await fileStore.deleteEmptyDirectory(
              registry.chatTransactionDir(privateRootId, operationId).locator
            );
          }
          continue;
        }
        if (loaded.result.kind !== "ok" || loaded.revision === undefined) {
          // Corrupt records are recovery evidence (AC-CHAT-TX-03), not sweep
          // targets.
          continue;
        }
        const transaction = loaded.result.transaction;
        const lastReceipt = transaction.transitions[transaction.transitions.length - 1]!;
        if (Date.parse(lastReceipt.at) > cutoff) {
          continue;
        }
        if (transaction.state !== "settled") {
          const settledResult = await settleTerminal(operationId, "expired");
          if (settledResult.kind === "ok") {
            expired++;
          }
          continue;
        }
        // The resume-invocation claim marker (if any) is a sibling file
        // (plan §3.1 / AC-RUNNER-03) that must be removed BEFORE the
        // transaction record itself: if this sweep (or the process it runs
        // in) is interrupted partway through, a transaction file that is
        // still present is exactly what makes the marker discoverable and
        // deletable again on the next round. Deleting the transaction FIRST
        // would instead risk a marker-only directory on interruption — the
        // next sweep would see "missing" (no transaction to read) and, with
        // no way to find the marker without a transaction record naming its
        // sibling locator, silently skip it forever, wedging the directory's
        // removal permanently while having already reported nothing wrong.
        if (!(await clearClaimMarkerIfPresent(claimLocator))) {
          // Storage hiccup, an unsupported root, or an unexpected marker
          // shape mid-sweep: retry this operation's removal next round
          // rather than proceed to delete the transaction record.
          continue;
        }
        // Exact-revision deletion: if the record changed since this read,
        // the delete fails and the next sweep retries.
        const deleted = await fileStore.deleteFileExact(
          registry.chatTransactionFile(privateRootId, operationId).locator,
          loaded.revision
        );
        if (deleted.kind !== "ok") {
          continue;
        }
        // Only count this operation as removed once its directory is
        // actually gone — a failed rmdir (e.g. unexpected leftover content)
        // must not be reported as a successful removal.
        const rmdir = await fileStore.deleteEmptyDirectory(
          registry.chatTransactionDir(privateRootId, operationId).locator
        );
        if (rmdir.kind === "ok") {
          removed++;
        }
      }
      return { expired, removed };
    },
  };
}
