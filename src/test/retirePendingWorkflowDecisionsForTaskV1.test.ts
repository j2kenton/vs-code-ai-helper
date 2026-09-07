/**
 * Regression coverage for `retirePendingWorkflowDecisionsForTaskV1` — 1.0.0
 * gate, A4 (review finding, 2026-09-06): "a decision for a task that has been
 * completed cannot be acted on and should not be retained or rendered"
 * (observed: a `reconcilePlanChecklist` card still presented for a jester
 * task completed a day earlier). Unlike `withdrawWorkflowDecisionsByKeyV1`
 * (event-driven Part 11 item 13c), this withdraws every pending decision for
 * a task regardless of `decisionKey` — called from lifecycle transitions
 * (mark-done, archive) after which no further round will ever act on the
 * task again.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { retirePendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file("/tasks"),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

const TARGET = { taskFolderPath: "/tasks/2026-08-30_a", canonicalId: "/tasks/2026-08-30_a" };
const OTHER_TARGET = { taskFolderPath: "/tasks/2026-08-30_b", canonicalId: "/tasks/2026-08-30_b" };

function decisionInput(
  decisionKey: string,
  taskCanonicalId: string
): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: `${decisionKey}-${taskCanonicalId}-id`,
    decisionKey,
    taskCanonicalId,
    stage: "impl",
    whatHappened: "Something happened that needs a decision.",
    whyUserNeeded: "Automation cannot decide this alone.",
    options: [
      {
        optionId: "doNothing",
        label: "Do nothing",
        consequence: "Nothing happens.",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: { kind: "option", optionId: "doNothing", reasoning: "It is the only option." },
    gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "Nothing is gated on this decision." },
    createdAt: new Date().toISOString(),
  };
}

let contextActive = false;
afterEach(() => {
  if (contextActive) {
    __extensionContextV1TestOnly.reset();
    contextActive = false;
  }
});

void describe("retirePendingWorkflowDecisionsForTaskV1", () => {
  void it("withdraws every pending decision for the task regardless of decisionKey", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post(decisionInput("reconcilePlanChecklist", TARGET.canonicalId));
    await store.post(decisionInput("reviewPlateauEscalation", TARGET.canonicalId));

    await retirePendingWorkflowDecisionsForTaskV1(TARGET, "the task was marked complete");

    assert.equal(store.listPending(TARGET.canonicalId).length, 0);
    assert.equal(
      store.get(`reconcilePlanChecklist-${TARGET.canonicalId}-id`)?.state,
      "withdrawn"
    );
    assert.equal(
      store.get(`reviewPlateauEscalation-${TARGET.canonicalId}-id`)?.state,
      "withdrawn"
    );
    assert.equal(
      store.get(`reconcilePlanChecklist-${TARGET.canonicalId}-id`)?.withdrawnReason,
      "the task was marked complete"
    );
  });

  void it("never touches another task's pending decisions", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post(decisionInput("reconcilePlanChecklist", TARGET.canonicalId));
    await store.post(decisionInput("reconcilePlanChecklist", OTHER_TARGET.canonicalId));

    await retirePendingWorkflowDecisionsForTaskV1(TARGET, "the task was archived");

    assert.equal(store.listPending(TARGET.canonicalId).length, 0);
    assert.equal(store.listPending(OTHER_TARGET.canonicalId).length, 1);
  });

  void it("is a silent no-op when no extension context is available", async () => {
    await assert.doesNotReject(() =>
      retirePendingWorkflowDecisionsForTaskV1(TARGET, "the task was archived")
    );
  });
});
