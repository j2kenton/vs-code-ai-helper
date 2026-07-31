/**
 * Coverage for the §7.4 receipt contract: receipts are durable on disk
 * before the tool result returns, carry the sealed operation's digest and
 * the host callId, and the broker's ordered applied-receipt list is the
 * authoritative record a completion must match.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { installEditBrokerHarnessV1 } from "./editBrokerTestHarnessV1";
import { computeSealedOperationDigestV1, MutationReceiptV1 } from "../types/editExecutionProtocolV1";

void describe("editReceiptContractV1", () => {
  void it("persists an ordered receipt per applied step, matching the returned tool result", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, planId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);

      const returnedReceiptIds: string[] = [];
      for (let i = 0; i < script.steps.length; i++) {
        const result = await h.callStep(handler, script, i);
        assert.equal(result.ok, true);
        assert.equal(result.outcome, "applied");
        assert.equal(result.stepId, script.steps[i]!.stepId);
        assert.equal(result.hostCallId, `host-${i + 1}`);
        assert.equal(result.planId, planId);
        assert.equal(
          result.operationDigest,
          computeSealedOperationDigestV1(h.plan.operations[i]!),
          "the receipt digests the exact sealed operation"
        );
        returnedReceiptIds.push(result.receiptId as string);

        // Durable BEFORE the result returned: the receipt file exists now.
        const receiptPath = path.join(
          h.privateRoot,
          "workflow-runtime-v1",
          "edit-runs",
          executionId,
          `receipt-${i + 1}-v1.json`
        );
        const onDisk = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as MutationReceiptV1;
        assert.equal(onDisk.receiptId, result.receiptId);
        assert.equal(onDisk.stepId, script.steps[i]!.stepId);
      }

      // The broker's ordered list is authoritative and matches exactly.
      assert.deepEqual(
        h.broker.executionOutcome(executionId)?.appliedReceiptIds,
        returnedReceiptIds
      );
    } finally {
      h.cleanup();
    }
  });

  void it("persists the sealed plan exclusively and reads it back before any session", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, planId } = await h.seal();
      const sealedPath = path.join(
        h.privateRoot,
        "workflow-runtime-v1",
        "edit-runs",
        executionId,
        "sealed-plan-v1.json"
      );
      const sealed = JSON.parse(fs.readFileSync(sealedPath, "utf8")) as {
        planId: string;
        scriptDigest: string;
        operations: unknown[];
        observations: unknown[];
      };
      assert.equal(sealed.planId, planId);
      assert.match(sealed.scriptDigest, /^[0-9a-f]{64}$/);
      assert.equal(sealed.operations.length, 6);
      assert.ok(sealed.observations.length >= 6, "the authorizing observation records are sealed too");
    } finally {
      h.cleanup();
    }
  });
});
