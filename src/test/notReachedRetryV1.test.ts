/**
 * bugs4 Step 13 (item 43): after a zero-change Implementation round that left buildable items
 * "not reached", recommend retrying Implementation (not Run Review), and suggest a stronger model
 * when a small or fast tier ran.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNotReachedRetryNoticeV1,
  findNotReachedOpenItemsV1,
  isSmallOrFastTierModelV1,
} from "../utils/notReachedRetryV1";

const PLAN = [
  "- [x] Build the parser.",
  "- [ ] Wire the parser into the resolver.",
  "- [ ] Add the replay test.",
  "- [ ] Deploy to production. <!-- ensemble:excluded -->",
  "- [ ] Write the migration note.",
].join("\n");

function summaryWith(lines: readonly string[]): string {
  return ["No files changed.", "", "## Plan Item Checklist", "", ...lines, "", "## Verification", "", "None."].join("\n");
}

void describe("findNotReachedOpenItemsV1 (bugs4 item 43)", () => {
  void it("returns open items the round itself reported as not reached", () => {
    const summary = summaryWith([
      "- Wire the parser into the resolver. — not reached — ran out of turns",
      "- Add the replay test. — not reached",
      "- Build the parser. — done — already ticked",
    ]);
    assert.deepEqual(findNotReachedOpenItemsV1(summary, PLAN), [
      "Wire the parser into the resolver.",
      "Add the replay test.",
    ]);
  });

  void it("does not count deferred or blocked items, or items the round never mentioned", () => {
    const summary = summaryWith([
      "- Wire the parser into the resolver. — deferred — waits on the owner",
      "- Add the replay test. — blocked — no test runner",
    ]);
    assert.deepEqual(findNotReachedOpenItemsV1(summary, PLAN), []);
  });

  void it("does not count excluded owner hand-offs even when reported not reached", () => {
    const summary = summaryWith(["- Deploy to production. — not reached — owner step"]);
    assert.deepEqual(findNotReachedOpenItemsV1(summary, PLAN), []);
  });
});

void describe("buildNotReachedRetryNoticeV1 (bugs4 item 43)", () => {
  void it("recommends Implementation, not Run Review, and names the count", () => {
    const notice = buildNotReachedRetryNoticeV1({
      notReachedCount: 2,
      modelId: "claude-cli:claude-sonnet-5-5@high",
      modelLabel: "Claude Sonnet 5.5",
    });
    assert.equal(notice.actionLabel, "Run Implementation");
    assert.match(notice.warning, /2 plan item\(s\) as not reached/);
    assert.doesNotMatch(notice.warning, /Run Review/);
    assert.equal(notice.suggestStrongerModel, false);
  });

  void it("suggests a stronger model when a small or fast tier ran", () => {
    const notice = buildNotReachedRetryNoticeV1({
      notReachedCount: 5,
      modelId: "claude-cli:claude-haiku-4-5@low",
      modelLabel: "Claude Haiku 4.5",
    });
    assert.equal(notice.suggestStrongerModel, true);
    assert.match(notice.warning, /Claude Haiku 4\.5/);
    assert.match(notice.warning, /stronger Implementation model/);
  });

  void it("classifies tiers by id", () => {
    assert.equal(isSmallOrFastTierModelV1("gemini-4-flash-high"), true);
    assert.equal(isSmallOrFastTierModelV1("claude-opus-5-5"), false);
    assert.equal(isSmallOrFastTierModelV1(undefined), false);
  });
});
