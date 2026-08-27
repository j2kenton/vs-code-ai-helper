/**
 * Live-composition regression for the wf10 continuation review blocker
 * (narrowed `7cb82d57-49cb-456e-97d5-6f7e9fc0fc71-2`, 2026-08-27): "the
 * automatic Apply Review route lacks the required live-composition
 * regression test."
 *
 * Prior coverage of the automatic Apply Review redirect was either a pure
 * selector test (`reviewRouting.test.ts`'s `chooseAutomaticImplementationDispatchV1`
 * suite — no operation registry involved at all) or a fully
 * `executeCommand`-stubbed test (`goToReviewAndApply.test.ts` — proves
 * `goToReviewAndApplyV1`'s own dispatch-ordering logic, but never touches a
 * real `TaskOperationRegistry`). Neither can catch the actual bug that was
 * fixed: the redirect used to call `goToReviewAndApplyV1` from INSIDE the
 * "Run Implementation" tracked-operation's own callback, so `setTaskStage`'s
 * `cancelRunningOperationsForTask` polled waiting for the very operation it
 * was called from to end — a guaranteed self-wait that always timed out
 * (observed: the redirect announces itself, blocks ~15s, then
 * `goToReviewAndApplyV1` gives up and the redirect never dispatches). The fix
 * (`reviewActions.ts`'s `redirectAfterOperationV1`) defers the actual
 * `goToReviewAndApplyV1` call to run only once `runTrackedOperation` has
 * resolved.
 *
 * This test drives the REAL `runImplementationWithAI` against the REAL
 * `taskOperations` registry (`../utils/taskOperations`, unpatched) and the
 * REAL `vs-code-ai-helper.setTaskStage` command (registered via
 * `registerSetTaskStageCommand` against a real `TaskInventory` and
 * `CurrentTaskStore`, exactly as `extension.ts` wires it) — the same
 * production path that calls `cancelRunningOperationsForTask`, the function
 * whose polling loop the deadlock actually lived in. Only the provider
 * boundary (`runImplementationOrSealedV1`, deliberately made to throw so an
 * accidental Implementation dispatch fails the test loudly instead of
 * silently proving nothing) and the two Apply Review commands themselves
 * (stubbed to just record their invocation — dispatching a real AI review
 * round is a different property, not what this test is about) are faked.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runImplementationWithAI } from "../commands/reviewActions";
import { registerSetTaskStageCommand } from "../commands/setTaskStage";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { taskOperations } from "../utils/taskOperations";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { TaskProgress } from "../types/taskProgress";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";

/* eslint-disable @typescript-eslint/no-var-requires */
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const settingsModule = require("../config/settings") as Record<string, unknown>;
const taskOperationsModule = require("../utils/taskOperations") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-auto-redirect-"));
// Hermetic git scope — mirrors deferredRoundRecovery.test.ts's rationale: an
// OS temp dir can sit inside an unrelated git work tree, making a pre-run
// `git status` walk (and time out) the wrong repository.
cp.execFileSync("git", ["init", "-q"], { cwd: REAL_ROOT, windowsHide: true });

const TASK_NAME = "2026-08-27_redirect_task";
// Tasks live under the DEFAULT task root (`.ensemble`) here, unlike
// deferredRoundRecovery.test.ts's ad hoc "plans" folder — this test needs a
// real `TaskInventory.refresh()` to actually discover the folder (the
// production `setTaskStage` command resolves through the inventory, not
// through a synthesized IncompleteTask the way `runImplementationWithAI`'s
// own `{ taskFolderPath }` resolution does).
const FOLDER_PATH = path.join(REAL_ROOT, ".ensemble", TASK_NAME);

const PLAN_FINAL_FULLY_TICKED = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist",
  "",
  "- [x] Add the resolver",
  "- [x] Wire the decoder",
  "",
].join("\n");

function writeTaskFolder(): void {
  fs.mkdirSync(FOLDER_PATH, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: TASK_NAME,
    // Deliberately NOT the review stage the redirect targets (impl-low-review
    // vs. the impl-high-review blocker on record): this is the scenario
    // where a stage change (and therefore a real
    // `cancelRunningOperationsForTask` cancellation request) is actually
    // required, exercising the registry interaction the same-stage no-op
    // case would skip entirely. Deliberately NOT "impl" either — that would
    // route through `runImplementationWithAI`'s checklist-generation gate
    // (`needsChecklist` requires `currentStage === "impl"`), which calls the
    // real (unpatched) `checkImplementationAvailabilityForModel` and fails
    // on Copilot availability before ever reaching the redirect logic this
    // test targets.
    currentStage: "impl-low-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, ".ensemble"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    // A prior impl-high-review round found one standing task-fixable
    // blocker and the checklist is fully ticked below — the exact shape
    // `decidePostReviewActionV1` resolves to `apply-review`.
    reviewScoreHistory: [
      {
        stage: "impl-high-review",
        score: 6,
        attemptId: "attempt-1",
        at: "2026-08-20T10:00:00.000Z",
        blockerCount: 1,
        taskFixableCount: 1,
        blockers: [
          {
            category: "completion",
            resolver: "task-fixable",
            subject: "src/foo.ts",
            id: "attempt-1-0",
            description: "src/foo.ts still leaks the handle on the error path.",
          },
        ],
      },
    ],
  };
  fs.writeFileSync(
    path.join(FOLDER_PATH, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(FOLDER_PATH, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(FOLDER_PATH, "plan-final.md"), PLAN_FINAL_FULLY_TICKED, "utf8");
  fs.writeFileSync(
    path.join(FOLDER_PATH, "impl-high-review.md"),
    "# Implementation Review\n\nReadiness: 6/10\n\nsrc/foo.ts still leaks the handle.\n",
    "utf8"
  );
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
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return {
      type: stat.isDirectory() ? 2 : 1,
      size: stat.size,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
    };
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

function readProgress(): TaskProgress {
  const text = fs.readFileSync(path.join(FOLDER_PATH, "task-progress.json"), "utf8");
  const decoded = decodeTaskProgressTextV1(text, { expectedTaskFolder: TASK_NAME });
  assert.ok(decoded.ok, `persisted task-progress.json must strict-decode: ${decoded.ok ? "" : decoded.reason}`);
  return decoded.decoded.progress;
}

void describe("automatic Apply Review redirect — live composition (real operation registry + real stage transition)", () => {
  void it("dispatches the redirect only after the source operation has genuinely ended, without the cancellation poll self-waiting", async () => {
    writeTaskFolder();

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const context = makeExtensionContext();
    const inventory = new TaskInventory();
    const currentTaskStore = new CurrentTaskStore(context.workspaceState);
    registerSetTaskStageCommand(context, inventory, currentTaskStore);

    const applyCommandCalls: { command: string; arg: unknown }[] = [];
    const cancelCallOperationCounts: number[] = [];
    const notifications: string[] = [];
    const providerTarget = provider as unknown as { addEntry: (...args: unknown[]) => unknown };
    const origAddEntry = providerTarget.addEntry.bind(provider);
    providerTarget.addEntry = (...args: unknown[]): unknown => {
      notifications.push(String(args[0]));
      return origAddEntry(...args);
    };

    const origExecuteCommand = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: unknown }).executeCommand = (
      command: string,
      ...args: unknown[]
    ): Promise<unknown> => {
      if (command === "vs-code-ai-helper.applyHighLevelReviewChanges" || command === "vs-code-ai-helper.applyLowLevelReviewChanges") {
        applyCommandCalls.push({ command, arg: args[0] });
        return Promise.resolve(undefined);
      }
      return Promise.resolve(origExecuteCommand.call(vscode.commands, command, ...args));
    };

    const origCancel = taskOperationsModule.cancelRunningOperationsForTask as (
      ...args: unknown[]
    ) => Promise<{ ok: boolean; reason?: string }>;

    const patches: Patched[] = [
      patch(runEditActionModule, "checkEditActionProviderPathGateV1", () => Promise.resolve({ ok: true })),
      patch(runEditActionModule, "checkEditActionAvailabilityV1", () => Promise.resolve({ ok: true })),
      // If the redirect fails to fire and Implementation is dispatched
      // instead, this throws — failing the test loudly rather than silently
      // proving nothing (the same "provider boundary should never be
      // reached" pattern used elsewhere in this suite family).
      patch(runEditActionModule, "runImplementationOrSealedV1", () => {
        throw new Error(
          "runImplementationOrSealedV1 must never be invoked: the automatic " +
            "redirect should have routed to Apply Review before reaching the " +
            "provider boundary."
        );
      }),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ modelId: "cli:test-model", source: "task" })),
      patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
        Promise.resolve({ availability: { available: true }, providerLabel: "Test CLI" })),
      patch(contextPackModule, "generateContextPack", () => Promise.resolve("ctx")),
      patch(settingsModule, "allowsDirtyWorktreeChanges", () => true),
      // The property under test: at the exact moment the redirect's stage
      // transition asks the real operation registry to cancel whatever is
      // running for this task, the "Run Implementation" operation that
      // triggered the redirect must have ALREADY ended (0 live operations) —
      // proving the redirect runs after runTrackedOperation resolved, not
      // from inside its own callback (the fixed self-wait deadlock).
      patch(taskOperationsModule, "cancelRunningOperationsForTask", (...args: unknown[]) => {
        cancelCallOperationCounts.push(taskOperations.getTaskOperations(FOLDER_PATH).length);
        return origCancel(...args);
      }),
    ];

    const windowTarget = vscode.window as unknown as Record<string, unknown>;
    const origShowWarning = windowTarget.showWarningMessage;
    windowTarget.showWarningMessage = (): Promise<string> => Promise.resolve("Proceed Anyway");

    const start = Date.now();
    try {
      await inventory.refresh();
      await runImplementationWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: FOLDER_PATH, automationDispatch: true }
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      (vscode.commands as { executeCommand: unknown }).executeCommand = origExecuteCommand;
      windowTarget.showWarningMessage = origShowWarning;
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
    const elapsedMs = Date.now() - start;

    // Well under cancelRunningOperationsForTask's 15s poll timeout — proves
    // no self-wait occurred (a self-wait would have blocked for the full
    // timeout, since nothing would ever decrement the operation count).
    assert.ok(
      elapsedMs < 5_000,
      `redirect took ${elapsedMs}ms — a self-wait deadlock would block for ~15s`
    );

    // The redirect's cancellation request must see ZERO live operations for
    // this task, at every call — the "Run Implementation" operation had
    // already ended before the stage transition asked to cancel anything.
    assert.ok(
      cancelCallOperationCounts.length > 0,
      `setTaskStage must have called cancelRunningOperationsForTask. notifications=${JSON.stringify(notifications)} applyCommandCalls=${JSON.stringify(applyCommandCalls)}`
    );
    for (const count of cancelCallOperationCounts) {
      assert.equal(count, 0, "no live operation may still be registered when the redirect's cancellation request runs");
    }

    // No operation is left registered for the task once the whole dispatch
    // has settled, either.
    assert.equal(taskOperations.getTaskOperations(FOLDER_PATH).length, 0);

    // The redirect actually ran: the task moved to the review stage the
    // decision named, and the corresponding Apply Review command was
    // dispatched exactly once.
    const persisted = readProgress();
    assert.equal(persisted.currentStage, "impl-high-review");
    assert.deepEqual(
      applyCommandCalls.map((c) => c.command),
      ["vs-code-ai-helper.applyHighLevelReviewChanges"]
    );
    assert.deepEqual(applyCommandCalls[0]?.arg, { taskFolderPath: FOLDER_PATH });
  });
});
