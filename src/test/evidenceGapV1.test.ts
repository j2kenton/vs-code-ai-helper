/**
 * review1 Step 34: the evidence-only gap. A clean review whose only open items are provisional test items is
 * closed by one Publish Checks attempt, never by an Apply Review. Covers the pure decisions (gap detection, matching
 * the passing output to each item's test files, the recommendation), the card, the once-per-run loop hook and the
 * per-task holder of the passing output's test files.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import {
  buildEvidenceGapCardInputV1,
  extractPassedTestFilesFromOutputV1,
  identifyItemTestFilesV1,
  isEvidenceOnlyGapV1,
  matchPassedOutputToItemsV1,
  recommendEvidenceGapOptionV1,
  TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1,
  type EvidenceGapCardFactsV1,
} from "../utils/evidenceGapV1";
import { describeFastForwardHoldV1 } from "../utils/fastForwardHoldV1";
import {
  clearPublishChecksPassedFilesV1,
  recordPublishChecksPassedFilesV1,
  takePublishChecksPassedFilesV1,
} from "../utils/publishChecksPassedFilesV1";
import { improveReviewScore, type ReviewRoundOutcome } from "../utils/reviewScoreLoop";

const STEP7 = "Step 7: Write the tests for Part 1 in `src/test/churnCeilingBugs4ReplayV1.test.ts`";
const STEP17 = "Step 17: Write the tests for Part 3 in src/test/testEvidenceReportsV1.test.ts";
const STEP22 = "Step 22: Write the tests for Part 4";

void describe("is the open work only test evidence? (Step 34)", () => {
  const provisional = [{ text: STEP7, testDependent: true }];
  void it("is a gap at the stop level with no blockers and only provisional test items", () => {
    assert.equal(isEvidenceOnlyGapV1({ score: 8, stopLevel: 8, blockerCount: 0, uncheckedCount: 0, provisional }), true);
  });
  void it("is not a gap below the stop level, with blockers, with unbuilt items, or with a non-test item left", () => {
    const base = { score: 8, stopLevel: 8, blockerCount: 0, uncheckedCount: 0, provisional };
    assert.equal(isEvidenceOnlyGapV1({ ...base, score: 7 }), false);
    assert.equal(isEvidenceOnlyGapV1({ ...base, blockerCount: 1 }), false);
    assert.equal(isEvidenceOnlyGapV1({ ...base, blockerCount: null }), false);
    assert.equal(isEvidenceOnlyGapV1({ ...base, uncheckedCount: 2 }), false);
    assert.equal(isEvidenceOnlyGapV1({ ...base, provisional: [...provisional, { text: "Update the README", testDependent: false }] }), false);
    assert.equal(isEvidenceOnlyGapV1({ ...base, provisional: [] }), false);
  });
});

void describe("matching Publish Checks output to the test files an item names (Step 34)", () => {
  void it("takes the test files from the item's text, else from its rejected reports' commands", () => {
    assert.deepEqual(identifyItemTestFilesV1(STEP7, []), ["src/test/churnCeilingBugs4ReplayV1.test.ts"]);
    assert.deepEqual(identifyItemTestFilesV1("Write the tests for Part 2", ["node --test out/test/planItemCountsV1.test.js"]), [
      "out/test/planItemCountsV1.test.js",
    ]);
    assert.deepEqual(identifyItemTestFilesV1("Write the tests for Part 2", []), []);
  });

  void it("records an item when every file it names appears in the passing output, whichever spelling the runner used", () => {
    const output = "✔ out/test/churnCeilingBugs4ReplayV1.test.js (12ms)\n✔ out/test/testEvidenceReportsV1.test.js";
    const files = extractPassedTestFilesFromOutputV1(output);
    const matched = matchPassedOutputToItemsV1(
      [
        { itemText: STEP7, testFiles: identifyItemTestFilesV1(STEP7, []) },
        { itemText: STEP17, testFiles: identifyItemTestFilesV1(STEP17, []) },
      ],
      files
    );
    assert.deepEqual(matched.recordable.map((entry) => entry.itemText), [STEP7, STEP17]);
    assert.equal(matched.unidentified.length, 0);
  });

  void it("leaves an item with no identifiable file, or whose file the output does not name, provisional with the reason", () => {
    const matched = matchPassedOutputToItemsV1(
      [
        { itemText: STEP22, testFiles: [] },
        { itemText: STEP7, testFiles: ["src/test/churnCeilingBugs4ReplayV1.test.ts"] },
      ],
      ["out/test/somethingElse.test.js"]
    );
    assert.equal(matched.recordable.length, 0);
    assert.match(matched.unidentified[0]!.reason, /no test file could be identified/);
    assert.match(matched.unidentified[1]!.reason, /does not name `src\/test\/churnCeilingBugs4ReplayV1\.test\.ts`/);
  });
});

function facts(overrides: Partial<EvidenceGapCardFactsV1> = {}): EvidenceGapCardFactsV1 {
  return {
    taskFolderPath: "/ws/.ensemble/2026-11-02_task_3",
    stage: "impl-high-review",
    attempt: "passed",
    score: 8,
    items: [{ itemText: STEP7, passingRuns: 1 }, { itemText: STEP17, passingRuns: 2 }],
    recordedCount: 1,
    nextStage: "impl-low-review",
    ...overrides,
  };
}

void describe("the evidence-gap card (Step 34)", () => {
  void it("recommends ticking when every listed item has a passing run on record", () => {
    assert.equal(recommendEvidenceGapOptionV1(facts()), "tickThese");
    const card = buildEvidenceGapCardInputV1(facts());
    assert.deepEqual(card.options.map((o) => o.optionId), ["tickThese", "runChecksAgain", "recordRun", "moveOn"]);
    assert.equal(card.recommendation.kind, "option");
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : "", "tickThese");
    const tick = card.options[0]!;
    assert.equal(tick.label, "Tick these 2 items");
    assert.equal(tick.effect.kind === "command" ? tick.effect.command : "", TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1);
  });

  void it("recommends running the checks again when an item has no passing run and the attempt could not run", () => {
    const f = facts({ attempt: "could-not-run", attemptDetail: "the command was refused", items: [{ itemText: STEP7, passingRuns: 0 }] });
    assert.equal(recommendEvidenceGapOptionV1(f), "runChecksAgain");
    assert.match(buildEvidenceGapCardInputV1(f).whatHappened, /could not run: the command was refused/);
  });

  void it("recommends recording a run when the checks ran but the item still has no passing run", () => {
    const f = facts({ attempt: "failed", items: [{ itemText: STEP7, passingRuns: 0 }] });
    assert.equal(recommendEvidenceGapOptionV1(f), "recordRun");
    assert.match(buildEvidenceGapCardInputV1(f).whatHappened, /ran once and failed/);
  });

  void it("says no editing round was dispatched, and names why the count is short on Move on", () => {
    const card = buildEvidenceGapCardInputV1(facts());
    assert.match(card.whatHappened, /No editing round was dispatched/);
    const moveOn = card.options.find((o) => o.optionId === "moveOn")!;
    assert.match(moveOn.consequence, /2 plan items still counted as provisional/);
    assert.equal(buildEvidenceGapCardInputV1(facts({ nextStage: undefined })).options.some((o) => o.optionId === "moveOn"), false);
  });
});

void describe("the passing output's test files are held per task and read once (Step 34)", () => {
  void it("a take returns the latest record and clears it, so one run's files never count for the next", () => {
    const folder = "/ws/.ensemble/2026-11-02_task_9";
    recordPublishChecksPassedFilesV1(folder, { runAt: "2026-11-03T20:00:00.000Z", passed: true, testFiles: ["a.test.js"] });
    assert.deepEqual(takePublishChecksPassedFilesV1(folder)?.testFiles, ["a.test.js"]);
    assert.equal(takePublishChecksPassedFilesV1(folder), undefined);
    recordPublishChecksPassedFilesV1(folder, { runAt: "x", passed: true, testFiles: ["b.test.js"] });
    clearPublishChecksPassedFilesV1(folder);
    assert.equal(takePublishChecksPassedFilesV1(folder), undefined);
  });
});

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
}

const CLEAN: ReviewRoundOutcome = { score: 8, taskFixableCount: 0, zeroFixableEvidence: true, progress: { complete: 5, total: 10 } };

void describe("Fast Forward and the evidence-only gap (Step 34)", () => {
  void it("asks the hook once, before any Apply Review, and stops with the gap hold when the gap remains", async () => {
    let applies = 0;
    let asked = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(CLEAN),
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      closeEvidenceGap: () => {
        asked += 1;
        return Promise.resolve({ kind: "stopped", detail: "Publish Checks passed once; 1 item recorded and 2 still wait" });
      },
      maxAttempts: 5,
    });
    assert.equal(applies, 0);
    assert.equal(asked, 1);
    assert.equal(result.held?.kind, "evidence-gap");
    assert.match(describeFastForwardHoldV1(result.held,"High-Level Code Review", result.attempts), /No Apply Review was dispatched/);
  });

  void it("when the hook closes the gap the run takes the clean-review path and no Apply Review runs", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(CLEAN),
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      closeEvidenceGap: () => Promise.resolve({ kind: "closed" }),
      maxAttempts: 5,
    });
    assert.equal(applies, 0);
    assert.equal(result.held?.kind, "clean-review");
  });

  void it("not-applicable leaves the older path alone, and the hook is never asked a second time in a run", async () => {
    let asked = 0;
    let applies = 0;
    await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(CLEAN),
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      closeEvidenceGap: () => {
        asked += 1;
        return Promise.resolve({ kind: "not-applicable" });
      },
      maxAttempts: 3,
    });
    assert.equal(asked, 1);
    assert.equal(applies, 3);
  });
});
