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

import { offerLintFixRecoveryInChatV1, runLintingFixes } from "../commands/runLintingFixes";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { taskOperations, TaskOperationSnapshot } from "../utils/taskOperations";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { copyPromptResources } from "./helpers/copyPromptResources";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
const completionLintModule = require("../utils/completionLint") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

// One level below its own temp directory: the task-state store takes its
// session lock at `<tasks root>/../.ensemble-session.lock`, so a root placed
// directly in `os.tmpdir()` would share `/tmp/.ensemble-session.lock` with
// runLintingFixesGateMessages.test.ts when the two files run in parallel
// ("Another Ensemble session is currently updating task state").
const REAL_ROOT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-lint-fixes-outcome-")), "workspace");
fs.mkdirSync(REAL_ROOT, { recursive: true });
copyPromptResources(REAL_ROOT);

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMemento(): vscode.Memento {
  const backing = new Map<string, unknown>();
  return {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => backing.has(key) ? backing.get(key) as T : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) backing.delete(key);
      else backing.set(key, value);
      return Promise.resolve();
    },
  } as vscode.Memento;
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
  void it("renders the lint-fix recovery reason, recommended retry, implementation alternative and one stable card", async () => {
    const taskFolderPath = makeTaskFolder("outcome-lint-fix-recovery-card");
    const progress = fixtureProgress(taskFolderPath, "publish");
    writeProgress(taskFolderPath, progress);
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(REAL_ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const rf = installReadFileBridge();
    try {
      const reason = "Publish Checks have not run yet. Run them first.";
      await offerLintFixRecoveryInChatV1(taskFolderPath, "lint fix recovery", reason);
      await offerLintFixRecoveryInChatV1(taskFolderPath, "lint fix recovery", reason);
      const decisions = new WorkflowDecisionStoreV1(memento).listPending(taskFolderPath)
        .filter((decision) => decision.decisionKey === "chatActionOffer:runPublishChecks");
      assert.equal(decisions.length, 1);
      const decision = decisions[0];
      assert.ok(decision);
      assert.equal(decision.whatHappened, reason);
      assert.deepEqual(decision.options.map((option) => option.label), [
        "Run Publish Checks", "Back to Implementation", "Not now",
      ]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(decision.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.runPublishChecks",
        args: [{ taskFolderPath }],
      });
      assert.deepEqual(decision.options[1]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.setTaskStage",
        args: [{ taskFolderPath, stage: "implementation" }],
      });
    } finally {
      rf.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("cancels during the first check through the tracked operation and records no success", async () => {
    const taskFolderPath = makeTaskFolder("outcome-cancel-during-check");
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
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const endedSnapshots: TaskOperationSnapshot[] = [];
    const sub = taskOperations.onDidEnd((snap) => {
      if (snap.label === "Linting Fixes") endedSnapshots.push(snap);
    });
    const originalEnsure = modelSelectionModule.ensureStageModelConfigured;
    const originalResolveFresh = modelSelectionModule.resolveFreshModelForStage;
    const originalRunCompletionLint = completionLintModule.runCompletionLint;
    modelSelectionModule.ensureStageModelConfigured = () => Promise.resolve(true);
    modelSelectionModule.resolveFreshModelForStage = () =>
      Promise.resolve({ modelId: "stub-publish-model", source: "workspace" });
    completionLintModule.runCompletionLint = () => {
      const operation = taskOperations.getLocalTaskOperations(taskFolderPath).find((item) => item.label === "Linting Fixes");
      assert.ok(operation, "the outer fix operation must be live during checks");
      assert.equal(operation.cancellable, true, "the Notifications row must expose cancellation");
      assert.equal(taskOperations.cancelOperation(operation.id, "notifications"), true);
      const ErrorCtor = completionLintModule.PublishChecksCancelledError as new () => Error;
      throw new ErrorCtor();
    };

    try {
      await runLintingFixes(makeInventory(taskFolderPath, progress), vscode.Uri.file(REAL_ROOT), { taskFolderPath });
      assert.equal(endedSnapshots.length, 1);
      assert.equal(endedSnapshots[0]?.state, "cancelled");
      assert.match(endedSnapshots[0]?.cancelReasonV1 ?? "", /cancelled/i);
      assert.match(terminalEntryFor(endedSnapshots[0])?.message ?? "", /cancelled/i);
      assert.ok(surface.entries.every((entry) => !/passed|completed/i.test(entry.message)));
    } finally {
      sub.dispose();
      modelSelectionModule.ensureStageModelConfigured = originalEnsure;
      modelSelectionModule.resolveFreshModelForStage = originalResolveFresh;
      completionLintModule.runCompletionLint = originalRunCompletionLint;
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

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
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(REAL_ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
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
      // Unavailable Git evidence (this fixture folder is not a repository) is
      // logged, not raised: only the failed AI hand-back is a notice.
      assert.equal(warnings.length, 1, "only the failed AI hand-back is a notice");
      assert.ok(warnings.some((entry) => /AI final fixes are unavailable/.test(entry.message)));
      assert.ok(!warnings.some((entry) => /Git state evidence unavailable/.test(entry.message)));

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
      const decisions = new WorkflowDecisionStoreV1(memento).listPending(taskFolderPath)
        .filter((decision) => decision.decisionKey === "chatActionOffer:runPublishChecks");
      assert.equal(decisions.length, 1, "the failed-AI branch offers one stable task-chat recovery decision");
      const decision = decisions[0];
      assert.ok(decision);
      assert.match(decision.whatHappened, /AI final fixes are unavailable: No Copilot language models are available/);
      assert.match(decision.whatHappened, /Checks summary: unrun\/untested: npm run test\./);
      assert.match(decision.whatHappened, /Fix the remaining issues, then run Publish Checks\./);
      assert.deepEqual(decision.options.map((option) => option.label), [
        "Run Publish Checks", "Back to Implementation", "Not now",
      ]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(decision.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.runPublishChecks",
        args: [{ taskFolderPath }],
      });
      assert.deepEqual(decision.options[1]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.setTaskStage",
        args: [{ taskFolderPath, stage: "implementation" }],
      });
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
      __extensionContextV1TestOnly.reset();
    }
  });
});
