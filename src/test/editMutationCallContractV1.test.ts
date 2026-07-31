/**
 * Coverage for the §7.4 reference-only mutation-call contract
 * (decodeMutationCallV1): exactly four bounded string fields, unknown
 * fields rejected — a call carrying a path or bytes can never decode.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeMutationCallV1 } from "../types/editExecutionProtocolV1";

const VALID = {
  executionId: "exec-1",
  planId: "plan-1",
  planDigest: "ab".repeat(32),
  stepId: "s1",
};

void describe("editMutationCallContractV1", () => {
  void it("accepts exactly the four reference fields", () => {
    const result = decodeMutationCallV1(VALID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.call, VALID);
    }
  });

  void it("rejects non-objects, missing fields, and empty/oversized values", () => {
    assert.equal(decodeMutationCallV1(undefined).ok, false);
    assert.equal(decodeMutationCallV1("x").ok, false);
    assert.equal(decodeMutationCallV1({ ...VALID, stepId: "" }).ok, false);
    assert.equal(decodeMutationCallV1({ ...VALID, stepId: "x".repeat(257) }).ok, false);
    const { stepId: _dropped, ...withoutStep } = VALID;
    assert.equal(decodeMutationCallV1(withoutStep).ok, false);
  });

  void it("rejects any extra field — a path or bytes can never ride along", () => {
    assert.equal(decodeMutationCallV1({ ...VALID, relativePath: "src/a.ts" }).ok, false);
    assert.equal(decodeMutationCallV1({ ...VALID, contentBase64: "aGk=" }).ok, false);
  });
});
