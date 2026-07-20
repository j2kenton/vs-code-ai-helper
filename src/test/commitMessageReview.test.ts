/**
 * Coverage for the in-UI commit-message review flow (commitAndPushTask.ts):
 * a modal confirmation showing the AI-suggested message, the capped file
 * preview, and the push destination — no editor document, no file to save,
 * and no need to re-invoke the whole command to see it again.
 *
 * Regression coverage for a review finding: the previous implementation
 * (pendingCommitSession.ts, removed) required the user to review the
 * message in an untitled editor buffer and confirm via a special editor-title
 * button, which was reported as a headache ("I have to save the file, and
 * then I have to start again"). This flow instead confirms inline, and lets
 * the user ask for a different message ("Regenerate") without restarting
 * staging or PR-description generation.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const modelSelectionModule = require("../utils/modelSelection") as {
  resolveFreshModelForStage: (...args: unknown[]) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runnerRegistryModule = require("../runners/runnerRegistry") as {
  resolveRunnerForModel: (...args: unknown[]) => unknown;
  checkRunnerAvailabilityForModel: (...args: unknown[]) => Promise<unknown>;
};

function git(cwd: string, args: string[]): string {
  return cp.execFileSync("git", args, { cwd, windowsHide: true }).toString("utf8");
}

function makeGitFixtureWithRemote(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-commit-message-review-")
  );
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
    "commit", "--allow-empty", "-m", "initial",
  ]);
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

function installFakeInventory(
  taskFolderPath: string,
  canonicalId: string,
  progressOverrides?: Partial<TaskProgress>
): TaskInventory {
  const task = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: { ...fixtureTaskProgress(), ...progressOverrides },
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

interface Harness {
  repoRoot: string;
  taskFolderPath: string;
  inventory: TaskInventory;
  surface: RecordingSurface;
  /** Every showInformationMessage call (the commit-message review dialog). */
  infoCalls: { message: string; options: unknown; items: string[] }[];
  /** The `stage` argument of every resolveFreshModelForStage call. */
  modelStageCalls: string[];
  restore(): void;
}

function installHarness(
  answerReviewModal: (call: { message: string; items: string[] }) => string | undefined,
  progressOverrides?: Partial<TaskProgress>
): Harness {
  const repoRoot = makeGitFixtureWithRemote();
  const taskFolderPath = path.join(repoRoot, "plans", "task_1");
  const inventory = installFakeInventory(taskFolderPath, taskFolderPath, progressOverrides);

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
  const modelStageCalls: string[] = [];
  modelSelectionModule.resolveFreshModelForStage = (
    ...args: unknown[]
  ) => {
    modelStageCalls.push(String(args[1]));
    return Promise.resolve({ modelId: "copilot:auto" });
  };
  // The file-scope confirmation modal (unrelated to this file's coverage).
  vscode.window.showWarningMessage =
    (() => Promise.resolve("Commit & Push")) as unknown as typeof vscode.window.showWarningMessage;
  const infoCalls: { message: string; options: unknown; items: string[] }[] = [];
  vscode.window.showInformationMessage = ((...args: unknown[]): Promise<string | undefined> => {
    const message = String(args[0]);
    const options = args[1];
    const items = args.slice(2).filter((a): a is string => typeof a === "string");
    const call = { message, options, items };
    infoCalls.push(call);
    return Promise.resolve(answerReviewModal(call));
  }) as unknown as typeof vscode.window.showInformationMessage;
  vscode.window.showErrorMessage = (() => Promise.resolve(undefined)) as unknown as typeof vscode.window.showErrorMessage;
  workspaceFs.writeFile = () => Promise.resolve();
  workspaceFs.rename = () => Promise.resolve();

  return {
    repoRoot,
    taskFolderPath,
    inventory,
    surface,
    infoCalls,
    modelStageCalls,
    restore(): void {
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
    },
  };
}

void describe("commit-message review (in-UI modal, no editor session)", () => {
  void it("shows a single modal with the message, file preview, and destination, then commits and pushes on confirm", async () => {
    const harness = installHarness(() => "Commit & Push");
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(harness.infoCalls.length, 1, "exactly one review dialog for a single accept");
      const call = harness.infoCalls[0]!;
      assert.match(call.message, /Commit message:/);
      assert.match(call.message, /Files \(\d+ total\):/);
      assert.match(call.message, /foo\.ts/, "the file preview lists changed files");
      assert.match(call.message, /Destination: /);
      assert.deepEqual(call.items, ["Commit & Push", "Regenerate"]);
      assert.deepEqual(call.options, { modal: true });

      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "2",
        "confirming must create the commit"
      );
      assert.doesNotMatch(
        git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim(),
        /foo\.ts/,
        "the fallback commit subject must never be a filename list"
      );
    } finally {
      harness.restore();
    }
  });

  void it("the fallback commit subject uses the task.md title, not the raw folder slug", async () => {
    const harness = installHarness(() => "Commit & Push");
    const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalReadFile = workspaceFs.readFile;
    try {
      fs.writeFileSync(
        path.join(harness.taskFolderPath, "task.md"),
        "# Add background export queue\n\n## Task Description\n\nSome details.\n"
      );
      workspaceFs.readFile = (uri: vscode.Uri) =>
        Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));

      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      const subject = git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim();
      assert.match(subject, /Add background export queue/, "fallback subject must use the task.md H1, not task_1");
      assert.doesNotMatch(subject, /task_1/, "fallback subject must not fall back to the folder slug when a title is available");
    } finally {
      workspaceFs.readFile = originalReadFile;
      harness.restore();
    }
  });

  void it("the fallback commit subject uses progress.displayName when task.md has no H1 (normal AI drafting)", async () => {
    // Normal Draft with AI never emits an H1 into task.md — it stores its
    // generated summary as progress.displayName and flips nameIsDefault to
    // false. Without this fallback the commit subject would regress to the
    // raw folder slug ("task_1") instead of the drafted intent.
    const harness = installHarness(() => "Commit & Push", {
      displayName: "Add background export queue",
      nameIsDefault: false,
    });
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      const subject = git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim();
      assert.match(
        subject,
        /Add background export queue/,
        "fallback subject must use progress.displayName, not task_1"
      );
      assert.doesNotMatch(
        subject,
        /task_1/,
        "fallback subject must not fall back to the folder slug when displayName is available"
      );
    } finally {
      harness.restore();
    }
  });

  void it("Regenerate re-shows the dialog without staging or committing anything", async () => {
    let calls = 0;
    const harness = installHarness(() => {
      calls += 1;
      return calls === 1 ? "Regenerate" : "Commit & Push";
    });
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(harness.infoCalls.length, 2, "Regenerate must re-show the review dialog once");
      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "2",
        "the eventual confirm must still create exactly one commit"
      );
    } finally {
      harness.restore();
    }
  });

  void it("resolves the model configured for the Publish stage, not some other stage or a fixed default", async () => {
    const harness = installHarness(() => "Commit & Push");
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.ok(harness.modelStageCalls.length > 0, "commit-message generation must resolve a model");
      assert.ok(
        harness.modelStageCalls.every((stage) => stage === "publish"),
        `every model resolution during commit-message generation must use the "publish" stage; got: ${JSON.stringify(harness.modelStageCalls)}`
      );
    } finally {
      harness.restore();
    }
  });

  void it("uses the configured Publish-stage CLI provider's run output, not the filename-list fallback", async () => {
    const harness = installHarness(() => "Commit & Push");
    const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalReadFile = workspaceFs.readFile;
    const originalCreateDirectory = workspaceFs.createDirectory;
    const originalResolveRunner = runnerRegistryModule.resolveRunnerForModel;
    const originalCheckAvailability = runnerRegistryModule.checkRunnerAvailabilityForModel;
    const cliMessage = "Add background export queue\n\nLets large exports finish without blocking the UI.";
    let runInvokedWithStage: string | undefined;
    try {
      modelSelectionModule.resolveFreshModelForStage = () =>
        Promise.resolve({ modelId: "claude-cli:sonnet" });
      runnerRegistryModule.resolveRunnerForModel = () => ({
        runner: {
          run: (request: { stage: string }) => {
            runInvokedWithStage = request.stage;
            return Promise.resolve({ status: "completed" });
          },
        },
        provider: "claude-cli",
        providerLabel: "Claude Code",
        nativeModelId: undefined,
      });
      runnerRegistryModule.checkRunnerAvailabilityForModel = () =>
        Promise.resolve({ availability: { available: true } });
      workspaceFs.createDirectory = () => Promise.resolve();
      workspaceFs.readFile = () => Promise.resolve(new TextEncoder().encode(cliMessage));

      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(runInvokedWithStage, "publish", "the CLI runner must be invoked for the publish stage");
      assert.equal(harness.infoCalls.length, 1);
      assert.match(harness.infoCalls[0]!.message, /Add background export queue/);
      assert.doesNotMatch(
        harness.infoCalls[0]!.message,
        /^Commit message:\n\nUpdate /,
        "must not fall back to the deterministic filename-list subject when the CLI runner succeeds"
      );
    } finally {
      workspaceFs.readFile = originalReadFile;
      workspaceFs.createDirectory = originalCreateDirectory;
      runnerRegistryModule.resolveRunnerForModel = originalResolveRunner;
      runnerRegistryModule.checkRunnerAvailabilityForModel = originalCheckAvailability;
      harness.restore();
    }
  });

  void it("dismissing the review dialog cancels without staging, committing, or writing any file", async () => {
    const harness = installHarness(() => undefined);
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "1",
        "nothing may be committed when the review dialog is dismissed"
      );
      assert.equal(
        git(harness.repoRoot, ["status", "--porcelain"]).trim().length > 0,
        true,
        "the working tree changes must remain unstaged, exactly as before the run"
      );
      assert.ok(
        harness.surface.entries.some((e) => /Commit and push cancelled/.test(e.message)),
        "cancellation must be reported"
      );
    } finally {
      harness.restore();
    }
  });
});
