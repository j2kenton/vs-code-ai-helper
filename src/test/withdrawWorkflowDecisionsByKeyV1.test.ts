/**
 * Regression coverage for `withdrawWorkflowDecisionsByKeyV1` — the
 * event-driven half of Part 11 item 13c (wf "stage chat as a record of
 * work"). The render-time safety net (`chatView.ts`'s
 * `withdrawStaleDecisionsV1`) already re-derives staleness on every render;
 * this helper is called from the exact mutation site that made a card stale
 * (e.g. `implRecovery` being cleared, or a `checklistChangeProposed` proposal
 * being discarded/adopted) so `WorkflowDecisionStoreV1.listPending` — and
 * anything reading it without ever opening the chat panel, like the task
 * tree's `hasPendingDecision` token — does not keep reporting the decision
 * as pending until some later render happens to run.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
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

function decisionInput(decisionKey: string): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: `${decisionKey}-id`,
    decisionKey,
    taskCanonicalId: TARGET.canonicalId,
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

void describe("withdrawWorkflowDecisionsByKeyV1", () => {
  void it("withdraws every pending decision matching the key, recording the reason", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const posted = await store.post(decisionInput("checklistChangeProposed"));
    assert.equal(posted.ok, true);

    await withdrawWorkflowDecisionsByKeyV1(
      TARGET,
      "checklistChangeProposed",
      "this checklist-change proposal has already been revised or discarded"
    );

    const after = store.get("checklistChangeProposed-id");
    assert.equal(after?.state, "withdrawn");
    assert.equal(
      after?.withdrawnReason,
      "this checklist-change proposal has already been revised or discarded"
    );
    assert.equal(store.listPending(TARGET.canonicalId).length, 0);
  });

  void it("is a no-op when nothing pending matches the key", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const posted = await store.post(decisionInput("restoreRejectedImplementationRound"));
    assert.equal(posted.ok, true);

    // A different key — must not touch the unrelated pending decision.
    await withdrawWorkflowDecisionsByKeyV1(TARGET, "checklistChangeProposed", "unrelated");

    const after = store.get("restoreRejectedImplementationRound-id");
    assert.equal(after?.state, "pending");
  });

  void it("is a silent no-op when no extension context is available", async () => {
    // Deliberately does not call __extensionContextV1TestOnly.set — mirrors
    // postWorkflowDecisionV1's own best-effort contract (module doc comment).
    await assert.doesNotReject(() =>
      withdrawWorkflowDecisionsByKeyV1(TARGET, "checklistChangeProposed", "unrelated")
    );
  });
});
