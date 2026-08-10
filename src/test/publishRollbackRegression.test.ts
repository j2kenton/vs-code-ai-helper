/**
 * Task A regression coverage: moving a task back out of Publish must land
 * visibly.
 *
 * Repro findings (2026-08-10), recorded here because they gate which fix was
 * chosen:
 *  - ACTIVE rollback (setTaskStage → advanceStage → updateTaskProgressStage)
 *    already retracts `completedStages` on disk — the "written JSON" tests
 *    below pin that.
 *  - COMPLETED rollback (setTaskStageOnCompletedTask → reopenCompletedTask →
 *    resumeTask.v1 row → applyReopenPolicyV1) also retracts on disk.
 *  - The bug that survives is READ-side: files written before retraction
 *    existed (and kept whole by the decoder's canonicalize-to-a-prefix
 *    backfill) still list the destination stage — and every later stage — as
 *    completed. `getStageStatus` consulted `completedStages` FIRST, so the
 *    tree/tooltip rendered those stages as done and showed no current marker
 *    anywhere: the rollback notification fired but the UI still read
 *    Publish. The fix makes the current-stage comparison win.
 *
 * Also covers the two task-list ordering defects fixed alongside:
 *  - activation/selection must not bump `updatedAt` (which hoisted the
 *    current task to the top of the recency-ordered list), and
 *  - autoFirstActive expansion must target the first ACTIVE task in display
 *    order, not ordered[0].
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import { advanceStage } from "../utils/stageTransition";
import {
  executeResumeTaskV1,
  RESUME_TASK_ACTION_KEY_V1,
} from "../actions/rows/resumeTaskRowV1";
import { LifecycleExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  getStageStatus,
  TaskNode,
  TaskTreeProvider,
} from "../views/taskTreeProvider";
import { STAGE_ORDER, TaskStage, TaskProgress } from "../types/taskProgress";
import {
  clearEscalation,
  recordEscalation,
  updateTaskStatus,
} from "../utils/taskProgressTransforms";
import type { IncompleteTask } from "../types/incompleteTask";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const ALL_BEFORE_PUBLISH = STAGE_ORDER.filter((s) => s !== "publish");

function setProgress(folder: string, patch: Record<string, unknown>): void {
  const progressPath = path.join(folder, "task-progress.json");
  const raw = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  Object.assign(raw, patch);
  fs.writeFileSync(progressPath, JSON.stringify(raw, null, 2));
}

function readRawProgress(folder: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")
  ) as Record<string, unknown>;
}

/** The test vscode stub does not implement workspace.fs.readFile; bridge it to real fs. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

void describe("Publish rollback — written progress JSON (repro for the stage-display defect)", () => {
  let bridge: { restore: () => void };
  before(() => { bridge = installReadFileBridge(); });
  after(() => { bridge.restore(); });

  void it("ACTIVE task at Publish moved back to impl persists the retracted state", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-publish-rollback-active-");
    setProgress(fixture.folder, {
      currentStage: "publish",
      status: "active",
      completedStages: ALL_BEFORE_PUBLISH,
    });

    const result = await advanceStage(
      vscode.Uri.file(fixture.folder),
      "publish",
      "impl",
      false,
      "jump"
    );
    assert.ok(result?.persisted, "the backward transition must persist");

    const written = readRawProgress(fixture.folder);
    assert.equal(written.currentStage, "impl");
    assert.equal(written.status, "active");
    assert.deepEqual(
      written.completedStages,
      ["desc", "plan", "plan-high-review", "plan-low-review"],
      "the destination stage and everything after it must be retracted on disk"
    );
  });

  void it("COMPLETED task at Publish reopened at impl persists the retracted state", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-publish-rollback-done-");
    const completedAt = "2026-08-01T12:00:00.000Z";
    setProgress(fixture.folder, {
      currentStage: "publish",
      status: "completed",
      completedAt,
      completedStages: [...STAGE_ORDER],
    });

    const context: LifecycleExecutionContextV1 = {
      actionKey: RESUME_TASK_ACTION_KEY_V1,
      operationId: allocateHex128IdV1(),
      taskBindingId: "test-task-binding",
      chatDocumentId: "test-chat-doc",
      validatedInput: {
        taskFolderPath: fixture.folder,
        selectedStage: "impl",
        expectedCompletedAt: completedAt,
      },
    };
    const outcome = await executeResumeTaskV1(context);
    assert.equal(outcome.kind, "completed");

    const written = readRawProgress(fixture.folder);
    assert.equal(written.currentStage, "impl");
    assert.equal(written.status, "active");
    assert.equal(written.completedAt, undefined);
    assert.deepEqual(
      written.completedStages,
      ["desc", "plan", "plan-high-review", "plan-low-review"],
      "reopen must retain only stages strictly before the selected stage"
    );
  });
});

void describe("getStageStatus — current stage wins over stale completedStages", () => {
  void it("renders the destination stage as current even when completedStages still lists it", () => {
    // The wild stale shape: a rollback written by a version that predates
    // retraction (or hand-edited), then decoded — the decoder canonicalizes
    // completedStages to the full prefix through the highest recorded tick,
    // so every stage through publish is still claimed as done.
    const staleCompleted: readonly TaskStage[] = [...STAGE_ORDER];
    assert.equal(getStageStatus("impl", "impl", staleCompleted), "current");
  });

  void it("never renders stages at or after the current one as done, regardless of completedStages", () => {
    const staleCompleted: readonly TaskStage[] = [...STAGE_ORDER];
    const currentIndex = STAGE_ORDER.indexOf("impl");
    for (const stage of STAGE_ORDER) {
      const status = getStageStatus(stage, "impl", staleCompleted);
      const index = STAGE_ORDER.indexOf(stage);
      if (index < currentIndex) {
        assert.equal(status, "done", `${stage} is before the current stage`);
      } else if (index === currentIndex) {
        assert.equal(status, "current");
      } else {
        assert.equal(
          status,
          "outstanding",
          `${stage} is after the current stage and must not render done`
        );
      }
    }
  });

  void it("keeps the normal rendering for a clean (retracted) progress shape", () => {
    const clean: readonly TaskStage[] = ["desc", "plan"];
    assert.equal(getStageStatus("desc", "plan-high-review", clean), "done");
    assert.equal(getStageStatus("plan-high-review", "plan-high-review", clean), "current");
    assert.equal(getStageStatus("publish", "plan-high-review", clean), "outstanding");
  });
});

// ---------------------------------------------------------------------------
// Activation/selection must not bump updatedAt (recency-ordering hoist)
// ---------------------------------------------------------------------------

const FIXED_UPDATED_AT = "2026-08-01T00:00:00.000Z";

function makeProgress(): TaskProgress {
  return {
    taskFolder: "2026-08-01_task_1",
    currentStage: "impl",
    status: "paused",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: FIXED_UPDATED_AT,
  };
}

void describe("updateTaskStatus / clearEscalation — preserveFreshness", () => {
  void it("preserves updatedAt on a status flip when preserveFreshness is set", () => {
    const activated = updateTaskStatus(makeProgress(), "active", { preserveFreshness: true });
    assert.equal(activated.status, "active");
    assert.equal(activated.updatedAt, FIXED_UPDATED_AT);
  });

  void it("still bumps updatedAt on a status flip by default", () => {
    const paused = updateTaskStatus(makeProgress(), "paused");
    assert.notEqual(paused.updatedAt, FIXED_UPDATED_AT);
  });

  void it("preserves updatedAt when clearing an escalation with preserveFreshness", () => {
    const escalated = {
      ...recordEscalation(makeProgress(), {
        stage: "impl-high-review",
        kind: "plateau",
        reason: "stuck",
        at: "2026-08-02T00:00:00.000Z",
      }),
      updatedAt: FIXED_UPDATED_AT,
    };
    const cleared = clearEscalation(escalated, { preserveFreshness: true });
    assert.equal(cleared.escalation, undefined);
    assert.equal(cleared.updatedAt, FIXED_UPDATED_AT);
  });
});

// ---------------------------------------------------------------------------
// autoFirstActive expansion follows display order's first ACTIVE task
// ---------------------------------------------------------------------------

function makeInventoryTask(
  fsPath: string,
  folderName: string,
  status: "active" | "completed",
  updatedAt: string
): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(fsPath),
    folderName,
    progress: {
      currentStage: "impl" as TaskStage,
      status,
      taskFolder: folderName,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt,
    },
    canonicalId: fsPath,
  } as unknown as IncompleteTask;
}

function makeInventoryWithTasks(
  tasks: IncompleteTask[]
): import("../state/taskInventory").TaskInventory {
  return {
    getTasks: () =>
      tasks.map((t) => ({
        taskFolderPath: t.folderUri.fsPath,
        folderName: t.folderName,
        progress: t.progress,
        canonicalId: t.canonicalId,
      })),
    refresh: async () => {},
    onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
  } as unknown as import("../state/taskInventory").TaskInventory;
}

/** getChildren() fires setContext via executeCommand; the stub throws on unregistered commands. */
async function withStubbedCommands<T>(callback: () => Promise<T>): Promise<T> {
  const commandsStub = vscode.commands as typeof vscode.commands & {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const previous = commandsStub._executeCommandOverride;
  commandsStub._executeCommandOverride = () => Promise.resolve(undefined);
  try {
    return await callback();
  } finally {
    commandsStub._executeCommandOverride = previous;
  }
}

void describe("TaskTreeProvider — autoFirstActive expands the first active task in display order", () => {
  void it("expands the first ACTIVE task even when a completed task sorts above it", async () => {
    // The completed task is more recent, so it is ordered[0]; the active task
    // below it must still receive the auto-expansion.
    const completed = makeInventoryTask("/workspace/tasks/done-task", "done-task", "completed", "2026-08-09T00:00:00.000Z");
    const active = makeInventoryTask("/workspace/tasks/live-task", "live-task", "active", "2026-08-05T00:00:00.000Z");

    const provider = new TaskTreeProvider(makeInventoryWithTasks([completed, active]));
    const children = await withStubbedCommands(() => provider.getChildren());
    const taskNodes = children.filter((c): c is TaskNode => c instanceof TaskNode);
    assert.equal(taskNodes.length, 2);
    assert.equal(taskNodes[0]?.task.folderName, "done-task", "the completed task stays first by recency");

    const doneNode = taskNodes.find((n) => n.task.folderName === "done-task");
    const liveNode = taskNodes.find((n) => n.task.folderName === "live-task");
    assert.equal(
      liveNode?.collapsibleState,
      vscode.TreeItemCollapsibleState.Expanded,
      "the first active task in display order must auto-expand"
    );
    assert.equal(
      doneNode?.collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed,
      "a completed task must not swallow the auto-expansion just for being first"
    );
  });
});
