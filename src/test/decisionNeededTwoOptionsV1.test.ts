/**
 * bugs4 Step 15 / item 17: a card headed "Decision needed" always offers a real choice
 * (at least two options). A single-action card is a notice with a button ("Optional").
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIdleReconcileDecisionV1,
  decisionHeadingV1,
  hasActionableOptionV1,
  isBlockingDecisionV1,
} from "../views/chatView";

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

const HELD = (optionId: string) => ({
  ...OPTION(optionId),
  disabled: true,
  disabledReason: "Fast Forward is running for this task right now.",
});

void describe("a card with nothing the owner can choose (bugs5 Step 1)", () => {
  void it("is not a 'Decision needed' when its only action is unavailable", () => {
    assert.equal(isBlockingDecisionV1({ gating: undefined, options: [HELD("apply"), NOT_NOW("skip")] }), false);
  });

  void it("is headed 'For information' when its only action is unavailable", () => {
    assert.equal(decisionHeadingV1({ gating: undefined, options: [HELD("apply"), NOT_NOW("skip")] }), "For information");
  });

  void it("is headed 'For information' when every option is a doNothing", () => {
    assert.equal(decisionHeadingV1({ gating: undefined, options: [NOT_NOW("a"), NOT_NOW("b")] }), "For information");
  });

  void it("keeps 'Decision needed' when an enabled action sits beside Not now", () => {
    assert.equal(decisionHeadingV1({ gating: HOLDING, options: [OPTION("do"), NOT_NOW("n")] }), "Decision needed");
  });

  void it("keeps 'Optional' for a single enabled action", () => {
    assert.equal(decisionHeadingV1({ gating: HOLDING, options: [OPTION("only")] }), "Optional");
  });

  void it("an enabled tick-only option beside a held dispatching one keeps the card actionable", () => {
    assert.equal(hasActionableOptionV1({ options: [HELD("apply"), OPTION("tickOnly"), NOT_NOW("skip")] }), true);
  });

  void it("a waiting command makes the card blocking and names the command, never 'Optional'", () => {
    const gating = { holdsTaskPaused: false, unblocksProgress: false, detail: "the commit and push", waitingCommand: "Commit & Push" };
    assert.equal(isBlockingDecisionV1({ gating, options: [OPTION("go")] }), true);
    assert.equal(decisionHeadingV1({ gating, options: [OPTION("go")] }), "Commit & Push is waiting for your answer");
  });

  void it("an awaited card, whose waiting command acts on the answer, is actionable though every effect is doNothing", () => {
    const awaited = { waiterId: "w", activationId: "a", taskFolderPath: "/t", restartGuidance: "g" };
    const options = [NOT_NOW("a"), NOT_NOW("b")];
    assert.equal(hasActionableOptionV1({ options, awaited }), true);
    assert.equal(isBlockingDecisionV1({ gating: undefined, options, awaited }), true);
    assert.equal(decisionHeadingV1({ gating: undefined, options, awaited }), "Decision needed");
  });

  void it("an awaited card whose options are all unavailable still has nothing to choose", () => {
    const awaited = { waiterId: "w", activationId: "a", taskFolderPath: "/t", restartGuidance: "g" };
    assert.equal(hasActionableOptionV1({ options: [HELD("a")], awaited }), false);
  });

  void it("a waiting command does not make a card with nothing to choose blocking", () => {
    const gating = { holdsTaskPaused: false, unblocksProgress: false, detail: "x", waitingCommand: "Commit & Push" };
    assert.equal(isBlockingDecisionV1({ gating, options: [HELD("go")] }), false);
    assert.equal(decisionHeadingV1({ gating, options: [HELD("go")] }), "For information");
  });
});
