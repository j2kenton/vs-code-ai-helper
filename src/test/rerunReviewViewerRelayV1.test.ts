/**
 * bugs6 item 32 (Step 9, 11): "Review again anyway" answered in a viewer is relayed to the runner once, never run
 * locally; a failed relay says so in the chat with the next click; a review an owner's answer started that returns
 * without dispatching writes a chat line.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  __resetRerunAnswersForTestV1,
  describeRerunNotRelayedV1,
  rerunReviewAfterUnchangedTreeCardV1,
  RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1,
  type RerunReviewDepsV1,
} from "../commands/rerunReviewAfterUnchangedTreeCardV1";
import { describeOwnerAnswerReviewNotStartedV1, runReviewForFolder } from "../commands/reviewActions";
import { decodeRelayedCommandArgV1, RELAYABLE_COMMAND_IDS_V1 } from "../services/viewerForwardingV1";
import { CHAT_HISTORY_FILENAME, readChatHistory } from "../utils/chatHistoryStore";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { recordStageActionRefusalReasonV1, clearStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

configureWorkflowPrivateStorageRootV1(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-rerun-relay-private-")));

const KEY = "0123456789abcdef0123456789abcdef:reviewAgainAnyway";

function makeDeps(overrides: Partial<RerunReviewDepsV1> & { forwardCalls?: unknown[][]; said?: string[] } = {}): {
  deps: RerunReviewDepsV1;
  forwardCalls: unknown[][];
  said: string[];
} {
  const forwardCalls = overrides.forwardCalls ?? [];
  const said = overrides.said ?? [];
  const deps: RerunReviewDepsV1 = {
    isViewer: overrides.isViewer ?? (() => true),
    forward:
      overrides.forward ??
      ((...args) => {
        forwardCalls.push(args);
        return Promise.resolve({ ok: true });
      }),
    say: overrides.say ?? ((_folder, _stage, text) => {
      said.push(text);
      return Promise.resolve();
    }),
  };
  return { deps, forwardCalls, said };
}

void describe("bugs6 item 32: the viewer relays 'Review again anyway' to the runner", () => {
  beforeEach(() => __resetRerunAnswersForTestV1());

  void it("the command is relayable, and the relay decodes only the stage and the answer key", () => {
    assert.ok(RELAYABLE_COMMAND_IDS_V1.has(RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1));
    assert.deepEqual(
      decodeRelayedCommandArgV1(RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1, {
        stage: "impl-low-review",
        answerKey: KEY,
        automationDispatch: true,
      }),
      { stage: "impl-low-review", answerKey: KEY }
    );
    assert.deepEqual(
      decodeRelayedCommandArgV1(RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1, { stage: "nope", answerKey: "../x" }),
      {}
    );
  });

  void it("a viewer sends the answer to the runner exactly once and runs nothing locally", async () => {
    const { deps, forwardCalls } = makeDeps();
    const input = { taskFolderPath: "/ws/.ensemble/2026-11-02_task_1", stage: "impl-low-review" as const, answerKey: KEY };
    await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file("/ext"), input, undefined, deps);
    await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file("/ext"), input, undefined, deps);
    assert.equal(forwardCalls.length, 1, "the same answer is relayed once");
    assert.deepEqual(forwardCalls[0], [
      RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1,
      "/ws/.ensemble/2026-11-02_task_1",
      { stage: "impl-low-review", answerKey: KEY },
    ]);
  });

  void it("when the runner cannot be reached the chat says so, offers 'Run on Runner…', and the answer can be given again", async () => {
    const said: string[] = [];
    let calls = 0;
    const { deps } = makeDeps({
      said,
      forward: () => {
        calls += 1;
        return Promise.resolve({ ok: false });
      },
    });
    const input = { taskFolderPath: "/ws/.ensemble/t", stage: "impl-low-review" as const, answerKey: KEY };
    await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file("/ext"), input, undefined, deps);
    assert.equal(said.length, 1);
    assert.match(said[0] ?? "", /could not be sent to the runner/);
    assert.match(said[0] ?? "", /Ensemble: Run on Runner…/);
    await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file("/ext"), input, undefined, deps);
    assert.equal(calls, 2, "a refused relay released the key");
  });

  void it("an indeterminate relay tells the owner to check Notifications and does not allow a second run", async () => {
    const said: string[] = [];
    let calls = 0;
    const { deps } = makeDeps({
      said,
      forward: () => {
        calls += 1;
        return Promise.resolve({ ok: false, indeterminate: true });
      },
    });
    const input = { taskFolderPath: "/ws/.ensemble/t", stage: "impl-low-review" as const, answerKey: KEY };
    await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file("/ext"), input, undefined, deps);
    await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file("/ext"), input, undefined, deps);
    assert.equal(calls, 1);
    assert.match(said[0] ?? "", /has not said whether/);
    assert.equal(describeRerunNotRelayedV1("Implementation › Low-Level Code Review", true), said[0]);
  });
});

void describe("bugs6 item 32: an owner-started review that does not dispatch writes a chat line", () => {
  void it("the line names the reason and the next click", () => {
    const text = describeOwnerAnswerReviewNotStartedV1("the workspace has no tracked file set.", "Low-Level Code Review");
    assert.match(text, /Your answer asked for a Low-Level Code Review review, but none was started: the workspace has no tracked file set\./);
    assert.match(text, /Click Review on the Low-Level Code Review row to try again\./);
  });

  void it("runReviewForFolder with the owner-answer flag writes the line when it returns before dispatching; without the flag it stays silent", async () => {
    const { folder } = makeOwnedTaskFolder("ensemble-rerun-owner-answer-");
    try {
      clearStageActionRefusalReasonV1(folder);
      recordStageActionRefusalReasonV1(folder, "the review scope could not be established");
      const workspaceRoot = { uri: vscode.Uri.file(folder), name: "t", index: 0 } as vscode.WorkspaceFolder;
      // "desc" has no review target, so the function returns before it dispatches anything.
      await runReviewForFolder(vscode.Uri.file("/ext"), vscode.Uri.file(folder), workspaceRoot, "desc", true, {});
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false, "a plain click writes no chat line");
      await runReviewForFolder(vscode.Uri.file("/ext"), vscode.Uri.file(folder), workspaceRoot, "desc", true, {
        startedByOwnerAnswer: true,
      });
      const lines = (await readChatHistory(folder)).map((m) => m.text);
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /none was started: the review scope could not be established/);
    } finally {
      clearStageActionRefusalReasonV1(folder);
      safeRemoveDir(folder);
    }
  });
});
