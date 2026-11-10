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
  parseReviewBlockersDetailed,
} from "../utils/reviewReadiness";
import {
  executeOwnerPlanDecisionLockedV1,
  findAmbiguousRewordTargetV1,
  postOwnerOnlyBlockersCardV1,
  postOwnerPlanDecisionCardV1,
  RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
  startReReviewAfterOwnerDecisionV1,
} from "../commands/ownerPlanDecisionCommandV1";
import { buildEscalationDecisionV1, classifyEnvironmentalBlockerV1, isOwnerDecisionBlockerV1 } from "../utils/reviewEscalation";
import { decideReviewRoute } from "../utils/reviewRouting";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { normalizePath } from "../utils/taskRoot";
import { isOwnerEvidenceBlockerV1 } from "../utils/stageAdvanceOverrideV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
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
    assert.equal(started, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "vs-code-ai-helper.resumeAndRerunReview");
    assert.deepEqual(calls[0]!.args[0], { taskFolderPath: baseArg.taskFolderPath });
    // Only task.md and the plan changed, so the unchanged-tree guard must not refuse the review.
    assert.equal((calls[0]!.args[1] as { skipUnchangedTreeGuardV1?: boolean }).skipUnchangedTreeGuardV1, true);
    assert.equal(typeof (calls[0]!.args[1] as { onDispatchingV1?: unknown }).onDispatchingV1, "function");
  });

  void it("keeping the plan as written, or approving a deviation, starts no review", async () => {
    let calls = 0;
    const run = (): Promise<boolean> => {
      calls++;
      return Promise.resolve(true);
    };
    assert.equal(await startReReviewAfterOwnerDecisionV1({ ...baseArg, rejects: true }, run), false);
    assert.equal(
      await startReReviewAfterOwnerDecisionV1({ ...baseArg, planAction: { kind: "approveDeviation" } }, run),
      false
    );
    assert.equal(calls, 0);
  });

  void it("an own-words answer, which keeps the plan untouched, does start the review", async () => {
    let calls = 0;
    const started = await startReReviewAfterOwnerDecisionV1({ ...baseArg, rejects: true, ownWords: true }, () => {
      calls++;
      return Promise.resolve(true);
    });
    assert.equal(started, true);
    assert.equal(calls, 1);
  });

  void it("a failing start is reported as not started, never thrown into the answer", async () => {
    const started = await startReReviewAfterOwnerDecisionV1(baseArg, () => Promise.reject(new Error("boom")));
    assert.equal(started, false);
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
