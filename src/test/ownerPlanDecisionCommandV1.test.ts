/**
 * bugs5 Step 22-24: Owner decisions needed parser, card generator, command execution,
 * plan deviations, and agent-gatherable evidence routing.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { describe, it, afterEach, after } from "node:test";
import {
  parseOwnerDecisionsNeededV1,
  parsePlanDeviationsV1,
  parseReviewBlockers,
  parseReviewBlockersDetailed,
} from "../utils/reviewReadiness";
import { blockerOwnerIdentityV1 } from "../utils/ownerCardCoverageV1";
import {
  describeOwnerAnswerNextV1,
  executeOwnerPlanDecisionLockedV1,
  findAmbiguousRewordTargetV1,
  ownerOptionNeedsCodeChangeV1,
  postOwnerOnlyBlockersCardV1,
  postOwnerPlanDecisionCardV1,
  RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
  recordOwnerPlanDecisionV1,
  startReReviewAfterOwnerDecisionV1,
  type RecordOwnerPlanDecisionArgV1,
} from "../commands/ownerPlanDecisionCommandV1";
import { applyCurrentStageAction } from "../commands/applyCurrentStageAction";
import { resumeAndApplyCurrentStageActionV1 } from "../commands/resumeTask";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { taskOperations } from "../utils/taskOperations";
import { acquireWorkAdmissionV1 } from "../state/workAdmissionV1";
import { readChatHistory } from "../utils/chatHistoryStore";
import { isConversationEntryV1 } from "../views/chatTranscriptFilterV1";
import { cancelDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { releaseHeldWriteV1 } from "../utils/ownerAnswerGroupV1";
import { deactivateNotificationRouter, initNotificationRouter, NotificationRouter } from "../utils/notificationRouter";
import {
  listPendingWorkflowDecisionsForTaskV1,
  postWorkflowDecisionV1,
  withdrawWorkflowDecisionsByKeyV1,
} from "../utils/workflowDecisionDispatchV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import {
  __resetOwnerDecisionDeferralLinesV1,
  buildEscalationDecisionV1,
  classifyEnvironmentalBlockerV1,
  isOwnerDecisionBlockerV1,
  repostPlateauCardAfterOwnerDecisionV1,
  writeOwnerDecisionDeferralLineV1,
} from "../utils/reviewEscalation";
import { decideReviewRoute } from "../utils/reviewRouting";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { normalizePath } from "../utils/taskRoot";
import { listPlanItemSettlementV1 } from "../utils/implementationChecklist";
import { isOwnerEvidenceBlockerV1 } from "../utils/stageAdvanceOverrideV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { describeStageDispatchNotStartedV1 } from "../types/stageDispatchOutcomeV1";
import { formatOwnerDecisionsVariableV1 } from "../utils/reviewEvidenceNormalizerV1";
import type { TaskProgress } from "../types/taskProgress";
import {
  clearApplyReviewFocusV1,
  formatApplyReviewFocusBlockV1,
  peekApplyReviewFocusV1,
  setApplyReviewFocusV1,
} from "../utils/applyReviewFocusV1";

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

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-owner-decision-test-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

const STEP_6_REVIEW = [
  "Readiness: 6/10",
  "",
  "## Owner decisions needed",
  "",
  "### Step 6 admission-token owner decision",
  "- id: step-6-admission",
  "- what this part of the plan is for: Token hand-off during form submission.",
  "- what is undecided or went wrong: Simpler design built instead of token hand-off.",
  "- options:",
  "  - approve: Approve the simpler design (Recommended) — trade-off: simpler code.",
  "  - buildToken: Require token hand-off — trade-off: matches original plan.",
  "- recommendation: approve — simpler design.",
  "- technical details: In Step 6, the token hand-off was designed to avoid concurrent submit races.",
].join("\n");

void describe("bugs5 Step 23: Owner decisions needed parser and card generator", () => {
  afterEach(() => {
    __extensionContextV1TestOnly.reset();
  });

  void it("parses structured ## Owner decisions needed section into blocks", () => {
    const blocks = parseOwnerDecisionsNeededV1(STEP_6_REVIEW);
    assert.strictEqual(blocks.length, 1);
    const block = blocks[0]!;
    assert.strictEqual(block.id, "step-6-admission");
    assert.strictEqual(block.planPurpose, "Token hand-off during form submission.");
    assert.strictEqual(block.problem, "Simpler design built instead of token hand-off.");
    assert.ok(block.technicalDetails?.includes("Step 6, the token hand-off was designed"));
    assert.strictEqual(block.options.length, 2);
    assert.strictEqual(block.options[0]?.id, "approve");
    assert.ok(block.options[0]?.label.includes("Approve the simpler design"));
    assert.ok(!block.options[0]?.label.includes("Recommended"), "the (Recommended) marker is not part of the label");
    assert.strictEqual(block.options[1]?.id, "buildToken");
    assert.strictEqual(block.options[1]?.rejects, true, "an option that requires the plan as written rejects the change");
    assert.strictEqual(block.recommendation?.optionId, "approve");
    assert.strictEqual(block.recommendation?.reason, "simpler design.");
    assert.ok(block.rawContentHash.length > 0);
  });

  void it("keeps hyphenated words intact and splits a label from its trade-offs only at a spaced dash", () => {
    const blocks = parseOwnerDecisionsNeededV1(
      [
        "## Owner decisions needed",
        "### token-choice",
        "Plan purpose: Hand-off between the form and the round.",
        "Problem: The round built a marker instead of a token hand-off.",
        "Options:",
        "- Keep the marker — simpler, but a second form can still race",
        "- Use the token hand-off: one extra step per submit",
        "Recommendation: Keep the marker - it is already built and tested.",
      ].join("\n")
    );
    assert.strictEqual(blocks.length, 1);
    const [keep, token] = blocks[0]!.options;
    assert.strictEqual(keep?.label, "Keep the marker");
    assert.strictEqual(keep?.consequence, "simpler, but a second form can still race");
    assert.strictEqual(token?.label, "Use the token hand-off");
    assert.strictEqual(token?.consequence, "one extra step per submit");
    assert.strictEqual(blocks[0]!.recommendation?.optionId, keep?.id);
    assert.strictEqual(blocks[0]!.id, "token-choice");
  });

  void it("returns every block when the section holds several ### sub-blocks", () => {
    const blocks = parseOwnerDecisionsNeededV1(
      [
        "## Owner decisions needed",
        "### first",
        "- Problem: One.",
        "- Options:",
        "  - Approve it — fine",
        "  - Reject it — keep the plan",
        "### second",
        "- Problem: Two.",
        "- Options:",
        "  - Approve it — fine",
        "## Verified Complete",
        "- nothing",
      ].join("\n")
    );
    assert.deepStrictEqual(
      blocks.map((b) => b.id),
      ["first", "second"]
    );
    assert.strictEqual(blocks[0]!.problem, "One.");
    assert.notStrictEqual(blocks[0]!.rawContentHash, blocks[1]!.rawContentHash);
  });

  void it("returns nothing for a missing section or a 'None' section", () => {
    assert.deepStrictEqual(parseOwnerDecisionsNeededV1("Readiness: 9/10"), []);
    assert.deepStrictEqual(parseOwnerDecisionsNeededV1("## Owner decisions needed\n\nNone.\n"), []);
  });

  void it("carries the plan items an [exclude] option settles", () => {
    const blocks = parseOwnerDecisionsNeededV1(
      [
        "## Owner decisions needed",
        "### token-items",
        "Problem: The token items were not built.",
        "Plan items: `Mint the admission token` and `Adopt the admission token`",
        "Options:",
        "- Approve the simpler design [exclude] — the two token items are dropped",
        "- Reject it — build the token hand-off",
      ].join("\n")
    );
    const [approve, reject] = blocks[0]!.options;
    assert.deepStrictEqual(approve?.planAction, {
      kind: "exclude",
      items: ["Mint the admission token", "Adopt the admission token"],
    });
    assert.ok(!approve?.label.includes("[exclude]"));
    assert.strictEqual(reject?.planAction, undefined);
  });

  void it("parses ## Plan deviations bullets, and skips 'None'", () => {
    const deviations = parsePlanDeviationsV1(
      [
        "# Summary",
        "## Plan deviations",
        "- Used in-memory cache instead of Redis because Redis dependency was unavailable.",
        "- Excluded legacy fallback option in favor of simpler handler.",
        "## Verification",
      ].join("\n")
    );
    assert.strictEqual(deviations.length, 2);
    assert.ok(deviations[0]?.problem.includes("Used in-memory cache instead of Redis"));
    assert.ok(deviations[1]?.problem.includes("Excluded legacy fallback"));
    assert.notStrictEqual(deviations[0]?.id, deviations[1]?.id);
    assert.strictEqual(deviations[0]?.options[1]?.rejects, true);

    assert.deepStrictEqual(parsePlanDeviationsV1("## Plan deviations\nNone.\n## Files Changed"), []);
    assert.deepStrictEqual(parsePlanDeviationsV1("## Plan deviations\n- None\n## Files Changed"), []);
  });

  void it("posts owner plan decision card with details in the collapsible section", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const block = parseOwnerDecisionsNeededV1(STEP_6_REVIEW)[0]!;

    const card = await postOwnerPlanDecisionCardV1({
      taskFolderPath: nodePath.join(ROOT, ".ensemble", "card-task"),
      stage: "impl-high-review",
      block,
    });

    assert.ok(card);
    assert.strictEqual(card.decisionKey, "ownerPlanDecision:step-6-admission");
    assert.strictEqual(card.whatHappened, "Simpler design built instead of token hand-off.");
    assert.strictEqual(card.whyUserNeeded, "Token hand-off during form submission.");
    // The block's two options, plus review1 Step 40's "Answer in my own words…".
    assert.strictEqual(card.options.length, 3);
    assert.deepEqual(card.options.map((o) => o.optionId).slice(-1), ["ownWords"]);
    const recommendation = card.recommendation;
    assert.strictEqual(recommendation.kind, "option");
    if (recommendation.kind === "option") {
      assert.ok(card.options.some((o) => o.optionId === recommendation.optionId), "the recommendation names a real option");
    }
    for (const option of card.options) {
      assert.strictEqual(option.effect.kind, "command");
      if (option.effect.kind === "command") {
        assert.strictEqual(option.effect.command, RECORD_OWNER_PLAN_DECISION_COMMAND_V1);
      }
    }
    // Technical details sit behind the "Details" label, which the chat card renders collapsed.
    assert.ok(card.evidence?.some((e) => e.label === "Details" && e.detail.includes("concurrent submit races")));
  });
});

function makeTask(name: string, plan: string): string {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
  const progress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  } as TaskProgress;
  nodeFs.writeFileSync(nodePath.join(folder, "task-progress.json"), JSON.stringify(progress, undefined, 2), "utf8");
  return folder;
}

function readPlan(folder: string): string {
  return nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
}

function readProgress(folder: string): TaskProgress {
  return JSON.parse(nodeFs.readFileSync(nodePath.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
}

void describe("bugs5 Step 23: the owner-decision command records the answer without file edits", () => {
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;

  function patchReadFile(): void {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  }

  afterEach(() => {
    fsApi.readFile = origReadFile;
    __extensionContextV1TestOnly.reset();
  });

  const PLAN = [
    "# Plan",
    "- [ ] Mint the admission token",
    "- [ ] Adopt the admission token",
    "- [ ] Final verification",
  ].join("\n");

  void it("excludes the named items with a dated owner note, and records the supersession for both implementation reviews", async () => {
    patchReadFile();
    const folder = makeTask("exec-exclude", PLAN);

    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl",
      blockerId: "step-6-admission",
      optionId: "approve",
      optionLabel: "Approve the simpler design",
      planAction: { kind: "exclude", items: ["Mint the admission token", "Adopt the admission token"] },
    });

    const plan = readPlan(folder);
    const lines = plan.split("\n");
    for (const item of ["Mint the admission token", "Adopt the admission token"]) {
      const line = lines.find((l) => l.includes(item));
      assert.ok(line?.includes("<!-- ensemble:excluded -->"), `${item} is marked excluded`);
      assert.match(line ?? "", /Owner decision \d{4}-\d{2}-\d{2}: Approve the simpler design/);
    }
    assert.ok(!lines.find((l) => l.includes("Final verification"))?.includes("excluded"), "other items are untouched");

    const progress = readProgress(folder);
    assert.deepStrictEqual(
      (progress.blockerSupersessions ?? []).map((s) => s.stage).sort(),
      ["impl-high-review", "impl-low-review"]
    );
    assert.strictEqual(progress.planItemOwnerDecisions?.length, 2);
    assert.ok(progress.planItemOwnerDecisions?.every((d) => d.decision === "exclude"));
    const shown = formatOwnerDecisionsVariableV1("impl-high-review", progress.blockerSupersessions);
    assert.ok(shown.includes('the owner chose "Approve the simpler design"'), "the reviewer sees the owner's answer");
  });

  void it("review1 Step 4: a reword rewrites the occurrence asked for, and refuses to guess between identical items", async () => {
    patchReadFile();
    const twins = ["# Plan", "- [ ] Do the thing", "- [ ] Do the thing", "- [ ] Final verification"].join("\n");
    const base = {
      stage: "impl" as const,
      blockerId: "twin-item",
      optionId: "reword",
      optionLabel: "Reword it",
    };

    // The second of two identical items, named by occurrence: only that line changes.
    const second = makeTask("exec-reword-occurrence", twins);
    await executeOwnerPlanDecisionLockedV1({
      ...base,
      taskFolderPath: second,
      planAction: { kind: "reword", itemText: "Do the thing", newText: "Do the new thing", itemOccurrence: 2 },
    });
    const lines = readPlan(second).split("\n");
    assert.strictEqual(lines[1], "- [ ] Do the thing", "the first twin is untouched");
    assert.match(lines[2] ?? "", /^- \[ \] Do the new thing — Owner decision/);

    // No occurrence: the command refuses before recording anything, and the plan is not edited.
    const ambiguous = makeTask("exec-reword-ambiguous", twins);
    const arg = {
      ...base,
      taskFolderPath: ambiguous,
      planAction: { kind: "reword" as const, itemText: "Do the thing", newText: "Do the new thing" },
    };
    const found = await findAmbiguousRewordTargetV1(arg);
    assert.deepStrictEqual(found, { itemText: "Do the thing", count: 2 });
    await executeOwnerPlanDecisionLockedV1(arg);
    const after = readPlan(ambiguous);
    assert.ok(!after.includes("Do the new thing"), "neither twin was reworded");
    assert.strictEqual(after.match(/- \[ \] Do the thing/g)?.length, 2);

    // A single match needs no occurrence.
    const single = makeTask("exec-reword-single", PLAN);
    assert.strictEqual(
      await findAmbiguousRewordTargetV1({
        ...base,
        taskFolderPath: single,
        planAction: { kind: "reword", itemText: "Final verification", newText: "Final checks" },
      }),
      undefined
    );
  });

  void it("writes an Owner Decisions note when no item is named, once", async () => {
    patchReadFile();
    const folder = makeTask("exec-note", PLAN);
    const arg = {
      taskFolderPath: folder,
      stage: "impl-high-review" as const,
      blockerId: "plan-deviation-ab12cd34",
      optionId: "approve-deviation",
      optionLabel: "Approve plan deviation",
      planAction: { kind: "approveDeviation" as const },
    };
    await executeOwnerPlanDecisionLockedV1(arg);
    await executeOwnerPlanDecisionLockedV1(arg);

    const plan = readPlan(folder);
    assert.strictEqual(plan.match(/## Owner Decisions/g)?.length, 1);
    assert.strictEqual(plan.match(/plan-deviation-ab12cd34/g)?.length, 1, "the same note is not written twice");
    assert.ok(plan.includes("- [ ] Final verification"), "the checklist is untouched");
    assert.strictEqual(readProgress(folder).blockerSupersessions?.length, 1);
  });

  void it("review1 Step 40: an answer is written to task.md under Owner decisions, once, with the blocker and the answer", async () => {
    patchReadFile();
    const folder = makeTask("exec-task-md", PLAN);
    nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nBuild it.\n", "utf8");
    const arg = {
      taskFolderPath: folder,
      stage: "impl-high-review" as const,
      blockerId: "step-6-admission",
      optionId: "approve",
      optionLabel: "Approve the simpler design",
      planAction: { kind: "note" as const },
      blockerText: "Step 6:  token hand-off\nversus the simpler design",
    };
    await executeOwnerPlanDecisionLockedV1(arg);
    await executeOwnerPlanDecisionLockedV1(arg);

    const task = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
    assert.strictEqual(task.match(/## Owner decisions/g)?.length, 1);
    assert.strictEqual(task.match(/### \d{4}-\d{2}-\d{2} — step-6-admission/g)?.length, 1, "the same answer is not written twice");
    assert.ok(task.includes("> Step 6: token hand-off versus the simpler design"));
    assert.ok(task.includes("Owner's answer: Approve the simpler design"));
    assert.ok(task.startsWith("# Task\n\n## Task Description"), "the owner's own text is untouched");
  });

  void it("review2 Step 34: a rule typed for 'Settle it with a rule' is written to task.md under Owner decisions with the blocker id, once", async () => {
    patchReadFile();
    const folder = makeTask("exec-task-md-rule", PLAN);
    nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nBuild it.\n", "utf8");
    const arg = {
      taskFolderPath: folder,
      stage: "impl-low-review" as const,
      blockerId: "b3-evidence-keyed-by-text",
      optionId: "settleWithRule",
      optionLabel: "an ambiguous reviewer entry verifies nothing",
      ownWords: true as const,
      rejects: true,
      thenApplyReview: true as const,
      blockerText: "A plan item's evidence settles a same-worded item at another level.",
    };
    await executeOwnerPlanDecisionLockedV1(arg);
    await executeOwnerPlanDecisionLockedV1(arg);

    const task = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
    assert.strictEqual(task.match(/### \d{4}-\d{2}-\d{2} — b3-evidence-keyed-by-text/g)?.length, 1, "written once");
    assert.ok(task.includes("Owner's answer: an ambiguous reviewer entry verifies nothing"));
    assert.ok(task.includes("> A plan item's evidence settles a same-worded item at another level."));
  });

  void it("review1 Step 40: at a plan stage the answer also becomes an Accepted Non-Goals entry in plan.md that cites task.md", async () => {
    patchReadFile();
    const folder = nodePath.join(ROOT, ".ensemble", "exec-plan-stage");
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan.md"), "# Plan\n\n## Goal\n\nShip it.\n", "utf8");
    nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nBuild it.\n", "utf8");
    nodeFs.writeFileSync(
      nodePath.join(folder, "task-progress.json"),
      JSON.stringify({
        taskFolder: "exec-plan-stage", currentStage: "plan-low-review", status: "active",
        createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
      }),
      "utf8"
    );
    const arg = {
      taskFolderPath: folder,
      stage: "plan-low-review" as const,
      blockerId: "popups-owner-rule",
      optionId: "accept",
      optionLabel: "Keep the six pop-up categories as pop-ups",
      planAction: { kind: "note" as const },
      blockerText: "The no-pop-ups owner rule is only partially delivered",
    };
    await executeOwnerPlanDecisionLockedV1(arg);
    await executeOwnerPlanDecisionLockedV1(arg);

    const plan = nodeFs.readFileSync(nodePath.join(folder, "plan.md"), "utf8");
    assert.strictEqual(plan.match(/## Accepted Non-Goals/g)?.length, 1);
    assert.ok(plan.includes("The no-pop-ups owner rule is only partially delivered"));
    assert.ok(plan.includes("(task.md → Owner decisions, popups-owner-rule)"));
    assert.strictEqual(plan.match(/task\.md → Owner decisions, popups-owner-rule/g)?.length, 1, "written once");
    const task = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
    assert.ok(task.includes("Owner's answer: Keep the six pop-up categories as pop-ups"));

    // review1 Step 46 (item 5 replay): the review prompt treats exactly this pair as settled. Every review prompt
    // that scores a stage (plan and code) carries the shared rubric, and the rubric names the citation the answer
    // just wrote, so the next review does not call the plan's non-goal a fabricated owner decision.
    const promptsDir = nodePath.resolve(__dirname, "..", "..", "resources", "prompts");
    const rubric = nodeFs.readFileSync(nodePath.join(promptsDir, "review-scoring-rubric.md"), "utf8");
    assert.match(rubric, /an `## Accepted Non-Goals` entry that cites `task\.md → Owner decisions, <id>` is settled by it/);
    assert.match(rubric, /A plan line that says "owner decision" with no such task\.md entry proves nothing/);
    for (const prompt of ["review-plan-high.md", "review-plan-low.md", "review-impl-high.md", "review-impl-low.md"]) {
      assert.match(nodeFs.readFileSync(nodePath.join(promptsDir, prompt), "utf8"), /\{\{reviewScoringRubric\}\}/, prompt);
    }
  });

  void it("review1 Step 40: at a code stage the answer also becomes an Accepted Non-Goals entry in plan-final.md, once, without touching the checklist", async () => {
    patchReadFile();
    const folder = makeTask("exec-code-stage-nongoal", PLAN);
    nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nBuild it.\n", "utf8");
    const before = readPlan(folder);
    const checklistLines = (text: string): string[] => text.split("\n").filter((line) => /^\s*- \[[ xX]\]/.test(line));
    const arg = {
      taskFolderPath: folder,
      stage: "impl-high-review" as const,
      blockerId: "step-6-admission",
      optionId: "approve",
      optionLabel: "Approve the simpler design",
      planAction: { kind: "note" as const },
      blockerText: "Step 6: token hand-off versus the simpler design",
    };
    await executeOwnerPlanDecisionLockedV1(arg);
    await executeOwnerPlanDecisionLockedV1(arg);

    const plan = readPlan(folder);
    assert.strictEqual(plan.match(/## Accepted Non-Goals/g)?.length, 1);
    assert.ok(plan.includes("Step 6: token hand-off versus the simpler design"));
    assert.strictEqual(plan.match(/task\.md → Owner decisions, step-6-admission/g)?.length, 1, "written once");
    assert.deepStrictEqual(checklistLines(plan), checklistLines(before), "no checklist line changed");
    assert.notStrictEqual(plan, before, "the file did change");
  });

  void it("review1 Step 40: a plan-deviation approval and a rejecting option add no Accepted Non-Goals entry at a code stage", async () => {
    patchReadFile();
    const folder = makeTask("exec-code-stage-no-nongoal", PLAN);
    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: "plan-deviation-ab12cd34",
      optionId: "approve-deviation",
      optionLabel: "Approve plan deviation",
      planAction: { kind: "approveDeviation" },
    });
    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: "step-7-keep",
      optionId: "reject",
      optionLabel: "Keep the plan",
      planAction: { kind: "note" },
      rejects: true,
    });
    assert.doesNotMatch(readPlan(folder), /## Accepted Non-Goals/);
  });

  void it("a rejecting option notes the decision but neither excludes items nor sets the blocker aside", async () => {
    patchReadFile();
    const folder = makeTask("exec-reject", PLAN);

    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: "step-6-admission",
      optionId: "buildToken",
      optionLabel: "Require token hand-off",
      planAction: undefined,
      rejects: true,
    });

    const plan = readPlan(folder);
    assert.ok(!plan.includes("ensemble:excluded"));
    assert.ok(plan.includes("plan kept as written"));
    assert.strictEqual(readProgress(folder).blockerSupersessions, undefined);
  });
});

void describe("bugs5 Step 22: only blockers the owner must settle stop Fast Forward", () => {
  void it("a task-fixable blocker is never owner-only, whatever words it contains", () => {
    assert.strictEqual(
      isOwnerDecisionBlockerV1({ description: "Step 6 hand-off is unbuilt", resolver: "task-fixable" }),
      false
    );
    assert.strictEqual(
      isOwnerDecisionBlockerV1({ description: "Step 6 hand-off needs a human gate", resolver: "environmental" }),
      true
    );
    assert.strictEqual(isOwnerDecisionBlockerV1("Owner evidence needed: the laptop's .gitignore"), true);
    assert.strictEqual(isOwnerDecisionBlockerV1("Agent can gather (cost: $0.10): stream sample"), false);
  });

  void it("a blocker named by an owner-decision block is owner-only", () => {
    const blocks = parseOwnerDecisionsNeededV1(STEP_6_REVIEW);
    assert.strictEqual(
      isOwnerDecisionBlockerV1({ description: "Unapproved deviation (step-6-admission): no owner approval", resolver: "environmental" }, blocks),
      true
    );
  });
});

void describe("bugs5 Step 22: routing and card dedupe", () => {
  afterEach(() => {
    __extensionContextV1TestOnly.reset();
  });

  void it("decideReviewRoute escalates, running no Apply Review, when every blocker holding the score needs the owner", () => {
    const blockers = [
      { category: "completion", resolver: "environmental", description: "Owner evidence needed: the laptop's .gitignore" },
    ] as const;
    const decision = decideReviewRoute({
      score: 6,
      threshold: 9,
      blockers: [...blockers],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
      allBlockersNeedOwnerDecision: true,
    });
    assert.equal(decision.route, "escalate");
    const mixed = decideReviewRoute({
      score: 6,
      threshold: 9,
      blockers: [
        ...blockers,
        { category: "completion", resolver: "task-fixable", description: "Step 27 is not built" },
      ],
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
      allBlockersNeedOwnerDecision: false,
    });
    assert.notEqual(mixed.route, "escalate", "a task-fixable blocker among them keeps the loop going");
  });

  void it("posting the same owner-decision block twice leaves one card; changed content is a new card", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join(ROOT, ".ensemble", "dedupe-task");
    const block = parseOwnerDecisionsNeededV1(STEP_6_REVIEW)[0]!;

    await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: "impl-high-review", block });
    await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: "impl-high-review", block });
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const pending = store.listPending(normalizePath(folder)).filter((d) => d.decisionKey === "ownerPlanDecision:step-6-admission");
    assert.equal(pending.length, 1);

    const changed = parseOwnerDecisionsNeededV1(STEP_6_REVIEW.replace("Simpler design built", "A different design built"))[0]!;
    assert.notEqual(changed.rawContentHash, block.rawContentHash);
  });
});

void describe("bugs5 Step 22: owner-only blockers with no decision block", () => {
  void it("raises one card naming the blockers, with a settle option and Not now, once per set of blockers", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join(ROOT, ".ensemble", "owner-only-task");
    const blockerDescriptions = ["Step 6 owner decision: token hand-off versus the simpler design"];

    const first = await postOwnerOnlyBlockersCardV1({ taskFolderPath: folder, stage: "impl-high-review", blockerDescriptions });
    await postOwnerOnlyBlockersCardV1({ taskFolderPath: folder, stage: "impl-high-review", blockerDescriptions });
    assert.ok(first);
    assert.deepEqual(first.options.map((o) => o.optionId), ["settleItem", "notNow"]);
    assert.match(first.whyUserNeeded ?? "", /Step 6 owner decision/);
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const pending = store.listPending(normalizePath(folder)).filter((d) => d.decisionKey.startsWith("ownerOnlyBlockers:"));
    assert.equal(pending.length, 1);

    assert.equal(
      await postOwnerOnlyBlockersCardV1({ taskFolderPath: folder, stage: "impl-high-review", blockerDescriptions: [] }),
      undefined
    );
  });
});

void describe("bugs5 Step 24: Agent-gatherable evidence routing", () => {
  void it("the escalation card offers 'Let the AI gather it (about <cost>)' for an agent-gatherable blocker, and only then", () => {
    const description = "Agent can gather (cost: $0.10): Claude Code CLI edit-mode stream sample";
    const input = {
      blockersCount: 1,
      primaryBlockerDescription: description,
      allBlockerDescriptions: [description],
      narrowedNote: "",
      progressNote: "",
      taskFixableCount: 1,
      hasSpecDefect: false,
      hasDeclinedBlocker: false,
      hasNonFixableBlocker: false,
      nextStageHasRun: false,
      clearingNote: "",
      dispatchModeEvidence: [],
      planItemsOpen: 3,
    };
    const target = { canonicalId: "c", taskFolderPath: "/t" };
    const gather = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, input).options.find(
      (o) => o.optionId === "aiGatherEvidence"
    );
    assert.equal(gather?.label, "Let the AI gather it (about $0.10)");
    assert.equal(gather?.effect.kind, "command");

    const owner = "Owner evidence needed: the owner's laptop file";
    const none = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, {
      ...input,
      primaryBlockerDescription: owner,
      allBlockerDescriptions: [owner],
    }).options.find((o) => o.optionId === "aiGatherEvidence");
    assert.equal(none, undefined);
  });

  void it("two agent-gatherable blockers give two options with distinct ids", () => {
    const a = "Agent can gather (cost: $0.10): stream sample";
    const b = "Agent can gather (cost: $0.20): second sample";
    const decision = buildEscalationDecisionV1(
      "plateau",
      "impl-high-review",
      "plateau",
      { canonicalId: "c", taskFolderPath: "/t" },
      {
        blockersCount: 2,
        primaryBlockerDescription: a,
        allBlockerDescriptions: [a, b],
        narrowedNote: "",
        progressNote: "",
        taskFixableCount: 2,
        hasSpecDefect: false,
        hasDeclinedBlocker: false,
        hasNonFixableBlocker: false,
        nextStageHasRun: false,
        clearingNote: "",
        dispatchModeEvidence: [],
        planItemsOpen: 3,
      }
    );
    const ids = decision.options.map((o) => o.optionId);
    assert.equal(new Set(ids).size, ids.length);
    const gathers = decision.options.filter((o) => o.label.startsWith("Let the AI gather it"));
    assert.equal(gathers.length, 2);
    // bugs5 Step 24: each button works on its own blocker, and the labels tell them apart.
    assert.notEqual(gathers[0]?.label, gathers[1]?.label);
    const focusOf = (o: (typeof gathers)[number] | undefined): unknown =>
      o?.effect.kind === "command" ? (o.effect.args?.[0] as { focusBlocker?: string }).focusBlocker : undefined;
    assert.equal(focusOf(gathers[0]), a);
    assert.equal(focusOf(gathers[1]), b);
  });

  void it("a focused Apply Review carries only its blocker, and an unfocused one is unchanged", () => {
    const task = "/tmp/task-x";
    assert.equal(formatApplyReviewFocusBlockV1(peekApplyReviewFocusV1(task)), "");
    setApplyReviewFocusV1(task, "  Agent can gather (cost: $0.10): stream sample ");
    const block = formatApplyReviewFocusBlockV1(peekApplyReviewFocusV1(task));
    assert.match(block, /Blocker: Agent can gather \(cost: \$0\.10\): stream sample/);
    assert.match(block, /ONLY that blocker/);
    clearApplyReviewFocusV1(task);
    assert.equal(peekApplyReviewFocusV1(task), undefined);
  });

  void it("classifyEnvironmentalBlockerV1 identifies agent-gatherable blocker", () => {
    const desc = "Agent can gather (cost: $0.10): Claude Code CLI edit-mode stream test";
    assert.strictEqual(classifyEnvironmentalBlockerV1(desc), "agent-gatherable");
    assert.strictEqual(classifyEnvironmentalBlockerV1("Owner evidence needed: manual check on laptop"), "owner-evidence");
  });

  void it("parseReviewBlockersDetailed routes agent-gatherable blocker as task-fixable", () => {
    const content = [
      "Readiness: 6/10",
      "<!-- blockers:start -->",
      "- [environmental] Agent can gather (cost: $0.10): Claude Code CLI edit-mode stream test",
      "- [environmental] Owner evidence needed: manual test on laptop",
      "<!-- blockers:end -->",
    ].join("\n");

    const parsed = parseReviewBlockersDetailed(content);
    assert.strictEqual(parsed.blockers.length, 2);
    assert.strictEqual(parsed.blockers[0]?.resolver, "task-fixable", "routed as task-fixable");
    assert.strictEqual(parsed.blockers[1]?.resolver, "environmental", "owner evidence stays environmental");
  });

  void it("isOwnerEvidenceBlockerV1 returns false for agent-gatherable blocker", () => {
    assert.strictEqual(isOwnerEvidenceBlockerV1({ description: "Agent can gather (cost: $0.10): stream test" }), false);
    assert.strictEqual(isOwnerEvidenceBlockerV1({ description: "Owner evidence needed: laptop file" }), true);
  });
});

void describe("review1 Step 40: an owner-decision answer re-runs the review, and the card takes free text", () => {
  afterEach(() => {
    __extensionContextV1TestOnly.reset();
  });

  const baseArg = {
    taskFolderPath: nodePath.join(ROOT, ".ensemble", "rerun-task"),
    stage: "impl-high-review" as const,
    blockerId: "step-6-admission",
    optionId: "buildToken",
    optionLabel: "Require token hand-off",
  };

  void it("an answer that settles the blocker starts the stage review through the single resume-and-review command", async () => {
    const calls: { id: string; args: unknown[] }[] = [];
    const started = await startReReviewAfterOwnerDecisionV1(baseArg, (id, ...args) => {
      calls.push({ id, args });
      return Promise.resolve(true);
    });
    assert.equal(started.kind, "started");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "vs-code-ai-helper.resumeAndRerunReview");
    assert.deepEqual(calls[0]!.args[0], { taskFolderPath: baseArg.taskFolderPath });
    // Only task.md and the plan changed, so the unchanged-tree guard must not refuse the review.
    assert.equal((calls[0]!.args[1] as { skipUnchangedTreeGuardV1?: boolean }).skipUnchangedTreeGuardV1, true);
    assert.equal(typeof (calls[0]!.args[1] as { onStartedV1?: unknown }).onStartedV1, "function");
  });

  void it("bugs8 Step 4: resumeAndRerunReviewV1 keeps an operation-confirmed start in its returned result", () => {
    const source = nodeFs.readFileSync(nodePath.join(process.cwd(), "src", "commands", "resumeTask.ts"), "utf8");
    const start = source.indexOf("export async function resumeAndRerunReviewV1(");
    const end = source.indexOf("export async function resumeAndDispatchImplementationV1(");
    assert.ok(start >= 0 && end > start, "resumeAndRerunReviewV1 not found");
    assert.match(source.slice(start, end), /started = started \|\| startWatch\.confirmed\(\)/);
  });

  void it("keeping the plan as written, or approving a deviation, starts no review", async () => {
    let calls = 0;
    const run = (): Promise<boolean> => {
      calls++;
      return Promise.resolve(true);
    };
    assert.equal((await startReReviewAfterOwnerDecisionV1({ ...baseArg, rejects: true }, run)).kind, "recordedOnly");
    assert.equal(
      (await startReReviewAfterOwnerDecisionV1({ ...baseArg, planAction: { kind: "approveDeviation" } }, run)).kind,
      "recordedOnly"
    );
    assert.equal(calls, 0);
  });

  void it("an own-words answer, which keeps the plan untouched, does start the review", async () => {
    let calls = 0;
    const started = await startReReviewAfterOwnerDecisionV1({ ...baseArg, rejects: true, ownWords: true }, () => {
      calls++;
      return Promise.resolve(true);
    });
    assert.equal(started.kind, "started");
    assert.equal(calls, 1);
  });

  void it("bugs7 item 3: an option that needs a code change starts Apply Review first, not the review alone", async () => {
    const calls: { id: string; args: unknown[] }[] = [];
    const started = await startReReviewAfterOwnerDecisionV1({ ...baseArg, thenApplyReview: true }, (id, ...args) => {
      calls.push({ id, args });
      return Promise.resolve(true);
    });
    assert.equal(started.kind, "started");
    assert.deepEqual(calls.map((c) => c.id), ["vs-code-ai-helper.resumeAndApplyCurrentStageAction"]);
  });

  void it("bugs7 item 3: the review's `Needs a code change` line, or its 'one round rewords' wording, routes to Apply Review; 'applying now' is said only then", () => {
    const [block] = parseOwnerDecisionsNeededV1(
      [
        "## Owner decisions needed",
        "### step-12-hard-stop",
        "Id: step-12-hard-stop",
        "Plan purpose: the round clock",
        "Problem: the prompt says the 60 minutes is the hard stop",
        "Options:",
        "- Keep the round's 60 minutes, reworded — one round rewords two sentences. Needs a code change: yes",
        "- Drop the clock — the plan is edited. Needs a code change: no",
        "- Leave the wording — nothing builds it",
        "Recommendation: Keep the round's 60 minutes, reworded, because it is cheap.",
        "Technical details: roundClockV1.ts",
      ].join("\n")
    );
    assert.ok(block);
    const [reword, drop, leave] = block.options;
    assert.equal(reword!.needsCodeChange, true);
    assert.equal(drop!.needsCodeChange, false);
    assert.equal(leave!.needsCodeChange, undefined);
    assert.doesNotMatch(reword!.consequence, /Needs a code change/i);
    assert.equal(ownerOptionNeedsCodeChangeV1(reword!, block), true);
    assert.equal(ownerOptionNeedsCodeChangeV1(drop!, block), false);
    assert.equal(ownerOptionNeedsCodeChangeV1(leave!, block), false);
    // Without the line, the review's own words about a round decide.
    const worded = { ...reword!, needsCodeChange: undefined };
    assert.equal(ownerOptionNeedsCodeChangeV1(worded, block), true, "one round rewords two sentences");
    assert.match(describeOwnerAnswerNextV1(reword!, block, "High-Level Code Review"), /^Apply Review builds it, then/);
    assert.equal(describeOwnerAnswerNextV1(drop!, block, "High-Level Code Review"), "High-Level Code Review checks it next");
    assert.doesNotMatch(describeOwnerAnswerNextV1(drop!, block, "High-Level Code Review"), /applying now/);
  });

  void it("a failing start is reported as not started, never thrown into the answer", async () => {
    const started = await startReReviewAfterOwnerDecisionV1(baseArg, () => Promise.reject(new Error("boom")));
    assert.equal(started.kind, "refused");
  });

  void it("the card offers 'Answer in my own words…', and only the options that settle the blocker are 'continue'", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join(ROOT, ".ensemble", "own-words-task");
    const block = parseOwnerDecisionsNeededV1(STEP_6_REVIEW)[0]!;
    const card = await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: "impl-high-review", block });
    assert.ok(card);
    const ownWords = card.options.find((o) => o.optionId === "ownWords");
    assert.ok(ownWords, "the free-text option is on the card");
    assert.equal(ownWords.resumeKind, "continue");
    assert.equal(ownWords.effect.kind, "command");
    const ownWordsArgs = (ownWords.effect as { args?: readonly { ownWords?: boolean }[] }).args;
    assert.equal(ownWordsArgs?.[0]?.ownWords, true);
    for (const option of card.options) {
      if (option.optionId === "ownWords") continue;
      const rejects = (option.effect as { args?: readonly { rejects?: boolean }[] }).args?.[0]?.rejects === true;
      assert.equal(option.resumeKind, rejects ? "unpause" : "continue", `${option.optionId} resume kind`);
    }
  });

  void it("own words are recorded in task.md and leave the plan's checklist alone", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "own-words-record");
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nX\n");
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), "# Plan\n\n- [ ] Step 6: Build it\n");
    await executeOwnerPlanDecisionLockedV1({
      ...baseArg,
      taskFolderPath: folder,
      optionId: "ownWords",
      optionLabel: "Keep the pop-ups for these six",
      rejects: true,
      ownWords: true,
      blockerText: "Pop-up categories",
    });
    const taskMd = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
    assert.match(taskMd, /Owner's answer: Keep the pop-ups for these six\n/);
    assert.ok(!taskMd.includes("plan kept as written"), "an own-words answer is not described as keeping the plan");
    const plan = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    assert.ok(plan.includes("- [ ] Step 6: Build it"), "no checklist line changed");
    assert.ok(!plan.includes("ensemble:excluded"));
    assert.ok(!plan.includes("plan kept as written"));
  });
});

// ---------------------------------------------------------------------------
// bugs8 item 1 (Part A1, regression tests only): an owner answer on a plateau-paused task starts what it promises.
//
// The replay of bugs7 (2026-11-11, 18:04 Israel time): the task was paused by a plateau with one owner-decision
// blocker; the owner chose "Keep the plan" (`Needs a code change: yes`); the chat said "applying now" and nothing
// ran. These tests run the real chain: the card's own option args -> `recordOwnerPlanDecisionV1` ->
// `followUpAfterOwnerAnswerV1` -> `startReReviewAfterOwnerDecisionV1` -> the real
// `resumeAndApplyCurrentStageActionV1` -> the real `applyCurrentStageAction` router. Only the downstream
// Apply Review stage command is a stub, and a stub that claims a start registers a real operation first.
// Each assertion names its requirement (`item1a:`, `item1b:`, `item1c:`) so a failing run says which one broke.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-var-requires */
const itemOneModelSelectionModuleV1 = require("../utils/modelSelection") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const ITEM_ONE_BLOCKER_ID_V1 = "step-19-chain-boundary";
const ITEM_ONE_STAGE_V1 = "impl-high-review" as const;

/** The bugs7 review: one owner-decision blocker, with "Keep the plan" saying whether a code change is needed. */
function itemOneReviewTextV1(keepNeedsCodeChange: boolean): string {
  return [
    "Readiness: 7/10",
    "",
    "<!-- blockers:start -->",
    "- Step 19 chain boundary needs an owner decision: where Fast Forward stops before Publish.",
    "<!-- blockers:end -->",
    "",
    "## Owner decisions needed",
    "",
    "### Step 19 chain boundary",
    `- id: ${ITEM_ONE_BLOCKER_ID_V1}`,
    "- what this part of the plan is for: Fast Forward's boundary before Publish.",
    "- what is undecided or went wrong: The plan and the build disagree on whether Fast Forward may move into Publish.",
    "- options:",
    `  - keep-the-plan: Keep the plan — adopt the whole-invocation rule and fix successor-review coordination. Needs a code change: ${keepNeedsCodeChange ? "yes" : "no"}`,
    "  - settle-with-rule: Settle it with a rule — record the rule and one round applies it. Needs a code change: yes",
    "  - stop-at-publish: Stop before Publish — the plan is edited. Needs a code change: no",
    "- recommendation: keep-the-plan — it is the owner's original rule.",
    "- technical details: Step 19.",
    "",
    "<!-- review-pass: 1 -->",
    "",
  ].join("\n");
}

interface ItemOneEnvironmentV1 {
  readonly folder: string;
  readonly executed: { readonly command: string; readonly args: readonly unknown[] }[];
  readonly downstream: {
    calls: number;
    /** The transcript (cards left out) as it stood when the stub was called, before it registered anything. */
    transcriptAtCall: string[] | undefined;
    readonly handles: ReturnType<typeof taskOperations.begin>[];
  };
  readonly warnings: string[];
  /** The answer args of the card option with this label, taken from the real card builder. */
  answerArgFor(label: string): RecordOwnerPlanDecisionArgV1;
  readProgress(): TaskProgress;
  restore(): void;
}

/** The task's chat transcript as the owner reads it: every line except the cards themselves. */
async function itemOneTranscriptV1(folder: string): Promise<string[]> {
  const messages = await readChatHistory(folder, folder);
  return messages.filter((message) => message.kind !== "decision").map((message) => message.text);
}

/**
 * The lines the chat actually RENDERS as conversation (the same filter `chatView.ts` applies): `outcome` and `activity`
 * status lines, which only the Notifications log shows, are not in it. A reason-and-click line the owner has to read
 * must be here, not only in the stored transcript.
 */
async function itemOneConversationV1(folder: string): Promise<string[]> {
  const messages = await readChatHistory(folder, folder);
  return messages.filter((message) => isConversationEntryV1(message)).map((message) => message.text);
}

async function installItemOneEnvironmentV1(
  name: string,
  options: {
    readonly keepNeedsCodeChange: boolean;
    readonly downstream: "starts" | "refuses";
    /** bugs7's shape: two items ticked by a round and not yet checked by a review (built, not settled). */
    readonly builtButUnchecked?: boolean;
  }
): Promise<ItemOneEnvironmentV1> {
  // Every fixture gets its own container: the task lock derives its lease paths from the folder's ancestors.
  const container = nodeFs.mkdtempSync(nodePath.join(ROOT, `${name}-`));
  const folder = nodePath.join(container, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  const reviewText = itemOneReviewTextV1(options.keepNeedsCodeChange);
  nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nX\n", "utf8");
  nodeFs.writeFileSync(nodePath.join(folder, "plan.md"), "# Plan\n", "utf8");
  // No checklist on purpose: with one, `refreshPlanItemSettlementSnapshotV1` (called inside `executeOwnerPlanDecisionLockedV1`'s
  // task lock) patches task-progress.json through the same lock and never returns, which would hang this file before it
  // could report anything. That is a separate finding (filed for bugs9), not what these tests are about.
  const planFinalText = options.builtButUnchecked
    ? [
        "# Plan",
        "",
        "Step 19: Fast Forward boundary.",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Step 14: first built item",
        "- [x] Step 15: second built item",
        "",
      ].join("\n")
    : "# Plan\n\nStep 19: Fast Forward boundary.\n";
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), planFinalText, "utf8");
  nodeFs.writeFileSync(nodePath.join(folder, "impl-summary.md"), "# Summary\n", "utf8");
  nodeFs.writeFileSync(nodePath.join(folder, "impl-high-review.md"), reviewText, "utf8");

  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
    keys: (): string[] => [...values.keys()],
  } as unknown as vscode.Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento, globalState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext);

  const warnings: string[] = [];
  initNotificationRouter({
    addEntry(message: string, level: "info" | "warning" | "error"): void {
      if (level === "warning") warnings.push(message);
    },
  });

  const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalReadFile = fsTarget["readFile"];
  fsTarget["readFile"] = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  const workspaceTarget = vscode.workspace as unknown as Record<string, unknown>;
  const originalWorkspaceFolders = workspaceTarget["workspaceFolders"];
  workspaceTarget["workspaceFolders"] = [{ uri: vscode.Uri.file(container), name: "item1", index: 0 }];

  const originalResolveModel = itemOneModelSelectionModuleV1["resolveModelForStage"];
  const originalEnsureModel = itemOneModelSelectionModuleV1["ensureStageModelConfigured"];
  itemOneModelSelectionModuleV1["resolveModelForStage"] = (): Promise<{ source: string; modelId: string }> =>
    Promise.resolve({ source: "workspace", modelId: "stub:model" });
  // The model guard is not what these tests are about; the downstream stub raises its own refusal when asked to.
  itemOneModelSelectionModuleV1["ensureStageModelConfigured"] = (): Promise<boolean> => Promise.resolve(true);

  const progressPath = nodePath.join(folder, "task-progress.json");
  const readProgress = (): TaskProgress => JSON.parse(nodeFs.readFileSync(progressPath, "utf8")) as TaskProgress;
  const item = {
    canonicalId: folder,
    taskFolderPath: folder,
    folderName: nodePath.basename(folder),
    sourceScopeKey: folder,
    get progress(): TaskProgress {
      return readProgress();
    },
  };
  const inventory = Object.create(TaskInventory.prototype) as TaskInventory;
  const looseInventory = inventory as unknown as Record<string, unknown>;
  looseInventory["visibleTasks"] = [item];
  looseInventory["taskByCanonicalId"] = new Map([[folder, item]]);
  looseInventory["suppressionAliasMap"] = new Map();
  looseInventory["refresh"] = (): Promise<void> => Promise.resolve();
  looseInventory["getTasks"] = (): unknown[] => [item];
  looseInventory["getTaskById"] = (id: string): unknown => (id === folder ? item : undefined);
  looseInventory["getTaskByPath"] = (path: string): unknown => (path === folder ? item : undefined);
  looseInventory["getVisibleTaskForSuppressedId"] = (): undefined => undefined;
  looseInventory["getVisibleTaskForSuppressedPath"] = (): undefined => undefined;
  const currentStore = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  const looseStore = currentStore as unknown as Record<string, unknown>;
  looseStore["get"] = (): string | undefined => undefined;
  looseStore["set"] = (): Promise<void> => Promise.resolve();
  looseStore["clear"] = (): Promise<void> => Promise.resolve();

  const executed: { command: string; args: unknown[] }[] = [];
  const downstream: ItemOneEnvironmentV1["downstream"] = { calls: 0, transcriptAtCall: undefined, handles: [] };
  /** The one stub: the Apply Review stage command. A start registers a real operation; a refusal raises its warning. */
  const runDownstream = async (): Promise<boolean> => {
    downstream.calls += 1;
    downstream.transcriptAtCall = await itemOneTranscriptV1(folder);
    if (options.downstream === "refuses") {
      NotificationRouter.showWarning(
        "bugs7: no AI model is configured for the High-Level Code Review stage. Configure one in AI Models."
      );
      return false;
    }
    const handle = taskOperations.begin(folder, {
      label: "Apply Review",
      stage: ITEM_ONE_STAGE_V1,
      taskName: "bugs8 fixture",
      exclusive: false,
    });
    downstream.handles.push(handle);
    return handle !== null;
  };
  const commandsTarget = vscode.commands as unknown as {
    executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown>;
  };
  const originalExecute = commandsTarget.executeCommand;
  commandsTarget.executeCommand = (command: string, ...args: unknown[]): PromiseLike<unknown> => {
    executed.push({ command, args });
    switch (command) {
      case "vs-code-ai-helper.resumeAndApplyCurrentStageAction":
        return resumeAndApplyCurrentStageActionV1(inventory, currentStore, args[0] as Parameters<typeof resumeAndApplyCurrentStageActionV1>[2]);
      case "vs-code-ai-helper.applyCurrentStageAction":
        return applyCurrentStageAction(inventory, currentStore, args[0] as Parameters<typeof applyCurrentStageAction>[2]);
      case "vs-code-ai-helper.applyHighLevelReviewChanges":
        return runDownstream();
      default:
        return Promise.resolve(undefined);
    }
  };

  // The card the owner answered, built by the real card builder (its option args are what the click sends).
  const block = parseOwnerDecisionsNeededV1(reviewText).find((candidate) => candidate.id === ITEM_ONE_BLOCKER_ID_V1);
  assert.ok(block, "item1 fixture: the review's owner-decision block parses");
  const card = await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: ITEM_ONE_STAGE_V1, block, reviewText });
  assert.ok(card, "item1 fixture: the owner-decision card was posted");

  // The state the bugs7 task was in: paused by a plateau, waiting on the owner, automation due next.
  nodeFs.writeFileSync(
    progressPath,
    JSON.stringify(
      {
        taskFolder: name,
        displayName: "bugs7",
        currentStage: ITEM_ONE_STAGE_V1,
        status: "paused",
        nextActor: "automation",
        stageReviewPasses: { [ITEM_ONE_STAGE_V1]: 1 },
        // The settlement snapshot as the gate last stored it, so the refresh inside the answer's task lock finds
        // nothing new and writes nothing (it patches task-progress.json through the same lock; a bugs9 finding).
        ...(options.builtButUnchecked
          ? {
              lastPlanItemSettlement: {
                at: "2026-11-11T14:20:00.000Z",
                items: listPlanItemSettlementV1(planFinalText, [], []).map((entry) => ({
                  hash: entry.hash,
                  settled: entry.settled,
                  label: entry.label,
                })),
              },
            }
          : {}),
        ownership: fixtureOwnershipFor(folder),
        pausedReason: "Every blocker holding the score requires an owner decision; automated iteration cannot resolve it.",
        escalation: {
          stage: ITEM_ONE_STAGE_V1,
          kind: "plateau",
          reason: "Every blocker holding the score requires an owner decision; automated iteration cannot resolve it.",
          at: "2026-11-11T14:25:00.000Z",
        },
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-11T14:25:00.000Z",
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    folder,
    executed,
    downstream,
    warnings,
    answerArgFor(label: string): RecordOwnerPlanDecisionArgV1 {
      const option = card.options.find((candidate) => candidate.label === label);
      assert.ok(option, `item1 fixture: the card has an option labelled "${label}"`);
      assert.equal(option.effect.kind, "command", "item1 fixture: the option runs the record command");
      const args = (option.effect as unknown as { args?: readonly RecordOwnerPlanDecisionArgV1[] }).args;
      const first = args?.[0];
      assert.ok(first, "item1 fixture: the option carries its answer args");
      return first;
    },
    readProgress,
    restore(): void {
      for (const handle of downstream.handles) taskOperations.end(handle);
      commandsTarget.executeCommand = originalExecute;
      itemOneModelSelectionModuleV1["resolveModelForStage"] = originalResolveModel;
      itemOneModelSelectionModuleV1["ensureStageModelConfigured"] = originalEnsureModel;
      workspaceTarget["workspaceFolders"] = originalWorkspaceFolders;
      fsTarget["readFile"] = originalReadFile;
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    },
  };
}

/** Let detached follow-ups (a deferred write, a chat line posted without being awaited) land before the test counts. */
function itemOneSettleV1(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

const APPLYING_NOW_RE_V1 = /applying now/i;

void describe("bugs8 item 1: an owner answer on a plateau-paused task starts what it promises", () => {
  void it("item1a: answering 'Keep the plan' (Needs a code change: yes) starts Apply Review, and the task leaves the pause", async () => {
    const env = await installItemOneEnvironmentV1("item1a", { keepNeedsCodeChange: true, downstream: "starts" });
    try {
      const arg = env.answerArgFor("Keep the plan");
      assert.equal(arg.rejects, true, "item1 fixture: 'Keep the plan' is a rejecting answer");
      assert.equal(arg.thenApplyReview, true, "item1 fixture: the card option carries 'Needs a code change: yes'");
      assert.equal(env.readProgress().escalation?.kind, "plateau", "item1 fixture: the task starts under the plateau escalation");

      await recordOwnerPlanDecisionV1(arg);
      await itemOneSettleV1();

      const sent = JSON.stringify(env.executed.map((entry) => entry.command));
      assert.equal(env.downstream.calls, 1, `item1a: Apply Review was not dispatched exactly once (${env.downstream.calls} calls; commands run: ${sent})`);
      assert.ok(taskOperations.hasRootOperationForTask(env.folder), "item1a: no operation was registered for the task");
      const progress = env.readProgress();
      assert.notEqual(progress.status, "paused", "item1a: the task is still paused after the answer");
      assert.equal(progress.escalation, undefined, "item1a: the plateau escalation is still set after the answer");
    } finally {
      env.restore();
    }
  });

  void it("item1b: 'applying now' is written only once something has started (happy run)", async () => {
    // "Settle it with a rule" needs a code change and does not keep the plan, so it starts Apply Review on this build too.
    const env = await installItemOneEnvironmentV1("item1b-happy", { keepNeedsCodeChange: true, downstream: "starts" });
    try {
      const result = await recordOwnerPlanDecisionV1(env.answerArgFor("Settle it with a rule"));
      await itemOneSettleV1();

      assert.equal(env.downstream.calls, 1, "setup: the rule-settling answer did not dispatch Apply Review");
      assert.equal(result.dispatch?.kind, "started", "bugs8 Step 4: a confirmed start is reported as started");
      // Once the start is confirmed, exactly one line says so (written from onStartedV1, never before).
      const after = await itemOneTranscriptV1(env.folder);
      assert.equal(
        after.filter((line) => /^Applying now: Apply Review builds it, then /.test(line)).length,
        1,
        `bugs8 Step 6: expected exactly one confirmed-start line: ${JSON.stringify(after)}`
      );
      const before = env.downstream.transcriptAtCall ?? [];
      assert.ok(
        !before.some((line) => APPLYING_NOW_RE_V1.test(line)),
        `item1b: a line said "applying now" before the operation was registered: ${JSON.stringify(before)}`
      );
      assert.ok(taskOperations.hasRootOperationForTask(env.folder), "setup: the downstream stub registered no operation");
    } finally {
      env.restore();
    }
  });

  void it("item1b: a refused start never says 'applying now', and one line gives the reason and the click that carries on", async () => {
    const env = await installItemOneEnvironmentV1("item1b-refused", { keepNeedsCodeChange: true, downstream: "refuses" });
    try {
      // "Settle it with a rule" reaches the downstream command on its own (it is not a rejecting answer), so the
      // refusal below happens after the command was called, as the model guard's does, whatever "Keep the plan" does.
      const result = await recordOwnerPlanDecisionV1(env.answerArgFor("Settle it with a rule"));
      await itemOneSettleV1();

      assert.equal(result.dispatch?.kind, "refused", "bugs8 Step 4: a refusal after the call is reported as refused, never started");
      assert.equal(env.downstream.calls, 1, `setup: the downstream command was called ${env.downstream.calls} times, not once`);
      assert.equal(
        env.warnings.filter((warning) => /no AI model is configured/i.test(warning)).length,
        1,
        `setup: the downstream refusal raised the wrong warnings: ${JSON.stringify(env.warnings)}`
      );
      assert.equal(taskOperations.hasRootOperationForTask(env.folder), false, "setup: a refused start registered an operation");

      const lines = await itemOneTranscriptV1(env.folder);
      assert.ok(
        !lines.some((line) => APPLYING_NOW_RE_V1.test(line)),
        `item1b: a line said "applying now" although nothing started: ${JSON.stringify(lines)}`
      );
      // The line must be one the chat renders (not an `outcome` status line the conversation filter hides).
      const shown = await itemOneConversationV1(env.folder);
      const reasonAndClick = shown.filter((line) => /no (?:AI )?model/i.test(line) && /\bclick\b/i.test(line));
      assert.equal(
        reasonAndClick.length,
        1,
        `item1b: expected exactly one VISIBLE line giving the reason and the click that carries on, found ${reasonAndClick.length}: ${JSON.stringify(shown)}`
      );
    } finally {
      env.restore();
    }
  });

  void it("bugs8 Step 4: the re-review branch forwards onStartedV1, and its 'checking it now' line comes only from it", async () => {
    const env = await installItemOneEnvironmentV1("rerun-started", { keepNeedsCodeChange: false, downstream: "starts" });
    try {
      const answer = { ...env.answerArgFor("Settle it with a rule"), thenApplyReview: undefined };
      let called = false;
      let linesAtCall: string[] = [];
      const outcome = await startReReviewAfterOwnerDecisionV1(answer, async (_id, ...args) => {
        called = true;
        linesAtCall = await itemOneTranscriptV1(env.folder);
        // The command confirms the start through the callback (an operation registered), then reports `false`.
        (args[1] as { onStartedV1?: () => void }).onStartedV1?.();
        return false;
      });
      await itemOneSettleV1();
      assert.equal(called, true, "setup: the re-review command was not called");
      assert.ok(!linesAtCall.some((line) => /checking it now/i.test(line)), "no 'checking it now' line before the start is confirmed");
      const lines = await itemOneTranscriptV1(env.folder);
      assert.equal(lines.filter((line) => /checking it now/i.test(line)).length, 1, `one 'checking it now' line, got ${JSON.stringify(lines)}`);
      assert.equal(outcome.kind, "started", "a start the command confirmed through onStartedV1 is not reported as refused");
    } finally {
      env.restore();
    }
  });

  void it("item1b: a start held by a live work admission never says 'applying now'", async () => {
    const env = await installItemOneEnvironmentV1("item1b-held", { keepNeedsCodeChange: true, downstream: "starts" });
    const holder = await acquireWorkAdmissionV1({ taskFolderPath: env.folder, purpose: "admission", commandId: "runReviewWithAI" });
    try {
      assert.equal(holder.outcome, "acquired", "setup: the work admission was not acquired");
      // A non-rejecting, code-change answer would start Apply Review if nothing held it.
      await recordOwnerPlanDecisionV1(env.answerArgFor("Settle it with a rule"));
      await itemOneSettleV1();

      assert.equal(env.downstream.calls, 0, "item1b: a held answer still dispatched Apply Review");
      const lines = await itemOneTranscriptV1(env.folder);
      assert.ok(
        !lines.some((line) => APPLYING_NOW_RE_V1.test(line)),
        `item1b: a line said "applying now" although the start is held: ${JSON.stringify(lines)}`
      );
      // nonstart-feedback-rule: the explanation is a line the owner can read (not a hidden status entry) and says what happens.
      const shown = (await itemOneConversationV1(env.folder)).filter(
        (line) => /is recorded/.test(line) && /running round ends/.test(line)
      );
      assert.equal(shown.length, 1, `nonstart-feedback: expected one visible held-answer line, found ${shown.length}: ${JSON.stringify(shown)}`);
    } finally {
      cancelDeferredOptionRunV1(`owner-plan-decision:${normalizePath(env.folder)}:${ITEM_ONE_BLOCKER_ID_V1}`);
      releaseHeldWriteV1(normalizePath(env.folder), ITEM_ONE_BLOCKER_ID_V1);
      if (holder.outcome === "acquired") {
        await holder.handle.release();
      }
      env.restore();
    }
  });

  void it("nonstart-feedback: a recorded-only answer on a task that is not paused still gets a visible line, without telling it to resume", async () => {
    const env = await installItemOneEnvironmentV1("nonstart-active", { keepNeedsCodeChange: false, downstream: "starts" });
    try {
      const arg = env.answerArgFor("Keep the plan");
      await withdrawWorkflowDecisionsByKeyV1(
        { taskFolderPath: env.folder, canonicalId: normalizePath(env.folder) },
        `ownerPlanDecision:${ITEM_ONE_BLOCKER_ID_V1}`,
        "answered"
      );
      const progressPath = nodePath.join(env.folder, "task-progress.json");
      const active = JSON.parse(nodeFs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
      delete active["escalation"];
      active["status"] = "active";
      nodeFs.writeFileSync(progressPath, JSON.stringify(active, null, 2), "utf8");

      await recordOwnerPlanDecisionV1(arg);
      await itemOneSettleV1();
      assert.equal(env.downstream.calls, 0, "setup: an answer that needs no code change dispatched a round");
      const lines = (await itemOneConversationV1(env.folder)).filter((line) => /^Nothing started:/.test(line));
      assert.equal(lines.length, 1, `nonstart-feedback: expected one visible 'Nothing started' line, found ${lines.length}`);
      assert.doesNotMatch(lines[0]!, /Resume Task/, "nonstart-feedback: an active task was told to click Resume Task");
      assert.match(lines[0]!, /Run Current Stage Action|already running|Answer the open/, "nonstart-feedback: the line names no truthful next action");
      assert.doesNotMatch(lines[0]!, /carries on by itself/, "nonstart-feedback: an idle task was promised automatic continuation");
    } finally {
      env.restore();
    }
  });

  void it("item1b: neither chat acknowledgement site writes 'applying now' before the command's confirmed start", () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "views", "chatView.ts"), "utf8");
    // Site 1: a local interaction's option effect, up to the command it runs.
    const localStart = source.indexOf("private async runLocalInteractionOptionEffectV1(");
    assert.ok(localStart >= 0, "item1b: runLocalInteractionOptionEffectV1 not found");
    const localEnd = source.indexOf("await vscode.commands.executeCommand(effect.command", localStart);
    assert.ok(localEnd > localStart, "item1b: the local option effect no longer runs its command where this check looks");
    const beforeLocalCommand = source.slice(localStart, localEnd);
    assert.doesNotMatch(
      beforeLocalCommand,
      APPLYING_NOW_RE_V1,
      'item1b: runLocalInteractionOptionEffectV1 writes "applying now" before its command has confirmed a start'
    );
    // Site 2: the decision-answer path, from its acknowledgement to the command it dispatches.
    const ackStart = source.indexOf("const ackText =");
    assert.ok(ackStart >= 0, "item1b: the decision-answer acknowledgement not found");
    const ackEnd = source.indexOf("option.effect.command,", ackStart);
    assert.ok(ackEnd > ackStart, "item1b: the decision-answer path no longer dispatches its command where this check looks");
    const beforeDecisionCommand = source.slice(ackStart, ackEnd);
    assert.doesNotMatch(
      beforeDecisionCommand,
      APPLYING_NOW_RE_V1,
      'item1b: the decision-answer path writes "applying now" before its command has confirmed a start'
    );
  });

  void it("item1c: a paused task with no card open and nothing running gets exactly one line with the pause reason and the click that resumes", async () => {
    // "Keep the plan" with no code change: nothing starts, the card is closed by the answer, and the task stays paused.
    const env = await installItemOneEnvironmentV1("item1c", { keepNeedsCodeChange: false, downstream: "starts" });
    try {
      const arg = env.answerArgFor("Keep the plan");
      assert.equal(arg.thenApplyReview, undefined, "item1 fixture: this 'Keep the plan' needs no code change");
      await withdrawWorkflowDecisionsByKeyV1(
        { taskFolderPath: env.folder, canonicalId: normalizePath(env.folder) },
        `ownerPlanDecision:${ITEM_ONE_BLOCKER_ID_V1}`,
        "answered"
      );
      // The stop's own card would come back from the plateau (bugs8 Step 14), so the task is paused with no plateau record
      // holding it: the pause reason survives only as the task's own `pausedReason`, and nothing else is open.
      const progressPath = nodePath.join(env.folder, "task-progress.json");
      const paused = JSON.parse(nodeFs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
      delete paused["escalation"];
      nodeFs.writeFileSync(progressPath, JSON.stringify(paused, null, 2), "utf8");

      await recordOwnerPlanDecisionV1(arg);
      await itemOneSettleV1();
      assert.equal(env.downstream.calls, 0, "setup: an answer that needs no code change dispatched a round");
      assert.equal(env.readProgress().status, "paused", "setup: the task did not stay paused");

      const pauseLines = async (): Promise<string[]> =>
        (await itemOneConversationV1(env.folder)).filter(
          (line) => /paused/i.test(line) && /owner decision|holding the score|plateau/i.test(line) && /Resume Task/.test(line)
        );
      const first = await pauseLines();
      assert.equal(
        first.length,
        1,
        `item1c: expected exactly one line naming the pause reason (the plateau: every blocker needs an owner decision) and the click that resumes (Resume Task), found ${first.length}: ${JSON.stringify(await itemOneConversationV1(env.folder))}`
      );

      // The same answer again, in the same state, adds nothing.
      await recordOwnerPlanDecisionV1(arg);
      await itemOneSettleV1();
      const second = await pauseLines();
      assert.equal(second.length, 1, `item1c: repeating the answer in the same state left ${second.length} pause lines, not one`);
    } finally {
      env.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// bugs8 item 3 (Steps 14-15): one card per stop. The bugs7 review had one owner-decision blocker and one stale-record
// blocker; the can't-progress card must not sit beside the decision card, in either order, and says once what waits.
// ---------------------------------------------------------------------------

void describe("bugs8 item 3: one card per stop", () => {
  const pendingForStageV1 = (folder: string): readonly { readonly decisionKey: string }[] =>
    listPendingWorkflowDecisionsForTaskV1(normalizePath(folder)).filter((card) => card.stage === ITEM_ONE_STAGE_V1);

  const plateauCardInputV1 = (folder: string, overrides: object = {}): ReturnType<typeof buildEscalationDecisionV1> =>
    buildEscalationDecisionV1(
      "plateau",
      ITEM_ONE_STAGE_V1,
      "plateau",
      { canonicalId: normalizePath(folder), taskFolderPath: folder },
      {
        blockersCount: 2,
        primaryBlockerDescription: "Step 19 chain boundary needs an owner decision.",
        allBlockerDescriptions: ["Step 19 chain boundary needs an owner decision.", "The protected plan-final.md still records the old boundary."],
        narrowedNote: "",
        progressNote: "",
        taskFixableCount: 1,
        hasSpecDefect: false,
        hasDeclinedBlocker: false,
        hasNonFixableBlocker: true,
        nextStageHasRun: false,
        clearingNote: "",
        dispatchModeEvidence: [],
        planItemsOpen: 2,
        provisionalTicks: 2,
        reviewAffirmsOpenItemsBuilt: true,
        ownerDecisionBlockersPresent: true,
        ...overrides,
      }
    );

  void it("build-count-precedence: a blocker naming unbuilt work never turns a zero 'to build' count into a Build offer", () => {
    // 2 open items, both built but not checked: the stop card's own split says 0 to build.
    const card = plateauCardInputV1("/tmp/build-count-precedence", {
      taskFixableAllUnbuiltWork: true,
      taskFixableIncludesUnbuiltWork: true,
      unbuiltItemsNamedCount: 5,
      unbuiltWorkReferences: ["Step 4", "Step 5"],
      applyReviewRoundsClosedNone: 5,
      hasNonFixableBlocker: false,
      ownerDecisionBlockersPresent: false,
    });
    assert.ok(
      !card.options.some((option) => option.optionId === "buildRemaining" || /^Build the /.test(option.label)),
      `build-count-precedence: a Build option was offered with nothing to build: ${JSON.stringify(card.options.map((o) => o.label))}`
    );
    assert.ok(
      !(card.recommendation.kind === "option" && card.recommendation.optionId === "buildRemaining"),
      "build-count-precedence: Build was recommended with nothing to build"
    );
    assert.doesNotMatch(JSON.stringify(card), /choose \\"Build the/, "the card still tells the owner to choose Build");
    // With items nothing has built, Build is offered and counts only those.
    const unbuilt = plateauCardInputV1("/tmp/build-count-precedence", {
      planItemsOpen: 3,
      provisionalTicks: 1,
      taskFixableAllUnbuiltWork: true,
      taskFixableIncludesUnbuiltWork: true,
      hasNonFixableBlocker: false,
      ownerDecisionBlockersPresent: false,
    });
    const build = unbuilt.options.find((option) => option.optionId === "buildRemaining");
    assert.ok(build && /Build the 2 open plan items/.test(build.label), `Build should count the 2 unbuilt items: ${build?.label}`);
  });

  void it("a can't-progress card already waiting is withdrawn when the decision card is posted: exactly one card is left", async () => {
    const env = await installItemOneEnvironmentV1("one-card-reverse", { keepNeedsCodeChange: true, downstream: "starts" });
    try {
      const store = { taskFolderPath: env.folder, canonicalId: normalizePath(env.folder) };
      await withdrawWorkflowDecisionsByKeyV1(store, `ownerPlanDecision:${ITEM_ONE_BLOCKER_ID_V1}`, "setup: the decision card comes second");
      await postWorkflowDecisionV1(plateauCardInputV1(env.folder), { ...store, stage: ITEM_ONE_STAGE_V1 });
      assert.deepEqual(
        pendingForStageV1(env.folder).map((card) => card.decisionKey),
        ["reviewPlateauEscalation"],
        "setup: the can't-progress card is the only card before the decision card"
      );

      const block = parseOwnerDecisionsNeededV1(itemOneReviewTextV1(true)).find((candidate) => candidate.id === ITEM_ONE_BLOCKER_ID_V1);
      assert.ok(block, "setup: the review's owner-decision block parses");
      await postOwnerPlanDecisionCardV1({
        taskFolderPath: env.folder,
        stage: ITEM_ONE_STAGE_V1,
        block,
        reviewText: itemOneReviewTextV1(true),
      });
      assert.deepEqual(
        pendingForStageV1(env.folder).map((card) => card.decisionKey),
        [`ownerPlanDecision:${ITEM_ONE_BLOCKER_ID_V1}`],
        "the stage has more than the one decision card after it was posted"
      );
    } finally {
      env.restore();
    }
  });

  void it("with the decision card waiting, the blockers it does not ask about get one line, once", async () => {
    const env = await installItemOneEnvironmentV1("one-card-deferral", { keepNeedsCodeChange: true, downstream: "starts" });
    try {
      __resetOwnerDecisionDeferralLinesV1();
      const store = { taskFolderPath: env.folder, canonicalId: normalizePath(env.folder) };
      await withdrawWorkflowDecisionsByKeyV1(store, `ownerPlanDecision:${ITEM_ONE_BLOCKER_ID_V1}`, "setup: the card is re-posted with its blocker");
      const block = parseOwnerDecisionsNeededV1(itemOneReviewTextV1(true)).find((candidate) => candidate.id === ITEM_ONE_BLOCKER_ID_V1);
      assert.ok(block, "setup: the review's owner-decision block parses");
      await postOwnerPlanDecisionCardV1({
        taskFolderPath: env.folder,
        stage: ITEM_ONE_STAGE_V1,
        block,
        reviewText: itemOneReviewTextV1(true),
        blockerIdentities: ["lineage:step-19"],
      });
      const blockers = [
        { identity: "lineage:step-19", description: "Step 19 chain boundary needs an owner decision." },
        { identity: "lineage:stale-records", description: "The protected plan-final.md still records the old boundary." },
      ];
      const first = await writeOwnerDecisionDeferralLineV1(env.folder, normalizePath(env.folder), ITEM_ONE_STAGE_V1, blockers, "review-a");
      const second = await writeOwnerDecisionDeferralLineV1(env.folder, normalizePath(env.folder), ITEM_ONE_STAGE_V1, blockers, "review-a");
      assert.equal(first, true, "the first call wrote no line");
      assert.equal(second, false, "the second call wrote a line again");
      const lines = (await itemOneTranscriptV1(env.folder)).filter((line) => /waits? until you answer the decision card/.test(line));
      assert.equal(lines.length, 1, `expected one deferral line, found ${lines.length}`);
      assert.match(lines[0]!, /^1 other blocker waits until you answer the decision card: "The protected plan-final\.md still records the old boundary\."\.$/);
      // The owner sees it: an untyped assistant line, not an outcome entry the chat hides.
      const entry = (await readChatHistory(env.folder, env.folder)).find((message) => message.text === lines[0]);
      assert.ok(entry !== undefined && isConversationEntryV1(entry), "the deferral line is hidden from the conversation");
      // Once per review: a changed set of waiting blockers in the same review stays silent, a new review speaks again.
      const sameReviewOtherBlockers = await writeOwnerDecisionDeferralLineV1(
        env.folder,
        normalizePath(env.folder),
        ITEM_ONE_STAGE_V1,
        [...blockers, { identity: "lineage:third", description: "A third blocker." }],
        "review-a"
      );
      assert.equal(sameReviewOtherBlockers, false, "the same review wrote a second line");
      const nextReview = await writeOwnerDecisionDeferralLineV1(env.folder, normalizePath(env.folder), ITEM_ONE_STAGE_V1, blockers, "review-b");
      assert.equal(nextReview, true, "a new review wrote no line");
    } finally {
      env.restore();
    }
  });

  void it("the real posting path: with the decision card waiting there is one card and one line; after an answer that starts nothing the stop gets its one can't-progress card back", async () => {
    const env = await installItemOneEnvironmentV1("one-card-integration", {
      keepNeedsCodeChange: false,
      downstream: "starts",
      builtButUnchecked: true,
    });
    try {
      // The bugs7 shape: the owner-decision blocker, plus a stale-record blocker nobody has to decide.
      nodeFs.writeFileSync(
        nodePath.join(env.folder, "impl-high-review.md"),
        itemOneReviewTextV1(false)
          .replace("- Step 19 chain boundary needs", `- ${ITEM_ONE_BLOCKER_ID_V1}: Step 19 chain boundary needs`)
          .replace(
            "<!-- blockers:end -->",
            "- The protected plan-final.md still records the superseded Publish boundary.\n<!-- blockers:end -->"
          ),
        "utf8"
      );
      const store = { taskFolderPath: env.folder, canonicalId: normalizePath(env.folder) };
      const decisionKey = `ownerPlanDecision:${ITEM_ONE_BLOCKER_ID_V1}`;
      __resetOwnerDecisionDeferralLinesV1();
      // The review's own decision card asks about the first blocker only, as the real posting path records it.
      const reviewText = nodeFs.readFileSync(nodePath.join(env.folder, "impl-high-review.md"), "utf8");
      const parsedBlockers = parseReviewBlockers(reviewText);
      assert.equal(parsedBlockers.length, 2, `setup: the review has two blockers, found ${parsedBlockers.length}`);
      await withdrawWorkflowDecisionsByKeyV1(store, decisionKey, "setup: re-posted with its blocker identity");
      const block = parseOwnerDecisionsNeededV1(reviewText).find((candidate) => candidate.id === ITEM_ONE_BLOCKER_ID_V1);
      assert.ok(block, "setup: the review's owner-decision block parses");
      await postOwnerPlanDecisionCardV1({
        taskFolderPath: env.folder,
        stage: ITEM_ONE_STAGE_V1,
        block,
        reviewText,
        blockerIdentities: [blockerOwnerIdentityV1(parsedBlockers[0]!)],
      });

      // 1. The decision card is waiting: the stop's other card is not posted, and one line says what waits (once).
      await repostPlateauCardAfterOwnerDecisionV1(env.folder, ITEM_ONE_STAGE_V1, "not-the-pending-card");
      await repostPlateauCardAfterOwnerDecisionV1(env.folder, ITEM_ONE_STAGE_V1, "not-the-pending-card");
      assert.deepEqual(
        pendingForStageV1(env.folder).map((card) => card.decisionKey),
        [decisionKey],
        "the stage has more than the one decision card while it waits"
      );
      const waitLines = (await itemOneTranscriptV1(env.folder)).filter((line) => /wait until you answer the decision card|waits until you answer the decision card/.test(line));
      assert.equal(waitLines.length, 1, `expected one deferral line, found ${waitLines.length}: ${JSON.stringify(waitLines)}`);

      // 2. The answer starts nothing ("Keep the plan", no code change); once its card is closed the stop has one card.
      const arg = env.answerArgFor("Keep the plan");
      await recordOwnerPlanDecisionV1(arg);
      await itemOneSettleV1();
      assert.equal(env.downstream.calls, 0, "setup: an answer that needs no code change dispatched a round");
      await withdrawWorkflowDecisionsByKeyV1(store, decisionKey, "answered");
      const pending = pendingForStageV1(env.folder);
      assert.deepEqual(
        pending.map((card) => card.decisionKey),
        ["reviewPlateauEscalation"],
        `after the answer the stage should hold exactly the can't-progress card: ${JSON.stringify(pending.map((card) => card.decisionKey))}`
      );
      const card = listPendingWorkflowDecisionsForTaskV1(normalizePath(env.folder)).find((entry) => entry.decisionKey === "reviewPlateauEscalation");
      assert.ok(card, "the can't-progress card is missing");
      const labels = card.options.map((option) => option.label);
      assert.ok(!labels.some((label) => /^Build /.test(label)), `a Build option was offered: ${JSON.stringify(labels)}`);
      // The fixture's two ticked-but-unchecked items were counted by the real posting path: the evidence option is there.
      assert.ok(
        card.options.some((option) => option.optionId === "checkBuiltItems"),
        `the two built-but-unchecked items got no evidence option: ${JSON.stringify(card.options.map((option) => option.optionId))}`
      );
      for (const choice of ["Settle it with a rule", "Accept this narrowing", "Keep the item open", "Change the plan instead"]) {
        assert.ok(!labels.includes(choice), `the decision card's choice "${choice}" is repeated: ${JSON.stringify(labels)}`);
      }
      assert.ok(card.options.length <= 4, `${card.options.length} options: ${JSON.stringify(labels)}`);
      assert.equal(card.recommendation.kind, "option", "the card has no recommendation");
      assert.equal(
        card.options.filter((option) => card.recommendation.kind === "option" && option.optionId === card.recommendation.optionId).length,
        1,
        "the recommendation does not name exactly one option on the card"
      );
    } finally {
      env.restore();
    }
  });

  void it("two built-but-unchecked items with no review wording about them: no Build, the evidence path is offered (checkBuiltItems)", () => {
    const folder = "/tmp/bugs8-built-unchecked";
    const card = buildEscalationDecisionV1(
      "plateau",
      ITEM_ONE_STAGE_V1,
      "plateau",
      { canonicalId: normalizePath(folder), taskFolderPath: folder },
      {
        blockersCount: 2,
        primaryBlockerDescription: "Step 19 chain boundary needs an owner decision.",
        allBlockerDescriptions: ["Step 19 chain boundary needs an owner decision.", "The protected plan-final.md still records the old boundary."],
        narrowedNote: "",
        progressNote: "",
        taskFixableCount: 1,
        hasSpecDefect: false,
        hasDeclinedBlocker: false,
        hasNonFixableBlocker: true,
        nextStageHasRun: false,
        clearingNote: "",
        dispatchModeEvidence: [],
        planItemsOpen: 2,
        provisionalTicks: 2,
        provisionalItemTexts: ["Step 14: first built item", "Step 15: second built item"],
        reviewAffirmsOpenItemsBuilt: false,
        ownerDecisionBlockersPresent: true,
      }
    );
    const ids = card.options.map((option) => option.optionId);
    assert.ok(!ids.includes("buildRemaining"), `Build was offered with nothing left to build: ${JSON.stringify(ids)}`);
    assert.ok(!card.options.some((option) => /^Build /.test(option.label)), "a Build label was offered");
    const evidence = card.options.find((option) => option.optionId === "checkBuiltItems");
    assert.ok(evidence !== undefined, `no evidence option for the built items: ${JSON.stringify(ids)}`);
    assert.equal(evidence.effect.kind, "command");
    assert.ok(card.options.length <= 4, `${card.options.length} options`);
    assert.equal(card.options.filter((option) => card.recommendation.kind === "option" && option.optionId === card.recommendation.optionId).length, 1);
  });

  void it("the can't-progress card after the answer: no Build for built items, none of the decision card's choices, at most 4 options, one recommendation", () => {
    const card = plateauCardInputV1("/tmp/bugs8-one-card");
    const labels = card.options.map((option) => option.label);
    assert.ok(!labels.some((label) => /^Build /.test(label)), `a Build option was offered for built items: ${JSON.stringify(labels)}`);
    for (const choice of ["Settle it with a rule", "Accept this narrowing", "Keep the item open", "Change the plan instead"]) {
      assert.ok(!labels.includes(choice), `the decision card's choice "${choice}" is repeated: ${JSON.stringify(labels)}`);
    }
    assert.ok(card.options.length <= 4, `${card.options.length} options`);
    const recommendation = card.recommendation;
    assert.equal(recommendation.kind, "option");
    assert.ok(
      recommendation.kind === "option" && card.options.some((option) => option.optionId === recommendation.optionId),
      "the recommendation names an option that is not on the card"
    );
  });
});

// ---------------------------------------------------------------------------
// bugs8 Step 4/6: the outcome wording, and where "Applying now" may be written.
// ---------------------------------------------------------------------------

void describe("bugs8 Step 4/6: dispatch outcomes and their one line", () => {
  void it("only a start that did not happen gets a 'Nothing started' line, naming the reason and the click", () => {
    assert.equal(describeStageDispatchNotStartedV1({ kind: "started" }), undefined);
    assert.equal(
      describeStageDispatchNotStartedV1({ kind: "refused", reason: "no AI model is configured.", click: "Resume Task" }),
      "Nothing started: no AI model is configured. Click Resume Task to carry on."
    );
    assert.equal(
      describeStageDispatchNotStartedV1({ kind: "held", reason: "a round is running", startsWhen: "this starts when it ends" }),
      "A round is running. This starts when it ends."
    );
  });

  void it("'Applying now' is written in ownerPlanDecisionCommandV1.ts only from the confirmed-start callback", () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "ownerPlanDecisionCommandV1.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const hits = [...code.matchAll(/applying now/gi)];
    assert.equal(hits.length, 1, "exactly one place writes 'Applying now'");
    const index = code.search(/applying now/i);
    assert.match(code.slice(Math.max(0, index - 200), index), /onStartedV1/, "that place is the onStartedV1 callback");
  });
});
