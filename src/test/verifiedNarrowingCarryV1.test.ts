/**
 * review1 Step 43 (review blockers 2026-11-04): the card's Apply option applies exactly the narrowings it offered,
 * and the narrowed item keeps the reviewer verification it had before (the nested child changes its content hash).
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { applyVerifiedNarrowingsConfirmedV1 } from "../commands/applyReviewerVerifiedNarrowingsV1";
import type { PlanItemEvidenceV1, TaskProgress } from "../types/taskProgress";
import {
  findPlanItemContentHashV1,
  getPlanRevisionV1,
  listProvisionalTickedItemsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-narrowing-carry-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
const origReadFile = fsApi.readFile;
afterEach(() => {
  fsApi.readFile = origReadFile;
});

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Step 5: Update the three renderers",
  "- [x] Step 6: Document the flag",
  "- [x] Step 7: Something else",
  "",
].join("\n");

const REVIEW = [
  "## Summary",
  "",
  "<!-- verified-narrowing:start -->",
  "- Step 5: Update the three renderers",
  "  not applicable: the third renderer, which does not exist.",
  "  evidence: src/views/third.ts is absent.",
  "- Step 6: Document the flag",
  "  not applicable: the CLI half.",
  "  evidence: src/cli.ts has no flag.",
  "<!-- verified-narrowing:end -->",
  "",
].join("\n");

function makeTask(name: string, progress: Partial<TaskProgress> = {}): string {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), PLAN, "utf8");
  nodeFs.writeFileSync(nodePath.join(folder, "impl-high-review.md"), REVIEW, "utf8");
  nodeFs.writeFileSync(
    nodePath.join(folder, "task-progress.json"),
    JSON.stringify(
      {
        taskFolder: name,
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        ...progress,
      },
      undefined,
      2
    ),
    "utf8"
  );
  return folder;
}

function readProgress(folder: string): TaskProgress {
  return JSON.parse(nodeFs.readFileSync(nodePath.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
}

function verifiedRows(texts: readonly string[]): PlanItemEvidenceV1[] {
  return texts.map((itemText) => ({
    planRevision: getPlanRevisionV1(PLAN),
    itemKey: normalizeChecklistItemTextV1(itemText),
    itemText,
    itemContentHash: findPlanItemContentHashV1(PLAN, itemText)!,
    claims: [],
    verifications: [{ at: "2026-11-04T00:00:00.000Z", evidence: "checked" }],
  }));
}

function useDisk(): void {
  fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
}

void describe("applying a verified narrowing (review1 Step 43)", () => {
  void it("applies only the narrowings the card offered, and the narrowed item keeps its verification", async () => {
    useDisk();
    // Steps 5 and 7 were verified by the reviewer; Step 6 never was.
    const folder = makeTask("narrow", {
      planItemEvidence: verifiedRows(["Step 5: Update the three renderers", "Step 7: Something else"]),
    });
    const offered = [
      {
        itemText: "Step 5: Update the three renderers",
        notApplicable: "the third renderer, which does not exist.",
        evidence: "src/views/third.ts is absent.",
      },
    ];
    const result = await applyVerifiedNarrowingsConfirmedV1({ taskFolderPath: folder, stage: "impl-high-review", offered });
    assert.equal(result.outcome, "done");

    const written = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    assert.match(written, /the third renderer, which does not exist — narrowed \(reviewer-verified\)/);
    assert.ok(!written.includes("the CLI half"), "a narrowing the card did not offer is not applied");

    const progress = readProgress(folder);
    const provisional = listProvisionalTickedItemsV1(
      written,
      progress.planItemEvidence ?? [],
      progress.planItemOwnerDecisions ?? []
    ).map((item) => item.text);
    assert.ok(!provisional.some((text) => /Step 5/.test(text)), "Step 5 kept its verification under the new wording");
    assert.ok(!provisional.some((text) => /Step 7/.test(text)), "Step 7 was untouched");
    assert.ok(provisional.some((text) => /Step 6/.test(text)), "Step 6 was never verified, and nothing verifies it here");
  });

  void it("a narrowing never verifies an item the reviewer had not verified", async () => {
    useDisk();
    const folder = makeTask("narrow-unverified");
    const result = await applyVerifiedNarrowingsConfirmedV1({ taskFolderPath: folder, stage: "impl-high-review" });
    assert.equal(result.outcome, "done");
    const written = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    const progress = readProgress(folder);
    const provisional = listProvisionalTickedItemsV1(
      written,
      progress.planItemEvidence ?? [],
      progress.planItemOwnerDecisions ?? []
    ).map((item) => item.text);
    assert.ok(provisional.some((text) => /Step 5/.test(text)));
  });

  void it("refuses a card whose offered narrowing the review no longer verifies, and writes nothing", async () => {
    useDisk();
    const folder = makeTask("narrow-stale");
    const result = await applyVerifiedNarrowingsConfirmedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      offered: [{ itemText: "Step 7: Something else", notApplicable: "x", evidence: "y" }],
    });
    assert.equal(result.outcome, "refused");
    assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), PLAN);
  });
});
