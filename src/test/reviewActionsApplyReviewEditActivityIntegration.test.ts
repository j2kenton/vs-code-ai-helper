/**
 * Notifications in-flight visibility (Part II) — REAL behavioral coverage
 * for the Apply Review Edit / Fast Forward implementation-review dispatch
 * (`applyImplementationReviewWithAI`, reached via the public
 * `applyReviewEditWithAI` command), complementing
 * `reviewActionsApplyReviewActivityIntegration.test.ts` (the plan-review
 * sibling, `applyReviewWithAI`).
 *
 * Review blocker 7bf9f2ec…-0 (remaining portion): the only prior evidence for
 * this specific dispatch was a source-ordering assertion
 * (`reviewActionsStageActivity.test.ts`'s "reports 'starting' at the top of
 * applyImplementationReviewWithAI" test) — never a real invocation observed
 * through the real registry.
 *
 * `applyImplementationReviewWithAI` ultimately dispatches through the SAME
 * `executeImplementationRun` boundary `reviewActionsImplementationActivity
 * IntegrationV1.test.ts` already drives behaviorally for `runImplementation
 * WithAI` (proving "running", the boundary file count, and "writing
 * summary" for real) — so this suite does not re-prove that shared interior;
 * it proves the two things unique to THIS caller: the "starting"/model
 * report before context assembly, and the "reading context (N KB)" report at
 * its own boundary, through the REAL `applyReviewEditWithAI` -> `apply
 * ImplementationReviewWithAI` -> `executeImplementationRun` call chain (only
 * the innermost `runnerRegistry.runImplementationForModel` provider call and
 * the automatic follow-up re-review's coordinator transport are faked, at
 * the same seams the sibling suites already use).
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { applyReviewEditWithAI } from "../commands/reviewActions";
import { taskOperations } from "../utils/taskOperations";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
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

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-applyrevedit-activity-"));

// See reviewActionsImplementationActivityIntegration.test.ts's identical
// comment: executeImplementationRun's pre-run safety check calls the REAL
// isGitWorkspace/getUnrelatedWorkspaceChanges, which walk up from cwd — this
// makes REAL_ROOT itself the nearest enclosing repo so that check is
// deterministic rather than dependent on the host machine's ambient state.
execFileSync("git", ["init", "--quiet"], { cwd: REAL_ROOT });

// Real, fast conventional scripts so the automatic re-review's own
// completion-check pass (buildVerifiedChecksVariable, reached because
// impl-high-review is not a plan review) resolves quickly and deterministically
// instead of failing on a missing package.json or reaching for a slow real
// toolchain — same pattern as reviewActionsCompletionCheckWorkflowIntegration
// .test.ts.
fs.writeFileSync(
  path.join(REAL_ROOT, "package.json"),
  JSON.stringify(
    {
      name: "apply-review-edit-activity-fixture",
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

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-applyrevedit-activity-private-"));
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

function makeImplReviewTaskFolder(name: string): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress = {
    taskFolder: name,
    currentStage: "impl-high-review",
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
  fs.writeFileSync(
    path.join(folderPath, "impl-high-review.md"),
    "Readiness: 6/10\n\n- Needs work.\n",
    "utf8"
  );
  return { folderPath };
}

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function markdownReviewTransportV1(markdown: string, runnerId = "stub-review-runner"): AgentTransportV1 {
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

/** Routes the automatic follow-up re-review's coordinator dispatch (the ONLY
 * dispatch in this suite that goes through the V1 runner-selection seam —
 * the main edit dispatch below goes through `runnerRegistry.
 * runImplementationForModel` directly, per `runImplementationOrSealedV1`'s
 * CLI-resolved-model path) to a fake transport instead of a real provider. */
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
  const preflightPatch = patch(
    runnerRegistryModule,
    "preflightStageChainAvailabilityV1",
    () => Promise.resolve({ kind: "dispatchable" })
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

function installProceedAnywayStub(): { restore: () => void } {
  const win = vscode.window as unknown as Record<string, unknown>;
  const orig = win.showWarningMessage;
  win.showWarningMessage = (): Promise<string> => Promise.resolve("Proceed Anyway");
  return { restore: (): void => { win.showWarningMessage = orig; } };
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

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

function controllableImplementationRun(): {
  invoked: Promise<void>;
  resolveWith: (result: Record<string, unknown>) => void;
  fn: (...args: unknown[]) => Promise<unknown>;
} {
  let markInvoked: () => void = () => {};
  const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
  let settleResolve: (result: Record<string, unknown>) => void = () => {};
  const fn = (): Promise<unknown> => {
    markInvoked();
    return new Promise((resolve) => { settleResolve = resolve; });
  };
  return {
    invoked,
    resolveWith: (result: Record<string, unknown>): void => settleResolve(result),
    fn,
  };
}

function installApplyReviewEditPatches(): Patched[] {
  return [
    patch(settingsModule, "isAutoAdvanceEnabled", () => false),
    patch(settingsModule, "allowsDirtyWorktreeChanges", () => true),
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveEffectiveStageChainV1", () => ({
      originStage: "impl",
      source: "stage",
      primary: "claude-cli:sonnet@high",
      backups: [],
    })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "generateContextPack", () => Promise.resolve("# Context\n")),
    patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
      Promise.resolve({
        availability: { available: true },
        providerLabel: "Claude Code",
        provider: "claude-cli",
        modelId: "claude-cli:sonnet@high",
        nativeModelId: "sonnet",
      })),
  ];
}

void describe("applyReviewEditWithAI — real in-flight activity through the production dispatcher", () => {
  void it("reports starting -> reading context -> model -> running through the real edit dispatch, then clears the row once the automatic re-review also completes", async () => {
    const { folderPath } = makeImplReviewTaskFolder(`applyrevedit-activity-live-${Math.floor(Math.random() * 1e9)}`);

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const warnStub = installProceedAnywayStub();
    const controllable = controllableImplementationRun();
    const patches = [
      ...installApplyReviewEditPatches(),
      patch(runnerRegistryModule, "runImplementationForModel", controllable.fn),
      stubV1RunnerSelection([markdownReviewTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("applyrevedit-activity-live")) { ended.push({ state: snap.state }); }
    });

    let liveRowActivity: string | undefined;
    let liveRowModelId: string | undefined;
    let liveRowOrigin: number | undefined;

    try {
      const context = makeExtensionContext();
      const dispatchPromise = applyReviewEditWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath }
      );

      // Wait for the real edit dispatch to reach the real (still-pending)
      // implementation provider call — proves applyImplementationReviewWithAI's
      // own "starting"/model/"reading context" reports, and
      // executeImplementationRun's shared "running" report, all actually ran
      // along the real code path, not merely that the source contains the
      // calls (as the sibling source-ordering suite only proved).
      await controllable.invoked;

      const liveRow = taskOperations.getTaskOperations(folderPath)[0];
      assert.ok(liveRow, "the root operation must still be live while the edit dispatch is in flight");
      liveRowActivity = liveRow?.activity;
      liveRowModelId = liveRow?.modelId;
      liveRowOrigin = liveRow?.activityStartedAt;

      await new Promise((resolve) => setTimeout(resolve, 20));

      controllable.resolveWith({
        status: "completed",
        filesChanged: ["src/a.ts"],
        summary: "stub apply-review-edit run",
        summaryIsSynthetic: true,
        runnerId: "claude-cli",
        actualProviderLabel: "Claude Code",
        actualStoredModelId: "claude-cli:sonnet@high",
      });

      await dispatchPromise;

      assert.equal(liveRowActivity, "running", "the real edit dispatch must have reported 'running' before the provider call");
      assert.equal(
        liveRowModelId,
        "claude-cli:sonnet@high",
        "the real edit dispatch must have attached the resolved impl-stage model via setModel before the provider call"
      );
      assert.equal(typeof liveRowOrigin, "number", "an elapsed origin must be set for the running stage");

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "the live row must be gone once the real dispatch (edit + automatic re-review) completes"
      );
      // Two ends are expected: the edit dispatch's own child operation
      // ("Applying implementation review") plus the automatic follow-up
      // re-review's child operation, both under the root Apply Review
      // operation — see applyReviewEditWithAI's two nested runTrackedOperation
      // calls. All must end as succeeded, never leave a stale row.
      assert.ok(ended.length > 0, "at least the root operation must have ended");
      assert.ok(
        ended.every((e) => e.state === "succeeded"),
        `every ended operation must end as succeeded, got: ${JSON.stringify(ended)}`
      );
    } finally {
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      warnStub.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
