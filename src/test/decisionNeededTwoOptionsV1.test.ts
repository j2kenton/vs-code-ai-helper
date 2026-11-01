/**
 * bugs4 Step 15 / item 17: a card headed "Decision needed" always offers a real choice
 * (at least two options). A single-action card is a notice with a button ("Optional").
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIdleReconcileDecisionV1, isBlockingDecisionV1 } from "../views/chatView";

const OPTION = (optionId: string) => ({
  optionId,
  label: optionId,
  consequence: "Does something.",
  resumeKind: "unpause" as const,
  effect: { kind: "command" as const, command: "ensemble.noop" },
});

const NOT_NOW = (optionId: string, consequence = "Does nothing. The task stays as it is.") => ({
  optionId,
  label: "Not now",
  consequence,
  resumeKind: "unpause" as const,
  effect: { kind: "doNothing" as const },
});

const HOLDING = { holdsTaskPaused: true, unblocksProgress: false, detail: "Holds the task." };

void describe("isBlockingDecisionV1 (bugs4 Step 15)", () => {
  void it("a gating card with a single option is a notice, not a 'Decision needed'", () => {
    assert.equal(isBlockingDecisionV1({ gating: HOLDING, options: [OPTION("only")] }), false);
  });

  void it("a gating card with an action plus a Not now is a 'Decision needed'", () => {
    assert.equal(isBlockingDecisionV1({ gating: HOLDING, options: [OPTION("do"), NOT_NOW("notNow")] }), true);
  });

  void it("unknown gating with an action plus a Not now stays blocking (absence is not positive evidence)", () => {
    assert.equal(isBlockingDecisionV1({ gating: undefined, options: [OPTION("a"), NOT_NOW("b")] }), true);
  });

  void it("two real actions with no Not now are not a 'Decision needed'", () => {
    assert.equal(isBlockingDecisionV1({ gating: HOLDING, options: [OPTION("a"), OPTION("b")] }), false);
  });

  void it("a Not now that does not say what happens does not count", () => {
    assert.equal(isBlockingDecisionV1({ gating: HOLDING, options: [OPTION("a"), NOT_NOW("n", "  ")] }), false);
  });

  void it("a non-gating card with two options is still optional", () => {
    assert.equal(
      isBlockingDecisionV1({
        gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "Nothing waits." },
        options: [OPTION("a"), NOT_NOW("b")],
      }),
      false
    );
  });

  void it("the idle reconcile card (one action) is not blocking", () => {
    const decision = buildIdleReconcileDecisionV1({
      canonicalId: "t",
      taskFolderPath: "/w/.ensemble/t",
      stage: "impl",
    });
    assert.equal(isBlockingDecisionV1(decision), false);
  });
});
