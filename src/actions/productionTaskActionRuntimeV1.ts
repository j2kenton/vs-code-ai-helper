/**
 * Production wiring for the task action registry/coordinator (plan §3.8,
 * §6.2's Generate Plan vertical slice — the first cohort to actually
 * construct one of these in production; see taskActionRegistryV1.ts's and
 * taskActionCoordinatorV1.ts's own "ENFORCEMENT STATE" headers).
 *
 * The registry is a process-lifetime singleton (rows are pure declarations,
 * safe to share). The coordinator is NOT a singleton: `RunnerSelectionOpenerV1`
 * is bound to one invocation's already-resolved workspace cwd and stage model
 * (plan's registry/runner boundary — see runnerRegistry.ts's
 * `createV1RunnerSelectionOpener`), so a fresh, cheap coordinator instance is
 * built per invocation. Every instance still shares the same underlying
 * lease store / transaction store / file store singletons
 * (workflowRuntimeServicesV1.ts), so duplicate-invocation rejection and
 * durable Chat interaction state are correctly shared across instances.
 */
import {
  ActionConversationOrchestratorV1,
  createActionConversationOrchestratorV1,
} from "./actionConversationOrchestratorV1";
import {
  createTaskActionCoordinatorV1,
  TaskActionAuditLoggerV1,
  TaskActionCoordinatorV1,
  TaskActionFollowUpSchedulerV1,
  TaskActionPresenterV1,
} from "./taskActionCoordinatorV1";
import { createTaskActionRegistryV1, TaskActionRegistryV1 } from "./taskActionRegistryV1";
import { createGeneratePlanRowV1 } from "./rows/generatePlanRowV1";
import { createDraftRowV1 } from "./rows/draftRowV1";
import { createGenerateImplementationRowV1 } from "./rows/generateImplementationRowV1";
import { createReviewRowV1 } from "./rows/reviewRowV1";
import { createApplyReviewRowV1 } from "./rows/applyReviewRowV1";
import { createChatSendRowV1 } from "./rows/chatSendRowV1";
import { createCommitPushMetadataRowV1 } from "./rows/commitPushMetadataRowV1";
import { createCommitPushRowV1 } from "./rows/commitPushRowV1";
import { createNextStageRowV1 } from "./rows/nextStageRowV1";
import { createMarkTaskDoneRowV1 } from "./rows/markTaskDoneRowV1";
import { createResumeTaskRowV1 } from "./rows/resumeTaskRowV1";
import {
  createApplyReviewEditPreflightRowV1,
  createFastForwardPreflightRowV1,
  createImplementationPreflightRowV1,
  createLintPreflightRowV1,
  EditPreflightActionInputV1,
} from "./rows/editPreflightRowsV1";
import { createEditExecutionRowV1, EditExecutionActionInputV1 } from "./rows/editExecutionRowV1";
import { createV1RunnerSelectionOpener } from "../runners/runnerRegistry";
import {
  getChatInteractionTransactionStoreV1,
  getEditPlanBrokerV1,
  getWorkflowFileStoreV1,
  getWorkflowLeaseStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { createReadToolSessionHandlerV1 } from "../services/readToolSessionHandlerV1";
import { createObservationLedgerV1 } from "../types/preflightPlanV1";
import { TaskProgress, TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "../utils/notificationRouter";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import * as vscode from "vscode";

let registry: TaskActionRegistryV1 | undefined;

/** The one process-lifetime registry of migrated task actions. */
export function getProductionTaskActionRegistryV1(): TaskActionRegistryV1 {
  if (!registry) {
    registry = createTaskActionRegistryV1([
      createGeneratePlanRowV1(),
      createDraftRowV1(),
      createGenerateImplementationRowV1(),
      createReviewRowV1(),
      createApplyReviewRowV1(),
      createChatSendRowV1(),
      createCommitPushMetadataRowV1(),
      createCommitPushRowV1(),
      createNextStageRowV1(),
      createMarkTaskDoneRowV1(),
      createResumeTaskRowV1(),
      createImplementationPreflightRowV1(),
      createFastForwardPreflightRowV1(),
      createApplyReviewEditPreflightRowV1(),
      createLintPreflightRowV1(),
      createEditExecutionRowV1(),
    ]);
  }
  return registry;
}

/** No row has declared a follow-up action yet (plan §3.8 / AC-LIFECYCLE-02) — nothing to schedule. */
const noopFollowUpSchedulerV1: TaskActionFollowUpSchedulerV1 = {
  schedule(): void {
    // Intentionally empty: no migrated row declares a followUpActionKey yet.
  },
};

/**
 * Routes each invocation's declared progress label through the existing
 * Notifications-row summary surface, instead of a second competing native
 * progress toast — callers that already wrap the coordinator in their own
 * `vscode.window.withProgress` (e.g. generatePlanWithAI.ts) keep that as the
 * primary UI; this still gives a Resume-triggered run (which has no such
 * wrapper) a visible progress entry.
 */
function notificationPresenterV1(): TaskActionPresenterV1 {
  return {
    beginProgress(presentation): { end: () => void } {
      NotificationRouter.emitProgressSummary(presentation.progressLabel);
      return { end: (): void => undefined };
    },
  };
}

/** Sanitized settlement records (plan §2.2/§3.8 — correlation, codes, digests, byte counts only). */
const consoleAuditLoggerV1: TaskActionAuditLoggerV1 = {
  log(record): void {
    console.log("[ensemble:taskAction]", JSON.stringify(record));
  },
};

export function getProductionActionConversationOrchestratorV1(): ActionConversationOrchestratorV1 {
  const transactionStore = getChatInteractionTransactionStoreV1();
  if (!transactionStore) {
    throw new Error(
      "The Chat interaction transaction store is not wired yet (setChatInteractionTransactionStoreV1 must run at activation)."
    );
  }
  return createActionConversationOrchestratorV1({ transactionStore });
}

/**
 * A `TaskActionCoordinatorV1` never touches its `orchestrator` dependency
 * for a lifecycle row (plan §6.6): only `runProviderRow`/`settleEnvelope`
 * (provider-only paths) call it. Resolving the real orchestrator eagerly at
 * coordinator-construction time would therefore require every lifecycle-only
 * caller (e.g. nextStage/markTaskDone) to have the full Chat interaction
 * transaction store wired at activation, even though it will never actually
 * be used. This lazily resolves on first real method access instead, so a
 * lifecycle-only invocation works without that wiring while a provider row
 * still gets the real orchestrator, resolved just slightly later.
 *
 * Implemented as an explicit method-by-method delegate rather than a
 * generic `Proxy` `get` trap: a `Proxy` forwards any property silently, so a
 * future member added to `ActionConversationOrchestratorV1` would resolve at
 * runtime with no compile-time signal that this lazy wrapper needs a
 * matching delegate. Listing every method here makes that omission a build
 * error instead.
 */
function lazyProductionActionConversationOrchestratorV1(): ActionConversationOrchestratorV1 {
  let cached: ActionConversationOrchestratorV1 | undefined;
  const resolve = (): ActionConversationOrchestratorV1 => {
    if (!cached) {
      cached = getProductionActionConversationOrchestratorV1();
    }
    return cached;
  };
  return {
    admitInvocation: (input) => resolve().admitInvocation(input),
    discardInvocation: (operationId) => resolve().discardInvocation(operationId),
    postQuestions: (input) => resolve().postQuestions(input),
    submitAnswers: (ref, rawAnswers, answerIdempotencyId) =>
      resolve().submitAnswers(ref, rawAnswers, answerIdempotencyId),
    resolveResume: (ref, resumeIdempotencyId) => resolve().resolveResume(ref, resumeIdempotencyId),
    claimResumeInvocation: (ref) => resolve().claimResumeInvocation(ref),
    recordResumeInvocationOutcome: (ref, outcome) => resolve().recordResumeInvocationOutcome(ref, outcome),
    cancel: (ref) => resolve().cancel(ref),
    expire: (ref) => resolve().expire(ref),
    getRecord: (ref) => resolve().getRecord(ref),
    loadInteraction: (ref) => resolve().loadInteraction(ref),
  };
}

/**
 * Build a coordinator bound to one invocation's already-resolved workspace
 * cwd and stage-model resolution. `resolveStagePrimaryModel` must be
 * synchronous — callers resolve the stage's stored model id asynchronously
 * BEFORE invoking the coordinator and close over the resolved value here
 * (see generatePlanWithAI.ts).
 */
export function createProductionTaskActionCoordinatorV1(options: {
  readonly workspaceCwd: string;
  readonly resolveStagePrimaryModel: (
    taskStage: string
  ) => { readonly modelId: string | undefined; readonly stage: TaskStage | undefined };
}): TaskActionCoordinatorV1 {
  return createTaskActionCoordinatorV1({
    registry: getProductionTaskActionRegistryV1(),
    leaseStore: getWorkflowLeaseStoreV1(),
    openRunnerSelection: createV1RunnerSelectionOpener({
      workspaceCwd: options.workspaceCwd,
      resolveStagePrimaryModel: options.resolveStagePrimaryModel,
    }),
    orchestrator: lazyProductionActionConversationOrchestratorV1(),
    followUpScheduler: noopFollowUpSchedulerV1,
    presenter: notificationPresenterV1(),
    auditLogger: consoleAuditLoggerV1,
    // §7.2/§7.6 request-local tool sessions: a fresh read session (with its
    // own observation ledger) per preflight attempt, and the broker's
    // mutation-session handler per edit attempt. Text rows never touch this.
    toolSessions: {
      createPreflightSession(validatedInput) {
        const input = validatedInput as EditPreflightActionInputV1;
        const ledger = createObservationLedgerV1();
        return {
          handler: createReadToolSessionHandlerV1({
            view: getWorkflowFileStoreV1(),
            rootId: input.rootId,
            ledger,
          }),
          ledger,
          rootId: input.rootId,
        };
      },
      createEditSession(validatedInput) {
        const input = validatedInput as EditExecutionActionInputV1;
        return getEditPlanBrokerV1().createEditSessionHandler(input.executionId);
      },
    },
  });
}

/**
 * Shared invocation path for a non-provider (lifecycle) row — `nextStage.v1`,
 * `markTaskDone.v1`, and `resumeTask.v1` are all callers (`reviewActions.ts`,
 * `markTaskDone.ts`, `reopenTask.ts`, `commitAndPushTask.ts`). A lifecycle row
 * never writes through the workflow file store, so it needs no registered/
 * verified workflow task-folder root — but `options.taskBindingId` MUST still
 * be the ownership-derived `TaskBindingV1.bindingId` (plan §3.9,
 * `deriveTaskBindingV1` in `types/taskBindingV1.ts`), never a raw or
 * normalized filesystem path: leases (`workflowLeaseStoreV1`) and audit
 * records key on this value, and it must equal the SAME task's binding as
 * derived by every provider row (generatePlan.v1, draft.v1, ...) so a single
 * active-operation-per-task invariant and Resume's task lookup
 * (`TaskInventory.getTaskByBindingId`) hold across action kinds, and so raw
 * paths never reach audit logs (plan §2.2). A lifecycle row never posts to
 * Chat (that's provider-only coordinator plumbing), so `chatDocumentId` here
 * is inert correlation/audit metadata only; a synthetic id when the real one
 * can't be resolved is safe.
 */
export async function invokeLifecycleRowV1(options: {
  readonly actionKey: string;
  readonly taskFolderPath: string;
  readonly taskBindingId: string;
  readonly chatDocumentIdentitySeed: string;
  readonly workspaceCwd: string;
  readonly taskStatus: TaskProgress["status"];
  readonly taskStage: TaskStage;
  readonly rawInput: Record<string, unknown>;
  /** Forwarded to `TaskActionRequestV1.lifecycleBeforeWrite` — see its header. */
  readonly beforeWrite?: (patched: TaskProgress) => Promise<void>;
  /** Forwarded to `TaskActionRequestV1.lifecycleSkipTaskLock` — see its header. */
  readonly skipTaskLock?: boolean;
  /** Forwarded to `TaskActionRequestV1.lifecycleServices` — see its header. */
  readonly services?: unknown;
}): Promise<TaskActionOutcomeV1> {
  let chatDocumentId: string;
  try {
    const chatIdentity = await readChatDocumentIdentityV1(
      options.taskFolderPath,
      options.chatDocumentIdentitySeed
    );
    chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();
  } catch {
    // Inert correlation metadata (see this function's header) — a lifecycle
    // row never consults chatDocumentId, so a synthetic id is safe. Logged
    // (no paths, no content) so a future row that does depend on it isn't
    // silently working from a random id.
    chatDocumentId = allocateHex128IdV1();
    console.warn("[ensemble:taskAction] lifecycle row chat identity read failed; using synthetic id", {
      actionKey: options.actionKey,
    });
  }

  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: options.workspaceCwd,
    // A lifecycle row never consults provider selection, so this resolver
    // is never actually invoked.
    resolveStagePrimaryModel: () => ({ modelId: undefined, stage: undefined }),
  });
  const cancellation = new vscode.CancellationTokenSource();
  try {
    return await coordinator.executeAction({
      actionKey: options.actionKey,
      taskBinding: { taskBindingId: options.taskBindingId, chatDocumentId },
      taskStatus: options.taskStatus ?? "active",
      taskStage: options.taskStage,
      rawInput: options.rawInput,
      cancellationToken: cancellation.token,
      lifecycleBeforeWrite: options.beforeWrite,
      lifecycleSkipTaskLock: options.skipTaskLock,
      lifecycleServices: options.services,
    });
  } finally {
    cancellation.dispose();
  }
}

/** Test isolation: forget the cached registry singleton. Production never calls this. */
export function resetProductionTaskActionRegistryForTestV1(): void {
  registry = undefined;
}
