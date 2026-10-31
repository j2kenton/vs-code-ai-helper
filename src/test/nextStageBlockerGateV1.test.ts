/**
 * wf10 item 19 / Step 28 (review blocker a96160ec-…-2, third narrowing): the
 * two pre-existing consumers of `blockerSupersessions` — `readStageArtifactsForChat`
 * (chatWithStage.ts) and `computePlanReviewBlockerSupersessionEvidenceV1`
 * (reconcilePlanChecklist.ts) — are both informational, so a manual
 * "Complete Stage & Move On" could silently advance past a blocker the
 * artifacts still list as outstanding. `nextStage` (reviewActions.ts) now
 * warns and offers a "Complete Anyway" override (`vs-code-ai-helper.completeStageAnywayV1`)
 * instead of silently advancing, whenever the current plan-review stage's
 * own review artifact still lists a blocker no confirmed `plan.md` edit has
 * superseded — see `getOutstandingPlanReviewBlockersForAdvanceV1`'s doc
 * comment in reviewActions.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { completeStageAnywayV1, nextStage } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { OWNED_FIXTURE_BOUND_AT } from "./taskFolderFixture";
import { IncompleteTask } from "../types/incompleteTask";
import { TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

/* eslint-disable @typescript-eslint/no-var-requires */
const taskOperationsModule = require("../utils/taskOperations") as Record<string, unknown>;
const settingsModule = require("../config/settings") as Record<string, unknown>;
const chatChoiceModule = require("../utils/chatChoiceV1") as {
  askChatChoiceV1: (req: AskedChoice) => Promise<string | undefined>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

interface RecordedEntry {
  message: string;
  level: "info" | "warning" | "error";
  actionCommand?: { command: string; title: string; args?: unknown[] };
}

class RecordingSurface {
  entries: RecordedEntry[] = [];
  addEntry(
    message: string,
    level: "info" | "warning" | "error",
    _filePath?: string,
    _resultTargetUri?: string,
    _sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void {
    this.entries.push({ message, level, actionCommand });
  }
}

/** `resolveTask`'s direct `node.task.folderUri` path reads task progress and
 * review artifacts through `vscode.workspace.fs.readFile`, which the test
 * stub leaves `notImplemented` by default — bridge it (and `readDirectory`,
 * for anything that lists the task folder) to the real filesystem, the same
 * technique `nextStageCurrentTaskDefault.test.ts` uses for its discovery
 * path. */
function installFsBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fsObj.readFile;
  const origReadDirectory = fsObj.readDirectory;
  const origStat = fsObj.stat;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  fsObj.readDirectory = (uri: vscode.Uri): Promise<[string, number][]> => {
    if (!fs.existsSync(uri.fsPath)) {
      return Promise.reject(new Error("ENOENT"));
    }
    return Promise.resolve(
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((entry) => [
        entry.name,
        entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ])
    );
  };
  fsObj.stat = (uri: vscode.Uri): Promise<vscode.FileStat> =>
    fs.promises.stat(uri.fsPath).then((stat) => ({
      type: vscode.FileType.File,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    }));
  return {
    restore: (): void => {
      fsObj.readFile = origReadFile;
      fsObj.readDirectory = origReadDirectory;
      fsObj.stat = origStat;
    },
  };
}

function makeContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  return { workspaceState: memento } as unknown as vscode.ExtensionContext;
}

function writeTaskProgress(folder: string, extra: Partial<TaskProgress> = {}): TaskProgress {
  const progress: TaskProgress = {
    taskFolder: path.basename(folder),
    currentStage: "plan-high-review",
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    ownership: {
      metaRoot: path.dirname(folder),
      projectRoot: path.dirname(folder),
      boundAt: OWNED_FIXTURE_BOUND_AT,
      state: "resolved",
    } as TaskProgress["ownership"],
    ...extra,
  };
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2));
  return progress;
}

function makeNode(folder: string): { task: IncompleteTask } {
  return {
    task: {
      folderUri: vscode.Uri.file(folder),
      folderName: path.basename(folder),
      progress: {
        taskFolder: path.basename(folder),
        currentStage: "plan-high-review",
        status: "active",
        createdAt: "",
        updatedAt: "",
      } as TaskProgress,
    },
  };
}

interface AskedChoice {
  decisionKey: string;
  whatHappened: string;
  holdsProgress?: boolean;
  options: ReadonlyArray<{ optionId: string; label: string }>;
}

const REVIEW_WITH_BLOCKER =
  "Readiness: 6/10\n\n" +
  "<!-- blockers:start -->\n" +
  "- [architectural] [environmental] the owner must approve the tie policy\n" +
  "<!-- blockers:end -->\n";

void describe("nextStage — blocker-gate warning on manual advance (wf10 item 19 / Step 28)", () => {
  void it("warns and offers Complete Anyway instead of silently advancing when the plan-review stage's blocker is not superseded", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-blocker-gate-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    writeTaskProgress(taskFolder);
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    let cancelCalled = false;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> => {
      cancelCalled = true;
      return Promise.resolve({ ok: true });
    };

    const context = makeContext();
    __extensionContextV1TestOnly.set(context);
    const chatChoiceMod = chatChoiceModule;
    const origAsk = chatChoiceMod.askChatChoiceV1;
    const asked: AskedChoice[] = [];
    chatChoiceMod.askChatChoiceV1 = (req): Promise<string | undefined> => {
      asked.push(req);
      return Promise.resolve("notNow");
    };

    try {
      await nextStage(vscode.Uri.file(container), context, makeNode(taskFolder));

      // bugs3 Step 16: ONE confirmation at the click, labelled with what happens, not a second chat card.
      assert.equal(asked.length, 1);
      const [question] = asked;
      assert.equal(question!.decisionKey, "confirmAdvanceOverBlockers");
      assert.equal(question!.holdsProgress, true, "a card the advance waits on is never labelled Optional");
      assert.match(question!.options.find((o) => o.optionId === "advanceAnyway")!.label, /^Advance to .+ anyway$/);
      assert.ok(!question!.options.some((o) => /Complete/.test(o.label)), "no option reads as finishing the task");
      assert.match(question!.whatHappened, /the owner must approve the tie policy/);
      assert.ok(
        !new WorkflowDecisionStoreV1(context.workspaceState).listPending().some((d) => d.decisionKey === "chatActionOffer:completeStageAnywayV1"),
        "no second chat card is raised"
      );
      assert.equal(cancelCalled, false, "Not now leaves the running stage alone");
      assert.ok(!surface.entries.some((entry) => /advanced to:/.test(entry.message)), "Not now does not advance");
      assert.ok(!fs.existsSync(path.join(taskFolder, "advance-overrides-v1.jsonl")), "Not now records no override");
    } finally {
      chatChoiceMod.askChatChoiceV1 = origAsk;
      __extensionContextV1TestOnly.reset();
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      safeRemoveDir(container);
    }
  });

  void it("confirming advances once and records the override with the skipped blocker; a repeated click joins the open confirmation", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-advance-anyway-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    writeTaskProgress(taskFolder);
    fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\n\n- [ ] Do the work\n");
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> =>
      Promise.resolve({ ok: true });
    const origTriggers = settingsModule.completeAndMoveOnTriggersAI;
    settingsModule.completeAndMoveOnTriggersAI = (): boolean => false;
    const chatChoiceMod = chatChoiceModule;
    const origAsk = chatChoiceMod.askChatChoiceV1;
    const asked: AskedChoice[] = [];
    let answer: (value: string) => void = () => undefined;
    chatChoiceMod.askChatChoiceV1 = (req): Promise<string | undefined> => {
      asked.push(req);
      return new Promise((resolve) => {
        answer = resolve;
      });
    };

    try {
      const context = makeContext();
      const first = nextStage(vscode.Uri.file(container), context, makeNode(taskFolder));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = nextStage(vscode.Uri.file(container), context, makeNode(taskFolder));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(asked.length, 1, "repeating the click never raises a second card");
      answer("advanceAnyway");
      await Promise.all([first, second]);

      const persisted = JSON.parse(fs.readFileSync(path.join(taskFolder, "task-progress.json"), "utf8")) as TaskProgress;
      assert.notEqual(persisted.currentStage, "plan-high-review", `advanced; notifications: ${JSON.stringify(surface.entries)}`);
      assert.equal(surface.entries.filter((entry) => /advanced to:/.test(entry.message)).length, 1, "the transition ran exactly once");
      const lines = fs
        .readFileSync(path.join(taskFolder, "advance-overrides-v1.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sourceStage: string; destinationStage: string; actor: string; skippedBlockers: { description: string }[] });
      assert.equal(lines.length, 1, "one override record");
      assert.equal(lines[0]!.sourceStage, "plan-high-review");
      assert.equal(lines[0]!.destinationStage, persisted.currentStage);
      assert.equal(lines[0]!.actor, "owner");
      assert.deepEqual(lines[0]!.skippedBlockers.map((b) => b.description), ["the owner must approve the tie policy"]);
      assert.match(
        (lines[0]!.skippedBlockers[0] as unknown as { id: string }).id,
        /^[0-9a-f]{12}$/,
        "the skipped blocker carries a stable id"
      );
      assert.ok(
        surface.entries.some((entry) => /already in progress/.test(entry.message)),
        "the repeated click is told an advance is already under way"
      );
    } finally {
      chatChoiceMod.askChatChoiceV1 = origAsk;
      settingsModule.completeAndMoveOnTriggersAI = origTriggers;
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      safeRemoveDir(container);
    }
  });

  void it("refuses a confirmation whose blocker set changed while it was open, and records no override", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-advance-changed-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    writeTaskProgress(taskFolder);
    fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\n\n- [ ] Do the work\n");
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> =>
      Promise.resolve({ ok: true });
    const origTriggers = settingsModule.completeAndMoveOnTriggersAI;
    settingsModule.completeAndMoveOnTriggersAI = (): boolean => false;
    const origAsk = chatChoiceModule.askChatChoiceV1;
    let answer: (value: string) => void = () => undefined;
    chatChoiceModule.askChatChoiceV1 = (): Promise<string | undefined> =>
      new Promise((resolve) => {
        answer = resolve;
      });

    try {
      const run = nextStage(vscode.Uri.file(container), makeContext(), makeNode(taskFolder));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A new review lands while the card is open: different blocker, different set.
      fs.writeFileSync(
        path.join(taskFolder, "plan-high-review.md"),
        REVIEW_WITH_BLOCKER.replace("the owner must approve the tie policy", "a different blocker the owner never saw")
      );
      answer("advanceAnyway");
      await run;

      const persisted = JSON.parse(fs.readFileSync(path.join(taskFolder, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(persisted.currentStage, "plan-high-review", "the stage did not move");
      assert.ok(!fs.existsSync(path.join(taskFolder, "advance-overrides-v1.jsonl")), "no override was recorded");
      assert.ok(surface.entries.some((entry) => /changed while the confirmation was open/.test(entry.message)));
    } finally {
      chatChoiceModule.askChatChoiceV1 = origAsk;
      settingsModule.completeAndMoveOnTriggersAI = origTriggers;
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      safeRemoveDir(container);
    }
  });

  void it("does not warn when the sole blocker is recorded as superseded by a confirmed plan.md edit", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-next-stage-blocker-gate-superseded-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);
    // Written well after the review artifact's own mtime, matching stage and
    // (trimmed) description exactly — filterSupersededBlockersV1's match rule.
    writeTaskProgress(taskFolder, {
      blockerSupersessions: [
        {
          stage: "plan-high-review",
          blockerDescription: "the owner must approve the tie policy",
          supersededAt: new Date(Date.now() + 60_000).toISOString(),
          planRelPath: "plan.md",
        },
      ],
    });

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> =>
      Promise.resolve({ ok: true });

    try {
      await nextStage(vscode.Uri.file(container), makeContext(), makeNode(taskFolder));

      assert.ok(
        !surface.entries.some((entry) => entry.actionCommand?.command === "vs-code-ai-helper.completeStageAnywayV1"),
        "a fully-superseded blocker must not trigger the gate warning"
      );
    } finally {
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      safeRemoveDir(container);
    }
  });
});

void describe("completeStageAnywayV1 — the registered force-advance handler (hand-off card Advance)", () => {
  void it("advances the task named by taskFolderPath past an outstanding blocker, persisting the new stage", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-complete-anyway-"));
    const taskFolder = path.join(container, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    writeTaskProgress(taskFolder);
    fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\n\n- [ ] Do the work\n");
    fs.writeFileSync(path.join(taskFolder, "plan-high-review.md"), REVIEW_WITH_BLOCKER);

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
    taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean; reason?: string }> =>
      Promise.resolve({ ok: true });

    // Keep the destination stage's own AI action out of this test: only the
    // force-advance itself is under test.
    const origTriggers = settingsModule.completeAndMoveOnTriggersAI;
    settingsModule.completeAndMoveOnTriggersAI = (): boolean => false;

    try {
      await completeStageAnywayV1(makeContext(), { taskFolderPath: taskFolder });

      assert.ok(
        !surface.entries.some((entry) => entry.actionCommand?.command === "vs-code-ai-helper.completeStageAnywayV1"),
        "the blocker gate is bypassed: no Complete Anyway warning is posted again"
      );
      const persisted = JSON.parse(fs.readFileSync(path.join(taskFolder, "task-progress.json"), "utf8")) as TaskProgress;
      assert.notEqual(
        persisted.currentStage,
        "plan-high-review",
        `the task's persisted stage must have moved on; notifications: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      settingsModule.completeAndMoveOnTriggersAI = origTriggers;
      taskOperationsModule.cancelRunningOperationsForTask = origCancel;
      fsBridge.restore();
      deactivateNotificationRouter();
      safeRemoveDir(container);
    }
  });
});
