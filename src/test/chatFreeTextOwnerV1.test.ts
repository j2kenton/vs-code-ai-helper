/**
 * bugs3 Step 8: a command-bound free-text question names the activation that
 * asked it, so a question left by an earlier activation (a reload ended the
 * command waiting on it) can be told apart and withdrawn.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ACTIVATION_ID_V1 } from "../utils/awaitedDecisionWaitersV1";
import {
  __resetChatFreeTextTestOnlyV1,
  chatFreeTextMarkerV1,
  chatFreeTextOwnerMarkerV1,
  isFreeTextQuestionFromEarlierActivationV1,
  parseChatFreeTextOwnerV1,
  registerChatFreeTextAnswerV1,
} from "../utils/chatFreeTextV1";

const ID = "0123456789abcdef0123456789abcdef";

function question(activationId: string | undefined): string {
  const owner = activationId === undefined ? "" : chatFreeTextOwnerMarkerV1(activationId);
  return `Owner evidence — ${chatFreeTextMarkerV1(ID)}${owner}\nPaste the output.`;
}

void describe("free-text question provenance", () => {
  afterEach(() => __resetChatFreeTextTestOnlyV1());

  void it("round-trips the owning activation", () => {
    assert.equal(parseChatFreeTextOwnerV1(question("11111111-2222-3333-4444-555555555555")), "11111111-2222-3333-4444-555555555555");
    assert.equal(parseChatFreeTextOwnerV1(question(undefined)), undefined);
  });

  void it("a question from another activation with no waiter is from an earlier activation", () => {
    assert.equal(isFreeTextQuestionFromEarlierActivationV1(question("11111111-2222-3333-4444-555555555555")), true);
  });

  void it("a question written before the owner was recorded counts as earlier too", () => {
    assert.equal(isFreeTextQuestionFromEarlierActivationV1(question(undefined)), true);
  });

  void it("this activation's own question is left alone", () => {
    assert.equal(isFreeTextQuestionFromEarlierActivationV1(question(ACTIVATION_ID_V1)), false);
  });

  void it("a question with a live waiter is never withdrawn, whoever recorded it", () => {
    registerChatFreeTextAnswerV1(ID, () => undefined);
    assert.equal(isFreeTextQuestionFromEarlierActivationV1(question("11111111-2222-3333-4444-555555555555")), false);
  });

  void it("ordinary chat questions without the answer marker are not command-bound", () => {
    assert.equal(isFreeTextQuestionFromEarlierActivationV1("What should the title be?"), false);
  });
});
