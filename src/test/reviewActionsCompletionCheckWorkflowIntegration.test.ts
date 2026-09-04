/**
 * Notifications in-flight visibility (Part III) — REAL behavioral coverage
 * for the workflow-level completion-check transition.
 *
 * Review blocker 7bf9f2ec…-0 (remaining portion): `completionCheckActivity
 * Accumulator.test.ts` drives `createCompletionCheckActivityAccumulatorV1`
 * directly against a fake `TaskOperationHandle`, and
 * `completionLintCheckObserver.test.ts` drives `collectCompletionLint`'s
 * `onCheckEvent` observer directly — neither test exercises the actual
 * PRODUCTION wiring that connects the two: `buildVerifiedChecksVariable`
 * inside `runReviewForFolder`'s implementation-review branch, which is the
 * only caller that ever constructs the accumulator and threads it through
 * `collectCompletionLintPreview` against a REAL operation on the REAL
 * registry (reviewActions.ts:2680-2688).
 *
 * `reviewActionsWorkflowActivityIntegration.test.ts` drives the REAL
 * `runReviewForFolder`, but only through the `isPlanReview` branch, which
 * never reaches `buildVerifiedChecksVariable` at all — so the "actual
 * completion-check workflow transition" (an implementation-review round
 * whose completion checks report into the live root) has never been driven
 * end to end.
 *
 * This suite closes that gap: it runs `runReviewForFolder` for
 * `impl-high-review` against a REAL temporary workspace with REAL fast
 * (`node -e`) package.json scripts, so `collectCompletionLintPreview`
 * genuinely spawns real child processes (the same pattern
 * `completionLintCheckObserver.test.ts` uses for its own real-process
 * concurrency proof), and observes the REAL registry row transition through
 * starting -> completion-check aggregate labels -> the review's own
 * "running" stage -> cleared, via the production `reportActivity` choke
 * point.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runReviewForFolder } from "../commands/reviewActions";
import { runTrackedOperation, taskOperations } from "../utils/taskOperations";
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

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-completioncheck-workflow-"));

// Real, FAST conventional scripts so `collectCompletionLintPreview`'s
// package.json-driven candidate detection finds genuine, quick-to-run
// commands (same pattern as completionLintCheckObserver.test.ts) instead of
// either failing on a missing package.json or running this repo's own real
// (slow) lint/check-types/test suites against REAL_ROOT.
fs.writeFileSync(
  path.join(REAL_ROOT, "package.json"),
  JSON.stringify(
    {
      name: "completion-check-workflow-fixture",
      scripts: {
        lint: 'node -e "setTimeout(() => process.exit(0), 60)"',
        "check-types": 'node -e "setTimeout(() => process.exit(0), 30)"',
        test: 'node -e "setTimeout(() => process.exit(0), 90)"',
      },
    },
    null,
    2
  ),
  "utf8"
);

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-completioncheck-workflow-private-"));
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
    path.join(folderPath, "impl-summary.md"),
    "# Implementation Summary\n\nGood notes from a usable round.\n",
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

interface Patched { restore: () => void }

function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

/** Spies on the registry's own `reportActivity` choke point (see the
 * identical helper in `reviewActionsImplementationActivityIntegration
 * .test.ts`) so the test can assert the REAL ordered sequence of activity
 * labels the workflow reported, not just a value sampled after the fact. */
function spyOnReportedActivity(): { log: (string | undefined)[]; restore: () => void } {
  const log: (string | undefined)[] = [];
  const orig = taskOperations.reportActivity.bind(taskOperations);
  (taskOperations as unknown as Record<string, unknown>).reportActivity = (
    id: string,
    activity: string | undefined,
    options?: { resetElapsedOrigin?: boolean; stageToken?: number; elapsedOrigin?: number }
  ): number | undefined => {
    const result = orig(id, activity, options);
    if (result !== undefined) { log.push(activity); }
    return result;
  };
  return {
    log,
    restore: (): void => { (taskOperations as unknown as Record<string, unknown>).reportActivity = orig; },
  };
}

function installImplReviewPatches(contextPackPath: string): Patched[] {
  fs.writeFileSync(contextPackPath, "# Context\n", "utf8");
  return [
    patch(settingsModule, "isAutoAdvanceEnabled", () => false),
    patch(modelSelectionModule, "resolveModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
    patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPackPath))),
  ];
}

void describe("runReviewForFolder (impl-high-review) — real completion-check activity through the production workflow", () => {
  void it("aggregates real, concurrently-run completion checks into the live root's activity row, then transitions to the review's own running stage and clears on completion", async () => {
    const { folderPath } = makeImplReviewTaskFolder(
      `completioncheck-workflow-${Math.floor(Math.random() * 1e9)}`
    );
    const taskFolderUri = vscode.Uri.file(folderPath);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const contextPack = path.join(folderPath, "context-pack.md");
    const activitySpy = spyOnReportedActivity();
    const patches = [
      ...installImplReviewPatches(contextPack),
      stubV1RunnerSelection([markdownReviewTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
    ];

    const ended: { state: string }[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("completioncheck-workflow")) { ended.push({ state: snap.state }); }
    });

    try {
      await runTrackedOperation(
        folderPath,
        {
          label: "High-Level Code Review",
          stage: "impl-high-review",
          taskName: "Completion Check Workflow Test",
          kind: "review",
          cancellable: true,
        },
        async (op) => {
          await runReviewForFolder(
            vscode.Uri.file(REAL_ROOT),
            taskFolderUri,
            workspaceRoot,
            "impl-high-review",
            true,
            { operation: op }
          );
        }
      );

      // Collapse consecutive duplicates: reportActivity REPLACES, never
      // appends, so what matters is the sequence of DISTINCT states this one
      // real round moved through, not incidental repeats.
      const deduped = activitySpy.log.filter((activity, index) => activity !== activitySpy.log[index - 1]);

      const startingIdx = deduped.indexOf("starting");
      assert.ok(startingIdx >= 0, "the review stage must report 'starting' first");

      // The accumulator's real labels: either the single-active-check form
      // (`command · N/3 complete`) or the multi-active form
      // (`K checks running · command (+K-1) · N/3 complete`) — both contain
      // "complete" as their trailing clause (createCompletionCheckActivity
      // AccumulatorV1's renderActive/settled rendering). Proves the real
      // `onCheckEvent` callbacks from a REAL collectCompletionLint pass
      // (three genuine `node -e` child processes) actually reached the REAL
      // registry row through `buildVerifiedChecksVariable`'s accumulator,
      // not just that the wiring is reachable in source.
      const checkLabelIndices = deduped
        .map((activity, index) => ({ activity, index }))
        .filter(({ activity }) => typeof activity === "string" && activity.includes("complete"));
      assert.ok(
        checkLabelIndices.length > 0,
        `expected at least one completion-check aggregate label, got: ${JSON.stringify(deduped)}`
      );
      assert.ok(
        checkLabelIndices[0]!.index > startingIdx,
        "the first completion-check label must be reported after 'starting'"
      );

      // The final completion-check label must report the true grand total
      // (3: lint, check-types, test — no monorepo members, no explicit
      // commands) fully settled, before the review's own dispatch begins.
      const lastCheckLabel = deduped[checkLabelIndices[checkLabelIndices.length - 1]!.index];
      assert.match(
        lastCheckLabel!,
        /3\/3 complete/,
        `expected the final completion-check label to report the true grand total 3/3, got: ${lastCheckLabel}`
      );

      // Once buildVerifiedChecksVariable returns (accumulator closed), the
      // review stage's own "running" report — guarded by the SAME stageToken
      // the accumulator used — must follow, proving the accumulator's
      // `close()` correctly hands control back rather than leaving a stale
      // check label in place or racing the stage's own transition.
      const lastCheckIdx = checkLabelIndices[checkLabelIndices.length - 1]!.index;
      const runningIdx = deduped.indexOf("running", lastCheckIdx);
      assert.ok(runningIdx > lastCheckIdx, "the review's own 'running' report must follow the last completion-check label");

      assert.deepEqual(
        taskOperations.getTaskOperations(folderPath),
        [],
        "the live row must be gone once the real review round completes"
      );
      assert.deepEqual(ended.map((e) => e.state), ["succeeded"], "the real lifecycle must end as succeeded");
    } finally {
      activitySpy.restore();
      endSub.dispose();
      for (const p of patches.reverse()) { p.restore(); }
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
