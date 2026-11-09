/**
 * run1 plain words: "usage limit" is said only when the provider's own text says so. A failure classified as a
 * quota or rate limit from other words ("quota reached", "429") is told as a quota or rate limit.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFixChainFailureV1 } from "../utils/lintFixChainBlockV1";
import {
  describeProviderLimitPhraseV1,
  describeRoundStopV1,
  describeStopLeadV1,
  describeWaitForLimitResetV1,
} from "../utils/roundStopCauseV1";

void describe("plain limit words in the fix-chain card", () => {
  void it("keeps 'usage limit' when the provider's text says it, and says quota or rate limit otherwise", () => {
    const usage = readFixChainFailureV1("Backup a@high was tried and failed: You've hit your usage limit, resets in 1h.");
    assert.deepEqual(usage.triedOutcomes, [{ label: "a@high", outcome: "usage limit, resets in 1h" }]);
    const quota = readFixChainFailureV1("Backup a@high was tried and failed: Individual quota reached, resets in 1h.");
    assert.deepEqual(quota.triedOutcomes, [{ label: "a@high", outcome: "quota or rate limit, resets in 1h" }]);
  });
});

void describe("limit fragments are decided by describeRoundStopV1", () => {
  void it("returns the limit name, the wait step and the lead through the one formatter", () => {
    const usage = { kind: "providerUsageLimit" } as const;
    const quota = { kind: "providerQuota" } as const;
    assert.equal(describeRoundStopV1(usage, { providerLabel: "", fragment: "limitName" }), "usage limit");
    assert.equal(describeRoundStopV1(quota, { providerLabel: "", fragment: "limitName" }), "quota or rate limit");
    assert.equal(
      describeRoundStopV1(usage, { providerLabel: "", fragment: "waitForReset", resetText: "9:00" }),
      "wait for the usage limit to reset (earliest 9:00)"
    );
    assert.equal(
      describeRoundStopV1(quota, { providerLabel: "", fragment: "waitForReset" }),
      "wait for the quota or rate limit to reset"
    );
    assert.equal(
      describeRoundStopV1(usage, { providerLabel: "Claude Code", fragment: "lead", rawDetail: "resets 9am." }),
      "Claude Code hit a usage limit: resets 9am"
    );
  });

  void it("the helper builders give the same words as the formatter", () => {
    assert.equal(describeProviderLimitPhraseV1("You've hit your usage limit"), "usage limit");
    assert.equal(describeProviderLimitPhraseV1("429 too many requests"), "quota or rate limit");
    assert.equal(describeProviderLimitPhraseV1(undefined), "quota or rate limit");
    assert.equal(
      describeWaitForLimitResetV1(["quota reached", "You've hit your usage limit"], "9:00"),
      "wait for the usage limit to reset (earliest 9:00)"
    );
    assert.equal(describeWaitForLimitResetV1(["quota reached"]), "wait for the quota or rate limit to reset");
    assert.equal(describeStopLeadV1({ kind: "providerTimeCap" }, "Antigravity CLI").includes("usage limit"), false);
  });
});
