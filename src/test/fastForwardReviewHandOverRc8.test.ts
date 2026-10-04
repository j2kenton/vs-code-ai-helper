/**
 * RC8 item 5: a review that auto-advances inside a Fast Forward run hands the
 * next stage over to exactly one follow-up, anchored to the run's LIVE ROOT
 * operation (the review itself runs as a child of that root), and the run's
 * closing report only says work is "queued" when it really is.
 *
 * Drives the real `taskOperations` registry and the real
 * `scheduleAutomationChain`; the only seam is `vscode.commands.executeCommand`,
 * which records the dispatched commands.
 *
 * Also pins the hand-overs RC5-RC7 fixed: into Implementation after a plan
 * review (RC5 item 1) and into Publish (RC5 item 2, RC7 item 5).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  handleReviewOutcomeV1,
  reportFastForwardMovedOnV1,
  scheduleAutomaticImplementationAfterReview,
} from "../commands/reviewActions";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { REVIEW_STAGES, STAGE_DISPLAY_NAMES, TaskProgress, TaskStage } from "../types/taskProgress";
import {
  __setAutomationChainGuardForTestV1,
  isAutomationChainActive,
  resetAutomationChainGuards,
} from "../utils/automationChain";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { taskOperations, TaskOperationHandle } from "../utils/taskOperations";
import { safeRemoveDir } from "./testFsUtils";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-handover-rc8-"));
after(() => {
  safeRemoveDir(ROOT);
});

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...fsObj };
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${uri.toString()}`), { code: "FileNotFound" }));
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsObj.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
  fsObj.stat = (uri: vscode.Uri): Promise<unknown> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${uri.toString()}`), { code: "FileNotFound" }));
    }
    return Promise.resolve({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.length });
  };
  fsObj.createDirectory = (): Promise<void> => Promise.resolve();
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
  return {
    restore: (): void => {
      Object.assign(fsObj, orig);
    },
  };
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const DISPLAY_NAME = "RC8 task";
const PASSING_REVIEW = "# Review\n\nReadiness: 10/10\n\nEverything checks out. No blockers.\n";
const REVIEW_FILE: Partial<Record<TaskStage, string>> = {
  "plan-high-review": "plan-high-review.md",
  "plan-low-review": "plan-low-review.md",
  "impl-high-review": "impl-high-review.md",
  "impl-low-review": "impl-low-review.md",
};

interface Dispatched {
  command: string;
  arg: unknown;
}

interface HandOverRun {
  folderPath: string;
  folderUri: vscode.Uri;
  root: TaskOperationHandle;
  child: TaskOperationHandle;
  surface: RecordingSurface;
  dispatched: Dispatched[];
  /** Display name of the stage the "Review accepted. Advanced to ..." notice named. */
  advancedTo: () => string | undefined;
  cleanup: () => void;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) {
    c();
  }
  cleanups = [];
  resetAutomationChainGuards();
});

/**
 * Route a completed 10/10 review of `fromStage` as a CHILD of a live Fast
 * Forward root, with the settings that make auto-advance chain the next stage.
 */
async function routeReviewUnderRoot(
  name: string,
  fromStage: TaskStage,
  options: {
    mode?: "auto" | "auto-fast-forward";
    autoImplement?: boolean;
    executeResult?: unknown;
    /** Route with an unregistered operation id and no live root. */
    orphanOperation?: boolean;
  } = {}
): Promise<HandOverRun> {
  const store: MemStore = new Map();
  const bridge = installMemStore(store);
  const surface = new RecordingSurface();
  initNotificationRouter(surface);
  const folderPath = path.join(ROOT, ".ensemble", name);
  const folderUri = vscode.Uri.file(folderPath);
  const reviewUri = vscode.Uri.joinPath(folderUri, REVIEW_FILE[fromStage]!);
  const progress: TaskProgress = {
    taskFolder: name,
    displayName: DISPLAY_NAME,
    currentStage: fromStage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reviewAttemptId: "attempt-rc8",
    ownership: {
      metaRoot: path.join(ROOT, ".ensemble"),
      projectRoot: ROOT,
      workspaceRoot: ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
  };
  store.set(vscode.Uri.joinPath(folderUri, "task-progress.json").toString(), JSON.stringify(progress, null, 2));
  store.set(reviewUri.toString(), PASSING_REVIEW);

  const settingPatches: Array<[string, unknown]> = [
    ["isAutoAdvanceEnabled", (): boolean => true],
    ["getAutoAdvanceMode", (): string => options.mode ?? "auto-fast-forward"],
    ["getAutoAdvanceScoreThreshold", (): number => 8],
    ["isAutoImplementAfterReviewEnabled", (): boolean => options.autoImplement ?? true],
  ];
  const originals = settingPatches.map(([key]) => [key, settingsModule[key]] as const);
  for (const [key, value] of settingPatches) {
    settingsModule[key] = value;
  }
  const origConfiguredStages = modelSelectionModule.resolveConfiguredReviewStages;
  modelSelectionModule.resolveConfiguredReviewStages = (): Promise<Set<TaskStage>> =>
    Promise.resolve(new Set(REVIEW_STAGES));
  store.set(vscode.Uri.joinPath(folderUri, "task.md").toString(), "# Task\n\nDo the thing.\n");
  store.set(
    vscode.Uri.joinPath(folderUri, "plan.md").toString(),
    "# Plan\n\n<!-- ensemble:implementation-checklist -->\n\n- [ ] 1. Do the thing.\n"
  );
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const origOverride = commandsObj._executeCommandOverride;
  const dispatched: Dispatched[] = [];
  commandsObj._executeCommandOverride = (id: string, arg?: unknown): Promise<unknown> => {
    dispatched.push({ command: id, arg });
    return Promise.resolve(options.executeResult);
  };

  const noop = (): void => undefined;
  const orphan = {
    id: "orphan-op",
    key: folderPath,
    label: "Review",
    report: noop,
    setModel: noop,
    setWaitingForUser: noop,
    setResultTargetUri: noop,
    reportActivity: noop,
    settleAs: noop,
  } as unknown as TaskOperationHandle;
  const root = options.orphanOperation
    ? orphan
    : taskOperations.begin(folderPath, {
        label: "Fast Forward Review",
        stage: fromStage,
        kind: "fast-forward",
        cancellable: true,
        taskName: DISPLAY_NAME,
      });
  assert.ok(root, "test setup: the exclusive root operation must register");
  const child = options.orphanOperation
    ? orphan
    : taskOperations.begin(folderPath, {
        label: "Review",
        stage: fromStage,
        kind: "review",
        parent: root,
        taskName: DISPLAY_NAME,
      });
  assert.ok(child, "test setup: the child review operation must register");

  const cleanup = (): void => {
    for (const [key, value] of originals) {
      settingsModule[key] = value;
    }
    modelSelectionModule.resolveConfiguredReviewStages = origConfiguredStages;
    commandsObj._executeCommandOverride = origOverride;
    deactivateNotificationRouter();
    bridge.restore();
  };
  cleanups.push(cleanup);

  const outcome: TaskActionOutcomeV1 = {
    kind: "completed",
    code: "completed",
    correlation: {
      actionKey: "review.v1",
      operationId: "0".repeat(32),
      attemptId: "1".repeat(32),
      taskBindingId: "2".repeat(32),
      chatDocumentId: "3".repeat(32),
    },
    provider: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
  };
  try {
    await handleReviewOutcomeV1(outcome, {
      extensionUri: vscode.Uri.file(ROOT),
      folderUri,
      workspaceUri: vscode.Uri.file(ROOT),
      currentStage: fromStage,
      targetStage: fromStage,
      reviewUri,
      variables: {},
      reviewAttemptId: "attempt-rc8",
      modelId: "codex-cli:gpt-5.6",
      providerId: "codex-cli",
      operation: child,
    });
  } catch {
    // Anything past the hand-over scheduling needs more of the production
    // harness than this test wires; the scheduling is the observable.
  }
  if (!options.orphanOperation) {
    taskOperations.end(child);
  }
  return {
    folderPath,
    folderUri,
    root,
    child,
    surface,
    dispatched,
    advancedTo: () => {
      for (const entry of surface.entries) {
        const match = /Advanced to (.+?)\./.exec(entry.message);
        if (match) {
          return match[1];
        }
      }
      return undefined;
    },
    cleanup,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function warnings(run: HandOverRun): string[] {
  return run.surface.entries.filter((e) => e.level === "warning").map((e) => e.message);
}

function reportOf(op: TaskOperationHandle): { texts: string[] } {
  const texts: string[] = [];
  const original = op.report.bind(op);
  (op as { report: (d: string | undefined) => void }).report = (d) => {
    if (d !== undefined) {
      texts.push(d);
    }
    original(d);
  };
  return { texts };
}

void describe("RC8 item 5: Fast Forward review-to-review hand-over", () => {
  for (const [label, from, to] of [
    ["plan reviews", "plan-high-review", "plan-low-review"],
    ["code reviews", "impl-high-review", "impl-low-review"],
  ] as const) {
    void it(`${label}: Low-Level review is dispatched exactly once, only after the root ends, with no busy warning`, async () => {
      const run = await routeReviewUnderRoot(`${from}-once`, from);
      await settle();
      assert.equal(run.advancedTo(), STAGE_DISPLAY_NAMES[to], "the review advanced the stage");
      assert.equal(run.dispatched.length, 0, "nothing is dispatched while the Fast Forward root still holds the lock");
      assert.equal(isAutomationChainActive(run.folderPath, "auto-review"), true, "the follow-up waits on the root");

      taskOperations.end(run.root);
      await settle();
      const reviews = run.dispatched.filter((d) => d.command === "vs-code-ai-helper.fastForwardReviewWithAI");
      assert.equal(reviews.length, 1, "exactly one Fast Forward run takes the new stage");
      assert.equal(run.dispatched.length, 1);
      assert.ok(!warnings(run).some((w) => /did not start|already in progress/.test(w)));
    });

    void it(`${label}: a pre-held auto-review slot (the run's own dispatch) is released, not treated as a duplicate`, async () => {
      __setAutomationChainGuardForTestV1(
        path.join(ROOT, ".ensemble", `${from}-held`),
        "auto-review",
        Date.now() + 60_000
      );
      const run = await routeReviewUnderRoot(`${from}-held`, from);
      taskOperations.end(run.root);
      await settle();
      assert.equal(
        run.dispatched.filter((d) => d.command === "vs-code-ai-helper.fastForwardReviewWithAI").length,
        1
      );
      assert.ok(!warnings(run).some((w) => /did not start|already in progress/.test(w)));
    });
  }

  void it("into Publish (RC5 item 2, RC7 item 5): the follow-up is dispatched once, after the root ends", async () => {
    const run = await routeReviewUnderRoot("into-publish", "impl-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Publish");
    assert.equal(run.dispatched.length, 0);
    taskOperations.end(run.root);
    await settle();
    assert.equal(run.dispatched.filter((d) => d.command === "vs-code-ai-helper.fastForwardReviewWithAI").length, 1);
  });

  void it("into Implementation (RC5 item 1): the Implementation round is scheduled behind the root and dispatched once", async () => {
    const run = await routeReviewUnderRoot("into-impl", "plan-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Implementation");
    assert.equal(run.dispatched.length, 0);
    taskOperations.end(run.root);
    await settle();
    assert.equal(run.dispatched.filter((d) => d.command === "vs-code-ai-helper.runImplementationWithAI").length, 1);
    assert.equal(run.dispatched.filter((d) => d.command === "vs-code-ai-helper.fastForwardReviewWithAI").length, 0);
  });

  void it("scheduleAutomaticImplementationAfterReview chains behind the given anchor and dispatches once", async () => {
    const folderPath = path.join(ROOT, ".ensemble", "impl-direct");
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const origOverride = commandsObj._executeCommandOverride;
    const dispatched: Dispatched[] = [];
    commandsObj._executeCommandOverride = (id: string, arg?: unknown): Promise<unknown> => {
      dispatched.push({ command: id, arg });
      return Promise.resolve(undefined);
    };
    const origEnabled = settingsModule.isAutoImplementAfterReviewEnabled;
    settingsModule.isAutoImplementAfterReviewEnabled = (): boolean => true;
    cleanups.push(() => {
      commandsObj._executeCommandOverride = origOverride;
      settingsModule.isAutoImplementAfterReviewEnabled = origEnabled;
    });
    const root = taskOperations.begin(folderPath, {
      label: "Fast Forward Review",
      stage: "plan-low-review",
      kind: "fast-forward",
      taskName: DISPLAY_NAME,
    });
    assert.ok(root);
    assert.equal(scheduleAutomaticImplementationAfterReview("impl", true, folderPath, { id: root.id }), true);
    await settle();
    assert.equal(dispatched.length, 0);
    taskOperations.end(root);
    await settle();
    assert.equal(dispatched.filter((d) => d.command === "vs-code-ai-helper.runImplementationWithAI").length, 1);
  });
});

void describe("RC8 item 5: reportFastForwardMovedOnV1", () => {
  function fakeReportOp(root: TaskOperationHandle): { op: TaskOperationHandle; texts: string[] } {
    const folderPath = root.key;
    const op = taskOperations.begin(folderPath, {
      label: "Fast Forward attempt",
      stage: root.stage,
      kind: "review",
      parent: root,
      taskName: DISPLAY_NAME,
    });
    assert.ok(op);
    const { texts } = reportOf(op);
    return { op, texts };
  }

  void it("queued: says the review is queued and starts when the run ends, never 'continuing there'", async () => {
    const run = await routeReviewUnderRoot("report-queued", "impl-high-review");
    const { op, texts } = fakeReportOp(run.root);
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "impl-low-review" });
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /queued and starts when this run ends/);
    assert.doesNotMatch(texts[0]!, /continuing there/);
    assert.deepEqual(warnings(run), []);
  });

  void it("dropped at once (duplicate-chain): reports nothing was started, with exactly one warning naming the task", async () => {
    // A review whose operation is not provably the task's live root cannot
    // release a slot held by a genuinely separate pending chain, so the
    // follow-up is dropped as a duplicate at once.
    const key = path.join(ROOT, ".ensemble", "report-dup");
    __setAutomationChainGuardForTestV1(key, "auto-review", Date.now() + 60_000);
    const run = await routeReviewUnderRoot("report-dup", "impl-high-review", { orphanOperation: true });
    await settle();
    const op = { id: "orphan-op", report: (d: string | undefined): void => void texts.push(d ?? "") };
    const texts: string[] = [];
    reportFastForwardMovedOnV1({
      op: op as unknown as TaskOperationHandle,
      folderUri: run.folderUri,
      displayName: DISPLAY_NAME,
      landedStage: "impl-low-review",
    });
    assert.match(texts[0]!, /nothing was started there/);
    const dropWarnings = warnings(run).filter((w) => /did not start|nothing was started/.test(w));
    assert.equal(dropWarnings.length, 1, "the drop is warned about exactly once");
    assert.match(dropWarnings[0]!, new RegExp(DISPLAY_NAME));
    assert.match(dropWarnings[0]!, /another automatic follow-up is already pending/);
  });

  void it("no hand-over: reports nothing was started and raises one warning naming the task", async () => {
    const run = await routeReviewUnderRoot("report-none", "impl-high-review", { mode: "auto" });
    // Remove the record by reporting once for another stage, then report for
    // the landed stage with no record left.
    const { op, texts } = fakeReportOp(run.root);
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "publish" });
    assert.match(texts[0]!, /nothing was started there/);
    assert.equal(warnings(run).filter((w) => /nothing was started there/.test(w)).length, 1);
    assert.ok(warnings(run).some((w) => w.includes(DISPLAY_NAME)));
    // A second report finds no record at all.
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "impl-low-review" });
    assert.match(texts[1]!, /nothing was started there/);
    assert.doesNotMatch(texts[1]!, /continuing there/);
  });

  void it("dropped after the root ends (auto-advance turned off while queued): the warning names the task, cause and manual step", async () => {
    const run = await routeReviewUnderRoot("report-off", "impl-high-review");
    settingsModule.isAutoAdvanceEnabled = (): boolean => false;
    taskOperations.end(run.root);
    await settle();
    assert.equal(run.dispatched.length, 0);
    const dropWarnings = warnings(run).filter((w) => /did not start/.test(w));
    assert.equal(dropWarnings.length, 1);
    assert.match(dropWarnings[0]!, new RegExp(DISPLAY_NAME));
    assert.match(dropWarnings[0]!, /automation was turned off/);
    assert.match(dropWarnings[0]!, /Run Review with AI on Low-Level Code Review/);
  });

  void it("declined (the dispatched command resolves false): the warning appears", async () => {
    const run = await routeReviewUnderRoot("report-declined", "impl-high-review", { executeResult: false });
    taskOperations.end(run.root);
    await settle();
    assert.equal(run.dispatched.length, 1);
    const declined = warnings(run).filter((w) => /did not start/.test(w));
    assert.equal(declined.length, 1);
    assert.match(declined[0]!, /declined to start/);
  });

  void it("started: no warning", async () => {
    const run = await routeReviewUnderRoot("report-started", "impl-high-review");
    taskOperations.end(run.root);
    await settle();
    assert.equal(run.dispatched.length, 1);
    assert.deepEqual(
      warnings(run).filter((w) => /did not start|nothing was started/.test(w)),
      []
    );
  });

  void it("Implementation hand-over: queued, dropped and no-hand-over reports use 'Run Implementation'", async () => {
    const run = await routeReviewUnderRoot("report-impl", "plan-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Implementation");
    const { op, texts } = fakeReportOp(run.root);
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "impl" });
    assert.match(texts[0]!, /Implementation round is queued and starts when this run ends/);
    // The record was consumed by the first report; nothing is left for impl.
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "impl" });
    assert.match(texts[1]!, /Run Implementation on/);
  });

  void it("Implementation hand-over, record for a different stage: reports nothing was started and warns once", async () => {
    // The queued record is for Implementation; the task landed elsewhere.
    const run = await routeReviewUnderRoot("report-impl-other", "plan-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Implementation");
    const { op, texts } = fakeReportOp(run.root);
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "impl-high-review" });
    assert.match(texts[0]!, /nothing was started there/);
    assert.doesNotMatch(texts[0]!, /continuing there/);
    const warned = warnings(run).filter((w) => /nothing was started there/.test(w));
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, new RegExp(DISPLAY_NAME));
  });

  void it("Implementation hand-over dropped at once (duplicate-chain): reports nothing was started, one warning naming the task", async () => {
    // The Implementation hand-over is guarded by its command key; a pending
    // chain already holding that key drops the follow-up synchronously.
    const key = path.join(ROOT, ".ensemble", "report-impl-dup");
    __setAutomationChainGuardForTestV1(key, "vs-code-ai-helper.runImplementationWithAI", Date.now() + 60_000);
    const run = await routeReviewUnderRoot("report-impl-dup", "plan-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Implementation");
    const { op, texts } = fakeReportOp(run.root);
    reportFastForwardMovedOnV1({ op, folderUri: run.folderUri, displayName: DISPLAY_NAME, landedStage: "impl" });
    assert.match(texts[0]!, /nothing was started there/);
    assert.match(texts[0]!, /Run Implementation/);
    assert.doesNotMatch(texts[0]!, /continuing there/);
    const dropWarnings = warnings(run).filter((w) => /did not start|nothing was started/.test(w));
    assert.equal(dropWarnings.length, 1, "the drop is warned about exactly once");
    assert.match(dropWarnings[0]!, new RegExp(DISPLAY_NAME));
    assert.equal(run.dispatched.length, 0);
  });
});

void describe("RC8 item 5: remaining outcome pins", () => {
  void it("into Publish with a failed root: the follow-up still dispatches once (dispatchEvenIfRootFails)", async () => {
    const run = await routeReviewUnderRoot("publish-failed-root", "impl-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Publish");
    assert.equal(run.dispatched.length, 0);
    taskOperations.end(run.root, "failed");
    await settle();
    assert.equal(run.dispatched.filter((d) => d.command === "vs-code-ai-helper.fastForwardReviewWithAI").length, 1);
  });

  void it("Implementation hand-over dropped after the root ends: the warning says to run Implementation", async () => {
    const run = await routeReviewUnderRoot("impl-dropped", "plan-low-review");
    await settle();
    assert.equal(run.advancedTo(), "Implementation");
    taskOperations.end(run.root, "failed");
    await settle();
    assert.equal(run.dispatched.length, 0);
    const dropWarnings = warnings(run).filter((w) => /did not start/.test(w));
    assert.equal(dropWarnings.length, 1);
    assert.match(dropWarnings[0]!, new RegExp(DISPLAY_NAME));
    assert.match(dropWarnings[0]!, /Run Implementation/);
  });

  void it("no hand-over, stage moved by another surface: reports nothing was started and warns once", () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    cleanups.push(() => {
      deactivateNotificationRouter();
      bridge.restore();
    });
    const folderPath = path.join(ROOT, ".ensemble", "manual-advance");
    const folderUri = vscode.Uri.file(folderPath);
    const progress = {
      taskFolder: "manual-advance",
      displayName: DISPLAY_NAME,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");
    store.set(progressUri.toString(), JSON.stringify(progress));
    const root = taskOperations.begin(folderPath, {
      label: "Fast Forward Review",
      stage: "impl-high-review",
      kind: "fast-forward",
      taskName: DISPLAY_NAME,
    });
    assert.ok(root);
    cleanups.push(() => taskOperations.end(root));
    const texts: string[] = [];
    (root as { report: (d: string | undefined) => void }).report = (d) => void texts.push(d ?? "");
    // A manual advance from another surface moves the stage; nothing is routed
    // through the auto-advance tail, so no hand-over record exists.
    store.set(progressUri.toString(), JSON.stringify({ ...progress, currentStage: "impl-low-review" }));
    reportFastForwardMovedOnV1({ op: root, folderUri, displayName: DISPLAY_NAME, landedStage: "impl-low-review" });
    assert.match(texts[0]!, /nothing was started there\. Run Review with AI on/);
    assert.doesNotMatch(texts[0]!, /continuing there/);
    const warned = surface.entries.filter((e) => e.level === "warning");
    assert.equal(warned.length, 1);
    assert.match(warned[0]!.message, new RegExp(DISPLAY_NAME));
  });

  void it("Implementation, no hand-over, stage moved by another surface: reports 'Run Implementation' and warns once", () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    cleanups.push(() => {
      deactivateNotificationRouter();
      bridge.restore();
    });
    const folderPath = path.join(ROOT, ".ensemble", "manual-advance-impl");
    const folderUri = vscode.Uri.file(folderPath);
    const progress = {
      taskFolder: "manual-advance-impl",
      displayName: DISPLAY_NAME,
      currentStage: "plan-low-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");
    store.set(progressUri.toString(), JSON.stringify(progress));
    const root = taskOperations.begin(folderPath, {
      label: "Fast Forward Review",
      stage: "plan-low-review",
      kind: "fast-forward",
      taskName: DISPLAY_NAME,
    });
    assert.ok(root);
    cleanups.push(() => taskOperations.end(root));
    const texts: string[] = [];
    (root as { report: (d: string | undefined) => void }).report = (d) => void texts.push(d ?? "");
    // A manual advance from another surface; the auto-advance tail never ran,
    // so no hand-over record exists for this root.
    store.set(progressUri.toString(), JSON.stringify({ ...progress, currentStage: "impl" }));
    reportFastForwardMovedOnV1({ op: root, folderUri, displayName: DISPLAY_NAME, landedStage: "impl" });
    assert.match(texts[0]!, /nothing was started there\. Run Implementation/);
    assert.doesNotMatch(texts[0]!, /continuing there/);
    const warned = surface.entries.filter((e) => e.level === "warning");
    assert.equal(warned.length, 1);
    assert.match(warned[0]!.message, new RegExp(DISPLAY_NAME));
    assert.match(warned[0]!.message, /Run Implementation/);
  });
});
