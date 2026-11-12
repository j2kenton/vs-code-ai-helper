/**
 * bugs7 item 7 (Step 21), owner decision 2026-11-11 (`step-21-host-coverage-rule`: keep the plan, the host hand-offs are
 * covered by automated tests). This runs the PRODUCTION host wrapper `fastForwardAcrossCleanStagesHostV1` with only the
 * provider-facing calls stubbed (the Fast Forward run itself, and the `nextStage` / `runLintingFixes` commands). Stage
 * facts are read from task files in an in-memory store, successor scheduling uses the real automation-chain guards, and
 * the wait uses the real task-operation registry, the real chat writer path (recorded) and the real boundary hook.
 *
 * Covered: an awaited successor and a deferred successor that both carry the invocation into Publish; failed Publish
 * Checks followed by a fix round, its queued Publish review and the boundary; a still-failing fix round; pending work at
 * the wait's limit; pause; task identity; two invocations whose results stay their own; and no Commit & Push dispatch.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  fastForwardAcrossCleanStagesHostV1,
  type FastForwardEndReportV1,
  type FastForwardHostSeamsV1,
} from "../commands/reviewActions";
import { __setAutomationChainGuardForTestV1, releaseAutomationChain, resetAutomationChainGuards } from "../utils/automationChain";
import { __resetFastForwardRunsForTestV1 } from "../utils/activeFastForwardRunsV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import type { TaskProgress, TaskStage } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

/* eslint-disable @typescript-eslint/no-var-requires */
const cardModule = require("../commands/automationStoppedCardV1") as Record<string, unknown>;
const chatModule = require("../utils/chatHistoryStore") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-host-handoff-"));
after(() => {
  safeRemoveDir(ROOT);
});

const CLEAN_REVIEW = "Readiness: 9/10\n\nNo blockers.\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";
const FAR_FUTURE = (): number => Date.now() + 60 * 60 * 1000;
const FAST_SEAMS = { waitPollMs: 5, successorGraceMs: 40, waitLimitMs: 400 } as const;

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): () => void {
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
  fsObj.stat = (uri: vscode.Uri): Promise<{ type: number; ctime: number; mtime: number; size: number }> =>
    store.has(uri.toString())
      ? Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: store.get(uri.toString())?.length ?? 0 })
      : Promise.reject(Object.assign(new Error("ENOENT"), { code: "FileNotFound" }));
  fsObj.createDirectory = (): Promise<void> => Promise.resolve();
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
  return () => {
    Object.assign(fsObj, orig);
  };
}

class Surface {
  addEntry(): void {
    /* not under test */
  }
}

/** One task folder on the in-memory store, with helpers that move it the way the real commands do. */
class TaskFixture {
  readonly folderPath: string;
  private readonly uri: vscode.Uri;
  constructor(private readonly store: MemStore, readonly name: string, stage: TaskStage) {
    this.folderPath = path.join(ROOT, ".ensemble", name);
    this.uri = vscode.Uri.file(this.folderPath);
    this.setStage(stage);
    for (const review of ["impl-high-review.md", "impl-low-review.md", "publish-review.md"]) {
      this.write(review, CLEAN_REVIEW);
    }
    this.write("plan-final.md", "# Plan\n\nNo checklist.\n");
  }
  private file(name: string): string {
    return vscode.Uri.joinPath(this.uri, name).toString();
  }
  write(name: string, text: string): void {
    this.store.set(this.file(name), text);
  }
  progress(): TaskProgress {
    return JSON.parse(this.store.get(this.file("task-progress.json")) ?? "{}") as TaskProgress;
  }
  patch(change: Partial<TaskProgress>): void {
    const next = { ...this.progress(), ...change, updatedAt: new Date().toISOString() };
    this.write("task-progress.json", JSON.stringify(next, null, 2));
  }
  setStage(stage: TaskStage, status: TaskProgress["status"] = "active"): void {
    this.patch({
      taskFolder: this.name,
      currentStage: stage,
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      reviewAttemptId: `attempt-${this.name}`,
    });
  }
  setLint(passed: boolean): void {
    this.patch({ lintPayload: { runAt: new Date().toISOString(), passed } });
  }
}

interface Harness {
  readonly commands: string[];
  readonly chat: string[];
  readonly readyCards: number[];
  readonly runs: string[];
}

let counter = 0;

async function withHost<T>(body: (make: (stage: TaskStage) => TaskFixture, h: Harness) => Promise<T>): Promise<T> {
  const store: MemStore = new Map();
  const restoreFs = installMemStore(store);
  initNotificationRouter(new Surface());
  const h: Harness = { commands: [], chat: [], readyCards: [], runs: [] };
  const saved = { ready: cardModule.postStageReadyCardIfReadyV1, chat: chatModule.appendChatMessageV1 };
  cardModule.postStageReadyCardIfReadyV1 = (folder: string): Promise<undefined> => {
    h.readyCards.push(folder.length);
    return Promise.resolve(undefined);
  };
  chatModule.appendChatMessageV1 = (_folder: string, message: { text: string }): Promise<undefined> => {
    h.chat.push(message.text);
    return Promise.resolve(undefined);
  };
  try {
    return await body((stage) => {
      counter += 1;
      return new TaskFixture(store, `host-handoff-${counter}`, stage);
    }, h);
  } finally {
    cardModule.postStageReadyCardIfReadyV1 = saved.ready;
    chatModule.appendChatMessageV1 = saved.chat;
    deactivateNotificationRouter();
    restoreFs();
  }
}

/** A Fast Forward run that ends clean on whatever stage the task is on, reported to its own invocation. */
function cleanRun(task: TaskFixture, h: Harness, onRun?: (stage: TaskStage) => void): NonNullable<FastForwardHostSeamsV1["runFastForward"]> {
  return (_arg, endReport: FastForwardEndReportV1) => {
    const stage = task.progress().currentStage;
    h.runs.push(`${task.name}:${stage}`);
    onRun?.(stage);
    endReport({ folderPath: task.folderPath, stage, movedOn: false });
    return Promise.resolve();
  };
}

function invoke(task: TaskFixture, seams: FastForwardHostSeamsV1): Promise<void> {
  return fastForwardAcrossCleanStagesHostV1({} as vscode.ExtensionContext, { taskFolderPath: task.folderPath } as never, undefined, {
    ...FAST_SEAMS,
    ...seams,
  });
}

void describe("the production Fast Forward host wrapper hands off through successors and Publish (bugs7 Step 21)", () => {
  beforeEach(() => {
    __resetFastForwardRunsForTestV1();
    resetAutomationChainGuards();
  });
  afterEach(() => {
    __resetFastForwardRunsForTestV1();
    resetAutomationChainGuards();
  });

  void it("an awaited successor review that moves the task on to Publish continues there and stops at the Commit & Push boundary", async () => {
    await withHost(async (make, h) => {
      const task = make("impl-high-review");
      await invoke(task, {
        runFastForward: cleanRun(task, h),
        executeCommand: (command) => {
          h.commands.push(command);
          // The move lands on Low-Level, and the review it starts (awaited) is clean and moves on to Publish.
          task.setStage("impl-low-review");
          task.setStage("publish");
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.runs, [`${task.name}:impl-high-review`, `${task.name}:publish`]);
      assert.deepEqual(h.commands, ["vs-code-ai-helper.nextStage"]);
      assert.ok(h.chat.some((line) => /Commit & Push is next, and it stays your click/.test(line)), JSON.stringify(h.chat));
      assert.equal(h.readyCards.length, 1, "the boundary raises the done card once");
    });
  });

  void it("a deferred successor review (its chain guard held after the move) is waited for, then the invocation continues in Publish", async () => {
    await withHost(async (make, h) => {
      const task = make("impl-high-review");
      const observedWhileHeld: string[] = [];
      await invoke(task, {
        runFastForward: cleanRun(task, h, (stage) => observedWhileHeld.push(stage)),
        executeCommand: (command) => {
          h.commands.push(command);
          task.setStage("impl-low-review");
          // The queued successor review: its guard is held now, and it finishes (and moves on) a little later.
          __setAutomationChainGuardForTestV1(task.folderPath, "auto-review", FAR_FUTURE());
          setTimeout(() => {
            task.setStage("publish");
            releaseAutomationChain(task.folderPath, "auto-review");
          }, 15);
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.runs, [`${task.name}:impl-high-review`, `${task.name}:publish`]);
      assert.ok(h.chat.some((line) => /Commit & Push is next/.test(line)));
    });
  });

  void it("failed Publish Checks run a fix round, wait for the Publish review it queues, then reach the boundary; Commit & Push is never dispatched", async () => {
    await withHost(async (make, h) => {
      const task = make("publish");
      let first = true;
      await invoke(task, {
        runFastForward: (_arg, endReport) => {
          h.runs.push(`${task.name}:publish`);
          if (first) {
            first = false;
            endReport({ folderPath: task.folderPath, stage: "publish", movedOn: false, publishChecksFailed: true });
          } else {
            endReport({ folderPath: task.folderPath, stage: "publish", movedOn: false });
          }
          return Promise.resolve();
        },
        executeCommand: (command) => {
          h.commands.push(command);
          task.setLint(true);
          // The fix round queues the Publish review behind itself; it is still pending when the command returns.
          __setAutomationChainGuardForTestV1(task.folderPath, "publish-review-after-fix", FAR_FUTURE());
          setTimeout(() => releaseAutomationChain(task.folderPath, "publish-review-after-fix"), 15);
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.commands, ["vs-code-ai-helper.runLintingFixes"]);
      assert.equal(h.runs.length, 2, "Fast Forward ran again after the fix round and its review");
      assert.ok(h.chat.some((line) => /Publish Checks failed\. Running fix round 1 of 2/.test(line)));
      assert.ok(h.chat.some((line) => /Commit & Push is next, and it stays your click/.test(line)));
      assert.ok(!h.commands.some((command) => /commit|push/i.test(command)));
    });
  });

  void it("a fix round that leaves the checks failing hands back: no second run, no boundary line", async () => {
    await withHost(async (make, h) => {
      const task = make("publish");
      await invoke(task, {
        runFastForward: (_arg, endReport) => {
          h.runs.push("publish");
          endReport({ folderPath: task.folderPath, stage: "publish", movedOn: false, publishChecksFailed: true });
          return Promise.resolve();
        },
        executeCommand: (command) => {
          h.commands.push(command);
          task.setLint(false);
          return Promise.resolve(undefined);
        },
      });
      assert.equal(h.runs.length, 1);
      assert.ok(!h.chat.some((line) => /Commit & Push is next/.test(line)));
      assert.equal(h.readyCards.length, 0);
    });
  });

  void it("successor work still pending at the wait's limit hands back: no run starts on top of it and the boundary is not reached", async () => {
    await withHost(async (make, h) => {
      const task = make("impl-high-review");
      await invoke(task, {
        waitLimitMs: 80,
        runFastForward: cleanRun(task, h),
        executeCommand: (command) => {
          h.commands.push(command);
          task.setStage("impl-low-review");
          __setAutomationChainGuardForTestV1(task.folderPath, "auto-review", FAR_FUTURE());
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.runs, [`${task.name}:impl-high-review`]);
      assert.ok(!h.chat.some((line) => /Commit & Push is next/.test(line)));
    });
  });

  void it("a task the owner paused during the hand-off is not carried on", async () => {
    await withHost(async (make, h) => {
      const task = make("impl-high-review");
      await invoke(task, {
        runFastForward: cleanRun(task, h),
        executeCommand: (command) => {
          h.commands.push(command);
          task.setStage("impl-low-review", "paused");
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.runs, [`${task.name}:impl-high-review`]);
      assert.equal(h.readyCards.length, 0);
    });
  });

  void it("a run that reports another task's end is ignored: this invocation continues nothing (task identity)", async () => {
    await withHost(async (make, h) => {
      const task = make("impl-high-review");
      const other = make("impl-high-review");
      await invoke(task, {
        runFastForward: (_arg, endReport) => {
          h.runs.push("run");
          endReport({ folderPath: other.folderPath, stage: "impl-high-review", movedOn: false });
          return Promise.resolve();
        },
        executeCommand: (command) => {
          h.commands.push(command);
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.commands, []);
      assert.equal(h.runs.length, 1);
    });
  });

  void it("a run cancelled before it reported an end (no report) continues nothing", async () => {
    await withHost(async (make, h) => {
      const task = make("impl-high-review");
      await invoke(task, {
        runFastForward: () => {
          h.runs.push("cancelled");
          return Promise.resolve();
        },
        executeCommand: (command) => {
          h.commands.push(command);
          return Promise.resolve(undefined);
        },
      });
      assert.deepEqual(h.commands, []);
      assert.deepEqual(h.runs, ["cancelled"]);
    });
  });

  void it("two invocations on two tasks keep their results apart: each moves only its own task and ends at its own boundary", async () => {
    await withHost(async (make, h) => {
      const a = make("impl-low-review");
      const b = make("impl-high-review");
      const moves: string[] = [];
      const seamsFor = (task: TaskFixture): FastForwardHostSeamsV1 => ({
        runFastForward: cleanRun(task, h),
        executeCommand: (command, ...args) => {
          const folder = (args[0] as { taskFolderPath: string }).taskFolderPath;
          moves.push(`${command}:${path.basename(folder)}`);
          const target = task.progress().currentStage === "impl-low-review" ? "publish" : "impl-low-review";
          task.setStage(target);
          return Promise.resolve(undefined);
        },
      });
      await Promise.all([invoke(a, seamsFor(a)), invoke(b, seamsFor(b))]);
      assert.ok(moves.includes(`vs-code-ai-helper.nextStage:${a.name}`));
      assert.ok(moves.includes(`vs-code-ai-helper.nextStage:${b.name}`));
      assert.equal(a.progress().currentStage, "publish");
      assert.equal(b.progress().currentStage, "publish");
      assert.equal(h.runs.filter((run) => run.startsWith(`${a.name}:`)).length, 2);
      assert.equal(h.runs.filter((run) => run.startsWith(`${b.name}:`)).length, 3);
      assert.equal(h.readyCards.length, 2, "one boundary card per task");
    });
  });
});
