/**
 * Single source of truth for every named §11 runtime suite
 * (`test:workflow:*` / suite-backed `verify:*` package scripts), consumed by
 * runWorkflowSuite.mjs. Each entry lists the compiled `out/test` files the
 * suite executes — or `discover: true` for the full recursive unit sweep.
 *
 * §11.2: required suites fail when they discover zero tests — the runner
 * enforces both "every named file exists" and "the run executed at least
 * one test", so a renamed/deleted test file breaks its suite instead of
 * silently shrinking it.
 */
export const SUITES = {
  // ── §3.2/§3.3 runner + provider machinery ────────────────────────────────
  "runner-output-capture": {
    files: [
      "agentExecutionBrokerV1.test.js",
      "boundedResultStoreV1.test.js",
      "cliStdoutResultCaptureV1.test.js",
      "cliTextTransportV1.test.js",
    ],
  },
  "provider-reservations": {
    files: ["providerSelectionPolicyV1.test.js", "runnerRegistryV1Selection.test.js"],
  },
  correlation: {
    files: ["taskActionRegistryV1.test.js", "taskActionCoordinatorV1.test.js"],
  },
  "resume-semantics": {
    files: ["actionConversationOrchestratorV1.test.js"],
  },
  "runner-v1-cutover": {
    files: [
      "runnerRegistryV1Selection.test.js",
      "runnerRegistry.test.js",
      "copilotImplementationRunnerHostCapability.test.js",
      "languageModelToolSessionV1.test.js",
    ],
  },
  "vscode-lm-compat": {
    files: ["vscodeLmCompat.test.js"],
  },
  // ── Gates + activation order ─────────────────────────────────────────────
  "legacy-action-gates": {
    files: ["legacyAiActionSafetyGateV0.test.js", "legacyAiActionSafetyGateWiring.test.js"],
  },
  "runtime-gates": {
    files: [
      "legacyAiActionSafetyGateV0.test.js",
      "legacyAiActionSafetyGateWiring.test.js",
      "chatResetNoDocumentStorageGate.test.js",
      "completionLintRunGuards.test.js",
      "commitAndPushPublishGate.test.js",
    ],
  },
  "creation-startup-gate": {
    files: ["taskCreationStartupReconcilerV1.test.js"],
  },
  "activation-order": {
    files: ["taskCreationStartupReconcilerWiring.test.js"],
  },
  // ── Envelope, schemas, outcomes, prompts ─────────────────────────────────
  "result-envelope": {
    files: ["aiResultEnvelope.test.js", "chatFileUpdateEnvelope.test.js"],
  },
  "completed-content-schemas": {
    files: [
      "aiResultEnvelope.test.js",
      "draftRowV1.test.js",
      "generatePlanRowV1.test.js",
      "text3CohortRowsV1.test.js",
      "editPreflightContractV1.test.js",
    ],
  },
  "coordinator-outcomes": {
    files: ["taskActionCoordinatorV1.test.js"],
  },
  "prompt-contracts": {
    files: ["providerCliContracts.test.js", "completionLintPrompt.test.js", "contextPackTestMapping.test.js"],
  },
  // ── Text actions ─────────────────────────────────────────────────────────
  "generate-plan": {
    files: ["generatePlanRowV1.test.js"],
  },
  "draft-document": {
    files: ["draftRowV1.test.js", "draftTaskWithAI.test.js", "draftTaskWithAICommand.test.js"],
  },
  "generate-implementation": {
    files: ["text3CohortRowsV1.test.js"],
  },
  "stage-lifecycle": {
    files: [
      "nextStageRowV1.test.js",
      "markTaskDoneRowV1.test.js",
      "lifecyclePolicyRejection.test.js",
      "taskProgressFieldPolicyV1.test.js",
      "completedTaskResume.test.js",
      "resumeTaskRowV1.test.js",
    ],
  },
  // ── Chat ─────────────────────────────────────────────────────────────────
  "chat-transactions": {
    files: ["chatInteractionTransactionStoreV1.test.js"],
  },
  "chat-migration": {
    files: ["chatHistoryStore.test.js"],
  },
  "legacy-chat-conversion": {
    files: ["chatHistoryStore.test.js"],
  },
  "chat-limits": {
    files: ["chatHistoryStore.test.js"],
  },
  "chat-limit-recovery": {
    files: [
      "chatInteractionAnswerAndResetReconciliation.test.js",
      "chatInteractionOrphanReconciliation.test.js",
    ],
  },
  "chat-exclusions": {
    files: ["contextPackPrivacyExclusion.test.js", "chatStageIsolation.test.js", "metaGitIgnore.test.js"],
  },
  // ── Creation recovery ────────────────────────────────────────────────────
  "creation-recovery": {
    files: ["taskCreationRecovery.test.js"],
  },
  "creation-adoption": {
    files: ["taskCreationIntentV1.test.js", "taskCreationIntentStoreV1.test.js"],
  },
  "creation-contributions": {
    files: ["stage3ActionMatrix.test.js"],
  },
  "creation-startup-reconcile": {
    files: ["taskCreationStartupReconcilerV1.test.js", "taskCreationStartupReconcilerWiring.test.js"],
  },
  "creation-crash": {
    files: ["taskCreationRecovery.test.js", "taskCreationStartupReconcilerV1.test.js"],
  },
  "creation-delete-recovery": {
    files: ["taskCreationRecovery.test.js"],
  },
  // ── Progress stack ───────────────────────────────────────────────────────
  "progress-recovery-inventory": {
    files: ["taskProgressDiscoveryV1.test.js", "taskProgressReaderV1.test.js", "taskProgressWriterV1.test.js"],
  },
  "menu-contributions": {
    files: ["stage3ActionMatrix.test.js", "taskTreeProvider.test.js"],
  },
  // ── §7 edit protocol ─────────────────────────────────────────────────────
  "read-tool-contract": {
    files: ["editReadToolContractV1.test.js"],
  },
  "preflight-contract": {
    files: ["editPreflightContractV1.test.js", "canonicalJsonV1.test.js"],
  },
  "edit-preconditions": {
    files: ["editPreconditionsV1.test.js"],
  },
  "mutation-call-contract": {
    files: ["editMutationCallContractV1.test.js"],
  },
  "edit-execution-script": {
    files: ["editExecutionScriptV1.test.js"],
  },
  "edit-receipt-contract": {
    files: ["editReceiptContractV1.test.js"],
  },
  "edit-recovery": {
    files: ["editRecoveryV1.test.js", "runEditActionV1.test.js"],
  },
  // ── Commit/Push ──────────────────────────────────────────────────────────
  "commit-push-guard": {
    files: [
      "commitAndPushDuplicateGuard.test.js",
      "commitAndPushPublishGate.test.js",
      "commitAndPushIndexGuard.test.js",
    ],
  },
  "commit-push-privacy": {
    files: ["commitAndPushPorcelain.test.js", "commitAndPushIndexGuard.test.js", "runLogPrivacyGuard.test.js"],
  },
  // ── Broad sweeps ─────────────────────────────────────────────────────────
  unit: { discover: true },
  integration: {
    files: [
      "operationLifecycleIntegration.test.js",
      "redoCommandIntegration.test.js",
      "startNewTaskLifecycle.test.js",
      "completedTaskResume.test.js",
      "taskLifecycleArchivePin.test.js",
      "publishScope.test.js",
      "nextStageAutoReviewCommandChain.test.js",
    ],
  },
  acceptance: {
    files: [
      "automationChain.test.js",
      "completeAndMoveOnFastForward.test.js",
      "commandArgNormalization.test.js",
      "stage3ActionMatrix.test.js",
      "operationCoverage.test.js",
      "publishOwnershipMatrix.test.js",
    ],
  },
  "host-fs": {
    files: [
      "pathSafety.test.js",
      "workflowPathSafetyV1.test.js",
      "workflowFileStoreV1.test.js",
      "workflowLeaseStoreV1.test.js",
      "taskStateStoreLocking.test.js",
      "metaGitIgnore.test.js",
    ],
  },
};
