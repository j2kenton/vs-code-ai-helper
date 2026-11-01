/**
 * bugs4 item 13 (plan item 47/50): the no-progress breaker card agrees with the gate and the
 * review. After rounds that changed no files it never recommends Keep iterating or Back to
 * Implementation; a review at the pass mark recommends advancing unless an open item is genuinely
 * buildable; and it offers the reviewer-verified ticks when the review named every open item.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEscalationDecisionV1,
  recommendForBreakerCardV1,
  type BreakerCardContextV1,
} from "../utils/reviewEscalation";

const TARGET = { canonicalId: "/ws/.ensemble/t", taskFolderPath: "/ws/.ensemble/t", taskName: "Backup task" };

function breakerCard(context: BreakerCardContextV1, planItemsOpen = context.planItemsOpen) {
  return buildEscalationDecisionV1(
    "plateau",
    "impl-low-review",
    "3 consecutive implementation round(s) changed zero files and made no checklist progress (no-progress breaker).",
    TARGET,
    undefined,
    planItemsOpen,
    context
  );
}

void describe("no-progress breaker card (bugs4 items 13 / 47)", () => {
  void it("05:15 replay: items built and awaiting verification recommend Advance, not Keep iterating", () => {
    const card = breakerCard({
      zeroChangeRounds: 3,
      planItemsOpen: 5,
      reviewAffirmsOpenItemsBuilt: true,
      unclaimedOpenItems: 0,
    });
    assert.equal(card.recommendation?.kind, "option");
    assert.equal(card.recommendation && "optionId" in card.recommendation ? card.recommendation.optionId : undefined, "advance");
    assert.match(
      card.recommendation && "reasoning" in card.recommendation ? card.recommendation.reasoning : "",
      /3 implementation rounds in a row changed no files/
    );
    const recommended = card.recommendation && "optionId" in card.recommendation ? card.recommendation.optionId : "";
    assert.notEqual(recommended, "keepIterating");
    assert.notEqual(recommended, "buildRemaining");
  });

  void it("offers Apply Reviewer-Verified Ticks when the review named every open item as built", () => {
    const card = breakerCard({
      zeroChangeRounds: 3,
      planItemsOpen: 28,
      reviewAffirmsOpenItemsBuilt: true,
      unclaimedOpenItems: 0,
    });
    const option = card.options.find((o) => o.optionId === "applyReviewerVerifiedTicks");
    assert.ok(option, "the verified-ticks option must be offered");
    assert.equal(option.effect.kind === "command" ? option.effect.command : "", "vs-code-ai-helper.applyReviewerVerifiedTicks");
  });

  void it("does not offer the ticks when the review did not name the items", () => {
    const card = breakerCard({
      zeroChangeRounds: 3,
      planItemsOpen: 4,
      reviewAffirmsOpenItemsBuilt: false,
      unclaimedOpenItems: 0,
    });
    assert.equal(card.options.some((o) => o.optionId === "applyReviewerVerifiedTicks"), false);
  });

  void it("an open item with no claim and no review confirmation is genuinely buildable: the owner decides, nothing iterates", () => {
    const recommendation = recommendForBreakerCardV1(
      { zeroChangeRounds: 3, planItemsOpen: 6, reviewAffirmsOpenItemsBuilt: false, unclaimedOpenItems: 2 },
      "Publish"
    );
    assert.equal(recommendation.kind === "option" ? recommendation.optionId : undefined, "handleMyself");
    assert.match(recommendation.kind === "option" ? recommendation.reasoning : "", /More automated rounds will not edit anything/);
  });

  void it("with no open items the review's pass mark recommends Advance", () => {
    const recommendation = recommendForBreakerCardV1(
      { zeroChangeRounds: 4, planItemsOpen: 0, reviewAffirmsOpenItemsBuilt: false, unclaimedOpenItems: 0 },
      "Publish"
    );
    assert.equal(recommendation.kind === "option" ? recommendation.optionId : undefined, "advance");
  });

  void it("states the gate's own count once, so the card, the review and the Tasks pane read the same numbers (item 48/49)", () => {
    const note = "28 open, of which 8 are owner hand-offs; 97 ticked, 8 verified by review, 89 awaiting review verification.";
    const card = breakerCard({
      zeroChangeRounds: 3,
      planItemsOpen: 28,
      reviewAffirmsOpenItemsBuilt: true,
      unclaimedOpenItems: 0,
      gateCountNote: note,
    });
    const gate = card.evidence?.find((item) => item.label.includes("gate's count"));
    assert.equal(gate?.detail, note);
    assert.equal(
      breakerCard({ zeroChangeRounds: 3, planItemsOpen: 0, reviewAffirmsOpenItemsBuilt: false, unclaimedOpenItems: 0 }).evidence,
      undefined
    );
  });

  void it("control: a card not raised by the breaker keeps the original recommendation", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-low-review", "stuck", TARGET, undefined, 0);
    assert.equal(card.recommendation && "optionId" in card.recommendation ? card.recommendation.optionId : undefined, "keepIterating");
  });
});
