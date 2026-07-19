/**
 * Regression test for a real bug: applyReviewWithAI's inline re-review step
 * (used by both "Apply Review" and Fast Forward Review) crosses the
 * auto-advance score threshold and hands off to runReviewForFolder's
 * auto-advance tail, which dispatches the next stage's review via
 * scheduleAutomationChain(dispatch, options.operation) — deferred until
 * `options.operation` ends, specifically so it never races the exclusive
 * lock a still-running caller holds.
 *
 * The bug: the re-review call sites passed `operation: reReviewOp` — the
 * re-review's own short-lived CHILD operation — instead of the enclosing
 * `op`, which is the actual exclusive-lock-holding root (Apply Review's own
 * root, or — under Fast Forward — its whole multi-attempt loop). Children
 * end almost immediately; the true root can keep running far longer (Fast
 * Forward's remaining attempts). So the deferred dispatch fired while the
 * root still held the task's exclusive lock, the follow-up command's own
 * runTrackedOperation call was refused as busy, and the next stage's review
 * (or implementation start) silently never ran — see reviewActions.ts
 * (the two "Re-running review" runTrackedOperation call sites inside
 * applyReviewWithAI's runApply).
 *
 * This test drives the REAL taskOperations registry and REAL
 * scheduleAutomationChain (neither is mocked) so the actual lock-contention
 * timing is exercised — not just which command names would be dispatched,
 * which is all the other auto-review-chain tests assert (they replace
 * scheduleAutomationChain with a recorder, which is exactly why this bug
 * shipped unnoticed).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { applyReviewWithAI, registerReviewActionCommands } from "../commands/reviewActions";
import { taskOperations } from "../utils/taskOperations";
import { isAutomationChainActive, resetAutomationChainGuards } from "../utils/automationChain";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentRunRequest, AgentRunResult } from "../types/agentRunner";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-nested-lock-"));

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
  fs.writeFileSync(path.join(folderPath, "plan-high-review.md"), "Readiness: 6/10\n\n- Needs work.\n", "utf8");
  return { folderPath, progress };
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

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void describe("applyReviewWithAI re-review auto-advance dispatch (real operation-lock timing)", () => {
  void it("defers the follow-up review dispatch until the true root operation ends, instead of racing it as busy", async () => {
    resetAutomationChainGuards();
    const { folderPath } = makeTaskFolder(`nested-lock-${Math.floor(Math.random() * 1e9)}`, "plan-high-review");
    const taskFolderUri = vscode.Uri.file(folderPath);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const fakeRunner = {
      id: "stub-runner",
      label: "Stub Provider",
      capabilities: { planning: true, review: true, assistant: false },
      isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
      run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const target = request.outputFile.fsPath;
        const content = target.endsWith("plan.md")
          ? "# Plan\n\n1. Do the thing (revised).\n"
          : "Readiness: 9/10\n\n- Ready.\n";
        await fs.promises.writeFile(target, content, "utf8");
        return { runnerId: "stub-runner", status: "completed" };
      },
    };

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
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
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    ];

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    // Simulate a still-running composite (e.g. Fast Forward Review's root
    // operation) that holds this task's exclusive lock while the inline
    // re-review runs underneath it as a child.
    const rootOp = taskOperations.begin(folderPath, {
      label: "Fast Forward Review",
      stage: "plan-high-review",
      kind: "fast-forward",
      cancellable: true,
    });
    assert.ok(rootOp, "test setup: the exclusive root operation must register");

    try {
      await applyReviewWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath },
        { parentOperation: rootOp }
      );

      // The re-review crossed the auto-advance threshold and the stage
      // transition persisted...
      assert.equal(
        (await readTaskProgress(taskFolderUri))?.currentStage,
        "plan-low-review",
        "auto-advance persisted the stage transition"
      );
      // ...but the follow-up review dispatch must still be PENDING at this
      // point, not already resolved. Under the bug, the dispatch was
      // anchored to the re-review's own child operation, which had already
      // ended by the time applyReviewWithAI returned — so it had already
      // fired and been refused as busy (indistinguishable from "never
      // dispatched" by the assertions below alone, which is exactly why
      // this check matters).
      assert.equal(
        isAutomationChainActive(folderPath, "auto-review"),
        true,
        "the follow-up review dispatch must still be pending, deferred on the true root operation"
      );
      assert.equal(
        fs.existsSync(path.join(folderPath, "plan-low-review.md")),
        false,
        "the follow-up review must not have run yet — the root operation hasn't ended"
      );

      // Now end the true root operation, exactly as Fast Forward would once
      // its own multi-attempt loop actually finishes. This must unblock the
      // deferred dispatch.
      taskOperations.end(rootOp);

      await waitUntil(() => !isAutomationChainActive(folderPath, "auto-review"));

      assert.equal(
        fs.existsSync(path.join(folderPath, "plan-low-review.md")),
        true,
        "the follow-up review ran once the true root operation ended"
      );
      assert.equal(
        fs.readFileSync(path.join(folderPath, "plan-low-review.md"), "utf8"),
        "Readiness: 9/10\n\n- Ready.\n"
      );

      const busyWarning = (provider.getEntries?.() ?? []).find((e: { message: string }) =>
        e.message.includes("is already in progress for this task")
      );
      assert.equal(busyWarning, undefined, "the follow-up dispatch must never be refused as busy");
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
