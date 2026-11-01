/**
 * bugs4 Step 32 (item 31): a fix round that ended because its model chain is out of quota,
 * payment-blocked or unauthenticated recommends a different Publish model, never a re-run of
 * the checks it just failed, and the 402 text is readable (no mid-word cut, remedy once).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFixChainBlockV1 } from "../utils/lintFixChainBlockV1";
import { cancelledFixHandbackV1, decideFixHandbackV1, describeFixChainBlockV1 } from "../utils/lintFixHandbackPolicyV1";
import { classifyFailure, paymentRequiredMessageV1 } from "../utils/quota";

// The captured Publish fix-round failure, as the provider worded it.
const CAPTURED_402 =
  "devpass-code hit a usage limit: HTTP 402 payment required: devpass-code CLI failed: APIError: You've reached the daily pacing " +
  "allowance on the lite plan. Upgrade for a higher daily allowance, or wait for the window to roll over — resets in 22 hours. " +
  "Enable pay-as-you-go overflow in your DevPass dashboard. Add credits or choose a free model.";

void describe("classifyFixChainBlockV1", () => {
  void it("reads the captured HTTP 402 as payment-required", () => {
    assert.equal(classifyFixChainBlockV1(CAPTURED_402), "payment-required");
  });

  void it("reads a usage-limit reply as quota and an expired sign-in as auth", () => {
    assert.equal(classifyFixChainBlockV1("Codex hit its 5-hour usage limit; try again later"), "quota");
    assert.equal(classifyFixChainBlockV1("Unauthorized: this API token is not active (HTTP 401)"), "auth");
  });

  void it("returns undefined for an ordinary failure or no message, so the normal yield rule applies", () => {
    assert.equal(classifyFixChainBlockV1("The model produced an empty patch"), undefined);
    assert.equal(classifyFixChainBlockV1(undefined), undefined);
    assert.equal(classifyFixChainBlockV1("   "), undefined);
  });
});

void describe("decideFixHandbackV1 with a chain-level block", () => {
  void it("recommends choosing a different model, and says re-running checks would repeat the failure", () => {
    const decision = decideFixHandbackV1(undefined, "payment-required");
    assert.equal(decision.recommended, "chooseModel");
    assert.match(decision.reason, /account needs credits/);
    assert.match(decision.reason, /Choose a different Publish model/);
    assert.match(decision.reason, /re-running Publish Checks would repeat/);
  });

  void it("names each kind of block in plain words", () => {
    assert.match(describeFixChainBlockV1("quota"), /out of quota/);
    assert.match(describeFixChainBlockV1("auth"), /sign-in/);
  });

  void it("without a block the existing progress rule still applies (control)", () => {
    assert.equal(decideFixHandbackV1(undefined).recommended, "fixAgain");
  });
});

void describe("paymentRequiredMessageV1", () => {
  void it("keeps the provider's reset time once and the remedy once, with no double full stop", () => {
    const text = paymentRequiredMessageV1(CAPTURED_402);
    assert.equal((text.match(/Add credits or choose a free model/g) ?? []).length, 1, text);
    assert.equal((text.match(/resets in 22 hours/g) ?? []).length, 1, text);
    assert.doesNotMatch(text, /\.\./);
    assert.match(text, /^HTTP 402 payment required: /);
  });

  void it("does not stack the wrapper when a message is classified twice", () => {
    const once = paymentRequiredMessageV1("Insufficient account funds (status 402)");
    assert.equal(paymentRequiredMessageV1(once), once);
  });

  void it("classifyFailure uses it for a 402 and keeps the payment-required kind", () => {
    const classified = classifyFailure({ errorMessage: CAPTURED_402 });
    assert.equal(classified.failureKind, "payment-required");
    assert.equal((classified.errorMessage?.match(/Add credits or choose a free model/g) ?? []).length, 1);
  });
});

void describe("cancelledFixHandbackV1 (bugs4 item 31: cancelled endings use the left-failing card)", () => {
  void it("a cancel after checks were seen failing passes leftFailing, and says they were not re-verified", () => {
    const handback = cancelledFixHandbackV1(" No changed files were reported.", true);
    assert.notEqual(handback.leftFailing, undefined);
    assert.match(handback.noticeText, /have not been re-verified/);
    assert.doesNotMatch(handback.noticeText, /then run Publish Checks/);
    // With no measured progress the left-failing rule recommends another fix round, not a re-run.
    assert.equal(decideFixHandbackV1(handback.leftFailing?.progress).recommended, "fixAgain");
  });

  void it("a cancel before any check failed keeps the plain Publish Checks hand-back (control)", () => {
    const handback = cancelledFixHandbackV1(" No changed files were reported.", false);
    assert.equal(handback.leftFailing, undefined);
    assert.match(handback.noticeText, /run Publish Checks to verify/);
  });
});
