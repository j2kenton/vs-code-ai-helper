/**
 * Notifications in-flight visibility (Part II/III) — REAL behavioral
 * coverage for the Implementation dispatch family, complementing
 * `reviewActionsWorkflowActivityIntegration.test.ts`'s review-family
 * coverage. Review blocker 7bf9f2ec…-0 (narrowed): the prior evidence for
 * this family was source-ordering assertions only
 * (`reviewActionsStageActivity.test.ts`) plus a source-shape proof that
 * `executeImplementationRun`'s dispatch try-block has no intervening
 * `catch` around `runImplementationOrSealedV1` — never a real invocation of
 * the actual dispatch function observed through the actual registry.
 *
 * This suite drives the REAL exported `runImplementationWithAI`
 * (reviewActions.ts) end to end, through its REAL `executeImplementationRun`
 * / `runImplementationOrSealedV1` dispatch. Only the innermost provider call
 * is faked, at the same seam `runEditActionV1.test.ts` already proves works
 * for exercising this exact dispatcher for real:
 * `runnerRegistry.runImplementationForModel` (a CLI-resolved model's direct
 * edit invocation never touches the coordinator at all, so patching this one
 * function is the full "provider" boundary for this family). The patched
 * function is CONTROLLABLE (does not settle until the test says so), which
 * is what makes it possible to observe the registry row while the
 * "provider" is genuinely still running.
 *
 * Covers the two acceptance points this family adds beyond the review
 * family: the boundary-only changed-file count report (fired only once the
 * dispatch result is known, from `result.filesChanged`), and a genuine
 * unexpected-exit throw propagating uncaught through
 * `executeImplementationRun`'s try/finally (no intervening catch) — unlike
 * the review family's coordinator, which classifies a transport failure
 * into a normal outcome instead of throwing.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runImplementationWithAI } from "../commands/reviewActions";
import { taskOperations } from "../utils/taskOperations";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-impl-activity-"));

// `executeImplementationRun`'s pre-run safety check (reviewActions.ts) calls
// the REAL `isGitWorkspace`/`getUnrelatedWorkspaceChanges` (both defined and
// called within the same module, so they cannot be patched like every other
// dependency in this file) — `git rev-parse --show-toplevel` walks UP from
// `cwd` looking for the nearest enclosing repo, so on a machine where
// `os.tmpdir()` itself happens to sit inside some unrelated ambient git
// repository, `isGitWorkspace(REAL_ROOT)` resolves true and the run falls
// into the "unrelated changes" branch instead of the (patched-for) "not a
// git workspace" one — which then runs a REAL `git status` against whatever
// that ambient repo's actual toplevel is, an unbounded, non-deterministic
// operation this suite must never depend on. `git init` here makes REAL_ROOT
// itself the nearest enclosing repo (with no commits, so every task file is
// untracked and — being under the task's own folder — excluded by
// `getUnrelatedWorkspaceChanges`'s own path filter), which is deterministic
// and environment-independent instead of accidentally correct.
execFileSync("git", ["init", "--quiet"], { cwd: REAL_ROOT });

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-impl-activity-private-"));
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

const IMPLEMENTATION_CHECKLIST_MARKER = "<!-- ensemble:implementation-checklist -->";

function makeImplTaskFolder(name: string): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress = {
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
  // Already carries the checklist marker with no unticked items, so
  // runImplementationWithAI's own checklist-generation sub-step (a SEPARATE
  // model-backed dispatch, already covered by the source-ordering suite) is
  // skipped entirely — this test isolates the main implementation dispatch.
  // hasImplementationChecklistV1 requires the marker to be followed by at
  // least one actual `- [ ]`/`- [x]` checklist item (not just any text) —
  // this must be a REAL rendered checklist, ticked, so needsChecklist is
  // false and this test isolates the main implementation dispatch instead
  // of also driving the (separately covered) checklist-generation sub-step.
  fs.writeFileSync(
    path.join(folderPath, "plan-final.md"),
    `# Implementation Notes\n\n${IMPLEMENTATION_CHECKLIST_MARKER}\n\n- [x] Do the thing.\n`,
    "utf8"
  );
  return { folderPath };
}

/**
 * Same shape as `makeImplTaskFolder`, but plan-final.md deliberately carries
 * NO implementation-checklist marker — this is what makes
 * `runImplementationWithAI`'s `needsChecklist` branch fire for real, driving
 * the checklist-generation sub-dispatch (`invokeGenerateImplementationActionV1`,
 * the same coordinator/V1-runner-selection seam the standalone "Generate
 * Implementation" command uses) instead of the pre-seeded-checklist shortcut
 * every other test in this file takes.
 */
function makeImplTaskFolderNeedingChecklist(name: string): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress = {
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
  fs.writeFileSync(
    path.join(folderPath, "plan-final.md"),
    "# Implementation Notes\n\nNo checklist generated yet.\n",
    "utf8"
  );
  return { folderPath };
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/** A controllable V1 transport for the checklist-generation coordinator
 * dispatch — same shape/purpose as `reviewActionsWorkflowActivityIntegration
 * .test.ts`'s `controllableTransport`: `invoke()` does not settle until the
 * test releases it, so the registry row can be observed mid-flight. */
function controllableV1Transport(runnerId = "stub-runner"): {
  transport: AgentTransportV1;
  invoked: Promise<void>;
  resolveWith: (markdown: string) => void;
} {
  let markInvoked: () => void = () => {};
  const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
  let settleResolve: (markdown: string) => void = () => {};
  const transport: AgentTransportV1 = {
    runnerId,
    invoke: (request, output) => {
      markInvoked();
      return new Promise((resolve) => {
        settleResolve = (markdown: string): void => {
          output.write(
            frame({
              version: 1,
              correlation: request.correlation,
              kind: "completed",
              content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
            })
          );
          resolve({ kind: "completed" as const });
        };
      });
    },
  };
  return {
    transport,
    invoked,
    resolveWith: (markdown: string): void => settleResolve(markdown),
  };
}

/** Same seam `reviewActionsWorkflowActivityIntegration.test.ts` patches:
 * routes a real coordinator dispatch (here, the checklist-generation
 * sub-action) to a fake V1 transport instead of a real CLI/Copilot provider. */
function stubV1RunnerSelection(transports: readonly AgentTransportV1[]): Patched {
  let cursor = 0;
  const fakeOpener = (request: {
    session: { reserve: (input: Record<string, unknown>) => unknown };
    mode: unknown;
  }): { reserveNext: (attemptId: string) => unknown } => ({
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
        modelId: "claude-cli:opus@max",
      });
      return {
        kind: "reserved",
        reserved: {
          handle,
          providerLabel: "Test Provider",
          storedModelId: "claude-cli:opus@max",
          createTransport: () => transport,
        },
      };
    },
  });
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

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (
    source: vscode.Uri,
    dest: vscode.Uri,
    _options?: { overwrite?: boolean }
  ): Promise<void> => {
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

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

/** The non-git-workspace safety modal executeImplementationRun shows before
 * any dispatch (REAL_ROOT is a plain temp dir, not a git repo) — answered
 * exactly as a user clicking through it would. */
function installProceedAnywayStub(): { restore: () => void } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const orig = win.showWarningMessage;
  win.showWarningMessage = (): Promise<string> => Promise.resolve("Proceed Anyway");
  return { restore: (): void => { win.showWarningMessage = orig; } };
}

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>([
    [
      `aiHelper.consent.v${DISCLAIMER_VERSION}`,
      { acceptedAt: "2026-01-01T00:00:00.000Z", version: DISCLAIMER_VERSION },
    ],
  ]);
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(REAL_ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

/**
 * Spies on the registry's own `reportActivity` choke point (every
 * `TaskOperationHandle.reportActivity`/`reportStageStartingV1`/
 * `reportStageRunningV1` call resolves to this one method — see its doc
 * comment in taskOperations.ts) so a test can assert the REAL ordered
 * sequence of activity labels a dispatch reported, instead of only the
 * final value observable after `await`ing back to a synchronization point.
 * This is what makes it possible to prove a fast, un-awaited label (e.g.
 * "generating implementation checklist") actually fired, even though a
 * later label overwrites it before the test's own code resumes.
 */
function spyOnReportedActivity(): { log: (string | undefined)[]; restore: () => void } {
  const log: (string | undefined)[] = [];
  const orig = taskOperations.reportActivity.bind(taskOperations);
  (taskOperations as unknown as Record<string, unknown>).reportActivity = (
    id: string,
    activity: string | undefined,
    options?: { resetElapsedOrigin?: boolean; stageToken?: number; elapsedOrigin?: number }
  ): number | undefined => {
    const result = orig(id, activity, options);
    // Only a call that actually mutated (found a live root) reflects a real
    // report — a stale/no-op call (dead id, superseded stageToken) must not
    // pollute the sequence a test asserts against.
    if (result !== undefined) { log.push(activity); }
    return result;
  };
  return {
    log,
    restore: (): void => { (taskOperations as unknown as Record<string, unknown>).reportActivity = orig; },
  };
}

/** A controllable stand-in for `runnerRegistry.runImplementationForModel` —
 * the real seam runImplementationOrSealedV1 calls directly for a
 * CLI-resolved model (see runEditActionV1.test.ts's identical patch target).
 * `invoke()` does not settle until the test releases it. */
function controllableImplementationRun(): {
  invoked: Promise<void>;
  resolveWith: (result: Record<string, unknown>) => void;
  rejectWith: (err: Error) => void;
  fn: (...args: unknown[]) => Promise<unknown>;
} {
  let markInvoked: () => void = () => {};
  const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
  let settleResolve: (result: Record<string, unknown>) => void = () => {};
  let settleReject: (err: Error) => void = () => {};
  const fn = (): Promise<unknown> => {
    markInvoked();
    return new Promise((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
  };
  return {
    invoked,
    resolveWith: (result: Record<string, unknown>): void => settleResolve(result),
    rejectWith: (err: Error): void => settleReject(err),
    fn,
  };
}

function installImplementationPatches(): Patched[] {
  return [
    patch(settingsModule, "isAutoAdvanceEnabled", () => false),
    // Bypasses executeImplementationRun's "unrelated uncommitted changes"
    // modal unconditionally (reviewActions.ts calls this cross-module, so —
    // unlike isGitWorkspace/getUnrelatedWorkspaceChanges, defined in the same
    // module — it CAN be patched here). Without this, a PRIOR test's own
    // task folder under the same git-initialized REAL_ROOT (see REAL_ROOT's
    // `git init` above) shows up as an unrelated uncommitted change for every
    // test that runs after it, sending the run down the real warning-dialog
    // branch this suite must never depend on.
    patch(settingsModule, "allowsDirtyWorktreeChanges", () => true),
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveEffectiveStageChainV1", () => ({
      originStage: "impl",
      source: "stage",
      primary: "claude-cli:sonnet@high",
      backups: [],
    })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context\n")),
    patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
      Promise.resolve({
        availability: { available: true },
        providerLabel: "Claude Code",
        provider: "claude-cli",
        modelId: "claude-cli:sonnet@high",
        nativeModelId: "sonnet",
      })),
  ];
}

void describe("runImplementationWithAI — real in-flight activity through the production dispatcher", () => {
  void it("reports starting -> model -> running live, then the boundary-only changed-file count once the real dispatch result is known", async () => {
    const { folderPath } = makeImplTaskFolder(`impl-activity-live-${Math.floor(Math.random() * 1e9)}`);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const warnStub = installProceedAnywayStub();
    const controllable = controllableImplementationRun();
    const activitySpy = spyOnReportedActivity();
    const patches = [
      ...installImplementationPatches(),
      patch(runnerRegistryModule, "runImplementationForModel", controllable.fn),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("impl-activity-live")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivity: string | undefined;
    let liveRowModelId: string | undefined;
    let liveRowOrigin: number | undefined;
    let countRowActivity: string | undefined;

    try {
      const context = makeExtensionContext();
      const dispatchPromise = runImplementationWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      // Wait for the real dispatch to reach the real (still-pending)
      // provider call — proves reportStageStartingV1/setModel/
      // reportStageRunningV1 all actually ran along the real code path.
      await controllable.invoked;

      const liveRow = taskOperations.getTaskOperations(folderPath)[0];
      assert.ok(liveRow, "the root operation must still be live while the implementation dispatch is in flight");
      liveRowActivity = liveRow?.activity;
      liveRowModelId = liveRow?.modelId;
      liveRowOrigin = liveRow?.activityStartedAt;

      await new Promise((resolve) => setTimeout(resolve, 20));

      controllable.resolveWith({
        status: "completed",
        filesChanged: ["src/a.ts", "src/b.ts"],
        summary: "stub implementation run",
        // Runner-synthesized (the sealed CLI edit pipeline's own shape,
        // matching runEditActionV1.test.ts's identical stand-in) — a plain
        // model-authored summary with no `## Files Changed` section fails
        // `describeIncompleteImplementationRoundV1`'s shape checks, which
        // routes around the "writing summary" report entirely (it lives
        // behind the `!summaryIssue` gate) and this test needs that report
        // to fire.
        summaryIsSynthetic: true,
        runnerId: "claude-cli",
        actualProviderLabel: "Claude Code",
        actualStoredModelId: "claude-cli:sonnet@high",
      });

      // The boundary-only file-count report fires synchronously once the
      // result is known, before the rest of executeImplementationRun's
      // longer post-run bookkeeping (summary write, round-ledger close,
      // etc.) — poll briefly for it rather than assuming a specific await
      // ordering inside that bookkeeping.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = taskOperations.getTaskOperations(folderPath)[0];
        if (row?.activity && /file/.test(row.activity)) {
          countRowActivity = row.activity;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await dispatchPromise;

      // "writing summary" (review blocker 7bf9f2ec…-0, narrowed: the explicit
      // summary-boundary transition had no behavioral coverage) fires once
      // the round's result is known, after the boundary file-count report —
      // both land inside executeImplementationRun's post-dispatch bookkeeping,
      // which has already fully run by the time dispatchPromise settles, so
      // asserting against the real ordered log (not a poll) is the only
      // reliable way to observe it.
      const filesIdx = activitySpy.log.findIndex((a) => typeof a === "string" && /file/.test(a));
      const summaryIdx = activitySpy.log.indexOf("writing summary");
      assert.ok(filesIdx >= 0, "the boundary file-count activity must have been reported");
      assert.ok(summaryIdx >= 0, "the 'writing summary' explicit boundary activity must have been reported");
      assert.ok(
        summaryIdx > filesIdx,
        "'writing summary' must be reported after the file-count boundary, not before"
      );

      assert.equal(liveRowActivity, "running", "the real dispatch must have reported 'running' before the provider call");
      assert.equal(
        liveRowModelId,
        "claude-cli:sonnet@high",
        "the real dispatch must have attached the resolved model via setModel before the provider call"
      );
      assert.equal(typeof liveRowOrigin, "number", "an elapsed origin must be set for the running stage");
      assert.equal(
        countRowActivity,
        "2 files changed",
        "the boundary-only file-count report must fire from the real result once known"
      );

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "the live row must be gone once the real dispatch completes"
      );
      assert.deepEqual(ended.map((e) => e.state), ["succeeded"], "the real lifecycle must end as succeeded");
    } finally {
      activitySpy.restore();
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      warnStub.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("propagates a genuine unexpected provider exit uncaught through the real dispatch, cleaning up through the real lifecycle with no resurrected row", async () => {
    // Unlike the review family (whose coordinator classifies a transport
    // rejection into a normal, non-throwing outcome), a CLI-resolved
    // implementation dispatch's runImplementationForModel rejecting IS an
    // uncaught throw that propagates through executeImplementationRun's
    // try/finally (no intervening catch — see
    // reviewActionsStageActivity.test.ts's source-shape pin of that same
    // fact) and out through runTrackedOperation, which is what actually ends
    // the operation as failed. This is the real behavioral proof of that
    // previously only source-shape-asserted claim.
    const { folderPath } = makeImplTaskFolder(`impl-activity-exit-${Math.floor(Math.random() * 1e9)}`);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const warnStub = installProceedAnywayStub();
    const controllable = controllableImplementationRun();
    const patches = [
      ...installImplementationPatches(),
      patch(runnerRegistryModule, "runImplementationForModel", controllable.fn),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("impl-activity-exit")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivitySeen: string | undefined;

    try {
      const context = makeExtensionContext();
      const dispatchPromise = runImplementationWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      await controllable.invoked;
      const liveRow = taskOperations.getTaskOperations(folderPath)[0];
      liveRowActivitySeen = liveRow?.activity;

      controllable.rejectWith(new Error("simulated CLI provider crash"));

      // runImplementationWithAI wraps its whole dispatch in ONE
      // runTrackedOperation call with no enclosing try/catch of its own, so
      // an uncaught throw from inside it (propagated up through
      // executeImplementationRun's try/finally, which has no catch) reaches
      // the caller here too — this is the real, end-to-end proof of what
      // was previously only a source-shape claim.
      await assert.rejects(() => dispatchPromise, /simulated CLI provider crash/);

      assert.equal(liveRowActivitySeen, "running", "must be observably running before the unexpected exit");
      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "an unexpected provider exit must still clear the live row through the real lifecycle"
      );
      assert.deepEqual(
        ended.map((e) => e.state),
        ["failed"],
        "the real lifecycle must end as failed — never leaving a stale live row alongside a terminal outcome"
      );
    } finally {
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      warnStub.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("reports the checklist-generation sub-dispatch (reading context, generating checklist, model swap) through the real coordinator seam, then hands off to the main dispatch's own reading-context boundary", async () => {
    // Review blocker 7bf9f2ec…-0 (narrowed): every other test in this file
    // pre-seeds plan-final.md with an already-ticked checklist marker
    // specifically to SKIP this branch and isolate the main dispatch. That
    // left `needsChecklist`'s whole sub-dispatch — "generating implementation
    // checklist", the checklist's own "reading context (N KB)" boundary, and
    // the model swap to/from the checklist's resolved model — with no
    // behavioral coverage, only source-order assertions
    // (reviewActionsStageActivity.test.ts). This test removes the pre-seeded
    // marker so `needsChecklist` is genuinely true, and drives the REAL
    // `invokeGenerateImplementationActionV1` coordinator dispatch that
    // sub-step uses (the same function the standalone "Generate
    // Implementation" command calls), through the same
    // stubV1RunnerSelection/controllable-transport seam
    // `reviewActionsWorkflowActivityIntegration.test.ts` already proved works
    // for a real coordinator round trip. It then lets the run continue into
    // the main implementation dispatch, proving the main dispatch's OWN
    // "reading context (N KB)" boundary (reviewActions.ts:11280) and final
    // "running" transition also fire for real, and that the model segment
    // correctly swaps checklist -> main -> (never resets) across the whole
    // sequence.
    const { folderPath } = makeImplTaskFolderNeedingChecklist(
      `impl-activity-checklist-${Math.floor(Math.random() * 1e9)}`
    );

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const warnStub = installProceedAnywayStub();
    const activitySpy = spyOnReportedActivity();

    let freshModelCallCount = 0;
    const checklistTransport = controllableV1Transport();
    const mainRunControllable = controllableImplementationRun();
    const modelIdsSeen: (string | undefined)[] = [];
    const origSetModel = taskOperations.setModel.bind(taskOperations);
    (taskOperations as unknown as Record<string, unknown>).setModel = (
      id: string,
      modelId: string | undefined
    ): void => {
      modelIdsSeen.push(modelId);
      return origSetModel(id, modelId);
    };

    const patches = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      // See installImplementationPatches's identical patch for why this is
      // required: a prior test's own task folder under the shared,
      // git-initialized REAL_ROOT otherwise reads as an unrelated
      // uncommitted change.
      patch(settingsModule, "allowsDirtyWorktreeChanges", () => true),
      // Call #1 (before runTrackedOperation begins) resolves the MAIN
      // implementation model; call #2 (inside needsChecklist) resolves the
      // checklist's own model — genuinely different models, so the row's
      // model segment provably swaps rather than coincidentally repeating
      // the same string.
      patch(modelSelectionModule, "resolveFreshModelForStage", () => {
        freshModelCallCount += 1;
        return Promise.resolve({
          source: "settings",
          modelId: freshModelCallCount === 1 ? "claude-cli:sonnet@high" : "claude-cli:opus@max",
        });
      }),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveEffectiveStageChainV1", () => ({
        originStage: "impl",
        source: "stage",
        primary: "claude-cli:sonnet@high",
        backups: [],
      })),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context\n")),
      patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
        Promise.resolve({
          availability: { available: true },
          providerLabel: "Claude Code",
          provider: "claude-cli",
          modelId: "claude-cli:sonnet@high",
          nativeModelId: "sonnet",
        })),
      patch(runnerRegistryModule, "runImplementationForModel", mainRunControllable.fn),
      stubV1RunnerSelection([checklistTransport.transport]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("impl-activity-checklist")) { ended.push({ state: snap.state }); }
    });

    try {
      const context = makeExtensionContext();
      const dispatchPromise = runImplementationWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      // Wait for the checklist sub-dispatch's real (still-pending) coordinator
      // round trip — proves "generating implementation checklist", the
      // checklist's "reading context (N KB)" boundary, and the model swap to
      // the checklist model all really ran along the real code path first.
      await checklistTransport.invoked;
      const checklistLiveRow = taskOperations.getTaskOperations(folderPath)[0];
      assert.ok(checklistLiveRow, "the root operation must be live during the checklist sub-dispatch");
      assert.equal(
        checklistLiveRow?.activity,
        "running",
        "the checklist sub-dispatch must report 'running' before its own provider call"
      );
      assert.equal(
        checklistLiveRow?.modelId,
        "claude-cli:opus@max",
        "the checklist sub-dispatch must attach its OWN resolved model, not the main implementation model"
      );

      checklistTransport.resolveWith("# Implementation Notes\n\n<!-- ensemble:implementation-checklist -->\n\n- [ ] Do the thing.\n");

      // Once the checklist succeeds, the run continues into the main
      // dispatch, which resolves its own "reading context (N KB)" boundary
      // and reports "running" again (with the model swapped BACK to the main
      // model) before reaching the real (still-pending) main provider call.
      await mainRunControllable.invoked;
      const mainLiveRow = taskOperations.getTaskOperations(folderPath)[0];
      assert.ok(mainLiveRow, "the root operation must still be live during the main dispatch");
      assert.equal(
        mainLiveRow?.activity,
        "running",
        "the main dispatch must report 'running' again before its own provider call"
      );
      assert.equal(
        mainLiveRow?.modelId,
        "claude-cli:sonnet@high",
        "the main dispatch must restore the MAIN implementation model after the checklist sub-dispatch completes"
      );

      mainRunControllable.resolveWith({
        status: "completed",
        filesChanged: ["src/a.ts"],
        summary: "stub implementation run",
        summaryIsSynthetic: true,
        runnerId: "claude-cli",
        actualProviderLabel: "Claude Code",
        actualStoredModelId: "claude-cli:sonnet@high",
      });

      await dispatchPromise;

      // The real ordered sequence, proving every explicit boundary this
      // branch adds actually fired, in the right order, and that the
      // checklist's transient labels were not simply skipped en route to the
      // final "running" state observed above. Consecutive duplicates are
      // collapsed first: a coarse label reported twice in a row is the same
      // observable state (reportActivity REPLACES, never appends — see
      // reviewActions.ts's own "harmless: reportActivity replaces, never
      // appends" comment), so this asserts the sequence of DISTINCT states
      // rather than pinning an incidental duplicate report as a boundary.
      const dedupedLog = activitySpy.log.filter((activity, index) => activity !== activitySpy.log[index - 1]);
      assert.deepEqual(
        dedupedLog,
        [
          "starting",
          "generating implementation checklist",
          "reading context (0 KB)", // checklist's own context pack ("# Context\n")
          "running", // checklist sub-dispatch, checklist model
          "reading context (0 KB)", // main dispatch's own context pack
          "running", // main dispatch, main model restored
          "1 file changed",
          "writing summary",
        ],
        "every explicit activity boundary in the checklist-generation branch, then the main dispatch, must fire in order"
      );

      assert.deepEqual(
        modelIdsSeen,
        ["claude-cli:sonnet@high", "claude-cli:opus@max", "claude-cli:sonnet@high"],
        "the model segment must swap main -> checklist -> main across the two sub-dispatches"
      );

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "the live row must be gone once the real dispatch completes"
      );
      // Two "succeeded" ends are expected here (unlike the other tests in
      // this file): the checklist sub-dispatch runs as its own CHILD tracked
      // operation under the same lockKey (reviewActions.ts's "Generating
      // implementation checklist" runTrackedOperation, parented to `op`), so
      // it fires its own onDidEnd in addition to the root's — both must
      // still end as "succeeded", never anything else, and never leave a
      // live row behind (asserted above).
      assert.ok(ended.length > 0, "at least the root operation must have ended");
      assert.ok(
        ended.every((e) => e.state === "succeeded"),
        `every ended operation (root + checklist child) must end as succeeded, got: ${JSON.stringify(ended)}`
      );
    } finally {
      (taskOperations as unknown as Record<string, unknown>).setModel = origSetModel;
      activitySpy.restore();
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      warnStub.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
