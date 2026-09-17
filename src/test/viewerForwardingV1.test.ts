/**
 * A viewer's action buttons forward to the runner (viewerForwardingV1.ts);
 * in every other host the wrapper is transparent.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { configureEnsembleHostRoleForTestV1 } from "../state/hostRoleV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import {
  configureViewerCommandForwarderV1,
  decodeRelayedCommandArgV1,
  forwardInViewerV1,
  forwardToRunnerV1,
  VIEWER_DECISION_EFFECT_COMMANDS_V1,
  RELAYABLE_COMMAND_IDS_V1,
  taskFolderPathFromCommandArgV1,
} from "../services/viewerForwardingV1";

void describe("viewerForwardingV1", () => {
  afterEach(() => {
    configureEnsembleHostRoleForTestV1(undefined);
    configureViewerCommandForwarderV1(undefined);
  });

  void it("is transparent in a standalone or runner host: the real handler runs with its arguments", () => {
    for (const role of ["standalone", "runner"] as const) {
      configureEnsembleHostRoleForTestV1(role);
      const seen: unknown[] = [];
      const wrapped = forwardInViewerV1("vs-code-ai-helper.runReviewWithAI", (arg?: { taskFolderPath?: string }) => {
        seen.push(arg);
        return "ran";
      });
      assert.equal(wrapped({ taskFolderPath: "/w/.ensemble/t1" }), "ran");
      assert.deepEqual(seen, [{ taskFolderPath: "/w/.ensemble/t1" }]);
    }
  });

  void it("in a viewer host the handler never runs: the command id and its task go to the forwarder", async () => {
    configureEnsembleHostRoleForTestV1("viewer");
    const forwarded: Array<[string, string | undefined]> = [];
    configureViewerCommandForwarderV1((commandId, taskFolderPath) => {
      forwarded.push([commandId, taskFolderPath]);
      return Promise.resolve(true);
    });
    let ran = false;
    const wrapped = forwardInViewerV1("vs-code-ai-helper.runReviewWithAI", (_arg?: unknown) => {
      ran = true;
    });
    // A tree row's argument shape.
    await wrapped({ task: { folderUri: { fsPath: "/w/.ensemble/t1" } } });
    // A bare (command palette) invocation: the forwarder falls back to the current task.
    await wrapped(undefined);
    assert.equal(ran, false);
    assert.deepEqual(forwarded, [
      ["vs-code-ai-helper.runReviewWithAI", "/w/.ensemble/t1"],
      ["vs-code-ai-helper.runReviewWithAI", undefined],
    ]);
  });

  void it("reads the task from every argument shape the workflow's commands receive", () => {
    assert.equal(taskFolderPathFromCommandArgV1({ task: { folderUri: { fsPath: "/a" } } }), "/a");
    assert.equal(taskFolderPathFromCommandArgV1({ taskFolderPath: "/b" }), "/b");
    assert.equal(taskFolderPathFromCommandArgV1({ canonicalId: "/c" }), "/c");
    for (const junk of [undefined, null, "x", 7, {}, { task: {} }, { taskFolderPath: "" }]) {
      assert.equal(taskFolderPathFromCommandArgV1(junk), undefined);
    }
  });

  void it("forwards one invocation directly, with the extra command argument (a chat send)", async () => {
    // With no runner connection it REPORTS and resolves false — it must never
    // reject, since a rejection from a webview handler is VS Code's raw
    // "Error running command" toast.
    const warnings: string[] = [];
    initNotificationRouter({ addEntry: (message) => void warnings.push(message) });
    try {
      assert.equal(await forwardToRunnerV1("vs-code-ai-helper.chatWithStage", "/t"), false);
      assert.match(warnings[0] ?? "", /no connection to the runner/);
    } finally {
      deactivateNotificationRouter();
    }
    const forwarded: unknown[] = [];
    configureViewerCommandForwarderV1((commandId, taskFolderPath, commandArg) => {
      forwarded.push([commandId, taskFolderPath, commandArg]);
      return Promise.resolve(true);
    });
    assert.equal(await forwardToRunnerV1("vs-code-ai-helper.chatWithStage", "/t", { stage: "plan", message: "why?" }), true);
    assert.deepEqual(forwarded, [["vs-code-ai-helper.chatWithStage", "/t", { stage: "plan", message: "why?" }]]);
    await assert.rejects(forwardToRunnerV1("vs-code-ai-helper.commitAndPushTask", "/t"), /RELAYABLE_COMMAND_IDS_V1/);
  });

  void it("only the fields a relayed command defines cross the boundary", () => {
    // The runner used to spread this straight into the command argument, so a
    // relay writer could set internal provenance fields.
    assert.deepEqual(
      decodeRelayedCommandArgV1("vs-code-ai-helper.chatWithStage", {
        message: "why?",
        stage: "impl-low-review",
        taskName: "Spacing",
        automationDispatch: true,
        admissionHandoffTokenV1: "stolen",
        task: { folderUri: { fsPath: "/elsewhere" } },
      }),
      { message: "why?", stage: "impl-low-review", taskName: "Spacing" }
    );
    assert.deepEqual(decodeRelayedCommandArgV1("vs-code-ai-helper.chatWithStage", { stage: "not-a-stage", message: "" }), {});
    assert.deepEqual(
      decodeRelayedCommandArgV1("vs-code-ai-helper.runImplementationWithAI", { automationDispatch: true, message: "x" }),
      {},
      "every other command takes nothing but its task"
    );
    for (const junk of [undefined, null, "x", 7, []]) {
      assert.deepEqual(decodeRelayedCommandArgV1("vs-code-ai-helper.chatWithStage", junk), {});
    }
  });

  void it("Commit & Push is not relayable, and its decision effect runs where the user is", () => {
    assert.equal(RELAYABLE_COMMAND_IDS_V1.has("vs-code-ai-helper.commitAndPushTask"), false);
    assert.equal(VIEWER_DECISION_EFFECT_COMMANDS_V1.has("vs-code-ai-helper.commitAndPushTask"), true);
    assert.equal(VIEWER_DECISION_EFFECT_COMMANDS_V1.has("vs-code-ai-helper.openAiModels"), true);
    assert.equal(
      VIEWER_DECISION_EFFECT_COMMANDS_V1.has("vs-code-ai-helper.resumeAndApplyCurrentStageAction"),
      false,
      "workflow work stays on the runner"
    );
  });

  void it("refuses to wrap a command the runner would not run", () => {
    assert.throws(() => forwardInViewerV1("workbench.action.terminal.sendSequence", () => undefined), /RELAYABLE_COMMAND_IDS_V1/);
    assert.ok(RELAYABLE_COMMAND_IDS_V1.has("vs-code-ai-helper.runReviewWithAI"));
    assert.equal(RELAYABLE_COMMAND_IDS_V1.has("vs-code-ai-helper.commitAndPushTask"), false, "it confirms with a modal nobody can click on the runner");
  });
});
