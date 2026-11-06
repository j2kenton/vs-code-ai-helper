/**
 * review1 Step 59 / Step 60: the context pack's own non-code sections compact before the task description is cut, and
 * both before any code; files left out of the budget are still reported, and a file missing on disk stays listed.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { generateImplReviewContextPack } from "../utils/contextPack";
import {
  codeBudgetHasHalfTheLimitV1,
  nextPreviousReviewLimitV1,
  planImplReviewCodeBudgetV1,
  shrinkImplReviewCodeBudgetV1,
} from "../utils/implReviewBudgetV1";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-impl-review-compact-test-"));
after(() => {
  safeRemoveDir(ROOT);
});

function withRealFs<T>(run: () => Promise<T>): Promise<T> {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsObj.readFile;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    nodeFs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return run().finally(() => {
    fsObj.readFile = original;
  });
}

function setup(name: string): { task: vscode.Uri; ws: vscode.Uri; files: string[] } {
  const ws = nodePath.join(ROOT, name);
  const taskDir = nodePath.join(ws, ".ensemble", "task");
  nodeFs.mkdirSync(taskDir, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(ws, "src"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(taskDir, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  const files = ["src/alpha.ts", "src/beta.ts", "src/gone.ts"];
  nodeFs.writeFileSync(nodePath.join(ws, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
  nodeFs.writeFileSync(nodePath.join(ws, "src", "beta.ts"), "export const beta = 2;\n", "utf8");
  // A realistic task touches many files; the name list is what compacting removes.
  for (let i = 0; i < 40; i++) {
    const name = `src/generated-module-with-a-long-descriptive-name-${i}.ts`;
    nodeFs.writeFileSync(nodePath.join(ws, name), `export const value${i} = ${i};\n`, "utf8");
    files.push(name);
  }
  return { task: vscode.Uri.file(taskDir), ws: vscode.Uri.file(ws), files };
}

void describe("review1 Step 59: compacting the context pack's non-code sections", () => {
  void it("by default lists every tracked file by name before the contents", async () => {
    const { task, ws, files } = setup("full");
    const { content } = await withRealFs(() =>
      generateImplReviewContextPack(task, ws, files, undefined, undefined, undefined, undefined, false)
    );
    assert.match(content, /^- src\/alpha\.ts$/m);
    assert.match(content, /^- src\/beta\.ts$/m);
    assert.match(content, /^- src\/gone\.ts ⚠ \(missing on disk\)$/m);
  });

  void it("compact mode drops the repeated name list but keeps the contents, the omissions and the missing file", async () => {
    const { task, ws, files } = setup("compact");
    const full = await withRealFs(() =>
      generateImplReviewContextPack(task, ws, files, undefined, undefined, undefined, undefined, false)
    );
    const compact = await withRealFs(() =>
      generateImplReviewContextPack(task, ws, files, undefined, undefined, undefined, undefined, true)
    );
    assert.doesNotMatch(compact.content, /^- src\/alpha\.ts$/m, "the name list is the duplicated part");
    assert.match(compact.content, /43 tracked file\(s\) \(named with their contents below/);
    assert.match(compact.content, /^- src\/gone\.ts ⚠ \(missing on disk\)$/m, "a file with no contents heading stays listed");
    assert.match(compact.content, /export const alpha = 1;/, "the code itself is untouched");
    assert.match(compact.content, /export const beta = 2;/);
    assert.ok(compact.content.length < full.content.length, "the pack got smaller");
    assert.equal(compact.embeddedContentBytes, full.embeddedContentBytes, "no code was cut by compacting");
  });

  void it("the measured path compacts the pack first, then the task description, then code (and code keeps its half)", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    const compactStep = source.indexOf("nonCodeCompact = true;");
    const taskDescriptionStep = source.indexOf("taskDescriptionMaxChars = smallerTask;");
    const previousReviewStep = source.indexOf('truncateTextToBudgetV1(fullPreviousReview, next, "the previous review")');
    const codeBudgetStep = source.indexOf("// 3. Build with the derived budget");
    assert.ok(compactStep > 0 && taskDescriptionStep > compactStep, "compacting comes before the task description is cut");
    assert.ok(previousReviewStep > taskDescriptionStep, "the previous review is cut only after the task description");
    assert.ok(codeBudgetStep > previousReviewStep, "code is built last, with what is left");
    assert.match(source.slice(source.lastIndexOf("writeImplReviewContextPack(", codeBudgetStep)), /nonCodeCompact/);
    // The half-of-the-limit guarantee drives every cut, not only the over-the-limit case.
    assert.match(
      source,
      /while \(\(measured > MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 \|\| codeLacksHalfV1\(\)\) && advanceNonCodeShrinkV1\(\)\)/
    );
  });

  void it("the previous review shrinks in steps after the task description, and runs out", () => {
    assert.equal(nextPreviousReviewLimitV1(undefined), 40000);
    assert.equal(nextPreviousReviewLimitV1(40000), 20000);
    assert.equal(nextPreviousReviewLimitV1(20000), 10000);
    assert.equal(nextPreviousReviewLimitV1(10000), undefined);
  });

  void it("a non-code input that leaves code under half of the limit is cut until code has its half", () => {
    const limit = 262_144;
    // Plan + prompt + task description + previous review: 150 KB leaves 104 KB < 131 KB for code.
    const before = planImplReviewCodeBudgetV1({ limitBytes: limit, nonCodeBytes: 150_000 });
    assert.equal(before.codeHasHalfTheLimit, false);
    // The previous review is cut from 100 KB to 40 KB (one step): 90 KB non-code now leaves code its half.
    const after = planImplReviewCodeBudgetV1({ limitBytes: limit, nonCodeBytes: 90_000 });
    assert.equal(after.codeHasHalfTheLimit, true);
    assert.ok(after.codeBudgetBytes >= limit / 2);
  });

  void it("when the plan and prompt alone take over half, the review is refused, never built below the guarantee", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    assert.match(source, /"impl-review-code-budget"/);
    assert.match(source, /Review not started: the non-code input/);
    assert.match(source, /codeShareRefusedNonCodeBytes = measured - lastEmbeddedContentBytes;/);
    // The refusal shares the pre-dispatch abort path, so nothing is sent to a model.
    assert.match(source, /if \(oversizedAfterShrink \|\| codeShareRefusedNonCodeBytes !== undefined\) \{/);
    // No rebuild at the floor after the scaled retry: that is what let a review run with less than half for code.
    const codeBudgetStep = source.indexOf("// 3. Build with the derived budget");
    const abortStep = source.indexOf("if (oversizedAfterShrink || codeShareRefusedNonCodeBytes !== undefined)");
    assert.doesNotMatch(source.slice(codeBudgetStep, abortStep), /buildAndMeasure\(shrinkFloorChars/);
  });

  void it("the scaled retry keeps the half-of-the-limit guarantee: a retry budget under half is refused, not built", () => {
    const limit = 262_144;
    // The review's illustration: a 103,040-character budget scaled for a 280,000-byte first build.
    const first = planImplReviewCodeBudgetV1({ limitBytes: limit, nonCodeBytes: limit - 8 * 1024 - Math.ceil(103_040 * 1.3) });
    assert.equal(first.codeHasHalfTheLimit, true);
    const scaled = shrinkImplReviewCodeBudgetV1(first.codeBudgetChars, 280_000, limit);
    assert.ok(scaled < first.codeBudgetChars);
    assert.equal(codeBudgetHasHalfTheLimitV1(scaled, limit), false, "83k characters cost under 131,072 bytes");
    assert.equal(codeBudgetHasHalfTheLimitV1(Math.ceil(limit / 2 / 1.3), limit), true, "exactly the half still passes");
    // The refusal is wired between the scaling and the second build.
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    const scaleAt = source.indexOf("const scaled = shrinkImplReviewCodeBudgetV1(");
    const refuseAt = source.indexOf("if (!codeBudgetHasHalfTheLimitV1(scaled, MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1))", scaleAt);
    const rebuildAt = source.indexOf("measured = await buildAndMeasure(scaled, taskDescriptionMaxChars);", scaleAt);
    assert.ok(scaleAt > 0 && refuseAt > scaleAt && rebuildAt > refuseAt, "check comes before the rebuild");
  });
});
