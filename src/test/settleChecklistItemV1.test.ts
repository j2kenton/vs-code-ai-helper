/**
 * RC1 item 8: settling one checklist item by hand, the hand-off card's Advance
 * offer, and the checklist-change card's wording.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { buildHandoffChecksDecisionInputV1 } from "../commands/handoffChecksV1";
import { buildChecklistChangeProposedDecisionInputV1 } from "../commands/planRevisionV1";
import {
  countChecklistProgressV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  settleChecklistItemV1,
} from "../utils/implementationChecklist";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Build",
  "",
  "- [x] Build the thing",
  "- [ ] Build the other thing",
  "  - [ ] a nested child",
  "",
  "## Verification",
  "",
  "- [ ] Click through the card in a live window",
  "- [ ] Already excluded <!-- ensemble:excluded -->",
  "",
].join("\n");

function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length, "line count must not change");
  return a.flatMap((line, index) => (line === b[index] ? [] : [index]));
}

void describe("settleChecklistItemV1", () => {
  void it("ticks exactly one line and records the note", () => {
    const result = settleChecklistItemV1(PLAN, "Build the other thing", "tick", "did it by hand");
    assert.equal(result.settledItemText, "Build the other thing");
    const changed = changedLines(PLAN, result.content);
    assert.equal(changed.length, 1);
    assert.equal(result.content.split("\n")[changed[0]!], "- [x] Build the other thing — Checked: did it by hand.");
    assert.equal(countChecklistProgressV1(result.content)?.total, countChecklistProgressV1(PLAN)?.total);
  });

  void it("excludes exactly one line, keeping the box open and the denominator unchanged", () => {
    const result = settleChecklistItemV1(PLAN, "Click through the card in a live window", "exclude", "not applicable");
    const changed = changedLines(PLAN, result.content);
    assert.equal(changed.length, 1);
    const line = result.content.split("\n")[changed[0]!]!;
    assert.match(line, /^- \[ \] Click through the card in a live window — Excluded by you: not applicable\. /);
    assert.ok(line.endsWith(EXCLUDED_CHECKLIST_ITEM_MARKER_V1));
    const before = countChecklistProgressV1(PLAN);
    const after = countChecklistProgressV1(result.content);
    assert.equal(after?.total, before?.total);
    assert.equal(after?.closedWithoutDoing, (before?.closedWithoutDoing ?? 0) + 1);
  });

  void it("leaves the plan untouched for a ticked, excluded, nested or unknown item", () => {
    for (const text of ["Build the thing", "Already excluded", "a nested child", "no such item"]) {
      const result = settleChecklistItemV1(PLAN, text, "tick", "x");
      assert.equal(result.settledItemText, undefined, text);
      assert.equal(result.content, PLAN, text);
    }
  });
});

void describe("hand-off card Advance offer", () => {
  const base = { canonicalId: "c", taskFolderPath: "/t", stage: "impl-high-review" as const, reason: "r" };

  void it("is offered only when every remaining check declares Priority: LOW", () => {
    const low = buildHandoffChecksDecisionInputV1({
      ...base,
      checks: ["Package listing. Priority: LOW — cheap to fix", "Wording. Priority: LOW — loud"],
    });
    assert.ok(low.options.some((option) => option.optionId === "advance"));
    const mixed = buildHandoffChecksDecisionInputV1({
      ...base,
      checks: ["Package listing. Priority: LOW — cheap to fix", "Crash test. Priority: HIGH — silent"],
    });
    assert.ok(!mixed.options.some((option) => option.optionId === "advance"));
    const undeclared = buildHandoffChecksDecisionInputV1({ ...base, checks: ["No priority declared"] });
    assert.ok(!undeclared.options.some((option) => option.optionId === "advance"));
  });
});

void describe("checklist-change card", () => {
  const proposal = {
    at: "2026-09-27T00:00:00.000Z",
    kind: "added" as const,
    proposedItems: ["New work A", "New work B"],
    removedItems: [],
  };

  void it("describes the actual change, recommends keeping the plan, and states what revising costs", () => {
    const input = buildChecklistChangeProposedDecisionInputV1("c", "/t", "impl-high-review", proposal);
    assert.match(input.whatHappened, /adding 2 items/);
    assert.match(input.whatHappened, /New work A/);
    const labels = input.options.map((option) => option.label);
    assert.deepEqual(labels, ["Revise the plan", "Keep the plan as it is"]);
    assert.ok(!labels.includes("Discard the proposal"));
    assert.deepEqual(
      { kind: input.recommendation.kind, optionId: input.recommendation.kind === "option" ? input.recommendation.optionId : "" },
      { kind: "option", optionId: "discard" }
    );
    const revise = input.options.find((option) => option.optionId === "revise");
    assert.match(revise?.consequence ?? "", /both plan reviews run again/);
  });
});

void describe("hand-off card Advance dispatch", () => {
  void it("advance is a continue option whose command is the registered force-advance command for that task", () => {
    const input = buildHandoffChecksDecisionInputV1({
      canonicalId: "c",
      taskFolderPath: "/t",
      stage: "impl-high-review",
      reason: "r",
      checks: ["Package listing. Priority: LOW — cheap to fix"],
    });
    const advance = input.options.find((option) => option.optionId === "advance");
    assert.equal(advance?.resumeKind, "continue");
    assert.equal(advance?.effect.kind, "command");
    if (advance?.effect.kind !== "command") {
      return;
    }
    assert.equal(advance.effect.command, "vs-code-ai-helper.completeStageAnywayV1");
    assert.deepEqual(advance.effect.args, [{ taskFolderPath: "/t" }]);

    // What the command does when run is proven by executing the real handler
    // in nextStageBlockerGateV1.test.ts (completeStageAnywayV1, asserting the
    // persisted stage moves). This only checks the registration delegates to it.
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const at = source.indexOf('"vs-code-ai-helper.completeStageAnywayV1",\n      (arg?');
    assert.ok(at >= 0, "completeStageAnywayV1 registration not found");
    assert.match(source.slice(at, at + 300), /completeStageAnywayV1\(context, arg\)/);
  });
});
