/**
 * bugs3 Step 7 (open items 11–17): the shared deferred-scope classification
 * applied at the readiness gates — the review-text contradiction check, the
 * progress gate, the checklist-behind card's split lists and carried owner
 * evidence — each with a control where the work is still required.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDeferredPlanScopeV1,
  deferredOrGatedStepNumbersV1,
  describeCarriedGateReportV1,
  describeDeferredChecklistCountsV1,
  extractCarriedGatesV1,
  findPlanCreatedResourceV1,
  gatesOutsideDeliverableV1,
  partitionCarriedEvidenceBlockersV1,
  settleDeferredInProgressV1,
  splitUnfinishedItemsByScopeV1,
  summarizeCarriedEvidenceV1,
} from "../utils/deferredPlanScopeV1";
import * as vscode from "vscode";
import { buildEscalationDecisionV1, carriedGatesForStageV1 } from "../utils/reviewEscalation";
import { decideReviewRoute } from "../utils/reviewRouting";
import type { ReviewBlocker } from "../utils/reviewReadiness";
import { findUnbuiltStepsWithoutCompletionBlockerV1 } from "../utils/reviewUnbuiltStepsV1";

const TASK_MD = [
  "# Task",
  "",
  "## Task Description",
  "",
  "Produce the initial proposal. Plan Steps 3–12 wait for owner approval of the proposal; do not build them in this task yet.",
  "",
  "## Draft",
].join("\n");

const PLAN = [
  "# Plan",
  "",
  "PART 0 may finish with the root-recovery gate OPEN; Steps 4, 6, 9 and 12 wait on it.",
  "",
  "### 1. Inventory",
  "- [x] Inventory the accounts",
  "- [ ] Record the registrar owner",
  "",
  "### 2. Proposal",
  "- [ ] Write the proposal document",
  "",
  "### 3. Create the backup account",
  "- [ ] Create the account",
  "",
  "### 4. Escrow",
  "- [ ] Escrow the root secret",
].join("\n");

const PROSE_REVIEW = [
  "# Review",
  "",
  "Readiness: 9/10",
  "",
  "## Verdict",
  "",
  "**Coverage:** Steps 3–4 remain intentionally unbuilt pending owner approval; their absence is not a blocker.",
  "",
  "<!-- blockers:start -->",
  "<!-- blockers:end -->",
].join("\n");

void describe("deferred scope at readiness gates (bugs3 Step 7)", () => {
  const scope = classifyDeferredPlanScopeV1({ planText: PLAN, taskMd: TASK_MD });

  void it("the review-text check ignores a sentence that names only deferred or gated steps", () => {
    const steps = deferredOrGatedStepNumbersV1(scope);
    assert.ok(steps.has(3) && steps.has(4));
    assert.equal(findUnbuiltStepsWithoutCompletionBlockerV1(PROSE_REVIEW, steps), undefined);
  });

  void it("control: without the classification, or with a still-required step named, the contradiction stands", () => {
    assert.ok(findUnbuiltStepsWithoutCompletionBlockerV1(PROSE_REVIEW));
    const mixed = PROSE_REVIEW.replace("Steps 3–4 remain", "Steps 2–4 remain");
    assert.ok(findUnbuiltStepsWithoutCompletionBlockerV1(mixed, deferredOrGatedStepNumbersV1(scope)));
  });

  void it("review prose alone never defers: an empty plan scope leaves the check unchanged", () => {
    const empty = classifyDeferredPlanScopeV1({ planText: PLAN, taskMd: "# Task\n\n## Task Description\n\nBuild everything.\n" });
    const steps = deferredOrGatedStepNumbersV1(empty);
    assert.equal(steps.has(3), false);
    assert.ok(findUnbuiltStepsWithoutCompletionBlockerV1(PROSE_REVIEW, steps));
  });

  void it("deferred open items are settled for the progress gate, never past the total", () => {
    assert.deepEqual(settleDeferredInProgressV1({ complete: 1, total: 5 }, scope.counts.deferred), {
      complete: Math.min(5, 1 + scope.counts.deferred),
      total: 5,
    });
    assert.deepEqual(settleDeferredInProgressV1({ complete: 4, total: 5 }, 9), { complete: 5, total: 5 });
    assert.equal(settleDeferredInProgressV1(null, 3), null);
  });

  void it("the checklist-behind lists keep open, deferred and gated work apart", () => {
    const split = splitUnfinishedItemsByScopeV1(scope, { maxItems: 10, maxItemChars: 240 });
    assert.deepEqual(split.open.items, ["Record the registrar owner", "Write the proposal document"]);
    assert.equal(split.deferred.total, scope.counts.deferred);
    assert.ok(split.deferred.items.includes("Create the account"));
    assert.equal(split.open.total + split.deferred.total + split.gated.total, 4);
  });

  void it("lists are capped and long items are shortened", () => {
    const split = splitUnfinishedItemsByScopeV1(scope, { maxItems: 1, maxItemChars: 8 });
    assert.equal(split.open.items.length, 1);
    assert.equal(split.open.total, 2);
    assert.ok(split.open.items[0]!.length <= 8);
  });
});

void describe("carried owner evidence (bugs3 Step 7)", () => {
  const gates = extractCarriedGatesV1(PLAN);
  const isEvidence = (description: string): boolean => /^\W*owner evidence needed\b/i.test(description);

  void it("blockers that are all evidence for a carried gate's steps are carried", () => {
    const summary = summarizeCarriedEvidenceV1(
      [{ description: "Owner evidence needed before Step 4: backup-account root recovery access." }],
      { carriedGates: gates },
      isEvidence
    );
    assert.equal(summary.allCarried, true);
    assert.equal(summary.gates.length, 1);
  });

  void it("control: any other blocker keeps the stage held", () => {
    const summary = summarizeCarriedEvidenceV1(
      [
        { description: "Owner evidence needed before Step 4: root recovery access." },
        { description: "Step 2 omits the proposal's acceptance criteria." },
      ],
      { carriedGates: gates },
      isEvidence
    );
    assert.equal(summary.allCarried, false);
  });

  void it("control: evidence the plan needs to be written, a step the gate does not gate, or no gate stays current", () => {
    const one = (description: string, carriedGates = gates) =>
      summarizeCarriedEvidenceV1([{ description }], { carriedGates }, isEvidence).allCarried;
    assert.equal(one("Owner evidence needed to write the plan: Step 4 assumptions."), false);
    assert.equal(one("Owner evidence needed before Step 5: DNS provider."), false);
    assert.equal(one("Owner evidence needed before Step 4: root recovery access.", []), false);
    assert.equal(
      summarizeCarriedEvidenceV1([], { carriedGates: gates }, isEvidence).allCarried,
      false
    );
  });
});

void describe("owner-evidence card recommendation (bugs3 Step 7)", () => {
  const description = "Owner evidence needed before Step 4: backup-account root recovery access.";
  const base = {
    blockersCount: 1,
    primaryBlockerDescription: description,
    allBlockerDescriptions: [description],
    narrowedNote: "",
    progressNote: "",
    taskFixableCount: 0,
    hasSpecDefect: false,
    hasDeclinedBlocker: false,
    hasNonFixableBlocker: true,
    nextStageHasRun: false,
    clearingNote: "",
    dispatchModeEvidence: [],
    planItemsOpen: 0,
    allBlockersNeedOwnerDecision: true,
  };
  const target = { canonicalId: "c", taskFolderPath: "/t" };
  const recommended = (card: { recommendation?: unknown }): string | undefined =>
    (card.recommendation as { optionId?: string } | undefined)?.optionId;

  void it("a carried gate recommends advancing, not leaving the task paused", () => {
    const card = buildEscalationDecisionV1("plateau", "plan-low-review", "plateau", target, {
      ...base,
      allBlockersCarriedGates: true,
    });
    assert.equal(recommended(card), "advance");
  });

  void it("control: the same blocker without a carried gate still recommends the option that records the owner's decision", () => {
    // review1 Step 38: "Leave it paused" does nothing, so it is not recommended while "Change the plan instead"
    // (which opens the file the decision is written in) exists. At a plan stage that is the recommendation.
    const card = buildEscalationDecisionV1("plateau", "plan-low-review", "plateau", target, base);
    assert.equal(recommended(card), "reconsiderRequirement");
  });

  void it("control: a carried gate with task-fixable work left keeps the normal recommendation", () => {
    const card = buildEscalationDecisionV1("plateau", "plan-low-review", "plateau", target, {
      ...base,
      blockersCount: 2,
      taskFixableCount: 1,
      allBlockersCarriedGates: true,
      allBlockersNeedOwnerDecision: false,
    });
    assert.notEqual(recommended(card), "advance");
  });
});

void describe("carried gates at the route decision (bugs3 Step 7)", () => {
  const gates = extractCarriedGatesV1(PLAN);
  const isEvidence = (description: string): boolean => /^\W*owner evidence needed\b/i.test(description);
  const evidence: ReviewBlocker = {
    category: "completion",
    resolver: "environmental",
    description: "Owner evidence needed before Step 4: backup-account root recovery access.",
  };
  const planNeeds: ReviewBlocker = {
    category: "completion",
    resolver: "environmental",
    description: "Owner evidence needed to write the plan: the registrar account list.",
  };
  const fixable: ReviewBlocker = {
    category: "completion",
    resolver: "task-fixable",
    description: "Step 2 omits the acceptance check.",
  };
  const route = (blockers: ReviewBlocker[], carried: ReviewBlocker[], score: number): ReturnType<typeof decideReviewRoute> =>
    decideReviewRoute({
      score,
      threshold: 8,
      blockers,
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
      carriedGateBlockers: carried,
    });

  void it("partitions blocker by blocker, keeping evidence the plan needs and other blockers", () => {
    const parts = partitionCarriedEvidenceBlockersV1([evidence, planNeeds, fixable], { carriedGates: gates }, isEvidence);
    assert.deepEqual(parts.carried, [evidence]);
    assert.deepEqual(parts.remaining, [planNeeds, fixable]);
  });

  void it("at Publish a gate whose dependent steps are all deferred or gated is outside the deliverable", () => {
    const outside = gatesOutsideDeliverableV1(classifyDeferredPlanScopeV1({ planText: PLAN, taskMd: TASK_MD }));
    // Steps 4, 6, 9 and 12 wait on the gate, but Steps 6, 9 and 12 do not exist in this plan, so it stays held.
    assert.equal(outside.length, 0);
    const small = ["# Plan", "", "The root gate is OPEN; Step 2 waits on it.", "", "### 1. Inventory", "- [x] Inventory", "", "### 2. Escrow", "- [ ] Escrow the secret"].join("\n");
    assert.equal(gatesOutsideDeliverableV1(classifyDeferredPlanScopeV1({ planText: small, taskMd: "" })).length, 1);
  });

  void it("control: once a dependent step is built the gate is part of the deliverable", () => {
    const built = ["# Plan", "", "The root gate is OPEN; Step 2 waits on it.", "", "### 1. Inventory", "- [x] Inventory", "", "### 2. Escrow", "- [x] Escrow the secret"].join("\n");
    assert.equal(gatesOutsideDeliverableV1(classifyDeferredPlanScopeV1({ planText: built, taskMd: "" })).length, 0);
  });

  void it("a carried gate alone does not hold a stage that meets the threshold", () => {
    assert.equal(route([evidence], [evidence], 8).route, "advance");
  });

  void it("below threshold with only a carried gate it asks to advance rather than iterating", () => {
    const decision = route([evidence], [evidence], 6);
    assert.equal(decision.route, "escalate");
    assert.match(decision.reason, /carries to named later steps/);
  });

  void it("control: without the carried set the same blocker is only a note at threshold", () => {
    assert.equal(route([evidence], [], 8).route, "advance-with-note");
  });

  void it("control: a task-fixable blocker next to a carried gate still iterates", () => {
    assert.equal(route([evidence, fixable], [evidence], 6).route, "iterate");
  });

  void it("control: evidence the plan needs is not carried and still escalates", () => {
    assert.equal(route([planNeeds], [], 6).route, "escalate");
  });
});

void describe("evidence about a resource the plan will create (bugs3 Step 7)", () => {
  const PLAN_CREATES = [
    "# Plan",
    "",
    "### 1. Inventory",
    "- [x] Inventory the accounts",
    "",
    "### 6. Backup account",
    "- [ ] Create the backup account",
  ].join("\n");
  const BLOCKER =
    "Owner evidence needed: backup account root/MFA recovery access from a second recovery session or device.";
  const isEvidence = (d: string): boolean => /^Owner evidence needed/i.test(d);

  void it("finds the open step that creates the resource the evidence is about", () => {
    const found = findPlanCreatedResourceV1(BLOCKER, PLAN_CREATES);
    assert.equal(found?.stepNumber, 6);
    assert.match(found?.resource ?? "", /backup account/i);
  });

  void it("carries such evidence with a gate naming the resource and the creating step", () => {
    const summary = summarizeCarriedEvidenceV1([{ description: BLOCKER }], { carriedGates: [], planText: PLAN_CREATES }, isEvidence);
    assert.equal(summary.allCarried, true);
    assert.deepEqual(summary.gates[0]?.dependentSteps, [6]);
    assert.ok(summary.gates[0]?.createdResource);
  });

  void it("control: once the creating step is built the resource exists and the evidence is not carried", () => {
    const built = PLAN_CREATES.replace("- [ ] Create", "- [x] Create");
    assert.equal(findPlanCreatedResourceV1(BLOCKER, built), undefined);
    assert.equal(summarizeCarriedEvidenceV1([{ description: BLOCKER }], { carriedGates: [], planText: built }, isEvidence).allCarried, false);
  });

  void it("control: evidence about something else, or a one-word generic resource, is not carried", () => {
    assert.equal(findPlanCreatedResourceV1("Owner evidence needed: registrar ownership proof.", PLAN_CREATES), undefined);
    const generic = ["### 2. X", "- [ ] Create the account"].join("\n");
    assert.equal(findPlanCreatedResourceV1("Owner evidence needed: account ownership.", generic), undefined);
  });

  void it("control: without the plan text nothing is inferred, and evidence the plan needs still holds", () => {
    assert.equal(summarizeCarriedEvidenceV1([{ description: BLOCKER }], { carriedGates: [] }, isEvidence).allCarried, false);
    const needed = `${BLOCKER} This is required to write the plan.`;
    assert.equal(
      partitionCarriedEvidenceBlockersV1([{ description: needed }], { carriedGates: [], planText: PLAN_CREATES }, isEvidence).carried.length,
      0
    );
  });
});

void describe("carried-gate report (bugs3 Step 7)", () => {
  const gate = [{ description: "Owner evidence needed: root recovery access." }];

  void it("at Publish it says the gate is reported, not a failed check", () => {
    const text = describeCarriedGateReportV1(gate, "Publish", true);
    assert.match(text, /does not depend on/);
    assert.match(text, /not counted as a failed check/);
    assert.match(text, /root recovery access/);
  });

  void it("at another stage it says the dependent steps stay gated and never claims the evidence exists", () => {
    const text = describeCarriedGateReportV1(gate, "High-Level Review (Plan)", false);
    assert.match(text, /stay gated/);
    assert.match(text, /has not been recorded/);
  });

  void it("is empty when nothing was carried", () => {
    assert.equal(describeCarriedGateReportV1([], "Publish", true), "");
  });
});

void describe("deferred counts line for the Tasks tree (bugs3 Step 7)", () => {
  void it("names deferred and gated items apart from open work, and is empty when there are none", () => {
    assert.match(describeDeferredChecklistCountsV1({ deferred: 3, gated: 2 }), /3 deferred.*2 waiting on a carried owner gate/);
    assert.equal(describeDeferredChecklistCountsV1({ deferred: 0, gated: 0 }), "");
  });
});

void describe("the escalation card reads the route's stage-aware carried gates (bugs3 Step 7)", () => {
  const SMALL_OPEN = [
    "# Plan",
    "",
    "The root gate is OPEN; Step 2 waits on it.",
    "",
    "### 1. Inventory",
    "- [x] Inventory",
    "",
    "### 2. Escrow",
    "- [ ] Escrow the secret",
  ].join("\n");
  const SMALL_BUILT = SMALL_OPEN.replace("- [ ] Escrow", "- [x] Escrow");
  const folder = vscode.Uri.file("/nonexistent-task-folder");

  void it("at a code-review stage a gate whose dependent step is built is not carried", async () => {
    assert.equal((await carriedGatesForStageV1(folder, "impl-high-review", SMALL_BUILT)).length, 0);
  });

  void it("control: at a code-review stage a gate whose dependent step is still gated stays carried", async () => {
    assert.equal((await carriedGatesForStageV1(folder, "impl-high-review", SMALL_OPEN)).length, 1);
  });

  void it("control: at a plan-review stage every gate the plan marks open is carried", async () => {
    assert.equal((await carriedGatesForStageV1(folder, "plan-high-review", SMALL_BUILT)).length, 1);
  });
});
