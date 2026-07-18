/**
 * The global assistant executes ONLY operations from the typed, allowlisted
 * registry in utils/globalAssistantActions.ts: unregistered proposals are
 * rejected without executing, payloads are schema-validated, consequential
 * operations are confirmation-gated with the affected-task list, and a
 * partial failure stops and reports rather than plowing on. These tests
 * assert that authorization boundary directly.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  executeProposedAction,
  getGlobalAssistantOperation,
  GLOBAL_ASSISTANT_OPERATIONS,
  parseProposedAction,
  stripActionEnvelopes,
  GlobalAssistantContext,
} from "../utils/globalAssistantActions";
import { buildGlobalAssistantPrompt } from "../commands/openGeneralAssistant";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import type { TaskProgress } from "../types/taskProgress";

function makeTask(folderName: string, status: TaskProgress["status"]): TaskWithProgress {
  return {
    canonicalId: `c:/tmp/${folderName}`,
    taskFolderPath: `c:/tmp/${folderName}`,
    folderName,
    sourceScopeKey: "scope",
    progress: {
      taskFolder: folderName,
      currentStage: "publish",
      status,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    } as TaskProgress,
  };
}

function makeContext(tasks: TaskWithProgress[]): GlobalAssistantContext {
  const inventory = Object.create(TaskInventory.prototype) as TaskInventory;
  inventory.getTasks = (): TaskWithProgress[] => tasks;
  inventory.refresh = async (): Promise<void> => { /* no-op */ };
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => undefined;
  store.clear = async (): Promise<void> => { /* no-op */ };
  return {
    inventory,
    currentTaskStore: store,
    assistantFolderUri: vscode.Uri.file("c:/tmp/global-assistant"),
  };
}

function withWarningStub<T>(
  result: string | undefined,
  body: (calls: string[]) => Promise<T>
): Promise<T> {
  const win = vscode.window as unknown as Record<string, unknown>;
  const original = win.showWarningMessage;
  const calls: string[] = [];
  win.showWarningMessage = (message: string): Promise<string | undefined> => {
    calls.push(message);
    return Promise.resolve(result);
  };
  return body(calls).finally(() => {
    win.showWarningMessage = original;
  });
}

void describe("global assistant action envelopes", () => {
  void it("parses an ACTION envelope with a JSON payload", () => {
    const proposal = parseProposedAction(
      'Sure. [[ACTION:repairStuckTask {"taskFolder": "2026-07-01_task_1"}]]'
    );
    assert.ok(proposal);
    assert.strictEqual(proposal.operationId, "repairStuckTask");
    assert.deepStrictEqual(proposal.payload, { taskFolder: "2026-07-01_task_1" });
  });

  void it("strips every envelope from the displayed text", () => {
    const stripped = stripActionEnvelopes(
      "Before [[ACTION:archiveCompletedTasks]] after"
    );
    assert.ok(!stripped.includes("[[ACTION:"));
    assert.ok(stripped.startsWith("Before"));
    assert.ok(stripped.endsWith("after"));
  });

  void it("names only registry operations in the assistant prompt", () => {
    const prompt = buildGlobalAssistantPrompt("(no tasks)", "", "hello");
    for (const op of GLOBAL_ASSISTANT_OPERATIONS) {
      assert.ok(prompt.includes(op.id), `prompt must document ${op.id}`);
    }
  });
});

void describe("global assistant authorization boundary", () => {
  void it("rejects an unregistered operation without executing or prompting", async () => {
    const ctx = makeContext([makeTask("t1", "completed")]);
    await withWarningStub("Run Action", async (calls) => {
      const outcome = await executeProposedAction(ctx, {
        operationId: "deleteEverything",
        payload: undefined,
      });
      assert.match(outcome, /not in the allowlisted registry/);
      assert.strictEqual(calls.length, 0, "no confirmation may be shown for a rejected op");
    });
  });

  void it("rejects an invalid payload via the operation's own schema validation", async () => {
    const ctx = makeContext([]);
    await withWarningStub("Run Action", async (calls) => {
      const outcome = await executeProposedAction(ctx, {
        operationId: "repairStuckTask",
        payload: { wrong: true },
      });
      assert.match(outcome, /rejected/);
      assert.strictEqual(calls.length, 0);
    });
  });

  void it("gates consequential operations on confirmation listing affected tasks", async () => {
    const ctx = makeContext([makeTask("done-1", "completed"), makeTask("active-1", "active")]);
    await withWarningStub(undefined, async (calls) => {
      const outcome = await executeProposedAction(ctx, {
        operationId: "archiveCompletedTasks",
        payload: undefined,
      });
      assert.strictEqual(calls.length, 1, "a confirmation must be shown");
      assert.ok(calls[0]!.includes("done-1"), "the confirmation lists affected tasks");
      assert.ok(!calls[0]!.includes("active-1"), "only completed tasks are affected");
      assert.match(outcome, /not confirmed; nothing was executed/);
    });
  });

  void it("stops on the first failure and reports which tasks were left untouched", async () => {
    // Under the unit-test stub, task progress files cannot be read, so the
    // first archive attempt fails — the operation must stop there and say so
    // instead of continuing to the second task.
    const ctx = makeContext([makeTask("done-1", "completed"), makeTask("done-2", "completed")]);
    await withWarningStub("Run Action", async () => {
      const outcome = await executeProposedAction(ctx, {
        operationId: "archiveCompletedTasks",
        payload: undefined,
      });
      assert.match(outcome, /Archived 0 of 2/);
      assert.match(outcome, /Stopped after a failure/);
      assert.match(outcome, /Remaining tasks were left untouched/);
    });
  });

  void it("exposes exactly the allowlisted operations through the registry lookup", () => {
    assert.ok(getGlobalAssistantOperation("archiveCompletedTasks"));
    assert.ok(getGlobalAssistantOperation("repairStuckTask"));
    assert.strictEqual(getGlobalAssistantOperation("anythingElse"), undefined);
  });
});

void describe("typed operation catalog — payload schemas and targeting", () => {
  void it("covers the full lifecycle catalog", () => {
    for (const id of [
      "createTask",
      "renameTask",
      "setTaskStage",
      "triggerStageAI",
      "completeTask",
      "completeStage",
      "runReview",
      "fastForwardReview",
      "pauseTask",
      "resumeTask",
      "archiveTask",
      "unarchiveTask",
      "pinTask",
      "unpinTask",
      "archiveCompletedTasks",
      "archiveTasks",
      "unarchiveAllTasks",
      "unarchiveTasks",
      "repairStuckTask",
    ]) {
      assert.ok(getGlobalAssistantOperation(id), `registry must expose ${id}`);
    }
  });

  void it("renameTask requires taskFolder and a non-blank newName", () => {
    const op = getGlobalAssistantOperation("renameTask")!;
    assert.ok(op.validatePayload(undefined));
    assert.ok(op.validatePayload({ taskFolder: "t1" }));
    assert.ok(op.validatePayload({ taskFolder: "t1", newName: "   " }));
    assert.strictEqual(op.validatePayload({ taskFolder: "t1", newName: "Better name" }), undefined);
  });

  void it("setTaskStage validates the stage id against the known stages", () => {
    const op = getGlobalAssistantOperation("setTaskStage")!;
    assert.ok(op.validatePayload({ taskFolder: "t1" }));
    assert.ok(op.validatePayload({ taskFolder: "t1", stage: "not-a-stage" }));
    assert.strictEqual(op.validatePayload({ taskFolder: "t1", stage: "publish" }), undefined);
    assert.strictEqual(op.requiresConfirmation, true, "stage moves are consequential");
  });

  void it("createTask accepts optional title/description and rejects unknown fields", () => {
    const op = getGlobalAssistantOperation("createTask")!;
    assert.strictEqual(op.validatePayload(undefined), undefined);
    assert.strictEqual(op.validatePayload({ title: "T", description: "D" }), undefined);
    assert.ok(op.validatePayload({ title: 5 }));
    assert.ok(op.validatePayload({ folder: "x" }));
  });

  void it("archiveTasks requires an explicit selector and never means 'every task'", () => {
    const op = getGlobalAssistantOperation("archiveTasks")!;
    assert.ok(op.validatePayload({}), "an empty payload must be rejected");
    assert.ok(op.validatePayload({ taskFolders: [] }));
    assert.ok(op.validatePayload({ status: "archived" }), "cannot archive archived tasks");
    assert.strictEqual(op.validatePayload({ taskFolders: ["t1"] }), undefined);
    assert.strictEqual(op.validatePayload({ status: "completed" }), undefined);
    assert.strictEqual(op.requiresConfirmation, true);
  });

  void it("archiveTasks resolves explicit and status-filter targets (union, deduped)", () => {
    const op = getGlobalAssistantOperation("archiveTasks")!;
    const ctx = makeContext([
      makeTask("done-1", "completed"),
      makeTask("done-2", "completed"),
      makeTask("active-1", "active"),
    ]);
    const explicit = op.affectedTasks(ctx, { taskFolders: ["active-1"] });
    assert.deepStrictEqual(explicit.map((t) => t.folderName), ["active-1"]);
    const union = op.affectedTasks(ctx, { taskFolders: ["done-1"], status: "completed" });
    assert.deepStrictEqual(
      union.map((t) => t.folderName).sort(),
      ["done-1", "done-2"],
      "explicit + filter targets union without duplicates"
    );
  });

  void it("unarchiveTasks requires an explicit taskFolders list and targets only archived tasks", () => {
    const op = getGlobalAssistantOperation("unarchiveTasks")!;
    assert.ok(op.validatePayload({ status: "archived" }), "a bare status filter is not enough");
    assert.strictEqual(op.validatePayload({ taskFolders: ["t1"] }), undefined);
    const ctx = makeContext([makeTask("parked", "archived"), makeTask("live", "active")]);
    const targets = op.affectedTasks(ctx, { taskFolders: ["parked", "live"] });
    assert.deepStrictEqual(targets.map((t) => t.folderName), ["parked"]);
  });
});
