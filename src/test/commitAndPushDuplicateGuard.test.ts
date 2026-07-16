/**
 * Regression coverage for the Commit and Push duplicate-invocation guard.
 *
 * The exclusive task-operation lock (`taskOperations.begin`) must be acquired
 * BEFORE lint, the lint-failure modal, staging, commit, or push start — a
 * second invocation arriving while the first is mid-lint or waiting on a
 * modal must be refused immediately, with no second lint run and no second
 * modal stacked on top of the first.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { commitAndPushTask } from "../commands/commitAndPushTask";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

// completionLint.ts is required (not `import`ed) so its exported function
// reference can be monkey-patched for the duration of a test: TypeScript
// compiles named imports to property access on the shared CommonJS module
// object, so reassigning the property here is visible to commitAndPushTask.ts
// too, without needing a DI seam that doesn't otherwise exist.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<unknown>;
};

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitFixtureWithRemote(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-commit-push-guard-")
  );
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
    "commit", "--allow-empty", "-m", "initial",
  ]);
  // A remote (never actually pushed to in these tests) so describePushDestination
  // resolves a single-remote push target instead of throwing "ambiguous".
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

/** Deferred promise helper for pausing mid-flow in the tests below. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

void describe("commitAndPushTask duplicate-invocation guard", () => {
  void it("refuses a second invocation that arrives while the first is mid-lint, with no duplicate lint run", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-commit-push-guard-"));
    fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
    const taskFolderPath = path.join(repoRoot, "plans", "task_1");
    const canonicalId = taskFolderPath;
    const inventory = installFakeInventory(taskFolderPath, canonicalId);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalRunCompletionLint = completionLintModule.runCompletionLint;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(repoRoot), name: "root", index: 0 },
    ];

    let lintCallCount = 0;
    const lintGate = deferred<void>();
    completionLintModule.runCompletionLint = async () => {
      lintCallCount += 1;
      await lintGate.promise;
      return { passed: false, summary: "stub failure", runAt: new Date().toISOString(), issueCount: 1, failedChecks: [] };
    };
    // The lint-failure modal (reached once lintGate resolves) — resolve to
    // "Cancel" so the first invocation exits cleanly without needing a real
    // git repository.
    vscode.window.showWarningMessage = (() => Promise.resolve("Cancel")) as unknown as typeof vscode.window.showWarningMessage;
    vscode.window.showErrorMessage = (() => Promise.resolve(undefined)) as unknown as typeof vscode.window.showErrorMessage;

    try {
      const firstCall = commitAndPushTask(inventory, { canonicalId });
      // Let the first call reach and enter the mocked lint before firing the second.
      await new Promise((r) => setImmediate(r));

      const secondCall = commitAndPushTask(inventory, { canonicalId });
      await secondCall;

      assert.equal(lintCallCount, 1, "lint must not run a second time for the duplicate invocation");
      assert.ok(
        surface.entries.some((e) => /already in progress/.test(e.message)),
        `expected a busy warning; got: ${JSON.stringify(surface.entries)}`
      );

      lintGate.resolve();
      await firstCall;
    } finally {
      completionLintModule.runCompletionLint = originalRunCompletionLint;
      vscode.window.showWarningMessage = originalShowWarningMessage;
      vscode.window.showErrorMessage = originalShowErrorMessage;
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originalWorkspaceFolders;
      deactivateNotificationRouter();
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  void it("refuses a second invocation that arrives while the first is waiting on the confirmation modal, with no second modal and no git commands from the duplicate", async () => {
    const repoRoot = makeGitFixtureWithRemote();
    const taskFolderPath = path.join(repoRoot, "plans", "task_1");
    const canonicalId = taskFolderPath;
    const inventory = installFakeInventory(taskFolderPath, canonicalId);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalRunCompletionLint = completionLintModule.runCompletionLint;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(repoRoot), name: "root", index: 0 },
    ];

    completionLintModule.runCompletionLint = () => Promise.resolve({
      passed: true, summary: "", runAt: new Date().toISOString(), issueCount: 0, failedChecks: [],
    });

    let confirmModalCallCount = 0;
    const confirmGate = deferred<string>();
    vscode.window.showWarningMessage = ((..._args: unknown[]) => {
      confirmModalCallCount += 1;
      return confirmGate.promise;
    }) as unknown as typeof vscode.window.showWarningMessage;

    try {
      const firstCall = commitAndPushTask(inventory, { canonicalId });
      // Let the first call proceed through lint, git-repo resolution, and
      // changed-file collection up to the confirmation modal. Poll rather
      // than a fixed sleep since the several real `git` child-process calls
      // on the way there have variable latency.
      const deadline = Date.now() + 10_000;
      while (confirmModalCallCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(confirmModalCallCount, 1, "expected the first invocation to reach the confirmation modal");

      const secondCall = commitAndPushTask(inventory, { canonicalId });
      await secondCall;

      assert.equal(confirmModalCallCount, 1, "the confirmation modal must not be shown a second time for the duplicate invocation");
      assert.ok(
        surface.entries.some((e) => /already in progress/.test(e.message)),
        `expected a busy warning; got: ${JSON.stringify(surface.entries)}`
      );

      confirmGate.resolve("Cancel");
      await firstCall;
    } finally {
      completionLintModule.runCompletionLint = originalRunCompletionLint;
      vscode.window.showWarningMessage = originalShowWarningMessage;
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originalWorkspaceFolders;
      deactivateNotificationRouter();
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
