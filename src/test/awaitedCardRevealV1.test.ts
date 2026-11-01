/**
 * bugs4 item 20 / Step 33: an awaited owner-waiting card (the path `choosePublishScope` and
 * `askChatChoiceV1` use) reveals the chat once, like a fire-and-forget card does.
 */
import * as assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type * as vscode from "vscode";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { awaitWorkflowDecisionOutcomeV1, type PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";
import { setChatRevealHandlerV1 } from "../views/chatRevealV1";
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

const target: ChatTarget = { canonicalId: "/task-rv", taskFolderPath: "/task-rv", stage: "publish" };

function input(decisionId: string, unblocksProgress: boolean): PostWorkflowDecisionInputV1 {
  return {
    decisionId,
    decisionKey: "commitPushFinalScopeConfirmation",
    taskCanonicalId: "/task-rv",
    stage: "publish" as const,
    whatHappened: "Choose the publish scope.",
    whyUserNeeded: "Nothing continues until you choose.",
    options: [
      { optionId: "go", label: "Go", consequence: "Continues.", resumeKind: "continue" as const, effect: { kind: "doNothing" as const } },
    ],
    recommendation: { kind: "none" as const, reasoning: "Your call." },
    gating: { holdsTaskPaused: false, unblocksProgress, detail: "Continues this run." },
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

void describe("awaited owner cards reveal the chat (bugs4 Step 33)", () => {
  void it("a card that unblocks progress reveals once; an optional awaited card does not", async () => {
    const context = { workspaceState: new FakeMemento() as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
    __extensionContextV1TestOnly.set(context);
    const revealed: string[] = [];
    setChatRevealHandlerV1((id) => {
      revealed.push(id);
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const blocking = awaitWorkflowDecisionOutcomeV1(input("d-blocking", true), target, undefined, { noTimeout: true });
      const optional = awaitWorkflowDecisionOutcomeV1(input("d-optional", false), target, undefined, { noTimeout: true });
      await settleMicrotasks();
      assert.deepEqual(revealed, ["d-blocking"]);
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      await store.resolve("d-blocking", "go");
      await store.resolve("d-optional", "go");
      await Promise.all([blocking, optional]);
    } finally {
      mock.timers.reset();
      setChatRevealHandlerV1(undefined);
      __extensionContextV1TestOnly.reset();
    }
  });
});
