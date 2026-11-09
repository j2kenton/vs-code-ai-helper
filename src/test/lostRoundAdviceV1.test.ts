/**
 * run1 Step 15: the lost-editing-round card recommends "continue from the working tree" for a round
 * Ensemble stopped or a provider's per-turn cap cut short, and another model only for a failure that
 * will repeat on the same model.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLostEditingRoundCardPartsV1, failureWillRepeatV1 } from "../utils/lostRoundNextStepV1";

void describe("run1 plain words: the lost-round card never claims a limit without the provider's text", () => {
  const card = (failure: string | undefined) =>
    buildLostEditingRoundCardPartsV1({
      taskFolderPath: "/tmp/tasks/t",
      stage: "impl-high-review",
      lost: {
        roundId: "r1",
        mode: "apply-review",
        state: "quota-blocked",
        ...(failure !== undefined ? { failure } : {}),
        stage: "impl-high-review",
        fastForwardKnown: true,
      },
      continueLabel: "Continue",
      chainModels: ["claude-cli:claude-sonnet-5-5"],
    }).sentence;

  void it("a quota-blocked record with no provider text says no limit", () => {
    for (const text of [undefined, "  "]) {
      const sentence = card(text);
      assert.doesNotMatch(sentence, /usage limit|quota|rate limit/i);
      assert.match(sentence, /stopped by the provider/);
      assert.match(sentence, /Its edits are kept in the working tree/);
    }
  });

  void it("with the provider's text, the limit is named as the text says", () => {
    assert.match(card("You've hit your usage limit. Resets in 54m"), /hit a usage limit/);
    assert.match(card("Individual quota reached"), /hit a quota or rate limit/);
  });
});

void describe("run1 Step 15: failureWillRepeatV1", () => {
  void it("an Ensemble stop or a provider time cap is not a failure that will repeat", () => {
    for (const cause of ["ensembleBackstop", "ensembleIdleStop", "ensembleEndOfTurn", "providerTimeCap", "ensembleRepeatStop"]) {
      assert.equal(failureWillRepeatV1("failed", "Ensemble stopped the round.", cause), false, cause);
    }
  });

  void it("a stopped round that was changing files continues from the working tree", () => {
    assert.equal(failureWillRepeatV1("failed", "the 55-minute time limit", undefined, 3), false);
  });

  void it("a real usage limit still points at another model", () => {
    assert.equal(failureWillRepeatV1("quota-blocked", "You've hit your usage limit. Resets in 54m", "providerUsageLimit"), true);
    assert.equal(failureWillRepeatV1("failed", "Claude Code is not signed in: please log in"), true);
  });

  void it("an old row with only the time-limit text, no recorded cause and no attributed files, behaves as before", () => {
    assert.equal(failureWillRepeatV1("failed", "Antigravity turn limit: cut off after 55 minutes"), true);
  });
});
