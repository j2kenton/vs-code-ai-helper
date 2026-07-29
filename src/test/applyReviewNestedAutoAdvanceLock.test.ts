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

import { applyReviewWithAI, registerReviewActionCommands, resumeApplyReviewInteractionV1 } from "../commands/reviewActions";
import { taskOperations } from "../utils/taskOperations";
import { isAutomationChainActive, resetAutomationChainGuards } from "../utils/automationChain";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { REVIEW_STAGES, TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { getProductionActionConversationOrchestratorV1 } from "../actions/productionTaskActionRuntimeV1";
import { ChatViewProvider, ChatInteractionRefV1 } from "../views/chatView";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { TaskInventory } from "../state/taskInventory";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-nested-lock-"));

// applyReviewWithAI's re-review path runs through the real production
// coordinator (createProductionTaskActionCoordinatorV1), which requires the
// Chat interaction transaction store to be wired exactly as extension.ts
// does at activation — otherwise getProductionActionConversationOrchestratorV1
// throws "not wired yet" before this test's actual lock-contention behavior
// ever runs.
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-nested-lock-private-"));
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

/**
 * applyReviewWithAI/runReviewForFolder now run through the real V1 action
 * coordinator (createProductionTaskActionCoordinatorV1), which selects
 * providers via runnerRegistry's `createV1RunnerSelectionOpener` — NOT the
 * legacy `resolveRunnerForModel` cascade this file used to patch. Framing a
 * fake response requires the V1 envelope format and this seam instead
 * (mirrors publishOwnershipMatrix.test.ts's identical helpers).
 */
function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

/** A V1 transport that frames a completed markdown-artifact.v1 envelope. */
function markdownTransportV1(markdown: string, runnerId = "stub-runner"): AgentTransportV1 {
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

/** A V1 transport that frames a `questions` envelope with a single required text question. */
function questionsTransportV1(runnerId = "stub-runner"): AgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frame({
          version: 1,
          correlation: request.correlation,
          kind: "questions",
          questions: [
            {
              questionId: "q1",
              kind: "text",
              prompt: "Which revision should the plan favor?",
              required: true,
              allowBlank: false,
              maxLength: 200,
            },
          ],
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/** Minimal vscode.Memento backing store for a standalone ChatViewProvider instance. */
function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

/**
 * ChatViewProvider.askInteraction's first call for a task opens the webview
 * via `executeCommand("vs-code-ai-helper.chatView.focus")` (chatView.ts's
 * `open()`), which this test process never registers — mirrors
 * chatInteractionUI.test.ts's identical harness.
 */
function installExecuteCommandCapture(): { restore: () => void } {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  return {
    restore: (): void => {
      commandsObj._executeCommandOverride = orig;
    },
  };
}

/**
 * A TaskInventory stub whose task's `progress` carries the same
 * `ownership`/`taskFolder` binding `makeTaskFolder` writes to disk — required
 * for `TaskInventory.getTaskByBindingId` (the real, un-stubbed prototype
 * method) to resolve the task a durable Chat interaction transaction's
 * `taskBindingId` names, exactly as `resumeApplyReviewInteractionV1` looks it
 * up.
 */
function makeBindingInventoryStub(folderPath: string, stage: TaskStage): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const folderName = folderPath.split(/[/\\]/).pop() ?? "";
  const task = {
    canonicalId: folderPath,
    taskFolderPath: folderPath,
    folderName,
    sourceScopeKey: folderPath,
    workspaceFolder: vscode.Uri.file(REAL_ROOT),
    progress: {
      taskFolder: folderName,
      currentStage: stage,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: {
        metaRoot: path.join(REAL_ROOT, "plans"),
        projectRoot: REAL_ROOT,
        workspaceRoot: REAL_ROOT,
        boundAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[folderPath, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === folderPath ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === folderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function fakeToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  } as unknown as vscode.CancellationToken;
}

/**
 * Patches runnerRegistry's `createV1RunnerSelectionOpener` factory so a
 * coordinator-run action never reaches a real CLI or Copilot provider.
 * Transports are offered strictly in order across every coordinator
 * operation opened while this patch is installed.
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
  return patch(runnerRegistryModule, "createV1RunnerSelectionOpener", () => fakeOpener);
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
      // First call is applyReview.v1 (rewrites plan.md); every call after
      // that is review.v1 (the inline re-review, then the deferred
      // follow-up once the true root operation ends) — supply several in
      // case routing performs more than one review.v1 round, mirroring the
      // old always-available resolveRunnerForModel stub this replaces.
      stubV1RunnerSelection([
        markdownTransportV1("# Plan\n\n1. Do the thing (revised).\n"),
        ...Array.from({ length: 6 }, () => markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")),
      ]),
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

/**
 * Direct coverage for the production `resumeApplyReviewInteractionV1`
 * delegate (reviewActions.ts) — the wiring extension.ts calls from the Chat
 * "Resume" control for the text-only Apply Review action (plan §5.5/§6.1).
 * The generic coordinator-level `resumeAction` machinery already has
 * thorough coverage in taskActionCoordinatorV1.test.ts; what was previously
 * untested is the production glue this delegate adds: looking the task up by
 * its durable `taskBindingId` via `TaskInventory.getTaskByBindingId`,
 * resolving a fresh model for the "plan" stage, and — on a completed resume —
 * actually promoting the resumed content to plan.md and re-running the
 * review, mirroring applyReviewWithAI's own synchronous completion path.
 */
void describe("resumeApplyReviewInteractionV1 — production Resume delegate", () => {
  void it("resumes a questions-returning Apply Review end to end: settles \"resumed\", rewrites plan.md, and re-runs the review", async () => {
    const { folderPath } = makeTaskFolder(`resume-apply-review-${Math.floor(Math.random() * 1e9)}`, "plan-high-review");
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const execCapture = installExecuteCommandCapture();
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const chatViewProvider = new ChatViewProvider(makeMemento());
    const askedRefs: ChatInteractionRefV1[] = [];
    const originalAskInteraction = chatViewProvider.askInteraction.bind(chatViewProvider);
    chatViewProvider.askInteraction = (async (question) => {
      askedRefs.push({
        operationId: question.operationId,
        interactionId: question.interactionId,
        taskBindingId: question.binding.taskBindingId,
        chatDocumentId: question.binding.chatDocumentId,
        sourceAttemptId: question.sourceAttemptId,
      });
      return originalAskInteraction(question);
    }) as typeof chatViewProvider.askInteraction;

    const context = makeExtensionContext();
    registerReviewActionCommands(context);

    try {
      const initialPatches: Patched[] = [
        patch(settingsModule, "isAutoAdvanceEnabled", () => false),
        patch(modelSelectionModule, "resolveModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        patch(modelSelectionModule, "resolveFreshModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
          Promise.resolve(new Set(REVIEW_STAGES))),
        stubV1RunnerSelection([questionsTransportV1()]),
        patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
        patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
        patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      ];
      try {
        await applyReviewWithAI(
          vscode.Uri.file(REAL_ROOT),
          context,
          { taskFolderPath: folderPath },
          { chatViewProvider }
        );
      } finally {
        for (const p of initialPatches.reverse()) { p.restore(); }
      }

      assert.equal(askedRefs.length, 1, "the apply-review clarifying question must reach Chat With AI exactly once");
      assert.equal(
        fs.readFileSync(path.join(folderPath, "plan.md"), "utf8"),
        "# Plan\n\n1. Do the thing.\n",
        "a questions outcome must not rewrite plan.md"
      );

      const submitted = await getProductionActionConversationOrchestratorV1().submitAnswers(
        askedRefs[0]!,
        [{ questionId: "q1", kind: "text", state: "answered", value: "Favor the revised approach." }],
        allocateHex128IdV1()
      );
      assert.equal(submitted.ok, true, "the clarifying answer must be accepted before Resume");

      const inventory = makeBindingInventoryStub(folderPath, "plan-high-review");
      const resumePatches: Patched[] = [
        patch(settingsModule, "isAutoAdvanceEnabled", () => false),
        patch(modelSelectionModule, "resolveModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        patch(modelSelectionModule, "resolveFreshModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "stub:model" })),
        patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
          Promise.resolve(new Set(REVIEW_STAGES))),
        // First transport is the resumed applyReview.v1 attempt (rewrites
        // plan.md); the second is the completion path's own re-review.
        stubV1RunnerSelection([
          markdownTransportV1("# Plan\n\n1. Do the thing (revised via Resume).\n"),
          markdownTransportV1("Readiness: 9/10\n\n- Ready.\n"),
        ]),
        patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
        patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
        patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      ];
      try {
        const result = await resumeApplyReviewInteractionV1(
          vscode.Uri.file(REAL_ROOT),
          inventory,
          chatViewProvider,
          askedRefs[0]!,
          allocateHex128IdV1(),
          fakeToken()
        );

        assert.equal(result.ok, true, `expected Resume to settle successfully: ${result.ok ? "" : result.reason}`);
        if (result.ok) {
          assert.equal(result.settlement, "resumed", "applyReview.v1 declares sameOperation resume semantics");
        }
        assert.equal(
          fs.readFileSync(path.join(folderPath, "plan.md"), "utf8"),
          "# Plan\n\n1. Do the thing (revised via Resume).\n",
          "the resumed attempt's own content must be the one actually promoted to plan.md"
        );
        // REVIEW_TARGETS["plan-high-review"] is "plan-high-review" itself
        // (a self-review), so the completion path's re-review — already
        // awaited inside resumeApplyReviewInteractionV1 before it returns —
        // overwrites the SAME review artifact the original
        // applyReviewWithAI call applied.
        assert.equal(
          fs.readFileSync(path.join(folderPath, "plan-high-review.md"), "utf8"),
          "Readiness: 9/10\n\n- Ready.\n",
          "the re-review triggered by Resume's completion must have run and overwritten the review artifact"
        );
      } finally {
        for (const p of resumePatches.reverse()) { p.restore(); }
      }
    } finally {
      execCapture.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
