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

import { registerReviewActionCommands } from "../commands/reviewActions";
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
import { readTaskProgress, IncompleteTask } from "../utils/taskProgressUtils";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentRunRequest, AgentRunResult } from "../types/agentRunner";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";

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
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-cmd-chain-"));

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
    // auto-started review operation is running.
    const midRun: {
      reviewRows?: StatusOperationNode[];
      stageSpinnerIconId?: string;
      outputFile?: string;
    } = {};

    const fakeRunner = {
      id: "stub-runner",
      label: "Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        midRun.reviewRows = operationNodes(provider).filter((n) => n.label === "Review");
        const stageRow = new StageNode(buttonArg.task, "plan-high-review", "current", undefined);
        midRun.stageSpinnerIconId =
          stageRow.iconPath instanceof vscode.ThemeIcon ? stageRow.iconPath.id : "";
        midRun.outputFile = request.outputFile.fsPath;
        await fs.promises.writeFile(request.outputFile.fsPath, FAKE_REVIEW, "utf8");
        return { runnerId: "stub-runner", status: "completed", summary: "stub run" };
      },
    };

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
      patch(runnerRegistryModule, "resolveRunnerForModel", () => ({
        runner: fakeRunner,
        provider: "copilot",
        providerLabel: "Stub Provider",
        nativeModelId: undefined,
      })),
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
      assert.ok(
        midRun.outputFile?.includes("plan-high-review.md"),
        "the provider was pointed at the staged review artifact"
      );

      // 3. The review artifact was published with EXACTLY the validated
      //    provider output (staging tmp → CAS → rename, the production path).
      const artifact = fs.readFileSync(path.join(folderPath, "plan-high-review.md"), "utf8");
      assert.equal(artifact, FAKE_REVIEW, "published artifact content matches the provider output exactly");

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
});
