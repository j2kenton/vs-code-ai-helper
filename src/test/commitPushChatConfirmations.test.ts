/**
 * Owner rule (2026-09-29): every question Ensemble asks is asked in the chat
 * panel, never a pop-up, and a notification's only button opens the chat —
 * it never starts work itself. This pins the Commit & Push and Release
 * conversions:
 *
 * - Commit & Push's confirmations are `awaitWorkflowDecisionAnswerV1`
 *   decisions (the flow still awaits and branches in-process), with no
 *   `vscode.window.showInformationMessage`/`showWarningMessage` modal left.
 * - Release's confirmation is a chat decision too.
 * - The "Publish Anyway" notification nudges attach an
 *   `offerActionInChatV1` pointer instead of dispatching Commit & Push.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const SRC = path.resolve(__dirname, "..", "..", "src");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), "utf8");
}

void describe("Commit & Push and Release ask in chat, never in a pop-up", () => {
  void it("Commit & Push has no modal showMessage call left and answers through chat decisions", () => {
    const source = read("commands/commitAndPushTask.ts");
    assert.doesNotMatch(source, /vscode\.window\.showInformationMessage/);
    assert.doesNotMatch(source, /vscode\.window\.showWarningMessage/);
    assert.match(source, /awaitWorkflowDecisionAnswerV1/);
    for (const decisionKey of [
      "commitPushReviewMessage",
      "commitPushCompletionChecksFailed",
      "commitPushExistingStagedChanges",
      "commitPushIncludeTaskFolder",
      "commitPushIncludeRunArtifacts",
      "commitPushFinalScopeConfirmation",
    ]) {
      assert.ok(source.includes(decisionKey), `${decisionKey} must be asked in the chat`);
    }
  });

  void it("Release confirms through a chat decision", () => {
    const source = read("commands/reviewActions.ts");
    assert.match(source, /decisionKey: "runReleaseConfirmation"/);
    assert.match(source, /if \(releaseChoice !== "runRelease"\)/);
    assert.doesNotMatch(source, /showWarningMessage\(`Run release\?/);
  });

  void it("Publish Anyway notification buttons only open the chat offer", () => {
    for (const file of ["commands/reviewActions.ts", "commands/setTaskStage.ts"]) {
      const source = read(file);
      assert.ok(
        source.includes('actionLabel: "Publish Anyway"'),
        `${file} must post the Publish Anyway action as a chat offer`
      );
    }
    const allowlist = JSON.parse(read("../scripts/toastAllowlistV1.json")) as {
      directActionEntries: { file: string; snippet: string }[];
    };
    assert.equal(
      allowlist.directActionEntries.filter((entry) => entry.snippet.includes("commitAndPushTask")).length,
      0,
      "no notification may dispatch Commit & Push directly"
    );
    assert.equal(
      allowlist.directActionEntries.filter((entry) =>
        entry.snippet.includes("completeStageAnywayV1") ||
        entry.snippet.includes("markTaskDone") ||
        entry.snippet.includes("takeOverStaleWorkAdmission") ||
        entry.snippet.includes("resumeAndDispatchImplementation") ||
        entry.snippet.includes("restoreRejectedImplementationRound") ||
        entry.snippet.includes("completeStageAnyway") ||
        entry.snippet.includes("fastForwardReviewWithAI")
      ).length,
      0,
      "completeStageAnywayV1, markTaskDone, takeOverStaleWorkAdmission, resumeAndDispatchImplementation, and restoreRejectedImplementationRound must not be direct notification actions"
    );
  });
});
