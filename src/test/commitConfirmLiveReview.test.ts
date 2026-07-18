/**
 * Regression coverage for settling the commit-message review while the
 * ORIGINATING Commit and Push operation is still live.
 *
 * The originating operation holds the task's exclusive lock while it awaits
 * the non-modal review notification. The editor-title "Confirm Commit
 * Message" command must therefore settle THROUGH that live operation (the
 * wake channel in pendingCommitSession.ts) — a second exclusive
 * runTrackedOperation claim would be refused with only a busy message and
 * the session would silently stay uncommitted. Closing the review editor
 * during the same window must likewise wake the operation so the lock is
 * released instead of being held until the notification is dismissed.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { commitAndPushTask, confirmPendingCommitMessage } from "../commands/commitAndPushTask";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { getPendingCommitSession } from "../utils/pendingCommitSession";
import { taskOperations } from "../utils/taskOperations";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

// Required (not `import`ed) so the exported function references can be
// monkey-patched for the duration of a test — TypeScript compiles named
// imports to property access on the shared CommonJS module object, so the
// reassignment is visible to commitAndPushTask.ts too.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const modelSelectionModule = require("../utils/modelSelection") as {
  resolveFreshModelForStage: (...args: unknown[]) => Promise<unknown>;
};

function git(cwd: string, args: string[]): string {
  return cp.execFileSync("git", args, { cwd, windowsHide: true }).toString("utf8");
}

function makeGitFixtureWithRemote(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-commit-confirm-live-")
  );
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
    "commit", "--allow-empty", "-m", "initial",
  ]);
  // A remote (never actually pushed to) so describePushDestination resolves a
  // single-remote push target; the push itself failing is fine — the local
  // commit is what these tests assert on.
  git(repoRoot, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "foo.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
  return repoRoot;
}

function fixtureTaskProgress(): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function installFakeInventory(taskFolderPath: string, canonicalId: string): TaskInventory {
  const task = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: fixtureTaskProgress(),
  };
  return {
    getTaskById: (id: string) => (id === canonicalId ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [task],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(condition(), `timed out waiting for: ${what}`);
}

interface LiveReviewHarness {
  repoRoot: string;
  taskFolderPath: string;
  surface: RecordingSurface;
  errorMessages: string[];
  commitPromise: Promise<void>;
  restore: () => void;
}

/**
 * Drives commitAndPushTask through lint, the confirmation modal, and message
 * generation up to the review notification (which is never answered — the
 * user "ignores" it, leaving the originating operation live and holding the
 * task's exclusive lock), then hands control back to the test.
 */
async function startLiveReview(): Promise<LiveReviewHarness> {
  const repoRoot = makeGitFixtureWithRemote();
  const taskFolderPath = path.join(repoRoot, "plans", "task_1");
  const inventory = installFakeInventory(taskFolderPath, taskFolderPath);

  const surface = new RecordingSurface();
  initNotificationRouter(surface);

  const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = {
    workspaceFolders: vscode.workspace.workspaceFolders,
    runCompletionLint: completionLintModule.runCompletionLint,
    resolveFreshModelForStage: modelSelectionModule.resolveFreshModelForStage,
    showWarningMessage: vscode.window.showWarningMessage,
    showInformationMessage: vscode.window.showInformationMessage,
    showErrorMessage: vscode.window.showErrorMessage,
    fsWriteFile: workspaceFs.writeFile,
    fsRename: workspaceFs.rename,
  };

  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(repoRoot), name: "root", index: 0 },
  ];
  completionLintModule.runCompletionLint = () => Promise.resolve({
    passed: true, summary: "", runAt: new Date().toISOString(), issueCount: 0, failedChecks: [],
  });
  // Deterministic model resolution: the Copilot lm stub returns no models,
  // so buildCommitMessage always lands on its deterministic fallback subject.
  modelSelectionModule.resolveFreshModelForStage = () =>
    Promise.resolve({ modelId: "copilot:auto" });
  // The Commit & Push confirmation modal (file-list preview).
  vscode.window.showWarningMessage =
    (() => Promise.resolve("Commit & Push")) as unknown as typeof vscode.window.showWarningMessage;
  // The review notification: never answered — the operation keeps awaiting.
  vscode.window.showInformationMessage =
    (() => new Promise(() => { /* never resolves */ })) as unknown as typeof vscode.window.showInformationMessage;
  const errorMessages: string[] = [];
  vscode.window.showErrorMessage = ((message: string) => {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  }) as unknown as typeof vscode.window.showErrorMessage;
  // pr-description.md write (workspace.fs is notImplemented in the stub).
  workspaceFs.writeFile = () => Promise.resolve();
  workspaceFs.rename = () => Promise.resolve();

  const restore = (): void => {
    completionLintModule.runCompletionLint = originals.runCompletionLint;
    modelSelectionModule.resolveFreshModelForStage = originals.resolveFreshModelForStage;
    vscode.window.showWarningMessage = originals.showWarningMessage;
    vscode.window.showInformationMessage = originals.showInformationMessage;
    vscode.window.showErrorMessage = originals.showErrorMessage;
    workspaceFs.writeFile = originals.fsWriteFile;
    workspaceFs.rename = originals.fsRename;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originals.workspaceFolders;
    deactivateNotificationRouter();
    fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    const commitPromise = commitAndPushTask(inventory, { canonicalId: taskFolderPath });
    await until(() => getPendingCommitSession() !== undefined, "the pending commit session");
    // The originating operation is still live: it holds the exclusive lock
    // while awaiting the (unanswered) review notification.
    assert.equal(taskOperations.busyLabel(taskFolderPath), "Commit and Push");
    return { repoRoot, taskFolderPath, surface, errorMessages, commitPromise, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

void describe("commit-message confirmation while the originating operation is live", () => {
  void it("the confirm command settles through the live operation instead of being refused as busy", async () => {
    const harness = await startLiveReview();
    try {
      await confirmPendingCommitMessage();
      await harness.commitPromise;

      assert.equal(getPendingCommitSession(), undefined, "the session must be consumed by settlement");
      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "2",
        "settlement must create the commit"
      );
      assert.match(
        git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim(),
        /^Update foo\.ts \(task_1\)/,
        "the commit must carry the reviewed message"
      );
      assert.ok(
        !harness.surface.entries.some((e) => /already in progress/.test(e.message)),
        `settlement must not be refused as busy; got: ${JSON.stringify(harness.surface.entries)}`
      );
      assert.equal(
        taskOperations.busyLabel(harness.taskFolderPath),
        undefined,
        "the operation must have ended and released the lock"
      );
    } finally {
      harness.restore();
    }
  });

  void it("closing the review editor wakes the live operation so the lock is released without a commit", async () => {
    const harness = await startLiveReview();
    try {
      const session = getPendingCommitSession();
      assert.ok(session);
      const doc = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === session.documentUri
      );
      assert.ok(doc, "the review editor document must be open");
      (vscode.workspace as unknown as { _closeTextDocument: (d: unknown) => void })._closeTextDocument(doc);

      await harness.commitPromise;

      assert.equal(getPendingCommitSession(), undefined, "closing the editor must cancel the session");
      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "1",
        "nothing may be committed on the cancel path"
      );
      assert.equal(
        taskOperations.busyLabel(harness.taskFolderPath),
        undefined,
        "the lock must be released instead of held until the notification is dismissed"
      );
      assert.ok(
        harness.surface.entries.some((e) => /editor closed — commit and push cancelled/i.test(e.message)),
        `expected the close-cancel notice; got: ${JSON.stringify(harness.surface.entries)}`
      );

      // A later confirm reports "nothing pending" rather than a busy refusal.
      await confirmPendingCommitMessage();
      assert.ok(
        harness.surface.entries.some((e) => /No commit message review is pending/.test(e.message)),
        `expected the no-pending notice; got: ${JSON.stringify(harness.surface.entries)}`
      );
    } finally {
      harness.restore();
    }
  });
});
