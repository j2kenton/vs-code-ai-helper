/**
 * bugs6 item 38 (Step 10, 11): "Add the missing files and review again" answered after the Fast Forward run exited
 * still continues that run; a stale capture, or no run at all, ends with the stage's normal card; a stage the
 * re-review clears gets a chat line and a card with the next click.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  buildPartialScopeDecisionInputV1,
  continueAfterScopeReReviewV1,
  decideScopeReReviewFollowUpV1,
  type ResolvePartialReviewScopeArgV1,
  type ScopeReReviewDepsV1,
} from "../commands/partialScopeDecisionV1";
import {
  __resetFastForwardRunsForTestV1,
  clearFastForwardRunActiveV1,
  clearFastForwardRunPausedProvenanceV1,
  getFastForwardRunChainV1,
  markFastForwardRunActiveV1,
  recordFastForwardRunPausedV1,
} from "../utils/activeFastForwardRunsV1";
import { isFastForwardResumeStateTrustedV1, type FastForwardResumeStateV1 } from "../commands/fastForwardResumeSuffixV1";
import { hashMissingFilesV1, type PartialReviewScopeV1 } from "../utils/reviewPartialScopeV1";

const FOLDER = "/ws/.ensemble/2026-11-06_task_1";
const MISSING = Array.from({ length: 17 }, (_, i) => `src/m${i}.ts`);
const SCOPE: PartialReviewScopeV1 = {
  missingCount: 17,
  summary: "Reviewed 7 of 24 changed files",
  hash: hashMissingFilesV1(MISSING),
  files: MISSING,
};

function cardArgs(input: ReturnType<typeof buildPartialScopeDecisionInputV1>, optionId: string): ResolvePartialReviewScopeArgV1 {
  const option = input.options.find((o) => o.optionId === optionId);
  assert.ok(option, `option ${optionId}`);
  assert.equal(option.effect.kind, "command");
  return (option.effect.kind === "command" ? option.effect.args?.[0] : undefined) as ResolvePartialReviewScopeArgV1;
}

function makeDeps(overrides: Partial<ScopeReReviewDepsV1> = {}): {
  deps: ScopeReReviewDepsV1;
  said: string[];
  dispatched: { command: string; arg: Record<string, unknown> }[];
  cards: string[];
} {
  const said: string[] = [];
  const dispatched: { command: string; arg: Record<string, unknown> }[] = [];
  const cards: string[] = [];
  const deps: ScopeReReviewDepsV1 = {
    readHoldReason: () => Promise.resolve(undefined),
    isTrusted: (state) => isFastForwardResumeStateTrustedV1(state, FOLDER),
    isFastForwardActive: () => false,
    runFastForward: (command, arg) => {
      dispatched.push({ command, arg });
      return Promise.resolve();
    },
    postEndCard: () => {
      cards.push("end-card");
      return Promise.resolve({ posted: true });
    },
    postStageReadyCard: () => {
      cards.push("stage-ready");
      return Promise.resolve({ posted: true });
    },
    say: (text) => {
      said.push(text);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, said, dispatched, cards };
}

/** A Fast Forward run raises the card at iteration 1 of 5, then exits as a pause for it. */
function raiseCardInFastForwardRunAndExit(): ResolvePartialReviewScopeArgV1 {
  markFastForwardRunActiveV1(FOLDER, { attemptNumber: 1, maxAttempts: 5 });
  const input = buildPartialScopeDecisionInputV1({
    taskFolderPath: FOLDER,
    stage: "impl-high-review",
    scope: SCOPE,
    score: 5,
    threshold: 8,
    scoreClears: false,
    fastForward: { attemptNumber: 1, maxAttempts: 5 },
  });
  const args = cardArgs(input, "addAndRereview");
  // The run ends as a pause for the card (reviewActions' finally: record the pause, then clear liveness).
  recordFastForwardRunPausedV1(FOLDER);
  clearFastForwardRunActiveV1(FOLDER);
  return args;
}

void describe("bugs6 item 38: the scope card carries the Fast Forward run it was raised in", () => {
  beforeEach(() => __resetFastForwardRunsForTestV1());

  void it("bakes the run's attempts and provenance into the re-review options, not into Accept", () => {
    markFastForwardRunActiveV1(FOLDER, { attemptNumber: 2, maxAttempts: 6 });
    const input = buildPartialScopeDecisionInputV1({
      taskFolderPath: FOLDER,
      stage: "impl-high-review",
      scope: { ...SCOPE, sizeLimitFiles: [MISSING[0]!] },
      score: 5,
      threshold: 8,
      scoreClears: false,
      fastForward: { attemptNumber: 2, maxAttempts: 6 },
    });
    const add = cardArgs(input, "addAndRereview");
    assert.equal(add.resumeFastForwardV1?.attemptNumber, 2);
    assert.equal(add.resumeFastForwardV1?.maxAttempts, 6);
    assert.ok(add.resumeFastForwardV1?.fastForwardSessionIdV1);
    assert.equal(add.resumeFastForwardV1?.fastForwardRunEpochV1, 1);
    assert.ok(cardArgs(input, "separatePass").resumeFastForwardV1);
    assert.equal(cardArgs(input, "acceptPartial").resumeFastForwardV1, undefined);
    assert.match(input.options.find((o) => o.optionId === "addAndRereview")?.consequence ?? "", /raised during Fast Forward \(iteration 2 of 6\)/);
  });

  void it("outside a Fast Forward run nothing is captured", () => {
    const input = buildPartialScopeDecisionInputV1({
      taskFolderPath: FOLDER,
      stage: "impl-high-review",
      scope: SCOPE,
      score: 5,
      threshold: 8,
    });
    assert.equal(cardArgs(input, "addAndRereview").resumeFastForwardV1, undefined);
    assert.doesNotMatch(input.options.find((o) => o.optionId === "addAndRereview")?.consequence ?? "", /Fast Forward/);
  });
});

void describe("bugs6 item 38: what follows the re-review", () => {
  beforeEach(() => __resetFastForwardRunsForTestV1());

  void it("a card raised during Fast Forward and answered after the run exited still continues Fast Forward", async () => {
    const args = raiseCardInFastForwardRunAndExit();
    assert.equal(getFastForwardRunChainV1(FOLDER), 1, "the run chain was kept");
    const { deps, dispatched, cards, said } = makeDeps();
    const decision = await continueAfterScopeReReviewV1(args, deps);
    assert.equal(decision.kind, "continue-fast-forward");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.command, "vs-code-ai-helper.fastForwardReviewWithAI");
    assert.deepEqual((dispatched[0]?.arg.resumeFromAttemptV1 as FastForwardResumeStateV1).attemptNumber, 1);
    assert.equal(dispatched[0]?.arg.taskFolderPath, FOLDER);
    assert.deepEqual(cards, [], "no end card while Fast Forward goes on");
    assert.match(said[0] ?? "", /Fast Forward goes on with Apply Review \(iteration 1 of 5\)/);
  });

  void it("a capture whose run was superseded by a newer run falls back to the normal end card", async () => {
    const args = raiseCardInFastForwardRunAndExit();
    markFastForwardRunActiveV1(FOLDER, { attemptNumber: 0, maxAttempts: 5 }); // a newer run: new epoch
    clearFastForwardRunActiveV1(FOLDER);
    const { deps, dispatched, cards, said } = makeDeps();
    const decision = await continueAfterScopeReReviewV1(args, deps);
    assert.equal(decision.kind, "end-card");
    assert.equal(dispatched.length, 0);
    assert.deepEqual(cards, ["end-card"]);
    assert.match(said.join("\n"), /Fast Forward did not continue: the run that raised this card has since ended/);
  });

  void it("a capture from before a window restart (new session) falls back to the normal end card", async () => {
    const args = raiseCardInFastForwardRunAndExit();
    __resetFastForwardRunsForTestV1(); // a restart: fresh session id, cleared state
    const { deps, dispatched, cards } = makeDeps();
    const decision = await continueAfterScopeReReviewV1(args, deps);
    assert.equal(decision.kind, "end-card");
    assert.equal(dispatched.length, 0);
    assert.deepEqual(cards, ["end-card"]);
  });

  void it("a run that ended for an unrelated reason (chain ended, pause invalidated) falls back to the normal end card", async () => {
    const args = raiseCardInFastForwardRunAndExit();
    clearFastForwardRunPausedProvenanceV1(FOLDER);
    const { deps, dispatched, cards } = makeDeps();
    assert.equal((await continueAfterScopeReReviewV1(args, deps)).kind, "end-card");
    assert.equal(dispatched.length, 0);
    assert.deepEqual(cards, ["end-card"]);
  });

  void it("outside Fast Forward the re-review ends with the normal end card, never with nothing", async () => {
    const args: ResolvePartialReviewScopeArgV1 = {
      taskFolderPath: FOLDER,
      stage: "impl-high-review",
      action: "addAndRereview",
      missingFiles: MISSING,
      hash: SCOPE.hash,
    };
    const first = makeDeps();
    assert.equal((await continueAfterScopeReReviewV1(args, first.deps)).kind, "end-card");
    assert.deepEqual(first.cards, ["end-card"]);

    // The stage is cleared (no work-left card): the "<Stage> is done" card with the next stage's click.
    const cleared = makeDeps({ postEndCard: () => Promise.resolve({ posted: false }) });
    await continueAfterScopeReReviewV1(args, cleared.deps);
    assert.deepEqual(cleared.cards, ["stage-ready"]);

    // Neither card applies: the chat still says it ended and what to click.
    const neither = makeDeps({
      postEndCard: () => Promise.resolve({ posted: false }),
      postStageReadyCard: () => Promise.resolve({ posted: false }),
    });
    await continueAfterScopeReReviewV1(args, neither.deps);
    assert.match(neither.said.join("\n"), /nothing more is queued/);
    assert.match(neither.said.join("\n"), /click Review again, Apply Review or Move on/);
  });

  void it("a review that raised a new scope hold has its own card: nothing is dispatched or added", async () => {
    const args = raiseCardInFastForwardRunAndExit();
    const { deps, dispatched, cards } = makeDeps({ readHoldReason: () => Promise.resolve("still partial") });
    const decision = await continueAfterScopeReReviewV1(args, deps);
    assert.deepEqual(decision, { kind: "hold", reason: "still partial" });
    assert.equal(dispatched.length, 0);
    assert.deepEqual(cards, []);
  });

  void it("never starts a second Fast Forward run while one is active", () => {
    const decision = decideScopeReReviewFollowUpV1({
      capture: { attemptNumber: 1, maxAttempts: 5, fastForwardSessionIdV1: "s", fastForwardRunEpochV1: 1 },
      captureTrusted: true,
      otherFastForwardRunActive: true,
      holdReason: undefined,
    });
    assert.equal(decision.kind, "end-card");
  });
});
