/**
 * Where Ensemble asks the user something (owner rule, 2026-10-26, which
 * narrows the 2026-09-29 "everything in the chat" rule):
 *
 *  - A question the workflow itself raises (a round, a review, automation)
 *    is asked in the chat panel and awaited there.
 *  - A picker, search box, filter, rename, or "are you sure?" for something
 *    the user just clicked in this window stays a pop-up (QuickPick, input
 *    box, modal). Moving those into the chat made every search and filter a
 *    round trip through a chat card.
 *
 * This pins both halves for the call sites the 2026-10-25 conversion touched.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const SRC = path.resolve(__dirname, "..", "..", "src");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), "utf8");
}

void describe("workflow questions are asked in chat", () => {
  const inChat: Array<{ file: string; decisionKeys: readonly string[] }> = [
    { file: "commands/chatWithStage.ts", decisionKeys: ["confirmBlockerSupersessionEdit"] },
    { file: "commands/settleChecklistItem.ts", decisionKeys: ["settleChecklistPickItem", "settleChecklistPickMode"] },
    { file: "utils/promptSizeGuard.ts", decisionKeys: ["confirmLargePromptSize"] },
    { file: "commands/runLintingFixes.ts", decisionKeys: ["confirmNonGitLintingFixes", "confirmDirtyWorkspaceLintingFixes"] },
    // Answering a review-failure card leads here, and on the cloud box that
    // answer runs on the runner, where a picker would open unseen.
    { file: "commands/retryReviewWithBackupV1.ts", decisionKeys: ["chooseReviewRetryModel"] },
    // The assistant proposed the action in the chat (relayed to the runner on
    // the cloud box), so its confirmation is answered there too.
    { file: "utils/globalAssistantActions.ts", decisionKeys: ["confirmGlobalAssistantAction"] },
    // Raised at activation or by automation (on the cloud box, on the
    // unattended runner), not by a click in this window.
    { file: "utils/resolveTaskContext.ts", decisionKeys: ["resolveTaskWorkspaceOwnership", "bindTaskWorkspaceFolder"] },
    { file: "utils/metaResourcesMigration.ts", decisionKeys: ["offerMetaResourcesMigration"] },
  ];

  for (const { file, decisionKeys } of inChat) {
    void it(`${file} asks its workflow question in chat`, () => {
      const source = read(file);
      assert.doesNotMatch(source, /vscode\.window\.showQuickPick/);
      assert.doesNotMatch(source, /vscode\.window\.showInputBox/);
      assert.match(source, /askChatChoiceV1/);
      for (const decisionKey of decisionKeys) {
        assert.ok(source.includes(decisionKey), `${decisionKey} must be asked in the chat`);
      }
    });
  }

  void it("handoffChecksV1.ts asks for the owner's evidence as free text in chat", () => {
    const source = read("commands/handoffChecksV1.ts");
    assert.doesNotMatch(source, /vscode\.window\.showInputBox/);
    assert.match(source, /askChatFreeTextV1/);
  });

  void it("Publish Checks ask for a replacement scope in chat; the command itself uses a picker", () => {
    const source = read("commands/choosePublishScope.ts");
    assert.ok(source.includes('"choosePublishVerificationScope"'));
    assert.match(source, /vscode\.window\.showQuickPick/);
  });

  void it("reviewActions.ts asks its workflow choices in chat", () => {
    const source = read("commands/reviewActions.ts");
    assert.doesNotMatch(source, /vscode\.window\.showQuickPick/);
    assert.ok(source.includes('"viewReviewMissingArtifact"'));
    assert.ok(source.includes('"confirmNonGitImplementation"'));
    assert.ok(source.includes('"confirmDirtyWorkspaceImplementation"'));
  });

  void it("copilotImplementationRunner.ts asks to continue past its round limit in chat", () => {
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

void describe("pickers, search, filters and confirmations stay pop-ups", () => {
  const popUps: Array<{ file: string; call: RegExp }> = [
    { file: "commands/viewArtifacts.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "commands/openRetainedPromptV1.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "commands/setTaskStage.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "utils/reopenTask.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "utils/pickTaskFolder.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "commands/startNewTask.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "views/taskTreeProvider.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "views/statusView.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "views/taskStatusBar.ts", call: /vscode\.window\.showQuickPick/ },
    { file: "commands/renameTask.ts", call: /vscode\.window\.showInputBox/ },
    { file: "commands/scheduleTaskResume.ts", call: /vscode\.window\.showInputBox/ },
    { file: "commands/viewStageChanges.ts", call: /vscode\.window\.showWarningMessage/ },
    { file: "commands/releaseStuckAdmissionMarkers.ts", call: /vscode\.window\.showWarningMessage/ },
    { file: "commands/taskCreationRecovery.ts", call: /vscode\.window\.showWarningMessage/ },
    { file: "utils/aiConsent.ts", call: /vscode\.window\.showWarningMessage/ },
    { file: "views/settingsView.ts", call: /vscode\.window\.showWarningMessage/ },
    { file: "views/chatView.ts", call: /vscode\.window\.showWarningMessage/ },
  ];

  for (const { file, call } of popUps) {
    void it(`${file} uses a pop-up, not a chat card`, () => {
      const source = read(file);
      assert.match(source, call);
      assert.doesNotMatch(source, /askChatChoiceV1/);
      assert.doesNotMatch(source, /askChatFreeTextV1/);
    });
  }

  void it("settings.ts: the workspace-settings question at activation is in chat; turning on auto-implement is a modal", () => {
    const source = read("config/settings.ts");
    assert.ok(source.includes('"reconcileWorkspaceSettings"'));
    assert.match(source, /Automatically implement will make real code and file changes after an approved review\. Use it only with continuous human supervision\.",\s*\{ modal: true \}/);
  });

  void it("extension.ts searches with input boxes and picks runner actions with a QuickPick", () => {
    const source = read("extension.ts");
    assert.match(source, /vscode\.window\.showInputBox\(\{\s*title: "Search tasks"/);
    assert.match(source, /vscode\.window\.showInputBox\(\{\s*title: "Search notifications"/);
    assert.match(source, /placeHolder: "Run on the runner for the current task"/);
    assert.doesNotMatch(source, /askChatFreeTextV1/);
    assert.doesNotMatch(source, /"runOnRunnerAction"/);
  });

  void it("extension.ts asks about an interrupted revert found at startup in chat, not a modal", () => {
    // Raised by activation, not a click, and on the cloud box it runs on the
    // runner, where a modal would sit unseen.
    const source = read("extension.ts");
    assert.ok(source.includes('"recoverInterruptedRevertJournal"'));
    assert.doesNotMatch(source, /"Complete Revert",\s*"Keep Current File"\s*\)/);
  });
});
