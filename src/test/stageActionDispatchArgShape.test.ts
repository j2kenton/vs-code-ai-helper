/**
 * Regression tests for the keyboard-shortcut router's dispatch arg shape.
 *
 * applyCurrentStageAction dispatches every stage's primary action with
 * `{ canonicalId, taskFolderPath, task: { progress } }` — a PARTIAL task
 * object carrying only `progress`, no `folderUri`. Each stage command's
 * normalizer/resolver must resolve that shape from the explicit
 * canonicalId/taskFolderPath fields instead of reading
 * `task.folderUri.fsPath` first, which used to throw
 * "Cannot read properties of undefined (reading 'fsPath')" on the Task
 * Description stage (and would silently open a folder picker on the plan
 * stage).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { normalizeDraftTaskArg } from "../commands/draftTaskWithAI";
import { normalizeGeneratePlanArg } from "../commands/generatePlanWithAI";
import { normalizeReviewArg } from "../commands/reviewActions";
import { normalizeRunPublishChecksArg } from "../commands/runPublishChecks";
import { TaskInventory } from "../state/taskInventory";
import type { TaskStage } from "../types/taskProgress";

const FOLDER = "/workspace/.ensemble/2026-08-11_task_1";
const CANONICAL_ID = FOLDER.toLowerCase();

/** The exact shape applyCurrentStageAction.ts dispatches for `stage`. */
function dispatchShape(stage: TaskStage): {
  canonicalId: string;
  taskFolderPath: string;
  task: { progress: { taskFolder: string; currentStage: TaskStage; status: "active"; createdAt: string; updatedAt: string } };
} {
  return {
    canonicalId: CANONICAL_ID,
    taskFolderPath: FOLDER,
    task: {
      progress: {
        taskFolder: "2026-08-11_task_1",
        currentStage: stage,
        status: "active",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
    },
  };
}

/** Inventory stub that must never be consulted for the dispatch shape. */
function unusedInventoryStub(): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  inv.getTaskById = (): undefined => {
    throw new Error("inventory must not be consulted when taskFolderPath is present");
  };
  return inv;
}

void describe("applyCurrentStageAction dispatch shape resolves at every stage", () => {
  void it("desc stage: normalizeDraftTaskArg resolves the explicit fields without throwing", () => {
    const result = normalizeDraftTaskArg(dispatchShape("desc"));
    assert.ok(result, "must resolve, not fall through");
    assert.equal(result.canonicalId, CANONICAL_ID);
    assert.equal(result.taskFolderPath, FOLDER);
  });

  void it("plan stage: normalizeGeneratePlanArg resolves a Uri, never the silent picker", () => {
    const result = normalizeGeneratePlanArg(
      dispatchShape("plan") as unknown as Parameters<typeof normalizeGeneratePlanArg>[0],
      unusedInventoryStub()
    );
    assert.ok(result instanceof vscode.Uri, "must resolve to the task folder Uri");
    assert.ok(result.fsPath.includes("2026-08-11_task_1"));
  });

  for (const stage of ["impl", "plan-high-review", "plan-low-review", "impl-high-review", "impl-low-review"] as const) {
    void it(`${stage} stage: normalizeReviewArg builds a synthetic task from taskFolderPath`, () => {
      const node = normalizeReviewArg(
        dispatchShape(stage) as unknown as Parameters<typeof normalizeReviewArg>[0]
      );
      assert.ok(node.task, "must produce a task node, not the no-task QuickPick fallback");
      assert.ok(node.task.folderUri, "the synthetic task must carry a real folderUri");
      assert.ok(node.task.folderUri.fsPath.includes("2026-08-11_task_1"));
    });
  }

  void it("publish stage: normalizeRunPublishChecksArg resolves the explicit fields without throwing", () => {
    const result = normalizeRunPublishChecksArg(dispatchShape("publish"));
    assert.ok(result, "must resolve, not fall through");
    assert.equal(result.canonicalId, CANONICAL_ID);
    assert.equal(result.taskFolderPath, FOLDER);
  });

  void it("a partial task with no folderUri and no explicit fields falls through instead of throwing", () => {
    const partialOnly = { task: { progress: dispatchShape("desc").task.progress } };
    assert.doesNotThrow(() => normalizeDraftTaskArg(partialOnly as unknown as Parameters<typeof normalizeDraftTaskArg>[0]));
    assert.equal(
      normalizeDraftTaskArg(partialOnly as unknown as Parameters<typeof normalizeDraftTaskArg>[0]),
      undefined
    );
    assert.doesNotThrow(() => normalizeRunPublishChecksArg(partialOnly as unknown as Parameters<typeof normalizeRunPublishChecksArg>[0]));
    const reviewNode = normalizeReviewArg(partialOnly as unknown as Parameters<typeof normalizeReviewArg>[0]);
    assert.equal(reviewNode.task, undefined, "a partial task must fall to the no-task shape");
  });
});
