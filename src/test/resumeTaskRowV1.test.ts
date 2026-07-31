/**
 * Coverage for the `resumeTask.v1` registry row (plan §9): completed-task
 * reopen through the strict progress stack and `applyReopenPolicyV1`'s
 * Reopen column. Mirrors `nextStageRowV1.test.ts` at the row's I/O boundary:
 * input validation, the completedAt staleness CAS, persisted-binding
 * validation, missing/undecodable progress, the write-failure seam, and the
 * skipLock composition regression (the row runs as `activateTask`'s target
 * write INSIDE the held meta-root lock — see taskActivationCoordinator.ts).
 * Field-matrix depth stays with `taskProgressFieldPolicyV1.test.ts`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  createResumeTaskRowV1,
  executeResumeTaskV1,
  RESUME_TASK_ACTION_KEY_V1,
  ResumeTaskRowDepsV1,
  validateResumeTaskInputV1,
} from "../actions/rows/resumeTaskRowV1";
import { LifecycleExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { withMetaRootLock } from "../state/taskStateStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const COMPLETED_AT = "2026-06-01T12:00:00.000Z";

function contextFor(
  folder: string,
  input: Record<string, unknown>,
  extras: Partial<Pick<LifecycleExecutionContextV1, "beforeWrite" | "skipTaskLock">> = {}
): LifecycleExecutionContextV1 {
  return {
    actionKey: RESUME_TASK_ACTION_KEY_V1,
    operationId: allocateHex128IdV1(),
    taskBindingId: "test-task-binding",
    chatDocumentId: "test-chat-doc",
    validatedInput: { taskFolderPath: folder, ...input },
    ...extras,
  };
}

function setProgress(folder: string, patch: Record<string, unknown>): void {
  const progressPath = path.join(folder, "task-progress.json");
  const raw = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  Object.assign(raw, patch);
  fs.writeFileSync(progressPath, JSON.stringify(raw, null, 2));
}

/** A completed, ownership-backed fixture the strict reopen accepts. */
function makeCompletedTaskFolder(prefix: string): string {
  const fixture = makeOwnedTaskFolder(prefix);
  setProgress(fixture.folder, {
    currentStage: "publish",
    status: "completed",
    completedAt: COMPLETED_AT,
    completedStages: ["publish"],
  });
  return fixture.folder;
}

/** The test vscode stub does not implement workspace.fs.readFile; bridge it to real fs. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

void describe("resumeTask.v1 registry row", () => {
  let bridge: { restore: () => void };
  before(() => { bridge = installReadFileBridge(); });
  after(() => { bridge.restore(); });

  void describe("validateResumeTaskInputV1", () => {
    void it("rejects a non-object, missing folder path, and invalid stage", () => {
      assert.equal(validateResumeTaskInputV1(undefined).ok, false);
      assert.equal(validateResumeTaskInputV1("x").ok, false);
      assert.equal(validateResumeTaskInputV1({ selectedStage: "publish" }).ok, false);
      assert.equal(
        validateResumeTaskInputV1({ taskFolderPath: "t", selectedStage: "not-a-stage" }).ok,
        false
      );
    });

    void it("rejects an empty expectedCompletedAt and unknown fields", () => {
      assert.equal(
        validateResumeTaskInputV1({ taskFolderPath: "t", selectedStage: "publish", expectedCompletedAt: "" }).ok,
        false
      );
      assert.equal(
        validateResumeTaskInputV1({ taskFolderPath: "t", selectedStage: "publish", extra: 1 }).ok,
        false
      );
    });

    void it("accepts a minimal input and one with the completedAt marker", () => {
      assert.equal(validateResumeTaskInputV1({ taskFolderPath: "t", selectedStage: "impl" }).ok, true);
      const result = validateResumeTaskInputV1({
        taskFolderPath: "t",
        selectedStage: "publish",
        expectedCompletedAt: COMPLETED_AT,
      });
      assert.equal(result.ok, true);
    });
  });

  void it("reopens a completed task at the selected stage through the Reopen policy column", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-");
    const outcome = await executeResumeTaskV1(
      contextFor(folder, { selectedStage: "publish", expectedCompletedAt: COMPLETED_AT })
    );
    assert.equal(outcome.kind, "completed");

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      const progress = strict.decoded.progress;
      assert.equal(progress.status, "active");
      assert.equal(progress.currentStage, "publish");
      assert.equal(progress.completedAt, undefined);
      assert.ok(!(progress.completedStages ?? []).includes("publish"));
      assert.ok(progress.ownership, "binding metadata must be preserved");
      assert.equal(strict.decoded.progress.ensembleProgressVersion, 1);
    }
  });

  void it("rejects with resumeTask.staleCompletedAt when the marker moved, and never mutates", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-stale-");
    const before = fs.readFileSync(path.join(folder, "task-progress.json"), "utf8");
    const outcome = await executeResumeTaskV1(
      contextFor(folder, { selectedStage: "publish", expectedCompletedAt: "2026-06-02T00:00:00.000Z" })
    );
    assert.deepEqual(outcome, { kind: "failed", code: "resumeTask.staleCompletedAt", retryable: false });
    assert.equal(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8"), before);
  });

  void it("rejects with resumeTask.staleCompletedAt when the task is no longer completed", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-notdone-");
    setProgress(folder, { status: "active", completedAt: undefined });
    const outcome = await executeResumeTaskV1(
      contextFor(folder, { selectedStage: "publish", expectedCompletedAt: COMPLETED_AT })
    );
    assert.deepEqual(outcome, { kind: "failed", code: "resumeTask.staleCompletedAt", retryable: false });
  });

  void it("reports recoveryRequired for an ownership-free completed task (underivable binding), and never mutates", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-unbound-");
    const progressPath = path.join(folder, "task-progress.json");
    const raw = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    delete raw.ownership;
    fs.writeFileSync(progressPath, JSON.stringify(raw, null, 2));
    const before = fs.readFileSync(progressPath, "utf8");

    const outcome = await executeResumeTaskV1(
      contextFor(folder, { selectedStage: "publish", expectedCompletedAt: COMPLETED_AT })
    );
    assert.deepEqual(outcome, { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" });
    assert.equal(fs.readFileSync(progressPath, "utf8"), before);
  });

  void it("reports recoveryRequired when task-progress.json is missing", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-missing-");
    fs.rmSync(path.join(folder, "task-progress.json"));
    const outcome = await executeResumeTaskV1(
      contextFor(folder, { selectedStage: "publish", expectedCompletedAt: COMPLETED_AT })
    );
    assert.deepEqual(outcome, { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" });
  });

  void it("maps an unexpected write failure to a sanitized retryable resumeTask.writeFailed code", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-writefail-");
    const deps: ResumeTaskRowDepsV1 = {
      patchTaskProgress: () =>
        Promise.reject(
          Object.assign(new Error("EACCES: permission denied, open 'C:\\secret\\path'"), {
            code: "EACCES",
          })
        ),
    };
    const outcome = await executeResumeTaskV1(
      contextFor(folder, { selectedStage: "publish", expectedCompletedAt: COMPLETED_AT }),
      deps
    );
    assert.deepEqual(outcome, {
      kind: "failed",
      code: "resumeTask.writeFailed.EACCES",
      retryable: true,
    });
  });

  void it("honors skipTaskLock under a held covering meta-root lock (activation-seam regression)", async () => {
    const folder = makeCompletedTaskFolder("ensemble-resume-row-skiplock-");
    const tasksRoot = path.dirname(folder);
    const outcome = await withMetaRootLock(tasksRoot, () =>
      executeResumeTaskV1(
        contextFor(
          folder,
          { selectedStage: "impl", expectedCompletedAt: COMPLETED_AT },
          { skipTaskLock: true }
        )
      )
    );
    assert.equal(outcome.kind, "completed");
    const strict = await readTaskProgressStrictV1(vscode.Uri.file(folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "impl");
      assert.equal(strict.decoded.progress.status, "active");
    }
  });

  void it("declares the §9 row shape: completed-only eligibility, the resumeTask route, and a task lease", () => {
    const row = createResumeTaskRowV1();
    assert.equal(row.kind, "lifecycle");
    assert.equal(row.actionKey, RESUME_TASK_ACTION_KEY_V1);
    assert.deepEqual(row.routes, ["vs-code-ai-helper.resumeTask"]);
    assert.deepEqual(row.eligibility, { statuses: ["completed"], stages: "anyStage" });
    assert.equal(row.requiresTaskOperationLease, true);
    assert.equal(row.loggingPolicy.channel, "action.resumeTask");
  });
});
