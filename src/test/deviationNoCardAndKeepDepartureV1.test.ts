/**
 * review2 Steps 37, 39, 40 (Part 8; bugs6 items 17, 19, 6): bullets that must not become deviation cards, a restated
 * owner decision as a chat line, status sentences kept off the card, a review blocker on a deviation's step, and a
 * keep-the-departure recommendation that has to cite a file and line.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  ownerDecisionsSectionTextV1,
  parseOwnerDecisionsNeededV1,
  parsePlanDeviationsV1,
  planDeviationNoCardReasonV1,
  planDeviationSideNotesV1,
  restatedOwnerDecisionLineV1,
  splitDeviationStatusSentencesV1,
} from "../utils/reviewReadiness";

const PLAN = [
  "- [ ] Step 22 — wait centrally",
  "- [ ] Step 24 — check admission",
  "- [ ] Step 34 — run the checks",
  "- [ ] Step 47 — parser and rubric",
  "- [ ] Step 48 — the owner card",
].join("\n");

function section(...bullets: string[]): string {
  return ["## Files Changed", "", "- a.ts", "", "## Plan deviations", "", ...bullets, ""].join("\n");
}

void describe("deviation bullets that raise no card (review2 Step 37)", () => {
  void it("replays runs/020: one card per top-level bullet, sub-bullets in its body, notes skipped (2 cards, not 8)", () => {
    const content = section(
      "- **Step 34 runs the checks through `collectCompletionLintPreview`…**",
      "  - Why: the runner is shared.",
      "  - What changed: the lint preview is called directly.",
      "  - Trade-off: no per-check override.",
      "- **A recorded test report does not clear an item by itself.** It also needs the item's claim.",
      "- Backup retries: the earlier deviation is withdrawn.",
      "- The plan's own deviations still stand."
    );
    const cards = parsePlanDeviationsV1(content, { planOfRecord: PLAN });
    assert.equal(cards.length, 2);
    assert.match(cards[0]!.problem, /Why: the runner is shared/);
  });

  void it("a note that a step was split as the plan says (runs/055 Step 47) raises no card", () => {
    const bullet =
      '- **Step 47 is parser, routing and rubric only.** The immediate owner card with "Investigate it for me" is Step 48.';
    assert.equal(planDeviationNoCardReasonV1(bullet.slice(2)), "step-split");
    assert.equal(parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN }).length, 0);
  });

  void it("progress reports on planned work raise no card, and the unbuilt part stays open work", () => {
    const partly = "- **Step 8 is only partly built.**\n  - Done: the budget.\n  - Not done: the dispatch.";
    const notStarted = "- **Step 14 is still required work.** I did not start it.";
    const follows = "- **Step 7:** the final text now takes the first successful `result` event's text, which follows the plan.";
    for (const bullet of [partly, notStarted, follows]) {
      assert.equal(parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN }).length, 0, bullet);
    }
    assert.equal(planDeviationNoCardReasonV1(partly.slice(2)), "progress");
    assert.equal(planDeviationNoCardReasonV1(notStarted.slice(2)), "progress");
    assert.equal(planDeviationNoCardReasonV1(follows.slice(2)), "follows-plan");
  });

  void it("'Otherwise none.' raises no card", () => {
    assert.equal(parsePlanDeviationsV1(section("- Otherwise none."), { planOfRecord: PLAN }).length, 0);
  });

  void it("a real departure is never taken for a note", () => {
    const real = "- **Step 24 built in a different place.** The plan says `workAdmissionV1.ts`; I added the check in `TaskOperationRegistry.begin` instead.";
    assert.equal(planDeviationNoCardReasonV1(real.slice(2)), undefined);
    assert.equal(parsePlanDeviationsV1(section(real), { planOfRecord: PLAN }).length, 1);
    const onlyWithSubstitution = "- **Step 43 is only the verified ones.** They are written directly instead of through a card; Step 53 says otherwise.";
    assert.equal(planDeviationNoCardReasonV1(onlyWithSubstitution.slice(2)), undefined);
  });
});

void describe("a bullet that restates an owner decision is a chat line (review2 Step 37)", () => {
  const taskMd = [
    "## Owner decisions",
    "",
    "### 2026-11-07 16:03 — step-22-waiting",
    "Owner's answer: central waiting rather than stateLockRetryV1 by name is fine for Step 22.",
    "",
  ].join("\n");
  const bullet =
    "- **Step 22 and its acceptance line.** Central waiting rather than `stateLockRetryV1` by name is owner-approved. The wording of the Step 22 acceptance line is not re-litigated.";

  void it("yields 'Following your decision of 16:03: …' and no card", () => {
    const decisions = ownerDecisionsSectionTextV1(taskMd);
    const line = restatedOwnerDecisionLineV1(bullet.slice(2), decisions);
    assert.ok(line !== undefined);
    assert.match(line, /^Following your decision of 16:03: /);
    assert.equal(parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN, ownerDecisionsText: decisions }).length, 0);
    assert.equal(planDeviationSideNotesV1(section(bullet), { ownerDecisionsText: decisions }).followingDecisionLines.length, 1);
  });

  void it("takes the stamp from the matched decision, not the newest entry of the section", () => {
    const newestFirst = [
      "## Owner decisions",
      "",
      "### 2026-11-09 — plan-deviation-5ad29e3b",
      "Blocker answered: Part 4 item 5 file access. Owner's answer: Approve plan deviation",
      "",
      "### 2026-11-07 16:03 — step-22-waiting",
      "Owner's answer: central waiting rather than stateLockRetryV1 by name is fine for Step 22.",
      "",
    ].join("\n");
    const line = restatedOwnerDecisionLineV1(bullet.slice(2), ownerDecisionsSectionTextV1(newestFirst));
    assert.ok(line !== undefined);
    assert.match(line, /^Following your decision of 16:03: /);
    // Bulleted entries (no headings) are split per bullet as well.
    const bulleted = [
      "## Owner decisions",
      "- Owner decision 2026-11-09: Approve plan deviation (plan-deviation-5ad29e3b)",
      "- Owner decision 2026-11-07: central waiting is fine for Step 22",
    ].join("\n");
    const bulletedLine = restatedOwnerDecisionLineV1(bullet.slice(2), ownerDecisionsSectionTextV1(bulleted));
    assert.ok(bulletedLine !== undefined);
    assert.match(bulletedLine, /^Following your decision of 2026-11-07: /);
  });

  void it("is not restated when only an unrelated decision is recorded", () => {
    const unrelated = ["## Owner decisions", "", "### 2026-11-09 — other", "Owner's answer: Approve plan deviation for Step 5.", ""].join("\n");
    assert.equal(restatedOwnerDecisionLineV1(bullet.slice(2), ownerDecisionsSectionTextV1(unrelated)), undefined);
  });

  void it("is still a card when nothing recorded covers it", () => {
    assert.equal(restatedOwnerDecisionLineV1(bullet.slice(2), undefined), undefined);
    assert.equal(parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN }).length, 1);
  });
});

void describe("status sentences stay off the card (review2 Step 37)", () => {
  const bullet =
    "- **Step 24 built in a different place.** I added the check in `TaskOperationRegistry.begin` instead. Reported under Verified Complete rather than ticked.";

  void it("moves the sentence to the round's summary and keeps the question on the card", () => {
    const split = splitDeviationStatusSentencesV1(bullet.slice(2));
    assert.deepEqual(split.statusNotes, ["Reported under Verified Complete rather than ticked."]);
    const [card] = parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN });
    assert.ok(card);
    assert.doesNotMatch(card.problem, /rather than ticked/);
    assert.match(card.problem, /TaskOperationRegistry\.begin/);
    assert.deepEqual(planDeviationSideNotesV1(section(bullet), {}).summaryNotes, ["Reported under Verified Complete rather than ticked."]);
  });
});

void describe("a deviation the latest review holds as a blocker (review2 Step 39)", () => {
  const bullet = "- **Step 24 built in a different place.** I added the check in `TaskOperationRegistry.begin` instead.";
  const review = [
    "Readiness: 6/10",
    "<!-- blockers:start -->",
    "- [completion] [task-fixable] Step 24 is partial: the registry permits code-changing children.",
    "<!-- blockers:end -->",
  ].join("\n");

  void it("recommends Reject and quotes the blocker", () => {
    const [card] = parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN, latestReviewText: review });
    assert.ok(card);
    assert.equal(card.recommendation?.optionId, "reject-deviation");
    assert.match(card.recommendation?.reason ?? "", /registry permits code-changing children/);
    assert.match(card.problem, /holds this as a blocker/);
    assert.doesNotMatch(card.problem, /has not verified it/);
  });

  void it("a review with no blocker on that step keeps the earlier behaviour (no recommendation)", () => {
    const other = review.replace("Step 24", "Step 30");
    const [card] = parsePlanDeviationsV1(section(bullet), { planOfRecord: PLAN, latestReviewText: other });
    assert.ok(card);
    assert.equal(card.recommendation, undefined);
  });
});

void describe("a keep-the-departure recommendation has to cite a file and line (review2 Step 40)", () => {
  function block(recommendation: string): string {
    return [
      "## Owner decisions needed",
      "",
      "### step-38-publish-anyway-stage",
      "Plan purpose: no override before Publish.",
      "Problem: the round kept an override at the code-review stages.",
      "Options:",
      "- Accept the code-review override — keeps the button",
      "- Keep the plan — removes the button before Publish",
      `Recommendation: ${recommendation}`,
      "",
    ].join("\n");
  }

  void it("a reason with no file:line moves the recommendation to 'Keep the plan'", () => {
    const [parsed] = parseOwnerDecisionsNeededV1(block("Accept the code-review override. The implementation says the gate relies on it."));
    assert.ok(parsed);
    assert.equal(parsed.recommendation?.optionId, "keep-the-plan");
    assert.match(parsed.recommendation?.reason ?? "", /cited no file and line/);
  });

  void it("a reason that cites a file and line keeps the reviewer's recommendation", () => {
    const [parsed] = parseOwnerDecisionsNeededV1(
      block("Accept the code-review override. src/actions/rows/commitPushMetadataRowV1.ts:139 shows the gate reads it at this stage.")
    );
    assert.ok(parsed);
    assert.equal(parsed.recommendation?.optionId, "accept-the-code-review-override");
  });

  void it("a recommendation of 'Keep the plan' is untouched", () => {
    const [parsed] = parseOwnerDecisionsNeededV1(block("Keep the plan. The owner already approved it."));
    assert.equal(parsed?.recommendation?.optionId, "keep-the-plan");
  });
});

void describe("the review prompts ask for checked recommendations and a proposed rule (review2 Steps 35 and 40)", () => {
  const dir = path.resolve(__dirname, "../../resources/prompts");
  for (const file of ["review-impl-high.md", "review-impl-low.md", "review-impl-high-rereview.md", "review-impl-low-rereview.md"]) {
    void it(`${file} requires file:line for a keep-the-departure reason and a proposed rule for a blocker raised twice`, () => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      assert.match(text, /Name the file and line \(`path\/file\.ts:123`\)/);
      assert.match(text, /the round's claim, unchecked/);
      assert.match(text, /the recommendation is "Keep the plan"/);
      assert.match(text, /A blocker raised twice/);
      assert.match(text, /## Owner decisions` records a rule for a blocker/);
    });
  }

  void it("the Apply Review prompt treats a recorded owner rule as the blocker's specification", () => {
    const text = fs.readFileSync(path.join(dir, "apply-impl-review-code.md"), "utf8");
    assert.match(text, /that rule is the specification for that blocker/);
  });
});
