/**
 * Coverage for Part 3 (AI task renaming) of the provider-discard/review-
 * status/AI-rename/task-refresh plan: the reported regression was that
 * "Rename Task with AI" silently returned the task description's opening
 * words instead of a genuine AI-generated summary.
 *
 *  - validateAiNameReply / isLeadingSubstringOfDescription (pure): the
 *    unified 6-8 word validator, including the leading-substring guard that
 *    specifically catches the reported failure mode.
 *  - renameTaskWithAI (command-level, real coordinator + fake transport,
 *    mirroring draftTaskWithAICommand.test.ts's pattern): the single
 *    bounded re-prompt budget — at most two provider calls total, covering
 *    every failure combination — and that a task which never produces a
 *    valid summary keeps its existing name rather than falling back to a
 *    deterministic derivation.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  isLeadingSubstringOfDescription,
  normalizeAiNameReply,
  renameTaskWithAI,
  validateAiNameReply,
} from "../commands/renameTask";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { readTaskProgressForTest as readTaskProgress } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { safeRemoveDir } from "./testFsUtils";
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

void describe("validateAiNameReply / isLeadingSubstringOfDescription (pure)", () => {
  const description =
    "Add a discard changes control to the provider settings section identical to the one for models.";

  void it("accepts a genuine 6-8 word summary", () => {
    const result = validateAiNameReply("Add provider settings discard changes control", description);
    assert.deepStrictEqual(result, { ok: true, name: "Add provider settings discard changes control" });
  });

  void it("rejects fewer than 6 words as too-short", () => {
    const result = validateAiNameReply("Add discard control", description);
    assert.deepStrictEqual(result, { ok: false, reason: "too-short" });
  });

  void it("rejects more than 8 words as too-long", () => {
    const result = validateAiNameReply(
      "Add a brand new discard changes control to provider settings section",
      description
    );
    assert.deepStrictEqual(result, { ok: false, reason: "too-long" });
  });

  void it("rejects a reply that is just the description's opening words restated — the reported regression", () => {
    // Exactly the first 7 words of `description`, restated verbatim.
    const leadingWords = "Add a discard changes control to the";
    const result = validateAiNameReply(leadingWords, description);
    assert.deepStrictEqual(result, { ok: false, reason: "leading-substring" });
  });

  void it("isLeadingSubstringOfDescription tolerates markdown/case/whitespace differences", () => {
    assert.ok(
      isLeadingSubstringOfDescription("ADD A discard   changes control to the", description)
    );
    assert.ok(!isLeadingSubstringOfDescription("Provider settings discard control added here", description));
  });

  void it("normalizeAiNameReply strips quotes, markdown emphasis, and a trailing period from a single reply line", () => {
    assert.strictEqual(
      normalizeAiNameReply('"*Add provider settings discard control.*"\n\nExtra line'),
      "Add provider settings discard control"
    );
  });
});

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const copilotLmTransportModule = require("../runners/copilotLanguageModelRunner") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-rename-ai-cmd-"));

interface Patched { restore: () => void }
function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

/**
 * Fake the V1 broker's Copilot text transport with a queue of reply strings
 * — one per provider call — so a test can drive the too-long/too-short/
 * leading-substring retry path deterministically. Mirrors
 * draftTaskWithAICommand.test.ts's fake transport, adapted to
 * renameTask.v1's `chat-message.v1` completed-content type.
 */
function fakeChatMessageTransportFactory(
  replies: string[],
  onCreate: () => void
): (options: { model?: string }) => {
  runnerId: string;
  invoke: (request: unknown, output: { write: (chunk: string) => boolean }) => Promise<{ kind: "completed" }>;
} {
  let callIndex = 0;
  return () => {
    onCreate();
    return {
      runnerId: "copilot-lm",
      invoke: (
        request: unknown,
        output: { write: (chunk: string) => boolean }
      ): Promise<{ kind: "completed" }> => {
        const text = replies[Math.min(callIndex, replies.length - 1)];
        callIndex += 1;
        const correlation = (request as { correlation: unknown }).correlation;
        const envelope = {
          version: 1,
          correlation,
          kind: "completed",
          content: { contentType: "chat-message.v1", schemaVersion: 1, text },
        };
        output.write(`<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(envelope)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`);
        return Promise.resolve({ kind: "completed" });
      },
    };
  };
}

function setUpTaskActionRuntimeForTestV1(): { tearDown: () => void } {
  resetWorkflowRuntimeServicesForTestV1();
  resetProductionTaskActionRegistryForTestV1();
  const privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-rename-ai-private-"));
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

function makeTaskFolder(name: string, taskDescription: string): string {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  // The renameTask.v1 row promotes into runs/rename-suggestion-*.txt via
  // createFileExclusive, which — unlike a plain fs write — never creates
  // missing parent directories, so the fixture must pre-create "runs/".
  fs.mkdirSync(path.join(folderPath, "runs"), { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    displayName: "original task name",
    nameIsDefault: false,
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
  };
  fs.writeFileSync(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(folderPath, "task.md"), `## Task Description\n\n${taskDescription}\n`, "utf8");
  return folderPath;
}

function installFakeInventory(taskFolderPath: string): TaskInventory {
  const task = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId: taskFolderPath,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: JSON.parse(fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8")) as TaskProgress,
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [task],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
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

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.stat = (uri: vscode.Uri): Promise<{ type: number; ctime: number; mtime: number; size: number }> =>
    fs.promises.stat(uri.fsPath).then((s) => ({
      type: s.isDirectory() ? 2 : 1,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    }));
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "delete", "stat"]) {
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

/** Shared fixture/patch setup for every command-level case below. */
async function withRenameHarness(
  taskDescription: string,
  replies: string[],
  run: (ctx: {
    folderPath: string;
    inventory: TaskInventory;
    context: vscode.ExtensionContext;
    warnings: string[];
    transportCallCount: () => number;
  }) => Promise<void>
): Promise<void> {
  const folderPath = makeTaskFolder(`renamecmd_${Math.floor(Math.random() * 1e9)}`, taskDescription);
  const inventory = installFakeInventory(folderPath);
  const context = makeExtensionContext();

  const warnings: string[] = [];
  initNotificationRouter({
    addEntry: (message: string, level: "info" | "warning" | "error") => {
      if (level === "warning") { warnings.push(message); }
    },
  });
  const fsBridge = installFsBridge();
  const wsStub = installWorkspaceFoldersStub();
  const runtime = setUpTaskActionRuntimeForTestV1();

  let transportCalls = 0;
  const patches: Patched[] = [
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ modelId: "fake-desc-model:v1" })
    ),
    patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
      Promise.resolve({ availability: { available: true }, providerLabel: "Stub Provider" })
    ),
    patch(
      copilotLmTransportModule,
      "createCopilotLmTextTransportV1",
      fakeChatMessageTransportFactory(replies, () => { transportCalls += 1; })
    ),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
  ];

  try {
    await run({ folderPath, inventory, context, warnings, transportCallCount: () => transportCalls });
  } finally {
    for (const p of patches) { p.restore(); }
    runtime.tearDown();
    fsBridge.restore();
    wsStub.restore();
    deactivateNotificationRouter();
    safeRemoveDir(REAL_ROOT);
  }
}

void describe("renameTaskWithAI (command-level, real coordinator + fake transport)", () => {
  void it("applies a valid first reply directly — a single provider call", async () => {
    await withRenameHarness(
      "Users need to export large datasets without freezing the UI.",
      ["Add background export queue for large datasets"],
      async ({ folderPath, inventory, context, transportCallCount }) => {
        await renameTaskWithAI(context, inventory, { canonicalId: folderPath });
        const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
        assert.strictEqual(persisted?.displayName, "Add background export queue for large datasets");
        assert.strictEqual(transportCallCount(), 1);
      }
    );
  });

  void it("retries once on a too-long first reply, then applies the valid retry", async () => {
    await withRenameHarness(
      "Users need to export large datasets without freezing the UI.",
      [
        "Add a brand new background export queue for exporting very large datasets",
        "Add background export queue for large datasets",
      ],
      async ({ folderPath, inventory, context, transportCallCount }) => {
        await renameTaskWithAI(context, inventory, { canonicalId: folderPath });
        const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
        assert.strictEqual(persisted?.displayName, "Add background export queue for large datasets");
        assert.strictEqual(transportCallCount(), 2);
      }
    );
  });

  void it("stops after exactly one re-prompt (two total calls) when both replies are invalid, and preserves the existing name", async () => {
    await withRenameHarness(
      "Users need to export large datasets without freezing the UI.",
      ["too short", "still way too short"],
      async ({ folderPath, inventory, context, warnings, transportCallCount }) => {
        await renameTaskWithAI(context, inventory, { canonicalId: folderPath });
        const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
        assert.strictEqual(
          persisted?.displayName,
          "original task name",
          "the task must keep its existing name rather than falling back to a derived/clamped one"
        );
        assert.strictEqual(transportCallCount(), 2, "must stop after exactly one re-prompt");
        assert.ok(
          warnings.some((w) => /did not produce a valid task summary/.test(w)),
          `expected a "did not produce a valid task summary" warning; got: ${JSON.stringify(warnings)}`
        );
      }
    );
  });

  void it("rejects a leading-substring reply (the reported regression) and does not apply it even on the bounded retry", async () => {
    const description = "Add a discard changes control to the provider settings section for parity with models.";
    await withRenameHarness(
      description,
      [
        // First reply: literally the description's opening words.
        "Add a discard changes control to",
        // Retry reply: still just the opening words, one word longer.
        "Add a discard changes control to the",
      ],
      async ({ folderPath, inventory, context, warnings, transportCallCount }) => {
        await renameTaskWithAI(context, inventory, { canonicalId: folderPath });
        const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
        assert.strictEqual(persisted?.displayName, "original task name");
        assert.strictEqual(transportCallCount(), 2);
        assert.ok(warnings.some((w) => /did not produce a valid task summary/.test(w)));
      }
    );
  });

  void it("shows a distinct 'no model configured' warning and never calls the provider when no Description-stage model is set", async () => {
    const folderPath = makeTaskFolder(
      `renamecmd_nomodel_${Math.floor(Math.random() * 1e9)}`,
      "Some task description text that is long enough to pass the empty-description guard."
    );
    const inventory = installFakeInventory(folderPath);
    const context = makeExtensionContext();
    const warnings: string[] = [];
    initNotificationRouter({
      addEntry: (message: string, level: "info" | "warning" | "error") => {
        if (level === "warning") { warnings.push(message); }
      },
    });
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const runtime = setUpTaskActionRuntimeForTestV1();
    let transportCalls = 0;
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveFreshModelForStage", () => Promise.resolve({ modelId: undefined })),
      patch(
        copilotLmTransportModule,
        "createCopilotLmTextTransportV1",
        fakeChatMessageTransportFactory(["irrelevant"], () => { transportCalls += 1; })
      ),
    ];

    try {
      await renameTaskWithAI(context, inventory, { canonicalId: folderPath });
      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.strictEqual(persisted?.displayName, "original task name");
      assert.strictEqual(transportCalls, 0, "no provider call must be made when no model is configured");
      assert.ok(warnings.some((w) => /No Description-stage model is configured/.test(w)));
    } finally {
      for (const p of patches) { p.restore(); }
      runtime.tearDown();
      fsBridge.restore();
      wsStub.restore();
      deactivateNotificationRouter();
      safeRemoveDir(REAL_ROOT);
    }
  });
});
