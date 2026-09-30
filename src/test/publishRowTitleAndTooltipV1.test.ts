/**
 * RC3 item 7: the Publish row's single inline button ("Check and Review
 * (Publish)") had an unclear, bracketed title, and nothing told the owner
 * what the combined button does or where the separate checks/review/fix
 * actions went. This checks the retitled command and the row tooltip's new
 * explanation, including the plain-language reason shown whenever the
 * "Fix Linting & Code Errors" wand is hidden.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { StageNode } from "../views/taskTreeProvider";
import type { TaskStage } from "../types/taskProgress";

interface ManifestV1 {
  contributes: {
    commands: { command: string; title: string }[];
  };
}

function makeTask(lintPayload?: { passed: boolean }) {
  return {
    folderUri: vscode.Uri.file("/workspace/tasks/my-task"),
    folderName: "my-task",
    progress: {
      currentStage: "publish" as TaskStage,
      status: "active" as const,
      taskFolder: "my-task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(lintPayload ? { lintPayload: { passed: lintPayload.passed, timestamp: new Date().toISOString() } } : {}),
    },
  };
}

void describe("Publish row title and tooltip (RC3 item 7)", () => {
  void it("retitles checkAndReviewPublish with no bracketed stage name", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
    ) as ManifestV1;
    const entry = manifest.contributes.commands.find((c) => c.command === "vs-code-ai-helper.checkAndReviewPublish");
    assert.ok(entry, "checkAndReviewPublish command must be declared");
    assert.strictEqual(entry.title, "Run Publish Checks, Then Review");
    assert.ok(!entry.title.includes("("), `title must not carry a bracketed stage name: ${entry.title}`);
  });

  void it("explains the combined checks-and-review action and the right-click menu on the Publish row", () => {
    const task = makeTask({ passed: false });
    const node = new StageNode(task as never, "publish", "current", undefined);
    const tooltip = (node.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /Runs Publish Checks, then the Publish review/);
    assert.match(tooltip, /Fix Linting & Code Errors/);
    assert.match(tooltip, /right-click menu/);
  });

  void it("says checks have not run yet when the wand is hidden because no checks exist", () => {
    const task = makeTask(undefined);
    const node = new StageNode(task as never, "publish", "current", undefined);
    const tooltip = (node.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /Run Publish Checks first\./);
    assert.doesNotMatch(tooltip, /No fixes needed/);
  });

  void it("says no fixes are needed when the wand is hidden because checks passed", () => {
    const task = makeTask({ passed: true });
    const node = new StageNode(task as never, "publish", "current", undefined);
    const tooltip = (node.tooltip as vscode.MarkdownString).value;
    assert.match(tooltip, /No fixes needed: Publish Checks passed\./);
    assert.doesNotMatch(tooltip, /Run Publish Checks first\./);
  });

  void it("adds no Publish-only tooltip text for a non-publish stage", () => {
    const task = makeTask({ passed: false });
    const node = new StageNode(task as never, "impl", "current", undefined);
    const tooltip = (node.tooltip as vscode.MarkdownString).value;
    assert.doesNotMatch(tooltip, /Runs Publish Checks, then the Publish review/);
  });
});
