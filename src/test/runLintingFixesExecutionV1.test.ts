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

import { runLintingFixes } from "../commands/runLintingFixes";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { runTrackedOperation, taskOperations } from "../utils/taskOperations";
import { resetAutomationChainGuards, scheduleAutomationChain } from "../utils/automationChain";
import { checkAndReviewPublishV1 } from "../commands/checkAndReviewPublish";
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
    scopeCheckThrows?: boolean;
    /** Drive the AI pass: `fixes` makes the stubbed edit action repair the checks. */
    ai?: { fixes: boolean };
    /** Run as the commit-and-push flow's child under a live parent operation. */
    nested?: boolean;
    /**
     * Nested only: drive the REAL deferred chain and the real
     * `checkAndReviewPublishV1` (with recording command deps) instead of a
     * recorder. `headMoved` models a commit made by the parent flow, which
     * leaves the Publish Checks stamp stale until the checks command runs.
     */
    realChain?: { parentFails: boolean; headMoved: boolean };
  } = {}
): Promise<{
  scheduled: ScheduledCall[];
  review: string;
  surface: RecordingSurface;
  taskFolderPath: string;
  parentOpId?: string;
  aiCalls: number;
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
    lintPayload: {
      runAt: "2026-01-01T00:00:00.000Z",
      passed: false,
      summary: "1 check failed",
      issueCount: 1,
      failedChecks: [],
    },
  };
  fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
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
  commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  const originalGetDiagnostics = vscode.languages.getDiagnostics;
  (vscode.languages as unknown as Record<string, unknown>).getDiagnostics = () => [
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
  if (options.ai) {
    const ai = options.ai;
    patch(runEditActionModule, "checkEditActionAvailabilityV1", () => Promise.resolve({ ok: true }));
    patch(runEditActionModule, "runImplementationOrSealedV1", () => {
      aiCalls += 1;
      if (ai.fixes) {
        fs.writeFileSync(flagFile, "fixed", "utf8");
      }
      return Promise.resolve({ status: "completed" });
    });
    patch(contextPackModule, "generateContextPack", () => Promise.resolve("context"));
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("prompt"));
    patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok"));
    patch(aiConsentModule, "ensureAiConsent", () => Promise.resolve(true));
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
    (vscode.languages as unknown as Record<string, unknown>).getDiagnostics = originalGetDiagnostics;
    commandsStub._executeCommandOverride = originalCommandOverride;
    fs.rmSync(packageJsonPath, { force: true });
    fsTarget.readFile = originalReadFile;
    wsTarget.workspaceFolders = originalFolders;
    deactivateNotificationRouter();
    resetAutomationChainGuards();
  }
}

void describe("runLintingFixes — RC6 item 5 execution paths", () => {
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

  void it("an error after a passing lint result schedules nothing and writes no note", async () => {
    const result = await runFix("rc6-error-after-pass", 'node -e "process.exit(0)"', { scopeCheckThrows: true });
    assert.equal(result.scheduled.length, 0);
    assert.match(result.review, /> ⚠ Stale: superseded by an update to workspace files/);
    assert.doesNotMatch(result.review, /Publish Checks (still fail|pass) after the fix/);
    assert.ok(result.surface.entries.some((e) => e.level === "error" && /scope check exploded/.test(e.message)));
  });

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
