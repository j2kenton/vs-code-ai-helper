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

function contextForWith(
  folder: string,
  input: Record<string, unknown>,
  beforeWrite?: LifecycleExecutionContextV1["beforeWrite"]
): LifecycleExecutionContextV1 {
  return {
    actionKey: NEXT_STAGE_ACTION_KEY_V1,
    operationId: allocateHex128IdV1(),
    taskBindingId: "test-task-binding",
    chatDocumentId: "test-chat-doc",
    validatedInput: { taskFolderPath: folder, ...input },
    ...(beforeWrite !== undefined ? { beforeWrite } : {}),
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
  const origStat = target.stat;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.stat = (uri: vscode.Uri): Promise<vscode.FileStat> =>
    fs.promises.stat(uri.fsPath).then((stat) => ({
      type: vscode.FileType.File,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    }));
  return { restore: (): void => { target.readFile = orig; target.stat = origStat; } };
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

  void it("validateNextStageInputV1 accepts targetStage and expectedReviewAttemptId, rejecting invalid values", () => {
    assert.deepEqual(
      validateNextStageInputV1({
        taskFolderPath: "/x",
        expectedSourceStage: "plan",
        targetStage: "impl",
        expectedReviewAttemptId: "attempt-1",
      }),
      {
        ok: true,
        input: {
          taskFolderPath: "/x",
          expectedSourceStage: "plan",
          targetStage: "impl",
          expectedReviewAttemptId: "attempt-1",
        },
      }
    );
    assert.equal(
      validateNextStageInputV1({
        taskFolderPath: "/x",
        expectedSourceStage: "plan",
        targetStage: "not-a-stage",
      }).ok,
      false
    );
    assert.equal(
      validateNextStageInputV1({
        taskFolderPath: "/x",
        expectedSourceStage: "plan",
        expectedReviewAttemptId: "",
      }).ok,
      false
    );
    assert.equal(
      validateNextStageInputV1({
        taskFolderPath: "/x",
        expectedSourceStage: "plan",
        expectedReviewAttemptId: 7,
      }).ok,
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
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Plan");

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

  void it("refuses a stage completion with its artifact absent unless the human explicitly overrides it", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-missing-artifact-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan" });

    const rejected = await executeNextStageV1(contextFor(fixture.folder, "plan"));
    assert.equal(rejected.kind, "failed");
    if (rejected.kind === "failed") {
      assert.equal(rejected.code, "nextStage.missingStageArtifact");
    }

    const overridden = await executeNextStageV1(contextForWith(fixture.folder, {
      expectedSourceStage: "plan",
      artifactOverride: "user",
    }));
    assert.equal(overridden.kind, "completed");
    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.deepEqual(strict.decoded.progress.completedWithMissingArtifacts, [
        { stage: "plan", artifact: "plan.md", at: strict.decoded.progress.updatedAt, override: "user" },
      ]);
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
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Plan");

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

  void it("lands directly on an explicit targetStage, skipping the configured review stage's completion tick", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-skip-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan" });
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Plan");

    const outcome = await executeNextStageV1(
      contextForWith(fixture.folder, { expectedSourceStage: "plan", targetStage: "impl" })
    );
    assert.equal(outcome.kind, "completed");

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "impl");
      assert.ok(strict.decoded.progress.completedStages?.includes("plan"));
      // The skipped review stages were never landed on, so they are never
      // ticked complete by this transition.
      assert.equal(strict.decoded.progress.completedStages?.includes("plan-high-review"), false);
      assert.equal(strict.decoded.progress.completedStages?.includes("plan-low-review"), false);
    }
  });

  void it("rejects a backward/equal targetStage with invalidTargetStage and never mutates", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-badtarget-");
    setProgress(fixture.folder, { status: "active", currentStage: "impl" });

    const outcome = await executeNextStageV1(
      contextForWith(fixture.folder, { expectedSourceStage: "impl", targetStage: "plan" })
    );
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.invalidTargetStage");
      assert.equal(outcome.retryable, false);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "impl");
    }
  });

  void it("advances when expectedReviewAttemptId matches the freshly re-read progress", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-attempt-match-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan", reviewAttemptId: "attempt-1" });
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Plan");

    const outcome = await executeNextStageV1(
      contextForWith(fixture.folder, { expectedSourceStage: "plan", expectedReviewAttemptId: "attempt-1" })
    );
    assert.equal(outcome.kind, "completed");

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "plan-high-review");
      assert.equal(strict.decoded.progress.reviewAttemptId, undefined);
    }
  });

  void it("rejects with staleReviewAttempt and never mutates when a newer review attempt owns the transition", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-attempt-stale-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan", reviewAttemptId: "attempt-2" });

    // Caller claimed "attempt-1" before its provider call started, but a
    // newer review attempt ("attempt-2") already claimed and possibly
    // advanced this stage — the stale attempt's follow-up transition must
    // be rejected instead of silently advancing on the newer attempt's behalf.
    const outcome = await executeNextStageV1(
      contextForWith(fixture.folder, { expectedSourceStage: "plan", expectedReviewAttemptId: "attempt-1" })
    );
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.staleReviewAttempt");
      assert.equal(outcome.retryable, false);
    }

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "plan");
      assert.equal(strict.decoded.progress.reviewAttemptId, "attempt-2");
    }
  });

  void it("runs beforeWrite atomically with a winning CAS, before the write", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-beforewrite-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan" });
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Plan");

    const calls: string[] = [];
    const outcome = await executeNextStageV1(
      contextForWith(
        fixture.folder,
        { expectedSourceStage: "plan" },
        async () => {
          calls.push("beforeWrite");
          // The freshly re-read (pre-transition) progress must still be on
          // disk when beforeWrite runs — it fires BEFORE the transition write.
          const strictDuringWrite = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
          assert.equal(strictDuringWrite.ok, true);
          if (strictDuringWrite.ok) {
            assert.equal(strictDuringWrite.decoded.progress.currentStage, "plan");
          }
        }
      )
    );
    assert.equal(outcome.kind, "completed");
    assert.deepEqual(calls, ["beforeWrite"]);
  });

  void it("creates publish-review.md when landing on Publish (plan item 17, step 20a) — the primary review-driven/manual transition writer, not just the legacy advanceStage path", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-publish-artifact-");
    setProgress(fixture.folder, { status: "active", currentStage: "impl-low-review" });
    fs.writeFileSync(path.join(fixture.folder, "impl-low-review.md"), "Readiness: 10/10");
    const artifactPath = path.join(fixture.folder, "publish-review.md");
    assert.equal(fs.existsSync(artifactPath), false);

    const outcome = await executeNextStageV1(contextFor(fixture.folder, "impl-low-review"));
    assert.equal(outcome.kind, "completed");

    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "publish");
    }
    assert.equal(fs.existsSync(artifactPath), true, "publish-review.md must exist the moment this row lands the task on Publish");
  });

  void it("refuses to advance and preserves implRecovery when a continuation is owed (A1, 1.0.0 gate) — exercises the real production auto-advance path", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-owed-continuation-");
    setProgress(fixture.folder, {
      status: "active",
      currentStage: "impl",
      implRecovery: {
        sourceAttemptId: "impl-recovery-e2e-1",
        reason: "summary was stamped unusable",
        trigger: "summaryRejected",
        mode: "unconstrained",
        dispatch: "pending",
        at: "2026-07-09T00:00:00.000Z",
      },
      pendingImplReviewFiles: ["src/a.ts"],
    });

    const outcome = await executeNextStageV1(contextFor(fixture.folder, "impl"));
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.implRecoveryOwed");
      assert.equal(outcome.retryable, false);
    }

    // The bug this fixes: the stage previously moved anyway and
    // `implRecovery`/`pendingImplReviewFiles` were silently discarded,
    // leaving the task "active" with nothing running. Confirm neither the
    // stage moved nor the owed continuation vanished.
    const strict = await readTaskProgressStrictV1(vscode.Uri.file(fixture.folder));
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.equal(strict.decoded.progress.currentStage, "impl");
      assert.ok(strict.decoded.progress.implRecovery !== undefined, "implRecovery must survive the refused transition");
      assert.deepEqual(strict.decoded.progress.pendingImplReviewFiles, ["src/a.ts"]);
    }
  });

  void it("never runs beforeWrite when the CAS is rejected", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-nextstage-row-beforewrite-rejected-");
    setProgress(fixture.folder, { status: "active", currentStage: "plan-high-review" });

    let called = false;
    const outcome = await executeNextStageV1(
      contextForWith(
        fixture.folder,
        { expectedSourceStage: "plan" },
        () => { called = true; return Promise.resolve(); }
      )
    );
    assert.equal(outcome.kind, "failed");
    if (outcome.kind === "failed") {
      assert.equal(outcome.code, "nextStage.staleSourceStage");
    }
    assert.equal(called, false);
  });
});
