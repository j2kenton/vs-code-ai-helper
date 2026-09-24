/**
 * Pre-1.0.0 fixes register, Part 3 Step 2 inventory: `utils/quota.ts`'s
 * `resume`/`switch` options were a `known-gap` row in
 * `decisionOptionResumeKindTableV1.test.ts` — both are `effect: { kind:
 * "doNothing" }` by design (the choice is awaited in-process via
 * `awaitWorkflowDecisionAnswerV1` and returned directly to
 * `handleQuotaFailure`'s own caller), so no `.effect`/`executeCommand`
 * assertion could ever prove the "continue"/"unpause" classification for
 * this pair — only exercising the real function and observing what it
 * RETURNS (and, for "switch", that it invokes the supplied `switchModel`
 * callback) can.
 *
 * This calls the real, unmocked `handleQuotaFailure` and answers its posted
 * decision through the same `WorkflowDecisionStoreV1` mechanism a live chat
 * panel would use (mirroring `workflowDecisionAwaitAnswerV1.test.ts`'s
 * pattern), closing that known-gap with a genuine runtime assertion.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { handleQuotaFailure } from "../utils/quota";
import { AgentRunRequest, AgentRunResult } from "../types/agentRunner";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";

/** Minimal in-memory stand-in for `vscode.Memento`, mirroring `workflowDecisionAwaitAnswerV1.test.ts`. */
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

function fakeExtensionContext(): vscode.ExtensionContext {
  return { workspaceState: new FakeMemento() as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
}

function makeRequest(taskFolderPath: string): AgentRunRequest {
  return {
    taskFolderUri: vscode.Uri.file(taskFolderPath),
    workspaceUri: vscode.Uri.file(taskFolderPath),
    stage: "impl",
    prompt: "irrelevant for this test",
    outputFile: vscode.Uri.file(`${taskFolderPath}/out.md`),
  };
}

const QUOTA_RESULT: AgentRunResult = {
  runnerId: "claude-cli",
  status: "failed",
  failureKind: "quota",
};

async function withHarness<T>(run: () => Promise<T>): Promise<T> {
  const provider = new StatusTreeProvider();
  initNotificationRouter(provider);
  try {
    return await run();
  } finally {
    provider.dispose();
    deactivateNotificationRouter();
  }
}

void describe("quota.ts's handleQuotaFailure — resume/switch runtime dispatch (Part 3 Step 2 known-gap closure)", () => {
  void it('resolves "resume" and does not call switchModel when the posted decision is answered "resume"', async () => {
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await withHarness(async () => {
        let switchModelCalled = false;
        const resultPromise = handleQuotaFailure(
          context,
          makeRequest("/task-quota-resume"),
          QUOTA_RESULT,
          () => {
            switchModelCalled = true;
            return Promise.resolve();
          }
        );

        // Let the internal post + subscribe complete before resolving from
        // the outside, mirroring the chat panel resolving a pending decision
        // (same pattern as workflowDecisionAwaitAnswerV1.test.ts).
        await new Promise((resolve) => setImmediate(resolve));

        const store = new WorkflowDecisionStoreV1(context.workspaceState);
        const pending = store.listPending("/task-quota-resume").find((d) => d.decisionKey === "quotaExhaustedDuringRun");
        assert.ok(pending, "handleQuotaFailure must post a quotaExhaustedDuringRun decision");
        const resolveResult = await store.resolve(pending.decisionId, "resume");
        assert.equal(resolveResult.kind, "resolved");

        const chosen = await resultPromise;
        assert.equal(chosen, "resume", "'resume' classified resumeKind 'continue' must be what the caller receives back");
        assert.equal(switchModelCalled, false, "'resume' must never invoke the switchModel callback");
      });
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it('resolves "switch", invokes switchModel, when the posted decision is answered "switch"', async () => {
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await withHarness(async () => {
        let switchModelCalled = false;
        const resultPromise = handleQuotaFailure(
          context,
          makeRequest("/task-quota-switch"),
          QUOTA_RESULT,
          () => {
            switchModelCalled = true;
            return Promise.resolve();
          }
        );

        await new Promise((resolve) => setImmediate(resolve));

        const store = new WorkflowDecisionStoreV1(context.workspaceState);
        const pending = store.listPending("/task-quota-switch").find((d) => d.decisionKey === "quotaExhaustedDuringRun");
        assert.ok(pending, "handleQuotaFailure must post a quotaExhaustedDuringRun decision");
        const resolveResult = await store.resolve(pending.decisionId, "switch");
        assert.equal(resolveResult.kind, "resolved");

        const chosen = await resultPromise;
        assert.equal(chosen, "switch", "'switch' classified resumeKind 'unpause' must be what the caller receives back");
        assert.equal(switchModelCalled, true, "'switch' must invoke the supplied switchModel callback before returning");
      });
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("resolves undefined (neither resume nor a further dispatch) when the decision is dismissed", async () => {
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await withHarness(async () => {
        const resultPromise = handleQuotaFailure(context, makeRequest("/task-quota-dismiss"), QUOTA_RESULT);

        await new Promise((resolve) => setImmediate(resolve));

        const store = new WorkflowDecisionStoreV1(context.workspaceState);
        const pending = store.listPending("/task-quota-dismiss").find((d) => d.decisionKey === "quotaExhaustedDuringRun");
        assert.ok(pending, "handleQuotaFailure must post a quotaExhaustedDuringRun decision");
        const dismissResult = await store.dismiss(pending.decisionId);
        assert.equal(dismissResult.kind, "dismissed");

        const chosen = await resultPromise;
        assert.equal(chosen, undefined);
      });
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });
});
