/**
 * Owner, 2026-11-06: a review row's line shows its score only. "N of M plan items left" read as a third progress
 * figure next to the score and the Implementation percentage, so it stays in the tooltip's "Next:" line (and on the
 * cards) but not on the line itself.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { StageNode } from "../views/taskTreeProvider";
import { IncompleteTask } from "../types/incompleteTask";

function task(id: string): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(`/dev/${id}`),
    folderName: id,
    progress: {
      taskFolder: id,
      createdAt: new Date().toISOString(),
      currentStage: "impl-high-review",
      updatedAt: new Date().toISOString(),
      status: "active",
    },
    canonicalId: `/dev/${id}`,
  };
}

function tooltipText(node: StageNode): string {
  const tip = node.tooltip;
  return typeof tip === "string" ? tip : tip instanceof vscode.MarkdownString ? tip.value : String(tip ?? "");
}

void describe("review row: score only on the line", () => {
  void it("keeps the plan-items figure off the current review row's line but in its tooltip", () => {
    const node = new StageNode(
      task("row_score_only"),
      "impl-high-review",
      "current",
      vscode.Uri.file("/dev/row_score_only/impl-high-review.md"),
      { label: "5/10", planItemsLeft: { left: 41, total: 61 } }
    );
    const line = `${String(node.label)} ${String(node.description ?? "")}`;
    assert.match(line, /5\/10/, "the score is shown");
    assert.doesNotMatch(line, /plan items left/, "no plan-items figure on the line");
    assert.match(tooltipText(node), /Next: Continue the work \(41 of 61 plan items left\)/, "the tooltip keeps it");
  });
});
