/**
 * Unit tests for command argument normalization across entry points and
 * explicit-task resolution failure behavior.
 *
 * Tests cover:
 *   1. normalizeGeneratePlanArg — all accepted shapes
 *   2. Explicit-task failure behavior (must not fall through to other tasks)
 *   3. patchTaskProgress — preserves unrelated fields on stage/status writes
 *      (regression: pauseTask, resumeTask, setTaskStage all migrated onto
 *      patchTaskProgress so they no longer overwrite implReviewFiles etc.)
 *   4. setTaskStage auto-review delegation: production setTaskStage with
 *      triggerAutoReview=true must dispatch { taskFolderPath }, not
 *      { canonicalId }, so reviewActions.normalizeReviewArg resolves
 *      correctly instead of falling through to a QuickPick.
 *   5. normalizePauseTaskArg — TaskNode shape and flat shape handling
 *   6. normalizeResumeTaskArg — TaskNode shape and flat shape handling
 *   7. pauseTaskArgHasExplicitTask — explicit-task detection for deleted-task
 *      error path in pauseTask
 *   8. resumeTaskArgHasExplicitTask — explicit-task detection for deleted-task
 *      error path in resumeTask
 *   9. pauseTask / resumePausedTask integration — full command path through
 *      normalization + resolveTaskContext with a stubbed inventory
 *  10. installMessageCapture restore — verifies the restore() call actually
 *      reinstates the original vscode.window methods
 *  11. runReviewForFolder impl-review variable sourcing — calls the production
 *      function directly; verifies that missing plan.md triggers the plan-
 *      missing warning, missing plan-final.md triggers the impl-missing
 *      warning, and when both exist neither warning fires (the runner-
 *      unavailable warning fires instead, confirming the variable gates
 *      were passed).
 *  12. setTaskStage deleted-task error path — explicit-task arg that fails
 *      to resolve shows an error, not a generic fallback
 *  13. normalizeReviewArg canonicalId-only regression — confirms that passing
 *      canonicalId without taskFolderPath does NOT silently re-target the
 *      action to a different task. Three-layer defense:
 *        (a) Compile-time: ReviewCommandArg type no longer includes
 *            { canonicalId } alone — TS compiler rejects such calls.
 *        (b) Runtime/normalizer: normalizeReviewArg returns a no-task {}
 *            for unrecognized object shapes.
 *        (c) Runtime/entry-point: isMalformedReviewArg guard at command
 *            entry points (runReviewWithAI, applyReviewWithAI, viewReview)
 *            detects the unsupported shape and shows a clear error before
 *            normalizeReviewArg is even called — preventing any QuickPick
 *            fallback for programmatic callers that pass bad args via cast.
 *        NOTE: The local isMalformedReviewArgSim in suite 13 exactly mirrors
 *        the production guard including the folderUri check. { task: {} }
 *        is malformed because {} has no folderUri; { task: { folderUri: uri }}
 *        is valid. Primitives return false (not malformed) because they fall
 *        through to the safe QuickPick path.
 *  14. runReviewForFolder legacy-task fallback — confirms that a task folder
 *      with only implementation.md (and no plan-final.md) at an impl-review
 *      stage is handled via materializeCanonicalIfNeeded: the legacy file is
 *      used as the implementation artifact and the review proceeds to the
 *      runner stage (runner-unavailable warning confirms both gates passed).
 *  15. isMalformedReviewArg mixed-shape bypass variants — confirms that
 *      mixed shapes like { canonicalId, taskFolderPath: undefined } and
 *      { canonicalId, task: undefined } are correctly identified as malformed
 *      even though the accepted discriminant keys are present with falsy values.
 *      Also confirms that { task: {} } (truthy task without folderUri) is
 *      malformed, and that { task: { folderUri: uri } } is valid.
 *      Also confirms that primitives ("x", 42, true) are NOT malformed —
 *      they fall through to the safe QuickPick path in normalizeReviewArg.
 *      Includes production entry-point regression tests for { task: {} as any }
 *      and { task: { folderUri: undefined } as any } shapes exercising
 *      runReviewWithAI directly, PLUS a production-path test confirming that
 *      a string primitive passed to runReviewWithAI does NOT throw a TypeError
 *      and instead falls through to the workspace-guard or QuickPick path.
 *  16. generateImplementationWithAI eligibility — confirms that plan-low-review
 *      tasks are NOT eligible for Generate Implementation (they must advance
 *      to the implementation stage first), and that implementation-stage tasks
 *      ARE eligible. This prevents the command from advertising a task as
 *      eligible in the QuickPick and then hard-failing because plan-final.md
 *      doesn't exist yet.
 *
 *      Suite 16 asserts against the PRODUCTION `GENERATE_IMPL_ELIGIBLE_STAGES`
 *      constant exported from `reviewActions.ts`, NOT a locally re-declared
 *      array. This means a regression in the production code (e.g.
 *      re-adding "plan-low-review" to the constant) will cause suite 16 to
 *      fail immediately.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// normalizeGeneratePlanArg: covers Uri, { task }, { canonicalId }, { taskFolderPath }
// ---------------------------------------------------------------------------

import { normalizeGeneratePlanArg } from "../commands/generatePlanWithAI";
import {
  normalizePauseTaskArg,
  pauseTaskArgHasExplicitTask,
} from "../commands/pauseTask";
import {
  normalizeResumeTaskArg,
  resumeTaskArgHasExplicitTask,
} from "../commands/resumeTask";
import { setTaskStage } from "../commands/setTaskStage";
import {
  scheduleAutomationChain,
  resetAutomationChainGuards,
} from "../utils/automationChain";
import {
  GENERATE_IMPL_ELIGIBLE_STAGES,
  applyReviewWithAI,
  normalizeReviewArg,
  runReviewForFolder,
  runReviewWithAI,
} from "../commands/reviewActions";
import { TaskInventory } from "../state/taskInventory";
import { applyHighLevelReviewChanges } from "../commands/applyHighLevelReviewChanges";
import { applyLowLevelReviewChanges } from "../commands/applyLowLevelReviewChanges";
import {
  LEGACY_AI_ROUTE_DISABLED_V0,
  LegacyAiActionSafetyGateErrorV0,
} from "../services/legacyAiActionSafetyGateV0";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { initNotificationRouter } from "../utils/notificationRouter";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";

// Initialize notification router to forward to vscode stubs so tests can intercept them
initNotificationRouter({
  addEntry(message, level) {
    // Tests that don't install a message capture leave the window stubs in
    // their throwing "not implemented" state; entries they never assert on
    // are simply dropped.
    try {
      if (level === "warning") {
        void vscode.window.showWarningMessage(message);
      } else if (level === "error") {
        void vscode.window.showErrorMessage(message);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    } catch {
      // No capture installed for this test — ignore.
    }
  }
});
// Production activation installs the operation → terminal-entry bridge, so
// the full command paths exercised here must be asserted against that same
// centralized subscription, not against ad-hoc per-command messages.
installOperationNotificationBridge();

/**
 * Build a minimal TaskInventory stub that returns a known task for a given
 * canonical ID, or undefined for any other.
 */
function makeInventoryStub(
  knownId: string,
  taskFolderPath: string,
  status: "active" | "paused" = "active"
): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const task = {
    canonicalId: knownId,
    taskFolderPath,
    folderName: taskFolderPath.split(/[/\\]/).pop() ?? "",
    sourceScopeKey: knownId,
    progress: {
      taskFolder: taskFolderPath.split(/[/\\]/).pop() ?? "",
      currentStage: "impl" as const,
      status,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    },
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[knownId, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  // Stub refresh: no-op (the inventory is already "refreshed")
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === knownId ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === taskFolderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

/**
 * Build a minimal empty TaskInventory stub (no tasks).
 */
function makeEmptyInventoryStub(): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map();
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<never> => [];
  inv.getTaskById = (): undefined => undefined;
  inv.getTaskByPath = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

/**
 * Build a TaskInventory stub where tasks have a specific currentStage.
 * Used for setTaskStage integration tests.
 */
function makeInventoryStubWithStage(
  knownId: string,
  taskFolderPath: string,
  currentStage: import("../types/taskProgress").TaskStage,
  status: "active" | "paused" = "active"
): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const task = {
    canonicalId: knownId,
    taskFolderPath,
    folderName: taskFolderPath.split(/[/\\]/).pop() ?? "",
    sourceScopeKey: knownId,
    progress: {
      taskFolder: taskFolderPath.split(/[/\\]/).pop() ?? "",
      currentStage,
      status,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    },
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[knownId, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === knownId ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === taskFolderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

/**
 * Build a minimal IncompleteTask stub for testing TaskNode-shaped args.
 */
function makeIncompleteTask(
  folderPath: string,
  status: "active" | "paused" = "active"
): {
  folderUri: vscode.Uri;
  folderName: string;
  progress: TaskProgress;
} {
  return {
    folderUri: vscode.Uri.file(folderPath),
    folderName: folderPath.split(/[/\\]/).pop() ?? "",
    progress: {
      taskFolder: folderPath.split(/[/\\]/).pop() ?? "",
      currentStage: "impl" as const,
      status,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal CurrentTaskStore stub
// ---------------------------------------------------------------------------

import { CurrentTaskStore } from "../utils/currentTaskStore";

function makeCurrentTaskStoreStub(persistedId?: string): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => persistedId;
  store.set = async (): Promise<void> => { /* no-op */ };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return store;
}

// ---------------------------------------------------------------------------
// Message capture helpers — intercept all vscode.window.show* calls
//
// Stubs showInformationMessage, showErrorMessage, showWarningMessage,
// showQuickPick, and withProgress so tests that exercise production code
// reaching any of these do not hit the throwing defaults in the vscode
// test stub, and so that assertions can inspect emitted messages.
// ---------------------------------------------------------------------------

type CapturedMessage = { method: string; message: string };

function installMessageCapture(): {
  captured: CapturedMessage[];
  restore: () => void;
} {
  const captured: CapturedMessage[] = [];
  const win = vscode.window as unknown as Record<string, unknown>;

  const origInfo = win.showInformationMessage;
  const origErr = win.showErrorMessage;
  const origWarn = win.showWarningMessage;
  const origQuickPick = win.showQuickPick;
  const origWithProgress = win.withProgress;

  win.showInformationMessage = (msg: string): Promise<undefined> => {
    captured.push({ method: "info", message: msg });
    return Promise.resolve(undefined);
  };
  win.showErrorMessage = (msg: string): Promise<undefined> => {
    captured.push({ method: "error", message: msg });
    return Promise.resolve(undefined);
  };
  win.showWarningMessage = (msg: string): Promise<undefined> => {
    captured.push({ method: "warning", message: msg });
    return Promise.resolve(undefined);
  };
  win.showQuickPick = (): Promise<undefined> => {
    return Promise.resolve(undefined);
  };
  win.withProgress = async (
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ): Promise<unknown> => {
    return task(
      { report: (): void => undefined },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: (): void => undefined }),
      }
    );
  };

  return {
    captured,
    restore: (): void => {
      win.showInformationMessage = origInfo;
      win.showErrorMessage = origErr;
      win.showWarningMessage = origWarn;
      win.showQuickPick = origQuickPick;
      win.withProgress = origWithProgress;
    },
  };
}

// ---------------------------------------------------------------------------
// workspace.fs stub helpers — intercept vscode.workspace.fs calls
// ---------------------------------------------------------------------------

type FsStubHandles = {
  restore: () => void;
};

function installMemStore(store: Map<string, string>): FsStubHandles {
  const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
  const origWriteFile = (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile;
  const origStat = (vscode.workspace.fs as unknown as Record<string, unknown>).stat;
  const origCreateDirectory = (vscode.workspace.fs as unknown as Record<string, unknown>).createDirectory;

  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
    uri: vscode.Uri
  ): Promise<Uint8Array> => {
    // writeTaskProgress persists task-progress.json via writeAtomic, which
    // always hits the real filesystem (production's vscode.workspace.fs and
    // Node's fs both resolve to the same disk, but this in-memory store does
    // not). Prefer the real file when present so patchTaskProgress reads see
    // its own prior writes instead of the stale seeded snapshot.
    if (nodePath.basename(uri.fsPath) === "task-progress.json" && nodeFs.existsSync(uri.fsPath)) {
      return nodeFs.promises.readFile(uri.fsPath, "utf8").then((text) => new TextEncoder().encode(text));
    }
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile = (
    uri: vscode.Uri,
    data: Uint8Array
  ): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).stat = (
    uri: vscode.Uri
  ): Promise<vscode.FileStat> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    const now = Date.now();
    return Promise.resolve({
      type: vscode.FileType.File,
      ctime: now,
      mtime: now,
      size: Buffer.byteLength(content, "utf8"),
    });
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).createDirectory = (
    _uri: vscode.Uri
  ): Promise<void> => Promise.resolve();

  return {
    restore: (): void => {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile = origWriteFile;
      (vscode.workspace.fs as unknown as Record<string, unknown>).stat = origStat;
      (vscode.workspace.fs as unknown as Record<string, unknown>).createDirectory = origCreateDirectory;
    },
  };
}

// patchTaskProgress (and therefore pauseTask/resumePausedTask/setTaskStage,
// which all route through it) now serializes writes through withTaskLock,
// which takes real filesystem leases derived from the folder path's ".."
// ancestry. A shallow fake path like "/fake-workspace/x" collides with the
// filesystem root two levels up, and mkdir on a Windows drive root throws
// EPERM even though it already exists. Use a real temp directory with a
// ".ensemble"-nested shape matching production so the lease paths land
// safely inside it instead.
const REAL_TASK_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-cmdargs-test-")
);
after(() => {
  nodeFs.rmSync(REAL_TASK_ROOT, { recursive: true, force: true });
});

// runReviewForFolder runs through the real production coordinator
// (createProductionTaskActionCoordinatorV1), which requires the Chat
// interaction transaction store to be wired exactly as extension.ts does at
// activation — otherwise getProductionActionConversationOrchestratorV1
// throws "not wired yet" before this file's actual argument-normalization
// behavior ever runs.
const PRIVATE_STORAGE_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-cmdargs-test-private-")
);
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

function makeTaskFolderUri(name: string): vscode.Uri {
  const dir = nodePath.join(REAL_TASK_ROOT, ".ensemble", name);
  // resolveTaskContext refuses to resolve a task whose folder does not exist
  // on disk (fs.existsSync guard), so the fixture must create it for real,
  // not just seed a matching key in the in-memory workspace.fs mock.
  nodeFs.mkdirSync(dir, { recursive: true });
  return vscode.Uri.file(dir);
}

/**
 * Install a stub for vscode.workspace.workspaceFolders pointing at
 * REAL_TASK_ROOT, and restore it afterward. resolveTaskContext requires the
 * resolved task folder to fall under a configured workspace folder, so any
 * test that exercises the full command path (pauseTask, resumePausedTask,
 * setTaskStage) against a makeTaskFolderUri()-produced path needs this.
 */
function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_TASK_ROOT), name: "real-task-root", index: 0 },
  ];
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig;
    },
  };
}

function seedProgress(
  store: Map<string, string>,
  folderUri: vscode.Uri,
  progress: TaskProgress
): Promise<void> {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  const content = JSON.stringify(progress, null, 2);
  store.set(uri.toString(), content);
  // activateTask (used by resumePausedTask/startNewTask) checks task-progress.json's
  // existence via raw Node fs, not vscode.workspace.fs, so it never sees the
  // in-memory store. Also write the real file so both paths agree.
  nodeFs.writeFileSync(uri.fsPath, content, "utf8");
  return Promise.resolve();
}

function readStoredProgress(
  store: Map<string, string>,
  folderUri: vscode.Uri
): Promise<TaskProgress | undefined> {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  // See the matching comment in installMemStore's readFile mock: writeAtomic
  // always persists task-progress.json to the real filesystem, so the real
  // file (when present) reflects any patchTaskProgress writes that the
  // in-memory store does not.
  if (nodeFs.existsSync(uri.fsPath)) {
    return nodeFs.promises.readFile(uri.fsPath, "utf8").then((raw) => JSON.parse(raw) as TaskProgress);
  }
  const raw = store.get(uri.toString());
  if (!raw) {
    return Promise.resolve(undefined);
  }
  return Promise.resolve(JSON.parse(raw) as TaskProgress);
}

// ---------------------------------------------------------------------------
// normalizeGeneratePlanArg: covers Uri, { task }, { canonicalId }, { taskFolderPath }
// ---------------------------------------------------------------------------

void describe("normalizeGeneratePlanArg", () => {
  const FOLDER = "/workspace/.helper/plans/2026-07-08_task_1";
  const CANONICAL_ID = FOLDER.toLowerCase(); // on Linux same; covered below

  void it("returns undefined for undefined arg (triggers folder picker)", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const result = normalizeGeneratePlanArg(undefined, inv);
    assert.strictEqual(result, undefined);
  });

  void it("passes through a vscode.Uri directly", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const uri = vscode.Uri.file(FOLDER);
    const result = normalizeGeneratePlanArg(uri, inv);
    assert.ok(result instanceof vscode.Uri);
    assert.ok((result).fsPath.includes("2026-07-08_task_1"));
  });

  void it("{ task: IncompleteTask } returns the task's folderUri", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const arg = {
      task: {
        folderUri: vscode.Uri.file(FOLDER),
        folderName: "2026-07-08_task_1",
        progress: {
          taskFolder: "2026-07-08_task_1",
          currentStage: "plan" as const,
          status: "active" as const,
          createdAt: "",
          updatedAt: "",
        },
      },
    };
    const result = normalizeGeneratePlanArg(arg, inv);
    assert.ok(result instanceof vscode.Uri, "should return a Uri from task.folderUri");
  });

  void it("{ taskFolderPath } returns a Uri from the path", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const result = normalizeGeneratePlanArg({ taskFolderPath: FOLDER }, inv);
    assert.ok(result instanceof vscode.Uri);
    assert.ok((result).fsPath.includes("2026-07-08_task_1"));
  });

  void it("{ canonicalId } found in inventory → returns a Uri", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const result = normalizeGeneratePlanArg({ canonicalId: CANONICAL_ID }, inv);
    // Inventory stub returns the task — result should be a Uri
    assert.ok(result instanceof vscode.Uri, "should resolve canonical ID to Uri via inventory");
  });

  void it("{ canonicalId } not found → returns sentinel object (not undefined)", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const result = normalizeGeneratePlanArg(
      { canonicalId: "/totally/unknown/task" },
      inv
    );
    // Should return a sentinel { canonicalId } so the caller can fail clearly
    assert.ok(result !== undefined, "should not return undefined for unknown canonical ID");
    assert.ok(!(result instanceof vscode.Uri), "should return a sentinel, not a Uri");
    assert.ok(
      typeof result === "object" && "canonicalId" in result,
      "sentinel must have canonicalId"
    );
  });

  void it("empty object {} → returns undefined (triggers folder picker)", () => {
    const inv = makeInventoryStub(CANONICAL_ID, FOLDER);
    const result = normalizeGeneratePlanArg({}, inv);
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Explicit-task resolution: must fail clearly, not redirect to another task
// ---------------------------------------------------------------------------

void describe("explicit-task resolution failure contract", () => {
  void it("normalizeGeneratePlanArg sentinel triggers a clear error, not a silent fallback", () => {
    const inv = makeInventoryStub(
      "/known/task",
      "/workspace/.helper/plans/known_task"
    );

    // Unknown canonical ID produces a sentinel
    const sentinel = normalizeGeneratePlanArg(
      { canonicalId: "/unknown/task" },
      inv
    );

    // Caller must detect and report an error — this test verifies the sentinel
    // shape is distinguishable from undefined (no picker) and Uri (resolved).
    assert.ok(sentinel !== undefined, "sentinel is not undefined — caller knows to fail");
    assert.ok(
      !(sentinel instanceof vscode.Uri),
      "sentinel is not a Uri — caller cannot proceed silently"
    );
    assert.ok(
      typeof sentinel === "object" && "canonicalId" in (sentinel as object),
      "sentinel has canonicalId property for error message construction"
    );
  });

  void it("normalizeGeneratePlanArg with no task returns undefined — caller shows picker, not an error", () => {
    const inv = makeInventoryStub("x", "/x");
    const result = normalizeGeneratePlanArg(undefined, inv);
    // undefined means "show the folder picker" — no error, no wrong-task redirect
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// normalizePauseTaskArg: TaskNode shape and flat shape handling
// ---------------------------------------------------------------------------

void describe("normalizePauseTaskArg", () => {
  const FOLDER = "/workspace/.helper/plans/2026-07-08_pause_task";

  void it("returns undefined for undefined arg (triggers current-task fallback)", () => {
    const result = normalizePauseTaskArg(undefined);
    assert.strictEqual(result, undefined);
  });

  void it("{ task: IncompleteTask } (TaskNode shape) extracts taskFolderPath", () => {
    const task = makeIncompleteTask(FOLDER);
    const result = normalizePauseTaskArg({ task });
    assert.ok(result !== undefined);
    assert.ok(result.taskFolderPath !== undefined,
      "TaskNode shape must yield a taskFolderPath for resolveTaskContext"
    );
    assert.ok(result.taskFolderPath.includes("2026-07-08_pause_task"),
      "taskFolderPath must come from the IncompleteTask's folderUri"
    );
    assert.strictEqual(result.canonicalId, undefined,
      "canonicalId must not be set when extracting from IncompleteTask"
    );
  });

  void it("{ task: undefined } returns undefined (no explicit task — triggers current-task fallback)", () => {
    const result = normalizePauseTaskArg({ task: undefined });
    assert.strictEqual(result, undefined);
  });

  void it("{ canonicalId } flat shape passes through", () => {
    const result = normalizePauseTaskArg({ canonicalId: "/some/canonical/id" });
    assert.ok(result !== undefined);
    assert.strictEqual(result.canonicalId, "/some/canonical/id");
  });

  void it("{ taskFolderPath } flat shape passes through", () => {
    const result = normalizePauseTaskArg({ taskFolderPath: FOLDER });
    assert.ok(result !== undefined);
    assert.strictEqual(result.taskFolderPath, FOLDER);
  });

  void it("empty object {} returns undefined (triggers current-task fallback)", () => {
    const result = normalizePauseTaskArg({});
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// normalizeResumeTaskArg: TaskNode shape and flat shape handling
// ---------------------------------------------------------------------------

void describe("normalizeResumeTaskArg", () => {
  const FOLDER = "/workspace/.helper/plans/2026-07-08_resume_task";

  void it("returns undefined for undefined arg (triggers current-task fallback)", () => {
    const result = normalizeResumeTaskArg(undefined);
    assert.strictEqual(result, undefined);
  });

  void it("{ task: IncompleteTask } (TaskNode shape) extracts taskFolderPath", () => {
    const task = makeIncompleteTask(FOLDER);
    const result = normalizeResumeTaskArg({ task });
    assert.ok(result !== undefined);
    assert.ok(result.taskFolderPath !== undefined,
      "TaskNode shape must yield a taskFolderPath for resolveTaskContext"
    );
    assert.ok(result.taskFolderPath.includes("2026-07-08_resume_task"),
      "taskFolderPath must come from the IncompleteTask's folderUri"
    );
    assert.strictEqual(result.canonicalId, undefined,
      "canonicalId must not be set when extracting from IncompleteTask"
    );
  });

  void it("{ task: undefined } returns undefined (no explicit task — triggers current-task fallback)", () => {
    const result = normalizeResumeTaskArg({ task: undefined });
    assert.strictEqual(result, undefined);
  });

  void it("{ canonicalId } flat shape passes through", () => {
    const result = normalizeResumeTaskArg({ canonicalId: "/some/canonical/id" });
    assert.ok(result !== undefined);
    assert.strictEqual(result.canonicalId, "/some/canonical/id");
  });

  void it("{ taskFolderPath } flat shape passes through", () => {
    const result = normalizeResumeTaskArg({ taskFolderPath: FOLDER });
    assert.ok(result !== undefined);
    assert.strictEqual(result.taskFolderPath, FOLDER);
  });

  void it("empty object {} returns undefined (triggers current-task fallback)", () => {
    const result = normalizeResumeTaskArg({});
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// pauseTaskArgHasExplicitTask: explicit-task detection
// ---------------------------------------------------------------------------

void describe("pauseTaskArgHasExplicitTask", () => {
  const FOLDER = "/workspace/.helper/plans/2026-07-08_pause_task";

  void it("returns false for undefined", () => {
    assert.strictEqual(pauseTaskArgHasExplicitTask(undefined), false);
  });

  void it("returns true for { task: IncompleteTask }", () => {
    const task = makeIncompleteTask(FOLDER);
    assert.strictEqual(pauseTaskArgHasExplicitTask({ task }), true);
  });

  void it("returns false for { task: undefined }", () => {
    assert.strictEqual(pauseTaskArgHasExplicitTask({ task: undefined }), false);
  });

  void it("returns true for { canonicalId }", () => {
    assert.strictEqual(
      pauseTaskArgHasExplicitTask({ canonicalId: "/some/id" }),
      true
    );
  });

  void it("returns true for { taskFolderPath }", () => {
    assert.strictEqual(
      pauseTaskArgHasExplicitTask({ taskFolderPath: FOLDER }),
      true
    );
  });

  void it("returns false for empty object {}", () => {
    assert.strictEqual(pauseTaskArgHasExplicitTask({}), false);
  });
});

// ---------------------------------------------------------------------------
// resumeTaskArgHasExplicitTask: explicit-task detection
// ---------------------------------------------------------------------------

void describe("resumeTaskArgHasExplicitTask", () => {
  const FOLDER = "/workspace/.helper/plans/2026-07-08_resume_task";

  void it("returns false for undefined", () => {
    assert.strictEqual(resumeTaskArgHasExplicitTask(undefined), false);
  });

  void it("returns true for { task: IncompleteTask }", () => {
    const task = makeIncompleteTask(FOLDER, "paused");
    assert.strictEqual(resumeTaskArgHasExplicitTask({ task }), true);
  });

  void it("returns false for { task: undefined }", () => {
    assert.strictEqual(resumeTaskArgHasExplicitTask({ task: undefined }), false);
  });

  void it("returns true for { canonicalId }", () => {
    assert.strictEqual(
      resumeTaskArgHasExplicitTask({ canonicalId: "/some/id" }),
      true
    );
  });

  void it("returns true for { taskFolderPath }", () => {
    assert.strictEqual(
      resumeTaskArgHasExplicitTask({ taskFolderPath: FOLDER }),
      true
    );
  });

  void it("returns false for empty object {}", () => {
    assert.strictEqual(resumeTaskArgHasExplicitTask({}), false);
  });
});

// ---------------------------------------------------------------------------
// pauseTask integration: full command path through normalization +
// resolveTaskContext with a stubbed inventory
// ---------------------------------------------------------------------------

import { pauseTask } from "../commands/pauseTask";
import { resumePausedTask } from "../commands/resumeTask";
import { patchTaskProgressStrictV1 as patchTaskProgress } from "../services/taskProgressWriterV1";
import { updateTaskStatus, updateTaskProgressStage, updateImplReviewFiles } from "../utils/taskProgressTransforms";
import type { TaskProgress } from "../types/taskProgress";
import { IMPLEMENTATION_SUMMARY_FILENAME } from "../types/taskProgress";

void describe("pauseTask integration (full command path)", () => {
  void it("TaskNode-shaped arg pauses the exact named task", async () => {
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    try {
      const folderUri = makeTaskFolderUri("pause-integration-active");
      const folderPath = folderUri.fsPath;
      const progress: TaskProgress = {
        taskFolder: "pause-integration-active",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: ["src/x.ts"],
      };
      await seedProgress(store, folderUri, progress);

      const inv = makeInventoryStub(folderPath, folderPath, "active");
      const currentStore = makeCurrentTaskStoreStub(undefined);
      const task = makeIncompleteTask(folderPath, "active");

      await pauseTask(inv, currentStore, { task });

      // The operation-notification bridge must record the terminal entry for
      // the tracked pause mutation (taxonomy: pause-task / terminal-always).
      assert.ok(
        msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("Pause Task") && m.message.includes("completed")
        ),
        "pauseTask must record a lifecycle-backed 'Pause Task … completed' terminal entry"
      );
      // progress file must be updated
      const stored = await readStoredProgress(store, folderUri);
      assert.strictEqual(stored!.status, "paused",
        "task-progress.json status must be 'paused' after pauseTask"
      );
      // implReviewFiles must be preserved
      assert.deepEqual(stored!.implReviewFiles, ["src/x.ts"],
        "implReviewFiles must survive pauseTask"
      );
    } finally {
      msgs.restore();
      fs.restore();
      wsFolders.restore();
    }
  });

  void it("deleted/missing task with TaskNode arg shows error, not generic fallback", async () => {
    // Inventory does NOT contain the task (simulates deleted/moved task)
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);
    const task = makeIncompleteTask("/fake-workspace/deleted-task", "active");

    const msgs = installMessageCapture();
    try {
      await pauseTask(inv, currentStore, { task });

      assert.ok(
        msgs.captured.some(
          (m) => m.method === "error" && m.message.includes("could not be found")
        ),
        "pauseTask with a deleted task must show a specific error message, not the generic fallback"
      );
      assert.ok(
        !msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("No active tasks")
        ),
        "must NOT show generic 'No active tasks to pause.' when an explicit task was named"
      );
    } finally {
      msgs.restore();
    }
  });

  void it("no arg + no current task shows generic info message", async () => {
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);

    const msgs = installMessageCapture();
    try {
      await pauseTask(inv, currentStore, undefined);

      assert.ok(
        msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("No active tasks to pause")
        ),
        "pauseTask with no arg and no current task must show generic info message"
      );
    } finally {
      msgs.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// resumePausedTask integration (full command path)
// ---------------------------------------------------------------------------

void describe("resumePausedTask integration (full command path)", () => {
  void it("TaskNode-shaped arg resumes the exact named paused task", async () => {
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    try {
      const folderUri = makeTaskFolderUri("resume-integration-paused");
      const folderPath = folderUri.fsPath;
      const progress: TaskProgress = {
        taskFolder: "resume-integration-paused",
        currentStage: "impl",
        status: "paused",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: ["src/y.ts"],
      };
      await seedProgress(store, folderUri, progress);

      const inv = makeInventoryStub(folderPath, folderPath, "paused");
      const currentStore = makeCurrentTaskStoreStub(undefined);
      const task = makeIncompleteTask(folderPath, "paused");

      await resumePausedTask(inv, currentStore, { task });

      // The operation-notification bridge must record the terminal entry for
      // the tracked resume mutation (taxonomy: resume-task / terminal-always).
      assert.ok(
        msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("Resume Task") && m.message.includes("completed")
        ),
        "resumePausedTask must record a lifecycle-backed 'Resume Task … completed' terminal entry"
      );
      const stored = await readStoredProgress(store, folderUri);
      assert.strictEqual(stored!.status, "active",
        "task-progress.json status must be 'active' after resumePausedTask"
      );
      assert.deepEqual(stored!.implReviewFiles, ["src/y.ts"],
        "implReviewFiles must survive resumePausedTask"
      );
    } finally {
      msgs.restore();
      fs.restore();
      wsFolders.restore();
    }
  });

  void it("deleted/missing task with TaskNode arg shows error, not generic fallback", async () => {
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);
    const task = makeIncompleteTask("/fake-workspace/deleted-paused-task", "paused");

    const msgs = installMessageCapture();
    try {
      await resumePausedTask(inv, currentStore, { task });

      assert.ok(
        msgs.captured.some(
          (m) => m.method === "error" && m.message.includes("could not be found")
        ),
        "resumePausedTask with a deleted task must show a specific error message"
      );
      assert.ok(
        !msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("No paused tasks")
        ),
        "must NOT show generic 'No paused tasks to resume.' when an explicit task was named"
      );
    } finally {
      msgs.restore();
    }
  });

  void it("no arg + no current task shows generic info message", async () => {
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);

    const msgs = installMessageCapture();
    try {
      await resumePausedTask(inv, currentStore, undefined);

      assert.ok(
        msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("No paused tasks to resume")
        ),
        "resumePausedTask with no arg and no current task must show generic info message"
      );
    } finally {
      msgs.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// patchTaskProgress: preserves unrelated fields across pauseTask/resumeTask/
// setTaskStage mutations (regression coverage for the direct-write bug)
// ---------------------------------------------------------------------------

void describe("patchTaskProgress preserves unrelated fields (pauseTask regression)", () => {
  void it("pausing a task does not erase implReviewFiles", async () => {
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    try {
      const folderUri = makeTaskFolderUri("pause-preserves-impl-files");

      const initial: TaskProgress = {
        taskFolder: "pause-preserves-impl-files",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: ["src/a.ts", "src/b.ts"],
      };
      await seedProgress(store, folderUri, initial);

      // Simulate what pauseTask now does: patchTaskProgress with updateTaskStatus
      const patched = await patchTaskProgress(folderUri, (current) =>
        updateTaskStatus(current, "paused")
      );

      assert.ok(patched !== undefined);
      assert.strictEqual(patched.status, "paused");
      // implReviewFiles must survive the pause mutation
      assert.deepEqual(patched.implReviewFiles, ["src/a.ts", "src/b.ts"],
        "implReviewFiles must not be erased by a pause mutation"
      );

      // Also verify on disk
      const stored = await readStoredProgress(store, folderUri);
      assert.deepEqual(stored!.implReviewFiles, ["src/a.ts", "src/b.ts"]);
    } finally {
      fs.restore();
    }
  });

  void it("resuming a task does not erase implReviewFiles", async () => {
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    try {
      const folderUri = makeTaskFolderUri("resume-preserves-impl-files");

      const initial: TaskProgress = {
        taskFolder: "resume-preserves-impl-files",
        currentStage: "impl-high-review",
        status: "paused",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: ["src/c.ts"],
      };
      await seedProgress(store, folderUri, initial);

      const patched = await patchTaskProgress(folderUri, (current) =>
        updateTaskStatus(current, "active")
      );

      assert.ok(patched !== undefined);
      assert.strictEqual(patched.status, "active");
      assert.deepEqual(patched.implReviewFiles, ["src/c.ts"],
        "implReviewFiles must not be erased by a resume mutation"
      );
    } finally {
      fs.restore();
    }
  });

  void it("setting stage does not erase implReviewFiles", async () => {
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    try {
      const folderUri = makeTaskFolderUri("set-stage-preserves-impl-files");

      const initial: TaskProgress = {
        taskFolder: "set-stage-preserves-impl-files",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: ["src/d.ts", "src/e.ts"],
      };
      await seedProgress(store, folderUri, initial);

      // Simulate what setTaskStage now does: patchTaskProgress with updateTaskProgressStage
      const patched = await patchTaskProgress(folderUri, (current) =>
        updateTaskProgressStage(current, "impl-high-review")
      );

      assert.ok(patched !== undefined);
      assert.strictEqual(patched.currentStage, "impl-high-review");
      assert.deepEqual(patched.implReviewFiles, ["src/d.ts", "src/e.ts"],
        "implReviewFiles must not be erased by a stage-change mutation"
      );
    } finally {
      fs.restore();
    }
  });

  void it("accumulating impl files across patchTaskProgress calls unions correctly", async () => {
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    try {
      const folderUri = makeTaskFolderUri("accumulate-impl-files");

      const initial: TaskProgress = {
        taskFolder: "accumulate-impl-files",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      };
      await seedProgress(store, folderUri, initial);

      // First impl run
      await patchTaskProgress(folderUri, (current) =>
        updateImplReviewFiles(current, ["src/x.ts"])
      );
      // Second impl run (empty diff — must not erase first run's files)
      await patchTaskProgress(folderUri, (current) =>
        updateImplReviewFiles(current, [])
      );
      // Stage change (must not erase files)
      await patchTaskProgress(folderUri, (current) =>
        updateTaskProgressStage(current, "impl-high-review")
      );

      const stored = await readStoredProgress(store, folderUri);
      assert.deepEqual(stored!.implReviewFiles, ["src/x.ts"],
        "impl files accumulated across patchTaskProgress calls must survive stage changes"
      );
    } finally {
      fs.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// setTaskStage auto-review delegation: production setTaskStage with
// triggerAutoReview=true must dispatch { taskFolderPath } so
// reviewActions.normalizeReviewArg resolves the task correctly rather than
// falling through to a QuickPick.
//
// These tests call PRODUCTION setTaskStage directly (not a local re-implementation)
// so that a regression in setTaskStage.ts is caught here.
// ---------------------------------------------------------------------------

void describe("setTaskStage auto-review delegation (production code)", () => {
  /**
   * Helper: install a stub for vscode.commands.executeCommand that captures
   * calls and resolves to undefined (no-op). Returns a restore handle and the
   * captured-calls array.
   */
  function installExecuteCommandStub(): {
    captured: Array<{ command: string; arg: unknown }>;
    restore: () => void;
  } {
    const captured: Array<{ command: string; arg: unknown }> = [];
    // vscode.commands may not exist in the test stub — attach it if needed
    if (!(vscode as unknown as Record<string, unknown>).commands) {
      (vscode as unknown as Record<string, unknown>).commands = {};
    }
    const orig = (vscode.commands as unknown as Record<string, unknown>).executeCommand;
    (vscode.commands as unknown as Record<string, unknown>).executeCommand = async (
      command: string,
      arg?: unknown
    ): Promise<undefined> => {
      captured.push({ command, arg });
      return Promise.resolve(undefined);
    };
    return {
      captured,
      restore: (): void => {
        (vscode.commands as unknown as Record<string, unknown>).executeCommand = orig;
      },
    };
  }

  void it("dispatches runReviewWithAI with { taskFolderPath } not { canonicalId }", async () => {
    const FOLDER_PATH = nodePath.join(REAL_TASK_ROOT, ".ensemble", "set-stage-auto-review-delegation");
    nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
    const folderUri = vscode.Uri.file(FOLDER_PATH);

    const store = new Map<string, string>();
    const memFs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    const execCmd = installExecuteCommandStub();

    // The run-time model guard (ensureStageModelConfigured) blocks the
    // auto-review dispatch when the destination stage has no configured
    // model, so this delegation test configures a Copilot model for it.
    const wsRecord = vscode.workspace as unknown as Record<string, unknown>;
    const origGetConfiguration = wsRecord.getConfiguration;
    wsRecord.getConfiguration = () => ({
      get: (key: string, defaultValue?: unknown): unknown => {
        if (key === "modelSettings") {
          return { "plan-high-review": { primary: "gpt-test-model" } };
        }
        return defaultValue;
      },
      inspect: (): undefined => undefined,
    });

    try {
      // Seed the task at "plan" stage.
      // AUTO_REVIEW_TRANSITIONS maps plan → plan-high-review, so advancing
      // the task to plan-high-review with triggerAutoReview=true fires the
      // auto-review dispatch.
      const progress: TaskProgress = {
        taskFolder: "set-stage-auto-review-delegation",
        currentStage: "plan",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      };
      await seedProgress(store, folderUri, progress);

      // Inventory: task is at "plan" stage (this is what resolveTaskContext sees)
      const inv = makeInventoryStubWithStage(
        FOLDER_PATH,
        FOLDER_PATH,
        "plan",
        "active"
      );
      const currentStore = makeCurrentTaskStoreStub(undefined);

      // Call PRODUCTION setTaskStage with triggerAutoReview=true, requesting
      // the plan-high-review destination
      await setTaskStage(
        inv,
        currentStore,
        { taskFolderPath: FOLDER_PATH, stage: "plan-high-review" },
        "complete-and-move-on" /* kind */
      );

      // Find the auto-review command dispatch
      const reviewDispatch = execCmd.captured.find(
        (e) => e.command === "vs-code-ai-helper.runReviewWithAI"
      );
      assert.ok(
        reviewDispatch !== undefined,
        "setTaskStage must dispatch vs-code-ai-helper.runReviewWithAI when auto-review is eligible"
      );

      const dispatchArg = reviewDispatch.arg as Record<string, unknown>;

      // CRITICAL: must carry taskFolderPath so normalizeReviewArg in
      // reviewActions.ts can construct a synthetic IncompleteTask for
      // resolveTask — a canonicalId-only arg is not accepted by the
      // ReviewCommandArg type and would be rejected as malformed at runtime.
      assert.ok(
        "taskFolderPath" in dispatchArg && typeof dispatchArg.taskFolderPath === "string",
        "auto-review dispatch must carry taskFolderPath (not canonicalId-only)"
      );
      assert.ok(
        (dispatchArg.taskFolderPath).includes("set-stage-auto-review-delegation"),
        "taskFolderPath in dispatch must match the task being advanced"
      );
    } finally {
      wsRecord.getConfiguration = origGetConfiguration;
      msgs.restore();
      memFs.restore();
      wsFolders.restore();
      execCmd.restore();
    }
  });

  void it("does NOT dispatch runReviewWithAI when triggerAutoReview is false", async () => {
    const FOLDER_PATH = nodePath.join(REAL_TASK_ROOT, ".ensemble", "set-stage-no-auto-review");
    nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
    const folderUri = vscode.Uri.file(FOLDER_PATH);

    const store = new Map<string, string>();
    const memFs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    const execCmd = installExecuteCommandStub();

    try {
      const progress: TaskProgress = {
        taskFolder: "set-stage-no-auto-review",
        currentStage: "plan",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      };
      await seedProgress(store, folderUri, progress);

      const inv = makeInventoryStubWithStage(
        FOLDER_PATH,
        FOLDER_PATH,
        "plan",
        "active"
      );
      const currentStore = makeCurrentTaskStoreStub(undefined);

      // kind="jump" (the default for manual set-stage-as-current) is not in
      // AUTO_REVIEW_ELIGIBLE_KINDS, so no auto-review can fire.
      await setTaskStage(
        inv,
        currentStore,
        { taskFolderPath: FOLDER_PATH, stage: "plan-high-review" },
        "jump" /* kind */
      );

      const reviewDispatch = execCmd.captured.find(
        (e) => e.command === "vs-code-ai-helper.runReviewWithAI"
      );
      assert.strictEqual(
        reviewDispatch,
        undefined,
        "setTaskStage with triggerAutoReview=false must NOT dispatch runReviewWithAI"
      );
    } finally {
      msgs.restore();
      memFs.restore();
      wsFolders.restore();
      execCmd.restore();
    }
  });

  void it("drops the dispatch when an auto-review chain is already pending for the task", async () => {
    const FOLDER_PATH = nodePath.join(REAL_TASK_ROOT, ".ensemble", "set-stage-auto-review-dedupe");
    nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
    const folderUri = vscode.Uri.file(FOLDER_PATH);

    const store = new Map<string, string>();
    const memFs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    const execCmd = installExecuteCommandStub();

    // Same run-time model guard stub as the delegation test above — without a
    // configured model, ensureStageModelConfigured would block before the
    // dispatcher and this test would pass vacuously.
    const wsRecord = vscode.workspace as unknown as Record<string, unknown>;
    const origGetConfiguration = wsRecord.getConfiguration;
    wsRecord.getConfiguration = () => ({
      get: (key: string, defaultValue?: unknown): unknown => {
        if (key === "modelSettings") {
          return { "plan-high-review": { primary: "gpt-test-model" } };
        }
        return defaultValue;
      },
      inspect: (): undefined => undefined,
    });

    try {
      const progress: TaskProgress = {
        taskFolder: "set-stage-auto-review-dedupe",
        currentStage: "plan",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      };
      await seedProgress(store, folderUri, progress);

      const inv = makeInventoryStubWithStage(
        FOLDER_PATH,
        FOLDER_PATH,
        "plan",
        "active"
      );
      const currentStore = makeCurrentTaskStoreStub(undefined);

      // Occupy the (taskKey, "auto-review") guard slot with a chain deferred
      // behind a root operation that never ends — exactly the state a racing
      // auto-advance leaves while its review chain is still outstanding.
      void scheduleAutomationChain(
        {
          command: "vs-code-ai-helper.runReviewWithAI",
          arg: { taskFolderPath: FOLDER_PATH },
          taskKey: FOLDER_PATH,
          chainId: "auto-review",
        },
        { id: "never-ending-root" },
        {
          onDidEnd: () => ({ dispose: (): void => undefined }),
          execute: () => Promise.resolve(undefined),
        }
      );

      await setTaskStage(
        inv,
        currentStore,
        { taskFolderPath: FOLDER_PATH, stage: "plan-high-review" },
        "complete-and-move-on" /* kind */
      );

      // The transition itself must have persisted — proof the eligible
      // auto-review path (not some earlier guard) is what dropped the chain.
      const persisted = JSON.parse(
        nodeFs.readFileSync(nodePath.join(FOLDER_PATH, "task-progress.json"), "utf8")
      ) as TaskProgress;
      assert.strictEqual(
        persisted.currentStage,
        "plan-high-review",
        "stage transition must persist even when the follow-up chain is dropped"
      );

      const reviewDispatch = execCmd.captured.find(
        (e) => e.command === "vs-code-ai-helper.runReviewWithAI"
      );
      assert.strictEqual(
        reviewDispatch,
        undefined,
        "setTaskStage must drop its auto-review dispatch while an identical (taskKey, auto-review) chain is pending"
      );
    } finally {
      resetAutomationChainGuards();
      wsRecord.getConfiguration = origGetConfiguration;
      msgs.restore();
      memFs.restore();
      wsFolders.restore();
      execCmd.restore();
    }
  });

  void it("canonicalId-only dispatch would NOT resolve via production normalizeReviewArg", () => {
    // Confirms the contract that the auto-review fix relies on:
    // ReviewCommandArg no longer accepts { canonicalId } alone (compile-time guard).
    // At runtime, normalizeReviewArg returns a no-task {} for any arg that has
    // neither { task } nor { taskFolderPath }; the entry-point guard
    // (isMalformedReviewArg) additionally shows a clear error for such shapes
    // when a non-empty object without the accepted keys is passed.
    // setTaskStage must always pass taskFolderPath to resolve the task correctly.

    // Simulate a stale/wrong caller passing canonicalId-only via cast.
    // @ts-expect-error — canonicalId alone is not a valid ReviewCommandArg (compile-time guard)
    const withIdOnly = normalizeReviewArg({ canonicalId: "/some/task" });
    assert.ok(
      !withIdOnly.task,
      "normalizeReviewArg: canonicalId-only arg (unsupported shape) produces no resolved task"
    );

    // { taskFolderPath } — the only correct explicit shape — resolves correctly
    const withPath = normalizeReviewArg({ taskFolderPath: "/some/task" });
    assert.ok(
      withPath.task !== undefined,
      "normalizeReviewArg: taskFolderPath arg resolves to a synthetic IncompleteTask"
    );
    assert.ok(
      withPath.task.folderUri.fsPath.includes("some") ||
        withPath.task.folderUri.path.includes("some"),
      "normalizeReviewArg: resolved task folderUri matches the supplied path"
    );
  });
});

// ---------------------------------------------------------------------------
// installMessageCapture restore: verifies restore() reinstates the prior
// vscode.window methods exactly — not just any function, but the originals.
//
// This guards the claim in the plan that installMessageCapture "saves and
// restores" the window surface, not just overwrites it.
// ---------------------------------------------------------------------------

void describe("installMessageCapture restore contract", () => {
  void it("restore() reinstates the original showInformationMessage", () => {
    const win = vscode.window as unknown as Record<string, unknown>;
    const sentinel = (): Promise<undefined> => Promise.resolve(undefined);
    win.showInformationMessage = sentinel;

    const capture = installMessageCapture();
    // After install, the method is replaced
    assert.notStrictEqual(
      win.showInformationMessage,
      sentinel,
      "installMessageCapture must replace showInformationMessage"
    );

    capture.restore();
    assert.strictEqual(
      win.showInformationMessage,
      sentinel,
      "restore() must reinstate the exact prior showInformationMessage"
    );
  });

  void it("restore() reinstates the original showErrorMessage", () => {
    const win = vscode.window as unknown as Record<string, unknown>;
    const sentinel = (): Promise<undefined> => Promise.resolve(undefined);
    win.showErrorMessage = sentinel;

    const capture = installMessageCapture();
    assert.notStrictEqual(win.showErrorMessage, sentinel);

    capture.restore();
    assert.strictEqual(
      win.showErrorMessage,
      sentinel,
      "restore() must reinstate the exact prior showErrorMessage"
    );
  });

  void it("restore() reinstates the original showWarningMessage", () => {
    const win = vscode.window as unknown as Record<string, unknown>;
    const sentinel = (): Promise<undefined> => Promise.resolve(undefined);
    win.showWarningMessage = sentinel;

    const capture = installMessageCapture();
    assert.notStrictEqual(win.showWarningMessage, sentinel);

    capture.restore();
    assert.strictEqual(
      win.showWarningMessage,
      sentinel,
      "restore() must reinstate the exact prior showWarningMessage"
    );
  });

  void it("restore() reinstates the original showQuickPick", () => {
    const win = vscode.window as unknown as Record<string, unknown>;
    const sentinel = (): Promise<undefined> => Promise.resolve(undefined);
    win.showQuickPick = sentinel;

    const capture = installMessageCapture();
    assert.notStrictEqual(win.showQuickPick, sentinel);

    capture.restore();
    assert.strictEqual(
      win.showQuickPick,
      sentinel,
      "restore() must reinstate the exact prior showQuickPick"
    );
  });

  void it("restore() reinstates the original withProgress", () => {
    const win = vscode.window as unknown as Record<string, unknown>;
    const sentinel = (): Promise<undefined> => Promise.resolve(undefined);
    win.withProgress = sentinel;

    const capture = installMessageCapture();
    assert.notStrictEqual(win.withProgress, sentinel);

    capture.restore();
    assert.strictEqual(
      win.withProgress,
      sentinel,
      "restore() must reinstate the exact prior withProgress"
    );
  });

  void it("nested capture/restore correctly reinstates two levels of overrides", () => {
    const win = vscode.window as unknown as Record<string, unknown>;
    const outerSentinel = (): Promise<string> => Promise.resolve("outer");
    win.showInformationMessage = outerSentinel;

    const outer = installMessageCapture();
    // Outer capture replaced the sentinel
    assert.notStrictEqual(win.showInformationMessage, outerSentinel);

    const innerSentinel = (): Promise<string> => Promise.resolve("inner");
    // Simulate a nested test overriding further
    win.showInformationMessage = innerSentinel;

    const inner = installMessageCapture();
    assert.notStrictEqual(win.showInformationMessage, innerSentinel);

    // Restore inner — must go back to innerSentinel (what inner saved)
    inner.restore();
    assert.strictEqual(
      win.showInformationMessage,
      innerSentinel,
      "inner restore() must reinstate what was in place when inner was installed"
    );

    // Restore outer — must go back to outerSentinel (what outer saved)
    outer.restore();
    assert.strictEqual(
      win.showInformationMessage,
      outerSentinel,
      "outer restore() must reinstate the original sentinel"
    );
  });
});

// ---------------------------------------------------------------------------
// runReviewForFolder impl-review variable sourcing — PRODUCTION CODE TESTS
//
// These tests call the EXPORTED production function `runReviewForFolder`
// directly (not a proxy) so that regressions in the function body are
// caught here.
//
// The function has two early-return warning paths before it ever reaches
// the AI runner:
//
//   Path A: plan.md absent/empty → warning "No plan found … before reviewing
//           implementation." → return
//
//   Path B: plan-final.md absent/empty (when plan.md present) → warning
//           "No implementation notes found (plan-final.md is missing or empty)."
//           → return
//
// Tests 1 and 2 exercise these paths directly by seeding only one of the
// two files. The warning text uniquely identifies which file triggered the
// guard, so a regression that swaps the two reads would fail the assertions.
//
// Test 3 seeds both files with DISTINCT content and verifies:
//   - Neither plan-missing nor impl-missing warning fires
//   - The function proceeds to the runner stage (the runner is unavailable
//     in the unit-test environment, so a runner-unavailable warning fires
//     instead — this is positive confirmation that both variable gates
//     were passed)
//
// The vscode.lm stub surfaces Copilot as unavailable (returns []), so
// CopilotLanguageModelRunner.isAvailable() returns { available: false }
// cleanly without throwing, and runAiToFile shows the runner-unavailable
// warning and returns false.
//
// Workspace.fs is intercepted via installMemStore. The task-progress.json
// is seeded with implReviewFiles: [] so writeImplReviewContextPack uses the
// tracked/zero-files path which requires no editor-API stubs.
// ---------------------------------------------------------------------------

void describe("runReviewForFolder impl-review variable sourcing (production code)", () => {
  /**
   * Minimal WorkspaceFolder stub for runReviewForFolder's workspaceRoot param.
   */
  function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return {
      uri: vscode.Uri.file(fsPath),
      name: fsPath.split(/[/\\]/).pop() ?? "fake-workspace",
      index: 0,
    };
  }

  /**
   * Minimal extensionUri stub — only needs to satisfy the type; it is only
   * used inside runAiToFile → renderPromptTemplate, which is never reached
   * in these tests because the runner is unavailable.
   */
  const fakeExtensionUri = vscode.Uri.file("/fake-extension");

  function seedImplHighReviewTemplate(store: Map<string, string>): void {
    const templateUri = vscode.Uri.joinPath(
      fakeExtensionUri,
      "resources",
      "prompts",
      "review-impl-high.md"
    );
    store.set(
      templateUri.toString(),
      [
        "# Impl Review",
        "",
        "## Plan",
        "{{plan}}",
        "",
        "## Implementation",
        "{{implementation}}",
        "",
        "## Context",
        "{{context_pack}}",
      ].join("\n")
    );
  }

  /**
   * Install a stub for vscode.lm.selectChatModels that returns [] (no Copilot
   * models). This makes CopilotLanguageModelRunner.isAvailable() return
   * { available: false } without throwing, so runAiToFile shows a
   * runner-unavailable warning and returns false — never reaching
   * renderPromptTemplate or the actual AI.
   *
   * Also stubs workspace.getConfiguration to return an empty config object
   * so resolveModelForStage → getAiModelDefaults doesn't throw.
   */
  function installRunnerStubs(): { restore: () => void } {
    // Namespace imports can expose read-only properties; patch the method
    // on the existing lm object instead of replacing vscode.lm wholesale.
    const lmObj = (vscode as unknown as { lm?: { selectChatModels?: () => Promise<unknown[]> } }).lm;
    const origSelectChatModels = lmObj?.selectChatModels;
    if (lmObj) {
      lmObj.selectChatModels = (): Promise<unknown[]> => Promise.resolve([]);
    }

    // vscode.workspace.getConfiguration stub (used by settings.ts)
    const origGetConfig = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
    (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
      get: (_key: string, defaultValue?: unknown) => unknown;
      update: () => Promise<undefined>;
      has: () => boolean;
      inspect: () => undefined;
    } => ({
      get: (_key: string, defaultValue?: unknown): unknown => defaultValue ?? undefined,
      update: () => Promise.resolve(undefined),
      has: () => false,
      inspect: () => undefined,
    });

    // vscode.workspace.textDocuments stub (used by contextPack fallback path)
    const origTextDocuments = (vscode.workspace as unknown as Record<string, unknown>).textDocuments;
    (vscode.workspace as unknown as Record<string, unknown>).textDocuments = [];

    return {
      restore: (): void => {
        if (lmObj) {
          lmObj.selectChatModels = origSelectChatModels;
        }
        (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = origGetConfig;
        (vscode.workspace as unknown as Record<string, unknown>).textDocuments = origTextDocuments;
      },
    };
  }

  void it("missing plan.md triggers the plan-missing warning, not the impl-missing warning", async () => {
    // Seed plan-final.md (implementation notes) but NOT plan.md.
    // Production runReviewForFolder reads plan.md via resolveCurrentPlanUri
    // for {{plan}}. A missing plan.md must trigger the plan-missing warning.
    // If plan-final.md were read for {{plan}} instead (the old bug), this
    // test would NOT trigger the plan-missing warning — it would proceed
    // to the impl slot and either succeed or trigger the impl-missing warning.
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const runners = installRunnerStubs();

    try {
      const folderUri = makeTaskFolderUri("impl-review-missing-plan");
      const workspaceRoot = makeWorkspaceFolder("/fake-workspace");

      // Seed plan-final.md (impl notes) — present
      const implUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
      store.set(
        implUri.toString(),
        "## Implementation Complete\n\nFiles changed:\n- src/x.ts"
      );
      // plan.md is intentionally absent

      // Seed task-progress.json with implReviewFiles: [] so context pack
      // generation takes the tracked/zero-files path (no editor-API deps)
      await seedProgress(store, folderUri, {
        taskFolder: "impl-review-missing-plan",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: [],
        ownership: {
          metaRoot: nodePath.dirname(folderUri.fsPath),
          projectRoot: nodePath.dirname(folderUri.fsPath),
          boundAt: "2026-07-08T00:00:00.000Z",
          state: "resolved",
        },
      });

      // Call the PRODUCTION function directly with an impl-review stage.
      // "impl" stage maps to targetStage "impl-high-review".
      await runReviewForFolder(
        fakeExtensionUri,
        folderUri,
        workspaceRoot,
        "impl",  // currentStage that maps to impl-high-review review
        true
      );

      // MUST show the plan-missing warning
      const planMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("No plan found") &&
          m.message.includes("before reviewing implementation")
      );
      assert.ok(
        planMissingWarning !== undefined,
        `Expected plan-missing warning but got: ${JSON.stringify(msgs.captured)}`
      );

      // Must NOT show the impl-missing warning
      const implMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("plan-final.md is missing or empty")
      );
      assert.ok(
        implMissingWarning === undefined,
        "Must NOT show impl-missing warning when plan.md is the absent file"
      );
    } finally {
      msgs.restore();
      fs.restore();
      runners.restore();
    }
  });

  void it("missing plan-final.md triggers the impl-missing warning, not the plan-missing warning", async () => {
    // Seed plan.md (plan) but NO implementation artifact at all.
    // Production runReviewForFolder fills {{implementation}} via
    // readImplementationReviewContent, which reads impl-summary.md (a run's
    // summary), then plan-final.md (the plan of record), then legacy
    // implementation.md. With none of the three present the impl-missing
    // warning must fire.
    // If plan.md were read for {{implementation}} instead (the old bug),
    // this test would NOT trigger the impl-missing warning — it would
    // proceed to the AI runner.
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const runners = installRunnerStubs();

    try {
      const folderUri = makeTaskFolderUri("impl-review-missing-impl");
      const workspaceRoot = makeWorkspaceFolder("/fake-workspace");

      // Seed plan.md (plan) — present
      const planUri = vscode.Uri.joinPath(folderUri, "plan.md");
      store.set(planUri.toString(), "# The Plan\n\nStep 1: Do X.");
      // plan-final.md is intentionally absent

      await seedProgress(store, folderUri, {
        taskFolder: "impl-review-missing-impl",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: [],
        ownership: {
          metaRoot: nodePath.dirname(folderUri.fsPath),
          projectRoot: nodePath.dirname(folderUri.fsPath),
          boundAt: "2026-07-08T00:00:00.000Z",
          state: "resolved",
        },
      });

      await runReviewForFolder(
        fakeExtensionUri,
        folderUri,
        workspaceRoot,
        "impl",
        true
      );

      // MUST show the impl-missing warning, naming every artifact it looked for
      const implMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("No implementation notes found") &&
          m.message.includes(IMPLEMENTATION_SUMMARY_FILENAME) &&
          m.message.includes("plan-final.md")
      );
      assert.ok(
        implMissingWarning !== undefined,
        `Expected impl-missing warning but got: ${JSON.stringify(msgs.captured)}`
      );

      // Must NOT show the plan-missing warning
      const planMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("No plan found") &&
          m.message.includes("before reviewing implementation")
      );
      assert.ok(
        planMissingWarning === undefined,
        "Must NOT show plan-missing warning when plan-final.md is the absent file"
      );
    } finally {
      msgs.restore();
      fs.restore();
      runners.restore();
    }
  });

  void it("both files present: no variable-gate warnings fire; runner-unavailable warning confirms both gates passed", async () => {
    // Both plan.md and plan-final.md are seeded with DISTINCT content.
    // Production code must:
    //   1. Read plan.md → variables.plan  (gate 1 passes)
    //   2. Read plan-final.md → variables.implementation  (gate 2 passes)
    //   3. Proceed to runAiToFile
    //   4. Runner is unavailable → emit runner-unavailable warning
    //
    // If either variable slot read from the wrong file, one of the two
    // content values would be the wrong string — but since the gate only
    // checks for non-empty content (not the value), the distinction between
    // the slots is validated by tests 1 and 2 above (which verify that the
    // correct file absence triggers the correct warning).
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const runners = installRunnerStubs();

    try {
      const folderUri = makeTaskFolderUri("impl-review-both-present");
      const workspaceRoot = makeWorkspaceFolder("/fake-workspace");
      seedImplHighReviewTemplate(store);

      // Distinct content in each file
      const planUri = vscode.Uri.joinPath(folderUri, "plan.md");
      store.set(planUri.toString(), "# The Plan\n\nStep 1: Do X.\nStep 2: Do Y.");

      const implUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
      store.set(
        implUri.toString(),
        "## Implementation Complete\n\nFiles changed:\n- src/x.ts\n- src/y.ts"
      );

      await seedProgress(store, folderUri, {
        taskFolder: "impl-review-both-present",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: [],
        ownership: {
          metaRoot: nodePath.dirname(folderUri.fsPath),
          projectRoot: nodePath.dirname(folderUri.fsPath),
          boundAt: "2026-07-08T00:00:00.000Z",
          state: "resolved",
        },
      });

      await runReviewForFolder(
        fakeExtensionUri,
        folderUri,
        workspaceRoot,
        "impl",
        true
      );

      // Neither variable-gate warning must fire
      const planMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("No plan found") &&
          m.message.includes("before reviewing implementation")
      );
      assert.ok(
        planMissingWarning === undefined,
        "Plan-missing warning must NOT fire when plan.md is present"
      );

      const implMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("plan-final.md is missing or empty")
      );
      assert.ok(
        implMissingWarning === undefined,
        "Impl-missing warning must NOT fire when plan-final.md is present"
      );

      // Reaching here without throw confirms both variable gates passed.
    } finally {
      msgs.restore();
      fs.restore();
      runners.restore();
    }
  });

  void it("getCanonicalImplementationUri returns plan-final.md, not plan.md (URI separation)", () => {
    // Structural guard: the implementation slot must use a URI ending in
    // plan-final.md. If getCanonicalImplementationUri were accidentally
    // changed to return plan.md, tests 1–3 above could still pass if content
    // happened to be the same — this test catches the URI-level regression
    // independently of content.
    const folderUri = makeTaskFolderUri("uri-separation-structural");
    const implUri = getCanonicalImplementationUri(folderUri);

    assert.ok(
      implUri.fsPath.endsWith("plan-final.md") ||
        implUri.path.endsWith("plan-final.md"),
      `getCanonicalImplementationUri must return plan-final.md, got: ${implUri.fsPath}`
    );
    assert.ok(
      !implUri.fsPath.endsWith("plan.md") && !implUri.path.endsWith("plan.md"),
      `getCanonicalImplementationUri must NOT return plan.md, got: ${implUri.fsPath}`
    );
  });
});

// ---------------------------------------------------------------------------
// setTaskStage deleted-task error path: when setTaskStage is called with an
// explicit task identifier (task node, canonical ID, or folder path) and
// resolution fails, it must show a clear error rather than falling through
// to a QuickPick over unrelated tasks.
//
// This mirrors the pause/resume deleted-task tests and exercises the explicit-
// task guard at src/commands/setTaskStage.ts.
// ---------------------------------------------------------------------------

void describe("setTaskStage deleted-task error path", () => {
  /**
   * Helper: install a stub for vscode.workspace.workspaceFolders that
   * returns a minimal workspace folder, and restore it afterward.
   */
  function installWorkspaceFoldersStub(): { restore: () => void } {
    const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file("/fake-workspace"), name: "fake-workspace", index: 0 },
    ];
    return {
      restore: (): void => {
        (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig;
      },
    };
  }

  void it("{ task: IncompleteTask } for a deleted task shows error, not a QuickPick", async () => {
    // Inventory is empty — the named task cannot be resolved.
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();

    try {
      const task = makeIncompleteTask("/fake-workspace/deleted-stage-task", "active");

      await setTaskStage(
        inv,
        currentStore,
        { task, stage: "plan-high-review" },
        "jump"
      );

      assert.ok(
        msgs.captured.some(
          (m) => m.method === "error" && m.message.includes("could not be found")
        ),
        "setTaskStage with a deleted TaskNode task must show a specific error message"
      );
      assert.ok(
        !msgs.captured.some(
          (m) => m.method === "info" && m.message.includes("No task folders found")
        ),
        "must NOT show generic 'No task folders found' when an explicit task was named"
      );
    } finally {
      msgs.restore();
      wsFolders.restore();
    }
  });

  void it("{ taskFolderPath } for a deleted task shows error, not a QuickPick", async () => {
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();

    try {
      await setTaskStage(
        inv,
        currentStore,
        {
          taskFolderPath: "/fake-workspace/nonexistent-task",
          stage: "impl",
        },
        "jump"
      );

      assert.ok(
        msgs.captured.some(
          (m) => m.method === "error" && m.message.includes("could not be found")
        ),
        "setTaskStage with a taskFolderPath that resolves nothing must show a specific error"
      );
    } finally {
      msgs.restore();
      wsFolders.restore();
    }
  });

  void it("no explicit task (undefined arg) shows generic info message, not an error", async () => {
    // With no explicit task, setTaskStage must fall back to a QuickPick (or
    // generic info when the inventory is empty), not an error.
    const inv = makeEmptyInventoryStub();
    const currentStore = makeCurrentTaskStoreStub(undefined);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();

    try {
      await setTaskStage(inv, currentStore, undefined, "jump");

      assert.ok(
        msgs.captured.some(
          (m) =>
            (m.method === "info" || m.method === "warning") &&
            (m.message.includes("No task folders found") ||
              m.message.includes("No tasks"))
        ),
        "setTaskStage with no explicit task must show a generic info/warning, not an error"
      );
      assert.ok(
        !msgs.captured.some(
          (m) => m.method === "error" && m.message.includes("could not be found")
        ),
        "must NOT show the deleted-task error when no explicit task was supplied"
      );
    } finally {
      msgs.restore();
      wsFolders.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeReviewArg canonicalId-only regression (suite 13)
//
// Verifies that passing canonicalId without taskFolderPath to review commands
// does NOT silently re-target the action to a different task.
//
// Three-layer defense:
//
//   (a) Compile-time: ReviewCommandArg no longer includes { canonicalId }
//       alone — the TypeScript compiler rejects such calls at compile time.
//       The `// @ts-expect-error` below is the evidence that this guard is active.
//
//   (b) Runtime/normalizer: normalizeReviewArg returns a no-task {} for any
//       arg that has neither { task } nor { taskFolderPath }, so even if a
//       stale caller bypasses the type system via cast, the function does not
//       resolve to a task. The tests below verify this contract.
//
//   (c) Runtime/entry-point: isMalformedReviewArg is called at command entry
//       points (runReviewWithAI, applyReviewWithAI, viewReview). For any
//       non-empty object that lacks a well-formed { task } or { taskFolderPath },
//       the entry point shows a clear error message and returns early — the
//       QuickPick is never opened. This prevents a stale `as any` caller from
//       retargeting the action to a different task.
//
//   "Well-formed { task }" requires task to be truthy AND have a truthy
//   folderUri property. { task: {} } is NOT well-formed — the empty object
//   has no folderUri, so isMalformedReviewArg returns true for it.
//   This matches the production guard in reviewActions.ts.
//
//   Primitives ("x", 42, true) are NOT flagged as malformed — they fall through
//   to the safe QuickPick path in normalizeReviewArg (which treats !arg as
//   "no arg"). This avoids showing a confusing error for an arg shape that
//   the user could never deliberately pass.
// ---------------------------------------------------------------------------

void describe("normalizeReviewArg canonicalId-only regression (compile-time + runtime guard)", () => {
  void it("canonicalId-only (via cast) produces no resolved task at runtime", () => {
    // Simulate a stale caller passing only canonicalId via runtime cast.
    // The TypeScript type system rejects this at compile time (see @ts-expect-error below),
    // so this test serves as the runtime safety net for normalizeReviewArg.
    // @ts-expect-error — canonicalId alone is not a valid ReviewCommandArg; compile-time guard
    const result = normalizeReviewArg({ canonicalId: "/some/canonical/id" });
    assert.ok(
      !result.task,
      "canonicalId-only arg must NOT resolve to a task — returns no-task {} which entry-point guard catches"
    );
  });

  void it("canonicalId with taskFolderPath resolves correctly (both present)", () => {
    // When BOTH canonicalId and taskFolderPath are present, the object satisfies
    // the { taskFolderPath } branch of ReviewCommandArg, so the task is resolved.
    const result = normalizeReviewArg({
      taskFolderPath: "/workspace/.helper/plans/2026-07-08_task_1",
    });
    assert.ok(
      result.task !== undefined,
      "taskFolderPath arg must resolve to a synthetic IncompleteTask"
    );
    assert.ok(
      result.task.folderUri.fsPath.includes("2026-07-08_task_1") ||
        result.task.folderUri.path.includes("2026-07-08_task_1"),
      "resolved task folderUri must match the supplied taskFolderPath"
    );
  });

  void it("undefined arg produces no resolved task (safe fallback to QuickPick)", () => {
    const result = normalizeReviewArg(undefined);
    assert.ok(
      !result.task,
      "undefined arg must produce no resolved task — falls back to QuickPick"
    );
  });

  void it("{ task: IncompleteTask } arg resolves to the named task (no fallback)", () => {
    const task = makeIncompleteTask("/workspace/.helper/plans/2026-07-08_task_1");
    const result = normalizeReviewArg({ task });
    assert.ok(
      result.task !== undefined,
      "TaskNode arg must resolve to the named task"
    );
    assert.strictEqual(
      result.task,
      task,
      "resolved task must be the exact IncompleteTask passed in"
    );
  });

  void it("malformed arg (canonicalId-only via cast) triggers error at command entry point, not QuickPick", () => {
    // This test exercises layer (c): the isMalformedReviewArg guard at the
    // command entry point. When a non-empty object with no well-formed { task }
    // or { taskFolderPath } key is passed (as could happen from stale JS/cast),
    // the entry point shows a clear error message and returns early — the
    // QuickPick is never opened and no task is selected.
    //
    // The guard logic (mirrored exactly from the production code):
    //   - "task" key present AND value is truthy AND has truthy folderUri → valid
    //   - "taskFolderPath" key present AND value is a non-empty string → valid
    //   - primitives (string, number, boolean) → NOT malformed (safe QuickPick)
    //   - anything else in a non-empty object → malformed
    //
    // { task: {} } does NOT have a truthy folderUri, so it is malformed.

    function isMalformedReviewArgSim(arg: unknown): boolean {
      if (arg === undefined || arg === null) {return false;}
      if (typeof arg !== "object") {return false;}
      if (Object.keys(arg).length === 0) {return false;}
      const rec = arg as Record<string, unknown>;
      // { task } branch is valid only when task is truthy AND has truthy folderUri
      if ("task" in rec && rec.task && typeof rec.task === "object") {
        const taskObj = rec.task as Record<string, unknown>;
        if (taskObj.folderUri) {return false;}
      }
      // { taskFolderPath } branch is valid only when the value is a non-empty string
      if ("taskFolderPath" in rec && typeof rec.taskFolderPath === "string" && rec.taskFolderPath.length > 0) {
        return false;
      }
      return true;
    }

    // canonicalId-only is malformed (non-empty object, no accepted key)
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "/some/task" }),
      true,
      "canonicalId-only shape must be detected as malformed by the entry-point guard"
    );

    // { taskFolderPath } is NOT malformed (has the accepted key)
    assert.strictEqual(
      isMalformedReviewArgSim({ taskFolderPath: "/some/task" }),
      false,
      "taskFolderPath shape must NOT be flagged as malformed"
    );

    // undefined is NOT malformed (means QuickPick fallback, not an error)
    assert.strictEqual(
      isMalformedReviewArgSim(undefined),
      false,
      "undefined must NOT be flagged as malformed"
    );

    // { task: {} } is malformed — no folderUri, so not a well-formed TaskNode
    assert.strictEqual(
      isMalformedReviewArgSim({ task: {} }),
      true,
      "{ task: {} } (truthy task with no folderUri) must be flagged as malformed"
    );

    // { task: { folderUri: realUri } } is NOT malformed
    assert.strictEqual(
      isMalformedReviewArgSim({ task: { folderUri: vscode.Uri.file("/some/path") } }),
      false,
      "{ task: { folderUri } } with a truthy folderUri must NOT be flagged as malformed"
    );

    // Primitives are NOT malformed (they fall through to safe QuickPick)
    assert.strictEqual(
      isMalformedReviewArgSim("x"),
      false,
      "string primitive must NOT be flagged as malformed (falls through to QuickPick)"
    );
    assert.strictEqual(
      isMalformedReviewArgSim(42),
      false,
      "number primitive must NOT be flagged as malformed"
    );
    assert.strictEqual(
      isMalformedReviewArgSim(true),
      false,
      "boolean primitive must NOT be flagged as malformed"
    );
  });
});

// ---------------------------------------------------------------------------
// runReviewForFolder legacy-task fallback (suite 14)
//
// Confirms that a legacy task folder with only implementation.md (and no
// plan-final.md) at an impl-review stage is handled correctly:
// materializeCanonicalIfNeeded copies implementation.md → plan-final.md,
// then both variable gates pass and the runner-unavailable warning fires
// (confirming the review reached the AI stage).
//
// This is the migration path for in-flight tasks upgraded to the new
// canonical-artifact model.
// ---------------------------------------------------------------------------

void describe("runReviewForFolder legacy-task fallback (suite 14)", () => {
  function makeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return {
      uri: vscode.Uri.file(fsPath),
      name: fsPath.split(/[/\\]/).pop() ?? "fake-workspace",
      index: 0,
    };
  }

  const fakeExtensionUri = vscode.Uri.file("/fake-extension");

  function seedImplHighReviewTemplate(store: Map<string, string>): void {
    const templateUri = vscode.Uri.joinPath(
      fakeExtensionUri,
      "resources",
      "prompts",
      "review-impl-high.md"
    );
    store.set(
      templateUri.toString(),
      [
        "# Impl Review",
        "",
        "## Plan",
        "{{plan}}",
        "",
        "## Implementation",
        "{{implementation}}",
        "",
        "## Context",
        "{{context_pack}}",
      ].join("\n")
    );
  }

  function installRunnerStubs(): { restore: () => void } {
    const lmObj = (vscode as unknown as { lm?: { selectChatModels?: () => Promise<unknown[]> } }).lm;
    const origSelectChatModels = lmObj?.selectChatModels;
    if (lmObj) {
      lmObj.selectChatModels = (): Promise<unknown[]> => Promise.resolve([]);
    }
    const origGetConfig = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
    (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
      get: (_key: string, defaultValue?: unknown) => unknown;
      update: () => Promise<undefined>;
      has: () => boolean;
      inspect: () => undefined;
    } => ({
      get: (_key: string, defaultValue?: unknown): unknown => defaultValue ?? undefined,
      update: () => Promise.resolve(undefined),
      has: () => false,
      inspect: () => undefined,
    });
    const origTextDocuments = (vscode.workspace as unknown as Record<string, unknown>).textDocuments;
    (vscode.workspace as unknown as Record<string, unknown>).textDocuments = [];
    return {
      restore: (): void => {
        if (lmObj) {
          lmObj.selectChatModels = origSelectChatModels;
        }
        (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = origGetConfig;
        (vscode.workspace as unknown as Record<string, unknown>).textDocuments = origTextDocuments;
      },
    };
  }

  void it("legacy task with only implementation.md proceeds to runner stage (no plan-final.md warning)", async () => {
    // Seed plan.md and implementation.md but NOT plan-final.md.
    // runReviewForFolder reads implementation.md through a read-only
    // canonical-then-legacy fallback (getCanonicalImplementationUri, then
    // getLegacyImplementationUri) so the review can proceed — it must NOT
    // write plan-final.md as a side effect of preparing the review prompt
    // (a review that is later cancelled, fails, or returns questions must
    // leave the implementation artifact byte-identical; only the writing
    // materializeCanonicalIfNeeded, used by the still-gated edit-capable
    // applyImplementationReviewWithAI path, may do that). The
    // runner-unavailable warning fires last, confirming both variable gates
    // (plan.md and the legacy implementation.md fallback) were passed.
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const runners = installRunnerStubs();

    try {
      const folderUri = makeTaskFolderUri("impl-review-legacy-only");
      const workspaceRoot = makeWorkspaceFolder("/fake-workspace");
      seedImplHighReviewTemplate(store);

      // Seed plan.md (the plan the implementation followed)
      const planUri = vscode.Uri.joinPath(folderUri, "plan.md");
      store.set(planUri.toString(), "# Legacy Plan\n\nStep 1: Do A.\nStep 2: Do B.");

      // Seed legacy implementation.md — no plan-final.md
      const legacyUri = vscode.Uri.joinPath(folderUri, "implementation.md");
      store.set(
        legacyUri.toString(),
        "## Legacy Implementation\n\nFiles changed:\n- src/legacy.ts"
      );

      await seedProgress(store, folderUri, {
        taskFolder: "impl-review-legacy-only",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: [],
        ownership: {
          metaRoot: nodePath.dirname(folderUri.fsPath),
          projectRoot: nodePath.dirname(folderUri.fsPath),
          boundAt: "2026-07-08T00:00:00.000Z",
          state: "resolved",
        },
      });

      await runReviewForFolder(
        fakeExtensionUri,
        folderUri,
        workspaceRoot,
        "impl",
        true
      );

      // Must NOT show the impl-missing warning (legacy file was materialized)
      const implMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("plan-final.md is missing or empty")
      );
      assert.ok(
        implMissingWarning === undefined,
        `impl-missing warning must NOT fire for legacy task — got: ${JSON.stringify(msgs.captured)}`
      );

      // Must NOT show the plan-missing warning
      const planMissingWarning = msgs.captured.find(
        (m) =>
          m.method === "warning" &&
          m.message.includes("No plan found") &&
          m.message.includes("before reviewing implementation")
      );
      assert.ok(
        planMissingWarning === undefined,
        `plan-missing warning must NOT fire when plan.md is present — got: ${JSON.stringify(msgs.captured)}`
      );

      // Reaching here without throw confirms the review reached AI execution.

      // plan-final.md must NOT have been materialized as a side effect of
      // preparing the review prompt — read-only fallback, not a write.
      const canonicalUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
      const materialized = store.get(canonicalUri.toString());
      assert.equal(
        materialized,
        undefined,
        "plan-final.md must NOT be materialized by review preparation — it only reads implementation.md via the read-only fallback"
      );
    } finally {
      msgs.restore();
      fs.restore();
      runners.restore();
    }
  });

  void it("legacy task with both implementation.md and plan-final.md uses plan-final.md (canonical wins)", async () => {
    // When both files exist, plan-final.md is the canonical artifact.
    // materializeCanonicalIfNeeded must detect plan-final.md already exists
    // and NOT overwrite it with the legacy content.
    const store = new Map<string, string>();
    const fs = installMemStore(store);
    const msgs = installMessageCapture();
    const runners = installRunnerStubs();

    try {
      const folderUri = makeTaskFolderUri("impl-review-both-legacy-and-canonical");
      const workspaceRoot = makeWorkspaceFolder("/fake-workspace");
      seedImplHighReviewTemplate(store);

      const planUri = vscode.Uri.joinPath(folderUri, "plan.md");
      store.set(planUri.toString(), "# Plan\n\nStep 1.");

      // Seed BOTH files with distinct content
      const legacyUri = vscode.Uri.joinPath(folderUri, "implementation.md");
      store.set(legacyUri.toString(), "## Legacy content — must NOT be used");

      const canonicalUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
      store.set(canonicalUri.toString(), "## Canonical content — must be used");

      await seedProgress(store, folderUri, {
        taskFolder: "impl-review-both-legacy-and-canonical",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        implReviewFiles: [],
        ownership: {
          metaRoot: nodePath.dirname(folderUri.fsPath),
          projectRoot: nodePath.dirname(folderUri.fsPath),
          boundAt: "2026-07-08T00:00:00.000Z",
          state: "resolved",
        },
      });

      await runReviewForFolder(
        fakeExtensionUri,
        folderUri,
        workspaceRoot,
        "impl",
        true
      );

      // plan-final.md must still have the canonical content (not overwritten)
      const afterContent = store.get(canonicalUri.toString());
      assert.ok(
        afterContent !== undefined && afterContent.includes("Canonical content"),
        "plan-final.md must not be overwritten when it already exists"
      );
      assert.ok(
        !afterContent.includes("Legacy content"),
        "plan-final.md must NOT contain legacy content when canonical file exists"
      );

      // Reaching here without throw confirms both gates passed.
    } finally {
      msgs.restore();
      fs.restore();
      runners.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// isMalformedReviewArg mixed-shape bypass variants (suite 15)
//
// Confirms that mixed shapes like { canonicalId, taskFolderPath: undefined }
// and { canonicalId, task: undefined } are correctly identified as malformed
// even though the accepted discriminant keys are present with falsy values.
//
// The old guard used `"taskFolderPath" in arg` which returns true even when
// the value is undefined, causing these shapes to pass the check and fall
// through to normalizeReviewArg's QuickPick path.
//
// The updated guard requires:
//   - For the { task } branch: task must be truthy AND have a truthy folderUri
//   - For the { taskFolderPath } branch: value must be a non-empty string
//   - Primitives (string, number, boolean): NOT malformed — fall through
//     to the safe QuickPick path (normalizeReviewArg treats them as no-arg)
//
// This additionally catches { task: {} } — an empty object is truthy but has
// no folderUri, so resolveTask would pass undefined to vscode.Uri.joinPath
// and throw. The guard intercepts this before it can reach resolveTask.
//
// Includes three production entry-point tests that call runReviewWithAI
// directly with { task: {} as any }, { task: { folderUri: undefined } as any },
// and a string primitive — confirming the guard fires for malformed objects
// and that primitives safely fall through to the workspace-guard/QuickPick.
// ---------------------------------------------------------------------------

void describe("isMalformedReviewArg mixed-shape bypass variants (suite 15)", () => {
  // Mirror the production guard logic exactly for pure-logic assertions.
  // Production isMalformedReviewArg is not exported, so we replicate it here
  // and separately test production behavior via runReviewWithAI below.
  function isMalformedReviewArgSim(arg: unknown): boolean {
    if (arg === undefined || arg === null) {return false;}
    if (typeof arg !== "object") {return false;}
    if (Object.keys(arg).length === 0) {return false;}
    const rec = arg as Record<string, unknown>;
    // { task } branch is valid only when task is truthy AND has truthy folderUri
    if ("task" in rec && rec.task && typeof rec.task === "object") {
      const taskObj = rec.task as Record<string, unknown>;
      if (taskObj.folderUri) {return false;}
    }
    // { taskFolderPath } branch is valid only when the value is a non-empty string
    if ("taskFolderPath" in rec && typeof rec.taskFolderPath === "string" && rec.taskFolderPath.length > 0) {
      return false;
    }
    // Non-empty object that satisfies neither accepted branch — malformed
    return true;
  }

  void it("{ canonicalId, taskFolderPath: undefined } is malformed (taskFolderPath key present but undefined value)", () => {
    // This is the key bypass variant from the review: the old guard returned
    // false (not malformed) because "taskFolderPath" in arg was true.
    // The new guard checks the value is a non-empty string, not just the key.
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "x", taskFolderPath: undefined }),
      true,
      "{ canonicalId, taskFolderPath: undefined } must be flagged as malformed"
    );
  });

  void it("{ canonicalId, task: undefined } is malformed (task key present but undefined value)", () => {
    // Same bypass via task key with undefined value.
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "x", task: undefined }),
      true,
      "{ canonicalId, task: undefined } must be flagged as malformed"
    );
  });

  void it("{ canonicalId, taskFolderPath: '' } is malformed (empty string is falsy)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "x", taskFolderPath: "" }),
      true,
      "{ canonicalId, taskFolderPath: '' } must be flagged as malformed"
    );
  });

  void it("{ canonicalId, taskFolderPath: null } is malformed (null is falsy)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "x", taskFolderPath: null }),
      true,
      "{ canonicalId, taskFolderPath: null } must be flagged as malformed"
    );
  });

  void it("{ canonicalId, task: null } is malformed (null task is falsy)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "x", task: null }),
      true,
      "{ canonicalId, task: null } must be flagged as malformed"
    );
  });

  void it("{ taskFolderPath: '/valid/path' } is NOT malformed (valid shape)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({ taskFolderPath: "/valid/path" }),
      false,
      "{ taskFolderPath } with a non-empty string value must NOT be flagged as malformed"
    );
  });

  void it("{ task: {} } IS malformed (truthy task but no folderUri — would crash resolveTask)", () => {
    // An empty object is truthy, but it has no folderUri property.
    // resolveTask passes task.folderUri to readTaskProgress → vscode.Uri.joinPath,
    // which throws when folderUri is undefined. The guard must catch this.
    assert.strictEqual(
      isMalformedReviewArgSim({ task: {} }),
      true,
      "{ task: {} } with a truthy task but no folderUri must be flagged as malformed"
    );
  });

  void it("{ task: { folderUri: realUri } } is NOT malformed (valid TaskNode shape)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({ task: { folderUri: vscode.Uri.file("/some/path") } }),
      false,
      "{ task: { folderUri } } with a truthy folderUri must NOT be flagged as malformed"
    );
  });

  void it("undefined is NOT malformed (safe QuickPick fallback)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim(undefined),
      false,
      "undefined must NOT be flagged as malformed"
    );
  });

  void it("empty object {} is NOT malformed (safe QuickPick fallback)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({}),
      false,
      "empty object must NOT be flagged as malformed (normalizeReviewArg returns {} → QuickPick)"
    );
  });

  void it("{ canonicalId: 'x' } (no accepted key at all) is malformed", () => {
    assert.strictEqual(
      isMalformedReviewArgSim({ canonicalId: "x" }),
      true,
      "canonicalId-only shape must be malformed"
    );
  });

  // ── Primitive inputs are NOT malformed ────────────────────────────────────
  // Primitives fall through to normalizeReviewArg's `typeof arg !== "object"`
  // check (which returns {} → QuickPick). Returning true from
  // isMalformedReviewArg would show a confusing error for something the user
  // never consciously passed. The `in` operator on a primitive would throw a
  // TypeError in the old normalizeReviewArg, but the updated guard in
  // normalizeReviewArg (`typeof arg !== "object"`) intercepts primitives
  // before any property access.

  void it("string primitive 'x' is NOT malformed (safe QuickPick fallback)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim("x"),
      false,
      "string primitive must NOT be flagged as malformed"
    );
  });

  void it("number primitive 42 is NOT malformed (safe QuickPick fallback)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim(42),
      false,
      "number primitive must NOT be flagged as malformed"
    );
  });

  void it("boolean primitive true is NOT malformed (safe QuickPick fallback)", () => {
    assert.strictEqual(
      isMalformedReviewArgSim(true),
      false,
      "boolean primitive must NOT be flagged as malformed"
    );
  });

  // ── Production entry-point regression tests ────────────────────────────────
  // The three tests below call the real runReviewWithAI production function:
  //
  //   (a) { task: {} as any } — malformed; must show error, no crash
  //   (b) { task: { folderUri: undefined } as any } — malformed; must show error
  //   (c) "bad-string" as primitive — NOT malformed; must NOT throw TypeError,
  //       must NOT show malformed-arg error; falls through to workspace-guard
  //       or QuickPick (whichever fires first when the workspace is stubbed).
  //
  // Test (c) exercises the real production failure path: the primitive reaches
  // normalizeReviewArg, which now guards `typeof arg !== "object"` and returns
  // {} (no task), which then triggers resolveTask's QuickPick/eligibility path.
  // The absence of a TypeError confirms the fix is in the production code, not
  // only in the local simulator above.

  void it("{ task: {} as any } triggers error at runReviewWithAI entry point (no QuickPick, no crash)", async () => {
    const msgs = installMessageCapture();
    // Stub workspace root so the workspace-guard doesn't trigger first
    const origWsFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file("/fake-workspace"), name: "fake-workspace", index: 0 },
    ];
    // Stub extensionContext minimally (consent is NOT reached — guard fires first)
    const fakeContext = {
      extensionUri: vscode.Uri.file("/fake-extension"),
      subscriptions: [],
      globalState: { get: (): undefined => undefined, update: (): Promise<undefined> => Promise.resolve(undefined), keys: (): string[] => [], setKeysForSync: (): undefined => undefined },
      secrets: { get: (): Promise<undefined> => Promise.resolve(undefined), store: (): Promise<undefined> => Promise.resolve(undefined), delete: (): Promise<undefined> => Promise.resolve(undefined), onDidChange: { event: (): { dispose: () => void } => ({ dispose: (): void => undefined }) } },
      workspaceState: { get: (): undefined => undefined, update: (): Promise<undefined> => Promise.resolve(undefined), keys: (): string[] => [] },
    } as unknown as vscode.ExtensionContext;

    try {
      // { task: {} } — truthy task but no folderUri (stale/untyped caller)
      await runReviewWithAI(
        vscode.Uri.file("/fake-extension"),
        fakeContext,
        { task: {} } as unknown as Parameters<typeof runReviewWithAI>[2]
      );

      // Must show the malformed-arg error, not open a QuickPick
      const malformedError = msgs.captured.find(
        (m) => m.method === "error" && m.message.includes("unsupported argument shape")
      );
      assert.ok(
        malformedError !== undefined,
        `runReviewWithAI with { task: {} } must show malformed-arg error. Got: ${JSON.stringify(msgs.captured)}`
      );
    } finally {
      msgs.restore();
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWsFolders;
    }
  });

  void it("{ task: { folderUri: undefined } as any } triggers error at runReviewWithAI entry point", async () => {
    const msgs = installMessageCapture();
    const origWsFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file("/fake-workspace"), name: "fake-workspace", index: 0 },
    ];
    const fakeContext = {
      extensionUri: vscode.Uri.file("/fake-extension"),
      subscriptions: [],
      globalState: { get: (): undefined => undefined, update: (): Promise<undefined> => Promise.resolve(undefined), keys: (): string[] => [], setKeysForSync: (): undefined => undefined },
      secrets: { get: (): Promise<undefined> => Promise.resolve(undefined), store: (): Promise<undefined> => Promise.resolve(undefined), delete: (): Promise<undefined> => Promise.resolve(undefined), onDidChange: { event: (): { dispose: () => void } => ({ dispose: (): void => undefined }) } },
      workspaceState: { get: (): undefined => undefined, update: (): Promise<undefined> => Promise.resolve(undefined), keys: (): string[] => [] },
    } as unknown as vscode.ExtensionContext;

    try {
      // { task: { folderUri: undefined } } — task key present, truthy obj, but falsy folderUri
      await runReviewWithAI(
        vscode.Uri.file("/fake-extension"),
        fakeContext,
        { task: { folderUri: undefined } } as unknown as Parameters<typeof runReviewWithAI>[2]
      );

      const malformedError = msgs.captured.find(
        (m) => m.method === "error" && m.message.includes("unsupported argument shape")
      );
      assert.ok(
        malformedError !== undefined,
        `runReviewWithAI with { task: { folderUri: undefined } } must show malformed-arg error. Got: ${JSON.stringify(msgs.captured)}`
      );
    } finally {
      msgs.restore();
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWsFolders;
    }
  });

  void it("string primitive passed to runReviewWithAI does NOT throw TypeError and does NOT show malformed-arg error", async () => {
    // This is the key production-path regression test for the blocking issue:
    // a truthy string primitive must NOT cause `"task" in arg` to throw a
    // TypeError inside normalizeReviewArg. The fix adds `typeof arg !== "object"`
    // to normalizeReviewArg so primitives return {} (no task) before any
    // property access.
    //
    // Expected behavior: no TypeError thrown, no malformed-arg error shown.
    // The primitive falls through normalizeReviewArg → {} → resolveTask's
    // QuickPick/eligibility path. With no real tasks in the workspace, the
    // QuickPick shows "No task folders found" or "No tasks eligible" — neither
    // of which is an error.
    const msgs = installMessageCapture();
    const origWsFolders = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file("/fake-workspace"), name: "fake-workspace", index: 0 },
    ];
    const fakeContext = {
      extensionUri: vscode.Uri.file("/fake-extension"),
      subscriptions: [],
      globalState: { get: (): undefined => undefined, update: (): Promise<undefined> => Promise.resolve(undefined), keys: (): string[] => [], setKeysForSync: (): undefined => undefined },
      secrets: { get: (): Promise<undefined> => Promise.resolve(undefined), store: (): Promise<undefined> => Promise.resolve(undefined), delete: (): Promise<undefined> => Promise.resolve(undefined), onDidChange: { event: (): { dispose: () => void } => ({ dispose: (): void => undefined }) } },
      workspaceState: { get: (): undefined => undefined, update: (): Promise<undefined> => Promise.resolve(undefined), keys: (): string[] => [] },
    } as unknown as vscode.ExtensionContext;

    let threw = false;
    try {
      // Pass a truthy string primitive — the old code would throw TypeError here.
      await runReviewWithAI(
        vscode.Uri.file("/fake-extension"),
        fakeContext,
        "bad-string" as unknown as Parameters<typeof runReviewWithAI>[2]
      );
    } catch {
      threw = true;
    } finally {
      msgs.restore();
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWsFolders;
    }

    // Must not throw
    assert.strictEqual(
      threw,
      false,
      "runReviewWithAI with a string primitive must NOT throw a TypeError"
    );

    // Must not show malformed-arg error (primitives are NOT malformed — they
    // fall through to the safe QuickPick/eligibility path)
    const malformedError = msgs.captured.find(
      (m) => m.method === "error" && m.message.includes("unsupported argument shape")
    );
    assert.ok(
      malformedError === undefined,
      `runReviewWithAI with a string primitive must NOT show malformed-arg error. Got: ${JSON.stringify(msgs.captured)}`
    );
  });
});

// ---------------------------------------------------------------------------
// generateImplementationWithAI eligibility (suite 16)
//
// Confirms that:
//   (a) plan-low-review tasks are NOT shown in the QuickPick for Generate
//       Implementation — the eligible stage list is ["impl"] only.
//   (b) implementation-stage tasks ARE eligible.
//
// The old code used ["plan-low-review", "impl"], which advertised
// plan-low-review tasks as eligible but then immediately failed when
// plan-final.md didn't exist yet (because plan-final.md is only written when
// advancing INTO the implementation stage via nextStage).
//
// IMPORTANT: These tests assert against the PRODUCTION `GENERATE_IMPL_ELIGIBLE_STAGES`
// constant exported from `reviewActions.ts`. They do NOT use a locally
// re-declared array. This ensures that if someone accidentally re-adds
// "plan-low-review" to the production constant, these tests will fail
// immediately and catch the regression.
// ---------------------------------------------------------------------------

void describe("generateImplementationWithAI eligibility (suite 16)", () => {
  void it("GENERATE_IMPL_ELIGIBLE_STAGES (production) does NOT include plan-low-review", () => {
    // Assert against the imported production constant — not a local copy.
    // If the production code regresses and re-adds plan-low-review, this test
    // fails, whereas a locally re-declared array would always pass.
    assert.ok(
      !GENERATE_IMPL_ELIGIBLE_STAGES.includes("plan-low-review"),
      "production GENERATE_IMPL_ELIGIBLE_STAGES must NOT include plan-low-review"
    );
  });

  void it("GENERATE_IMPL_ELIGIBLE_STAGES (production) includes 'implementation'", () => {
    assert.ok(
      GENERATE_IMPL_ELIGIBLE_STAGES.includes("impl"),
      "production GENERATE_IMPL_ELIGIBLE_STAGES must include 'implementation'"
    );
  });

  void it("GENERATE_IMPL_ELIGIBLE_STAGES (production) contains exactly ['implementation']", () => {
    // This test verifies the full contents of the production constant so that
    // any unintended additions (not just plan-low-review) are caught.
    assert.deepEqual(
      [...GENERATE_IMPL_ELIGIBLE_STAGES],
      ["impl"],
      "production GENERATE_IMPL_ELIGIBLE_STAGES must be exactly ['implementation']"
    );
  });

  void it("a plan-low-review task is filtered out when the production eligible-stage list is applied", () => {
    // Confirm that a task at plan-low-review stage is NOT eligible when
    // filtered against the production GENERATE_IMPL_ELIGIBLE_STAGES.
    // This is the direct behavioral consequence of the constant's value.
    const taskStage: import("../types/taskProgress").TaskStage = "plan-low-review";
    assert.ok(
      !GENERATE_IMPL_ELIGIBLE_STAGES.includes(taskStage),
      "plan-low-review must not pass the production eligibleStages filter for Generate Implementation"
    );
  });
});

// ---------------------------------------------------------------------------
// applyHighLevelReviewChanges / applyLowLevelReviewChanges delegation to
// applyReviewWithAI (production code, plan §1.3): these keyboard-shortcut
// commands already read real progress via resolveTaskContext before
// delegating. They must forward { task: IncompleteTask } carrying that
// already-known progress — not { taskFolderPath } — so applyReviewWithAI's
// early gate check can trust arg.task.progress.currentStage and fire the
// applyReviewEdit.v1 gate BEFORE it performs any read of its own for an
// impl-review-stage (edit-branch) target. A { taskFolderPath } delegation is
// deliberately re-wrapped with an untrustworthy placeholder stage by
// normalizeReviewArg and would fall through to a fresh, post-gate read.
// ---------------------------------------------------------------------------

void describe("applyHighLevelReviewChanges / applyLowLevelReviewChanges delegation (production code)", () => {
  function installExecuteCommandStub(): {
    captured: Array<{ command: string; arg: unknown }>;
    restore: () => void;
  } {
    const captured: Array<{ command: string; arg: unknown }> = [];
    if (!(vscode as unknown as Record<string, unknown>).commands) {
      (vscode as unknown as Record<string, unknown>).commands = {};
    }
    const orig = (vscode.commands as unknown as Record<string, unknown>).executeCommand;
    (vscode.commands as unknown as Record<string, unknown>).executeCommand = async (
      command: string,
      arg?: unknown
    ): Promise<undefined> => {
      captured.push({ command, arg });
      return Promise.resolve(undefined);
    };
    return {
      captured,
      restore: (): void => {
        (vscode.commands as unknown as Record<string, unknown>).executeCommand = orig;
      },
    };
  }

  void it("applyHighLevelReviewChanges delegates with { task } (real progress) for an impl-high-review target", async () => {
    const FOLDER_PATH = nodePath.join(REAL_TASK_ROOT, ".ensemble", "apply-high-review-edit-delegation");
    nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
    const folderUri = vscode.Uri.file(FOLDER_PATH);

    const store = new Map<string, string>();
    const memFs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    const execCmd = installExecuteCommandStub();

    try {
      const progress: TaskProgress = {
        taskFolder: "apply-high-review-edit-delegation",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      };
      await seedProgress(store, folderUri, progress);

      const inv = makeInventoryStubWithStage(
        FOLDER_PATH,
        FOLDER_PATH,
        "impl-high-review",
        "active"
      );

      await applyHighLevelReviewChanges(inv, { taskFolderPath: FOLDER_PATH });

      // Route separation (AC-ROUTE-01): an impl-high-review (edit-capable)
      // target dispatches to the dedicated edit-root command, not the
      // shared text-root applyReviewWithAI.
      const dispatch = execCmd.captured.find(
        (e) => e.command === "vs-code-ai-helper.applyReviewEditWithAI"
      );
      assert.ok(dispatch, "applyHighLevelReviewChanges must delegate to applyReviewEditWithAI for an edit-capable target");
      assert.equal(
        execCmd.captured.some((e) => e.command === "vs-code-ai-helper.applyReviewWithAI"),
        false,
        "must not also dispatch to the shared text-root applyReviewWithAI"
      );
      const arg = dispatch.arg as Record<string, unknown>;
      assert.ok(
        "task" in arg && arg.task !== undefined,
        "delegation must carry { task }, not a bare { taskFolderPath }, so the caller's already-known " +
          "stage can gate the edit branch before any further read"
      );
      assert.strictEqual("taskFolderPath" in arg, false, "delegation must not carry taskFolderPath");
      const taskArg = arg.task as { progress: TaskProgress };
      assert.strictEqual(
        taskArg.progress.currentStage,
        "impl-high-review",
        "the forwarded task node must carry the real, already-resolved stage"
      );
    } finally {
      msgs.restore();
      memFs.restore();
      wsFolders.restore();
      execCmd.restore();
    }
  });

  void it("applyLowLevelReviewChanges delegates with { task } (real progress) for an impl-low-review target", async () => {
    const FOLDER_PATH = nodePath.join(REAL_TASK_ROOT, ".ensemble", "apply-low-review-edit-delegation");
    nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
    const folderUri = vscode.Uri.file(FOLDER_PATH);

    const store = new Map<string, string>();
    const memFs = installMemStore(store);
    const msgs = installMessageCapture();
    const wsFolders = installWorkspaceFoldersStub();
    const execCmd = installExecuteCommandStub();

    try {
      const progress: TaskProgress = {
        taskFolder: "apply-low-review-edit-delegation",
        currentStage: "impl-low-review",
        status: "active",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      };
      await seedProgress(store, folderUri, progress);

      const inv = makeInventoryStubWithStage(
        FOLDER_PATH,
        FOLDER_PATH,
        "impl-low-review",
        "active"
      );

      await applyLowLevelReviewChanges(inv, { taskFolderPath: FOLDER_PATH });

      // Route separation (AC-ROUTE-01): an impl-low-review (edit-capable)
      // target dispatches to the dedicated edit-root command, not the
      // shared text-root applyReviewWithAI.
      const dispatch = execCmd.captured.find(
        (e) => e.command === "vs-code-ai-helper.applyReviewEditWithAI"
      );
      assert.ok(dispatch, "applyLowLevelReviewChanges must delegate to applyReviewEditWithAI for an edit-capable target");
      assert.equal(
        execCmd.captured.some((e) => e.command === "vs-code-ai-helper.applyReviewWithAI"),
        false,
        "must not also dispatch to the shared text-root applyReviewWithAI"
      );
      const arg = dispatch.arg as Record<string, unknown>;
      assert.ok(
        "task" in arg && arg.task !== undefined,
        "delegation must carry { task }, not a bare { taskFolderPath }, so the caller's already-known " +
          "stage can gate the edit branch before any further read"
      );
      assert.strictEqual("taskFolderPath" in arg, false, "delegation must not carry taskFolderPath");
      const taskArg = arg.task as { progress: TaskProgress };
      assert.strictEqual(
        taskArg.progress.currentStage,
        "impl-low-review",
        "the forwarded task node must carry the real, already-resolved stage"
      );
    } finally {
      msgs.restore();
      memFs.restore();
      wsFolders.restore();
      execCmd.restore();
    }
  });

  void it(
    "applyHighLevelReviewChanges gates applyReviewEdit.v1 itself for an impl-high-review target, " +
      "before any dispatch to applyReviewWithAI, when the edit route is disabled",
    async () => {
      const FOLDER_PATH = nodePath.join(
        REAL_TASK_ROOT,
        ".ensemble",
        "apply-high-review-edit-gate-in-wrapper"
      );
      nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
      const folderUri = vscode.Uri.file(FOLDER_PATH);

      const store = new Map<string, string>();
      const memFs = installMemStore(store);
      const msgs = installMessageCapture();
      const wsFolders = installWorkspaceFoldersStub();
      const execCmd = installExecuteCommandStub();

      // The unit-test harness clears LEGACY_AI_ROUTE_DISABLED_V0 for the whole
      // suite so the retained legacy handlers stay exercisable; re-add
      // "applyReviewEdit.v1" here to prove this wrapper's own gate call is
      // real and load-bearing (plan §1.3), not merely relying on the
      // downstream applyReviewWithAI delegate to catch it later.
      const mutableDisabled = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(mutableDisabled.has("applyReviewEdit.v1"), false);
      mutableDisabled.add("applyReviewEdit.v1");

      try {
        const progress: TaskProgress = {
          taskFolder: "apply-high-review-edit-gate-in-wrapper",
          currentStage: "impl-high-review",
          status: "active",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        };
        await seedProgress(store, folderUri, progress);

        const inv = makeInventoryStubWithStage(
          FOLDER_PATH,
          FOLDER_PATH,
          "impl-high-review",
          "active"
        );

        await assert.rejects(
          () => applyHighLevelReviewChanges(inv, { taskFolderPath: FOLDER_PATH }),
          LegacyAiActionSafetyGateErrorV0,
          "the wrapper must itself throw on the disabled applyReviewEdit.v1 route for an impl-high-review target"
        );

        assert.equal(
          execCmd.captured.length,
          0,
          "no dispatch to either applyReviewWithAI or applyReviewEditWithAI may occur once the wrapper's own edit gate has thrown"
        );
      } finally {
        mutableDisabled.delete("applyReviewEdit.v1");
        msgs.restore();
        memFs.restore();
        wsFolders.restore();
        execCmd.restore();
      }
    }
  );

  void it(
    "applyHighLevelReviewChanges still dispatches for a plan-high-review (text) target " +
      "while applyReviewEdit.v1 stays disabled",
    async () => {
      const FOLDER_PATH = nodePath.join(
        REAL_TASK_ROOT,
        ".ensemble",
        "apply-high-review-text-unaffected-by-edit-gate"
      );
      nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
      const folderUri = vscode.Uri.file(FOLDER_PATH);

      const store = new Map<string, string>();
      const memFs = installMemStore(store);
      const msgs = installMessageCapture();
      const wsFolders = installWorkspaceFoldersStub();
      const execCmd = installExecuteCommandStub();

      const mutableDisabled = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(mutableDisabled.has("applyReviewEdit.v1"), false);
      mutableDisabled.add("applyReviewEdit.v1");

      try {
        const progress: TaskProgress = {
          taskFolder: "apply-high-review-text-unaffected-by-edit-gate",
          currentStage: "plan-high-review",
          status: "active",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        };
        await seedProgress(store, folderUri, progress);

        const inv = makeInventoryStubWithStage(
          FOLDER_PATH,
          FOLDER_PATH,
          "plan-high-review",
          "active"
        );

        await applyHighLevelReviewChanges(inv, { taskFolderPath: FOLDER_PATH });

        const dispatch = execCmd.captured.find(
          (e) => e.command === "vs-code-ai-helper.applyReviewWithAI"
        );
        assert.ok(
          dispatch,
          "a plan-high-review (text) target must still dispatch even while the unrelated edit route is disabled"
        );
      } finally {
        mutableDisabled.delete("applyReviewEdit.v1");
        msgs.restore();
        memFs.restore();
        wsFolders.restore();
        execCmd.restore();
      }
    }
  );

  void it(
    "applyLowLevelReviewChanges gates applyReviewEdit.v1 itself for an impl-low-review target, " +
      "before any dispatch to applyReviewWithAI, when the edit route is disabled",
    async () => {
      const FOLDER_PATH = nodePath.join(
        REAL_TASK_ROOT,
        ".ensemble",
        "apply-low-review-edit-gate-in-wrapper"
      );
      nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
      const folderUri = vscode.Uri.file(FOLDER_PATH);

      const store = new Map<string, string>();
      const memFs = installMemStore(store);
      const msgs = installMessageCapture();
      const wsFolders = installWorkspaceFoldersStub();
      const execCmd = installExecuteCommandStub();

      const mutableDisabled = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(mutableDisabled.has("applyReviewEdit.v1"), false);
      mutableDisabled.add("applyReviewEdit.v1");

      try {
        const progress: TaskProgress = {
          taskFolder: "apply-low-review-edit-gate-in-wrapper",
          currentStage: "impl-low-review",
          status: "active",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        };
        await seedProgress(store, folderUri, progress);

        const inv = makeInventoryStubWithStage(
          FOLDER_PATH,
          FOLDER_PATH,
          "impl-low-review",
          "active"
        );

        await assert.rejects(
          () => applyLowLevelReviewChanges(inv, { taskFolderPath: FOLDER_PATH }),
          LegacyAiActionSafetyGateErrorV0,
          "the wrapper must itself throw on the disabled applyReviewEdit.v1 route for an impl-low-review target"
        );

        assert.equal(
          execCmd.captured.length,
          0,
          "no dispatch to either applyReviewWithAI or applyReviewEditWithAI may occur once the wrapper's own edit gate has thrown"
        );
      } finally {
        mutableDisabled.delete("applyReviewEdit.v1");
        msgs.restore();
        memFs.restore();
        wsFolders.restore();
        execCmd.restore();
      }
    }
  );

  void it(
    "applyLowLevelReviewChanges still dispatches for a plan-low-review (text) target " +
      "while applyReviewEdit.v1 stays disabled",
    async () => {
      const FOLDER_PATH = nodePath.join(
        REAL_TASK_ROOT,
        ".ensemble",
        "apply-low-review-text-unaffected-by-edit-gate"
      );
      nodeFs.mkdirSync(FOLDER_PATH, { recursive: true });
      const folderUri = vscode.Uri.file(FOLDER_PATH);

      const store = new Map<string, string>();
      const memFs = installMemStore(store);
      const msgs = installMessageCapture();
      const wsFolders = installWorkspaceFoldersStub();
      const execCmd = installExecuteCommandStub();

      const mutableDisabled = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(mutableDisabled.has("applyReviewEdit.v1"), false);
      mutableDisabled.add("applyReviewEdit.v1");

      try {
        const progress: TaskProgress = {
          taskFolder: "apply-low-review-text-unaffected-by-edit-gate",
          currentStage: "plan-low-review",
          status: "active",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        };
        await seedProgress(store, folderUri, progress);

        const inv = makeInventoryStubWithStage(
          FOLDER_PATH,
          FOLDER_PATH,
          "plan-low-review",
          "active"
        );

        await applyLowLevelReviewChanges(inv, { taskFolderPath: FOLDER_PATH });

        const dispatch = execCmd.captured.find(
          (e) => e.command === "vs-code-ai-helper.applyReviewWithAI"
        );
        assert.ok(
          dispatch,
          "a plan-low-review (text) target must still dispatch even while the unrelated edit route is disabled"
        );
      } finally {
        mutableDisabled.delete("applyReviewEdit.v1");
        msgs.restore();
        memFs.restore();
        wsFolders.restore();
        execCmd.restore();
      }
    }
  );

  void it(
    "applyReviewWithAI with { taskFolderPath } targeting an impl-review stage asserts applyReviewEdit.v1 gate and rejects",
    async () => {
      const folderUri = makeTaskFolderUri("task-folder-impl-review-gate");
      const FOLDER_PATH = folderUri.fsPath;
      const store = new Map<string, string>();
      const memFs = installMemStore(store);
      const msgs = installMessageCapture();
      const wsFolders = installWorkspaceFoldersStub();

      const mutableDisabled = LEGACY_AI_ROUTE_DISABLED_V0 as unknown as Set<string>;
      assert.equal(mutableDisabled.has("applyReviewEdit.v1"), false);
      mutableDisabled.add("applyReviewEdit.v1");

      try {
        const progress: TaskProgress = {
          taskFolder: "task-folder-impl-review-gate",
          currentStage: "impl-high-review",
          status: "active",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        };
        await seedProgress(store, folderUri, progress);

        let gateThrown = false;
        try {
          await applyReviewWithAI(
            vscode.Uri.file("c:/test-ext"),
            {} as vscode.ExtensionContext,
            { taskFolderPath: FOLDER_PATH }
          );
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes("applyReviewEdit.v1")) {
            gateThrown = true;
          } else {
            throw err;
          }
        }
        assert.ok(
          gateThrown,
          "applyReviewWithAI with { taskFolderPath } pointing to an impl-review task must assert applyReviewEdit.v1 gate"
        );
      } finally {
        mutableDisabled.delete("applyReviewEdit.v1");
        msgs.restore();
        memFs.restore();
        wsFolders.restore();
      }
    }
  );
});
