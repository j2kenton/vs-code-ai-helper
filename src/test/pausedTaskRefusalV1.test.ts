/**
 * A stage action refused because the task is paused. RC9 item 3: the owner's
 * own click gets an informational notice naming the task by its display name
 * (Resume is an optional chat offer); an automatic dispatch is only logged.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { runAsAutomationDispatchV1, runWithAutomaticOriginV1 } from "../state/automationDispatchContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { TaskProgress } from "../types/taskProgress";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
  type StatusSurface,
} from "../utils/notificationRouter";
import { showPausedTaskRefusalV1 } from "../utils/pausedTaskRefusalV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-paused-refusal-"));
after(() => {
  safeRemoveDir(ROOT);
});

function makeTask(folderName: string, displayName: string): string {
  const dir = path.join(ROOT, folderName);
  fs.mkdirSync(dir, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: folderName,
    displayName,
    currentStage: "impl-high-review",
    status: "paused",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ownership: fixtureOwnershipFor(dir),
  };
  fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return dir;
}

function makeMemento(): vscode.Memento {
  const backing = new Map<string, unknown>();
  return {
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
  } as vscode.Memento;
}

interface Harness {
  entries: { message: string; level: string }[];
  memento: vscode.Memento;
  run(body: () => Promise<void>): Promise<void>;
}

function harness(): Harness {
  const entries: { message: string; level: string }[] = [];
  const memento = makeMemento();
  const surface: StatusSurface = {
    addEntry: (message, level): void => {
      entries.push({ message, level });
    },
  };
  return {
    entries,
    memento,
    async run(body): Promise<void> {
      const target = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalRead = target.readFile;
      target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
        fs.promises.readFile(uri.fsPath).then((buffer) => new Uint8Array(buffer));
      __extensionContextV1TestOnly.set({
        subscriptions: [],
        extensionUri: vscode.Uri.file(ROOT),
        workspaceState: memento,
        globalState: memento,
      } as unknown as vscode.ExtensionContext);
      initNotificationRouter(surface);
      try {
        await body();
      } finally {
        deactivateNotificationRouter();
        __extensionContextV1TestOnly.reset();
        target.readFile = originalRead;
      }
    },
  };
}

const pendingOffers = (memento: vscode.Memento): number =>
  new WorkflowDecisionStoreV1(memento).listPending().filter((d) => d.decisionKey.startsWith("chatActionOffer:")).length;

void describe("showPausedTaskRefusalV1 (RC9 item 3)", () => {
  void it("owner path: an info notice naming the task by its display name, plus an optional Resume offer", async () => {
    const dir = makeTask("2026-10-03_task_1", "rc8");
    const h = harness();
    await h.run(() => showPausedTaskRefusalV1("running a review", dir));
    const paused = h.entries.filter((e) => /is paused\. Resume it before/.test(e.message));
    // The posted decision may surface its own entry carrying the same text.
    assert.ok(paused.length >= 1);
    assert.ok(paused.some((e) => e.level === "info"));
    for (const entry of paused) {
      assert.match(entry.message, /"rc8" is paused\. Resume it before running a review\./);
      assert.doesNotMatch(entry.message, /Task 1 \(2026-10-03\)/);
    }
    assert.deepEqual(h.entries.filter((e) => e.level === "warning"), []);
    const decision = new WorkflowDecisionStoreV1(h.memento)
      .listPending()
      .find((d) => d.decisionKey === "chatActionOffer:resumeTask");
    assert.equal(decision?.gating?.holdsTaskPaused, false);
    assert.equal(decision?.gating?.unblocksProgress, false);
  });

  void it("owner path with an unreadable task: still an info notice, no offer", async () => {
    const h = harness();
    await h.run(() => showPausedTaskRefusalV1("running a review", "/tmp/plans/task-a"));
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0]?.level, "info");
    assert.match(h.entries[0]?.message ?? "", /"task-a" is paused\. Resume it before running a review\./);
  });

  void it("automatic path: no notice and no decision for { automatic: true }", async () => {
    const dir = makeTask("2026-10-03_task_2", "rc8");
    const h = harness();
    await h.run(() => showPausedTaskRefusalV1("applying a review", dir, undefined, { automatic: true }));
    assert.deepEqual(h.entries, []);
    assert.equal(pendingOffers(h.memento), 0);
  });

  void it("automatic path: no notice and no decision inside an automation dispatch or automatic-origin scope", async () => {
    const dir = makeTask("2026-10-03_task_3", "rc8");
    const h = harness();
    await h.run(() => runAsAutomationDispatchV1(() => showPausedTaskRefusalV1("applying a review", dir)));
    await h.run(() => runWithAutomaticOriginV1(() => showPausedTaskRefusalV1("applying a review", dir)));
    assert.deepEqual(h.entries, []);
    assert.equal(pendingOffers(h.memento), 0);
  });

  void it("no command in src still refuses a paused task with an info message", () => {
    const commandsDir = path.join(__dirname, "..", "..", "src", "commands");
    const offenders: string[] = [];
    for (const name of fs.readdirSync(commandsDir)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const source = fs.readFileSync(path.join(commandsDir, name), "utf8");
      if (/showInformation\(\s*["'`][^"'`]*is paused\. Resume it before/.test(source)) {
        offenders.push(name);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
