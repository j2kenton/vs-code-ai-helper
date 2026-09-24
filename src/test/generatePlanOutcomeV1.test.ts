/**
 * Regression coverage for `handleGeneratePlanOutcomeV1`'s stage-entry
 * refusal path (pre-1.0.0 fixes register, Part 1, review fix 2026-09-22,
 * new completion blocker 1): a completed `generatePlan.v1` outcome whose
 * task is no longer at Description or Plan used to report `succeeded: true`
 * with the stage silently unmoved — recording a refused stage entry as a
 * successful Generate Plan operation. It must now report `succeeded: false`
 * and record the actual stage-entry refusal reason in the run log, while
 * still preserving the generated plan.md.
 *
 * Reuses the real-fs bridge pattern from `enterStageV1.test.ts` so the real
 * `enterStageV1`/`patchTaskProgressStrictV1` stack runs for real, rather than
 * re-stubbing it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { handleGeneratePlanOutcomeV1 } from "../commands/generatePlanWithAI";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import type { TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-generate-plan-outcome-test-"));
after(() => {
  safeRemoveDir(REAL_ROOT);
});

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
        target[key] = orig[key];
      }
    },
  };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

let counter = 0;

function makeTaskFolder(overrides: Partial<TaskProgress> = {}): { folderPath: string; folderUri: vscode.Uri } {
  counter += 1;
  const name = `generate-plan-outcome-${counter}`;
  const folderPath = path.join(REAL_ROOT, "tasks", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
    ensembleProgressVersion: 1,
    taskFolder: name,
    currentStage: "plan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, "tasks"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
}

function readProgress(folderPath: string): TaskProgress {
  return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const COMPLETED_OUTCOME: TaskActionOutcomeV1 = {
  kind: "completed",
  code: "completed",
  correlation: {
    taskBindingId: "binding-under-test",
    chatDocumentId: "chat-doc-under-test",
    actionKey: "generatePlan.v1",
    operationId: "op-under-test",
    attemptId: "attempt-under-test",
  },
} as unknown as TaskActionOutcomeV1;

void describe("handleGeneratePlanOutcomeV1 stage-entry refusal (2026-09-22 review fix, completion blocker 1)", () => {
  void it("reports succeeded: false (not true) when the task is no longer at Description or Plan", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    try {
      // "impl" is outside ELIGIBLE_STAGES ["desc", "plan"].
      const { folderPath } = makeTaskFolder({ currentStage: "impl" });
      const before = readProgress(folderPath);

      const result = await handleGeneratePlanOutcomeV1(COMPLETED_OUTCOME, {
        taskRef: {
          taskFolderPath: folderPath,
          canonicalId: folderPath,
          taskName: "Test Task",
        },
        chatViewProvider: {} as never,
        orchestrator: {} as never,
        prompt: "irrelevant",
        providerLabel: "Stub Provider",
        modelLabel: undefined,
        effectiveReviewMode: "off",
      });

      assert.equal(
        result.succeeded,
        false,
        "a refused stage entry must never be reported as a successful Generate Plan operation"
      );
      assert.equal(result.triggerAutoReview, false);
      assert.equal(readProgress(folderPath).currentStage, "impl", "the stage must not have moved");
      assert.deepEqual(readProgress(folderPath), before, "no field may change on a refused entry");

      const warning = surface.entries.find((e) => e.level === "warning");
      assert.ok(warning, "expected a warning about the stage not moving");
      assert.match(warning.message, /stage was not moved/);

      assert.ok(result.runLogUri, "expected a run log to be written");
      const runLogContent = fs.readFileSync(result.runLogUri.fsPath, "utf8");
      assert.match(
        runLogContent,
        /stage entry was refused/,
        "the run log must record the actual stage-entry refusal reason, not just the provider's completed outcome"
      );
      assert.match(runLogContent, /no longer at Description or Plan/);
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("still reports success and moves the stage for an eligible source stage", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    try {
      const { folderPath } = makeTaskFolder({ currentStage: "plan" });

      const result = await handleGeneratePlanOutcomeV1(COMPLETED_OUTCOME, {
        taskRef: {
          taskFolderPath: folderPath,
          canonicalId: folderPath,
          taskName: "Test Task",
        },
        chatViewProvider: {} as never,
        orchestrator: {} as never,
        prompt: "irrelevant",
        providerLabel: "Stub Provider",
        modelLabel: undefined,
        effectiveReviewMode: "off",
      });

      assert.equal(result.succeeded, true);
      assert.equal(readProgress(folderPath).currentStage, "plan");
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });
});
