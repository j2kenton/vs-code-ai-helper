/**
 * Command-boundary coverage for the unchanged-tree review guard (A1 1.0.0
 * gate, Part C Step 5). `reviewFreshness.test.ts` only exercises the pure
 * predicate `isReviewDispatchAgainstUnchangedTreeV1` in isolation; nothing
 * previously drove the REAL `runReviewForFolder` dispatch boundary where the
 * guard is actually wired (2026-09-04 review follow-up, narrowed completion
 * blocker de9851ef…-2: "Step 5's predicate is wired only for manual commands
 * already on the review stage... with no command-boundary refusal test").
 *
 * This suite drives the real exported `runReviewForFolder` against a real git
 * repo, specifically for the case the review named as the remaining gap: a
 * MAPPED SOURCE STAGE re-review (`currentStage: "impl"` dispatching against
 * `targetStage: "impl-high-review"`, i.e. `currentStage !== targetStage`) —
 * the exact shape that a prior version of the guard (gated behind
 * `currentStage === targetStage`) would have let through unchecked.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { runReviewForFolder } from "../commands/reviewActions";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
  StatusSurface,
} from "../utils/notificationRouter";
import type { TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-unchanged-guard-"));

// A real repo with a resolvable HEAD — resolveHeadCommitSha (gitRepoInfo.ts)
// shells out to real git, same as publishOwnershipMatrix.test.ts's identical
// setup, so this is not a fake/patched SHA but the actual current commit.
cp.execSync("git init", { cwd: REAL_ROOT, stdio: "ignore" });
cp.execSync(
  'git -c user.email=test@example.invalid -c user.name=test commit --allow-empty -m "init"',
  { cwd: REAL_ROOT, stdio: "ignore" }
);
const REAL_ROOT_HEAD_SHA = cp.execSync("git rev-parse HEAD", { cwd: REAL_ROOT }).toString().trim();

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-unchanged-guard-private-"));
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

after(() => {
  fs.rmSync(REAL_ROOT, { recursive: true, force: true });
});

/**
 * Writes a task folder whose `impl-high-review.md` already carries a
 * `reviewed-commit` marker equal to the CURRENT real HEAD — the exact
 * "nothing has changed since the last review" state the guard exists to
 * catch. `currentStage: "impl"` (not `"impl-high-review"`) is deliberate:
 * `REVIEW_TARGETS["impl"] === "impl-high-review"`, so this is the MAPPED
 * SOURCE STAGE case the review flagged as still bypassing the guard.
 */
function makeUnchangedTreeTaskFolder(name: string): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.dirname(folderPath),
      projectRoot: path.dirname(folderPath),
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved",
    },
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan-final.md"), "# Implementation\n\nDone.\n", "utf8");
  fs.writeFileSync(
    path.join(folderPath, "impl-high-review.md"),
    `Readiness: 7/10\n\n- Looks fine.\n\n<!-- reviewed-commit: ${REAL_ROOT_HEAD_SHA} -->\n`,
    "utf8"
  );
  return { folderPath };
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

function frame(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function markdownTransportV1(markdown: string, runnerId = "stub-review-runner"): AgentTransportV1 {
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

/** Same seam as publishOwnershipMatrix.test.ts / reviewActionsWorkflowActivityIntegration.test.ts. */
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

/** Records every notification instead of routing to a real tree view. */
function installNotificationRecorder(): { notifications: { message: string; level: string }[]; restore: () => void } {
  const notifications: { message: string; level: string }[] = [];
  const surface: StatusSurface = {
    addEntry: (message, level): void => { notifications.push({ message, level }); },
  };
  initNotificationRouter(surface);
  return { notifications, restore: (): void => deactivateNotificationRouter() };
}

void describe("runReviewForFolder — unchanged-tree guard at the command boundary (A1 1.0.0 gate, Part C Step 5)", () => {
  void it("silently refuses an AUTOMATION dispatch against an unchanged tree from a MAPPED SOURCE STAGE, and never touches model resolution or the provider", async () => {
    const { folderPath } = makeUnchangedTreeTaskFolder(`auto-unchanged-${Math.floor(Math.random() * 1e9)}`);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    let modelResolutionCalled = false;
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () => {
        modelResolutionCalled = true;
        return Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" });
      }),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => {
        modelResolutionCalled = true;
        return Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" });
      }),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () =>
        Promise.reject(new Error("must not reach context-pack write when the unchanged-tree guard refuses"))),
    ];

    try {
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl" as TaskStage,
        true,
        { automationDispatch: true }
      );

      assert.equal(
        modelResolutionCalled,
        false,
        "an automated re-review against an unchanged tree must never reach model resolution — the dispatch must be refused before any provider work starts"
      );
      assert.ok(
        recorder.notifications.some((n) => n.message.includes("skipped re-review") && n.message.includes("nothing has changed")),
        `expected a "skipped re-review" notification naming why; got: ${JSON.stringify(recorder.notifications)}`
      );

      const artifactAfter = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
      assert.ok(
        artifactAfter.includes("Readiness: 7/10"),
        "the existing review artifact must be untouched — no re-dispatch occurred"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("shows a cancellable modal for an INTERACTIVE dispatch against an unchanged tree from a MAPPED SOURCE STAGE, and refuses on cancel without touching model resolution", async () => {
    const { folderPath } = makeUnchangedTreeTaskFolder(`interactive-unchanged-${Math.floor(Math.random() * 1e9)}`);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    const windowTarget = vscode.window as unknown as Record<string, unknown>;
    const origShowWarning = windowTarget.showWarningMessage;
    const warningCalls: unknown[][] = [];
    windowTarget.showWarningMessage = (...args: unknown[]): Promise<string | undefined> => {
      warningCalls.push(args);
      return Promise.resolve(undefined); // simulate dismiss/cancel
    };

    let modelResolutionCalled = false;
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () => {
        modelResolutionCalled = true;
        return Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" });
      }),
      patch(modelSelectionModule, "resolveFreshModelForStage", () => {
        modelResolutionCalled = true;
        return Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" });
      }),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () =>
        Promise.reject(new Error("must not reach context-pack write when the unchanged-tree guard refuses"))),
    ];

    try {
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl" as TaskStage,
        true,
        {}
      );

      assert.equal(warningCalls.length, 1, "exactly one confirmation modal must be shown");
      const [message, opts, ...buttons] = warningCalls[0] as [string, { modal?: boolean }, ...string[]];
      assert.ok(message.includes("nothing has changed"), "the modal must explain why re-running would be pointless");
      assert.equal(opts?.modal, true, "the confirmation must be a blocking modal, not a dismissable toast");
      assert.deepEqual(buttons, ["I've made changes — re-check"], "the only bypass option must be the explicit re-check button");

      assert.equal(
        modelResolutionCalled,
        false,
        "cancelling the modal must refuse the dispatch before any provider work starts"
      );

      const artifactAfter = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
      assert.ok(artifactAfter.includes("Readiness: 7/10"), "the existing review artifact must be untouched on cancel");
    } finally {
      windowTarget.showWarningMessage = origShowWarning;
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("proceeds with a real dispatch when the interactive bypass is chosen, even though the tree is unchanged", async () => {
    const { folderPath } = makeUnchangedTreeTaskFolder(`interactive-bypass-${Math.floor(Math.random() * 1e9)}`);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    const windowTarget = vscode.window as unknown as Record<string, unknown>;
    const origShowWarning = windowTarget.showWarningMessage;
    windowTarget.showWarningMessage = (): Promise<string> => Promise.resolve("I've made changes — re-check");

    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 3/10\n\n- New blockers found.\n")]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    ];

    try {
      await runReviewForFolder(
        vscode.Uri.file(REAL_ROOT),
        vscode.Uri.file(folderPath),
        workspaceRoot,
        "impl" as TaskStage,
        true,
        {}
      );

      const artifactAfter = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
      assert.ok(
        artifactAfter.includes("Readiness: 3/10"),
        `bypassing the guard must let a real re-review overwrite the artifact; got: ${artifactAfter}`
      );
    } finally {
      windowTarget.showWarningMessage = origShowWarning;
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});
