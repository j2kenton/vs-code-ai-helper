/**
 * Regression coverage for the Publish auto-run ownership matrix (plan area
 * A1): auto-advancing past the final Low-Level Code Review directly onto
 * Publish must have exactly one scheduling owner for the eventual publish
 * chain — never both a follow-up Publish review AND a direct auto-publish
 * dispatch racing for the same task.
 *
 * AUTO_REVIEW_TRANSITIONS deliberately has no entry landing on "publish"
 * (impl-low-review is itself a review stage, not the plain stage the map
 * requires), so `transition.shouldAutoReview` is always false there —
 * ownership for the Publish landing is decided directly from the auto-advance
 * mode instead: "auto-fast-forward" gets a follow-up Publish review (which
 * then owns auto-publish once its own score clears the threshold), plain
 * "auto" auto-publishes directly.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { isUnusableAsExistingReview, nextStage, runReviewForFolder } from "../commands/reviewActions";
import { setTaskStage } from "../commands/setTaskStage";
import { commitAndPushTask, completeCommitAndPushTask } from "../commands/commitAndPushTask";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentRunRequest, AgentRunResult } from "../types/agentRunner";
import type { AutomationDispatch } from "../utils/automationChain";
import { scheduleAutomationChain, resetAutomationChainGuards } from "../utils/automationChain";
import { StatusTreeProvider } from "../views/statusView";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { upsertCompletionChecksInPublishReview, CompletionLintResult } from "../utils/completionLint";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { normalizePath } from "../utils/taskRoot";
import { __quotaTestOnly, getQuotaObservation, recordQuotaObservation } from "../utils/quota";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const automationChainModule = require("../utils/automationChain") as Record<string, unknown>;
const publishPreflightModule = require("../utils/publishPreflight") as Record<string, unknown>;
const gitRepoInfoModule = require("../utils/gitRepoInfo") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-owner-"));

function makeTaskFolder(
  name: string,
  currentStage: TaskProgress["currentStage"] = "impl-low-review"
): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");
  return { folderPath };
}

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
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory"]) {
        target[key] = orig[key];
      }
    },
  };
}

/**
 * Bridges vscode.workspace.fs.readDirectory to real fs — needed only by the
 * resolveTask no-arg fallback (findAllTasks), which installFsBridge above
 * doesn't cover since no other test in this file exercises that scan path.
 */
function installReadDirectoryBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readDirectory;
  target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, number]>> => {
    try {
      const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
    } catch {
      return [];
    }
  };
  return { restore: (): void => { target.readDirectory = orig; } };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

/** Minimal TaskInventory stub — enough for setTaskStage's resolveTaskContext + refresh(). */
function makeInventoryStub(
  taskFolderPath: string,
  currentStage: TaskStage,
  status: "active" | "paused" | "completed" = "active",
  completedAt?: string,
  implReviewFiles?: string[]
): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const folderName = taskFolderPath.split(/[/\\]/).pop() ?? "";
  const task = {
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName,
    sourceScopeKey: taskFolderPath,
    progress: {
      taskFolder: folderName,
      currentStage,
      status,
      completedAt,
      implReviewFiles,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[taskFolderPath, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === taskFolderPath ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === taskFolderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

/**
 * Like makeInventoryStub, but re-reads task-progress.json from disk on every
 * lookup instead of returning a fixed snapshot — needed for command-level
 * flows (the "Complete, Commit and Push" composite, reopen) that mutate the
 * task's persisted stage/status mid-flow and then re-resolve it themselves
 * (e.g. completeCommitAndPushTask calling commitAndPushTask internally).
 */
function makeLiveInventoryStub(taskFolderPath: string): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const folderName = taskFolderPath.split(/[/\\]/).pop() ?? "";
  const readLive = (): { canonicalId: string; taskFolderPath: string; folderName: string; sourceScopeKey: string; progress: TaskProgress } => {
    const raw = fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8");
    return {
      canonicalId: taskFolderPath,
      taskFolderPath,
      folderName,
      sourceScopeKey: taskFolderPath,
      progress: JSON.parse(raw) as TaskProgress,
    };
  };
  inv.refresh = async (): Promise<void> => { /* no-op — reads are always live */ };
  inv.getTasks = (): Array<ReturnType<typeof readLive>> => [readLive()];
  inv.getTaskById = (id: string): ReturnType<typeof readLive> | undefined =>
    (id === taskFolderPath ? readLive() : undefined);
  inv.getTaskByPath = (p: string): ReturnType<typeof readLive> | undefined =>
    (p === taskFolderPath ? readLive() : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function makeCurrentTaskStoreStub(): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => undefined;
  store.set = async (): Promise<void> => { /* no-op */ };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return store;
}

async function runPassingReview(
  folderPath: string,
  dispatches: AutomationDispatch[],
  reviewText = "Readiness: 9/10\n\n- Ready.\n",
  currentStage: TaskProgress["currentStage"] = "impl-low-review",
  reviewOptions: Parameters<typeof runReviewForFolder>[5] = {}
): Promise<void> {
  const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
  const fakeRunner = {
    id: "stub-runner",
    label: "Stub Provider",
    capabilities: { planning: true, review: true, assistant: false },
    isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
    run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      await fs.promises.writeFile(request.outputFile.fsPath, reviewText, "utf8");
      return { runnerId: "stub-runner", status: "completed" };
    },
  };
  const contextPack = path.join(folderPath, "context-pack.md");
  fs.writeFileSync(contextPack, "# Context\n", "utf8");

  const patches: Patched[] = [
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "stub:model" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "stub:model" })),
    patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
      Promise.resolve(new Set(REVIEW_STAGES))),
    patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
      runner: fakeRunner, provider: "copilot", providerLabel: "Stub Provider", nativeModelId: undefined,
    })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
      dispatches.push(dispatch);
      return Promise.resolve(true);
    }),
  ];
  try {
    await runReviewForFolder(
      vscode.Uri.file(REAL_ROOT),
      vscode.Uri.file(folderPath),
      workspaceRoot,
      currentStage,
      true,
      reviewOptions
    );
  } finally {
    for (const p of patches.reverse()) { p.restore(); }
  }
}

void describe("Publish auto-run ownership matrix — auto-advance landing on Publish", () => {
  void it("auto-fast-forward mode: dispatches exactly one follow-up Publish review carrying autoPublishOnSuccess, never a direct auto-publish chain", async () => {
    const { folderPath } = makeTaskFolder(`ff-${Math.floor(Math.random() * 1e9)}`);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto-fast-forward"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runPassingReview(folderPath, dispatches);

      assert.equal(dispatches.length, 1, "exactly one scheduling owner — no race between review and direct publish");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.fastForwardReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
      const arg = dispatches[0]?.arg as { autoPublishOnSuccess?: boolean } | undefined;
      assert.equal(arg?.autoPublishOnSuccess, true, "the follow-up Publish review must own auto-publish");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("plain auto mode: dispatches the publish chain directly, with no follow-up review", async () => {
    const { folderPath } = makeTaskFolder(`auto-${Math.floor(Math.random() * 1e9)}`);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      // Isolate the ownership-dispatch decision from actual completion-lint
      // execution (covered separately by checkPublishPreflight's own tests).
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({ ok: true, lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] } })),
    ];
    try {
      await runPassingReview(folderPath, dispatches);

      assert.equal(dispatches.length, 1, "exactly one scheduling owner");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.commitAndPushTask");
      assert.equal(dispatches[0]?.chainId, "auto-publish");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a task paused while the review was running must not auto-publish, even though the score cleared the threshold", async () => {
    const { folderPath } = makeTaskFolder(`paused-mid-review-${Math.floor(Math.random() * 1e9)}`);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
    const progressPath = path.join(folderPath, "task-progress.json");

    // The AI review call is where a real review spends most of its (possibly
    // multi-minute) wall-clock time — simulate the user pausing the task
    // from the UI while it is still in flight, before the review resolves.
    const fakeRunner = {
      id: "stub-runner",
      label: "Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
        progress.status = "paused";
        fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf8");
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "stub-runner", status: "completed" };
      },
    };
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
        runner: fakeRunner, provider: "copilot", providerLabel: "Stub Provider", nativeModelId: undefined,
      })),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({ ok: true, lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] } })),
    ];
    try {
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(dispatches.length, 0, "a task paused mid-review must never auto-publish, even with a passing score");
      const written = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
      assert.equal(written.status, "paused", "the pause set mid-review must survive the transition");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

void describe("Publish auto-run ownership matrix — dropped auto-review chain warns instead of silently stalling", () => {
  void it("auto-fast-forward landing on Publish: when the shared auto-review chain slot is already claimed, warns with Publish Anyway instead of leaving the task silently stuck", async () => {
    const { folderPath } = makeTaskFolder(`dropped-chain-${Math.floor(Math.random() * 1e9)}`);
    const taskFolderUri = vscode.Uri.file(folderPath);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
    const fakeRunner = {
      id: "stub-runner",
      label: "Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "stub-runner", status: "completed" };
      },
    };
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto-fast-forward"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
        runner: fakeRunner, provider: "copilot", providerLabel: "Stub Provider", nativeModelId: undefined,
      })),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      // Deliberately NOT patching scheduleAutomationChain — this test
      // exercises the real duplicate-chain guard in automationChain.ts.
    ];
    try {
      // Claim the shared "auto-review" guard slot for this task first,
      // deferred on a root operation id that will never end — simulating
      // another review chain that is already pending/running when this
      // review's own follow-up dispatch attempts to claim the same slot.
      void scheduleAutomationChain(
        { command: "vs-code-ai-helper.runReviewWithAI", arg: {}, taskKey: taskFolderUri.fsPath, chainId: "auto-review" },
        { id: "unrelated-still-running-op" }
      );

      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        taskFolderUri,
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "expected a Notifications entry offering the manual publish action after the dropped review chain");
      assert.equal(warning?.actionCommand?.title, "Publish Anyway");
      assert.match(warning?.message ?? "", /could not be started automatically/);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      resetAutomationChainGuards();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

void describe("Publish review-owned auto-publish — failure/below-threshold outcomes still offer a manual publish action", () => {
  void it("below-threshold score: does not dispatch auto-publish, but warns with a Publish Anyway action", async () => {
    const { folderPath } = makeTaskFolder(`below-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runPassingReview(
        folderPath,
        dispatches,
        "Readiness: 3/10\n\n- Not ready.\n",
        "publish",
        { autoPublishOnSuccess: true }
      );

      assert.equal(dispatches.length, 0, "a below-threshold score must never schedule the publish chain");
      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "expected a Notifications entry offering the manual publish action");
      assert.equal(warning?.actionCommand?.title, "Publish Anyway");
      assert.deepEqual(warning?.actionCommand?.args, [{ taskFolderPath: vscode.Uri.file(folderPath).fsPath }]);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("review with no Readiness line (failed/unusable output): does not dispatch auto-publish, but warns with a Publish Anyway action", async () => {
    const { folderPath } = makeTaskFolder(`failed-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      // Invalid review output (no "Readiness:" line) makes runAiToFile pop an
      // error dialog on the way to reporting the review as unwritten — stub
      // it out like the other interactive surfaces this harness patches.
      patch(vscode.window as unknown as Record<string, unknown>, "showErrorMessage", () => Promise.resolve(undefined)),
    ];
    try {
      await runPassingReview(
        folderPath,
        dispatches,
        "I have a clarifying question instead of a review.\n",
        "publish",
        { autoPublishOnSuccess: true }
      );

      assert.equal(dispatches.length, 0, "an unusable review output must never schedule the publish chain");
      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "expected a Notifications entry offering the manual publish action");
      assert.equal(warning?.actionCommand?.title, "Publish Anyway");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

/**
 * Like runPassingReview, but drives the stub runner to a specific
 * AgentRunResult (a genuine provider failure or an outright cancellation)
 * instead of always completing successfully — needed to exercise the "review
 * failed / was cancelled" branch of runReviewForFolder (reviewActions.ts
 * around line 1550), distinct from the "completed but unusable output"
 * (no Readiness line) and "completed but below threshold" cases already
 * covered above.
 */
async function runReviewWithOutcome(
  folderPath: string,
  dispatches: AutomationDispatch[],
  runnerResult: AgentRunResult,
  currentStage: TaskProgress["currentStage"] = "publish",
  reviewOptions: Parameters<typeof runReviewForFolder>[5] = {}
): Promise<void> {
  const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
  const fakeRunner = {
    id: "stub-runner",
    label: "Stub Provider",
    capabilities: { planning: true, review: true, assistant: false },
    isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
    run: (): Promise<AgentRunResult> => Promise.resolve(runnerResult),
  };
  const contextPack = path.join(folderPath, "context-pack.md");
  fs.writeFileSync(contextPack, "# Context\n", "utf8");

  const patches: Patched[] = [
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "stub:model" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "stub:model" })),
    patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
      Promise.resolve(new Set(REVIEW_STAGES))),
    patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
      runner: fakeRunner, provider: "copilot", providerLabel: "Stub Provider", nativeModelId: undefined,
    })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
      dispatches.push(dispatch);
      return Promise.resolve(true);
    }),
  ];
  try {
    await runReviewForFolder(
      vscode.Uri.file(REAL_ROOT),
      vscode.Uri.file(folderPath),
      workspaceRoot,
      currentStage,
      true,
      reviewOptions
    );
  } finally {
    for (const p of patches.reverse()) { p.restore(); }
  }
}

void describe("Publish review-owned auto-publish — genuine provider failure and cancellation outcomes", () => {
  void it("provider error (runner returns status 'failed'): does not dispatch auto-publish, but warns with a Publish Anyway action", async () => {
    const { folderPath } = makeTaskFolder(`provider-error-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(vscode.window as unknown as Record<string, unknown>, "showErrorMessage", () => Promise.resolve(undefined)),
    ];
    try {
      await runReviewWithOutcome(
        folderPath,
        dispatches,
        { runnerId: "stub-runner", status: "failed", errorMessage: "stub: provider returned a 500" },
        "publish",
        { autoPublishOnSuccess: true }
      );

      assert.equal(dispatches.length, 0, "a genuine provider failure must never schedule the publish chain");
      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "expected a Notifications entry offering the manual publish action");
      assert.equal(warning?.actionCommand?.title, "Publish Anyway");
      assert.deepEqual(warning?.actionCommand?.args, [{ taskFolderPath: vscode.Uri.file(folderPath).fsPath }]);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("cancellation (runner returns status 'cancelled'): does not dispatch auto-publish, but warns with a Publish Anyway action", async () => {
    const { folderPath } = makeTaskFolder(`provider-cancel-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runReviewWithOutcome(
        folderPath,
        dispatches,
        { runnerId: "stub-runner", status: "cancelled" },
        "publish",
        { autoPublishOnSuccess: true }
      );

      assert.equal(dispatches.length, 0, "a cancelled review must never schedule the publish chain");
      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "expected a Notifications entry offering the manual publish action");
      assert.equal(warning?.actionCommand?.title, "Publish Anyway");
      assert.deepEqual(warning?.actionCommand?.args, [{ taskFolderPath: vscode.Uri.file(folderPath).fsPath }]);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

void describe("Fast Forward Review — the Publish preflight's Completion Checks section is not mistaken for an existing review", () => {
  // Reproduces the defect: publish-review.md can hold ONLY a Completion
  // Checks section — written by upsertCompletionChecksInPublishReview via a
  // prior runCompletionLint persist (e.g. an earlier manual publish attempt
  // or "Fix with AI"; checkPublishPreflight's own scheduling-decision calls
  // are side-effect-free and never write this) — with no review body yet.
  // Before the fix, fastForwardReviewWithAI read that checks-only content as
  // "an existing review with no Readiness line" and refused outright instead
  // of running the initial review it was dispatched to run.
  const samplePassingLint: CompletionLintResult = {
    runAt: "2026-01-01T00:00:00.000Z",
    passed: true,
    summary: "All checks passed.",
    issueCount: 0,
    failedChecks: [],
    missingScripts: [],
  };

  void it("isUnusableAsExistingReview treats checks-only publish-review.md content as no review yet", async () => {
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-checks-only-"));
    const fsBridge = installFsBridge();
    try {
      await upsertCompletionChecksInPublishReview(vscode.Uri.file(folderPath), samplePassingLint);
      const written = fs.readFileSync(path.join(folderPath, "publish-review.md"), "utf8");
      assert.ok(written.includes("Completion Checks"), "sanity: the checks section was written");
      assert.equal(
        written.includes("Readiness:"),
        false,
        "sanity: a checks-only file has no Readiness line"
      );
      assert.equal(
        isUnusableAsExistingReview(written),
        true,
        "checks-only content must not be treated as a usable existing review"
      );
    } finally {
      fsBridge.restore();
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  });

  void it("isUnusableAsExistingReview treats an actual AI review (with a Readiness line) as usable", () => {
    const realReview = "Readiness: 9/10\n\n- Looks good.\n";
    assert.equal(isUnusableAsExistingReview(realReview), false);
  });

  void it("isUnusableAsExistingReview treats a real review merged with a Completion Checks section as usable", async () => {
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-checks-plus-review-"));
    const fsBridge = installFsBridge();
    try {
      fs.writeFileSync(
        path.join(folderPath, "publish-review.md"),
        "Readiness: 9/10\n\n- Looks good.\n",
        "utf8"
      );
      await upsertCompletionChecksInPublishReview(vscode.Uri.file(folderPath), samplePassingLint);
      const written = fs.readFileSync(path.join(folderPath, "publish-review.md"), "utf8");
      assert.ok(written.includes("Readiness: 9/10"), "the AI review body must survive the merge");
      assert.equal(
        isUnusableAsExistingReview(written),
        false,
        "an actual review merged with the checks section must remain usable"
      );
    } finally {
      fsBridge.restore();
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  });
});

void describe("Publish auto-run ownership matrix — manual entry routes (command-level)", () => {
  void it("setTaskStage: manual jump onto Publish is entry-owned — dispatches auto-publish directly with { taskFolderPath }", async () => {
    const { folderPath } = makeTaskFolder(`jump-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const inv = makeInventoryStub(folderPath, "impl-low-review");
    const currentStore = makeCurrentTaskStoreStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({ ok: true, lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] } })),
    ];
    try {
      await setTaskStage(inv, currentStore, { taskFolderPath: folderPath, stage: "publish" }, "jump");

      assert.equal(dispatches.length, 1, "exactly one scheduling owner for a manual jump onto Publish");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.commitAndPushTask");
      assert.equal(dispatches[0]?.chainId, "auto-publish");
      assert.deepEqual(dispatches[0]?.arg, { taskFolderPath: folderPath });
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("setTaskStage: manual jump onto Publish never dispatches when the preflight fails, and warns with Publish Anyway instead", async () => {
    const { folderPath } = makeTaskFolder(`jump-fail-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const inv = makeInventoryStub(folderPath, "impl-low-review");
    const currentStore = makeCurrentTaskStoreStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({ ok: false, reason: "Completion checks did not pass." })),
    ];
    try {
      await setTaskStage(inv, currentStore, { taskFolderPath: folderPath, stage: "publish" }, "jump");

      assert.equal(dispatches.length, 0, "a failed preflight must never schedule the publish chain");
      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "expected a Notifications entry offering the manual publish action");
      assert.equal(warning?.actionCommand?.title, "Publish Anyway");
      assert.deepEqual(warning?.actionCommand?.args, [{ taskFolderPath: folderPath }]);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("nextStage: triggers-AI off — entry-owned, dispatches auto-publish directly after lint, no Publish review", async () => {
    const { folderPath } = makeTaskFolder(`nextstage-off-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => false),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({ ok: true, lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] } })),
    ];
    try {
      await nextStage(
        vscode.Uri.file(folderPath),
        {} as vscode.ExtensionContext,
        {
          task: {
            folderUri: vscode.Uri.file(folderPath),
            folderName: path.basename(folderPath),
            progress: {
              taskFolder: path.basename(folderPath),
              currentStage: "impl-low-review",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }
      );

      assert.equal(dispatches.length, 1, "exactly one scheduling owner — triggers-AI off is entry-owned");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.commitAndPushTask");
      assert.equal(dispatches[0]?.chainId, "auto-publish");
      assert.deepEqual(dispatches[0]?.arg, { taskFolderPath: folderPath });
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("nextStage: the keyboard-shortcut invocation (no tree-item arg) resolves the current task from CurrentTaskStore and actually advances it, exactly like the tree-button click", async () => {
    // Ctrl+Shift+Alt+N invokes vs-code-ai-helper.nextStage with no argument —
    // registerCommand's handler receives node === undefined, unlike a tree
    // inline-button click which always carries a TaskNodeArg. This exercises
    // resolveTask's no-arg fallback (single-eligible-task auto-pick, guarded
    // by CurrentTaskStore) end-to-end through the real command handler, the
    // same path a user's keypress takes.
    //
    // Uses its own isolated temp root (not the shared REAL_ROOT) because
    // resolveTask's no-arg fallback scans the *entire* legacy "plans/"
    // folder for eligible tasks: reusing REAL_ROOT would pick up every
    // fixture task folder left behind by other tests in this file at the
    // same stage, making "exactly one eligible task" untestable here.
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-nextstage-kbd-"));
    const { folderPath } = (() => {
      const folder = path.join(isolatedRoot, "plans", "solo-task");
      fs.mkdirSync(folder, { recursive: true });
      const progress: TaskProgress = {
        taskFolder: "solo-task",
        currentStage: "impl-low-review",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
      fs.writeFileSync(path.join(folder, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
      fs.writeFileSync(path.join(folder, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
      fs.writeFileSync(path.join(folder, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");
      return { folderPath: folder };
    })();
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const readDirBridge = installReadDirectoryBridge();
    const ws = vscode.workspace as unknown as Record<string, unknown>;
    const origWorkspaceFolders = ws.workspaceFolders;
    ws.workspaceFolders = [{ uri: vscode.Uri.file(isolatedRoot), name: "root", index: 0 }];
    const dispatches: AutomationDispatch[] = [];
    const context = {
      extensionUri: vscode.Uri.file(isolatedRoot),
      workspaceState: {
        // Production always stores the normalized canonical ID here (see
        // taskRoot.ts's discoverAllTasks / setTaskStage.ts's
        // currentTaskStore.set(task.canonicalId)) — never the raw fsPath.
        get: (key: string): string | undefined => (key === "vs-code-ai-helper.currentTaskCanonicalId" ? normalizePath(folderPath) : undefined),
        update: async (): Promise<void> => { /* no-op */ },
      },
    } as unknown as vscode.ExtensionContext;
    const patches: Patched[] = [
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => false),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({ ok: true, lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] } })),
    ];
    try {
      await nextStage(vscode.Uri.file(isolatedRoot), context, undefined);

      assert.equal(dispatches.length, 1, "the keyboard shortcut must resolve the current task and actually dispatch the same advance a tree-button click would");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.commitAndPushTask");
      assert.equal(dispatches[0]?.chainId, "auto-publish");
      assert.deepEqual(dispatches[0]?.arg, { taskFolderPath: folderPath });
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      ws.workspaceFolders = origWorkspaceFolders;
      readDirBridge.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  void it("nextStage: triggers-AI on — review-owned, dispatches exactly one Publish review carrying autoPublishOnSuccess, never a direct publish chain", async () => {
    const { folderPath } = makeTaskFolder(`nextstage-on-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => true),
      patch(settingsModule, "getCompleteAndMoveOnTriggersAIMode", () => "auto"),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      await nextStage(
        vscode.Uri.file(folderPath),
        {} as vscode.ExtensionContext,
        {
          task: {
            folderUri: vscode.Uri.file(folderPath),
            folderName: path.basename(folderPath),
            progress: {
              taskFolder: path.basename(folderPath),
              currentStage: "impl-low-review",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }
      );

      assert.equal(dispatches.length, 1, "exactly one scheduling owner — triggers-AI on is review-owned");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
      const arg = dispatches[0]?.arg as { autoPublishOnSuccess?: boolean; taskFolderPath?: string } | undefined;
      assert.equal(arg?.autoPublishOnSuccess, true, "the follow-up Publish review must own auto-publish");
      assert.equal(arg?.taskFolderPath, folderPath);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a manual Publish review dispatched WITHOUT autoPublishOnSuccess never auto-publishes, even on a passing score", async () => {
    const { folderPath } = makeTaskFolder(`manual-review-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      // reviewOptions omits autoPublishOnSuccess entirely — simulates a plain
      // manual "Run Review with AI" click on the Publish stage, not a
      // dispatch that threaded the auto-publish flag through.
      await runPassingReview(
        folderPath,
        dispatches,
        "Readiness: 9/10\n\n- Ready.\n",
        "publish",
        {}
      );

      assert.equal(
        dispatches.length,
        0,
        "a manual review run without autoPublishOnSuccess must never schedule the publish chain, even at a passing score"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("suppressAutoPublishDispatch on a passing, autoPublishOnSuccess-flagged review still suppresses the dispatch", async () => {
    const { folderPath } = makeTaskFolder(`suppressed-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runPassingReview(
        folderPath,
        dispatches,
        "Readiness: 9/10\n\n- Ready.\n",
        "publish",
        { autoPublishOnSuccess: true, suppressAutoPublishDispatch: true }
      );

      assert.equal(
        dispatches.length,
        0,
        "suppressAutoPublishDispatch must override a passing score + autoPublishOnSuccess and prevent dispatch"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

void describe("Publish auto-run ownership matrix — passing review, composite, reopen, and execution-time recheck", () => {
  void it("a passing, autoPublishOnSuccess-flagged Publish review dispatches auto-publish directly with { taskFolderPath }", async () => {
    const { folderPath } = makeTaskFolder(`passing-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runPassingReview(
        folderPath,
        dispatches,
        "Readiness: 9/10\n\n- Ready.\n",
        "publish",
        { autoPublishOnSuccess: true }
      );

      assert.equal(dispatches.length, 1, "a passing, flagged Publish review must schedule exactly one publish chain");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.commitAndPushTask");
      assert.equal(dispatches[0]?.chainId, "auto-publish");
      assert.deepEqual(dispatches[0]?.arg, { taskFolderPath: folderPath });
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("completeCommitAndPushTask (the composite command): never dispatches a separate auto-publish chain — it commits inline instead", async () => {
    const folderName = `composite-${Math.floor(Math.random() * 1e9)}`;
    const folderPath = path.join(REAL_ROOT, "plans", folderName);
    fs.mkdirSync(folderPath, { recursive: true });
    const progress: TaskProgress = {
      taskFolder: folderName,
      currentStage: "impl-low-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const inv = makeLiveInventoryStub(folderPath);
    const currentStore = makeCurrentTaskStoreStub();
    const dispatches: AutomationDispatch[] = [];
    let gitReadinessCalls = 0;
    const patches: Patched[] = [
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      // The composite's own internal advance to Publish uses transition kind
      // "complete-commit-push", which AUTO_PUBLISH_ELIGIBLE_KINDS hard-excludes
      // (stageTransition.ts) — so no `shouldAutoPublish`-gated scheduling path
      // is even reachable here. What must be proven at the COMMAND level is
      // that the composite instead calls commitAndPushTask inline (which never
      // itself calls scheduleAutomationChain — see grep of commitAndPushTask.ts)
      // and that its own fresh git-readiness recheck actually runs.
      patch(gitRepoInfoModule, "checkGitPublishReadiness", (): Promise<{ ok: false; reason: string }> => {
        gitReadinessCalls += 1;
        return Promise.resolve({ ok: false, reason: "stub: no git repository for this test" });
      }),
      patch(vscode.window as unknown as Record<string, unknown>, "showErrorMessage", () => Promise.resolve(undefined)),
    ];
    try {
      await completeCommitAndPushTask(inv, { taskFolderPath: folderPath }, currentStore, undefined);

      assert.equal(dispatches.length, 0, "the composite must never schedule a separate auto-publish chain");
      assert.ok(gitReadinessCalls >= 1, "expected the composite to fall through into commitAndPushTask's own fresh git-readiness recheck");
      const written = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(written.currentStage, "publish", "the composite's own advance to Publish must persist even though the nested commit step then failed");
      assert.equal(written.status, "completed", "the composite must mark the task completed before attempting commit and push");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("reopening a completed task onto Publish (setTaskStage on a completed task) never dispatches auto-publish", async () => {
    const folderName = `reopen-${Math.floor(Math.random() * 1e9)}`;
    const folderPath = path.join(REAL_ROOT, "plans", folderName);
    fs.mkdirSync(folderPath, { recursive: true });
    const completedAt = "2026-01-02T00:00:00.000Z";
    const progress: TaskProgress = {
      taskFolder: folderName,
      currentStage: "publish",
      status: "completed",
      completedAt,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const inv = makeInventoryStub(folderPath, "publish", "completed", completedAt);
    const currentStore = makeCurrentTaskStoreStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      await setTaskStage(inv, currentStore, { taskFolderPath: folderPath, stage: "publish" }, "jump");

      assert.equal(dispatches.length, 0, "reopening a completed task must never dispatch the publish chain");
      const written = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(written.status, "active", "reopening must reactivate the task");
      assert.equal(written.currentStage, "publish");
      assert.equal(written.completedAt, undefined, "reopening must clear completedAt");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("execution-time recheck: commitAndPushTask re-verifies git readiness fresh every run, so a state change after scheduling is still caught", async () => {
    const { folderPath } = makeTaskFolder(`race-${Math.floor(Math.random() * 1e9)}`, "publish");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const inv = makeLiveInventoryStub(folderPath);
    const currentStore = makeCurrentTaskStoreStub();
    let gitReadinessCalls = 0;
    const patches: Patched[] = [
      // At scheduling time (setTaskStage.ts / reviewActions.ts) checkPublishPreflight
      // would have observed a clean, push-ready repo — but between scheduling and
      // this dispatched command actually running, the branch/remote state changed
      // (e.g. the branch was deleted, or the remote was removed). commitAndPushTask
      // must not trust the scheduling-time decision — it re-derives git readiness
      // itself, fresh, on every invocation.
      patch(gitRepoInfoModule, "checkGitPublishReadiness", (): Promise<{ ok: false; reason: string }> => {
        gitReadinessCalls += 1;
        return Promise.resolve({ ok: false, reason: "branch was deleted between scheduling and execution (test)" });
      }),
    ];
    try {
      await commitAndPushTask(inv, { taskFolderPath: folderPath }, currentStore, undefined);

      assert.equal(gitReadinessCalls, 1, "expected exactly one fresh git-readiness recheck at execution time");
      // The failure is now routed to the internal Notifications panel
      // (NotificationRouter.showError) rather than a native VS Code toast.
      const entries = (provider.getChildren() ?? []) as Array<{ message?: string }>;
      const capturedErrorMessage = entries.find((e) =>
        typeof e.message === "string" && e.message.includes("branch was deleted between scheduling and execution")
      )?.message;
      assert.ok(
        capturedErrorMessage,
        "expected the execution-time recheck's failure reason to be surfaced, proving publishing did not silently proceed"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

/**
 * Regression coverage: every scheduling-decision call site that decides
 * whether to auto-publish must call checkPublishPreflight with the SAME
 * relevantFiles scope (the task's implReviewFiles) that the execution-time
 * recheck in commitAndPushTask.ts uses. completionLint.ts substitutes a
 * different file set (git-modified ∪ open editors) whenever relevantFiles is
 * omitted, so a call site that forgets to pass it can pass or fail against
 * different state than the recheck sees for the identical task — a false
 * green (scheduled here, fails at execution) or false red (skipped here,
 * would have succeeded at execution) for exactly the same task at the same
 * instant.
 */
void describe("Publish auto-run ownership matrix — implReviewFiles scope consistency", () => {
  const scopeFiles = ["src/only-tracked-by-impl-review.ts"];

  async function captureRelevantFiles(run: () => Promise<void>): Promise<Array<readonly string[] | undefined>> {
    const calls: Array<readonly string[] | undefined> = [];
    const preflightPatch = patch(
      publishPreflightModule,
      "checkPublishPreflight",
      (_uri: vscode.Uri, relevantFiles?: readonly string[]) => {
        calls.push(relevantFiles);
        return Promise.resolve({
          ok: true,
          lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] },
        });
      }
    );
    try {
      await run();
    } finally {
      preflightPatch.restore();
    }
    return calls;
  }

  void it("setTaskStage: manual jump onto Publish scopes the preflight to the task's implReviewFiles", async () => {
    const { folderPath } = makeTaskFolder(`scope-jump-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const inv = makeInventoryStub(folderPath, "impl-low-review", "active", undefined, scopeFiles);
    const currentStore = makeCurrentTaskStoreStub();
    const dispatchPatch = patch(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> => Promise.resolve(true));
    try {
      const calls = await captureRelevantFiles(() =>
        setTaskStage(inv, currentStore, { taskFolderPath: folderPath, stage: "publish" }, "jump")
      );
      assert.equal(calls.length, 1, "expected exactly one checkPublishPreflight call");
      assert.deepEqual(calls[0], scopeFiles);
    } finally {
      dispatchPatch.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("nextStage (triggers-AI off, entry-owned): scopes the preflight to the task's implReviewFiles", async () => {
    const { folderPath } = makeTaskFolder(`scope-nextstage-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const progressPath = path.join(folderPath, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    progress.implReviewFiles = scopeFiles;
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const patches: Patched[] = [
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => false),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () => Promise.resolve(new Set(REVIEW_STAGES))),
      patch(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> => Promise.resolve(true)),
    ];
    try {
      const calls = await captureRelevantFiles(() =>
        nextStage(
          vscode.Uri.file(folderPath),
          {} as vscode.ExtensionContext,
          {
            task: {
              folderUri: vscode.Uri.file(folderPath),
              folderName: path.basename(folderPath),
              progress: {
                taskFolder: path.basename(folderPath),
                currentStage: "impl-low-review",
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          }
        )
      );
      assert.equal(calls.length, 1, "expected exactly one checkPublishPreflight call");
      assert.deepEqual(calls[0], scopeFiles);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("auto-advance onto Publish (plain 'auto' mode, entry-owned): scopes the preflight to the task's implReviewFiles", async () => {
    const { folderPath } = makeTaskFolder(`scope-autoadvance-${Math.floor(Math.random() * 1e9)}`);
    const progressPath = path.join(folderPath, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    progress.implReviewFiles = scopeFiles;
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      const calls = await captureRelevantFiles(() => runPassingReview(folderPath, dispatches));
      assert.equal(calls.length, 1, "expected exactly one checkPublishPreflight call");
      assert.deepEqual(calls[0], scopeFiles);
      assert.equal(dispatches.length, 1, "expected the entry-owned auto-publish chain to still be scheduled");
      assert.equal(dispatches[0]?.chainId, "auto-publish");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

/**
 * Regression coverage for a real production bug: a primary model that exits
 * cleanly (status "completed") but with unusable review content — no
 * "Readiness: N/10" line — is invisible to resolveRunnerForModel's own
 * quota/unavailable-triggered backup cascade, since that wrapper only reacts
 * to CliExecResult.status/failureKind. Verified live: opencode's
 * "opencode-go/kimi-k3" backup model did exactly this (a truncated
 * mid-generation response, still exit-0) when rate-limited, and the review
 * was rejected with no automatic retry against the task's other configured
 * backup models — the user had to notice and manually re-run the review,
 * which just retried the same flaky primary again. runAiToFile now retries
 * the stage's configured backups itself when content validation rejects the
 * primary's output.
 */
void describe("Review generation — content-validation failure falls back to a configured backup model", () => {
  void it("primary returns clean status but no Readiness line: retries a configured backup and promotes its valid output", async () => {
    const { folderPath } = makeTaskFolder(`content-fallback-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    let primaryRunCount = 0;
    let backupRunCount = 0;
    let backupListReadCount = 0;
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        primaryRunCount += 1;
        // No "Readiness: N/10" line — the exact shape a rate-limited free-tier
        // model returned live (a response truncated mid-generation, still
        // exit 0), which validateReviewOutput rejects.
        await fs.promises.writeFile(request.outputFile.fsPath, "I'll verify the plan's claims before scoring.", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 47 characters" };
      },
    };
    const backupRunner = {
      id: "backup-stub-runner",
      label: "Backup Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        backupRunCount += 1;
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 8/10\n\n- Ready to proceed.\n", "utf8");
        return { runnerId: "backup-stub-runner", status: "completed", summary: "Generated 40 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      // The primary attempt is resolved with a defined `stage` argument;
      // runAiToFile's content-validation retry resolves each backup with
      // `stage: undefined` (mirrors runSecondOpinionReview, so a backup is
      // never wrapped in its own nested quota cascade) — that difference is
      // exactly what this stub keys off of to hand back the right runner.
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: backupRunner, provider: "backup-cli", providerLabel: "Backup Stub Provider", nativeModelId: undefined }
          : { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined }),
      patch(runnerRegistryModule, "backupModelsForStage", () => {
        backupListReadCount += 1;
        return ["backup-cli:model"];
      }),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(primaryRunCount, 1, "the primary should be tried exactly once");
      assert.equal(backupRunCount, 1, "the backup should be tried exactly once after the primary's content was rejected");
      assert.equal(backupListReadCount, 1, "the disclosed backup list must be snapshotted once and reused for retries");
      assert.equal(dispatches.length, 0, "isAutoAdvanceEnabled is off, so no automation chain should fire");

      const reviewContent = fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8");
      assert.match(reviewContent, /Readiness: 8\/10/, "the backup's valid review must be promoted, not the primary's rejected text");
      assert.doesNotMatch(reviewContent, /verify the plan's claims/, "the primary's rejected content must not survive into the artifact");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("primary and its one configured backup both return content with no Readiness line: tries both, publishes nothing, and blames the backup (the last one actually tried) rather than the primary", async () => {
    const { folderPath } = makeTaskFolder(`content-fallback-exhausted-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    let primaryRunCount = 0;
    let backupRunCount = 0;
    const invalidPrimaryRunner = {
      id: "invalid-primary-stub-runner",
      label: "Invalid Primary Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        primaryRunCount += 1;
        await fs.promises.writeFile(request.outputFile.fsPath, "(no text reply)", "utf8");
        return { runnerId: "invalid-primary-stub-runner", status: "completed", summary: "Generated 16 characters" };
      },
    };
    const invalidBackupRunner = {
      id: "invalid-backup-stub-runner",
      label: "Invalid Backup Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        backupRunCount += 1;
        await fs.promises.writeFile(request.outputFile.fsPath, "Also just a clarifying question.", "utf8");
        return { runnerId: "invalid-backup-stub-runner", status: "completed", summary: "Generated 33 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: invalidBackupRunner, provider: "backup-cli", providerLabel: "Invalid Backup Provider", nativeModelId: undefined }
          : { runner: invalidPrimaryRunner, provider: "primary-cli", providerLabel: "Invalid Primary Provider", nativeModelId: undefined }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(vscode.window as unknown as Record<string, unknown>, "showErrorMessage", () => Promise.resolve(undefined)),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(primaryRunCount, 1, "the primary must be tried exactly once");
      assert.equal(backupRunCount, 1, "the one configured backup must be tried exactly once");
      assert.equal(dispatches.length, 0, "nothing usable was ever produced, so no automation chain should fire");
      assert.equal(fs.existsSync(path.join(folderPath, "impl-low-review.md")), false, "no review artifact should be published when every candidate is rejected");

      const errorEntry = provider.getEntries().find((entry) => entry.level === "error");
      assert.ok(errorEntry, "expected an error entry reporting the failed generation");
      assert.match(
        errorEntry.message,
        /Invalid Backup Provider/,
        "the failure message must blame the backup that was actually last tried, not the primary"
      );
      assert.doesNotMatch(
        errorEntry.message,
        /Invalid Primary Provider/,
        "the failure message must not misattribute the backup's rejection reason to the primary"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("the model that already ran (reported with no modelId, i.e. a CLI provider's own default) is not re-run when it also appears in the backup list as '<provider>:default'", async () => {
    // Regression coverage: qualifiedRanModelId used to bail out (return
    // undefined) whenever the reported modelId was undefined, which is
    // exactly what every CLI provider's "(CLI default)" catalog entry
    // reports back — silently defeating the dedup for the most common
    // configuration shape (six providers ship one of these entries).
    const { folderPath } = makeTaskFolder(`content-fallback-default-dedup-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const attemptedBackupModelIds: string[] = [];
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        // Simulates resolveRunnerForModel's own quota cascade having already
        // silently substituted "opencode-cli"'s own default model (a real
        // CLI provider id — getCliProvider("opencode-cli") is genuinely
        // registered, unstubbed here) before returning this content-invalid
        // result. A CliAgentRunner reports an unconfigured/"default" native
        // id back as modelId: undefined (see cliAgentRunner.ts).
        return { runnerId: "opencode-cli", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const claudeBackupRunner = {
      id: "claude-cli",
      label: "Claude Backup",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "claude-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string, stage: TaskStage | undefined) => {
        if (stage === undefined) {
          attemptedBackupModelIds.push(modelId);
          return { runner: claudeBackupRunner, provider: "claude-cli", providerLabel: "Claude Backup", nativeModelId: undefined };
        }
        return { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined };
      }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["opencode-cli:default", "claude-cli:sonnet"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.deepEqual(
        attemptedBackupModelIds,
        ["claude-cli:sonnet"],
        "opencode-cli:default must be skipped as the model that already ran, not re-invoked"
      );
      const reviewContent = fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8");
      assert.match(reviewContent, /Readiness: 9\/10/, "the real, un-skipped backup's valid review must be promoted");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("the model that already ran under its canonical (post-alias) name is not re-run when the backup list stores it under its legacy alias", async () => {
    // Regression coverage: qualifiedRanModelId used to join runnerId:modelId
    // literally, but a CLI provider's modelId is the ALIAS-RESOLVED name
    // (parseModelSelection applies legacyModelAliases before returning it),
    // while a backup list entry may still be stored under the raw legacy
    // key — the two would never compare equal without normalizing both
    // through normalizeQualifiedModelId first.
    const { folderPath } = makeTaskFolder(`content-fallback-alias-dedup-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const attemptedBackupModelIds: string[] = [];
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        // "antigravity-cli" is a real, unstubbed provider whose
        // legacyModelAliases maps "gemini-3.5-flash-medium" (the old stored
        // key) to "Gemini 3.5 Flash (Medium)" (the canonical name it now
        // reports back — see providers.ts).
        return { runnerId: "antigravity-cli", status: "completed", modelId: "Gemini 3.5 Flash (Medium)", summary: "Generated 23 characters" };
      },
    };
    const claudeBackupRunner = {
      id: "claude-cli",
      label: "Claude Backup",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "claude-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string, stage: TaskStage | undefined) => {
        if (stage === undefined) {
          attemptedBackupModelIds.push(modelId);
          return { runner: claudeBackupRunner, provider: "claude-cli", providerLabel: "Claude Backup", nativeModelId: undefined };
        }
        return { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined };
      }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["antigravity-cli:gemini-3.5-flash-medium", "claude-cli:sonnet"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.deepEqual(
        attemptedBackupModelIds,
        ["claude-cli:sonnet"],
        "the legacy-aliased antigravity entry must be skipped as the model that already ran, not re-invoked"
      );
      const reviewContent = fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8");
      assert.match(reviewContent, /Readiness: 9\/10/, "the real, un-skipped backup's valid review must be promoted");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a stage configured with strategy 'pause-and-resume' performs zero backup retries on content-validation failure (real, unstubbed backupModelsForStage)", async () => {
    // End-to-end coverage for the strategy gate itself: the previous tests
    // in this file all stub backupModelsForStage directly, which proves the
    // retry loop calls SOME backup source but never actually exercises the
    // real function's "switch-to-backup"-only gate — reverting the fix back
    // to the strategy-agnostic getConfiguredBackupModelsForStage would leave
    // every other test in this suite green. This test uses the real
    // backupModelsForStage (via a real modelSettings config) so that
    // regression would be caught.
    const { folderPath } = makeTaskFolder(`content-fallback-strategy-gate-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    let backupAttempts = 0;
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      // A real modelSettings config for "impl-low-review" with backups
      // present but strategy "pause-and-resume" — the real backupModelsForStage
      // (unstubbed) must return [] for this, per its own gate.
      patch(settingsModule, "getModelSettings", () => ({
        "impl-low-review": {
          primary: "primary-cli:model",
          backups: ["claude-cli:sonnet"],
          strategy: "pause-and-resume",
        },
      })),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) => {
        if (stage === undefined) {
          backupAttempts += 1;
        }
        return { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined };
      }),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
      patch(vscode.window as unknown as Record<string, unknown>, "showErrorMessage", () => Promise.resolve(undefined)),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(backupAttempts, 0, "a stage that opted out of automatic switch-over must see zero backup attempts, even with backups configured");
      assert.equal(fs.existsSync(path.join(folderPath, "impl-low-review.md")), false, "no review artifact should be published");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a backup with a quota-exhausted observation recorded during THIS call's own primary run is skipped, while one with only a stale observation from earlier in the session still is", async () => {
    // Regression coverage: the skip must be gated on the observation having
    // been recorded during this specific call, not on a fixed recency
    // window — an agentic CLI candidate can easily run longer than any fixed
    // window, ageing out a moments-ago observation before this loop ever
    // reaches it, while quotaObservations (utils/quota.ts) is documented as
    // "a live signal, not a persisted ledger" with no expiry of its own, so
    // an observation left over from earlier in the same extension-host
    // session (a quota window that has long since reset) must not
    // permanently disqualify a backup either. This test pins both halves:
    // backup-a's observation is recorded from INSIDE the primary's own run()
    // — simulating resolveRunnerForModel's own cascade having burned it
    // moments earlier in this exact call — and must still gate; backup-b's
    // observation is recorded before the call even starts — simulating a
    // stale leftover from earlier in the session — and must not.
    const { folderPath } = makeTaskFolder(`content-fallback-quota-skip-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    __quotaTestOnly.clear();
    // Recorded an hour before the call even starts — must NOT gate the
    // skip; this backup must still be tried.
    __quotaTestOnly.setObservation("impl-low-review", "backup-b-cli:model", {
      state: "unavailable",
      observedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const attemptedBackupModelIds: string[] = [];
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        // Simulates resolveRunnerForModel's own quota cascade (inside this
        // same primary run() call) having already tried and quota-failed
        // backup-a moments ago, in this exact call.
        recordQuotaObservation("impl-low-review", "backup-a-cli:model", "quota", "quota exceeded");
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const backupBRunner = {
      id: "backup-b-cli",
      label: "Backup B Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "backup-b-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string, stage: TaskStage | undefined) => {
        if (stage === undefined) {
          attemptedBackupModelIds.push(modelId);
          return { runner: backupBRunner, provider: "backup-b-cli", providerLabel: "Backup B Provider", nativeModelId: undefined };
        }
        return { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined };
      }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-a-cli:model", "backup-b-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.deepEqual(
        attemptedBackupModelIds,
        ["backup-b-cli:model"],
        "backup-a (recent exhausted observation) must be skipped; backup-b (stale observation) must still be tried"
      );
      const reviewContent = fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8");
      assert.match(reviewContent, /Readiness: 9\/10/, "the un-skipped backup's valid review must be promoted");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
      __quotaTestOnly.clear();
    }
  });

  void it("a successful backup retry atomically persists fallbackActive/fallbackModelId for the stage", async () => {
    // The claim and model write are one locked compare-and-set. This pins the
    // observable outcome for the common case (nothing else holds the
    // reservation): the persisted state after a promoted backup must name
    // that exact backup, the same contract resolveRunnerForModel's own quota
    // cascade provides for a quota-triggered switch.
    const { folderPath } = makeTaskFolder(`content-fallback-persist-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const backupRunner = {
      id: "backup-cli",
      label: "Backup Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 8/10\n\n- Ready.\n", "utf8");
        return { runnerId: "backup-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: backupRunner, provider: "backup-cli", providerLabel: "Backup Stub Provider", nativeModelId: undefined }
          : { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      const progress = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      assert.equal(
        progress.fallbackActive?.["impl-low-review"],
        true,
        "fallbackActive must be persisted for the stage once a backup's output is promoted"
      );
      assert.equal(
        progress.fallbackModelId?.["impl-low-review"],
        "backup-cli:model",
        "fallbackModelId must record which backup actually served the stage"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a preserved active fallback that returns invalid content is replaced by the next backup that validates", async () => {
    const { folderPath } = makeTaskFolder(`content-fallback-replace-active-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const progressPath = path.join(folderPath, "task-progress.json");
    const existingProgress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    existingProgress.fallbackActive = { "impl-low-review": true };
    existingProgress.fallbackModelId = { "impl-low-review": "active-cli:model" };
    fs.writeFileSync(progressPath, JSON.stringify(existingProgress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const activeRunner = {
      id: "active-cli",
      label: "Active Fallback Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return {
          runnerId: "active-cli",
          status: "completed",
          modelId: "model",
          summary: "Generated 23 characters",
        };
      },
    };
    const backupRunner = {
      id: "backup-cli",
      label: "Backup Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 8/10\n\n- Ready.\n", "utf8");
        return { runnerId: "backup-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "active-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: backupRunner, provider: "backup-cli", providerLabel: "Backup Provider", nativeModelId: undefined }
          : { runner: activeRunner, provider: "active-cli", providerLabel: "Active Fallback Provider", nativeModelId: "model" }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        { preserveActiveFallback: true }
      );

      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
      assert.equal(progress.fallbackActive?.["impl-low-review"], true);
      assert.equal(
        progress.fallbackModelId?.["impl-low-review"],
        "backup-cli:model",
        "the next iteration should start directly from the backup whose content validated"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a backup retry does not overwrite a pre-existing fallback reservation held by a different run", async () => {
    // The retry loop's atomic write may replace an active model when this
    // call's own primary-resolution cascade selected it, or when a preserved
    // Fast Forward iteration deliberately started from that exact route.
    // Neither applies here: the primary genuinely ran and reported itself,
    // exactly as this test's stub does. A pre-existing reservation made by a
    // genuinely different run (e.g. another VS Code window) must therefore
    // still be respected: this run's own backup content is promoted locally,
    // but the persisted fallbackModelId is not clobbered.
    const { folderPath } = makeTaskFolder(`content-fallback-preexisting-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const progressPath = path.join(folderPath, "task-progress.json");
    const existingProgress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    existingProgress.fallbackActive = { "impl-low-review": true };
    existingProgress.fallbackModelId = { "impl-low-review": "someone-elses-cli:model" };
    fs.writeFileSync(progressPath, JSON.stringify(existingProgress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      // No modelId on the result (same shape the sibling "persists
      // fallbackActive/fallbackModelId" test above uses): qualifiedRanModelId
      // then returns undefined, so primaryCascadeAlreadySubstitutedBackup is
      // false — this run's own primary genuinely ran, no internal cascade
      // substitution — exercising the unreserved-only CAS path.
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const backupRunner = {
      id: "backup-cli",
      label: "Backup Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 8/10\n\n- Ready.\n", "utf8");
        return { runnerId: "backup-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: backupRunner, provider: "backup-cli", providerLabel: "Backup Stub Provider", nativeModelId: undefined }
          : { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      const reviewContent = fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8");
      assert.match(
        reviewContent,
        /Readiness: 8\/10/,
        "the validated backup content must still be promoted for THIS run regardless of who owns the reservation"
      );

      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
      assert.equal(
        progress.fallbackModelId?.["impl-low-review"],
        "someone-elses-cli:model",
        "a pre-existing reservation held by a different run must not be overwritten by this run's own backup search"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a backup that returns status 'cancelled' during the content-validation retry reports a cancellation, not a validation-failure error, and records no false quota observation", async () => {
    // Regression coverage for two related bugs: (1) recordQuotaObservation
    // used to run unconditionally before the cancelled check, so a
    // cancellation — which never actually observed the provider's quota
    // state — was recorded as a healthy "ok" observation; (2) a cancelled
    // backup result must surface the same "generation cancelled" message the
    // primary path already gives for the identical user action, not the
    // generic "did not produce a valid result" validation-failure error.
    const { folderPath } = makeTaskFolder(`content-fallback-cancel-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    __quotaTestOnly.clear();

    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const cancelledBackupRunner = {
      id: "cancelled-backup-stub-runner",
      label: "Cancelled Backup Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: (): Promise<AgentRunResult> =>
        Promise.resolve({ runnerId: "cancelled-backup-stub-runner", status: "cancelled" }),
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: cancelledBackupRunner, provider: "backup-cli", providerLabel: "Cancelled Backup Provider", nativeModelId: undefined }
          : { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(fs.existsSync(path.join(folderPath, "impl-low-review.md")), false, "no artifact should be published when the only backup was cancelled");
      assert.equal(dispatches.length, 0, "nothing was ever produced, so no automation chain should fire");

      const infoEntry = provider.getEntries().find((entry) => entry.level === "info" && /cancelled/i.test(entry.message));
      assert.ok(infoEntry, "expected an information entry reporting cancellation");
      const errorEntry = provider.getEntries().find((entry) => entry.level === "error");
      assert.equal(errorEntry, undefined, "a cancelled backup must not be reported as a validation-failure error");
      assert.equal(
        getQuotaObservation("impl-low-review", "backup-cli:model"),
        undefined,
        "a cancelled run never observed the provider's quota state and must not be recorded as ok"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
      __quotaTestOnly.clear();
    }
  });

  void it("when the primary's own cascade already substituted a backup, a further content-validation retry corrects the persisted fallbackModelId instead of being blocked by its own earlier reservation", async () => {
    // Regression coverage for the primaryCascadeAlreadySubstitutedBackup
    // replacement branch, which the
    // sibling "pre-existing reservation" test deliberately does NOT cover
    // (it pins the other side: no substitution, so the real CAS must still
    // apply). Here the primary's OWN result reports a different model than
    // what was requested (simulating resolveRunnerForModel's own internal
    // quota cascade having already substituted a backup and recorded it),
    // with fallbackActive/fallbackModelId already set to that first,
    // content-invalid backup. A second, later backup in the list then
    // produces valid content — the persisted fallbackModelId must be
    // corrected to that one, not left pointing at the known-bad model,
    // and must NOT be blocked by the atomic write seeing its own earlier
    // (same-call) reservation as already active.
    const { folderPath } = makeTaskFolder(`content-fallback-correct-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const progressPath = path.join(folderPath, "task-progress.json");
    const existingProgress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    existingProgress.fallbackActive = { "impl-low-review": true };
    existingProgress.fallbackModelId = { "impl-low-review": "already-cli:model" };
    fs.writeFileSync(progressPath, JSON.stringify(existingProgress, null, 2), "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const attemptedBackupModelIds: string[] = [];
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        // Reports back a DIFFERENT model than the configured primary
        // ("primary-cli:model") — simulating the internal cascade having
        // already silently substituted "already-cli:model" (the same one
        // already recorded as fallbackModelId above) before this content
        // was even produced.
        return { runnerId: "primary-stub-runner", status: "completed", modelId: "already-cli:model", summary: "Generated 23 characters" };
      },
    };
    const realBackupRunner = {
      id: "real-backup-cli",
      label: "Real Backup Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 8/10\n\n- Ready.\n", "utf8");
        return { runnerId: "real-backup-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string, stage: TaskStage | undefined) => {
        if (stage === undefined) {
          attemptedBackupModelIds.push(modelId);
          return { runner: realBackupRunner, provider: "real-backup-cli", providerLabel: "Real Backup Provider", nativeModelId: undefined };
        }
        return { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined };
      }),
      // "already-cli:model" (the model that already ran, per the primary's
      // own reported modelId above) must be skipped as already-tried;
      // "real-backup-cli:model" is the one that should actually run.
      patch(runnerRegistryModule, "backupModelsForStage", () => ["already-cli:model", "real-backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.deepEqual(
        attemptedBackupModelIds,
        ["real-backup-cli:model"],
        "already-cli:model must be skipped as already-tried; real-backup-cli:model must be the one actually attempted"
      );
      const reviewContent = fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8");
      assert.match(reviewContent, /Readiness: 8\/10/, "the validated backup content must be promoted");

      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
      assert.equal(
        progress.fallbackModelId?.["impl-low-review"],
        "real-backup-cli:model",
        "fallbackModelId must be CORRECTED to the validated backup, not left pointing at the known-bad model the internal cascade recorded"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a newer review attempt claiming the stage mid-retry stops the loop before spending further backups, publishes nothing, and reports an information notice", async () => {
    // Regression coverage for the reviewAttemptId supersession check, which
    // previously had zero coverage. Configures two backups; the first
    // backup's own stub rewrites task-progress.json's reviewAttemptId (the
    // same technique the existing "paused mid-review" test in this file uses
    // to mutate progress mid-flight), simulating a newer review attempt
    // claiming the stage while this run's retry loop is still in progress.
    // The second backup — which would otherwise produce valid content —
    // must never be attempted.
    const { folderPath } = makeTaskFolder(`content-fallback-superseded-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const progressPath = path.join(folderPath, "task-progress.json");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    let backupBAttempted = false;
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const backupARunner = {
      id: "backup-a-cli",
      label: "Backup A Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        // Simulates a newer review attempt (e.g. a second VS Code window)
        // claiming this stage while this run's own backup A is in flight.
        const current = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
        current.reviewAttemptId = "a-newer-attempt-claimed-this-stage";
        fs.writeFileSync(progressPath, JSON.stringify(current, null, 2), "utf8");
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here either", "utf8");
        return { runnerId: "backup-a-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };
    const backupBRunner = {
      id: "backup-b-cli",
      label: "Backup B Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        backupBAttempted = true;
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "backup-b-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string, stage: TaskStage | undefined) => {
        if (stage === undefined) {
          return modelId === "backup-a-cli:model"
            ? { runner: backupARunner, provider: "backup-a-cli", providerLabel: "Backup A Provider", nativeModelId: undefined }
            : { runner: backupBRunner, provider: "backup-b-cli", providerLabel: "Backup B Provider", nativeModelId: undefined };
        }
        return { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined };
      }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-a-cli:model", "backup-b-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(backupBAttempted, false, "backup B must never be attempted once a newer review attempt has claimed the stage");
      assert.equal(fs.existsSync(path.join(folderPath, "impl-low-review.md")), false, "no artifact should be published");
      assert.equal(dispatches.length, 0, "nothing was ever produced, so no automation chain should fire");

      const infoEntry = provider.getEntries().find(
        (entry) => entry.level === "info" && /newer review attempt/i.test(entry.message)
      );
      assert.ok(infoEntry, "expected an information entry reporting supersession by a newer review attempt");
      const errorEntry = provider.getEntries().find((entry) => entry.level === "error");
      assert.equal(errorEntry, undefined, "supersession must not be reported as a validation-failure error");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a newer review attempt claiming the stage while a valid backup is running cannot persist stale fallback routing", async () => {
    const { folderPath } = makeTaskFolder(`content-fallback-superseded-valid-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const progressPath = path.join(folderPath, "task-progress.json");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    let backupRunCount = 0;
    const primaryRunner = {
      id: "primary-stub-runner",
      label: "Primary Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "no readiness line here", "utf8");
        return { runnerId: "primary-stub-runner", status: "completed", summary: "Generated 23 characters" };
      },
    };
    const backupRunner = {
      id: "backup-cli",
      label: "Backup Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        backupRunCount += 1;
        // Simulates another VS Code window claiming the stage while this
        // otherwise-valid backup response is in flight.
        const current = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
        current.reviewAttemptId = "a-newer-attempt-claimed-this-stage";
        fs.writeFileSync(progressPath, JSON.stringify(current, null, 2), "utf8");
        await fs.promises.writeFile(request.outputFile.fsPath, "Readiness: 9/10\n\n- Ready.\n", "utf8");
        return { runnerId: "backup-cli", status: "completed", summary: "Generated 30 characters" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      patch(runnerRegistryModule, "resolveRunnerForModel", (_modelId: string, stage: TaskStage | undefined) =>
        stage === undefined
          ? { runner: backupRunner, provider: "backup-cli", providerLabel: "Backup Provider", nativeModelId: undefined }
          : { runner: primaryRunner, provider: "primary-cli", providerLabel: "Primary Stub Provider", nativeModelId: undefined }),
      patch(runnerRegistryModule, "backupModelsForStage", () => ["backup-cli:model"]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl-low-review",
        true,
        {}
      );

      assert.equal(backupRunCount, 1, "the configured backup should have started exactly once");
      assert.equal(fs.existsSync(path.join(folderPath, "impl-low-review.md")), false, "a superseded backup result must not be published");
      assert.equal(dispatches.length, 0, "a superseded attempt must not schedule automation");

      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
      assert.equal(progress.fallbackActive?.["impl-low-review"], undefined, "a superseded backup must not activate fallback routing");
      assert.equal(progress.fallbackModelId?.["impl-low-review"], undefined, "a superseded backup must not select a fallback model");

      const infoEntry = provider.getEntries().find(
        (entry) => entry.level === "info" && /newer review attempt/i.test(entry.message)
      );
      assert.ok(infoEntry, "expected an information entry reporting supersession");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
