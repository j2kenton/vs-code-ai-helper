/**
 * Coverage for the provider selection policy (plan §3.3):
 *  - selection is split from invocation — the session only issues identities
 *    and reservations;
 *  - every attempt is globally unique, gets exactly one reservation, and
 *    reservations are claim-once and invocation-once (AC-RUNNER-03);
 *  - attempt outcomes are reported exactly once, and only pre-response
 *    outcomes leave the session open for an explicit fallback reservation
 *    (AC-RUNNER-05);
 *  - simultaneous sessions never share a complete correlation tuple
 *    (AC-ID-01/02).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateHex128IdV1, isHex128IdV1 } from "../types/actionCorrelationV1";
import {
  AttemptOutcomeKindV1,
  FALLBACK_ELIGIBLE_ATTEMPT_OUTCOMES_V1,
  openProviderSelectionSessionV1,
  ProviderSelectionPolicyErrorV1,
  ProviderSelectionSessionV1,
} from "../services/providerSelectionPolicyV1";

function openSession(): ProviderSelectionSessionV1 {
  return openProviderSelectionSessionV1({
    actionKey: "generatePlan.v1",
    operationId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  });
}

function reserveNextAttempt(session: ProviderSelectionSessionV1): {
  attemptId: string;
  reservationId: string;
} {
  const attemptId = session.allocateAttempt();
  const handle = session.reserve({
    attemptId,
    mode: "text",
    runnerId: "copilot-lm",
    providerId: "copilot",
    modelId: "copilot:gpt",
  });
  return { attemptId, reservationId: handle.reservationId };
}

void describe("providerSelectionPolicyV1", () => {
  void it("rejects opening a session without a well-formed operation id or binding", () => {
    assert.throws(
      () =>
        openProviderSelectionSessionV1({
          actionKey: "generatePlan.v1",
          operationId: "not-hex",
          taskBindingId: "b",
          chatDocumentId: "c",
        }),
      ProviderSelectionPolicyErrorV1
    );
    assert.throws(
      () =>
        openProviderSelectionSessionV1({
          actionKey: "",
          operationId: allocateHex128IdV1(),
          taskBindingId: "b",
          chatDocumentId: "c",
        }),
      ProviderSelectionPolicyErrorV1
    );
  });

  void it("issues well-formed, distinct session/attempt/reservation identities", () => {
    const session = openSession();
    assert.ok(isHex128IdV1(session.selectionSessionId));
    const attemptId = session.allocateAttempt();
    assert.ok(isHex128IdV1(attemptId));
    const handle = session.reserve({
      attemptId,
      mode: "text",
      runnerId: "copilot-lm",
      providerId: "copilot",
      modelId: "copilot:gpt",
    });
    assert.ok(isHex128IdV1(handle.reservationId));
    assert.notEqual(handle.reservationId, attemptId);
    assert.notEqual(handle.reservationId, session.binding.operationId);
    assert.equal(handle.selectionSessionId, session.selectionSessionId);
    assert.deepEqual(handle.correlation, {
      actionKey: "generatePlan.v1",
      operationId: session.binding.operationId,
      attemptId,
      taskBindingId: "task-binding-digest",
      chatDocumentId: "chat-document-id",
    });
  });

  void it("issues exactly one reservation per attempt and never revisits it", () => {
    const session = openSession();
    const attemptId = session.allocateAttempt();
    const input = {
      attemptId,
      mode: "text" as const,
      runnerId: "copilot-lm",
      providerId: "copilot",
      modelId: "copilot:gpt",
    };
    session.reserve(input);
    assert.throws(() => session.reserve(input), /exactly one reservation/);
  });

  void it("rejects reservations for attempts it did not allocate", () => {
    const session = openSession();
    assert.throws(
      () =>
        session.reserve({
          attemptId: allocateHex128IdV1(),
          mode: "text",
          runnerId: "copilot-lm",
          providerId: "copilot",
          modelId: "copilot:gpt",
        }),
      /must be allocated by this session/
    );
  });

  void it("claims a reservation exactly once and invokes it exactly once", () => {
    const session = openSession();
    const { reservationId } = reserveNextAttempt(session);
    const claimed = session.claim(reservationId);
    assert.throws(() => session.claim(reservationId), /claim-once/);
    claimed.beginInvocation();
    assert.throws(() => claimed.beginInvocation(), /invocation-once/);
  });

  void it("reports an attempt outcome exactly once", () => {
    const session = openSession();
    const { attemptId } = reserveNextAttempt(session);
    session.reportAttemptOutcome(attemptId, "transportFailurePreResponse");
    assert.throws(
      () => session.reportAttemptOutcome(attemptId, "completed"),
      /exactly once/
    );
  });

  void it("refuses a new attempt while the previous attempt has no reported outcome", () => {
    const session = openSession();
    reserveNextAttempt(session);
    assert.throws(() => session.allocateAttempt(), /no reported outcome/);
  });

  void it("allows an explicit fallback reservation only after a pre-response outcome", () => {
    const session = openSession();
    const first = reserveNextAttempt(session);
    session.reportAttemptOutcome(first.attemptId, "transportFailurePreResponse");
    assert.equal(session.isTerminated(), false);

    const second = reserveNextAttempt(session);
    assert.notEqual(second.attemptId, first.attemptId);
    assert.notEqual(second.reservationId, first.reservationId);
    session.reportAttemptOutcome(second.attemptId, "providerUnavailablePreInvocation");
    assert.equal(session.isTerminated(), false);

    const third = reserveNextAttempt(session);
    session.reportAttemptOutcome(third.attemptId, "completed");
    assert.equal(session.isTerminated(), true);
    assert.throws(() => session.allocateAttempt(), /closed/);
  });

  void it("treats every non-pre-response outcome as terminal", () => {
    const terminalOutcomes: AttemptOutcomeKindV1[] = [
      "completed",
      "questions",
      "providerDeclaredFailure",
      "malformedResult",
      "resultCorrelationMismatch",
      "overflow",
      "providerCancelled",
      "callerCancelled",
      "transportFailureResponseStarted",
    ];
    for (const outcome of terminalOutcomes) {
      assert.equal(
        FALLBACK_ELIGIBLE_ATTEMPT_OUTCOMES_V1.has(outcome),
        false,
        `${outcome} must not be fallback-eligible`
      );
      const session = openSession();
      const { attemptId } = reserveNextAttempt(session);
      session.reportAttemptOutcome(attemptId, outcome);
      assert.equal(session.isTerminated(), true, `${outcome} must terminate the session`);
      assert.throws(() => session.allocateAttempt(), ProviderSelectionPolicyErrorV1);
      assert.throws(
        () =>
          session.reserve({
            attemptId,
            mode: "text",
            runnerId: "copilot-lm",
            providerId: "copilot",
            modelId: "copilot:gpt",
          }),
        ProviderSelectionPolicyErrorV1
      );
    }
  });

  void it("never allows a settled attempt's reservation to be claimed", () => {
    // The exact exploit from the implementation review: an attempt settles
    // with a fallback-eligible outcome (session stays open), a fallback
    // attempt is allocated — the FIRST attempt's reservation must now be
    // permanently dead, or one operation could run two live invocations.
    const session = openSession();
    const first = reserveNextAttempt(session);
    session.reportAttemptOutcome(first.attemptId, "providerUnavailablePreInvocation");
    assert.equal(session.isTerminated(), false, "a pre-response outcome keeps the session open");

    const second = reserveNextAttempt(session);
    assert.throws(() => session.claim(first.reservationId), /can never be claimed/);
    // The fallback attempt's own reservation is unaffected.
    session.claim(second.reservationId).beginInvocation();
  });

  void it("never allows a claimed reservation to begin invocation after its attempt settles", () => {
    const session = openSession();
    const first = reserveNextAttempt(session);
    const claimed = session.claim(first.reservationId);
    // Claimed before the attempt settled, invoked after: still dead.
    session.reportAttemptOutcome(first.attemptId, "transportFailurePreResponse");
    reserveNextAttempt(session);
    assert.throws(() => claimed.beginInvocation(), /can never be invoked/);
  });

  void it("keeps simultaneous sessions' correlation tuples distinct", () => {
    const a = openSession();
    const b = openSession();
    const attemptA = a.allocateAttempt();
    const attemptB = b.allocateAttempt();
    assert.notEqual(a.binding.operationId, b.binding.operationId);
    assert.notEqual(attemptA, attemptB);
    assert.notDeepEqual(a.correlationForAttempt(attemptA), b.correlationForAttempt(attemptB));
  });
});
