import * as assert from "node:assert/strict";
import { test } from "node:test";
import { filterSupersededBlockersV1 } from "../utils/reviewEvidenceNormalizerV1";
import { BlockerSupersessionRecordV1 } from "../types/taskProgress";
import { ReviewBlocker } from "../utils/reviewReadiness";

// filterSupersededBlockersV1: wf10 item 19 — "teach the stage gate to
// recognize an annotated-superseded blocker as no longer outstanding".
// ---------------------------------------------------------------------------

function blocker(description: string, overrides: Partial<ReviewBlocker> = {}): ReviewBlocker {
  return { category: "architectural", resolver: "environmental", description, ...overrides };
}

function supersession(overrides: Partial<BlockerSupersessionRecordV1> = {}): BlockerSupersessionRecordV1 {
  return {
    stage: "plan-high-review",
    blockerDescription: "the owner must approve a complete tie policy",
    supersededAt: "2026-07-07T00:00:00.000Z",
    planRelPath: "plan.md",
    ...overrides,
  };
}

void test("returns every blocker unchanged when no supersessions are recorded", () => {
  const blockers = [blocker("A"), blocker("B")];
  assert.deepEqual(filterSupersededBlockersV1("plan-high-review", blockers, undefined), blockers);
  assert.deepEqual(filterSupersededBlockersV1("plan-high-review", blockers, []), blockers);
});

// supersededAt is fixed at 2026-07-07T00:00:00.000Z (see supersession()
// above) — a reviewAsOfMs strictly before that is "content read/produced
// before the resolution landed", the one case filtering should still apply.
const STALE_REVIEW_AS_OF_MS = Date.parse("2026-07-06T00:00:00.000Z");

void test("drops a blocker whose description exactly matches a recorded supersession for the same stage, when the review content predates the resolution", () => {
  const blockers = [blocker("the owner must approve a complete tie policy"), blocker("something else")];
  const result = filterSupersededBlockersV1("plan-high-review", blockers, [supersession()], STALE_REVIEW_AS_OF_MS);
  assert.deepEqual(
    result.map((b) => b.description),
    ["something else"]
  );
});

void test("does not drop a blocker recorded against a different stage, even with identical text", () => {
  const blockers = [blocker("the owner must approve a complete tie policy")];
  const result = filterSupersededBlockersV1(
    "impl-high-review",
    blockers,
    [supersession({ stage: "plan-high-review" })],
    STALE_REVIEW_AS_OF_MS
  );
  assert.deepEqual(result, blockers);
});

void test("matches after trimming surrounding whitespace on both sides", () => {
  const blockers = [blocker("  the owner must approve a complete tie policy  ")];
  const result = filterSupersededBlockersV1("plan-high-review", blockers, [supersession()], STALE_REVIEW_AS_OF_MS);
  assert.deepEqual(result, []);
});

void test("returns a fresh array (never the same reference as the input)", () => {
  const blockers = [blocker("unrelated")];
  const result = filterSupersededBlockersV1("plan-high-review", blockers, undefined);
  assert.notEqual(result, blockers);
  assert.deepEqual(result, blockers);
});

void test("does not filter when reviewAsOfMs is omitted — fresh review content is never masked by a prior supersession", () => {
  const blockers = [blocker("the owner must approve a complete tie policy")];
  const result = filterSupersededBlockersV1("plan-high-review", blockers, [supersession()]);
  assert.deepEqual(result, blockers);
});

void test("does not filter when the review content is NEWER than the supersession (a fresh review re-finding the same blocker)", () => {
  const blockers = [blocker("the owner must approve a complete tie policy")];
  const freshReviewAsOfMs = Date.parse("2026-07-08T00:00:00.000Z"); // after supersededAt
  const result = filterSupersededBlockersV1("plan-high-review", blockers, [supersession()], freshReviewAsOfMs);
  assert.deepEqual(result, blockers);
});
