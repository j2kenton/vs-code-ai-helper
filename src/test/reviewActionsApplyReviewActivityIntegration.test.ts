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
import { readChatHistory } from "../utils/chatHistoryStore";
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
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

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

/**
 * Same as `installApplyReviewPatches`, but leaves the real `writeRunLog` in
 * place — for RC3 item 9 (Step 7)'s "a failed plan Apply Review writes a run
 * log like any other round" requirement, which can only be proven by reading
 * an actual log file on disk, not a stubbed no-op.
 */
function installApplyReviewPatchesWithRealRunLogV1(contextPackPath: string): Patched[] {
  fs.writeFileSync(contextPackPath, "# Context\n", "utf8");
  return [
    patch(settingsModule, "isAutoAdvanceEnabled", () => false),
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPackPath))),
  ];
}

/** A transport whose reply carries the frame START marker but breaks the
 * frame contract (invalid JSON payload) — the coordinator classifies this as
 * a genuine `malformedResult`/`invalidFrame`. A reply with NO frame markers
 * at all is deliberately NOT used here: `tryFramelessContentFallbackV1`
 * leniently accepts frameless text as the result content itself (see
 * taskActionCoordinatorV1's own doc comment, "only `invalidFrame`, and only
 * when `FRAME_START_V1` does not appear" — meaning frameless text gets the
 * fallback, not a rejection), which would make this transport a `completed`
 * outcome instead of the failure this test needs. Once the start marker is
 * present, that leniency no longer applies. */
function malformedTransportV1(runnerId: string): AgentTransportV1 {
  return {
    runnerId,
    invoke: (_request, output): Promise<{ kind: "completed" }> => {
      output.write("<<<ENSEMBLE_AI_RESULT_V1>>>\nthis is not valid json\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n");
      return Promise.resolve({ kind: "completed" as const });
    },
  };
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

      const liveRows = taskOperations.getTaskOperations(folderPath);
      const liveRow = liveRows[0];
      assert.ok(liveRow, "the root operation must still be live while the apply dispatch is in flight");
      liveRowActivity = liveRow?.activity;
      liveRowModelId = liveRow?.modelId;
      liveRowOrigin = liveRow?.activityStartedAt;

      await new Promise((resolve) => setTimeout(resolve, 20));

      controllable.resolveWith("# Plan\n\n1. Do the thing (revised).\n");
      await dispatchPromise;

      assert.equal(
        liveRowActivity,
        "Applying review fixes…",
        "the leaf (plan-fix) operation must report what it is doing before the provider call"
      );
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

      assert.equal(
        liveRowActivitySeen,
        "Applying review fixes…",
        "must be observably applying the review fixes before the transport failure"
      );
      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "a classified provider-transport failure must still clear the live row through the real lifecycle"
      );
      assert.deepEqual(
        ended.map((e) => e.state),
        ["succeeded", "succeeded"],
        "(plan-fix child + wrapping operation) the coordinator classifies the transport failure into a normal, non-completed outcome that applyReviewWithAI's runApply handles internally and returns from — the wrapping operation therefore still ends through the ordinary success path, never leaving a stale live row"
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

  void it("2026-09-30 review follow-up (RC3 item 9): a cancelled apply dispatch is recorded as a cancelled round, never a failed one", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-activity-cancel-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    // A provider-declared "cancelled" envelope frame (the response content
    // itself says `kind: "cancelled"`, as a provider legitimately does for a
    // user-initiated stop) maps onto a genuine `outcome.kind === "cancelled"`
    // coordinator outcome — see taskActionCoordinatorV1.test.ts's "maps
    // provider-declared failure and cancellation envelopes onto stable
    // outcomes". This is distinct from a `providerCancelled` TRANSPORT EXIT
    // reached after the provider was actually invoked, which the coordinator
    // deliberately settles as `kind: "failed", code: "providerCancelled"`
    // instead (taskActionCoordinatorV1.ts ~line 2208's documented contract:
    // "a provider-invoked cancellation always settles failed... rather than
    // reading as an unremarkable cancel"), so it flows through the ordinary
    // failed-outcome handling every stage caller already has — recording
    // THAT case as "failed" is correct, not the bug this test targets.
    const cancelledTransport: AgentTransportV1 = {
      runnerId: "stub-runner-cancel",
      invoke: (request, output): Promise<{ kind: "completed" }> => {
        output.write(frame({ version: 1, correlation: request.correlation, kind: "cancelled", reason: "user" }));
        return Promise.resolve({ kind: "completed" as const });
      },
    };
    const patches = [
      ...installApplyReviewPatches(contextPack),
      stubV1RunnerSelection([cancelledTransport]),
    ];

    try {
      const context = makeExtensionContext();
      await runTrackedOperation(
        folderPath,
        {
          label: "Apply Review",
          stage: "plan-high-review",
          taskName: "Apply Review Activity Cancel Test",
          kind: "apply-review",
          cancellable: true,
        },
        async (op) => {
          await applyReviewWithAI(
            vscode.Uri.file(REAL_ROOT),
            context,
            { taskFolderPath: folderPath },
            { parentOperation: op }
          );
        }
      );

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "a cancelled dispatch must still clear the live row"
      );

      const progress = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as { roundLedger?: Array<{ mode: string; state: string; outcome?: { rejectionReason?: string } }> };
      const applyReviewRows = (progress.roundLedger ?? []).filter((row) => row.mode === "apply-review");
      assert.equal(applyReviewRows.length, 1, "expected exactly one apply-review round recorded");
      assert.equal(
        applyReviewRows[0]!.state,
        "cancelled",
        "a cancelled coordinator outcome must terminalize as 'cancelled', not 'failed' — describeTaskActionFailureV1's own doc comment disclaims cancelled outcomes"
      );
      assert.equal(
        applyReviewRows[0]!.outcome?.rejectionReason,
        undefined,
        "a cancelled round carries no rejectionReason — that field is reserved for genuine dispatch failures"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("2026-09-30 review (RC3 item 9 / Step 7): a plan Apply Review whose every attempt is rejected as malformed writes a real run log naming each attempt's reason, and records a failed round in the ledger — not a silent non-event", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-activity-malformed-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    // Four malformed replies: comfortably more than the coordinator's own
    // malformed-result retry budget plus its candidate chain, so the
    // dispatch is proven to exhaust every attempt rather than merely being
    // lucky with a short transport list.
    const patches = [
      ...installApplyReviewPatchesWithRealRunLogV1(contextPack),
      stubV1RunnerSelection([
        malformedTransportV1("stub-runner-malformed-1"),
        malformedTransportV1("stub-runner-malformed-2"),
        malformedTransportV1("stub-runner-malformed-3"),
        malformedTransportV1("stub-runner-malformed-4"),
      ]),
    ];

    try {
      const context = makeExtensionContext();
      await runTrackedOperation(
        folderPath,
        {
          label: "Apply Review",
          stage: "plan-high-review",
          taskName: "Apply Review Activity Malformed Test",
          kind: "apply-review",
          cancellable: true,
        },
        async (op) => {
          await applyReviewWithAI(
            vscode.Uri.file(REAL_ROOT),
            context,
            { taskFolderPath: folderPath },
            { parentOperation: op }
          );
        }
      );

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "an exhausted-malformed dispatch must still clear the live row"
      );

      // Run log: a real file under runs/ naming the failure, not a stubbed
      // no-op — RC3 item 9's "writes a run log like any other round".
      const runsDir = path.join(folderPath, "runs");
      const logFiles = fs.readdirSync(runsDir).filter((name) => name.includes("apply-review"));
      assert.equal(logFiles.length, 1, "expected exactly one apply-review run log");
      const logContent = fs.readFileSync(path.join(runsDir, logFiles[0]!), "utf8");
      assert.match(logContent, /# Apply Review/);
      assert.match(logContent, /malformed result \(invalidJson/, "the run log must name the actual final-attempt rejection reason, not a generic non-event");
      assert.match(logContent, /Attempt \S+ rejected \(invalidJson/, "the run log must name each PRIOR attempt's own rejection reason, per RC2 item 6's per-attempt reasons");

      // Round ledger: a failed round, not a silently dropped one.
      const progress = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as { roundLedger?: Array<{ mode: string; state: string; outcome?: { rejectionReason?: string } }> };
      const applyReviewRows = (progress.roundLedger ?? []).filter((row) => row.mode === "apply-review");
      assert.equal(applyReviewRows.length, 1, "expected exactly one apply-review round recorded");
      assert.equal(
        applyReviewRows[0]!.state,
        "failed",
        "every attempt rejected as malformed must terminalize as a genuine 'failed' round"
      );
      assert.match(
        applyReviewRows[0]!.outcome?.rejectionReason ?? "",
        /invalidJson/,
        "the ledger's own rejectionReason must name the actual cause, matching the run log"
      );

      // Chat outcome line: the failure must appear in the task's chat
      // transcript like any other terminalized round (RC3 item 9's "show the
      // failure as an outcome line in the chat"), not only in the run log
      // and the ledger.
      const chatMessages = await readChatHistory(folderPath);
      const outcomeMessages = chatMessages.filter((m) => m.text.startsWith("_Ended:"));
      assert.equal(outcomeMessages.length, 1, "expected exactly one round-outcome chat message");
      assert.match(
        outcomeMessages[0]!.text,
        /Apply Review/,
        "the chat outcome line must name the round that failed"
      );
      assert.match(
        outcomeMessages[0]!.text,
        /failed/,
        "the chat outcome line must show the round's real terminal state, not a silent non-event"
      );
      assert.match(
        outcomeMessages[0]!.text,
        /invalidJson/,
        "the chat outcome line must carry the actual rejection reason"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("RC2 item 2 / Step 57a: hands the real coordinator outcome back through options.dispatchProbe.coordinatorOutcome, for the caller's own admission-release trigger recording", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-activity-probe-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    let markInvoked: () => void = () => {};
    const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
    let settleReject: (err: Error) => void = () => {};
    const rejectingTransport: AgentTransportV1 = {
      runnerId: "stub-runner-reject-probe",
      invoke: () => {
        markInvoked();
        return new Promise((_resolve, reject) => { settleReject = reject; });
      },
    };
    const patches = [
      ...installApplyReviewPatches(contextPack),
      stubV1RunnerSelection([rejectingTransport]),
    ];

    try {
      const context = makeExtensionContext();
      const dispatchProbe: { coordinatorOutcome?: TaskActionOutcomeV1 } = {};
      await runTrackedOperation(
        folderPath,
        {
          label: "Apply Review",
          stage: "plan-high-review",
          taskName: "Apply Review Activity Probe Test",
          kind: "apply-review",
          cancellable: true,
        },
        async (op) => {
          const dispatchPromise = applyReviewWithAI(
            vscode.Uri.file(REAL_ROOT),
            context,
            { taskFolderPath: folderPath },
            { parentOperation: op, dispatchProbe }
          );
          await invoked;
          settleReject(new Error("simulated provider crash"));
          await dispatchPromise;
        }
      );

      assert.ok(
        dispatchProbe.coordinatorOutcome,
        "runApply must set dispatchProbe.coordinatorOutcome once its coordinator.executeAction call settles, so a composite caller (e.g. Fast Forward) can feed it to recordAdmissionReleaseTriggerV1"
      );
      assert.equal(
        dispatchProbe.coordinatorOutcome?.kind,
        "unavailable",
        "a provider transport rejection with no further candidates classifies as an unavailable coordinator outcome"
      );
      assert.equal(
        (dispatchProbe.coordinatorOutcome as { code?: string } | undefined)?.code,
        "candidatesExhausted"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("RC2 item 2 / Step 57a: the chained re-review's own coordinator outcome is authoritative in dispatchProbe.coordinatorOutcome, not the earlier apply's", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-activity-rereview-probe-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    // The apply dispatch itself succeeds outright (its own coordinator
    // outcome settles "completed"); only the automatic inline re-review
    // that applyReviewWithAI runs right after — a SECOND, later
    // coordinator.executeAction call — fails. Before this fix, the
    // re-review's own dispatchProbe was never wired, so
    // coordinatorOutcomeForAdmissionV1 (and options.dispatchProbe) stayed
    // on the apply's stale "completed" outcome, and a caller's `finally`
    // would release admission as if nothing was still amiss, even though
    // this later, terminal-failing invocation is the one release safety
    // actually needs to see.
    let markReReviewInvoked: () => void = () => {};
    const reReviewInvoked = new Promise<void>((resolve) => { markReReviewInvoked = resolve; });
    let settleReReviewReject: (err: Error) => void = () => {};
    const reReviewRejectingTransport: AgentTransportV1 = {
      runnerId: "stub-runner-reject-rereview",
      invoke: () => {
        markReReviewInvoked();
        return new Promise((_resolve, reject) => { settleReReviewReject = reject; });
      },
    };
    const patches = [
      ...installApplyReviewPatches(contextPack),
      stubV1RunnerSelection([
        markdownTransportV1("# Plan\n\n1. Do the thing (revised).\n"),
        reReviewRejectingTransport,
      ]),
    ];

    try {
      const context = makeExtensionContext();
      const dispatchProbe: { coordinatorOutcome?: TaskActionOutcomeV1 } = {};
      await runTrackedOperation(
        folderPath,
        {
          label: "Apply Review",
          stage: "plan-high-review",
          taskName: "Apply Review Activity Re-review Probe Test",
          kind: "apply-review",
          cancellable: true,
        },
        async (op) => {
          const dispatchPromise = applyReviewWithAI(
            vscode.Uri.file(REAL_ROOT),
            context,
            { taskFolderPath: folderPath },
            { parentOperation: op, dispatchProbe }
          );
          await reReviewInvoked;
          settleReReviewReject(new Error("simulated re-review provider crash"));
          await dispatchPromise;
        }
      );

      assert.ok(
        dispatchProbe.coordinatorOutcome,
        "the re-review's own coordinator.executeAction call must have set dispatchProbe.coordinatorOutcome"
      );
      assert.equal(
        dispatchProbe.coordinatorOutcome?.kind,
        "unavailable",
        "the re-review's failing transport (no further candidates) must be what dispatchProbe reflects — not the earlier apply's 'completed' outcome"
      );
      assert.equal(
        (dispatchProbe.coordinatorOutcome as { code?: string } | undefined)?.code,
        "candidatesExhausted"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("RC6 Part F: plan-fix child operation has stage: 'plan' and activity both standalone and under Fast Forward, and re-review has stage: reviewStage", async () => {
    const { folderPath } = makeTaskFolder(`applyreview-part-f-${Math.floor(Math.random() * 1e9)}`);
    const contextPack = path.join(folderPath, "context-pack.md");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const controllableApply = controllableTransport();
    const controllableReReview = controllableTransport();
    const standaloneApply = controllableTransport();
    const standaloneReReview = controllableTransport();
    const patches = [
      ...installApplyReviewPatches(contextPack),
      stubV1RunnerSelection([
        controllableApply.transport,
        controllableReReview.transport,
        standaloneApply.transport,
        standaloneReReview.transport,
      ]),
    ];

    try {
      const context = makeExtensionContext();
      let parentOpId: string | undefined;

      // 1. Under Fast Forward mode: an explicit parentOperation is passed
      await runTrackedOperation(
        folderPath,
        {
          label: "Fast Forward",
          stage: "plan-high-review",
          taskName: "Apply Review Activity FF Mode",
          kind: "review",
          cancellable: true,
        },
        async (parentOp) => {
          parentOpId = parentOp.id;
          const dispatchPromise = applyReviewWithAI(
            vscode.Uri.file(REAL_ROOT),
            context,
            { taskFolderPath: folderPath },
            { parentOperation: parentOp }
          );

          // In-flight apply-review fix child
          await controllableApply.invoked;
          const liveOpsDuringApply = taskOperations.getTaskOperations(folderPath);
          const rootOpDuringApply = liveOpsDuringApply.find((op) => op.id === parentOpId);
          const planFixOp = liveOpsDuringApply.find((op) => op.kind === "apply-review");
          assert.ok(planFixOp, "a child operation with kind 'apply-review' must exist during plan fix");
          assert.equal(planFixOp?.stage, "plan", "the plan-fix operation must have stage: 'plan'");
          assert.equal(planFixOp?.parentId, parentOpId, "the plan-fix operation must be parented to Fast Forward");
          assert.equal(planFixOp?.activity, "Applying review fixes…", "the plan-fix child operation must report plan fix activity");
          assert.equal(rootOpDuringApply?.activity, "Applying review fixes…", "the root operation must report plan fix activity");

          controllableApply.resolveWith("# Plan\n\n1. Do the thing (revised).\n");

          // In-flight re-review child
          await controllableReReview.invoked;
          const liveOpsDuringReReview = taskOperations.getTaskOperations(folderPath);
          const rootOpDuringReReview = liveOpsDuringReReview.find((op) => op.id === parentOpId);
          const reReviewOp = liveOpsDuringReReview.find((op) => op.kind === "review" && op.id !== parentOpId);
          assert.ok(reReviewOp, "a child operation for re-review must exist during re-review");
          assert.equal(reReviewOp?.stage, "plan-high-review", "the re-review child must be registered against the review stage");
          assert.ok(
            reReviewOp?.activity === "running" || reReviewOp?.activity === "Re-running review…",
            "the re-review child operation must report re-review activity"
          );
          assert.ok(
            rootOpDuringReReview?.activity === "running" || rootOpDuringReReview?.activity === "Re-running review…",
            "the root operation must report re-review activity"
          );

          controllableReReview.resolveWith("Readiness: 9/10\n\n- Ready.\n");
          await dispatchPromise;
        }
      );

      // 2. Standalone mode: applyReviewWithAI with no parentOperation
      fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
      fs.writeFileSync(path.join(folderPath, "plan-high-review.md"), "Readiness: 6/10\n\n- Needs work.\n", "utf8");

      const standaloneDispatchPromise = applyReviewWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      // In-flight standalone apply-review fix child
      await standaloneApply.invoked;
      const liveOpsDuringStandaloneApply = taskOperations.getTaskOperations(folderPath);
      const rootOpDuringStandaloneApply = liveOpsDuringStandaloneApply.find((op) => !op.parentId);
      const planFixOpStandalone = liveOpsDuringStandaloneApply.find(
        (op) => op.kind === "apply-review" && op.parentId === rootOpDuringStandaloneApply?.id
      );
      assert.ok(rootOpDuringStandaloneApply, "the root operation must exist during standalone plan fix");
      assert.ok(planFixOpStandalone, "a child operation with kind 'apply-review' must exist during standalone plan fix");
      assert.equal(planFixOpStandalone?.stage, "plan", "the plan-fix operation must have stage: 'plan' in standalone mode");
      assert.equal(planFixOpStandalone?.parentId, rootOpDuringStandaloneApply?.id, "the plan-fix child operation must be parented to the root operation");
      assert.equal(planFixOpStandalone?.activity, "Applying review fixes…", "the plan-fix child operation must report plan fix activity in standalone mode");
      assert.equal(rootOpDuringStandaloneApply?.activity, "Applying review fixes…", "the root operation must report plan fix activity in standalone mode");

      standaloneApply.resolveWith("# Plan\n\n1. Do the thing (revised).\n");

      // In-flight standalone re-review child
      await standaloneReReview.invoked;
      const liveOpsDuringStandaloneReReview = taskOperations.getTaskOperations(folderPath);
      const rootOpDuringStandaloneReReview = liveOpsDuringStandaloneReReview.find((op) => !op.parentId);
      const reReviewOpStandalone = liveOpsDuringStandaloneReReview.find(
        (op) => op.kind === "review" && op.parentId === rootOpDuringStandaloneReReview?.id
      );
      assert.ok(reReviewOpStandalone, "a child operation for re-review must exist during re-review in standalone mode");
      assert.equal(reReviewOpStandalone?.stage, "plan-high-review", "the re-review child must be registered against the review stage in standalone mode");
      assert.ok(
        reReviewOpStandalone?.activity === "running" || reReviewOpStandalone?.activity === "Re-running review…",
        "the re-review child operation must report re-review activity in standalone mode"
      );

      standaloneReReview.resolveWith("Readiness: 9/10\n\n- Ready.\n");
      await standaloneDispatchPromise;
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
