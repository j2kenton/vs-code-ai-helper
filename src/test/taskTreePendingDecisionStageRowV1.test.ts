/**
 * RC1 item 9: a stage row shows a pending-decision icon only while that stage
 * is the task's current stage.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { countPendingDecisionsForStageRowV1, countUnresolvedInteractionsV1 } from "../views/taskTreeProvider";

const decision = (stage: string): WorkflowDecisionV1 => ({ stage }) as unknown as WorkflowDecisionV1;

void describe("countPendingDecisionsForStageRowV1", () => {
  void it("counts a decision on the current stage exactly as before", () => {
    assert.equal(countPendingDecisionsForStageRowV1([decision("impl"), decision("plan")], "impl", "impl"), 1);
    assert.equal(countPendingDecisionsForStageRowV1([decision("impl"), decision("impl")], "impl", "impl"), 2);
  });

  void it("shows no icon on a row for a stage the task has left", () => {
    assert.equal(countPendingDecisionsForStageRowV1([decision("plan")], "plan", "impl"), 0);
  });

  void it("never counts another stage's decision", () => {
    assert.equal(countPendingDecisionsForStageRowV1([decision("plan")], "impl", "impl"), 0);
  });

  void it("adds unresolved structured questions to the current stage row (RC12 item 2)", () => {
    assert.equal(countPendingDecisionsForStageRowV1([], "plan", "plan", 1), 1);
    assert.equal(countPendingDecisionsForStageRowV1([decision("plan")], "plan", "plan", 2), 3);
  });

  void it("does not add unresolved questions to a row for another stage", () => {
    assert.equal(countPendingDecisionsForStageRowV1([], "impl", "plan", 1), 0);
  });
});

void describe("countUnresolvedInteractionsV1 (RC12 item 2)", () => {
  const read = (...states: string[]) => () => Promise.resolve(states.map((state) => ({ state })));

  void it("counts only unresolved interactions", async () => {
    assert.equal(await countUnresolvedInteractionsV1("active", read("unresolved", "resolved", "resumed", "unresolved")), 2);
  });

  void it("is 0 when every interaction is resolved or resumed", async () => {
    assert.equal(await countUnresolvedInteractionsV1("active", read("resolved", "resumed")), 0);
  });

  void it("is 0 for completed and archived tasks without reading", async () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return Promise.resolve([{ state: "unresolved" }]);
    };
    assert.equal(await countUnresolvedInteractionsV1("completed", counting), 0);
    assert.equal(await countUnresolvedInteractionsV1("archived", counting), 0);
    assert.equal(reads, 0);
  });

  void it("is 0 when the chat cannot be read", async () => {
    assert.equal(await countUnresolvedInteractionsV1("active", () => Promise.reject(new Error("boom"))), 0);
  });

  void it("feeds the stage row count only on the current stage; a decision alone is unchanged", async () => {
    const n = await countUnresolvedInteractionsV1("active", read("unresolved"));
    assert.equal(countPendingDecisionsForStageRowV1([], "plan", "plan", n), 1);
    assert.equal(countPendingDecisionsForStageRowV1([], "impl", "plan", n), 0);
    assert.equal(countPendingDecisionsForStageRowV1([decision("plan")], "plan", "plan", 0), 1);
  });
});
