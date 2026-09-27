/**
 * Pre-1.0.0 fixes register, Part 3 Step 2 inventory: `copilotImplementationRunner.ts`'s
 * `continue`/`cancel` round-limit options were a `known-gap` row in
 * `decisionOptionResumeKindTableV1.test.ts` — both are `effect: { kind:
 * "doNothing" }` by design (the choice is awaited in-process via
 * `awaitWorkflowDecisionAnswerV1` and returned directly to the caller), so no
 * `.effect`/`executeCommand` assertion could ever prove the
 * "continue"/"unpause" classification for this pair — only exercising the
 * real function and observing what it RETURNS can.
 *
 * `resolveRoundLimitDecisionV1` was extracted out of
 * `runImplementationWithCopilot`'s tool-call loop specifically so this
 * decision could be exercised directly, without driving a full (mocked)
 * Copilot model loop up to its round limit. This mirrors
 * `quotaHandleQuotaFailureDispatchV1.test.ts`'s pattern for `quota.ts`'s
 * analogous `resume`/`switch` pair: call the real, unmocked function and
 * answer its posted decision through the same `WorkflowDecisionStoreV1`
 * mechanism a live chat panel would use.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { resolveRoundLimitDecisionV1 } from "../runners/copilotImplementationRunner";
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

void describe(
  "copilotImplementationRunner.ts's resolveRoundLimitDecisionV1 — continue/cancel runtime dispatch (Part 3 Step 2 known-gap closure)",
  () => {
    void it('resolves "Continue" when the posted decision is answered "continue"', async () => {
      const context = fakeExtensionContext();
      __extensionContextV1TestOnly.set(context);
      try {
        await withHarness(async () => {
          const taskFolderPath = "/task-round-limit-continue";
          const resultPromise = resolveRoundLimitDecisionV1({
            maxIterations: 40,
            workspaceUri: vscode.Uri.file(taskFolderPath),
            token: new vscode.CancellationTokenSource().token,
            taskFolderUri: vscode.Uri.file(taskFolderPath),
            stage: "impl",
          });

          // Let the internal post + subscribe complete before resolving from
          // the outside, mirroring the chat panel resolving a pending
          // decision (same pattern as workflowDecisionAwaitAnswerV1.test.ts).
          await new Promise((resolve) => setImmediate(resolve));

          const store = new WorkflowDecisionStoreV1(context.workspaceState);
          const pending = store
            .listPending(taskFolderPath)
            .find((d) => d.decisionKey === "implementationRoundLimitReached");
          assert.ok(pending, "resolveRoundLimitDecisionV1 must post an implementationRoundLimitReached decision");
          const resolveResult = await store.resolve(pending.decisionId, "continue");
          assert.equal(resolveResult.kind, "resolved");

          const choice = await resultPromise;
          assert.equal(
            choice,
            "Continue",
            "'continue' classified resumeKind 'continue' must be what the caller receives back"
          );
        });
      } finally {
        __extensionContextV1TestOnly.reset();
      }
    });

    void it('resolves "Cancel" when the posted decision is answered "cancel"', async () => {
      const context = fakeExtensionContext();
      __extensionContextV1TestOnly.set(context);
      try {
        await withHarness(async () => {
          const taskFolderPath = "/task-round-limit-cancel";
          const resultPromise = resolveRoundLimitDecisionV1({
            maxIterations: 40,
            workspaceUri: vscode.Uri.file(taskFolderPath),
            token: new vscode.CancellationTokenSource().token,
            taskFolderUri: vscode.Uri.file(taskFolderPath),
            stage: "impl",
          });

          await new Promise((resolve) => setImmediate(resolve));

          const store = new WorkflowDecisionStoreV1(context.workspaceState);
          const pending = store
            .listPending(taskFolderPath)
            .find((d) => d.decisionKey === "implementationRoundLimitReached");
          assert.ok(pending, "resolveRoundLimitDecisionV1 must post an implementationRoundLimitReached decision");
          const resolveResult = await store.resolve(pending.decisionId, "cancel");
          assert.equal(resolveResult.kind, "resolved");

          const choice = await resultPromise;
          assert.equal(
            choice,
            "Cancel",
            "'cancel' classified resumeKind 'unpause' must be what the caller receives back"
          );
        });
      } finally {
        __extensionContextV1TestOnly.reset();
      }
    });

    void it("falls back to the raw modal and resolves undefined with no taskFolderUri/stage (test-only path)", async () => {
      const context = fakeExtensionContext();
      __extensionContextV1TestOnly.set(context);
      const originalShowWarningMessage = vscode.window.showWarningMessage;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (): Promise<undefined> =>
        Promise.resolve(undefined);
      try {
        await withHarness(async () => {
          const choice = await resolveRoundLimitDecisionV1({
            maxIterations: 40,
            workspaceUri: vscode.Uri.file("/task-round-limit-no-task"),
            token: new vscode.CancellationTokenSource().token,
          });
          assert.equal(choice, undefined);
        });
      } finally {
        (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalShowWarningMessage;
        __extensionContextV1TestOnly.reset();
      }
    });
  }
);
