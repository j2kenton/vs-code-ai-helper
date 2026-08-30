/**
 * Regression coverage for the Publish auto-run ownership matrix (plan area
 * A1), for the "commit and push must never run automatically, only from the
 * user's explicit button click" requirement: `stageTransition.ts` has no
 * `shouldAutoPublish` concept, and neither `ReviewCommandArg` nor
 * `ApplyReviewOptions` carries any auto-publish flag to thread from it — so
 * there is no plumbing left anywhere in this file's call graph that could
 * ever schedule `vs-code-ai-helper.commitAndPushTask` automatically. Landing
 * on Publish, from every entry point covered here, only ever surfaces a
 * manual "Publish" / "Publish Anyway" nudge (a `NotificationRouter.showWarning`
 * pointing at the `commitAndPushTask` command) — the command itself is never
 * dispatched by any of these paths.
 *
 * AUTO_REVIEW_TRANSITIONS deliberately has no entry landing on "publish"
 * (impl-low-review is itself a review stage, not the plain stage the map
 * requires), so `transition.shouldAutoReview` is always false there —
 * whether a follow-up Publish review is dispatched at all is decided
 * directly from the auto-advance mode. wf10 item 14 / Part 7 step 17: this
 * dispatch is unconditional across BOTH modes now — "auto-fast-forward"
 * dispatches the follow-up review+fix loop (`fastForwardReviewWithAI`) and
 * plain "auto" dispatches a single review pass (`runReviewWithAI`); neither
 * mode ever nudges the user to publish manually while a follow-up review can
 * still be scheduled (that nudge only survives as the "could not be started
 * automatically" drop-reason warning when the shared "auto-review" chain slot
 * is unavailable). Either way, nothing this file exercises can ever reach
 * `commitAndPushTask` without the user clicking it — that command is never
 * scheduled automatically by any of these paths.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { isUnusableAsExistingReview, nextStage, resumeReviewInteractionV1, runReviewForFolder } from "../commands/reviewActions";
import { setTaskStage } from "../commands/setTaskStage";
import { commitAndPushTask, completeCommitAndPushTask } from "../commands/commitAndPushTask";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentRunResult } from "../types/agentRunner";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import { ChatViewProvider, ChatInteractionRefV1 } from "../views/chatView";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { getProductionActionConversationOrchestratorV1 } from "../actions/productionTaskActionRuntimeV1";
import type { AutomationDispatch } from "../utils/automationChain";
import { scheduleAutomationChain, resetAutomationChainGuards } from "../utils/automationChain";
import { StatusTreeProvider } from "../views/statusView";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { upsertCompletionChecksReportV1, CompletionLintResult } from "../utils/completionLint";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { normalizePath } from "../utils/taskRoot";
import { __quotaTestOnly } from "../utils/quota";
import {
  computePublishScopeId,
  renderPublishChecksFreshnessStamp,
} from "../utils/publishChecksFreshness";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";

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

// Publish review now refuses to build a prompt unless publish-checks.md
// carries a freshness stamp naming the current commit and verification scope
// (plan PART 2, step 7 — requirePublishChecksFreshnessOrWarnV1 in
// reviewActions.ts) — see makeTaskFolder's `stampPublishChecksFreshnessV1`
// call below for how this file satisfies that gate for its Publish-stage
// fixtures. That requires REAL_ROOT to actually be a git repo with a
// resolvable HEAD; `git init` alone leaves HEAD unborn, so one empty commit
// is made too.
cp.execSync("git init", { cwd: REAL_ROOT, stdio: "ignore" });
cp.execSync(
  'git -c user.email=test@example.invalid -c user.name=test commit --allow-empty -m "init"',
  { cwd: REAL_ROOT, stdio: "ignore" }
);
const REAL_ROOT_HEAD_SHA = cp.execSync("git rev-parse HEAD", { cwd: REAL_ROOT }).toString().trim();

// runReviewForFolder/commitAndPushTask's AI metadata path run through the
// real production coordinator (createProductionTaskActionCoordinatorV1),
// which requires the Chat interaction transaction store to be wired exactly
// as extension.ts does at activation — otherwise
// getProductionActionConversationOrchestratorV1 throws "not wired yet"
// before this file's actual ownership-matrix behavior ever runs.
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-owner-private-"));
// configureWorkflowPrivateStorageRootV1 MUST run (and its `rebuildFileStore()`
// side effect complete) before getWorkflowFileStoreV1() is called below —
// object-literal property evaluation runs top-to-bottom, so folding the
// configure call into the `privateRootId` property here would capture the
// PRE-registration (root-less) fileStore instance and every `begin()` write
// through it would fail closed with `workspaceRootUnsupported`, exactly as
// extension.ts's own activation wiring avoids by registering the root in its
// own statement first (src/extension.ts, `workflowPrivateStorageRootId`).
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

// Never cleaned up before this: every run of this file left its entire
// REAL_ROOT tree (task folders, progress files, review artifacts from every
// `it()` below) behind in the OS temp directory permanently. Across many CI
// and local runs that accumulates into thousands of stale directories in
// os.tmpdir() — the kind of buildup that plausibly compounds the
// filesystem/OS contention already suspected (not confirmed) as a
// contributor to this file's intermittent, non-reproducible-on-demand
// failure under the full suite's ~245 concurrently-spawned test processes.
// `force: true` so a failed/half-written subtree from a killed run doesn't
// turn cleanup itself into a new source of flakiness.
after(() => {
  fs.rmSync(REAL_ROOT, { recursive: true, force: true });
});

/**
 * Satisfy the Publish review freshness gate (plan PART 2, step 7) for a
 * Publish-stage fixture: writes a stamp naming REAL_ROOT_HEAD_SHA (this
 * file's single, never-advancing commit) and the scope this task's
 * `ownership.projectRoot` binding resolves to — `path.dirname(folderPath)`,
 * matching makeTaskFolder's own binding below and the resolver
 * requirePublishChecksFreshnessOrWarnV1 actually calls
 * (resolvePublishScopeFolder → ownership.projectRoot first).
 */
function stampPublishChecksFreshnessV1(folderPath: string): void {
  const scopeFolder = path.dirname(folderPath);
  const section = renderPublishChecksFreshnessStamp({
    formatVersion: 1,
    runId: "00000000-0000-4000-8000-000000000000",
    verifiedCommitSha: REAL_ROOT_HEAD_SHA,
    completedAt: "2026-01-01T00:00:00.000Z",
    scopeId: computePublishScopeId(scopeFolder),
  });
  // The stamp lives in publish-review.md now (plan item 17, step 20 — the
  // split with publish-checks.md is reversed).
  fs.writeFileSync(
    path.join(folderPath, STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME),
    `${section}\n`,
    "utf8"
  );
}

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
    ownership: {
      metaRoot: path.dirname(folderPath),
      projectRoot: path.dirname(folderPath),
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved",
    },
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");
  if (currentStage === "publish") {
    stampPublishChecksFreshnessV1(folderPath);
  }
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

function fakeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

/**
 * ChatViewProvider.askInteraction's first call for a task opens the webview
 * via `executeCommand("vs-code-ai-helper.chatView.focus")` (chatView.ts's
 * `open()`), which this test process never registers — mirrors
 * chatInteractionUI.test.ts's identical harness.
 */
function installExecuteCommandCapture(): { restore: () => void } {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  return {
    restore: (): void => {
      commandsObj._executeCommandOverride = orig;
    },
  };
}

/**
 * runReviewForFolder/applyReviewWithAI now run through the real V1 action
 * coordinator (createProductionTaskActionCoordinatorV1), which selects
 * providers via runnerRegistry's `createV1RunnerSelectionOpener` — NOT the
 * legacy `resolveRunnerForModel`/`backupModelsForStage` cascade this file
 * used to patch. Framing a fake response therefore requires the V1 envelope
 * format and this seam instead.
 */
function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/**
 * A V1 transport that frames a completed markdown-artifact.v1 envelope
 * echoing the request's correlation. `produceMarkdown` is invoked at invoke
 * time (not eagerly), so a caller can run a side effect (e.g. simulating a
 * mid-review pause) exactly when the "provider" would have been running.
 */
function scriptedMarkdownTransportV1(
  produceMarkdown: () => string,
  runnerId = "stub-runner"
): AgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frame({
          version: 1,
          correlation: request.correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: produceMarkdown() },
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/** A V1 transport that frames a fixed completed markdown-artifact.v1 envelope. */
function markdownTransportV1(markdown: string, runnerId = "stub-runner"): AgentTransportV1 {
  return scriptedMarkdownTransportV1(() => markdown, runnerId);
}

/** A V1 transport that frames a `questions` envelope with a single required text question. */
function questionsTransportV1(runnerId = "stub-runner"): AgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frame({
          version: 1,
          correlation: request.correlation,
          kind: "questions",
          questions: [
            {
              questionId: "q1",
              kind: "text",
              prompt: "Which approach should the review favor?",
              required: true,
            },
          ],
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/**
 * Patches runnerRegistry's `createV1RunnerSelectionOpener` factory — the seam
 * `createProductionTaskActionCoordinatorV1` calls internally — so a
 * coordinator-run review/apply-review never reaches a real CLI or Copilot
 * provider. Reservations still flow through the caller's own selection
 * session (`session.reserve`), so claim-once/one-reservation-per-attempt stay
 * session-enforced exactly like production; only WHICH runner/model is
 * offered is stubbed, mirroring the ranked-candidate contract
 * `openV1RunnerSelection` implements: transports are offered in order, and
 * running out reports `providerModeUnavailable` (nothing reserved yet) or
 * `candidatesExhausted` (at least one candidate already offered).
 */
function stubV1RunnerSelection(transports: readonly AgentTransportV1[]): Patched {
  let cursor = 0;
  const fakeOpener = (request: {
    session: { reserve: (input: Record<string, unknown>) => unknown };
    mode: unknown;
  }) => ({
    reserveNext(attemptId: string): unknown {
      const transport = transports[cursor];
      if (!transport) {
        return cursor === 0
          ? { kind: "noneRemaining", code: "providerModeUnavailable" }
          : { kind: "noneRemaining", code: "candidatesExhausted" };
      }
      cursor += 1;
      const handle = request.session.reserve({
        attemptId,
        mode: request.mode,
        runnerId: transport.runnerId,
        providerId: "copilot",
        modelId: "copilot:test",
      });
      return {
        kind: "reserved",
        reserved: {
          handle,
          providerLabel: "Test Provider",
          storedModelId: "copilot:test",
          createTransport: () => transport,
        },
      };
    },
  });
  // The dispatch-site chain pre-flight (finding 4) probes REAL provider
  // availability before the coordinator ever opens a selection; in this
  // harness no CLI is installed, so an unstubbed pre-flight would report the
  // chain exhausted and pause the task before the stubbed selection above is
  // ever reached. A stubbed selection is dispatchable by definition.
  const openerPatch = patch(runnerRegistryModule, "createV1RunnerSelectionOpener", () => fakeOpener);
  const preflightPatch = patch(
    runnerRegistryModule,
    "preflightStageChainAvailabilityV1",
    () => Promise.resolve({ kind: "dispatchable" })
  );
  return {
    restore: (): void => {
      preflightPatch.restore();
      openerPatch.restore();
    },
  };
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
      ownership: fixtureOwnershipFor(taskFolderPath),
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
 * Like makeInventoryStub, but the stubbed task's `progress` carries the same
 * `ownership`/`taskFolder` binding written to disk by `makeTaskFolder`, and
 * the task carries a `workspaceFolder` — both required for
 * `TaskInventory.getTaskByBindingId` (the real, un-stubbed prototype method,
 * which derives a `TaskBindingV1` from `progress` via `deriveTaskBindingV1`)
 * to resolve the task that a durable Chat interaction transaction's
 * `taskBindingId` names, exactly as the production Resume delegates
 * (`resumeReviewInteractionV1`, `resumeApplyReviewInteractionV1`,
 * `resumeCommitPushMetadataInteractionV1`) look it up.
 */
function makeBindingInventoryStub(
  folderPath: string,
  currentStage: TaskStage
): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const folderName = folderPath.split(/[/\\]/).pop() ?? "";
  const task = {
    canonicalId: folderPath,
    taskFolderPath: folderPath,
    folderName,
    sourceScopeKey: folderPath,
    workspaceFolder: vscode.Uri.file(REAL_ROOT),
    progress: {
      taskFolder: folderName,
      currentStage,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: {
        metaRoot: path.dirname(folderPath),
        projectRoot: path.dirname(folderPath),
        workspaceRoot: REAL_ROOT,
        boundAt: "2026-01-01T00:00:00.000Z",
        state: "resolved" as const,
      },
    },
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[folderPath, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === folderPath ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === folderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

/** Minimal vscode.Memento backing store for a standalone ChatViewProvider instance. */
function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
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
  const contextPack = path.join(folderPath, "context-pack.md");
  fs.writeFileSync(contextPack, "# Context\n", "utf8");

  const patches: Patched[] = [
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "stub:model" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "stub:model" })),
    patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
      Promise.resolve(new Set(REVIEW_STAGES))),
    stubV1RunnerSelection([markdownTransportV1(reviewText)]),
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
  void it("auto-fast-forward mode: dispatches exactly one follow-up Publish review — commit/push only runs from the user's explicit click", async () => {
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
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("plain auto mode: dispatches exactly one single-pass follow-up Publish review — commit/push only runs from the user's explicit click", async () => {
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
    ];
    try {
      await runPassingReview(folderPath, dispatches);

      assert.equal(dispatches.length, 1, "exactly one scheduling owner — no race between review and direct publish");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("auto-fast-forward mode: turning auto-advance off after the Publish transition commits must not cancel the already-owed review", async () => {
    // wf10 item 14 / Part 7 step 17 (review completion blocker, 2026-08-24):
    // the transition to Publish has already landed on disk by the time the
    // follow-up review is scheduled — `stillEnabled` must not re-read
    // isAutoAdvanceEnabled() at fire time and drop it if the user (or some
    // other automation) turns the setting off afterward.
    const { folderPath } = makeTaskFolder(`ff-toggle-${Math.floor(Math.random() * 1e9)}`);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    let autoAdvanceEnabled = true;
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => autoAdvanceEnabled),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto-fast-forward"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runPassingReview(folderPath, dispatches);

      assert.equal(dispatches.length, 1);
      autoAdvanceEnabled = false;
      assert.equal(
        dispatches[0]?.stillEnabled?.(),
        true,
        "an already-committed Publish transition must not be cancelled by turning auto-advance off afterward"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("plain auto mode: turning auto-advance off after the Publish transition commits must not cancel the already-owed review", async () => {
    const { folderPath } = makeTaskFolder(`auto-toggle-${Math.floor(Math.random() * 1e9)}`);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    let autoAdvanceEnabled = true;
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => autoAdvanceEnabled),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    ];
    try {
      await runPassingReview(folderPath, dispatches);

      assert.equal(dispatches.length, 1);
      autoAdvanceEnabled = false;
      assert.equal(
        dispatches[0]?.stillEnabled?.(),
        true,
        "an already-committed Publish transition must not be cancelled by turning auto-advance off afterward"
      );
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
      stubV1RunnerSelection([
        scriptedMarkdownTransportV1(() => {
          const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
          progress.status = "paused";
          fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf8");
          return "Readiness: 9/10\n\n- Ready.\n";
        }),
      ]),
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
  void it("auto-fast-forward landing on Publish: when the shared auto-review chain slot is already claimed, warns with a Publish Anyway action", async () => {
    const { folderPath } = makeTaskFolder(`dropped-chain-${Math.floor(Math.random() * 1e9)}`);
    const taskFolderUri = vscode.Uri.file(folderPath);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
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
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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

      // This follow-up review can never auto-publish (there is no
      // auto-publish scheduling path anywhere in reviewActions.ts) — but
      // landing on Publish always gets the manual "Publish Anyway" nudge
      // once its follow-up review chain is dropped, regardless of why that
      // review was dispatched in the first place.
      const publishAnywayWarning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(publishAnywayWarning, "expected a Publish Anyway warning once the follow-up review chain was dropped");
      assert.equal(publishAnywayWarning.actionCommand?.title, "Publish Anyway");
      assert.deepEqual(publishAnywayWarning.actionCommand?.args, [{ taskFolderPath: taskFolderUri.fsPath }]);
      assert.match(
        publishAnywayWarning.message,
        /could not be started automatically/,
        "expected the warning to explain that the follow-up review was dropped"
      );
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

void describe("Publish review — failure/below-threshold outcomes still offer a manual publish action", () => {
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
        "publish"
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
        "publish"
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
  // Reviews run through the V1 coordinator, so the failure is injected as a
  // transport exit, not a legacy AgentRunResult: a "cancelled" result becomes
  // a providerCancelled exit (a cancelled outcome), and a "failed" result
  // becomes a transportFailure exit (the coordinator advances past it; the
  // stub chain has nothing further, so selection reports exhausted without
  // the registry's structured evidence — the generic-failure shape).
  const failureTransport: AgentTransportV1 = {
    runnerId: runnerResult.runnerId,
    invoke: (): Promise<{ kind: "providerCancelled" } | { kind: "transportFailure"; code: string }> =>
      Promise.resolve(
        runnerResult.status === "cancelled"
          ? { kind: "providerCancelled" as const }
          : { kind: "transportFailure" as const, code: "stubProviderError" }
      ),
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
    stubV1RunnerSelection([failureTransport]),
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

void describe("Publish review — genuine provider failure and cancellation outcomes still offer a manual publish action", () => {
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
        "publish"
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
        "publish"
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

void describe("Fast Forward Review — a checks-only publish-review.md is not mistaken for an existing review", () => {
  // Historical shape, kept covered because tasks created before the artifact
  // split still have it on disk: publish-review.md holding ONLY a Completion
  // Checks section, with no AI review body. Before the guard,
  // fastForwardReviewWithAI read that as "an existing review with no Readiness
  // line" and refused outright instead of running the initial review it was
  // dispatched to run. The split stops NEW files taking this shape; the guard
  // stays for the ones that already have it.
  const samplePassingLint: CompletionLintResult = {
    runAt: "2026-01-01T00:00:00.000Z",
    passed: true,
    summary: "All checks passed.",
    issueCount: 0,
    failedChecks: [],
    missingScripts: [],
  };

  void it("isUnusableAsExistingReview treats checks-only content as no review yet", () => {
    const checksOnly = [
      "<!-- completion-checks:start -->",
      "## Completion Checks",
      "",
      "All checks passed.",
      "<!-- completion-checks:end -->",
      "",
    ].join("\n");
    assert.equal(
      checksOnly.includes("Readiness:"),
      false,
      "sanity: a checks-only file has no Readiness line"
    );
    assert.equal(
      isUnusableAsExistingReview(checksOnly),
      true,
      "checks-only content must not be treated as a usable existing review"
    );
  });

  void it("isUnusableAsExistingReview treats an actual AI review (with a Readiness line) as usable", () => {
    const realReview = "Readiness: 9/10\n\n- Looks good.\n";
    assert.equal(isUnusableAsExistingReview(realReview), false);
  });

  void it("the checks report is spliced into publish-review.md, preserving the reviewer's own verdict", async () => {
    // Plan item 17, step 20: the split is reversed — checks and the AI
    // verdict now share one document (a managed, marker-delimited section),
    // specifically so a user can never again mistake a separate
    // checks-only file for their Publish review (2026-08-23 field report).
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-checks-unified-"));
    const fsBridge = installFsBridge();
    try {
      fs.writeFileSync(
        path.join(folderPath, "publish-review.md"),
        "Readiness: 9/10\n\n- Looks good.\n",
        "utf8"
      );
      await upsertCompletionChecksReportV1(vscode.Uri.file(folderPath), samplePassingLint);

      const review = fs.readFileSync(path.join(folderPath, "publish-review.md"), "utf8");
      assert.ok(review.includes("Readiness: 9/10"), "the AI review body is untouched");
      assert.ok(review.includes("Completion Checks"), "the checks section is spliced into the SAME document");
      assert.equal(
        fs.existsSync(path.join(folderPath, "publish-checks.md")),
        false,
        "no separate publish-checks.md is ever written"
      );
    } finally {
      fsBridge.restore();
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  });

  void it("refreshing the Completion Checks section replaces only that section, leaving the reviewer's verdict untouched", async () => {
    // Re-running checks must correct a stale checks section in place without
    // disturbing the surrounding AI verdict — the two-verdict failure this
    // guards against is a stale review next to fresh checks, not a stale
    // checks section next to a fresh review.
    const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-checks-refresh-"));
    const fsBridge = installFsBridge();
    try {
      fs.writeFileSync(
        path.join(folderPath, "publish-review.md"),
        [
          "Readiness: 2/10",
          "",
          "## Shipping blockers",
          "",
          "- Something from an older commit.",
          "",
          "<!-- completion-checks:start -->",
          "## Completion Checks",
          "",
          "Stale checks from a previous cycle.",
          "<!-- completion-checks:end -->",
          "",
        ].join("\n"),
        "utf8"
      );
      await upsertCompletionChecksReportV1(vscode.Uri.file(folderPath), samplePassingLint);

      const review = fs.readFileSync(path.join(folderPath, "publish-review.md"), "utf8");
      assert.equal(
        review.includes("Stale checks from a previous cycle."),
        false,
        "the stale section content must be replaced in place"
      );
      assert.ok(
        review.includes("Readiness: 2/10") && review.includes("Shipping blockers"),
        "the reviewer's own verdict must survive the refresh untouched"
      );
      assert.ok(review.includes("All checks passed."), "the current run's results land in the same document");
    } finally {
      fsBridge.restore();
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  });
});

void describe("Publish auto-run ownership matrix — manual entry routes (command-level)", () => {
  void it("setTaskStage: manual jump onto Publish never auto-publishes, even with a passing preflight — commit/push only runs from the user's explicit click", async () => {
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

      // setTaskStage.ts has no auto-publish scheduling path at all — landing
      // on Publish via a manual jump only ever computes the preflight result
      // for its own nudge (below), never a scheduling decision.
      assert.equal(dispatches.length, 0, "a manual jump onto Publish must never schedule the publish chain automatically, regardless of preflight outcome");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("setTaskStage: manual jump onto Publish with a failing preflight still never auto-publishes, but still warns with a Publish Anyway action", async () => {
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
      // setTaskStage.ts surfaces the failing-checks warning unconditionally on
      // landing on Publish, so the user still learns checks are failing and
      // gets a one-click way to publish anyway.
      const warning = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(warning, "a Publish Anyway warning should appear for the failing preflight");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("nextStage: triggers-AI off — never auto-publishes and dispatches no Publish review either, regardless of a passing lint", async () => {
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

      // Step 3b (nextStage's entry-owned Publish nudge) never schedules
      // anything — it only reads the preflight result to choose which nudge
      // wording to show — so this landing on Publish schedules nothing at
      // all, even though the lint passed.
      assert.equal(dispatches.length, 0, "triggers-AI off must never auto-publish, and dispatches no Publish review either");
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
        ownership: {
          metaRoot: path.dirname(folder),
          projectRoot: path.dirname(folder),
          workspaceRoot: isolatedRoot,
          boundAt: "2026-01-01T00:00:00.000Z",
          state: "resolved",
        },
      };
      fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
      fs.writeFileSync(path.join(folder, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
      fs.writeFileSync(path.join(folder, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
      fs.writeFileSync(path.join(folder, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");
      // The shortcut exercises a valid transition out of Low-Level Code
      // Review; stage completion now correctly refuses an absent review
      // artifact before it can advance to Publish.
      fs.writeFileSync(path.join(folder, STAGE_ARTIFACT_FILENAMES["impl-low-review"]!), "# Review\n", "utf8");
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

      // Landing on Publish never dispatches anything (there is no
      // auto-publish scheduling path) — proving the keyboard shortcut
      // resolved and actually advanced the right task has to go through the
      // persisted stage instead of a dispatch.
      const written = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(written.currentStage, "publish", "the keyboard shortcut must resolve the current task and actually advance it, exactly like the tree-button click");
      assert.equal(dispatches.length, 0, "triggers-AI off must never auto-publish");
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

  void it("nextStage: triggers-AI on — review-owned, dispatches exactly one Publish review, never a direct publish chain", async () => {
    const { folderPath } = makeTaskFolder(`nextstage-on-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    fs.writeFileSync(path.join(folderPath, STAGE_ARTIFACT_FILENAMES["impl-low-review"]!), "# Review\n", "utf8");
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
      const arg = dispatches[0]?.arg as { taskFolderPath?: string } | undefined;
      assert.equal(arg?.taskFolderPath, folderPath);
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
  void it("a passing manual Publish review never auto-publishes — it only nudges toward the manual Publish action", async () => {
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
      // A plain manual "Run Review with AI" click on the Publish stage —
      // reviewOptions carries nothing that could ever thread an auto-publish
      // decision through, because reviewActions.ts has no such plumbing left
      // anywhere in its call graph (see the file's header comment). This must
      // never schedule commitAndPushTask, only nudge toward it.
      await runPassingReview(
        folderPath,
        dispatches,
        "Readiness: 9/10\n\n- Ready.\n",
        "publish"
      );

      assert.equal(dispatches.length, 0, "a passing Publish review must never schedule the publish chain — only the user's own click may");
      const nudge = provider
        .getEntries()
        .find((entry) => entry.actionCommand?.command === "vs-code-ai-helper.commitAndPushTask");
      assert.ok(nudge, "expected a Notifications entry offering the manual publish action");
      assert.equal(nudge?.actionCommand?.title, "Publish");
      assert.deepEqual(nudge?.actionCommand?.args, [{ taskFolderPath: vscode.Uri.file(folderPath).fsPath }]);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("both-files case: a stub publish-review.md with no stamp, alongside a legacy publish-checks.md that DOES have one, still lets the review proceed (wf10 item 17, step 20c)", async () => {
    // Reproduces the review-confidence blocker on the previous round: the
    // entry gate (requirePublishChecksFreshnessOrWarnV1) used to read
    // publish-review.md's own (absent) stamp and refuse with "Publish Checks
    // have not been run yet" — never reaching reviewRowV1.ts's promotion-time
    // import, which only runs AFTER this gate accepts. A task that upgraded
    // mid-Publish, where an older build had already stubbed publish-review.md
    // before the legacy-import path existed, could never get its most recent
    // Scope Check/Completion Checks/stamp imported by requesting a review.
    const folderName = `both-files-${Math.floor(Math.random() * 1e9)}`;
    const folderPath = path.join(REAL_ROOT, "plans", folderName);
    fs.mkdirSync(folderPath, { recursive: true });
    const progress: TaskProgress = {
      taskFolder: folderName,
      currentStage: "publish",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: {
        metaRoot: path.dirname(folderPath),
        projectRoot: path.dirname(folderPath),
        workspaceRoot: REAL_ROOT,
        boundAt: "2026-01-01T00:00:00.000Z",
        state: "resolved",
      },
    };
    fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
    fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
    fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");

    // Stub publish-review.md — no embedded verification sections, no stamp —
    // exactly the shape an older intermediate build's
    // ensurePublishReviewArtifactExistsV1 would have left behind.
    fs.writeFileSync(
      path.join(folderPath, "publish-review.md"),
      "# Publish Review\n\n**Not yet reviewed.**\n",
      "utf8"
    );
    // Legacy publish-checks.md — the REAL pre-unification shape: its own
    // top-level `##` headings (one level shallower than the current build's
    // `###`), never `###` — and the only place the valid freshness stamp
    // lives.
    const scopeFolder = path.dirname(folderPath);
    const legacyStamp = renderPublishChecksFreshnessStamp({
      formatVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      verifiedCommitSha: REAL_ROOT_HEAD_SHA,
      completedAt: "2026-01-01T00:00:00.000Z",
      scopeId: computePublishScopeId(scopeFolder),
    });
    const legacyContent = [
      "<!-- completion-checks:start -->",
      "## Completion Checks",
      "",
      "- Status: Passed",
      "<!-- completion-checks:end -->",
      "",
      "<!-- scope-check:start -->",
      "## Scope Check",
      "",
      "No files the plan doesn't mention.",
      "<!-- scope-check:end -->",
      "",
      legacyStamp,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(folderPath, PUBLISH_CHECKS_FILENAME), legacyContent, "utf8");

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
        "publish"
      );

      // The gate must not have refused the review as missing evidence — the
      // freshness-failure warning names "Run Publish Checks" and must not
      // appear alongside the expected manual-publish nudge.
      const refusal = provider
        .getEntries()
        .find((entry) => /Publish Checks have not been run yet/.test(entry.message));
      assert.equal(refusal, undefined, "expected the legacy stamp to satisfy the freshness gate, not a refusal");

      const finalContent = fs.readFileSync(path.join(folderPath, "publish-review.md"), "utf8");
      assert.match(finalContent, /Readiness: 9\/10/, "the reviewer's verdict was actually written");
      // Legacy sections were imported and their headings normalized to nest
      // under "## Verification (ground truth)" instead of reading as
      // top-level siblings of it.
      assert.match(finalContent, /### Completion Checks/);
      assert.match(finalContent, /### Scope Check/);
      assert.doesNotMatch(finalContent, /^## Completion Checks$/m);
      assert.doesNotMatch(finalContent, /^## Scope Check$/m);
      // The provenance note survived the review write's re-splice — it used
      // to live as plain text outside every extractable marker and get
      // silently dropped by reinjectPublishGroundTruthSectionsV1.
      assert.match(finalContent, /Imported once from the legacy `publish-checks\.md`/);
      // The legacy file itself is never modified.
      assert.equal(
        fs.readFileSync(path.join(folderPath, PUBLISH_CHECKS_FILENAME), "utf8"),
        legacyContent
      );
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
      ownership: {
        metaRoot: path.dirname(folderPath),
        projectRoot: path.dirname(folderPath),
        workspaceRoot: REAL_ROOT,
        boundAt: "2026-01-01T00:00:00.000Z",
        state: "resolved",
      },
    };
    fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
    // The composite intentionally completes the Low-Level Code Review and
    // Publish stages before it reaches the inline git-readiness recheck.
    // Supply those required artifacts so this fixture tests that ownership
    // path rather than the separate missing-artifact refusal contract.
    fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
    fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");
    fs.writeFileSync(path.join(folderPath, STAGE_ARTIFACT_FILENAMES["impl-low-review"]!), "# Review\n", "utf8");
    fs.writeFileSync(path.join(folderPath, STAGE_ARTIFACT_FILENAMES.publish!), "# Publish Review\n", "utf8");

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
      // The composite's own internal advance to Publish has no auto-publish
      // scheduling path to begin with (stageTransition.ts has no such
      // concept at all). What must be proven at the COMMAND level is that
      // the composite instead calls commitAndPushTask inline (which never
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
      ownership: {
        metaRoot: path.dirname(folderPath),
        projectRoot: path.dirname(folderPath),
        workspaceRoot: REAL_ROOT,
        boundAt: "2026-01-01T00:00:00.000Z",
        state: "resolved",
      },
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
    // Advancing out of a review stage now validates that stage's own
    // completion artifact before it reaches the Publish preflight. This
    // ownership test is about the preflight scope, so establish the valid
    // outgoing-stage state explicitly rather than relying on the old
    // artifact-less fixture shape.
    fs.writeFileSync(path.join(folderPath, STAGE_ARTIFACT_FILENAMES["impl-low-review"]!), "# Review\n", "utf8");
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
    // See the manual-jump case above: this test exercises Publish preflight
    // ownership, not refusal of an incomplete Low-Level Code Review stage.
    fs.writeFileSync(path.join(folderPath, STAGE_ARTIFACT_FILENAMES["impl-low-review"]!), "# Review\n", "utf8");
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

  void it("auto-advance onto Publish (plain 'auto' mode): dispatches the follow-up review rather than computing the preflight itself", async () => {
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
      // wf10 item 14 / Part 7 step 17: landing on Publish in plain "auto"
      // mode now dispatches a single-pass follow-up review
      // (runReviewWithAI), same as every other landed-on review stage —
      // it no longer computes checkPublishPreflight itself here to pick a
      // "Publish manually" nudge wording (that entry-owned nudge only fires
      // from the SEPARATE `targetStage === "publish"` branch, i.e. once a
      // review already AT Publish completes without anywhere further to
      // advance to — untouched by this fix and still covered by the
      // sibling scope-jump/scope-nextstage tests above). The dispatched
      // review itself is what will eventually decide the preflight scope,
      // not this transition site.
      const calls = await captureRelevantFiles(() => runPassingReview(folderPath, dispatches));
      assert.equal(calls.length, 0, "this transition site no longer calls checkPublishPreflight directly — it defers to the dispatched review");
      assert.equal(dispatches.length, 1, "auto-advancing onto Publish in plain 'auto' mode schedules exactly one follow-up review");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
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
 * This describe block used to cover reviewActions.ts's own content-validation
 * backup-retry cascade (runAiToFile retrying a stage's configured backups
 * when the primary's output had no "Readiness: N/10" line, with dedup against
 * already-tried models, quota-observation gating, and atomic
 * fallbackActive/fallbackModelId persistence). Review generation now runs
 * through the V1 action coordinator (review.v1, reviewRowV1.ts), which
 * changes this behavior deliberately, not by omission:
 *
 *  - Provider selection and fallback move to providerSelectionPolicyV1.ts /
 *    runnerRegistry.ts's openV1RunnerSelection.
 *  - The old dedup-against-already-tried-model logic
 *    (qualifiedRanModelId/normalizeQualifiedModelId) lived entirely inside
 *    runAiToFile's own cascade and has no V1 equivalent to test here: ranking
 *    and dedup of primary vs. configured backups is runnerRegistry.ts's
 *    openV1RunnerSelection's responsibility now (covered by
 *    runnerRegistry.test.ts and taskActionCoordinatorV1.test.ts), not
 *    something reviewActions.ts's callers orchestrate per-attempt.
 *  - fallbackActive/fallbackModelId persistence tied to a content-validation
 *    retry no longer applies for the same reason: there is no legacy retry
 *    loop left to persist the outcome of.
 *
 * What replaces this coverage: reviewRowV1.ts's `validateCompletedContent`
 * readiness check plus the coordinator's candidate-scoped content-contract
 * advance (taskActionCoordinatorV1.ts, `classifyProviderCandidateDispositionV1`
 * in providerSelectionPolicyV1.ts). A response with no Readiness line decodes
 * fine as a well-formed `markdown-artifact.v1` envelope, but fails that
 * row-owned content contract — and per the 2026-08-16 field report (fourth
 * item), that is now candidate-scoped, not stage-terminal: the coordinator
 * advances to the next ranked candidate exactly as it does for a malformed
 * envelope, rather than settling on a terminal outcome while a working
 * backup sits unreserved one position down. The test below pins the
 * reviewActions.ts-level, end-to-end half of that contract: a real
 * runReviewForFolder call whose FIRST candidate produces well-formed but
 * invalid (no Readiness line) content must fall through to the second
 * configured candidate and publish ITS review.
 */
void describe("Review generation — a response with no Readiness line advances to the next candidate", () => {
  void it("a review response with no Readiness line from the first candidate falls through to a working second candidate, which is published", async () => {
    const { folderPath } = makeTaskFolder(`content-invalid-advance-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    let secondCandidateInvoked = false;
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "primary-cli:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      // Two candidates offered: the first returns well-formed but invalid
      // (no Readiness line) content; the coordinator must advance to the
      // second, which produces a valid, publishable review.
      stubV1RunnerSelection([
        markdownTransportV1("I have a clarifying question instead of a review."),
        scriptedMarkdownTransportV1(() => {
          secondCandidateInvoked = true;
          return "Readiness: 9/10\n\n- Ready.\n";
        }),
      ]),
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

      assert.equal(secondCandidateInvoked, true, "a content-contract failure (no Readiness line) must advance to the next ranked candidate");
      assert.equal(fs.existsSync(path.join(folderPath, "impl-low-review.md")), true, "the second candidate's valid review should be published");
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
 * Direct coverage for the production `resumeReviewInteractionV1` delegate
 * (reviewActions.ts) — the wiring extension.ts calls from the Chat "Resume"
 * control (plan §5.5/§6.1, AC-QUESTION-03). The generic coordinator-level
 * `resumeAction` machinery already has thorough coverage in
 * taskActionCoordinatorV1.test.ts; what was previously untested is the
 * production glue this delegate adds on top: looking the task up by its
 * durable `taskBindingId` via `TaskInventory.getTaskByBindingId`, resolving a
 * fresh model for the review's target stage, claiming a review attempt, and
 * — on a completed resume — actually promoting the resumed content to the
 * review artifact via the normal `handleReviewOutcomeV1` path.
 */
void describe("resumeReviewInteractionV1 — production Resume delegate", () => {
  void it("resumes a questions-returning review end to end: settles \"resumed\" and promotes the resumed content", async () => {
    const { folderPath } = makeTaskFolder(`resume-review-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const execCapture = installExecuteCommandCapture();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const chatViewProvider = new ChatViewProvider(makeMemento());
    const askedRefs: ChatInteractionRefV1[] = [];
    const originalAskInteraction = chatViewProvider.askInteraction.bind(chatViewProvider);
    chatViewProvider.askInteraction = (async (question) => {
      askedRefs.push({
        operationId: question.operationId,
        interactionId: question.interactionId,
        // This coordinator-tracked caller always supplies a real binding;
        // only the no-coordinator local-only fallback omits it.
        taskBindingId: question.binding!.taskBindingId,
        chatDocumentId: question.binding!.chatDocumentId,
        sourceAttemptId: question.sourceAttemptId,
      });
      return originalAskInteraction(question);
    }) as typeof chatViewProvider.askInteraction;

    try {
      const initialPatches: Patched[] = [
        patch(modelSelectionModule, "resolveModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        patch(modelSelectionModule, "resolveFreshModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
          Promise.resolve(new Set(REVIEW_STAGES))),
        stubV1RunnerSelection([questionsTransportV1()]),
        patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
        patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
        patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      ];
      try {
        await runReviewForFolder(
          vscode.Uri.file(REAL_ROOT),
          vscode.Uri.file(folderPath),
          workspaceRoot,
          "impl-low-review",
          true,
          { chatViewProvider }
        );
      } finally {
        for (const p of initialPatches.reverse()) { p.restore(); }
      }

      assert.equal(askedRefs.length, 1, "the review's questions must reach Chat With AI exactly once");
      assert.equal(
        fs.existsSync(path.join(folderPath, "impl-low-review.md")),
        false,
        "a questions outcome must not promote any review content"
      );

      // Resume is only valid after the interaction's questions have been
      // answered (questionsPosted -> answersSubmitted); the transaction
      // state machine rejects a bare Resume straight from questionsPosted
      // (outcomeCode "answersNotSubmitted").
      const submitted = await getProductionActionConversationOrchestratorV1().submitAnswers(
        askedRefs[0]!,
        [{ questionId: "q1", kind: "text", state: "answered", value: "Favor correctness over speed." }],
        allocateHex128IdV1()
      );
      assert.equal(submitted.ok, true, "the clarifying answer must be accepted before Resume");

      const inventory = makeBindingInventoryStub(folderPath, "impl-low-review");
      const resumePatches: Patched[] = [
        patch(modelSelectionModule, "resolveFreshModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready after clarification.\n")]),
      ];
      try {
        const result = await resumeReviewInteractionV1(
          vscode.Uri.file(REAL_ROOT),
          inventory,
          chatViewProvider,
          askedRefs[0]!,
          allocateHex128IdV1(),
          fakeToken()
        );

        assert.equal(result.ok, true, `expected Resume to settle successfully: ${result.ok ? "" : result.reason}`);
        if (result.ok) {
          assert.equal(result.settlement, "resumed", "review.v1 declares sameOperation resume semantics");
        }
        assert.equal(
          fs.readFileSync(path.join(folderPath, "impl-low-review.md"), "utf8").includes("Ready after clarification"),
          true,
          "the resumed attempt's own content must be the one actually promoted to the review artifact"
        );
      } finally {
        for (const p of resumePatches.reverse()) { p.restore(); }
      }

      // A second Resume of the same interaction, with a fresh idempotency id,
      // must be rejected without invoking a provider (AC-ID-04) — proven here
      // via the production delegate's own return value, not only at the
      // generic coordinator level.
      const replayPatches: Patched[] = [
        stubV1RunnerSelection([
          markdownTransportV1("must not be invoked for a replay"),
        ]),
      ];
      try {
        const replay = await resumeReviewInteractionV1(
          vscode.Uri.file(REAL_ROOT),
          inventory,
          chatViewProvider,
          askedRefs[0]!,
          allocateHex128IdV1(),
          fakeToken()
        );
        assert.equal(replay.ok, false, "a second Resume of an already-settled interaction must not report success");
      } finally {
        for (const p of replayPatches.reverse()) { p.restore(); }
      }
    } finally {
      execCapture.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});

/**
 * Plan Part 3, step 12(c): a candidate that probes AVAILABLE at pre-flight but
 * fails at invocation must still reach the runtime exhaustion backstop — the
 * pre-flight's probeable checks cannot see quota, capacity, or outage classes,
 * so the registry's invoke-time exhaustion evidence (chain + per-candidate
 * reasons) is a permanent backstop, not a transitional one. The stage owner
 * applies it: task paused with `pausedReason`, `updatedAt` bumped, and the
 * enriched run record naming the chain — never the bare 60-byte status line.
 *
 * The second test pins the Publish-stage regression: the generic "Publish
 * review did not complete" branch used to capture every non-completed outcome
 * first, so a Publish-chain exhaustion produced only the Publish Anyway nudge
 * while the task stayed active.
 */
void describe("provider-chain exhaustion — probe-available/invoke-fail reaches the runtime backstop", () => {
  const invokeTimeExhaustion = (stage: string): Record<string, unknown> => ({
    stage,
    candidates: [
      {
        storedModelId: "cline-cli:kimi-k3",
        providerLabel: "Cline CLI",
        runnerId: "cline-cli",
        reason: "quota exhausted at invocation",
      },
      {
        storedModelId: "kimi-cli:k3",
        providerLabel: "Kimi CLI",
        runnerId: "kimi-cli",
        reason: "remote service outage at invocation",
      },
    ],
  });

  /**
   * Pre-flight explicitly reports the chain dispatchable (the probes saw an
   * available candidate), while the selection opener exhausts at invocation
   * time WITH the registry's structured evidence attached — the
   * probe-available/invoke-fail shape.
   */
  function stubProbeAvailableInvokeFail(stage: string): Patched {
    const openerPatch = patch(runnerRegistryModule, "createV1RunnerSelectionOpener", () => () => ({
      reserveNext(): unknown {
        return {
          kind: "noneRemaining",
          code: "providerModeUnavailable",
          chainExhaustion: invokeTimeExhaustion(stage),
        };
      },
    }));
    const preflightPatch = patch(
      runnerRegistryModule,
      "preflightStageChainAvailabilityV1",
      () => Promise.resolve({ kind: "dispatchable" })
    );
    return {
      restore: (): void => {
        preflightPatch.restore();
        openerPatch.restore();
      },
    };
  }

  function readPersistedProgress(folderPath: string): TaskProgress {
    return JSON.parse(
      fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
    ) as TaskProgress;
  }

  async function runExhaustedReview(stage: TaskStage, name: string): Promise<string> {
    const { folderPath } = makeTaskFolder(name, stage);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "cline-cli:kimi-k3" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "cline-cli:kimi-k3" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      stubProbeAvailableInvokeFail(stage),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      // writeRunLog is deliberately NOT patched: the enriched exhaustion run
      // record is part of what these tests assert.
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    ];
    try {
      const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        stage,
        true,
        {}
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
    return folderPath;
  }

  void it("an invoke-time exhaustion pauses the task with a reason and writes the enriched run record, even though pre-flight probed available", async () => {
    const folderPath = await runExhaustedReview(
      "impl-low-review",
      `invoke-fail-backstop-${Math.floor(Math.random() * 1e9)}`
    );

    const persisted = readPersistedProgress(folderPath);
    assert.equal(persisted.status, "paused", "the runtime backstop must pause the task");
    assert.match(
      persisted.pausedReason ?? "",
      /No configured provider for impl-low-review is available/
    );
    assert.match(persisted.pausedReason ?? "", /Cline CLI → Kimi CLI/);
    assert.notEqual(persisted.updatedAt, "2026-01-01T00:00:00.000Z", "updatedAt must be bumped");

    const runsDir = path.join(folderPath, "runs");
    const logs = fs.readdirSync(runsDir).map((entry) =>
      fs.readFileSync(path.join(runsDir, entry), "utf8")
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /## Provider chain exhausted/);
    assert.match(logs[0]!, /Cline CLI .*— quota exhausted at invocation/);
    assert.match(logs[0]!, /Kimi CLI .*— remote service outage at invocation/);
  });

  void it("a Publish-stage exhaustion pauses the task too — the generic Publish failure nudge must not swallow it", async () => {
    const folderPath = await runExhaustedReview(
      "publish",
      `publish-exhaustion-${Math.floor(Math.random() * 1e9)}`
    );

    const persisted = readPersistedProgress(folderPath);
    assert.equal(
      persisted.status,
      "paused",
      "an exhausted Publish chain must pause the task, not only surface Publish Anyway"
    );
    assert.match(
      persisted.pausedReason ?? "",
      /No configured provider for publish is available/
    );
  });
});
