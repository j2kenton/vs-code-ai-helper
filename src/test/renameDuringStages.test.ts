/**
 * Rename-while-running availability (Part 5 of the compact-controls /
 * progress-visibility plan): both rename operations are non-exclusive, so a
 * task can be renamed while an implementation, review, or publish operation
 * is running. The single stage rename must NOT run beside is Task
 * Description generation — that run never writes the name (naming is owned
 * by the rename actions, per handleDraftOutcomeV1), but it works from the
 * name captured at admission. refuseRenameWhileDescStageRuns provides the
 * explanatory warning, but the exclusion itself is enforced ATOMICALLY by
 * the registry: both sides register with TASK_NAME_WRITE_CONFLICT_KEY, so
 * begin() refuses whichever arrives second even when the guard was passed
 * earlier (e.g. while the rename dialog sat open). The persistence path
 * stays safe under concurrency because the displayName patch goes through
 * patchTaskProgressStrictV1, which merges onto freshly-read state.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { refuseRenameWhileDescStageRuns } from "../commands/renameTask";
import {
  encodeTaskProgressV1,
  patchTaskProgressStrictV1,
} from "../services/taskProgressWriterV1";
import {
  runTrackedOperation,
  taskOperations,
  TASK_NAME_WRITE_CONFLICT_KEY,
} from "../utils/taskOperations";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { readTaskProgressForTest } from "./taskFolderFixture";

/** The strict reader goes through vscode.workspace.fs — bridge it to the
 * real filesystem for this suite (same helper shape as
 * taskProgressWriterV1.test.ts). */
function installReadFileBridge(): { restore: () => void } {
  const workspaceFs = (vscode.workspace as unknown as { fs: Record<string, unknown> }).fs;
  const original = workspaceFs.readFile;
  workspaceFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
  return {
    restore: (): void => {
      workspaceFs.readFile = original;
    },
  };
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

void describe("rename availability during running stages", () => {
  void it("admits the non-exclusive rename operation while an implementation review is active", async () => {
    const taskPath = `/tmp/rename-beside-review-${Math.random()}`;
    const review = taskOperations.begin(taskPath, {
      label: "Review",
      stage: "impl-high-review",
      kind: "review",
    });
    assert.ok(review, "precondition: the exclusive review op must be admitted");

    try {
      assert.equal(refuseRenameWhileDescStageRuns(taskPath), false);
      let renamed = false;
      await runTrackedOperation(
        taskPath,
        { label: "Rename Task", taskName: "ff for 1 pt 2", kind: "rename-task", exclusive: false },
        () => {
          renamed = true;
          return Promise.resolve();
        }
      );
      assert.equal(renamed, true, "rename must run despite the exclusive review lock");
    } finally {
      taskOperations.end(review);
    }
  });

  void it("refuses with an explanatory warning while a Task Description operation is active", () => {
    const taskPath = `/tmp/rename-during-desc-${Math.random()}`;
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const desc = taskOperations.begin(taskPath, {
      label: "Draft Task with AI",
      stage: "desc",
      kind: "draft-task",
      conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY],
    });
    assert.ok(desc);

    try {
      assert.equal(refuseRenameWhileDescStageRuns(taskPath), true);
      const warning = surface.entries.find((e) => e.level === "warning");
      assert.ok(warning, "a warning must explain why rename has to wait");
      assert.match(warning.message, /Task Description/);
      assert.match(warning.message, /works from the task's current name/);
    } finally {
      taskOperations.end(desc);
      deactivateNotificationRouter();
    }
  });

  void it("source wiring: both rename commands are non-exclusive, guard on the desc stage, and declare the name-write conflict key", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "commands", "renameTask.ts"),
      "utf8"
    );
    const guards = source.split("refuseRenameWhileDescStageRuns(task.taskFolderPath)").length - 1;
    assert.equal(
      guards,
      4,
      "each rename command must guard at entry AND re-check after its user-interaction gap (dialog / consent)"
    );
    assert.match(source, /label: "Rename Task",[^}]*exclusive: false/);
    assert.match(source, /label: "Rename Task with AI",[^}]*exclusive: false/);
    // Atomic exclusion: both rename specs and the Task Description spec must
    // carry the shared conflict key, so begin() — not just the guard —
    // refuses the overlap.
    const renameKeys =
      source.split("conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY]").length - 1;
    assert.equal(renameKeys, 2, "both rename specs must declare the name-write conflict key");
    const draftSource = fs.readFileSync(
      path.join(process.cwd(), "src", "commands", "draftTaskWithAI.ts"),
      "utf8"
    );
    assert.match(
      draftSource,
      /label: "Draft Task with AI",[^}]*conflictKeys: \[TASK_NAME_WRITE_CONFLICT_KEY\]/,
      "the desc-stage Draft operation must declare the same conflict key"
    );
    // The coordinator row needs no lease either — see renameTaskRowV1.ts.
    const rowSource = fs.readFileSync(
      path.join(process.cwd(), "src", "actions", "rows", "renameTaskRowV1.ts"),
      "utf8"
    );
    assert.match(rowSource, /requiresTaskOperationLease: false/);
  });

  void it("a rename that passed the guard cannot begin once a Task Description run started (atomic admission)", () => {
    const taskPath = `/tmp/rename-race-desc-first-${Math.random()}`;
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    // The manual-rename race: the guard passes while the task is idle…
    assert.equal(refuseRenameWhileDescStageRuns(taskPath), false);
    // …then a description run begins while the rename dialog sits open.
    const desc = taskOperations.begin(taskPath, {
      label: "Draft Task with AI",
      stage: "desc",
      kind: "draft-task",
      conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY],
    });
    assert.ok(desc);

    try {
      // The rename's begin() must now refuse via the shared conflict key,
      // so its displayName patch can never run beside the description run.
      const rename = taskOperations.begin(taskPath, {
        label: "Rename Task",
        kind: "rename-task",
        exclusive: false,
        conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY],
      });
      assert.equal(rename, null, "the conflict key must refuse the late-arriving rename");
    } finally {
      taskOperations.end(desc);
      deactivateNotificationRouter();
    }
  });

  void it("a Task Description run cannot begin while a rename operation is active (atomic admission, reverse direction)", async () => {
    const taskPath = `/tmp/rename-race-rename-first-${Math.random()}`;
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    try {
      await runTrackedOperation(
        taskPath,
        {
          label: "Rename Task with AI",
          taskName: "ff for 1 pt 2",
          kind: "rename-task",
          exclusive: false,
          conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY],
        },
        async () => {
          // While the (non-exclusive) rename is registered, an exclusive
          // description run must be refused — the exclusive lock alone would
          // have admitted it, since no exclusive operation is active.
          const desc = await runTrackedOperation(
            taskPath,
            {
              label: "Draft Task with AI",
              stage: "desc",
              kind: "draft-task",
              cancellable: true,
              conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY],
            },
            () => Promise.resolve("ran")
          );
          assert.equal(desc, undefined, "the description run must be refused while a rename is active");
          const busy = surface.entries.find((e) =>
            e.message.includes("Rename Task with AI")
          );
          assert.ok(
            busy,
            `the busy warning must name the rename operation; got: ${JSON.stringify(surface.entries)}`
          );
        }
      );

      // Once the rename ends, the description run is admitted again.
      const after = await runTrackedOperation(
        taskPath,
        {
          label: "Draft Task with AI",
          stage: "desc",
          kind: "draft-task",
          cancellable: true,
          conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY],
        },
        () => Promise.resolve("ran")
      );
      assert.equal(after, "ran", "the conflict clears when the rename operation ends");
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("a concurrent displayName patch preserves unrelated progress fields", async () => {
    // Two levels below the mkdtemp container so the session/meta lock paths
    // withTaskLock derives stay private to this test.
    const taskFolderName = "2026-08-14_task_1";
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-rename-concurrent-"));
    const folder = path.join(container, "tasks", taskFolderName);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "task-progress.json"),
      encodeTaskProgressV1({
        ensembleProgressVersion: 1,
        taskFolder: taskFolderName,
        currentStage: "impl",
        status: "active",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      })
    );
    const bridge = installReadFileBridge();
    const folderUri = vscode.Uri.file(folder);

    try {
      // Simulate the running stage's own progress write landing before the
      // rename's: both patches merge onto freshly-read state, so neither
      // clobbers the other's field.
      const stagePatch = await patchTaskProgressStrictV1(folderUri, (current) => ({
        ...current,
        currentStage: "impl-high-review",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }));
      assert.ok(stagePatch, "the stage patch must decode and apply");
      const renamePatch = await patchTaskProgressStrictV1(folderUri, (current) => ({
        ...current,
        displayName: "ff for 1 pt 2",
        nameIsDefault: false,
      }));
      assert.ok(renamePatch, "the rename patch must decode and apply");

      const progress = await readTaskProgressForTest(folderUri);
      assert.ok(progress);
      assert.equal(progress.displayName, "ff for 1 pt 2");
      assert.equal(progress.nameIsDefault, false);
      assert.equal(
        progress.currentStage,
        "impl-high-review",
        "the stage write must survive the rename patch"
      );
      assert.equal(progress.updatedAt, "2026-08-14T00:00:00.000Z");
    } finally {
      bridge.restore();
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
});
