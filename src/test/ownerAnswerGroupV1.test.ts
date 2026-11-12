/**
 * review2 Step 41 (Part 8): the round's card is folded into the review's card by step or plan-item id and its body is
 * carried over; cards raised together form one group, and the follow-up run starts once the group is answered.
 */
import * as assert from "node:assert/strict";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { beforeEach, describe, it } from "node:test";
import {
  decideFollowUpRunV1,
  describeDecisionGroupV1,
  describeHeldFollowUpRunV1,
  heldWritesRemainingV1,
  noteHeldWriteV1,
  releaseHeldWriteV1,
  resetOwnerAnswerGroupsV1TestOnly,
} from "../utils/ownerAnswerGroupV1";
import {
  followUpAfterOwnerAnswerV1,
  namedPlanReferencesV1,
  raiseOwnerDecisionCardsFromReviewV1,
  raisePlanDeviationCardsV1,
  type OwnerFollowUpDepsV1,
  type RecordOwnerPlanDecisionArgV1,
} from "../commands/ownerPlanDecisionCommandV1";
import { listPendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { normalizePath } from "../utils/taskRoot";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";

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

function makeExtensionContext(): vscode.ExtensionContext {
  const memento = new FakeMemento();
  return {
    workspaceState: memento as unknown as vscode.Memento,
    globalState: memento as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

void describe("review2 Step 41: one card per deviation, matched by step or plan-item id", () => {
  void it("names the steps and the item ids a text refers to", () => {
    const refs = namedPlanReferencesV1("Step 24 and [item:ab12cd34] and Steps 7");
    assert.deepEqual([...refs.steps].sort((a, b) => a - b), [7, 24]);
    assert.deepEqual([...refs.itemIds], ["ab12cd34"]);
  });

  const ROUND = [
    "## Plan deviations",
    "",
    "- **The waiting row is built in the registry.** The plan names `[item:0a1b2c3d4e5f6071]`; the check lives elsewhere.",
    "  - Why: the registry is the one place every start passes.",
  ].join("\n");
  const REVIEW = [
    "Readiness: 7/10",
    "",
    "## Owner decisions needed",
    "",
    "### Waiting row place",
    "- id: waiting-row-place",
    "- what this part of the plan is for: the waiting row of [item:0a1b2c3d4e5f6071].",
    "- what is undecided or went wrong: the check is in the registry, not where the plan says.",
    "- options:",
    "  - accept: Accept the registry — trade-off: one more place to read.",
    "  - keep: Keep the plan as written — trade-off: a second check.",
    "- recommendation: keep — the plan is approved.",
  ].join("\n");

  void it("folds by plan-item id when neither text names a step, and carries the round's body on the review's card", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "fold-by-item-id");
    const canonicalId = normalizePath(folder);
    const fromRound = await raisePlanDeviationCardsV1(folder, "impl-high-review", ROUND, { roundName: "Apply Review" });
    assert.equal(fromRound.length, 1);
    const fromReview = await raiseOwnerDecisionCardsFromReviewV1(folder, "impl-high-review", REVIEW);
    assert.equal(fromReview.length, 1);
    const pending = listPendingWorkflowDecisionsForTaskV1(canonicalId).filter((card) =>
      card.decisionKey.startsWith("ownerPlanDecision:")
    );
    assert.deepEqual(pending.map((card) => card.decisionKey), ["ownerPlanDecision:waiting-row-place"]);
    const carried = (pending[0]!.evidence ?? []).map((entry) => entry.detail).join("\n");
    assert.match(carried, /What the round reported:/);
    assert.match(carried, /registry is the one place every start passes/);
    // The review's own options are the ones the card offers.
    assert.ok(pending[0]!.options.some((option) => option.optionId === "keep"));
  });

  void it("a round's card about an item a pending review decision already covers is not raised", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "fold-by-item-id-second");
    await raiseOwnerDecisionCardsFromReviewV1(folder, "impl-high-review", REVIEW);
    const fromRound = await raisePlanDeviationCardsV1(folder, "impl-high-review", ROUND, { roundName: "Apply Review" });
    assert.equal(fromRound.length, 0);
  });

  void it("cards about different items are not folded together", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "fold-unrelated");
    const canonicalId = normalizePath(folder);
    await raisePlanDeviationCardsV1(
      folder,
      "impl-high-review",
      ROUND.replace("0a1b2c3d4e5f6071", "ffffffffffffffff"),
      { roundName: "Apply Review" }
    );
    await raiseOwnerDecisionCardsFromReviewV1(folder, "impl-high-review", REVIEW);
    const keys = listPendingWorkflowDecisionsForTaskV1(canonicalId).map((card) => card.decisionKey);
    assert.equal(keys.filter((key) => key.startsWith("ownerPlanDecision:")).length, 2);
  });
});

void describe("review2 Step 41: cards from one round are a group", () => {
  beforeEach(() => resetOwnerAnswerGroupsV1TestOnly());

  void it("counts the decisions", () => {
    assert.equal(describeDecisionGroupV1(2), "2 decisions from this round");
    assert.equal(describeDecisionGroupV1(1), "1 decision from this round");
    assert.match(describeHeldFollowUpRunV1(3), /3 decisions from this round are answered/);
    assert.match(describeHeldFollowUpRunV1(3), /Run now/);
  });

  void it("decides: start only when nothing else of the group is open", () => {
    const base = { startsRun: true, openSiblings: 0, heldWritesRemaining: 0, owedFromEarlier: false };
    assert.deepEqual(decideFollowUpRunV1(base), { action: "start" });
    assert.deepEqual(decideFollowUpRunV1({ ...base, openSiblings: 3 }), { action: "hold", open: 3 });
    assert.deepEqual(decideFollowUpRunV1({ ...base, heldWritesRemaining: 1 }), { action: "hold", open: 1 });
    assert.deepEqual(decideFollowUpRunV1({ ...base, startsRun: false }), { action: "none" });
    assert.deepEqual(decideFollowUpRunV1({ ...base, startsRun: false, owedFromEarlier: true }), { action: "start-owed" });
    assert.deepEqual(decideFollowUpRunV1({ ...base, startsRun: false, owedFromEarlier: true, openSiblings: 1 }), { action: "none" });
  });

  void it("tracks answers whose write is still held", () => {
    noteHeldWriteV1("/t", "a");
    noteHeldWriteV1("/t", "b");
    assert.equal(heldWritesRemainingV1("/t", "a"), 1);
    releaseHeldWriteV1("/t", "b");
    assert.equal(heldWritesRemainingV1("/t", "a"), 0);
  });

  const ARG = (blockerId: string, extra: Partial<RecordOwnerPlanDecisionArgV1> = {}): RecordOwnerPlanDecisionArgV1 => ({
    taskFolderPath: "/tmp/.ensemble/group-task",
    stage: "impl-high-review",
    blockerId,
    optionId: "x",
    optionLabel: "x",
    ...extra,
  });

  function fakeDeps(open: { value: number }) {
    const log = { started: [] as string[], said: [] as string[], offered: 0 };
    const deps: OwnerFollowUpDepsV1 = {
      openSiblings: () => open.value,
      start: (arg) => {
        log.started.push(arg.blockerId);
        return Promise.resolve({ kind: "started" } as const);
      },
      say: (_arg, text) => {
        log.said.push(text);
        return Promise.resolve();
      },
      offerRunNow: () => {
        log.offered += 1;
        return Promise.resolve();
      },
      reviewStartedSince: () => Promise.resolve(false),
    };
    return { deps, log };
  }

  void it("run1 05:44 replay: answering the review's card first holds its run until the three round cards are answered", async () => {
    const open = { value: 3 };
    const { deps, log } = fakeDeps(open);
    // The owner answers the review's card ("Allow escalation countdowns") first: three round cards are still open.
    assert.equal((await followUpAfterOwnerAnswerV1(ARG("review-card"), deps)).kind, "held");
    assert.deepEqual(log.started, [], "no review starts at once");
    assert.equal(log.offered, 1, "the Run now card is offered");
    assert.match(log.said[0]!, /3 decisions from this round/);
    // Two deviation approvals follow: they start nothing and the group is still not complete.
    const approve = (id: string) => ARG(id, { planAction: { kind: "approveDeviation" } });
    open.value = 2;
    await followUpAfterOwnerAnswerV1(approve("d1"), deps);
    open.value = 1;
    await followUpAfterOwnerAnswerV1(approve("d2"), deps);
    assert.deepEqual(log.started, []);
    // The last approval completes the group: the run the first answer owed now starts, once.
    open.value = 0;
    await followUpAfterOwnerAnswerV1(approve("d3"), deps);
    assert.deepEqual(log.started, ["review-card"]);
    // Nothing is owed any more.
    await followUpAfterOwnerAnswerV1(approve("d4"), deps);
    assert.deepEqual(log.started, ["review-card"]);
  });

  void it("an answer with no siblings starts its run at once", async () => {
    const { deps, log } = fakeDeps({ value: 0 });
    assert.equal((await followUpAfterOwnerAnswerV1(ARG("only"), deps)).kind, "started");
    assert.deepEqual(log.started, ["only"]);
    assert.equal(log.offered, 0);
  });

  void it("a run overtaken by 'Run now' is not started a second time", async () => {
    const open = { value: 1 };
    const { deps, log } = fakeDeps(open);
    await followUpAfterOwnerAnswerV1(ARG("review-card"), deps);
    open.value = 0;
    const overtaken: OwnerFollowUpDepsV1 = { ...deps, reviewStartedSince: () => Promise.resolve(true) };
    await followUpAfterOwnerAnswerV1(ARG("d1", { planAction: { kind: "approveDeviation" } }), overtaken);
    assert.deepEqual(log.started, []);
  });

  void it("an answer whose plan write is still held keeps the group open", async () => {
    const { deps, log } = fakeDeps({ value: 0 });
    noteHeldWriteV1(normalizePath("/tmp/.ensemble/group-task"), "held-one");
    await followUpAfterOwnerAnswerV1(ARG("review-card"), deps);
    assert.deepEqual(log.started, []);
    releaseHeldWriteV1(normalizePath("/tmp/.ensemble/group-task"), "held-one");
    await followUpAfterOwnerAnswerV1(ARG("held-one", { planAction: { kind: "approveDeviation" } }), deps);
    assert.deepEqual(log.started, ["review-card"]);
  });
});
