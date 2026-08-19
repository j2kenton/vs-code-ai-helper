/**
 * Unit tests for `goToReviewAndApplyV1` — the helper that moves a task to a
 * review stage before dispatching Apply Review.
 *
 * The behaviour under test is specifically the FAILURE path. `setTaskStage`
 * reports every failure by notification and then returns normally; it does not
 * throw. A helper that assumed otherwise dispatched the apply command anyway
 * whenever the stage change failed, producing exactly the out-of-stage warning
 * it exists to prevent (observed 2026-08-19: "Could not set stage … The
 * running operation did not stop in time", immediately followed by "Task is
 * not at a Low-Level Review stage", with no work done).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as vscode from "vscode";
import { goToReviewAndApplyV1 } from "../commands/goToReviewAndApplyV1";

/** Commands dispatched during one test, in order. */
let dispatched: { command: string; arg: unknown }[] = [];
let originalExecuteCommand: typeof vscode.commands.executeCommand;
let tempRoot: string;

/**
 * A task folder whose persisted stage is whatever the test says it is, and —
 * crucially — whose stage does NOT change when `setTaskStage` is dispatched
 * unless `stageAfterSet` says so. That models the real silent-failure case.
 */
function writeTask(folderName: string, stage: string): string {
  const folder = path.join(tempRoot, folderName);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "task-progress.json"),
    JSON.stringify(
      {
        taskFolder: folderName,
        currentStage: stage,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2
    ),
    "utf8"
  );
  return folder;
}

/**
 * `readTaskProgressStrictV1` reads through `vscode.workspace.fs`, which the
 * unit harness stubs out entirely. Without this, every read throws and the
 * function returns false for the WRONG reason — the failure-path tests would
 * pass while proving nothing, and the success path could never pass at all.
 */
let restoreFs: () => void;

function installFsStub(): () => void {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalRead = fsRecord.readFile;
  fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath) as Promise<Uint8Array>;
  return (): void => {
    fsRecord.readFile = originalRead;
  };
}

beforeEach(() => {
  dispatched = [];
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goto-review-apply-"));
  restoreFs = installFsStub();
  originalExecuteCommand = vscode.commands.executeCommand;
  (vscode.commands as { executeCommand: unknown }).executeCommand = (
    command: string,
    arg: unknown
  ): Promise<unknown> => {
    dispatched.push({ command, arg });
    // Resolved promise rather than `async`: the stub awaits nothing, and
    // `require-await` rejects an async function with no await expression.
    return Promise.resolve(undefined);
  };
});

afterEach(() => {
  (vscode.commands as { executeCommand: unknown }).executeCommand = originalExecuteCommand;
  restoreFs();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

void describe("goToReviewAndApplyV1 — stage change fails silently", () => {
  void it("does NOT dispatch the apply when the persisted stage did not move", async () => {
    // `setTaskStage` is stubbed to do nothing (as it does when it fails and
    // returns), so the folder stays at `impl`.
    const folder = writeTask("2026-08-18_task_1", "impl");

    const ok = await goToReviewAndApplyV1({
      taskFolderPath: folder,
      reviewStage: "impl-low-review",
    });

    assert.strictEqual(ok, false, "must report that it did not run");
    assert.deepEqual(
      dispatched.map((d) => d.command),
      ["vs-code-ai-helper.setTaskStage"],
      "the apply command must never be dispatched out of stage"
    );
  });

  void it("does NOT dispatch the apply when the task folder cannot be read", async () => {
    const ok = await goToReviewAndApplyV1({
      taskFolderPath: path.join(tempRoot, "does-not-exist"),
      reviewStage: "impl-low-review",
    });

    assert.strictEqual(ok, false);
    assert.deepEqual(
      dispatched.map((d) => d.command),
      ["vs-code-ai-helper.setTaskStage"],
      "an unreadable task is 'stage unknown', which must fail closed"
    );
  });
});

void describe("goToReviewAndApplyV1 — stage change succeeds", () => {
  void it("dispatches the low-level apply once the stage is confirmed", async () => {
    // Already at the target stage: the verification read sees the stage it
    // asked for, which is the same observable state a successful change leaves.
    const folder = writeTask("2026-08-18_task_1", "impl-low-review");

    const ok = await goToReviewAndApplyV1({
      taskFolderPath: folder,
      reviewStage: "impl-low-review",
    });

    assert.strictEqual(ok, true);
    assert.deepEqual(dispatched.map((d) => d.command), [
      "vs-code-ai-helper.setTaskStage",
      "vs-code-ai-helper.applyLowLevelReviewChanges",
    ]);
    assert.deepEqual(dispatched[1]?.arg, { taskFolderPath: folder });
  });

  void it("dispatches the high-level apply for the high review stage", async () => {
    const folder = writeTask("2026-08-18_task_1", "impl-high-review");

    const ok = await goToReviewAndApplyV1({
      taskFolderPath: folder,
      reviewStage: "impl-high-review",
    });

    assert.strictEqual(ok, true);
    assert.deepEqual(dispatched.map((d) => d.command), [
      "vs-code-ai-helper.setTaskStage",
      "vs-code-ai-helper.applyHighLevelReviewChanges",
    ]);
  });
});
