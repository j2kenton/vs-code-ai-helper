/**
 * bugs4 item 21 / Step 17: "N claimed; M verified; the rest because …" for each round, so a
 * verified count that does not move always has a stated reason.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectRoundClaimedItemsV1,
  formatClaimVerificationReportV1,
  formatClaimVerificationSectionV1,
} from "../utils/claimVerificationReportV1";

void describe("formatClaimVerificationReportV1", () => {
  void it("the captured shape: 37 claimed, 0 verified, review named none, 0 test reports parsed", () => {
    const line = formatClaimVerificationReportV1({ claimed: 37, verified: 0, testReportsParsed: 0, uncounted: [] });
    assert.match(line, /^37 claimed; 0 verified:/);
    assert.match(line, /review named none/);
    assert.match(line, /0 test reports parsed/);
  });

  void it("names why a claimed test item's evidence did not count", () => {
    const line = formatClaimVerificationReportV1({
      claimed: 3,
      verified: 1,
      testReportsParsed: 0,
      uncounted: [
        { itemText: "A", reason: "the Verification section does not state the post-edit tree" },
        { itemText: "B", reason: "no command matched" },
      ],
    });
    assert.match(line, /3 claimed; 1 verified/);
    assert.match(line, /2 claimed test items not counted \(the Verification section does not state the post-edit tree; see the run log/);
  });

  void it("a refused test command is named as the reason no report could exist", () => {
    const line = formatClaimVerificationReportV1({ claimed: 2, verified: 0, testReportsParsed: 0, uncounted: [], testsRefused: true });
    assert.match(line, /provider refused the round's test commands/);
  });

  void it("when every claim is verified there is no 'review named none' reason", () => {
    const line = formatClaimVerificationReportV1({ claimed: 2, verified: 2, testReportsParsed: 2, uncounted: [] });
    assert.doesNotMatch(line, /review named none/);
    assert.match(line, /2 test reports parsed/);
  });

  void it("a round that claims nothing writes no section", () => {
    assert.equal(formatClaimVerificationSectionV1({ claimed: 0, verified: 0, testReportsParsed: 0, uncounted: [] }), "");
  });

  void it("the run-log section carries the line under its own heading", () => {
    const section = formatClaimVerificationSectionV1({ claimed: 1, verified: 0, testReportsParsed: 1, uncounted: [] });
    assert.match(section, /## Claims and verification/);
    assert.match(section, /1 claimed; 0 verified/);
  });
});

void describe("collectRoundClaimedItemsV1 — claims withheld for test evidence still count as claimed", () => {
  const key = (text: string): string => text.trim().toLowerCase();

  void it("includes claims the test-evidence rule withheld, so the round reports 'N claimed; 0 verified'", () => {
    const claimed = collectRoundClaimedItemsV1([], ["Add the inventory test", "Add the coverage guard"], key);
    assert.deepEqual(claimed, ["Add the inventory test", "Add the coverage guard"]);
    const line = formatClaimVerificationReportV1({
      claimed: claimed.length,
      verified: 0,
      testReportsParsed: 0,
      uncounted: [{ itemText: "Add the inventory test", reason: "no Verification command matched the item's evidence" }],
    });
    assert.match(line, /^2 claimed; 0 verified:/);
    assert.match(line, /0 test reports parsed/);
  });

  void it("adds newly ticked items and withheld items together, once each", () => {
    assert.deepEqual(collectRoundClaimedItemsV1(["A", "B"], ["b", "C"], key), ["A", "B", "C"]);
  });

  void it("a round that claimed nothing yields nothing", () => {
    assert.deepEqual(collectRoundClaimedItemsV1([], [], key), []);
  });
});
