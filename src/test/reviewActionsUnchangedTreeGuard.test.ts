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

import { fastForwardReviewWithAI, runReviewForFolder } from "../commands/reviewActions";
import { rerunReviewAfterUnchangedTreeCardV1 } from "../commands/rerunReviewAfterUnchangedTreeCardV1";
import { computeWorkingTreeFingerprintV1 } from "../utils/gitRepoInfo";
import {
  NotificationRouter,
  initNotificationRouter,
  deactivateNotificationRouter,
  StatusSurface,
} from "../utils/notificationRouter";
import type { TaskProgress, TaskStage } from "../types/taskProgress";
import type { AgentTransportV1 } from "../types/agentExecutionV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  buildUnusableImplementationSummaryV1,
  getImplementationSummaryUri,
} from "../utils/implementationArtifactResolver";
import { previousVersionUri } from "../utils/artifactBackups";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { safeRemoveDir } from "./testFsUtils";
import { computePublishScopeId, renderPublishChecksFreshnessStamp } from "../utils/publishChecksFreshness";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const workAdmissionModule = require("../state/workAdmissionV1") as Record<string, unknown>;
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
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
  safeRemoveDir(REAL_ROOT);
});

/**
 * Writes a task folder whose `impl-high-review.md` already carries a
 * `reviewed-commit` marker equal to the CURRENT real HEAD — the exact
 * "nothing has changed since the last review" state the guard exists to
 * catch. `currentStage: "impl"` (not `"impl-high-review"`) is deliberate:
 * `REVIEW_TARGETS["impl"] === "impl-high-review"`, so this is the MAPPED
 * SOURCE STAGE case the review flagged as still bypassing the guard.
 */
async function makeUnchangedTreeTaskFolder(name: string): Promise<{ folderPath: string }> {
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
  // The review guard now requires BOTH markers to match (RC1 item 3): the
  // commit AND a digest of the uncommitted working tree at the moment this
  // fixture is considered "already reviewed". Computed here, against the
  // exact same REAL_ROOT the guard will check against, right after every
  // other fixture file above is in place and before the guard runs — so it
  // is the true live fingerprint, not a hand-picked stand-in. The target
  // artifact itself (about to be written below) is excluded, mirroring the
  // production guard's own exclusion of its self-referential output.
  const reviewPath = path.join(folderPath, "impl-high-review.md");
  const fingerprint =
    (await computeWorkingTreeFingerprintV1(REAL_ROOT, {
      excludeAbsolutePaths: [
        reviewPath,
        previousVersionUri(vscode.Uri.file(reviewPath)).fsPath,
      ],
    })) ?? "unknown";
  fs.writeFileSync(
    reviewPath,
    `Readiness: 7/10\n\n- Looks fine.\n\n<!-- reviewed-commit: ${REAL_ROOT_HEAD_SHA} -->\n` +
      `<!-- reviewed-tree-fingerprint: ${fingerprint} -->\n`,
    "utf8"
  );
  return { folderPath };
}

/**
 * RC2 item 12, Step 25/26 completion blocker (2026-09-28 review): a task
 * sitting ON the review stage itself (`currentStage: "impl-high-review"`,
 * `REVIEW_TARGETS["impl-high-review"] === "impl-high-review"`), with a
 * CURRENT, non-stale review already on disk — `stageReviewPasses` and the
 * artifact's own `<!-- review-pass: N -->` marker agree, so
 * `isReviewPassCurrentV1` and `reviewPredatesLatestImplementationRoundV1`
 * both read it as fresh and `fastForwardReviewWithAI` never dispatches an
 * initial review. This is the fixture the exhausted-resume-budget test below
 * needs: a fast-forward call that can reach the budget check WITHOUT first
 * needing a real provider round for the initial review.
 */
async function makeCurrentReviewTaskFolderV1(name: string): Promise<{ folderPath: string }> {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stageReviewPasses: { "impl-high-review": 1 },
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
  const reviewPath = path.join(folderPath, "impl-high-review.md");
  const fingerprint =
    (await computeWorkingTreeFingerprintV1(REAL_ROOT, {
      excludeAbsolutePaths: [
        reviewPath,
        previousVersionUri(vscode.Uri.file(reviewPath)).fsPath,
      ],
    })) ?? "unknown";
  fs.writeFileSync(
    reviewPath,
    `Readiness: 7/10\n\n- Looks fine.\n\n<!-- reviewed-commit: ${REAL_ROOT_HEAD_SHA} -->\n` +
      `<!-- reviewed-tree-fingerprint: ${fingerprint} -->\n<!-- review-pass: 1 -->\n`,
    "utf8"
  );
  return { folderPath };
}

/**
 * Writes a task folder with NO existing review artifact for the target stage
 * (so the unchanged-tree guard above has nothing to compare against and
 * never fires) whose `impl-summary.md` is the `IMPLEMENTATION_SUMMARY_
 * UNUSABLE_MARKER_V1` stamp a rejected round leaves behind, with a usable
 * `impl-summary_prev.md` backup sitting right behind it — item 1's "surface
 * 1": `runReviewForFolder`'s OWN dispatch-refusal branch (the review-prompt
 * preparation guard, not Fast Forward's or the resume-preflight's copies of
 * the same offer).
 */
function makeUnusableSummaryTaskFolder(name: string): { folderPath: string } {
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
  const summaryUri = getImplementationSummaryUri(vscode.Uri.file(folderPath));
  fs.writeFileSync(
    summaryUri.fsPath,
    buildUnusableImplementationSummaryV1("bad shape", "run-log.md"),
    "utf8"
  );
  fs.writeFileSync(
    previousVersionUri(summaryUri).fsPath,
    "## Files Changed\n\n- `src/a.ts` — did a thing\n\n## Verification\n\n- tests pass\n",
    "utf8"
  );
  return { folderPath };
}

/**
 * Same as {@link makeUnusableSummaryTaskFolder}, except `plan-final.md`
 * carries a fully-settled checklist (every item checked, nothing
 * remaining) — v1 fixes 2, item 1 completion blocker (2026-09-18 review):
 * "run the implementation step again" is provably inert here, since there
 * is nothing left for a round to change.
 */
function makeUnusableSummaryFullySettledTaskFolder(name: string): { folderPath: string } {
  const { folderPath } = makeUnusableSummaryTaskFolder(name);
  fs.writeFileSync(
    path.join(folderPath, "plan-final.md"),
    "# Implementation Checklist\n\n<!-- ensemble:implementation-checklist -->\n\n- [x] Step one\n- [x] Step two\n",
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
function installNotificationRecorder(): {
  notifications: {
    message: string;
    level: string;
    actionCommand?: { command: string; title: string; args?: unknown[] };
  }[];
  restore: () => void;
} {
  const notifications: {
    message: string;
    level: string;
    actionCommand?: { command: string; title: string; args?: unknown[] };
  }[] = [];
  const surface: StatusSurface = {
    addEntry: (message, level, _filePath, _resultTargetUri, _sourceOperationId, actionCommand): void => {
      notifications.push({ message, level, actionCommand });
    },
  };
  initNotificationRouter(surface);
  return { notifications, restore: (): void => deactivateNotificationRouter() };
}

/**
 * `fastForwardReviewWithAI`'s own admission acquisition is real disk-marker
 * machinery (workAdmissionV1.ts) that this suite has no need to exercise —
 * only the refusal wording downstream of it is under test here. Patches
 * `acquireOrAdoptWorkAdmissionV1` to always report a fresh, trivially
 * releasable acquisition, mirroring the shape `WorkAdmissionHandleV1`
 * requires (heartbeat/release/handover all no-ops).
 */
function installAlwaysAcquiredWorkAdmissionV1(): Patched {
  return patch(workAdmissionModule, "acquireOrAdoptWorkAdmissionV1", () =>
    Promise.resolve({
      outcome: "acquired",
      handle: {
        ownerToken: "test-owner-token",
        claimId: "test-claim-id",
        taskFolderPath: "",
        commandId: "fastForwardReviewWithAI",
        purpose: "admission",
        heartbeat: (): Promise<void> => Promise.resolve(),
        release: (): Promise<void> => Promise.resolve(),
        handover: (): Promise<void> => Promise.resolve(),
      },
    })
  );
}

/**
 * §7.5's coarse host/provider gate and its edit-availability sibling are
 * both real CLI/Copilot probes — unrelated to what this suite is testing
 * (the unusable-summary refusal reached only once both gates pass).
 */
function installEditActionGatesAlwaysOkV1(): Patched[] {
  return [
    patch(runEditActionModule, "checkEditActionProviderPathGateV1", () => Promise.resolve({ ok: true })),
    patch(runEditActionModule, "checkEditActionAvailabilityV1", () => Promise.resolve({ ok: true })),
  ];
}

/** Minimal extension context with AI consent pre-granted, mirroring nextStageAutoReviewCommandChain.test.ts. */
function makeFastForwardExtensionContext(): vscode.ExtensionContext {
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

void describe("runReviewForFolder — unchanged-tree guard at the command boundary (A1 1.0.0 gate, Part C Step 5)", () => {
  void it("silently refuses an AUTOMATION dispatch against an unchanged tree from a MAPPED SOURCE STAGE, and never touches model resolution or the provider", async () => {
    const { folderPath } = await makeUnchangedTreeTaskFolder(`auto-unchanged-${Math.floor(Math.random() * 1e9)}`);
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

  void it("RC3 item 13: posts a local-only chat card for an INTERACTIVE dispatch against an unchanged tree from a MAPPED SOURCE STAGE, and opens no modal", async () => {
    const { folderPath } = await makeUnchangedTreeTaskFolder(`interactive-unchanged-${Math.floor(Math.random() * 1e9)}`);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    const windowTarget = vscode.window as unknown as Record<string, unknown>;
    const origShowWarning = windowTarget.showWarningMessage;
    let modalCalls = 0;
    windowTarget.showWarningMessage = (): Promise<string | undefined> => {
      modalCalls += 1;
      return Promise.resolve(undefined);
    };

    const askInteractionCalls: unknown[] = [];
    const fakeChatViewProvider = {
      askInteraction: (question: unknown): Promise<void> => {
        askInteractionCalls.push(question);
        return Promise.resolve();
      },
    } as unknown as import("../views/chatView").ChatViewProvider;

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
        { chatViewProvider: fakeChatViewProvider }
      );

      assert.equal(modalCalls, 0, "no modal must ever be shown for the unchanged-tree case");
      assert.equal(askInteractionCalls.length, 1, "exactly one chat card must be posted");
      const posted = askInteractionCalls[0] as {
        questions: readonly { prompt: string; options: readonly { optionId: string; label: string }[] }[];
        optionEffects?: Record<string, { kind: string; command?: string; args?: readonly unknown[] }>;
      };
      const question = posted.questions[0];
      assert.ok(question, "the card must carry a question");
      assert.match(question.prompt, /nothing has changed/i);
      const optionIds = question.options.map((o) => o.optionId);
      assert.deepEqual(optionIds, ["keepLastReview", "reviewAgainAnyway"]);
      assert.deepEqual(posted.optionEffects?.keepLastReview, { kind: "doNothing" });
      assert.deepEqual(posted.optionEffects?.reviewAgainAnyway, {
        kind: "command",
        command: "vs-code-ai-helper.rerunReviewAfterUnchangedTreeCardV1",
        args: [{ taskFolderPath: vscode.Uri.file(folderPath).fsPath, stage: "impl-high-review" }],
      });

      assert.equal(
        modelResolutionCalled,
        false,
        "posting the card must refuse the dispatch before any provider work starts — nothing awaits the answer"
      );

      const artifactAfter = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
      assert.ok(artifactAfter.includes("Readiness: 7/10"), "the existing review artifact must be untouched while the card is unanswered");
    } finally {
      windowTarget.showWarningMessage = origShowWarning;
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("RC3 item 13: a plain re-dispatch without going through the card's bypass command remains guarded (posts the card again)", async () => {
    const { folderPath } = await makeUnchangedTreeTaskFolder(`interactive-still-guarded-${Math.floor(Math.random() * 1e9)}`);
    const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    const askInteractionCalls: unknown[] = [];
    const fakeChatViewProvider = {
      askInteraction: (question: unknown): Promise<void> => {
        askInteractionCalls.push(question);
        return Promise.resolve();
      },
    } as unknown as import("../views/chatView").ChatViewProvider;

    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      stubV1RunnerSelection([markdownTransportV1("Readiness: 9/10\n\n- Ready.\n")]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () =>
        Promise.reject(new Error("must not reach context-pack write when the unchanged-tree guard refuses"))),
    ];

    try {
      for (let i = 0; i < 2; i += 1) {
        // A plain re-dispatch (no `skipUnchangedTreeGuard`) — simulating the
        // owner clicking Review again without having answered the card —
        // must hit the guard again each time, not remember an earlier visit.
        // eslint-disable-next-line no-await-in-loop
        await runReviewForFolder(
          vscode.Uri.file(REAL_ROOT),
          vscode.Uri.file(folderPath),
          workspaceRoot,
          "impl" as TaskStage,
          true,
          { chatViewProvider: fakeChatViewProvider }
        );
      }

      assert.equal(askInteractionCalls.length, 2, "the guard must post the card again on every un-bypassed dispatch, not just the first");
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("rerunReviewAfterUnchangedTreeCardV1 — the unchanged-tree card's sole bypass (RC3 item 13)", () => {
  void it("dispatches exactly one real review, bypassing the guard, when invoked with the card's args", async () => {
    const { folderPath } = await makeUnchangedTreeTaskFolder(`bypass-command-${Math.floor(Math.random() * 1e9)}`);
    // A review with zero changed files now refuses on its own (RC1 item 5).
    // The task tracks one changed file, so the bypass command's own dispatch
    // is what decides whether the review runs.
    const progressPath = path.join(folderPath, "task-progress.json");
    const trackedProgress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    fs.writeFileSync(
      progressPath,
      JSON.stringify({ ...trackedProgress, implReviewFiles: ["src/a.ts"] }, null, 2),
      "utf8"
    );
    const contextPack = path.join(folderPath, "context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    let transportInvokeCount = 0;
    const countingTransport: AgentTransportV1 = {
      runnerId: "stub-review-runner",
      invoke: (request, output) => {
        transportInvokeCount += 1;
        return markdownTransportV1("Readiness: 3/10\n\n- New blockers found.\n").invoke(request, output);
      },
    };
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      stubV1RunnerSelection([countingTransport]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub prompt")),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(undefined)),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    ];

    try {
      await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file(REAL_ROOT), {
        taskFolderPath: folderPath,
        stage: "impl-high-review" as TaskStage,
      });

      assert.equal(transportInvokeCount, 1, "the bypass command must dispatch exactly one review");
      const artifactAfter = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
      assert.ok(
        artifactAfter.includes("Readiness: 3/10"),
        `the bypass must let a real re-review overwrite the artifact; got: ${artifactAfter}; ` +
          `notifications: ${JSON.stringify(recorder.notifications)}`
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("refuses without dispatching when the task has since moved past the card's stage", async () => {
    const { folderPath } = await makeUnchangedTreeTaskFolder(`bypass-stale-${Math.floor(Math.random() * 1e9)}`);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();

    let promptRenderCount = 0;
    const patches: Patched[] = [
      patch(promptTemplatesModule, "renderPromptTemplate", () => {
        promptRenderCount += 1;
        return Promise.resolve("stub prompt");
      }),
    ];

    try {
      // The card was posted for "impl-plan-review" (say), but the task's
      // current stage no longer maps to it — a stale card from before the
      // task advanced.
      await rerunReviewAfterUnchangedTreeCardV1(vscode.Uri.file(REAL_ROOT), {
        taskFolderPath: folderPath,
        stage: "plan-high-review" as TaskStage,
      });

      assert.equal(promptRenderCount, 0, "a stale card must never dispatch a review");
      assert.ok(
        recorder.notifications.some((n) => n.message.includes("moved past the stage")),
        `expected a warning naming the stale card; got: ${JSON.stringify(recorder.notifications)}`
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

/**
 * v1 fixes 2, Part 1 step 2 / item 1: "Restore the last usable summary" must
 * be offered at EVERY surface that reads the unusable-summary stamp. Three
 * other surfaces (Fast Forward's `describeUnusableReviewBlockV1`, the resume
 * preflight's `buildReviewResumeVariablesV1`, and the restore mechanism
 * itself) already have coverage in `restoreRejectedImplementationRound.
 * test.ts`; this is the fourth and remaining one — `runReviewForFolder`'s OWN
 * dispatch-refusal branch, reached when a plain Review (or a Complete Stage &
 * Move On auto-review, which dispatches through this exact same function and
 * therefore needs no separate test) tries to prepare a review prompt and
 * finds `impl-summary.md` still stamped unusable.
 */
void describe("runReviewForFolder — offers Restore Last Usable Summary on its own dispatch refusal (item 1, Part 1 step 2)", () => {
  void it("attaches the restoreRejectedImplementationRound action when a usable _prev backup exists", async () => {
    const { folderPath } = makeUnusableSummaryTaskFolder(`unusable-summary-${Math.floor(Math.random() * 1e9)}`);
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
        "the unusable-summary refusal must fire before any model resolution or provider work starts"
      );
      const warning = recorder.notifications.find((n) => n.message.includes("did not produce usable"));
      assert.ok(warning, `expected an unusable-summary warning; got: ${JSON.stringify(recorder.notifications)}`);
      assert.match(warning.message, /Restore the last usable summary/);
      // Run Implementation takes priority as the toast's one action button
      // when both it and Restore apply (2026-09-24 review, narrowed
      // completion blocker) — Restore stays reachable via the tree row and
      // the "Restore Last Usable Summary" command; the message text above
      // still names it.
      assert.deepEqual(warning.actionCommand, {
        command: "vs-code-ai-helper.resumeAndDispatchImplementation",
        title: "Run Implementation",
        args: [{ taskFolderPath: folderPath }],
      });
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it(
    "never recommends rerunning implementation once the plan's checklist is fully settled (v1 fixes 2, " +
      "item 1 completion blocker, 2026-09-18 review)",
    async () => {
      const { folderPath } = makeUnusableSummaryFullySettledTaskFolder(
        `unusable-summary-settled-${Math.floor(Math.random() * 1e9)}`
      );
      const workspaceRoot: vscode.WorkspaceFolder = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 };
      const fsBridge = installFsBridge();
      const wsStub = installWorkspaceFoldersStub();
      const recorder = installNotificationRecorder();

      const patches: Patched[] = [
        patch(modelSelectionModule, "resolveModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
        patch(modelSelectionModule, "resolveFreshModelForStage", () =>
          Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
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

        const warning = recorder.notifications.find((n) => n.message.includes("did not produce usable"));
        assert.ok(warning, `expected an unusable-summary warning; got: ${JSON.stringify(recorder.notifications)}`);
        assert.match(warning.message, /Restore the last usable summary/);
        assert.match(warning.message, /fully settled/);
        assert.doesNotMatch(warning.message, /run the implementation step again/i);
        // Run Implementation still takes priority as the toast's one action
        // button here: a fully-settled checklist is not a reason to withhold
        // it (`shouldOfferRunImplementationForUnusableSummaryV1`'s doc
        // comment) — only the message TEXT above changes for this case.
        assert.deepEqual(warning.actionCommand, {
          command: "vs-code-ai-helper.resumeAndDispatchImplementation",
          title: "Run Implementation",
          args: [{ taskFolderPath: folderPath }],
        });
      } finally {
        for (const p of patches.reverse()) { p.restore(); }
        recorder.restore();
        wsStub.restore();
        fsBridge.restore();
      }
    }
  );
});

/**
 * v1 fixes 2, item 1 completion blocker (2026-09-18 review): "Fast Forward
 * still tests only `describeUnusableReviewBlockV1`... shared-path reasoning
 * does not satisfy this acceptance criterion" — the helper's OWN unit tests
 * (`restoreRejectedImplementationRound.test.ts`) prove the string it builds,
 * but nothing before this drove the real, registered `fastForwardReviewWithAI`
 * command through admission, the §7.5 provider-path/edit-availability gates,
 * `resolveTask`, and its "no initial review yet" branch to prove the SAME
 * restore action actually reaches the command boundary — not only the helper
 * function it happens to share with the other two surfaces.
 */
void describe("fastForwardReviewWithAI — offers Restore Last Usable Summary when it cannot even run an initial review (item 1, Part 1 step 2)", () => {
  void it("surfaces the Fast-Forward-specific restore action, re-entering Fast Forward itself on restore", async () => {
    const { folderPath } = makeUnusableSummaryTaskFolder(`ff-unusable-${Math.floor(Math.random() * 1e9)}`);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();
    const admissionPatch = installAlwaysAcquiredWorkAdmissionV1();
    const gatePatches = installEditActionGatesAlwaysOkV1();
    const context = makeFastForwardExtensionContext();

    // Unlike `runReviewForFolder`'s own direct-dispatch refusal (the sibling
    // describe block above), Fast Forward's "no initial review yet" branch
    // legitimately resolves a model BEFORE it ever reaches the unusable
    // summary — the §7.5 edit-availability gate (`checkEditActionAvailabilityV1`,
    // stubbed to `ok: true` above) needs `resolveFreshModelForStage` itself to
    // decide whether the target stage's model can even run edits, strictly
    // before any review content is read. That gate call is stubbed out here
    // via `installEditActionGatesAlwaysOkV1`, so this only needs a model id
    // for it to resolve against — not an assertion that resolution never runs.
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    ];

    try {
      await fastForwardReviewWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath },
        undefined
      );

      // The INNER refusal comes from runReviewForFolder's own dispatch-refusal
      // branch (already covered by the earlier describe block in this file);
      // the OUTER one — Fast Forward's own `describeUnusableReviewBlockV1`
      // wrapping, reached after that inner call returns with no artifact
      // written — is the one this test exists to prove reaches the command
      // boundary, distinguished by its "before fast-forwarding" wording and
      // its rerun command naming Fast Forward itself.
      const warning = recorder.notifications.find((n) =>
        n.message.includes("nothing to fast-forward from")
      );
      assert.ok(
        warning,
        `expected Fast Forward's own unusable-summary warning; got: ${JSON.stringify(recorder.notifications)}`
      );
      assert.match(warning.message, /Restore the last usable summary/);
      // Run Implementation takes priority as the toast's one action button
      // when both it and Restore apply (2026-09-24 review, narrowed
      // completion blocker) — Restore stays reachable via the tree row and
      // the "Restore Last Usable Summary" command.
      assert.deepEqual(warning.actionCommand, {
        command: "vs-code-ai-helper.resumeAndDispatchImplementation",
        title: "Run Implementation",
        args: [{ taskFolderPath: folderPath }],
      });
      assert.equal(
        fs.existsSync(path.join(folderPath, "impl-high-review.md")),
        false,
        "no review artifact must be written when both refusals fire before any provider work"
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const p of gatePatches.reverse()) { p.restore(); }
      admissionPatch.restore();
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

/**
 * RC1 item 9 (f3 Part 9): pressing Fast Forward right after the task moved onto
 * a review stage — before any review artifact exists for it — must START with
 * the review, never refuse with "No review found" (that wording belongs to
 * Apply Review, which genuinely needs an existing review). The stage here is
 * the review stage itself (`impl-high-review`), the post-transition shape; the
 * describe block above covers the pre-review source stage (`impl`).
 */
void describe("fastForwardReviewWithAI — a review stage with no review artifact yet runs the initial review (RC1 item 9)", () => {
  void it("reaches the initial-review branch and never reports 'No review found'", async () => {
    const { folderPath } = makeUnusableSummaryTaskFolder(`ff-post-transition-${Math.floor(Math.random() * 1e9)}`);
    const progressPath = path.join(folderPath, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as TaskProgress;
    fs.writeFileSync(
      progressPath,
      JSON.stringify({ ...progress, currentStage: "impl-high-review" as TaskStage }, null, 2),
      "utf8"
    );
    assert.equal(
      fs.existsSync(path.join(folderPath, "impl-high-review.md")),
      false,
      "fixture must have no review artifact"
    );

    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();
    const admissionPatch = installAlwaysAcquiredWorkAdmissionV1();
    const gatePatches = installEditActionGatesAlwaysOkV1();
    const context = makeFastForwardExtensionContext();
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    ];

    try {
      await fastForwardReviewWithAI(vscode.Uri.file(REAL_ROOT), context, { taskFolderPath: folderPath }, undefined);

      assert.equal(
        recorder.notifications.some((n) => /No review found/i.test(n.message)),
        false,
        `Fast Forward must not refuse for a missing review; got: ${JSON.stringify(recorder.notifications)}`
      );
      // The initial review was dispatched and refused by the unusable
      // implementation summary — Fast Forward's OWN wording proves the
      // "no review yet" branch ran the review rather than stopping earlier.
      assert.ok(
        recorder.notifications.some((n) => n.message.includes("nothing to fast-forward from")),
        `expected the initial-review branch to have run; got: ${JSON.stringify(recorder.notifications)}`
      );
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      for (const p of gatePatches.reverse()) { p.restore(); }
      admissionPatch.restore();
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

/**
 * RC3 item 6 (Step 8): a task reaching Publish with no Publish Checks
 * freshness stamp on disk (mirrors `publishOwnershipMatrix.test.ts`'s
 * "no-checks-" fixture, but driven through Fast Forward rather than a direct
 * review dispatch).
 */
function makePublishTaskFolderNoChecksV1(name: string): { folderPath: string } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "publish",
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
  return { folderPath };
}

/**
 * RC2 item 13, 2026-09-28: Fast Forward reaching Publish with Publish Checks
 * not yet run used to call `runReviewForFolder` first, which refused on the
 * freshness gate (`requirePublishChecksFreshnessOrWarnV1`) leaving no review
 * artifact written; Fast Forward's OWN "no initial review yet" branch then
 * read that same absence and reported a SECOND, misleading warning — "the
 * initial review did not produce usable output. Try running Review
 * manually" — for a dispatch that was never attempted, and no round the
 * ledger could ever legitimately call completed. Step 8 makes Fast Forward
 * run Publish Checks itself first, through the same command the Publish
 * row's own button uses, before ever calling `runReviewForFolder`.
 */
void describe("fastForwardReviewWithAI — Publish Checks gate (RC3 item 6 / Step 8)", () => {
  void it("runs Publish Checks first, never attempts the Publish review, and never reports the refusal as 'did not produce usable output'", async () => {
    await runPublishRefusalCaseV1(undefined, "Publish Checks declined to start without saying why");
  });

  void it("a Publish Checks refusal that raised a warning names that warning in the terminal row (RC7 item 5)", async () => {
    await runPublishRefusalCaseV1(
      "lint is not configured for this workspace",
      "Publish Checks declined to start: lint is not configured for this workspace"
    );
  });

  async function runPublishRefusalCaseV1(raisedWarning: string | undefined, expectedReason: string): Promise<void> {
    const { folderPath } = makePublishTaskFolderNoChecksV1(
      `ff-publish-no-checks-${Math.floor(Math.random() * 1e9)}`
    );
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();
    const bridge = installOperationNotificationBridge();
    const admissionPatch = installAlwaysAcquiredWorkAdmissionV1();
    const gatePatches = installEditActionGatesAlwaysOkV1();
    const context = makeFastForwardExtensionContext();
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    ];
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const priorOverride = commandsObj._executeCommandOverride;
    const executed: { id: string; args: unknown[] }[] = [];
    commandsObj._executeCommandOverride = (id: string, ...args: unknown[]): Promise<unknown> => {
      executed.push({ id, args });
      if (raisedWarning !== undefined) {
        NotificationRouter.showWarning(raisedWarning);
      }
      // Simulate a real `runPublishChecks` invocation that ran but left the
      // checks still not fresh (e.g. a real lint failure) — proving this
      // never gets misreported as an unusable review output.
      return Promise.resolve(undefined);
    };

    try {
      await fastForwardReviewWithAI(vscode.Uri.file(REAL_ROOT), context, { taskFolderPath: folderPath }, undefined);

      assert.equal(
        executed.some((c) => c.id === "vs-code-ai-helper.runPublishChecks"),
        true,
        `expected Fast Forward to run Publish Checks before attempting the Publish review; got: ${JSON.stringify(executed)}`
      );
      assert.equal(
        recorder.notifications.some((n) => /did not produce usable output/.test(n.message)),
        false,
        `a Publish-Checks-not-fresh refusal must never be reported as "did not produce usable output"; got: ${JSON.stringify(recorder.notifications)}`
      );
      assert.equal(
        fs.existsSync(path.join(folderPath, "publish-review.md")),
        false,
        "the Publish review must never be attempted (and so never write its artifact) before Publish Checks have passed"
      );
      // RC7 item 5: the refusal reason reaches the emitted terminal row.
      assert.equal(
        recorder.notifications.some(
          (n) => /refused — nothing was started \(/.test(n.message) && n.message.includes(expectedReason)
        ),
        true,
        `expected the Publish terminal row to carry "${expectedReason}"; got: ${JSON.stringify(recorder.notifications)}`
      );
      const progress = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as {
        roundLedger?: unknown[];
      };
      assert.equal(
        (progress.roundLedger ?? []).length,
        0,
        "a refused dispatch must never write a completed (or any) round to the ledger"
      );
    } finally {
      commandsObj._executeCommandOverride = priorOverride;
      for (const p of patches.reverse()) { p.restore(); }
      for (const p of gatePatches.reverse()) { p.restore(); }
      admissionPatch.restore();
      bridge.dispose();
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  }

  /**
   * 2026-09-30 review follow-up (RC3 item 6 / Step 8 completion blocker):
   * Publish Checks freshness passing is not the only way `runReviewForFolder`
   * can refuse a Publish dispatch before ever claiming a review attempt —
   * Step 6's own changed-file-record refusal ("no changed-file record for
   * this task... shows no changed files") fires INSIDE `runReviewForFolder`,
   * after the freshness gate passes, and already reports its own specific
   * reason via NotificationRouter. Before this fix, `fastForwardReviewWithAI`
   * unconditionally fell through to `describeUnusableReviewBlockV1`'s generic
   * "did not produce usable output. Try running Review manually" warning
   * whenever `initialContent` stayed empty — a second, wrong message on top
   * of the real one, plus an inapplicable "Run Implementation"/"Restore"
   * action. This fixture has FRESH Publish Checks (so it clears the
   * freshness gate cleanly) but no `implReviewFiles`, no round ledger and no
   * baseline sidecar, so Step 6's rebuild is refused with no changed-file
   * record — proving the fix is scoped to the actual gap, not merely to the
   * freshness-refusal case the sibling test above already covers.
   */
  void it("a Publish refusal from Step 6's changed-file-record check (not the freshness gate) is never re-reported as 'did not produce usable output'", async () => {
    const name = `ff-publish-no-scope-${Math.floor(Math.random() * 1e9)}`;
    const folderPath = path.join(REAL_ROOT, "plans", name);
    fs.mkdirSync(folderPath, { recursive: true });
    const progress: TaskProgress = {
      taskFolder: name,
      currentStage: "publish",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      implReviewFiles: undefined,
      // The Fast Forward Publish branch stops on the saved checks verdict
      // before Step 6, so this fixture's checks must have passed for the run
      // to reach Step 6's own changed-file-record refusal.
      lintPayload: { runAt: "2026-01-01T00:00:00.000Z", passed: true, source: "publish" },
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
    // A fresh Publish Checks stamp against the REAL_ROOT repo's actual HEAD —
    // mirrors publishOwnershipMatrix.test.ts's stampPublishChecksFreshnessV1
    // — so this fixture clears the freshness gate and reaches Step 6's own
    // changed-file-record rebuild, not the freshness refusal.
    const stampSection = renderPublishChecksFreshnessStamp({
      formatVersion: 1,
      runId: "00000000-0000-4000-8000-000000000000",
      verifiedCommitSha: REAL_ROOT_HEAD_SHA,
      completedAt: "2026-01-01T00:00:00.000Z",
      // Matches resolvePublishScopeFolder's own resolution for this fixture:
      // ownership.projectRoot is path.dirname(folderPath) below, and that
      // (not REAL_ROOT itself) is what the freshness check will hash.
      scopeId: computePublishScopeId(path.dirname(folderPath)),
    });
    fs.writeFileSync(
      path.join(folderPath, STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME),
      `${stampSection}\n`,
      "utf8"
    );

    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();
    const admissionPatch = installAlwaysAcquiredWorkAdmissionV1();
    const gatePatches = installEditActionGatesAlwaysOkV1();
    const context = makeFastForwardExtensionContext();
    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    ];
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const priorOverride = commandsObj._executeCommandOverride;
    commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);

    try {
      await fastForwardReviewWithAI(vscode.Uri.file(REAL_ROOT), context, { taskFolderPath: folderPath }, undefined);

      assert.equal(
        recorder.notifications.some((n) => /did not produce usable output/.test(n.message)),
        false,
        `Step 6's own changed-file-record refusal must never be re-reported as "did not produce usable output"; got: ${JSON.stringify(recorder.notifications)}`
      );
      assert.equal(
        recorder.notifications.some((n) => n.actionCommand?.title === "Run Implementation" || n.actionCommand?.title === "Restore Last Usable Summary"),
        false,
        "a missing-changed-file-record refusal must never offer Run Implementation/Restore — those actions do not apply to it"
      );
      const refusal = recorder.notifications.find((n) => /no changed-file record for this task/.test(n.message));
      assert.ok(
        refusal,
        `expected Step 6's own specific refusal reason to reach the owner; got: ${JSON.stringify(recorder.notifications)}`
      );
      const progressAfter = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as {
        roundLedger?: unknown[];
      };
      assert.equal(
        (progressAfter.roundLedger ?? []).length,
        0,
        "a refused dispatch must never write a completed (or any) round to the ledger"
      );
    } finally {
      commandsObj._executeCommandOverride = priorOverride;
      for (const p of patches.reverse()) { p.restore(); }
      for (const p of gatePatches.reverse()) { p.restore(); }
      admissionPatch.restore();
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

/**
 * RC2 item 12, Step 25/26 completion blocker (2026-09-28 review): a plateau
 * can be raised on the interrupted Fast Forward run's own FINAL allowed
 * attempt (`attemptNumber === maxAttempts`), or an owner can retry an already
 * fully-spent run. Either way, `computeFastForwardResumeBudgetV1`'s
 * `remainingBudgetExhausted` must be `true` and `fastForwardReviewWithAI`
 * must make NO further apply/re-review cycle — running one more off the
 * arithmetic value's `Math.max(1, …)` floor would silently exceed the
 * interrupted run's own committed budget. This drives the real command
 * (not just the pure arithmetic already covered in `activeFastForwardRunsV1.
 * test.ts`) so a regression that skips the guard at the actual call site is
 * caught, not just one in the helper function.
 */
void describe("fastForwardReviewWithAI — a resumed run whose captured offset already exhausted its budget (RC2 item 12, Step 25 completion blocker)", () => {
  void it("makes no further attempt, dispatches no provider round, and leaves the existing review untouched", async () => {
    const { folderPath } = await makeCurrentReviewTaskFolderV1(`ff-exhausted-${Math.floor(Math.random() * 1e9)}`);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const recorder = installNotificationRecorder();
    const admissionPatch = installAlwaysAcquiredWorkAdmissionV1();
    const gatePatches = installEditActionGatesAlwaysOkV1();
    const context = makeFastForwardExtensionContext();

    // The §7.5 gate above the budget check legitimately resolves a model for
    // its own availability probe (see resolveFreshModelForStage's call at
    // reviewActions.ts:7898) — patched here exactly like the sibling tests
    // above, NOT to prove it is unreached (it runs before the budget check),
    // but so it never shells out to a real CLI/Copilot probe in this test.
    const modelPatches: Patched[] = [
      patch(modelSelectionModule, "resolveModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
      patch(modelSelectionModule, "resolveFreshModelForStage", () =>
        Promise.resolve({ source: "settings", modelId: "claude-cli:sonnet@high" })),
    ];
    // The actual apply/review provider reservation — reached only from
    // INSIDE improveReviewScore's loop — must never be consulted at all once
    // the budget is exhausted. Throwing here turns any such call into a hard
    // test failure instead of a silently-passing extra attempt.
    const openerPatch = patch(runnerRegistryModule, "createV1RunnerSelectionOpener", () => {
      throw new Error("must not resolve a provider when the resumed budget is already exhausted");
    });

    try {
      await fastForwardReviewWithAI(
        vscode.Uri.file(REAL_ROOT),
        context,
        { taskFolderPath: folderPath, resumeFromAttemptV1: { attemptNumber: 10, maxAttempts: 10 } },
        undefined
      );

      assert.ok(
        recorder.notifications.some(
          (n) => n.message.includes("already used all 10 attempt(s)") && n.message.includes("resuming it would exceed its own budget")
        ),
        `expected the exhausted-budget warning naming the spent total; got: ${JSON.stringify(recorder.notifications)}`
      );

      const artifactAfter = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
      assert.ok(
        artifactAfter.includes("Readiness: 7/10"),
        "no apply/re-review cycle must have run — the existing review artifact must be untouched"
      );
    } finally {
      openerPatch.restore();
      for (const p of modelPatches.reverse()) { p.restore(); }
      for (const p of gatePatches.reverse()) { p.restore(); }
      admissionPatch.restore();
      recorder.restore();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // The complementary "budget NOT yet exhausted still runs its remaining
  // attempt" boundary is covered at the arithmetic level in
  // activeFastForwardRunsV1.test.ts ("a resume offset one short of the total
  // … is not exhausted") — driving that case through this command's real
  // edit-capable apply branch would require mocking a full implementation-
  // runner CLI spawn (applyReviewEditWithAI's edit path, distinct from the
  // review-only V1 runner selection stubbed above), which is out of
  // proportion for what this boundary needs proven.
});
