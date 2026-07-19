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
import { readTaskProgress, IncompleteTask } from "../utils/taskProgressUtils";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentRunRequest, AgentRunResult } from "../types/agentRunner";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import type { AutomationDispatch } from "../utils/automationChain";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const promptSizeGuardModule = require("../utils/promptSizeGuard") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const fileUtilsModule = require("../utils/fileUtils") as Record<string, unknown>;
const automationChainModule = require("../utils/automationChain") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

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

    const fakeRunner = {
      id: "stub-runner",
      label: "Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "# Plan\n\n1. Generated.\n", "utf8");
        return { runnerId: "stub-runner", status: "completed", summary: "stub run" };
      },
    };

    const inventory = {
      getTaskById: (): undefined => undefined,
      getTaskByPath: (fsPath: string): { taskFolderPath: string; workspaceFolder: vscode.Uri } => ({
        taskFolderPath: fsPath,
        workspaceFolder: vscode.Uri.file(REAL_ROOT),
      }),
      refresh: (): Promise<void> => Promise.resolve(),
    } as unknown as TaskInventory;

    const patches: Patched[] = [
      dispatchSeam,
      // The standalone setting is OFF — only the chained request may fire.
      patch(settingsModule, "getAutoReviewAfterPlanMode", () => "off"),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
        runner: fakeRunner,
        provider: "copilot",
        providerLabel: "Stub Provider",
        nativeModelId: undefined,
      })),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
        Promise.resolve({ availability: { available: true }, providerLabel: "Stub Provider" })),
      patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context Pack (stub)\n")),
      patch(contextPackModule, "writeContextPackContent", () => Promise.resolve(undefined)),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(fileUtilsModule, "safeOpenTextDocument", () => Promise.resolve(undefined)),
    ];

    const context = makeExtensionContext();

    try {
      const succeeded = await generatePlanWithAI(context, inventory, {
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

    const fakeRunner = {
      id: "stub-runner",
      label: "Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        await fs.promises.writeFile(request.outputFile.fsPath, "# Plan\n\n1. Generated.\n", "utf8");
        return { runnerId: "stub-runner", status: "completed", summary: "stub run" };
      },
    };

    const inventory = {
      getTaskById: (): undefined => undefined,
      getTaskByPath: (fsPath: string): { taskFolderPath: string; workspaceFolder: vscode.Uri } => ({
        taskFolderPath: fsPath,
        workspaceFolder: vscode.Uri.file(REAL_ROOT),
      }),
      refresh: (): Promise<void> => Promise.resolve(),
    } as unknown as TaskInventory;

    const patches: Patched[] = [
      dispatchSeam,
      patch(settingsModule, "getAutoReviewAfterPlanMode", () => "off"),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })),
      patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
        runner: fakeRunner,
        provider: "copilot",
        providerLabel: "Stub Provider",
        nativeModelId: undefined,
      })),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
        Promise.resolve({ availability: { available: true }, providerLabel: "Stub Provider" })),
      patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context Pack (stub)\n")),
      patch(contextPackModule, "writeContextPackContent", () => Promise.resolve(undefined)),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(fileUtilsModule, "safeOpenTextDocument", () => Promise.resolve(undefined)),
    ];

    const context = makeExtensionContext();

    try {
      const succeeded = await generatePlanWithAI(context, inventory, {
        taskFolderPath: folderPath,
      });
      assert.equal(succeeded, true, "plan generation completed");

      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.currentStage, "plan", "no chained request → no review-stage advance");
      assert.equal(dispatches.length, 0, "no follow-up review dispatched");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
