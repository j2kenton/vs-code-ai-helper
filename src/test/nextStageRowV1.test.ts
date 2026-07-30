/**
 * Coverage for the `nextStage.v1` registry row (plan §6.6): the lifecycle
 * row that advances an active task to its immediate `STAGE_ORDER` successor
 * through the strict progress stack and the exhaustive field policy —
 * mirrors `taskProgressFieldPolicyV1.test.ts`'s pure-policy coverage at the
 * row's I/O boundary (missing progress, terminal stage, non-active status).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  createNextStageRowV1,
  executeNextStageV1,
  NEXT_STAGE_ACTION_KEY_V1,
  NextStageRowDepsV1,
  validateNextStageInputV1,
} from "../actions/rows/nextStageRowV1";
import { LifecycleExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function contextFor(folder: string, expectedSourceStage: string): LifecycleExecutionContextV1 {
  return {
    actionKey: NEXT_STAGE_ACTION_KEY_V1,
    operationId: allocateHex128IdV1(),
    taskBindingId: "test-task-binding",
    chatDocumentId: "test-chat-doc",
    validatedInput: { taskFolderPath: folder, expectedSourceStage },
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

void describe("nextStage.v1 registry row", () => {
  let bridge: { restore: () => void };
  before(() => { bridge = installReadFileBridge(); });
  after(() => { bridge.restore(); });

  void it("validateNextStageInputV1 accepts only the exact declared shape", () => {
    assert.deepEqual(validateNextStageInputV1({ taskFolderPath: "/x", expectedSourceStage: "plan" }), {
      ok: true,
      input: { taskFolderPath: "/x", expectedSourceStage: "plan" },
    });
    assert.equal(validateNextStageInputV1({}).ok, false);
    assert.equal(validateNextStageInputV1(null).ok, false);
    assert.equal(validateNextStageInputV1({ taskFolderPath: "" }).ok, false);
    assert.equal(validateNextStageInputV1({ taskFolderPath: "/x" }).ok, false);
    assert.equal(
      validateNextStageInputV1({ taskFolderPath: "/x", expectedSourceStage: "not-a-stage" }).ok,
      false
    );
    assert.equal(
      validateNextStageInputV1({ taskFolderPath: "/x", expectedSourceStage: "plan", extra: 1 }).ok,
      false
    );
  });

  void it("declares the expected route/eligibility/lease contract", () => {
    const row = createNextStageRowV1();
    assert.equal(row.kind, "lifecycle");
    assert.equal(row.actionKey, NEXT_STAGE_ACTION_KEY_V1);
    assert.deepEqual(row.routes, ["vs-code-ai-helper.nextStage"]);
    assert.deepEqual(row.eligibility, { statuses: ["active"], stages: "anyStage" });
    assert.equal(row.requiresTaskOperationLease, true);
  });

  void it("advances an active task to the immediate next canonical stage and marks the departing stage complete", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan" });

    const outcome = await executeNextStageV1(contextFor(fixture.folder, "plan"));
    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") {
      assert.equal(outcome.code, "completed");
      assert.equal(outcome.correlation.taskBindingId, "test-task-binding");
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "plan-high-review");
      assert.ok(strict.decoded.progress.completedStages?.includes("plan"));
      assert.equal(strict.decoded.progress.status, "active");
    }
  });

  void it("fails with noNextStage at the terminal (publish) stage", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-terminal-");
    setProgress(fixture.folder, { status: "active", currentStage: "publish" });

    const outcome = await executeNextStageV1(contextFor(fixture.folder, "publish"));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.noNextStage");
      assert.equal(outcome.retryable, false);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "publish");
    }
  });

  void it("fails with statusNotActive for a paused task and never mutates it", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-paused-");
    setProgress(fixture.folder, { status: "paused", currentStage: "plan" });

    const outcome = await executeNextStageV1(contextFor(fixture.folder, "plan"));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.statusNotActive");
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.status, "paused");
      assert.equal(strict.decoded.progress.currentStage, "plan");
    }
  });

  void it("reports recoveryRequired when task-progress.json is missing", async () => {
    const emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-nextstage-row-missing-"));
    const outcome = await executeNextStageV1(contextFor(emptyFolder, "plan"));
    assert.deepEqual(outcome, { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" });
  });

  void it("rejects with staleSourceStage and never mutates when the task moved off the expected source stage", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-stale-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan-high-review" });

    // Caller observed "plan" (e.g. before a concurrent auto-advance moved
    // the task to "plan-high-review"); the row must reject rather than
    // silently advancing from whatever it finds.
    const outcome = await executeNextStageV1(contextFor(fixture.folder, "plan"));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.staleSourceStage");
      assert.equal(outcome.retryable, false);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "plan-high-review");
    }
  });

  void it("surfaces a sanitized writeFailed code when the strict writer throws, without touching progress", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-writefail-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan" });

    const throwingDeps: NextStageRowDepsV1 = {
      patchTaskProgress: () => {
        const error = new Error(
          `EACCES: permission denied, open '${path.join(fixture.folder, "task-progress.json_temp_abc.tmp")}'`
        );
        (error as unknown as { cause: { code: string } }).cause = { code: "EACCES" };
        throw error;
      },
    };

    const outcome = await executeNextStageV1(contextFor(fixture.folder, "plan"), throwingDeps);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.writeFailed.EACCES");
      assert.equal(outcome.retryable, true);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "plan");
    }
  });
});
