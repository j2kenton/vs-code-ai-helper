/**
 * review2 Step 44 (Part 10; bugs-register item 3): a clean review whose only open items wait on test evidence does not
 * dispatch an Apply Review, and a test command that was refused earlier is not run again by a round that can only run
 * it. The replay is the laptop "bugs1" run of 2026-11-06 12:17-12:23 UTC: clean 8/10 review, four open "write the
 * tests" items, vitest refused, and an Apply Review that could only fail the same way.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { improveReviewScore, type ReviewRoundOutcome } from "../utils/reviewScoreLoop";
import { describeFastForwardHoldV1, unproducibleTestEvidenceHoldV1 } from "../utils/fastForwardHoldV1";
import { openItemsAllWaitOnTestEvidenceV1 } from "../utils/implementationChecklist";

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

const CLEAN: ReviewRoundOutcome = { score: 8, taskFixableCount: 0, zeroFixableEvidence: true };

const PLAN = [
  "## Part 2",
  "",
  "- [x] Step 3: Build the popup search store.",
  "- [ ] Step 7: Write the tests for the popup search store (`test/popup-search-shared.spec.ts`).",
  "- [ ] Step 10: Write the tests for the content script (`test/content-shared.spec.ts`).",
].join("\n");

const BASE = {
  uncheckedCount: 2,
  provisional: [],
  lastRoundTestsRefused: true,
  hasAllowedTestCommand: true,
};

void describe("review2 Step 44: open items that wait only on test evidence", () => {
  void it("the plan's open items are all test-dependent", () => {
    assert.equal(openItemsAllWaitOnTestEvidenceV1(PLAN), true);
    assert.equal(openItemsAllWaitOnTestEvidenceV1(`${PLAN}\n- [ ] Step 11: Build the options page.`), false);
  });

  void it("after a clean review they hold the run with the reason and what would unblock it", () => {
    const hold = unproducibleTestEvidenceHoldV1({ ...BASE, uncheckedAllWaitOnTestEvidence: true });
    assert.ok(hold);
    assert.match(hold, /2 open items wait only for a passing test report/);
    assert.match(hold, /nothing left to build/);
    assert.match(hold, /refused/);
    assert.match(hold, /Allow the test command|run it yourself/);
  });

  void it("with no refusal the reason is still given, and no round is said to be able to produce a report", () => {
    const hold = unproducibleTestEvidenceHoldV1({ ...BASE, lastRoundTestsRefused: false, uncheckedAllWaitOnTestEvidence: true });
    assert.ok(hold);
    assert.doesNotMatch(hold, /refused/);
    assert.match(hold, /A round cannot make a test report appear by editing/);
  });

  void it("a refusal followed by changed files is not 'the same provider cannot' (the guard still names the open items)", () => {
    const hold = unproducibleTestEvidenceHoldV1({
      ...BASE,
      changedSinceRefusal: true,
      uncheckedAllWaitOnTestEvidence: true,
    });
    assert.ok(hold);
    assert.doesNotMatch(hold, /last editing round's test commands were refused/);
  });

  void it("any open item that is not test-dependent keeps the normal path (control)", () => {
    assert.equal(unproducibleTestEvidenceHoldV1({ ...BASE, uncheckedAllWaitOnTestEvidence: false }), undefined);
    assert.equal(unproducibleTestEvidenceHoldV1(BASE), undefined);
  });

  void it("bugs1 replay: a clean 8/10 review with four test-only open items dispatches no Apply Review", async () => {
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
      buildMandateCannotProgress: () =>
        unproducibleTestEvidenceHoldV1({ ...BASE, uncheckedCount: 4, uncheckedAllWaitOnTestEvidence: true }),
      maxAttempts: 5,
    });
    assert.equal(applies, 0, "no Apply Review");
    assert.equal(result.held?.kind, "test-evidence-unproducible");
    const line = describeFastForwardHoldV1(result.held, "High-Level Code Review", result.attempts);
    assert.match(line, /4 open items wait only for a passing test report/);
    assert.match(line, /none was dispatched/);
  });
});
