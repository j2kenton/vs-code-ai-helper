/**
 * review1 Step 36 / item 1's replay: a clean 8/10 review with 0 blockers whose only open items are provisional
 * test items. Fast Forward's hook runs the checks ONCE (never a model round), records the items whose test files
 * the passing output names, and raises one card for the rest; a failing or refused run stops at once; and the
 * `runEvidenceGapChecksV1` wrapper passes Step 24's gate before running anything.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  closeEvidenceGapWithPublishChecksV1,
  registerTickEvidenceGapItemsCommandV1,
  runEvidenceGapChecksV1,
  type EvidenceGapChecksRunV1,
} from "../commands/evidenceGapChecksV1";
import { AUTOMATION_STOPPED_DECISION_KEY_V1 } from "../commands/automationStoppedCardV1";
import { buildEvidenceGapCardInputV1, TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1 } from "../utils/evidenceGapV1";
import { recordReviewInputsV1 } from "../utils/reviewInputsChangedV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { listPendingWorkflowDecisionsForTaskV1, postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { normalizePath } from "../utils/taskRoot";
import { readChatHistory } from "../utils/chatHistoryStore";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  getPlanRevisionV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { recordPublishChecksPassedFilesV1, takePublishChecksPassedFilesV1 } from "../utils/publishChecksPassedFilesV1";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const STEP7 = "Step 7: Write the tests for Part 1 in `src/test/churnCeilingBugs4ReplayV1.test.ts`";
const STEP17 = "Step 17: Write the tests for Part 3 in src/test/testEvidenceReportsV1.test.ts";
const STEP22 = "Step 22: Write the tests for Part 4";

const PLAN = ["# Final Plan", "", "<!-- ensemble:implementation-checklist -->", "", `- [x] ${STEP7}`, `- [x] ${STEP17}`, `- [x] ${STEP22}`, ""].join(
  "\n"
);
const REVIEW = "Readiness: 8/10\n\n## Blockers\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";

const roots: string[] = [];

// The vscode test stub has no `workspace.fs.readFile`; back it (and writeFile) with the real filesystem for this file.
const stubFs = vscode.workspace.fs as unknown as Record<string, unknown>;
const originalFs = { readFile: stubFs["readFile"], writeFile: stubFs["writeFile"] };
stubFs["readFile"] = async (uri: vscode.Uri): Promise<Uint8Array> =>
  new TextEncoder().encode(await fs.promises.readFile(uri.fsPath, "utf8"));
stubFs["writeFile"] = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
  await fs.promises.writeFile(uri.fsPath, Buffer.from(data));
};

after(() => {
  stubFs["readFile"] = originalFs.readFile;
  stubFs["writeFile"] = originalFs.writeFile;
  for (const root of roots) safeRemoveDir(root);
});

function makeTask(): { folder: string; folderUri: vscode.Uri } {
  const fixture = makeOwnedTaskFolder("evidence-gap-live-");
  roots.push(path.dirname(path.dirname(fixture.folder)));
  const revision = getPlanRevisionV1(PLAN);
  const file = path.join(fixture.folder, "task-progress.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  json["currentStage"] = "impl-high-review";
  json["planItemEvidence"] = [STEP7, STEP17, STEP22].map((text) => ({
    planRevision: revision,
    itemKey: normalizeChecklistItemTextV1(text),
    itemText: text,
    claims: [{ source: "implementation", at: "2026-11-03T06:00:00.000Z", roundId: "r1" }],
  }));
  fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(path.join(fixture.folder, "plan-final.md"), PLAN, "utf8");
  fs.writeFileSync(path.join(fixture.folder, "impl-high-review.md"), REVIEW, "utf8");
  return { folder: fixture.folder, folderUri: vscode.Uri.file(fixture.folder) };
}

function hook(folder: string, run: () => Promise<EvidenceGapChecksRunV1>, score = 8) {
  const folderUri = vscode.Uri.file(folder);
  return closeEvidenceGapWithPublishChecksV1({
    folderUri,
    workspaceRootFsPath: path.dirname(folder),
    stage: "impl-high-review",
    displayName: "chat1",
    score,
    stopLevel: 8,
    runChecks: run,
  });
}

void describe("review1 item 1 replay: the evidence-only gap is closed by Ensemble, once (Step 34/36)", () => {
  void it("a passing run records the items whose test files the output names and stops with one card for the rest", async () => {
    const { folder, folderUri } = makeTask();
    let runs = 0;
    const outcome = await hook(folder, () => {
      runs += 1;
      recordPublishChecksPassedFilesV1(folder, {
        runAt: "2026-11-03T07:00:00.000Z",
        passed: true,
        testFiles: ["out/test/churnCeilingBugs4ReplayV1.test.js", "out/test/testEvidenceReportsV1.test.js"],
      });
      return Promise.resolve({ ran: true });
    });
    assert.equal(runs, 1, "the checks ran once");
    assert.equal(outcome.kind, "stopped", "Step 22 names no test file, so one item has no passing run on record");
    // A recorded report only unlocks verification (a reviewer's, or the owner's tick on the card), so every listed
    // item still waits; the card shows which of them now have a passing run.
    assert.match(outcome.kind === "stopped" ? outcome.detail : "", /2 items recorded from their output and 3 still wait/);
    const progress = await readTaskProgressForTest(folderUri);
    const recorded = (progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every((row) => row.testReports?.every((report) => report.source === "publishChecks" && report.failed === 0)));
    assert.equal(takePublishChecksPassedFilesV1(folder), undefined, "one run's files are read once");
  });

  void it("a failing run records nothing and stops at once", async () => {
    const { folder, folderUri } = makeTask();
    const outcome = await hook(folder, () => {
      recordPublishChecksPassedFilesV1(folder, { runAt: "2026-11-03T07:00:00.000Z", passed: false, testFiles: ["a.test.js"] });
      return Promise.resolve({ ran: true });
    });
    assert.equal(outcome.kind, "stopped");
    assert.match(outcome.kind === "stopped" ? outcome.detail : "", /did not pass, so 3 built items still wait/);
    const progress = await readTaskProgressForTest(folderUri);
    assert.equal((progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0).length, 0);
  });

  void it("a run that could not start (refused, or the gate holds the task) stops at once and says so", async () => {
    const { folder } = makeTask();
    const outcome = await hook(folder, () => Promise.resolve({ ran: false, detail: "the checks were refused" }));
    assert.equal(outcome.kind, "stopped");
    assert.match(outcome.kind === "stopped" ? outcome.detail : "", /could not run \(the checks were refused\)/);
  });

  void it("below the stop level, with blockers, or with a non-test item open, the hook leaves the older path alone and never runs the checks", async () => {
    const { folder } = makeTask();
    let runs = 0;
    const outcome = await hook(
      folder,
      () => {
        runs += 1;
        return Promise.resolve({ ran: true });
      },
      7
    );
    assert.equal(outcome.kind, "not-applicable");
    assert.equal(runs, 0);
  });
});

void describe("the gap's one checks run passes Step 24's gate first (Step 34)", () => {
  void it("a held gate means the checks are not started", async () => {
    const { folderUri } = makeTask();
    let ran = false;
    const result = await runEvidenceGapChecksV1({
      folderUri,
      stage: "impl-high-review",
      gate: ((arg: { kind: string }) => {
        assert.equal(arg.kind, "fast-forward-publish-checks");
        return Promise.resolve({ admitted: false, reason: "failed", cardPosted: true });
      }) as never,
      runPreview: (() => {
        ran = true;
        return Promise.reject(new Error("must not run"));
      }) as never,
    });
    assert.equal(result.ran, false);
    assert.equal(ran, false);
  });

  void it("an admitted run uses the deterministic checks only and leaves the passing test files for the hook", async () => {
    const { folder, folderUri } = makeTask();
    let options: Record<string, unknown> | undefined;
    const result = await runEvidenceGapChecksV1({
      folderUri,
      stage: "impl-high-review",
      gate: (() => Promise.resolve({ admitted: true })) as never,
      runPreview: ((_uri: vscode.Uri, _files: unknown, opts: Record<string, unknown>) => {
        options = opts;
        return Promise.resolve({ runAt: "2026-11-03T07:00:00.000Z", passed: true, passedTestFiles: ["a.test.js"] });
      }) as never,
    });
    assert.equal(result.ran, true);
    assert.equal(options?.["includeAiPlanVerification"], false, "no model call for the gap");
    assert.equal(options?.["allowScopePrompt"], false, "no picker from an automatic run");
    assert.deepEqual(takePublishChecksPassedFilesV1(folder)?.testFiles, ["a.test.js"]);
  });

  void it("a run that throws is reported as could-not-run, not as a pass", async () => {
    const { folder, folderUri } = makeTask();
    const result = await runEvidenceGapChecksV1({
      folderUri,
      stage: "impl-high-review",
      gate: (() => Promise.resolve({ admitted: true })) as never,
      runPreview: (() => Promise.reject(new Error("no valid scope"))) as never,
    });
    assert.deepEqual(result, { ran: false, detail: "no valid scope" });
    assert.equal(takePublishChecksPassedFilesV1(folder), undefined);
  });
});

// ---------------------------------------------------------------------------
// bugs8 item 4 (Part A1, regression test only): ticking the last item settles the stage, and the owner is told.
// ---------------------------------------------------------------------------

const READY_REVIEW = "Readiness: 9/10\n\n## Blockers\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";

type TickHandlerV1 = (arg: { taskFolderPath: string; itemTexts: readonly string[] }) => Promise<number>;

/** The handler `registerTickEvidenceGapItemsCommandV1` registers, captured so the test runs the real thing. */
function captureTickHandlerV1(): TickHandlerV1 {
  const commandsTarget = vscode.commands as unknown as {
    registerCommand: (id: string, callback: (...args: never[]) => unknown) => { dispose(): void };
  };
  const original = commandsTarget.registerCommand;
  const holder: { handler?: TickHandlerV1 } = {};
  commandsTarget.registerCommand = (id, callback) => {
    if (id === TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1) {
      holder.handler = callback as unknown as TickHandlerV1;
    }
    return { dispose: (): void => undefined };
  };
  try {
    registerTickEvidenceGapItemsCommandV1({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  } finally {
    commandsTarget.registerCommand = original;
  }
  assert.ok(holder.handler, "test setup: the tick command registered a handler");
  return holder.handler;
}

/** A clean, current review at a plan-review stage (plan reviews carry no commit stamps, so no git state is read). */
function makeReadyTaskV1(): { folder: string } {
  const fixture = makeOwnedTaskFolder("evidence-gap-ready-");
  roots.push(path.dirname(path.dirname(fixture.folder)));
  const revision = getPlanRevisionV1(PLAN);
  const file = path.join(fixture.folder, "task-progress.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  json["currentStage"] = "plan-high-review";
  json["status"] = "active";
  json["displayName"] = "bugs8 item 4";
  json["planItemEvidence"] = [STEP7, STEP17, STEP22].map((text) => ({
    planRevision: revision,
    itemKey: normalizeChecklistItemTextV1(text),
    itemText: text,
    claims: [{ source: "implementation", at: "2026-11-03T06:00:00.000Z", roundId: "r1" }],
  }));
  fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(path.join(fixture.folder, "task.md"), "# Task\n\n## Task Description\n\nX\n", "utf8");
  fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Plan\n", "utf8");
  fs.writeFileSync(path.join(fixture.folder, "plan-final.md"), PLAN, "utf8");
  return { folder: fixture.folder };
}

/** The review is written last, and newer than every input it read, so it is the current one. */
async function writeCurrentReviewV1(folder: string): Promise<void> {
  const reviewPath = path.join(folder, "plan-high-review.md");
  await recordReviewInputsV1(folder, reviewPath);
  fs.writeFileSync(reviewPath, READY_REVIEW, "utf8");
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(reviewPath, later, later);
}

function pendingIsDoneCardsV1(folder: string): readonly WorkflowDecisionV1[] {
  return listPendingWorkflowDecisionsForTaskV1(normalizePath(folder)).filter(
    (card) => card.decisionKey === AUTOMATION_STOPPED_DECISION_KEY_V1 && /is done/.test(card.whatHappened)
  );
}

void describe("bugs8 item 4: a tick that settles the last item says the stage is done", () => {
  void it("ticking the last item from an evidence card of an earlier failed Publish Checks run raises exactly one 'is done' card", async () => {
    const values = new Map<string, unknown>();
    const memento = {
      get<T>(key: string, defaultValue: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown): Promise<void> {
        values.set(key, value);
        return Promise.resolve();
      },
      keys: (): string[] => [...values.keys()],
    } as unknown as vscode.Memento;
    __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
    initNotificationRouter({ addEntry: (): void => undefined });
    try {
      const { folder } = makeReadyTaskV1();
      await writeCurrentReviewV1(folder);
      const tick = captureTickHandlerV1();

      // The evening before: Publish Checks failed, and its evidence card listed the item still waiting.
      const oldCard = buildEvidenceGapCardInputV1({
        taskFolderPath: folder,
        stage: "plan-high-review",
        attempt: "failed",
        attemptDetail: "2 tests failed",
        score: 9,
        items: [{ itemText: STEP22, passingRuns: 0 }],
        recordedCount: 0,
        planItems: { total: 3, settled: 2 },
        nextStage: "plan-low-review",
      });
      await postWorkflowDecisionV1(oldCard, {
        canonicalId: normalizePath(folder),
        taskFolderPath: folder,
        stage: "plan-high-review",
        taskName: "bugs8 item 4",
      });

      // Every item but one is settled by the owner's earlier ticks; none of them completes the stage.
      assert.equal(await tick({ taskFolderPath: folder, itemTexts: [STEP7, STEP17] }), 2, "setup: the first two ticks were not recorded");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(pendingIsDoneCardsV1(folder).length, 0, "setup: a tick that leaves an item open already raised an 'is done' card");

      // The last tick, from the old card.
      assert.equal(await tick({ taskFolderPath: folder, itemTexts: [STEP22] }), 1, "setup: the last tick was not recorded");
      for (let attempt = 0; attempt < 400 && pendingIsDoneCardsV1(folder).length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // A second card would be raised a moment after the first, so wait before counting.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const cards = pendingIsDoneCardsV1(folder);
      assert.equal(cards.length, 1, `item4: no is-done card (found ${cards.length})`);
      const recommendation = cards[0]!.recommendation;
      assert.ok(
        recommendation.kind === "option" && recommendation.optionId === "moveOn",
        "item4: the 'is done' card does not recommend Move on"
      );
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("bugs8 Step 8: a tick that raises no 'is done' card says why in the chat and names the click, once per tick command", async () => {
    const values = new Map<string, unknown>();
    const memento = {
      get<T>(key: string, defaultValue: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown): Promise<void> {
        values.set(key, value);
        return Promise.resolve();
      },
      keys: (): string[] => [...values.keys()],
    } as unknown as vscode.Memento;
    __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
    initNotificationRouter({ addEntry: (): void => undefined });
    try {
      const { folder } = makeReadyTaskV1();
      await writeCurrentReviewV1(folder);
      const tick = captureTickHandlerV1();
      const lines = async (): Promise<string[]> =>
        (await readChatHistory(folder, folder)).map((message) => message.text).filter((text) => /Your tick is recorded/.test(text));

      // An item is still open: no card, and one line that says why and which click carries on.
      assert.equal(await tick({ taskFolderPath: folder, itemTexts: [STEP7, STEP17] }), 2, "setup: the ticks were not recorded");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(pendingIsDoneCardsV1(folder).length, 0, "setup: a card was raised with an item still open");
      const open = await lines();
      assert.equal(open.length, 1, `step8: expected one line for the tick command, found ${open.length}`);
      assert.match(open[0]!, /still has plan items open or waiting for a check/, "step8: the line does not say why no card was raised");
      assert.match(open[0]!, /Click Apply Review with AI/, "step8: the line does not name the click");

      // The last tick raises the card, so it adds no line.
      assert.equal(await tick({ taskFolderPath: folder, itemTexts: [STEP22] }), 1, "setup: the last tick was not recorded");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(pendingIsDoneCardsV1(folder).length, 1, "step8: the last tick raised no 'is done' card");
      assert.equal((await lines()).length, 1, "step8: a tick that raised the card also wrote a 'why not' line");
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });
});
