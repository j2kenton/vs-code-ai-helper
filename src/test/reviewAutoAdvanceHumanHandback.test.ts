import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  offerCompleteStageAndMoveOnInChatV1,
  offerCompletedImplementationReviewInChatV1,
  routeAutomaticReviewAfterAdvanceV1,
  routeAutomaticPublishReviewAfterFreshnessV1,
  warnHandOverNotStartedV1,
} from "../commands/reviewActions";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { TaskProgress } from "../types/taskProgress";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-handback-"));
after(() => safeRemoveDir(ROOT));

function makeMemento(): vscode.Memento {
  const backing = new Map<string, unknown>();
  return {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => backing.has(key) ? backing.get(key) as T : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) {
        backing.delete(key);
      } else {
        backing.set(key, value);
      }
      return Promise.resolve();
    },
  } as vscode.Memento;
}

function makeTask(): string {
  const dir = path.join(ROOT, "task");
  fs.mkdirSync(dir, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: "task",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(dir),
  };
  fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify(progress), "utf8");
  return dir;
}

void describe("automatic review advancement hand-back", () => {
  void it("posts the completed Implementation review action with the actual optional decision", async () => {
    const dir = makeTask();
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    initNotificationRouter({ addEntry: () => undefined });
    const fsBridge = vscode.workspace.fs as unknown as { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
    const previousReadFile = fsBridge.readFile;
    fsBridge.readFile = (uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath).then((b) => new Uint8Array(b));
    try {
      await offerCompletedImplementationReviewInChatV1(vscode.Uri.file(dir), "task");
      await offerCompletedImplementationReviewInChatV1(vscode.Uri.file(dir), "task");
      const decisions = new WorkflowDecisionStoreV1(memento).listPending(dir)
        .filter((item) => item.decisionKey === "chatActionOffer:runReviewWithAI");
      assert.equal(decisions.length, 1, "repeated completion hand-backs update the existing decision");
      const decision = decisions[0];
      assert.ok(decision);
      assert.match(decision.whatHappened, /Implementation finished and no review was started automatically/);
      assert.deepEqual(decision.options.map((option) => option.label), ["Run Review", "Not now"]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(decision.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.runReviewWithAI",
        args: [{ taskFolderPath: dir }],
      });
    } finally {
      fsBridge.readFile = previousReadFile;
      deactivateNotificationRouter();
    }
  });

  void it("posts the stage action to task chat when an automatic hand-over is declined", async () => {
    const dir = makeTask();
    const memento = makeMemento();
    const context = {
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext;
    __extensionContextV1TestOnly.set(context);
    initNotificationRouter({ addEntry: () => undefined });
    const fsBridge = vscode.workspace.fs as unknown as { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
    const previousReadFile = fsBridge.readFile;
    fsBridge.readFile = (uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath).then((b) => new Uint8Array(b));
    try {
      await warnHandOverNotStartedV1(vscode.Uri.file(dir), "task", "impl", "declined", "implementation");
      await warnHandOverNotStartedV1(vscode.Uri.file(dir), "task", "impl", "declined", "implementation");
      await offerCompleteStageAndMoveOnInChatV1(
        vscode.Uri.file(dir),
        "The automatic stage advance stopped because the plan is missing.",
        "task"
      );
      await offerCompleteStageAndMoveOnInChatV1(
        vscode.Uri.file(dir),
        "The automatic stage advance stopped because the plan is missing.",
        "task"
      );
      const decisions = new WorkflowDecisionStoreV1(memento).listPending().filter((item) => item.decisionKey.startsWith("chatActionOffer:"));
      const decision = decisions.find((item) => item.options.some((option) => option.label === "Run Implementation"));
      assert.ok(decision, "the hand-back decision is present in task chat");
      assert.equal(
        decisions.filter((item) => item.options.some((option) => option.label === "Run Implementation")).length,
        1,
        "a repeated terminal hand-back updates one stable decision"
      );
      assert.match(decision.whatHappened, /auto-advance reached Implementation, but its Implementation round did not start because the queued command returned without starting a round but did not provide its refusal reason/);
      assert.deepEqual(decision.options.map((option) => option.label), ["Run Implementation", "Not now"]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.equal(decision.options.find((option) => option.optionId === "runAction")?.label, "Run Implementation");
      assert.deepEqual(
        decision.options.find((option) => option.optionId === "runAction")?.effect,
        { kind: "command", command: "vs-code-ai-helper.runImplementationWithAI", args: [{ taskFolderPath: dir }] }
      );
      const advanceDecisions = decisions.filter((item) => item.options.some((option) => option.label === "Complete Stage & Move On"));
      assert.equal(advanceDecisions.length, 1, "repeated transition failures update one recovery card");
      const advanceDecision = advanceDecisions[0];
      assert.ok(advanceDecision, "the automatic advance hand-back is also posted in task chat");
      assert.match(advanceDecision.whatHappened, /The automatic stage advance stopped because the plan is missing/);
      assert.deepEqual(advanceDecision.options.map((option) => option.label), ["Complete Stage & Move On", "Not now"]);
      assert.equal(advanceDecision.recommendation.kind === "option" ? advanceDecision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(
        advanceDecision.options[0]?.effect,
        { kind: "command", command: "vs-code-ai-helper.nextStage", args: [{ taskFolderPath: dir }] }
      );
      assert.deepEqual(advanceDecision.options[1]?.effect, { kind: "doNothing" });
    } finally {
      fsBridge.readFile = previousReadFile;
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("offers automatic follow-up drops and declines in task chat", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");
    assert.match(source, /variables\.automationDispatch = "true"/);
    assert.match(
      source,
      /onDropped: \(reason\) => \{[\s\S]*?void warnHandOverNotStartedV1\(folderUri, handOverDisplayName, next, reason, "implementation"\)/
    );
    assert.match(
      source,
      /onDeclined: \(\) => \{[\s\S]*?void warnHandOverNotStartedV1\(folderUri, handOverDisplayName, next, "declined", "implementation"\)/
    );
    assert.match(
      source,
      /onDropped: \(reason\) => \{[\s\S]*?void warnHandOverNotStartedV1\(folderUri, handOverDisplayName, next, reason\)/
    );
    assert.match(
      source,
      /onDeclined: \(\) => \{[\s\S]*?void warnHandOverNotStartedV1\(folderUri, handOverDisplayName, next, "declined"\)/
    );
    assert.match(
      source,
      /export async function warnHandOverNotStartedV1\([\s\S]*?await offerActionInChatV1\([\s\S]*?actionLabel,[\s\S]*?command,[\s\S]*?noticeText/
    );
  });

  void it("offers the automatic advance action even when a user started the review", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");
    assert.match(
      source,
      /if \(!isPublishReview\) \{\s*await offerCompleteStageAndMoveOnInChatV1\(/
    );
    assert.match(
      source,
      /Review score reached the auto-advance threshold, but there is no plan to promote\. Write or generate a plan, then advance to Implementation\./
    );
    assert.match(
      source,
      /automatic stage advance stopped: \$\{message\}\./
    );
    assert.match(source, /if \(!automaticImplementationScheduled && next === "impl"\)[\s\S]*?actionLabel: "Run Implementation"[\s\S]*?offerActionInChatV1/);
    assert.match(source, /if \(!isGit && isAutomationDispatchContextV1\(\)\)[\s\S]*?Run Implementation from Chat to confirm[\s\S]*?actionLabel: "Run Implementation"/);
    assert.doesNotMatch(source, /if \(variables\.automationDispatch === "true"\) \{\s*await offerActionInChatV1\(\{[\s\S]{0,350}no plan to promote/);
    assert.doesNotMatch(source, /if \(next !== "publish"\) \{\s*void warnHandOverNotStartedV1/);
  });

  void it("puts stale-check automatic Publish advancement in task chat", async () => {
    const dir = makeTask();
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const fsBridge = vscode.workspace.fs as unknown as { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
    const previousReadFile = fsBridge.readFile;
    fsBridge.readFile = (uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath).then((b) => new Uint8Array(b));
    initNotificationRouter({ addEntry: () => undefined });
    try {
      let freshnessRead = false;
      const route = {
        folderUri: vscode.Uri.file(dir),
        nextStage: "publish",
        transitionShouldAutoReview: true,
        autoAdvanceMode: "auto",
        readPublishFreshnessStatus: () => {
          freshnessRead = true;
          return Promise.resolve("staleCommit" as const);
        },
      } as const;
      assert.equal(await routeAutomaticReviewAfterAdvanceV1(route), true);
      assert.equal(await routeAutomaticReviewAfterAdvanceV1(route), true);
      assert.equal(freshnessRead, true, "the automatic advance branch checks Publish freshness");
      const matching = new WorkflowDecisionStoreV1(memento).listPending().filter((item) =>
        item.decisionKey === "chatActionOffer:runPublishChecks"
      );
      assert.equal(matching.length, 1, "repeated stale-review hand-backs update one chat decision");
      const decision = matching[0];
      assert.ok(decision);
      assert.match(decision.whatHappened, /Run Publish Checks, then Review/);
      assert.deepEqual(decision.options.map((option) => option.label), ["Run Publish Checks", "Not now"]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.equal(decision.options.find((option) => option.optionId === "runAction")?.label, "Run Publish Checks");
      assert.deepEqual(
        decision.options.find((option) => option.optionId === "runAction")?.effect,
        { kind: "command", command: "vs-code-ai-helper.runPublishChecks", args: [{ taskFolderPath: dir }] }
      );
    } finally {
      fsBridge.readFile = previousReadFile;
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("does not post a Publish Checks hand-back when automatic review evidence is fresh", async () => {
    const dir = makeTask();
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    initNotificationRouter({ addEntry: () => undefined });
    try {
      assert.equal(await routeAutomaticPublishReviewAfterFreshnessV1(vscode.Uri.file(dir), "valid"), false);
      assert.equal(new WorkflowDecisionStoreV1(memento).listPending().length, 0);
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });
});
