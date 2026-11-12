/**
 * bugs7 (Step 16): the options the new cards build are in the decision-option inventory table
 * (`decisionOptionResumeKindTableV1.test.ts`). Each test below builds a real card and asserts the real `.effect` of
 * every option, so the table's "runtime-test" rows have a dispatch assertion to point at.
 */
import * as assert from "node:assert/strict";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import type * as vscode from "vscode";

import { postOwnerOnlyBlockersCardV1 } from "../commands/ownerPlanDecisionCommandV1";
import { buildAutomationStoppedCardInputV1, type AutomationStopFactsV1 } from "../utils/automationStopV1";
import { buildWithheldTestEvidenceCardInputV1 } from "../utils/withheldTestEvidenceCardV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import type { TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";

function commandOf(option: WorkflowDecisionOptionV1 | undefined): string {
  return option?.effect.kind === "command" ? option.effect.command : `(${option?.effect.kind ?? "missing"})`;
}

function stopFacts(stage: TaskStage, over: Partial<AutomationStopFactsV1> = {}): AutomationStopFactsV1 {
  return {
    taskFolderPath: "/tmp/.ensemble/option-dispatch-task",
    stage,
    ending: "fast-forward-stalled",
    stopReason: "nothing moved",
    score: 7,
    previousScore: 7,
    blockers: { fixFirst: 1, buildToClear: 0, notThisRound: 0 },
    planItems: { total: 5, settled: 3, open: 2, provisional: 0 },
    buildNext: [],
    dismissedDependencies: [],
    reviewClean: false,
    gateComplete: false,
    fastForwardWasRunning: false,
    ...over,
  };
}

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

void describe("the automation-stopped card's options dispatch what they say (bugs7 Step 16)", () => {
  void it("moveOn, moveOnAndFastForward, continueTheWork, startFastForward, runOneMoreCycle, runPublishChecksNow, changeStageModel and leaveWithMe each have their real effect", () => {
    const done = buildAutomationStoppedCardInputV1(
      stopFacts("impl-high-review", { ending: "stage-ready", reviewClean: true, gateComplete: true })
    );
    const moveOn = done.options.find((o) => o.optionId === "moveOn");
    const moveOnAndFastForward = done.options.find((o) => o.optionId === "moveOnAndFastForward");
    assert.equal(commandOf(moveOn), "vs-code-ai-helper.nextStage");
    assert.equal(commandOf(moveOnAndFastForward), "vs-code-ai-helper.fastForwardReviewWithAI");
    assert.equal(moveOnAndFastForward?.resumeKind, "continue");
    assert.equal(moveOn?.resumeKind, "continue");

    const impl = buildAutomationStoppedCardInputV1(stopFacts("impl"));
    assert.equal(commandOf(impl.options.find((o) => o.optionId === "continueTheWork")), "vs-code-ai-helper.resumeAndApplyCurrentStageAction");

    const open = buildAutomationStoppedCardInputV1(
      stopFacts("impl-high-review", {
        failingTestsBlockers: 1,
        repeatedRejection: { kind: "checklist-claim", count: 4, lastReason: "no passing test report" },
      })
    );
    assert.equal(commandOf(open.options.find((o) => o.optionId === "startFastForward")), "vs-code-ai-helper.fastForwardReviewWithAI");
    assert.equal(commandOf(open.options.find((o) => o.optionId === "runOneMoreCycle")), "vs-code-ai-helper.resumeAndApplyCurrentStageAction");
    assert.match(commandOf(open.options.find((o) => o.optionId === "runPublishChecksNow")), /^vs-code-ai-helper\./);
    assert.equal(commandOf(open.options.find((o) => o.optionId === "changeStageModel")), "vs-code-ai-helper.openAiModels");
    const leave = open.options.find((o) => o.optionId === "leaveWithMe");
    assert.equal(leave?.effect.kind, "doNothing");
    assert.equal(leave?.resumeKind, "unpause");
  });
});

void describe("the withheld-evidence card's options dispatch what they say (bugs7 Step 6)", () => {
  void it("runChecks, recordRun and tickThese run commands and notNow does nothing", () => {
    const card = buildWithheldTestEvidenceCardInputV1({
      taskFolderPath: "/tmp/.ensemble/option-dispatch-task",
      stage: "impl-high-review",
      taskLabel: "task",
      items: ["Step 11: tests"],
    });
    assert.match(commandOf(card.options.find((o) => o.optionId === "runChecks")), /^vs-code-ai-helper\./);
    assert.equal(commandOf(card.options.find((o) => o.optionId === "recordRun")), "vs-code-ai-helper.postOwnerTestRunCard");
    assert.match(commandOf(card.options.find((o) => o.optionId === "tickThese")), /^vs-code-ai-helper\./);
    const notNow = card.options.find((o) => o.optionId === "notNow");
    assert.equal(notNow?.effect.kind, "doNothing");
    assert.equal(notNow?.resumeKind, "unpause");
    assert.equal(card.options.find((o) => o.optionId === "tickThese")?.resumeKind, "continue");
  });
});

void describe("the owner-only-blockers card's options dispatch what they say (bugs7 Step 13)", () => {
  void it("applyReviewToBuild runs Apply Review, settleItem and changePlan open their forms, notNow does nothing", async () => {
    __extensionContextV1TestOnly.set({
      workspaceState: new FakeMemento() as unknown as vscode.Memento,
      globalState: new FakeMemento() as unknown as vscode.Memento,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    const withWork = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: nodePath.join("/tmp", ".ensemble", "option-dispatch-build"),
      stage: "impl-high-review",
      blockerDescriptions: ["Step 12 rewording per owner decision x is not applied"],
      buildNext: ["Build Step 12's rewording"],
    });
    assert.ok(withWork);
    const apply = withWork.options.find((o) => o.optionId === "applyReviewToBuild");
    assert.equal(commandOf(apply), "vs-code-ai-helper.resumeAndApplyCurrentStageAction");
    assert.equal(apply?.resumeKind, "continue");

    const tick = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: nodePath.join("/tmp", ".ensemble", "option-dispatch-tick"),
      stage: "impl-high-review",
      blockerDescriptions: ["Step 6 owner decision: token hand-off versus the simpler design"],
    });
    assert.ok(tick);
    const settle = tick.options.find((o) => o.optionId === "settleItem");
    assert.equal(commandOf(settle), "vs-code-ai-helper.settleChecklistItem");
    assert.equal(settle?.resumeKind, "unpause");
    const notNow = tick.options.find((o) => o.optionId === "notNow");
    assert.equal(notNow?.effect.kind, "doNothing");

    const plan = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: nodePath.join("/tmp", ".ensemble", "option-dispatch-plan"),
      stage: "plan-low-review",
      blockerDescriptions: ["Narrowing needs an owner decision: the no-pop-ups rule is only partially delivered"],
    });
    assert.ok(plan);
    const change = plan.options.find((o) => o.optionId === "changePlan");
    assert.equal(commandOf(change), "vs-code-ai-helper.openPlanNonGoals");
    assert.equal(change?.resumeKind, "unpause");
  });
});
