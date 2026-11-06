/**
 * review1 Step 57 (and Step 60's advance-confirmation test): a manual move out of High-Level Code Review with plan
 * items still open asks first, naming what will be skipped, in a pop-up.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeOs from "node:os";
import * as vscode from "vscode";
import { after, afterEach, describe, it } from "node:test";

import { confirmAdvanceOverOpenItemsV1 } from "../commands/confirmAdvanceOverOpenItemsV1";
import { buildAdvanceOptionV1, buildEnvironmentalFailureDecisionV1 } from "../utils/reviewEscalation";
import { extractEnvironmentalFailureEvidenceV1 } from "../utils/environmentalFailureEvidenceV1";
import {
  advanceNeedsOpenItemsConfirmationV1,
  advanceOverOpenItemsLabelV1,
  describeAdvanceOverOpenItemsV1,
} from "../utils/advanceOverOpenItemsV1";

void describe("review1 Step 57: the move on from High-Level Code Review names the open plan items", () => {
  void it("guards exactly the move from High-Level to Low-Level Code Review", () => {
    assert.equal(advanceNeedsOpenItemsConfirmationV1("impl-high-review", "impl-low-review"), true);
    assert.equal(advanceNeedsOpenItemsConfirmationV1("impl", "impl-high-review"), false);
    assert.equal(advanceNeedsOpenItemsConfirmationV1("impl-low-review", "publish"), false);
    assert.equal(advanceNeedsOpenItemsConfirmationV1("impl-high-review", "publish"), false);
  });

  void it("the override button says how many items are left open", () => {
    assert.equal(advanceOverOpenItemsLabelV1(1), "Move on, leaving 1 plan item open");
    assert.equal(advanceOverOpenItemsLabelV1(12), "Move on, leaving 12 plan items open");
  });

  void it("the message names the count and the stage it moves to, and says what is skipped", () => {
    const one = describeAdvanceOverOpenItemsV1(1, "Low-Level Code Review");
    assert.match(one, /^1 plan item is still open/);
    assert.match(one, /Low-Level Code Review/);
    assert.match(one, /skips them/);
    assert.match(describeAdvanceOverOpenItemsV1(30, "Low-Level Code Review"), /^30 plan items are still open/);
  });

  void it("nextStage asks before it cancels anything or moves, through the shared confirmation", () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const guard = source.indexOf("confirmAdvanceOverOpenItemsV1(resolved.folderUri, resolved.progress.currentStage");
    assert.ok(guard > 0, "nextStage calls the shared confirmation");
    assert.ok(
      guard < source.indexOf("const cancelResult = await cancelRunningOperationsForTask(resolved.folderUri.fsPath);", guard),
      "the confirmation comes before the running operations are cancelled"
    );
  });

  void it("the Advance card option asks the same question before it resumes or moves anything", () => {
    const source = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", "commands", "resumeTask.ts"), "utf8");
    const start = source.indexOf("export async function resumeAndSetTaskStageV1");
    const guard = source.indexOf("confirmAdvanceOverOpenItemsV1(", start);
    assert.ok(guard > start, "resumeAndSetTaskStageV1 calls the shared confirmation");
    assert.ok(guard < source.indexOf("await resumeThenDispatchV1(", start), "it asks before the task is resumed");
  });
});

void describe("review1 Step 57: the shared confirmation", () => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-advance-open-"));
  after(() => {
    nodeFs.rmSync(root, { recursive: true, force: true });
  });
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
  });

  function task(name: string, lines: readonly string[]): vscode.Uri {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    const folder = nodePath.join(root, ".ensemble", name);
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      ["<!-- ensemble:implementation-checklist -->", "", ...lines, ""].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "task-progress.json"),
      JSON.stringify({
        taskFolder: name,
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      }),
      "utf8"
    );
    return vscode.Uri.file(folder);
  }

  void it("asks with the override label when items are open; only that button goes ahead", async () => {
    const folder = task("open", ["- [x] Step 1: built", "- [ ] Step 2: not built", "- [ ] Step 3: not built"]);
    const asked: string[] = [];
    const answer = (choose: boolean) => (_message: string, label: string) => {
      asked.push(label);
      return Promise.resolve(choose ? label : undefined);
    };
    assert.equal(await confirmAdvanceOverOpenItemsV1(folder, "impl-high-review", "impl-low-review", answer(true)), true);
    assert.equal(await confirmAdvanceOverOpenItemsV1(folder, "impl-high-review", "impl-low-review", answer(false)), false);
    assert.equal(asked.length, 2);
    assert.match(asked[0]!, /^Move on, leaving \d+ plan items? open$/);
  });

  void it("asks nothing for other moves or when nothing is open", async () => {
    const never = (): Promise<string | undefined> => {
      throw new Error("must not ask");
    };
    const done = task("done", ["- [x] Step 1: built"]);
    assert.equal(await confirmAdvanceOverOpenItemsV1(done, "impl-high-review", "impl-low-review", never), true);
    const open = task("open-other-move", ["- [ ] Step 1: not built"]);
    assert.equal(await confirmAdvanceOverOpenItemsV1(open, "impl-low-review", "publish", never), true);
  });

  void it("the card option is the labelled override while items are open, and plain otherwise", () => {
    const open = buildAdvanceOptionV1("impl-low-review", "/ws/t", "Moves on.", "impl-high-review", 3);
    assert.equal(open.label, advanceOverOpenItemsLabelV1(3));
    const clean = buildAdvanceOptionV1("impl-low-review", "/ws/t", "Moves on.", "impl-high-review", 0);
    assert.equal(clean.label, "Advance to Low-Level Code Review");
    const other = buildAdvanceOptionV1("publish", "/ws/t", "Moves on.", "impl-low-review", 3);
    assert.match(other.label, /^Advance to /);
  });
});

void describe("review1 Step 57: the environmental-failure card keeps the open-items override label", () => {
  const evidence = extractEnvironmentalFailureEvidenceV1({
    blockers: [{ resolver: "environmental", description: "The provider quota is exhausted until tomorrow" }],
  });
  const target = { canonicalId: "task-x", taskFolderPath: "/ws/.ensemble/task-x", taskName: "chat" };
  const acceptOption = (stage: "impl-high-review" | "impl-low-review", planItemsOpen?: number) => {
    const card = buildEnvironmentalFailureDecisionV1({ stage, reason: "r", target, evidence, planItemsOpen });
    return card.options.find((option) => option.optionId === "advance")!;
  };

  void it("High-Level Code Review with items open: the labelled override, with the acceptance named in the text", () => {
    const option = acceptOption("impl-high-review", 3);
    assert.equal(option.label, advanceOverOpenItemsLabelV1(3));
    assert.match(option.consequence, /Accepts the environmental failure/);
  });

  void it("nothing open, or a stage that is not guarded: the card's own label", () => {
    assert.equal(acceptOption("impl-high-review", 0).label, "Accept it as environmental and continue");
    assert.equal(acceptOption("impl-low-review", 3).label, "Accept it as environmental and continue");
  });
});
