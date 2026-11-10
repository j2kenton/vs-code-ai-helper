/**
 * review2 Step 38 (Part 8; bugs6 item 6): a deviation card keeps "what was done differently" apart from "what is left
 * undone". Approve covers the change only; the gap is its own choice or stays open work; what is recorded and what the
 * reply says name exactly what was approved.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  deviationApprovalReplyV1,
  deviationApprovalScopeV1,
  executeOwnerPlanDecisionLockedV1,
  type RecordOwnerPlanDecisionArgV1,
} from "../commands/ownerPlanDecisionCommandV1";
import { parsePlanDeviationsV1, splitDeviationAndGapV1 } from "../utils/reviewReadiness";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import type { TaskProgress } from "../types/taskProgress";

const PLAN = [
  "# Plan",
  "- [ ] Step 24 — check admission in workAdmissionV1.ts",
  "- [ ] Step 25 — something else",
].join("\n");

// The 2026-11-07 16:27 UTC run1 deviation that Approve used to approve together with its gap.
const STEP_24_SUMMARY = [
  "## Files Changed",
  "",
  "- a.ts",
  "",
  "## Plan deviations",
  "",
  "- **Step 24 built in a different place.** The plan says to check `workAdmissionV1.ts`; I added the check in `TaskOperationRegistry.begin` instead.",
  "  - It only checks round roots at start. A Fast Forward run whose later Apply Review child starts while another task changes code is not refused.",
  "  - I did not touch Fast Forward chaining.",
  "",
].join("\n");

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-deviation-gap-test-"));
after(() => nodeFs.rmSync(ROOT, { recursive: true, force: true }));

function makeTask(name: string): string {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), PLAN, "utf8");
  nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nBuild it.\n", "utf8");
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

void describe("a deviation and the gap it mentions are separate questions (review2 Step 38)", () => {
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
    __extensionContextV1TestOnly.reset();
  });
  function patchReadFile(): void {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  }

  void it("splits the change from the stated gap", () => {
    const split = splitDeviationAndGapV1(
      "**Step 24 built in a different place.** I added the check in the registry instead.\n- It only checks round roots at start. Children are not refused."
    );
    assert.match(split.change, /built in a different place/);
    assert.doesNotMatch(split.change, /only checks/);
    assert.match(split.gap ?? "", /only checks round roots/);
    assert.match(split.gap ?? "", /not refused/);
    // A "Left undone:" line is the gap too.
    const labelled = splitDeviationAndGapV1("**Moved the check.** Done in the registry.\nLeft undone: Fast Forward children.");
    assert.equal(labelled.gap, "Fast Forward children.");
    // A deviation that states no gap is untouched.
    assert.equal(splitDeviationAndGapV1("**Moved the check.** Done in the registry instead.").gap, undefined);
  });

  void it("the Step 24 card is one card with the change and the gap separate, and Approve leaves the gap open", () => {
    const cards = parsePlanDeviationsV1(STEP_24_SUMMARY, { planOfRecord: PLAN });
    assert.equal(cards.length, 1);
    const card = cards[0]!;
    assert.match(card.problem, /What was done differently: .*different place/s);
    assert.match(card.problem, /Left undone: .*only checks round roots/s);
    assert.deepEqual(
      card.options.map((o) => o.id),
      ["approve-deviation", "approve-deviation-accept-gap", "reject-deviation"]
    );
    const approve = card.options[0]!.planAction!;
    assert.equal(approve.kind, "approveDeviation");
    assert.ok(approve.statedGap && /not refused/.test(approve.statedGap));
    assert.equal(approve.gapAccepted, undefined, "plain Approve never accepts the gap");
    assert.equal(card.options[1]!.planAction!.gapAccepted, true, "accepting the gap is its own option");
    assert.match(card.options[0]!.consequence, /stays open work/);
  });

  void it("a deviation with no stated gap keeps its one Approve option", () => {
    const cards = parsePlanDeviationsV1(
      ["## Plan deviations", "", "- **Step 24 built in a different place.** I put the check in the registry instead."].join("\n"),
      { planOfRecord: PLAN }
    );
    assert.deepEqual(
      cards[0]!.options.map((o) => o.id),
      ["approve-deviation", "reject-deviation"]
    );
    assert.equal(cards[0]!.options[0]!.label, "Approve plan deviation");
  });

  void it("deviationApprovalScopeV1 names exactly what each answer covers", () => {
    const base: RecordOwnerPlanDecisionArgV1 = {
      taskFolderPath: "x",
      stage: "impl-high-review",
      blockerId: "plan-deviation-aaaaaaaa",
      optionId: "approve-deviation",
      optionLabel: "Approve",
    };
    const only = deviationApprovalScopeV1({
      ...base,
      planAction: { kind: "approveDeviation", approvedChange: "Step 24 built in a different place.", statedGap: "children are not refused." },
    });
    assert.equal(only?.approved, "Approved the change only: Step 24 built in a different place");
    assert.equal(only?.stillOpen, "children are not refused");
    const both = deviationApprovalScopeV1({
      ...base,
      planAction: { kind: "approveDeviation", approvedChange: "Step 24 moved", statedGap: "children", gapAccepted: true },
    });
    assert.match(both?.approved ?? "", /Accepted the gap: children/);
    assert.equal(both?.stillOpen, undefined);
    // No change text recorded, or a rejection: the plain wording applies.
    assert.equal(deviationApprovalScopeV1({ ...base, planAction: { kind: "approveDeviation" } }), undefined);
    assert.equal(
      deviationApprovalScopeV1({ ...base, rejects: true, planAction: { kind: "approveDeviation", approvedChange: "x" } }),
      undefined
    );
  });

  void it("Approve (change only) records the change and the open gap, and the reply says what stays open", async () => {
    patchReadFile();
    const folder = makeTask("gap-approve-only");
    const card = parsePlanDeviationsV1(STEP_24_SUMMARY, { planOfRecord: PLAN })[0]!;
    const option = card.options[0]!;
    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: card.id,
      optionId: option.id,
      optionLabel: option.label,
      planAction: option.planAction,
      blockerText: card.problem,
    });

    const task = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
    assert.match(task, /Owner's answer: Approved the change only: Step 24 built in a different place/);
    assert.match(task, /Not approved, still open: .*only checks round roots/);
    const plan = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    assert.match(plan, /Approved the change only: Step 24 built in a different place/);
    assert.match(plan, /still open: .*only checks round roots/);
    const progress = JSON.parse(nodeFs.readFileSync(nodePath.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
    const description = progress.blockerSupersessions?.[0]?.blockerDescription ?? "";
    assert.match(description, /approved the change only/);
    assert.match(description, /still open/);
  });

  void it("the reply says what was recorded and what stays open, never that the next review will not carry the blocker", () => {
    const only = deviationApprovalReplyV1(
      { approved: "Approved the change only: Step 24 moved", stillOpen: "children are not refused." },
      "plan-deviation-aaaaaaaa",
      true
    );
    assert.match(only, /^Approved the change only: Step 24 moved\./);
    assert.match(only, /Still open: children are not refused\. It stays a blocker for the next review/);
    assert.match(only, /task\.md under Owner decisions/);
    assert.doesNotMatch(only, /will not carry this blocker/);
    const both = deviationApprovalReplyV1({ approved: "Approved the change: x. Accepted the gap: y" }, "id", false);
    assert.doesNotMatch(both, /Still open/);
    assert.doesNotMatch(both, /task\.md/);
  });

  void it("Approve and accept the gap records both, and the reply does not call anything open", async () => {
    patchReadFile();
    const folder = makeTask("gap-accept-both");
    const card = parsePlanDeviationsV1(STEP_24_SUMMARY, { planOfRecord: PLAN })[0]!;
    const option = card.options[1]!;
    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: card.id,
      optionId: option.id,
      optionLabel: option.label,
      planAction: option.planAction,
      blockerText: card.problem,
    });
    const task = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
    assert.match(task, /Accepted the gap: .*only checks round roots/);
    assert.doesNotMatch(task, /still open/);
  });
});
