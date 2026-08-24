/**
 * Coverage for the `WorkflowDecisionV1` contract (task: "Replace hidden
 * notification decision buttons with explained, selectable decisions"):
 * `createWorkflowDecisionV1` must reject a record missing any of the four
 * required elements (what happened, why the user is needed, at least one
 * option with a stated consequence, a recommendation or an explicit "no
 * basis to recommend"), and must reject a destructive option that omits its
 * consequence text.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CreateWorkflowDecisionInputV1,
  createWorkflowDecisionV1,
  WorkflowDecisionOptionV1,
} from "../types/workflowDecisionV1";

function option(overrides: Partial<WorkflowDecisionOptionV1> = {}): WorkflowDecisionOptionV1 {
  return {
    optionId: "doIt",
    label: "Do it",
    consequence: "Applies the change immediately.",
    effect: { kind: "command", command: "ensemble.doIt" },
    ...overrides,
  };
}

function validInput(overrides: Partial<CreateWorkflowDecisionInputV1> = {}): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "decision-1",
    decisionKey: "exampleDecision",
    taskCanonicalId: "/tmp/tasks/task-1",
    stage: "impl",
    whatHappened: "The scheduled round finished and the summary was rejected.",
    whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
    options: [option()],
    recommendation: { kind: "option", optionId: "doIt", reasoning: "It is safe and reversible." },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

void describe("createWorkflowDecisionV1", () => {
  void it("accepts a well-formed decision with a recommended option", () => {
    const result = createWorkflowDecisionV1(validInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decision.state, "pending");
      assert.equal(result.decision.options.length, 1);
    }
  });

  void it("accepts an explicit 'no recommendation' with reasoning", () => {
    const result = createWorkflowDecisionV1(
      validInput({ recommendation: { kind: "none", reasoning: "Both options are equally valid; only the user knows which applies." } })
    );
    assert.equal(result.ok, true);
  });

  void it("rejects a decision missing 'whatHappened'", () => {
    const result = createWorkflowDecisionV1(validInput({ whatHappened: "" }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /whatHappened/);}
  });

  void it("rejects a decision missing 'whyUserNeeded'", () => {
    const result = createWorkflowDecisionV1(validInput({ whyUserNeeded: "   " }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /whyUserNeeded/);}
  });

  void it("rejects a decision with no options", () => {
    const result = createWorkflowDecisionV1(validInput({ options: [] }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /at least one option/);}
  });

  void it("rejects an option with no consequence text", () => {
    const result = createWorkflowDecisionV1(validInput({ options: [option({ consequence: "" })] }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /consequence/);}
  });

  void it("rejects a destructive option with no consequence text", () => {
    const result = createWorkflowDecisionV1(
      validInput({ options: [option({ destructive: true, consequence: "" })] })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /consequence/);}
  });

  void it("accepts a destructive option that states its consequence", () => {
    const result = createWorkflowDecisionV1(
      validInput({
        options: [
          option({
            optionId: "restore",
            destructive: true,
            consequence: "Overwrites the current implementation summary and review with the prior round's backup, discarding the completed round's work.",
          }),
        ],
        recommendation: { kind: "option", optionId: "restore", reasoning: "No continuation is scheduled." },
      })
    );
    assert.equal(result.ok, true);
  });

  void it("rejects duplicate option ids", () => {
    const result = createWorkflowDecisionV1(validInput({ options: [option(), option()] }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /duplicate option id/);}
  });

  void it("rejects a recommendation that references an unknown option", () => {
    const result = createWorkflowDecisionV1(
      validInput({ recommendation: { kind: "option", optionId: "doesNotExist", reasoning: "n/a" } })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /unknown option/);}
  });

  void it("rejects a recommended option with empty reasoning", () => {
    const result = createWorkflowDecisionV1(
      validInput({ recommendation: { kind: "option", optionId: "doIt", reasoning: "" } })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /reasoning/);}
  });

  void it("rejects an explicit 'none' recommendation with empty reasoning", () => {
    const result = createWorkflowDecisionV1(validInput({ recommendation: { kind: "none", reasoning: "" } }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /reasoning/);}
  });

  void it("rejects an invalid createdAt timestamp", () => {
    const result = createWorkflowDecisionV1(validInput({ createdAt: "not-a-date" }));
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /createdAt/);}
  });

  void it("rejects a command effect with an empty command id", () => {
    const result = createWorkflowDecisionV1(
      validInput({ options: [option({ effect: { kind: "command", command: "" } })] })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /command/);}
  });

  void it("accepts a well-formed 'gating' claim", () => {
    const result = createWorkflowDecisionV1(
      validInput({
        gating: {
          holdsTaskPaused: true,
          unblocksProgress: true,
          detail: "Resolves the escalation this task is paused on.",
        },
      })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decision.gating, {
        holdsTaskPaused: true,
        unblocksProgress: true,
        detail: "Resolves the escalation this task is paused on.",
      });
    }
  });

  void it("accepts a decision that omits 'gating' entirely (the deferred production call site)", () => {
    const result = createWorkflowDecisionV1(validInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decision.gating, undefined);
    }
  });

  void it("rejects a 'gating' with a non-boolean 'holdsTaskPaused'", () => {
    const result = createWorkflowDecisionV1(
      validInput({
        gating: { holdsTaskPaused: "yes" as unknown as boolean, unblocksProgress: true, detail: "n/a" },
      })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /holdsTaskPaused/);}
  });

  void it("rejects a 'gating' with a non-boolean 'unblocksProgress'", () => {
    const result = createWorkflowDecisionV1(
      validInput({
        gating: { holdsTaskPaused: false, unblocksProgress: "yes" as unknown as boolean, detail: "n/a" },
      })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /unblocksProgress/);}
  });

  void it("rejects a 'gating' with an empty 'detail'", () => {
    const result = createWorkflowDecisionV1(
      validInput({ gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "" } })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {assert.match(result.reason, /gating.*detail/);}
  });

  void it("accepts a legitimate doNothing option", () => {
    const result = createWorkflowDecisionV1(
      validInput({
        options: [
          option(),
          option({ optionId: "wait", label: "Wait", consequence: "Leaves the round as-is; nothing changes.", effect: { kind: "doNothing" } }),
        ],
      })
    );
    assert.equal(result.ok, true);
  });
});
