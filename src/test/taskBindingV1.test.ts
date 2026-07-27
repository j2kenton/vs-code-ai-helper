/**
 * Coverage for the §3.9 task-binding model: deterministic digests over the
 * persisted ownership + taskFolder record, and fail-closed derivation for
 * every ambiguous shape.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeTaskBindingIdV1,
  deriveTaskBindingV1,
  PersistedTaskOwnershipV1,
} from "../types/taskBindingV1";

function makeOwnership(overrides: Partial<PersistedTaskOwnershipV1> = {}): PersistedTaskOwnershipV1 {
  return {
    metaRoot: "c:/work/.ensemble",
    projectRoot: "c:/work",
    boundAt: "2026-07-01T09:00:00.000Z",
    ...overrides,
  };
}

void describe("taskBindingV1", () => {
  void it("derives a deterministic binding id independent of property order", () => {
    const a = computeTaskBindingIdV1(makeOwnership(), "2026-07-01_task_1");
    const b = computeTaskBindingIdV1(
      // Same values, different literal ordering.
      { boundAt: "2026-07-01T09:00:00.000Z", projectRoot: "c:/work", metaRoot: "c:/work/.ensemble" },
      "2026-07-01_task_1"
    );
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
  });

  void it("changes the binding id when any bound value changes", () => {
    const base = computeTaskBindingIdV1(makeOwnership(), "2026-07-01_task_1");
    assert.notEqual(base, computeTaskBindingIdV1(makeOwnership(), "2026-07-01_task_2"));
    assert.notEqual(base, computeTaskBindingIdV1(makeOwnership({ metaRoot: "d:/other/.ensemble" }), "2026-07-01_task_1"));
    assert.notEqual(
      base,
      computeTaskBindingIdV1(makeOwnership({ workspaceRoot: "c:/work" }), "2026-07-01_task_1")
    );
  });

  void it("derives a binding from a valid resolved ownership record", () => {
    const result = deriveTaskBindingV1({
      ownership: makeOwnership({ state: "resolved" }),
      taskFolder: "2026-07-01_task_1",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.binding.taskFolder, "2026-07-01_task_1");
      assert.equal(
        result.binding.bindingId,
        computeTaskBindingIdV1(makeOwnership({ state: "resolved" }), "2026-07-01_task_1")
      );
    }
  });

  void it("fails closed on every ambiguous or unresolved shape", () => {
    const cases: ReadonlyArray<Parameters<typeof deriveTaskBindingV1>[0]> = [
      { ownership: makeOwnership(), taskFolder: "" },
      { ownership: undefined, taskFolder: "t" },
      { ownership: makeOwnership({ metaRoot: "" }), taskFolder: "t" },
      { ownership: makeOwnership({ projectRoot: "" }), taskFolder: "t" },
      { ownership: makeOwnership({ boundAt: "not-a-date" }), taskFolder: "t" },
      { ownership: makeOwnership({ workspaceRoot: "" }), taskFolder: "t" },
      { ownership: makeOwnership({ state: "ownership-unresolved" }), taskFolder: "t" },
    ];
    for (const candidate of cases) {
      const result = deriveTaskBindingV1(candidate);
      assert.equal(result.ok, false, `expected derivation failure for ${JSON.stringify(candidate)}`);
    }
  });
});
