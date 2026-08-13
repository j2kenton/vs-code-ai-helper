/**
 * Regression coverage for `decodeTaskActionOutcomeV1`'s `malformedResult`
 * branch (2026-08-13 review fix): `malformedInvocationsUsedV1`
 * (`taskActionOutcomeV1.ts`, stamped by the malformed-result candidate
 * -advancement loop, `taskActionCoordinatorV1.ts`) was added to the runtime
 * union but never added to the strict decoder's allowed-field set. A
 * `resumeAction` durably persists its exact settled outcome as
 * `resumeInvocationOutcome` (plan §3.1 / AC-RUNNER-03), so a malformed Resume
 * outcome carrying this field failed decoding on reload with "malformedResult
 * outcome has an unknown field: malformedInvocationsUsedV1" — silently
 * breaking the "recover the claimed terminal result" contract for exactly
 * the outcomes this field was added to describe.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeTaskActionOutcomeV1, TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

const CORRELATION = {
  actionKey: "review.v1",
  operationId: "a".repeat(32),
  attemptId: "b".repeat(32),
  taskBindingId: "tb",
  chatDocumentId: "cd",
};

void describe("decodeTaskActionOutcomeV1 — malformedResult.malformedInvocationsUsedV1", () => {
  void it("round-trips a malformedResult outcome carrying malformedInvocationsUsedV1", () => {
    const outcome: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      malformedInvocationsUsedV1: 2,
    };
    const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(outcome)));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.outcome, outcome);
    }
  });

  void it("decodes a pre-existing malformedResult outcome with no malformedInvocationsUsedV1 field", () => {
    const raw = { kind: "malformedResult", correlation: CORRELATION, code: "invalidFrame" };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, true);
    if (decoded.ok && decoded.outcome.kind === "malformedResult") {
      assert.equal(decoded.outcome.malformedInvocationsUsedV1, undefined);
    }
  });

  void it("rejects a non-integer malformedInvocationsUsedV1", () => {
    const raw = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      malformedInvocationsUsedV1: 1.5,
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });

  void it("rejects a negative malformedInvocationsUsedV1", () => {
    const raw = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      malformedInvocationsUsedV1: -1,
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });
});
