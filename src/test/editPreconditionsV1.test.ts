/**
 * Coverage for §7.7's precondition re-verification: the happy path applies
 * all five operation kinds against the real filesystem in script order, and
 * every stale-world divergence (target modified, target materialized,
 * directory no longer empty) settles as stalePreflight BEFORE any mutation
 * when no receipt exists yet.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { installEditBrokerHarnessV1 } from "./editBrokerTestHarnessV1";

void describe("editPreconditionsV1 — §7.7 revalidation", () => {
  void it("applies all five operation kinds in script order against the real filesystem", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      for (let i = 0; i < script.steps.length; i++) {
        const result = await h.callStep(handler, script, i);
        assert.equal(result.ok, true, `step ${i} must apply: ${JSON.stringify(result)}`);
      }
      assert.equal(
        fs.readFileSync(path.join(h.workspaceRoot, "src", "new.ts"), "utf8"),
        "new file content\n"
      );
      assert.equal(
        fs.readFileSync(path.join(h.workspaceRoot, "src", "generated", "out.ts"), "utf8"),
        "generated\n"
      );
      assert.equal(
        fs.readFileSync(path.join(h.workspaceRoot, "src", "existing.ts"), "utf8"),
        "replacement content\n"
      );
      assert.equal(fs.existsSync(path.join(h.workspaceRoot, "src", "old.ts")), false);
      assert.equal(fs.existsSync(path.join(h.workspaceRoot, "empty")), false);
      assert.equal(h.broker.executionOutcome(executionId)?.state, "completed");
    } finally {
      h.cleanup();
    }
  });

  void it("settles as stalePreflight when the replace target changed after preflight (no receipts yet)", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      // External edit AFTER sealing: the exact-revision replace must refuse.
      // The replace is step index 3; drive the earlier steps' TARGETS stale
      // instead — simplest: touch the replace target and start with step 0
      // replaced by... keep it direct: modify existing.ts, then run steps
      // 0-2 normally and hit the divergence at step 3.
      fs.writeFileSync(path.join(h.workspaceRoot, "src", "existing.ts"), "changed underfoot\n");
      for (let i = 0; i < 3; i++) {
        const result = await h.callStep(handler, script, i);
        assert.equal(result.ok, true);
      }
      const stale = await h.callStep(handler, script, 3);
      assert.equal(stale.ok, false);
      assert.equal(stale.code, "stalePreflight");
      // Three receipts were already issued, so the execution is
      // partialEditBlocked — the applied edits remain in place (§7.7).
      const outcome = h.broker.executionOutcome(executionId);
      assert.equal(outcome?.state, "partialEditBlocked");
      assert.equal(outcome?.appliedReceiptIds.length, 3);
      assert.equal(
        fs.readFileSync(path.join(h.workspaceRoot, "src", "existing.ts"), "utf8"),
        "changed underfoot\n",
        "the diverged file must not be touched"
      );
      assert.equal(
        fs.readFileSync(path.join(h.workspaceRoot, "src", "new.ts"), "utf8"),
        "new file content\n",
        "verified partial edits remain in place"
      );
    } finally {
      h.cleanup();
    }
  });

  void it("settles as stalePreflight when the FIRST step's create target materialized (zero receipts)", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      fs.writeFileSync(path.join(h.workspaceRoot, "src", "new.ts"), "surprise\n");
      const stale = await h.callStep(handler, script, 0);
      assert.equal(stale.ok, false);
      assert.equal(stale.code, "stalePreflight");
      const outcome = h.broker.executionOutcome(executionId);
      assert.equal(outcome?.state, "stalePreflight");
      assert.deepEqual(outcome?.appliedReceiptIds, []);
      // Blocked terminally: even a now-valid later step is refused.
      const refused = await h.callStep(handler, script, 1);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "executionBlocked");
    } finally {
      h.cleanup();
    }
  });

  void it("refuses deleteEmptyDirectory when the directory gained an entry after preflight", async () => {
    const h = await installEditBrokerHarnessV1();
    try {
      const { executionId, script } = await h.seal();
      const handler = await h.claimAndHandler(executionId);
      for (let i = 0; i < 5; i++) {
        const result = await h.callStep(handler, script, i);
        assert.equal(result.ok, true);
      }
      fs.writeFileSync(path.join(h.workspaceRoot, "empty", "late.txt"), "late");
      const stale = await h.callStep(handler, script, 5);
      assert.equal(stale.ok, false);
      assert.equal(stale.code, "stalePreflight");
      assert.equal(h.broker.executionOutcome(executionId)?.state, "partialEditBlocked");
      assert.equal(fs.existsSync(path.join(h.workspaceRoot, "empty", "late.txt")), true);
    } finally {
      h.cleanup();
    }
  });
});
