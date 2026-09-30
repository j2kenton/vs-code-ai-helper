/**
 * RC3 item 11 (Step 9): "Fix Linting & Code Errors" must never leave its
 * tracked operation in the `succeeded` state (rendered as "Linting Fixes —
 * …: completed" by operationNotificationBridge.ts) when the AI fixes could
 * not run and the checks it was meant to satisfy are still failing. Before
 * this fix, runLintingFixes's tracked-operation body always returned
 * normally in that branch, so `runTrackedOperation` inferred `succeeded`
 * regardless of the "AI final fixes are unavailable: …" warning shown in
 * the same run — the exact defect observed on the `gpt6` task (wt-b),
 * 2026-09-29 17:46.
 *
 * Reuses the same real-completion-lint harness as
 * runLintingFixesGateMessages.test.ts's "step42" tests (a real failing
 * `test` script, `checkEditActionAvailabilityV1` stubbed to `ok: false` so
 * the run reaches the "AI final fixes are unavailable" branch without
 * needing a live provider) and additionally listens on
 * `taskOperations.onDidEnd` to assert the operation's own terminal state.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runLintingFixes } from "../commands/runLintingFixes";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { taskOperations, TaskOperationSnapshot } from "../utils/taskOperations";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-lint-fixes-outcome-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProgress(folderPath: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 },
  ];
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig; } };
}

function makeInventory(taskFolderPath: string, progress: TaskProgress): TaskInventory {
  const item = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId: taskFolderPath,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress,
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? item : undefined),
    getTaskByPath: (p: string) => (p === taskFolderPath ? item : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [item],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function fixtureProgress(taskFolderPath: string, currentStage: TaskProgress["currentStage"]): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
  };
}

void describe("runLintingFixes tracked-operation outcome (RC3 item 11 / Step 9)", () => {
  void it("ends the tracked operation as 'failed', never 'succeeded', when AI final fixes are unavailable and checks still fail", async () => {
    const taskFolderPath = makeTaskFolder("outcome-ai-fixes-unavailable");
    const progress: TaskProgress = {
      ...fixtureProgress(taskFolderPath, "publish"),
      lintPayload: {
        runAt: "2026-01-01T00:00:00.000Z",
        passed: false,
        summary: "1 check failed",
        issueCount: 1,
        failedChecks: [],
      },
    };
    writeProgress(taskFolderPath, progress);
    const packageJsonPath = path.join(REAL_ROOT, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "root-outcome",
          scripts: {
            lint: 'node -e "process.exit(0)"',
            "check-types": 'node -e "process.exit(0)"',
            test: 'node -e "process.exit(1)"',
            build: 'node -e "process.exit(0)"',
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const endedSnapshots: TaskOperationSnapshot[] = [];
    const sub = taskOperations.onDidEnd((snap) => {
      if (snap.label === "Linting Fixes") {
        endedSnapshots.push(snap);
      }
    });

    const originalEnsure = modelSelectionModule.ensureStageModelConfigured;
    const originalResolveFresh = modelSelectionModule.resolveFreshModelForStage;
    const originalCheckAvailability = runEditActionModule.checkEditActionAvailabilityV1;
    modelSelectionModule.ensureStageModelConfigured = () => Promise.resolve(true);
    modelSelectionModule.resolveFreshModelForStage = () =>
      Promise.resolve({
        modelId: "stub-publish-model",
        source: "workspace",
      });
    runEditActionModule.checkEditActionAvailabilityV1 = () =>
      Promise.resolve({
        ok: false,
        code: "providerModeUnavailable",
        reason: "No Copilot language models are available. Sign in to GitHub Copilot in VS Code.",
      });

    try {
      const inventory = makeInventory(taskFolderPath, progress);
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      const warnings = surface.entries.filter((e) => e.level === "warning");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]?.message ?? "", /AI final fixes are unavailable/);

      assert.equal(
        endedSnapshots.length,
        1,
        "runLintingFixes's own tracked operation must end exactly once"
      );
      assert.equal(
        endedSnapshots[0]?.state,
        "failed",
        "checks are still failing after this run — the operation must not settle as 'succeeded' " +
          "(which operationNotificationBridge.ts renders as 'completed')"
      );
      assert.notEqual(
        endedSnapshots[0]?.state,
        "succeeded",
        "must never report a false 'completed' outcome when the AI fixes could not run and checks remain failing"
      );
    } finally {
      sub.dispose();
      modelSelectionModule.ensureStageModelConfigured = originalEnsure;
      modelSelectionModule.resolveFreshModelForStage = originalResolveFresh;
      runEditActionModule.checkEditActionAvailabilityV1 = originalCheckAvailability;
      fs.rmSync(packageJsonPath, { force: true });
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});
