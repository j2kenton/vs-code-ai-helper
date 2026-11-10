/**
 * review2 Step 30-31: `applyBatchPassToReviewV1` against a real task folder. Each pass keeps its own part file and
 * record, the stage's review file becomes the combined verdict, a change to a file drops only the pass that read it,
 * and a reviewer that did not inspect its batch gets a split instead of a `[review-confidence]` blocker.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  applyBatchPassToReviewV1,
  REVIEW_BATCH_PARTS_FOLDER_V1,
  REVIEW_BATCH_STORE_FILENAME_V1,
} from "../commands/reviewBatchCombineIoV1";
import { extractBlockerLinesV1 } from "../utils/reviewBatchStoreV1";
import { REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1, REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1 } from "../utils/reviewBatchPassV1";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-batch-combine-test-"));
after(() => {
  safeRemoveDir(ROOT);
});

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
const FOLDER = nodePath.join(ROOT, ".ensemble", "t1");
const REVIEW = nodePath.join(FOLDER, "impl-high-review.md");

const restoreFns: Array<() => void> = [];

function installRealFs(): void {
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { readFile: fs.readFile, writeFile: fs.writeFile, createDirectory: fs.createDirectory };
  fs.readFile = async (uri: vscode.Uri): Promise<Uint8Array> => new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  fs.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await nodeFs.promises.writeFile(uri.fsPath, Buffer.from(data));
  };
  fs.createDirectory = async (uri: vscode.Uri): Promise<void> => {
    await nodeFs.promises.mkdir(uri.fsPath, { recursive: true });
  };
  restoreFns.push(() => {
    fs.readFile = orig.readFile;
    fs.writeFile = orig.writeFile;
    fs.createDirectory = orig.createDirectory;
  });
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const origFolders = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(ROOT), name: "batch-root", index: 0 }];
  restoreFns.push(() => {
    ws.workspaceFolders = origFolders;
  });
}

function reviewText(score: number, blockers: string[], extra = ""): string {
  return [
    "# Implementation Review",
    "",
    `Readiness: ${score}/10`,
    "",
    "<!-- blockers:start -->",
    ...blockers,
    "<!-- blockers:end -->",
    extra,
    "",
    "<!-- progress: 1/2 -->",
    "",
  ].join("\n");
}

function pass(position: number, files: string[]): Record<string, string> {
  return {
    [REVIEW_SCOPE_BATCH_FILES_VARIABLE_V1]: files.join("\n"),
    [REVIEW_SCOPE_BATCH_POSITION_VARIABLE_V1]: `${position}/2`,
  };
}

async function run(position: number, files: string[], content: string, missingFiles: string[] = []) {
  nodeFs.writeFileSync(REVIEW, content, "utf8");
  return applyBatchPassToReviewV1({
    folderUri: vscode.Uri.file(FOLDER),
    variables: pass(position, files),
    reviewUri: vscode.Uri.file(REVIEW),
    content,
    stage: "impl-high-review",
    runId: `run-${position}`,
    missingFiles,
  });
}

beforeEach(() => {
  installRealFs();
  nodeFs.rmSync(FOLDER, { recursive: true, force: true });
  nodeFs.mkdirSync(FOLDER, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(ROOT, "src"), { recursive: true });
  for (const file of FILES) nodeFs.writeFileSync(nodePath.join(ROOT, file), `// ${file}\n`, "utf8");
  nodeFs.writeFileSync(
    nodePath.join(FOLDER, "task-progress.json"),
    JSON.stringify({
      taskFolder: "t1",
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-11-10T05:00:00.000Z",
      updatedAt: "2026-11-10T05:00:00.000Z",
      implReviewFiles: FILES,
    }),
    "utf8"
  );
});

afterEach(() => {
  while (restoreFns.length > 0) restoreFns.pop()?.();
});

void describe("applyBatchPassToReviewV1", () => {
  void it("a review over the whole list (no batch variables) is left alone", async () => {
    const content = reviewText(8, []);
    nodeFs.writeFileSync(REVIEW, content, "utf8");
    const outcome = await applyBatchPassToReviewV1({
      folderUri: vscode.Uri.file(FOLDER),
      variables: {},
      reviewUri: vscode.Uri.file(REVIEW),
      content,
      stage: "impl-high-review",
      runId: "r",
      missingFiles: [],
    });
    assert.equal(outcome, undefined);
    assert.equal(nodeFs.readFileSync(REVIEW, "utf8"), content);
  });

  void it("each pass keeps its own part file and record; the review file becomes the combined verdict", async () => {
    const first = await run(1, ["src/a.ts", "src/b.ts"], reviewText(9, ["- [completion] [task-fixable] [new] Fix the parser"]));
    assert.ok(first);
    assert.equal(first.complete, false);
    assert.deepEqual(first.unreadFiles, ["src/c.ts", "src/d.ts"]);
    assert.equal(first.progressed, true);
    assert.equal(first.readFileCount, 2);
    assert.equal(first.totalFileCount, 4);

    const second = await run(2, ["src/c.ts", "src/d.ts"], reviewText(6, ["- [architectural] [task-fixable] [new] Split the card"]));
    assert.ok(second);
    assert.equal(second.complete, true);
    assert.deepEqual(second.unreadFiles, []);

    const combined = nodeFs.readFileSync(REVIEW, "utf8");
    assert.match(combined, /^Readiness: 6\/10$/m, "the lowest score");
    assert.equal(extractBlockerLinesV1(combined).length, 2, "the blockers of both passes");
    assert.match(combined, /Covered 4 of 4 files across 2 part\(s\)/);
    const parts = nodeFs.readdirSync(nodePath.join(FOLDER, REVIEW_BATCH_PARTS_FOLDER_V1)).sort();
    assert.deepEqual(parts, ["impl-high-review-part-1-of-2.md", "impl-high-review-part-2-of-2.md"]);
    const store = JSON.parse(nodeFs.readFileSync(nodePath.join(FOLDER, REVIEW_BATCH_STORE_FILENAME_V1), "utf8")) as Record<string, unknown[]>;
    assert.equal(store["impl-high-review"]?.length, 2);
  });

  void it("a file that changed after its pass drops only that pass from the combined verdict", async () => {
    await run(1, ["src/a.ts", "src/b.ts"], reviewText(9, []));
    await run(2, ["src/c.ts", "src/d.ts"], reviewText(9, []));
    nodeFs.writeFileSync(nodePath.join(ROOT, "src/c.ts"), "// changed\n", "utf8");
    const again = await run(1, ["src/a.ts", "src/b.ts"], reviewText(9, []));
    assert.ok(again);
    assert.equal(again.complete, false);
    assert.deepEqual(again.unreadFiles, ["src/c.ts", "src/d.ts"], "only the second batch needs reading again");
  });

  void it("files the reviewer lists as not fully inspected are not read, the batch is split, and no review-confidence blocker is kept", async () => {
    const content = reviewText(
      8,
      [
        "- [review-confidence] [task-fixable] [new] Complete the independent review of the remaining paths",
        "- [completion] [task-fixable] [new] Fix the parser",
      ],
      "\n## Files not fully inspected\n\n- `src/b.ts`\n"
    );
    const outcome = await run(1, ["src/a.ts", "src/b.ts"], content);
    assert.ok(outcome);
    assert.deepEqual([...outcome.notReadFiles], ["src/b.ts"]);
    assert.equal(outcome.progressed, true, "a split follows");
    assert.ok(outcome.unreadFiles.includes("src/b.ts"));
    const blockers = extractBlockerLinesV1(nodeFs.readFileSync(REVIEW, "utf8"));
    assert.equal(blockers.length, 1);
    assert.match(blockers[0] ?? "", /Fix the parser/);
  });

  void it("a prose-only 'did not inspect' statement declines the whole batch", async () => {
    const outcome = await run(
      1,
      ["src/a.ts", "src/b.ts"],
      reviewText(7, ["- [review-confidence] [task-fixable] [new] Finish the review"], "\nI did not independently inspect every file in this batch.\n")
    );
    assert.ok(outcome);
    assert.deepEqual([...outcome.notReadFiles], ["src/a.ts", "src/b.ts"]);
    assert.equal(outcome.readFileCount, 0);
    assert.equal(outcome.progressed, true);
    assert.equal(extractBlockerLinesV1(nodeFs.readFileSync(REVIEW, "utf8")).length, 0);
  });

  void it("a single-file batch that is declined cannot be split, so nothing follows it", async () => {
    const outcome = await run(2, ["src/d.ts"], reviewText(7, [], "\n## Files not fully inspected\n\n- `src/d.ts`\n"));
    assert.ok(outcome);
    assert.equal(outcome.progressed, false);
    assert.equal(outcome.complete, false);
  });
});
