/**
 * bugs3 Step 5/7 (open items 10 and 17): one classification of deferred plan
 * work and carried owner gates, with controls for work that is still required.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { readDeferredOpenPlanItemCountV1 } from "../utils/reviewEscalation";
import {
  classifyDeferredPlanScopeV1,
  classifyOwnerEvidenceBlockerV1,
  extractCarriedGatesV1,
  taskDescriptionSectionV1,
} from "../utils/deferredPlanScopeV1";

const TASK_MD = [
  "# Task",
  "",
  "## Task Description",
  "",
  "Produce the initial backup proposal. Plan Steps 3–12 wait for owner approval of the proposal; do not build them in this task yet, and reviews must not count them as unbuilt.",
  "Missing owner evidence must not prevent producing the initial proposal.",
  "",
  "## Draft",
  "",
  "Steps 1 and 2 are optional.",
].join("\n");

const PLAN = [
  "# Plan",
  "",
  "PART 0 may finish with the root-recovery gate OPEN; Steps 4, 6, 9 and 12 wait on it.",
  "",
  "## PART 1",
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
  "- [ ] Enable MFA",
  "",
  "### 4. Escrow",
  "- [ ] Escrow the root secret",
  "",
  "### 5. Alarm",
  "- [ ] Add the combined alarm",
].join("\n");

void describe("deferred plan scope (bugs3 Steps 5/7)", () => {
  void it("reads only the owner's Task Description section for task-level deferrals", () => {
    const section = taskDescriptionSectionV1(TASK_MD);
    assert.match(section, /Steps 3–12/);
    assert.doesNotMatch(section, /Steps 1 and 2/);
  });

  void it("marks steps the task defers as deferred, gated steps as gated, and the rest open or settled", () => {
    const scope = classifyDeferredPlanScopeV1({ planText: PLAN, taskMd: TASK_MD });
    const byText = (text: string) => scope.items.find((item) => item.itemText === text)!;
    assert.equal(byText("Inventory the accounts").disposition, "settled");
    assert.equal(byText("Record the registrar owner").disposition, "open");
    assert.equal(byText("Write the proposal document").disposition, "open");
    assert.equal(byText("Create the account").disposition, "deferred");
    assert.equal(byText("Enable MFA").disposition, "deferred");
    assert.equal(byText("Create the account").source, "task.md");
    // Step 4 is both deferred by task.md and gated; the deferral wins (it is not buildable at all here).
    assert.equal(byText("Escrow the root secret").disposition, "deferred");
    assert.equal(byText("Add the combined alarm").disposition, "deferred");
    assert.deepEqual(scope.counts, { open: 2, deferred: 4, gated: 0, settled: 1 });
  });

  void it("shows gated work separately when the task does not defer it", () => {
    const scope = classifyDeferredPlanScopeV1({
      planText: PLAN,
      taskMd: "## Task Description\n\nBuild the whole plan.\n",
    });
    assert.equal(scope.items.find((i) => i.itemText === "Escrow the root secret")!.disposition, "gated");
    assert.equal(scope.counts.deferred, 0);
    assert.equal(scope.counts.gated, 1);
    assert.equal(scope.counts.open, 5);
    assert.deepEqual(scope.carriedGates[0]!.dependentSteps, [4, 6, 9, 12]);
    // Steps 6, 9 and 12 do not exist in this plan: reported, not silently ignored.
    assert.deepEqual([...scope.unresolvedReferences].sort(), ["Step 12", "Step 6", "Step 9"]);
  });

  void it("review prose alone never defers work", () => {
    // The plan and task are unchanged; only a review (not passed in) says the steps are intentionally unbuilt.
    const scope = classifyDeferredPlanScopeV1({ planText: PLAN, taskMd: "## Task Description\n\nBuild the whole plan.\n" });
    assert.equal(scope.counts.deferred, 0);
  });

  void it("a negated cue, a reversed range and an ambiguous numbering defer nothing", () => {
    const negated = classifyDeferredPlanScopeV1({
      planText: PLAN,
      taskMd: "## Task Description\n\nDo not defer Steps 3 and 4.\n",
    });
    assert.equal(negated.counts.deferred, 0);
    const reversed = classifyDeferredPlanScopeV1({
      planText: PLAN,
      taskMd: "## Task Description\n\nSteps 5–3 are out of scope.\n",
    });
    assert.equal(reversed.counts.deferred, 0);
    assert.ok(reversed.unresolvedReferences.includes("Steps 5–3"));
    const repeated = [
      "## Part 1",
      "### 1. First",
      "- [ ] Alpha work",
      "## Part 2",
      "### 1. Again",
      "- [ ] Beta work",
    ].join("\n");
    const ambiguous = classifyDeferredPlanScopeV1({
      planText: repeated,
      taskMd: "## Task Description\n\nStep 1 is out of scope.\n",
    });
    assert.equal(ambiguous.counts.deferred, 0);
    assert.equal(ambiguous.counts.open, 2);
  });

  void it("carried gates come from a plan sentence that marks the gate OPEN and names dependent steps", () => {
    const gates = extractCarriedGatesV1(PLAN);
    assert.equal(gates.length, 1);
    assert.deepEqual(gates[0]!.dependentSteps, [4, 6, 9, 12]);
    assert.deepEqual(extractCarriedGatesV1("The gate is closed. Step 4 uses it."), []);
  });
});

void describe("deferred open items leave the 'Build the N open plan items' count (bugs3 Step 7)", () => {
  void it("counts only open items the owner's task description defers", async () => {
    const folder = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "deferred-scope-"));
    const original = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      Promise.resolve(new Uint8Array(nodeFs.readFileSync(uri.fsPath)));
    try {
      nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), PLAN);
      nodeFs.writeFileSync(nodePath.join(folder, "task.md"), TASK_MD);
      assert.equal(await readDeferredOpenPlanItemCountV1(vscode.Uri.file(folder)), 4);
      nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "## Task Description\n\nBuild everything.\n");
      assert.equal(await readDeferredOpenPlanItemCountV1(vscode.Uri.file(folder)), 0);
      nodeFs.rmSync(nodePath.join(folder, "plan-final.md"));
      assert.equal(await readDeferredOpenPlanItemCountV1(vscode.Uri.file(folder)), 0);
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = original;
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("owner-evidence blocker disposition (bugs3 Steps 6/7)", () => {
  const gate = {
    description: "PART 0 may finish with the root-recovery gate OPEN; Steps 4, 6, 9 and 12 wait on it.",
    dependentSteps: [4, 6, 9, 12],
  };

  void it("a blocker naming only the gate's dependent steps is carried", () => {
    const result = classifyOwnerEvidenceBlockerV1("Owner evidence needed before Steps 4 and 6: escrow location.", {
      carriedGates: [gate],
    });
    assert.equal(result.kind, "carried");
  });

  void it("a blocker that overlaps the gate's own wording is carried", () => {
    const gateWords = {
      description: "The root-recovery escrow gate is OPEN; Steps 4 and 6 wait on it (backup-account root recovery evidence).",
      dependentSteps: [4, 6],
    };
    const result = classifyOwnerEvidenceBlockerV1(
      "Owner evidence needed: backup-account root recovery evidence and current escrow status.",
      { carriedGates: [gateWords] }
    );
    assert.equal(result.kind, "carried");
  });

  void it("evidence the plan cannot be written without stays a current blocker", () => {
    const result = classifyOwnerEvidenceBlockerV1(
      "Owner evidence needed to write the plan: Steps 4 and 6 assumptions.",
      { carriedGates: [gate] }
    );
    assert.equal(result.kind, "current");
  });

  void it("a blocker naming a step outside the gate, or with no gate at all, stays current", () => {
    assert.equal(
      classifyOwnerEvidenceBlockerV1("Owner evidence needed before Step 5: DNS provider.", { carriedGates: [gate] }).kind,
      "current"
    );
    assert.equal(classifyOwnerEvidenceBlockerV1("Owner evidence needed for Step 4.", { carriedGates: [] }).kind, "current");
  });
});
