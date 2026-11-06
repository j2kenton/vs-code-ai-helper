/**
 * review1 Step 47: `environmental` keeps meaning "no code change resolves it"; `environmental-fixable` is
 * environmental in origin but a bounded (usually out-of-plan) code change resolves it. Both are non-terminal for
 * the plan's own rounds: neither is task-fixable work for an in-plan round.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import { buildBlockerWorkListV1 } from "../utils/blockerWorkListV1";
import { isEnvironmentalResolverV1, parseReviewBlockersDetailed, type ReviewBlocker } from "../utils/reviewReadiness";
import { decideReviewRoute } from "../utils/reviewRouting";

const REVIEW = [
  "Readiness: 7/10",
  "",
  "<!-- blockers:start -->",
  "- [completion] [environmental-fixable] The server test run dies before collecting any suite; it may be a config missing an exclusion (uncertain)",
  "- [completion] [environmental] The provider quota is exhausted until tomorrow",
  "- [completion] [task-fixable] src/a.ts drops the last row",
  "<!-- blockers:end -->",
].join("\n");

void describe("review1 Step 47: the environmental-fixable resolver", () => {
  void it("parses environmental-fixable as its own resolver, beside environmental and task-fixable", () => {
    const parsed = parseReviewBlockersDetailed(REVIEW);
    assert.deepEqual(
      parsed.blockers.map((b) => b.resolver),
      ["environmental-fixable", "environmental", "task-fixable"]
    );
    assert.equal(parsed.malformedLines.length, 0);
  });

  void it("treats both environmental resolvers alike for routing, and nothing else", () => {
    assert.equal(isEnvironmentalResolverV1("environmental"), true);
    assert.equal(isEnvironmentalResolverV1("environmental-fixable"), true);
    assert.equal(isEnvironmentalResolverV1("task-fixable"), false);
    assert.equal(isEnvironmentalResolverV1(undefined), false);
  });

  void it("a review whose only blockers are environmental-fixable escalates at once, with no in-plan round", () => {
    const blockers: ReviewBlocker[] = [
      { category: "completion", resolver: "environmental-fixable", description: "The server test run dies before collecting any suite" },
    ];
    const decision = decideReviewRoute({
      score: 7,
      threshold: 9,
      blockers,
      plateaued: false,
      secondOpinionTriedThisPlateau: false,
    });
    assert.equal(decision.route, "escalate");
  });

  void it("the sorted work list leaves both out of the round, each with its own reason", () => {
    const blockers = parseReviewBlockersDetailed(REVIEW).blockers;
    const list = buildBlockerWorkListV1({ blockers, planOfRecord: "- [ ] Step 1: x", plateauRounds: 4 });
    assert.equal(list.fixFirst.length, 1);
    const reasons = list.notThisRound.map((item) => item.reason);
    assert.equal(reasons.length, 2);
    assert.ok(reasons.some((reason) => /bounded out-of-plan fix/.test(reason)));
    assert.ok(reasons.some((reason) => /no code change resolves it/.test(reason)));
  });

  void it("the rubric names both resolvers and tells a reviewer who cannot tell to use environmental-fixable", () => {
    const rubric = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../resources/prompts/review-scoring-rubric.md"), "utf8");
    assert.match(rubric, /`environmental-fixable`/);
    assert.match(rubric, /If you cannot tell whether `environmental` or `environmental-fixable` applies, file `environmental-fixable`/);
    assert.match(rubric, /no code change resolves it/);
  });
});
