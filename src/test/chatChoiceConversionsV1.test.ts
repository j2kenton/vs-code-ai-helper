/**
 * Owner rule (2026-09-29): every question Ensemble asks is asked in the chat
 * panel, never a QuickPick/input box/modal. This pins Part 2 Step 12's
 * conversion of review, recovery, retained-prompt and artifact choices:
 * each command awaits a chat decision and then continues its own operation
 * with the answer (the effect is `doNothing`, so no second command runs).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const SRC = path.resolve(__dirname, "..", "..", "src");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), "utf8");
}

void describe("Step 12 choices are asked in chat", () => {
  const converted: Array<{ file: string; decisionKeys: readonly string[] }> = [
    { file: "commands/viewArtifacts.ts", decisionKeys: ["viewTaskArtifact", "viewPlanArtifact"] },
    { file: "commands/openRetainedPromptV1.ts", decisionKeys: ["openRetainedPromptTask", "openRetainedPromptRound"] },
    { file: "commands/retryReviewWithBackupV1.ts", decisionKeys: ["chooseReviewRetryModel"] },
    { file: "commands/viewStageChanges.ts", decisionKeys: ["confirmRevertStageChanges", "confirmRedoStageChanges"] },
    { file: "commands/releaseStuckAdmissionMarkers.ts", decisionKeys: ["releaseStuckAdmissionMarkers"] },
    { file: "commands/chatWithStage.ts", decisionKeys: ["confirmBlockerSupersessionEdit"] },
    { file: "commands/settleChecklistItem.ts", decisionKeys: ["settleChecklistPickItem", "settleChecklistPickMode"] },
    {
      file: "commands/taskCreationRecovery.ts",
      decisionKeys: [
        "confirmRetryTaskCreation",
        "confirmAdoptAndRetryTaskCreation",
        "confirmSafeDeleteFailedTaskCreation",
      ],
    },
    { file: "utils/aiConsent.ts", decisionKeys: ["firstUseAiConsent"] },
    { file: "config/settings.ts", decisionKeys: ["reconcileWorkspaceSettings", "confirmAutoImplementAfterReview"] },
    { file: "views/settingsView.ts", decisionKeys: ["clearLeftoverTaskModelOverrides"] },
    { file: "utils/metaResourcesMigration.ts", decisionKeys: ["offerMetaResourcesMigration"] },
    { file: "utils/promptSizeGuard.ts", decisionKeys: ["confirmLargePromptSize"] },
    { file: "utils/resolveTaskContext.ts", decisionKeys: ["resolveTaskWorkspaceOwnership", "bindTaskWorkspaceFolder"] },
    { file: "utils/pickTaskFolder.ts", decisionKeys: ["pickTaskFolder"] },
    { file: "commands/runLintingFixes.ts", decisionKeys: ["confirmNonGitLintingFixes", "confirmDirtyWorkspaceLintingFixes"] },
    { file: "utils/reopenTask.ts", decisionKeys: ["pickReopenStage"] },
    { file: "utils/globalAssistantActions.ts", decisionKeys: ["confirmGlobalAssistantAction"] },
    { file: "views/taskTreeProvider.ts", decisionKeys: ["chooseTaskStatusFilter"] },
    { file: "views/statusView.ts", decisionKeys: ["chooseNotificationLevelFilter"] },
    { file: "views/taskStatusBar.ts", decisionKeys: ["taskStatusBarMenu"] },
  ];

  for (const { file, decisionKeys } of converted) {
    void it(`${file} has no pop-up picker and posts its choices in chat`, () => {
      const source = read(file);
      assert.doesNotMatch(source, /vscode\.window\.showQuickPick/);
      assert.doesNotMatch(source, /vscode\.window\.showInputBox/);
      assert.doesNotMatch(source, /vscode\.window\.showWarningMessage/);
      assert.match(source, /askChatChoiceV1/);
      for (const decisionKey of decisionKeys) {
        assert.ok(source.includes(decisionKey), `${decisionKey} must be asked in the chat`);
      }
    });
  }

  void it("handoffChecksV1.ts, renameTask.ts, and scheduleTaskResume.ts ask for free-text input in chat instead of an input box", () => {
    for (const file of ["commands/handoffChecksV1.ts", "commands/renameTask.ts", "commands/scheduleTaskResume.ts"]) {
      const source = read(file);
      assert.doesNotMatch(source, /vscode\.window\.showInputBox/);
      assert.match(source, /askChatFreeTextV1/);
    }
  });

  void it("reviewActions.ts asks resolveReviewActionTask, viewReviewMissingArtifact, confirmDiscardOwedImplRecovery, release target, and git safety choices in chat", () => {
    const source = read("commands/reviewActions.ts");
    assert.doesNotMatch(source, /vscode\.window\.showQuickPick/);
    assert.ok(source.includes('"resolveReviewActionTask"'));
    assert.ok(source.includes('"viewReviewMissingArtifact"'));
    assert.ok(source.includes('"confirmDiscardOwedImplRecovery"'));
    assert.ok(source.includes('"chooseReleaseTargetWorkspaceFolder"'));
    assert.ok(source.includes('"chooseReleaseTargetPackage"'));
    assert.ok(source.includes('"confirmNonGitImplementation"'));
    assert.ok(source.includes('"confirmDirtyWorkspaceImplementation"'));
  });

  void it("extension.ts, chatView.ts, and copilotImplementationRunner.ts route all remaining questions, filters, and confirmations to chat", () => {
    const extensionSource = read("extension.ts");
    assert.doesNotMatch(extensionSource, /vscode\.window\.showWarningMessage/);
    assert.doesNotMatch(extensionSource, /vscode\.window\.showQuickPick/);
    assert.doesNotMatch(extensionSource, /vscode\.window\.showInputBox/);
    assert.ok(extensionSource.includes('"recoverInterruptedRevertJournal"'));
    assert.ok(extensionSource.includes('"runOnRunnerAction"'));
    assert.match(extensionSource, /askChatFreeTextV1/);
    const chatViewSource = read("views/chatView.ts");
    assert.doesNotMatch(chatViewSource, /vscode\.window\.showWarningMessage/);
    assert.ok(chatViewSource.includes('"confirmResetChatHistory"'));
    const runnerSource = read("runners/copilotImplementationRunner.ts");
    assert.doesNotMatch(runnerSource, /vscode\.window\.showWarningMessage\(/);
    assert.ok(runnerSource.includes("resolveGlobalChatTargetOrDefaultV1"));
  });

  void it("the shared helper awaits the answer in-process and dispatches nothing itself", () => {
    const source = read("utils/chatChoiceV1.ts");
    assert.match(source, /awaitWorkflowDecisionAnswerV1/);
    assert.match(source, /effect: \{ kind: "doNothing" as const \}/);
    assert.match(source, /input\.target,\s*input\.token/);
    const lintFixes = read("commands/runLintingFixes.ts");
    assert.equal((lintFixes.match(/token: cancelToken/g) ?? []).length >= 2, true);
    assert.equal((lintFixes.match(/throwIfPublishChecksCancelledV1\(cancelToken\);/g) ?? []).length >= 2, true);
  });
});
