/**
 * Engine run hosting (plan Part 5): the control plane drives the Part 4a
 * task loop — with Part 4b provider dispatch behind its runner seam — for
 * every created task, end to end inside the server process:
 *
 * - one `EngineTaskV1` per task, its plan of record seeded from the task's
 *   request text (the checklist inside it is the loop's `N/M` denominator);
 * - every engine event both PERSISTS (task-progress snapshots via
 *   `updateTaskProgress`, structured-question posts as assistant chat turns)
 *   and FANS OUT to the owner's authorized WS subscriptions through the hub
 *   — the store stays the read model for the task list/monitor endpoints;
 * - completed rounds append per-round history records (Part 7's task detail
 *   reads these); a plan-complete round advances the stage machinery to
 *   completion; a checklist-less plan advances one stage per completed round;
 * - a `questions` round pauses the run over the DURABLE transaction store
 *   (`store.engineTransactions` backs the engine's Part 4a store, so the
 *   interaction record persists with the document); answers arriving through
 *   the chat endpoint resume the run under the engine's invocation-once
 *   claim, with the answer idempotency id doubling as the resume idempotency
 *   id so a replayed submission can never double-invoke the provider;
 * - job status checkpoints to the store at every transition (`running`,
 *   `questionsPaused` — carrying the durable resume point —, `completed`,
 *   `failed`) so the monitor endpoints and the Part 5 restart procedure read
 *   a truthful supervision state;
 * - RESTART RECOVERY for question-paused runs: a `questionsPaused` job's
 *   checkpoint records the interaction address and the plan of record, so a
 *   restarted host rebuilds the engine task on the next answer submission
 *   and resumes it — the durable store's idempotency rules still guarantee
 *   the resumed invocation runs at most once across restarts (a claim
 *   recorded before the crash fails closed instead of re-invoking). At boot
 *   the host reconciles stale `running` checkpoints (crashed mid-round, no
 *   durable resume point) to `failed` so they never read as zombie running
 *   jobs.
 *
 * The provider runner is injected per task (`providerRunnerFor`): production
 * composition builds it from Part 4b dispatch over custody-decrypted model
 * keys; tests script it directly. The host itself never touches key
 * material.
 */
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type { TaskStage } from "../../ensemble-core/src/taskProgressV1";
import type { EngineEventSinkV1 } from "../../ensemble-engine/src/engineEventsV1";
import type { EngineInteractionRefV1 } from "../../ensemble-engine/src/conversationOrchestratorV1";
import {
  createEngineTaskV1,
  EngineProviderRunnerV1,
  EngineTaskV1,
  RunEngineRoundResultV1,
} from "../../ensemble-engine/src/taskLoopV1";
import { createEngineTransactionStoreV1 } from "../../ensemble-engine/src/transactionStoreV1";
import type {
  ControlPlaneStoreV1,
  ControlPlaneTaskRecordV1,
  EngineJobPausedInteractionV1,
} from "./storeV1";
import type { WsHubV1 } from "./wsHubV1";

export type EngineRunOutcomeV1 =
  | { readonly kind: "completed" }
  | { readonly kind: "questionsPaused"; readonly interactionId: string }
  | { readonly kind: "failed"; readonly code: string }
  | {
      /**
       * Fail-closed resume outcome: the invocation was already claimed and
       * no re-invocation happened; nothing changed (engine Part 4a rules).
       */
      readonly kind: "resumeUnavailable";
      readonly code: "invocationOutcomeUnknown" | "resumeOutcomeRecovered";
    };

export type SubmitRunAnswersResultV1 =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      /** Settles when the resumed drive next pauses, completes, or fails. */
      readonly settled: Promise<EngineRunOutcomeV1>;
    }
  | {
      readonly ok: false;
      readonly code: "noActiveRun" | "unknownInteraction" | "answersRejected";
      readonly reason?: string;
    };

export interface EngineRunHostV1 {
  /**
   * Start (idempotently) hosting the task's engine run. The returned promise
   * settles at the run's first pause/completion/failure — callers that must
   * not block (the task-creation handler) fire it without awaiting.
   */
  start(task: ControlPlaneTaskRecordV1): Promise<EngineRunOutcomeV1>;
  /** Forward validated structured answers into the paused run and resume it. */
  submitAnswers(
    taskId: string,
    interactionId: string,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<SubmitRunAnswersResultV1>;
  /** The interaction the run is currently paused on, if any. */
  pendingInteractionId(taskId: string): string | undefined;
  /** The latest drive segment's settlement, for observers and tests. */
  settled(taskId: string): Promise<EngineRunOutcomeV1> | undefined;
}

export interface CreateEngineRunHostOptionsV1 {
  readonly store: ControlPlaneStoreV1;
  readonly hub: WsHubV1;
  readonly providerRunnerFor: (task: ControlPlaneTaskRecordV1) => EngineProviderRunnerV1;
  readonly now?: () => Date;
  /**
   * Rounds one stage may spend before the run fails closed
   * (`roundBudgetExhausted`) instead of looping a stalled provider forever.
   */
  readonly maxRoundsPerStage?: number;
}

interface RunStateV1 {
  readonly task: ControlPlaneTaskRecordV1;
  readonly engineTask: EngineTaskV1;
  pendingRef: EngineInteractionRefV1 | undefined;
  /** Continuations keyed by interaction id: replays return the original. */
  readonly answered: Map<string, Promise<EngineRunOutcomeV1>>;
  settled: Promise<EngineRunOutcomeV1>;
  roundsThisStage: number;
}

export function createEngineRunHostV1(options: CreateEngineRunHostOptionsV1): EngineRunHostV1 {
  const { store, hub, providerRunnerFor } = options;
  const now = options.now ?? ((): Date => new Date());
  const maxRoundsPerStage = options.maxRoundsPerStage ?? 16;
  const runs = new Map<string, RunStateV1>();

  // The engine's Part 4a transaction store over the DURABLE backend: every
  // hosted task's interaction records and invocation-once claims persist
  // with the control-plane document, so question pauses survive restarts.
  const transactions = createEngineTransactionStoreV1({
    backend: store.engineTransactions,
    now,
  });

  // Boot reconciliation: a `running` checkpoint with no live run is a
  // crashed mid-round job. Question pauses checkpoint `questionsPaused` and
  // gate pauses `gatePaused`, so a stale `running` has no durable resume
  // point — reconcile it to `failed` rather than letting it read as a
  // zombie running job forever.
  for (const job of store.listJobsByStatus("running")) {
    store.upsertJob({ ...job, status: "failed", updatedAt: now().toISOString() });
  }

  function checkpoint(
    state: RunStateV1,
    status: "running" | "questionsPaused" | "completed" | "failed",
    pausedInteraction?: EngineJobPausedInteractionV1
  ): void {
    store.upsertJob({
      jobId: state.task.taskId,
      taskId: state.task.taskId,
      ownerUserId: state.task.ownerUserId,
      status,
      ...(pausedInteraction !== undefined ? { pausedInteraction } : {}),
      updatedAt: now().toISOString(),
    });
  }

  /** Persist-then-relay: the store is the durable read model, the hub the feed. */
  function sinkFor(task: ControlPlaneTaskRecordV1): EngineEventSinkV1 {
    const relay = hub.createEngineSink(task.ownerUserId);
    return {
      emit(event): void {
        if (event.type === "taskProgress") {
          store.updateTaskProgress(task.taskId, event.progress);
        }
        if (event.type === "structuredQuestions") {
          store.appendChatTurn(task.taskId, {
            turnId: allocateHex128IdV1(),
            role: "assistant",
            at: now().toISOString(),
            interactionId: event.interactionId,
          });
        }
        relay.emit(event);
      },
    };
  }

  function pausedInteractionFor(
    state: RunStateV1,
    ref: EngineInteractionRefV1
  ): EngineJobPausedInteractionV1 {
    return {
      interactionId: ref.interactionId,
      operationId: ref.operationId,
      taskBindingId: ref.taskBindingId,
      chatDocumentId: ref.chatDocumentId,
      sourceAttemptId: ref.sourceAttemptId,
      planOfRecord: state.engineTask.planOfRecord,
    };
  }

  function fail(state: RunStateV1, code: string): EngineRunOutcomeV1 {
    state.pendingRef = undefined;
    checkpoint(state, "failed");
    return { kind: "failed", code };
  }

  function complete(state: RunStateV1): EngineRunOutcomeV1 {
    checkpoint(state, "completed");
    return { kind: "completed" };
  }

  /**
   * Fold one settled round into host state. Returns the run's outcome when
   * the drive should stop, or undefined to keep driving rounds.
   */
  function absorbRound(
    state: RunStateV1,
    result: RunEngineRoundResultV1,
    startedAt: string
  ): EngineRunOutcomeV1 | undefined {
    if (result.kind === "questionsPosted") {
      state.pendingRef = result.ref;
      // The durable resume point: interaction address + plan of record, so a
      // restarted host can rebuild this run when the answers arrive.
      checkpoint(state, "questionsPaused", pausedInteractionFor(state, result.ref));
      return { kind: "questionsPaused", interactionId: result.ref.interactionId };
    }
    if (result.kind === "failed") {
      return fail(state, result.code);
    }
    store.appendTaskRound(state.task.taskId, {
      roundId: allocateHex128IdV1(),
      stage: state.engineTask.progress.currentStage,
      startedAt,
      completedAt: now().toISOString(),
      summary:
        result.progress !== null
          ? `${result.progress.complete}/${result.progress.total}`
          : result.checklist !== undefined
            ? `${result.checklist.checked}/${result.checklist.total}`
            : "round completed",
    });
    if (result.planComplete) {
      // The plan has nothing left unchecked: run the stage machinery out.
      let progress = state.engineTask.advanceStage();
      while (progress.status !== "completed") {
        progress = state.engineTask.advanceStage();
      }
      return complete(state);
    }
    if (result.checklist === undefined) {
      // A checklist-less plan has no `M`: one completed round per stage.
      const progress = state.engineTask.advanceStage();
      state.roundsThisStage = 0;
      return progress.status === "completed" ? complete(state) : undefined;
    }
    return undefined;
  }

  async function drive(state: RunStateV1): Promise<EngineRunOutcomeV1> {
    for (;;) {
      if (state.roundsThisStage >= maxRoundsPerStage) {
        return fail(state, "roundBudgetExhausted");
      }
      state.roundsThisStage += 1;
      const startedAt = now().toISOString();
      let result: RunEngineRoundResultV1;
      try {
        result = await state.engineTask.runRound();
      } catch {
        return fail(state, "engineRoundThrew");
      }
      const outcome = absorbRound(state, result, startedAt);
      if (outcome !== undefined) {
        return outcome;
      }
    }
  }

  function buildState(
    task: ControlPlaneTaskRecordV1,
    planOfRecord: string,
    initialStage?: TaskStage
  ): RunStateV1 {
    const engineTask = createEngineTaskV1({
      taskId: task.taskId,
      taskFolder: task.taskId,
      ...(task.displayName !== undefined ? { displayName: task.displayName } : {}),
      planOfRecord,
      provider: providerRunnerFor(task),
      sink: sinkFor(task),
      store: transactions,
      now,
      ...(initialStage !== undefined ? { initialStage } : {}),
    });
    const state: RunStateV1 = {
      task,
      engineTask,
      pendingRef: undefined,
      answered: new Map(),
      settled: Promise.resolve({ kind: "failed", code: "notStarted" }),
      roundsThisStage: 0,
    };
    runs.set(task.taskId, state);
    return state;
  }

  /**
   * Rebuild a question-paused run from its durable checkpoint after a
   * restart: the engine task is recreated over the SAME durable transaction
   * store (so the recorded interaction, its answers-idempotency binding, and
   * any invocation-once claim all still apply) and the pending ref is
   * restored from the checkpointed interaction address.
   */
  function rehydrate(taskId: string): RunStateV1 | undefined {
    const job = store.readJob(taskId);
    if (job?.status !== "questionsPaused" || job.pausedInteraction === undefined) {
      return undefined;
    }
    const task = store.readTask(taskId);
    if (task === undefined) {
      return undefined;
    }
    const paused = job.pausedInteraction;
    const state = buildState(task, paused.planOfRecord, task.progress.currentStage);
    state.pendingRef = {
      operationId: paused.operationId,
      interactionId: paused.interactionId,
      taskBindingId: paused.taskBindingId,
      chatDocumentId: paused.chatDocumentId,
      sourceAttemptId: paused.sourceAttemptId,
    };
    state.settled = Promise.resolve({
      kind: "questionsPaused",
      interactionId: paused.interactionId,
    });
    return state;
  }

  return {
    start(task: ControlPlaneTaskRecordV1): Promise<EngineRunOutcomeV1> {
      const existing = runs.get(task.taskId);
      if (existing !== undefined) {
        return existing.settled;
      }
      const state = buildState(task, task.request);
      checkpoint(state, "running");
      state.engineTask.start();
      state.settled = drive(state);
      return state.settled;
    },

    async submitAnswers(
      taskId: string,
      interactionId: string,
      rawAnswers: unknown,
      answerIdempotencyId: string
    ): Promise<SubmitRunAnswersResultV1> {
      const state = runs.get(taskId) ?? rehydrate(taskId);
      if (state === undefined) {
        return { ok: false, code: "noActiveRun" };
      }
      const replay = state.answered.get(interactionId);
      if (replay !== undefined) {
        // Idempotent replay: the first submission's continuation owns the
        // resume; a retry observes the same settlement, never a second run.
        return { ok: true, duplicate: true, settled: replay };
      }
      const ref = state.pendingRef;
      if (ref === undefined || ref.interactionId !== interactionId) {
        return { ok: false, code: "unknownInteraction" };
      }
      const submitted = await state.engineTask.submitAnswers(
        ref,
        rawAnswers,
        answerIdempotencyId
      );
      if (!submitted.ok) {
        return {
          ok: false,
          code: "answersRejected",
          ...(submitted.reason !== undefined ? { reason: submitted.reason } : {}),
        };
      }
      state.pendingRef = undefined;
      checkpoint(state, "running");
      const continuation = (async (): Promise<EngineRunOutcomeV1> => {
        // The answer idempotency id doubles as the resume id: a crashed or
        // replayed submission maps to the exactly-one recorded resolution.
        const resumed = await state.engineTask.resume(ref, answerIdempotencyId);
        if (resumed.kind === "failed") {
          return fail(state, resumed.code);
        }
        if (resumed.kind === "invocationOutcomeUnknown") {
          // Fail closed AND stay durably paused: the interaction remains the
          // job's recorded resume point for a later explicit retry.
          state.pendingRef = ref;
          checkpoint(state, "questionsPaused", pausedInteractionFor(state, ref));
          return { kind: "resumeUnavailable", code: "invocationOutcomeUnknown" };
        }
        if (resumed.kind === "recovered") {
          return { kind: "resumeUnavailable", code: "resumeOutcomeRecovered" };
        }
        const startedAt = now().toISOString();
        const outcome = absorbRound(state, resumed.result, startedAt);
        return outcome !== undefined ? outcome : drive(state);
      })();
      state.answered.set(interactionId, continuation);
      state.settled = continuation;
      return { ok: true, duplicate: submitted.duplicate === true, settled: continuation };
    },

    pendingInteractionId(taskId: string): string | undefined {
      return runs.get(taskId)?.pendingRef?.interactionId;
    },

    settled(taskId: string): Promise<EngineRunOutcomeV1> | undefined {
      return runs.get(taskId)?.settled;
    },
  };
}
