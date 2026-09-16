/**
 * Derived entry-point inventory of every `package.json`-contributed command
 * (v1 fixes 2, Part 1a — "build derived entry-point inventory of all
 * watchdog-susceptible commands from package.json contributions and
 * automation-chain dispatches").
 *
 * Prior rounds hand-traced admission coverage for the ten routes named in the
 * original finding (`runReviewWithAI`, `fastForwardReviewWithAI`, implementation
 * dispatch, `runEditActionV1.ts`, plan generation, `runLintingFixes.ts`,
 * publish/complete actions, scheduled firing, resume-with-dispatch,
 * `automationChain.ts`) and recorded that audit as a table in implementation
 * notes — but that list was never checked against `package.json` itself, and
 * a systematic pass this round found three commands it missed entirely:
 * `draftTaskWithAI`, `renameTaskWithAI`, and `chatWithStage`/
 * `respondToStageDecision` all dispatched a real provider round via
 * `coordinator.executeAction` with NO admission wiring at all. All three are
 * fixed as of this module landing (see their own files' "Early work admission"
 * comments).
 *
 * This module is the maintained, automatically-checkable replacement for that
 * hand-traced audit: `WORK_ADMISSION_ROUTE_INVENTORY_V1` below classifies
 * EVERY command in `package.json`'s `contributes.commands`, and
 * `workAdmissionRouteInventoryV1.test.ts` asserts the map stays in exact
 * 1:1 correspondence with that list — so a newly contributed command with no
 * classification entry fails the test immediately, instead of silently
 * joining the next unaudited gap.
 *
 * Three classification kinds:
 *  - `admissionWired`: the command's own handler acquires durable admission
 *    itself (see `evidence` for the file/function). This is the set every
 *    other command must transitively resolve to.
 *  - `delegatesTo`: a thin router that dispatches to ONE other command in
 *    this same map by a literal, statically-known id (e.g.
 *    `applyHighLevelReviewChanges` → `applyReviewWithAI`/`applyReviewEditWithAI`
 *    — recorded as the first, since both targets are themselves
 *    `admissionWired`). The completeness test resolves `delegatesTo` chains
 *    and rejects a cycle or a dangling target.
 *  - `delegatesDynamically`: a generic dispatcher whose target command id is
 *    chosen at runtime (`applyCurrentStageAction`, `runNotificationAction`,
 *    `nextStage`'s `scheduleAutomationChain` call) — every concrete target
 *    such a dispatcher can reach is itself one of the commands in this same
 *    map, so it is safe by construction rather than by a single fixed edge.
 *  - `notWatchdogSusceptible`: the command never dispatches provider work
 *    against a task's `active`-status lifecycle at all (pure UI/deterministic
 *    action, or — `openGeneralAssistant`'s `globalAssistantSend` — a
 *    workspace-scoped pseudo-task with no `task-progress.json` the watchdog
 *    could ever evaluate).
 */

export type WorkAdmissionRouteClassificationV1 =
  | { readonly kind: "admissionWired"; readonly evidence: string }
  | { readonly kind: "delegatesTo"; readonly to: string; readonly evidence: string }
  | { readonly kind: "delegatesDynamically"; readonly evidence: string }
  | { readonly kind: "notWatchdogSusceptible"; readonly reason: string };

/**
 * Keyed by the command id WITHOUT the `vs-code-ai-helper.` prefix (every
 * contributed command in this codebase shares that prefix; stripping it here
 * keeps the table below readable — the test re-adds it before comparing
 * against `package.json`).
 */
export const WORK_ADMISSION_ROUTE_INVENTORY_V1: Readonly<Record<string, WorkAdmissionRouteClassificationV1>> = {
  helloWorld: { kind: "notWatchdogSusceptible", reason: "demo command; no provider dispatch" },
  migrateMetaResources: { kind: "notWatchdogSusceptible", reason: "deterministic file migration; no provider dispatch" },
  startNewTask: { kind: "notWatchdogSusceptible", reason: "creates a task folder deterministically; no provider dispatch of its own" },
  resumeTask: { kind: "admissionWired", evidence: "src/commands/resumeTask.ts — resumePausedTask acquires admission before the active-status write" },
  pauseTask: { kind: "notWatchdogSusceptible", reason: "deterministic status write; no provider dispatch" },
  draftTaskWithAI: { kind: "admissionWired", evidence: "src/commands/draftTaskWithAI.ts — draftTaskWithAI (v1 fixes 2 gap, fixed this round)" },
  generatePlanWithAI: { kind: "admissionWired", evidence: "src/commands/generatePlanWithAI.ts — generatePlanWithAI" },
  runReviewWithAI: { kind: "admissionWired", evidence: "src/commands/reviewActions.ts — runReviewWithAI" },
  applyReviewWithAI: { kind: "admissionWired", evidence: "src/commands/reviewActions.ts — applyReviewWithAI" },
  applyReviewEditWithAI: { kind: "admissionWired", evidence: "src/commands/reviewActions.ts — applyReviewEditWithAI" },
  fastForwardReviewWithAI: { kind: "admissionWired", evidence: "src/commands/reviewActions.ts — fastForwardReviewWithAI" },
  nextStage: {
    kind: "delegatesDynamically",
    evidence:
      "src/commands/reviewActions.ts — nextStage calls scheduleAutomationChain (src/utils/automationChain.ts, itself " +
      "documented proof-of-safety: no setup of its own before the dispatched command runs), which reaches only " +
      "already-classified commands (runReviewWithAI, runImplementationWithAI, ...) via vscode.commands.executeCommand",
  },
  runImplementationWithAI: { kind: "admissionWired", evidence: "src/commands/reviewActions.ts — runImplementationWithAI" },
  setTaskStage: { kind: "notWatchdogSusceptible", reason: "deterministic stage-pointer write; no provider dispatch" },
  setStageAsCurrent: { kind: "notWatchdogSusceptible", reason: "deterministic; no provider dispatch" },
  refreshTasksView: { kind: "notWatchdogSusceptible", reason: "UI refresh only" },
  openSettings: { kind: "notWatchdogSusceptible", reason: "opens a settings UI panel; no provider dispatch" },
  openAiModels: { kind: "notWatchdogSusceptible", reason: "opens a settings UI panel; no provider dispatch" },
  recoverLastAiResponse: { kind: "notWatchdogSusceptible", reason: "reads/recovers an already-stored response; dispatches no new provider round" },
  restoreRejectedImplementationRound: { kind: "notWatchdogSusceptible", reason: "deterministic artifact restore; no provider dispatch" },
  archiveTask: { kind: "notWatchdogSusceptible", reason: "deterministic status write; no provider dispatch" },
  unarchiveTask: { kind: "notWatchdogSusceptible", reason: "deterministic status write; no provider dispatch" },
  reconcilePlanChecklist: { kind: "notWatchdogSusceptible", reason: "deterministic checklist reconciliation; no coordinator/provider call" },
  applyReviewerVerifiedTicks: { kind: "notWatchdogSusceptible", reason: "deterministic tick application; no provider dispatch" },
  pinTask: { kind: "notWatchdogSusceptible", reason: "deterministic; no provider dispatch" },
  unpinTask: { kind: "notWatchdogSusceptible", reason: "deterministic; no provider dispatch" },
  openFailedTaskCreation: { kind: "notWatchdogSusceptible", reason: "opens a failed-creation folder; no provider dispatch" },
  retryTaskCreation: { kind: "notWatchdogSusceptible", reason: "src/commands/taskCreationRecovery.ts — deterministic retry of task-folder creation; no coordinator/provider call" },
  adoptAndRetryTaskCreation: { kind: "notWatchdogSusceptible", reason: "src/commands/taskCreationRecovery.ts — deterministic; no coordinator/provider call" },
  safeDeleteFailedTaskCreation: { kind: "notWatchdogSusceptible", reason: "deterministic cleanup; no provider dispatch" },
  filterNotifications: { kind: "notWatchdogSusceptible", reason: "UI filter state only" },
  chooseReleaseTarget: { kind: "notWatchdogSusceptible", reason: "UI picker; no provider dispatch" },
  choosePublishScope: { kind: "notWatchdogSusceptible", reason: "UI picker; no provider dispatch" },
  filterTasksByStatus: { kind: "notWatchdogSusceptible", reason: "UI filter state only" },
  resetTaskStatusFilter: { kind: "notWatchdogSusceptible", reason: "UI filter state only" },
  clearNotifications: { kind: "notWatchdogSusceptible", reason: "UI state only" },
  cancelOperation: { kind: "notWatchdogSusceptible", reason: "cancels in-flight work; never starts a provider round itself" },
  runNotificationAction: {
    kind: "delegatesDynamically",
    evidence:
      "src/extension.ts — dispatches statusTreeProvider.runAction, which executes a notification-carried command id " +
      "(e.g. vs-code-ai-helper.runPublishChecks) that is itself already classified in this table",
  },
  applyCurrentStageAction: {
    kind: "delegatesDynamically",
    evidence:
      "src/commands/applyCurrentStageAction.ts — resolves the current stage's action and dispatches via " +
      "vscode.commands.executeCommand to an already-classified command, threading admissionHandoffTokenV1 for adoption",
  },
  applyHighLevelReviewChanges: {
    kind: "delegatesTo",
    to: "applyReviewEditWithAI",
    evidence:
      "src/commands/applyHighLevelReviewChanges.ts — routes to applyReviewEditWithAI (impl-high-review) or " +
      "applyReviewWithAI (plan-high-review) by resolved stage, forwarding admissionHandoffTokenV1 to whichever it picks",
  },
  applyLowLevelReviewChanges: {
    kind: "delegatesTo",
    to: "applyReviewEditWithAI",
    evidence: "src/commands/applyLowLevelReviewChanges.ts — same routing shape as applyHighLevelReviewChanges.ts",
  },
  commitAndPushTask: { kind: "admissionWired", evidence: "src/commands/commitAndPushTask.ts — commitAndPushTask" },
  viewDisclaimer: { kind: "notWatchdogSusceptible", reason: "opens a static document" },
  expandAllTasks: { kind: "notWatchdogSusceptible", reason: "UI state only" },
  collapseAllTasks: { kind: "notWatchdogSusceptible", reason: "UI state only" },
  chatWithStage: { kind: "admissionWired", evidence: "src/commands/chatWithStage.ts — chatWithStage (v1 fixes 2 gap, fixed this round)" },
  respondToStageDecision: {
    kind: "delegatesTo",
    to: "chatWithStage",
    evidence: "src/commands/chatWithStage.ts — registered on the exact same chatWithStage function as vs-code-ai-helper.chatWithStage",
  },
  postStageQuestion: { kind: "notWatchdogSusceptible", reason: "re-opens an already-posted question in Chat; dispatches no new provider round" },
  openGeneralAssistant: {
    kind: "notWatchdogSusceptible",
    reason:
      "src/commands/openGeneralAssistant.ts — globalAssistantSend dispatches a provider round, but against a " +
      "workspace-scoped pseudo-task (GLOBAL_ASSISTANT_CANONICAL_ID) with no task-progress.json the watchdog ever " +
      "evaluates — there is no active-status lifecycle for admission to protect",
  },
  openChatData: { kind: "notWatchdogSusceptible", reason: "opens a read-only data view" },
  resetChatHistory: { kind: "notWatchdogSusceptible", reason: "deterministic history reset; no provider dispatch" },
  openWorkflowDecision: { kind: "notWatchdogSusceptible", reason: "opens an already-recorded decision; no provider dispatch" },
  viewPendingTaskDecision: { kind: "notWatchdogSusceptible", reason: "opens an already-recorded decision; no provider dispatch" },
  runPublishChecks: { kind: "admissionWired", evidence: "src/commands/runPublishChecks.ts — runPublishChecks" },
  runLintingFixes: { kind: "admissionWired", evidence: "src/commands/runLintingFixes.ts — runLintingFixes" },
  scheduleTaskResume: { kind: "admissionWired", evidence: "src/commands/scheduleTaskResume.ts — SchedulerV1.fire (withWorkAdmissionV1 is its first statement)" },
  cancelScheduledTaskAction: { kind: "notWatchdogSusceptible", reason: "deterministic schedule-record removal; no provider dispatch" },
  viewTask: { kind: "notWatchdogSusceptible", reason: "opens a document" },
  viewPlan: { kind: "notWatchdogSusceptible", reason: "opens a document" },
  viewReview: { kind: "notWatchdogSusceptible", reason: "opens a document" },
  openRetainedPrompt: { kind: "notWatchdogSusceptible", reason: "opens a stored prompt; no provider dispatch" },
  markTaskDone: { kind: "notWatchdogSusceptible", reason: "deterministic completion write; no coordinator/provider call" },
  completeCommitAndPushTask: { kind: "admissionWired", evidence: "src/commands/commitAndPushTask.ts — completeCommitAndPushTask" },
  release: { kind: "notWatchdogSusceptible", reason: "deterministic finalization; no coordinator/provider call" },
  openAndStartNewTask: { kind: "notWatchdogSusceptible", reason: "creates and opens a task deterministically; no provider dispatch of its own" },
  reviewCurrentTask: {
    kind: "delegatesTo",
    to: "runReviewWithAI",
    evidence: "src/commands/reviewCurrentTask.ts — resolves the current task and executes vs-code-ai-helper.runReviewWithAI",
  },
  fastForwardCurrentTaskReview: {
    kind: "delegatesTo",
    to: "fastForwardReviewWithAI",
    evidence: "src/commands/fastForwardCurrentTaskReview.ts — resolves the current task and executes vs-code-ai-helper.fastForwardReviewWithAI",
  },
  viewStageChanges: { kind: "notWatchdogSusceptible", reason: "opens a diff view; no provider dispatch" },
  revertStageChanges: { kind: "notWatchdogSusceptible", reason: "deterministic backup restore; no provider dispatch" },
  redoStageChanges: { kind: "notWatchdogSusceptible", reason: "deterministic backup restore; no provider dispatch" },
  deleteStageBackup: { kind: "notWatchdogSusceptible", reason: "deterministic backup removal; no provider dispatch" },
  renameTask: { kind: "notWatchdogSusceptible", reason: "src/commands/renameTask.ts — renameTask (the non-AI variant) is a plain deterministic rename" },
  renameTaskWithAI: { kind: "admissionWired", evidence: "src/commands/renameTask.ts — renameTaskWithAI (v1 fixes 2 gap, fixed this round)" },
};

/** Commands transitively resolve through `delegatesTo` chains to one of
 * these two terminal kinds — used by the completeness test to reject a
 * dangling or cyclic `delegatesTo` target. */
export const WORK_ADMISSION_ROUTE_TERMINAL_KINDS_V1 = ["admissionWired", "delegatesDynamically", "notWatchdogSusceptible"] as const;
