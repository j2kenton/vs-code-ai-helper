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
import { createV1RunnerSelectionOpener } from "../runners/runnerRegistry";
import {
  getChatInteractionTransactionStoreV1,
  getWorkflowLeaseStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { TaskStage } from "../types/taskProgress";
import { NotificationRouter } from "../utils/notificationRouter";

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
    orchestrator: getProductionActionConversationOrchestratorV1(),
    followUpScheduler: noopFollowUpSchedulerV1,
    presenter: notificationPresenterV1(),
    auditLogger: consoleAuditLoggerV1,
  });
}

/** Test isolation: forget the cached registry singleton. Production never calls this. */
export function resetProductionTaskActionRegistryForTestV1(): void {
  registry = undefined;
}
