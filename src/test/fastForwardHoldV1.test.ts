/**
 * bugs4 item 25 (Step 23): Fast Forward obeys its own cards. Replays the
 * 2026-10-31 bugs3 sequence (clean 8/10 review, an Apply Review dispatched
 * anyway, an empty round that raised a card, a re-review of the same tree,
 * then another Apply Review) against the loop and its hook helpers.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { improveReviewScore, type ReviewRoundOutcome } from "../utils/reviewScoreLoop";
import {
  describeFastForwardHoldV1,
  findBlockingDecisionSinceRunStartV1,
  latestApplyReviewChangedNothingV1,
  isOwnerOnlyTestRunItemV1,
  unproducibleTestEvidenceHoldV1,
} from "../utils/fastForwardHoldV1";
import { isBlockingDecisionV1 } from "../views/chatView";
import type { RoundLedgerEntryV1 } from "../types/taskProgress";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";

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

const RUN_START = Date.parse("2026-10-31T16:30:00.000Z");

function decision(overrides: Partial<WorkflowDecisionV1> = {}): WorkflowDecisionV1 {
  return {
    decisionId: "d1",
    decisionKey: "checklistBehind",
    taskCanonicalId: "t",
    stage: "impl-high-review",
    whatHappened: "High-Level Code Review is clean, but this task's plan checklist is flagged as behind.",
    whyUserNeeded: "x",
    options: [
      { optionId: "moveOn", resumeKind: "advance", label: "Move on", consequence: "Advances.", effect: { kind: "doNothing" } },
      { optionId: "notNow", resumeKind: "unpause", label: "Not now", consequence: "Does nothing.", effect: { kind: "doNothing" } },
    ],
    recommendation: { kind: "option", optionId: "moveOn", reasoning: "r" },
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "d" },
    createdAt: "2026-10-31T16:44:20.000Z",
    state: "pending",
    ...overrides,
  } as unknown as WorkflowDecisionV1;
}

function ledgerRow(overrides: Record<string, unknown>): RoundLedgerEntryV1 {
  return {
    roundId: "r1",
    stage: "impl-high-review",
    mode: "apply-review",
    startedAt: "2026-10-31T16:33:15.000Z",
    state: "completed",
    ...overrides,
  } as unknown as RoundLedgerEntryV1;
}

const CLEAN: ReviewRoundOutcome = { score: 8, taskFixableCount: 0, zeroFixableEvidence: true };
const BLOCKED: ReviewRoundOutcome = { score: 6, taskFixableCount: 2, zeroFixableEvidence: false };

void describe("findBlockingDecisionSinceRunStartV1", () => {
  void it("finds a card raised since the run started that waits on the owner, and names it", () => {
    const found = findBlockingDecisionSinceRunStartV1([decision()], RUN_START, isBlockingDecisionV1);
    assert.match(found ?? "", /plan checklist is flagged as behind/);
  });

  void it("ignores a card from before the run, a resolved card and an optional (single-option) notice", () => {
    assert.equal(
      findBlockingDecisionSinceRunStartV1(
        [
          decision({ createdAt: "2026-10-31T10:00:00.000Z" }),
          decision({ state: "resolved" as never }),
          decision({ options: decision().options.slice(0, 1) }),
        ],
        RUN_START,
        isBlockingDecisionV1
      ),
      undefined
    );
  });
});

void describe("latestApplyReviewChangedNothingV1", () => {
  void it("is true only for the latest terminal Apply Review with a known, empty change list", () => {
    assert.equal(latestApplyReviewChangedNothingV1([ledgerRow({ outcome: { filesChanged: [] } })], RUN_START), true);
    assert.equal(latestApplyReviewChangedNothingV1([ledgerRow({ outcome: { filesChanged: ["a.ts"] } })], RUN_START), false);
  });

  void it("an unknown change list, a live round, a review round and an older round are not 'changed nothing'", () => {
    assert.equal(latestApplyReviewChangedNothingV1([ledgerRow({})], RUN_START), false);
    assert.equal(
      latestApplyReviewChangedNothingV1([ledgerRow({ state: "open", outcome: { filesChanged: [] } })], RUN_START),
      false
    );
    assert.equal(
      latestApplyReviewChangedNothingV1([ledgerRow({ mode: "review", outcome: { filesChanged: [] } })], RUN_START),
      false
    );
    assert.equal(
      latestApplyReviewChangedNothingV1(
        [ledgerRow({ startedAt: "2026-10-30T10:00:00.000Z", outcome: { filesChanged: [] } })],
        RUN_START
      ),
      false
    );
    assert.equal(latestApplyReviewChangedNothingV1(undefined, RUN_START), false);
  });
});

void describe("improveReviewScore — Fast Forward obeys its own cards (bugs4 item 25)", () => {
  void it("a clean review never dispatches an Apply Review: the loop follows the clean-review path", async () => {
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
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
      cleanReviewNeverApplies: true,
      maxAttempts: 5,
    });
    assert.equal(applies, 0);
    assert.equal(result.zeroFixableSuccess, true);
    assert.equal(result.stalled, false);
    assert.equal(result.held?.kind, "clean-review");
  });

  void it("a clean review whose plan still has unbuilt steps is a build mandate: the Apply Review is dispatched, no success is claimed", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ ...CLEAN, progress: { complete: 5, total: 10 } }),
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      maxAttempts: 1,
    });
    assert.equal(applies, 1);
    assert.equal(result.held, undefined);
    assert.equal(result.zeroFixableSuccess, false);
  });

  void it("a clean round that leaves the plan incomplete does not take the clean-review hold on the next attempt", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ ...CLEAN, progress: { complete: 5, total: 10 } }),
      preLoopEvidence: { zeroFixableEvidence: false, planIncomplete: false },
      cleanReviewNeverApplies: true,
      maxAttempts: 2,
    });
    assert.equal(applies, 2);
    assert.equal(result.held, undefined);
  });

  void it("without the option the pre-existing build-mandate behaviour is unchanged (control)", async () => {
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
      maxAttempts: 1,
    });
    assert.equal(applies, 1);
  });

  void it("a review that finds real blockers still dispatches Apply Review, and each dispatch counts as an attempt (control)", async () => {
    let applies = 0;
    const rounds: ReviewRoundOutcome[] = [BLOCKED, BLOCKED, { score: 10, taskFixableCount: 1, zeroFixableEvidence: false }];
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(rounds.shift() ?? null),
      preLoopEvidence: { zeroFixableEvidence: false, planIncomplete: false },
      cleanReviewNeverApplies: true,
      maxAttempts: 10,
    });
    assert.equal(applies, 3);
    assert.equal(result.attempts, 3);
    assert.equal(result.held, undefined);
  });

  void it("a round that ends clean stops before the next Apply Review", async () => {
    let applies = 0;
    const rounds = [{ ...CLEAN, score: 7.5 }];
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 7.5,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(rounds.shift() ?? null),
      preLoopEvidence: { zeroFixableEvidence: false, planIncomplete: true },
      cleanReviewNeverApplies: true,
      maxAttempts: 10,
    });
    assert.equal(applies, 1);
    assert.equal(result.held?.kind, "clean-review");
    assert.equal(result.attempts, 1);
  });

  void it("a card that waits on the owner holds the run: nothing more is dispatched while it is open", async () => {
    let applies = 0;
    let cardOpen = false;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        cardOpen = true; // the round's ending raised the card
        return Promise.resolve();
      },
      review: () => Promise.resolve(BLOCKED),
      pendingBlockingDecision: () => (cardOpen ? "the checklist is behind" : undefined),
      maxAttempts: 10,
    });
    assert.equal(applies, 1);
    assert.equal(result.held?.kind, "pending-decision");
    assert.equal(result.held?.detail, "the checklist is behind");
    assert.equal(result.stalled, false);
    assert.equal(result.attempts, 1);
  });

  void it("an Apply Review that changed nothing and raised a decision ends the run before the re-review", async () => {
    let reviews = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 5,
      apply: () => Promise.resolve(),
      review: () => {
        reviews += 1;
        return Promise.resolve(BLOCKED);
      },
      holdAfterApply: () => "This round changed no files",
      maxAttempts: 10,
    });
    assert.equal(reviews, 0, "the same tree is not re-reviewed");
    assert.equal(result.held?.kind, "no-change-decision");
    assert.equal(result.attempts, 1);
  });

  void it("a round that changed files, or raised no decision, continues (control)", async () => {
    let applies = 0;
    const rounds: ReviewRoundOutcome[] = [BLOCKED, { score: 10, taskFixableCount: 1, zeroFixableEvidence: false }];
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(rounds.shift() ?? null),
      holdAfterApply: () => undefined,
      pendingBlockingDecision: () => undefined,
      maxAttempts: 10,
    });
    assert.equal(applies, 2);
    assert.equal(result.held, undefined);
  });
});

void describe("describeFastForwardHoldV1", () => {
  void it("each hold says why Fast Forward stopped and what ends the wait", () => {
    const pending = describeFastForwardHoldV1({ kind: "pending-decision", detail: "checklist is behind" }, "High-Level Code Review", 2);
    assert.match(pending, /waiting for your answer/);
    assert.match(pending, /checklist is behind/);
    const noChange = describeFastForwardHoldV1({ kind: "no-change-decision", detail: "x" }, "High-Level Code Review", 1);
    assert.match(noChange, /changed no files and raised a decision/);
    assert.match(noChange, /1 round dispatched/);
    const clean = describeFastForwardHoldV1({ kind: "clean-review", detail: "nothing to act on" }, "High-Level Code Review", 0);
    assert.match(clean, /clean-review path/);
  });
});

void describe("unproducibleTestEvidenceHoldV1 (bugs4 item 11, Step 23)", () => {
  const waiting = [{ testDependent: true }, { testDependent: true }];

  void it("holds when the last round's tests were refused and nothing changed since", () => {
    const reason = unproducibleTestEvidenceHoldV1({
      uncheckedCount: 0,
      provisional: waiting,
      lastRoundTestsRefused: true,
      hasAllowedTestCommand: true,
    });
    assert.match(reason ?? "", /2 built items are waiting only for a passing test report/);
    assert.match(reason ?? "", /test commands were refused/);
  });

  void it("holds when every waiting item needs a run only the owner can do (Docker / live database)", () => {
    const reason = unproducibleTestEvidenceHoldV1({
      uncheckedCount: 0,
      provisional: [
        { testDependent: true, text: "The authoritative Docker run passes: `npm run resilience:test:portable -- --synthetic --require-postgres16`" },
        { testDependent: true, text: "The docker drill refuses all 25 negative fixtures" },
      ],
      lastRoundTestsRefused: false,
      hasAllowedTestCommand: true,
    });
    assert.match(reason ?? "", /2 built items are waiting only for a passing test report/);
    assert.match(reason ?? "", /only you can do/);
  });

  void it("an owner-only item mixed with a runnable one keeps the normal path", () => {
    assert.equal(
      unproducibleTestEvidenceHoldV1({
        uncheckedCount: 0,
        provisional: [
          { testDependent: true, text: "The Docker drill passes" },
          { testDependent: true, text: "The parser tests pass" },
        ],
        lastRoundTestsRefused: false,
        hasAllowedTestCommand: true,
      }),
      undefined
    );
    assert.equal(isOwnerOnlyTestRunItemV1("Add tests for the parser"), false);
  });

  void it("holds when the project offers no targeted test command", () => {
    const reason = unproducibleTestEvidenceHoldV1({
      uncheckedCount: 0,
      provisional: waiting,
      lastRoundTestsRefused: false,
      hasAllowedTestCommand: false,
    });
    assert.match(reason ?? "", /no targeted test command a round can run/);
  });

  void it("does not hold when files changed since the refusal, so a round could still produce a report", () => {
    assert.equal(
      unproducibleTestEvidenceHoldV1({
        uncheckedCount: 0,
        provisional: waiting,
        lastRoundTestsRefused: true,
        hasAllowedTestCommand: true,
        changedSinceRefusal: true,
      }),
      undefined
    );
  });

  void it("never holds while an item is unticked or a provisional item needs no test run (control)", () => {
    const base = { lastRoundTestsRefused: true, hasAllowedTestCommand: false };
    assert.equal(unproducibleTestEvidenceHoldV1({ ...base, uncheckedCount: 1, provisional: waiting }), undefined);
    assert.equal(
      unproducibleTestEvidenceHoldV1({ ...base, uncheckedCount: 0, provisional: [...waiting, { testDependent: false }] }),
      undefined
    );
    assert.equal(unproducibleTestEvidenceHoldV1({ ...base, uncheckedCount: 0, provisional: [] }), undefined);
  });

  void it("a producible hold (tests allowed, none refused) keeps dispatching (control)", () => {
    assert.equal(
      unproducibleTestEvidenceHoldV1({
        uncheckedCount: 0,
        provisional: waiting,
        lastRoundTestsRefused: false,
        hasAllowedTestCommand: true,
      }),
      undefined
    );
  });
});

void describe("improveReviewScore — unproducible test evidence (bugs4 item 11)", () => {
  void it("a clean review with open items held only for unproducible test evidence dispatches no Apply Review", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 9,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve(CLEAN),
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      buildMandateCannotProgress: () => "5 built items are waiting only for a passing test report",
      maxAttempts: 5,
    });
    assert.equal(applies, 0);
    assert.equal(result.held?.kind, "test-evidence-unproducible");
    assert.equal(result.zeroFixableSuccess, false);
    assert.equal(result.attempts, 0);
    const line = describeFastForwardHoldV1(result.held, "High-Level Code Review", result.attempts);
    assert.match(line, /stopped/);
    assert.match(line, /none was dispatched/);
  });

  void it("when the hook finds a round could still progress, the build-mandate Apply Review is dispatched (control)", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 9,
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ ...CLEAN, progress: { complete: 5, total: 10 } }),
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      buildMandateCannotProgress: () => undefined,
      maxAttempts: 1,
    });
    assert.equal(applies, 1);
    assert.equal(result.held, undefined);
  });
});

void describe("describeFastForwardHoldV1 for unproducible test evidence (bugs4 item 46)", () => {
  void it("says why the run stopped and points at the decision card that carries the way on", () => {
    const line = describeFastForwardHoldV1(
      { kind: "test-evidence-unproducible", detail: "3 items wait for a test run only you can do" },
      "High-Level Code Review",
      2
    );
    assert.match(line, /stopped/);
    assert.match(line, /3 items wait for a test run only you can do/);
    assert.match(line, /decision card/);
  });
});
