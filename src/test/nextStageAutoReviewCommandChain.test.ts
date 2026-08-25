/**
 * Command-layer end-to-end coverage of the C1 critical chain, driven through
 * the REAL registered command — the exact invocation the tree-row button
 * makes — rather than through runTrackedOperation directly:
 *
 *   executeCommand("vs-code-ai-helper.nextStage", { task }) →
 *   advanceStage persists plan → plan-high-review →
 *   auto-review dispatch registers a cancellable "Review" operation
 *   (Notifications row + stage-row spinner observed mid-run, from inside the
 *   provider call) →
 *   the real runReviewForFolder pipeline validates, stages, and CAS-publishes
 *   the review artifact (exact contents asserted) →
 *   the operation-notification bridge records the persistent terminal entry.
 *
 * Only the provider boundary is faked (model resolution, the runner process,
 * prompt template rendering, run-log/context-pack writers) — everything from
 * the command registration down through stage transition, attempt-ID CAS,
 * artifact staging/rename, the operation registry, and the notification
 * bridge is the production code path.
 *
 * Remaining gap to the full acceptance criterion: this still runs under the
 * vscode test stub, not a packaged extension host (@vscode/test-electron), so
 * package.json activation/menu wiring and real TreeView rendering are not
 * exercised here.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { registerReviewActionCommands, runReviewForFolder } from "../commands/reviewActions";
import { StageNode } from "../views/taskTreeProvider";
import {
  StatusTreeProvider,
  StatusTreeNode,
  StatusOperationNode,
  StatusEntry,
} from "../views/statusView";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";
import { readTaskProgressForTest as readTaskProgress } from "./taskFolderFixture";
import { IncompleteTask } from "../types/incompleteTask";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import { scheduleAutomationChain, resetAutomationChainGuards, type AutomationDispatch } from "../utils/automationChain";
import { runTrackedOperation, taskOperations } from "../utils/taskOperations";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";

// ── Provider-boundary seams, monkey-patched via the shared CommonJS module
// objects (the same technique as markTaskDoneUngated.test.ts /
// commitAndPushDuplicateGuard.test.ts) so reviewActions.ts's named imports
// see the stubbed behaviour without dedicated DI seams. ──────────────────────
/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const automationChainModule = require("../utils/automationChain") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-cmd-chain-"));
let autoImplementationFolderCounter = 0;

// runReviewForFolder runs through the real production coordinator
// (createProductionTaskActionCoordinatorV1), which requires the Chat
// interaction transaction store to be wired exactly as extension.ts does at
// activation — otherwise getProductionActionConversationOrchestratorV1
// throws "not wired yet" before this test's actual command chain ever runs.
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-cmd-chain-private-"));
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

const FAKE_REVIEW =
  "Readiness: 6/10\n\n- Summary verdict: needs changes.\n- Blocking issues: one.\n";

function makeTaskFolder(name: string, stage: TaskStage): { folderPath: string; progress: TaskProgress } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: stage,
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
  return { folderPath, progress };
}

function makeButtonPressArg(folderPath: string, progress: TaskProgress): { task: IncompleteTask } {
  return {
    task: {
      folderUri: vscode.Uri.file(folderPath),
      folderName: path.basename(folderPath),
      progress,
      canonicalId: folderPath,
    },
  };
}

/** Bridge the vscode-stub file system onto the real disk for this test. */
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

/**
 * `scheduleAutomationChain`'s deferred branch is intentionally
 * fire-and-forget once a root operation ends (see its own doc comment):
 * nothing awaits the follow-up command it dispatches. A test that exercises
 * that real, un-mocked path (rather than a mock that captures dispatches
 * synchronously) can therefore return while that follow-up is still running
 * as a detached operation. Left undrained, the detached chain resolves its
 * production imports (settings, scheduleAutomationChain itself) dynamically
 * at whatever moment it happens to finish — which can be after a *later*
 * test has installed its own patches, silently leaking a call into that
 * test's assertions. Wait for the task's operation registry to go quiet
 * before restoring mocks so nothing from this test's chain can bleed
 * forward.
 */
async function waitForTaskOperationsIdle(taskFolderPath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (taskOperations.rootOperationIdFor(taskFolderPath) !== undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * runReviewForFolder now runs through the real V1 action coordinator
 * (createProductionTaskActionCoordinatorV1), which selects providers via
 * runnerRegistry's `createV1RunnerSelectionOpener` — NOT the legacy
 * `resolveRunnerForModel` cascade this file used to patch. Framing a fake
 * response requires the V1 envelope format and this seam instead (mirrors
 * publishOwnershipMatrix.test.ts's identical helpers).
 */
function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/** A V1 transport that frames a completed markdown-artifact.v1 envelope, running `produceMarkdown` at invoke time. */
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

/**
 * Patches runnerRegistry's `createV1RunnerSelectionOpener` factory so a
 * coordinator-run review never reaches a real CLI or Copilot provider.
 * Reservations still flow through the caller's own selection session, so
 * claim-once/one-reservation-per-attempt stay session-enforced exactly like
 * production; only WHICH runner/model is offered is stubbed.
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
  // The review dispatch site pre-flights the stage's REAL provider chain
  // before opening a selection; no CLI exists in this harness, so an
  // unstubbed pre-flight would pause the task before the stubbed selection
  // above is ever reached. A stubbed selection is dispatchable by definition.
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

function operationNodes(provider: StatusTreeProvider): StatusOperationNode[] {
  const children = (provider.getChildren() ?? []) as StatusTreeNode[];
  return children.filter(
    (node): node is StatusOperationNode => "kind" in node && node.kind === "operation"
  );
}

function makeExtensionContext(): vscode.ExtensionContext {
  // Minimal memento with AI consent pre-granted: the auto-review chain now
  // dispatches the REAL runReviewWithAI command, whose consent gate reads
  // workspaceState (aiConsent.ts) before running.
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

void describe("nextStage command → auto-review chain (command-layer end-to-end)", () => {
  void it("button press → transition → registered cancellable review → published artifact → persistent entry", async () => {
    const { folderPath, progress } = makeTaskFolder(`chain_${Math.floor(Math.random() * 1e9)}`, "plan");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const bridge = installOperationNotificationBridge();
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    // Snapshots captured from INSIDE the provider call — i.e. while the
    // auto-started review operation is running. (V1 requests carry no
    // artifact/result path — AC-RUNNER-01 — so there is no outputFile to
    // snapshot here anymore; the staged-artifact assertion below instead
    // checks the published content directly.)
    const midRun: {
      reviewRows?: StatusOperationNode[];
      stageSpinnerIconId?: string;
    } = {};

    const fakeTransport = scriptedMarkdownTransportV1(() => {
      midRun.reviewRows = operationNodes(provider).filter((n) => n.label === "Review");
      const stageRow = new StageNode(buttonArg.task, "plan-high-review", "current", undefined);
      midRun.stageSpinnerIconId =
        stageRow.iconPath instanceof vscode.ThemeIcon ? stageRow.iconPath.id : "";
      return FAKE_REVIEW;
    });

    const contextPackUri = vscode.Uri.file(path.join(folderPath, "context-pack.md"));
    fs.writeFileSync(contextPackUri.fsPath, "# Context Pack (stub)\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => true),
      patch(settingsModule, "isAutoAdvanceEnabled", () => false),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      stubV1RunnerSelection([fakeTransport]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(contextPackUri)),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      // The exact invocation the "Complete Stage & Move On" tree button makes.
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);

      // 1. The transition persisted plan → plan-high-review, and the review
      //    run claimed an attempt ID through the production CAS path.
      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "plan-high-review");
      assert.ok(persisted?.reviewAttemptId, "the auto-started review claimed a review attempt ID");

      // 2. While the provider ran, the auto-started review was registered as
      //    exactly one cancellable operation row, and the newly entered review
      //    stage row was spinning.
      assert.equal(midRun.reviewRows?.length, 1, "exactly one in-progress Review row during the run");
      assert.equal(midRun.reviewRows?.[0]?.cancellable, true, "the auto-started review is cancellable");
      assert.equal(midRun.stageSpinnerIconId, "loading~spin", "the review stage row spins during the run");

      // 3. The review artifact was published with EXACTLY the validated
      //    provider output (staging tmp → CAS → rename, the production path),
      //    signed with the claimed reservation's identity (fileUtils.ts's
      //    withAttribution — same header format the legacy CliAgentRunner
      //    text path uses).
      const artifact = fs.readFileSync(path.join(folderPath, "plan-high-review.md"), "utf8");
      assert.equal(
        artifact,
        `<!-- Generated by Test Provider (test) -->\n\n${FAKE_REVIEW}`,
        "published artifact content matches the provider output exactly, signed with the claimed reservation's identity"
      );

      // 4. No operation row survives completion; the activation-time bridge
      //    recorded the persistent terminal entry for the review.
      assert.equal(operationNodes(provider).length, 0, "no operation row survives completion");
      const nodes = (provider.getChildren() ?? []) as StatusTreeNode[];
      const terminalEntries = nodes.filter(
        (n): n is StatusEntry =>
          !("kind" in n) && n.message.includes("Review") && n.message.includes("completed")
      );
      assert.equal(terminalEntries.length, 1, "exactly one persistent terminal entry for the review");
      assert.ok(
        (provider.getEntries?.() ?? []).some((e: { message: string }) =>
          e.message.includes("advanced to")),
        "the stage-advance notification was recorded in the Notifications section"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const sub of context.subscriptions) { sub.dispose(); }
      wsStub.restore();
      fsBridge.restore();
      bridge.dispose();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("advancing plan-low-review → impl promotes plan.md into plan-final.md with exact contents", async () => {
    const { folderPath, progress } = makeTaskFolder(`promote_${Math.floor(Math.random() * 1e9)}`, "plan-low-review");
    const planContent = "# Plan\n\n1. Do the thing.\n2. Verify the thing.\n";
    fs.writeFileSync(path.join(folderPath, "plan.md"), planContent, "utf8");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const patches: Patched[] = [
      // No destination-stage AI action: this test pins the artifact promotion
      // that the manual "Complete Stage & Move On" transition itself performs.
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => false),
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);

      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "impl");

      // The real plan-final.md write path (preparePlanPromotion → publish):
      // exact artifact contents, not just existence. The promotion reads the
      // plan through readNonEmptyText, which trims surrounding whitespace.
      const planFinal = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
      assert.equal(planFinal, planContent.trim(), "plan-final.md carries exactly the promoted plan content");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const sub of context.subscriptions) { sub.dispose(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("regression: cancels a running operation for the task before the artifact-existence check can short-circuit the transition", async () => {
    // Reproduces the fixed bug: cancelRunningOperationsForTask used to run
    // AFTER the artifact-existence check, which itself can return early — so
    // a task with a missing/empty artifact left its previous stage's
    // operation running underneath it even after "Complete Stage & Move On"
    // was clicked. Emptying plan.md here deliberately drives nextStage down
    // that early-return path, so this test can observe that cancellation
    // still happened despite the transition itself not proceeding.
    const { folderPath, progress } = makeTaskFolder(`abort-order-${Math.floor(Math.random() * 1e9)}`, "plan");
    fs.writeFileSync(path.join(folderPath, "plan.md"), "", "utf8");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
    ];

    let cancelled = false;
    const stillRunning = runTrackedOperation(
      folderPath,
      { label: "Stub Long-Running", stage: "plan", kind: "review", cancellable: true },
      (handle) =>
        new Promise<void>((resolve) => {
          const token = handle.token;
          if (!token || token.isCancellationRequested) {
            cancelled = !!token?.isCancellationRequested;
            resolve();
            return;
          }
          token.onCancellationRequested(() => {
            cancelled = true;
            resolve();
          });
        })
    );

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);
      await stillRunning;

      assert.equal(
        cancelled,
        true,
        "the pre-existing operation for this task must be cancelled by the transition handler"
      );
      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(
        persisted?.currentStage,
        "plan",
        "the missing-artifact early return must still fire after cancellation — cancelling must not " +
          "itself advance the stage or skip the artifact check"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const sub of context.subscriptions) { sub.dispose(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("regression: cancels a running operation for the task before resolving configured review stages", async () => {
    // Reproduces the fixed bug: cancelRunningOperationsForTask used to run
    // AFTER resolveConfiguredReviewStages — a slow config/model-resolution
    // path left the previous stage's operation running during transition
    // preparation. This test observes whether the stray operation was
    // already cancelled by the time resolveConfiguredReviewStages is called,
    // which only holds if cancellation now runs strictly first.
    // Empty plan.md deliberately drives nextStage down the missing-artifact
    // early-return path (as the sibling ordering test above does), so this
    // test observes cancel-before-config-resolution without also exercising
    // the real review pipeline.
    const { folderPath, progress } = makeTaskFolder(`abort-order-cfg-${Math.floor(Math.random() * 1e9)}`, "plan");
    fs.writeFileSync(path.join(folderPath, "plan.md"), "", "utf8");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    let cancelledBeforeConfigResolution: boolean | undefined;
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () => {
        cancelledBeforeConfigResolution = cancelled;
        return Promise.resolve(new Set(REVIEW_STAGES));
      }),
    ];

    let cancelled = false;
    const stillRunning = runTrackedOperation(
      folderPath,
      { label: "Stub Long-Running", stage: "plan", kind: "review", cancellable: true },
      (handle) =>
        new Promise<void>((resolve) => {
          const token = handle.token;
          if (!token || token.isCancellationRequested) {
            cancelled = !!token?.isCancellationRequested;
            resolve();
            return;
          }
          token.onCancellationRequested(() => {
            cancelled = true;
            resolve();
          });
        })
    );

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);
      await stillRunning;

      assert.equal(
        cancelledBeforeConfigResolution,
        true,
        "the pre-existing operation for this task must already be cancelled by the time " +
          "resolveConfiguredReviewStages runs — cancellation must come first"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const sub of context.subscriptions) { sub.dispose(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("score-based auto-advance into another review dispatches Fast Forward when auto-advance mode requests it", async () => {
    const { folderPath } = makeTaskFolder(`auto-ff-review-${Math.floor(Math.random() * 1e9)}`, "plan-high-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto-fast-forward"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () => Promise.resolve(new Set(REVIEW_STAGES))),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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
        "plan-high-review",
        true
      );

      assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "plan-low-review");
      assert.equal(dispatches.length, 1, "auto-advance should dispatch the next review-stage action");
      assert.equal(
        dispatches[0]?.command,
        "vs-code-ai-helper.fastForwardReviewWithAI",
        "auto-advance mode auto-fast-forward must dispatch the Fast Forward loop"
      );
      assert.equal(dispatches[0]?.chainId, "auto-review");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("regression: score-based auto-advance into the next review stage is not silently dropped by its own not-yet-settled outer chain claim", async () => {
    // Reproduces the real production shape (unlike the mocked-dispatch test
    // above): the high-level review is itself dispatched under the shared
    // "auto-review" chainId via the REAL, un-mocked scheduleAutomationChain
    // — exactly what nextStage's Step 4 does — so its outer guard slot is
    // still held (the dispatch's own promise has not settled) while the
    // review, mid-execution, tries to auto-advance into plan-low-review and
    // dispatch ITS review under the same chainId. Before the fix, the
    // follow-up was always dropped here because claimChainGuard saw its own
    // not-yet-released predecessor as a duplicate.
    resetAutomationChainGuards();
    const { folderPath } = makeTaskFolder(`self-succession-${Math.floor(Math.random() * 1e9)}`, "plan-high-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
    const dispatchedCommands: string[] = [];
    const commandsApi = vscode.commands as unknown as {
      executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
    };
    const originalExecuteCommand = commandsApi.executeCommand;

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () => Promise.resolve(new Set(REVIEW_STAGES))),
      stubV1RunnerSelection([
        markdownTransportV1("Readiness: 9/10\n\n- Ready.\n"),
        markdownTransportV1("Readiness: 9/10\n\n- Ready.\n"),
      ]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      // scheduleAutomationChain and executeCommand are deliberately NOT
      // mocked: this test exercises the real duplicate-chain guard.
    ];
    commandsApi.executeCommand = ((command: string, ...args: unknown[]): Thenable<unknown> => {
      dispatchedCommands.push(command);
      if (command === "vs-code-ai-helper.runReviewWithAI") {
        // The real command registration isn't installed in this test; stand
        // in for it with the same production call shape runReviewWithAI
        // itself uses, so the follow-up review actually executes and can
        // itself be observed advancing the stage further if it also scores
        // above threshold.
        const arg = args[0] as { taskFolderPath: string } | undefined;
        return runTrackedOperation(
          arg?.taskFolderPath ?? folderPath,
          { label: "Review", stage: "plan-low-review", kind: "review", cancellable: true },
          (op) =>
            runReviewForFolder(
              vscode.Uri.file(REAL_ROOT),
              vscode.Uri.file(arg?.taskFolderPath ?? folderPath),
              workspaceRoot,
              "plan-low-review",
              true,
              { operation: op }
            )
        );
      }
      return originalExecuteCommand.call(commandsApi, command, ...args);
    }) as typeof commandsApi.executeCommand;

    try {
      // Mirrors nextStage's Step 4: dispatch the high-level review under the
      // shared "auto-review" chainId via the real scheduleAutomationChain,
      // immediate branch (no root operation — nothing holds the lock yet).
      const dispatched = await scheduleAutomationChain(
        {
          command: "vs-code-ai-helper.runReviewWithAI",
          arg: { taskFolderPath: folderPath },
          taskKey: folderPath,
          chainId: "auto-review",
        },
        undefined,
        {
          onDidEnd: () => ({ dispose(): void {} }),
          execute: (command) => {
            dispatchedCommands.push(command);
            return runTrackedOperation(
              folderPath,
              { label: "Review", stage: "plan-high-review", kind: "review", cancellable: true },
              (op) =>
                runReviewForFolder(
                  vscode.Uri.file(REAL_ROOT),
                  vscode.Uri.file(folderPath),
                  workspaceRoot,
                  "plan-high-review",
                  true,
                  { operation: op }
                )
            );
          },
        }
      );

      assert.equal(dispatched, true);
      assert.equal(
        (await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage,
        "plan-low-review",
        "the high-level review should have auto-advanced the stage"
      );
      assert.ok(
        dispatchedCommands.filter((c) => c === "vs-code-ai-helper.runReviewWithAI").length >= 1,
        "the follow-up review for plan-low-review must actually be dispatched, not silently dropped by its own predecessor's still-active guard slot"
      );
      // The plan-low-review follow-up above may itself pass and auto-advance
      // into "impl" through the same deferred, fire-and-forget dispatch path
      // — drain it (still under this test's own mocks/intercepts) before
      // tearing down, so a later test never observes its trailing effects.
      await waitForTaskOperationsIdle(folderPath);
    } finally {
      commandsApi.executeCommand = originalExecuteCommand;
      for (const p of patches.reverse()) { p.restore(); }
      resetAutomationChainGuards();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a passing plan review advances to Implementation and dispatches only when auto-implement is armed", async () => {
    resetAutomationChainGuards();
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () => Promise.resolve(new Set(REVIEW_STAGES))),
      // Each loop iteration below (armed: [false, true]) may drive more than
      // one provider call internally (e.g. a same-stage re-review round plus
      // routing/second-opinion work) before landing on Implementation — the
      // legacy `resolveRunnerForModel` stub this replaces served an unbounded
      // number of calls from one always-available runner, so this supplies
      // a generous, identical-content transport per possible call instead of
      // pinning an exact count unrelated to this test's actual assertions.
      stubV1RunnerSelection(
        Array.from({ length: 8 }, () => markdownTransportV1("Readiness: 9/10\n\n- Ready.\n"))
      ),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", (folder: vscode.Uri) =>
        Promise.resolve(vscode.Uri.file(path.join(folder.fsPath, "context-pack.md")))),
      patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
        dispatches.push(dispatch);
        return Promise.resolve(true);
      }),
    ];

    try {
      for (const armed of [false, true]) {
        dispatches.length = 0;
        patches.push(patch(settingsModule, "isAutoImplementAfterReviewEnabled", () => armed));
        const { folderPath } = makeTaskFolder(
          `auto-impl-${armed}-${++autoImplementationFolderCounter}`,
          "plan-low-review"
        );
        const contextPack = path.join(folderPath, "context-pack.md");
        fs.writeFileSync(contextPack, "# Context\n", "utf8");
        try {
          await runReviewForFolder(
            vscode.Uri.file(REAL_ROOT),
            vscode.Uri.file(folderPath),
            workspaceRoot,
            "plan-low-review",
            true
          );
          assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "impl");
          assert.equal(fs.existsSync(path.join(folderPath, "plan-final.md")), true, "auto-advance promotes the plan before implementation");
          assert.equal(dispatches.length, armed ? 1 : 0, "only an armed gate dispatches implementation");
          if (armed) {
            assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runImplementationWithAI");
          }
        } finally {
          patches.pop()?.restore();
        }
      }
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  function installModelSettingsOverride(raw: Record<string, unknown>): { restore: () => void } {
    const ws = vscode.workspace as unknown as { _configOverrides: Map<string, unknown> };
    const had = ws._configOverrides.has("modelSettings");
    const previous = ws._configOverrides.get("modelSettings");
    ws._configOverrides.set("modelSettings", raw);
    return {
      restore: (): void => {
        if (had) {
          ws._configOverrides.set("modelSettings", previous);
        } else {
          ws._configOverrides.delete("modelSettings");
        }
      },
    };
  }

  void it("score-based auto-advance runs plan-low-review via the real resolver when only the General Model is configured", async () => {
    // Does NOT stub resolveConfiguredReviewStages: auto-advance must inherit
    // the General Model for a blank optional review stage and actually land on it.
    const settings = installModelSettingsOverride({
      desc: { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" },
    });
    const { folderPath } = makeTaskFolder(`gm-plan-low-${Math.floor(Math.random() * 1e9)}`, "plan-high-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "general", modelId: "copilot-gpt-5.6-sol" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "general", modelId: "copilot-gpt-5.6-sol" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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
        "plan-high-review",
        true
      );

      assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "plan-low-review");
      assert.equal(dispatches.length, 1, "auto-advance should dispatch the inherited plan-low-review");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      settings.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("score-based auto-advance runs impl-low-review via the real resolver when only the General Model is configured", async () => {
    const settings = installModelSettingsOverride({
      desc: { primary: "copilot-gpt-5.6-sol", strategy: "alert-and-wait" },
    });
    const { folderPath } = makeTaskFolder(`gm-impl-low-${Math.floor(Math.random() * 1e9)}`, "impl-high-review");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "general", modelId: "copilot-gpt-5.6-sol" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "general", modelId: "copilot-gpt-5.6-sol" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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
        "impl-high-review",
        true
      );

      assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "impl-low-review");
      assert.equal(dispatches.length, 1, "auto-advance should dispatch the inherited impl-low-review");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      settings.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("score-based auto-advance skips plan-low-review only when neither its own chain nor the General Model is configured", async () => {
    // Sole remaining skip condition: blank optional review + no General Model.
    const settings = installModelSettingsOverride({});
    const { folderPath } = makeTaskFolder(`skip-plan-low-${Math.floor(Math.random() * 1e9)}`, "plan-high-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(settingsModule, "isAutoImplementAfterReviewEnabled", () => false),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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
        "plan-high-review",
        true
      );

      assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "impl");
      assert.equal(
        dispatches.some((dispatch) => dispatch.command === "vs-code-ai-helper.runReviewWithAI"),
        false,
        "unconfigured plan-low-review must not receive a review dispatch"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      settings.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("score-based auto-advance skips impl-low-review only when neither its own chain nor the General Model is configured", async () => {
    const settings = installModelSettingsOverride({});
    const { folderPath } = makeTaskFolder(`skip-impl-low-${Math.floor(Math.random() * 1e9)}`, "impl-high-review");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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
        "impl-high-review",
        true
      );

      assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "publish");
      // impl-low-review itself is entirely skipped (never becomes
      // currentStage, so it can never receive its own dispatch) — the single
      // dispatch observed here is landing directly on Publish, whose
      // follow-up review is unconditional in "auto" mode too (wf10 item 14 /
      // Part 7 step 17), not a dispatch mistakenly attributed to the skipped
      // stage.
      assert.equal(dispatches.length, 1, "exactly one dispatch: Publish's own follow-up review");
      assert.equal(dispatches[0]?.command, "vs-code-ai-helper.runReviewWithAI");
      assert.equal(dispatches[0]?.chainId, "auto-review");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      settings.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("wf10 item 14 / Part 7 step 17: auto-fast-forward landing on Publish dispatches the follow-up review with dispatchEvenIfRootFails set", async () => {
    // Publish is the terminal stage: once a review's own currentStage write
    // lands there, the follow-up Publish review it schedules must not be
    // gated on the SAME root operation's own eventual "succeeded" outcome —
    // that stage transition already committed to disk before this dispatch
    // is scheduled. Asserting `dispatchEvenIfRootFails: true` here is the
    // regression for that specific contract, not just that a dispatch
    // occurred at all (every sibling test above only checks the latter).
    const settings = installModelSettingsOverride({});
    const { folderPath } = makeTaskFolder(`ff-publish-${Math.floor(Math.random() * 1e9)}`, "impl-low-review");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const dispatches: AutomationDispatch[] = [];
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto-fast-forward"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ source: "settings", modelId: "stub:model" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
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
        "impl-low-review",
        true
      );

      assert.equal((await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage, "publish");
      const publishDispatch = dispatches.find((dispatch) => dispatch.chainId === "auto-review");
      assert.ok(publishDispatch, "the follow-up Publish review must be scheduled under the auto-review chain");
      assert.equal(publishDispatch?.command, "vs-code-ai-helper.fastForwardReviewWithAI");
      assert.equal(
        publishDispatch?.dispatchEvenIfRootFails,
        true,
        "Publish's follow-up review must fire regardless of how the triggering root operation itself concludes"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      settings.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
