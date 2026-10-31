/**
 * bugs3 Step 2 (item 2): the reconcile / reviewer-verified-ticks cards state
 * what is running from the live operations state, at render time and when an
 * option is taken — not from how the card was raised.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import {
  clearFastForwardRunActiveV1,
  markFastForwardRunActiveV1,
} from "../utils/activeFastForwardRunsV1";
import { fastForwardResumeSuffixV1 } from "../commands/fastForwardResumeSuffixV1";
import { setLiveTaskOperationLookupV1 } from "../utils/liveTaskOperationLookupV1";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  raw(key: string): unknown {
    return this.values.get(key);
  }
}

const TASK = "/tmp/tasks/live-op-task";

/** A card raised outside Fast Forward: single-cycle wording, as in the report. */
function reconcileCard(): CreateWorkflowDecisionInputV1 {
  const ff = fastForwardResumeSuffixV1(TASK, undefined);
  return {
    decisionId: "reconcile-1",
    decisionKey: "reconcilePlanChecklist",
    taskCanonicalId: TASK,
    stage: "impl-high-review",
    whatHappened: "This task's plan checklist is flagged unreliable.",
    whyUserNeeded: "Only a human can confirm the checklist matches the work.",
    options: [
      {
        optionId: "continueStage",
        label: `Resume and continue stage${ff.labelSuffix}`,
        resumeKind: "continue",
        consequence: `Dispatches this stage's next action without clearing the flag.${ff.consequenceSuffix}`,
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
          args: [{ taskFolderPath: TASK, ...ff.extraArgs }],
        },
      },
      {
        optionId: "reconcile",
        label: "Mark reconciled",
        resumeKind: "unpause",
        consequence: "Clears the flag without dispatching a stage action.",
        effect: { kind: "command", command: "vs-code-ai-helper.reconcilePlanChecklistConfirmed", args: [{ taskFolderPath: TASK }] },
      },
      { optionId: "notYet", label: "Not yet", resumeKind: "unpause", consequence: "Does nothing.", effect: { kind: "doNothing" } },
    ],
    recommendation: { kind: "option", optionId: "notYet", reasoning: "Nothing is lost by waiting." },
    createdAt: new Date().toISOString(),
  };
}

void describe("reconcile card follows the live operations state (bugs3 Step 2)", () => {
  afterEach(() => {
    setLiveTaskOperationLookupV1(undefined);
    clearFastForwardRunActiveV1(TASK);
  });

  void it("offers every option when nothing is running", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    const [card] = store.listPending(TASK);
    assert.ok(card);
    assert.ok(card.options.every((o) => o.disabled !== true));
    assert.match(card.options.find((o) => o.optionId === "continueStage")!.consequence, /not raised by an active Fast Forward run/);
  });

  void it("withholds the dispatching option and names the running operation", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review", startedAt: Date.now() - 5 * 60_000 }));
    const card = store.get("reconcile-1")!;
    const dispatching = card.options.find((o) => o.optionId === "continueStage")!;
    assert.equal(dispatching.disabled, true);
    assert.match(dispatching.disabledReason ?? "", /"Fast Forward Review" \(running 5 min so far\) is running/);
    assert.match(dispatching.disabledReason ?? "", /offered again when it ends/);
    assert.doesNotMatch(dispatching.consequence, /not raised by an active Fast Forward run/);
    assert.match(dispatching.consequence, /Fast Forward Review/);
    // "Mark reconciled" dispatches nothing, but its command refuses while an
    // operation holds the task, so the card holds it too and says why.
    const reconcile = card.options.find((o) => o.optionId === "reconcile")!;
    assert.equal(reconcile.disabled, true);
    assert.match(reconcile.disabledReason ?? "", /"Fast Forward Review" \(running 5 min so far\) is running/);
    assert.match(reconcile.disabledReason ?? "", /would race it; it is offered again when it ends/);
    // "Not yet" does nothing, so it stays available.
    assert.equal(card.options.find((o) => o.optionId === "notYet")!.disabled, undefined);
  });

  void it("refuses Mark reconciled while an operation runs, then accepts it once it ends", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review" }));
    const refused = await store.resolve("reconcile-1", "reconcile");
    assert.equal(refused.kind, "rejected");
    assert.equal(store.get("reconcile-1")!.state, "pending");
    setLiveTaskOperationLookupV1(undefined);
    assert.equal((await store.resolve("reconcile-1", "reconcile")).kind, "resolved");
  });

  void it("names an operation of unknown kind without inventing a duration", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    // The registry knows a root operation holds the task but not what it is.
    setLiveTaskOperationLookupV1(() => ({ label: "another operation" }));
    const dispatching = store.get("reconcile-1")!.options.find((o) => o.optionId === "continueStage")!;
    assert.equal(dispatching.disabled, true);
    assert.match(dispatching.disabledReason ?? "", /^"another operation" is running for this task right now/);
    assert.doesNotMatch(dispatching.disabledReason ?? "", /so far/);
  });

  void it("follows a replaced operation: the card names the one running now, never the first", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review", startedAt: Date.now() - 60_000 }));
    assert.match(
      store.get("reconcile-1")!.options.find((o) => o.optionId === "continueStage")!.disabledReason ?? "",
      /Fast Forward Review/
    );

    // The first run ends and a different one starts before the card is read again.
    setLiveTaskOperationLookupV1(() => ({ label: "Apply Review", startedAt: Date.now() - 10_000 }));
    const reason = store.get("reconcile-1")!.options.find((o) => o.optionId === "continueStage")!.disabledReason ?? "";
    assert.match(reason, /"Apply Review"/);
    assert.doesNotMatch(reason, /Fast Forward Review/);
    const refused = await store.resolve("reconcile-1", "continueStage");
    assert.equal(refused.kind, "rejected");
    assert.match(refused.kind === "rejected" ? refused.reason : "", /"Apply Review"/);
  });

  void it("puts a card back to pending when its effect was refused after the answer was recorded", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    assert.equal((await store.resolve("reconcile-1", "continueStage")).kind, "resolved");
    assert.equal(store.get("reconcile-1")!.state, "resolved");

    // A different option's reopen must not undo this answer.
    assert.equal(await store.reopenResolved("reconcile-1", "reconcile"), false);
    assert.equal(await store.reopenResolved("reconcile-1", "continueStage"), true);
    const reopened = store.get("reconcile-1")!;
    assert.equal(reopened.state, "pending");
    assert.equal(reopened.resolvedOptionId, undefined);
    assert.equal(reopened.resolvedAt, undefined);
    // It can be answered again.
    assert.equal((await store.resolve("reconcile-1", "notYet")).kind, "resolved");
    // And a decision settled any other way is never reopened.
    assert.equal(await store.reopenResolved("reconcile-1", "notYet"), true);
    await store.dismiss("reconcile-1");
    assert.equal(await store.reopenResolved("reconcile-1", "notYet"), false);
    assert.equal(await store.reopenResolved("missing", "notYet"), false);
  });

  void it("treats an in-process Fast Forward run as live even with no registry row", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    markFastForwardRunActiveV1(TASK);
    const dispatching = store.get("reconcile-1")!.options.find((o) => o.optionId === "continueStage")!;
    assert.equal(dispatching.disabled, true);
    assert.match(dispatching.disabledReason ?? "", /"Fast Forward"/);
  });

  void it("refuses the dispatching answer when a run began between render and click, without settling the card", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    const rendered = store.get("reconcile-1")!;
    assert.equal(rendered.options.find((o) => o.optionId === "continueStage")!.disabled, undefined);

    setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review" }));
    const result = await store.resolve("reconcile-1", "continueStage");
    assert.equal(result.kind, "rejected");
    assert.match(result.kind === "rejected" ? result.reason : "", /"Fast Forward Review" is running/);
    assert.equal(store.get("reconcile-1")!.state, "pending");

    // A safe, non-dispatching answer is still accepted during the run.
    assert.equal((await store.resolve("reconcile-1", "notYet")).kind, "resolved");
  });

  void it("offers the option again once the operation ends: the hold is a view and is never persisted", async () => {
    const memento = new FakeMemento();
    const store = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);
    await store.post(reconcileCard());
    setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review" }));
    assert.equal(store.get("reconcile-1")!.options.find((o) => o.optionId === "continueStage")!.disabled, true);
    // A write path while held (dismissing an unrelated card) must not bake the hold in.
    await store.post({ ...reconcileCard(), decisionId: "other", decisionKey: "otherCard", taskCanonicalId: "/tmp/tasks/other" });

    setLiveTaskOperationLookupV1(undefined);
    const after = store.get("reconcile-1")!;
    const afterDispatching = after.options.find((o) => o.optionId === "continueStage")!;
    assert.equal(afterDispatching.disabled, undefined);
    assert.match(afterDispatching.consequence, /not raised by an active Fast Forward run/);
    const persisted = (memento.raw("workflowDecisions") as Array<{ decisionId: string; options: Array<{ disabled?: boolean }> }>).find(
      (d) => d.decisionId === "reconcile-1"
    )!;
    assert.ok(persisted.options.every((o) => o.disabled === undefined));
    assert.equal((await store.resolve("reconcile-1", "continueStage")).kind, "resolved");
  });

  void it("does not hold cards of other decision kinds or other tasks' operations", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post({ ...reconcileCard(), decisionId: "unrelated", decisionKey: "somethingElse" });
    setLiveTaskOperationLookupV1((folder) => (folder === "/tmp/tasks/other" ? { label: "Review" } : undefined));
    assert.ok(store.get("unrelated")!.options.every((o) => o.disabled === undefined));
    await store.post(reconcileCard());
    assert.ok(store.get("reconcile-1")!.options.every((o) => o.disabled === undefined));
  });
});
