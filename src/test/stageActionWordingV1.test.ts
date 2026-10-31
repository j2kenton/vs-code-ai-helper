/**
 * bugs3 Step 4 (item 4) and Step 3 (item 3): what a round does is named for the
 * task's actual stage, and an exhausted candidate chain is reported as every
 * model failing, with each candidate's own reason.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeLastRoundV1,
  describeRoundActionV1,
  fixRoundSummaryV1,
  isPlanWorkStageV1,
} from "../utils/stageActionWordingV1";
import { describeTaskActionFailureV1, describeTaskActionOutcomeForLogV1 } from "../utils/taskActionOutcomeTextV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import { __resetFastForwardRunsForTestV1, markFastForwardRunActiveV1 } from "../utils/activeFastForwardRunsV1";
import { describeStalledActiveTaskEscalationV1 } from "../utils/taskWatchdogV1";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

void describe("stage-aware round wording (bugs3 Step 4)", () => {
  void it("treats Plan and both plan-review stages as plan work, and implementation stages as code work", () => {
    for (const stage of ["plan", "plan-high-review", "plan-low-review"] as const) {
      assert.equal(isPlanWorkStageV1(stage), true, stage);
    }
    for (const stage of ["impl", "impl-high-review", "impl-low-review", "publish"] as const) {
      assert.equal(isPlanWorkStageV1(stage), false, stage);
    }
  });

  void it("a plan-stage fix round revises plan.md and says it edits no code; an implementation-review one edits code", () => {
    const plan = fixRoundSummaryV1("plan-high-review");
    assert.match(plan.labelClause, /revises the plan \(plan\.md\); it does not edit code/);
    assert.doesNotMatch(plan.consequence, /implementation round/);
    const code = fixRoundSummaryV1("impl-high-review");
    assert.match(code.labelClause, /edits code to address the review's findings/);
    assert.match(fixRoundSummaryV1(undefined).consequence, /plan stage it revises plan\.md/);
  });

  void it("describes the same internal mode differently at a plan stage and an implementation stage", () => {
    assert.match(describeRoundActionV1("implementation", "plan"), /plan\.md; it does not edit code/);
    assert.match(describeRoundActionV1("implementation", "impl"), /builds the plan's open items in code/);
    assert.match(describeRoundActionV1("apply-review", "plan-low-review"), /revises plan\.md; it does not edit code/);
    assert.match(describeRoundActionV1("apply-review", "impl-low-review"), /edits code/);
    assert.match(describeRoundActionV1("review", "plan-high-review"), /does not edit anything/);
  });

  void it("describeLastRoundV1 never prints the raw mode for a known mode, and keeps unknown text as-is", () => {
    const text = describeLastRoundV1("implementation", "Plan", "plan");
    assert.match(text, /^a round that writes or revises plan\.md; it does not edit code at Plan$/);
    assert.equal(describeLastRoundV1("custom-thing", "Plan", "plan"), "custom-thing at Plan");
  });

  void it("the watchdog's 'last round' text describes a plan-stage round as plan work, not 'implementation at plan'", () => {
    const text = describeStalledActiveTaskEscalationV1("bugs1", {
      kind: "finished",
      stage: "plan-high-review",
      mode: "apply-review",
      score: 6,
      blockers: 2,
    });
    assert.match(text, /its last round \(a round that revises plan\.md; it does not edit code at High-Level Review \(Plan\)\) finished/);
    assert.doesNotMatch(text, /apply-review at/);
  });
});

void describe("exhausted candidate chain wording (bugs3 Step 3)", () => {
  const exhausted: TaskActionOutcomeV1 = {
    kind: "unavailable",
    code: "candidatesExhausted",
    chainExhaustion: {
      stage: "plan",
      candidates: [
        {
          storedModelId: "kimi-code/k3.1-pro@max",
          providerLabel: "Kimi Code CLI",
          runnerId: "kimi-cli",
          reason: "429 You've reached your 5-hour usage limit",
        },
        {
          storedModelId: "llmgateway-devpass/claude-opus-5-5",
          providerLabel: "devpass",
          runnerId: "devpass-cli",
          reason: "Unauthorized: This LLMGateway API token is not active",
        },
      ],
    },
  };

  void it("names every candidate's own reason and says every model failed", () => {
    const failure = describeTaskActionFailureV1(exhausted);
    assert.match(failure, /^every model failed: /);
    assert.match(failure, /5-hour usage limit/);
    assert.match(failure, /token is not active/);
    const log = describeTaskActionOutcomeForLogV1(exhausted);
    assert.match(log, /Status: unavailable \(candidatesExhausted\) — every model failed:/);
    assert.match(log, /5-hour usage limit/);
    assert.match(log, /token is not active/);
  });

  void it("keeps the bare code when no candidate detail is recorded", () => {
    const bare: TaskActionOutcomeV1 = { kind: "unavailable", code: "candidatesExhausted" };
    assert.equal(describeTaskActionFailureV1(bare), "candidatesExhausted");
    assert.equal(describeTaskActionOutcomeForLogV1(bare), "Status: unavailable (candidatesExhausted)");
  });
});

void describe("plateau card 'Keep iterating' wording (bugs3 Step 4, Fast Forward and plain)", () => {
  const base = {
    blockersCount: 2,
    primaryBlockerDescription: "Plan lacks a rollback step",
    allBlockerDescriptions: ["Plan lacks a rollback step", "Plan lacks an owner"],
    narrowedNote: "",
    progressNote: "",
    taskFixableCount: 2,
    hasSpecDefect: false,
    hasDeclinedBlocker: false,
    hasNonFixableBlocker: false,
    nextStageHasRun: false,
    clearingNote: "",
    dispatchModeEvidence: [],
    planItemsOpen: 0,
  };
  const target = { canonicalId: "c", taskFolderPath: "/nonexistent-task-folder-for-wording-test" };

  void it("at a plan-review stage the option says the round revises plan.md and edits no code", () => {
    const card = buildEscalationDecisionV1("plateau", "plan-high-review", "plateau", target, base);
    const option = card.options.find((o) => o.optionId === "keepIterating");
    assert.ok(option, "keepIterating is offered");
    assert.match(option.consequence, /revises the plan \(plan\.md\); it does not edit code/);
    assert.doesNotMatch(option.consequence, /edits the workspace/);
  });

  void it("at an implementation-review stage the option says the round edits code", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, base);
    const option = card.options.find((o) => o.optionId === "keepIterating");
    assert.ok(option, "keepIterating is offered");
    assert.match(option.consequence, /edits code to address the review's findings/);
    assert.doesNotMatch(option.consequence, /does not edit code/);
  });

  void it("during a Fast Forward run the resume option names the stage's fix round and keeps its iteration budget", () => {
    const folder = "/nonexistent-task-folder-for-wording-ff";
    __resetFastForwardRunsForTestV1();
    markFastForwardRunActiveV1(folder, { attemptNumber: 3, maxAttempts: 30 });
    try {
      const ffTarget = { canonicalId: "c", taskFolderPath: folder };
      const plan = buildEscalationDecisionV1("plateau", "plan-high-review", "plateau", ffTarget, base)
        .options.find((o) => o.optionId === "keepIterating");
      assert.ok(plan);
      assert.match(plan.label, /resume Fast Forward \(iteration 3 of 30\) from Apply Review/);
      assert.match(plan.consequence, /a round that revises the plan \(plan\.md\); it does not edit code/);
      assert.match(plan.consequence, /iteration 3 of 30/);
      const code = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", ffTarget, base)
        .options.find((o) => o.optionId === "keepIterating");
      assert.ok(code);
      assert.match(code.consequence, /a round that edits code to address the review's findings/);
    } finally {
      __resetFastForwardRunsForTestV1();
    }
  });
});
