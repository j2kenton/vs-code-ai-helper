/**
 * Notifications in-flight visibility (Part II) — REAL behavioral coverage.
 *
 * Review blocker 7bf9f2ec…-0 (narrowed): `reviewActionsStageActivity.test.ts`
 * only proves source ORDERING (report-call-before-await via string search),
 * and `statusTreeProviderLiveActivity.test.ts` only drives the shared
 * `reportStageStartingV1`/`reportStageRunningV1` helpers directly against a
 * bare registry handle. Neither exercises a real model-backed dispatch
 * function — the actual review/coordinator/provider seam — through the
 * registry, so neither can prove the wiring in `runReviewForFolder` itself
 * (as opposed to the shared helpers it calls) actually fires in the right
 * order with a real provider round trip, or that an unexpected provider exit
 * mid-flight is cleaned up correctly.
 *
 * This suite drives the REAL exported `runReviewForFolder` (reviewActions.ts)
 * under a REAL `taskOperations` root operation, through the REAL production
 * coordinator (`createProductionTaskActionCoordinatorV1`), with only the
 * provider transport faked — the identical harness
 * `applyReviewNestedAutoAdvanceLock.test.ts` already proved works for driving
 * this exact coordinator wiring end to end (same
 * `stubV1RunnerSelection`/`createV1RunnerSelectionOpener` seam). What's new
 * here is a CONTROLLABLE transport: `invoke()` does not resolve until the
 * test says so, which lets the test observe the registry row while the
 * "provider" is genuinely still in flight (proving "running" + model +
 * elapsed are real live state, not just reachable source lines), then
 * resolve or reject it to observe the two terminal transitions the plan
 * requires: normal completion, and an unexpected provider exit.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runReviewForFolder } from "../commands/reviewActions";
import { runTrackedOperation, taskOperations, TaskOperationHandle } from "../utils/taskOperations";
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

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-activity-"));

// See applyReviewNestedAutoAdvanceLock.test.ts's identical top-level
// comment: runReviewForFolder dispatches through the real production
// coordinator, which requires this wiring exactly as extension.ts performs
// it at activation, or getProductionActionConversationOrchestratorV1 throws
// "not wired yet" before any of this suite's real assertions run.
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-activity-private-"));
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

function makeTaskFolder(name: string): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress = {
    taskFolder: name,
    currentStage: "plan-high-review",
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
    path.join(folderPath, "plan-high-review.md"),
    "Readiness: 6/10\n\n- Needs work.\n",
    "utf8"
  );
  return { folderPath };
}

/** Bridge the vscode-stub file system onto the real disk, same as
 * applyReviewNestedAutoAdvanceLock.test.ts. */
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

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/**
 * A V1 transport whose `invoke()` does not settle until the test explicitly
 * releases it — unlike every other fake transport in this codebase (which
 * resolve synchronously/immediately), this is what makes it possible to
 * observe the registry row while a "provider" is genuinely still running,
 * not just prove a report call is reachable before an await.
 */
function controllableTransport(runnerId = "stub-runner"): {
  transport: AgentTransportV1;
  invoked: Promise<void>;
  resolveWith: (markdown: string) => void;
  rejectWith: (err: Error) => void;
} {
  let markInvoked: () => void = () => {};
  const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
  let settleResolve: (markdown: string) => void = () => {};
  let settleReject: (err: Error) => void = () => {};
  const transport: AgentTransportV1 = {
    runnerId,
    invoke: (request, output) => {
      markInvoked();
      return new Promise((resolve, reject) => {
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
        settleReject = reject;
      });
    },
  };
  return {
    transport,
    invoked,
    resolveWith: (markdown: string): void => settleResolve(markdown),
    rejectWith: (err: Error): void => settleReject(err),
  };
}

/** Same seam as applyReviewNestedAutoAdvanceLock.test.ts: patches
 * runnerRegistry's V1 provider-selection opener so a real coordinator
 * dispatch never reaches an actual CLI or Copilot provider. */
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
        modelId: "claude-cli:sonnet@high",
      });
      return {
        kind: "reserved",
        reserved: {
          handle,
          providerLabel: "Test Provider",
          storedModelId: "claude-cli:sonnet@high",
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

/** Standard patch set for a plan-review dispatch (isPlanReview branch of
 * runReviewForFolder): auto-advance off (keep this test single-round),
 * a resolved model, a stubbed prompt render, no-op run log, and a
 * context-pack write pointed at a real file the fs bridge can read back. */
function installPlanReviewPatches(contextPackPath: string): Patched[] {
  fs.writeFileSync(contextPackPath, "# Context\n", "utf8");
  return [
    patch(settingsModule, "isAutoAdvanceEnabled", () => false),
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPackPath))),
  ];
}

void describe("runReviewForFolder — real in-flight activity through the production coordinator", () => {
  void it("reports starting -> model -> running through a real (controllable, still in-flight) provider call, then clears the row on real completion", async () => {
    const { folderPath } = makeTaskFolder(`review-activity-live-${Math.floor(Math.random() * 1e9)}`);
    const taskFolderUri = vscode.Uri.file(folderPath);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const contextPack = path.join(folderPath, "context-pack.md");
    const controllable = controllableTransport();
    const patches = [
      ...installPlanReviewPatches(contextPack),
      stubV1RunnerSelection([controllable.transport]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("review-activity-live")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivity: string | undefined;
    let liveRowModelId: string | undefined;
    let liveRowOrigin: number | undefined;

    try {
      // Wrapped in runTrackedOperation exactly as every real call site
      // dispatches runReviewForFolder (reviewActions.ts never calls it bare)
      // — this is what actually ends the operation once the callback
      // settles, matching production lifecycle ownership.
      await runTrackedOperation(
        folderPath,
        {
          label: "High-Level Code Review",
          stage: "plan-high-review",
          taskName: "Review Activity Live Test",
          kind: "review",
          cancellable: true,
        },
        async (op) => {
          const dispatchPromise = runReviewForFolder(
            vscode.Uri.file(REAL_ROOT),
            taskFolderUri,
            workspaceRoot,
            "plan-high-review",
            true,
            { operation: op }
          );

          // Wait for the real dispatch to reach the real (still-pending)
          // provider call — this proves reportStageRunningV1/setModel
          // actually ran along the real code path, not merely that the
          // source contains the calls.
          await controllable.invoked;

          const liveRow = taskOperations.getTaskOperations(folderPath)[0];
          assert.ok(liveRow, "the root operation must still be live while the provider call is in flight");
          liveRowActivity = liveRow?.activity;
          liveRowModelId = liveRow?.modelId;
          liveRowOrigin = liveRow?.activityStartedAt;

          // Let real time pass so a genuine elapsed reading would be
          // nonzero — proving activityStartedAt is a real timestamp, not a
          // placeholder.
          await new Promise((resolve) => setTimeout(resolve, 20));

          controllable.resolveWith("Readiness: 9/10\n\n- Ready.\n");
          await dispatchPromise;
        }
      );

      assert.equal(liveRowActivity, "running", "the real dispatch must have reported 'running' before the provider call");
      assert.equal(
        liveRowModelId,
        "claude-cli:sonnet@high",
        "the real dispatch must have attached the resolved model via setModel before the provider call"
      );
      assert.equal(typeof liveRowOrigin, "number", "an elapsed origin must be set for the running stage");

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "the live row must be gone once the real dispatch completes"
      );
      assert.deepEqual(ended.map((e) => e.state), ["succeeded"], "the real lifecycle must end as succeeded");
    } finally {
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("cleans up through the real lifecycle when the provider transport fails mid-flight, leaving no live or resurrected row", async () => {
    // The coordinator's own transport boundary (agentExecutionBrokerV1.ts's
    // finishInvocation) deliberately CATCHES a transport rejection and
    // classifies it as a `transportFailure` outcome rather than letting it
    // escape as an exception — a provider crash is ordinary, handled
    // business logic, not a bug in the dispatch plumbing. So this proves
    // the real cleanup path for that classified failure: the operation
    // still ends cleanly through the normal (non-throwing) return, the row
    // is removed, and nothing resurrects it — never a coexisting live row
    // and terminal outcome.
    const { folderPath } = makeTaskFolder(`review-activity-exit-${Math.floor(Math.random() * 1e9)}`);
    const taskFolderUri = vscode.Uri.file(folderPath);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const contextPack = path.join(folderPath, "context-pack.md");
    const controllable = controllableTransport();
    const patches = [
      ...installPlanReviewPatches(contextPack),
      stubV1RunnerSelection([controllable.transport]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("review-activity-exit")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivitySeen: string | undefined;
    let capturedOp: TaskOperationHandle | undefined;

    try {
      await runTrackedOperation(
        folderPath,
        {
          label: "High-Level Code Review",
          stage: "plan-high-review",
          taskName: "Review Activity Exit Test",
          kind: "review",
          cancellable: true,
        },
        async (op) => {
          capturedOp = op;
          const dispatchPromise = runReviewForFolder(
            vscode.Uri.file(REAL_ROOT),
            taskFolderUri,
            workspaceRoot,
            "plan-high-review",
            true,
            { operation: op }
          );

          await controllable.invoked;
          const liveRow = taskOperations.getTaskOperations(folderPath)[0];
          liveRowActivitySeen = liveRow?.activity;

          // Simulate an unexpected provider exit — a transport rejection,
          // which is exactly what a crashed/killed CLI process surfaces as,
          // per the coordinator's own transport contract.
          controllable.rejectWith(new Error("simulated provider crash"));

          // The real dispatch does NOT throw for this: the coordinator
          // classifies the failure and runReviewForFolder's own handler
          // (handleReviewOutcomeV1) reports it and returns normally.
          await dispatchPromise;
        }
      );

      assert.equal(liveRowActivitySeen, "running", "must be observably running before the transport failure");
      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "a classified provider-transport failure must still clear the live row through the real lifecycle"
      );
      assert.deepEqual(
        ended.map((e) => e.state),
        ["succeeded"],
        "runReviewForFolder handles a classified transport failure internally and returns normally, so the wrapping operation ends through the ordinary success path — never leaving a stale live row"
      );

      // A late report captured before completion must not resurrect the row
      // — proven here against the real dispatch's own captured operation.
      assert.ok(capturedOp);
      capturedOp?.reportActivity("running", { resetElapsedOrigin: true });
      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "a late report after the real dispatch has ended must never resurrect the row"
      );
    } finally {
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
