/**
 * End-to-end deferred/incomplete implementation-round recovery
 * (plan Part 1, step 4): drives the REAL `runImplementationWithAI` →
 * `executeImplementationRun` path with only the provider boundary
 * (`runImplementationOrSealedV1`) and the extension-host seams faked — the
 * same require-cache monkey-patch harness completeAndMoveOnFastForward.test.ts
 * uses — and asserts the full recovery contract:
 *
 *   - a detected round leaves impl-summary.md, impl-summary_prev.md, and the
 *     review artifact's CONTENT byte-identical;
 *   - the review is flagged invalid via the durable metadata marker, not a
 *     placeholder write;
 *   - the round's delta lands in `pendingImplReviewFiles` and never in
 *     `implReviewFiles`, and is durable BEFORE the run log is written
 *     (crash-order invariant);
 *   - a continuation implementation round is scheduled (chainId
 *     "impl-continuation") instead of auto-advance/review dispatch;
 *   - an EMPTY completed response is the limiting case of the same contract
 *     (review blocker, 2026-08-13: it used to fall onto the rejected-summary
 *     path and bank its files);
 *   - a later successful round's prompt carries the Continuation Notice, its
 *     progress patch promotes the pending set (union with its own delta),
 *     and the review-invalid marker is cleared only after replacement
 *     review-tracking state has persisted (asserted across every persisted
 *     state, not just the final one);
 *   - the continuation cap escalates to human — pausing the task — even at
 *     an implementation stage where `reviewAttemptId` is legitimately absent.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { handleReviewOutcomeV1, runImplementationWithAI, runReviewForFolder } from "../commands/reviewActions";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { applyReviewerVerifiedTicks, applyReviewerVerifiedTicksConfirmedV1 } from "../commands/applyReviewerVerifiedTicks";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import {
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  MAX_ROUND_OUTCOMES,
  REVIEW_STAGES,
  TaskProgress,
  TaskStage,
} from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import { effectiveReviewProgressV1 } from "../utils/effectiveReviewProgress";
import { readyToAdvanceStage } from "../utils/reviewReadiness";
import { getAutoAdvanceScoreThreshold } from "../config/settings";
import type { AutomationDispatch } from "../utils/automationChain";
import type { AgentTransportExitV1, AgentTransportV1 } from "../types/agentExecutionV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";

/* eslint-disable @typescript-eslint/no-var-requires */
const runEditActionModule = require("../commands/runEditActionV1") as Record<string, unknown>;
const implContinuationTextDispatchModule =
  require("../commands/implContinuationTextDispatchV1") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const contextPackModule = require("../utils/contextPack") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const promptSizeGuardModule = require("../utils/promptSizeGuard") as Record<string, unknown>;
const automationChainModule = require("../utils/automationChain") as Record<string, unknown>;
const settingsModule = require("../config/settings") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
const progressWriterModule = require("../services/taskProgressWriterV1") as Record<string, unknown>;
const publishPreflightModule = require("../utils/publishPreflight") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-deferred-round-"));
// Hermetic git scope: the OS temp dir can itself sit inside a git work tree
// (e.g. a dotfiles repo at the user's home directory), in which case the
// pre-run safety check's `git status` walks that ENTIRE tree — observed at
// 75s on a real machine, timing out every test here. A repo at the harness
// root pins rev-parse/status to this tiny directory instead.
cp.execFileSync("git", ["init", "-q"], { cwd: REAL_ROOT, windowsHide: true });

// Part 8 step 1's review-round hops (below) drive runReviewForFolder, whose
// AI metadata path runs through the real production coordinator
// (createProductionTaskActionCoordinatorV1) — that requires the Chat
// interaction transaction store to be wired exactly as extension.ts does at
// activation, or getProductionActionConversationOrchestratorV1 throws "not
// wired yet". runImplementationWithAI's existing harness above never needed
// this (it replaces runImplementationOrSealedV1 wholesale, below the
// coordinator), so this file had no such wiring until this addition.
// Mirrors publishOwnershipMatrix.test.ts's identical setup.
const REVIEW_PRIVATE_STORAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "ensemble-deferred-round-review-private-")
);
const REVIEW_PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(
  REVIEW_PRIVATE_STORAGE_ROOT
);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: REVIEW_PRIVATE_STORAGE_ROOT_ID,
  })
);

/** The observed round-014 shape: a deferral to a wakeup that never fires. */
const DEFERRED_RESPONSE =
  "All edits are staged. Waiting for the background test run to finish " +
  "(scheduled wakeup in ~5 min). I'll pick back up automatically when it " +
  "completes or the wakeup fires.";

const PLAN_FINAL = [
  "<!-- Generated by Test -->",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist",
  "",
  "- [ ] Add the resolver",
  "- [ ] Wire the decoder",
  "",
].join("\n");

/** A summary that passes the shape gate: echo + own Files Changed + Verification. */
const GOOD_SUMMARY = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Add the resolver",
  "- [ ] Wire the decoder",
  "",
  "## Files Changed",
  "",
  "- `src/resolver.ts` — added the resolver",
  "",
  "## Verification",
  "",
  "- ran the unit tests",
].join("\n");

/**
 * Verbatim round-077 plan of record and response ("workflow 3" task, review
 * finding 2026-08-15) — real production text, not a hand-authored toy, kept
 * as fixture files rather than inline strings because both are long enough
 * that hand-transcribing them into a template literal risked silently
 * altering the exact byte content the reproduction depends on.
 */
const ROUND_077_PLAN_FINAL = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "test", "fixtures", "round077", "plan-final.md"),
  "utf8"
);
const ROUND_077_SUMMARY = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "test", "fixtures", "round077", "response.md"),
  "utf8"
).trimEnd();
const ROUND_077_FILES_CHANGED = [
  "packages/ensemble-core/src/taskProgressDecoderV1.ts",
  "packages/ensemble-core/src/taskProgressV1.ts",
  "src/commands/reviewActions.ts",
  "src/services/taskProgressDecoderV1.ts",
  "src/test/reviewRouting.test.ts",
  "src/test/taskProgressDecoderV1.test.ts",
  "src/types/taskProgress.ts",
  "src/utils/reviewRouting.ts",
];

const PRIOR_SUMMARY = "# Prior Round Summary\n\nGood notes from the last usable round.\n";
const PRIOR_SUMMARY_PREV = "# Even Older Summary\n";
const PRIOR_REVIEW =
  "# Implementation Review\n\nReadiness: 6/10\n\nReal review content that must be preserved.\n";

interface FakeRunResult {
  status: "completed" | "failed" | "cancelled";
  filesChanged: string[];
  filesChangedUnknown?: boolean;
  summary?: string;
  summaryIsSynthetic?: boolean;
  runnerId: string;
  providerLabel?: string;
  storedModelId?: string;
  typeCheckFailed?: boolean;
  typeCheckOutput?: string;
  /**
   * The sealed pipeline's own per-step receipts (2026-08-21 review round —
   * required to drive `runAutomaticChecklistReconciliationV1`'s tier 2
   * through the REAL production write path in reviewActions.ts, rather than
   * only through direct unit calls — see the "automatic checklist
   * reconciliation (production path, end to end)" describe block below).
   */
  appliedOperations?: { kind: string; path: string; contentExcerpt?: string }[];
  /** See `AssembledPromptCaptureV1`/`AssembledPromptAttemptsV1` (runEditActionV1.ts). */
  assembledPrompt?: { attemptId: string; prompt: string; promptSha256: string };
  /** See `AssembledPromptAttemptsV1` — review fix, 2026-08-27 (Step 7, per-attempt cardinality). */
  assembledPromptAttempts?: { attemptId: string; prompt: string; promptSha256: string }[];
}

function makeTaskFolder(
  name: string,
  extraProgress: Partial<TaskProgress> = {}
): { folderPath: string; folderUri: vscode.Uri; progress: TaskProgress } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    implReviewFiles: ["src/prior.ts"],
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    ...extraProgress,
  };
  fs.writeFileSync(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(folderPath, "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "plan-final.md"), PLAN_FINAL, "utf8");
  fs.writeFileSync(path.join(folderPath, "impl-summary.md"), PRIOR_SUMMARY, "utf8");
  fs.writeFileSync(path.join(folderPath, "impl-summary_prev.md"), PRIOR_SUMMARY_PREV, "utf8");
  fs.writeFileSync(path.join(folderPath, "impl-high-review.md"), PRIOR_REVIEW, "utf8");
  return { folderPath, folderUri: vscode.Uri.file(folderPath), progress };
}

function makeButtonPressArg(folderPath: string, progress: TaskProgress): { task: IncompleteTask } {
  return {
    task: {
      folderUri: vscode.Uri.file(folderPath),
      folderName: path.basename(folderPath),
      progress,
      canonicalId: folderPath,
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

/**
 * Part 8 step 1's review-round harness, borrowed from
 * publishOwnershipMatrix.test.ts's identical machinery: a V1 transport that
 * frames a completed markdown-artifact.v1 envelope echoing the request's
 * correlation, so a scripted review round can drive the REAL
 * runReviewForFolder -> handleReviewOutcomeV1 -> advanceStageViaNextStageRowV1
 * chain instead of only the effectiveReviewProgressV1/readyToAdvanceStage
 * predicate pair the "Part 3, end to end" block above calls directly.
 */
function frameV1ReviewResult(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

function markdownReviewTransportV1(markdown: string, runnerId = "stub-review-runner"): AgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frameV1ReviewResult({
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

/** Stubs runnerRegistry's V1 selection opener so a review round never reaches a real CLI/Copilot provider. */
function stubV1ReviewRunnerSelection(transports: readonly AgentTransportV1[]): Patched {
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

/**
 * Drives ONE real review round for `currentStage` (a same-stage self-review,
 * exactly what "run the review for the task's current stage" means in
 * production) through the actual advance chain, self-contained like
 * `runHarnessed` above: installs and tears down its own fs bridge,
 * workspace-folders stub, and notification router.
 */
async function runPassingReviewHarnessed(
  folderPath: string,
  currentStage: TaskStage,
  reviewText: string
): Promise<void> {
  const provider = new StatusTreeProvider();
  initNotificationRouter(provider);
  const fsBridge = installFsBridge();
  const wsStub = installWorkspaceFoldersStub();
  const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
  const contextPack = path.join(folderPath, "review-context-pack.md");
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
    stubV1ReviewRunnerSelection([markdownReviewTransportV1(reviewText)]),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub review prompt")),
    patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
    patch(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> => Promise.resolve(true)),
    patch(publishPreflightModule, "checkPublishPreflight", () =>
      Promise.resolve({
        ok: true,
        lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] },
      })),
  ];
  try {
    await runReviewForFolder(
      vscode.Uri.file(REAL_ROOT),
      vscode.Uri.file(folderPath),
      workspaceRoot,
      currentStage,
      true,
      {}
    );
  } finally {
    for (const p of patches.reverse()) { p.restore(); }
    wsStub.restore();
    fsBridge.restore();
    provider.dispose();
    deactivateNotificationRouter();
  }
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

interface HarnessRun {
  /** Every automation-chain dispatch recorded instead of executed. */
  dispatches: AutomationDispatch[];
  /** Prompts the fake provider boundary was invoked with. */
  prompts: string[];
  /**
   * Prompts the fake TEXT-MODE continuation dispatch
   * (`runSummaryOnlyContinuationV1`) was invoked with — a summary-only
   * continuation must land here, never in `prompts` (the edit path).
   */
  textPrompts: string[];
  /**
   * Persisted pendingImplReviewFiles as read from DISK at the moment the run
   * log was written — the crash-order probe for "quarantine is durable first".
   */
  pendingAtRunLogWrite: string[][];
  /**
   * Persisted implRecovery record as read from DISK at the moment the run
   * log was written — the crash-order probe for "the recovery transition is
   * durable before anything else" (Part 1).
   */
  recoveryAtRunLogWrite: (TaskProgress["implRecovery"] | undefined)[];
  /**
   * After every patchTaskProgressStrictV1 persist: the marker's presence and
   * whether the review artifact was stale-stamped at that instant, for the
   * marker-clear ordering invariant. Also carries `status` and
   * `checklistProgressUnreliable` so tests can assert no persisted state ever
   * shows the task paused without a remedy latch that the pause reason names
   * already being true (the no-progress-breaker atomicity invariant).
   */
  persistedStates: {
    markerSet: boolean;
    reviewStale: boolean;
    status: TaskProgress["status"];
    checklistProgressUnreliable: boolean;
  }[];
  /**
   * Every status-surface notification the run emitted, with its action
   * command when one was attached — the reconciliation-affordance probe
   * (finding 3).
   */
  notifications: { message: string; actionCommand?: { command: string; title: string } }[];
  /**
   * Every pending `WorkflowDecisionV1` left in the store at the end of the
   * run (task: "Replace hidden notification decision buttons with explained,
   * selectable decisions") — the reconcile/apply-ticks/restore notifications
   * this run's write paths used to attach a bare action button to now post a
   * decision here instead; assertions check `decisionKey` rather than a
   * notification's `actionCommand`. Populated by `runHarnessed` itself, so it
   * is absent until the harness returns.
   */
  pendingDecisions?: readonly import("../types/workflowDecisionV1").WorkflowDecisionV1[];
}

interface HarnessOptions {
  /**
   * Result the fake text-mode dispatch returns when a summary-only
   * continuation routes there. When absent, a text dispatch is unexpected
   * and throws — pinning that only summary-only continuations use it.
   */
  textResult?: FakeRunResult;
  /**
   * What the patched `isSummaryOnlyDispatchAvailableV1` probe reports.
   * Defaults to false (the enforceable fallback), keeping every test
   * deterministic against the real probe's settings-dependent answer. The
   * real probe now requires BOTH that the resolved provider's text mode
   * withholds edits AND that it honours the requested response contract
   * (`isCliTextModeSummaryOnlyCapableV1`, tightened 2026-08-20 — claude-cli's
   * plan mode withholds edits but is a repurposed interactive flow that can
   * override the requested report), but this stub stays a plain boolean:
   * the harness only needs to control the coarse "is text dispatch usable at
   * all" outcome, not exercise the probe's own per-provider logic.
   */
  summaryOnlyDispatchAvailable?: boolean;
  /**
   * When set, simulates an edit-mode round directly rewriting plan-final.md
   * during the round — written to disk the instant the fake edit dispatch
   * runs, before `result` is returned — so the checklist-mutation guard
   * (wf "make the stage chat a record of work", Part 6 / item 5) can be
   * exercised against the real production write path.
   */
  mutatePlanFinalDuringRound?: string;
}

async function runHarnessed(
  folderPath: string,
  progress: TaskProgress,
  result: FakeRunResult,
  harnessOptions: HarnessOptions = {}
): Promise<HarnessRun> {
  const provider = new StatusTreeProvider();
  initNotificationRouter(provider);
  const fsBridge = installFsBridge();
  const wsStub = installWorkspaceFoldersStub();
  const windowTarget = vscode.window as unknown as Record<string, unknown>;
  const origShowWarning = windowTarget.showWarningMessage;
  // The pre-run safety modal for a non-git workspace: always proceed.
  windowTarget.showWarningMessage = (): Promise<string> => Promise.resolve("Proceed Anyway");

  const run: HarnessRun = {
    dispatches: [],
    prompts: [],
    textPrompts: [],
    pendingAtRunLogWrite: [],
    recoveryAtRunLogWrite: [],
    persistedStates: [],
    notifications: [],
  };

  // Notification probe: NotificationRouter routes through the provider's
  // addEntry, whose sixth argument is the optional action command.
  const providerTarget = provider as unknown as {
    addEntry: (...args: unknown[]) => unknown;
  };
  const origAddEntry = providerTarget.addEntry.bind(provider);
  providerTarget.addEntry = (...args: unknown[]): unknown => {
    run.notifications.push({
      message: args[0] as string,
      actionCommand: args[5] as { command: string; title: string } | undefined,
    });
    return origAddEntry(...args);
  };

  const progressFile = path.join(folderPath, "task-progress.json");
  const reviewFile = path.join(folderPath, "impl-high-review.md");
  const origWriteRunLog = runLogModule.writeRunLog as (...args: unknown[]) => Promise<vscode.Uri>;
  const origPatch = progressWriterModule.patchTaskProgressStrictV1 as (
    ...args: unknown[]
  ) => Promise<TaskProgress | undefined>;

  const patches: Patched[] = [
    patch(automationChainModule, "scheduleAutomationChain", (dispatch: AutomationDispatch): Promise<boolean> => {
      run.dispatches.push(dispatch);
      return Promise.resolve(true);
    }),
    patch(runEditActionModule, "checkEditActionProviderPathGateV1", () => Promise.resolve({ ok: true })),
    patch(runEditActionModule, "checkEditActionAvailabilityV1", () => Promise.resolve({ ok: true })),
    patch(runEditActionModule, "runImplementationOrSealedV1", (options: { prompt: string }) => {
      run.prompts.push(options.prompt);
      if (harnessOptions.mutatePlanFinalDuringRound !== undefined) {
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), harnessOptions.mutatePlanFinalDuringRound, "utf8");
      }
      return Promise.resolve(result);
    }),
    patch(
      implContinuationTextDispatchModule,
      "isSummaryOnlyDispatchAvailableV1",
      () => harnessOptions.summaryOnlyDispatchAvailable ?? false
    ),
    patch(
      implContinuationTextDispatchModule,
      "runSummaryOnlyContinuationV1",
      (options: { prompt: string }): Promise<FakeRunResult> => {
        run.textPrompts.push(options.prompt);
        if (!harnessOptions.textResult) {
          throw new Error(
            "unexpected text-mode continuation dispatch: this test provided no textResult"
          );
        }
        return Promise.resolve(harnessOptions.textResult);
      }
    ),
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ modelId: "cli:test-model", source: "task" })),
    patch(runnerRegistryModule, "checkImplementationAvailabilityForModel", () =>
      Promise.resolve({ availability: { available: true }, providerLabel: "Test CLI" })),
    patch(contextPackModule, "generateContextPack", () => Promise.resolve("ctx")),
    patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("BASE PROMPT")),
    patch(promptSizeGuardModule, "checkAndConfirmPromptSize", () => Promise.resolve("ok")),
    patch(settingsModule, "isAutoAdvanceEnabled", () => false),
    patch(settingsModule, "getAutoReviewAfterImplementationMode", () => "off"),
    // The harness root repo is all-untracked by design; the dirty-worktree
    // prompt is not what these tests exercise.
    patch(settingsModule, "allowsDirtyWorktreeChanges", () => true),
    patch(runLogModule, "writeRunLog", async (...args: unknown[]): Promise<vscode.Uri> => {
      // Crash-order probe: what is DURABLE at the instant the run log lands?
      const persisted = JSON.parse(fs.readFileSync(progressFile, "utf8")) as TaskProgress;
      run.pendingAtRunLogWrite.push([...(persisted.pendingImplReviewFiles ?? [])]);
      run.recoveryAtRunLogWrite.push(persisted.implRecovery);
      return origWriteRunLog(...args);
    }),
    patch(
      progressWriterModule,
      "patchTaskProgressStrictV1",
      async (...args: unknown[]): Promise<TaskProgress | undefined> => {
        const patched = await origPatch(...args);
        const persisted = JSON.parse(fs.readFileSync(progressFile, "utf8")) as TaskProgress;
        const review = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, "utf8") : "";
        run.persistedStates.push({
          markerSet: persisted.reviewInvalidatedByRound !== undefined,
          reviewStale: review.trimStart().startsWith("# Review Stale"),
          status: persisted.status,
          checklistProgressUnreliable: persisted.checklistProgressUnreliable === true,
        });
        return patched;
      }
    ),
  ];

  const context = makeExtensionContext();
  // Wires the process-wide extension-context accessor (extensionContextV1.ts)
  // so the WorkflowDecisionV1 posting paths deep in this write path (the
  // reconcile/apply-ticks/restore decisions) can actually construct a
  // WorkflowDecisionStoreV1 over this run's own workspaceState, exactly as
  // extension.ts's activate() does in production — without this, every
  // decision-posting call site silently no-ops (no active extension
  // context) and falls back to a bare notification with no action.
  __extensionContextV1TestOnly.set(context);
  try {
    await runImplementationWithAI(
      vscode.Uri.file(REAL_ROOT),
      context,
      makeButtonPressArg(folderPath, progress)
    );
  } finally {
    for (const p of patches.reverse()) { p.restore(); }
    windowTarget.showWarningMessage = origShowWarning;
    wsStub.restore();
    fsBridge.restore();
    provider.dispose();
    deactivateNotificationRouter();
    __extensionContextV1TestOnly.reset();
  }
  run.pendingDecisions = new WorkflowDecisionStoreV1(context.workspaceState).listPending();
  return run;
}

/**
 * Read the persisted task-progress.json through the STRICT decoder (plain
 * node fs — the vscode fs bridge is already torn down when assertions run),
 * so every assertion also proves the state the run persisted is a document
 * the product's own fail-closed decoder accepts.
 */
function readProgress(folderPath: string): TaskProgress {
  const text = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
  const decoded = decodeTaskProgressTextV1(text, {
    expectedTaskFolder: path.basename(folderPath),
  });
  assert.ok(decoded.ok, `persisted task-progress.json must strict-decode: ${decoded.ok ? "" : decoded.reason}`);
  return decoded.decoded.progress;
}

function readRunLogs(folderPath: string): string[] {
  const runsDir = path.join(folderPath, "runs");
  if (!fs.existsSync(runsDir)) {
    return [];
  }
  // Run logs are ".md" files under runs/; item 17a's prompt manifest
  // (".prompt-manifest.json") and retained prompt text (".prompt.txt") are
  // written as siblings and are not run logs themselves.
  return fs
    .readdirSync(runsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => fs.readFileSync(path.join(runsDir, name), "utf8"));
}

void describe("deferred/incomplete round recovery (end to end)", () => {
  void it("records a deferred round incomplete: artifacts preserved, delta quarantined durably before the run log, continuation scheduled", async () => {
    const { folderPath, progress } = makeTaskFolder("deferred_detect");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/newfile.ts"],
      filesChangedUnknown: false,
      summary: DEFERRED_RESPONSE,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // Artifacts byte-identical — no unusable-summary replacement, no stale
    // placeholder over the review's content.
    assert.equal(fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8"), PRIOR_SUMMARY);
    assert.equal(
      fs.readFileSync(path.join(folderPath, "impl-summary_prev.md"), "utf8"),
      PRIOR_SUMMARY_PREV
    );
    assert.equal(
      fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8"),
      PRIOR_REVIEW
    );

    const persisted = readProgress(folderPath);
    assert.deepEqual(persisted?.pendingImplReviewFiles, ["src/newfile.ts"]);
    assert.deepEqual(
      persisted?.implReviewFiles,
      ["src/prior.ts"],
      "a detected round's delta must never be banked into implReviewFiles"
    );
    assert.equal(persisted?.incompleteRoundContinuations, 1);
    assert.equal(persisted?.reviewInvalidatedByRound?.stage, "impl-high-review");
    assert.equal(persisted?.status, "active");

    // Crash-order invariant: the quarantine was durable BEFORE the run log
    // was written — a crash after the log write can only lose reporting.
    assert.equal(run.pendingAtRunLogWrite.length, 1);
    assert.deepEqual(run.pendingAtRunLogWrite[0], ["src/newfile.ts"]);

    const logs = readRunLogs(folderPath);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /Status: incomplete \(roundDeferred\)/);
    assert.match(logs[0]!, /## Incomplete round/);
    assert.match(logs[0]!, /- src\/newfile\.ts/);

    // Continuation scheduled; no review/auto-advance dispatch fired.
    assert.equal(run.dispatches.length, 1);
    assert.equal(run.dispatches[0]?.command, "vs-code-ai-helper.runImplementationWithAI");
    assert.equal(run.dispatches[0]?.chainId, "impl-continuation");
  });

  void it("treats an EMPTY completed response as the same incomplete round (no banking, no summary replacement)", async () => {
    const { folderPath, progress } = makeTaskFolder("deferred_empty");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/orphan.ts"],
      filesChangedUnknown: false,
      summary: "",
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The review blocker's exact failure: an empty response used to fall onto
    // the rejected-summary path, banking src/orphan.ts and replacing
    // impl-summary.md with the unusable placeholder.
    assert.equal(fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8"), PRIOR_SUMMARY);
    const persisted = readProgress(folderPath);
    assert.deepEqual(persisted?.pendingImplReviewFiles, ["src/orphan.ts"]);
    assert.deepEqual(persisted?.implReviewFiles, ["src/prior.ts"]);

    const logs = readRunLogs(folderPath);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /Status: incomplete \(roundIncomplete\)/);
    assert.equal(run.dispatches[0]?.chainId, "impl-continuation");
  });

  void it("a later successful round gets the Continuation Notice, promotes the pending set, and clears the marker only after replacement review state persists", async () => {
    const { folderPath, progress } = makeTaskFolder("deferred_promote", {
      pendingImplReviewFiles: ["src/newfile.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The continuation prompt names the unreported round's paths.
    assert.equal(run.prompts.length, 1);
    assert.match(run.prompts[0]!, /## Continuation Notice/);
    assert.match(run.prompts[0]!, /- src\/newfile\.ts/);

    const persisted = readProgress(folderPath);
    const banked = [...(persisted?.implReviewFiles ?? [])].sort();
    assert.deepEqual(
      banked,
      ["src/newfile.ts", "src/prior.ts", "src/resolver.ts"],
      "promotion unions the quarantined delta with the round's own delta"
    );
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.equal(persisted?.incompleteRoundContinuations, undefined);
    assert.equal(persisted?.reviewInvalidatedByRound, undefined);

    // Replacement review-tracking state persisted: the stage's artifact is
    // now stale-stamped (its previous content is preserved as the _prev
    // backup by the stamp's own write path).
    const review = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
    assert.ok(review.trimStart().startsWith("# Review Stale"));

    // Ordering invariant across EVERY persisted state, not just the final
    // one: at no point was the marker cleared while the review artifact still
    // read as current.
    for (const state of run.persistedStates) {
      assert.ok(
        state.markerSet || state.reviewStale,
        "a persisted state cleared the review-invalid marker before replacement review state was durable"
      );
    }
  });

  void it("escalates to human at the continuation cap — pausing the task despite an absent reviewAttemptId", async () => {
    const { folderPath, progress } = makeTaskFolder("deferred_cap", {
      incompleteRoundContinuations: MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 - 1,
      pendingImplReviewFiles: ["src/newfile.ts"],
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/more.ts"],
      filesChangedUnknown: false,
      summary: DEFERRED_RESPONSE,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.incompleteRoundContinuations, MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1);
    assert.equal(
      persisted?.status,
      "paused",
      "cap exhaustion must pause the task even with no reviewAttemptId on an implementation-stage task"
    );
    assert.equal(persisted?.escalation?.kind, "plateau");
    // Both incomplete rounds' deltas stay quarantined, nothing banked.
    assert.deepEqual(
      [...(persisted?.pendingImplReviewFiles ?? [])].sort(),
      ["src/more.ts", "src/newfile.ts"]
    );
    assert.deepEqual(persisted?.implReviewFiles, ["src/prior.ts"]);

    // No continuation scheduled once the cap is exhausted.
    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      false
    );
  });
});

/**
 * Item 17b / review blocker (2026-08-26, fail-closed correction):
 * `deriveNextRecoverySourceV1` and the run-log `Mode:` line were already
 * fixed to report a fallback honestly rather than falsely claiming
 * apply-review ancestry — but honest reporting of a mode LOSS is not the
 * same as preventing the loss. This end-to-end test drives the real
 * `runImplementationWithAI` continuation branch (`reviewActions.ts`, the
 * `applyReviewContinuationStage` block) against an `implRecovery` record
 * whose `sourceDispatchMode` is `"apply-review"` but whose source review
 * artifact is missing, and asserts the round refuses to run at all rather
 * than silently downgrading to a checklist-driven Implementation round.
 */
void describe("Apply Review continuation reconstruction (item 17b, fail-closed)", () => {
  void it("refuses to run under a lost apply-review mandate rather than silently downgrading to checklist-driven Implementation", async () => {
    const { folderPath, progress } = makeTaskFolder("apply_review_continuation_lost", {
      pendingImplReviewFiles: ["src/newfile.ts"],
      implRecovery: {
        sourceAttemptId: "impl-recovery-lost-review",
        reason: "the provider's final response was cut short",
        trigger: "roundIncomplete",
        mode: "unconstrained",
        dispatch: "pending",
        at: "2026-01-02T00:00:00.000Z",
        sourceDispatchMode: "apply-review",
        sourceReviewStage: "impl-high-review",
      },
    });
    // The source review artifact this continuation would need to re-render
    // from is missing — the exact reconstruction failure the fail-closed fix
    // must refuse under, rather than falling through to run-implementation.md.
    fs.rmSync(path.join(folderPath, "impl-high-review.md"), { force: true });

    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/should-not-run.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The round must never have been dispatched under the wrong mandate.
    assert.equal(run.prompts.length, 0, "the checklist-driven prompt must never be assembled");
    assert.equal(readRunLogs(folderPath).length, 0, "no run log — the round never ran");

    // The continuation stays owed, exactly as it was, for a retry once the
    // review artifact is restored.
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery?.dispatch, "pending");
    assert.equal(persisted?.implRecovery?.sourceDispatchMode, "apply-review");
    assert.deepEqual(persisted?.pendingImplReviewFiles, ["src/newfile.ts"]);

    // A warning names the reconstruction failure.
    assert.ok(
      run.notifications.some((n) => /could not be reconstructed/.test(n.message)),
      `expected a reconstruction-failure warning; got: ${JSON.stringify(run.notifications)}`
    );
  });
});

/**
 * Part 2 (finding 2): `implReviewFiles` comes from the round's own report.
 *
 * The pinned leak mechanism (round 015 of "more workflow bugs", 2026-08-13):
 * the before/after git snapshot diff spans the round's wall-clock window, not
 * its authorship, so files edited BY HAND in the same workspace while the
 * round ran (the user's own Claude Code session — sessionManagerV1.ts,
 * appServicesV1.ts, …) landed in the diff and were banked verbatim: the round
 * self-reported 2 changed files, the workflow banked 8. Banking now
 * intersects the snapshot with the round's `## Files Changed` self-report.
 */
void describe("round file attribution (end to end)", () => {
  void it("pause-window files untouched by the round never enter implReviewFiles, and are logged as unattributed", async () => {
    const { folderPath, progress } = makeTaskFolder("attribution_leak");
    await runHarnessed(folderPath, progress, {
      status: "completed",
      // The snapshot saw both; the summary (GOOD_SUMMARY) reports only
      // src/resolver.ts — apps/mobile/hand-edit.ts is the concurrent hand edit.
      filesChanged: ["apps/mobile/hand-edit.ts", "src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/prior.ts", "src/resolver.ts"],
      "only the round's self-reported delta may be banked as review scope"
    );
    assert.equal(persisted?.pendingImplReviewFiles, undefined);

    // Visible, not silent: the run file names the excluded remainder.
    const logs = readRunLogs(folderPath);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /## Unattributed workspace changes/);
    assert.match(logs[0]!, /- apps\/mobile\/hand-edit\.ts/);
    assert.doesNotMatch(logs[0]!, /## Unattributed workspace changes[\s\S]*src\/resolver\.ts/);
  });

  void it("a file edited by hand during a pause AND modified by the round stays in scope via the intersection", async () => {
    const { folderPath, progress } = makeTaskFolder("attribution_both");
    const bothEditedSummary = GOOD_SUMMARY.replace(
      "- `src/resolver.ts` — added the resolver",
      "- `src/resolver.ts` — added the resolver\n- `src/both-edited.ts` — reworked during the round"
    );
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/both-edited.ts", "src/resolver.ts"],
      filesChangedUnknown: false,
      summary: bothEditedSummary,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/both-edited.ts", "src/prior.ts", "src/resolver.ts"]
    );
    const logs = readRunLogs(folderPath);
    assert.doesNotMatch(logs[0]!, /## Unattributed workspace changes/);
  });

  void it("pending-set promotion unions files changed only by a deferred round, while unattributed files stay excluded", async () => {
    const { folderPath, progress } = makeTaskFolder("attribution_promote", {
      pendingImplReviewFiles: ["src/deferred-only.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["apps/mobile/hand-edit.ts", "src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/deferred-only.ts", "src/prior.ts", "src/resolver.ts"],
      "promotion must union the deferred round's files; the hand edit must still be excluded"
    );
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
  });

  void it("filesChangedUnknown never banks anything — an unenumerable change set is not a dirty scan license", async () => {
    const { folderPath, progress } = makeTaskFolder("attribution_unknown");
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: true,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.deepEqual(persisted?.implReviewFiles, ["src/prior.ts"]);
    const logs = readRunLogs(folderPath);
    assert.doesNotMatch(logs[0]!, /## Unattributed workspace changes/);
  });
});

/**
 * Part 4 (finding 3): while `checklistProgressUnreliable` is set the loop
 * keeps running, but never silently — the round's own file records that the
 * counts are unverified, a notification carries the one affordance that can
 * clear the latch (reconcilePlanChecklist), and no round clears it
 * automatically. The count-gating stand-down and the "N of M" qualifier are
 * covered in reconcilePlanChecklistCommand.test.ts.
 */
void describe("checklist reconciliation prompt while the latch is set", () => {
  void it("a completed round under the latch appends the run-log note, surfaces the reconcile affordance, and leaves the latch set", async () => {
    const { folderPath, progress } = makeTaskFolder("latched_prompt", {
      checklistProgressUnreliable: true,
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // No automatic reconciliation: a successful round must NOT clear the
    // latch — only the explicit human confirmation may.
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.checklistProgressUnreliable, true);

    const logs = readRunLogs(folderPath);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /## Checklist reconciliation needed/);
    assert.match(logs[0]!, /Mark Plan Checklist Reconciled/);

    const decision = run.pendingDecisions?.find((d) => d.decisionKey === "reconcilePlanChecklist");
    assert.ok(decision, "a WorkflowDecisionV1 must carry the reconcile affordance");
    assert.match(decision.whatHappened, /unreliable/);

    const affordance = run.notifications.find(
      (n) => n.actionCommand?.command === "vs-code-ai-helper.openWorkflowDecision"
    );
    assert.ok(affordance, "the notification announcing it must route to Chat With AI");
  });

  void it("an unlatched round surfaces no reconciliation prompt", async () => {
    const { folderPath, progress } = makeTaskFolder("unlatched_no_prompt");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const logs = readRunLogs(folderPath);
    assert.doesNotMatch(logs[0]!, /## Checklist reconciliation needed/);
    assert.equal(
      run.pendingDecisions?.some((d) => d.decisionKey === "reconcilePlanChecklist"),
      false
    );
  });
});

/**
 * 2026-08-21 review round: the tier-2 applied-operation reconciliation pass
 * (`runAutomaticChecklistReconciliationV1`, `src/commands/reconcilePlanChecklist.ts`)
 * and its safety guards (exclusivity, kind-vs-intent, and — added in a THIRD
 * review round below — content corroboration; see that function's doc
 * comment) were previously proven only by calling the pass and
 * `computeSyntheticRoundChecklistLatchV1` directly. This block drives the
 * REAL production round-completion path — `runImplementationWithAI` ->
 * `executeImplementationRun` — for a sealed/synthetic round, through the
 * SAME `runHarnessed` harness the rest of this file uses, so what actually
 * (does not) land on `plan-final.md` and the `checklistProgressUnreliable`
 * value that gets persisted are the ones the real write path produces, not a
 * hand-emulated stand-in for it. 2026-08-21 NINTH review round: tier 2 never
 * wrote plan-final.md (EIGHTH round); tier 1 no longer does either — every
 * outcome below keeps the checklist untouched and the round latched.
 */
void describe("automatic checklist reconciliation (production path, end to end)", () => {
  const TIER2_PLAN = [
    "<!-- Generated by Test -->",
    "",
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist",
    "",
    "- [ ] Add the resolver export in `src/resolver.ts`",
    "",
  ].join("\n");

  // 2026-08-21 EIGHTH review round (the persisting Part 4 architectural
  // blocker, closed here): tier 2 is lexical corroboration, not a reviewer's
  // judgement, so it must never write the checkbox at all — surfacing it as
  // a pending candidate (visible progress via the round log and the
  // reconcile decision's evidence) while keeping `checklistProgressUnreliable`
  // set is the correct outcome, not a merge that ticks and then re-latches.
  void it("surfaces an item from this round's own applied-operation evidence as a pending candidate, never ticks it, and keeps the round latched", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_positive");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [
        {
          kind: "createFile",
          path: "src/resolver.ts",
          contentExcerpt: "export function resolver() {\n  return realResolverImpl();\n}",
        },
      ],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(
      persistedPlan,
      /- \[ \] Add the resolver export in `src\/resolver\.ts`/,
      "tier-2 evidence must never write the checkbox — it is lexical corroboration, not a reviewer's judgement"
    );

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      true,
      "applied-operation-only evidence is a candidate, not a tick, and must not clear the latch"
    );

    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /Automatic checklist reconciliation: `candidatesFound`/);
    assert.match(logs[0]!, /pending human attestation/);
    // Latched (above), so the standing "Finding 3" behavior applies: every
    // round that completes under the latch re-surfaces the reconcile
    // affordance rather than leaving it as a silent tooltip-only signal.
    assert.equal(run.pendingDecisions?.some((d) => d.decisionKey === "reconcilePlanChecklist"), true);
  });

  // 2026-08-21 THIRD review round finding (the persisting Part 4
  // architectural blocker, this time reproduced through the REAL
  // production write path rather than a direct unit call): the earlier
  // version of this exact test proved the opposite of what it should have —
  // a `createFile` receipt for `src/resolver.ts` with NO content examined
  // ticked "Add the resolver export" regardless of what actually landed in
  // the file. This test drives the same production path with a receipt
  // whose written content has nothing to do with the item, and confirms the
  // content-corroboration guard now keeps the item unticked and the round
  // latched — the exact false-positive the review cited by name.
  void it("does not tick from applied-operation evidence when the written content has nothing to do with the item, and keeps the round latched (content-corroboration guard, production path)", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_content_mismatch");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [
        {
          kind: "createFile",
          path: "src/resolver.ts",
          contentExcerpt: "// placeholder scaffold, nothing implemented yet",
        },
      ],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(
      persistedPlan,
      /- \[ \] Add the resolver export in `src\/resolver\.ts`/,
      "a receipt whose content has nothing to do with the item's own description must not tick it"
    );

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      true,
      "content that fails to corroborate the item must keep the round latched, exactly like no evidence at all"
    );
  });

  // Same shape, but the receipt carries no `contentExcerpt` at all — the
  // field is optional, so a caller that cannot supply it must not fall back
  // to path+kind-only ticking (the previous, now-unsafe behavior).
  void it("does not tick from applied-operation evidence when the receipt carries no content excerpt at all, and keeps the round latched", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_no_excerpt");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [{ kind: "createFile", path: "src/resolver.ts" }],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(persistedPlan, /- \[ \] Add the resolver export in `src\/resolver\.ts`/);

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistProgressUnreliable, true);
  });

  // 2026-08-21 FOURTH review round finding, reproduced through the REAL
  // production write path: the review's own cited counter-example was
  // content such as `const resolverStatus = "pending"` still ticking "Add
  // the resolver export" because the prior guard matched the token
  // `resolver` as a plain substring of `resolverStatus`. This test drives
  // the same production path with exactly that receipt and confirms the
  // hardened whole-token-boundary guard now keeps the item unticked and the
  // round latched.
  void it("does not tick from applied-operation evidence when the content's only match is a substring of a longer, unrelated word, and keeps the round latched", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_substring_mismatch");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [
        {
          kind: "createFile",
          path: "src/resolver.ts",
          contentExcerpt: 'const resolverStatus = "pending";',
        },
      ],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(
      persistedPlan,
      /- \[ \] Add the resolver export in `src\/resolver\.ts`/,
      "a token that only occurs as a substring of a longer, unrelated word must not corroborate the item"
    );

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      true,
      "a substring-only match must keep the round latched, exactly like no matching content at all"
    );
  });

  // 2026-08-21 FOURTH review round finding, reproduced through the REAL
  // production write path: the review's other cited counter-example was a
  // "non-exported/TODO `resolver` implementation" still ticking "Add the
  // resolver export" because the prior guard was satisfied by any ONE
  // matching token — here the receipt names `resolver` but never the
  // requirement word `export`.
  void it("does not tick from applied-operation evidence when the content names the identifier but omits the requirement word, and keeps the round latched", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_missing_requirement_word");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [
        {
          kind: "createFile",
          path: "src/resolver.ts",
          contentExcerpt: "function resolver() {\n  // TODO: not exported yet\n}",
        },
      ],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(
      persistedPlan,
      /- \[ \] Add the resolver export in `src\/resolver\.ts`/,
      "naming the identifier without the requirement word describing what must happen to it must not tick the item"
    );

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistProgressUnreliable, true);
  });

  // 2026-08-21 FIFTH review round finding, reproduced through the REAL
  // production write path with the review's own cited counter-example
  // verbatim: `// TODO: export resolver after migration` names BOTH required
  // tokens (`resolver`, `export`) as genuine whole words — the FOURTH round's
  // guards both pass this content — but the line itself declares the export
  // has not happened yet. Confirms the incompleteness-marker guard keeps the
  // item unticked and the round latched on the real write path, not just the
  // pure function.
  void it("does not tick from applied-operation evidence when every required token only occurs on a line declaring the work not yet done, and keeps the round latched", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_todo_marker");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [
        {
          kind: "createFile",
          path: "src/resolver.ts",
          contentExcerpt: "// TODO: export resolver after migration",
        },
      ],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(
      persistedPlan,
      /- \[ \] Add the resolver export in `src\/resolver\.ts`/,
      "content whose only match sits on a TODO line must not corroborate the item, even naming every required token"
    );

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistProgressUnreliable, true);
  });

  void it("does not tick either of two items sharing a file, and keeps the round latched (exclusivity guard, production path)", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_ambiguous");
    const sharedPlan = [
      "<!-- Generated by Test -->",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "# Implementation Checklist",
      "",
      "- [ ] Add the resolver export in `src/resolver.ts`",
      "- [ ] Fix the resolver bug in `src/resolver.ts`",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), sharedPlan, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [{ kind: "patchFile", path: "src/resolver.ts" }],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(persistedPlan, /- \[ \] Add the resolver export in `src\/resolver\.ts`/);
    assert.match(persistedPlan, /- \[ \] Fix the resolver bug in `src\/resolver\.ts`/);

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      true,
      "a receipt at a path shared by two unticked items cannot be attributed to just one of them"
    );
  });

  void it("does not tick a non-deletion item covered only by a deleteFile receipt, and keeps the round latched (kind-vs-intent guard, production path)", async () => {
    const { folderPath, progress } = makeTaskFolder("tier2_production_kind_mismatch");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), TIER2_PLAN, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summaryIsSynthetic: true,
      appliedOperations: [{ kind: "deleteFile", path: "src/resolver.ts" }],
      runnerId: "sealed-pipeline",
      providerLabel: "Sealed Edit Pipeline",
    });

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(
      persistedPlan,
      /- \[ \] Add the resolver export in `src\/resolver\.ts`/,
      "a deleteFile receipt proves removal, not that an 'Add' item's content landed"
    );

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistProgressUnreliable, true);
  });
});

/**
 * wf "make the stage chat a record of work", Part 6 / item 5: "a round never
 * mutates the checklist" — driven through the real production write path
 * (`executeImplementationRun` in reviewActions.ts), not just the pure
 * `detectChecklistItemSetMutationV1` unit tests in
 * implementationSummaryArtifact.test.ts. `mutatePlanFinalDuringRound`
 * simulates an edit-mode round directly rewriting plan-final.md's item list,
 * mid-round — exactly the Batch F incident this guard exists to catch.
 */
void describe("checklist-mutation guard (Part 6 / item 5, production path, end to end)", () => {
  const BASE_PLAN = [
    "<!-- Generated by Test -->",
    "",
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
  ].join("\n");

  const MUTATED_PLAN_WITH_ADDITION = [
    "<!-- Generated by Test -->",
    "",
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "- [ ] Present the remaining sites to a human reviewer",
    "",
  ].join("\n");

  void it("reverts a round's direct addition to the checklist item set and records a durable proposal", async () => {
    const { folderPath, progress } = makeTaskFolder("checklist_guard_addition");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), BASE_PLAN, "utf8");

    await runHarnessed(
      folderPath,
      progress,
      {
        status: "completed",
        filesChanged: ["src/resolver.ts"],
        filesChangedUnknown: false,
        summaryIsSynthetic: true,
        runnerId: "sealed-pipeline",
        providerLabel: "Sealed Edit Pipeline",
      },
      { mutatePlanFinalDuringRound: MUTATED_PLAN_WITH_ADDITION }
    );

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.equal(
      persistedPlan,
      BASE_PLAN,
      "the round's added item must be discarded — the item set is restored to exactly what it read at dispatch"
    );
    assert.doesNotMatch(persistedPlan, /Present the remaining sites/);

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistChangeProposals?.length, 1);
    const proposal = persisted.checklistChangeProposals?.[0];
    assert.equal(proposal?.kind, "added");
    assert.deepEqual(proposal?.proposedItems, ["Present the remaining sites to a human reviewer"]);
    assert.deepEqual(proposal?.removedItems, []);
    assert.equal(proposal?.status, "pending");

    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /## Checklist change discarded \(Part 6 guard\)/);
    assert.match(logs[0]!, /Present the remaining sites to a human reviewer/);
  });

  void it("still merges this round's genuinely reported ticks after reverting the mutation", async () => {
    const { folderPath, progress } = makeTaskFolder("checklist_guard_addition_with_ticks");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), BASE_PLAN, "utf8");

    await runHarnessed(
      folderPath,
      progress,
      {
        status: "completed",
        filesChanged: ["src/resolver.ts"],
        filesChangedUnknown: false,
        summary: GOOD_SUMMARY,
        runnerId: "test-cli",
      },
      { mutatePlanFinalDuringRound: MUTATED_PLAN_WITH_ADDITION }
    );

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(persistedPlan, /- \[x\] Add the resolver/, "a genuinely reported tick must still land");
    assert.match(persistedPlan, /- \[ \] Wire the decoder/);
    assert.doesNotMatch(
      persistedPlan,
      /Present the remaining sites/,
      "the added item must still be discarded even when the round also reported real progress"
    );

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistChangeProposals?.length, 1);
    assert.equal(persisted.checklistChangeProposals?.[0]?.kind, "added");
  });

  void it("does not record a proposal or touch plan-final.md when only tick state changes", async () => {
    const { folderPath, progress } = makeTaskFolder("checklist_guard_no_mutation");
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), BASE_PLAN, "utf8");

    await runHarnessed(
      folderPath,
      progress,
      {
        status: "completed",
        filesChanged: ["src/resolver.ts"],
        filesChangedUnknown: false,
        summary: GOOD_SUMMARY,
        runnerId: "test-cli",
      }
    );

    const persisted = readProgress(folderPath);
    assert.equal(persisted.checklistChangeProposals, undefined);

    const persistedPlan = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.match(persistedPlan, /- \[x\] Add the resolver/);
  });
});

/**
 * Part 3 (2026-08-14, round 013 of task "1.9"): a round that declares
 * `<!-- ensemble:no-checklist-change -->` while also reporting retroactive
 * plan-item completions is self-contradictory — the marker satisfies the
 * echo requirement on its own, so the round used to complete with its
 * claimed progress recorded nowhere. Rejected as a shape issue instead, so it
 * enters the same recovery transition every other unusable summary does.
 */
void describe("contradictory no-checklist-change + retroactive claims (Part 3, end to end)", () => {
  /** Verbatim shape from runs/013-claude-cli-impl.md of task "1.9" — the
   * marker is declared, then a retroactive claim uses PARAPHRASED item text
   * ("small font + reduced padding") that matches nothing in the plan. */
  const ROUND_013_SHAPED_SUMMARY = [
    "<!-- ensemble:no-checklist-change -->",
    "This round independently re-verified every plan anchor in the working tree.",
    "",
    "## Files Changed",
    "",
    "None — no source, test, or configuration file was created, modified, or deleted this round.",
    "",
    "## Plan Item Checklist",
    "",
    "- Resolver wiring, condensed — done <!-- ensemble:retroactive --> — src/resolver.ts:1-5",
    "",
    "## Verification",
    "",
    "- pnpm run test:unit — all green",
  ].join("\n");

  void it("is rejected as a shape issue and schedules a recovery continuation instead of completing silently", async () => {
    const { folderPath, progress } = makeTaskFolder("round013_contradiction");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: ROUND_013_SHAPED_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    const record = persisted?.implRecovery;
    assert.ok(record, "the contradictory round must be rejected and land a recovery record");
    assert.equal(record.trigger, "summaryRejected");
    assert.equal(record.dispatch, "pending");

    // The plan of record must NOT have been merged against — a rejected
    // round never reaches the merge/write step.
    const planFinal = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.equal(planFinal, PLAN_FINAL, "a rejected round's checklist must not be merged");

    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(summary.includes("<!-- ensemble:implementation-summary-unusable -->"));

    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /no-checklist-change/);
    assert.match(logs[0]!, /already ticked in the plan of record/);

    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      true,
      "a continuation round must be scheduled rather than leaving the task parked silently"
    );
  });
});

/**
 * Part 3 (2026-08-14): the `checklistProgressUnreliable` latch used to fire
 * only for a runner-authored summary or a rejected one — never for an
 * ACCEPTED round whose retroactive claim simply matched nothing in the plan
 * (merge kind "no-match"). That round believes it recorded progress, so
 * nothing else would ever revisit the claim; the latch must catch it too.
 */
void describe("checklistProgressUnreliable latch fires on claimed-but-unmerged progress (Part 3)", () => {
  /** Echoes the plan verbatim (unchecked — satisfies the echo requirement)
   * but claims a DIFFERENT, unmatched item retroactively, so the merge
   * returns "no-match" even though the round is otherwise well-formed and
   * accepted. */
  const ACCEPTED_BUT_UNMATCHED_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — verification only",
    "",
    "## Plan Item Checklist",
    "",
    "- Resolver addition — done <!-- ensemble:retroactive --> — src/resolver.ts:1 already implemented",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it("latches even though the round changed no files and was otherwise accepted", async () => {
    const { folderPath, progress } = makeTaskFolder("claimed_unmerged_latch");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: ACCEPTED_BUT_UNMATCHED_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The round is accepted (no recovery record) — this is not a rejected
    // summary, just one whose claimed progress didn't merge.
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery, undefined);
    assert.equal(persisted?.checklistProgressUnreliable, true);

    assert.equal(
      run.pendingDecisions?.some((d) => d.decisionKey === "reconcilePlanChecklist"),
      true,
      "the reconcile affordance must surface even though no files changed"
    );
  });

  /**
   * Review finding (2026-08-15, "workflow 3" round 074): the latch was
   * verified above against a minimal task (one prior reviewed file, no
   * review history). Round 074's REAL task carried 46 prior `implReviewFiles`
   * and a long `reviewScoreHistory` including a qualifying 0-blocker
   * `impl-high-review` pass — and the latch did not persist. This reproduces
   * that larger prior state with the same claimed-but-unmerged shape (four
   * paraphrased retroactive claims that never match the plan's exact
   * wording) to prove the latch still fires once realistic history is
   * present, not just in the minimal-state case above.
   */
  void it("latches with a large prior implReviewFiles set and a qualifying review in history (round 074 shape)", async () => {
    const manyPriorFiles = Array.from({ length: 46 }, (_, i) => `src/prior${i}.ts`);
    const { folderPath, progress } = makeTaskFolder("claimed_unmerged_latch_realistic_history", {
      implReviewFiles: manyPriorFiles,
      reviewScoreHistory: [
        {
          stage: "impl-high-review",
          score: 9,
          attemptId: "11111111-1111-1111-1111-111111111111",
          at: "2026-01-01T00:00:00.000Z",
          blockerCount: 0,
          taskFixableCount: 0,
          blockers: [],
        },
      ],
      reviewAttemptId: "11111111-1111-1111-1111-111111111111",
    });

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: ACCEPTED_BUT_UNMATCHED_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery, undefined);
    assert.equal(
      persisted?.checklistProgressUnreliable,
      true,
      "the latch must fire regardless of how large the prior implReviewFiles/review history is"
    );
  });

  /**
   * Review finding (2026-08-15, "workflow 3" round 077): the two cases above
   * cover a small two-item toy plan. Round 077's REAL plan of record was an
   * 8-part, 52-item checklist, and its response echoed most parts BYTE-EXACT
   * (they were already ticked, so re-echoing them verbatim is a no-op) while
   * paraphrasing the wording of the handful of items it was newly claiming —
   * dropping file/line parentheticals — so those specific ticks legitimately
   * fail to match (`mergeChecklistProgressV1` returns "no-match", confirmed
   * by direct replay). The reviewer could not determine from static evidence
   * alone whether `checklistProgressUnreliable` was set and then cleared, or
   * never set at all. This reproduces the exact multi-part plan structure,
   * the exact response text, and the exact non-empty file list round 077
   * reported, to pin down current-code behavior definitively.
   */
  void it("latches on a realistic multi-part plan with mostly-verbatim echo and a few paraphrased new ticks (round 077 shape)", async () => {
    const { folderPath, progress } = makeTaskFolder("claimed_unmerged_latch_round077_shape", {
      implReviewFiles: ["src/prior.ts"],
      reviewScoreHistory: [
        {
          stage: "impl-high-review",
          score: 9,
          attemptId: "22222222-2222-2222-2222-222222222222",
          at: "2026-01-01T00:00:00.000Z",
          blockerCount: 0,
          taskFixableCount: 0,
          blockers: [],
        },
      ],
      reviewAttemptId: "22222222-2222-2222-2222-222222222222",
    });
    fs.writeFileSync(path.join(folderPath, "plan-final.md"), ROUND_077_PLAN_FINAL, "utf8");

    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ROUND_077_FILES_CHANGED,
      filesChangedUnknown: false,
      summary: ROUND_077_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    const planFinalAfter = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.equal(
      planFinalAfter,
      ROUND_077_PLAN_FINAL,
      "a no-match merge must never write plan-final.md"
    );
    assert.equal(
      persisted?.checklistProgressUnreliable,
      true,
      "the latch must fire for a non-zero-file round whose claimed new ticks paraphrase the plan text, " +
        "exactly as it must for the zero-file cases above"
    );

    // Review finding (2026-08-16): three production rounds reproduced this
    // exact merge/latch shape (074, 077, 079) with no standing trace of the
    // computed merge kind, so a stale-bundle hypothesis could not be
    // distinguished from a live defect from the run record alone. The merge
    // kind and latch decision are now written to every impl round's run log
    // unconditionally — pin that they actually land, not just the durable
    // task-progress field.
    const logs = readRunLogs(folderPath);
    const diagnosticsLog = logs.find((log) => log.includes("## Checklist merge diagnostics"));
    assert.ok(diagnosticsLog, "run log must record the checklist merge diagnostics section");
    assert.ok(
      diagnosticsLog?.includes("Merge kind: `no-match`"),
      "diagnostics must record the actual computed merge kind"
    );
    assert.ok(
      diagnosticsLog?.includes("Latch (`checklistProgressUnreliable`) after this round: set"),
      "diagnostics must record the actual persisted latch decision"
    );
  });
});

/**
 * Part 3 (2026-08-14): the zero-change no-progress streak is about STERILE
 * rounds — no file delta AND no checklist delta — not file delta alone. A
 * zero-file round that DID land new checklist ticks made real progress and
 * must reset the streak like any round that changed files; one that changed
 * no files and merged nothing (including a claimed-but-unmerged retroactive
 * claim) is exactly as sterile as one that reported nothing, and must still
 * count.
 */
void describe("zero-change streak counts checklist progress, not just file changes (Part 3)", () => {
  const ECHO_TICKS_RESOLVER_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — the resolver already existed; only the plan needed updating",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const UNMATCHED_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — verification only",
    "",
    "## Plan Item Checklist",
    "",
    "- Resolver addition — done <!-- ensemble:retroactive --> — src/resolver.ts:1 already implemented",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it("a zero-file round that lands new ticks resets the streak instead of extending it", async () => {
    const { folderPath, progress } = makeTaskFolder("streak_reset_on_ticks", {
      zeroChangeImplRounds: 2,
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: ECHO_TICKS_RESOLVER_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted?.zeroChangeImplRounds,
      undefined,
      "landing a real tick must clear the no-progress streak, not extend it"
    );
    assert.equal(
      persisted?.roundOutcomes?.at(-1)?.classification,
      "edits-produced",
      "landing a real checklist tick is durable progress (wf10 item 4 / Part 4), even with zero file changes"
    );
  });

  void it("a zero-file round whose claim never merges still extends the streak", async () => {
    // Item 4 (Part 3) note: the new `uncheckedItemsWithoutClearingReview`
    // gate does NOT intercept this round even without a qualifying review —
    // an unmatched `## Plan Item Checklist` claim (`checklistClaimedButUnmerged`)
    // is deliberately excluded from that gate, because it already has its
    // own dedicated, unconditional latch further below. This test is
    // unaffected by the Item 4 fix as a result.
    const { folderPath, progress } = makeTaskFolder("streak_extends_on_unmatched_claim", {
      zeroChangeImplRounds: 1,
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: UNMATCHED_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted?.zeroChangeImplRounds,
      2,
      "a claimed-but-unmerged round is exactly as sterile as one that reported nothing"
    );
    // wf10 item 4 / Part 4: no qualifying review vouches for this claim and
    // real work remains (PLAN_FINAL's 2 items are still unticked) — this is
    // a provider failure, not a justified no-op, and is about to be refused
    // below by `checklistClaimedButUnmergedWithoutClearingReview` for the
    // same reason.
    assert.equal(
      persisted?.roundOutcomes?.at(-1)?.classification,
      "provider-failure-empty",
      "an unmerged claim with real work remaining and no clearing review is a provider failure"
    );
  });
});

/**
 * wf10 item 4 / Part 4: the round-outcome taxonomy's core distinction — a
 * `Status: completed` round with zero files recorded on a task with unticked
 * checklist items and no clearing review must classify as
 * `provider-failure-empty`, NOT the same as a genuinely justified
 * `genuine-no-op` finding. Also covers the `edits-produced` and `cancelled`
 * classifications end to end through the real production write path.
 */
void describe("round-outcome classification (wf10 item 4 / Part 4)", () => {
  const NOTHING_TO_FIX_NO_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — the current state already satisfies the plan",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const PLAN_FINAL_ALL_DONE = [
    "<!-- Generated by Test -->",
    "",
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist",
    "",
    "- [x] Add the resolver",
    "- [x] Wire the decoder",
    "",
  ].join("\n");

  const NOTHING_LEFT_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Add the resolver",
    "- [x] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — the current state already satisfies the plan",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it(
    "a zero-file round with unticked items and no clearing review classifies as provider-failure-empty, " +
      "not genuine-no-op",
    async () => {
      const { folderPath, progress } = makeTaskFolder("taxonomy_provider_failure_empty");
      // No reviewScoreHistory: nothing vouches that the 2 remaining PLAN_FINAL
      // items are actually done, and this summary makes no claim either way.
      await runHarnessed(folderPath, progress, {
        status: "completed",
        filesChanged: [],
        filesChangedUnknown: false,
        summary: NOTHING_TO_FIX_NO_CLAIM_SUMMARY,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      });

      const persisted = readProgress(folderPath);
      assert.equal(
        persisted?.roundOutcomes?.at(-1)?.classification,
        "provider-failure-empty"
      );
      // wf10 review fix (Part 5 steps 13-14): the round-outcome entry must be
      // keyed to literal "impl" — where `runImplementationOrSealedV1` always
      // resolves its model/quota/fallback chain (see the comment on its own
      // `stage: "impl"` argument in `executeImplementationRun`) — not to the
      // task's current review stage. Keying this to "impl-high-review" (the
      // stage this round was launched from) made the entry invisible to the
      // Part 5 breaker/candidate-skip machinery, which reads under "impl".
      assert.equal(persisted?.roundOutcomes?.at(-1)?.stage, "impl");
    }
  );

  void it(
    "a zero-file round on an already-fully-ticked checklist classifies as genuine-no-op",
    async () => {
      const { folderPath, progress } = makeTaskFolder("taxonomy_genuine_no_op");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PLAN_FINAL_ALL_DONE, "utf8");
      await runHarnessed(folderPath, progress, {
        status: "completed",
        filesChanged: [],
        filesChangedUnknown: false,
        summary: NOTHING_LEFT_SUMMARY,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      });

      const persisted = readProgress(folderPath);
      assert.equal(
        persisted?.roundOutcomes?.at(-1)?.classification,
        "genuine-no-op",
        "with nothing left unticked, a zero-file completion is a justified no-work finding"
      );
    }
  );

  void it("a round that lands real file edits classifies as edits-produced", async () => {
    const { folderPath, progress } = makeTaskFolder("taxonomy_edits_produced");
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.roundOutcomes?.at(-1)?.classification, "edits-produced");
  });

  void it("a cancelled round classifies as cancelled", async () => {
    const { folderPath, progress } = makeTaskFolder("taxonomy_cancelled");
    await runHarnessed(folderPath, progress, {
      status: "cancelled",
      filesChanged: [],
      filesChangedUnknown: false,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.roundOutcomes?.at(-1)?.classification, "cancelled");
  });

  void it("roundOutcomes is capped at MAX_ROUND_OUTCOMES across repeated rounds", async () => {
    const existing = Array.from({ length: MAX_ROUND_OUTCOMES }, (_, i) => ({
      stage: "impl-high-review" as const,
      classification: "genuine-no-op" as const,
      at: "2026-01-01T00:00:00.000Z",
      attemptId: `prior-${i}`,
    }));
    const { folderPath, progress } = makeTaskFolder("taxonomy_capped", {
      roundOutcomes: existing,
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.roundOutcomes?.length, MAX_ROUND_OUTCOMES);
    assert.equal(persisted?.roundOutcomes?.at(-1)?.classification, "edits-produced");
  });
});

/**
 * Review fix, 2026-08-27 (narrowed blocker: "Step 7 expressly requires
 * coordinator-attempt identity, per-attempt cardinality, persistence at
 * assembly time, and attempt-based lookup"). Before this fix,
 * `executeImplementationRun` wrote exactly one prompt manifest per ROUND,
 * built from whichever single `AssembledPromptCaptureV1` a mutable variable
 * happened to hold last — so a round whose primary candidate failed and fell
 * back to a secondary silently lost the primary's own captured prompt on
 * disk. These tests drive the real production write path in
 * reviewActions.ts (via the patched `runImplementationOrSealedV1` result,
 * exactly as the sibling round-outcome tests above do) and assert on the
 * actual files it wrote under runs/.
 */
void describe("prompt manifest per-attempt persistence (Step 7 review fix, 2026-08-27)", () => {
  function readRunsDirFileNames(folderPath: string): string[] {
    const runsDir = path.join(folderPath, "runs");
    if (!fs.existsSync(runsDir)) {
      return [];
    }
    return fs.readdirSync(runsDir).sort();
  }

  void it("writes one manifest+prompt pair per captured attempt, not one per round", async () => {
    const { folderPath, progress } = makeTaskFolder("prompt_manifest_multi_attempt");
    const primary = {
      attemptId: "attempt-primary-0001",
      prompt: "PRIMARY CANDIDATE PROMPT TEXT",
      promptSha256: "sha-primary",
    };
    const secondary = {
      attemptId: "attempt-secondary-0002",
      prompt: "SECONDARY CANDIDATE PROMPT TEXT",
      promptSha256: "sha-secondary",
    };
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "copilot-lm",
      providerLabel: "Copilot",
      storedModelId: "copilot:test-model",
      assembledPrompt: secondary,
      assembledPromptAttempts: [primary, secondary],
    });

    const names = readRunsDirFileNames(folderPath);
    const manifestNames = names.filter((n) => n.endsWith(".prompt-manifest.json"));
    const promptNames = names.filter((n) => n.endsWith(".prompt.txt"));
    assert.equal(manifestNames.length, 2, `expected one manifest per attempt, got: ${manifestNames.join(", ")}`);
    assert.equal(promptNames.length, 2, `expected one retained prompt per attempt, got: ${promptNames.join(", ")}`);

    // Review blocker, 2026-08-27 (third pass — "keeping the last attempt
    // unsuffixed"): filenames are now derived purely from roundId/attemptId
    // (promptManifestV1.ts), so EVERY captured attempt — including the one
    // that actually completed — is named by its own attemptId. There is no
    // longer an unsuffixed "last attempt" special case.
    const secondaryManifest = manifestNames.find((n) => n.includes(`.attempt-${secondary.attemptId}.`));
    assert.ok(secondaryManifest, "the secondary (completing) attempt must be retained under its own attempt-suffixed filename");
    const secondaryManifestContent = JSON.parse(
      fs.readFileSync(path.join(folderPath, "runs", secondaryManifest), "utf8")
    ) as { attemptId?: string };
    assert.equal(secondaryManifestContent.attemptId, secondary.attemptId);

    // The earlier (overwritten-in-the-old-scheme) attempt is retained on
    // disk with its own attemptId in both the filename and the manifest.
    const primaryManifest = manifestNames.find((n) => n.includes(`.attempt-${primary.attemptId}.`));
    assert.ok(primaryManifest, "the primary (earlier) attempt must be retained under its own attempt-suffixed filename");
    const primaryManifestContent = JSON.parse(
      fs.readFileSync(path.join(folderPath, "runs", primaryManifest), "utf8")
    ) as { attemptId?: string };
    assert.equal(primaryManifestContent.attemptId, primary.attemptId);

    const primaryPromptText = fs.readFileSync(
      path.join(folderPath, "runs", primaryManifest.replace(".prompt-manifest.json", ".prompt.txt")),
      "utf8"
    );
    assert.equal(primaryPromptText, primary.prompt);
  });

  void it("a single-attempt round still names its manifest/prompt by that attempt's own attemptId", async () => {
    const { folderPath, progress } = makeTaskFolder("prompt_manifest_single_attempt");
    const only = {
      attemptId: "attempt-only-0001",
      prompt: "ONLY CANDIDATE PROMPT TEXT",
      promptSha256: "sha-only",
    };
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "copilot-lm",
      providerLabel: "Copilot",
      storedModelId: "copilot:test-model",
      assembledPrompt: only,
      assembledPromptAttempts: [only],
    });

    const names = readRunsDirFileNames(folderPath);
    const manifestNames = names.filter((n) => n.endsWith(".prompt-manifest.json"));
    assert.equal(manifestNames.length, 1);
    // Review blocker, 2026-08-27 (third pass): a manifest that carries an
    // attemptId always exposes it in the filename — no cardinality-based
    // exception, single-attempt or otherwise.
    assert.ok(manifestNames[0]!.includes(`.attempt-${only.attemptId}.`));
    const content = JSON.parse(fs.readFileSync(path.join(folderPath, "runs", manifestNames[0]!), "utf8")) as {
      attemptId?: string;
    };
    assert.equal(content.attemptId, only.attemptId);
  });

  void it("a round with NO captured coordinator attempt (CLI dispatch) is named by roundId alone", async () => {
    const { folderPath, progress } = makeTaskFolder("prompt_manifest_no_attempt");
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "claude-cli",
      providerLabel: "Claude Code",
      storedModelId: "claude-code",
      // No assembledPrompt/assembledPromptAttempts — this dispatch path
      // never reaches the coordinator.
    });

    const names = readRunsDirFileNames(folderPath);
    const manifestNames = names.filter((n) => n.endsWith(".prompt-manifest.json"));
    assert.equal(manifestNames.length, 1);
    assert.ok(!manifestNames[0]!.includes(".attempt-"), "a CLI dispatch has no coordinator attemptId to suffix with");
    const content = JSON.parse(fs.readFileSync(path.join(folderPath, "runs", manifestNames[0]!), "utf8")) as {
      attemptId?: string;
    };
    assert.equal(content.attemptId, undefined);
  });
});

/**
 * Item 4 review finding (2026-08-20): `checklistClaimedButUnmerged` was
 * previously exempted from the unticked-items-without-a-clearing-review
 * gate outright — the sibling test above proves the streak still extends,
 * but that alone left a gap: nothing stopped the round from falling through
 * to auto-advance as a false "nothing to fix" completion, with the
 * dedicated `checklistStateUnrecorded` latch further below only setting a
 * flag after the fact. This proves the closed gap directly — refused, not
 * routed onward, with the reconciliation outcome recorded — while the
 * sibling test above continues to prove the streak/no-progress-breaker
 * safety net for a REPEATED occurrence still runs exactly as before.
 */
void describe("a claimed-but-unmerged round with unticked items and no clearing review is also refused (Item 4 review fix, Part 3)", () => {
  const UNMATCHED_CLAIM_WITH_REMAINING_WORK_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — verification only",
    "",
    "## Plan Item Checklist",
    "",
    "- Resolver addition — done <!-- ensemble:retroactive --> — src/resolver.ts:1 already implemented",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it("refuses onward routing, records the reconciliation outcome, and still extends the streak", async () => {
    const { folderPath, progress } = makeTaskFolder("item4_claimed_unmerged_refused", {
      zeroChangeImplRounds: 1,
      // No reviewScoreHistory at all: nothing has ever vouched that the
      // plan's 2 remaining items are actually done.
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: UNMATCHED_CLAIM_WITH_REMAINING_WORK_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted?.zeroChangeImplRounds,
      2,
      "the streak/no-progress-breaker safety net must keep running for a repeated claimed-but-unmerged round"
    );
    assert.equal(
      persisted?.checklistProgressUnreliable,
      true,
      "the round must be recorded as under-recording, not just silently refused"
    );
    const logs = readRunLogs(folderPath);
    assert.ok(
      logs.some((log) => /## Checklist reconciliation needed/.test(log)),
      "the run log must record why the round was refused rather than routed onward"
    );
    const reconcileDecision = run.pendingDecisions?.find((d) => d.decisionKey === "reconcilePlanChecklist");
    assert.ok(
      reconcileDecision,
      "the operator must be told reconciliation is owed, not just that nothing happened"
    );
  });
});

/**
 * Part 3 (2026-08-14 review finding): the no-progress breaker exists for a
 * PASSING review sending a finished-looking round back to `impl` forever —
 * tripping it must require a qualifying same-stage review at or above the
 * auto-advance threshold, not just N sterile rounds in isolation. This also
 * drives the companion fix: when the diagnosed cause is claimed-but-unmerged
 * checklist progress, `checklistProgressUnreliable` and its
 * reconcilePlanChecklist remedy must land in the SAME patch as the
 * escalation, since the function returns immediately after and the later
 * merge-write block that would otherwise set the latch never runs.
 */
void describe("no-progress breaker requires a qualifying passing review (Part 3, end to end)", () => {
  const UNMATCHED_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — verification only",
    "",
    "## Plan Item Checklist",
    "",
    "- Resolver addition — done <!-- ensemble:retroactive --> — src/resolver.ts:1 already implemented",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const qualifyingHistory = [
    {
      stage: "impl-high-review" as const,
      score: 10,
      attemptId: "attempt-passing",
      at: "2026-01-02T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
    },
  ];

  void it("eligible: escalates at the threshold behind a qualifying 0-blocker review, and latches checklistProgressUnreliable in the same round", async () => {
    const { folderPath, progress } = makeTaskFolder("breaker_eligible", {
      zeroChangeImplRounds: 2,
      reviewScoreHistory: qualifyingHistory,
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: UNMATCHED_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.status, "paused", "the qualifying sequence must escalate and pause the task");
    assert.equal(persisted?.escalation?.kind, "plateau");
    assert.equal(
      persisted?.zeroChangeImplRounds,
      undefined,
      "the streak is cleared once the escalation lands"
    );
    // The companion fix: the latch must be true THIS round — not only after
    // a later round reaches the merge-write block, which never runs here
    // because the function returns immediately after escalating.
    assert.equal(
      persisted?.checklistProgressUnreliable,
      true,
      "reconcilePlanChecklist must be actionable immediately, not after another round"
    );
    // Atomicity invariant (review finding, 2026-08-14): the pause and the
    // latch must land in the SAME patchTaskProgressStrictV1 transaction, not
    // two sequential ones a crash could land between. Prove it across EVERY
    // persisted state the run produced, not just the final one: no snapshot
    // may ever show the task already paused while the latch it names as the
    // remedy still reads false — that gap is exactly the prior-blocker state
    // (paused, with the reconciliation remedy inert).
    for (const state of run.persistedStates) {
      assert.ok(
        state.status !== "paused" || state.checklistProgressUnreliable,
        "a persisted state showed the task paused before the checklist latch was durable"
      );
    }
    assert.equal(
      run.notifications.some((n) => /Reconcile Plan Checklist/.test(n.message)),
      true,
      "the escalation notice must name the reconciliation remedy for the diagnosed cause"
    );
    // Part 5 (workflow 3 continuation): the escalation reason must name the
    // exact outstanding items — "tick the missed items" with nothing named
    // left the human to search the plan for them. PLAN_FINAL's two items are
    // still unchecked on disk (this round's claim matched neither, so no
    // merge ran), so both must be enumerated verbatim.
    assert.match(
      persisted?.escalation?.reason ?? "",
      /plan checklist still lists 2 unfinished item\(s\)/
    );
    assert.match(persisted?.escalation?.reason ?? "", /- ☐ Add the resolver/);
    assert.match(persisted?.escalation?.reason ?? "", /- ☐ Wire the decoder/);
    // wf10 item 4 / Part 4: a qualifying review already vouches for this
    // stage, so despite the unmerged claim this round is the justified
    // "found nothing to fix" case, not a provider failure.
    assert.equal(
      persisted?.roundOutcomes?.at(-1)?.classification,
      "genuine-no-op",
      "a review-vouched-for round must classify as genuine-no-op, not provider-failure-empty"
    );
  });

  void it("ineligible: does not escalate without any qualifying review on record — the streak keeps counting instead", async () => {
    const { folderPath, progress } = makeTaskFolder("breaker_ineligible_no_history", {
      zeroChangeImplRounds: 2,
      // No reviewScoreHistory at all: three sterile reruns with prior edits
      // already in the tree, but no qualifying passing-review loop — exactly
      // the shape the review finding named.
    });
    // Item 4 (Part 3) note: the new gate does not intercept this round even
    // without a qualifying review, because UNMATCHED_CLAIM_SUMMARY's
    // `## Plan Item Checklist` claim (`checklistClaimedButUnmerged`) is
    // deliberately excluded from that gate — see the sibling note in "zero-
    // change streak counts checklist progress" above.
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: UNMATCHED_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.status, "active", "an ineligible sequence must not pause the task");
    assert.equal(persisted?.escalation, undefined);
    assert.equal(
      persisted?.zeroChangeImplRounds,
      3,
      "the streak keeps counting rather than resetting — only the escalation is withheld"
    );
    // wf10 item 4 / Part 4: no qualifying review vouches for this claim, so
    // this is the SAME shape as `uncheckedItemsWithoutClearingReview` — real
    // work remains and nothing has cleared it. Must classify as a provider
    // failure, not a justified no-op, since the round is about to be refused
    // for exactly this reason (checklistClaimedButUnmergedWithoutClearingReview).
    assert.equal(
      persisted?.roundOutcomes?.at(-1)?.classification,
      "provider-failure-empty",
      "an unverified claimed-but-unmerged round with real work remaining must not read as a justified no-op"
    );
  });

  void it("ineligible: does not escalate when the latest same-stage review scored below the auto-advance threshold", async () => {
    const { folderPath, progress } = makeTaskFolder("breaker_ineligible_low_score", {
      zeroChangeImplRounds: 2,
      reviewScoreHistory: [{ ...qualifyingHistory[0]!, score: 6, blockerCount: 1, taskFixableCount: 1 }],
    });
    // Item 4 (Part 3) note: unaffected by the new gate for the same reason as
    // the sibling test above (`checklistClaimedButUnmerged` is excluded).
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: UNMATCHED_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.status, "active", "a below-threshold review must not qualify as a passing loop");
    assert.equal(persisted?.escalation, undefined);
  });
});

/**
 * wf10 item 3 / item 6b / Part 5 step 13, end to end: a fallback provider
 * that keeps producing `provider-failure-empty` rounds must be named and
 * stopped, WITHOUT waiting on the broader no-progress breaker's own
 * qualifying-review requirement — the exact "ineligible" shape just above
 * (no qualifying review on record) is precisely the case wf9/jester's
 * stalled tasks hit: quota-exhaustion correctly switched to a fallback, and
 * then that fallback's sealed-preflight path produced zero edits for every
 * subsequent round with nothing ever escalating.
 */
void describe("fallback-provider circuit breaker fires without a qualifying review (Part 5 step 13, end to end)", () => {
  const UNMATCHED_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — verification only",
    "",
    "## Plan Item Checklist",
    "",
    "- Resolver addition — done <!-- ensemble:retroactive --> — src/resolver.ts:1 already implemented",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it(
    "trips at the default threshold (2 consecutive) on the stage's active fallback candidate, pausing the task with an environmental escalation naming the model",
    async () => {
      const { folderPath, progress } = makeTaskFolder("fallback_breaker_trips", {
        zeroChangeImplRounds: 1,
        // No reviewScoreHistory: the task-wide no-progress breaker (2c) would
        // NOT escalate here on its own (see the "ineligible" tests above) —
        // this breaker must fire independently of that gate.
        // wf10 review fix (Part 5 steps 13-14): keyed to literal "impl" —
        // where `recordActiveFallbackModel`/`runImplementationOrSealedV1`
        // actually read and write `fallbackActive`/`roundOutcomes` — not to
        // the task's current review stage ("impl-high-review" here). The
        // breaker must still fire for an implementation round dispatched
        // while the task sits on a review stage.
        fallbackActive: { impl: true },
        // One prior provider-failure-empty round already on record for the
        // exact candidate the harness resolves to (`cli:test-model` via
        // runnerId `test-cli`) — this round is the second, tripping the
        // default breakerRounds (2). wf10 review fix (Part 5 steps 13-14,
        // narrowed blocker 1): candidate identity is the full provider path
        // (provider id + model id), not `modelId` alone — `providerId` must
        // match the harnessed round's own `runnerId: "test-cli"` below or
        // this fixture entry is (correctly) treated as an unknown candidate
        // and does not extend the episode.
        roundOutcomes: [
          {
            stage: "impl",
            classification: "provider-failure-empty",
            at: "2026-01-01T12:00:00.000Z",
            modelId: "cli:test-model",
            providerId: "test-cli",
          },
        ],
      });
      const run = await runHarnessed(folderPath, progress, {
        status: "completed",
        filesChanged: [],
        filesChangedUnknown: false,
        summary: UNMATCHED_CLAIM_SUMMARY,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      });

      const persisted = readProgress(folderPath);
      assert.equal(persisted?.status, "paused", "two consecutive zero-file fallback rounds must pause the task");
      assert.equal(persisted?.escalation?.kind, "environmental");
      assert.match(persisted?.escalation?.reason ?? "", /active fallback provider/);
      assert.match(persisted?.escalation?.reason ?? "", /switch this stage's model/i);
      assert.equal(
        persisted?.roundOutcomes?.at(-1)?.classification,
        "provider-failure-empty",
        "the round itself is still recorded — the breaker adds an escalation, it does not replace the record"
      );
      assert.equal(
        run.notifications.some((n) => /active fallback provider/.test(n.message)),
        true,
        "the fallback-specific diagnosis must actually reach the user, not just the persisted escalation"
      );
      // Item 9 ("the last thing the user reads wins"): the generic "may have
      // been blocked" / "run this stage's review next" warning must not ALSO
      // fire for this same round once the specific diagnosis has — a second,
      // more generic message right behind it would read as a contradiction.
      assert.equal(
        run.notifications.some((n) => /provider may have been blocked/.test(n.message)),
        false,
        "the generic zero-file warning must not also fire once the fallback breaker has escalated"
      );
    }
  );

  void it(
    "does not trip on the PRIMARY (fallbackActive false) even with the same zero-file streak on record",
    async () => {
      const { folderPath, progress } = makeTaskFolder("fallback_breaker_primary_exempt", {
        zeroChangeImplRounds: 1,
        // fallbackActive intentionally omitted — this round is running on the
        // configured primary, not a fallback candidate.
        roundOutcomes: [
          {
            stage: "impl-high-review",
            classification: "provider-failure-empty",
            at: "2026-01-01T12:00:00.000Z",
            modelId: "cli:test-model",
          },
        ],
      });
      await runHarnessed(folderPath, progress, {
        status: "completed",
        filesChanged: [],
        filesChangedUnknown: false,
        summary: UNMATCHED_CLAIM_SUMMARY,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      });

      const persisted = readProgress(folderPath);
      assert.equal(
        persisted?.status,
        "active",
        "a struggling primary is the task-wide no-progress breaker's job, not this one's"
      );
      assert.equal(persisted?.escalation, undefined);
    }
  );
});

/**
 * Item 4 (2026-08-17..19 workflow-defects batch, Part 3): the
 * `priorRoundsChangedTree` gate could not tell "the model correctly found
 * nothing left to fix" from "a provider silently produced nothing" while the
 * plan checklist still had real unticked work and no review had vouched for
 * it — runs 016/018/047/061 all settled `Status: completed` this way with an
 * untouched checklist. The fix adds a second, complementary refusal
 * condition: unticked plan items AND no qualifying review clearing the
 * stage. It must stand down on exactly the evidence
 * `checklistUnderrecordingConfirmedByReview` (tested above) stands up on, so
 * the two behaviors are proven back to back here.
 */
void describe("a zero-change round with unticked plan items is refused without a clearing review (Item 4, Part 3)", () => {
  const NOTHING_TO_FIX_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — nothing needed changing this round",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const qualifyingHistory = [
    {
      stage: "impl-high-review" as const,
      score: 10,
      attemptId: "attempt-passing",
      at: "2026-01-02T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
    },
  ];

  void it("refuses a zero-change round when the plan has unticked items and no review has cleared the stage", async () => {
    const { folderPath, progress } = makeTaskFolder("item4_refused_no_clearing_review", {
      // No reviewScoreHistory at all: nothing has ever vouched that the
      // plan's 2 remaining items (from the default PLAN_FINAL fixture) are
      // actually done.
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: NOTHING_TO_FIX_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted?.zeroChangeImplRounds,
      undefined,
      "a refused round must never advance the streak — it never reached that logic"
    );
    assert.equal(persisted?.checklistProgressUnreliable, undefined);
    assert.equal(
      run.notifications.some((n) => /plan checklist still has 2 unticked item\(s\)/.test(n.message)),
      true,
      "the operator must be told why the round was refused, not just that files did not change"
    );
  });

  void it("routes the same round onward when the most recent qualifying review has cleared the stage", async () => {
    const { folderPath, progress } = makeTaskFolder("item4_routes_with_clearing_review", {
      reviewScoreHistory: qualifyingHistory,
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: NOTHING_TO_FIX_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      run.notifications.some((n) => /plan checklist still has/.test(n.message)),
      false,
      "a clearing review must stand the new gate down, not just the pre-existing latch"
    );
    // Standing down routes into the pre-existing under-recording latch this
    // exact evidence already drives (checklistUnderrecordingConfirmedByReview),
    // proving the two conditions are complementary rather than fighting.
    assert.equal(
      persisted?.checklistProgressUnreliable,
      true,
      "the round proceeded far enough to reach the under-recording latch"
    );
  });
});

/**
 * Workflow 3 continuation (second item) / plan Part 3: the
 * `checklistProgressUnreliable` latch previously fired only when a round
 * changed FILES without recording checklist state. It never fired for a
 * round that changed nothing and landed no ticks at all — which is exactly
 * the jester-shaped deadlock (2026-08-14_task_1): a finished implementation,
 * a review at full marks with zero blockers three times running, and a
 * checklist still showing unticked items because nothing ever asserted their
 * completion. This widens the trigger so the latch fires on the FIRST such
 * sterile round — well before the no-progress breaker's 3-round threshold
 * would otherwise grind the task to a pause waiting on a human.
 */
void describe("checklistProgressUnreliable latches on a review-confirmed sterile round (Part 3, widened trigger)", () => {
  // Deliberately NOT the "claimed-but-unmerged" shape (a `## Plan Item
  // Checklist` claim that matches no plan item): that shape independently
  // latches `checklistProgressUnreliable` via the PRE-EXISTING
  // `checklistStateUnrecorded`/checklistClaimedButUnmerged trigger a few
  // hundred lines below, regardless of review score or blockers — using it
  // here would make every assertion below pass or fail for the wrong reason.
  // This echoes the plan's checklist verbatim with NOTHING newly ticked and
  // makes no retroactive claim at all, so `mergeChecklistProgressV1` returns
  // `{ kind: "no-report" }` (`reported.size === 0`): a round that reported
  // properly and genuinely found nothing left to do, isolating the widened
  // trigger under test (a sterile round behind a qualifying review) from the
  // older one (a claim that failed to match).
  const STERILE_ECHO_NO_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — the review already confirmed this satisfies the plan; nothing left to change",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const zeroBlockerFullMarks = [
    {
      stage: "impl-high-review" as const,
      score: 10,
      attemptId: "attempt-passing",
      at: "2026-01-02T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
    },
  ];

  void it("latches on the FIRST sterile round behind a qualifying zero-blocker review, well before the no-progress breaker's threshold", async () => {
    const { folderPath, progress } = makeTaskFolder("latch_first_sterile_round", {
      // No zeroChangeImplRounds recorded at all: this is the very first
      // sterile round, nowhere near the breaker's 3-round threshold.
      reviewScoreHistory: zeroBlockerFullMarks,
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: STERILE_ECHO_NO_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.status,
      "active",
      "one sterile round must not itself trip the no-progress breaker"
    );
    assert.equal(
      persisted.checklistProgressUnreliable,
      true,
      "a qualifying zero-blocker full-marks review proves the checklist counts are under-recording"
    );
    const reconcileDecision = run.pendingDecisions?.find((d) => d.decisionKey === "reconcilePlanChecklist");
    assert.ok(
      reconcileDecision,
      "the operator must be told the counts are being stood down, not just that nothing happened"
    );
    assert.match(reconcileDecision.whatHappened, /unreliable/);
    const logs = readRunLogs(folderPath);
    assert.ok(
      logs.some((log) => /## Checklist counts stood down \(under-recording\)/.test(log)),
      "the run log must record why the gate stood itself down"
    );
  });

  void it("does not latch when the qualifying review still names blockers, even at full marks", async () => {
    const { folderPath, progress } = makeTaskFolder("latch_ignores_review_with_blockers", {
      reviewScoreHistory: [{ ...zeroBlockerFullMarks[0]!, blockerCount: 1, taskFixableCount: 1 }],
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: STERILE_ECHO_NO_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      undefined,
      "a review that still names blockers describes real unfinished work, not an under-recording checklist"
    );
  });

  void it("does not latch when the qualifying review scored below the auto-advance threshold, even with zero blockers", async () => {
    const { folderPath, progress } = makeTaskFolder("latch_ignores_below_threshold_review", {
      // Zero blockers, but the score itself (7) is below the default
      // auto-advance threshold (10) — `latestQualifyingReviewMeetsThresholdV1`
      // must reject on the score check before it ever reaches the
      // zero-blockers check, so this exercises that first gate specifically,
      // distinct from the blockers-present case just above.
      reviewScoreHistory: [{ ...zeroBlockerFullMarks[0]!, score: 7 }],
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: STERILE_ECHO_NO_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      undefined,
      "a below-threshold review has not yet said the work is done, so the checklist's remaining count is not " +
        "provably under-recording"
    );
  });

  void it("does not latch a healthy task with zero remaining checklist items", async () => {
    const { folderPath, progress } = makeTaskFolder("latch_ignores_fully_ticked_plan", {
      reviewScoreHistory: zeroBlockerFullMarks,
    });
    fs.writeFileSync(
      path.join(folderPath, "plan-final.md"),
      [
        "<!-- Generated by Test -->",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "# Implementation Checklist",
        "",
        "- [x] Add the resolver",
        "- [x] Wire the decoder",
        "",
      ].join("\n"),
      "utf8"
    );
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: STERILE_ECHO_NO_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      undefined,
      "there is nothing to under-report when the plan's own checklist already shows zero remaining"
    );
  });
});

/**
 * wf10 item 1 (2026-08-24): `uncheckedItemsWithoutClearingReview` computed
 * `remainingChecklistProgress` straight from the raw plan-final.md checklist,
 * never consulting `checklistProgressUnreliable` — so once a PRIOR round had
 * already latched the stand-down (the describe block above proves how that
 * happens), a later sterile round with the same unticked count and a
 * non-clearing review still hit this gate's own "unticked item(s) and no
 * review has cleared this stage" refusal and returned `false`. Nothing the
 * user can do from the implementation stage changes any of the three
 * ingredients (latch, remaining > 0, non-clearing review), so the round
 * refused forever — observed live 2026-08-21 on jester task 3, "21 unticked
 * item(s)" firing three times across runs 024/026/027 despite
 * `checklistProgressUnreliable: true` already being on record.
 *
 * The fix makes `remainingChecklistProgress` itself stand down
 * (`undefined`) whenever the latch is already set, mirroring the sibling
 * reader `readEffectivePlanChecklistProgressV1` every OTHER completeness
 * check in this file already goes through.
 */
void describe("the completeness gate honors an already-set checklistProgressUnreliable latch (wf10 item 1)", () => {
  const STERILE_ECHO_NO_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — nothing left to change from this round's vantage point",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it("does not refuse with 'unticked item(s) and no review has cleared' once the latch is already set, even with a non-clearing review", async () => {
    // The deadlock shape to preserve as a regression test, verbatim from the
    // task audit: latch set, remaining > 0 (PLAN_FINAL's default 2 unticked
    // items), and latestReviewClearsStage false because the newest review
    // scored below threshold WITH blockers.
    const { folderPath, progress } = makeTaskFolder("item1_latch_already_set_deadlock", {
      checklistProgressUnreliable: true,
      reviewScoreHistory: [
        {
          stage: "impl-high-review" as const,
          score: 5,
          attemptId: "attempt-non-clearing",
          at: "2026-01-02T00:00:00.000Z",
          blockerCount: 1,
          taskFixableCount: 1,
        },
      ],
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: STERILE_ECHO_NO_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    assert.equal(
      run.notifications.some((n) => /unticked item\(s\) and no review has cleared this/.test(n.message)),
      false,
      "an already-set latch must stand this gate down instead of refusing forever on the same three " +
        "unchanging ingredients"
    );
    // The latch must stay set — this is a stand-down of the COUNT, not
    // evidence the checklist is suddenly trustworthy again; only a human
    // running Mark Plan Checklist Reconciled clears it.
    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      true,
      "standing the gate down must not silently clear the latch — only an explicit reconcile does that"
    );
  });
});

/**
 * Part 3 step 3, the other half of the widened-trigger contract: once the
 * latch is set, "the gate stands down via the existing
 * `readEffectivePlanChecklistProgressV1` path ... so the next passing review
 * advances the stage" (plan step 3). The jester task's own next round never
 * happened — a human hand-ticked its checklist instead — so there is no real
 * transcript to replay here the way the other Part 3 tests replay one. This
 * drives the exact two functions the real advance gate calls at the exact
 * call site (`reviewActions.ts`, generateReviewWithAI): `effectiveReviewProgressV1`
 * then `readyToAdvanceStage`. That is the entirety of "does the next review
 * advance" — everything downstream (`handleReviewRoutingOutcome`, the stage
 * transition) is unconditional once this predicate is true.
 *
 * (An earlier version of this comment claimed no review-round harness exists
 * anywhere in the suite, as the reason this test reaches for the predicate
 * pair instead of a real review round. That was too broad —
 * `publishOwnershipMatrix.test.ts` already has one (`runReviewForFolder`
 * against a stubbed V1 runner selection). Part 8 step 1's own describe block
 * below reuses that harness — `runPassingReviewHarnessed` — to drive two real
 * review rounds through the actual advance chain, closing the gap this
 * comment used to justify leaving open.)
 */
void describe("checklistProgressUnreliable stand-down lets the next review advance (Part 3, end to end)", () => {
  const zeroBlockerFullMarks = [
    {
      stage: "impl-high-review" as const,
      score: 10,
      attemptId: "attempt-passing",
      at: "2026-01-02T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
    },
  ];
  // No `<!-- progress: N/M -->` marker: the review itself only ever reports
  // its score. Whether the stage may advance turns entirely on how the
  // checklist reconciles against that (checklist.ts's `PLAN_FINAL` fixture:
  // 2 unticked items, 0 checked).
  const NO_MARKER_REVIEW = "# Implementation Review\n\nReadiness: 10/10\n\nEverything checks out.\n";

  void it("a latched task's next full-marks review is no longer blocked by the plan's unticked items", async () => {
    const { folderUri } = makeTaskFolder("latch_stands_down_advance", {
      reviewScoreHistory: zeroBlockerFullMarks,
      // The state a task is in the round AFTER the sterile-round latch
      // fired (the previous describe block proves that transition).
      checklistProgressUnreliable: true,
    });
    const fsBridge = installFsBridge();
    try {
      const progress = await effectiveReviewProgressV1(
        folderUri,
        "impl-high-review",
        NO_MARKER_REVIEW,
        "strict"
      );
      assert.equal(
        progress,
        null,
        "readEffectivePlanChecklistProgressV1 must stand down under the latch, so reconciliation returns " +
          "the review's own (absent) marker unchanged rather than the plan's 2 unticked items"
      );
      assert.equal(
        readyToAdvanceStage(10, getAutoAdvanceScoreThreshold(), progress),
        true,
        "with the checklist stood down, a full-marks review is no longer judged incomplete and the stage " +
          "advance gate — the same predicate reviewActions.ts calls at the real advance site — now passes"
      );
    } finally {
      fsBridge.restore();
    }
  });

  void it("the SAME plan and review, without the latch, still blocks advance on its 2 unticked items", async () => {
    const { folderUri } = makeTaskFolder("latch_absent_still_blocks_advance", {
      reviewScoreHistory: zeroBlockerFullMarks,
      // No `checklistProgressUnreliable` — this is the contrast case proving
      // the previous test's pass is really the latch's doing, not some
      // unrelated effect of a full-marks review.
    });
    const fsBridge = installFsBridge();
    try {
      const progress = await effectiveReviewProgressV1(
        folderUri,
        "impl-high-review",
        NO_MARKER_REVIEW,
        "strict"
      );
      assert.deepEqual(
        progress,
        { complete: 0, total: 2 },
        "without the latch, the checklist's real 0-of-2 count overrides the review's absent marker"
      );
      assert.equal(
        readyToAdvanceStage(10, getAutoAdvanceScoreThreshold(), progress),
        false,
        "a full-marks score alone must not advance a stage the plan's own checklist still reports incomplete"
      );
    } finally {
      fsBridge.restore();
    }
  });
});

/**
 * Part 8 (workflow 3 continuation, seventh item's verification): the
 * complementary exit this describe block exercises is Part 4's — a round
 * that changes NO files and echoes NO checkbox list at all, only bare prose
 * claims in `## Plan Item Checklist` (the round-073 shape) — reaching
 * advance-eligibility with no human editing `plan-final.md`. This is
 * DISTINCT from the "Part 3, end to end" block above, which exercises the
 * `checklistProgressUnreliable` LATCH exit (a review-confirmed sterile round
 * whose counts are stood down). Here the merge itself succeeds — every
 * remaining item resolves and ticks for real — so the latch must NEVER fire;
 * standing the gate down would be the wrong mechanism when the checklist's
 * own counts are already accurate.
 *
 * Also pins down the shape-gate defect this same round found and fixed:
 * `describeImplementationSummaryShapeIssue` used to require a `- [x]`
 * checkbox echo (or the `<!-- ensemble:no-checklist-change -->` marker) to
 * accept a response at all — a PURE prose claim with no checkbox echo (the
 * verbatim round-073 production shape) was rejected by the shape gate BEFORE
 * `mergeChecklistProgressV1` ever ran, so Part 4's fix could tick a plan in
 * a direct unit call but could never actually fire in the real
 * round-completion pipeline (`reviewActions.ts`). `hasPlanItemChecklistClaimV1`
 * closes that gap; this test drives the real pipeline end to end (not just
 * the merge function directly) so a regression here is caught as a pipeline
 * failure, not just a unit-level one.
 */
void describe("a prose-only Plan Item Checklist claim reaches advance-eligibility with zero file changes (Part 4/8, end to end)", () => {
  const PROSE_CLAIM_TICKS_BOTH_ITEMS = [
    "## Files Changed",
    "",
    "- (none) — this round only verified prior work",
    "",
    "## Plan Item Checklist",
    "",
    "- Add the resolver — done — verified present in src/resolver.ts:12-30, tested by src/test/resolver.test.ts",
    "- Wire the decoder — done — verified present in src/decoder.ts:5-20, tested by src/test/decoder.test.ts",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  void it("ticks every remaining item for real, never latches, and the next full-marks review is advance-eligible — no manual plan-final.md edit anywhere in the chain", async () => {
    const { folderPath, folderUri, progress } = makeTaskFolder("prose_claim_reaches_advance_eligible");

    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: PROSE_CLAIM_TICKS_BOTH_ITEMS,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // 1. The merge actually ran and wrote real ticks — not the latch.
    const planFinalAfter = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.ok(
      planFinalAfter.includes("- [x] Add the resolver"),
      "the prose claim must land as a real checkbox tick on disk, with no file changes and no manual edit"
    );
    assert.ok(planFinalAfter.includes("- [x] Wire the decoder"));

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.checklistProgressUnreliable,
      undefined,
      "a claim that actually resolves and ticks for real must never trip the under-recording latch — " +
        "that exit is reserved for when the counts themselves cannot be trusted"
    );

    const logs = readRunLogs(folderPath);
    const diagnosticsLog = logs.find((log) => log.includes("## Checklist merge diagnostics"));
    assert.ok(
      diagnosticsLog?.includes("Merge kind: `merged`"),
      "the run log must record that this round's prose claim actually merged, not that it was rejected " +
        "or left unmatched"
    );

    // 2. No notification tells the operator to hand-edit anything — this
    // round needed no human intervention.
    assert.equal(
      run.notifications.some((n) => /tick the missed items|hand-edit|Reconciled/i.test(n.message)),
      false,
      "a round whose claim actually merged must not surface any reconciliation/manual-edit affordance"
    );

    // 3. The stage is now advance-eligible on the next full-marks review —
    // the same predicate the real advance gate calls at its call site.
    const fsBridge = installFsBridge();
    try {
      const NO_MARKER_REVIEW = "# Implementation Review\n\nReadiness: 10/10\n\nEverything checks out.\n";
      const reconciled = await effectiveReviewProgressV1(
        folderUri,
        "impl-high-review",
        NO_MARKER_REVIEW,
        "strict"
      );
      assert.equal(
        readyToAdvanceStage(10, getAutoAdvanceScoreThreshold(), reconciled),
        true,
        "with both plan items genuinely ticked, a full-marks review must now advance the stage with no " +
          "manual file editing anywhere in the chain"
      );
    } finally {
      fsBridge.restore();
    }
  });
});

/**
 * Part 8 step 1, closing the gap the review of this plan's previous round
 * flagged: every earlier "end to end" block in this file drives the real
 * round-completion pipeline up to the exact predicate the advance gate calls
 * (effectiveReviewProgressV1 + readyToAdvanceStage) and stops there — none of
 * them drives the REVIEW rounds themselves, so none proves the task actually
 * reaches Publish. `publishOwnershipMatrix.test.ts` already contains a full
 * review-round harness (runReviewForFolder against a stubbed V1 runner
 * selection, driving the real advanceStageViaNextStageRowV1 transition) — the
 * "no review-round harness exists anywhere in the suite" reasoning documented
 * on the "Part 3, end to end" block above was therefore too broad; that
 * harness is reused here (runPassingReviewHarnessed) to chain two real
 * review rounds after the zero-file prose-claim implementation round, so this
 * test drives the literal chain the seventh item asked for: a round whose
 * checklist state does not merge as checkboxes (prose only, no file changes)
 * reaching `publish`, with no manual `plan-final.md` edit anywhere.
 */
void describe("the prose-claim exit reaches literal Publish with no manual editing anywhere (Part 8 step 1, end to end)", () => {
  const PROSE_CLAIM_TICKS_BOTH_ITEMS = [
    "## Files Changed",
    "",
    "- (none) — this round only verified prior work",
    "",
    "## Plan Item Checklist",
    "",
    "- Add the resolver — done — verified present in src/resolver.ts:12-30, tested by src/test/resolver.test.ts",
    "- Wire the decoder — done — verified present in src/decoder.ts:5-20, tested by src/test/decoder.test.ts",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const FULL_MARKS_REVIEW = "# Implementation Review\n\nReadiness: 10/10\n\nEverything checks out. No blockers.\n";

  void it("a zero-file prose-only round ticks the checklist, then two real review rounds advance impl-high-review -> impl-low-review -> publish", async () => {
    const { folderPath, progress } = makeTaskFolder("prose_claim_reaches_literal_publish");
    // runReviewForFolder requires a non-empty plan.md (resolveCurrentPlanUri)
    // in addition to makeTaskFolder's plan-final.md — the implementation
    // round harness above never needed it since it never runs a review.
    fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Add the resolver.\n2. Wire the decoder.\n", "utf8");

    // Round 1: the zero-file, checkbox-free prose claim — the exact shape
    // that used to be rejected by the shape gate before this same plan's
    // Part 8 discovery fixed it (known-gaps.md, "a prose-only Plan Item
    // Checklist claim ... was rejected before the merge could ever run").
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: PROSE_CLAIM_TICKS_BOTH_ITEMS,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });
    const planFinalAfterRound = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.ok(
      planFinalAfterRound.includes("- [x] Add the resolver") && planFinalAfterRound.includes("- [x] Wire the decoder"),
      "precondition: the prose claim must have ticked both items for real before any review runs"
    );
    assert.equal(
      readProgress(folderPath).checklistProgressUnreliable,
      undefined,
      "precondition: the round above must not have latched — this test exercises the merge exit, not the latch exit"
    );

    // Round 2: a real, full-marks review AT the task's current stage
    // (impl-high-review) — same-stage self-review, exactly what "review the
    // current stage" means in production (REVIEW_TARGETS["impl-high-review"]
    // === "impl-high-review"). With the checklist now showing 0 remaining,
    // readyToAdvanceStage passes and the REAL advance chain fires.
    await runPassingReviewHarnessed(folderPath, "impl-high-review", FULL_MARKS_REVIEW);
    const afterFirstReview = readProgress(folderPath);
    assert.equal(
      afterFirstReview.currentStage,
      "impl-low-review",
      "a full-marks review with a genuinely complete checklist must advance the stage for real, via the same " +
        "advanceStageViaNextStageRowV1 transition production uses — not just report advance-eligible"
    );

    // Round 3: the same real review, now at impl-low-review — the last hop
    // to Publish.
    await runPassingReviewHarnessed(folderPath, "impl-low-review", FULL_MARKS_REVIEW);
    const afterSecondReview = readProgress(folderPath);
    assert.equal(
      afterSecondReview.currentStage,
      "publish",
      "the task must reach Publish through two real review rounds with no human ever hand-editing " +
        "plan-final.md — the exact chain the seventh item's verification requirement describes"
    );
  });
});

/**
 * Part 8 step 1, second complementary exit (2026-08-16 review finding): the
 * block above proves the Part 4 prose-claim exit reaches literal `publish`.
 * This block proves the Part 3 LATCH exit reaches it too — a sterile round
 * behind a qualifying zero-blocker review stands the checklist gate down
 * (`checklistProgressUnreliable`), and the task then advances through two
 * real review rounds to Publish with the plan's own items STILL genuinely
 * unticked on disk. That is the defining difference from the prose-claim
 * exit: here nothing ever merges as checkboxes — the gate itself stands
 * down — so this is a distinct proof, not a duplicate of the block above.
 * The "checklistProgressUnreliable stand-down lets the next review advance
 * (Part 3, end to end)" block already proves the underlying predicate pair
 * (`effectiveReviewProgressV1` + `readyToAdvanceStage`); this drives the
 * real round-completion and review pipelines end to end instead.
 */
void describe("the checklistProgressUnreliable latch exit reaches literal Publish with no manual editing anywhere (Part 3+8, end to end)", () => {
  const zeroBlockerFullMarks = [
    {
      stage: "impl-high-review" as const,
      score: 10,
      attemptId: "attempt-passing",
      at: "2026-01-02T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
    },
  ];

  // Same sterile-echo shape the "Part 3, widened trigger" block above
  // proves latches the gate: no files changed, the checklist echoed
  // verbatim with nothing newly ticked, no retroactive claim at all.
  const STERILE_ECHO_NO_CLAIM_SUMMARY = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the resolver",
    "- [ ] Wire the decoder",
    "",
    "## Files Changed",
    "",
    "- (none) — the review already confirmed this satisfies the plan; nothing left to change",
    "",
    "## Verification",
    "",
    "- ran the unit tests",
  ].join("\n");

  const FULL_MARKS_REVIEW = "# Implementation Review\n\nReadiness: 10/10\n\nEverything checks out. No blockers.\n";

  void it("a sterile round behind a qualifying review latches the gate, then two real review rounds advance impl-high-review -> impl-low-review -> publish", async () => {
    const { folderPath, progress } = makeTaskFolder("latch_reaches_literal_publish", {
      reviewScoreHistory: zeroBlockerFullMarks,
    });
    // runReviewForFolder requires a non-empty plan.md, same precondition as
    // the prose-claim block above.
    fs.writeFileSync(
      path.join(folderPath, "plan.md"),
      "# Plan\n\n1. Add the resolver.\n2. Wire the decoder.\n",
      "utf8"
    );

    // Round 1: the sterile round behind the qualifying zero-blocker
    // full-marks review already on record — must latch the gate.
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: STERILE_ECHO_NO_CLAIM_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });
    const latched = readProgress(folderPath);
    assert.equal(
      latched.checklistProgressUnreliable,
      true,
      "precondition: the sterile round behind a qualifying review must latch the gate before the review " +
        "rounds below can prove it stands the advance down"
    );
    assert.equal(
      latched.currentStage,
      "impl-high-review",
      "precondition: latching the checklist gate must not itself advance the stage — only a passing review does"
    );

    // Round 2: a real, full-marks review at impl-high-review. The plan's
    // own 2 items are STILL unticked on disk — the latch stands the count
    // down, it never ticks anything.
    await runPassingReviewHarnessed(folderPath, "impl-high-review", FULL_MARKS_REVIEW);
    const afterFirstReview = readProgress(folderPath);
    assert.equal(
      afterFirstReview.currentStage,
      "impl-low-review",
      "a full-marks review must advance the stage for real under the stood-down latch, via the same " +
        "advanceStageViaNextStageRowV1 transition production uses — with the plan's 2 items still genuinely unticked"
    );
    const planStillUnticked = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.ok(
      planStillUnticked.includes("- [ ] Add the resolver") && planStillUnticked.includes("- [ ] Wire the decoder"),
      "the latch exit advances WITHOUT ticking the plan — proving this is the stand-down path, not the merge path"
    );

    // Round 3: the same real review, now at impl-low-review — the last hop
    // to Publish, under the same still-latched gate.
    await runPassingReviewHarnessed(folderPath, "impl-low-review", FULL_MARKS_REVIEW);
    const afterSecondReview = readProgress(folderPath);
    assert.equal(
      afterSecondReview.currentStage,
      "publish",
      "the task must reach Publish through two real review rounds with no human ever hand-editing " +
        "plan-final.md — the latch exit's own literal-publish proof, distinct from the prose-claim exit above"
    );
  });
});

/**
 * Part 8 step 1, third complementary exit (2026-08-16 review finding): the
 * two blocks above prove the Part 4 (prose-claim merge) and Part 3 (latch
 * stand-down) exits reach literal `publish`. This proves the Part 5 exit —
 * `applyReviewerVerifiedTicks` ("Apply N reviewer-verified ticks"), the
 * one-click command an OPERATOR invokes (not a round) to apply a reviewer's
 * `## Verified Complete` list — writes real checkbox ticks with zero file
 * changes and zero implementation rounds, and the task then advances through
 * two real review rounds to Publish with no human ever hand-editing
 * plan-final.md. `applyReviewerVerifiedTicksCommand.test.ts` already proves
 * the command's own ticking behavior in isolation; this drives it as one
 * step of the real end-to-end chain the seventh item's verification
 * requirement describes.
 */
void describe("the reviewer-verified-ticks exit reaches literal Publish with no manual editing anywhere (Part 5+8, end to end)", () => {
  const FULL_MARKS_REVIEW = "# Implementation Review\n\nReadiness: 10/10\n\nEverything checks out. No blockers.\n";

  const REVIEW_WITH_VERIFIED_ITEMS = [
    "# Implementation Review",
    "",
    "Readiness: 9/10",
    "",
    "<!-- verified-complete:start -->",
    "- Add the resolver",
    "- Wire the decoder",
    "<!-- verified-complete:end -->",
    "",
    "<!-- blockers:start -->",
    "<!-- blockers:end -->",
  ].join("\n");

  void it("Apply N reviewer-verified ticks writes real checkbox ticks with zero file changes, then two real review rounds advance impl-high-review -> impl-low-review -> publish", async () => {
    const { folderPath, progress } = makeTaskFolder("apply_ticks_reaches_literal_publish");
    fs.writeFileSync(
      path.join(folderPath, "plan.md"),
      "# Plan\n\n1. Add the resolver.\n2. Wire the decoder.\n",
      "utf8"
    );
    // Overwrite the default placeholder review with one naming both plan
    // items as reviewer-verified complete.
    fs.writeFileSync(path.join(folderPath, "impl-high-review.md"), REVIEW_WITH_VERIFIED_ITEMS, "utf8");

    const canonicalId = "canonical-apply-ticks-reaches-publish";
    const task = {
      canonicalId,
      taskFolderPath: folderPath,
      folderName: path.basename(folderPath),
      sourceScopeKey: canonicalId,
      progress,
    };
    const inventory = Object.create(TaskInventory.prototype) as TaskInventory;
    // @ts-expect-error — direct field init on stub, mirrors applyReviewerVerifiedTicksCommand.test.ts's makeInventory
    inventory.visibleTasks = [task];
    // @ts-expect-error — direct field init on stub
    inventory.taskByCanonicalId = new Map([[canonicalId, task]]);
    // @ts-expect-error — direct field init on stub
    inventory.suppressionAliasMap = new Map();
    inventory.refresh = (): Promise<void> => Promise.resolve();
    inventory.getTasks = (): Array<typeof task> => [task];
    inventory.getTaskById = (id: string): typeof task | undefined => (id === canonicalId ? task : undefined);
    inventory.getTaskByPath = (p: string): typeof task | undefined => (p === folderPath ? task : undefined);
    inventory.getVisibleTaskForSuppressedId = (): undefined => undefined;
    inventory.getVisibleTaskForSuppressedPath = (): undefined => undefined;

    const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
    store.get = (): string | undefined => canonicalId;
    store.set = (): Promise<void> => Promise.resolve();
    store.clear = (): Promise<void> => Promise.resolve();

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const windowTarget = vscode.window as unknown as Record<string, unknown>;
    const origShowWarning = windowTarget.showWarningMessage;
    windowTarget.showWarningMessage = (): Promise<string> => Promise.resolve("Apply Ticks");
    try {
      // applyReviewerVerifiedTicks now only POSTS the explained decision
      // (case 2 — its own doc comment); this test is about the write
      // mechanics that used to run behind the modal, so it drives the
      // confirmed-execution path directly, as choosing "Apply" in Chat
      // With AI would.
      await applyReviewerVerifiedTicks(inventory, store, { taskFolderPath: folderPath });
      await applyReviewerVerifiedTicksConfirmedV1(inventory, store, { taskFolderPath: folderPath });
    } finally {
      windowTarget.showWarningMessage = origShowWarning;
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }

    const planAfterApply = fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
    assert.ok(
      planAfterApply.includes("- [x] Add the resolver") && planAfterApply.includes("- [x] Wire the decoder"),
      "precondition: Apply N reviewer-verified ticks must land real checkbox ticks with zero file changes " +
        "and zero implementation rounds before any review runs"
    );

    // Round 2: a real, full-marks review at impl-high-review. With the
    // checklist now showing 0 remaining (ticked by the command, not a
    // round), the real advance chain fires.
    await runPassingReviewHarnessed(folderPath, "impl-high-review", FULL_MARKS_REVIEW);
    const afterFirstReview = readProgress(folderPath);
    assert.equal(
      afterFirstReview.currentStage,
      "impl-low-review",
      "a full-marks review with a genuinely complete checklist must advance the stage for real — the " +
        "operator's one-click apply is what completed it, not an implementation round"
    );

    // Round 3: the same real review, now at impl-low-review — the last hop
    // to Publish.
    await runPassingReviewHarnessed(folderPath, "impl-low-review", FULL_MARKS_REVIEW);
    const afterSecondReview = readProgress(folderPath);
    assert.equal(
      afterSecondReview.currentStage,
      "publish",
      "the task must reach Publish through the operator's one-click reviewer-verified-ticks apply plus two " +
        "real review rounds, with no human ever hand-editing plan-final.md"
    );
  });
});

/**
 * Part 1 (2026-08-14): the ONE durable recovery transition. Round 010 of
 * ".ensemble/2026-08-13_task_1" ("workflow 2") was finalized `completed` with
 * its edits kept while its whole response was a stale-waiter narration; the
 * summary was stamped unusable and NOTHING was persisted or scheduled, so the
 * task sat at impl-high-review/active with no round 011 until a human
 * noticed. Both failure classes — a detected incomplete round AND a
 * stamped-unusable summary — now land the identical `implRecovery` record
 * (quarantined delta, continuation count, mode, dispatch: "pending") in one
 * strict patch BEFORE anything else is written or scheduled.
 */
void describe("durable recovery transition (implRecovery, end to end)", () => {
  /** Verbatim response body from runs/010-claude-cli-impl.md. */
  const ROUND_010_RESPONSE =
    "Stale waiter stopped. The full unit suite (with the fix compiled in) is " +
    "running in the background — I'll write the final summary when its " +
    "completion notification arrives with the final pass/fail counts.";

  /** Rejected shape WITHOUT deferral phrasing: reports files, no Verification, no echo. */
  const REJECTED_NO_DEFERRAL_SUMMARY =
    "## Files Changed\n\n- `src/rejected.ts` — reworked the resolver\n\nDone.";

  void it("the round-010 fixture lands the recovery record durably before the run log, artifacts preserved", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_round010");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/commands/reviewActions.ts", "src/utils/implementationArtifactResolver.ts"],
      filesChangedUnknown: false,
      summary: ROUND_010_RESPONSE,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    const record = persisted?.implRecovery;
    assert.ok(record, "the recovery record must persist");
    assert.equal(record.trigger, "roundDeferred");
    assert.equal(record.mode, "unconstrained");
    assert.equal(record.dispatch, "pending");
    assert.ok(record.sourceAttemptId.startsWith("impl-recovery-"));
    assert.match(record.reason, /follow-up turn/);
    assert.deepEqual(
      [...(persisted?.pendingImplReviewFiles ?? [])].sort(),
      ["src/commands/reviewActions.ts", "src/utils/implementationArtifactResolver.ts"]
    );
    assert.equal(persisted?.incompleteRoundContinuations, 1);

    // Crash-order invariant: the identical record was already durable at the
    // instant the run log was written — before any dispatch.
    assert.equal(run.recoveryAtRunLogWrite.length, 1);
    assert.equal(run.recoveryAtRunLogWrite[0]?.dispatch, "pending");
    assert.equal(run.recoveryAtRunLogWrite[0]?.sourceAttemptId, record.sourceAttemptId);

    // A detected round preserves artifacts (no unusable stamp).
    assert.equal(fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8"), PRIOR_SUMMARY);

    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /Status: incomplete \(roundDeferred\)/);
    assert.match(logs[0]!, /Recovery record: `impl-recovery-/);
    assert.match(logs[0]!, /continuation 1 of 3, unconstrained/);

    assert.equal(run.dispatches.length, 1);
    assert.equal(run.dispatches[0]?.chainId, "impl-continuation");
    // The warning names the continuation count and mode — wording distinct
    // from a plain "review paused, waiting on user" state.
    assert.ok(
      run.notifications.some((n) => /continuation implementation round \(1 of 3, unconstrained\)/.test(n.message))
    );
  });

  void it("a stamped-unusable summary WITHOUT deferral phrasing lands the same recovery record and schedules the continuation", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_rejected");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/rejected.ts"],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    const record = persisted?.implRecovery;
    assert.ok(record, "the rejected-summary path must persist recovery state, not nothing");
    assert.equal(record.trigger, "summaryRejected");
    assert.equal(record.dispatch, "pending");
    assert.deepEqual(persisted?.pendingImplReviewFiles, ["src/rejected.ts"]);
    assert.equal(persisted?.incompleteRoundContinuations, 1);
    // Quarantine and review scope are mutually exclusive for a rejected
    // round: even though the summary's own `## Files Changed` attributes
    // src/rejected.ts to the round, nothing may be banked until a later
    // usable summary promotes the pending set (review blocker, 2026-08-14).
    assert.deepEqual(
      persisted?.implReviewFiles,
      ["src/prior.ts"],
      "a rejected round's delta must stay quarantined, never banked into implReviewFiles"
    );

    // Durable before the run log, exactly like the detected-round class.
    assert.equal(run.recoveryAtRunLogWrite.length, 1);
    assert.equal(run.recoveryAtRunLogWrite[0]?.trigger, "summaryRejected");

    // The stamp is still written — and now states what happens next.
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(summary.includes("<!-- ensemble:implementation-summary-unusable -->"));
    assert.match(summary, /continuation implementation round \(1 of 3, unconstrained\)/);

    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /Status: completed/);
    assert.match(logs[0]!, /## Unusable summary — recovery scheduled/);
    assert.match(logs[0]!, /- src\/rejected\.ts/);

    // Continuation scheduled. Item 10 / 13c: a `summaryRejected` round's WORK
    // is known-good (only its report was rejected), so — unlike the detected
    // deferred/cut-short class below — this path must NOT dangle the
    // destructive "Revert this round's changes" option against a situation
    // with no defensible reason to choose it. The plain warning notification
    // still announces the outcome; the round's own ledger outcome line
    // (Part 4) is the durable record of "work intact, continuation owed".
    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      true
    );
    const decision = run.pendingDecisions?.find((d) => d.decisionKey === "restoreRejectedImplementationRound");
    assert.equal(decision, undefined, "a summaryRejected round's work is known-good — no restore decision is offered");
    assert.ok(
      run.notifications.some((n) => /continuation implementation round \(1 of 3, unconstrained\)/.test(n.message)),
      "the outcome is still announced, just not as a decision with a destructive option"
    );
  });

  void it("cap exhaustion on the rejected-summary path escalates to human instead of looping", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_rejected_cap", {
      incompleteRoundContinuations: MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 - 1,
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/rejected.ts"],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.incompleteRoundContinuations, MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1);
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.escalation?.kind, "plateau");
    assert.equal(persisted?.implRecovery?.trigger, "summaryRejected");
    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      false
    );
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.match(summary, /continuation budget is exhausted/);
  });

  void it("filesChangedUnknown is recorded honestly on the record instead of an empty quarantine list", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_unknown");
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: true,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery?.filesChangedUnknown, true);
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.equal(persisted?.incompleteRoundContinuations, 1);
  });

  void it("a known-zero-change rejected summary lands the recovery record and schedules the continuation instead of parking the task", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_zero_change");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The exemption this pins against: "provably no edits" used to skip
    // recovery entirely, leaving an unusable stamp on an active task with
    // nothing scheduled (review blocker, 2026-08-14).
    const persisted = readProgress(folderPath);
    const record = persisted?.implRecovery;
    assert.ok(record, "a zero-change rejected summary must land the recovery record");
    assert.equal(record.trigger, "summaryRejected");
    assert.equal(record.dispatch, "pending");
    assert.equal(record.filesChangedUnknown, undefined);
    assert.equal(persisted?.incompleteRoundContinuations, 1);
    // Nothing to quarantine, nothing banked — and honestly recorded as such.
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.deepEqual(persisted?.implReviewFiles, ["src/prior.ts"]);
    assert.equal(persisted?.status, "active");

    // Durable before the run log, like every other trigger of the transition.
    assert.equal(run.recoveryAtRunLogWrite.length, 1);
    assert.equal(run.recoveryAtRunLogWrite[0]?.trigger, "summaryRejected");

    // The stamp is written and states what happens next.
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(summary.includes("<!-- ensemble:implementation-summary-unusable -->"));
    assert.match(summary, /continuation implementation round \(1 of 3, unconstrained\)/);

    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /## Unusable summary — recovery scheduled/);
    assert.match(logs[0]!, /_none recorded_/);

    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      true,
      "the continuation must be scheduled even with a provably empty change set"
    );
    assert.ok(
      run.notifications.some((n) =>
        /continuation implementation round \(1 of 3, unconstrained\)/.test(n.message)
      )
    );
  });

  void it("a rejected summary whose round also broke the type-check still dispatches the continuation before returning", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_typecheck");
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/rejected.ts"],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
      typeCheckFailed: true,
      typeCheckOutput: "src/rejected.ts(1,1): error TS2304: Cannot find name 'x'.",
    });

    // The type-check gate returns first; it used to do so WITHOUT finishing
    // the recovery dispatch, so the stamp claimed a continuation "has been
    // scheduled" while the record sat pending under a live lease (review
    // blocker, 2026-08-14).
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery?.trigger, "summaryRejected");
    assert.deepEqual(persisted?.pendingImplReviewFiles, ["src/rejected.ts"]);
    assert.deepEqual(persisted?.implReviewFiles, ["src/prior.ts"]);
    assert.equal(persisted?.implementationTypeCheckFailure !== undefined, true);

    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(summary.includes("<!-- ensemble:implementation-summary-unusable -->"));
    assert.match(summary, /continuation implementation round \(1 of 3, unconstrained\)/);

    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      true,
      "the stamp's promise must be true: the continuation is dispatched even when the type-check gate returns first"
    );
    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /## Type-check failure/);
    assert.match(logs[0]!, /## Unusable summary — recovery scheduled/);
  });

  void it("a later usable round claims the pending dispatch and clears the record in the finalizing transaction", async () => {
    const { folderPath, progress } = makeTaskFolder("recovery_cleared", {
      pendingImplReviewFiles: ["src/newfile.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
      implRecovery: {
        sourceAttemptId: "impl-recovery-seeded",
        reason: "seeded for the clear test",
        trigger: "roundDeferred",
        mode: "unconstrained",
        dispatch: "pending",
        at: "2026-01-02T00:00:00.000Z",
      },
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The run START claimed the record (pending → dispatched, one patch), so
    // at the moment the run log was written the record read "dispatched" —
    // proof a restart at that instant would never re-fire it.
    assert.equal(run.recoveryAtRunLogWrite.length, 1);
    assert.equal(run.recoveryAtRunLogWrite[0]?.dispatch, "dispatched");
    assert.ok(run.recoveryAtRunLogWrite[0]?.attemptId?.startsWith("impl-continuation-"));

    // The usable summary's finalizing transaction cleared the whole record
    // alongside the promotion of the pending set — and only NOW does the
    // quarantined delta enter review scope, unioned with the usable round's
    // own reported files.
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery, undefined);
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.equal(persisted?.incompleteRoundContinuations, undefined);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/newfile.ts", "src/prior.ts", "src/resolver.ts"],
      "promotion by a usable round is the only path into implReviewFiles for a quarantined delta"
    );
  });
});

/**
 * Part 2 (2026-08-14): evidence-based recovery modes, selected at transition
 * time and enforced by the post-run delta gate — a full stage redo
 * (`unconstrained`) is reserved for rounds whose EDITS are suspect, and a
 * prior clean review's score never covers edits made by a later round.
 *
 * `summary-only` requires an enforceable text-mode dispatch (Part 2 item 4,
 * `runSummaryOnlyContinuationV1`): the harness patches the capability probe
 * (false by default — the plan's `inspect-and-complete` fallback, never an
 * edit run carrying only a no-edits instruction) and the text dispatch
 * itself, so both the fallback and the real summary-only path are pinned.
 * Eligibility is additionally bound to the exact reviewed boundary: the
 * 0-blocker score must still DESCRIBE the pre-round tree (fresh
 * impl-high-review artifact at the reviewed stage), or selection refuses the
 * narrowed modes (review blocker 2, 2026-08-14).
 */
void describe("recovery mode selection and enforcement (Part 2, end to end)", () => {
  const REJECTED_NO_DEFERRAL_SUMMARY =
    "## Files Changed\n\n- `src/rejected.ts` — reworked the resolver\n\nDone.";

  const zeroBlockerHistory = [
    {
      stage: "impl-high-review" as const,
      score: 9,
      attemptId: "attempt-passing",
      at: "2026-01-02T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
    },
  ];

  void it("a rejected summary after a 0-blocker high review over a clean boundary selects inspect-and-complete when text mode is not honorable (fallback)", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_fallback", {
      reviewScoreHistory: zeroBlockerHistory,
    });
    // The harness probe defaults to false: the resolved provider cannot
    // enforce a read-only text run, so the plan's fallback rule applies.
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/rejected.ts"],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery?.mode, "inspect-and-complete");
    assert.equal(persisted?.implRecovery?.trigger, "summaryRejected");
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.match(summary, /continuation implementation round \(1 of 3, inspect-and-complete\)/);
    assert.ok(
      run.notifications.some((n) => /1 of 3, inspect-and-complete/.test(n.message)),
      "the warning must name the narrowed mode, not a full redo"
    );
  });

  void it("the same failure with an enforceable text-mode dispatch selects summary-only", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_summary_only_selected", {
      reviewScoreHistory: zeroBlockerHistory,
    });
    await runHarnessed(
      folderPath,
      progress,
      {
        status: "completed",
        filesChanged: ["src/rejected.ts"],
        filesChangedUnknown: false,
        summary: REJECTED_NO_DEFERRAL_SUMMARY,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      },
      { summaryOnlyDispatchAvailable: true }
    );
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery?.mode, "summary-only");
    assert.equal(persisted?.implRecovery?.dispatch, "pending");
  });

  void it("the same failure with open blockers on the latest high review stays unconstrained — the edits are suspect", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_open_blockers", {
      reviewScoreHistory: [
        { ...zeroBlockerHistory[0]!, score: 6, blockerCount: 2, taskFixableCount: 2 },
      ],
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/rejected.ts"],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });
    assert.equal(readProgress(folderPath)?.implRecovery?.mode, "unconstrained");
  });

  void it("an unknown delta stays unconstrained even after a 0-blocker review — no trustworthy delta to inspect", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_unknown_delta", {
      reviewScoreHistory: zeroBlockerHistory,
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: [],
      filesChangedUnknown: true,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery?.mode, "unconstrained");
    assert.equal(persisted?.implRecovery?.filesChangedUnknown, true);
  });

  void it("an outstanding quarantine before the round forbids the narrowed modes — the prior score does not cover unreported edits", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_dirty_boundary", {
      reviewScoreHistory: zeroBlockerHistory,
      pendingImplReviewFiles: ["src/unreported.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
    });
    await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/rejected.ts"],
      filesChangedUnknown: false,
      summary: REJECTED_NO_DEFERRAL_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });
    assert.equal(readProgress(folderPath)?.implRecovery?.mode, "unconstrained");
  });

  void it("a claimed summary-only continuation that can no longer dispatch in text mode escalates to inspect-and-complete BEFORE the edit run, never reaching an edit-capable path with the no-edits mandate", async () => {
    // Review blocker, 2026-08-14: the transition-time probe checked the
    // stage chain's PRIMARY, but THIS round resolves against a different
    // model whose text mode is not guaranteed read-only (the harness's probe
    // defaults to false, i.e. unavailable). The escalation must happen
    // before any dispatch decision — never let the claimed record and its
    // prompt still say `summary-only` while an edit-capable run executes.
    const { folderPath, progress } = makeTaskFolder("mode_summary_only_unenforceable", {
      reviewScoreHistory: zeroBlockerHistory,
      pendingImplReviewFiles: ["src/newfile.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
      implRecovery: {
        sourceAttemptId: "impl-recovery-seeded",
        reason: "seeded summary-only continuation",
        trigger: "summaryRejected",
        mode: "summary-only",
        dispatch: "pending",
        at: "2026-01-02T00:00:00.000Z",
      },
    });
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      filesChanged: ["src/resolver.ts"],
      filesChangedUnknown: false,
      summary: GOOD_SUMMARY,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // Never routed through text mode; the edit dispatch ran under the
    // REBUILT inspect-and-complete mandate, not the stale summary-only one.
    assert.equal(run.textPrompts.length, 0, "an unenforceable claim must never attempt text dispatch");
    assert.equal(run.prompts.length, 1);
    assert.match(run.prompts[0]!, /## Continuation Notice — inspect and complete/);
    assert.doesNotMatch(run.prompts[0]!, /report only \(summary-only\)/);
    assert.match(run.prompts[0]!, /Quarantined files \(unverified work in progress\):\n- src\/newfile\.ts/);
    assert.match(run.prompts[0]!, /Previously-reviewed boundary:\n- src\/prior\.ts/);

    // Persisted mid-run, before the claimed round's own patch — the CAS is
    // keyed on the claim's fresh attemptId.
    const claimedAttemptId = run.recoveryAtRunLogWrite[0]?.attemptId;
    assert.ok(claimedAttemptId, "the claim must have assigned a fresh continuation attemptId");

    // The round reported properly under its (rebuilt) mandate, so it is
    // ACCEPTED, not rejected: the report matches its own attributed delta,
    // the quarantine promotes, and the recovery record clears — this is the
    // key behavioral difference from the old "reject and re-quarantine"
    // path, which wasted a whole continuation re-litigating a claim the
    // round was never able to honor in the first place.
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(!summary.includes("<!-- ensemble:implementation-summary-unusable -->"));
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery, undefined);
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.equal(persisted?.incompleteRoundContinuations, undefined);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/newfile.ts", "src/prior.ts", "src/resolver.ts"],
      "the quarantined delta promotes and the round's own attributed delta banks alongside it"
    );

    // `src/resolver.ts` sits outside the quarantined+reviewed boundary — kept
    // (the gate is a backstop, not a sandbox), but recorded as unreviewed
    // scope rather than silently covered by the escalated mandate.
    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /## Out-of-boundary changes \(inspect-and-complete\)/);
    assert.match(logs[0]!, /src\/resolver\.ts/);
  });

  void it("the post-run delta gate still rejects a genuine summary-only violation when text mode itself reports edits", async () => {
    // The enforceable path (probe available, dispatched in text mode) is the
    // one place a violation can still slip through: a provider whose text
    // mode is supposed to be read-only but shells out anyway. This is the
    // gate `runSummaryOnlyContinuationV1`'s before/after git snapshot exists
    // to catch — distinct from the pre-dispatch escalation covered above.
    const { folderPath, progress } = makeTaskFolder("mode_summary_only_text_violation", {
      reviewScoreHistory: zeroBlockerHistory,
      pendingImplReviewFiles: ["src/newfile.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
      implRecovery: {
        sourceAttemptId: "impl-recovery-seeded",
        reason: "seeded summary-only continuation",
        trigger: "summaryRejected",
        mode: "summary-only",
        dispatch: "pending",
        at: "2026-01-02T00:00:00.000Z",
      },
    });
    const run = await runHarnessed(
      folderPath,
      progress,
      {
        // The edit-path result is a tripwire: routing there at all fails the
        // test via the prompts/textPrompts assertions below.
        status: "failed",
        filesChanged: [],
        runnerId: "test-cli",
      },
      {
        summaryOnlyDispatchAvailable: true,
        textResult: {
          status: "completed",
          filesChanged: ["src/resolver.ts"],
          filesChangedUnknown: false,
          // A WELL-FORMED summary on purpose: the delta gate must reject the
          // round for editing, not for its shape — a good report cannot
          // narrate over edits the mode forbade.
          summary: GOOD_SUMMARY,
          runnerId: "impl-continuation-text",
          providerLabel: "Test CLI",
          storedModelId: "cli:test-model",
        },
      }
    );

    // Dispatched in text mode, under the summary-only mandate — the probe
    // passed, so this IS the enforceable path.
    assert.equal(run.textPrompts.length, 1);
    assert.equal(run.prompts.length, 0, "the edit path must never be invoked for summary-only");
    assert.match(run.textPrompts[0]!, /## Continuation Notice — report only \(summary-only\)/);

    // Not accepted as a summary-only report: stamped unusable despite the
    // valid shape, nothing banked, both deltas quarantined.
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(summary.includes("<!-- ensemble:implementation-summary-unusable -->"));
    const persisted = readProgress(folderPath);
    assert.deepEqual(persisted?.implReviewFiles, ["src/prior.ts"]);
    assert.deepEqual(
      [...(persisted?.pendingImplReviewFiles ?? [])].sort(),
      ["src/newfile.ts", "src/resolver.ts"],
      "the violating round's delta joins the quarantine — never discarded, never banked as reviewed"
    );

    // The mode escalated under the same continuation cap.
    assert.equal(persisted?.implRecovery?.mode, "inspect-and-complete");
    assert.equal(persisted?.implRecovery?.dispatch, "pending");
    assert.equal(persisted?.incompleteRoundContinuations, 2);
    assert.equal(
      run.dispatches.some((d) => d.chainId === "impl-continuation"),
      true
    );

    // The warning and run log say plainly what happened.
    assert.ok(
      run.notifications.some((n) =>
        /summary-only continuation edited files it was not permitted to edit/.test(n.message)
      )
    );
    const logs = readRunLogs(folderPath);
    assert.match(logs[0]!, /was not permitted to edit files/);
  });

  void it("an inspect-and-complete continuation records out-of-boundary paths as unreviewed scope and still requires a fresh review", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_inspect_boundary", {
      pendingImplReviewFiles: ["src/newfile.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
      implRecovery: {
        sourceAttemptId: "impl-recovery-seeded",
        reason: "seeded inspect-and-complete continuation",
        trigger: "summaryRejected",
        mode: "inspect-and-complete",
        dispatch: "pending",
        at: "2026-01-02T00:00:00.000Z",
      },
    });
    const inspectSummary = GOOD_SUMMARY.replace(
      "- `src/resolver.ts` — added the resolver",
      "- `src/resolver.ts` — added the resolver\n- `src/newfile.ts` — finished the deferred work"
    );
    const run = await runHarnessed(folderPath, progress, {
      status: "completed",
      // src/newfile.ts is inside the boundary (quarantined); src/resolver.ts
      // is outside it (neither quarantined nor previously reviewed).
      filesChanged: ["src/newfile.ts", "src/resolver.ts"],
      filesChangedUnknown: false,
      summary: inspectSummary,
      runnerId: "test-cli",
      providerLabel: "Test CLI",
      storedModelId: "cli:test-model",
    });

    // The continuation ran under the inspect-and-complete mandate, with both
    // boundary lists in the prompt.
    assert.match(run.prompts[0]!, /## Continuation Notice — inspect and complete/);
    assert.match(run.prompts[0]!, /- src\/newfile\.ts/);
    assert.match(run.prompts[0]!, /Previously-reviewed boundary:\n- src\/prior\.ts/);

    // The out-of-boundary path is named in the run log — kept, but recorded
    // as scope the prior review's score does not cover.
    const logs = readRunLogs(folderPath);
    const boundarySection = logs[0]!.split("## Out-of-boundary changes (inspect-and-complete)")[1];
    assert.ok(boundarySection, "the run log must carry the out-of-boundary section");
    const sectionBody = boundarySection.split("\n## ")[0]!;
    assert.match(sectionBody, /- src\/resolver\.ts/);
    assert.doesNotMatch(sectionBody, /- src\/newfile\.ts/);

    // A usable report: the record clears, the quarantine promotes, and BOTH
    // paths enter review scope for the next review.
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery, undefined);
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/newfile.ts", "src/prior.ts", "src/resolver.ts"]
    );

    // Part 2 step 4's pin: the combined scope still requires a fresh review —
    // the stage's artifact is stale-stamped, so the prior score can never be
    // read as covering the continuation's edits.
    const review = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
    assert.ok(review.trimStart().startsWith("# Review Stale"));
  });

  void it("a summary-only continuation dispatches in TEXT mode, scoped to the reviewed files plus the quarantined delta, and its accepted report promotes and clears the record", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_summary_only_dispatch", {
      reviewScoreHistory: zeroBlockerHistory,
      pendingImplReviewFiles: ["src/newfile.ts"],
      incompleteRoundContinuations: 1,
      reviewInvalidatedByRound: { stage: "impl-high-review", at: "2026-01-02T00:00:00.000Z" },
      implRecovery: {
        sourceAttemptId: "impl-recovery-seeded",
        reason: "seeded summary-only continuation",
        trigger: "summaryRejected",
        mode: "summary-only",
        dispatch: "pending",
        at: "2026-01-02T00:00:00.000Z",
      },
    });
    // The report covers the EXISTING combined diff (reviewed + quarantined)
    // and, per the mode's mandate, the round itself changes nothing.
    const combinedReport = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] Add the resolver",
      "- [ ] Wire the decoder",
      "",
      "## Files Changed",
      "",
      "- `src/newfile.ts` — the quarantined delta, reported",
      "- `src/prior.ts` — previously-reviewed work, reported",
      "",
      "## Verification",
      "",
      "- re-verified the existing diff; made no edits",
    ].join("\n");
    const run = await runHarnessed(
      folderPath,
      progress,
      {
        // The edit-path result is a tripwire: routing there at all fails the
        // test via the textPrompts/prompts assertions below.
        status: "failed",
        filesChanged: [],
        runnerId: "test-cli",
      },
      {
        summaryOnlyDispatchAvailable: true,
        textResult: {
          status: "completed",
          filesChanged: [],
          filesChangedUnknown: false,
          summary: combinedReport,
          runnerId: "impl-continuation-text",
          providerLabel: "Test CLI",
          storedModelId: "cli:test-model",
        },
      }
    );

    // Dispatched through the text path — edit permissions withheld — and
    // never through the edit path.
    assert.equal(run.textPrompts.length, 1, "the continuation must dispatch in text mode");
    assert.equal(run.prompts.length, 0, "the edit path must not be invoked for summary-only");
    assert.match(run.textPrompts[0]!, /## Continuation Notice — report only \(summary-only\)/);
    assert.match(run.textPrompts[0]!, /Quarantined delta awaiting a report:\n- src\/newfile\.ts/);
    assert.match(run.textPrompts[0]!, /Previously-reviewed files:\n- src\/prior\.ts/);

    // The accepted report is the round's summary; the quarantine promotes,
    // the recovery record clears, and the continuation counter resets.
    const summary = fs.readFileSync(path.join(folderPath, "impl-summary.md"), "utf8");
    assert.ok(summary.includes("## Files Changed"));
    assert.ok(!summary.includes("<!-- ensemble:implementation-summary-unusable -->"));
    const persisted = readProgress(folderPath);
    assert.equal(persisted?.implRecovery, undefined);
    assert.equal(persisted?.pendingImplReviewFiles, undefined);
    assert.deepEqual(
      [...(persisted?.implReviewFiles ?? [])].sort(),
      ["src/newfile.ts", "src/prior.ts"]
    );

    // The combined scope still requires a fresh review: the prior 0-blocker
    // score never covered the quarantined delta.
    const review = fs.readFileSync(path.join(folderPath, "impl-high-review.md"), "utf8");
    assert.ok(review.trimStart().startsWith("# Review Stale"));
  });

  void it("a successful post-review edit round makes the old 0-blocker score stale: the next unreported round is never summary-only (review blocker 2)", async () => {
    const { folderPath, progress } = makeTaskFolder("mode_stale_score", {
      reviewScoreHistory: zeroBlockerHistory,
    });

    // Round 1: an ordinary successful edit round AFTER the 0-blocker review.
    // Its report is usable, so nothing quarantines — but its edits were never
    // reviewed, and the stage's review artifact goes stale.
    const roundOneSummary = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] Add the resolver",
      "- [ ] Wire the decoder",
      "",
      "## Files Changed",
      "",
      "- `src/roundb.ts` — new post-review work",
      "",
      "## Verification",
      "",
      "- ran the unit tests",
    ].join("\n");
    await runHarnessed(
      folderPath,
      progress,
      {
        status: "completed",
        filesChanged: ["src/roundb.ts"],
        filesChangedUnknown: false,
        summary: roundOneSummary,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      },
      { summaryOnlyDispatchAvailable: true }
    );
    const reviewAfterRoundOne = fs.readFileSync(
      path.join(folderPath, "impl-high-review.md"),
      "utf8"
    );
    assert.ok(
      reviewAfterRoundOne.trimStart().startsWith("# Review Stale"),
      "round 1's edits must stale-stamp the review artifact"
    );

    // Round 2: an unreported round. The 0-blocker history entry still exists
    // and the boundary reads clean (round 1 reported properly), but that
    // score reviewed a tree that no longer exists — summary-only must NOT be
    // selected, even with text mode fully available.
    await runHarnessed(
      folderPath,
      readProgress(folderPath),
      {
        status: "completed",
        filesChanged: ["src/rejected.ts"],
        filesChangedUnknown: false,
        summary: REJECTED_NO_DEFERRAL_SUMMARY,
        runnerId: "test-cli",
        providerLabel: "Test CLI",
        storedModelId: "cli:test-model",
      },
      { summaryOnlyDispatchAvailable: true }
    );
    const persisted = readProgress(folderPath);
    assert.equal(
      persisted?.implRecovery?.mode,
      "unconstrained",
      "a stale 0-blocker score must never select summary-only for later, unreviewed edits"
    );
  });
});

/**
 * wf10 Part 5 step 15 review fix (narrowed blocker
 * 0089d9c1-3b36-423e-ad61-75ea7932be98-2): the prior round's causal test
 * (reviewRoutingMalformedBlockers.test.ts) chained the two REAL exported
 * functions (`handleReviewRoutingOutcome` then
 * `dispatchDegenerateReviewBackupAdvanceV1`) together itself — proving
 * composability, but never making a rejected review actually traverse
 * `routeReviewOutcomeV1` (reviewActions.ts, not exported), the production
 * orchestration whose own `if (!escalated && degenerateBackupAdvance?.kind
 * === "advance")` conditional is what is supposed to perform this hand-off
 * automatically. That conditional was covered only by a source-text
 * assertion (degenerateReviewBackupAdvanceV1.test.ts).
 *
 * An initial attempt drove this through `runReviewForFolder` (the initial-
 * dispatch path) with a fake transport returning degenerate content, and
 * discovered it CANNOT reach the scenario under test: `reviewRowV1.ts`'s
 * `validateReviewCompletedContentV1` rejects any null-score content at the
 * coordinator's own per-candidate content-contract check
 * (taskActionCoordinatorV1.ts ~:1933-1980) BEFORE it can ever settle as a
 * "completed" outcome — it either retries the next candidate itself (via the
 * coordinator's OWN cascade, unrelated to wf10's routing-level backup
 * decision) or returns `kind: "failed", code: "contentContractFailed"`,
 * never `kind: "completed"`. So `handleReviewRoutingOutcome`'s degenerate-
 * rejection branch — which only runs inside `routeReviewOutcomeV1`'s
 * `outcome.kind === "completed"` branch — is structurally UNREACHABLE via
 * the initial-dispatch path. Tracing where a null-score "completed" outcome
 * legitimately originates (`taskActionCoordinatorV1.ts`'s `executeResume`,
 * used by Chat Resume) confirmed it never applies `validateCompletedContent`
 * at all — that check exists only in `executeAction`'s per-candidate
 * reservation loop. So a degenerate review reaching "completed" is real, but
 * ONLY via Resume, never via a fresh dispatch.
 *
 * This test therefore drives round 1 through `handleReviewOutcomeV1`
 * (exported above specifically for this) directly, with a synthetic-but-
 * realistic "completed" outcome of the exact shape `coordinator.resumeAction`
 * legitimately produces (content already promoted to the review file, no
 * Readiness line) — precisely mirroring what `resumeReviewInteractionV1`
 * feeds it in production, without needing to also fake the chat-interaction-
 * transaction/orchestrator plumbing incidental to what is under test here.
 * From there EVERYTHING is real production code with no manual composition:
 * `routeReviewOutcomeV1`'s real branches, the real `handleReviewRoutingOutcome`
 * degenerate-rejection decision, and the real `if (!escalated &&
 * degenerateBackupAdvance?.kind === "advance")` conditional's dispatch into a
 * REAL second `runReviewForFolder` round (round 2), which — being real,
 * well-formed "Readiness: 9/10" content — passes the initial path's own
 * content-contract check normally. A real `switch-to-backup` chain is
 * injected via the vscode test stub's `_configOverrides` so
 * `getConfiguredBackupModelsForStage` resolves a genuine backup. The test
 * never calls `runReviewForFolder` itself for round 2 — if its transport is
 * ever invoked, it can only be because `routeReviewOutcomeV1`'s own
 * conditional dispatched it.
 */
function installModelSettingsOverrideV1(raw: Record<string, unknown>): { restore: () => void } {
  const ws = vscode.workspace as unknown as { _configOverrides: Map<string, unknown> };
  const had = ws._configOverrides.has("modelSettings");
  const previous = ws._configOverrides.get("modelSettings");
  ws._configOverrides.set("modelSettings", raw);
  return {
    restore: (): void => {
      if (had) {
        ws._configOverrides.set("modelSettings", previous);
      } else {
        ws._configOverrides.delete("modelSettings");
      }
    },
  };
}

/** Wraps `markdownReviewTransportV1` so the test can prove, from OUTSIDE routing, exactly how many rounds actually dispatched. */
function spiedMarkdownReviewTransportV1(
  markdown: string,
  runnerId: string,
  onInvoke: () => void
): AgentTransportV1 {
  const base = markdownReviewTransportV1(markdown, runnerId);
  return {
    runnerId: base.runnerId,
    invoke: (request, output): Promise<AgentTransportExitV1> => {
      onInvoke();
      return base.invoke(request, output);
    },
  };
}

/** A well-formed-looking 32-hex-char id, matching `isHex128IdV1` — the shape `ActionCorrelationV1` fields require. */
function fakeHex128IdV1(seed: string): string {
  return (seed.repeat(32)).slice(0, 32).replace(/[^0-9a-f]/g, "0");
}

void describe("a rejected degenerate review flows through PRODUCTION routing to an automatic second dispatch (Part 5 step 15, causal end-to-end)", () => {
  void it("routeReviewOutcomeV1's real 'advance' conditional dispatches the configured backup with no test-side manual chaining", async () => {
    // Seed the round-ledger row `claimReviewAttempt` would have opened for
    // this attempt in production — `terminalizeRoundV1` (the sole writer of
    // the `roundOutcomes` classification recorded below) only writes when it
    // can resolve a matching row.
    const { folderPath, folderUri } = makeTaskFolder("degenerate-causal-e2e-production-routing", {
      roundLedger: [
        {
          roundId: "attempt-degenerate-causal-e2e-00000001",
          attemptIds: ["attempt-degenerate-causal-e2e-00000001"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:00:00.000Z",
          state: "open",
        },
      ],
    });
    // Round 2's real automatic dispatch goes through runReviewForFolder,
    // which requires a non-empty plan.md (resolveCurrentPlanUri) in addition
    // to makeTaskFolder's plan-final.md — same precondition as the "two real
    // review rounds" harness above.
    fs.writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n\n1. Add the resolver.\n2. Wire the decoder.\n", "utf8");

    const currentStage: TaskStage = "impl-high-review";
    const DEGENERATE_CONTENT =
      "I read the file but it kept truncating, so here is my current blocker instead.";
    const PASSING_BACKUP_REVIEW =
      "# Implementation Review\n\nReadiness: 9/10\n\nEverything checks out. No blockers.\n";

    // Simulate what `coordinator.resumeAction` really does before returning a
    // "completed" outcome to its caller: the content is ALREADY promoted to
    // the review artifact on disk. `routeReviewOutcomeV1` re-reads the file,
    // never the outcome's own (absent-here) content field.
    fs.writeFileSync(path.join(folderPath, "impl-high-review.md"), DEGENERATE_CONTENT, "utf8");

    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const workspaceRoot = { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 } as vscode.WorkspaceFolder;
    const contextPack = path.join(folderPath, "review-context-pack.md");
    fs.writeFileSync(contextPack, "# Context\n", "utf8");

    const modelSettings = installModelSettingsOverrideV1({
      [currentStage]: {
        primary: "codex-cli:gpt-5.6",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });

    let transportsInvoked = 0;
    const round2Transport = spiedMarkdownReviewTransportV1(PASSING_BACKUP_REVIEW, "stub-review-runner-backup", () => {
      transportsInvoked += 1;
    });

    const patches: Patched[] = [
      patch(settingsModule, "isAutoAdvanceEnabled", () => true),
      patch(settingsModule, "getAutoAdvanceMode", () => "auto"),
      patch(settingsModule, "getAutoAdvanceScoreThreshold", () => 8),
      patch(modelSelectionModule, "resolveConfiguredReviewStages", () =>
        Promise.resolve(new Set(REVIEW_STAGES))),
      // Only ONE transport: round 1 never reaches the coordinator at all
      // (it is injected directly below), so the ONLY reservation this stub
      // will ever be asked for is round 2's automatic backup dispatch.
      stubV1ReviewRunnerSelection([round2Transport]),
      patch(promptTemplatesModule, "renderPromptTemplate", () => Promise.resolve("stub review prompt")),
      patch(contextPackModule, "writeContextPack", () => Promise.resolve(vscode.Uri.file(contextPack))),
      patch(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> => Promise.resolve(true)),
      patch(publishPreflightModule, "checkPublishPreflight", () =>
        Promise.resolve({
          ok: true,
          lintPayload: { runAt: "now", passed: true, summary: "", issueCount: 0, failedChecks: [], missingScripts: [] },
        })),
    ];
    try {
      const reviewAttemptId = "attempt-degenerate-causal-e2e-00000001";
      const outcome: TaskActionOutcomeV1 = {
        kind: "completed",
        code: "completed",
        correlation: {
          actionKey: "review.v1",
          operationId: fakeHex128IdV1("0"),
          attemptId: fakeHex128IdV1("1"),
          taskBindingId: fakeHex128IdV1("2"),
          chatDocumentId: fakeHex128IdV1("3"),
        },
        provider: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
      };
      // The exact ctx shape resumeReviewInteractionV1 builds for
      // handleReviewOutcomeV1: same-stage self-review (targetStage ===
      // currentStage), since REVIEW_TARGETS["impl-high-review"] ===
      // "impl-high-review".
      await handleReviewOutcomeV1(outcome, {
        extensionUri: vscode.Uri.file(REAL_ROOT),
        folderUri,
        workspaceUri: workspaceRoot.uri,
        currentStage,
        targetStage: currentStage,
        reviewUri: vscode.Uri.joinPath(folderUri, "impl-high-review.md"),
        variables: {},
        reviewAttemptId,
        modelId: "codex-cli:gpt-5.6",
        promptLength: DEGENERATE_CONTENT.length,
        providerId: "codex-cli",
      });
    } finally {
      for (const p of patches.reverse()) { p.restore(); }
      modelSettings.restore();
      wsStub.restore();
      fsBridge.restore();
      provider.dispose();
      deactivateNotificationRouter();
    }

    assert.equal(
      transportsInvoked,
      1,
      "the automatic backup round's transport must be invoked by routeReviewOutcomeV1's OWN dispatch — " +
        "the test never calls runReviewForFolder itself for round 2"
    );

    const persisted = readProgress(folderPath);
    assert.equal(
      persisted.roundOutcomes?.[0]?.classification,
      "rejected-degenerate",
      "round 1's degenerate content must still be recorded as a rejected round, exactly as the isolated-decision test already checks"
    );
    assert.equal(persisted.roundOutcomes?.[0]?.stage, currentStage);
    const lastScore = persisted.reviewScoreHistory?.at(-1);
    assert.equal(
      lastScore?.score,
      9,
      "round 2's real score must have been recorded — proof the automatically-dispatched backup round actually " +
        "completed through the same production routing, not merely that a transport function was called"
    );
    assert.equal(lastScore?.stage, currentStage);
  });
});
