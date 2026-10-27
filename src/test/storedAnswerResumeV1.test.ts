/**
 * bugs2 finding 1: a Resume that does not settle names its real reason and
 * says the stored answer is kept — never the bare "failed to settle".
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeResumeFailureWithStoredAnswerV1,
  describeResumeNotSettledV1,
  STORED_ANSWER_KEPT_NOTE_V1,
} from "../utils/storedAnswerResumeV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

void describe("describeResumeNotSettledV1", () => {
  void it("names the concrete reason for every outcome shape instead of a generic failure", () => {
    assert.match(describeResumeNotSettledV1(undefined), /did not run/);
    assert.match(
      describeResumeNotSettledV1({ kind: "duplicateRejected", code: "operationAlreadyRunning" }),
      /another operation is already running/
    );
    assert.match(
      describeResumeNotSettledV1({ kind: "cancelled", code: "userCancelled" }),
      /cancelled before it finished/
    );
    assert.match(
      describeResumeNotSettledV1({ kind: "failed", code: "actionNotEligibleForStatus", retryable: false }),
      /the task is paused/
    );
    assert.match(
      describeResumeNotSettledV1({ kind: "failed", code: "providerQuota", retryable: false, detail: "HTTP 429" }),
      /failed \(providerQuota: HTTP 429\)/
    );
    assert.match(
      describeResumeNotSettledV1({ kind: "failed", code: "boom", retryable: true }),
      /failed \(boom\)/
    );
    const unavailable = { kind: "unavailable" } as unknown as TaskActionOutcomeV1;
    assert.match(describeResumeNotSettledV1(unavailable), /"unavailable"/);
  });

  void it("never produces the old bare wording", () => {
    for (const outcome of [undefined, { kind: "cancelled", code: "providerCancelled" } as TaskActionOutcomeV1]) {
      assert.doesNotMatch(describeResumeNotSettledV1(outcome), /failed to settle/);
    }
  });
});

void describe("describeResumeFailureWithStoredAnswerV1", () => {
  void it("keeps the reason and tells the user the answer is saved and does not need repeating", () => {
    const text = describeResumeFailureWithStoredAnswerV1("the task is paused.");
    assert.ok(text.startsWith("the task is paused. "), text);
    assert.ok(text.endsWith(STORED_ANSWER_KEPT_NOTE_V1));
    assert.match(text, /Confirm again/);
    assert.match(text, /do not need to answer again/);
    assert.doesNotMatch(text, /\.\./);
  });
});
