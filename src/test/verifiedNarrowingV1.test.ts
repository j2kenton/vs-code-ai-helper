/**
 * review1 Step 43: a reviewer-verified narrowing is recorded as an excluded sub-item when the owner applies the
 * card that offers it (nothing is written before), and a narrowing the reviewer could not check (no evidence line)
 * is never applied.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  applyVerifiedNarrowingsConfirmedV1,
  listPendingVerifiedNarrowingsV1,
  postVerifiedNarrowingsDecisionV1,
} from "../commands/applyReviewerVerifiedNarrowingsV1";

import {
  applyVerifiedNarrowingsToPlanV1,
  computePlanItemContentHashV1,
  countChecklistProgressV1,
  isExcludedChecklistItemText,
  listPlanItemContentHashesV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedNarrowingsV1 } from "../utils/reviewReadiness";

const REVIEW = [
  "## Summary",
  "",
  "<!-- verified-narrowing:start -->",
  "- [x] Step 5: Update the three renderers",
  "  not applicable: the third renderer, which does not exist in this tree.",
  "  evidence: src/views/third.ts is absent and nothing imports it.",
  "- Step 6: Document the flag",
  "  not applicable: the CLI half",
  "<!-- verified-narrowing:end -->",
].join("\n");

const PLAN = [
  "# Plan",
  "",
  "- [x] Step 5: Update the three renderers",
  "  - the first renderer",
  "- [ ] Step 6: Document the flag",
  "- [x] Step 7: Something else",
  "",
].join("\n");

void describe("parseReviewVerifiedNarrowingsV1", () => {
  void it("reads the item, the part and the evidence, and drops an entry with no evidence line", () => {
    const parsed = parseReviewVerifiedNarrowingsV1(REVIEW);
    assert.deepEqual(parsed, [
      {
        itemText: "Step 5: Update the three renderers",
        notApplicable: "the third renderer, which does not exist in this tree.",
        evidence: "src/views/third.ts is absent and nothing imports it.",
      },
    ]);
  });

  void it("yields nothing when the block is absent", () => {
    assert.deepEqual(parseReviewVerifiedNarrowingsV1("## Summary\n\nNo narrowing."), []);
  });
});

void describe("applyVerifiedNarrowingsToPlanV1", () => {
  const narrowing = parseReviewVerifiedNarrowingsV1(REVIEW);

  void it("adds a nested, already-excluded child noted as reviewer-verified, and changes nothing else", () => {
    const result = applyVerifiedNarrowingsToPlanV1(PLAN, narrowing);
    assert.equal(result.applied.length, 1);
    const lines = result.content.split("\n");
    const childIndex = lines.findIndex((line) => line.includes("narrowed (reviewer-verified)"));
    assert.ok(childIndex > 0);
    assert.match(lines[childIndex]!, /^ {2}- \[ \] the third renderer.* — narrowed \(reviewer-verified\): src\/views\/third\.ts is absent and nothing imports it\. <!-- ensemble:excluded -->$/);
    assert.equal(lines[childIndex - 1], "- [x] Step 5: Update the three renderers");
    // Every other line is byte-for-byte as it was.
    assert.deepEqual(
      lines.filter((_, index) => index !== childIndex),
      PLAN.split("\n")
    );
  });

  void it("keeps the parent settled: the excluded child gates nothing and the top-level total does not move", () => {
    const before = countChecklistProgressV1(PLAN)!;
    const after = countChecklistProgressV1(applyVerifiedNarrowingsToPlanV1(PLAN, narrowing).content)!;
    assert.equal(after.total, before.total);
    assert.equal(after.checked, before.checked);
    const child = listPlanItemContentHashesV1(applyVerifiedNarrowingsToPlanV1(PLAN, narrowing).content).find((e) => e.nested && e.text.includes("narrowed"));
    assert.ok(child?.excluded);
    assert.ok(isExcludedChecklistItemText(child.text));
  });

  void it("changes only the narrowed item's content hash", () => {
    const next = applyVerifiedNarrowingsToPlanV1(PLAN, narrowing).content;
    const hashOf = (plan: string, key: string): string | undefined =>
      listPlanItemContentHashesV1(plan).find((e) => !e.nested && e.text.startsWith(key))?.hash;
    assert.notEqual(hashOf(next, "Step 5"), hashOf(PLAN, "Step 5"));
    assert.equal(hashOf(next, "Step 6"), hashOf(PLAN, "Step 6"));
    assert.equal(hashOf(next, "Step 7"), hashOf(PLAN, "Step 7"));
    assert.equal(typeof computePlanItemContentHashV1("x"), "string");
  });

  void it("is idempotent: applying the same narrowing again writes nothing new", () => {
    const once = applyVerifiedNarrowingsToPlanV1(PLAN, narrowing);
    const twice = applyVerifiedNarrowingsToPlanV1(once.content, narrowing);
    assert.equal(twice.content, once.content);
    assert.equal(twice.applied.length, 0);
  });

  void it("skips an item that is not a top-level item of the checklist, with a reason", () => {
    const result = applyVerifiedNarrowingsToPlanV1(PLAN, [
      { itemText: "Step 99: not in the plan", notApplicable: "x", evidence: "y" },
    ]);
    assert.equal(result.content, PLAN);
    assert.equal(result.applied.length, 0);
    assert.match(result.skipped[0]!.reason, /not a top-level item/);
  });
});

void describe("review1 Step 43 (owner decision 2026-11-04): verified narrowings go through a card the owner applies", () => {
  const planWithMarker = `<!-- ensemble:implementation-checklist -->\n\n${PLAN}`;
  const reviewFile = `${REVIEW}\n`;

  // The stubbed `vscode.workspace.fs` reads nothing by default; back it with the real disk for these tests.
  const fsStub = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { readFile: fsStub.readFile, writeFile: fsStub.writeFile, stat: fsStub.stat };
  before(() => {
    fsStub.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    fsStub.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
      await nodeFs.promises.writeFile(uri.fsPath, Buffer.from(data));
    };
  });
  after(() => {
    fsStub.readFile = original.readFile;
    fsStub.writeFile = original.writeFile;
    fsStub.stat = original.stat;
  });

  function makeTask(): string {
    const folder = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-narrowing-card-"));
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), planWithMarker);
    nodeFs.writeFileSync(nodePath.join(folder, "impl-high-review.md"), reviewFile);
    return folder;
  }

  void it("offering the narrowings writes nothing to the plan", async () => {
    const folder = makeTask();
    try {
      const pending = await listPendingVerifiedNarrowingsV1(vscode.Uri.file(folder), reviewFile);
      assert.equal(pending.length, 1);
      assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), planWithMarker);
      // No extension context in this process, so no card is posted, and still nothing is written.
      assert.equal(await postVerifiedNarrowingsDecisionV1(vscode.Uri.file(folder), "impl-high-review", reviewFile), 0);
      assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), planWithMarker);
    } finally {
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the card's Apply option writes the narrowing once; choosing it again says it is already done", async () => {
    const folder = makeTask();
    try {
      const first = await applyVerifiedNarrowingsConfirmedV1({ taskFolderPath: folder, stage: "impl-high-review" });
      assert.equal(first.outcome, "done");
      const written = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
      assert.match(written, /narrowed \(reviewer-verified\)/);
      const second = await applyVerifiedNarrowingsConfirmedV1({ taskFolderPath: folder, stage: "impl-high-review" });
      assert.equal(second.outcome, "alreadyDone");
      assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), written);
    } finally {
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("reviewActions offers the narrowings on the card instead of writing them", () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    assert.ok(source.includes("postVerifiedNarrowingsDecisionV1(folderUri, targetStage, content"));
    assert.ok(!source.includes("applyReviewerVerifiedNarrowingsV1(folderUri"));
  });
});
