/**
 * Work-admission wiring for generatePlanWithAI (v1 fixes item 1, Part 1a —
 * the "plan generation" route-inventory item). Mirrors
 * runLintingFixesGateMessages.test.ts's admission coverage for
 * runLintingFixes: a durable admission marker already held for the task must
 * refuse this command with a busy diagnostic BEFORE the (unbounded) consent
 * modal is ever shown, and admission acquired at command entry must be
 * released in `finally` even when the command exits early (here: the user
 * declines consent).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { generatePlanWithAI, resumeGeneratePlanInteractionV1 } from "../commands/generatePlanWithAI";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import {
  acquireOrAdoptWorkAdmissionV1,
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  hasLiveWorkAdmissionBestEffortV1,
} from "../state/workAdmissionV1";
import type { ChatViewProvider, ChatInteractionRefV1 } from "../views/chatView";

// ── Provider-boundary seams for the resume-path auto-review test below, the
// same monkey-patch-the-CommonJS-module technique nextStageAutoReviewCommandChain.test.ts
// and commandArgNormalization.test.ts already use so the named imports these
// production modules use see the stubbed behavior without dedicated DI seams.
/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const productionTaskActionRuntimeModule = require("../actions/productionTaskActionRuntimeV1") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

interface PatchedV1 { restore: () => void }

function patchV1(module: Record<string, unknown>, name: string, replacement: unknown): PatchedV1 {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-generate-plan-admission-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

/** Neither test reaches task resolution, the coordinator, or Chat — both stubs throw if unexpectedly used. */
const dummyInventory = {
  getTaskById: () => { throw new Error("unexpected inventory access before admission/consent settled"); },
  getTaskByPath: () => { throw new Error("unexpected inventory access before admission/consent settled"); },
  refresh: () => Promise.resolve(undefined),
} as unknown as TaskInventory;
const dummyChatViewProvider = {
  askInteraction: (): Promise<void> => {
    throw new Error("unexpected askInteraction call before admission/consent settled");
  },
} as unknown as ChatViewProvider;

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
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

/** Pre-seeds AI consent so `ensureAiConsent` returns true without ever
 * showing its modal — needed for tests that must run PAST the consent gate. */
function makeConsentedExtensionContext(): vscode.ExtensionContext {
  const ctx = makeExtensionContext();
  void ctx.workspaceState.update(`aiHelper.consent.v${DISCLAIMER_VERSION}`, {
    acceptedAt: "2026-01-01T00:00:00.000Z",
    version: DISCLAIMER_VERSION,
  });
  return ctx;
}

function writeProgress(folderPath: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 },
  ];
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig; } };
}

function fixtureProgress(
  taskFolderPath: string,
  overrides: Partial<TaskProgress> = {}
): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "plan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
    ...overrides,
  };
}

void describe("generatePlanWithAI work admission (v1 fixes item 1, Part 1a)", () => {
  void it("refuses with the busy diagnostic, naming the other owner, when durable admission is already held for the task — before the consent modal is ever shown", async () => {
    const taskFolderPath = makeTaskFolder("admission-busy");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    // vscode.window.showWarningMessage is left as the stub's `notImplemented`
    // (it throws if called) — if generatePlanWithAI reached the consent
    // modal before the admission check, this test would fail with that
    // throw instead of a clean busy refusal.
    try {
      const result = await generatePlanWithAI(
        makeExtensionContext(),
        dummyInventory,
        dummyChatViewProvider,
        { taskFolderPath }
      );

      assert.equal(result, undefined);
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(
        surface.entries[0]?.message ?? "",
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner, not a generic 'task is busy' message"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      deactivateNotificationRouter();
    }
  });

  void it("releases its own admission once the command finishes, even on the fast consent-declined exit path", async () => {
    const taskFolderPath = makeTaskFolder("admission-released-on-decline");

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const win = vscode.window as unknown as Record<string, unknown>;
    const origShowWarningMessage = win.showWarningMessage;
    // Simulate the user declining the consent modal (no button chosen).
    win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);

    try {
      const result = await generatePlanWithAI(
        makeExtensionContext(),
        dummyInventory,
        dummyChatViewProvider,
        { taskFolderPath }
      );

      assert.equal(result, undefined);
      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after consent is declined"
      );
    } finally {
      win.showWarningMessage = origShowWarningMessage;
      deactivateNotificationRouter();
    }
  });

  void it("acquires admission synchronously for a resolvable { canonicalId } argument, before the consent modal", async () => {
    // 2026-09-09 review (completion blocker, new): `normalizeGeneratePlanArg`
    // resolves a `{ canonicalId }` argument synchronously via
    // `inventory.getTaskById` (zero I/O), but the early admission extractor
    // used to omit that shape entirely, leaving this exact invocation
    // unprotected through `ensureAiConsent`'s unbounded modal. Mirrors the
    // `{ taskFolderPath }` busy test above, but through the canonical-ID arg
    // shape the keyboard-shortcut router actually dispatches.
    const taskFolderPath = makeTaskFolder("admission-busy-canonical-id");
    const canonicalId = "canonical-id-under-test";

    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    const inventoryWithCanonicalTask = {
      getTaskById: (id: string) =>
        id === canonicalId ? ({ taskFolderPath } as unknown as ReturnType<TaskInventory["getTaskById"]>) : undefined,
      getTaskByPath: () => { throw new Error("unexpected inventory access before admission/consent settled"); },
      refresh: () => Promise.resolve(undefined),
    } as unknown as TaskInventory;

    // vscode.window.showWarningMessage is left as the stub's `notImplemented`
    // (it throws if called) — if generatePlanWithAI reached the consent
    // modal before the admission check, this test would fail with that
    // throw instead of a clean busy refusal.
    try {
      const result = await generatePlanWithAI(
        makeExtensionContext(),
        inventoryWithCanonicalTask,
        dummyChatViewProvider,
        { canonicalId }
      );

      assert.equal(result, undefined);
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(
        surface.entries[0]?.message ?? "",
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner, not a generic 'task is busy' message"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      deactivateNotificationRouter();
    }
  });
});

/**
 * Watchdog-pause reconciliation after admission (v1 fixes item 1, Part 1a).
 * 2026-09-09 review (completion blocker, new): `generatePlanWithAI` used to
 * discard `reconcileWatchdogPauseAgainstAdmissionV1`'s return value entirely,
 * so it continued running against a task a HUMAN had paused — unlike the
 * established `runReviewWithAI`/`fastForwardReviewWithAI` contract, which
 * gates on `userPaused` explicitly. Uses the same real-fs fixture pattern as
 * `runLintingFixesGateMessages.test.ts`.
 */
void describe("generatePlanWithAI watchdog-pause reconciliation (v1 fixes item 1, Part 1a)", () => {
  void it("refuses a genuinely user-paused task instead of proceeding past admission", async () => {
    const taskFolderPath = makeTaskFolder("user-paused");
    writeProgress(
      taskFolderPath,
      fixtureProgress(taskFolderPath, {
        status: "paused",
        // Deliberately NOT one of taskWatchdogV1's two provenance constants —
        // reconcileWatchdogPauseAgainstAdmissionV1 must never reverse this.
        pausedReason: "Paused by the user for manual investigation",
      })
    );

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const inventory = {
      getTaskById: () => { throw new Error("unexpected inventory access — must refuse before resolving display name"); },
      getTaskByPath: () => { throw new Error("unexpected inventory access — must refuse before resolving display name"); },
      refresh: () => Promise.resolve(undefined),
    } as unknown as TaskInventory;

    try {
      const result = await generatePlanWithAI(
        makeConsentedExtensionContext(),
        inventory,
        dummyChatViewProvider,
        { taskFolderPath }
      );

      assert.equal(result, undefined);
      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "info");
      assert.match(surface.entries[0]?.message ?? "", /paused/i);
      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must still be released when the pause check refuses"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});

/**
 * `resumeGeneratePlanInteractionV1`'s auto-review dispatch does not self-block
 * on the admission chatView.ts's `resumeInteraction` already holds (2026-09-09
 * review completion blocker, new). Unlike the direct-command path in
 * `generatePlanWithAI` above (which releases its own admission BEFORE
 * scheduling the auto-review chain, so the review acquires fresh admission
 * cleanly), a Chat Resume of a `generatePlan.v1` interaction runs entirely
 * inside chatView.ts's `resumeInteraction`, which acquires admission before
 * calling in and holds it for the whole call — including the inline, awaited
 * `scheduleAutomationChain` dispatch. Without a handoff, the review's own
 * admission acquisition observed that still-live, same-process marker and was
 * refused `busy`, which `scheduleAutomationChain` then recorded as a completed
 * chain even though no review ran. The fix mints a fresh single-use handoff
 * token immediately before scheduling the chain — exactly
 * `resumeTask.ts`'s `resumeThenDispatchV1` pattern, already proven by
 * `commandArgNormalization.test.ts`'s `resumeAndRerunReviewV1` coverage — so
 * the downstream review can adopt the SAME marker instead of racing it.
 *
 * The coordinator/orchestrator/model-resolution boundary is faked (this test
 * is about the admission handoff around the auto-review dispatch, not about
 * running a real plan-generation provider round); the real, un-mocked
 * `resumeGeneratePlanInteractionV1`, `scheduleAutomationChain`, and
 * `workAdmissionV1` code paths are exercised end to end.
 */
void describe("resumeGeneratePlanInteractionV1 auto-review admission handoff (v1 fixes item 1, Part 1a)", () => {
  function makeRef(taskBindingId: string): ChatInteractionRefV1 {
    return {
      operationId: "op-under-test",
      interactionId: "interaction-under-test",
      taskBindingId,
      chatDocumentId: "chat-doc-under-test",
      sourceAttemptId: "attempt-under-test",
    };
  }

  function installCoordinatorStubsV1(): PatchedV1[] {
    const completedOutcome = {
      kind: "completed" as const,
      code: "completed" as const,
      correlation: {
        taskBindingId: "binding-under-test",
        chatDocumentId: "chat-doc-under-test",
        actionKey: "generatePlan.v1",
        operationId: "op-under-test",
        attemptId: "attempt-under-test",
      },
    };
    const fakeRecord = {
      inputSnapshot: { canonicalJson: JSON.stringify({ prompt: "do the thing" }), sha256: "deadbeef" },
      state: "settled",
      settlement: "resumed",
    };
    return [
      patchV1(settingsModule, "getAutoReviewAfterPlanMode", () => "auto"),
      patchV1(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "stub:model" })
      ),
      patchV1(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
        Promise.resolve({
          availability: { available: true },
          providerLabel: "Stub Provider",
          provider: "stub",
          modelId: "stub:model",
          nativeModelId: "stub-native",
        })
      ),
      patchV1(productionTaskActionRuntimeModule, "createProductionTaskActionCoordinatorV1", () => ({
        resumeAction: () => Promise.resolve(completedOutcome),
      })),
      patchV1(productionTaskActionRuntimeModule, "getProductionActionConversationOrchestratorV1", () => ({
        loadInteraction: () => Promise.resolve({ kind: "ok", record: fakeRecord }),
      })),
      patchV1(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    ];
  }

  void it("lets the scheduled auto-review adopt the still-held Chat Resume marker instead of refusing busy", async () => {
    const taskFolderPath = makeTaskFolder("resume-auto-review-handoff");
    const taskBindingId = "binding-under-test";
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, { currentStage: "plan", status: "active" }));

    initNotificationRouter(new RecordingSurface());
    const rf = installReadFileBridge();
    const patches = installCoordinatorStubsV1();

    const inventory = {
      getTaskByBindingId: (id: string) =>
        id === taskBindingId
          ? ({
              taskFolderPath,
              workspaceFolder: vscode.Uri.file(REAL_ROOT),
              canonicalId: taskFolderPath,
              progress: { status: "active", currentStage: "plan" },
            } as unknown as ReturnType<TaskInventory["getTaskByBindingId"]>)
          : undefined,
    } as unknown as TaskInventory;

    // Simulates chatView.ts's resumeInteraction: it acquires durable admission
    // for this task BEFORE calling into resumeGeneratePlanInteractionV1, and
    // holds it for this whole call.
    const outer = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "chatResumeInteractionV1",
    });
    assert.equal(outer.outcome, "acquired");

    const captured: Array<{ command: string; outcome: string }> = [];
    if (!(vscode as unknown as Record<string, unknown>).commands) {
      (vscode as unknown as Record<string, unknown>).commands = {};
    }
    const origExecuteCommand = (vscode.commands as unknown as Record<string, unknown>).executeCommand;
    (vscode.commands as unknown as Record<string, unknown>).executeCommand = async (
      command: string,
      arg?: { taskFolderPath?: string; admissionHandoffTokenV1?: string }
    ): Promise<undefined> => {
      // Mirrors runReviewWithAI's own admission-acquisition call exactly,
      // including presenting the forwarded `admissionHandoffTokenV1` — without
      // it, adoption would correctly be refused busy, same as any unrelated
      // caller.
      const adopted = await acquireOrAdoptWorkAdmissionV1({
        taskFolderPath: arg?.taskFolderPath ?? "",
        purpose: "admission",
        commandId: "runReviewWithAI",
        handoffToken: arg?.admissionHandoffTokenV1,
      });
      captured.push({ command, outcome: adopted.outcome });
      if (adopted.outcome === "acquired") {
        await adopted.handle.release();
      }
      return Promise.resolve(undefined);
    };

    try {
      const result = await resumeGeneratePlanInteractionV1(
        inventory,
        dummyChatViewProvider,
        makeRef(taskBindingId),
        "resume-idempotency-under-test",
        new vscode.CancellationTokenSource().token
      );

      assert.equal(result.ok, true, "the resumed generatePlan.v1 interaction must settle ok");

      const reviewDispatch = captured.find((e) => e.command === "vs-code-ai-helper.runReviewWithAI");
      assert.ok(reviewDispatch !== undefined, "must dispatch vs-code-ai-helper.runReviewWithAI after plan generation completes");
      assert.equal(
        reviewDispatch.outcome,
        "acquired",
        "the review's own admission acquisition must adopt the still-held Chat Resume marker, not be refused busy"
      );
    } finally {
      (vscode.commands as unknown as Record<string, unknown>).executeCommand = origExecuteCommand;
      for (const p of patches) { p.restore(); }
      rf.restore();
      await outer.handle.release();
      deactivateNotificationRouter();
    }
  });

  void it("mints a fresh, single-use handoff token per dispatch rather than reusing chatView.ts's own", async () => {
    // Guards against a regression that threads the INCOMING token straight
    // through instead of minting a new one for this specific downstream
    // dispatch: `authorizeWorkAdmissionHandoffV1` invalidates any previously
    // unconsumed token for the task the instant it is called again, so if
    // resumeGeneratePlanInteractionV1 minted its own (rather than forwarding
    // a stale/foreign one), a handoff token authorized for something else
    // beforehand must no longer be the one presented to the review dispatch.
    const taskFolderPath = makeTaskFolder("resume-auto-review-fresh-token");
    const taskBindingId = "binding-fresh-token";
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, { currentStage: "plan", status: "active" }));

    initNotificationRouter(new RecordingSurface());
    const rf = installReadFileBridge();
    const patches = installCoordinatorStubsV1();

    const inventory = {
      getTaskByBindingId: (id: string) =>
        id === taskBindingId
          ? ({
              taskFolderPath,
              workspaceFolder: vscode.Uri.file(REAL_ROOT),
              canonicalId: taskFolderPath,
              progress: { status: "active", currentStage: "plan" },
            } as unknown as ReturnType<TaskInventory["getTaskByBindingId"]>)
          : undefined,
    } as unknown as TaskInventory;

    const outer = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "chatResumeInteractionV1",
    });
    assert.equal(outer.outcome, "acquired");
    // A stale, already-authorized-but-unconsumed token for an unrelated
    // dispatch — must be invalidated by resumeGeneratePlanInteractionV1
    // minting its OWN token, never presented to the review by accident.
    const staleToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);

    let presentedToken: string | undefined;
    if (!(vscode as unknown as Record<string, unknown>).commands) {
      (vscode as unknown as Record<string, unknown>).commands = {};
    }
    const origExecuteCommand = (vscode.commands as unknown as Record<string, unknown>).executeCommand;
    (vscode.commands as unknown as Record<string, unknown>).executeCommand = async (
      _command: string,
      arg?: { admissionHandoffTokenV1?: string }
    ): Promise<undefined> => {
      presentedToken = arg?.admissionHandoffTokenV1;
      return Promise.resolve(undefined);
    };

    try {
      await resumeGeneratePlanInteractionV1(
        inventory,
        dummyChatViewProvider,
        makeRef(taskBindingId),
        "resume-idempotency-under-test",
        new vscode.CancellationTokenSource().token
      );

      assert.equal(typeof presentedToken, "string");
      assert.notEqual(presentedToken, staleToken, "must mint its own handoff token, not reuse an unrelated one");
    } finally {
      (vscode.commands as unknown as Record<string, unknown>).executeCommand = origExecuteCommand;
      for (const p of patches) { p.restore(); }
      rf.restore();
      await outer.handle.release();
      deactivateNotificationRouter();
    }
  });
});
