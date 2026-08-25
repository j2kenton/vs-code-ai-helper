import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateHasRecentZeroFileFailuresV1,
  shouldTripFallbackProviderBreakerV1,
} from "../utils/fallbackProviderBreakerV1";
import { RoundOutcomeEntryV1 } from "../types/taskProgress";

function entry(overrides: Partial<RoundOutcomeEntryV1> = {}): RoundOutcomeEntryV1 {
  return {
    stage: "impl",
    classification: "provider-failure-empty",
    at: "2026-08-24T00:00:00.000Z",
    modelId: "claude-sonnet-5",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// candidateHasRecentZeroFileFailuresV1
// ---------------------------------------------------------------------------

void test("trips when the last N matching entries for (stage, modelId) are all provider-failure-empty", () => {
  const outcomes = [entry(), entry(), entry()];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), true);
});

void test("does not trip with fewer than N matching entries", () => {
  const outcomes = [entry()];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), false);
});

void test("a success on the same candidate breaks the run — the newest matching entry is no longer a failure", () => {
  const outcomes = [
    entry(),
    entry(),
    entry({ classification: "edits-produced" }),
  ];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), false);
});

void test("entries for a different candidate (the primary, or a different backup) never count", () => {
  const outcomes = [
    entry({ modelId: "claude-cli:opus" }),
    entry({ modelId: "claude-cli:opus" }),
  ];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), false);
});

void test("entries for a different stage never count", () => {
  const outcomes = [
    entry({ stage: "impl-high-review" }),
    entry({ stage: "impl-high-review" }),
  ];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), false);
});

void test("lookback of 0 never trips (breaker disabled)", () => {
  const outcomes = [entry(), entry()];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 0), false);
});

void test("an entry with no modelId (recorded before the field existed) never matches a lookup", () => {
  const outcomes = [entry({ modelId: undefined }), entry({ modelId: undefined })];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), false);
});

// wf10 review fix: an intervening round for a DIFFERENT candidate (the
// primary succeeding, or a different configured backup being tried) must END
// the episode — a fresh single failure against a candidate right after that
// must not be stitched onto an older episode's failures against the SAME
// candidate from before the intervening round.
void test("an intervening entry for a different candidate ends the episode — old failures do not carry over", () => {
  const outcomes = [
    entry(), // old episode: failure 1 against claude-sonnet-5
    entry(), // old episode: failure 2 against claude-sonnet-5
    entry({ modelId: "claude-cli:opus", classification: "edits-produced" }), // primary succeeded — episode boundary
    entry(), // new episode: only 1 failure against claude-sonnet-5 so far
  ];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), false);
});

void test("two failures within the SAME episode (after the boundary) still trip", () => {
  const outcomes = [
    entry(), // old episode
    entry({ modelId: "claude-cli:opus", classification: "edits-produced" }), // episode boundary
    entry(), // new episode: failure 1
    entry(), // new episode: failure 2
  ];
  assert.equal(candidateHasRecentZeroFileFailuresV1(outcomes, "impl", "claude-sonnet-5", 2), true);
});

// ---------------------------------------------------------------------------
// shouldTripFallbackProviderBreakerV1
// ---------------------------------------------------------------------------

void test("does not trip when fallbackActive is false, even with a matching failure streak", () => {
  const outcomes = [entry(), entry()];
  assert.equal(
    shouldTripFallbackProviderBreakerV1({
      roundOutcomes: outcomes,
      stage: "impl",
      modelId: "claude-sonnet-5",
      fallbackActive: false,
      breakerRounds: 2,
    }),
    false
  );
});

void test("trips when fallbackActive is true and the streak meets the threshold", () => {
  const outcomes = [entry(), entry()];
  assert.equal(
    shouldTripFallbackProviderBreakerV1({
      roundOutcomes: outcomes,
      stage: "impl",
      modelId: "claude-sonnet-5",
      fallbackActive: true,
      breakerRounds: 2,
    }),
    true
  );
});

void test("does not trip with no modelId", () => {
  const outcomes = [entry(), entry()];
  assert.equal(
    shouldTripFallbackProviderBreakerV1({
      roundOutcomes: outcomes,
      stage: "impl",
      modelId: undefined,
      fallbackActive: true,
      breakerRounds: 2,
    }),
    false
  );
});
