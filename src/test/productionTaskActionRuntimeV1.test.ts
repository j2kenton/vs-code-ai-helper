/**
 * Coverage for `withMalformedResultRetryV1` (productionTaskActionRuntimeV1.ts)
 * — the fix for a real bug: a model's malformed/unframed response used to
 * fail the whole action outright. Malformed output is deliberately TERMINAL
 * within one provider-selection session (providerSelectionPolicyV1.ts,
 * AC-RUNNER-05: only a pre-invocation or pre-response transport failure may
 * reopen a session for fallback), so the fix retries one layer up, as a
 * genuinely fresh `executeAction`/`executeRoute` call, never by reopening the
 * coordinator's session — that reopening was tried and throws
 * `ProviderSelectionPolicyErrorV1` ("Fallback requires a new coordinator
 * operation, not a reopened session").
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitAndContinueWithMalformedResultRetryV1,
  withMalformedResultRetryV1,
} from "../actions/productionTaskActionRuntimeV1";
import {
  AdmittedProviderActionTicketV1,
  TaskActionCoordinatorV1,
  TaskActionRequestV1,
} from "../actions/taskActionCoordinatorV1";
import { EDIT_EXECUTION_ACTION_KEY_V1 } from "../actions/rows/editExecutionRowV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

const notUsedInThisTest = (): never => {
  throw new Error("not exercised by withMalformedResultRetryV1 — not used in this test");
};

/** A coordinator whose executeAction/executeRoute return scripted outcomes in
 * order, one per call; every other method is unused by the wrapper. Call
 * count is a live counter object so callers can read it after the fact. */
function scriptedCoordinator(
  outcomes: readonly TaskActionOutcomeV1[]
): { coordinator: TaskActionCoordinatorV1; calls: { count: number } } {
  const calls = { count: 0 };
  const next = (): TaskActionOutcomeV1 => {
    const outcome = outcomes[calls.count];
    calls.count++;
    if (!outcome) {
      throw new Error(`scriptedCoordinator: no outcome configured for call ${calls.count}`);
    }
    return outcome;
  };
  const coordinator: TaskActionCoordinatorV1 = {
    executeAction: () => Promise.resolve(next()),
    executeRoute: () => Promise.resolve(next()),
    admitAction: notUsedInThisTest,
    continueAdmittedAction: notUsedInThisTest,
    abortAdmittedAction: notUsedInThisTest,
    resumeAction: notUsedInThisTest,
  };
  return { coordinator, calls };
}

const request = { actionKey: "test.v1" } as unknown as TaskActionRequestV1;

void describe("withMalformedResultRetryV1", () => {
  void it("passes a non-malformed outcome through on the first call, with no retry", async () => {
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "completed", correlation: {} as never, code: "completed" },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator);
    const outcome = await wrapped.executeAction(request);
    assert.equal(outcome.kind, "completed");
    assert.equal(calls.count, 1);
  });

  void it("retries once via a fresh call after a malformed result, and returns the recovered outcome", async () => {
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "malformedResult", correlation: {} as never, code: "invalidFrame" },
      { kind: "completed", correlation: {} as never, code: "completed" },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator);
    const outcome = await wrapped.executeAction(request);
    assert.equal(outcome.kind, "completed");
    assert.equal(calls.count, 2);
  });

  void it("stops after maxAttempts and returns the last malformed outcome unchanged", async () => {
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "malformedResult", correlation: {} as never, code: "invalidFrame" },
      { kind: "malformedResult", correlation: {} as never, code: "resultCorrelationMismatch" },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator, 2);
    const outcome = await wrapped.executeAction(request);
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    // The LAST attempt's diagnostic code, not the first — a caller inspecting
    // the failure sees what actually happened on the final try.
    assert.equal(outcome.code, "resultCorrelationMismatch");
    assert.equal(calls.count, 2);
  });

  void it("does not retry a terminal outcome that is not malformedResult", async () => {
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "failed", correlation: {} as never, code: "somethingElse", retryable: false },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator);
    const outcome = await wrapped.executeAction(request);
    assert.equal(outcome.kind, "failed");
    assert.equal(calls.count, 1);
  });

  void it("applies the same retry policy to executeRoute", async () => {
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "malformedResult", correlation: {} as never, code: "invalidFrame" },
      { kind: "completed", correlation: {} as never, code: "completed" },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator);
    const outcome = await wrapped.executeRoute("some.route", request);
    assert.equal(outcome.kind, "completed");
    assert.equal(calls.count, 2);
  });

  void it("respects a maxAttempts of 1 as no-retry", async () => {
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "malformedResult", correlation: {} as never, code: "invalidFrame" },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator, 1);
    const outcome = await wrapped.executeAction(request);
    assert.equal(outcome.kind, "malformedResult");
    assert.equal(calls.count, 1);
  });

  void it("never retries a malformedResult outcome whose correlation is editExecution.v1's, even with maxAttempts > 1", async () => {
    const editExecutionCorrelation = {
      actionKey: EDIT_EXECUTION_ACTION_KEY_V1,
      operationId: "op-1",
      attemptId: "attempt-1",
      taskBindingId: "binding-1",
      chatDocumentId: "chat-1",
    } as never;
    const { coordinator, calls } = scriptedCoordinator([
      { kind: "malformedResult", correlation: editExecutionCorrelation, code: "invalidFrame" },
      { kind: "completed", correlation: {} as never, code: "completed" },
    ]);
    const wrapped = withMalformedResultRetryV1(coordinator, 2);
    const outcome = await wrapped.executeAction(request);
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "invalidFrame");
    // Never re-called: a retried conversation against an already-mutating,
    // cursor-tracked edit session can only trip a mutationOrderViolation or a
    // receiptId mismatch — never a legitimate recovery — so this action key
    // is excluded from the retry loop entirely (see retryOnMalformedResultV1's
    // header in productionTaskActionRuntimeV1.ts).
    assert.equal(calls.count, 1);
  });
});

const fakeTicket = {} as AdmittedProviderActionTicketV1;

/** A coordinator whose admitAction always admits (never settles at
 * admission), and whose continueAdmittedAction returns scripted outcomes in
 * order — one continuation per admitAction/continueAdmittedAction pair, so
 * `calls.count` counts full admit+continue round trips. */
function scriptedAdmitContinueCoordinator(
  continuedOutcomes: readonly TaskActionOutcomeV1[]
): { coordinator: TaskActionCoordinatorV1; calls: { count: number } } {
  const calls = { count: 0 };
  const coordinator: TaskActionCoordinatorV1 = {
    executeAction: notUsedInThisTest,
    executeRoute: notUsedInThisTest,
    admitAction: () => Promise.resolve({ kind: "admitted", ticket: fakeTicket }),
    continueAdmittedAction: () => {
      const outcome = continuedOutcomes[calls.count];
      calls.count++;
      if (!outcome) {
        throw new Error(`scriptedAdmitContinueCoordinator: no outcome configured for call ${calls.count}`);
      }
      return Promise.resolve(outcome);
    },
    abortAdmittedAction: notUsedInThisTest,
    resumeAction: notUsedInThisTest,
  };
  return { coordinator, calls };
}

void describe("admitAndContinueWithMalformedResultRetryV1", () => {
  void it("passes a non-malformed continuation outcome through, with no retry", async () => {
    const { coordinator, calls } = scriptedAdmitContinueCoordinator([
      { kind: "completed", correlation: {} as never, code: "completed" },
    ]);
    const outcome = await admitAndContinueWithMalformedResultRetryV1(coordinator, request);
    assert.equal(outcome.kind, "completed");
    assert.equal(calls.count, 1);
  });

  void it("retries via a fresh admitAction after a malformed continuation, recovering on the next try", async () => {
    const { coordinator, calls } = scriptedAdmitContinueCoordinator([
      { kind: "malformedResult", correlation: {} as never, code: "invalidFrame" },
      { kind: "completed", correlation: {} as never, code: "completed" },
    ]);
    const outcome = await admitAndContinueWithMalformedResultRetryV1(coordinator, request);
    assert.equal(outcome.kind, "completed");
    assert.equal(calls.count, 2);
  });

  void it("stops after maxAttempts and returns the last malformed continuation outcome unchanged", async () => {
    const { coordinator, calls } = scriptedAdmitContinueCoordinator([
      { kind: "malformedResult", correlation: {} as never, code: "invalidFrame" },
      { kind: "malformedResult", correlation: {} as never, code: "resultCorrelationMismatch" },
    ]);
    const outcome = await admitAndContinueWithMalformedResultRetryV1(coordinator, request, 2);
    assert.equal(outcome.kind, "malformedResult");
    if (outcome.kind !== "malformedResult") {
      assert.fail("expected malformedResult");
    }
    assert.equal(outcome.code, "resultCorrelationMismatch");
    assert.equal(calls.count, 2);
  });

  void it("returns a settled admission's outcome directly, without ever calling continueAdmittedAction", async () => {
    let continueCalls = 0;
    const coordinator: TaskActionCoordinatorV1 = {
      executeAction: notUsedInThisTest,
      executeRoute: notUsedInThisTest,
      admitAction: () =>
        Promise.resolve({
          kind: "settled",
          outcome: { kind: "failed", correlation: {} as never, code: "actionNotEligibleForStatus", retryable: false },
        }),
      continueAdmittedAction: () => {
        continueCalls++;
        throw new Error("must not be called for a settled admission");
      },
      abortAdmittedAction: notUsedInThisTest,
      resumeAction: notUsedInThisTest,
    };
    const outcome = await admitAndContinueWithMalformedResultRetryV1(coordinator, request);
    assert.equal(outcome.kind, "failed");
    assert.equal(continueCalls, 0);
  });
});
