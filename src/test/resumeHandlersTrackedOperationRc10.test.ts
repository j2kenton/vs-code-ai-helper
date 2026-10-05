/**
 * RC10 item 1, Part C: the Draft, Chat Send and edit-preflight resumes each get
 * (1) a source-level contract check — `coordinator.resumeAction` sits inside
 * `runResumedRoundOperationV1` and any `askInteraction` follows it — and
 * (2) a focused transport-time check: a stubbed coordinator records the task's
 * running operations while `resumeAction` runs, and none may outlive the resume.
 * Same module-patching technique as generatePlanWithAIWorkAdmission.test.ts; only
 * the coordinator and provider-availability seams are stubbed.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { resumeDraftInteractionV1 } from "../commands/draftTaskWithAI";
import { resumeChatSendInteractionV1 } from "../commands/chatWithStage";
import { resumeEditPreflightInteractionV1 } from "../commands/runEditActionV1";
import { IMPLEMENTATION_ACTION_KEY_V1 } from "../actions/rows/editPreflightRowsV1";
import { CHAT_SEND_ACTION_KEY_V1 } from "../actions/rows/chatSendRowV1";
import type { TaskInventory } from "../state/taskInventory";
import type { TaskProgress } from "../types/taskProgress";
import type { ChatViewProvider } from "../views/chatView";
import { taskOperations } from "../utils/taskOperations";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const productionRuntimeModule = require("../actions/productionTaskActionRuntimeV1") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

function handlerBody(source: string, name: string): string {
  const start = source.indexOf("export async function " + name + "(");
  assert.ok(start >= 0, name + " is exported");
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

const CASES: Array<[string, string]> = [
  ["src/commands/draftTaskWithAI.ts", "resumeDraftInteractionV1"],
  ["src/commands/chatWithStage.ts", "resumeChatSendInteractionV1"],
  ["src/commands/runEditActionV1.ts", "resumeEditPreflightInteractionV1"],
];

void describe("resume handlers register a tracked operation (RC10 item 1, Part C)", () => {
  for (const [file, name] of CASES) {
    void it(name + " wraps resumeAction in the tracked operation", () => {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const body = handlerBody(source, name);
      const wrap = body.indexOf("runResumedRoundOperationV1(");
      const resume = body.indexOf("coordinator.resumeAction(");
      assert.ok(wrap >= 0 && resume > wrap, "resumeAction is called inside the wrapper");
      assert.match(body, /op\.token/, "the operation's token cancels the round");
      assert.match(body, /op\.setModel/, "the running model is reported");
      const ask = body.indexOf("askInteraction(");
      if (ask >= 0) {
        assert.ok(ask > resume, "askInteraction runs after the wrapped round");
      }
    });
  }
});

const TRANSPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-resume-handlers-rc10-"));

const AVAILABLE = {
  availability: { available: true },
  providerLabel: "Stub",
  provider: "stub",
  modelId: "stub:model",
  nativeModelId: "stub-native",
};

const FAKE_RECORD = {
  inputSnapshot: { canonicalJson: JSON.stringify({ prompt: "p" }), sha256: "x" },
  state: "settled",
  settlement: "resumed",
};

const noopChat = {
  askInteraction: (): Promise<void> => Promise.resolve(),
  open: (): Promise<void> => Promise.resolve(),
} as unknown as ChatViewProvider;

function patch(module: Record<string, unknown>, name: string, replacement: unknown): () => void {
  const orig = module[name];
  module[name] = replacement;
  return () => {
    module[name] = orig;
  };
}

function setupTask(name: string, stage: string): { folder: string; bindingId: string; inventory: TaskInventory } {
  const folder = path.join(TRANSPORT_ROOT, name);
  fs.mkdirSync(folder, { recursive: true });
  const progress = {
    taskFolder: path.basename(folder),
    displayName: name,
    currentStage: stage,
    status: "active",
    stages: {},
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  } as unknown as TaskProgress;
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress), "utf8");
  const bindingId = "binding-" + name;
  const inventory = {
    getTaskByBindingId: (id: string) =>
      id === bindingId
        ? ({
            taskFolderPath: folder,
            workspaceFolder: vscode.Uri.file(TRANSPORT_ROOT),
            canonicalId: folder,
            progress: { status: "active", currentStage: stage, displayName: name },
          } as unknown as ReturnType<TaskInventory["getTaskByBindingId"]>)
        : undefined,
  } as unknown as TaskInventory;
  return { folder, bindingId, inventory };
}

void describe("resume handlers hold a running operation while the transport runs (RC10 item 1, Part C)", () => {
  void it("Draft", async () => {
    const { folder, bindingId, inventory } = setupTask("draft-rc10", "desc");
    initNotificationRouter({ addEntry: (): void => undefined } as never);
    let during: ReturnType<typeof taskOperations.getTaskOperations> = [];
    const outcome = {
      kind: "cancelled",
      code: "cancelled",
      correlation: {
        taskBindingId: bindingId,
        chatDocumentId: "chat-doc",
        actionKey: "draft.v1",
        operationId: "op",
        attemptId: "attempt",
      },
    };
    const readFileTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
    const origReadFile = readFileTarget.readFile;
    readFileTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    const restores = [
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })
      ),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () => Promise.resolve(AVAILABLE)),
      patch(productionRuntimeModule, "createProductionTaskActionCoordinatorV1", () => ({
        resumeAction: () => {
          during = taskOperations.getTaskOperations(folder);
          return Promise.resolve(outcome);
        },
      })),
      patch(productionRuntimeModule, "getProductionActionConversationOrchestratorV1", () => ({
        loadInteraction: () => Promise.resolve({ kind: "ok", record: FAKE_RECORD }),
        getRecord: () => Promise.resolve(undefined),
      })),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    ];
    try {
      await resumeDraftInteractionV1(
        inventory,
        noopChat,
        {
          operationId: "op",
          interactionId: "interaction",
          taskBindingId: bindingId,
          chatDocumentId: "chat-doc",
          sourceAttemptId: "attempt",
        },
        "idem",
        new vscode.CancellationTokenSource().token
      );
      assert.equal(during.length, 1, "exactly one running root while the coordinator runs");
      assert.equal(during[0]!.label, "Draft Task with AI");
      assert.equal(during[0]!.stage, "desc");
      assert.equal(during[0]!.exclusive, false);
      assert.deepEqual(taskOperations.getTaskOperations(folder), [], "no operation outlives the resume");
    } finally {
      for (const r of restores) {
        r();
      }
      readFileTarget.readFile = origReadFile;
      deactivateNotificationRouter();
    }
  });

  void it("Chat Send", async () => {
    const { folder, bindingId, inventory } = setupTask("chat-send-rc10", "plan");
    initNotificationRouter({ addEntry: (): void => undefined } as never);
    let during: ReturnType<typeof taskOperations.getTaskOperations> = [];
    const outcome = {
      kind: "cancelled",
      code: "cancelled",
      correlation: {
        taskBindingId: bindingId,
        chatDocumentId: "chat-doc",
        actionKey: CHAT_SEND_ACTION_KEY_V1,
        operationId: "op",
        attemptId: "attempt",
      },
    };
    const readFileTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
    const origReadFile = readFileTarget.readFile;
    readFileTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    const restores = [
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })
      ),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () => Promise.resolve(AVAILABLE)),
      patch(productionRuntimeModule, "createProductionTaskActionCoordinatorV1", () => ({
        resumeAction: () => {
          during = taskOperations.getTaskOperations(folder);
          return Promise.resolve(outcome);
        },
      })),
      patch(productionRuntimeModule, "getProductionActionConversationOrchestratorV1", () => ({
        loadInteraction: () => Promise.resolve({ kind: "ok", record: FAKE_RECORD }),
        getRecord: () => Promise.resolve(undefined),
      })),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    ];
    try {
      await resumeChatSendInteractionV1(
        {} as vscode.ExtensionContext,
        inventory,
        undefined,
        noopChat,
        {
          operationId: "op",
          interactionId: "interaction",
          taskBindingId: bindingId,
          chatDocumentId: "chat-doc",
          sourceAttemptId: "attempt",
        },
        "idem",
        new vscode.CancellationTokenSource().token
      );
      assert.equal(during.length, 1, "exactly one running root while the coordinator runs");
      assert.equal(during[0]!.label, "Chat");
      assert.equal(during[0]!.stage, "plan");
      assert.equal(during[0]!.exclusive, false);
      assert.deepEqual(taskOperations.getTaskOperations(folder), [], "no operation outlives the resume");
    } finally {
      for (const r of restores) {
        r();
      }
      readFileTarget.readFile = origReadFile;
      deactivateNotificationRouter();
    }
  });

  void it("edit preflight (implementation)", async () => {
    // `import * as vscode` is a getter-only namespace wrapper; patch the module itself.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const v = require("vscode") as Record<string, unknown>;
    const keys = ["version", "LanguageModelTextPart", "LanguageModelToolCallPart", "LanguageModelToolResultPart", "lm"];
    const savedHost = keys.map((k) => [k, v[k]] as const);
    const ws = vscode.workspace as unknown as Record<string, unknown>;
    const savedFolders = ws.workspaceFolders;
    v.version = "1.110.0";
    v.LanguageModelTextPart = function LanguageModelTextPart(): void {
      /* host-capability probe only */
    };
    v.LanguageModelToolCallPart = function LanguageModelToolCallPart(): void {
      /* host-capability probe only */
    };
    v.LanguageModelToolResultPart = function LanguageModelToolResultPart(): void {
      /* host-capability probe only */
    };
    v.lm = { selectChatModels: (): Promise<unknown[]> => Promise.resolve([]) };
    // ensureWorkflowWorkspaceRootV1 requires the root to be an open workspace folder.
    ws.workspaceFolders = [{ uri: vscode.Uri.file(TRANSPORT_ROOT), name: "root", index: 0 }];

    const { folder, bindingId, inventory } = setupTask("edit-preflight-rc10", "impl");
    initNotificationRouter({ addEntry: (): void => undefined } as never);
    let during: ReturnType<typeof taskOperations.getTaskOperations> = [];
    const outcome = {
      kind: "cancelled",
      code: "cancelled",
      correlation: {
        taskBindingId: bindingId,
        chatDocumentId: "chat-doc",
        actionKey: IMPLEMENTATION_ACTION_KEY_V1,
        operationId: "op",
        attemptId: "attempt",
      },
    };
    const readFileTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
    const origReadFile = readFileTarget.readFile;
    readFileTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    const restores = [
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })
      ),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () => Promise.resolve(AVAILABLE)),
      patch(productionRuntimeModule, "createProductionTaskActionCoordinatorV1", () => ({
        resumeAction: () => {
          during = taskOperations.getTaskOperations(folder);
          return Promise.resolve(outcome);
        },
      })),
      patch(productionRuntimeModule, "getProductionActionConversationOrchestratorV1", () => ({
        loadInteraction: () => Promise.resolve({ kind: "ok", record: FAKE_RECORD }),
        getRecord: () => Promise.resolve(undefined),
      })),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(runnerRegistryModule, "resolveEffectiveProvider", () => ({ kind: "copilot" })),
      patch(runnerRegistryModule, "backupModelsForStage", () => []),
      patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
        Promise.resolve({ ...AVAILABLE, provider: "copilot" })
      ),
      patch(modelSelectionModule, "resolveEffectiveStageChainV1", () => ({ primary: "stub:model" })),
    ];
    try {
      await resumeEditPreflightInteractionV1(
        inventory,
        noopChat,
        {
          operationId: "op",
          interactionId: "interaction",
          taskBindingId: bindingId,
          chatDocumentId: "chat-doc",
          sourceAttemptId: "attempt",
        },
        IMPLEMENTATION_ACTION_KEY_V1,
        "idem",
        new vscode.CancellationTokenSource().token
      );
      assert.equal(during.length, 1, "exactly one running root while the coordinator runs ");
      assert.equal(during[0]!.label, "Run Implementation");
      assert.equal(during[0]!.stage, "impl");
      assert.equal(during[0]!.exclusive, false);
      assert.deepEqual(taskOperations.getTaskOperations(folder), [], "no operation outlives the resume");
    } finally {
      for (const r of restores) {
        r();
      }
      readFileTarget.readFile = origReadFile;
      deactivateNotificationRouter();
      for (const [k, val] of savedHost) {
        v[k] = val;
      }
      ws.workspaceFolders = savedFolders;
    }
  });
});
