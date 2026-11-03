/**
 * chat1 Step 5: a round's outcome detail goes to Notifications once. While the operation that ran
 * the round is live, the detail waits for that operation's end entry; nothing is posted twice.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearRoundOutcomeDetailsV1,
  roundOutcomeDetailOfV1,
  stashRoundOutcomeDetailV1,
  takeRoundOutcomeDetailsForTaskV1,
} from "../utils/roundOutcomeDetailV1";

void describe("roundOutcomeDetailOfV1", () => {
  const head = "Ended: Apply Review (High-Level Code Review) — completed";

  void it("drops the head the operation's end entry already says", () => {
    const text = `_${head} — score 82 · 1 reviewer / 0 mechanical blocker(s) — runs Apply Review — model Claude Sonnet_`;
    assert.equal(
      roundOutcomeDetailOfV1(text, head),
      "score 82 · 1 reviewer / 0 mechanical blocker(s) — runs Apply Review — model Claude Sonnet"
    );
  });

  void it("is undefined when nothing follows the head", () => {
    assert.equal(roundOutcomeDetailOfV1(`_${head}_`, head), undefined);
  });

  void it("keeps the whole line when it does not start with the head, and bounds its length", () => {
    assert.equal(roundOutcomeDetailOfV1("_Ended: something else — failed_", head), "Ended: something else — failed");
    const long = roundOutcomeDetailOfV1(`_${head} — ${"x".repeat(5000)}_`, head) ?? "";
    assert.ok(long.length <= 1201);
  });
});

void describe("pending round details", () => {
  afterEach(() => clearRoundOutcomeDetailsV1());

  void it("hands a task's details to its next root end entry, once, oldest first", () => {
    stashRoundOutcomeDetailV1("/t/a", "op-1", "first");
    stashRoundOutcomeDetailV1("/t/b", "op-2", "other task");
    stashRoundOutcomeDetailV1("/t/a", "op-3", "second");
    assert.deepEqual(takeRoundOutcomeDetailsForTaskV1("/t/a"), ["first", "second"]);
    assert.deepEqual(takeRoundOutcomeDetailsForTaskV1("/t/a"), [], "taken once");
    assert.deepEqual(takeRoundOutcomeDetailsForTaskV1("/t/b"), ["other task"]);
  });

  void it("keeps one detail per operation and a bounded list", () => {
    stashRoundOutcomeDetailV1("/t/a", "op-1", "old");
    stashRoundOutcomeDetailV1("/t/a", "op-1", "new");
    assert.deepEqual(takeRoundOutcomeDetailsForTaskV1("/t/a"), ["new"]);
    for (let i = 0; i < 150; i++) stashRoundOutcomeDetailV1("/t/a", `op-${i}`, `d${i}`);
    assert.equal(takeRoundOutcomeDetailsForTaskV1("/t/a").length, 100);
  });
});
