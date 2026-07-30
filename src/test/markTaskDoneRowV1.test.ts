/**
 * Coverage for the `markTaskDone.v1` registry row (plan §6.6): the lifecycle
 * row that terminally completes an active, Publish-stage task through the
 * strict progress stack and the exhaustive field policy.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  createMarkTaskDoneRowV1,
  executeMarkTaskDoneV1,
  MARK_TASK_DONE_ACTION_KEY_V1,
  MarkTaskDoneRowDepsV1,
  validateMarkTaskDoneInputV1,
} from "../actions/rows/markTaskDoneRowV1";
import { LifecycleExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function contextFor(folder: string): LifecycleExecutionContextV1 {
  return {
    actionKey: MARK_TASK_DONE_ACTION_KEY_V1,
    operationId: allocateHex128IdV1(),
    taskBindingId: "test-task-binding",
    chatDocumentId: "test-chat-doc",
    validatedInput: { taskFolderPath: folder },
  };
}

function setProgress(folder: string, patch: Record<string, unknown>): void {
  const progressPath = path.join(folder, "task-progress.json");
  const raw = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  Object.assign(raw, patch);
  fs.writeFileSync(progressPath, JSON.stringify(raw, null, 2));
}

/** The test vscode stub does not implement workspace.fs.readFile; bridge it to real fs. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

void describe("markTaskDone.v1 registry row", () => {
  let bridge: { restore: () => void };
  before(() => { bridge = installReadFileBridge(); });
  after(() => { bridge.restore(); });

  void it("validateMarkTaskDoneInputV1 accepts only the exact declared shape", () => {
    assert.deepEqual(validateMarkTaskDoneInputV1({ taskFolderPath: "/x" }), {
      ok: true,
      input: { taskFolderPath: "/x" },
    });
    assert.equal(validateMarkTaskDoneInputV1({}).ok, false);
    assert.equal(validateMarkTaskDoneInputV1(null).ok, false);
    assert.equal(validateMarkTaskDoneInputV1({ taskFolderPath: "/x", extra: 1 }).ok, false);
  });

  void it("declares the expected route/eligibility/lease contract", () => {
    const row = createMarkTaskDoneRowV1();
    assert.equal(row.kind, "lifecycle");
    assert.equal(row.actionKey, MARK_TASK_DONE_ACTION_KEY_V1);
    assert.deepEqual(row.routes, ["vs-code-ai-helper.markTaskDone"]);
    assert.deepEqual(row.eligibility, { statuses: ["active"], stages: ["publish"] });
    assert.equal(row.requiresTaskOperationLease, true);
  });

  void it("completes an active Publish-stage task, stamping completedAt and recording the completed stage", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-marktaskdone-row-");
    setProgress(fixture.folder, { status: "active", currentStage: "publish" });

    const outcome = await executeMarkTaskDoneV1(contextFor(fixture.folder));
    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      assert.equal(outcome.code, "completed");
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.status, "completed");
      assert.equal(strict.decoded.progress.currentStage, "publish");
      assert.ok(strict.decoded.progress.completedAt);
      assert.ok(strict.decoded.progress.completedStages?.includes("publish"));
      assert.equal(strict.decoded.progress.scheduledRun, undefined);
      assert.equal(strict.decoded.progress.scheduledResumeTime, undefined);
    }
  });

  void it("fails with statusNotActive for an already-completed task and never re-stamps it", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-marktaskdone-row-completed-");
    setProgress(fixture.folder, {
      status: "completed",
      currentStage: "publish",
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    const outcome = await executeMarkTaskDoneV1(contextFor(fixture.folder));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "markTaskDone.statusNotActive");
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.completedAt, "2026-01-01T00:00:00.000Z");
    }
  });

  void it("reports recoveryRequired when task-progress.json is missing", async () => {
    const emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-marktaskdone-row-missing-"));
    const outcome = await executeMarkTaskDoneV1(contextFor(emptyFolder));
    assert.deepEqual(outcome, { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" });
  });

  void it("rejects with staleSourceStage and never mutates when the task moved off Publish", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-marktaskdone-row-stale-");
    setProgress(fixture.folder, { status: "active", currentStage: "impl-low-review" });

    const outcome = await executeMarkTaskDoneV1(contextFor(fixture.folder));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "markTaskDone.staleSourceStage");
      assert.equal(outcome.retryable, false);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.status, "active");
      assert.equal(strict.decoded.progress.currentStage, "impl-low-review");
    }
  });

  void it("surfaces a sanitized writeFailed code when the strict writer throws, without touching progress", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-marktaskdone-row-writefail-");
    setProgress(fixture.folder, { status: "active", currentStage: "publish" });

    const throwingDeps: MarkTaskDoneRowDepsV1 = {
      patchTaskProgress: () => {
        const error = new Error(
          `EACCES: permission denied, open '${path.join(fixture.folder, "task-progress.json_temp_abc.tmp")}'`
        );
        (error as unknown as { cause: { code: string } }).cause = { code: "EACCES" };
        throw error;
      },
    };

    const outcome = await executeMarkTaskDoneV1(contextFor(fixture.folder), throwingDeps);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "markTaskDone.writeFailed.EACCES");
      assert.equal(outcome.retryable, true);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.status, "active");
      assert.equal(strict.decoded.progress.currentStage, "publish");
    }
  });
});
