/**
 * Coverage for the publish failing-checks gate (C3, plan step 28): when the
 * fresh pre-commit completion checks fail, Commit and Push must surface a
 * three-way decision — Publish Anyway (recorded as an override in
 * publish-checks.md), Fix with AI (the linting-fixes flow run in-flow, nested
 * under the commit-push operation, followed by a fresh check run), or Cancel
 * (the modal's dismiss affordance). A user with a failing test must be able
 * to pick the fix option without cancelling and restarting publishing.
 *
 * Every check run — passing, failing, and post-fix rerun — must also be
 * recorded in publish-checks.md's managed Completion Checks section,
 * regardless of which gate outcome follows. In production that write happens
 * inside runCompletionLint (completionLint.ts) on every run; the stub
 * installed below delegates to the real upsert so these tests exercise and
 * assert that artifact contract end to end, not just the modal choreography.
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
import { safeRemoveDir } from "./testFsUtils";
import { fixtureOwnershipFor } from "./taskFolderFixture";

// Both modules are required (not `import`ed) so their exported function
// references can be monkey-patched for the duration of a test: TypeScript
// compiles named imports to property access on the shared CommonJS module
// object, so reassigning the property here is visible to commitAndPushTask.ts
// too, without needing a DI seam that doesn't otherwise exist.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<unknown>;
  upsertCompletionChecksReportV1: (
    taskFolderUri: vscode.Uri,
    result: unknown,
    override?: { reason: string }
  ) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runLintingFixesModule = require("../commands/runLintingFixes") as {
  runLintingFixes: (...args: unknown[]) => Promise<void>;
};

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitFixtureWithRemote(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-commit-push-gate-")
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

function fixtureTaskProgress(taskFolderPath: string): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
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
    progress: fixtureTaskProgress(taskFolderPath),
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

function failingLintResult(): Record<string, unknown> {
  return {
    passed: false,
    summary: "1 completion check(s) failed.",
    runAt: new Date().toISOString(),
    issueCount: 1,
    failedChecks: [{ command: "npm run test", exitCode: 1, output: "1 failing" }],
    missingScripts: [],
  };
}

function passingLintResult(): Record<string, unknown> {
  return {
    passed: true,
    summary: "No linting issues found.",
    runAt: new Date().toISOString(),
    issueCount: 0,
    failedChecks: [],
    missingScripts: [],
  };
}

interface GateHarness {
  repoRoot: string;
  taskFolderPath: string;
  inventory: TaskInventory;
  surface: RecordingSurface;
  /** Every showWarningMessage call: the message plus the offered items. */
  warningCalls: { message: string; items: string[] }[];
  restore(): void;
}

function installGateHarness(
  lintResults: () => Record<string, unknown>,
  answerChecksModal: () => string | undefined
): GateHarness {
  const repoRoot = makeGitFixtureWithRemote();
  const taskFolderPath = path.join(repoRoot, "plans", "task_1");
  const inventory = installFakeInventory(taskFolderPath, taskFolderPath);

  const surface = new RecordingSurface();
  initNotificationRouter(surface);

  const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
  const originalRunCompletionLint = completionLintModule.runCompletionLint;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(repoRoot), name: "root", index: 0 },
  ];

  completionLintModule.runCompletionLint = async (...args: unknown[]): Promise<unknown> => {
    const result = lintResults();
    // Mirror the production contract: runCompletionLint upserts the managed
    // Completion Checks section into publish-checks.md on EVERY run — pass or
    // fail — before the gate ever sees the result. Delegating to the real
    // upsert keeps the artifact behavior under test instead of stubbed away.
    await completionLintModule.upsertCompletionChecksReportV1(
      args[0] as vscode.Uri,
      result
    );
    return result;
  };

  const warningCalls: { message: string; items: string[] }[] = [];
  vscode.window.showWarningMessage = ((...args: unknown[]): Promise<string | undefined> => {
    const message = String(args[0]);
    const items = args.slice(1).filter((a): a is string => typeof a === "string");
    warningCalls.push({ message, items });
    // The failing-checks decision modal is answered by the test; every other
    // warning modal (the staging confirmation) is dismissed, cancelling
    // cleanly before any git mutation.
    const answer = /Completion checks failed/.test(message)
      ? answerChecksModal()
      : undefined;
    return Promise.resolve(answer);
  }) as unknown as typeof vscode.window.showWarningMessage;

  return {
    repoRoot,
    taskFolderPath,
    inventory,
    surface,
    warningCalls,
    restore(): void {
      completionLintModule.runCompletionLint = originalRunCompletionLint;
      vscode.window.showWarningMessage = originalShowWarningMessage;
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originalWorkspaceFolders;
      deactivateNotificationRouter();
      safeRemoveDir(repoRoot);
    },
  };
}

void describe("commitAndPushTask failing-checks gate (Publish Anyway / Fix with AI / Cancel)", () => {
  void it("offers both Publish Anyway and Fix with AI, and records the override in publish-checks.md when the user publishes anyway", async () => {
    const harness = installGateHarness(failingLintResult, () => "Publish Anyway");
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      const checksModal = harness.warningCalls.find((c) => /Completion checks failed/.test(c.message));
      assert.ok(checksModal, "the failing-checks decision modal must be shown");
      assert.deepEqual(
        checksModal.items,
        ["Publish Anyway", "Fix with AI"],
        "the modal must offer Publish Anyway and Fix with AI (Cancel is the modal's dismiss affordance)"
      );

      const reviewPath = path.join(harness.taskFolderPath, "publish-checks.md");
      assert.ok(fs.existsSync(reviewPath), "publishing anyway must record the failing checks in publish-checks.md");
      const content = fs.readFileSync(reviewPath, "utf8");
      assert.match(content, /Published anyway despite failing checks — user chose Publish Anyway despite failing checks\./);
      assert.match(content, /npm run test/, "the failing check itself must be part of the recorded override");

      // The flow continued into publishing (reaching the staging confirmation
      // modal) rather than terminating at the gate.
      assert.ok(
        harness.warningCalls.some((c) => /Commit and push/.test(c.message) && !/Completion checks failed/.test(c.message)),
        `publishing must continue after the override; warning calls: ${JSON.stringify(harness.warningCalls.map((c) => c.items))}`
      );
    } finally {
      harness.restore();
    }
  });

  void it("Fix with AI runs the linting-fixes flow nested under the commit-push operation, then re-runs checks before continuing", async () => {
    let lintCallCount = 0;
    // First check run fails; the post-fix rerun passes.
    const harness = installGateHarness(
      () => (++lintCallCount === 1 ? failingLintResult() : passingLintResult()),
      () => "Fix with AI"
    );

    const originalRunLintingFixes = runLintingFixesModule.runLintingFixes;
    const fixCalls: unknown[][] = [];
    runLintingFixesModule.runLintingFixes = (...args: unknown[]): Promise<void> => {
      fixCalls.push(args);
      return Promise.resolve();
    };
    const fakeContext = {
      extensionUri: vscode.Uri.file(harness.repoRoot),
    } as unknown as vscode.ExtensionContext;

    try {
      await commitAndPushTask(
        harness.inventory,
        { canonicalId: harness.taskFolderPath },
        undefined,
        undefined,
        fakeContext
      );

      assert.equal(fixCalls.length, 1, "Fix with AI must invoke the linting-fixes flow exactly once");
      const [, extensionUri, arg, context, parentOperation] = fixCalls[0]!;
      assert.equal((extensionUri as vscode.Uri).fsPath, vscode.Uri.file(harness.repoRoot).fsPath);
      assert.deepEqual(arg, { taskFolderPath: harness.taskFolderPath });
      assert.equal(context, fakeContext, "the ExtensionContext must reach the fix flow (AI consent)");
      assert.ok(
        parentOperation && typeof (parentOperation as { id?: unknown }).id === "string",
        "the fix flow must nest under the commit-push operation (C1) instead of contending for its lock"
      );

      assert.equal(lintCallCount, 2, "checks must re-run after the fix pass, before publishing continues");
      const reviewContent = fs.readFileSync(
        path.join(harness.taskFolderPath, "publish-checks.md"),
        "utf8"
      );
      assert.match(reviewContent, /Status: Passed/, "the passing rerun must be recorded in publish-checks.md");
      assert.doesNotMatch(
        reviewContent,
        /Status: Failed/,
        "the rerun must replace the earlier failing section, not sit alongside it"
      );
      assert.ok(
        harness.warningCalls.some((c) => !/Completion checks failed/.test(c.message)),
        "once the rerun passes, publishing must continue to the staging confirmation"
      );
      assert.equal(
        harness.warningCalls.filter((c) => /Completion checks failed/.test(c.message)).length,
        1,
        "a passing rerun must not re-surface the failing-checks modal"
      );
    } finally {
      runLintingFixesModule.runLintingFixes = originalRunLintingFixes;
      harness.restore();
    }
  });

  void it("re-surfaces the decision when the fix pass leaves checks failing, and dismissing cancels without an override", async () => {
    let promptCount = 0;
    // Checks always fail; first prompt answers Fix with AI, second dismisses.
    const harness = installGateHarness(
      failingLintResult,
      () => (++promptCount === 1 ? "Fix with AI" : undefined)
    );

    const originalRunLintingFixes = runLintingFixesModule.runLintingFixes;
    runLintingFixesModule.runLintingFixes = (): Promise<void> => Promise.resolve();
    const fakeContext = {
      extensionUri: vscode.Uri.file(harness.repoRoot),
    } as unknown as vscode.ExtensionContext;

    try {
      await commitAndPushTask(
        harness.inventory,
        { canonicalId: harness.taskFolderPath },
        undefined,
        undefined,
        fakeContext
      );

      assert.equal(promptCount, 2, "a still-failing rerun must re-surface the three-way decision");
      assert.ok(
        harness.surface.entries.some((e) => /Commit and push cancelled/.test(e.message)),
        `dismissing the modal must cancel; got: ${JSON.stringify(harness.surface.entries)}`
      );
      // Cancelling forgoes the override, but the failing check runs themselves
      // must still be on record in publish-checks.md — publish check results
      // always update the artifact, whatever the user decides at the gate.
      const reviewPath = path.join(harness.taskFolderPath, "publish-checks.md");
      assert.ok(fs.existsSync(reviewPath), "the failing check runs must be recorded even when the user cancels");
      const reviewContent = fs.readFileSync(reviewPath, "utf8");
      assert.match(reviewContent, /Status: Failed/);
      assert.match(reviewContent, /npm run test/, "the failing check itself must be part of the record");
      assert.doesNotMatch(
        reviewContent,
        /Published anyway despite failing checks/,
        "cancelling must not record a Publish Anyway override"
      );
    } finally {
      runLintingFixesModule.runLintingFixes = originalRunLintingFixes;
      harness.restore();
    }
  });

  void it("records a clean passing run in publish-checks.md and proceeds without ever showing the gate", async () => {
    const harness = installGateHarness(passingLintResult, () => undefined);
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(
        harness.warningCalls.filter((c) => /Completion checks failed/.test(c.message)).length,
        0,
        "passing checks must not surface the failing-checks modal"
      );
      const reviewPath = path.join(harness.taskFolderPath, "publish-checks.md");
      assert.ok(
        fs.existsSync(reviewPath),
        "a successful pre-commit check run must still be recorded in publish-checks.md"
      );
      const reviewContent = fs.readFileSync(reviewPath, "utf8");
      assert.match(reviewContent, /## Completion Checks/);
      assert.match(reviewContent, /Status: Passed/);
      assert.ok(
        harness.warningCalls.some((c) => /Commit and push/.test(c.message)),
        "the flow must continue to the staging confirmation"
      );
    } finally {
      harness.restore();
    }
  });
});
