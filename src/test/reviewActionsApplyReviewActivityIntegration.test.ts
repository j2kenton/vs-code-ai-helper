/**
 * Notifications in-flight visibility (Part II) — REAL behavioral coverage
 * for the plan-review "Apply Review" dispatch (`applyReviewWithAI`'s
 * `runApply`, reviewActions.ts), complementing
 * `reviewActionsWorkflowActivityIntegration.test.ts` (which covers
 * `runReviewForFolder` itself, a different function).
 *
 * Review blocker 7bf9f2ec…-0 (remaining portion): the only prior evidence for
 * this specific dispatch was a source-ordering assertion
 * (`reviewActionsStageActivity.test.ts`'s "reports 'starting'/'running' for
 * the plan-review Apply Review dispatch" test) — never a real invocation of
 * `applyReviewWithAI` observed through the real registry.
 *
 * This suite drives the REAL exported `applyReviewWithAI` end to end, through
 * its REAL `coordinator.executeAction` dispatch, at the identical
 * `stubV1RunnerSelection`/controllable-transport seam
 * `applyReviewNestedAutoAdvanceLock.test.ts` already proves works for this
 * exact function (including its automatic inline re-review that follows a
 * completed apply).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { applyReviewWithAI } from "../commands/reviewActions";
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
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-applyreview-activity-"));

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-applyreview-activity-private-"));
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
  fs.writeFileSync(path.join(folderPath, "plan-high-review.md"), "Readiness: 6/10\n\n- Needs work.\n", "utf8");
  return { folderPath };
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/** Same shape as the sibling review-family suite's controllable transport:
 * `invoke()` does not settle until the test releases it. */
function controllableTransport(runnerId = "stub-runner"): {
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

function markdownTransportV1(markdown: string, runnerId = "stub-review-runner"): AgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frame({
          version: 1,
          correlation: request.correlation,
          kind: "completed",
          content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

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

function installApplyReviewPatches(contextPackPath: string): Patched[] {
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

void describe("applyReviewWithAI — real in-flight activity through the production coordinator", () => {
  void it("reports starting -> model -> running through a real (controllable, still in-flight) apply dispatch, then clears the row once the automatic re-review also completes", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-activity-live-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const controllable = controllableTransport();
    const patches = [
      ...installApplyReviewPatches(contextPack),
      // First transport answers the apply dispatch itself (controllable, so
      // the test can observe the live row mid-flight); the second answers
      // the automatic inline re-review applyReviewWithAI always runs after a
      // completed apply (reviewActions.ts's "Re-running review" nested
      // runTrackedOperation call).
      stubV1RunnerSelection([controllable.transport, markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("applyreview-activity-live")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivity: string | undefined;
    let liveRowModelId: string | undefined;
    let liveRowOrigin: number | undefined;

    try {
      const context = makeExtensionContext();
      const dispatchPromise = applyReviewWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      // Wait for the real apply dispatch to reach the real (still-pending)
      // provider call — proves reportStageStartingV1/setModel/
      // reportStageRunningV1 all actually ran along applyReviewWithAI's own
      // real code path, not merely that the source contains the calls.
      await controllable.invoked;

      const liveRow = taskOperations.getTaskOperations(folderPath)[0];
      assert.ok(liveRow, "the root operation must still be live while the apply dispatch is in flight");
      liveRowActivity = liveRow?.activity;
      liveRowModelId = liveRow?.modelId;
      liveRowOrigin = liveRow?.activityStartedAt;

      await new Promise((resolve) => setTimeout(resolve, 20));

      controllable.resolveWith("# Plan\n\n1. Do the thing (revised).\n");
      await dispatchPromise;

      assert.equal(liveRowActivity, "running", "the real apply dispatch must have reported 'running' before the provider call");
      assert.equal(
        liveRowModelId,
        "claude-cli:sonnet@high",
        "the real apply dispatch must have attached the resolved plan-stage model via setModel before the provider call"
      );
      assert.equal(typeof liveRowOrigin, "number", "an elapsed origin must be set for the running stage");

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "the live row must be gone once the real dispatch (apply + automatic re-review) completes"
      );
      // Two "succeeded" ends are expected: the automatic inline re-review
      // runs as its own CHILD tracked operation, parented to the root
      // (reviewActions.ts's "Re-running review" runTrackedOperation call),
      // so it fires its own onDidEnd in addition to the root's — both must
      // still end as "succeeded", never anything else.
      assert.ok(ended.length > 0, "at least the root operation must have ended");
      assert.ok(
        ended.every((e) => e.state === "succeeded"),
        `every ended operation (root + re-review child) must end as succeeded, got: ${JSON.stringify(ended)}`
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

  void it("cleans up through the real lifecycle when the apply dispatch's provider transport fails mid-flight, leaving no live or resurrected row", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-activity-exit-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    let markInvoked: () => void = () => {};
    const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
    let settleReject: (err: Error) => void = () => {};
    const rejectingTransport: AgentTransportV1 = {
      runnerId: "stub-runner-reject",
      invoke: () => {
        markInvoked();
        return new Promise((_resolve, reject) => { settleReject = reject; });
      },
    };
    const patches = [
      ...installApplyReviewPatches(contextPack),
      stubV1RunnerSelection([rejectingTransport]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("applyreview-activity-exit")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivitySeen: string | undefined;
    let capturedOp: TaskOperationHandle | undefined;

    try {
      const context = makeExtensionContext();
      // applyReviewWithAI does not expose its root operation to the caller,
      // so this test drives it under an explicit parentOperation the same
      // way Fast Forward does (options.parentOperation), which is what
      // reviewActions.ts's own runApply branches on to decide whether to
      // open its own runTrackedOperation — giving this test a captured
      // handle to assert a late report against, exactly like the sibling
      // review-family suite's identical assertion.
      await runTrackedOperation(
        folderPath,
        {
          label: "Apply Review",
          stage: "plan-high-review",
          taskName: "Apply Review Activity Exit Test",
          kind: "apply-review",
          cancellable: true,
        },
        async (op) => {
          capturedOp = op;
          const dispatchPromise = applyReviewWithAI(
            vscode.Uri.file(REAL_ROOT),
            context,
            { taskFolderPath: folderPath },
            { parentOperation: op }
          );

          await invoked;
          const liveRow = taskOperations.getTaskOperations(folderPath)[0];
          liveRowActivitySeen = liveRow?.activity;

          settleReject(new Error("simulated provider crash"));
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
        "the coordinator classifies the transport failure into a normal, non-completed outcome that applyReviewWithAI's runApply handles internally and returns from — the wrapping operation therefore still ends through the ordinary success path, never leaving a stale live row"
      );

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
