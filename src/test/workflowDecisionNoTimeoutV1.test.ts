/**
 * bugs3 Step 17: a confirmation the owner asked for (Commit & Push) is not
 * withdrawn unanswered after 10 minutes when it opts out of the timeout; every
 * other awaited card keeps the timeout and reports it as a timeout.
 */
import * as assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type * as vscode from "vscode";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { awaitWorkflowDecisionOutcomeV1, type PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";
import type { ChatTarget } from "../views/chatView";

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

const target: ChatTarget = { canonicalId: "/task-nt", taskFolderPath: "/task-nt", stage: "publish" };

function input(decisionId: string): PostWorkflowDecisionInputV1 {
  return {
    decisionId,
    decisionKey: "commitPushFinalScopeConfirmation",
    taskCanonicalId: "/task-nt",
    stage: "publish" as const,
    whatHappened: "Confirm what will be committed.",
    whyUserNeeded: "Nothing is committed until you confirm.",
    options: [
      { optionId: "go", label: "Commit & Push", consequence: "Commits.", resumeKind: "continue" as const, effect: { kind: "doNothing" as const } },
    ],
    recommendation: { kind: "none" as const, reasoning: "Your call." },
    gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "Continues or cancels this run." },
  };
}

const TEN_MINUTES = 10 * 60 * 1000;

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

void describe("awaited decision timeout opt-out (bugs3 Step 17)", () => {
  void it("by default a card nobody answers is dismissed as timed out after 10 minutes", async () => {
    const context = { workspaceState: new FakeMemento() as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
    __extensionContextV1TestOnly.set(context);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const outcome = awaitWorkflowDecisionOutcomeV1(input("d-default"), target);
      await settleMicrotasks();
      mock.timers.tick(TEN_MINUTES);
      assert.equal((await outcome).kind, "timedOut");
    } finally {
      mock.timers.reset();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("with noTimeout the card is still pending long after 10 minutes and is answered normally", async () => {
    const context = { workspaceState: new FakeMemento() as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
    __extensionContextV1TestOnly.set(context);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const outcome = awaitWorkflowDecisionOutcomeV1(input("d-open"), target, undefined, { noTimeout: true });
      await settleMicrotasks();
      mock.timers.tick(TEN_MINUTES * 3);
      await settleMicrotasks();
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      assert.equal(store.get("d-open")?.state, "pending", "the owner was away; the card is still there");
      assert.equal((await store.resolve("d-open", "go")).kind, "resolved");
      const settled = await outcome;
      assert.deepEqual(settled, { kind: "answered", optionId: "go" });
    } finally {
      mock.timers.reset();
      __extensionContextV1TestOnly.reset();
    }
  });
});
