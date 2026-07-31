/**
 * Coverage for §7.6's execution-permit and §7.4's order enforcement across
 * failure boundaries: the permit is claim-once DURABLY (a second broker
 * instance over the same storage cannot re-claim), reordered/repeated/
 * mismatched calls block the execution (stalePreflight with zero receipts,
 * partialEditBlocked once any receipt exists), and applied edits survive.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEditPlanBrokerV1 } from "../services/editBrokerToolSessionHandlerV1";
import { installEditBrokerHarnessV1, PRIVATE_ROOT_ID } from "./editBrokerTestHarnessV1";

void describe("editRecoveryV1", () => {
  void it("claims the execution permit exactly once — the claim record is durable on disk", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId } = await h.seal();
      const first = await h.broker.claimExecutionPermit(executionId);
      assert.deepEqual(first, { ok: true });
      const second = await h.broker.claimExecutionPermit(executionId);
      assert.equal(second.ok === false && second.code, "permitAlreadyClaimed");

      // Durability: the claim is an EXCLUSIVE on-disk create — even a
      // process that lost the in-memory execution state (crash/restart)
      // could never write a second claim for this executionId.
      const reclaim = await h.store.createFileExclusive(
        {
          rootId: PRIVATE_ROOT_ID,
          relativePath: `workflow-runtime-v1/edit-runs/${executionId}/execution-claim-v1.json`,
        },
        Buffer.from("{}", "utf8")
      );
      assert.equal(reclaim.kind === "failed" && reclaim.code, "targetExists");

      // A rebooted broker has no in-memory record of this execution and
      // refuses to claim an id it cannot verify.
      const rebooted = createEditPlanBrokerV1({ getFileStore: () => h.store, privateRootId: PRIVATE_ROOT_ID });
      const unknown = await rebooted.claimExecutionPermit(executionId);
      assert.equal(unknown.ok === false && unknown.code, "unknownExecution");
    } finally {
      h.cleanup();
    }
  });

  void it("blocks a reordered first call as stalePreflight with zero receipts", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      const reordered = await h.callStep(handler, script, 1);
      assert.equal(reordered.ok, false);
      assert.equal(reordered.code, "mutationOrderViolation");
      const outcome = h.broker.executionOutcome(executionId);
      assert.equal(outcome?.state, "stalePreflight");
      assert.deepEqual(outcome?.appliedReceiptIds, []);
    } finally {
      h.cleanup();
    }
  });

  void it("blocks a repeated call after one receipt as partialEditBlocked, keeping the applied receipt", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      const first = await h.callStep(handler, script, 0);
      assert.equal(first.ok, true);
      const repeated = await h.callStep(handler, script, 0);
      assert.equal(repeated.ok, false);
      assert.equal(repeated.code, "mutationOrderViolation");
      const outcome = h.broker.executionOutcome(executionId);
      assert.equal(outcome?.state, "partialEditBlocked");
      assert.equal(outcome?.appliedReceiptIds.length, 1);
      assert.equal(outcome?.appliedReceiptIds[0], first.receiptId);
    } finally {
      h.cleanup();
    }
  });

  void it("blocks a call whose plan references do not match the sealed plan", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      const mismatched = await h.callStep(handler, script, 0, { planDigest: "ff".repeat(32) });
      assert.equal(mismatched.ok, false);
      assert.equal(mismatched.code, "mutationReferenceMismatch");
      assert.equal(h.broker.executionOutcome(executionId)?.state, "stalePreflight");
    } finally {
      h.cleanup();
    }
  });

  void it("refuses mutation calls before the permit is claimed", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = h.broker.createEditSessionHandler(executionId);
      const refused = await h.callStep(handler, script, 0);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "executionBlocked");
      assert.equal(h.broker.executionOutcome(executionId)?.state, "sealed");
    } finally {
      h.cleanup();
    }
  });
});
