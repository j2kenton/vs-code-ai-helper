import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeChurnProgressSignalsV1 } from "../utils/churnProgressSignalsV1";

const PLAN = ["# Plan", "", "- [x] Build the parser.", "- [ ] Build the writer.", "- [ ] Build the card. <!-- ensemble:excluded -->", ""].join("\n");

void describe("computeChurnProgressSignalsV1 (bugs4 item 22)", () => {
  void it("records the gate's settled count and the distinct steps named by task-fixable completion blockers", () => {
    const signals = computeChurnProgressSignalsV1({
      planOfRecord: PLAN,
      planItemEvidence: [],
      planItemOwnerDecisions: [],
      blockers: [
        { category: "completion", resolver: "task-fixable", description: "Plan items not built: Steps 6, 8-10 and 12" },
        { category: "completion", resolver: "environmental", description: "Step 99 needs the owner" },
        { category: "defect", resolver: "task-fixable", description: "Step 77 is wrong" },
      ],
    });
    // The exclusion settles one item; the model-only tick is still provisional.
    assert.equal(signals.settledItemCount, 1);
    assert.equal(signals.unbuiltStepCount, 5);
  });

  void it("omits both fields when there is no plan and no step is named", () => {
    const signals = computeChurnProgressSignalsV1({
      planOfRecord: undefined,
      planItemEvidence: undefined,
      planItemOwnerDecisions: undefined,
      blockers: [{ category: "defect", resolver: "task-fixable", description: "Fix src/a.ts" }],
    });
    assert.deepEqual(signals, {});
  });
});
