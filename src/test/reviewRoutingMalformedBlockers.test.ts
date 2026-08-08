/**
 * Routing-level coverage for plan item "Add a routing-level test asserting
 * the run log write when malformed lines are present" (fail-closed review
 * parsing, step 3): `handleReviewRoutingOutcome` must write a `review-guard`
 * run log naming every unparseable blocker line verbatim, and warn the user
 * with the parsed/malformed counts, without rejecting the round itself.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { handleReviewRoutingOutcome } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { TaskProgress } from "../types/taskProgress";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): void {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsObj.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
  // writeRunLog's ensureRunsDirectory/getNextRunNumber only need these two to
  // not throw — an empty runs/ directory is fine, numbering starts at 1.
  fsObj.createDirectory = (): Promise<void> => Promise.resolve();
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-routing-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolderUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(TEST_ROOT, ".ensemble", name));
}

function seedProgress(store: MemStore, folderUri: vscode.Uri, progress: TaskProgress): void {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  const named: TaskProgress = { ...progress, taskFolder: path.basename(folderUri.fsPath) };
  store.set(uri.toString(), JSON.stringify(named, null, 2));
}

function baseProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

void describe("handleReviewRoutingOutcome — malformed blocker lines (step 3)", () => {
  void it("writes a review-guard run log naming the malformed line and warns, without rejecting the round", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("malformed-blocker-line");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-1" }));

    const content = [
      "Readiness: 5/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] a real, parseable blocker",
      "- this line has no brackets at all and cannot be parsed",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-1",
        content,
        score: 5,
        threshold: 8,
      });
      // Below threshold with a task-fixable blocker still present -> the
      // route is "iterate", which is not an escalation/rejection: the round
      // is recorded and continues normally.
      assert.strictEqual(escalated, false);

      const runsUri = vscode.Uri.joinPath(folderUri, "runs");
      const logKeys = [...store.keys()].filter(
        (k) => k.startsWith(runsUri.toString()) && k.includes("review-guard")
      );
      assert.strictEqual(logKeys.length, 1, "exactly one review-guard run log must be written");
      const logContent = store.get(logKeys[0]!)!;
      assert.match(logContent, /1 blocker\(s\) parsed/);
      assert.match(logContent, /1 line\(s\) could not be parsed/);
      assert.ok(
        logContent.includes("this line has no brackets at all and cannot be parsed"),
        "the run log must name the malformed line verbatim"
      );

      const warning = surface.entries.find(
        (e) => e.level === "warning" && e.message.includes("could not be read")
      );
      assert.ok(warning, "a notification naming the malformed-line count must be shown");
      assert.ok(warning.message.includes("1 blocker(s)"));
      assert.ok(warning.message.includes("1 blocker line(s)"));
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("does not write a review-guard run log when the blocker block is well-formed", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("well-formed-blocker-line");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-2" }));

    const content = [
      "Readiness: 5/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] a real, parseable blocker",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-2",
        content,
        score: 5,
        threshold: 8,
      });

      const runsUri = vscode.Uri.joinPath(folderUri, "runs");
      const logKeys = [...store.keys()].filter(
        (k) => k.startsWith(runsUri.toString()) && k.includes("review-guard")
      );
      assert.strictEqual(logKeys.length, 0, "no review-guard run log should be written for a clean parse");
    } finally {
      deactivateNotificationRouter();
    }
  });
});
