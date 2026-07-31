/**
 * "Complete & Move On triggers AI: auto-fast-forward" must carry the
 * fast-forward request through destinations that are not themselves reviews:
 *
 *   - Completing into Plan dispatches generatePlanWithAI with the chained
 *     followUpReviewMode marker; a successful plan generation then advances
 *     to Plan High-Level Review and dispatches the Fast Forward loop even
 *     when autoReviewAfterPlan is off.
 *   - Completing into Implementation dispatches runImplementationWithAI with
 *     the same marker (honored by executeImplementationRun's post-run review
 *     dispatch).
 *
 * The dispatch seam (scheduleAutomationChain) is recorded via the shared
 * CommonJS module object — the same monkey-patch technique as
 * nextStageAutoReviewCommandChain.test.ts — while the command layer, stage
 * transitions, and (for the plan test) the full generatePlanWithAI pipeline
 * run production code with only the provider boundary faked.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { registerReviewActionCommands } from "../commands/reviewActions";
import { generatePlanWithAI } from "../commands/generatePlanWithAI";
import { strongestAutoTriggerMode } from "../config/settings";
import { TaskInventory } from "../state/taskInventory";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { IncompleteTask } from "../types/incompleteTask";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import type { AutomationDispatch } from "../utils/automationChain";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  resetWorkflowRuntimeServicesForTestV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { resetProductionTaskActionRegistryForTestV1 } from "../actions/productionTaskActionRuntimeV1";
import type { ChatViewProvider } from "../views/chatView";

/**
 * Neither test in this file exercises the `questions` outcome (both fake a
 * completed provider response), so a Chat view is never actually needed —
 * this stub only exists to satisfy generatePlanWithAI's signature, and
 * throws loudly if a future change ever routes through it unexpectedly.
 */
const fakeChatViewProviderV1 = {
  askInteraction: (): Promise<void> => {
    throw new Error("unexpected askInteraction call in a completed-outcome test");
  },
} as unknown as ChatViewProvider;

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const copilotLmTransportModule = require("../runners/copilotLanguageModelRunner") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const promptSizeGuardModule = require("../utils/promptSizeGuard") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const fileUtilsModule = require("../utils/fileUtils") as Record<string, unknown>;
const automationChainModule = require("../utils/automationChain") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Fake the V1 broker's Copilot text transport (generatePlanWithAI.ts now
 * drives its provider call through the task action coordinator, not a
 * legacy AgentRunner) so a "generatePlanWithAI directly" test can prove a
 * completed markdown-artifact.v1 result reaches plan.md without a real
 * Copilot/CLI invocation. Echoes the request's own correlation, exactly like
 * production transports must (plan §3.1).
 */
function fakeCompletedCopilotTransportFactory(
  markdown: string
): () => { runnerId: string; invoke: (request: unknown, output: { write: (chunk: string) => boolean }) => Promise<{ kind: "completed" }> } {
  return () => ({
    // Must match the reservation's runnerId for the real "copilot" candidate
    // (openV1RunnerSelection's toRankedEntry hardcodes "copilot-lm") — the
    // broker rejects a transport whose runnerId differs from its claimed
    // reservation's (agentExecutionBrokerV1.ts's prepareAgentInvocationV1).
    runnerId: "copilot-lm",
    invoke: (
      request: unknown,
      output: { write: (chunk: string) => boolean }
    ): Promise<{ kind: "completed" }> => {
      const correlation = (request as { correlation: unknown }).correlation;
      const envelope = {
        version: 1,
        correlation,
        kind: "completed",
        content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
      };
      output.write(`<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(envelope)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`);
      return Promise.resolve({ kind: "completed" });
    },
  });
}

/**
 * Set up the shared workflow-runtime singletons (path registry, file store,
 * lease store, Chat interaction transaction store) a real coordinator
 * invocation needs, backed by a throwaway private-storage directory. Returns
 * a teardown function that restores the pristine, unconfigured state.
 */
function setUpTaskActionRuntimeForTestV1(): { tearDown: () => void } {
  resetWorkflowRuntimeServicesForTestV1();
  resetProductionTaskActionRegistryForTestV1();
  const privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-chain-private-"));
  const privateRootId = configureWorkflowPrivateStorageRootV1(privateStorageDir);
  setChatInteractionTransactionStoreV1(
    createChatInteractionTransactionStoreV1({
      registry: getWorkflowPathRegistryV1(),
      fileStore: getWorkflowFileStoreV1(),
      privateRootId,
    })
  );
  return {
    tearDown: (): void => {
      resetWorkflowRuntimeServicesForTestV1();
      resetProductionTaskActionRegistryForTestV1();
    },
  };
}

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-chain-"));

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

/** Record every automation-chain dispatch instead of executing it. */
function recordDispatches(): { dispatches: AutomationDispatch[]; patched: Patched } {
  const dispatches: AutomationDispatch[] = [];
  const patched = patch(
    automationChainModule,
    "scheduleAutomationChain",
    (dispatch: AutomationDispatch): Promise<boolean> => {
      dispatches.push(dispatch);
      return Promise.resolve(true);
    }
  );
  return { dispatches, patched };
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

interface ChainedArg { taskFolderPath?: string; followUpReviewMode?: string }

void describe("Complete & Move On auto-fast-forward chaining", () => {
  void it("strongestAutoTriggerMode keeps the stronger of two modes", () => {
    assert.equal(strongestAutoTriggerMode("off", undefined), "off");
    assert.equal(strongestAutoTriggerMode("off", "auto-fast-forward"), "auto-fast-forward");
    assert.equal(strongestAutoTriggerMode("auto", "auto-fast-forward"), "auto-fast-forward");
    assert.equal(strongestAutoTriggerMode("auto-fast-forward", undefined), "auto-fast-forward");
    // A weaker chained request must never downgrade a stronger setting.
    assert.equal(strongestAutoTriggerMode("auto-fast-forward", "auto"), "auto-fast-forward");
    assert.equal(strongestAutoTriggerMode("auto", undefined), "auto");
  });

  void it("completing Description into Plan carries the fast-forward marker on the generatePlanWithAI dispatch", async () => {
    const { folderPath, progress } = makeTaskFolder(`ff_desc_${Math.floor(Math.random() * 1e9)}`, "desc");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const { dispatches, patched: dispatchSeam } = recordDispatches();

    const patches: Patched[] = [
      dispatchSeam,
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => true),
      patch(settingsModule, "getCompleteAndMoveOnTriggersAIMode", () => "auto-fast-forward"),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);

      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "plan");
      assert.equal(dispatches.length, 1, "exactly one destination-stage AI dispatch");
      const dispatched = dispatches[0];
      assert.ok(dispatched);
      assert.equal(dispatched.command, "vs-code-ai-helper.generatePlanWithAI");
      const arg = dispatched.arg as ChainedArg;
      assert.equal(arg.taskFolderPath, folderPath);
      assert.equal(
        arg.followUpReviewMode,
        "auto-fast-forward",
        "the chained fast-forward request rides on the dispatched command's arg"
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

  void it("completing Plan Low-Level Review into Implementation dispatches regardless of the auto-implement review gate", async () => {
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const { dispatches, patched: dispatchSeam } = recordDispatches();

    const patches: Patched[] = [
      dispatchSeam,
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => true),
      patch(settingsModule, "getCompleteAndMoveOnTriggersAIMode", () => "auto-fast-forward"),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      for (const armed of [false, true]) {
        const { folderPath, progress } = makeTaskFolder(
          `ff_impl_${armed ? "armed" : "off"}`,
          "plan-low-review"
        );
        const buttonArg = makeButtonPressArg(folderPath, progress);
        const gateSeam = patch(settingsModule, "isAutoImplementAfterReviewEnabled", () => armed);
        dispatches.length = 0;
        try {
          await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);

          const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
          assert.equal(persisted?.currentStage, "impl");
          assert.equal(
            dispatches.length,
            1,
            "manual Complete & Move On dispatches independently of the review auto-implement gate"
          );
          const dispatched = dispatches[0];
          assert.ok(dispatched);
          assert.equal(dispatched.command, "vs-code-ai-helper.runImplementationWithAI");
          assert.equal((dispatched.arg as ChainedArg).followUpReviewMode, "auto-fast-forward");
        } finally {
          gateSeam.restore();
        }
      }
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const sub of context.subscriptions) { sub.dispose(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("completing Plan directly into review dispatches the Fast Forward loop in auto-fast-forward mode", async () => {
    const { folderPath, progress } = makeTaskFolder(`ff_plan_review_${Math.floor(Math.random() * 1e9)}`, "plan");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const { dispatches, patched: dispatchSeam } = recordDispatches();

    const patches: Patched[] = [
      dispatchSeam,
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => true),
      patch(settingsModule, "getCompleteAndMoveOnTriggersAIMode", () => "auto-fast-forward"),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);

      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "plan-high-review");
      assert.equal(dispatches.length, 1, "exactly one follow-up review dispatch");
      const dispatched = dispatches[0];
      assert.ok(dispatched);
      assert.equal(
        dispatched.command,
        "vs-code-ai-helper.fastForwardReviewWithAI",
        "direct review-stage completion must honor auto-fast-forward mode"
      );
      assert.equal(dispatched.chainId, "auto-review");
      assert.equal((dispatched.arg as ChainedArg).taskFolderPath, folderPath);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const sub of context.subscriptions) { sub.dispose(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("plain 'auto' mode does NOT attach the fast-forward marker", async () => {
    const { folderPath, progress } = makeTaskFolder(`auto_desc_${Math.floor(Math.random() * 1e9)}`, "desc");
    const buttonArg = makeButtonPressArg(folderPath, progress);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const { dispatches, patched: dispatchSeam } = recordDispatches();

    const patches: Patched[] = [
      dispatchSeam,
      patch(settingsModule, "completeAndMoveOnTriggersAI", () => true),
      patch(settingsModule, "getCompleteAndMoveOnTriggersAIMode", () => "auto"),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", buttonArg);

      assert.equal(dispatches.length, 1);
      const dispatched = dispatches[0];
      assert.ok(dispatched);
      assert.equal(dispatched.command, "vs-code-ai-helper.generatePlanWithAI");
      assert.equal(
        (dispatched.arg as ChainedArg).followUpReviewMode,
        undefined,
        "plain 'auto' must not request the fast-forward loop"
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

  void it("generatePlanWithAI with the chained marker and autoReviewAfterPlan off advances to Plan High-Level Review and dispatches the Fast Forward loop", async () => {
    const { folderPath } = makeTaskFolder(`plan_ff_${Math.floor(Math.random() * 1e9)}`, "desc");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const { dispatches, patched: dispatchSeam } = recordDispatches();

    const inventory = {
      getTaskById: (): undefined => undefined,
      getTaskByPath: (
        fsPath: string
      ): { taskFolderPath: string; workspaceFolder: vscode.Uri; canonicalId: string; progress: { status: string; currentStage: string } } => ({
        taskFolderPath: fsPath,
        workspaceFolder: vscode.Uri.file(REAL_ROOT),
        canonicalId: fsPath,
        progress: { status: "active", currentStage: "desc" },
      }),
      refresh: (): Promise<void> => Promise.resolve(),
    } as unknown as TaskInventory;

    const runtime = setUpTaskActionRuntimeForTestV1();
    const patches: Patched[] = [
      dispatchSeam,
      // The standalone setting is OFF — only the chained request may fire.
      patch(settingsModule, "getAutoReviewAfterPlanMode", () => "off"),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
        Promise.resolve({ availability: { available: true }, providerLabel: "Stub Provider" })),
      patch(
        copilotLmTransportModule,
        "createCopilotLmTextTransportV1",
        fakeCompletedCopilotTransportFactory("# Plan\n\n1. Generated.\n")
      ),
      patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context Pack (stub)\n")),
      patch(contextPackModule, "writeContextPackContent", () => Promise.resolve(undefined)),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(fileUtilsModule, "safeOpenTextDocument", () => Promise.resolve(undefined)),
    ];

    const context = makeExtensionContext();

    try {
      const succeeded = await generatePlanWithAI(context, inventory, fakeChatViewProviderV1, {
        taskFolderPath: folderPath,
        followUpReviewMode: "auto-fast-forward",
      });
      assert.equal(succeeded, true, "plan generation completed");

      // The chained fast-forward request advanced the task onto the review
      // stage even though autoReviewAfterPlan is off...
      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "plan-high-review");

      // ...and dispatched the Fast Forward loop, not a single review pass.
      assert.equal(dispatches.length, 1, "exactly one follow-up review dispatch");
      const dispatched = dispatches[0];
      assert.ok(dispatched);
      assert.equal(dispatched.command, "vs-code-ai-helper.fastForwardReviewWithAI");
      assert.equal(dispatched.chainId, "auto-review");
      assert.equal((dispatched.arg as ChainedArg).taskFolderPath, folderPath);
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      runtime.tearDown();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("generatePlanWithAI without the marker and autoReviewAfterPlan off stays at Plan with no review dispatch", async () => {
    const { folderPath } = makeTaskFolder(`plan_off_${Math.floor(Math.random() * 1e9)}`, "desc");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const { dispatches, patched: dispatchSeam } = recordDispatches();

    const inventory = {
      getTaskById: (): undefined => undefined,
      getTaskByPath: (
        fsPath: string
      ): { taskFolderPath: string; workspaceFolder: vscode.Uri; canonicalId: string; progress: { status: string; currentStage: string } } => ({
        taskFolderPath: fsPath,
        workspaceFolder: vscode.Uri.file(REAL_ROOT),
        canonicalId: fsPath,
        progress: { status: "active", currentStage: "desc" },
      }),
      refresh: (): Promise<void> => Promise.resolve(),
    } as unknown as TaskInventory;

    const runtime = setUpTaskActionRuntimeForTestV1();
    const patches: Patched[] = [
      dispatchSeam,
      patch(settingsModule, "getAutoReviewAfterPlanMode", () => "off"),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
        Promise.resolve({ availability: { available: true }, providerLabel: "Stub Provider" })),
      patch(
        copilotLmTransportModule,
        "createCopilotLmTextTransportV1",
        fakeCompletedCopilotTransportFactory("# Plan\n\n1. Generated.\n")
      ),
      patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context Pack (stub)\n")),
      patch(contextPackModule, "writeContextPackContent", () => Promise.resolve(undefined)),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(fileUtilsModule, "safeOpenTextDocument", () => Promise.resolve(undefined)),
    ];

    const context = makeExtensionContext();

    try {
      const succeeded = await generatePlanWithAI(context, inventory, fakeChatViewProviderV1, {
        taskFolderPath: folderPath,
      });
      assert.equal(succeeded, true, "plan generation completed");

      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "plan", "no chained request → no review-stage advance");
      assert.equal(dispatches.length, 0, "no follow-up review dispatched");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      runtime.tearDown();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
