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

void describe("decodeTaskActionOutcomeV1 — malformedResult.priorRejectedAttemptsV1 (item 6)", () => {
  void it("round-trips a malformedResult outcome carrying priorRejectedAttemptsV1", () => {
    const outcome: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidEnvelope",
      detail: 'unsupported envelope "version": 99',
      priorRejectedAttemptsV1: [
        { attemptId: "c".repeat(32), code: "invalidFrame" },
        { attemptId: "d".repeat(32), code: "invalidJson", detail: "the JSON payload is empty" },
      ],
    };
    const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(outcome)));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.outcome, outcome);
    }
  });

  void it("decodes a pre-existing malformedResult outcome with no priorRejectedAttemptsV1 field", () => {
    const raw = { kind: "malformedResult", correlation: CORRELATION, code: "invalidFrame" };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, true);
    if (decoded.ok && decoded.outcome.kind === "malformedResult") {
      assert.equal(decoded.outcome.priorRejectedAttemptsV1, undefined);
    }
  });

  void it("rejects a priorRejectedAttemptsV1 entry missing a code", () => {
    const raw = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      priorRejectedAttemptsV1: [{ attemptId: "c".repeat(32) }],
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });

  void it("rejects a priorRejectedAttemptsV1 that is not an array", () => {
    const raw = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      priorRejectedAttemptsV1: "not-an-array",
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });
});

void describe(
  "decodeTaskActionOutcomeV1 — attemptId + failed.priorRejectedAttemptsV1 (2026-09-28 " +
    "implementation-review follow-up to item 6: a content-contract chain settles `failed`, not " +
    "`malformedResult`, but needs the exact same per-attempt history and final-attempt id)",
  () => {
    void it("round-trips a malformedResult outcome carrying attemptId", () => {
      const outcome: TaskActionOutcomeV1 = {
        kind: "malformedResult",
        correlation: CORRELATION,
        code: "invalidFrame",
        attemptId: "e".repeat(32),
      };
      const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(outcome)));
      assert.equal(decoded.ok, true);
      if (decoded.ok) {
        assert.deepEqual(decoded.outcome, outcome);
      }
    });

    void it("round-trips a failed outcome carrying attemptId and priorRejectedAttemptsV1", () => {
      const outcome: TaskActionOutcomeV1 = {
        kind: "failed",
        correlation: CORRELATION,
        code: "contentContractFailed",
        retryable: false,
        detail: 'missing required "MAGIC" marker (got: "third")',
        attemptId: "e".repeat(32),
        priorRejectedAttemptsV1: [
          { attemptId: "c".repeat(32), code: "contentContractFailed", detail: 'missing required "MAGIC" marker (got: "first")' },
          { attemptId: "d".repeat(32), code: "contentContractFailed" },
        ],
      };
      const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(outcome)));
      assert.equal(decoded.ok, true);
      if (decoded.ok) {
        assert.deepEqual(decoded.outcome, outcome);
      }
    });

    void it("decodes a pre-existing failed outcome with no attemptId/priorRejectedAttemptsV1 fields", () => {
      const raw = { kind: "failed", correlation: CORRELATION, code: "providerExploded", retryable: true };
      const decoded = decodeTaskActionOutcomeV1(raw);
      assert.equal(decoded.ok, true);
      if (decoded.ok && decoded.outcome.kind === "failed") {
        assert.equal(decoded.outcome.attemptId, undefined);
        assert.equal(decoded.outcome.priorRejectedAttemptsV1, undefined);
      }
    });

    void it("rejects an empty-string attemptId on a failed outcome", () => {
      const raw = {
        kind: "failed",
        correlation: CORRELATION,
        code: "providerExploded",
        retryable: true,
        attemptId: "",
      };
      const decoded = decodeTaskActionOutcomeV1(raw);
      assert.equal(decoded.ok, false);
    });

    void it("rejects a priorRejectedAttemptsV1 entry on a failed outcome that is not an array", () => {
      const raw = {
        kind: "failed",
        correlation: CORRELATION,
        code: "providerExploded",
        retryable: true,
        priorRejectedAttemptsV1: "not-an-array",
      };
      const decoded = decodeTaskActionOutcomeV1(raw);
      assert.equal(decoded.ok, false);
    });
  }
);

void describe("decodeTaskActionOutcomeV1 — completed.frameRepairV1 (item 5)", () => {
  /**
   * `frameRepairV1` was added to the runtime `completed` outcome union
   * (`taskActionOutcomeV1.ts`) so a repaired lookalike end marker survives
   * onto the settled outcome, but the strict decoder's allowed-field set for
   * "completed outcome" was not updated to match. A `resumeAction` durably
   * persists its exact settled outcome (plan §3.1 / AC-RUNNER-03) and
   * self-checks it by round-tripping through this decoder before persisting
   * — so a repaired-marker Resume outcome failed that self-check with
   * "completed outcome has an unknown field: frameRepairV1", discarding a
   * result item 5 exists specifically to keep.
   */
  void it("round-trips a completed outcome carrying frameRepairV1", () => {
    const outcome: TaskActionOutcomeV1 = {
      kind: "completed",
      correlation: CORRELATION,
      code: "completed",
      frameRepairV1: { expected: "<<<END_ENSEMBLE_AI_RESULT_V1>>>", actual: "<<<END_ENSᗩMBLE_AI_RESULT_V1>>>", index: 10 },
    };
    const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(outcome)));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.outcome, outcome);
    }
  });

  void it("decodes a pre-existing completed outcome with no frameRepairV1 field", () => {
    const raw = { kind: "completed", correlation: CORRELATION, code: "completed" };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, true);
    if (decoded.ok && decoded.outcome.kind === "completed") {
      assert.equal(decoded.outcome.frameRepairV1, undefined);
    }
  });

  void it("rejects a frameRepairV1 with a non-integer index", () => {
    const raw = {
      kind: "completed",
      correlation: CORRELATION,
      code: "completed",
      frameRepairV1: { expected: "a", actual: "b", index: 1.5 },
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });

  void it("rejects a frameRepairV1 with an unknown sub-field", () => {
    const raw = {
      kind: "completed",
      correlation: CORRELATION,
      code: "completed",
      frameRepairV1: { expected: "a", actual: "b", index: 0, extra: true },
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });
});

void describe("decodeTaskActionOutcomeV1 — chainExhaustion.candidates[].deferredFailureKind/deferredResetAt", () => {
  // 2026-09-16 review (new completion blocker): the strict decoder rejected
  // these two fields as unknown, so a persisted `unavailable` outcome
  // carrying the 2026-09-15 post-freeze quota-deferral metadata
  // (`enrichChainExhaustionWithAttemptOutcomesV1`, taskActionCoordinatorV1.ts)
  // failed to round-trip through disk.
  void it("round-trips a chainExhaustion candidate carrying deferredFailureKind and deferredResetAt", () => {
    const outcome: TaskActionOutcomeV1 = {
      kind: "unavailable",
      code: "candidatesExhausted",
      chainExhaustion: {
        stage: "impl-high-review",
        candidates: [
          {
            storedModelId: "codex/gpt-5.6-sol",
            providerLabel: "OpenAI Codex",
            runnerId: "codex",
            reason: "invoked, but the request failed",
            deferredFailureKind: "quota",
            deferredResetAt: "2026-09-16T16:12:00.000Z",
          },
        ],
      },
    };
    const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(outcome)));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.outcome, outcome);
    }
  });

  void it("decodes a pre-existing chainExhaustion candidate with neither field present", () => {
    const raw = {
      kind: "unavailable",
      code: "candidatesExhausted",
      chainExhaustion: {
        candidates: [
          {
            storedModelId: "m",
            providerLabel: "p",
            runnerId: "r",
            reason: "failed",
          },
        ],
      },
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, true);
    if (decoded.ok && decoded.outcome.kind === "unavailable") {
      assert.equal(decoded.outcome.chainExhaustion?.candidates[0]?.deferredFailureKind, undefined);
      assert.equal(decoded.outcome.chainExhaustion?.candidates[0]?.deferredResetAt, undefined);
    }
  });

  void it("rejects an invalid deferredFailureKind value", () => {
    const raw = {
      kind: "unavailable",
      code: "candidatesExhausted",
      chainExhaustion: {
        candidates: [
          {
            storedModelId: "m",
            providerLabel: "p",
            runnerId: "r",
            reason: "failed",
            deferredFailureKind: "not-a-real-kind",
          },
        ],
      },
    };
    const decoded = decodeTaskActionOutcomeV1(raw);
    assert.equal(decoded.ok, false);
  });
});
