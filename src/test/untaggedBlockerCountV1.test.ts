import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countUnclassifiedBlockersV1,
  describeBlockersBlockGapV1,
  hasZeroTaskFixableEvidence,
  parseReviewBlockersDetailed,
  splitTaskFixableBlockersByOriginV1,
} from "../utils/reviewReadiness";
import { buildBlockerWorkListV1 } from "../utils/blockerWorkListV1";
import { formatRoundOutcomeMessageV1 } from "../utils/roundLedgerV1";
import type { RoundLedgerEntryV1 } from "../types/taskProgress";

// The shape of the 2026-11-09 14:37 review2 `impl-high-review.md`: a 7/10 review whose one blocker has no
// `[completion] [task-fixable]` tags and sits under "## New architectural blockers".
const REVIEW_1437 = [
  "Readiness: 7/10",
  "",
  "## New architectural blockers",
  "<!-- blockers:start -->",
  "- [narrowed:9a51b651-aaaa-bbbb-cccc-000000000001-1] Complete the remaining unbuilt plan scope (Part 4 item 2, Parts 6–10) and record durable post-edit passing test reports",
  "<!-- blockers:end -->",
  "<!-- progress: 20/64 -->",
].join("\n");

const PRIOR = [
  { id: "9a51b651-aaaa-bbbb-cccc-000000000001-1", category: "completion", resolver: "task-fixable" },
];

function endedLine(blockers: ReturnType<typeof parseReviewBlockersDetailed>["blockers"]): string {
  const split = splitTaskFixableBlockersByOriginV1(blockers);
  const unclassified = countUnclassifiedBlockersV1(blockers);
  const entry = {
    roundId: "r1",
    stage: "impl-high-review",
    mode: "review",
    state: "completed",
    startedAt: "2026-11-09T14:30:00.000Z",
    endedAt: "2026-11-09T14:37:00.000Z",
    attemptIds: ["a1"],
    outcome: {
      score: 7,
      reviewerBlockers: split.reviewerBlockers,
      mechanicalBlockers: split.mechanicalBlockers,
      ...(unclassified > 0 ? { unclassifiedBlockers: unclassified } : {}),
    },
  } as unknown as RoundLedgerEntryV1;
  return formatRoundOutcomeMessageV1(entry);
}

void describe("untagged blocker lines (bugs6 item 45)", () => {
  void it("case 1: an untagged [narrowed:<id>] line inherits category and resolver from the blocker it continues", () => {
    const evidence = parseReviewBlockersDetailed(REVIEW_1437, PRIOR);
    assert.equal(evidence.blockPresent, true);
    assert.equal(evidence.blockers.length, 1);
    const [blocker] = evidence.blockers;
    assert.equal(blocker?.category, "completion");
    assert.equal(blocker?.resolver, "task-fixable");
    assert.equal(blocker?.untaggedSource, "lineage");
    assert.deepEqual(blocker?.lineage, { kind: "narrowed", refId: "9a51b651-aaaa-bbbb-cccc-000000000001-1" });
    assert.equal(evidence.malformedLines.length, 0);
    assert.equal(hasZeroTaskFixableEvidence(REVIEW_1437), false);
    // The Ended line counts it as one reviewer blocker.
    assert.match(endedLine(evidence.blockers), /score 7 · 1 reviewer \/ 0 mechanical blocker\(s\)/);
  });

  void it("case 2: an untagged line with no lineage tag is counted, its resolver is unknown, and it is not task-fixable", () => {
    const content = [
      "Readiness: 7/10",
      "<!-- blockers:start -->",
      "- Complete the remaining unbuilt plan scope",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.equal(evidence.blockers.length, 1);
    assert.equal(evidence.blockers[0]?.resolver, "unknown");
    assert.equal(evidence.blockers[0]?.category, "uncategorised");
    assert.equal(evidence.blockers[0]?.untaggedSource, "none");
    assert.equal(splitTaskFixableBlockersByOriginV1(evidence.blockers).reviewerBlockers, 0);
    assert.equal(hasZeroTaskFixableEvidence(content), false);
    assert.match(endedLine(evidence.blockers), /1 \(1 whose kind the review didn't state\) reviewer/);
  });

  void it("takes the category from the section heading when no tag or lineage supplies one, with the resolver unknown", () => {
    const content = [
      "## New architectural blockers",
      "<!-- blockers:start -->",
      "- The dispatcher owns two competing queues",
      "<!-- blockers:end -->",
    ].join("\n");
    const [blocker] = parseReviewBlockersDetailed(content).blockers;
    assert.equal(blocker?.category, "architectural");
    assert.equal(blocker?.resolver, "unknown");
    assert.equal(blocker?.untaggedSource, "heading");
  });

  void it("a lineage tag citing an id absent from the prior list falls back to unknown", () => {
    const [blocker] = parseReviewBlockersDetailed(REVIEW_1437, [
      { id: "someone-else-1", category: "completion", resolver: "task-fixable" },
    ]).blockers;
    // The citation can't be resolved, so the resolver stays unknown; the heading still names the category.
    assert.equal(blocker?.resolver, "unknown");
    assert.equal(blocker?.category, "architectural");
    assert.equal(blocker?.untaggedSource, "heading");
  });

  void it("a fully tagged line parses exactly as before and a non-bullet line is still malformed", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] tagged",
      "stray prose that is not a bullet",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.deepEqual(evidence.blockers, [
      { category: "completion", resolver: "task-fixable", description: "tagged", origin: "reviewer" },
    ]);
    assert.deepEqual(evidence.malformedLines, ["stray prose that is not a bullet"]);
  });

  void it("an unknown-resolver blocker is no build mandate: the work list puts it under 'not this round' as unstated", () => {
    const evidence = parseReviewBlockersDetailed(REVIEW_1437);
    const list = buildBlockerWorkListV1({ blockers: evidence.blockers, plateauRounds: 3 });
    assert.equal(list.fixFirst.length, 0);
    assert.equal(list.buildToClear.length, 0);
    assert.equal(list.notThisRound.length, 1);
    assert.equal(list.notThisRound[0]?.kind, "unstated");
  });

  void it("warns when a failing review's blockers block has no blocker with a stated kind, and not otherwise", () => {
    const unknown = parseReviewBlockersDetailed(REVIEW_1437);
    const warning = describeBlockersBlockGapV1({ score: 7, threshold: 8, blockPresent: true, blockers: unknown.blockers });
    assert.match(warning ?? "", /scored 7\/10/);
    assert.match(warning ?? "", /no categorised blocker: Complete the remaining unbuilt plan scope/);
    assert.match(warning ?? "", /Apply Review/);
    const empty = describeBlockersBlockGapV1({ score: 7, threshold: 8, blockPresent: true, blockers: [] });
    assert.match(empty ?? "", /no counted blocker/);
    const inherited = parseReviewBlockersDetailed(REVIEW_1437, PRIOR);
    assert.equal(describeBlockersBlockGapV1({ score: 7, threshold: 8, blockPresent: true, blockers: inherited.blockers }), undefined);
    assert.equal(describeBlockersBlockGapV1({ score: 9, threshold: 8, blockPresent: true, blockers: [] }), undefined);
    assert.equal(describeBlockersBlockGapV1({ score: 7, threshold: 8, blockPresent: false, blockers: [] }), undefined);
  });

  void it("warns when a failing review mixes a tagged blocker with an unknown-resolver one, and not when the score passes", () => {
    const content = [
      "Readiness: 7/10",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] Build Part 4",
      "- Reconcile the two dispatch queues",
      "<!-- blockers:end -->",
    ].join("\n");
    const { blockers, blockPresent } = parseReviewBlockersDetailed(content);
    assert.equal(blockers.length, 2);
    assert.deepEqual(blockers.map((b) => b.resolver), ["task-fixable", "unknown"]);
    const warning = describeBlockersBlockGapV1({ score: 7, threshold: 8, blockPresent, blockers });
    assert.match(warning ?? "", /scored 7\/10/);
    assert.match(warning ?? "", /1 blocker\(s\) whose kind the review didn't state: Reconcile the two dispatch queues/);
    assert.doesNotMatch(warning ?? "", /Build Part 4/);
    assert.match(warning ?? "", /Apply Review/);
    assert.equal(describeBlockersBlockGapV1({ score: 8, threshold: 8, blockPresent, blockers }), undefined);
    // Every counted blocker stated: no warning.
    const stated = blockers.filter((b) => b.resolver !== "unknown");
    assert.equal(describeBlockersBlockGapV1({ score: 7, threshold: 8, blockPresent, blockers: stated }), undefined);
  });
});
