/**
 * Step 31 connected regression: drive the REAL `runLintingFixes` rerun and its
 * own freshness-stamp write in a real git workspace, then carry the evidence it
 * generated (the stamp, the recorded Completion Checks report and the run id)
 * through the real `checkAndReviewPublishV1` hand-off, the review's
 * `buildVerifiedChecksVariable` reuse and the dispatch/save revalidation.
 *
 * Nothing is written by hand: the stamp, the report and the run id all come
 * from the fix. The check command appends to a counter file kept OUTSIDE the
 * repository, so "no second suite run" is observed as a count, not assumed.
 */
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runLintingFixes } from "../commands/runLintingFixes";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { resetAutomationChainGuards } from "../utils/automationChain";
import { checkAndReviewPublishV1 } from "../commands/checkAndReviewPublish";
import {
  checkPublishChecksFreshnessV1,
  isReusedPublishChecksRunStillCurrentV1,
  readPublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import { buildVerifiedChecksVariable } from "../commands/reviewActions";
import { revalidatePublishFreshnessOrThrowV1, ReviewPromotionErrorV1 } from "../actions/rows/reviewRowV1";
import { safeRemoveDir } from "./testFsUtils";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const promptSizeGuardModule = require("../utils/promptSizeGuard") as Record<string, unknown>;
const aiConsentModule = require("../utils/aiConsent") as Record<string, unknown>;
const reviewActionsModule = require("../commands/reviewActions") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

interface FixToReviewFixture {
  readonly root: string;
  readonly taskFolder: string;
  readonly taskFolderUri: vscode.Uri;
  readonly counterFile: string;
  readonly flagFile: string;
  readonly suiteRuns: () => number;
  readonly headSha: () => string;
  readonly dispose: () => void;
}

function git(cwd: string, command: string): string {
  return childProcess.execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** A real git workspace whose only check passes once `fixed.flag` exists, and counts its own runs. */
function createFixture(name: string): FixToReviewFixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `ensemble-fix-to-review-${name}-`));
  const root = path.join(parent, "workspace");
  fs.mkdirSync(root, { recursive: true });
  const counterFile = path.join(parent, "suite-runs.log");
  const checkScript = path.join(parent, "check.js");
  const flagFile = path.join(root, "fixed.flag");
  fs.writeFileSync(
    checkScript,
    [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(counterFile)}, 'run\\n');`,
      `process.exit(fs.existsSync(${JSON.stringify(flagFile)}) ? 0 : 1);`,
      "",
    ].join("\n"),
    "utf8"
  );
  const nodeCheck = (script: string): string => `node ${JSON.stringify(script)}`;
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: `fix-to-review-${name}`,
      scripts: {
        lint: 'node -e "process.exit(0)"',
        "check-types": 'node -e "process.exit(0)"',
        test: nodeCheck(checkScript),
        build: 'node -e "process.exit(0)"',
      },
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "file.ts"), "export const a = 1;\n", "utf8");
  git(root, "init");
  git(root, "config user.name 'Test User'");
  git(root, "config user.email 'test@example.com'");
  git(root, "add -A");
  git(root, "commit -m init");

  const taskFolder = path.join(root, ".ensemble", `2026-10-24_${name}`);
  fs.mkdirSync(taskFolder, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: path.basename(taskFolder),
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.dirname(taskFolder),
      projectRoot: root,
      boundAt: "2026-07-01T09:00:00.000Z",
      state: "resolved",
    },
    lintPayload: {
      runAt: "2026-01-01T00:00:00.000Z",
      passed: false,
      summary: "1 check failed",
      issueCount: 1,
      failedChecks: [],
    },
  };
  fs.writeFileSync(path.join(taskFolder, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  fs.writeFileSync(
    path.join(taskFolder, "publish-review.md"),
    "# Publish Review\n\nReadiness: 6/10\n\nNeeds changes.\n",
    "utf8"
  );
  return {
    root,
    taskFolder,
    taskFolderUri: vscode.Uri.file(taskFolder),
    counterFile,
    flagFile,
    suiteRuns: () => (fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0),
    headSha: () => git(root, "rev-parse HEAD"),
    dispose: () => safeRemoveDir(parent),
  };
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

/**
 * Runs the real fix on the AI path. `fixes` makes the stubbed edit round create
 * the flag file (a real working-tree edit made before the fix's own rerun).
 */
async function runRealFix(
  fixture: FixToReviewFixture,
  fixes: boolean
): Promise<{ scheduled: { command: string; arg: unknown }[]; surface: RecordingSurface }> {
  const progress = JSON.parse(fs.readFileSync(path.join(fixture.taskFolder, "task-progress.json"), "utf8")) as TaskProgress;
  const surface = new RecordingSurface();
  initNotificationRouter(surface);
  const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
  const originalFolders = wsTarget.workspaceFolders;
  const originalGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
  wsTarget.workspaceFolders = [{ uri: vscode.Uri.file(fixture.root), name: "root", index: 0 }];
  (vscode.workspace as unknown as Record<string, unknown>).getWorkspaceFolder = (): unknown => ({
    uri: vscode.Uri.file(fixture.root),
    name: "root",
    index: 0,
  });
  const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalReadFile = fsTarget.readFile;
  fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  const commandsStub = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const originalCommandOverride = commandsStub._executeCommandOverride;
  commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  const originalGetDiagnostics = vscode.languages.getDiagnostics;
  (vscode.languages as unknown as Record<string, unknown>).getDiagnostics = (): unknown[] => [];

  const patches: [Record<string, unknown>, string, unknown][] = [];
  const patch = (mod: Record<string, unknown>, key: string, value: unknown): void => {
    patches.push([mod, key, mod[key]]);
    mod[key] = value;
  };
  patch(modelSelectionModule, "ensureStageModelConfigured", () => Promise.resolve(true));
  patch(modelSelectionModule, "resolveFreshModelForStage", () =>
    Promise.resolve({ modelId: "stub-publish-model", source: "workspace" })
  );
  patch(runEditActionModule, "checkEditActionAvailabilityV1", () => Promise.resolve({ ok: true }));
  patch(runEditActionModule, "runImplementationOrSealedV1", () => {
    if (fixes) {
      fs.writeFileSync(fixture.flagFile, "fixed", "utf8");
    }
    return Promise.resolve({ status: "completed" });
  });
  patch(contextPackModule, "generateContextPack", () => Promise.resolve("context"));
  patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("prompt"));
  patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok"));
  patch(aiConsentModule, "ensureAiConsent", () => Promise.resolve(true));
  patch(reviewActionsModule, "isGitWorkspace", () => Promise.resolve(true));
  patch(reviewActionsModule, "getUnrelatedWorkspaceChanges", () => Promise.resolve([]));

  const scheduled: { command: string; arg: unknown }[] = [];
  try {
    await runLintingFixes(
      makeInventory(fixture.taskFolder, progress),
      vscode.Uri.file(fixture.root),
      {
        taskFolderPath: fixture.taskFolder,
        testDeps: {
          scheduleChain: ((dispatch: { command: string; arg?: unknown }) => {
            scheduled.push({ command: dispatch.command, arg: dispatch.arg });
            return Promise.resolve();
          }) as never,
        },
      },
      { subscriptions: [] } as unknown as vscode.ExtensionContext
    );
    return { scheduled, surface };
  } finally {
    for (const [mod, key, original] of patches.reverse()) {
      mod[key] = original;
    }
    (vscode.languages as unknown as Record<string, unknown>).getDiagnostics = originalGetDiagnostics;
    commandsStub._executeCommandOverride = originalCommandOverride;
    fsTarget.readFile = originalReadFile;
    (vscode.workspace as unknown as Record<string, unknown>).getWorkspaceFolder = originalGetWorkspaceFolder;
    wsTarget.workspaceFolders = originalFolders;
    deactivateNotificationRouter();
    resetAutomationChainGuards();
  }
}

/** Runs the real hand-off with the real on-disk freshness probe the command uses. */
async function runRealHandoff(fixture: FixToReviewFixture): Promise<string[]> {
  const executed: string[] = [];
  const outcome = await checkAndReviewPublishV1(
    { taskFolderPath: fixture.taskFolder },
    {
      isPublishChecksFresh: async () =>
        (await checkPublishChecksFreshnessV1(fixture.taskFolderUri, fixture.root, fixture.headSha())).status === "valid",
      executeCommand: (command) => {
        executed.push(command);
        return Promise.resolve(undefined);
      },
    }
  );
  assert.equal(outcome, "review-dispatched");
  return executed;
}

void describe("Step 31 — fix rerun to Publish review reuse, connected end to end", () => {
  void it("a passing fix rerun's own stamp and report flow to the review with no Publish Checks and no second suite run", async () => {
    const fixture = createFixture("pass");
    const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    try {
      const fix = await runRealFix(fixture, true);
      assert.equal(fix.scheduled.length, 1, "the passing fix schedules exactly one follow-up");
      assert.equal(fix.scheduled[0]?.command, "vs-code-ai-helper.checkAndReviewPublish");
      const suiteRunsAfterFix = fixture.suiteRuns();
      assert.ok(suiteRunsAfterFix >= 1, "the fix's own rerun executed the suite");

      // The stamp is the one the fix wrote — not a hand-built one.
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
        fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
      const stamp = await readPublishChecksFreshnessStampV1(fixture.taskFolderUri);
      assert.ok(stamp, "the fix's rerun wrote a freshness stamp");
      assert.equal(stamp.verifiedCommitSha, fixture.headSha());
      assert.ok(stamp.treeFingerprint, "the fix's stamp carries a tree fingerprint");

      // Real hand-off: fresh stamp -> straight to the review, no Publish Checks.
      const executed = await runRealHandoff(fixture);
      assert.deepEqual(executed, ["vs-code-ai-helper.runReviewWithAI"]);

      // Review verification reuses the fix's evidence and cites the fix's run id.
      const verified = await buildVerifiedChecksVariable(
        fixture.taskFolderUri,
        [],
        undefined,
        false,
        "publish",
        fixture.headSha()
      );
      assert.ok(verified.reusedPublishChecks, "the review reuses the fix's recorded passing results");
      assert.equal(verified.reusedPublishChecks.runId, stamp.runId);
      assert.equal(verified.reusedPublishChecks.treeFingerprint, stamp.treeFingerprint);
      assert.ok(verified.verifiedChecks.includes(`Reused recorded passing Publish Checks run \`${stamp.runId}\``));
      assert.equal(fixture.suiteRuns(), suiteRunsAfterFix, "no second suite run for fresh passing evidence");

      // Dispatch and save revalidation accept the unchanged tree and the cited run.
      const guard = {
        taskFolderPath: fixture.taskFolder,
        scopeFolderPath: fixture.root,
        runId: verified.reusedPublishChecks.runId,
        verifiedCommitSha: fixture.headSha(),
        treeFingerprint: verified.reusedPublishChecks.treeFingerprint,
      };
      await revalidatePublishFreshnessOrThrowV1(guard);
      assert.equal(isReusedPublishChecksRunStillCurrentV1(guard.runId, stamp.runId), true);

      // An uncommitted tracked edit with the same HEAD refuses reuse at save.
      fs.writeFileSync(path.join(fixture.root, "file.ts"), "export const a = 42;\n", "utf8");
      await assert.rejects(() => revalidatePublishFreshnessOrThrowV1(guard), ReviewPromotionErrorV1);
      const afterEdit = await buildVerifiedChecksVariable(
        fixture.taskFolderUri,
        [],
        undefined,
        false,
        "publish",
        fixture.headSha()
      );
      assert.equal(afterEdit.reusedPublishChecks, undefined, "an edited tree never cites the fix's run");

      // A commit made after the fix's rerun makes the stamp stale for the hand-off.
      git(fixture.root, "add -A");
      git(fixture.root, "commit -m intervening");
      const stale = await checkPublishChecksFreshnessV1(fixture.taskFolderUri, fixture.root, fixture.headSha());
      assert.equal(stale.status, "staleCommit");
      const staleExecuted = await (async (): Promise<string[]> => {
        const executedStale: string[] = [];
        await checkAndReviewPublishV1(
          { taskFolderPath: fixture.taskFolder },
          {
            isPublishChecksFresh: async () =>
              (await checkPublishChecksFreshnessV1(fixture.taskFolderUri, fixture.root, fixture.headSha())).status ===
              "valid",
            executeCommand: (command) => {
              executedStale.push(command);
              return Promise.resolve(undefined);
            },
          }
        );
        return executedStale;
      })();
      assert.equal(
        staleExecuted[0],
        "vs-code-ai-helper.runPublishChecks",
        "a stale stamp sends the hand-off back through Publish Checks, never straight to review"
      );
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      fixture.dispose();
    }
  });

  void it("a fix whose rerun still fails dispatches nothing and writes no stamp the review could reuse", async () => {
    const fixture = createFixture("fail");
    const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    try {
      const fix = await runRealFix(fixture, false);
      assert.deepEqual(fix.scheduled, [], "a failed rerun schedules no follow-up");
      assert.ok(fixture.suiteRuns() >= 1, "the fix did rerun the suite");

      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
        fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
      const stamp = await readPublishChecksFreshnessStampV1(fixture.taskFolderUri);
      assert.equal(stamp, undefined, "no stamp is written for failing checks");
      const verified = await buildVerifiedChecksVariable(
        fixture.taskFolderUri,
        [],
        undefined,
        false,
        "publish",
        fixture.headSha()
      );
      assert.equal(verified.reusedPublishChecks, undefined, "nothing is reusable after a failed rerun");
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      fixture.dispose();
    }
  });
});
