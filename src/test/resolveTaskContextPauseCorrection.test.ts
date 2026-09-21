import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { TaskProgress } from "../types/taskProgress";
import { TaskWithProgress } from "../state/taskInventory";
import { correctResolvedForRevokedWatchdogPauseV1 } from "../utils/resolveTaskContext";
import { advancePauseFenceGenerationV1, readOrInitPauseFenceGenerationV1 } from "../state/workAdmissionV1";
import { safeRemoveDir } from "./testFsUtils";

/**
 * Part 1b step 13 ("audit every pause-sensitive read ... command
 * self-checks ... to use it"): `resolveTaskContext.ts` is the shared
 * command-resolution gate almost every command routes through, and many of
 * those callers thread `resolved.progress.status` straight into downstream
 * decisions (`TaskActionRequestV1.taskStatus`, the `allowPaused` gate, the
 * `currentTaskStore` paused-fallback heuristic). `correctResolvedForRevokedWatchdogPauseV1`
 * is the single correction point all of that inherits from — these tests
 * exercise it directly, without needing a full `TaskInventory`/
 * `CurrentTaskStore` fixture, since it is a pure function of one resolved
 * task plus the durable fence on disk.
 */
void describe("correctResolvedForRevokedWatchdogPauseV1", () => {
  function freshTaskFolder(name: string): { folder: string; cleanup: () => void } {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-resolve-ctx-pause-"));
    const folder = path.join(container, name);
    fs.mkdirSync(folder, { recursive: true });
    return { folder, cleanup: () => safeRemoveDir(container) };
  }

  function makeProgress(overrides: Partial<TaskProgress>): TaskProgress {
    return {
      taskFolder: "2026-09-14_task_1",
      currentStage: "impl",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
      ...overrides,
    };
  }

  function makeTask(folder: string, progress: TaskProgress): TaskWithProgress {
    return {
      taskFolderPath: folder,
      folderName: path.basename(folder),
      canonicalId: folder,
      sourceScopeKey: "test-scope",
      workspaceFolder: vscode.Uri.file(folder),
      progress,
    };
  }

  void it("returns the task unchanged when not paused at all", async () => {
    const { folder, cleanup } = freshTaskFolder("not-paused");
    try {
      const task = makeTask(folder, makeProgress({ status: "active" }));
      const corrected = await correctResolvedForRevokedWatchdogPauseV1(task);
      assert.equal(corrected, task, "must return the identical object — no correction needed, no new allocation");
    } finally {
      cleanup();
    }
  });

  void it("returns the task unchanged for a real user pause (no watchdogPauseClaimId)", async () => {
    const { folder, cleanup } = freshTaskFolder("user-pause");
    try {
      const task = makeTask(folder, makeProgress({ status: "paused", pausedReason: "manual" }));
      const corrected = await correctResolvedForRevokedWatchdogPauseV1(task);
      assert.equal(corrected, task, "a genuine user pause must never be second-guessed");
      assert.equal(corrected.progress.status, "paused");
    } finally {
      cleanup();
    }
  });

  void it("returns the task unchanged for a watchdog pause whose generation is still current", async () => {
    const { folder, cleanup } = freshTaskFolder("current-watchdog-pause");
    try {
      const generation = await readOrInitPauseFenceGenerationV1(folder);
      const task = makeTask(
        folder,
        makeProgress({
          status: "paused",
          pausedReason: "stalled-active-task",
          watchdogPauseClaimId: "claim-current",
          watchdogPauseFenceGeneration: generation,
        })
      );
      const corrected = await correctResolvedForRevokedWatchdogPauseV1(task);
      assert.equal(corrected.progress.status, "paused", "a current-generation watchdog pause remains real");
      assert.equal(corrected.progress.watchdogPauseClaimId, "claim-current");
    } finally {
      cleanup();
    }
  });

  void it("corrects a revoked watchdog pause to active in the returned copy, clearing pause fields, without writing to disk", async () => {
    const { folder, cleanup } = freshTaskFolder("revoked-watchdog-pause");
    try {
      const staleGeneration = await readOrInitPauseFenceGenerationV1(folder);
      await advancePauseFenceGenerationV1(folder);
      const original = makeProgress({
        status: "paused",
        pausedReason: "stalled-active-task",
        watchdogPauseClaimId: "claim-stale",
        watchdogPauseFenceGeneration: staleGeneration,
        currentStage: "impl-high-review",
      });
      const task = makeTask(folder, original);
      const corrected = await correctResolvedForRevokedWatchdogPauseV1(task);

      assert.equal(corrected.progress.status, "active", "a revoked watchdog pause must read as active to every caller");
      assert.equal(corrected.progress.pausedReason, undefined);
      assert.equal(corrected.progress.watchdogPauseClaimId, undefined);
      assert.equal(corrected.progress.watchdogPauseFenceGeneration, undefined);
      assert.equal(
        corrected.progress.currentStage,
        "impl-high-review",
        "only the pause fields are touched — every other field survives"
      );
      assert.equal(
        corrected.taskFolderPath,
        task.taskFolderPath,
        "identity/path fields are preserved by the shallow copy"
      );

      // Read-only: this correction must never itself write the durable
      // repair — that remains the revocation's own best-effort cleanup hook
      // (or a later admission attempt helping finish it), never a passive
      // reader like this one.
      assert.equal(fs.existsSync(path.join(folder, "task-progress.json")), false);
    } finally {
      cleanup();
    }
  });

  void it("treats a watchdog pause with no recorded generation (pre-1b build) as current, not revoked", async () => {
    const { folder, cleanup } = freshTaskFolder("pre-1b-watchdog-pause");
    try {
      await advancePauseFenceGenerationV1(folder);
      const task = makeTask(
        folder,
        makeProgress({
          status: "paused",
          pausedReason: "stalled-active-task",
          watchdogPauseClaimId: "claim-pre-1b",
          watchdogPauseFenceGeneration: undefined,
        })
      );
      const corrected = await correctResolvedForRevokedWatchdogPauseV1(task);
      assert.equal(corrected.progress.status, "paused");
      assert.equal(corrected.progress.watchdogPauseClaimId, "claim-pre-1b");
    } finally {
      cleanup();
    }
  });
});
