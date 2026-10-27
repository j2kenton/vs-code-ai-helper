/**
 * RC6 item 5 execution tests: drive `runLintingFixes` itself — real completion
 * lint against a temp package.json, a real admission marker and real report-lock
 * note writes — and observe what it schedules and when. Fixture helpers mirror
 * runLintingFixesGateMessages.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { offerLintFixRecoveryInChatV1, runLintingFixes } from "../commands/runLintingFixes";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { runTrackedOperation, taskOperations, TaskOperationSnapshot } from "../utils/taskOperations";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import { resetAutomationChainGuards, scheduleAutomationChain } from "../utils/automationChain";
import { checkAndReviewPublishV1 } from "../commands/checkAndReviewPublish";
import { ExtensionFolderRemovedErrorV1 } from "../utils/extensionResourcesV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  classifyPublishChecksFreshnessV1,
  computePublishScopeId,
  readPublishChecksFreshnessStampV1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
const publishScopeCheckModule = require("../utils/publishScopeCheck") as Record<string, unknown>;
const completionLintModule = require("../utils/completionLint") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const promptSizeGuardModule = require("../utils/promptSizeGuard") as Record<string, unknown>;
const aiConsentModule = require("../utils/aiConsent") as Record<string, unknown>;
const reviewActionsModule = require("../commands/reviewActions") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

// One level down, so this file's session lock (kept in the root's parent) is
// its own and never collides with the other lint-fix test files run in parallel.
const REAL_ROOT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-lint-fixes-exec-")), "workspace");
fs.mkdirSync(REAL_ROOT, { recursive: true });
// Model the extension's durable workspace state across separate command
// invocations for the same task. A fresh Map per run would make a repeated
// hand-back test inspect the first invocation's store while the second write
// silently lands in an unrelated store.
const taskMementos = new Map<string, vscode.Memento>();

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

interface ScheduledCall {
  command: string;
  arg: unknown;
  root: unknown;
  markerLiveAtSchedule: boolean;
  dispatchEvenIfRootFails: unknown;
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

async function runFix(
  name: string,
  testScript: string,
  options: {
    /** Exercise the real preflight recovery card when no Publish report exists. */
    missingReport?: boolean;
    scopeCheckThrows?: boolean;
    staleScope?: boolean;
    /** Drive the AI pass: `fixes` makes the stubbed edit action repair the checks. */
    ai?: { fixes: boolean; cancels?: boolean; invokeCandidate?: boolean; cancelAt?: "prompt-size" | "consent" };
    /** Run as the commit-and-push flow's child under a live parent operation. */
    nested?: boolean;
    /**
     * Nested only: drive the REAL deferred chain and the real
     * `checkAndReviewPublishV1` (with recording command deps) instead of a
     * recorder. `headMoved` models a commit made by the parent flow, which
     * leaves the Publish Checks stamp stale until the checks command runs.
     */
    realChain?: { parentFails: boolean; headMoved: boolean };
    /** Simulate the shared resource reader detecting a removed extension root. */
    extensionFolderRemoved?: boolean;
    diagnostics?: "eslint" | "none";
    eslintUnavailable?: boolean;
  } = {}
): Promise<{
  scheduled: ScheduledCall[];
  review: string;
  surface: RecordingSurface;
  taskFolderPath: string;
  parentOpId?: string;
  aiCalls: number;
  decisions: ReturnType<WorkflowDecisionStoreV1["listPending"]>;
  memento: vscode.Memento;
  progressBefore: string;
  chain?: { dispatchedWhileParentLive: number; commands: string[]; reviewStampCommit?: string; newHead: string };
}> {
  const taskFolderPath = path.join(REAL_ROOT, name);
  fs.mkdirSync(taskFolderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
    ...(options.missingReport ? {} : { lintPayload: {
      runAt: "2026-01-01T00:00:00.000Z",
      passed: false,
      summary: "1 check failed",
      issueCount: 1,
      failedChecks: [],
    } }),
  };
  fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  const progressBefore = fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8");
  const reviewPath = path.join(taskFolderPath, "publish-review.md");
  fs.writeFileSync(reviewPath, "# Publish Review\n\nReadiness: 6/10\n\nNeeds changes.\n", "utf8");
  const packageJsonPath = path.join(REAL_ROOT, "package.json");
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: `root-${name}`,
      scripts: {
        lint: 'node -e "process.exit(0)"',
        "check-types": 'node -e "process.exit(0)"',
        test: testScript,
        build: 'node -e "process.exit(0)"',
      },
    }),
    "utf8"
  );

  const surface = new RecordingSurface();
  let memento = taskMementos.get(taskFolderPath);
  if (!memento) {
    const state = new Map<string, unknown>();
    memento = {
      keys: () => [...state.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined => state.has(key) ? state.get(key) as T : defaultValue,
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
        return Promise.resolve();
      },
    } as vscode.Memento;
    taskMementos.set(taskFolderPath, memento);
  }
  __extensionContextV1TestOnly.set({
    subscriptions: [], extensionUri: vscode.Uri.file(REAL_ROOT), workspaceState: memento, globalState: memento,
  } as unknown as vscode.ExtensionContext);
  initNotificationRouter(surface);
  const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
  const originalFolders = wsTarget.workspaceFolders;
  wsTarget.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalReadFile = fsTarget.readFile;
  fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  const originalEnsure = modelSelectionModule.ensureStageModelConfigured;
  modelSelectionModule.ensureStageModelConfigured = () => Promise.resolve(true);
  const originalFresh = modelSelectionModule.resolveFreshModelForStage;
  modelSelectionModule.resolveFreshModelForStage = () =>
    Promise.resolve({ modelId: "stub-publish-model", source: "workspace" });
  const originalAvailability = runEditActionModule.checkEditActionAvailabilityV1;
  runEditActionModule.checkEditActionAvailabilityV1 = () =>
    Promise.resolve({ ok: false, code: "providerModeUnavailable", reason: "no model" });
  const originalScope = publishScopeCheckModule.runPublishScopeCheck;
  const originalResolveScope = completionLintModule.resolvePublishScopeFolder;
  if (options.staleScope) {
    completionLintModule.resolvePublishScopeFolder = () => ({ folder: REAL_ROOT, stale: true });
  }
  if (options.scopeCheckThrows) {
    publishScopeCheckModule.runPublishScopeCheck = () => Promise.reject(new Error("scope check exploded"));
  }
  // The editor autofix commands (eslint.executeAutofix, formatDocument) are not
  // registered in the stub host; let them succeed so the deterministic pass
  // counts a real fix.
  const commandsStub = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const originalCommandOverride = commandsStub._executeCommandOverride;
  commandsStub._executeCommandOverride = (id: string): Promise<unknown> =>
    options.eslintUnavailable && id === "eslint.executeAutofix"
      ? Promise.reject(new Error("ESLint command unavailable"))
      : Promise.resolve(undefined);
  const originalGetDiagnostics = vscode.languages.getDiagnostics;
  (vscode.languages as unknown as Record<string, unknown>).getDiagnostics = () => options.diagnostics === "none" ? [] : [
    [
      vscode.Uri.file(path.join(REAL_ROOT, "src", "example.ts")),
      [{ source: "eslint", message: "no-unused-vars", severity: 0, range: undefined }],
    ],
  ];
  const scheduled: ScheduledCall[] = [];
  let aiCalls = 0;
  const flagFile = path.join(taskFolderPath, "ai-fixed.flag");
  const aiPatches: [Record<string, unknown>, string, unknown][] = [];
  const patch = (mod: Record<string, unknown>, key: string, value: unknown): void => {
    aiPatches.push([mod, key, mod[key]]);
    mod[key] = value;
  };
  const originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
  patch(
    promptTemplatesModule,
    "renderPromptTemplate",
    () => options.extensionFolderRemoved
      ? Promise.reject(new ExtensionFolderRemovedErrorV1())
      : Promise.resolve("prompt")
  );
  if (options.ai) {
    const ai = options.ai;
    patch(runEditActionModule, "checkEditActionAvailabilityV1", () => Promise.resolve({ ok: true }));
    patch(runEditActionModule, "runImplementationOrSealedV1", async (input: {
      onCandidateInvokedV1?: (info: { storedModelId: string; providerLabel: string; runnerId: string; operationId: string; attemptId: string; backup: boolean }) => Promise<void>;
    }) => {
      aiCalls += 1;
      if (ai.invokeCandidate) {
        await input.onCandidateInvokedV1?.({
          storedModelId: "stub-publish-model",
          providerLabel: "Test Provider",
          runnerId: "test-runner",
          operationId: "lint-fix-operation",
          attemptId: "lint-fix-attempt",
          backup: false,
        });
      }
      if (ai.fixes) {
        fs.writeFileSync(flagFile, "fixed", "utf8");
      }
      if (ai.cancels) {
        const operation = taskOperations.getLocalTaskOperations(taskFolderPath).find((item) => item.label === "Linting Fixes");
        if (operation) taskOperations.cancelOperation(operation.id, "viewer");
        return Promise.resolve({ status: "cancelled", filesChanged: ["src/example.ts"] });
      }
      return Promise.resolve({ status: "completed" });
    });
    patch(contextPackModule, "generateContextPack", () => Promise.resolve("context"));
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("prompt"));
    patch(promptSizeGuardModule, "checkAndConfirmPromptSize", (_prompt: string, _label: string, _count: number, task: { token?: vscode.CancellationToken }) => {
      if (ai.cancelAt !== "prompt-size") return Promise.resolve("ok");
      return new Promise((resolve) => {
        task.token?.onCancellationRequested(() => resolve("declined"));
        setTimeout(() => {
          const operation = taskOperations.getLocalTaskOperations(taskFolderPath).find((item) => item.label === "Linting Fixes");
          if (operation) taskOperations.cancelOperation(operation.id, "viewer");
        }, 0);
      });
    });
    patch(aiConsentModule, "ensureAiConsent", (_context: vscode.ExtensionContext, _folder: string, token: vscode.CancellationToken) => {
      if (ai.cancelAt !== "consent") return Promise.resolve(true);
      return new Promise((resolve) => {
        token.onCancellationRequested(() => resolve(false));
        setTimeout(() => {
          const operation = taskOperations.getLocalTaskOperations(taskFolderPath).find((item) => item.label === "Linting Fixes");
          if (operation) taskOperations.cancelOperation(operation.id, "viewer");
        }, 0);
      });
    });
    patch(reviewActionsModule, "isGitWorkspace", () => Promise.resolve(true));
    patch(reviewActionsModule, "getUnrelatedWorkspaceChanges", () => Promise.resolve([]));
    (vscode.workspace as unknown as Record<string, unknown>).getWorkspaceFolder = () => ({
      uri: vscode.Uri.file(REAL_ROOT),
      name: "root",
      index: 0,
    });
  }
  // A real freshness stamp on disk, classified by the real classifier against a
  // test-controlled HEAD: the parent "commit" moves HEAD, so the stamp is stale
  // until the (stubbed) Publish Checks command writes a new stamp for the new HEAD.
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  let currentHead = oldHead;
  const stampUri = vscode.Uri.file(taskFolderPath);
  const chainLog = {
    dispatchedWhileParentLive: -1,
    commands: [] as string[],
    reviewStampCommit: undefined as string | undefined,
    newHead,
  };
  const writeStamp = (sha: string, runId: string): Promise<void> =>
    writePublishChecksFreshnessStampV1(stampUri, {
      formatVersion: 1,
      runId,
      verifiedCommitSha: sha,
      completedAt: "2026-01-01T00:00:00.000Z",
      scopeId: computePublishScopeId(REAL_ROOT),
    });
  if (options.realChain) {
    await writeStamp(oldHead, "run-old");
  }
  const realChainFn = ((dispatch: Parameters<typeof scheduleAutomationChain>[0], root?: { id: string }) => {
    scheduled.push({
      command: dispatch.command,
      arg: dispatch.arg,
      root,
      markerLiveAtSchedule: hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
      dispatchEvenIfRootFails: dispatch.dispatchEvenIfRootFails,
    });
    return scheduleAutomationChain(dispatch, root, {
      onDidEnd: (listener) => taskOperations.onDidEnd(listener),
      execute: (command, arg) => {
        chainLog.commands.push(command);
        return checkAndReviewPublishV1(arg as never, {
          isPublishChecksFresh: async () =>
            classifyPublishChecksFreshnessV1(
              await readPublishChecksFreshnessStampV1(stampUri),
              REAL_ROOT,
              currentHead
            ).status === "valid",
          executeCommand: async (cmd) => {
            chainLog.commands.push(cmd);
            if (cmd === "vs-code-ai-helper.runPublishChecks") {
              await writeStamp(currentHead, "run-new");
            } else if (cmd === "vs-code-ai-helper.runReviewWithAI") {
              chainLog.reviewStampCommit = (await readPublishChecksFreshnessStampV1(stampUri))?.verifiedCommitSha;
            }
            return undefined;
          },
        });
      },
    });
  }) as typeof scheduleAutomationChain;
  const invoke = (parentOperation?: Parameters<typeof runLintingFixes>[4]): Promise<void> =>
    runLintingFixes(
      makeInventory(taskFolderPath, progress),
      vscode.Uri.file(REAL_ROOT),
      {
        taskFolderPath,
        testDeps: {
          scheduleChain: options.realChain ? realChainFn : ((
            dispatch: { command: string; arg?: unknown; dispatchEvenIfRootFails?: unknown },
            root?: unknown
          ) => {
            scheduled.push({
              command: dispatch.command,
              arg: dispatch.arg,
              root,
              markerLiveAtSchedule: hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
              dispatchEvenIfRootFails: dispatch.dispatchEvenIfRootFails,
            });
            return Promise.resolve();
          }) as never,
        },
      },
      options.ai ? ({ subscriptions: [] } as unknown as vscode.ExtensionContext) : undefined,
      parentOperation
    );
  try {
    let parentOpId: string | undefined;
    if (options.nested) {
      await runTrackedOperation(
        taskFolderPath,
        { label: "Commit and push", stage: "publish", kind: "commit-and-push" } as never,
        async (parent) => {
          parentOpId = parent.id;
          await invoke(parent);
          if (options.realChain?.headMoved) {
            currentHead = newHead;
          }
          if (options.realChain) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            chainLog.dispatchedWhileParentLive = chainLog.commands.length;
            if (options.realChain.parentFails) {
              throw new Error("commit failed");
            }
          }
        }
      ).catch((error: unknown) => {
        if (!options.realChain?.parentFails) {
          throw error;
        }
      });
      if (options.realChain) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } else {
      await invoke();
    }
    return {
      scheduled,
      review: fs.readFileSync(reviewPath, "utf8"),
      surface,
      taskFolderPath,
      parentOpId,
      aiCalls,
      decisions: new WorkflowDecisionStoreV1(memento).listPending(taskFolderPath),
      memento,
      progressBefore,
      chain: options.realChain ? chainLog : undefined,
    };
  } finally {
    for (const [mod, key, original] of aiPatches.reverse()) {
      mod[key] = original;
    }
    (vscode.workspace as unknown as Record<string, unknown>).getWorkspaceFolder = originalGetWorkspaceFolder;
    modelSelectionModule.ensureStageModelConfigured = originalEnsure;
    modelSelectionModule.resolveFreshModelForStage = originalFresh;
    runEditActionModule.checkEditActionAvailabilityV1 = originalAvailability;
    publishScopeCheckModule.runPublishScopeCheck = originalScope;
    completionLintModule.resolvePublishScopeFolder = originalResolveScope;
    (vscode.languages as unknown as Record<string, unknown>).getDiagnostics = originalGetDiagnostics;
    commandsStub._executeCommandOverride = originalCommandOverride;
    fs.rmSync(packageJsonPath, { force: true });
    fsTarget.readFile = originalReadFile;
    wsTarget.workspaceFolders = originalFolders;
    deactivateNotificationRouter();
    resetAutomationChainGuards();
    __extensionContextV1TestOnly.reset();
  }
}

void describe("runLintingFixes — RC6 item 5 execution paths", () => {
  void it("cancels during the AI phase, names its edits, and skips post-cancel checks and follow-up", async () => {
    const ended: TaskOperationSnapshot[] = [];
    const sub = taskOperations.onDidEnd((snapshot) => {
      if (snapshot.label === "Linting Fixes") ended.push(snapshot);
    });
    try {
      const result = await runFix("rc6-ai-cancel", 'node -e "process.exit(1)"', {
        ai: { fixes: true, cancels: true },
      });
      assert.equal(result.aiCalls, 1);
      assert.deepEqual(result.scheduled, []);
      assert.equal(ended.length, 1);
      assert.equal(ended[0]?.state, "cancelled");
      assert.match(ended[0]?.cancelReasonV1 ?? "", /src\/example\.ts/);
      assert.match(terminalEntryFor(ended[0])?.message ?? "", /cancelled.*src\/example\.ts/i);
      const recovery = result.decisions.find((decision) => decision.decisionKey === "chatActionOffer:runPublishChecks");
      assert.ok(recovery, "cancellation leaves an explicit task-chat recovery choice");
      assert.match(recovery.whatHappened, /was cancelled[\s\S]*src\/example\.ts[\s\S]*Review any retained edits/);
      assert.deepEqual(recovery.options.map((option) => option.label), [
        "Run Publish Checks", "Back to Implementation", "Not now",
      ]);
      assert.equal(recovery.recommendation.kind === "option" ? recovery.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(recovery.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.runPublishChecks",
        args: [{ taskFolderPath: result.taskFolderPath }],
      });
      assert.equal(await readPublishChecksFreshnessStampV1(vscode.Uri.file(result.taskFolderPath)), undefined);
    } finally {
      sub.dispose();
    }
  });

  for (const cancelAt of ["prompt-size", "consent"] as const) {
    void it(`cancels and settles while the ${cancelAt} confirmation is waiting`, async () => {
      const ended: TaskOperationSnapshot[] = [];
      const sub = taskOperations.onDidEnd((snapshot) => {
        if (snapshot.label === "Linting Fixes") ended.push(snapshot);
      });
      try {
        const result = await runFix(`rc6-cancel-${cancelAt}`, failUntilFlag(`rc6-cancel-${cancelAt}`), {
          ai: { fixes: true, cancelAt },
        });
        assert.equal(result.aiCalls, 0, "cancellation in a confirmation must happen before provider invocation");
        assert.deepEqual(result.scheduled, []);
        assert.equal(ended.at(-1)?.state, "cancelled");
        assert.equal(await readPublishChecksFreshnessStampV1(vscode.Uri.file(result.taskFolderPath)), undefined);
      } finally {
        sub.dispose();
      }
    });
  }

  void it("does not run AI or modify task progress when the extension folder disappeared before linting prompt setup", async () => {
    const result = await runFix("rc6-removed-extension", 'node -e "process.exit(0)"', {
      extensionFolderRemoved: true,
    });
    assert.equal(result.aiCalls, 0);
    assert.equal(
      fs.readFileSync(path.join(result.taskFolderPath, "task-progress.json"), "utf8"),
      result.progressBefore
    );
    assert.ok(
      result.surface.entries.some((entry) => /Linting fixes were not started/.test(entry.message)),
      "the user-facing notice should say linting fixes did not start"
    );
    const decision = result.decisions.find((item) => item.decisionKey === "chatActionOffer:workbench.view.extensions");
    assert.ok(decision, "the removed-extension hand-back must remain actionable in task chat");
    assert.match(decision.whatHappened, /extension resources are unavailable, so Publish Checks cannot run/);
    assert.deepEqual(decision.options.map((option) => option.label), ["Open Extensions", "Not now"]);
    assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
    assert.deepEqual(decision.options[0]?.effect, {
      kind: "command", command: "workbench.view.extensions", args: [],
    });
    await runFix("rc6-removed-extension", 'node -e "process.exit(0)"', { extensionFolderRemoved: true });
    const repeated = new WorkflowDecisionStoreV1(result.memento).listPending(result.taskFolderPath)
      .filter((item) => item.decisionKey === "chatActionOffer:workbench.view.extensions");
    assert.equal(repeated.length, 1, "repeated removed-extension reporting updates the existing decision");
    assert.deepEqual(result.scheduled, []);
  });

  void it("missing Publish report offers the actual Run Checks recovery and updates one card", async () => {
    const result = await runFix("rc6-missing-report-handback", 'node -e "process.exit(0)"', {
      missingReport: true,
    });
    assert.equal(result.aiCalls, 0, "the preflight hand-back must not start an editing round");
    assert.deepEqual(result.scheduled, []);
    assert.match(result.surface.entries[0]?.message ?? "", /Publish Checks have not run yet\. Run them first\./);
    const decision = result.decisions.find((item) => item.decisionKey === "chatActionOffer:runPublishChecks");
    assert.ok(decision, "the real missing-report path must offer its recovery in chat");
    assert.match(decision.whatHappened, /Publish Checks have not run yet/);
    assert.deepEqual(decision.options.map((option) => option.label), ["Run Publish Checks", "Back to Implementation", "Not now"]);
    assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
    assert.deepEqual(decision.options[0]?.effect, {
      kind: "command", command: "vs-code-ai-helper.runPublishChecks", args: [{ taskFolderPath: result.taskFolderPath }],
    });

    await offerLintFixRecoveryInChatV1(result.taskFolderPath, "Task", "Publish Checks have not run yet. Run them first.");
    const duplicates = new WorkflowDecisionStoreV1(result.memento).listPending(result.taskFolderPath)
      .filter((item) => item.decisionKey === "chatActionOffer:runPublishChecks");
    assert.equal(duplicates.length, 1, "repeated terminal reporting updates the same recovery card");
  });

  void it("stale Publish scope offers the actual checks-first recovery and updates one card", async () => {
    const result = await runFix("rc6-stale-scope-handback", 'node -e "process.exit(0)"', { staleScope: true });
    assert.equal(result.aiCalls, 0, "a stale scope must stop before fixes are applied");
    assert.deepEqual(result.scheduled, []);
    assert.match(result.surface.entries[0]?.message ?? "", /no valid Publish verification scope could be resolved/);
    const decision = result.decisions.find((item) => item.decisionKey === "chatActionOffer:runPublishChecks");
    assert.ok(decision, "the stale-scope branch must offer its recovery in task chat");
    assert.match(decision.whatHappened, /saved scope or the task's project-root binding no longer exists/);
    assert.deepEqual(decision.options.map((option) => option.label), ["Run Publish Checks", "Back to Implementation", "Not now"]);
    assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
    assert.deepEqual(decision.options[0]?.effect, {
      kind: "command", command: "vs-code-ai-helper.runPublishChecks", args: [{ taskFolderPath: result.taskFolderPath }],
    });

    await runFix("rc6-stale-scope-handback", 'node -e "process.exit(0)"', { staleScope: true });
    const repeated = new WorkflowDecisionStoreV1(result.memento).listPending(result.taskFolderPath)
      .filter((item) => item.decisionKey === "chatActionOffer:runPublishChecks");
    assert.equal(repeated.length, 1, "a repeated stale-scope hand-back updates one card");
  });

  void it("deterministic success marks the review stale and schedules the Publish review once, after the marker is gone", async () => {
    const result = await runFix("rc6-det-success", 'node -e "process.exit(0)"');    assert.equal(result.scheduled.length, 1);
    assert.equal(result.scheduled[0]?.command, "vs-code-ai-helper.checkAndReviewPublish");
    assert.deepEqual(result.scheduled[0]?.arg, { taskFolderPath: result.taskFolderPath });
    assert.equal(result.scheduled[0]?.root, undefined, "a standalone fix has no live root operation");
    assert.equal(result.scheduled[0]?.markerLiveAtSchedule, false, "the review may only start once the marker is gone");
    assert.match(result.review, /> ⚠ Stale: superseded by an update to workspace files \(Fix Linting & Code Errors\) at /);
  });

  void it("still-failing checks write the failing-checks note under the banner and schedule nothing", async () => {
    const result = await runFix("rc6-still-failing", 'node -e "process.exit(1)"');
    assert.equal(result.scheduled.length, 0);
    assert.match(result.review, /> ⚠ Stale: superseded by an update to workspace files/);
    assert.match(result.review, /> Publish Checks still fail after the fix: /);
  });

  void it("still-failing deterministic checks with unavailable AI offer the checks-first recovery once", async () => {
    const result = await runFix("rc6-still-failing-handback", 'node -e "process.exit(1)"', { diagnostics: "none" });
    const decisions = result.decisions.filter((item) => item.decisionKey === "chatActionOffer:runPublishChecks");
    assert.equal(decisions.length, 1);
    const decision = decisions[0];
    assert.ok(decision);
    assert.match(decision.whatHappened, /AI final fixes are unavailable: no model/);
    assert.match(decision.whatHappened, /Checks summary: unrun\/untested: npm run test/);
    assert.deepEqual(decision.options.map((option) => option.label), ["Run Publish Checks", "Back to Implementation", "Not now"]);
    assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
    assert.deepEqual(decision.options[0]?.effect, {
      kind: "command", command: "vs-code-ai-helper.runPublishChecks", args: [{ taskFolderPath: result.taskFolderPath }],
    });
    assert.deepEqual(decision.options[1]?.effect, {
      kind: "command", command: "vs-code-ai-helper.setTaskStage", args: [{ taskFolderPath: result.taskFolderPath, stage: "implementation" }],
    });

    await runFix("rc6-still-failing-handback", 'node -e "process.exit(1)"', { diagnostics: "none" });
    const repeated = new WorkflowDecisionStoreV1(result.memento).listPending(result.taskFolderPath)
      .filter((item) => item.decisionKey === "chatActionOffer:runPublishChecks");
    assert.equal(repeated.length, 1, "repeated unavailable-AI hand-backs update rather than duplicate the decision");
  });

  void it("an error after a passing lint result schedules nothing and writes no note", async () => {
    const result = await runFix("rc6-error-after-pass", 'node -e "process.exit(0)"', { scopeCheckThrows: true });
    assert.equal(result.scheduled.length, 0);
    assert.match(result.review, /> ⚠ Stale: superseded by an update to workspace files/);
    assert.doesNotMatch(result.review, /Publish Checks (still fail|pass) after the fix/);
    assert.ok(result.surface.entries.some((e) => e.level === "error" && /scope check exploded/.test(e.message)));
  });

  for (const scenario of [
    {
      name: "AI edits were applied but their checks still fail",
      options: { ai: { fixes: true } } as const,
      testScript: 'node -e "process.exit(1)"',
      expected: /AI final fixes were applied, but checks still fail/,
    },
    {
      name: "final check outcome is unconfirmed",
      options: { scopeCheckThrows: true } as const,
      testScript: 'node -e "process.exit(0)"',
      expected: /Linting fixes failed: scope check exploded\..*final checks could not be confirmed/,
    },
    {
      name: "ESLint autofix is unavailable",
      options: { eslintUnavailable: true } as const,
      testScript: 'node -e "process.exit(0)"',
      expected: /Could not apply automatic fixes because the ESLint extension is unavailable/,
    },
    {
      name: "no automatic fixes were available",
      options: { diagnostics: "none" as const },
      testScript: 'node -e "process.exit(0)"',
      expected: /No automatic fixes were available/,
    },
  ]) {
    void it(`renders a reasoned recovery card when ${scenario.name}`, async () => {
      const result = await runFix(
        `rc6-handback-${scenario.name.replace(/\W+/g, "-").toLowerCase()}`,
        scenario.testScript,
        scenario.options
      );
      const decisions = result.decisions.filter((decision) => decision.decisionKey === "chatActionOffer:runPublishChecks");
      assert.equal(decisions.length, 1, "the terminal branch posts one actionable card");
      const decision = decisions[0];
      assert.ok(decision);
      assert.match(decision.whatHappened, scenario.expected);
      assert.deepEqual(decision.options.map((option) => option.label), [
        "Run Publish Checks", "Back to Implementation", "Not now",
      ]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(decision.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.runPublishChecks",
        args: [{ taskFolderPath: result.taskFolderPath }],
      });
      assert.deepEqual(decision.options[1]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.setTaskStage",
        args: [{ taskFolderPath: result.taskFolderPath, stage: "implementation" }],
      });
    });
  }

  const failUntilFlag = (name: string): string =>
    "node -e \"process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 1)\" \"" +
    path.join(REAL_ROOT, name, "ai-fixed.flag").replace(/\\/g, "/") +
    "\"";

  void it("AI-path success schedules the Publish review once, after the marker is gone", async () => {
    const result = await runFix("rc6-ai-success", failUntilFlag("rc6-ai-success"), { ai: { fixes: true } });
    assert.equal(result.aiCalls, 1);
    assert.equal(result.scheduled.length, 1);
    assert.equal(result.scheduled[0]?.command, "vs-code-ai-helper.checkAndReviewPublish");
    assert.deepEqual(result.scheduled[0]?.arg, { taskFolderPath: result.taskFolderPath });
    assert.equal(result.scheduled[0]?.root, undefined);
    assert.equal(result.scheduled[0]?.markerLiveAtSchedule, false);
    assert.match(result.review, /> ⚠ Stale: superseded by an update to workspace files/);
  });

  void it("writes a correlated run log with the dispatch chain before invocation and the terminal result", async () => {
    const result = await runFix("rc6-ai-run-log", failUntilFlag("rc6-ai-run-log"), {
      ai: { fixes: true, invokeCandidate: true },
    });
    const runLogPath = path.join(result.taskFolderPath, "runs", "001-test-runner-publish.md");
    const runLog = fs.readFileSync(runLogPath, "utf8");
    assert.match(runLog, /Test Provider — stub-publish-model/);
    assert.match(runLog, /Operation: lint-fix-operation/);
    assert.match(runLog, /Terminal outcome/);
    assert.match(runLog, /completed: lint fixes and required follow-up checks passed/);
  });

  void it("AI pass completed but checks still fail writes the failing-checks note and schedules nothing", async () => {
    const result = await runFix("rc6-ai-still-failing", failUntilFlag("rc6-ai-still-failing"), {
      ai: { fixes: false },
    });
    assert.equal(result.aiCalls, 1);
    assert.equal(result.scheduled.length, 0);
    assert.match(result.review, /> Publish Checks still fail after the fix: /);
  });

  void it("an error on the AI path schedules nothing and writes no note", async () => {
    const result = await runFix("rc6-ai-error", failUntilFlag("rc6-ai-error"), {
      ai: { fixes: true },
      scopeCheckThrows: true,
    });
    assert.equal(result.scheduled.length, 0);
    assert.doesNotMatch(result.review, /Publish Checks (still fail|pass) after the fix/);
    assert.ok(result.surface.entries.some((e) => e.level === "error" && /scope check exploded/.test(e.message)));
  });

  void it("a nested fix schedules the Publish review behind the parent's root operation", async () => {
    const result = await runFix("rc6-nested-success", 'node -e "process.exit(0)"', { nested: true });
    assert.equal(result.scheduled.length, 1);
    assert.deepEqual(result.scheduled[0]?.arg, { taskFolderPath: result.taskFolderPath });
    assert.deepEqual(result.scheduled[0]?.root, { id: result.parentOpId });
    assert.equal(result.scheduled[0]?.dispatchEvenIfRootFails, true);
  });

  for (const parentFails of [false, true]) {
    void it(`a nested fix dispatches the Publish review once, after the live parent ends (parent ${
      parentFails ? "fails" : "succeeds"
    }), rerunning Publish Checks first when HEAD moved`, async () => {
      const result = await runFix(`rc6-nested-real-${parentFails ? "fail" : "ok"}`, 'node -e "process.exit(0)"', {
        nested: true,
        realChain: { parentFails, headMoved: true },
      });
      assert.equal(result.chain?.dispatchedWhileParentLive, 0, "nothing dispatches while the parent is live");
      assert.deepEqual(result.chain?.commands, [
        "vs-code-ai-helper.checkAndReviewPublish",
        "vs-code-ai-helper.runPublishChecks",
        "vs-code-ai-helper.runReviewWithAI",
      ]);
      assert.equal(
        result.chain?.reviewStampCommit,
        result.chain?.newHead,
        "the review runs against a stamp naming the new commit"
      );
    });
  }

  void it("a nested fix whose checks still fail writes the note and schedules nothing", async () => {
    const result = await runFix("rc6-nested-still-failing", 'node -e "process.exit(1)"', { nested: true });
    assert.equal(result.scheduled.length, 0);
    assert.match(result.review, /> Publish Checks still fail after the fix: /);
  });
});
