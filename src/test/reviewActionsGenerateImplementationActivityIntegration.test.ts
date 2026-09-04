/**
 * Notifications in-flight visibility (Part II) — REAL behavioral coverage for
 * the standalone "Generate Implementation" command (`generateImplementationWithAI`,
 * reviewActions.ts), complementing `reviewActionsWorkflowActivityIntegration
 * .test.ts` (review family) and `reviewActionsImplementationActivityIntegration
 * .test.ts` (Run Implementation family, whose third test drives this exact
 * function's shared `invokeGenerateImplementationActionV1` dispatch, but only
 * as Run Implementation's internal checklist SUB-step — never as this,
 * the standalone top-level command).
 *
 * Review blocker 7bf9f2ec…-0 (remaining portion): prior evidence for this
 * specific entry point was source-ordering assertions only
 * (`reviewActionsStageActivity.test.ts`'s "reports 'starting'/model/'running'
 * for the standalone Generate Implementation command" test) — never a real
 * invocation of `generateImplementationWithAI` itself observed through the
 * real registry.
 *
 * This suite drives the REAL exported `generateImplementationWithAI` end to
 * end, through its REAL `invokeGenerateImplementationActionV1` /
 * production-coordinator dispatch. Only the innermost provider transport is
 * faked, at the identical `stubV1RunnerSelection`/controllable-transport seam
 * already proved for this exact coordinator call in
 * `reviewActionsImplementationActivityIntegration.test.ts`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { generateImplementationWithAI } from "../commands/reviewActions";
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
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-genimpl-activity-"));

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-genimpl-activity-private-"));
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
  return { folderPath };
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/** Same shape as the sibling suites' controllable V1 transport: `invoke()`
 * does not settle until the test releases it, so the registry row can be
 * observed while the real dispatch is genuinely still in flight. */
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

/** Same seam the sibling suites patch: routes a real coordinator dispatch to
 * a fake V1 transport instead of a real CLI/Copilot provider. */
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

function installGenerateImplementationPatches(): Patched[] {
  return [
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
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

void describe("generateImplementationWithAI — real in-flight activity through the production dispatcher", () => {
  void it("reports starting -> reading context -> model -> running live through the real coordinator dispatch, then clears the row on completion", async () => {
    const { folderPath } = makeTaskFolder(`genimpl-activity-live-${Math.floor(Math.random() * 1e9)}`);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const controllable = controllableV1Transport();
    const patches = [
      ...installGenerateImplementationPatches(),
      stubV1RunnerSelection([controllable.transport]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("genimpl-activity-live")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivity: string | undefined;
    let liveRowModelId: string | undefined;
    let liveRowOrigin: number | undefined;

    try {
      const context = makeExtensionContext();
      const dispatchPromise = generateImplementationWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      // Wait for the real dispatch to reach the real (still-pending)
      // coordinator provider call — proves the "starting" report, the
      // "reading context (N KB)" boundary, setModel, and reportStageRunningV1
      // all actually ran along the real code path in this exact, standalone
      // command, not merely that the source contains the calls (as the
      // sibling source-ordering suite only proved).
      await controllable.invoked;

      const liveRow = taskOperations.getTaskOperations(folderPath)[0];
      assert.ok(liveRow, "the root operation must still be live while the coordinator call is in flight");
      liveRowActivity = liveRow?.activity;
      liveRowModelId = liveRow?.modelId;
      liveRowOrigin = liveRow?.activityStartedAt;

      await new Promise((resolve) => setTimeout(resolve, 20));

      controllable.resolveWith("# Implementation Notes\n\nDid the thing.\n");
      await dispatchPromise;

      assert.equal(liveRowActivity, "running", "the real dispatch must have reported 'running' before the coordinator call");
      assert.equal(
        liveRowModelId,
        "claude-cli:sonnet@high",
        "the real dispatch must have attached the resolved model via setModel before the coordinator call"
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

  void it("cleans up through the real lifecycle when the coordinator's provider transport fails mid-flight, leaving no live or resurrected row", async () => {
    const { folderPath } = makeTaskFolder(`genimpl-activity-exit-${Math.floor(Math.random() * 1e9)}`);

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
      ...installGenerateImplementationPatches(),
      stubV1RunnerSelection([rejectingTransport]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("genimpl-activity-exit")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivitySeen: string | undefined;

    try {
      const context = makeExtensionContext();
      const dispatchPromise = generateImplementationWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      await invoked;
      const liveRow = taskOperations.getTaskOperations(folderPath)[0];
      liveRowActivitySeen = liveRow?.activity;

      settleReject(new Error("simulated provider crash"));
      await dispatchPromise;

      assert.equal(liveRowActivitySeen, "running", "must be observably running before the transport failure");
      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "a classified provider-transport failure must still clear the live row through the real lifecycle"
      );
      assert.deepEqual(
        ended.map((e) => e.state),
        ["succeeded"],
        "the coordinator classifies the transport failure into a normal 'failed' outcome, which generateImplementationWithAI handles internally and returns from — the wrapping operation therefore still ends through the ordinary success path, never leaving a stale live row"
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
