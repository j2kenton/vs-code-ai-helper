/**
 * wf10 item 19 / Step 28 (review blocker a96160ec-…-2, third narrowing): the
 * two pre-existing consumers of `blockerSupersessions` — `readStageArtifactsForChat`
 * (chatWithStage.ts) and `computePlanReviewBlockerSupersessionEvidenceV1`
 * (reconcilePlanChecklist.ts) — are both informational, so a manual
 * "Complete Stage & Move On" could silently advance past a blocker the
 * artifacts still list as outstanding. `nextStage` (reviewActions.ts) now
 * warns and offers a "Complete Anyway" override (`vs-code-ai-helper.completeStageAnywayV1`)
 * instead of silently advancing, whenever the current plan-review stage's
 * own review artifact still lists a blocker no confirmed `plan.md` edit has
 * superseded — see `getOutstandingPlanReviewBlockersForAdvanceV1`'s doc
 * comment in reviewActions.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { nextStage } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { OWNED_FIXTURE_BOUND_AT } from "./taskFolderFixture";
import { IncompleteTask } from "../types/incompleteTask";
import { TaskProgress } from "../types/taskProgress";

/* eslint-disable @typescript-eslint/no-var-requires */
const taskOperationsModule = require("../utils/taskOperations") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

interface RecordedEntry {
  message: string;
  level: "info" | "warning" | "error";
  actionCommand?: { command: string; title: string; args?: unknown[] };
}

class RecordingSurface {
  entries: RecordedEntry[] = [];
  addEntry(
    message: string,
    level: "info" | "warning" | "error",
    _filePath?: string,
    _resultTargetUri?: string,
    _sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void {
    this.entries.push({ message, level, actionCommand });
  }
}

/** `resolveTask`'s direct `node.task.folderUri` path reads task progress and
 * review artifacts through `vscode.workspace.fs.readFile`, which the test
 * stub leaves `notImplemented` by default — bridge it (and `readDirectory`,
 * for anything that lists the task folder) to the real filesystem, the same
 * technique `nextStageCurrentTaskDefault.test.ts` uses for its discovery
 * path. */
function installFsBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fsObj.readFile;
  const origReadDirectory = fsObj.readDirectory;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  fsObj.readDirectory = (uri: vscode.Uri): Promise<[string, number][]> => {
    if (!fs.existsSync(uri.fsPath)) {
      return Promise.reject(new Error("ENOENT"));
    }
    return Promise.resolve(
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((entry) => [
        entry.name,
        entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ])
    );
  };
  return {
    restore: (): void => {
      fsObj.readFile = origReadFile;
      fsObj.readDirectory = origReadDirectory;
    },
  };
}

function makeContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  return { workspaceState: memento } as unknown as vscode.ExtensionContext;
}

function writeTaskProgress(folder: string, extra: Partial<TaskProgress> = {}): TaskProgress {
  const progress: TaskProgress = {
    taskFolder: path.basename(folder),
    currentStage: "plan-high-review",
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    ownership: {
      metaRoot: path.dirname(folder),
      projectRoot: path.dirname(folder),
      boundAt: OWNED_FIXTURE_BOUND_AT,
      state: "resolved",
    } as TaskProgress["ownership"],
    ...extra,
  };
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2));
  return progress;
}

function makeNode(folder: string): { task: IncompleteTask } {
  return {
    task: {
      folderUri: vscode.Uri.file(folder),
      folderName: path.basename(folder),
      progress: {
        taskFolder: path.basename(folder),
        currentStage: "plan-high-review",
        status: "active",
        createdAt: "",
        updatedAt: "",
      } as TaskProgress,
    },
  };
}

const REVIEW_WITH_BLOCKER =
  "Readiness: 6/10\n\n" +
  "<!-- blockers:start -->\n" +
  "- [architectural] [environmental] the owner must approve the tie policy\n" +
  "<!-- blockers:end -->\n";

void describe("nextStage — blocker-gate warning on manual advance (wf10 item 19 / Step 28)", () => {
  void it("warns and offers Complete Anyway instead of silently advancing when the plan-review stage's blocker is not superseded", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-blocker-gate-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    writeTaskProgress(taskFolder);
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    let cancelCalled = false;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> => {
      cancelCalled = true;
      return Promise.resolve({ ok: true });
    };

    try {
      await nextStage(vscode.Uri.file(container), makeContext(), makeNode(taskFolder));

      assert.ok(cancelCalled, "the gate check runs after the existing cancel-running-operations step");
      const gateWarning = surface.entries.find((entry) =>
        entry.actionCommand?.command === "vs-code-ai-helper.completeStageAnywayV1"
      );
      assert.ok(gateWarning, "a warning naming the Complete Anyway override must be posted");
      assert.match(gateWarning.message, /the owner must approve the tie policy/);
      assert.equal(gateWarning.level, "warning");
      assert.deepEqual(gateWarning.actionCommand?.args, [{ taskFolderPath: taskFolder }]);
      assert.ok(
        !surface.entries.some((entry) => /advanced to:/.test(entry.message)),
        "the stage must NOT have actually advanced — the gate returns before the transition runs"
      );
    } finally {
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      fs.rmSync(container, { recursive: true, force: true });
    }
  });

  void it("does not warn when the sole blocker is recorded as superseded by a confirmed plan.md edit", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-blocker-gate-superseded-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);
    // Written well after the review artifact's own mtime, matching stage and
    // (trimmed) description exactly — filterSupersededBlockersV1's match rule.
    writeTaskProgress(taskFolder, {
      blockerSupersessions: [
        {
          stage: "plan-high-review",
          blockerDescription: "the owner must approve the tie policy",
          supersededAt: new Date(Date.now() + 60_000).toISOString(),
          planRelPath: "plan.md",
        },
      ],
    });

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> =>
      Promise.resolve({ ok: true });

    try {
      await nextStage(vscode.Uri.file(container), makeContext(), makeNode(taskFolder));

      assert.ok(
        !surface.entries.some((entry) => entry.actionCommand?.command === "vs-code-ai-helper.completeStageAnywayV1"),
        "a fully-superseded blocker must not trigger the gate warning"
      );
    } finally {
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
});
