/**
 * RC1 item 9: a stage row shows a pending-decision icon only while that stage
 * is the task's current stage.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { countPendingDecisionsForStageRowV1 } from "../views/taskTreeProvider";

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
});
