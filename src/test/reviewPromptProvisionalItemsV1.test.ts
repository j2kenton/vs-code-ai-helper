/**
 * bugs4 Step 17 (item 21): every code-review prompt tells the reviewer WHICH ticked items are
 * still provisional and asks it to name the ones it confirmed under `## Verified Complete`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";
import { formatProvisionalTickedItemsForReviewerV1 } from "../utils/implementationChecklist";
import { renderPromptTemplate } from "../utils/promptTemplates";

const CODE_REVIEW_TEMPLATES = [
  "review-impl-high.md",
  "review-impl-high-rereview.md",
  "review-impl-low.md",
  "review-impl-low-rereview.md",
] as const;

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "- [x] Add the git index lock capture (gitIndexLockV1).",
  "- [x] Rename the helper.",
  "- [ ] Build the rest.",
].join("\n");

void describe("review prompts list the provisional ticked items (bugs4 item 21)", () => {
  const workspace = vscode.workspace as unknown as {
    fs: { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
  };
  let originalReadFile: (uri: vscode.Uri) => Promise<Uint8Array>;
  before(() => {
    originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
  });
  after(() => {
    workspace.fs.readFile = originalReadFile;
  });
  const extensionUri = vscode.Uri.file(path.resolve(__dirname, "../.."));

  for (const template of CODE_REVIEW_TEMPLATES) {
    void it(`${template} carries the provisional list and asks the reviewer to name confirmed items`, async () => {
      const listed = formatProvisionalTickedItemsForReviewerV1(PLAN, []);
      const rendered = await renderPromptTemplate(extensionUri, template, { provisionalTickedItems: listed });
      assert.ok(rendered.includes("Add the git index lock capture (gitIndexLockV1)."), "the ticked item is listed by its text");
      assert.ok(rendered.includes("Rename the helper."));
      assert.ok(!rendered.includes("Build the rest."), "an unticked item is not offered as a ticked one");
      assert.ok(!rendered.includes("{{provisionalTickedItems}}"), "the placeholder is filled");
      assert.match(rendered, /Name each of those you personally checked against the workspace in the same block/);
      assert.match(rendered, /A ticked item you checked and found NOT built is a completion blocker/);
    });
  }
});
