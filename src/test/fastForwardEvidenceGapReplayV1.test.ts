/**
 * review1 Step 36 / item 1's replay, driven through Fast Forward's own loop. A clean review (8/10, 0 blockers)
 * whose only open items are provisional test items must: dispatch no Apply Review (`apply` is never called), run
 * the project's checks once through the real evidence-gap hook, record the items whose test files the passing
 * output names, raise exactly one card for the rest, and make no second automatic attempt. A failing or refused
 * run raises the card at once. `evidenceGapChecksLiveV1.test.ts` covers the hook on its own; this file covers it
 * wired into `improveReviewScore` the way `reviewActions.ts` wires it, and reads the posted card back.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { closeEvidenceGapWithPublishChecksV1, type EvidenceGapChecksRunV1 } from "../commands/evidenceGapChecksV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { EVIDENCE_GAP_DECISION_KEY_V1 } from "../utils/evidenceGapV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { getPlanRevisionV1, normalizeChecklistItemTextV1 } from "../utils/implementationChecklist";
import { recordPublishChecksPassedFilesV1 } from "../utils/publishChecksPassedFilesV1";
import { improveReviewScore, type ReviewRoundOutcome } from "../utils/reviewScoreLoop";
import { normalizePath } from "../utils/taskRoot";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const STEP7 = "Step 7: Write the tests for Part 1 in `src/test/churnCeilingBugs4ReplayV1.test.ts`";
const STEP17 = "Step 17: Write the tests for Part 3 in src/test/testEvidenceReportsV1.test.ts";
const STEP22 = "Step 22: Write the tests for Part 4";

const PLAN = ["# Final Plan", "", "<!-- ensemble:implementation-checklist -->", "", `- [x] ${STEP7}`, `- [x] ${STEP17}`, `- [x] ${STEP22}`, ""].join(
  "\n"
);
const REVIEW = "Readiness: 8/10\n\n## Blockers\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";
/** The review the loop read: clean, at the stop level, and the plan still shows open (provisional) items. */
const CLEAN_WITH_OPEN_ITEMS: ReviewRoundOutcome = { score: 8, taskFixableCount: 0, zeroFixableEvidence: true };

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function makeExtensionContext(): vscode.ExtensionContext {
  const memento = new FakeMemento();
  return {
    workspaceState: memento as unknown as vscode.Memento,
    globalState: memento as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

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
  const fixture = makeOwnedTaskFolder("ff-evidence-gap-replay-");
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

interface FastForwardReplayV1 {
  readonly result: Awaited<ReturnType<typeof improveReviewScore>>;
  readonly applies: number;
  readonly reviews: number;
  readonly checkRuns: number;
  readonly cards: readonly { decisionKey: string; whatHappened: string; options: readonly { optionId: string }[]; recommendation: unknown }[];
  readonly folderUri: vscode.Uri;
}

/** Runs Fast Forward's loop the way `reviewActions.ts` calls it, with the real hook and a stand-in for the checks run. */
async function replayFastForward(runChecks: (folder: string) => Promise<EvidenceGapChecksRunV1>): Promise<FastForwardReplayV1> {
  const context = makeExtensionContext();
  __extensionContextV1TestOnly.set(context);
  const { folder, folderUri } = makeTask();
  let applies = 0;
  let reviews = 0;
  let checkRuns = 0;
  const result = await improveReviewScore({
    context,
    stage: "impl-high-review",
    baselineScore: 8,
    preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
    cleanReviewNeverApplies: true,
    apply: () => {
      applies += 1;
      return Promise.resolve();
    },
    review: () => {
      reviews += 1;
      return Promise.resolve(CLEAN_WITH_OPEN_ITEMS);
    },
    closeEvidenceGap: ({ score }) =>
      closeEvidenceGapWithPublishChecksV1({
        folderUri,
        workspaceRootFsPath: path.dirname(folder),
        stage: "impl-high-review",
        displayName: "chat1",
        score,
        stopLevel: 8,
        runChecks: () => {
          checkRuns += 1;
          return runChecks(folder);
        },
      }),
    maxAttempts: 5,
  });
  const store = new WorkflowDecisionStoreV1(context.workspaceState);
  const cards = store.listPending(normalizePath(folder)).filter((d) => d.decisionKey === EVIDENCE_GAP_DECISION_KEY_V1);
  return { result, applies, reviews, checkRuns, cards, folderUri };
}

void describe("review1 item 1 replay through Fast Forward's loop (Step 36)", () => {
  void it("a passing run: no Apply Review, the checks run once, the named test files are recorded, and one card covers the rest", async () => {
    const replay = await replayFastForward((folder) => {
      recordPublishChecksPassedFilesV1(folder, {
        runAt: "2026-11-03T07:00:00.000Z",
        passed: true,
        testFiles: ["out/test/churnCeilingBugs4ReplayV1.test.js", "out/test/testEvidenceReportsV1.test.js"],
      });
      return Promise.resolve({ ran: true });
    });
    assert.equal(replay.applies, 0, "no Apply Review was dispatched for the gap");
    assert.equal(replay.reviews, 0, "no further review round either");
    assert.equal(replay.checkRuns, 1, "the checks ran once");
    assert.equal(replay.result.held?.kind, "evidence-gap");
    assert.match(replay.result.held?.detail ?? "", /Publish Checks passed once; 2 items recorded from their output and 3 still wait/);
    assert.equal(replay.result.attempts, 0, "the run ended before any editing attempt");

    const progress = await readTaskProgressForTest(replay.folderUri);
    const recorded = (progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0);
    assert.equal(recorded.length, 2, "only the items whose test files the output names were recorded");
    assert.ok(recorded.every((row) => row.testReports?.every((report) => report.source === "publishChecks")));

    assert.equal(replay.cards.length, 1, "exactly one card");
    const card = replay.cards[0]!;
    assert.match(card.whatHappened, /the review is clean \(8\/10\) and only test evidence is missing/);
    assert.match(card.whatHappened, /No editing round was dispatched for it/);
    // The card lists its recommended option first, so compare the set, not the order.
    assert.deepEqual(card.options.map((option) => option.optionId).sort(), ["moveOn", "recordRun", "runChecksAgain", "tickThese"]);
    // Step 22 names no test file, so not every listed item has a passing run: ticking is not the recommendation.
    assert.deepEqual((card.recommendation as { optionId?: string }).optionId, "recordRun");
  });

  void it("a failing run raises the card at once, records nothing, and recommends recording a run", async () => {
    const replay = await replayFastForward((folder) => {
      recordPublishChecksPassedFilesV1(folder, { runAt: "2026-11-03T07:00:00.000Z", passed: false, testFiles: ["a.test.js"] });
      return Promise.resolve({ ran: true });
    });
    assert.equal(replay.applies, 0);
    assert.equal(replay.checkRuns, 1);
    assert.equal(replay.result.held?.kind, "evidence-gap");
    assert.match(replay.result.held?.detail ?? "", /ran once and did not pass/);
    assert.equal(replay.cards.length, 1);
    assert.match(replay.cards[0]!.whatHappened, /ran once and failed/);
    const progress = await readTaskProgressForTest(replay.folderUri);
    assert.equal((progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0).length, 0);
  });

  void it("a refused run raises the card at once and recommends running the checks again; still no second attempt", async () => {
    const replay = await replayFastForward(() => Promise.resolve({ ran: false, detail: "the checks were refused" }));
    assert.equal(replay.applies, 0);
    assert.equal(replay.checkRuns, 1, "a refused run is not retried inside the same Fast Forward run");
    assert.equal(replay.result.held?.kind, "evidence-gap");
    assert.match(replay.result.held?.detail ?? "", /could not run \(the checks were refused\)/);
    assert.equal(replay.cards.length, 1);
    assert.match(replay.cards[0]!.whatHappened, /could not run: the checks were refused/);
    assert.deepEqual((replay.cards[0]!.recommendation as { optionId?: string }).optionId, "runChecksAgain");
  });
});
