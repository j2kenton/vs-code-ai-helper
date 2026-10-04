/**
 * RC8 item 5, call-site coverage: the inline re-review inside Apply Review
 * (`applyReviewWithAI`, plan reviews) and Apply Review Edit
 * (`applyReviewEditWithAI`, code reviews) runs as a CHILD of the enclosing
 * Fast Forward root. When it crosses the auto-advance threshold, the next
 * stage's Fast Forward run must be dispatched exactly once, only after the
 * true root ends, and never refused as "already in progress".
 *
 * Real `taskOperations` and real `scheduleAutomationChain`; the only seam on
 * dispatch is `vscode.commands._executeCommandOverride`.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { applyReviewEditWithAI, applyReviewWithAI, registerReviewActionCommands } from "../commands/reviewActions";
import {
  __setAutomationChainGuardForTestV1,
  isAutomationChainActive,
  resetAutomationChainGuards,
} from "../utils/automationChain";
import { taskOperations, TaskOperationHandle } from "../utils/taskOperations";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import type { TaskStage } from "../types/taskProgress";
import { REVIEW_STAGES } from "../types/taskProgress";
import { readTaskProgressForTest as readTaskProgress } from "./taskFolderFixture";
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

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-callsites-rc8-"));
// The code-review round's pre-run safety check walks up from cwd to a repo.
execFileSync("git", ["init", "--quiet"], { cwd: REAL_ROOT });
fs.writeFileSync(
  path.join(REAL_ROOT, "package.json"),
  JSON.stringify(
    {
      name: "ff-callsites-fixture",
      scripts: {
        lint: 'node -e "process.exit(0)"',
        "check-types": 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    },
    null,
    2
  ),
  "utf8"
);

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-callsites-rc8-private-"));
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

function makeTaskFolder(name: string, stage: TaskStage): string {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress = {
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
  fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Implementation Notes\n\nDid the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, `${stage}.md`), "Readiness: 6/10\n\n- Needs work.\n", "utf8");
  return folderPath;
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function markdownTransportV1(markdown: string): AgentTransportV1 {
  return {
    runnerId: "stub-runner",
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
  const preflightPatch = patch(runnerRegistryModule, "preflightStageChainAvailabilityV1", () =>
    Promise.resolve({ kind: "dispatchable" })
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
  target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.delete = (uri: vscode.Uri): Promise<void> => fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
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

function basePatches(): Patched[] {
  fs.writeFileSync(path.join(REAL_ROOT, "context-pack.md"), "# Context\n");
  return [
    patch(settingsModule, "isAutoAdvanceEnabled", () => true),
    patch(settingsModule, "getAutoAdvanceMode", () => "auto-fast-forward"),
    patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
    patch(settingsModule, "allowsDirtyWorktreeChanges", () => true),
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveConfiguredReviewStages", () => Promise.resolve(new Set(REVIEW_STAGES))),
    patch(modelSelectionModule, "resolveEffectiveStageChainV1", () => ({
      originStage: "impl",
      source: "stage",
      primary: "claude-cli:sonnet@high",
      backups: [],
    })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context\n")),
    patch(contextPackModule, "writeContextPack", () =>
      Promise.resolve(vscode.Uri.file(path.join(REAL_ROOT, "context-pack.md")))),
    patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
      Promise.resolve({
        availability: { available: true },
        providerLabel: "Claude Code",
        provider: "claude-cli",
        modelId: "claude-cli:sonnet@high",
        nativeModelId: "sonnet",
      })),
    patch(runnerRegistryModule, "runImplementationForModel", () =>
      Promise.resolve({
        status: "completed",
        filesChanged: ["src/a.ts"],
        summary: "round ran",
        summaryIsSynthetic: true,
        runnerId: "claude-cli",
        actualProviderLabel: "Claude Code",
        actualStoredModelId: "claude-cli:sonnet@high",
      })),
  ];
}

const FOLLOW_UP = "vs-code-ai-helper.fastForwardReviewWithAI";

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runCase(options: {
  name: string;
  from: TaskStage;
  to: TaskStage;
  preHeldSlot: boolean;
  apply: (context: vscode.ExtensionContext, folderPath: string, root: TaskOperationHandle) => Promise<unknown>;
}): Promise<void> {
  resetAutomationChainGuards();
  const folderPath = makeTaskFolder(`${options.name}-${Math.floor(Math.random() * 1e9)}`, options.from);
  const provider = new StatusTreeProvider();
  initNotificationRouter(provider);
  const fsBridge = installFsBridge();
  const wsStub = installWorkspaceFoldersStub();
  const patches: Patched[] = [
    ...basePatches(),
    stubV1RunnerSelection([
      markdownTransportV1("# Plan\n\n1. Do the thing (revised).\n"),
      ...Array.from({ length: 6 }, () => markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")),
    ]),
  ];
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const origOverride = commandsObj._executeCommandOverride;
  const dispatched: string[] = [];
  commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
    dispatched.push(id);
    return Promise.resolve(true);
  };
  const context = makeExtensionContext();
  registerReviewActionCommands(context);
  if (options.preHeldSlot) {
    // Fast Forward started by automation: the run itself holds the slot.
    __setAutomationChainGuardForTestV1(folderPath, "auto-review", Date.now() + 60_000);
  }
  const root = taskOperations.begin(folderPath, {
    label: "Fast Forward Review",
    stage: options.from,
    kind: "fast-forward",
    cancellable: true,
  });
  assert.ok(root, "test setup: the exclusive root operation must register");
  try {
    await options.apply(context, folderPath, root);
    assert.equal(
      (await readTaskProgress(vscode.Uri.file(folderPath)))?.currentStage,
      options.to,
      "auto-advance persisted the stage transition"
    );
    assert.deepEqual(
      dispatched.filter((id) => id === FOLLOW_UP),
      [],
      "nothing is dispatched while the Fast Forward root still holds the lock"
    );
    assert.equal(isAutomationChainActive(folderPath, "auto-review"), true, "the follow-up waits on the root");

    taskOperations.end(root);
    await waitUntil(() => dispatched.includes(FOLLOW_UP));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dispatched.filter((id) => id === FOLLOW_UP).length, 1, "exactly one Fast Forward run takes the new stage");
    const warnings = (provider.getEntries?.() ?? []).map((e: { message: string }) => e.message);
    assert.ok(
      !warnings.some((m) => /did not start|already in progress/.test(m)),
      `no busy or did-not-start warning, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    commandsObj._executeCommandOverride = origOverride;
    for (const p of patches.reverse()) { p.restore(); }
    for (const sub of context.subscriptions) { sub.dispose(); }
    wsStub.restore();
    fsBridge.restore();
    provider.dispose();
    deactivateNotificationRouter();
  }
}

void describe("RC8 item 5: re-review call sites hand over to exactly one Fast Forward run", () => {
  for (const preHeldSlot of [false, true]) {
    const suffix = preHeldSlot ? "with the run's own auto-review slot held" : "with no slot held";

    void it(`applyReviewWithAI (plan reviews) ${suffix}`, async () => {
      await runCase({
        name: `ff-plan-${preHeldSlot}`,
        from: "plan-high-review",
        to: "plan-low-review",
        preHeldSlot,
        apply: (context, folderPath, root) =>
          applyReviewWithAI(vscode.Uri.file(REAL_ROOT), context, { taskFolderPath: folderPath }, { parentOperation: root }),
      });
    });

    void it(`applyReviewEditWithAI (code reviews) ${suffix}`, async () => {
      await runCase({
        name: `ff-code-${preHeldSlot}`,
        from: "impl-high-review",
        to: "impl-low-review",
        preHeldSlot,
        apply: (context, folderPath, root) =>
          applyReviewEditWithAI(vscode.Uri.file(REAL_ROOT), context, { taskFolderPath: folderPath }, { parentOperation: root }),
      });
    });
  }
});
