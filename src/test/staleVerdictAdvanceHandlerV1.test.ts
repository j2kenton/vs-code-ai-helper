/**
 * bugs4 Step 13 (item 29): the REAL advance handlers (`nextStage` for Complete & Move On,
 * `completeStageAnywayV1` for the hand-off card's Advance) refuse to carry the task past a
 * review that predates a change to plan-final.md, naming the file and recommending a re-run.
 * `staleReviewVerdictV1.test.ts` covers the detection and wording helpers; this drives the
 * handlers themselves.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { completeStageAnywayV1, nextStage } from "../commands/reviewActions";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { recordReviewInputsV1 } from "../utils/reviewInputsChangedV1";
import { IncompleteTask } from "../types/incompleteTask";
import { TaskProgress } from "../types/taskProgress";
import { OWNED_FIXTURE_BOUND_AT } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

/* eslint-disable @typescript-eslint/no-var-requires */
const taskOperationsModule = require("../utils/taskOperations") as Record<string, unknown>;
const settingsModule = require("../config/settings") as Record<string, unknown>;
const chatChoiceModule = require("../utils/chatChoiceV1") as {
  askChatChoiceV1: (req: AskedChoice) => Promise<string | undefined>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

interface AskedChoice {
  decisionKey: string;
  whatHappened: string;
  recommendedOptionId?: string;
  options: ReadonlyArray<{ optionId: string; label: string }>;
}

const PLAN_AT_REVIEW = "- [x] Retire the old bucket policy.\n- [x] Other item.\n";
const PLAN_WITH_CHILDREN =
  "- [x] Retire the old bucket policy.\n  - [ ] Add the deny-delete fix.\n  - [ ] Add the alarm-flapping fix.\n- [x] Other item.\n";

class RecordingSurface {
  entries: string[] = [];
  addEntry(message: string): void {
    this.entries.push(message);
  }
}

function installFsBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fsObj.readFile;
  const origReadDirectory = fsObj.readDirectory;
  const origStat = fsObj.stat;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  fsObj.readDirectory = (uri: vscode.Uri): Promise<[string, number][]> =>
    fs.existsSync(uri.fsPath)
      ? Promise.resolve(
          fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((entry): [string, number] => [
            entry.name,
            entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
          ])
        )
      : Promise.reject(new Error("ENOENT"));
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
      if (value === undefined) {
        backing.delete(key);
      } else {
        backing.set(key, value);
      }
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  return { workspaceState: memento } as unknown as vscode.ExtensionContext;
}

function makeNode(folder: string): { task: IncompleteTask } {
  return {
    task: {
      folderUri: vscode.Uri.file(folder),
      folderName: path.basename(folder),
      progress: {
        taskFolder: path.basename(folder),
        currentStage: "impl-low-review",
        status: "active",
        createdAt: "",
        updatedAt: "",
      } as TaskProgress,
    },
  };
}

/** A task at Low-Level Code Review whose 9/10 review was dispatched against `PLAN_AT_REVIEW`. */
async function lowReviewTask(planAtReview: string = PLAN_AT_REVIEW): Promise<{ container: string; folder: string }> {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stale-advance-"));
  const folder = path.join(container, "task-a");
  fs.mkdirSync(folder, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: path.basename(folder),
    currentStage: "impl-low-review",
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    ownership: {
      metaRoot: path.dirname(folder),
      projectRoot: path.dirname(folder),
      boundAt: OWNED_FIXTURE_BOUND_AT,
      state: "resolved",
    } as TaskProgress["ownership"],
  };
  fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2));
  fs.writeFileSync(path.join(folder, "task.md"), "task text");
  fs.writeFileSync(path.join(folder, "plan-final.md"), planAtReview);
  const review = path.join(folder, "impl-low-review.md");
  fs.writeFileSync(review, "Readiness: 9/10\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n");
  await recordReviewInputsV1(folder, review);
  const later = Date.now() / 1000 + 30;
  fs.utimesSync(review, later, later);
  return { container, folder };
}

async function withHandlerStubs(
  answer: string,
  body: (asked: AskedChoice[], cancelCalls: () => number) => Promise<void>
): Promise<void> {
  const surface = new RecordingSurface();
  initNotificationRouter(surface);
  const fsBridge = installFsBridge();
  const origCancel = taskOperationsModule.cancelRunningOperationsForTask;
  let cancelled = 0;
  taskOperationsModule.cancelRunningOperationsForTask = (): Promise<{ ok: boolean }> => {
    cancelled += 1;
    return Promise.resolve({ ok: true });
  };
  const origTriggers = settingsModule.completeAndMoveOnTriggersAI;
  settingsModule.completeAndMoveOnTriggersAI = (): boolean => false;
  const origAsk = chatChoiceModule.askChatChoiceV1;
  const asked: AskedChoice[] = [];
  chatChoiceModule.askChatChoiceV1 = (req): Promise<string | undefined> => {
    asked.push(req);
    return Promise.resolve(answer);
  };
  const context = makeContext();
  __extensionContextV1TestOnly.set(context);
  try {
    await body(asked, () => cancelled);
  } finally {
    chatChoiceModule.askChatChoiceV1 = origAsk;
    settingsModule.completeAndMoveOnTriggersAI = origTriggers;
    taskOperationsModule.cancelRunningOperationsForTask = origCancel;
    __extensionContextV1TestOnly.reset();
    fsBridge.restore();
    deactivateNotificationRouter();
  }
}

void describe("advance handlers refuse a stale verdict (bugs4 item 29)", () => {
  void it("Complete & Move On after children were added names plan-final.md, recommends a re-run and leaves the stage alone on Not now", async () => {
    const { container, folder } = await lowReviewTask();
    try {
      fs.writeFileSync(path.join(folder, "plan-final.md"), PLAN_WITH_CHILDREN);
      await withHandlerStubs("notNow", async (asked, cancelCalls) => {
        await nextStage(vscode.Uri.file(container), makeContext(), makeNode(folder));
        const stale = asked.filter((req) => req.decisionKey === "confirmAdvanceOnStaleReviewV1");
        assert.equal(stale.length, 1);
        assert.match(stale[0]!.whatHappened, /plan-final\.md \(changed \d{4}-/);
        assert.match(stale[0]!.whatHappened, /2 unticked sub-item\(s\)/);
        assert.equal(stale[0]!.recommendedOptionId, "rerunReview");
        assert.ok(stale[0]!.options.some((option) => option.label === "Re-run the review"));
        assert.equal(cancelCalls(), 0, "Not now cancels nothing");
      });
      const persisted = JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(persisted.currentStage, "impl-low-review", "the task did not move on");
    } finally {
      safeRemoveDir(container);
    }
  });

  void it("the hand-off card's Advance (the blocker-gate bypass) is asked the same question", async () => {
    const { container, folder } = await lowReviewTask();
    try {
      fs.writeFileSync(path.join(folder, "plan-final.md"), PLAN_WITH_CHILDREN);
      await withHandlerStubs("notNow", async (asked) => {
        await completeStageAnywayV1(makeContext(), { taskFolderPath: folder });
        assert.deepEqual(
          asked.map((req) => req.decisionKey),
          ["confirmAdvanceOnStaleReviewV1"]
        );
      });
      const persisted = JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(persisted.currentStage, "impl-low-review");
    } finally {
      safeRemoveDir(container);
    }
  });

  void it("control: children added and ticked before the review raise no stale question", async () => {
    const { container, folder } = await lowReviewTask(
      "- [x] Retire the old bucket policy.\n  - [x] Add the deny-delete fix.\n- [x] Other item.\n"
    );
    try {
      await withHandlerStubs("notNow", async (asked) => {
        await nextStage(vscode.Uri.file(container), makeContext(), makeNode(folder));
        assert.ok(
          !asked.some((req) => req.decisionKey === "confirmAdvanceOnStaleReviewV1"),
          "an unchanged plan is not a stale verdict"
        );
      });
    } finally {
      safeRemoveDir(container);
    }
  });
});
