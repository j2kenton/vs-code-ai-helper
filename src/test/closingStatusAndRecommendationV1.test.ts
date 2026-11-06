/**
 * review1 Step 42 (owner, 2026-11-04; bugs6 item 19): closing status lines raise no card, and a deviation card
 * recommends Approve only when the review verified it.
 */
import * as assert from "node:assert/strict";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { describe, it } from "node:test";
import {
  isNoneItemTextV1,
  parseOwnerDecisionsNeededV1,
  parsePlanDeviationsV1,
  reviewAffirmsStepVerifiedV1,
} from "../utils/reviewReadiness";
import { splitSummaryAtEchoV1 } from "../utils/implementationChecklist";
import { postOwnerPlanDecisionCardV1 } from "../commands/ownerPlanDecisionCommandV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function makeExtensionContext(): vscode.ExtensionContext {
  const memento = new FakeMemento();
  return {
    workspaceState: memento as unknown as vscode.Memento,
    globalState: memento as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

// The shape of runs/050-claude-cli-impl.md's "## Plan deviations": one real deviation, then a closing line.
const RUN_050 = [
  "## Plan deviations",
  "- **Step 43 applies without a card.** The plan says to apply a verified narrowing \"the way verified ticks are applied\", and also that the owner card is raised only when the reviewer can't verify it. They are written directly, with a chat line naming the item and the evidence.",
  "- Otherwise none.",
  "",
  "## Plan Item Checklist",
  "- Step 4: done",
].join("\n");

void describe("review1 Step 42: closing status lines raise no card (bugs6 item 19 replay)", () => {
  void it("runs/050 raises 1 deviation card, not 2", () => {
    const cards = parsePlanDeviationsV1(RUN_050, { roundName: "Apply Review" });
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.problem, /Step 43 applies without a card/);
  });

  void it("closing lines raise no card wherever none or nothing falls", () => {
    for (const line of ["Otherwise none.", "Nothing else.", "No other deviations.", "That is all.", "**Everything else: none.**"]) {
      const section = `## Plan deviations\n- ${line}\n`;
      assert.equal(parsePlanDeviationsV1(section).length, 0, line);
      assert.equal(isNoneItemTextV1(line), true, line);
    }
    const decisions = ["## Owner decisions needed", "", "Nothing else.", ""].join("\n");
    assert.equal(parseOwnerDecisionsNeededV1(decisions).length, 0);
  });

  void it("a real departure that names a step or code is never swallowed as a closing line", () => {
    assert.equal(isNoneItemTextV1("Step 3 ran none of the new tests."), false);
    assert.equal(isNoneItemTextV1("`foo.ts` was left empty, which is a long explanation of a real change to the plan."), false);
  });
});

void describe("review1 Step 42: a deviation card recommends Approve only when the review verified it", () => {
  void it("a deviation that drops an owner sign-off recommends Reject, with that reason", () => {
    const [card] = parsePlanDeviationsV1(RUN_050, { roundName: "Apply Review" });
    assert.equal(card!.recommendation?.optionId, "reject-deviation");
    assert.match(card!.recommendation?.reason ?? "", /owner sign-off|plan scope/);
    assert.equal(card!.noRecommendationReason, undefined);
  });

  void it("a deviation the latest review verified recommends Approve with 'verified by the review'", () => {
    const section = "## Plan deviations\n- Step 18 is built through the shared renderer, not a new one.\n";
    const review = "Step 18 is verified complete: the shared renderer is an accepted alternate mechanism.";
    const plan = "- [ ] Step 18: Make the post-review dispatch single.\n";
    const [card] = parsePlanDeviationsV1(section, { roundName: "Apply Review", planOfRecord: plan, latestReviewText: review });
    assert.equal(card!.recommendation?.optionId, "approve-deviation");
    assert.match(card!.recommendation?.reason ?? "", /verified by the review/i);
  });

  void it("a review that says the step is NOT verified is not a verification (negation, 'unverified')", () => {
    const section = "## Plan deviations\n- Step 43 narrowings are written with no card.\n";
    const plan = "- [ ] Step 43: Let the reviewer verify narrowings.\n";
    for (const review of [
      "Step 43 is not verified; keep the plan.",
      "The review has not verified Step 43.",
      "Step 43 stays unverified.",
      "Step 43 was never accepted.",
    ]) {
      const [card] = parsePlanDeviationsV1(section, { roundName: "Apply Review", planOfRecord: plan, latestReviewText: review });
      assert.notEqual(card!.recommendation?.optionId, "approve-deviation", review);
      assert.equal(card!.recommendation?.optionId, "reject-deviation", review);
    }
    // Describing a mechanism, or verifying only part of the step, is not accepting the departure (review1 Step 42).
    for (const review of [
      "Step 43 uses an alternate mechanism and still needs owner approval.",
      "Step 43 is verified for the tick path, but the narrowing differs from the plan.",
      "Step 43 is only partly accepted.",
    ]) {
      assert.equal(reviewAffirmsStepVerifiedV1(review, 43), false, review);
    }
    assert.equal(reviewAffirmsStepVerifiedV1("Step 43 is verified complete.", 43), true);
    assert.equal(reviewAffirmsStepVerifiedV1("Step 430 is verified complete.", 43), false);
  });

  void it("verifying an unrelated aspect of the same step does not verify this departure (review1 Step 42)", () => {
    const section = "## Plan deviations\n- Step 43 narrowings are written with no card.\n";
    const plan = "- [ ] Step 43: Let the reviewer verify narrowings.\n";
    const review = [
      "Step 43's tick path is verified.",
      "The no-card narrowing is not acceptable: it skips the owner sign-off.",
    ].join("\n");
    const [card] = parsePlanDeviationsV1(section, { roundName: "Apply Review", planOfRecord: plan, latestReviewText: review });
    assert.notEqual(card!.recommendation?.optionId, "approve-deviation");
    assert.match(card!.problem, /has not verified it/);
    // The unrelated sentence alone does not talk about the departure either.
    assert.equal(reviewAffirmsStepVerifiedV1("Step 43's tick path is verified.", 43, "narrowings are written with no card"), false);
    // A sentence about the departure itself does verify it, and "no-card" is not a negation.
    assert.equal(
      reviewAffirmsStepVerifiedV1("Step 43's no-card narrowing is verified against the plan text.", 43, "narrowings are written with no card"),
      true
    );
  });

  void it("a Plan deviations section placed before Plan Item Checklist is the round's own text when the plan has no such heading (review1 Step 12)", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Step 43: Let the reviewer verify narrowings.",
      "- [ ] Step 44: Gather owner evidence.",
      "",
    ].join("\n");
    const response = [
      plan,
      "## Plan deviations",
      "- Step 43 narrowings are written with no card.",
      "",
      "## Plan Item Checklist",
      "- Step 43: Let the reviewer verify narrowings. — done — src/x.ts:1",
      "",
      "## Files Changed",
      "- src/x.ts",
      "",
    ].join("\n");
    // Without the plan the heading-only fallback stops at Plan Item Checklist and the section is swallowed.
    const own = splitSummaryAtEchoV1(response, plan).own;
    assert.match(own, /## Plan deviations/);
    const cards = parsePlanDeviationsV1(own, { roundName: "Apply Review", planOfRecord: plan });
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.problem, /Step 43 narrowings/);
  });

  void it("a later sentence that leaves the departure waiting on the owner outweighs an earlier related verification (review1 Step 42)", () => {
    const departure = "Step 43 narrowings are written with no card";
    const review = "Step 43's narrowing card text is verified. The no-card narrowing still needs owner approval.";
    assert.equal(reviewAffirmsStepVerifiedV1(review, 43, departure), false);
    for (const pending of [
      "The no-card narrowing is awaiting your sign-off.",
      "Owner approval is still required for the narrowing.",
      "The narrowing is pending an owner decision.",
    ]) {
      assert.equal(
        reviewAffirmsStepVerifiedV1(`Step 43's narrowing card text is verified. ${pending}`, 43, departure),
        false,
        pending
      );
    }
    const section = `## Plan deviations\n- ${departure}.\n`;
    const plan = "- [ ] Step 43: Let the reviewer verify narrowings.\n";
    const [card] = parsePlanDeviationsV1(section, { roundName: "Apply Review", planOfRecord: plan, latestReviewText: review });
    assert.notEqual(card!.recommendation?.optionId, "approve-deviation");
    // Without a pending sentence, a sentence about the omission itself still verifies the departure.
    assert.equal(
      reviewAffirmsStepVerifiedV1("Step 43's no-card narrowing is verified against the plan text.", 43, departure),
      true
    );
    assert.equal(
      reviewAffirmsStepVerifiedV1("Step 43: skipping the card for narrowings is accepted by this review.", 43, departure),
      true
    );
  });

  void it("verifying the words a departure shares with the review is not accepting that it leaves something out (review1 Step 42)", () => {
    const departure = "Step 43 narrowings are written with no card";
    // The review verifies the card's text; the departure is that there is no card at all.
    assert.equal(reviewAffirmsStepVerifiedV1("Step 43's narrowing card text is verified.", 43, departure), false);
    assert.equal(reviewAffirmsStepVerifiedV1("Step 43: the narrowing card is verified.", 43, departure), false);
    // An omission cue elsewhere in the sentence, not next to the card, does not say the card was left out.
    for (const unrelated of [
      "Step 43's narrowing card text is verified without changes.",
      "Step 43's narrowing card is verified, and no wording was altered.",
      "Step 43: with no further edits, the narrowing card is accepted.",
      "Step 43's narrowing is verified without any card text changes.",
    ]) {
      assert.equal(reviewAffirmsStepVerifiedV1(unrelated, 43, departure), false, unrelated);
    }
    const section = `## Plan deviations\n- ${departure}.\n`;
    const plan = "- [ ] Step 43: Let the reviewer verify narrowings.\n";
    const [card] = parsePlanDeviationsV1(section, {
      roundName: "Apply Review",
      planOfRecord: plan,
      latestReviewText: "Step 43's narrowing card text is verified.",
    });
    assert.notEqual(card!.recommendation?.optionId, "approve-deviation");
    // A departure that leaves nothing out is still verified by shared wording alone.
    assert.equal(
      reviewAffirmsStepVerifiedV1("Step 18's helper placement in the new file is verified.", 18, "Step 18 helper lives in a new file instead of the existing one"),
      true
    );
  });

  void it("an unchecked deviation recommends neither option and says the review has not checked it", async () => {
    const section = "## Plan deviations\n- The helper lives in a new file instead of the existing one.\n";
    const [card] = parsePlanDeviationsV1(section, { roundName: "Apply Review", latestReviewText: "Readiness: 8/10" });
    assert.equal(card!.recommendation, undefined);
    assert.match(card!.noRecommendationReason ?? "", /not checked/);
    assert.match(card!.problem, /has not verified it/);

    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "dev-no-recommendation");
    const posted = await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: "impl-high-review", block: card! });
    assert.equal(posted?.recommendation.kind, "none");
  });
});
