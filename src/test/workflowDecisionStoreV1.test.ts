/**
 * Coverage for `WorkflowDecisionStoreV1` (task: "Replace hidden notification
 * decision buttons with explained, selectable decisions"):
 *  - `post` persists a valid decision and rejects an invalid one;
 *  - `listPending` returns only pending decisions, optionally filtered to a
 *    task;
 *  - `resolve` settles a pending decision exactly once and reports a second
 *    resolve attempt as `alreadySettled` rather than an error (the
 *    acknowledgement contract: an already-answered decision is not a
 *    failure);
 *  - `resolve`/`dismiss` against an unknown id report `missing`;
 *  - `dismiss` settles a pending decision without an option;
 *  - reposting a decision under the same `decisionKey` + task marks the
 *    prior pending one `superseded` rather than leaving two pending;
 *  - `removeForTask` drops every record for one task.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";

/** Minimal in-memory stand-in for `vscode.Memento`. */
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

function option(overrides: Partial<WorkflowDecisionOptionV1> = {}): WorkflowDecisionOptionV1 {
  return {
    optionId: "doIt",
    label: "Do it",
    consequence: "Applies the change immediately.",
    effect: { kind: "command", command: "ensemble.doIt" },
    ...overrides,
  };
}

let counter = 0;
function decisionInput(overrides: Partial<CreateWorkflowDecisionInputV1> = {}): CreateWorkflowDecisionInputV1 {
  counter += 1;
  return {
    decisionId: `decision-${counter}`,
    decisionKey: "exampleDecision",
    taskCanonicalId: "/tmp/tasks/task-1",
    stage: "impl",
    whatHappened: "The scheduled round finished and the summary was rejected.",
    whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
    options: [option(), option({ optionId: "wait", label: "Wait", consequence: "Leaves the round as-is.", effect: { kind: "doNothing" } })],
    recommendation: { kind: "option", optionId: "wait", reasoning: "Nothing is lost by waiting." },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

void describe("WorkflowDecisionStoreV1", () => {
  void it("posts a valid decision and lists it as pending", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.state, "pending");
  });

  void it("rejects posting an invalid decision and does not persist it", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput({ whatHappened: "" }));
    assert.equal(posted.ok, false);
    assert.equal(store.listPending().length, 0);
  });

  void it("filters listPending by taskCanonicalId", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-1", decisionKey: "a" }));
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-2", decisionKey: "b" }));
    const forTask1 = store.listPending("/tmp/tasks/task-1");
    assert.equal(forTask1.length, 1);
    assert.equal(forTask1[0]!.taskCanonicalId, "/tmp/tasks/task-1");
  });

  void it("resolve settles a pending decision and returns the chosen option", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const result = await store.resolve(posted.decision.decisionId, "wait");
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.option.optionId, "wait");
      assert.equal(result.decision.state, "resolved");
      assert.equal(result.decision.resolvedOptionId, "wait");
    }
    assert.equal(store.listPending().length, 0);
  });

  void it("a second resolve of an already-resolved decision reports alreadySettled, not an error", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const first = await store.resolve(posted.decision.decisionId, "wait");
    assert.equal(first.kind, "resolved");
    const second = await store.resolve(posted.decision.decisionId, "doIt");
    assert.equal(second.kind, "alreadySettled");
    if (second.kind === "alreadySettled") {
      // The original resolution wins; the second attempt's option is ignored.
      assert.equal(second.decision.resolvedOptionId, "wait");
    }
  });

  void it("resolve against an unknown decision id reports missing", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const result = await store.resolve("does-not-exist", "wait");
    assert.equal(result.kind, "missing");
  });

  void it("resolve with an unknown optionId is rejected", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const result = await store.resolve(posted.decision.decisionId, "not-an-option");
    assert.equal(result.kind, "rejected");
  });

  void it("dismiss settles a pending decision without an option", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const result = await store.dismiss(posted.decision.decisionId);
    assert.equal(result.kind, "dismissed");
    assert.equal(store.listPending().length, 0);
  });

  void it("dismiss against an unknown decision id reports missing", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const result = await store.dismiss("does-not-exist");
    assert.equal(result.kind, "missing");
  });

  void it("reposting the same decisionKey for the same task supersedes the earlier pending decision", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const first = await store.post(decisionInput({ decisionKey: "reconcilePlanChecklist" }));
    assert.equal(first.ok, true);
    const second = await store.post(decisionInput({ decisionKey: "reconcilePlanChecklist" }));
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {return;}
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.decisionId, second.decision.decisionId);
    const supersededFirst = store.get(first.decision.decisionId);
    assert.equal(supersededFirst?.state, "superseded");
  });

  void it("reposting a different decisionKey for the same task does not supersede", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(decisionInput({ decisionKey: "keyA" }));
    await store.post(decisionInput({ decisionKey: "keyB" }));
    assert.equal(store.listPending().length, 2);
  });

  void it("removeForTask drops every record for one task", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-1" }));
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-1", decisionKey: "other" }));
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-2" }));
    const removed = await store.removeForTask("/tmp/tasks/task-1");
    assert.equal(removed, 2);
    assert.equal(store.listPending("/tmp/tasks/task-1").length, 0);
    assert.equal(store.listPending("/tmp/tasks/task-2").length, 1);
  });
});
