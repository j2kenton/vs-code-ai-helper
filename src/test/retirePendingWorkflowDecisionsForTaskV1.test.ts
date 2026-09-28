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
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { retirePendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { DEPARTED_STAGE_DECISION_RETIRED_REASON_V1, runStageEntryPostCommitV1 } from "../utils/stageTransition";
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
        resumeKind: "unpause",
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

  void it("with a stage filter, retires only that stage's decisions (RC1 item 9)", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post({ ...decisionInput("descCard", TARGET.canonicalId), stage: "desc" });
    await store.post({ ...decisionInput("implCard", TARGET.canonicalId), stage: "impl" });

    await retirePendingWorkflowDecisionsForTaskV1(TARGET, DEPARTED_STAGE_DECISION_RETIRED_REASON_V1, { stage: "desc" });

    assert.equal(store.get(`descCard-${TARGET.canonicalId}-id`)?.state, "withdrawn");
    assert.equal(store.get(`descCard-${TARGET.canonicalId}-id`)?.withdrawnReason, "retired by the task moving on, not answered");
    assert.equal(store.get(`implCard-${TARGET.canonicalId}-id`)?.state, "pending");
  });

  void it("does not retire a decision raised after the cutoff (a late Phase B replay)", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const startedAt = "2026-09-27T10:00:00.000Z";
    await store.post({ ...decisionInput("before", TARGET.canonicalId), stage: "plan", createdAt: "2026-09-27T09:59:00.000Z" });
    await store.post({ ...decisionInput("after", TARGET.canonicalId), stage: "plan", createdAt: "2026-09-27T10:05:00.000Z" });

    await runStageEntryPostCommitV1(vscode.Uri.file(TARGET.taskFolderPath), {
      departedStage: "plan",
      departedStageRetireBefore: startedAt,
    });

    assert.equal(store.get(`before-${TARGET.canonicalId}-id`)?.state, "withdrawn");
    assert.equal(store.get(`after-${TARGET.canonicalId}-id`)?.state, "pending");
  });

  void it("advancing retires the left stage's decisions but not the arrival stage's", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post({ ...decisionInput("left", TARGET.canonicalId), stage: "desc" });
    await store.post({ ...decisionInput("arrival", TARGET.canonicalId), stage: "plan" });

    await runStageEntryPostCommitV1(vscode.Uri.file(TARGET.taskFolderPath), {
      departedStage: "desc",
      departedStageRetireBefore: new Date(Date.now() + 1000).toISOString(),
    });

    assert.equal(store.get(`left-${TARGET.canonicalId}-id`)?.withdrawnReason, DEPARTED_STAGE_DECISION_RETIRED_REASON_V1);
    assert.equal(store.get(`arrival-${TARGET.canonicalId}-id`)?.state, "pending");
  });

  void it("plan revision back to plan retires the departed review stage's decisions", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post({ ...decisionInput("reviewCard", TARGET.canonicalId), stage: "plan-high-review" });
    await store.post({ ...decisionInput("planCard", TARGET.canonicalId), stage: "plan" });

    await runStageEntryPostCommitV1(vscode.Uri.file(TARGET.taskFolderPath), {
      departedStage: "plan-high-review",
      departedStageRetireBefore: new Date(Date.now() + 1000).toISOString(),
    });

    assert.equal(store.get(`reviewCard-${TARGET.canonicalId}-id`)?.withdrawnReason, DEPARTED_STAGE_DECISION_RETIRED_REASON_V1);
    assert.equal(store.get(`planCard-${TARGET.canonicalId}-id`)?.state, "pending");
  });

  void it("plan revision runs the entry result's post-commit work so the departed stage retires (source shape)", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "planRevisionV1.ts"), "utf8");
    assert.match(source, /enterStageV1\(\s*folderUri,\s*sourceStage,\s*"plan"/);
    assert.match(source, /await runStageEntryPostCommitV1\(folderUri, entryResult\);/);
  });

  void it("a same-stage entry (no departedStage) retires nothing", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.post({ ...decisionInput("keep", TARGET.canonicalId), stage: "plan" });

    await runStageEntryPostCommitV1(vscode.Uri.file(TARGET.taskFolderPath), {});

    assert.equal(store.get(`keep-${TARGET.canonicalId}-id`)?.state, "pending");
  });

  void it("plan generation retires the departed desc decision without blocking the auto-review (source shape)", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "generatePlanWithAI.ts"), "utf8");
    const at = source.indexOf("if (entryResult?.ready) {");
    assert.ok(at >= 0, "success branch not found");
    const branch = source.slice(at, at + 1200);
    assert.match(branch, /triggerAutoReview = ctx\.effectiveReviewMode !== "off";/);
    assert.match(branch, /await runStageEntryPostCommitV1\(taskFolderUri, entryResult\)\.catch\(/);
    assert.ok(
      branch.indexOf("triggerAutoReview =") < branch.indexOf("runStageEntryPostCommitV1"),
      "the auto-review flag is set before post-commit work so a failure there cannot cancel it"
    );
  });
});
