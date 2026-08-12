/**
 * Engine round/part task loop (plan Part 4a).
 *
 * Reimplements the extension actions-layer semantics
 * (`src/actions/taskActionCoordinatorV1.ts` /
 * `actionConversationOrchestratorV1.ts` / `productionTaskActionRuntimeV1.ts`)
 * for a plain Node service context:
 *
 *  - **Round/part loop with `N/M` progress.** Each implementation round
 *    invokes the configured provider against the task's plan of record; a
 *    completed round's echoed checklist merges into the plan (ticks only,
 *    byte-preserving), and the CHECKLIST — reconciled against any
 *    self-reported `<!-- progress: N/M -->` marker — is the authority on how
 *    much of the plan remains (`checklistProgressV1.ts`). Progress is
 *    surfaced both as `agentLifecycle` notifications with an `N/M` detail
 *    and as strict `ensemble-v1` task-progress frames.
 *  - **Structured-question lifecycle.** Every question-capable invocation is
 *    pre-admitted (`admitInvocation`) BEFORE the provider runs; a
 *    `questions` result posts through the durable transaction store before
 *    anything is emitted, the task pauses, and answers/Resume flow through
 *    the conversation orchestrator's idempotency rules.
 *  - **Resume semantics.** `sameOperation` retains the operation with a
 *    fresh attempt; `replacementOperation` allocates a fresh linked
 *    operation. The resumed provider invocation runs under the
 *    invocation-once claim, and its terminal outcome is durably recorded so
 *    a crashed Resume replays the recorded result instead of re-invoking.
 *  - **Event emission per Part 3 schemas.** Every externally visible state
 *    change is emitted as a `@ensemble/contract` server event
 *    (`taskProgress`, `notification`, `structuredQuestions`,
 *    `chatTransactionState`), and every task-progress frame is strictly
 *    self-decoded before emission (`progressV1.ts`).
 *
 * Gate machinery (pause/approve/deny as a durable state machine with the
 * crash-safe external-effect protocol) is plan Part 4c and is NOT built
 * here; this loop pauses only on structured questions. Provider dispatch is
 * abstract (`EngineProviderRunnerV1`) — Part 4b supplies the real
 * model-provider implementations.
 */
import {
  ActionCorrelationV1,
  allocateHex128IdV1,
} from "../../ensemble-core/src/actionCorrelationV1";
import { ChatTransactionPromptContractV1 } from "../../ensemble-core/src/chatInteractionTransactionV1";
import { sha256HexUtf8V1 } from "../../ensemble-core/src/sha256V1";
import {
  StructuredAnswerV1,
  StructuredQuestionV1,
} from "../../ensemble-core/src/structuredQuestionV1";
import { TaskActionOutcomeV1 } from "../../ensemble-core/src/taskActionOutcomeV1";
import {
  PUBLISH_STAGE,
  STAGE_ORDER,
  TaskStage,
} from "../../ensemble-core/src/taskProgressV1";
import { PersistedTaskProgressV1 } from "../../ensemble-core/src/taskProgressDecoderV1";
import {
  ChecklistProgressV1,
  countChecklistProgressV1,
  mergeChecklistProgressV1,
  parseReviewProgressV1,
  reconcileProgressWithChecklistV1,
  ReviewProgressV1,
} from "./checklistProgressV1";
import {
  createEngineConversationOrchestratorV1,
  EngineConversationOrchestratorV1,
  EngineInteractionRefV1,
} from "./conversationOrchestratorV1";
import { EngineEventSinkV1 } from "./engineEventsV1";
import { createTaskProgressJournalV1, TaskProgressJournalV1 } from "./progressV1";
import {
  createInMemoryEngineTransactionStoreV1,
  EngineChatTransactionStoreV1,
} from "./transactionStoreV1";

/** The prompt-contract identity the engine's round invocations run under. */
export const ENGINE_ROUND_PROMPT_CONTRACT_ID_V1 = "ensemble.engine.round.v1";
export const ENGINE_ROUND_PROMPT_CONTRACT_VERSION_V1 = 1;

/** What one provider round resolves to (Part 4b implements real dispatch). */
export type EngineRoundResultV1 =
  | {
      /**
       * The round finished work: `summaryMarkdown` is the response document
       * whose echoed checklist (and optional `<!-- progress: N/M -->`
       * marker) records what was completed.
       */
      readonly kind: "completed";
      readonly summaryMarkdown: string;
    }
  | {
      /** The provider needs the user's answers before it can proceed. */
      readonly kind: "questions";
      readonly questions: readonly StructuredQuestionV1[];
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly retryable: boolean;
    };

/** One provider invocation's input, as the loop dispatches it. */
export interface EngineProviderInvocationV1 {
  readonly taskId: string;
  readonly taskFolder: string;
  readonly stage: TaskStage;
  /** 1-based round counter within the current stage. */
  readonly round: number;
  readonly correlation: ActionCorrelationV1;
  /** The current plan of record (checklist state included). */
  readonly planOfRecord: string;
  /** Present exactly on a resumed invocation: the user's validated answers. */
  readonly answers?: readonly StructuredAnswerV1[];
}

/** Abstract provider dispatch (Part 4b's surface). */
export interface EngineProviderRunnerV1 {
  invoke(input: EngineProviderInvocationV1): Promise<EngineRoundResultV1>;
}

export type RunEngineRoundResultV1 =
  | {
      readonly kind: "completed";
      /** Post-merge checklist state (the authoritative `N/M`). */
      readonly checklist: ChecklistProgressV1 | undefined;
      /** The reconciled round progress (checklist authority applied). */
      readonly progress: ReviewProgressV1 | null;
      /** True when the plan's checklist has nothing left unchecked. */
      readonly planComplete: boolean;
    }
  | {
      /** The task paused on structured questions; resume via the returned ref. */
      readonly kind: "questionsPosted";
      readonly ref: EngineInteractionRefV1;
      readonly questions: readonly StructuredQuestionV1[];
    }
  | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean };

export type ResumeEngineTaskResultV1 =
  | {
      /** The resumed invocation ran (exactly once) and produced this round result. */
      readonly kind: "resumed";
      readonly result: RunEngineRoundResultV1;
    }
  | {
      /**
       * A prior drive already claimed this invocation and its terminal
       * outcome was durably recorded: this is that EXACT recovered outcome —
       * the provider was NOT invoked again.
       */
      readonly kind: "recovered";
      readonly outcome: TaskActionOutcomeV1;
    }
  | {
      /**
       * A prior drive claimed the invocation but no terminal outcome is
       * recorded (in flight, or crashed without a result). Fail closed:
       * nothing was invoked, nothing changed.
       */
      readonly kind: "invocationOutcomeUnknown";
    }
  | { readonly kind: "failed"; readonly code: string; readonly reason: string };

export interface EngineTaskV1 {
  readonly taskId: string;
  /** The current strict task-progress document. */
  readonly progress: PersistedTaskProgressV1;
  /** The current plan of record (accumulated checklist state). */
  readonly planOfRecord: string;
  /** The current checklist count, or undefined when the plan carries none. */
  readonly checklist: ChecklistProgressV1 | undefined;
  /** Activate the task (status `creating` → `active`) and announce it. */
  start(): void;
  /** Run one provider round for the current stage. */
  runRound(): Promise<RunEngineRoundResultV1>;
  /** Submit validated answers for a posted question set (idempotent). */
  submitAnswers(
    ref: EngineInteractionRefV1,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<{ readonly ok: boolean; readonly duplicate?: boolean; readonly reason?: string }>;
  /**
   * Resolve an explicit Resume for an answered interaction and drive the
   * resumed provider invocation exactly once (caller-owned idempotency id;
   * the identical id after a crash replays the recorded outcome).
   */
  resume(
    ref: EngineInteractionRefV1,
    resumeIdempotencyId: string
  ): Promise<ResumeEngineTaskResultV1>;
  /**
   * Advance to the next stage in `STAGE_ORDER`, recording the completed
   * stage; completing `publish` completes the task.
   */
  advanceStage(): PersistedTaskProgressV1;
  /** The engine-side conversation orchestrator (exposed for chat surfaces). */
  readonly conversations: EngineConversationOrchestratorV1;
}

export interface CreateEngineTaskOptionsV1 {
  readonly taskId: string;
  readonly taskFolder: string;
  readonly displayName?: string;
  /** The plan of record: the checklist is the loop's `M` denominator. */
  readonly planOfRecord: string;
  readonly provider: EngineProviderRunnerV1;
  readonly sink: EngineEventSinkV1;
  /** Stable action key for correlation tuples. */
  readonly actionKey?: string;
  /** Defaults to a fresh in-memory store (tests / single-process dev). */
  readonly store?: EngineChatTransactionStoreV1;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  readonly initialStage?: TaskStage;
}

export function createEngineTaskV1(options: CreateEngineTaskOptionsV1): EngineTaskV1 {
  const now = options.now ?? ((): Date => new Date());
  const actionKey = options.actionKey ?? "engine.runRound.v1";
  const store = options.store ?? createInMemoryEngineTransactionStoreV1({ now });
  const conversations = createEngineConversationOrchestratorV1({ transactionStore: store });
  const sink = options.sink;
  const taskId = options.taskId;

  // Stable per-task binding identity: the engine's counterpart of the
  // extension's task-binding digest (a hash of the ownership + folder
  // binding). One chat document per task.
  const taskBindingId = sha256HexUtf8V1(
    `ensemble-engine-task-binding-v1\n${taskId}\n${options.taskFolder}`
  );
  const chatDocumentId = sha256HexUtf8V1(`ensemble-engine-chat-document-v1\n${taskId}`);

  const journal: TaskProgressJournalV1 = createTaskProgressJournalV1({
    taskFolder: options.taskFolder,
    now,
    ...(options.initialStage !== undefined ? { initialStage: options.initialStage } : {}),
  });
  if (options.displayName !== undefined) {
    journal.patch((current) => ({ ...current, displayName: options.displayName }));
  }

  let planOfRecord = options.planOfRecord;
  let roundsInStage = 0;

  function emitProgress(): void {
    sink.emit({ type: "taskProgress", taskId, progress: journal.current });
  }

  function emitLifecycle(
    phase: "started" | "progress" | "completed" | "failed",
    detail?: string
  ): void {
    sink.emit({
      type: "notification",
      at: now().toISOString(),
      notification: {
        kind: "agentLifecycle",
        taskId,
        phase,
        ...(detail !== undefined ? { detail } : {}),
      },
    });
  }

  function emitError(code: string, message: string): void {
    sink.emit({
      type: "notification",
      at: now().toISOString(),
      notification: { kind: "error", taskId, code, message },
    });
  }

  function promptContract(): ChatTransactionPromptContractV1 {
    return {
      contractId: ENGINE_ROUND_PROMPT_CONTRACT_ID_V1,
      contractVersion: ENGINE_ROUND_PROMPT_CONTRACT_VERSION_V1,
      promptInputSha256: sha256HexUtf8V1(planOfRecord),
    };
  }

  function correlationFor(operationId: string, attemptId: string): ActionCorrelationV1 {
    return { actionKey, operationId, attemptId, taskBindingId, chatDocumentId };
  }

  /**
   * Fold a completed round's summary into the plan of record and report the
   * reconciled `N/M`: the merge accumulates the echoed ticks, and the
   * checklist overrides any narrower self-reported marker.
   */
  function absorbCompletedRound(summaryMarkdown: string): Extract<
    RunEngineRoundResultV1,
    { kind: "completed" }
  > {
    const merged = mergeChecklistProgressV1(planOfRecord, summaryMarkdown);
    if (merged !== undefined) {
      planOfRecord = merged;
    }
    const checklist = countChecklistProgressV1(planOfRecord);
    const reported = parseReviewProgressV1(summaryMarkdown);
    const progress = reconcileProgressWithChecklistV1(reported, checklist);
    const planComplete = checklist !== undefined && checklist.remaining === 0;

    journal.patch((current) => ({ ...current }));
    emitProgress();
    emitLifecycle(
      "progress",
      progress !== null
        ? `${progress.complete}/${progress.total}`
        : checklist !== undefined
          ? `${checklist.checked}/${checklist.total}`
          : "round completed"
    );
    return { kind: "completed", checklist, progress, planComplete };
  }

  /**
   * Shared handling of a provider round result for a pre-admitted operation:
   * questions post through the store (pause), anything else discards the
   * pending admission.
   */
  async function settleRoundResult(
    correlation: ActionCorrelationV1,
    stage: TaskStage,
    result: EngineRoundResultV1
  ): Promise<RunEngineRoundResultV1> {
    if (result.kind === "questions") {
      const posted = await conversations.postQuestions({
        correlation,
        stage,
        resumeSemantics: "sameOperation",
        questions: result.questions,
        validatedInput: { planOfRecordSha256: sha256HexUtf8V1(planOfRecord), taskId },
        promptContract: promptContract(),
      });
      if (!posted.ok) {
        // The questions must NOT surface without their durable record.
        await conversations.discardInvocation(correlation.operationId);
        emitError(posted.code, "structured questions could not be durably recorded");
        return { kind: "failed", code: posted.code, retryable: true };
      }
      const ref: EngineInteractionRefV1 = {
        operationId: correlation.operationId,
        interactionId: posted.record.interactionId,
        taskBindingId,
        chatDocumentId,
        sourceAttemptId: correlation.attemptId,
      };
      journal.patch((current) => ({ ...current, status: "paused" }));
      emitProgress();
      sink.emit({
        type: "structuredQuestions",
        taskId,
        interactionId: posted.record.interactionId,
        questions: posted.record.questions ?? result.questions,
      });
      sink.emit({
        type: "chatTransactionState",
        taskId,
        interactionId: posted.record.interactionId,
        state: posted.record.state,
      });
      return { kind: "questionsPosted", ref, questions: posted.record.questions ?? result.questions };
    }

    await conversations.discardInvocation(correlation.operationId);
    if (result.kind === "completed") {
      return absorbCompletedRound(result.summaryMarkdown);
    }
    emitError(result.code, "provider round failed");
    emitLifecycle("failed", result.code);
    return { kind: "failed", code: result.code, retryable: result.retryable };
  }

  return {
    taskId,
    get progress(): PersistedTaskProgressV1 {
      return journal.current;
    },
    get planOfRecord(): string {
      return planOfRecord;
    },
    get checklist(): ChecklistProgressV1 | undefined {
      return countChecklistProgressV1(planOfRecord);
    },
    conversations,

    start(): void {
      journal.patch((current) => ({ ...current, status: "active" }));
      emitProgress();
      emitLifecycle("started");
    },

    async runRound(): Promise<RunEngineRoundResultV1> {
      const stage = journal.current.currentStage;
      roundsInStage += 1;
      const correlation = correlationFor(allocateHex128IdV1(), allocateHex128IdV1());

      // Pre-invocation admission: the durable `invocationPending` record
      // exists BEFORE the provider ever runs, so a questions result can
      // never surface without a reconstructible transaction behind it.
      const admitted = await conversations.admitInvocation({
        correlation,
        stage,
        resumeSemantics: "sameOperation",
        validatedInput: { planOfRecordSha256: sha256HexUtf8V1(planOfRecord), taskId },
        promptContract: promptContract(),
      });
      if (!admitted.ok) {
        emitError(admitted.code, "round invocation could not be admitted");
        return { kind: "failed", code: admitted.code, retryable: true };
      }

      let result: EngineRoundResultV1;
      try {
        result = await options.provider.invoke({
          taskId,
          taskFolder: options.taskFolder,
          stage,
          round: roundsInStage,
          correlation,
          planOfRecord,
        });
      } catch {
        await conversations.discardInvocation(correlation.operationId);
        emitError("providerInvocationFailed", "provider round threw");
        return { kind: "failed", code: "providerInvocationFailed", retryable: true };
      }
      return settleRoundResult(correlation, stage, result);
    },

    async submitAnswers(
      ref: EngineInteractionRefV1,
      rawAnswers: unknown,
      answerIdempotencyId: string
    ): Promise<{ readonly ok: boolean; readonly duplicate?: boolean; readonly reason?: string }> {
      const submitted = await conversations.submitAnswers(ref, rawAnswers, answerIdempotencyId);
      if (!submitted.ok) {
        return { ok: false, reason: submitted.reason };
      }
      if (!submitted.duplicate) {
        sink.emit({
          type: "chatTransactionState",
          taskId,
          interactionId: ref.interactionId,
          state: "answersSubmitted",
        });
      }
      return { ok: true, duplicate: submitted.duplicate };
    },

    async resume(
      ref: EngineInteractionRefV1,
      resumeIdempotencyId: string
    ): Promise<ResumeEngineTaskResultV1> {
      const record = await conversations.getRecord(ref);
      if (record === undefined) {
        return { kind: "failed", code: "unknownInteraction", reason: "no such interaction" };
      }

      const wasAlreadySettled = record.state === "settled";
      let resolution;
      try {
        resolution = await conversations.resolveResume(ref, resumeIdempotencyId);
      } catch (error) {
        return {
          kind: "failed",
          code: "resumeRejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (!wasAlreadySettled) {
        // An idempotent replay of an already-settled Resume is not a state
        // change and must not re-emit one.
        sink.emit({
          type: "chatTransactionState",
          taskId,
          interactionId: ref.interactionId,
          state: "settled",
        });
      }

      // Invocation-once claim, immediately before the provider runs.
      const claim = await conversations.claimResumeInvocation(ref);
      if (!claim.ok) {
        return { kind: "failed", code: claim.code, reason: claim.reason };
      }
      if (claim.alreadyClaimed) {
        if (claim.recoveredOutcome !== undefined) {
          return { kind: "recovered", outcome: claim.recoveredOutcome };
        }
        // In flight or crashed with no result: fail closed, never re-invoke.
        return { kind: "invocationOutcomeUnknown" };
      }

      journal.patch((current) => ({ ...current, status: "active" }));
      emitProgress();

      // The resumed invocation's correlation names the operation the
      // resolution drives (source operation for sameOperation, replacement
      // operation for replacementOperation) — the transaction decoder binds
      // the recorded outcome to exactly that operation.
      const resumedCorrelation: ActionCorrelationV1 =
        resolution.kind === "sameOperation"
          ? correlationFor(resolution.operationId, resolution.newAttemptId)
          : correlationFor(resolution.replacementOperationId, allocateHex128IdV1());

      const stage = record.stage;
      let result: EngineRoundResultV1;
      try {
        result = await options.provider.invoke({
          taskId,
          taskFolder: options.taskFolder,
          stage,
          round: roundsInStage,
          correlation: resumedCorrelation,
          planOfRecord,
          ...(record.answers !== undefined ? { answers: record.answers } : {}),
        });
      } catch {
        emitError("providerInvocationFailed", "resumed provider invocation threw");
        return {
          kind: "failed",
          code: "providerInvocationFailed",
          reason: "resumed provider invocation threw",
        };
      }

      // Durably mirror the terminal outcome before surfacing it, so a later
      // replay of the identical Resume recovers this exact result.
      let outcome: TaskActionOutcomeV1;
      let roundResult: RunEngineRoundResultV1;
      if (result.kind === "questions") {
        // A resumed invocation asking MORE questions posts a fresh linked
        // interaction under its own operation (exactly one transaction per
        // question-returning operation): for `sameOperation` the source
        // operation's settled record cannot host a second question set, so
        // the follow-up set gets a fresh operation while the recorded
        // outcome still binds to the operation the resolution drives.
        const followUpCorrelation: ActionCorrelationV1 =
          resolution.kind === "replacementOperation"
            ? resumedCorrelation
            : correlationFor(allocateHex128IdV1(), resumedCorrelation.attemptId);
        const posted = await conversations.postQuestions({
          correlation: followUpCorrelation,
          stage,
          resumeSemantics: "sameOperation",
          questions: result.questions,
          validatedInput: { planOfRecordSha256: sha256HexUtf8V1(planOfRecord), taskId },
          promptContract: promptContract(),
        });
        if (!posted.ok) {
          emitError(posted.code, "follow-up questions could not be durably recorded");
          return { kind: "failed", code: posted.code, reason: posted.reason };
        }
        outcome = {
          kind: "questions",
          correlation: resumedCorrelation,
          interactionId: posted.record.interactionId,
        };
        const followUpRef: EngineInteractionRefV1 = {
          operationId: followUpCorrelation.operationId,
          interactionId: posted.record.interactionId,
          taskBindingId,
          chatDocumentId,
          sourceAttemptId: followUpCorrelation.attemptId,
        };
        journal.patch((current) => ({ ...current, status: "paused" }));
        emitProgress();
        sink.emit({
          type: "structuredQuestions",
          taskId,
          interactionId: posted.record.interactionId,
          questions: posted.record.questions ?? result.questions,
        });
        sink.emit({
          type: "chatTransactionState",
          taskId,
          interactionId: posted.record.interactionId,
          state: posted.record.state,
        });
        roundResult = {
          kind: "questionsPosted",
          ref: followUpRef,
          questions: posted.record.questions ?? result.questions,
        };
      } else if (result.kind === "completed") {
        outcome = { kind: "completed", correlation: resumedCorrelation, code: "completed" };
        roundResult = absorbCompletedRound(result.summaryMarkdown);
      } else {
        outcome = {
          kind: "failed",
          correlation: resumedCorrelation,
          code: result.code,
          retryable: result.retryable,
        };
        emitError(result.code, "resumed provider round failed");
        emitLifecycle("failed", result.code);
        roundResult = { kind: "failed", code: result.code, retryable: result.retryable };
      }
      await conversations.recordResumeInvocationOutcome(ref, outcome);
      return { kind: "resumed", result: roundResult };
    },

    advanceStage(): PersistedTaskProgressV1 {
      const current = journal.current;
      const stage = current.currentStage;
      const at = STAGE_ORDER.indexOf(stage);
      const nextStage = STAGE_ORDER[at + 1];
      const completedStages = [...(current.completedStages ?? [])];
      if (!completedStages.includes(stage)) {
        completedStages.push(stage);
      }
      const next = journal.patch((progress) => {
        if (stage === PUBLISH_STAGE || nextStage === undefined) {
          return {
            ...progress,
            completedStages,
            status: "completed",
            completedAt: now().toISOString(),
          };
        }
        return { ...progress, completedStages, currentStage: nextStage };
      });
      roundsInStage = 0;
      emitProgress();
      if (next.status === "completed") {
        emitLifecycle("completed");
      }
      return next;
    },
  };
}
