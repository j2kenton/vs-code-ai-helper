/**
 * Completion blocker (pre-1.0.0 fixes register, Part 1, review-pass 18):
 * `handleGeneratePlanOutcomeV1` already reports `succeeded: false` and logs
 * the real reason when a completed `generatePlan.v1` outcome arrives for a
 * task whose stage is no longer at Description or Plan (see
 * `generatePlanOutcomeV1.test.ts`). But `generatePlanWithAIForResolvedTask`
 * — the body `generatePlanWithAI` hands to `runTrackedOperation` — used to
 * return that whole `GeneratePlanResult` object, which is truthy even when
 * `succeeded` is `false`. `runTrackedOperation` derives its terminal state
 * from a normal (non-throwing) return, so the Notifications row for this
 * operation still ended `succeeded` despite the refusal.
 *
 * This suite drives the real `generatePlanWithAI` command end to end (the
 * same harness `completeAndMoveOnFastForward.test.ts` uses: only the
 * provider/model-resolution boundary is faked) and observes the tracked
 * operation's terminal state via `taskOperations.onDidEnd`, so a regression
 * that reports "completed" for a refused generation fails a real assertion
 * rather than only a unit-level check of the outcome object.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { generatePlanWithAI } from "../commands/generatePlanWithAI";
import { taskOperations, TaskOperationSnapshot } from "../utils/taskOperations";
import { TaskInventory } from "../state/taskInventory";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { readTaskProgressForTest as readTaskProgress } from "./taskFolderFixture";
import { TaskProgress, TaskStage } from "../types/taskProgress";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
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
/* eslint-enable @typescript-eslint/no-var-requires */

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

function fakeCompletedCopilotTransportFactory(
  markdown: string
): () => { runnerId: string; invoke: (request: unknown, output: { write: (chunk: string) => boolean }) => Promise<{ kind: "completed" }> } {
  return () => ({
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

function setUpTaskActionRuntimeForTestV1(): { tearDown: () => void } {
  resetWorkflowRuntimeServicesForTestV1();
  resetProductionTaskActionRegistryForTestV1();
  const privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-genplan-outcome-private-"));
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

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-genplan-outcome-"));

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

void describe("generatePlanWithAI tracked-operation outcome (2026-09-22 review, review-pass 18 blocker)", () => {
  void it("ends the operation refused (never succeeded) when the stage-entry is refused, and succeeded when it moves the stage", async () => {
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const runtime = setUpTaskActionRuntimeForTestV1();
    const patches: Patched[] = [
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
      // ── Refused case: task is at "impl", outside ELIGIBLE_STAGES ["desc",
      // "plan"] — the coordinator still returns a completed outcome (plan.md
      // was generated), but the stage entry must be refused.
      const refused = makeTaskFolder("refused-stage", "impl");
      const refusedInventory = {
        getTaskById: (): undefined => undefined,
        getTaskByPath: (fsPath: string) => ({
          taskFolderPath: fsPath,
          workspaceFolder: vscode.Uri.file(REAL_ROOT),
          canonicalId: fsPath,
          progress: { status: "active", currentStage: "impl" },
        }),
        refresh: (): Promise<void> => Promise.resolve(),
      } as unknown as TaskInventory;

      const endedRefused: TaskOperationSnapshot[] = [];
      const subRefused = taskOperations.onDidEnd((snap) => {
        if (snap.key === refused.folderPath) { endedRefused.push(snap); }
      });
      try {
        const succeeded = await generatePlanWithAI(context, refusedInventory, fakeChatViewProviderV1, {
          taskFolderPath: refused.folderPath,
        });
        assert.equal(succeeded, undefined, "a refused stage entry must not report the command as succeeded");

        const persisted = await readTaskProgress(vscode.Uri.file(refused.folderPath));
        assert.equal(persisted?.currentStage, "impl", "the stage must not have moved");

        assert.equal(endedRefused.length, 1, "expected exactly one terminal Notifications row for this operation");
        assert.equal(
          endedRefused[0]?.state,
          "refused",
          "a refused stage entry must end the tracked operation as 'refused', never 'succeeded'"
        );
      } finally {
        subRefused.dispose();
      }

      // ── Succeeding case, same harness: task is at "plan" (eligible) — the
      // operation must still end 'succeeded' so this fix doesn't overcorrect
      // every generation into a refusal.
      const eligible = makeTaskFolder("eligible-stage", "plan");
      const eligibleInventory = {
        getTaskById: (): undefined => undefined,
        getTaskByPath: (fsPath: string) => ({
          taskFolderPath: fsPath,
          workspaceFolder: vscode.Uri.file(REAL_ROOT),
          canonicalId: fsPath,
          progress: { status: "active", currentStage: "plan" },
        }),
        refresh: (): Promise<void> => Promise.resolve(),
      } as unknown as TaskInventory;

      const endedEligible: TaskOperationSnapshot[] = [];
      const subEligible = taskOperations.onDidEnd((snap) => {
        if (snap.key === eligible.folderPath) { endedEligible.push(snap); }
      });
      try {
        const succeeded = await generatePlanWithAI(context, eligibleInventory, fakeChatViewProviderV1, {
          taskFolderPath: eligible.folderPath,
        });
        assert.equal(succeeded, true, "an eligible source stage must still report the command as succeeded");

        const persisted = await readTaskProgress(vscode.Uri.file(eligible.folderPath));
        assert.equal(persisted?.currentStage, "plan");

        assert.equal(endedEligible.length, 1);
        assert.equal(endedEligible[0]?.state, "succeeded");
      } finally {
        subEligible.dispose();
      }
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
