/**
 * Work-admission wiring for runPublishChecks (v1 fixes item 1, Part 1a,
 * "publish/complete actions" route) against the EXACT dispatch shape
 * `applyCurrentStageAction` sends — { canonicalId, taskFolderPath,
 * task: { progress }, admissionHandoffTokenV1? } — and, through it, the
 * shape `scheduleTaskResume.ts`'s `fire()` forwards for a scheduled Publish
 * stage action.
 *
 * 2026-09-09 review completion blocker: `extractSynchronousPublishChecksFolderPathV1`
 * used to read `node.task.folderUri.fsPath` unconditionally, before checking
 * the explicit `taskFolderPath`/`canonicalId` fields — `applyCurrentStageAction`'s
 * `task` is a PARTIAL object carrying only `progress`, with no `folderUri`,
 * so every Publish dispatch through that router (including scheduled firing)
 * threw before admission or any check ever ran. It also never accepted or
 * adopted `admissionHandoffTokenV1`, so a scheduled dispatch that already
 * held live admission for the task (scheduleTaskResume.ts's `fire()`) always
 * raced a fresh genesis against its own marker and observed `busy`.
 *
 * Mirrors `generatePlanWithAIWorkAdmission.test.ts`'s coverage shape.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runPublishChecks } from "../commands/runPublishChecks";
import { completeCommitAndPushTask } from "../commands/commitAndPushTask";
import { peekTaskFolderPathSynchronouslyV1, resolveTaskContext } from "../utils/resolveTaskContext";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import {
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  hasLiveWorkAdmissionBestEffortV1,
} from "../state/workAdmissionV1";
import { STALLED_ACTIVE_TASK_PAUSE_REASON_V1 } from "../utils/taskWatchdogV1";
import { safeRemoveDir } from "./testFsUtils";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { runFastForwardPublishChecksV1 } from "../utils/fastForwardPublishChecksV1";
import { readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { listCheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";
import { associatePublishFailuresWithPlanItemsV1 } from "../utils/publishFailurePlanAssociationV1";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import { taskOperations } from "../utils/taskOperations";
import type { TaskOperationSnapshot } from "../utils/taskOperations";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-checks-admission-"));

/**
 * Nested two levels inside `REAL_ROOT` (not directly under it): the session
 * lock `withTaskLock`/`reconcileWatchdogPauseAgainstAdmissionV1` acquire
 * lives TWO levels above the task folder (`taskStateStore.ts`'s
 * `metaLocksForTasksRoot`) — a folder placed only one level under `REAL_ROOT`
 * would put that lock at `REAL_ROOT`'s PARENT, i.e. the shared `os.tmpdir()`
 * every parallel test-file process contends over (see
 * `taskFolderFixture.ts`'s `makeOwnedTaskFolder` doc comment for the same
 * hazard). Nesting under `tasks/` keeps the lock inside this file's own
 * private mkdtemp root.
 */
function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

/**
 * The "no model configured" guard fires `vs-code-ai-helper.openAiModels`
 * without awaiting it; with nothing registered the stub host rejects it after
 * the test has ended. Register a no-op for the test's duration.
 */
function stubOpenAiModelsCommand(): { restore: () => void } {
  const registration = vscode.commands.registerCommand("vs-code-ai-helper.openAiModels", () => undefined);
  return {
    restore: (): void => {
      registration.dispose();
    },
  };
}

/* eslint-disable @typescript-eslint/no-var-requires */
const completionLintModule = require("../utils/completionLint") as Record<string, unknown>;
const publishScopeCheckModule = require("../utils/publishScopeCheck") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const gitRepoInfoModule = require("../utils/gitRepoInfo") as Record<string, unknown>;
const failedPublishRunModule = require("../utils/failedPublishRunV1") as Record<string, unknown>;

/**
 * Lets `runPublishChecks` run to a result without a model, git or real
 * lint/test processes: the model guard passes and the check run is a counted
 * stub, so a lint call proves the run got past the stage guard.
 */
function stubPublishChecksRun(result: unknown = { passed: true, summary: "stubbed checks passed" }): { lintCalls: () => number; restore: () => void } {
  const originals = {
    ensure: modelSelectionModule.ensureStageModelConfigured,
    lint: completionLintModule.runCompletionLint,
    scope: publishScopeCheckModule.runPublishScopeCheck,
    sha: gitRepoInfoModule.resolveHeadCommitSha,
  };
  let lintCalls = 0;
  modelSelectionModule.ensureStageModelConfigured = (): Promise<boolean> => Promise.resolve(true);
  completionLintModule.runCompletionLint = (): Promise<unknown> => {
    lintCalls += 1;
    return Promise.resolve(result);
  };
  publishScopeCheckModule.runPublishScopeCheck = (): Promise<void> => Promise.resolve();
  gitRepoInfoModule.resolveHeadCommitSha = (): Promise<undefined> => Promise.resolve(undefined);
  return {
    lintCalls: () => lintCalls,
    restore: (): void => {
      modelSelectionModule.ensureStageModelConfigured = originals.ensure;
      completionLintModule.runCompletionLint = originals.lint;
      publishScopeCheckModule.runPublishScopeCheck = originals.scope;
      gitRepoInfoModule.resolveHeadCommitSha = originals.sha;
    },
  };
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

function fixtureProgress(
  taskFolderPath: string,
  overrides: Partial<TaskProgress> = {}
): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "plan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
    ...overrides,
  };
}

/**
 * A fake inventory resolving exactly one task by canonical ID or path —
 * mirrors `resolveTaskContext`'s `lookupInInventory` needs, with the
 * suppression-alias lookups stubbed to `undefined` (never exercised here).
 */
function makeInventory(taskFolderPath: string, progress: TaskProgress): TaskInventory {
  const task = {
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    sourceScopeKey: taskFolderPath,
    progress,
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? task : undefined),
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [task],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

/** The exact shape `applyCurrentStageAction`'s `execute()` dispatches: explicit
 * fields plus a PARTIAL `task` carrying only `progress` (no `folderUri`). */
function applyCurrentStageActionDispatchArg(
  taskFolderPath: string,
  progress: TaskProgress,
  admissionHandoffTokenV1?: string
): { canonicalId: string; taskFolderPath: string; task: { progress: TaskProgress }; admissionHandoffTokenV1?: string } {
  return {
    canonicalId: taskFolderPath,
    taskFolderPath,
    task: { progress },
    admissionHandoffTokenV1,
  };
}

void describe("runPublishChecks work admission against applyCurrentStageAction's dispatch shape (v1 fixes item 1, Part 1a)", () => {
  void it("associates a failed acceptance test before invalidation and preserves the durable relationship", async () => {
    const taskFolderPath = makeTaskFolder("publish-failure-association-order");
    const itemText = "Step 1: Keep retry handling working";
    const progress = fixtureProgress(taskFolderPath, {
      currentStage: "publish",
      planItemEvidence: [{
        planRevision: "plan-revision",
        itemKey: "step 1",
        itemText,
        claims: [{ source: "implementation", at: "2026-10-26T00:00:00.000Z", roundId: "impl-1" }],
        testReports: [{
          at: "2026-10-26T00:01:00.000Z",
          roundId: "impl-1",
          testIdentity: path.join(taskFolderPath, "src/test/retry.test.ts"),
          command: "node out/test/retry.test.js",
          workingDirectory: taskFolderPath,
          passed: 2,
          failed: 0,
          sourceState: "post-edit",
          sourceFiles: ["src/retry.ts"],
        }],
      }],
    });
    writeProgress(taskFolderPath, progress);
    fs.writeFileSync(path.join(taskFolderPath, "plan-final.md"), `<!-- ensemble:implementation-checklist -->\n\n# Plan\n\n- [x] ${itemText}\n`, "utf8");

    const surface = new RecordingSurface();
    const decisionState = fakeStatefulMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(REAL_ROOT),
      workspaceState: decisionState,
      globalState: decisionState,
    } as unknown as vscode.ExtensionContext);
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const planRead = await readPlanOfRecordV1(vscode.Uri.file(taskFolderPath));
    const progressRead = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath));
    assert.equal(planRead.hasChecklist, true, "fixture plan should be readable as the canonical checklist");
    assert.equal(progressRead.ok, true, `fixture progress should decode: ${JSON.stringify(progressRead)}`);
    assert.deepEqual(listCheckedChecklistItemTextsV1(planRead.text ?? ""), [itemText]);
    assert.equal(progressRead.ok && progressRead.decoded.progress.planItemEvidence?.[0]?.testReports?.length, 1);
    const compiledNodeFailure = [
      "✔ unrelated passing test",
      "✖ failing tests:",
      "test at out/test/retry.test.js:18:5",
      "✖ resumes after retry",
      "  AssertionError: expected true",
      "ℹ tests 2",
      "ℹ pass 1",
      "ℹ fail 1",
    ].join("\n");
    assert.equal(associatePublishFailuresWithPlanItemsV1({
      checkedItems: listCheckedChecklistItemTextsV1(planRead.text ?? ""),
      evidence: progressRead.ok ? progressRead.decoded.progress.planItemEvidence ?? [] : [],
      failures: [{ command: "node test-stubs/run-unit-tests.js", output: compiledNodeFailure }],
    }).length, 1);
    const run = stubPublishChecksRun({
      passed: false,
      passedModuloKnownFlakes: false,
      summary: "one failed acceptance check",
      failedChecks: [{ command: "node test-stubs/run-unit-tests.js", exitCode: 1, output: compiledNodeFailure }],
    });
    try {
      const started = await runPublishChecks(makeInventory(taskFolderPath, progress), {
        taskFolderPath,
        canonicalId: taskFolderPath,
      });
      assert.equal(started, true);
      assert.equal(run.lintCalls(), 1, "the integrated Publish path must consume the injected failing check result");
      assert.match(surface.entries.map((entry) => entry.message).join("\n"), /Publish checks found issues/, `unexpected Publish outcome: ${JSON.stringify(surface.entries)}`);
      const recoveryCards = new WorkflowDecisionStoreV1(decisionState).listPending(taskFolderPath)
        .filter((decision) => decision.decisionKey === "chatActionOffer:setTaskStage");
      assert.equal(recoveryCards.length, 1, "one terminal Publish failure produces one recovery card");
      const recovery = recoveryCards[0];
      assert.ok(recovery);
      assert.match(recovery.whatHappened, /one failed acceptance check/);
      assert.equal(recovery.options[0]?.label, "Back to Implementation", "a test failure recommends implementation");
      assert.deepEqual(recovery.options.map((option) => option.label), ["Back to Implementation", "Run Publish Checks", "Not now"]);
      assert.deepEqual(recovery.options.map((option) => option.optionId), ["runAction", "alternative1", "notNow"]);
      assert.equal(recovery.recommendation.kind === "option" ? recovery.recommendation.optionId : undefined, "runAction");
      assert.ok(!recovery.options.some((option) => option.label === "Fix Linting & Code Errors"),
        "test failures do not recommend an unrelated lint-fix action");
      assert.ok(fs.existsSync(path.join(taskFolderPath, "publish-failure-associations-v1.json")), `association artifact missing; task files: ${fs.readdirSync(taskFolderPath).join(", ")}`);
      const evidenceAfter = JSON.parse(fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.deepEqual(evidenceAfter.planItemEvidence?.[0]?.testReports, [], "confirmed acceptance-test failure invalidates its report after association");
      const durable = JSON.parse(fs.readFileSync(path.join(taskFolderPath, "publish-failure-associations-v1.json"), "utf8")) as { records?: Array<{ associations?: Array<{ itemText: string; disposition: string; paths: string[] }> }> };
      assert.equal(durable.records?.[0]?.associations?.[0]?.itemText, itemText);
      assert.equal(durable.records?.[0]?.associations?.[0]?.disposition, "contradicted");
      assert.deepEqual(durable.records?.[0]?.associations?.[0]?.paths, ["out/test/retry.test.js", "src/test/retry.test.ts"]);
    } finally {
      __extensionContextV1TestOnly.reset();
      run.restore();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does not crash on the partial-task dispatch shape, and refuses busy (naming the real owner) when durable admission is already held", async () => {
    const taskFolderPath = makeTaskFolder("acas-shape-busy");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    try {
      // Before the fix, `extractSynchronousPublishChecksFolderPathV1` threw a
      // TypeError reading `node.task.folderUri.fsPath` on this exact shape,
      // before ever reaching admission — this call must resolve, not reject.
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        applyCurrentStageActionDispatchArg(taskFolderPath, progress)
      );

      assert.equal(result, false, "must report it never dispatched real work");
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(
        surface.entries[0]?.message ?? "",
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner — proves the folder path was extracted correctly, not just that nothing threw"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("adopts a caller's already-live admission via the forwarded handoff token, instead of racing a fresh genesis and refusing busy", async () => {
    // Simulates scheduleTaskResume.ts's `fire()`: it holds live admission for
    // the whole dispatch and authorizes a single-use handoff token, then
    // applyCurrentStageAction forwards that token into this exact arg shape.
    const taskFolderPath = makeTaskFolder("acas-shape-handoff-adoption");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const outer = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "vs-code-ai-helper.scheduleTaskResume.fire",
    });
    assert.equal(outer.outcome, "acquired");
    const handoffToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);

    try {
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        applyCurrentStageActionDispatchArg(taskFolderPath, progress, handoffToken)
      );

      // The task's stage is "plan", not "publish", so this must reach and
      // hit the stage guard — proving admission was NOT refused busy —
      // rather than the busy diagnostic the previous test asserts on.
      assert.equal(result, false);
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(surface.entries[0]?.message ?? "", /Publish stage/);
      assert.doesNotMatch(surface.entries[0]?.message ?? "", /busy|already/i);
    } finally {
      await outer.handle.release();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("passes the stage guard when the inventory still holds the previous stage but task-progress.json reads publish (RC7 item 5)", async () => {
    const taskFolderPath = makeTaskFolder("acas-shape-stale-inventory-stage");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, { currentStage: "publish" }));
    const staleProgress = fixtureProgress(taskFolderPath, { currentStage: "impl-low-review" });

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const run = stubPublishChecksRun();
    try {
      const dispatched = await runPublishChecks(
        makeInventory(taskFolderPath, staleProgress),
        applyCurrentStageActionDispatchArg(taskFolderPath, staleProgress)
      );
      assert.equal(dispatched, true, `the checks should have run: ${JSON.stringify(surface.entries)}`);
      assert.equal(run.lintCalls(), 1, "the check run reached its lint step");
      assert.ok(
        !surface.entries.some((entry) => /only available for tasks at the Publish stage/.test(entry.message)),
        `unexpected stage refusal: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      run.restore();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("Fast Forward's Publish dispatch over a stale inventory runs the real command and the refusal row carries its notice (RC7 item 5)", async () => {
    const taskFolderPath = makeTaskFolder("acas-shape-ff-dispatch-refusal");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, { currentStage: "publish" }));
    const staleProgress = fixtureProgress(taskFolderPath, { currentStage: "impl-low-review" });

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const modelsStub = stubOpenAiModelsCommand();
    try {
      const settled: string[] = [];
      const ok = await runFastForwardPublishChecksV1({
        taskFolderPath,
        runChecks: () =>
          runPublishChecks(
            makeInventory(taskFolderPath, staleProgress),
            applyCurrentStageActionDispatchArg(taskFolderPath, staleProgress)
          ),
        // No model is configured, so the checks leave no fresh result.
        isFreshAfterChecks: () => Promise.resolve(false),
        op: {
          settleAs: (_state, reason) => settled.push(reason),
          report: () => undefined,
        },
      });
      assert.equal(ok, false);
      assert.equal(settled.length, 1);
      assert.match(settled[0] ?? "", /^Publish Checks declined to start: .*no AI model is configured/);
      assert.doesNotMatch(settled[0] ?? "", /only available for tasks at the Publish stage/);
      const row = terminalEntryFor({
        id: "op-ff",
        key: taskFolderPath,
        label: "Fast Forward Review",
        taskName: "rc7",
        state: "refused",
        detail: settled[0],
        stage: "publish",
      } as unknown as TaskOperationSnapshot);
      assert.match(row?.message ?? "", /refused — nothing was started \(Publish Checks declined to start: .*no AI model is configured/);
    } finally {
      modelsStub.restore();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("releases its own admission once the command finishes, even on the stage-guard early-exit path", async () => {
    const taskFolderPath = makeTaskFolder("acas-shape-release-on-stage-guard");
    const progress = fixtureProgress(taskFolderPath);
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        applyCurrentStageActionDispatchArg(taskFolderPath, progress)
      );

      assert.equal(result, false);
      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after the stage guard refuses"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});

/** Stateful in-memory `vscode.Memento`, so `CurrentTaskStore.set`/`.get` round-trip within a test. */
function fakeStatefulMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, defaultValue?: unknown) => (values.has(key) ? values.get(key) : defaultValue),
    update: (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve(undefined);
    },
    keys: () => Array.from(values.keys()),
  } as unknown as vscode.Memento;
}

/**
 * A cold-cache-miss inventory: every lookup misses (simulating a task that
 * exists on disk but is not yet in the in-memory inventory cache), except
 * `refresh()`, which succeeds without repopulating anything — mirroring how
 * `resolveTaskContext`'s own one-shot refresh-and-retry can still miss right
 * after a task was created in another window.
 */
function makeColdCacheInventory(): TaskInventory {
  return {
    getTaskById: () => undefined,
    getTaskByPath: () => undefined,
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

void describe("runPublishChecks — true no-arg invocation with a CurrentTaskStore (2026-09-09 review completion blocker)", () => {
  void it("resolves the persisted current task instead of reporting 'No task found', once registerRunPublishChecksCommand threads a CurrentTaskStore through", async () => {
    // Regression coverage for the review's sharper finding: `runPublishChecks`
    // itself always accepted a `currentTaskStore` parameter, but
    // `registerRunPublishChecksCommand`'s registration never passed one in at
    // all — so a true no-argument invocation (the command-palette entry,
    // `arg` fully `undefined`) had no persisted current-task pointer
    // available to EITHER the early-admission peek or the authoritative
    // `resolveTaskContext` call, and always resolved as "no task found"
    // rather than acting on the current task.
    const taskFolderPath = makeTaskFolder("no-arg-current-task-store");
    const progress = fixtureProgress(taskFolderPath, { currentStage: "plan" });
    writeProgress(taskFolderPath, progress);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
    await currentTaskStore.set(taskFolderPath);

    try {
      const result = await runPublishChecks(
        makeInventory(taskFolderPath, progress),
        undefined,
        undefined,
        currentTaskStore
      );

      // Stage is "plan", not "publish" — reaching (and being refused by) the
      // stage guard proves the current task was actually resolved, rather
      // than the command bailing out early on "No task found."
      assert.equal(result, false);
      assert.equal(surface.entries.length, 1);
      assert.match(surface.entries[0]?.message ?? "", /Publish stage/);
      assert.doesNotMatch(surface.entries[0]?.message ?? "", /No task found/i);
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});

/**
 * A multi-task fake inventory, for exercising `peekTaskFolderPathSynchronouslyV1`'s
 * unique-active-task mirror of `resolveTaskContext`'s step 3 — an inventory
 * with more than one entry, distinguished by `progress.status`.
 */
function makeMultiTaskInventory(
  entries: { taskFolderPath: string; progress: TaskProgress }[]
): TaskInventory {
  const tasks = entries.map(({ taskFolderPath, progress }) => ({
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    sourceScopeKey: taskFolderPath,
    progress,
  }));
  return {
    getTaskById: (id: string) => tasks.find((t) => t.canonicalId === id),
    getTaskByPath: (p: string) => tasks.find((t) => t.taskFolderPath === p),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => tasks,
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

void describe("peekTaskFolderPathSynchronouslyV1 — unique-active-task fallback (2026-09-10 review completion blocker, narrowed)", () => {
  void it("falls back to the sole active task when there is no persisted current-task pointer at all", () => {
    const activeFolderPath = makeTaskFolder("peek-fallback-no-pointer-active");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => undefined } as unknown as CurrentTaskStore
    );

    assert.equal(result, activeFolderPath);
  });

  void it("redirects from a persisted pointer that resolves to a PAUSED task to the sole active task elsewhere in the inventory", () => {
    const pausedFolderPath = makeTaskFolder("peek-fallback-paused-pointer-redirect-paused");
    const activeFolderPath = makeTaskFolder("peek-fallback-paused-pointer-redirect-active");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: pausedFolderPath, progress: fixtureProgress(pausedFolderPath, { status: "paused" }) },
      { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => pausedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(result, activeFolderPath, "must mirror resolveTaskContext's redirect away from a paused persisted task");
  });

  void it("falls back to the persisted PAUSED task itself when no unique active task exists to redirect to", () => {
    const pausedFolderPath = makeTaskFolder("peek-fallback-paused-pointer-no-redirect");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: pausedFolderPath, progress: fixtureProgress(pausedFolderPath, { status: "paused" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => pausedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      pausedFolderPath,
      "must mirror `resolved` staying the paused task when resolveTaskContext finds no onlyActiveTask override (allowPaused:true callers, e.g. Publish checks, still need it)"
    );
  });

  void it("falls back to the sole active task when the persisted pointer is a cold-cache miss with no folder on disk", () => {
    const activeFolderPath = makeTaskFolder("peek-fallback-cache-miss-active");
    const deletedFolderPath = path.join(REAL_ROOT, "tasks", "peek-fallback-cache-miss-deleted-pointer");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => deletedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      activeFolderPath,
      "a genuinely-gone persisted pointer (not just an uncached one) must still redirect to an unambiguous active task, mirroring resolveTaskContext's clear()-then-fallback path"
    );
  });

  void it("returns undefined when more than one active task makes the fallback ambiguous", () => {
    const activeA = makeTaskFolder("peek-fallback-ambiguous-a");
    const activeB = makeTaskFolder("peek-fallback-ambiguous-b");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: activeA, progress: fixtureProgress(activeA, { status: "active" }) },
      { taskFolderPath: activeB, progress: fixtureProgress(activeB, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => undefined } as unknown as CurrentTaskStore
    );

    assert.equal(result, undefined, "must fail closed rather than guess between two active tasks, matching resolveTaskContext's own ambiguity rule");
  });
});

void describe("peekTaskFolderPathSynchronouslyV1 — refresh-repopulated persisted target beats a stale cached active task (2026-09-10 review completion blocker, second pass)", () => {
  void it("returns the cache-missed persisted task, not a different cached active task, when the persisted task exists on disk and is not paused", () => {
    // The exact scenario the review reproduced: `resolveTaskContext`'s step 2
    // awaits `inventory.refresh()` on this same cache miss and, once refresh
    // finds the persisted task non-paused, uses it DIRECTLY — its own step-3
    // active-task fallback (which would have picked `cachedActiveFolderPath`)
    // is never even reached. This peek must not admit the wrong task here.
    const persistedFolderPath = makeTaskFolder("peek-refresh-beats-stale-active-persisted");
    writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "active" }));
    const cachedActiveFolderPath = makeTaskFolder("peek-refresh-beats-stale-active-cached");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: cachedActiveFolderPath, progress: fixtureProgress(cachedActiveFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => persistedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      persistedFolderPath,
      "the on-disk, non-paused persisted task must win over a stale cached active task, mirroring what resolveTaskContext's refresh finds"
    );
  });

  void it("falls back to a different cached active task when the cache-missed persisted task exists on disk but is paused", () => {
    const persistedFolderPath = makeTaskFolder("peek-refresh-paused-persisted-redirects");
    writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "paused" }));
    const cachedActiveFolderPath = makeTaskFolder("peek-refresh-paused-persisted-redirects-active");
    const inventory = makeMultiTaskInventory([
      { taskFolderPath: cachedActiveFolderPath, progress: fixtureProgress(cachedActiveFolderPath, { status: "active" }) },
    ]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => persistedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      cachedActiveFolderPath,
      "a paused on-disk persisted task must still redirect to an unambiguous active task, same as the already-cached paused-pointer case"
    );
  });

  void it("falls back to the cache-missed persisted task itself when it exists on disk, is paused, and no active task exists to redirect to", () => {
    const persistedFolderPath = makeTaskFolder("peek-refresh-paused-persisted-no-redirect");
    writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "paused" }));
    const inventory = makeMultiTaskInventory([]);

    const result = peekTaskFolderPathSynchronouslyV1(
      inventory,
      undefined,
      { get: () => persistedFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(
      result,
      persistedFolderPath,
      "must mirror `resolved` staying the on-disk paused persisted task when resolveTaskContext finds no onlyActiveTask override"
    );
  });
});

void describe("peekTaskFolderPathSynchronouslyV1 — cold-cache-miss id-as-path fallback (2026-09-09 review completion blocker)", () => {
  void it("falls back to the canonicalId as the folder-path guess when it still exists on disk", () => {
    const taskFolderPath = makeTaskFolder("peek-cold-miss-existing-folder");

    const result = peekTaskFolderPathSynchronouslyV1(makeColdCacheInventory(), {
      canonicalId: taskFolderPath,
    });

    assert.equal(result, taskFolderPath);
  });

  void it("returns undefined for a stale canonicalId whose folder no longer exists, rather than resurrecting it via admission's mkdir", () => {
    const deletedFolderPath = path.join(REAL_ROOT, "tasks", "deleted-task-never-created");

    const result = peekTaskFolderPathSynchronouslyV1(makeColdCacheInventory(), {
      canonicalId: deletedFolderPath,
    });

    assert.equal(result, undefined);
  });

  void it("falls back to the persisted current-task id as the folder-path guess when it still exists on disk", () => {
    const taskFolderPath = makeTaskFolder("peek-cold-miss-current-task-store");

    const result = peekTaskFolderPathSynchronouslyV1(
      makeColdCacheInventory(),
      undefined,
      { get: () => taskFolderPath } as unknown as CurrentTaskStore
    );

    assert.equal(result, taskFolderPath);
  });
});

/**
 * A mutable multi-task inventory whose `refresh()` call transitions it from a
 * "pre-refresh" snapshot (mirroring the stale in-memory cache
 * `peekTaskFolderPathSynchronouslyV1` is limited to) to a "post-refresh"
 * snapshot that can contain tasks the pre-refresh snapshot never had —
 * mirroring `TaskInventory.refresh()`'s own real disk scan discovering a
 * task the in-memory cache did not yet know about.
 */
function makeRefreshDiscoversNewTaskInventory(
  before: { taskFolderPath: string; progress: TaskProgress }[],
  after: { taskFolderPath: string; progress: TaskProgress }[]
): TaskInventory {
  let refreshed = false;
  const snapshot = (): { taskFolderPath: string; progress: TaskProgress }[] => (refreshed ? after : before);
  const toTask = (e: { taskFolderPath: string; progress: TaskProgress }): {
    canonicalId: string;
    taskFolderPath: string;
    folderName: string;
    sourceScopeKey: string;
    progress: TaskProgress;
  } => ({
    canonicalId: e.taskFolderPath,
    taskFolderPath: e.taskFolderPath,
    folderName: path.basename(e.taskFolderPath),
    sourceScopeKey: e.taskFolderPath,
    progress: e.progress,
  });
  return {
    getTaskById: (id: string) => snapshot().map(toTask).find((t) => t.canonicalId === id),
    getTaskByPath: (p: string) => snapshot().map(toTask).find((t) => t.taskFolderPath === p),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => snapshot().map(toTask),
    refresh: () => {
      refreshed = true;
      return Promise.resolve(undefined);
    },
  } as unknown as TaskInventory;
}

void describe(
  "resolveTaskContext — onResolvedCandidate hook (2026-09-10 review completion blocker, narrowed further: admission for a refresh-discovered target)",
  () => {
    void it(
      "fires with the refresh-discovered ACTIVE task, never the stale-cache paused guess, when the persisted pointer is a cache-miss that resolves to paused",
      async () => {
        // The review's exact scenario: BEFORE refresh, the persisted pointer
        // is a cache miss and the stale cache has NO active task at all (so
        // a synchronous peek has nothing to fall back to but the paused
        // pointer itself); refresh() discovers both the persisted (paused)
        // task AND a different, unambiguous active task — exactly what
        // resolveTaskContext's own internal `inventory.refresh()` would
        // surface in production.
        const persistedFolderPath = makeTaskFolder("resolve-hook-paused-persisted");
        const activeFolderPath = makeTaskFolder("resolve-hook-active-discovered-by-refresh");
        const inventory = makeRefreshDiscoversNewTaskInventory(
          [],
          [
            { taskFolderPath: persistedFolderPath, progress: fixtureProgress(persistedFolderPath, { status: "paused" }) },
            { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
          ]
        );

        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();
        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(persistedFolderPath);

        const seen: string[] = [];
        try {
          const resolved = await resolveTaskContext(inventory, undefined, {
            allowPaused: true,
            onResolvedCandidate: (candidate) => {
              seen.push(candidate.taskFolderPath);
              return Promise.resolve();
            },
          }, currentTaskStore);

          assert.equal(resolved?.taskFolderPath, activeFolderPath, "resolveTaskContext itself must land on the refresh-discovered active task");
          assert.deepEqual(seen, [activeFolderPath], "the hook must fire exactly once, with the AUTHORITATIVE target — never the stale paused guess");
        } finally {
          rf.restore();
          ws.restore();
        }
      }
    );

    void it("never fires when nothing resolves", async () => {
      const inventory = makeColdCacheInventory();
      const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());

      let called = false;
      const resolved = await resolveTaskContext(inventory, undefined, {
        allowPaused: true,
        onResolvedCandidate: () => {
          called = true;
          return Promise.resolve();
        },
      }, currentTaskStore);

      assert.equal(resolved, undefined);
      assert.equal(called, false);
    });

    void it(
      "never fires for a candidate whose folder does not exist on disk (2026-09-10 review architectural blocker fix)",
      async () => {
        // Deliberately never created via `makeTaskFolder`/`fs.mkdirSync` — a
        // stale inventory entry for a folder that no longer exists. Before
        // the fix, the hook fired BEFORE this exact existence check, so a
        // caller's admission acquisition (`mkdir(dir, { recursive: true })`)
        // could resurrect a directory under a candidate resolveTaskContext
        // was about to reject.
        const missingFolderPath = path.join(REAL_ROOT, "tasks", "resolve-hook-never-created");
        const progress = fixtureProgress(missingFolderPath, { status: "active" });
        const inventory = makeInventory(missingFolderPath, progress);
        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        const ws = installWorkspaceFoldersStub();

        let called = false;
        try {
          const resolved = await resolveTaskContext(inventory, { canonicalId: missingFolderPath, taskFolderPath: missingFolderPath }, {
            allowPaused: true,
            onResolvedCandidate: () => {
              called = true;
              return Promise.resolve();
            },
          }, currentTaskStore);

          assert.equal(resolved, undefined, "a missing folder must still fail resolution");
          assert.equal(called, false, "the admission hook must never fire for a candidate that fails the existence check");
          assert.equal(fs.existsSync(missingFolderPath), false, "the hook must not have resurrected the folder via admission's mkdir");
        } finally {
          ws.restore();
        }
      }
    );

    void it(
      "never fires for a candidate outside every open workspace folder (2026-09-10 review architectural blocker fix)",
      async () => {
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-outside-workspace-"));
        const outsideFolderPath = path.join(outsideRoot, "some-task");
        fs.mkdirSync(outsideFolderPath, { recursive: true });
        const progress = fixtureProgress(outsideFolderPath, { status: "active" });
        const inventory = makeInventory(outsideFolderPath, progress);
        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        // REAL_ROOT is the only open workspace folder — `outsideFolderPath`
        // sits entirely outside it.
        const ws = installWorkspaceFoldersStub();

        let called = false;
        try {
          const resolved = await resolveTaskContext(inventory, { canonicalId: outsideFolderPath, taskFolderPath: outsideFolderPath }, {
            allowPaused: true,
            onResolvedCandidate: () => {
              called = true;
              return Promise.resolve();
            },
          }, currentTaskStore);

          assert.equal(resolved, undefined, "a task outside every open workspace folder must still fail resolution");
          assert.equal(called, false, "the admission hook must never fire for a candidate that fails workspace containment");
        } finally {
          ws.restore();
          safeRemoveDir(outsideRoot);
        }
      }
    );
  }
);

void describe(
  "runPublishChecks — admits the refresh-discovered active task, not the stale-cache paused guess (2026-09-10 review completion blocker, narrowed further)",
  () => {
    void it(
      "attempts admission against the refresh-discovered ACTIVE task, reported busy by its real owner — proving the paused stale-cache guess was never the actual target",
      async () => {
        const persistedFolderPath = makeTaskFolder("rpc-hook-paused-persisted-busy");
        const activeFolderPath = makeTaskFolder("rpc-hook-active-discovered-by-refresh-busy");
        writeProgress(persistedFolderPath, fixtureProgress(persistedFolderPath, { status: "paused" }));
        writeProgress(activeFolderPath, fixtureProgress(activeFolderPath, { status: "active" }));

        const inventory = makeRefreshDiscoversNewTaskInventory(
          [],
          [
            { taskFolderPath: persistedFolderPath, progress: fixtureProgress(persistedFolderPath, { status: "paused" }) },
            { taskFolderPath: activeFolderPath, progress: fixtureProgress(activeFolderPath, { status: "active" }) },
          ]
        );

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(persistedFolderPath);

        // Held for the ACTIVE task specifically — never the paused one — so
        // a busy refusal naming this owner proves resolution/admission
        // targeted the correct (refresh-discovered) folder, not the
        // stale-cache guess (which has no competing holder here and would
        // have silently succeeded had it been used instead).
        const held = await acquireWorkAdmissionV1({
          taskFolderPath: activeFolderPath,
          purpose: "admission",
          commandId: "someOtherConcurrentCommand",
        });
        assert.equal(held.outcome, "acquired");

        try {
          const result = await runPublishChecks(inventory, undefined, undefined, currentTaskStore);

          assert.equal(result, false);
          assert.equal(surface.entries.length, 1);
          assert.equal(surface.entries[0]?.level, "warning");
          assert.match(
            surface.entries[0]?.message ?? "",
            /someOtherConcurrentCommand/,
            "must have attempted admission against the refresh-discovered ACTIVE task, not the stale-cache paused guess"
          );
        } finally {
          if (held.outcome === "acquired") {
            await held.handle.release();
          }
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );
  }
);

void describe(
  "completeCommitAndPushTask — a watchdog-provenance pause on the resolved target no longer fails resolution outright (2026-09-10 review completion blocker, narrowed further)",
  () => {
    void it(
      "reconciles a watchdog-provenance pause on the resolved task and proceeds (reaching the stage guard), instead of reporting 'No active task found'",
      async () => {
        const taskFolderPath = makeTaskFolder("ccpt-watchdog-pause-reconciled");
        const progress = fixtureProgress(taskFolderPath, {
          status: "paused",
          pausedReason: STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
          currentStage: "plan",
        });
        writeProgress(taskFolderPath, progress);

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(taskFolderPath);

        try {
          await completeCommitAndPushTask(makeInventory(taskFolderPath, progress), undefined, currentTaskStore);

          assert.equal(surface.entries.length, 1);
          assert.match(
            surface.entries[0]?.message ?? "",
            /Complete, Commit and Push.*final review stage/,
            "must reach the stage guard — proving the watchdog pause was reconciled rather than causing resolution to fail outright"
          );
          assert.doesNotMatch(surface.entries[0]?.message ?? "", /No active task found/i);
        } finally {
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );

    void it(
      "still reports 'No active task found' for a genuine (non-watchdog) pause — the fix narrows the failure, it does not remove it",
      async () => {
        const taskFolderPath = makeTaskFolder("ccpt-genuine-user-pause-still-blocks");
        const progress = fixtureProgress(taskFolderPath, {
          status: "paused",
          pausedReason: "Paused by the user",
          currentStage: "plan",
        });
        writeProgress(taskFolderPath, progress);

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(taskFolderPath);

        try {
          await completeCommitAndPushTask(makeInventory(taskFolderPath, progress), undefined, currentTaskStore);

          assert.equal(surface.entries.length, 1);
          assert.match(surface.entries[0]?.message ?? "", /No active task found to complete, commit, and push/);
        } finally {
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );

    void it(
      "still reports 'No active task found' when a genuine user pause lands on disk AFTER the resolved snapshot was read but BEFORE reconciliation observes it (2026-09-10 review completion blocker, new)",
      async () => {
        // The review's exact scenario: `resolveTaskContext`'s in-memory
        // resolution snapshot says "active" (the inventory's own copy,
        // captured before any pause landed), but the ON-DISK file — which is
        // what `reconcileWatchdogPauseAgainstAdmissionV1` freshly reads
        // inside the `onResolvedCandidate` hook — already carries a genuine,
        // non-watchdog pause by the time reconciliation runs. The stale
        // "active" snapshot must never override that fresh, authoritative
        // read.
        const taskFolderPath = makeTaskFolder("ccpt-user-pause-races-stale-active-snapshot");
        const activeSnapshot = fixtureProgress(taskFolderPath, {
          status: "active",
          currentStage: "plan",
        });
        // The in-memory inventory (what resolveTaskContext resolves against)
        // says active — but the disk file (what reconciliation reads) is
        // already genuinely paused by the user, simulating the race.
        writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, {
          status: "paused",
          pausedReason: "Paused by the user",
          currentStage: "plan",
        }));

        const surface = new RecordingSurface();
        initNotificationRouter(surface);
        const ws = installWorkspaceFoldersStub();
        const rf = installReadFileBridge();

        const currentTaskStore = new CurrentTaskStore(fakeStatefulMemento());
        await currentTaskStore.set(taskFolderPath);

        try {
          await completeCommitAndPushTask(
            makeInventory(taskFolderPath, activeSnapshot),
            undefined,
            currentTaskStore
          );

          assert.equal(surface.entries.length, 1);
          assert.match(
            surface.entries[0]?.message ?? "",
            /No active task found to complete, commit, and push/,
            "a fresh userPaused reconciliation result must win over the stale 'active' snapshot, not be masked by it"
          );
        } finally {
          rf.restore();
          ws.restore();
          deactivateNotificationRouter();
        }
      }
    );
  }
);

void describe("runPublishChecks pass notice (RC9 item 2, b)", () => {
  async function runPassing(
    name: string,
    withParent: boolean,
    repeat = false
  ): Promise<{ surface: RecordingSurface; decisions: ReturnType<WorkflowDecisionStoreV1["listPending"]> }> {
    const taskFolderPath = makeTaskFolder(name);
    const progress = fixtureProgress(taskFolderPath, { currentStage: "publish" });
    writeProgress(taskFolderPath, progress);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const memento = fakeStatefulMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(REAL_ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const run = stubPublishChecksRun();
    const modelsStub = stubOpenAiModelsCommand();
    const parent = withParent
      ? taskOperations.begin(taskFolderPath, {
          label: "Fast Forward Review",
          stage: "publish",
          taskName: "rc9",
          kind: "review",
        } as never)
      : undefined;
    try {
      const arg = applyCurrentStageActionDispatchArg(taskFolderPath, progress);
      await runPublishChecks(makeInventory(taskFolderPath, progress), arg as never, parent ?? undefined);
      if (repeat) {
        await runPublishChecks(makeInventory(taskFolderPath, progress), arg as never, parent ?? undefined);
      }
      assert.equal(run.lintCalls(), repeat ? 2 : 1, "the checks ran to a pass");
      const decisions = new WorkflowDecisionStoreV1(memento)
        .listPending()
        .filter((d) => d.decisionKey === "chatActionOffer:runReviewWithAI");
      return { surface, decisions };
    } finally {
      __extensionContextV1TestOnly.reset();
      taskOperations.end(parent, "succeeded");
      modelsStub.restore();
      run.restore();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  }

  void it("with a parent operation the pass notice says the review runs next", async () => {
    const { surface, decisions } = await runPassing("rc9-pass-parent", true);
    assert.equal(decisions.length, 0, "Fast Forward runs the review itself, so no Run Publish Review card is posted");
    const passed = surface.entries.filter((e) => /Publish checks passed/.test(e.message));
    assert.equal(passed.length, 1, JSON.stringify(surface.entries));
    assert.match(passed[0]?.message ?? "", /Fast Forward runs the Publish review next\./);
    assert.doesNotMatch(passed[0]?.message ?? "", /Request a Publish review/);
  });

  void it("without a parent operation one reasoned review card survives repeated terminal reporting", async () => {
    const { surface, decisions } = await runPassing("rc9-pass-no-parent", false, true);
    assert.equal(decisions.length, 1, "repeated manual passes update one Run Publish Review card");
    const decision = decisions[0];
    assert.ok(decision);
    assert.match(decision.whatHappened, /Publish checks passed/);
    assert.deepEqual(decision.options.map((option) => option.label), ["Run Publish Review", "Not now"]);
    assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
    assert.equal(decision.options[0]?.effect.kind, "command");
    assert.deepEqual(decision.options[1]?.effect, { kind: "doNothing" });
    const passed = surface.entries.filter((e) => e.level === "info" && /Publish checks passed/.test(e.message));
    assert.equal(passed.length, 2, JSON.stringify(surface.entries));
    assert.doesNotMatch(passed[0]?.message ?? "", /Fast Forward runs the Publish review next/);
  });
});


void describe("runPublishChecks failed-first execution sequences", () => {
  async function runSequence(
    name: string,
    targeted: "fail" | "pass" | "cancel",
    compatible = true
  ): Promise<{ calls: Array<Record<string, unknown>>; surface: RecordingSurface; clearCalls: number; decisions: vscode.Memento }> {
    const taskFolderPath = makeTaskFolder(name);
    const progress = fixtureProgress(taskFolderPath, { currentStage: "publish" });
    writeProgress(taskFolderPath, progress);
    const surface = new RecordingSurface();
    const decisions = fakeStatefulMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(REAL_ROOT),
      workspaceState: decisions,
      globalState: decisions,
    } as unknown as vscode.ExtensionContext);
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();
    const run = stubPublishChecksRun();
    const modelsStub = stubOpenAiModelsCommand();
    const originals = {
      read: failedPublishRunModule.readFailedPublishRunSnapshotV1,
      compatible: failedPublishRunModule.isFailedPublishRunCompatibleV1,
      clear: failedPublishRunModule.clearFailedPublishRunSnapshotV1,
      commandPlan: completionLintModule.resolveCurrentPublishCommandPlanV1,
    };
    const previous = {
      schemaVersion: 1,
      taskFolder: taskFolderPath,
      repositoryRoot: REAL_ROOT,
      verificationScopeId: "scope",
      headCommit: "a".repeat(40),
      failedAt: "2026-10-26T20:00:00.000Z",
      runner: { platform: process.platform, nodeVersion: process.version, packageManager: "npm 1" },
      commands: [{ command: "custom verify", cwd: REAL_ROOT, phase: "test", exitCode: 1 }],
      configuredCommands: [],
      failures: [{
        command: "custom verify", exitCode: 1, testFiles: [], failureCount: 1,
        completeFailureIdentities: true, unidentifiedFailureCount: 1,
      }],
      observedInputFingerprint: "observed",
      compatibilityUnknownReason: null,
      compatibilityFingerprint: "compatible",
    };
    let clearCalls = 0;
    failedPublishRunModule.readFailedPublishRunSnapshotV1 = (): Promise<unknown> => Promise.resolve(previous);
    failedPublishRunModule.isFailedPublishRunCompatibleV1 = (): boolean => compatible;
    failedPublishRunModule.clearFailedPublishRunSnapshotV1 = (): Promise<void> => {
      clearCalls += 1;
      return Promise.resolve();
    };
    completionLintModule.resolveCurrentPublishCommandPlanV1 = (): string[] => ["custom verify"];
    const calls: Array<Record<string, unknown>> = [];
    completionLintModule.runCompletionLint = (_uri: unknown, _files: unknown, options?: Record<string, unknown>): Promise<unknown> => {
      calls.push(options ?? {});
      if (options?.explicitChecks) {
        if (targeted === "cancel") {
          const Cancelled = completionLintModule.PublishChecksCancelledError as new () => Error;
          return Promise.reject(new Cancelled());
        }
        return Promise.resolve({
          runAt: "2026-10-27T00:00:00.000Z",
          passed: targeted === "pass",
          passedModuloKnownFlakes: targeted === "pass",
          summary: targeted === "pass" ? "targeted pass" : "targeted failure",
          issueCount: targeted === "pass" ? 0 : 1,
          missingScripts: [],
          commandsRun: ["custom verify"],
          failedChecks: targeted === "pass" ? [] : [{ command: "custom verify", exitCode: 1, output: "still failing" }],
        });
      }
      return Promise.resolve({
        runAt: "2026-10-27T00:00:00.000Z", passed: true, passedModuloKnownFlakes: true,
        summary: "full pass", issueCount: 0, missingScripts: [], commandsRun: ["custom verify"], failedChecks: [],
      });
    };
    try {
      await runPublishChecks(makeInventory(taskFolderPath, progress), { taskFolderPath, canonicalId: taskFolderPath });
      return { calls, surface, clearCalls, decisions };
    } finally {
      __extensionContextV1TestOnly.reset();
      failedPublishRunModule.readFailedPublishRunSnapshotV1 = originals.read;
      failedPublishRunModule.isFailedPublishRunCompatibleV1 = originals.compatible;
      failedPublishRunModule.clearFailedPublishRunSnapshotV1 = originals.clear;
      completionLintModule.resolveCurrentPublishCommandPlanV1 = originals.commandPlan;
      modelsStub.restore();
      run.restore();
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  }

  void it("stops after a persistent targeted failure and marks the remainder unrun", async () => {
    const { calls, surface } = await runSequence("failed-first-still-fails", "fail");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.explicitChecks);
    assert.match(String(calls[0]?.rawReportLocation), /^runs\/failed-first-/);
    assert.match(String(calls[0]?.rawReportLocation), /source-2026-10-26T20-00-00-000Z/,
      "recheck raw evidence stays correlated to the source full failure");
    assert.match(surface.entries.map((entry) => entry.message).join("\n"), /Remaining Publish checks were not run/);
  });

  void it("runs the complete selected set after targeted checks pass", async () => {
    const { calls } = await runSequence("failed-first-then-full", "pass");
    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.explicitChecks);
    assert.match(String(calls[0]?.rawReportLocation), /^runs\/failed-first-/);
    assert.equal(calls[1]?.explicitChecks, undefined);
    const report = fs.readFileSync(path.join(REAL_ROOT, "tasks", "failed-first-then-full", "publish-review.md"), "utf8");
    assert.match(report, /Running the complete selected Publish check set now/);
  });

  void it("does not turn a cancelled targeted recheck into a full run or a pass", async () => {
    const { calls, surface, clearCalls, decisions } = await runSequence("failed-first-cancelled", "cancel");
    assert.equal(calls.length, 1);
    assert.equal(clearCalls, 0, "cancellation must preserve the prior failed-run snapshot for a later recheck");
    const retries = new WorkflowDecisionStoreV1(decisions).listPending()
      .filter((decision) => decision.decisionKey === "chatActionOffer:runPublishChecks");
    assert.equal(retries.length, 1, "cancelled started checks expose one retry card");
    assert.match(retries[0]?.whatHappened ?? "", /cancelled/i);
    assert.equal(retries[0]?.options[0]?.label, "Run Publish Checks");
    assert.deepEqual(retries[0]?.options.map((option) => option.label), ["Run Publish Checks", "Not now"]);
    assert.equal(retries[0]?.recommendation.kind === "option" ? retries[0]?.recommendation.optionId : undefined, "runAction");
    assert.match(surface.entries.map((entry) => entry.message).join("\n"), /cancelled/i);
    assert.doesNotMatch(surface.entries.map((entry) => entry.message).join("\n"), /Publish checks passed/);
  });

  void it("uses the full set directly when compatibility changes", async () => {
    const { calls } = await runSequence("failed-first-incompatible", "pass", false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.explicitChecks, undefined);
  });
});
