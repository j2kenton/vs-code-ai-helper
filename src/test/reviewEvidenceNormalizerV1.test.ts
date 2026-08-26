import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  derivePlanNonGoalSupersessionsV1,
  filterSupersededBlockersV1,
  formatAcceptedNonGoalsVariableV1,
  formatOwnerDecisionsVariableV1,
  matchBlockersAgainstNonGoalsV1,
  parseAcceptedNonGoalsV1,
} from "../utils/reviewEvidenceNormalizerV1";
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

// wf10 continuation item 18 — `"plan-non-goal"` source: a standing decision
// about the blocker's SUBJECT, unlike `"chat-confirmed"` above, so it applies
// even to fresh content (`reviewAsOfMs` omitted).
// ---------------------------------------------------------------------------

void test("a plan-non-goal supersession filters a blocker even with reviewAsOfMs omitted (fresh content)", () => {
  const blockers = [blocker("the owner must approve a complete tie policy"), blocker("something else")];
  const result = filterSupersededBlockersV1(
    "plan-high-review",
    blockers,
    [supersession({ source: "plan-non-goal" })]
    // reviewAsOfMs deliberately omitted
  );
  assert.deepEqual(
    result.map((b) => b.description),
    ["something else"]
  );
});

void test("a plan-non-goal supersession still respects the stage scope", () => {
  const blockers = [blocker("the owner must approve a complete tie policy")];
  const result = filterSupersededBlockersV1("impl-high-review", blockers, [
    supersession({ stage: "plan-high-review", source: "plan-non-goal" }),
  ]);
  assert.deepEqual(result, blockers);
});

// parseAcceptedNonGoalsV1
// ---------------------------------------------------------------------------

void test("parseAcceptedNonGoalsV1 returns [] when the plan has no Accepted Non-Goals section", () => {
  assert.deepEqual(parseAcceptedNonGoalsV1("# Plan\n\n## Steps\n\n- do the thing\n"), []);
});

void test("parseAcceptedNonGoalsV1 extracts one entry per sub-heading and stops at the next same-or-higher heading", () => {
  const plan = [
    "# Plan",
    "",
    "## Accepted Non-Goals",
    "",
    "### The onWillSaveTextDocument correlation gap",
    "",
    "VS Code's API exposes no handle correlating the event to the save() that raised it.",
    "",
    "### The applyEdit version precondition",
    "",
    "applyEdit has no version precondition to guard against a concurrent write.",
    "",
    "## Human Verification Hand-offs",
    "",
    "- check the thing manually",
  ].join("\n");
  const entries = parseAcceptedNonGoalsV1(plan);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.heading, "The onWillSaveTextDocument correlation gap");
  assert.match(entries[0]?.bodyText ?? "", /correlating the event/);
  assert.equal(entries[1]?.heading, "The applyEdit version precondition");
  assert.match(entries[1]?.bodyText ?? "", /version precondition/);
});

void test("parseAcceptedNonGoalsV1 treats a section with no sub-headings as one entry", () => {
  const plan = ["## Accepted Non-Goals", "", "Nothing further is planned here.", "", "## Next"].join("\n");
  const entries = parseAcceptedNonGoalsV1(plan);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.heading, "Accepted Non-Goals");
  assert.match(entries[0]?.bodyText ?? "", /Nothing further/);
});

// matchBlockersAgainstNonGoalsV1 / derivePlanNonGoalSupersessionsV1
// ---------------------------------------------------------------------------

const SAVE_GUARD_BLOCKER_TEXT =
  "the own save exemption remains uri wide during the asynchronous save window";
const SAVE_GUARD_NON_GOAL_BODY =
  "Residual: the own save exemption remains uri wide during the asynchronous save window because " +
  "VS Code's onWillSaveTextDocument API exposes no per-operation correlation handle. Accepted as a " +
  "permanent limitation, detected and never silently persisted.";

void test("matchBlockersAgainstNonGoalsV1 matches a blocker whose distinctive words are covered by a non-goal entry", () => {
  const matches = matchBlockersAgainstNonGoalsV1(
    [blocker(SAVE_GUARD_BLOCKER_TEXT), blocker("the login form does not validate empty passwords")],
    [{ heading: "The save-guard residual", bodyText: SAVE_GUARD_NON_GOAL_BODY }]
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.blocker.description, SAVE_GUARD_BLOCKER_TEXT);
  assert.equal(matches[0]?.nonGoalHeading, "The save-guard residual");
});

void test("matchBlockersAgainstNonGoalsV1 returns [] when there are no non-goal entries", () => {
  assert.deepEqual(matchBlockersAgainstNonGoalsV1([blocker(SAVE_GUARD_BLOCKER_TEXT)], []), []);
});

void test("derivePlanNonGoalSupersessionsV1 removes matched blockers, derives one new supersession, and reports the match as challenged", () => {
  const result = derivePlanNonGoalSupersessionsV1(
    "impl-high-review",
    [blocker(SAVE_GUARD_BLOCKER_TEXT), blocker("something unrelated")],
    `## Accepted Non-Goals\n\n### The save-guard residual\n\n${SAVE_GUARD_NON_GOAL_BODY}\n`,
    undefined,
    "2026-08-26T11:15:57.000Z"
  );
  assert.deepEqual(
    result.effectiveBlockers.map((b) => b.description),
    ["something unrelated"]
  );
  assert.equal(result.newSupersessions.length, 1);
  assert.equal(result.newSupersessions[0]?.source, "plan-non-goal");
  assert.equal(result.newSupersessions[0]?.blockerDescription, SAVE_GUARD_BLOCKER_TEXT);
  assert.equal(result.newSupersessions[0]?.stage, "impl-high-review");
  assert.equal(result.challenged.length, 1);
  assert.equal(result.challenged[0]?.nonGoalHeading, "The save-guard residual");
});

void test("derivePlanNonGoalSupersessionsV1 does not re-derive a supersession that already exists, but still reports the re-raise as challenged", () => {
  const existing: BlockerSupersessionRecordV1[] = [
    {
      stage: "impl-high-review",
      blockerDescription: SAVE_GUARD_BLOCKER_TEXT,
      supersededAt: "2026-08-26T11:01:53.000Z",
      planRelPath: "plan-final.md",
      source: "plan-non-goal",
    },
  ];
  const result = derivePlanNonGoalSupersessionsV1(
    "impl-high-review",
    [blocker(SAVE_GUARD_BLOCKER_TEXT)],
    `## Accepted Non-Goals\n\n### The save-guard residual\n\n${SAVE_GUARD_NON_GOAL_BODY}\n`,
    existing,
    "2026-08-26T11:15:57.000Z"
  );
  assert.equal(result.newSupersessions.length, 0);
  assert.equal(result.challenged.length, 1);
  assert.deepEqual(result.effectiveBlockers, []);
});

void test("derivePlanNonGoalSupersessionsV1 leaves blockers untouched when the plan has no matching non-goal", () => {
  const blockers = [blocker("something unrelated")];
  const result = derivePlanNonGoalSupersessionsV1(
    "impl-high-review",
    blockers,
    "## Accepted Non-Goals\n\n### Something else entirely\n\nUnrelated residual text.\n",
    undefined,
    "2026-08-26T11:15:57.000Z"
  );
  assert.deepEqual(result.effectiveBlockers, blockers);
  assert.equal(result.newSupersessions.length, 0);
  assert.equal(result.challenged.length, 0);
});

// formatAcceptedNonGoalsVariableV1 / formatOwnerDecisionsVariableV1
// ---------------------------------------------------------------------------

void test("formatAcceptedNonGoalsVariableV1 states explicitly when nothing is recorded", () => {
  assert.match(formatAcceptedNonGoalsVariableV1([]), /No `## Accepted Non-Goals` section/);
});

void test("formatAcceptedNonGoalsVariableV1 renders each entry under its own heading", () => {
  const text = formatAcceptedNonGoalsVariableV1([
    { heading: "The save-guard residual", bodyText: SAVE_GUARD_NON_GOAL_BODY },
  ]);
  assert.match(text, /### The save-guard residual/);
  assert.match(text, /permanent limitation/);
});

void test("formatOwnerDecisionsVariableV1 states explicitly when nothing is recorded for the stage", () => {
  assert.match(formatOwnerDecisionsVariableV1("impl-high-review", undefined), /No standing owner decisions/);
  assert.match(
    formatOwnerDecisionsVariableV1("impl-high-review", [supersession({ stage: "plan-high-review" })]),
    /No standing owner decisions/
  );
});

void test("formatOwnerDecisionsVariableV1 lists a stage's supersessions with their source", () => {
  const text = formatOwnerDecisionsVariableV1("impl-high-review", [
    supersession({ stage: "impl-high-review", source: "plan-non-goal" }),
  ]);
  assert.match(text, /plan non-goal/);
  assert.match(text, /the owner must approve a complete tie policy/);
});
