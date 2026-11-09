/**
 * run1 Steps 22 and 23: a round that cannot finish because another window kept the task state busy past
 * the bounded wait ends with a line that names the cause and a card whose first option is "Retry now".
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStateLockExhaustedCardV1,
  formatStateLockEndedLineV1,
  isStateLockExhaustedErrorV1,
  reportRoundLostToStateLockV1,
  RoundLostToStateLockDepsV1,
  STATE_LOCK_EXHAUSTED_CAUSE_V1,
} from "../commands/roundLostToStateLockV1";
import { PrimarySessionLockHeldError } from "../state/primarySessionLock";

const RETRY = { command: "vs-code-ai-helper.resumeAndRerunReview", args: [{ taskFolderPath: "/w/.ensemble/task_1" }] };

function fakeDeps(overrides: Partial<RoundLostToStateLockDepsV1> = {}) {
  const calls = { lines: [] as string[], cards: [] as unknown[], notes: [] as string[] };
  const deps: RoundLostToStateLockDepsV1 = {
    appendEndedLine: (_folder, _stage, text) => {
      calls.lines.push(text);
      return Promise.resolve();
    },
    postCard: (input) => {
      calls.cards.push(input);
      return Promise.resolve({ decisionId: "d1" });
    },
    notify: (message) => {
      calls.notes.push(message);
    },
    ...overrides,
  };
  return { deps, calls };
}

const input = (rowClosed: boolean) => ({
  taskFolderPath: "/w/.ensemble/task_1",
  stage: "impl-high-review" as const,
  stepName: "Review (High-Level Code Review)",
  rowClosed,
  retry: RETRY,
});

void describe("round lost to a held task-state lease (run1 Steps 22-23)", () => {
  void it("recognises only the held-lease error, and says the cause in plain words", () => {
    assert.equal(isStateLockExhaustedErrorV1(new PrimarySessionLockHeldError()), true);
    assert.equal(isStateLockExhaustedErrorV1(new Error("boom")), false);
    assert.match(STATE_LOCK_EXHAUSTED_CAUSE_V1, /another window was updating task state for more than 30 s/);
    assert.match(formatStateLockEndedLineV1("Review (High-Level Code Review)"), /^_Ended: Review \(High-Level Code Review\) — failed — another window/);
  });

  void it("the card offers Retry now first, with the retry command, and carries no internal identifiers", () => {
    const card = buildStateLockExhaustedCardV1(input(true));
    assert.equal(card.options[0]?.label, "Retry now");
    assert.deepEqual(card.options[0]?.effect, { kind: "command", command: RETRY.command, args: RETRY.args });
    assert.equal(card.recommendation.kind, "option");
    const text = JSON.stringify([card.whatHappened, card.whyUserNeeded, card.options.map((o) => [o.label, o.consequence])]);
    assert.doesNotMatch(text, /PrimarySessionLockHeldError|lease|externallyTerminated|pendingImplReviewFiles/);
    assert.match(card.whatHappened, /another window was updating task state for more than 30 s/);
  });

  void it("a stop before any model started says nothing was changed; a later stop never says so and says the changes are kept", async () => {
    const before = buildStateLockExhaustedCardV1({ ...input(true), beforeAnyWork: true });
    assert.match(before.options[0]?.consequence ?? "", /never got as far as changing the task/);
    const late = buildStateLockExhaustedCardV1(input(true));
    const lateText = late.options[0]?.consequence ?? "";
    assert.doesNotMatch(lateText, /never got as far|Nothing from the stopped round/);
    assert.match(lateText, /still in the working tree/);

    const early = fakeDeps();
    await reportRoundLostToStateLockV1({ ...input(false), beforeAnyWork: true }, early.deps);
    assert.match(early.calls.notes[0] ?? "", /Nothing was changed/);
    const afterWork = fakeDeps();
    await reportRoundLostToStateLockV1(input(false), afterWork.deps);
    assert.doesNotMatch(afterWork.calls.notes[0] ?? "", /Nothing was changed/);
    assert.match(afterWork.calls.notes[0] ?? "", /still in the working tree/);
  });

  void it("with the ledger row closed, the row's own line stands: no second line, and the card alone is enough", async () => {
    const { deps, calls } = fakeDeps();
    const result = await reportRoundLostToStateLockV1(input(true), deps);
    assert.deepEqual(result, { postedLine: false, postedCard: true, notified: false });
    assert.equal(calls.lines.length, 0);
    assert.equal(calls.cards.length, 1);
  });

  void it("with the row left open, the line is posted here, naming the cause, and a notification carries Retry now too", async () => {
    const { deps, calls } = fakeDeps();
    const result = await reportRoundLostToStateLockV1(input(false), deps);
    assert.deepEqual(result, { postedLine: true, postedCard: true, notified: true });
    assert.match(calls.lines[0] ?? "", /_Ended: Review \(High-Level Code Review\) — failed — another window was updating task state for more than 30 s/);
    assert.equal(calls.notes.length, 1);
  });

  void it("a card that cannot be posted still leaves a notification with the retry, and one failing surface never hides another", async () => {
    const { deps, calls } = fakeDeps({
      postCard: () => Promise.resolve(undefined),
      appendEndedLine: () => Promise.reject(new Error("chat store busy")),
    });
    const result = await reportRoundLostToStateLockV1(input(false), deps);
    assert.deepEqual(result, { postedLine: false, postedCard: false, notified: true });
    assert.equal(calls.notes.length, 1);
    const throwing = fakeDeps({ postCard: () => Promise.reject(new Error("no context")) });
    const second = await reportRoundLostToStateLockV1(input(true), throwing.deps);
    assert.equal(second.postedCard, false);
    assert.equal(second.notified, true);
  });
});
