/**
 * bugs3 Steps 8 and 13: an awaited decision records the in-process waiter that
 * owns its answer, so a reload, a finished wait or a stale click is recognised
 * without a hand-kept list of decision keys.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  awaitWorkflowDecisionAnswerV1,
  awaitWorkflowDecisionOutcomeV1,
  dismissOrphanedAwaitedDecisionsV1,
  PostWorkflowDecisionInputV1,
} from "../utils/workflowDecisionDispatchV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { createWorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  ACTIVATION_ID_V1,
  isOrphanedAwaitedDecisionV1,
  registerAwaitedWaiterV1,
  releaseAwaitedWaiterV1,
} from "../utils/awaitedDecisionWaitersV1";
import { CHAT_HISTORY_FILENAME } from "../utils/chatHistoryStore";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { ChatTarget } from "../views/chatView";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

configureWorkflowPrivateStorageRootV1(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-awaited-private-storage-")));

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function fakeContext(): vscode.ExtensionContext {
  return { workspaceState: new FakeMemento() as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
}

const gating = { holdsTaskPaused: false, unblocksProgress: true, detail: "The run waits on this choice." };

function input(folder: string, decisionKey: string, decisionId: string): PostWorkflowDecisionInputV1 {
  return {
    decisionId,
    decisionKey,
    taskCanonicalId: folder,
    stage: "publish",
    whatHappened: "Choose the folder for Publish verification.",
    whyUserNeeded: "The checks need a scope.",
    restartGuidance: "Publish Checks were interrupted by a reload; run them again.",
    options: [
      { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue", effect: { kind: "doNothing" } },
    ],
    recommendation: { kind: "none", reasoning: "Your call." },
    gating,
  };
}

function tmpTaskFolder(): string {
  return makeOwnedTaskFolder("awaited-lifetime-").folder;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

void describe("awaited decision lifetime (bugs3 Step 13)", () => {
  void it("records its waiter, activation and restart guidance on any key, not only two hard-coded ones", async () => {
    const context = fakeContext();
    __extensionContextV1TestOnly.set(context);
    const folder = tmpTaskFolder();
    const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "publish" };
    const pending = awaitWorkflowDecisionAnswerV1(input(folder, "someBrandNewAwaitedKey", "d-1"), target);
    await tick();
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const record = store.get("d-1");
    assert.equal(record?.awaited?.activationId, ACTIVATION_ID_V1);
    assert.equal(record?.awaited?.taskFolderPath, folder);
    assert.equal(record?.awaited?.restartGuidance, "Publish Checks were interrupted by a reload; run them again.");
    assert.ok(record?.awaited?.waiterId);
    // A live waiter is not an orphan, so an activation-time sweep run now would keep it.
    assert.ok(record);
    assert.equal(isOrphanedAwaitedDecisionV1(record), false);

    const resolved = await store.resolve("d-1", "go");
    assert.equal(resolved.kind, "resolved");
    assert.equal(await pending, "go");
    assert.equal(store.get("d-1")?.completionReason, "answered");
  });

  void it("reports a cancelled wait as cancelled, never as an answer", async () => {
    const context = fakeContext();
    __extensionContextV1TestOnly.set(context);
    const folder = tmpTaskFolder();
    const source = new vscode.CancellationTokenSource();
    const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "publish" };
    const outcome = awaitWorkflowDecisionOutcomeV1(input(folder, "anotherKey", "d-2"), target, source.token);
    await tick();
    source.cancel();
    assert.deepEqual(await outcome, { kind: "cancelled" });
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    assert.equal(store.get("d-2")?.state, "dismissed");
    assert.equal(store.get("d-2")?.completionReason, "cancelled");
  });

  void it("reports an answer through the outcome with its option id", async () => {
    const context = fakeContext();
    __extensionContextV1TestOnly.set(context);
    const folder = tmpTaskFolder();
    const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "publish" };
    const outcome = awaitWorkflowDecisionOutcomeV1(input(folder, "answerKey", "d-3"), target);
    await tick();
    await new WorkflowDecisionStoreV1(context.workspaceState).resolve("d-3", "go");
    assert.deepEqual(await outcome, { kind: "answered", optionId: "go" });
  });

  void it("the activation sweep drops an awaited card whose waiter is gone and says how to run it again", async () => {
    const context = fakeContext();
    const folder = tmpTaskFolder();
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    // A card from a previous activation: its waiter id was never registered here.
    await store.post({
      decisionId: "d-4",
      decisionKey: "choosePublishVerificationScope",
      taskCanonicalId: folder,
      stage: "publish",
      whatHappened: "Choose the folder for Publish verification.",
      whyUserNeeded: "The checks need a scope.",
      options: [
        { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "Your call." },
      gating,
      awaited: {
        waiterId: "dead-waiter",
        activationId: "previous-activation",
        taskFolderPath: folder,
        restartGuidance: "Publish Checks were interrupted by a reload; run them again.",
      },
      createdAt: new Date().toISOString(),
    });
    // And a live one, still owned by this activation.
    const liveWaiter = registerAwaitedWaiterV1();
    await store.post({
      decisionId: "d-5",
      decisionKey: "aDifferentAwaitedKey",
      taskCanonicalId: folder,
      stage: "publish",
      whatHappened: "Pick something.",
      whyUserNeeded: "Needed.",
      options: [
        { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "Your call." },
      gating,
      awaited: { waiterId: liveWaiter, activationId: ACTIVATION_ID_V1, taskFolderPath: folder, restartGuidance: "Run it again." },
      createdAt: new Date().toISOString(),
    });
    try {
      assert.equal(await dismissOrphanedAwaitedDecisionsV1(context.workspaceState), 1);
      assert.equal(store.get("d-4")?.state, "dismissed");
      assert.equal(store.get("d-4")?.completionReason, "interrupted");
      assert.equal(store.get("d-5")?.state, "pending");
      const chat = fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8");
      assert.match(chat, /Publish Checks were interrupted by a reload; run them again\./);
    } finally {
      releaseAwaitedWaiterV1(liveWaiter);
    }
  });

  void it("refuses a late answer to an orphaned awaited card, saves nothing and names how to restart", async () => {
    const context = fakeContext();
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post({
      decisionId: "d-6",
      decisionKey: "chooseSomething",
      taskCanonicalId: "/task-z",
      stage: "publish",
      whatHappened: "Choose.",
      whyUserNeeded: "Needed.",
      options: [
        { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "Your call." },
      gating,
      awaited: {
        waiterId: "gone",
        activationId: "previous-activation",
        taskFolderPath: "/task-z",
        restartGuidance: "Choose Commit & Push again.",
      },
      createdAt: new Date().toISOString(),
    });
    const result = await store.resolve("d-6", "go");
    assert.deepEqual(result, { kind: "orphaned", restartGuidance: "Choose Commit & Push again." });
    assert.equal(store.get("d-6")?.state, "pending");
    assert.equal(store.get("d-6")?.resolvedOptionId, undefined);
  });

  void it("leaves a durable command-backed decision alone: no marker and no legacy awaited key", () => {
    const created = createWorkflowDecisionV1({
      decisionId: "d-7",
      decisionKey: "reconcilePlanChecklist",
      taskCanonicalId: "/task-z",
      stage: "impl",
      whatHappened: "x",
      whyUserNeeded: "y",
      options: [
        { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue", effect: { kind: "command", command: "ensemble.x" } },
      ],
      recommendation: { kind: "none", reasoning: "z" },
      gating,
      createdAt: new Date().toISOString(),
    });
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(isOrphanedAwaitedDecisionV1(created.decision), false);
    }
  });

  void it("treats a legacy record of a known awaited key as orphaned, and rejects a malformed marker", () => {
    const base = {
      decisionId: "d-8",
      taskCanonicalId: "/task-z",
      stage: "publish" as const,
      whatHappened: "x",
      whyUserNeeded: "y",
      options: [
        { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue" as const, effect: { kind: "doNothing" as const } },
      ],
      recommendation: { kind: "none" as const, reasoning: "z" },
      gating,
      createdAt: new Date().toISOString(),
    };
    const legacy = createWorkflowDecisionV1({ ...base, decisionKey: "confirmLargePromptSize" });
    assert.equal(legacy.ok && isOrphanedAwaitedDecisionV1(legacy.decision), true);
    const malformed = createWorkflowDecisionV1({
      ...base,
      decisionKey: "k",
      awaited: { waiterId: "", activationId: "a", taskFolderPath: "/t", restartGuidance: "r" },
    });
    assert.equal(malformed.ok, false);
    const noReference = createWorkflowDecisionV1({ ...base, decisionKey: "k", liveReference: { kind: "implementation-operation" } });
    assert.equal(noReference.ok, false);
    const withReference = createWorkflowDecisionV1({
      ...base,
      decisionKey: "k",
      liveReference: { kind: "implementation-operation", operationId: "op-1" },
    });
    assert.equal(withReference.ok && withReference.decision.liveReference?.operationId, "op-1");
  });
});
